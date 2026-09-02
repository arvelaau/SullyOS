import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../../types';
import { ActiveMsgClient, getDefaultActiveMsgFirstSendTime } from '../../utils/activeMsgClient';
import { ActiveMsgStore } from '../../utils/activeMsgStore';
import { type AmsgLastSkip, DEFAULT_MAX_UNANSWERED_SENDS, describeLastSkip } from '../../utils/amsgFirePack';
import { isInstantChatReady } from '../../utils/amsgInstantChat';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import { buildUserCancelledNotices } from '../../utils/amsg2TaskContext';
import { trackEvent } from '../../utils/analytics';
import {
  applyRemoteTaskDelta,
  applyScheduledTask,
  currentOccurrenceMs,
  describeExpirePolicy,
  describeRecurrence,
  describeRemoteLastError,
  describeTaskMode,
  describeTaskProgress,
  formatTaskTime,
  fromDatetimeLocalValue,
  isAmsg2EnabledForChar,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  pruneFiredTasks,
  reconcileTasksWithRemote,
  resolveExpirePolicy,
  type RemoteTaskLastError,
  type RemoteTaskProjection,
  shortTaskId,
  toDatetimeLocalValue,
} from '../../utils/amsg2Tasks';

interface ActiveMsg2SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  char: CharacterProfile;
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /**
   * Persists the task list and character-level settings.
   *
   * Takes an updater instead of a full config: every save in the panel first has to await a
   * network request, and during that time the character may have used a tool in chat to
   * schedule a new task (writing to the same activeMsg2Config). Overwriting with the whole
   * stale render-time snapshot would erase it — the remote side still fires it, but the panel
   * can no longer see it, which is exactly the "ghost task" everything elsewhere guards against.
   * The updater runs via OSContext's functional setState, so the prev it receives is the latest
   * state after that queued write.
   */
  onSave: (
    updater: (prev: ActiveMsg2CharacterConfig | undefined) => ActiveMsg2CharacterConfig,
  ) => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const MODE_OPTIONS = [
  { id: 'fixed', label: 'Fixed', desc: 'Sends the content you wrote, right when it is due' },
  { id: 'auto', label: 'Auto', desc: 'Generated automatically from the current character settings and chat snapshot' },
  { id: 'prompted', label: 'Prompted', desc: 'Generates a proactive message around the direction you write' },
] as const;

const RECURRENCE_OPTIONS = [
  { id: 'none', label: 'Once' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
] as const;

const ActiveMsg2SettingsModal: React.FC<ActiveMsg2SettingsModalProps> = ({
  isOpen,
  onClose,
  char,
  apiConfig,
  userProfile,
  groups,
  realtimeConfig,
  onSave,
  addToast,
}) => {
  const saved = char.activeMsg2Config;
  const tasks = saved?.tasks ?? [];
  // The reference "now" used to evaluate the task list: taken once per render, so cards on screen don't end up judged against different moments.
  const now = Date.now();

  // The toggle's initial value uses the same check as the tool-injection gate: if the panel shows "off" while the character can still schedule, the UI is lying.
  const [enabled, setEnabled] = useState(() => isAmsg2EnabledForChar(char));
  // Instant Chat can be turned off per character: undefined = follows the global default (on), so it only shows as off when explicitly false.
  const [instantChatOn, setInstantChatOn] = useState(saved?.instantChatEnabled !== false);
  // Whether the global gate is on (read back via isInstantChatReady). When it's off, the toggle below is grayed out.
  const [globalInstantChatOn, setGlobalInstantChatOn] = useState(false);
  const [mode, setMode] = useState<ActiveMsg2Mode>('auto');
  const [firstSendTime, setFirstSendTime] = useState(getDefaultActiveMsgFirstSendTime());
  const [recurrenceType, setRecurrenceType] = useState<ActiveMsg2Recurrence>('none');
  const [userMessage, setUserMessage] = useState('');
  const [promptHint, setPromptHint] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(saved?.maxTokens ?? ''));
  // '' = not set (uses the default); '0' = unlimited; otherwise 1-10.
  const [maxUnanswered, setMaxUnanswered] = useState(
    saved?.maxUnansweredSends === undefined ? '' : String(saved.maxUnansweredSends),
  );
  const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
  const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
  const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
  const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
  const [globalReady, setGlobalReady] = useState(false);
  const [pushSummary, setPushSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // editingTaskUuid=null → creating a new task; non-null → editing that task (replaceTaskUuid on save).
  const [editingTaskUuid, setEditingTaskUuid] = useState<string | null>(null);
  const [expirePolicy, setExpirePolicy] = useState<ActiveMsg2ExpirePolicy>('expire');
  // Baseline for remote reconciliation: fetches all tasks once when the panel opens, keeping
  // only uuids belonging to this character. null = reconciliation didn't happen (read failed /
  // didn't finish) — in that case the "not found on remote" badge is hidden so it doesn't
  // wrongly flag half the list.
  // Not re-fetched afterward; applyRemoteTaskDelta records the result of every subsequent
  // remote operation instead (see the amsg2Tasks comment).
  const [knownRemoteUuids, setKnownRemoteUuids] = useState<Set<string> | null>(null);
  // Projection of each remote task's status / lastError (fetched during the same reconciliation
  // pass). null = wasn't fetched, so cards don't show a failure explanation. This is only fetched
  // once when the panel opens and isn't maintained via delta afterward — after a cancel/recreate
  // the task gets a new uuid, so the old entry naturally stops matching, with no cross-talk.
  const [remoteTaskInfo, setRemoteTaskInfo] = useState<Map<string, {
    status?: string;
    lastError: RemoteTaskLastError | null;
  }> | null>(null);
  // The most recent skip recorded by the immersion-break guard (written by the worker). null = no record / couldn't be read.
  const [lastSkip, setLastSkip] = useState<AmsgLastSkip | null>(null);

  // Form reset: when the panel opens or the task being edited changes, fill the form from the
  // task's fields (or defaults, when creating new). Character-level shared settings (maxTokens /
  // secondary API) always follow the saved value.
  useEffect(() => {
    if (!isOpen) return;

    const config = char.activeMsg2Config;
    const list = config?.tasks ?? [];
    // Uses the same check as the useState initializer: writing a separate ternary here would let
    // the panel's toggle state diverge from the tool-injection gate (see isAmsg2EnabledForChar's
    // comment).
    setEnabled(isAmsg2EnabledForChar(char));
    setInstantChatOn(config?.instantChatEnabled !== false);
    setMaxTokens(config?.maxTokens ? String(config.maxTokens) : '');
    setMaxUnanswered(config?.maxUnansweredSends === undefined ? '' : String(config.maxUnansweredSends));
    setUseSecondaryApi(config?.useSecondaryApi ?? false);
    setSecUrl(config?.secondaryApi?.baseUrl ?? '');
    setSecKey(config?.secondaryApi?.apiKey ?? '');
    setSecModel(config?.secondaryApi?.model ?? '');

    const editing = editingTaskUuid ? list.find((t) => t.taskUuid === editingTaskUuid) : undefined;
    if (editing) {
      setMode(editing.mode);
      setFirstSendTime(toDatetimeLocalValue(editing.firstSendTime));
      setRecurrenceType(editing.recurrenceType);
      setUserMessage(editing.userMessage ?? '');
      setPromptHint(editing.promptHint ?? '');
      setExpirePolicy(resolveExpirePolicy(editing.mode, editing.expirePolicy));
    } else {
      setMode('auto');
      setFirstSendTime(getDefaultActiveMsgFirstSendTime());
      setRecurrenceType('none');
      setUserMessage('');
      setPromptHint('');
      setExpirePolicy('expire');
    }
  }, [isOpen, char.id, char.activeMsg2Config, editingTaskUuid]);

  // Push status check + remote reconciliation on panel open (only re-runs on isOpen / character change, not on every edit-target change).
  useEffect(() => {
    if (!isOpen) return;
    setKnownRemoteUuids(null);
    setRemoteTaskInfo(null);

    // Whether global Instant Chat is on (use the existing reader instead of reading storage directly). Grayed out as off if the read fails.
    void isInstantChatReady().then(setGlobalInstantChatOn).catch(() => setGlobalInstantChatOn(false));

    void (async () => {
      const globalConfig = await ActiveMsgClient.getGlobalConfig();
      const pushStatus = await ActiveMsgClient.getPushStatus();
      setGlobalReady(Boolean(globalConfig.workerUrl));
      setPushSummary(pushStatus.supported
        ? `Permission: ${pushStatus.permission} / Subscription: ${pushStatus.hasSubscription ? 'Ready' : 'Not created'}`
        : 'Web Push is not supported in this environment');
    })();

    // Which trigger the immersion-break guard most recently blocked. The guard is silent — if it
    // doesn't say anything, "yielded" looks exactly like "never sent" to the user.
    void (async () => setLastSkip(await ActiveMsgClient.readLastSkip(char.id)))();

    void (async () => {
      let remote: Set<string>;
      let remoteTasks: RemoteTaskProjection[];
      try {
        // Fetches the full projection in one go: uuid becomes the reconciliation baseline,
        // status / lastError let task cards explain "why it didn't send last time it was due",
        // and nextSendAt gives recurring tasks the actual time they'll next fire.
        remoteTasks = await ActiveMsgClient.listRemoteTasksForChar(char.id);
        remote = new Set(remoteTasks.map((t) => t.uuid));
        setRemoteTaskInfo(new Map(remoteTasks.map((t) => [
          t.uuid, { status: t.status, lastError: t.lastError },
        ])));
      } catch {
        // A reconciliation failure shouldn't be disruptive: null hides the "not found on remote" badge entirely and doesn't clear any tasks.
        setKnownRemoteUuids(null);
        return;
      }
      setKnownRemoteUuids(remote);

      // Reconciliation runs both directions: it clears out one-off tasks that have already fired
      // (otherwise sent tasks would just keep piling up here, needing manual cancellation one by
      // one), and it also pulls back in anything that exists remotely but not locally — a task the
      // character scheduled for itself gets claimed via push, and if that push fails to deliver or
      // gets swallowed by the immersion-break guard, the local side never learns it exists, even
      // though it still fires on schedule. First probe against this render-time snapshot to check
      // whether anything changed, so the panel isn't writing to storage every time it opens.
      // The actual persisted write recomputes from the latest prev inside the updater — saving in
      // the panel has to await a network request, during which the character may have scheduled a
      // new task via a tool in chat.
      const settle = (tasks: ActiveMsg2TaskRecord[]) =>
        pruneFiredTasks(reconcileTasksWithRemote(tasks, remoteTasks), remote, Date.now());
      const current = char.activeMsg2Config?.tasks ?? [];
      const settled = settle(current);
      const changed = settled.length !== current.length
        || settled.some((t, i) => t !== current[i]);
      if (changed) {
        onSave((prev) => ({
          ...(prev ?? { enabled: true, tasks: [] }),
          tasks: settle(prev?.tasks ?? []),
        }));
      }
    })();
    // char.activeMsg2Config is only read inside the function body as a probe, and deliberately
    // not in the dependency array — the cleanup write changes it, and including it would create a
    // self-triggering "clean up → rerun → clean up again" loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, char.id]);

  /**
   * Assembles the config to persist:
   *   - Character-level shared settings (enabled / maxTokens / secondary API) follow the panel's
   *     form — only the panel edits these;
   *   - The task list follows "the latest list at the moment of the write", with the panel only
   *     declaring which task it touched, via tasksOf.
   * Don't pass down the whole render-time tasks snapshot — see onSave's comment for why.
   */
  const buildConfig = (
    prev: ActiveMsg2CharacterConfig | undefined,
    tasksOf: (prevTasks: ActiveMsg2TaskRecord[]) => ActiveMsg2TaskRecord[],
    extra?: Partial<ActiveMsg2CharacterConfig>,
  ): ActiveMsg2CharacterConfig => ({
    enabled: true,
    tasks: tasksOf(prev?.tasks ?? []),
    // Stores undefined while on (= follows the global default), only writes false when explicitly turned off.
    instantChatEnabled: instantChatOn ? undefined : false,
    maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
    maxUnansweredSends: maxUnanswered === '' ? undefined : Number(maxUnanswered),
    useSecondaryApi: useSecondaryApi && !!secUrl,
    secondaryApi: useSecondaryApi && secUrl
      ? { baseUrl: secUrl.trim(), apiKey: secKey.trim(), model: secModel.trim() }
      : undefined,
    lastSyncedAt: prev?.lastSyncedAt,
    ...extra,
  });

  /**
   * Flipping the toggle itself counts as a save.
   *
   * This is a settings modal — once the user flips the toggle, they assume it's already in
   * effect. If we only change React state without writing to storage, the character's
   * activeMsg2Config stays empty (= off): the scheduling tool doesn't get injected in chat,
   * fire_pack's selfScheduleEnabled uploads as false, and reopening the panel shows the toggle
   * as "off" again — all without a single warning anywhere.
   *
   * Only the "on" side persists in place. "Off" goes through the "Turn off 2.0" button at the
   * bottom instead: turning off has to also cancel all of that character's remote tasks at the
   * same time. Writing enabled:false in place here, with nobody handling the remote tasks, would
   * turn them into ghost tasks — invisible to the panel but still firing on schedule.
   */
  const handleToggleEnabled = () => {
    const turningOn = !enabled;
    setEnabled(!enabled);
    // Also carries along the panel's other character-level settings (maxTokens / burst cap /
    // secondary API) while we're at it, consistent with buildConfig's contract — these fields
    // are only ever written by the panel anyway.
    if (turningOn) onSave((prev) => buildConfig(prev, (list) => list));
  };

  /**
   * The Instant Chat toggle also persists as soon as it's flipped (same habit as above). It has
   * no remote tasks to clean up — turning it off only affects routing for future turns — so both
   * directions of the toggle can save in place. Note it can't go through buildConfig: that pins
   * enabled to true, and Instant Chat and scheduling are two independent toggles — turning one on
   * shouldn't accidentally turn scheduling on too.
   */
  const handleToggleInstantChat = () => {
    const next = !instantChatOn;
    // The global toggle has its own event; this one is tracked separately to see whether anyone actually uses the per-character override.
    trackEvent('Toggle Character Instant Chat', { action: next ? 'On' : 'Off' });
    setInstantChatOn(next);
    onSave((prev) => ({
      ...(prev ?? { enabled: false }),
      // Stores undefined while on (= follows the global default), only writes false when explicitly turned off.
      instantChatEnabled: next ? undefined : false,
    }));
  };

  /**
   * Leaves the character a note that says "these were manually cancelled."
   *
   * A line like "I'll wake you up at 8am tomorrow~" in the chat history is a promise the
   * character made itself, and it has no way of knowing once the task gets deleted in the panel —
   * next chat it'll still say "don't worry, I'll wake you." So cancellations also get written to
   * the voided-notice ledger (idempotent by id), and the next turn's schedule-status block reads
   * it back to tell the character. A write failure doesn't block the cancellation itself — the
   * task really is gone either way.
   */
  const writeCancelledNotices = async (cancelled: ActiveMsg2TaskRecord[]) => {
    const notices = buildUserCancelledNotices(char.id, cancelled, Date.now());
    if (!notices.length) return;
    try {
      await ActiveMsgStore.upsertExpiredNotices(char.id, notices);
    } catch (e) {
      console.warn('[ActiveMsg2Modal] Failed to write cancellation notice (character may still think the promise stands)', e);
    }
  };

  const handleCancelTask = async (t: ActiveMsg2TaskRecord) => {
    // alreadyGone = the remote side never had this one to begin with (one-off tasks get deleted
    // once sent). This still counts as a successful cancellation — the copy just clarifies it, so
    // the user doesn't think they just intercepted a message that hadn't been sent yet.
    let alreadyGone = false;
    try {
      ({ alreadyGone } = await ActiveMsgClient.cancelTask(t.taskUuid));
    } catch (e) {
      // A failed remote cancellation doesn't remove the local record (Codex #4) — otherwise the remote side still fires it while the panel can no longer see it.
      console.warn('[ActiveMsg2Modal] Remote cancellation failed (keeping the record for retry)', e);
      onSave((prev) => buildConfig(prev, (list) =>
        list.map((x) => x.taskUuid === t.taskUuid ? { ...x, lastError: 'Remote cancellation failed, you can retry' } : x)));
      addToast(`Task [${shortTaskId(t.taskUuid)}] failed to cancel (not confirmed by the remote), try again later.`, 'error');
      // If scheduling is tracked but cancelling isn't, the task lifecycle is only half-recorded.
      // Each of the three outcomes means something different: failed = the remote side still
      // fires it while the panel thinks it blocked it — the most painful kind of reconciliation mismatch.
      trackEvent('Cancel Scheduled Message', { result: 'failed' });
      return;
    }
    if (editingTaskUuid === t.taskUuid) setEditingTaskUuid(null);
    await writeCancelledNotices([t]);
    setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, { gone: [t.taskUuid] }));
    // The write goes through onSave → OSContext.updateCharacter, which marks the amsg2 cloud
    // snapshot dirty (markAmsgStateDirty) once the storage write succeeds — so the schedule list
    // the character sees in fire_pack won't still contain this cancelled task. Don't mark it dirty
    // here using the render-time char snapshot — its list is still stale.
    onSave((prev) => buildConfig(
      prev,
      (list) => list.filter((x) => x.taskUuid !== t.taskUuid),
      { lastSyncedAt: Date.now() },
    ));
    addToast(alreadyGone
      ? `Task [${shortTaskId(t.taskUuid)}] no longer exists on the remote (it was most likely already sent), removed from the list.`
      : `Task [${shortTaskId(t.taskUuid)}] cancelled.`, 'info');
    trackEvent('Cancel Scheduled Message', { result: alreadyGone ? 'not_found' : 'ok' });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (!enabled) {
        // Turning off 2.0 = cancelling all of this character's remote tasks (the "remote list wins"
        // contract is documented in cancelAllTasksForChar, shared with character deletion). Ones
        // that fail to cancel stay in the local list so they can be retried next time the panel opens.
        const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(
          char.id,
          tasks.map((t) => t.taskUuid),
        );
        const attempted = new Set(targets);
        // The ones that were actually cancelled (attempted and didn't fail) get a note to the
        // character, otherwise it's left holding a pile of promises nobody's going to keep after
        // 2.0 gets turned off. The ones still left in the list (failed to cancel / newly appeared
        // in the meantime) don't get one — they'll still fire.
        await writeCancelledNotices(tasks.filter((t) =>
          attempted.has(t.taskUuid) && !failed.has(t.taskUuid)));
        onSave((prev) => buildConfig(
          prev,
          (list) => keepUncancelledTasks(list, attempted, failed, {
            failed: 'Remote cancellation failed while turning off, you can retry',
            appeared: 'Newly appeared while turning off Proactive Message, not cancelled, please handle separately',
          }),
          { enabled: false, lastSyncedAt: Date.now() },
        ));
        addToast(failed.size
          ? `Proactive Message 2.0 turned off, but ${failed.size} task(s) failed to cancel remotely — please reopen the panel later to retry.`
          : 'Proactive Message 2.0 turned off, all tasks cancelled.', failed.size ? 'error' : 'info');
        onClose();
        return;
      }

      if (!globalReady) throw new Error('Please finish the global "Proactive Message 2.0" setup in System Settings first.');

      // What's in the time field is the user's own wall clock; fold it into an absolute instant
      // before passing it down. Handing over a bare wall-clock time would have the scheduling
      // endpoint interpret it in the character's timezone instead (that rule exists for the
      // character's own self-scheduling) — the moment the character has a custom timezone set,
      // it'd be off by the offset. The persisted value stores this same absolute instant too, so
      // the panel's display and remote reconciliation agree on the same moment.
      const firstSendAt = fromDatetimeLocalValue(firstSendTime);

      // This copy passed to the scheduling endpoint is only used to read character-level settings
      // (cap validation / secondary API) — it doesn't get persisted.
      const config = buildConfig(saved, () => tasks);
      const result = await ActiveMsgClient.scheduleCharacterTask({
        char, config,
        task: {
          mode, firstSendTime: firstSendAt, recurrenceType,
          promptHint: promptHint.trim() || undefined,
          userMessage: userMessage.trim() || undefined,
          expirePolicy,
        },
        replaceTaskUuid: editingTaskUuid ?? undefined,
        userProfile, groups, realtimeConfig, apiConfig,
      });

      const record: ActiveMsg2TaskRecord = {
        taskUuid: result.uuid,
        clientTaskId: result.clientTaskId,
        mode, firstSendTime: result.firstSendAt, recurrenceType,
        promptHint: promptHint.trim() || undefined,
        userMessage: userMessage.trim() || undefined,
        expirePolicy: resolveExpirePolicy(mode, expirePolicy),
        source: 'user',
        status: 'scheduled',
        createdAt: Date.now(),
      };
      onSave((prev) => buildConfig(
        prev,
        // The rule for merging into the list (including keeping the old record when a replacement
        // fails) is shared with the character-tool path, via applyScheduledTask.
        (list) => applyScheduledTask(list, record, {
          replaceTaskUuid: editingTaskUuid ?? undefined,
          replacedCancelFailed: result.replacedCancelFailed,
        }, Date.now()),
        { lastSyncedAt: Date.now() },
      ));
      // If the scheduling endpoint returns success, this task really exists remotely — record it in
      // the baseline so it doesn't get flagged as "not found on remote". When editing, the old
      // task only drops out once its cancellation succeeds; if the cancellation failed, old and
      // new coexist remotely, so the old uuid needs to stay.
      setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, {
        present: [result.uuid],
        gone: editingTaskUuid && !result.replacedCancelFailed ? [editingTaskUuid] : [],
      }));
      // Only reports the enum shape — no content, time, or id is ever included. mode/recurrence do
      // have TS types, but the edit path reads them back from a persisted task record (an
      // imported backup could carry an arbitrary string), so they're narrowed at runtime right
      // before reporting.
      trackEvent('Schedule Timed Message', {
        mode: mode === 'fixed' || mode === 'prompted' ? mode : 'auto',
        recurrence: recurrenceType === 'daily' || recurrenceType === 'weekly' ? recurrenceType : 'none',
        source: 'user',
        isEdit: editingTaskUuid ? 'yes' : 'no',
      });
      setEditingTaskUuid(null);
      // Editing works by "create the new one first, then cancel the old one," so the id is bound to
      // change — if we only said "updated," the user would think the unfamiliar id in the list
      // was an extra, unrelated entry.
      addToast(result.replacedCancelFailed
        ? 'New task created, but the old task failed to cancel — please retry later.'
        : (editingTaskUuid
          ? `Task updated, id changed to [${shortTaskId(result.uuid)}].`
          : `Task created [${shortTaskId(result.uuid)}].`),
      result.replacedCancelFailed ? 'error' : 'success');

      // The character-level API (secondary API toggle / the three fields) may have just been
      // changed this time: on a Worker that supports the credentials table, overwriting this
      // character's rows is enough for already-scheduled tasks (including ones the character
      // scheduled itself) to pick it up next time they fire. On an older Worker this is a no-op,
      // and credentials get patched one by one below instead.
      syncAmsgLlmCredentials(apiConfig);
      // The character-level API may also have just changed this time: the task just scheduled
      // already carries the new credentials (computed at schedule time), but the ones frozen into
      // this character's **other** pending AI tasks are still the old ones — refresh them in
      // place here. The render-time list is used as an approximation of "other tasks" — any new
      // task the character just scheduled via a tool during this save will be missed, and gets
      // picked up on the next save or the next global-API save instead. A failure here is only
      // surfaced as a toast — it shouldn't fall into the outer catch and mark the whole save as failed.
      const otherAiTasks = tasks.filter((t) =>
        t.taskUuid !== result.uuid
        && t.taskUuid !== editingTaskUuid
        && isPendingTask(t, Date.now()));
      if (otherAiTasks.length > 0) {
        try {
          const refresh = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
            char, config, apiConfig, tasks: otherAiTasks,
          });
          if (refresh.status === 'partial') {
            addToast(`Failed to refresh API credentials for ${refresh.failed} task(s) of this character, saving again later can retry.`, 'error');
          }
        } catch (refreshError) {
          console.warn('[ActiveMsg2Modal] Failed to refresh API credentials for the remaining tasks', refreshError);
        }
      }
    } catch (error: any) {
      const message = error?.message || 'Failed to save Proactive Message 2.0.';
      onSave((prev) => buildConfig(prev, (list) => list, { lastError: message }));
      addToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Proactive Message 2.0"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={isSubmitting} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {isSubmitting ? 'Saving...' : !enabled ? 'Turn Off 2.0' : (editingTaskUuid ? 'Save Changes' : 'New Task')}
          </button>
        </>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p className="text-xs leading-relaxed text-slate-500">
          This is the new cloud-based Proactive Message entry point. It submits the current character settings, a recent chat snapshot, and your push subscription together to the Proactive Message standard service. For long-cycle recurring tasks, it's recommended to save again after story developments, to avoid running on stale context.
        </p>

        <div className="flex items-center justify-between bg-fuchsia-50 border border-fuchsia-100 rounded-2xl p-4">
          <div>
            <div className="font-bold text-slate-700">Enable Proactive Message 2.0</div>
            <div className="text-xs text-fuchsia-600 mt-1">{pushSummary || 'Checking Push status...'}</div>
          </div>
          <button
            onClick={handleToggleEnabled}
            className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* When it's off, the whole panel below is empty — without saying anything, the user can't
            tell this toggle is per-character, or know what turning it on would get them. */}
        {!enabled ? (
          <p className="text-xs leading-relaxed text-slate-400 pl-1">
            Proactive Message 2.0 is turned on per character. Turn on this toggle and they can schedule timed messages for you in chat, sent by the cloud when due — you can also manually create tasks here.
          </p>
        ) : null}

        {/* Instant Chat can be turned off per character, independently from the scheduling toggle
            above (scheduling-only or instant-only both work), so it isn't wrapped inside enabled.
            When the global gate is off, this is only grayed out with an explanation — it doesn't
            replace the global gate. */}
        <div className={`flex items-center justify-between rounded-2xl p-4 border ${globalInstantChatOn ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-100'}`}>
          <div className="min-w-0 pr-3">
            <div className={`font-bold ${globalInstantChatOn ? 'text-slate-700' : 'text-slate-400'}`}>Instant Chat</div>
            <div className="text-xs text-slate-400 mt-1 leading-relaxed">
              {globalInstantChatOn
                ? 'While it is on, their replies are generated in the cloud and delivered via push — you can lock your screen right after sending. Turn it off and this character goes back to generating locally.'
                : 'Instant Chat needs to be turned on in the global settings first before you can adjust it per character.'}
            </div>
          </div>
          <button
            onClick={handleToggleInstantChat}
            disabled={!globalInstantChatOn}
            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${globalInstantChatOn && instantChatOn ? 'bg-fuchsia-500' : 'bg-slate-200'} ${!globalInstantChatOn ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${globalInstantChatOn && instantChatOn ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* When the guard blocks a trigger, no push is sent at all, yet the remote task row still
            gets consumed — without saying anything, "yielded" looks exactly like "never sent /
            something's broken" to the user. */}
        {enabled && lastSkip ? (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-slate-600">
            {describeLastSkip(lastSkip, (ms) => formatTaskTime(new Date(ms).toISOString()))}
          </div>
        ) : null}

        {enabled && tasks.length > 0 ? (
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
              Task List ({tasks.length})
            </label>
            {/* All tasks within one render use the same "now", so cards on screen aren't judged against different moments. */}
            <div className="space-y-2">
              {tasks.map((t) => {
                // Recurring tasks display "next time", not the anchor time from when they were created (see currentOccurrenceMs).
                const occurrenceMs = currentOccurrenceMs(t, now);
                const missingRemote = isRemoteMissingTask(t, knownRemoteUuids, now);
                const remoteInfo = remoteTaskInfo?.get(t.taskUuid);
                // The remote-recorded "didn't send last time" — the worker only writes this on failure and
                // doesn't clear it on success, so including a timestamp in the copy keeps an old
                // record from being read as "still broken right now".
                const remoteErrorText = describeRemoteLastError(remoteInfo?.lastError, formatTaskTime);
                return (
                  <div key={t.taskUuid} className={`rounded-2xl border px-4 py-3 text-xs ${editingTaskUuid === t.taskUuid ? 'border-fuchsia-400 bg-fuchsia-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-700 truncate">
                          [{shortTaskId(t.taskUuid)}] {formatTaskTime(occurrenceMs ?? t.firstSendTime)} · {describeRecurrence(t.recurrenceType)}
                        </div>
                        {/* Progress goes first: this line gets truncated, and "did it send" is the thing the user most
                            wants to see first — if it were placed last (mode descriptions can be
                            long), it would never be visible. */}
                        <div className="text-slate-400 mt-0.5 truncate">
                          {describeTaskProgress(t, knownRemoteUuids, now, remoteInfo?.status)} · {describeTaskMode(t)}
                          · {describeExpirePolicy(t.expirePolicy)}
                          · {t.source === 'character' ? 'Created by character' : 'Created manually'}
                        </div>
                        {missingRemote ? (
                          <div className="text-slate-400 mt-1 text-[11px]">⚠ Not found on remote (may have already been sent, or cancelled elsewhere)</div>
                        ) : null}
                        {remoteErrorText ? (
                          <div className="text-amber-600 mt-1 text-[11px]">⚠ {remoteErrorText}</div>
                        ) : null}
                        {t.lastError ? (
                          <div className="text-red-500 mt-1 text-[11px]">{t.lastError}</div>
                        ) : null}
                      </div>
                      <div className="flex gap-2 shrink-0 ml-2">
                        <button onClick={() => setEditingTaskUuid(t.taskUuid)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold">Edit</button>
                        <button onClick={() => void handleCancelTask(t)} className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 font-bold">Cancel</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {editingTaskUuid ? (
              <button onClick={() => setEditingTaskUuid(null)} className="mt-2 text-xs text-fuchsia-500 font-bold pl-1">
                ＋ Discard edit, create a new task instead
              </button>
            ) : null}
          </div>
        ) : null}

        {enabled ? (
          <>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
                {editingTaskUuid ? 'Edit Task' : 'New Task'}
              </label>
              <div className="space-y-2">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => {
                      setMode(option.id);
                      // fixed can't reach the worker gate (taskNeedsLlm=false), so the policy is uniformly pinned to force.
                      if (option.id === 'fixed') setExpirePolicy('force');
                    }}
                    className={`w-full text-left rounded-2xl border px-4 py-3 transition-all ${mode === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    <div className="font-bold">{option.label}</div>
                    <div className={`text-xs mt-1 ${mode === option.id ? 'text-fuchsia-50' : 'text-slate-400'}`}>{option.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">First send time</label>
              <input
                type="datetime-local"
                value={firstSendTime}
                onChange={(event) => setFirstSendTime(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">Recurrence</label>
              <div className="grid grid-cols-3 gap-2">
                {RECURRENCE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRecurrenceType(option.id)}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${recurrenceType === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 mt-2 pl-1">
                The 2.0 standard edition currently only supports: Once / Daily / Weekly. Intervals like 30 minutes, 1 hour, or 2 hours are not supported yet.
              </div>
            </div>

            {mode !== 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">When it is due while you are chatting</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'expire', label: 'Auto-void', desc: 'Worked naturally into the conversation instead' },
                    { id: 'force', label: 'Force send', desc: 'Alarm-clock style, sends regardless' },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setExpirePolicy(option.id)}
                      className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${expirePolicy === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                    >
                      {option.label}
                      <div className={`font-normal mt-0.5 ${expirePolicy === option.id ? 'text-fuchsia-100' : 'text-slate-400'}`}>{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {mode === 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Fixed message content</label>
                <textarea
                  value={userMessage}
                  onChange={(event) => setUserMessage(event.target.value)}
                  placeholder="This message is pushed directly once it is due"
                  className="w-full h-28 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
                    {mode === 'prompted' ? 'Extra prompt' : 'Extra inspiration (optional)'}
                  </label>
                  <textarea
                    value={promptHint}
                    onChange={(event) => setPromptHint(event.target.value)}
                    placeholder={mode === 'prompted' ? 'e.g.: be a bit clingy before saying goodnight, but do not overdo it' : 'e.g.: it is raining today, want to chat about something light'}
                    className="w-full h-24 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">maxTokens (optional)</label>
                  <input
                    type="number"
                    min={1}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="e.g. 120"
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
                  />
                </div>
              </>
            )}

            <div className="pt-1 border-t border-slate-100">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Consecutive send limit</label>
              <select
                value={maxUnanswered}
                onChange={(event) => setMaxUnanswered(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              >
                <option value="">Default ({DEFAULT_MAX_UNANSWERED_SENDS})</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>{n}</option>
                ))}
                <option value="0">Unlimited</option>
              </select>
              <p className="text-xs text-slate-400 mt-1.5 pl-1 leading-relaxed">
                The most messages they can send in a row without a reply from you — this is the cap on how many
                times in a row they can speak up on their own (including follow-ups they schedule for
                themselves). Once the cap is hit, the ones they scheduled themselves pause, and one reply
                from you resets the count; tasks you schedule by hand in this panel aren't limited by it.
                For example, if the two of you are in different time zones and you want them to check in
                every so often while you're asleep, set this higher.
              </p>
            </div>

            <div className="pt-1 border-t border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-bold text-slate-700">Use a secondary API</div>
                  <div className="text-xs text-slate-400 mt-1">When off, reuses the main chat API.</div>
                </div>
                <button
                  onClick={() => setUseSecondaryApi(!useSecondaryApi)}
                  className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {useSecondaryApi ? (
                <div className="space-y-3 bg-slate-50 rounded-2xl p-3">
                  <input value={secUrl} onChange={(event) => setSecUrl(event.target.value)} placeholder="API URL" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <input type="password" value={secKey} onChange={(event) => setSecKey(event.target.value)} placeholder="API Key" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <input value={secModel} onChange={(event) => setSecModel(event.target.value)} placeholder="Model" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsg2SettingsModal);
