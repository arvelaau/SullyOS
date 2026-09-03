import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import { ActiveMsg2GlobalConfig, RealtimeConfig } from '../../types';
import {
  ActiveMsgClient, ActiveMsg2PushStatus, fetchWorkerDiagnostics, readAmsgFailKind,
} from '../../utils/activeMsgClient';
import {
  AmsgDiagnosticLevel, AmsgDiagnosticsProbe,
  buildAmsgDiagnosticRows, summarizeAmsgDiagnostics,
  INSTANT_CHAT_BLOCKER_HINTS, resolveInstantChatBlocker,
  type InstantChatGateInput,
} from '../../utils/amsgDiagnostics';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';
import { cancelAllRemoteAmsgTasks, isWorkerUrlCleared, wipeAmsgCloudData } from '../../utils/amsgStateSync';
import {
  buildCloudflareDashboardUrl,
  isInstantConfigReady,
  loadInstantConfig,
  saveInstantConfig,
} from '../../utils/instantPushClient';
import { generateClientToken } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid } from '../../utils/pushVapid';
import {
  attachUpdateCapability,
  provisionAmsgBackend,
  waitForWorkerReady,
  type CfAccount,
  type ProvisionProgress,
} from '../../utils/cfProvision';
import { isAmsgServerVersionAtLeast } from '../../utils/amsgWorkerVersion';
import { trackEvent } from '../../utils/analytics';

// Full-strength link-up requires all of these worker features (amsg-server 2.6.0-next.4+).
// If the endpoint can't be detected (old deployment 404 → null) or any feature is missing,
// show the "redeploy" prompt — the worker runs on the user's own account, so a new release
// on our side doesn't auto-sync over there.
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
  // Background fire passes the tools parameter to the LLM every round (so the character can use the user's own configured MCP tools in proactive messages).
  'agentic-fire-tools',
  // The hook payload carries its own readState / writeState, so a config-level hook no longer has to assemble its own write port.
  'hook-state-accessors',
  // onAfterSend receives this fire's scratch: the self-log write-back is settled against the segments actually sent.
  'after-send-scratch',
  // Task identity hangs directly off ctx and the push top level, so the two scheduling paths don't each need their own copy of metadata.
  'fire-task-identity',
  'push-task-identity',
  // Library-exported envelope reserved-bytes constant — push size is calculated against the size "after the library fills in its fields."
  'push-envelope-reserved-bytes',
  // When a character's self-scheduling collides, fall back to the projection of the already-existing row, and the rerun of that round is still accounted for.
  'schedule-task-duplicate-row',
  // Fast-forwarding an expired recurring task also fires the callback, so the accumulated skips are visible on the panel.
  'recurring-stale-skip-hook',
  // Task rows carry a timezone, so daily / weekly advance by the character's own local wall-clock time.
  'task-timezone',
  // Push subscription is stored once per user rather than carried by the schedule; after switching subscriptions, already-scheduled tasks pick it up automatically.
  'user-push-subscription',
  // Credentials are stored as a row in a table, and tasks only carry a reference (credRefs). Rotating a key only requires overwriting that one row, and
  // scheduled tasks — including ones the character scheduled for itself when triggered — use the new credential on their next trigger. Without this it falls
  // back to the old approach of freezing credentials into every task: rotating a key means patching every task individually, and missing one means a 401 when it comes due.
  'llm-credentials',
];
// Beyond features, the version also has to be compared: most of the capabilities this batch
// depends on never shipped an independent flag, so checking features alone can't tell old from new.
//   next.5 — GET /messages projection (charId/clientTaskId), onBeforeFire's { skip } exit
//   next.6 — task placeholder lease (tool-using AI tasks often run past a minute; without a
//            placeholder, an adjacent cron tick would re-push the same task)
//   next.7 — hook's writeState (large content bypasses to client_state storage), Web Push
//            payload size guard rail
//   next.8 — fire loop passes through the tools request parameter (prerequisite for background
//            calls into the user's own configured MCP)
//   next.9 — this tier also doubles as the criterion for "does the bundle have a self-log
//            write-back": after the character sends, it records the body back to client_state
//            so it can continue on schedule next time (fire_pack's self_log slot), shipped up
//            together with this wave's bundle. An old bundle receiving a fire_pack with the slot
//            will just forward `{{AMSG_SELF_LOG}}` to the LLM verbatim as-is, and SERVER_VERSION
//            is the amsg-server version at the time of packaging — exactly what's needed to
//            recognize this kind of stale paste.
//   next.11 — push subscription switched to one stored per user: from this tier on, the schedule
//            no longer carries the subscription; the frontend registers via the /push-subscription
//            endpoint instead, which doesn't exist on old workers.
//   next.12 — "what the character has already said" persistence moved onto onFireSettled (called
//            once regardless of whether this round was sent, skipped, or threw). An old worker
//            doesn't recognize this hook and will just ignore it as unrelated config — and since
//            the bundle side no longer uses onAfterSend, the result is self_log never gets written:
//            the character has no idea what it said last time when its schedule comes due, and
//            repeats the same line every day. The same tier also adds same-character task
//            serialization for a run-tick (serializeBy).
//   next.15 — this tier is capability-dense, and the wrapper inside the bundle has been rewritten
//            to match new upstream behavior: Instant Chat's immediate expires the moment it's
//            persisted + atomic supersedesUuid replacement; llmExtraBody (the thinking-chain
//            three-piece set goes to the cloud); lease heartbeat renewal (the wrapper no longer
//            configures claimLeaseMs; without a heartbeat, old upstream falls back to a 10-minute
//            dead lease, and tasks just wait after the isolate dies); fire ctx's cancelTask /
//            renewTask (the character canceling / rescheduling its own schedule); client_state
//            conditional writes (an old packet won't overwrite a new one); task row last_error
//            (failure reason becomes inspectable).
//   next.16 — Instant Chat moved to being kicked off by a Durable Object, relying on this tier's
//            runTask (runs a single task by uuid); error responses carry error.cause (the real
//            cause no longer only goes into the worker log); getSchemaVersion (whether the table
//            structure matches, compared by upstream against its own table-creation statements).
//   next.17 — user-level LLM credentials table (PUT/GET/DELETE /llm-credentials), task credRefs,
//            fire hook's resolveLlmCredential. This tier has its own independent flag (the
//            'llm-credentials' one above); the version number is listed here just as a backup check.
//   next.20 — when a push is declared dead by the push service (410 / 404), treat it as terminal
//            and stop idly retrying — delivery generates first and pushes second, so every retry
//            hop wastes a full round of LLM generation for nothing; at the same time, write the
//            status code into last_error's pushStatus in structured form, which the health check's
//            "this device" row uses to expose "registered all-green but nothing ever arrives."
//            Also, client_state prefix cleanup switched to a lexicographic range scan: D1 caps the
//            LIKE pattern at 50 bytes (undocumented officially), and once a key gets long enough the
//            whole statement reports pattern too complex, rolling back the state write from the
//            same batch along with it.
//   next.21 — endpoints with a body now recognize `Content-Encoding: gzip`: on the Instant Chat
//            path, the body (the whole chat turn) is compressed client-side before sending, and an
//            old worker that doesn't recognize this header reads the compressed bytes as plain
//            text, surfacing as "request body is not valid JSON" — large messages can't be sent at
//            all. The same tier also adds errorCode in failure records (things like
//            `LLM_CALL_FAILED`) and the verbatim text of upstream's rejection: the "generation
//            failed" line on the card can now say whether it was a wrong model name, insufficient
//            balance, or an expired subscription that needs re-registering.
//   next.23 — upgraded alongside amsg-shared 0.4.0-next.8: shared's notification field validation
//            now allows `silent: 'when-visible'` (muting is now computed by the Service Worker based
//            on window visibility). No behavior change on the server side — upgrading this tier alone
//            solves nothing; what actually needs the user to tap "Update Worker" once for this batch
//            is the notification policy itself, see utils/amsgBundleVersion.ts.
// Without comparing versions, an old paste-deployment would be misjudged as up to date, and the
// problem would happen entirely silently on the worker side.
const REQUIRED_WORKER_VERSION = '2.6.0-next.23';

/** The deployment repo holding the packaged worker code: fork it → connect it on Cloudflare → tap Sync fork to update later. */
const WORKERS_REPO_URL = 'https://github.com/Tosd0/sullyos-workers';
const SETUP_WALKTHROUGH_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md';
/** Where the API Token needed for one-click deploy gets created. */
const CF_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

// The probe result is only reported once per session. refresh() runs on opening the panel, on
// successful connect, and on successful subscription — otherwise someone whose connection keeps
// failing and who repeatedly taps "Connect" could single-handedly flood a dozen identical results
// and skew the distribution.
let workerCapsReported = false;
// "Where Instant Chat is stuck when it can't be enabled" is likewise only reported once per session, for the same reason.
let instantChatGateReported = false;

/** Colors and the small-print word for each health-check row. unknown uses gray: don't imply good or bad with color when there's no conclusion to reach. */
const DIAGNOSTIC_STYLES: Record<AmsgDiagnosticLevel, { dot: string; text: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600', word: 'OK' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', word: 'Note' },
  bad: { dot: 'bg-rose-500', text: 'text-rose-600', word: 'Issue' },
  unknown: { dot: 'bg-slate-300', text: 'text-slate-400', word: 'Unknown' },
};

/** The plaintext of a freshly generated secret: the input field is password-type, so this is the only place the user can see it and copy it by hand. */
const SecretReveal: React.FC<{ value: string; className?: string }> = ({ value, className = '' }) => (
  <p className={`font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5 ${className}`}>
    {value}
  </p>
);

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** "Clear Cloud Data" needs to immediately re-upload tool credentials right after clearing, so the current config is needed here. */
  realtimeConfig: RealtimeConfig;
  /** Injected by Settings: opens the top-level PushVapidSettingsModal when "Go to push credentials panel" is tapped */
  onOpenVapid?: () => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
  realtimeConfig,
  onOpenVapid,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  // Manual paste deployment: a fallback for people without a GitHub account, collapsed by default so it doesn't get in the way of the main flow.
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  // Deno facade: only needed when workers.dev is unreachable from mainland China, collapsed by default.
  const [denoProxyOpen, setDenoProxyOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // "Generate Master Key" is only shown while the panel is open this time and is never persisted client-side — it's a worker-side secret, just paste it into the CF env.
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');
  const [generatedServerToken, setGeneratedServerToken] = useState('');

  // One-click deploy: fill in one CF Token, and everything else (creating the database,
  // uploading the worker, writing secrets, adding the schedule) happens automatically.
  // The token only stays in memory for the duration of this deployment and is never persisted
  // either way — it has permission to modify Workers across the whole account, and the one that
  // actually needs to be kept long-term has already been written as a secret into the user's own
  // worker (used for self-updates).
  const [cfToken, setCfToken] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState('');
  /** Lets the user pick one when the token can be used on multiple accounts. */
  const [provisionAccounts, setProvisionAccounts] = useState<CfAccount[] | null>(null);
  /** A brand-new CF account doesn't have a workers.dev subdomain yet, so one needs to be created first. */
  const [needsSubdomain, setNeedsSubdomain] = useState(false);
  const [desiredSubdomain, setDesiredSubdomain] = useState('');
  const [provisionError, setProvisionError] = useState('');

  // Attach update capability: a backend installed the old way doesn't have CF_API_TOKEN, so tapping update gets rejected.
  // Pasting in a token attaches it in place, no need to go to the Cloudflare dashboard. Only shown when the key is actually missing.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachToken, setAttachToken] = useState('');
  const [attachScriptName, setAttachScriptName] = useState('');
  const [attachNeedsScriptName, setAttachNeedsScriptName] = useState(false);
  const [attachAccounts, setAttachAccounts] = useState<CfAccount[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');

  // Health check: the worker's GET /debug result. It already computes "which variable is
  // missing, which table is missing, which columns are missing, whether cron has stopped" —
  // but the only way to reach it has always been hand-typing the URL, and these are exactly the
  // whole reason for "everything looks fine on screen, yet nothing is ever sent." Store the raw
  // probe result; the traffic-light indicator is computed at render time (and follows along
  // whenever push status changes).
  const [diagnosticsProbe, setDiagnosticsProbe] = useState<AmsgDiagnosticsProbe | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // The health check sits at the top, but is collapsed by default: once things are set up it
  // reads "all good" every single day, and expanding it would eat up half the screen.
  // The title row already states the conclusion; only expand it to see which item needs attention.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [workerOutdated, setWorkerOutdated] = useState(false);
  /**
   * Whether the backend code on the user's Worker is up to date (see ActiveMsgClient.probeWorkerVersion).
   * null = not probed yet (no address filled in / currently probing). The UI uses this to decide
   * whether the update button is highlighted to push for an update, or de-emphasized.
   */
  const [workerVersion, setWorkerVersion] = useState<
    { state: 'current' | 'outdated' | 'unknown'; deployed: string | null; expected: string } | null
  >(null);
  /** The code fingerprint the worker reports back after a successful self-update, shown so the user can confirm it really did change. */
  const [selfUpdateHash, setSelfUpdateHash] = useState('');
  // Instant Push is also on: chat would go through it, and everything 2.0 hangs on the local
  // path would silently stop working — the two mutual-exclusion gates on the settings page
  // normally already block this combination, so reading it once here is a safety net against
  // leftover dirty config; it updates immediately once turned off.
  const [instantOn, setInstantOn] = useState(false);
  // Whether this worker recognizes /instant-chat. This is the **only** version gate for Instant
  // Chat — no per-call preflight check is done elsewhere, since probing the network an extra
  // time on every message sent, and not even being able to tell an old version from a network
  // hiccup on failure, isn't worth it.
  const [instantChatSupported, setInstantChatSupported] = useState(false);

  // Feature probing: only show the flag once confirmed "too old" (endpoint 404 → null, or a key
  // feature missing); don't show it if the probe itself fails (offline / wrong secret / no
  // address filled in), to avoid false positives.
  const probeWorkerCaps = async (workerConfigured: boolean) => {
    // Only report when an address is configured: without one, this probe is guaranteed to fail, and that's not a version problem.
    const shouldReport = workerConfigured && !workerCapsReported;
    if (shouldReport) workerCapsReported = true;
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      const missingFeature = !caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f));
      const versionTooOld = !caps || !isAmsgServerVersionAtLeast(caps.serverVersion, REQUIRED_WORKER_VERSION);
      setWorkerOutdated(missingFeature || versionTooOld);
      // Running an old worker manifests as a **silent** failure (self-log write-back never
      // persists, tasks get pushed twice) — the user won't come report it, so this panel's
      // prompt is the only channel. What's being counted here is "how many people are currently
      // running a version they shouldn't be."
      if (shouldReport) {
        trackEvent('Probe 2.0 Worker Capabilities', {
          result: !caps ? 'Endpoint not found' : missingFeature ? 'Missing feature' : versionTooOld ? 'Version too old' : 'ok',
        });
      }
    } catch {
      setWorkerOutdated(false);
      // Don't show the flag if the probe itself blows up (offline / address unreachable), to
      // avoid false positives; but that's a different situation from "version is old" — give it
      // its own bucket, so this group can be excluded at a glance when looking at the distribution.
      if (shouldReport) trackEvent('Probe 2.0 Worker Capabilities', { result: 'Probe failed' });
    }
  };

  // The Worker address that's already been persisted. Needed for the clear-confirmation flow:
  // the address can't be changed before confirming, since the requests to cancel remote tasks still need to go to the old one.
  const savedWorkerUrlRef = useRef('');

  /**
   * Run one health check. Don't run it when no address is filled in — the only thing to do at
   * that point is fill in the address, and a row of red lights would just make it look broken.
   */
  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      setDiagnosticsProbe(await fetchWorkerDiagnostics());
    } finally {
      setDiagnosing(false);
    }
  };

  /**
   * Report once whether Instant Chat can be enabled right now, and where it's stuck if not.
   *
   * This event can only be captured here: while the toggle is grayed out the user can't tap
   * anything, so no other event would ever be generated — looking only at the on/off snapshot in
   * the config, someone who's blocked from the door and someone who "just doesn't want this
   * feature" would look identical. The determination reuses resolveInstantChatBlocker, the same
   * function as the yellow-text line in the UI, so the two never disagree with each other.
   */
  const reportInstantChatGate = (gate: InstantChatGateInput, enabled: boolean) => {
    if (instantChatGateReported) return;
    instantChatGateReported = true;
    trackEvent('Can Instant Chat Be Enabled', {
      result: resolveInstantChatBlocker(gate) ?? 'Can enable',
      // Also report for people who already have it on: them being blocked means "it worked fine
      // when they turned it on, but the Worker later fell back to an old version" — the kind of
      // failure where every message fails to send while the settings page still says "Enabled."
      state: enabled ? 'Already on' : 'Not on yet',
    });
  };

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    savedWorkerUrlRef.current = nextConfig.workerUrl || '';
    setConfig(nextConfig);
    setPushStatus(nextPushStatus);
    setInstantOn(isInstantConfigReady());
    void probeWorkerCaps(Boolean(nextConfig.workerUrl?.trim()));
    if (nextConfig.workerUrl?.trim()) {
      void ActiveMsgClient.probeWorkerVersion().then(setWorkerVersion);
      void ActiveMsgClient.probeInstantChatSupport().then((supported) => {
        setInstantChatSupported(supported);
        reportInstantChatGate({
          connected: Boolean(nextConfig.initializedAt),
          pushSubscribed: Boolean(nextPushStatus?.hasSubscription),
          workerSupportsInstantChat: supported,
          instantPushOn: isInstantConfigReady(),
        }, Boolean(nextConfig.instantChatEnabled));
      });
      void runDiagnostics();
    } else {
      setInstantChatSupported(false);
      setDiagnosticsProbe(null);
      setWorkerVersion(null);
    }
  };

  /** Turns off the Instant Push toggle; the worker address and other config are kept — no need to re-enter anything if switching back later. */
  const disableInstantPush = () => {
    saveInstantConfig({ ...loadInstantConfig(), enabled: false });
    setInstantOn(false);
    addToast('Instant Push has been turned off. Chat is back to local direct generation.', 'success');
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    setDiagnosticsOpen(false);
    setDeployOpen(false);
    setPasteFallbackOpen(false);
    // Clear both plaintext secrets: leaving them displayed until the panel is reopened is a needless extra exposure.
    setGeneratedMasterKey('');
    setGeneratedServerToken('');
    // Clear the CF Token even more so — it's more sensitive than the two above, and must never be left over for the next time the panel opens.
    setCfToken('');
    setProvisionAccounts(null);
    setNeedsSubdomain(false);
    setDesiredSubdomain('');
    setProvisionError('');
    setAttachOpen(false);
    setAttachToken('');
    setAttachScriptName('');
    setAttachNeedsScriptName(false);
    setAttachAccounts(null);
    setAttachError('');
    void refresh();
  }, [isOpen]);

  /**
   * Cleanup when the address is cleared: confirm first, then use the **old address** to cancel
   * remote tasks cleanly, and only then save the empty value.
   *
   * Just saving the empty value alone would stop all frontend-side syncing immediately, while
   * not a single task in D1 would actually go away: cron would still consume them every minute
   * as usual, still burn LLM calls, still push (the push subscription is also still there) — the
   * content would just be permanently stuck at whatever it was at the last sync. The user thinks
   * they've turned everything off, but has really just made themself the one who can no longer see it.
   */
  const confirmAndClearRemote = async (): Promise<boolean> => {
    const ok = confirm("Clearing the Worker address will also cancel any proactive message tasks still pending remotely. Are you sure?\n\nIf you don't cancel them, those tasks will still trigger and push to you on schedule, and you will no longer be able to manage them from here.");
    if (!ok) return false;
    const { total, failed, listed } = await cancelAllRemoteAmsgTasks();
    if (!listed) {
      addToast("Remote tasks could not be canceled and may still trigger as scheduled. Consider putting the address back and handling them one by one in the character's Proactive Message panel.", 'error');
    } else if (failed > 0) {
      addToast(`${failed} remote task(s) failed to cancel. Consider restoring the address and handling them in the panel.`, 'error');
    } else if (total > 0) {
      addToast(`Canceled ${total} remote task(s).`, 'info');
    }
    return true;
  };

  const persistGlobalConfig = async () => {
    if (!config) return;
    if (isWorkerUrlCleared(savedWorkerUrlRef.current, config.workerUrl)) {
      if (!await confirmAndClearRemote()) {
        // The user changed their mind: put the address back in the input field, rather than leaving a mismatch of "field shown empty, but the store still has it."
        patchConfig({ workerUrl: savedWorkerUrlRef.current });
        return;
      }
    }
    await ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
      instantChatEnabled: config.instantChatEnabled,
      // The Master Key generated by one-click deploy must also be persisted along with the rest — this is the only local copy, it can't be read back from the Worker side.
      masterKey: config.masterKey,
    });
    savedWorkerUrlRef.current = config.workerUrl || '';
  };

  useEffect(() => {
    if (!isOpen || !config) return;
    const timer = setTimeout(() => { void persistGlobalConfig(); }, 1000);
    return () => clearTimeout(timer);
  }, [config?.workerUrl, config?.serverToken, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', workerUrl: '' }),
      ...updates,
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      // Creating the browser subscription alone isn't enough — it also needs to be registered as
      // the user-level subscription on the worker, since that's what the worker reads when a
      // task comes due. If the subscription is only created in the browser, the cloud copy is
      // still empty, and it'll throw PUSH_SUBSCRIPTION_MISSING when a task comes due — even
      // though this toast has already said "ready."
      await ActiveMsgClient.registerPushSubscription();
      await refresh();
      addToast('Notification permission and push subscription are ready.', 'success');
      trackEvent('Enable Notifications & Push Subscription', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || 'Failed to create push subscription.', 'error');
      // Only report the code attached at the moment it was thrown (a fixed enum in the source).
      // The raw error text may include the push endpoint — keep it in the toast and console only, never in analytics.
      trackEvent('Enable Notifications & Push Subscription', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * One-click deploy: with nothing but a Cloudflare API Token, set up the backend from scratch,
   * and connect it right after.
   *
   * All secrets are generated locally, so the user never has to copy or paste anything. Anything
   * that already exists is always reused — rotating the Master Key would make every previously
   * scheduled task undecryptable, and rotating VAPID would 403 every existing browser push subscription.
   *
   * The token only stays in memory for the duration of this operation and is never persisted
   * either way. The copy that needs to be kept long-term has already been written as a secret
   * into the user's own Worker (that's what "update backend" uses later).
   */
  const handleOneClickDeploy = async (accountId?: string) => {
    const token = cfToken.trim();
    if (!token) {
      addToast('Enter your Cloudflare API Token first.', 'error');
      return;
    }

    setProvisioning(true);
    setProvisionError('');
    setProvisionStep('');
    try {
      const vapid = loadPushVapid();
      const result = await provisionAmsgBackend({
        token,
        accountId: accountId || undefined,
        desiredSubdomain: desiredSubdomain.trim() || undefined,
        secrets: {
          AMSG_MASTER_KEY: config?.masterKey || undefined,
          VAPID_PUBLIC_KEY: vapid.vapidPublicKey || undefined,
          VAPID_PRIVATE_KEY: vapid.vapidPrivateKey || undefined,
          VAPID_EMAIL: vapid.vapidEmail || undefined,
          AMSG_SERVER_TOKEN: config?.serverToken || undefined,
        },
        onProgress: (p: ProvisionProgress) => setProvisionStep(p.message),
      });

      if (!result.ok) {
        setProvisionStep('');
        // These two aren't failures, they're "one more piece of information needed" — fill in the extra input on screen and tap again to continue.
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setProvisionAccounts(result.accounts || []);
          trackEvent('One-Click Deploy 2.0 Backend', { result: 'Needs account selection' });
          return;
        }
        if (result.code === 'SUBDOMAIN_MISSING') {
          setNeedsSubdomain(true);
          setProvisionError(result.message);
          trackEvent('One-Click Deploy 2.0 Backend', { result: 'Needs subdomain' });
          return;
        }
        setProvisionError(result.message);
        trackEvent('One-Click Deploy 2.0 Backend', { result: 'Failed' });
        return;
      }

      // Persist secrets before connecting: connecting needs serverToken, and once the Master Key is lost it can never be read back.
      const { secrets } = result;
      savePushVapid({
        vapidPublicKey: secrets.VAPID_PUBLIC_KEY,
        vapidPrivateKey: secrets.VAPID_PRIVATE_KEY,
        vapidEmail: secrets.VAPID_EMAIL || undefined,
      });
      // Write instantChatEnabled along with it: by the time the panel renders, config is
      // guaranteed not to be null (there's an early-return on the empty value at the end of the
      // file), so what's read is the current on-screen value — not passing it along explicitly
      // would get overwritten by this save.
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
        instantChatEnabled: config?.instantChatEnabled,
      });
      patchConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
      });
      savedWorkerUrlRef.current = result.workerUrl;

      setProvisionAccounts(null);
      setNeedsSubdomain(false);
      setCfToken('');
      result.warnings.forEach((warning) => addToast(warning, 'info'));
      // Don't just call it "done" here and stop: the address still takes several dozen seconds
      // to become active across edge nodes, and the moment the patchConfig call above lands, the
      // one-click deploy card collapses because "the address is now filled in" — the progress
      // bar disappears along with it, making it look like everything's wrapped up. The user
      // would then go tap "Connect & Enable" and run straight into an address that isn't live yet.
      addToast(`Backend deployed: ${result.workerUrl}. The address takes a few dozen seconds to become active — just wait for it to connect on its own.`, 'success');
      trackEvent('One-Click Deploy 2.0 Backend', { result: 'Success' });

      // A freshly created workers.dev address takes a moment to resolve — wait for it to come alive before creating the tables.
      setProvisionStep('Waiting for Worker to start…');
      const ready = await waitForWorkerReady(result.workerUrl);
      if (!ready) {
        addToast("Worker deployed, but the address isn't live yet. Tap \"Connect & Enable\" again in a minute or two.", 'info');
        return;
      }
      setProvisionStep('Creating tables…');
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      addToast('Connected successfully. Proactive Message 2.0 is ready to use.', 'success');
    } catch (error: any) {
      // The raw error text goes into the UI only, never into analytics (it may include addresses or account IDs).
      setProvisionError(error?.message || 'Something went wrong during deployment.');
      trackEvent('One-Click Deploy 2.0 Backend', { result: 'Failed' });
    } finally {
      setProvisioning(false);
      setProvisionStep('');
    }
  };

  const handleConnect = async () => {
    if (!config?.workerUrl.trim()) {
      addToast('Enter the address of your deployed Worker first.', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: config.workerUrl,
        serverToken: config.serverToken,
        instantChatEnabled: config.instantChatEnabled,
      });
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      addToast('Connected successfully. Proactive Message 2.0 is ready to use.', 'success');
      // Connected, but with one part silently broken (most typically: VAPID not fully
      // configured — tasks can be created, but nothing ever gets pushed out when they come due,
      // with no visible anomaly on screen). The user has no way to discover this kind of problem
      // themself, so if it's not surfaced at the moment of connecting, no one ever will.
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      // Only report "did this connection succeed or not / which category it's stuck on." The
      // connection string / tenantToken / raw error text are never included, and neither is
      // "whether a tenant was previously configured" — that would compress the configuration
      // state of two separate credentials down into a single bit and ship it out. The failure
      // code is the literal attached by HTTP status at the moment of the throw (see
      // activeMsgClient's AmsgFailKind); it's kept separate because "credentials don't match"
      // and "D1 isn't bound" require the user to go fix completely different things.
      trackEvent('Connect & Enable Proactive Message 2.0', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || 'Connection failed.', 'error');
      trackEvent('Connect & Enable Proactive Message 2.0', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * Lets the backend update itself to the latest version.
   *
   * The three installation methods (fork-and-connect-Git / Deploy button / someone else set it
   * up) previously each had a different update process, and the most troublesome one involved
   * shuttling a several-hundred-KB file back and forth between two websites. With this button,
   * all of them become a single tap.
   *
   * After a successful update, follows up with a "connect and verify" run (POST /init-tenant, idempotent).
   *
   * This step isn't an optional nicety tacked on at the end: a new backend version may carry a
   * new table structure, and D1 table creation only happens through this endpoint. Without it,
   * the Worker code would be new while the database stayed old, cron would silently fail every
   * minute, and proactive messages would grind to a complete halt — while everything on screen
   * looked totally normal and the user had no way to tell (this exact pitfall has actually
   * happened). Having "update" carry this along on its own means we don't have to count on
   * everyone remembering to tap something else manually afterward.
   *
   * A failure here doesn't retroactively count as an update failure: the code really has been
   * swapped in, it's just that the database didn't keep up. Reporting them separately lets the
   * user know which one they actually need to act on.
   */
  const handleSelfUpdateWorker = async () => {
    setLoading(true);
    try {
      const result = await ActiveMsgClient.selfUpdateWorker();
      if (result.ok) {
        setSelfUpdateHash(result.bundleHash || '');
        setAttachOpen(false);
        addToast(result.message, 'success');
        try {
          await ActiveMsgClient.connect();
          await refresh();
        } catch (error: any) {
          addToast(
            `Backend updated, but the follow-up verification failed: ${error?.message || 'unknown reason'}. Tap "Reconnect & Verify" manually.`,
            'error',
          );
        }
      } else {
        addToast(result.message, result.supported ? 'error' : 'info');
        // "Missing CF_API_TOKEN" is the only case that can be resolved right here in place:
        // reveal the attach-key section so the user can just paste in a token, without having to go add a variable in the Cloudflare dashboard.
        if (result.code === 'CF_TOKEN_MISSING') setAttachOpen(true);
      }
      trackEvent('Update Backend Worker', {
        result: result.ok ? 'ok' : result.supported ? 'failed' : 'unsupported',
      });
    } catch (error: any) {
      addToast(error?.message || 'Update failed.', 'error');
      trackEvent('Update Backend Worker', { result: 'failed' });
    } finally {
      setLoading(false);
    }
  };

  /**
   * Attaches the "self-update" key to a backend that's already installed.
   *
   * Only writes the two secrets CF_API_TOKEN / CF_SCRIPT_NAME — doesn't touch the script or any
   * other bindings, since for a manually deployed backend the frontend never has the user's
   * Master Key in the first place, and going through the re-upload path would wipe out the secrets.
   */
  const handleAttachUpdateKey = async (accountId?: string) => {
    const token = attachToken.trim();
    if (!token) {
      addToast('Enter your Cloudflare API Token first.', 'error');
      return;
    }
    if (!config?.workerUrl.trim()) {
      addToast('Fill in the Worker address first.', 'error');
      return;
    }

    setAttaching(true);
    setAttachError('');
    try {
      const result = await attachUpdateCapability({
        token,
        workerUrl: config.workerUrl,
        scriptName: attachScriptName.trim() || undefined,
        accountId,
      });

      if (!result.ok) {
        if (result.code === 'SCRIPT_NAME_UNKNOWN') {
          setAttachNeedsScriptName(true);
          setAttachError(result.message);
          trackEvent('Attach Backend Update Capability', { result: 'Needs Worker name' });
          return;
        }
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setAttachAccounts(result.accounts || []);
          trackEvent('Attach Backend Update Capability', { result: 'Needs account selection' });
          return;
        }
        setAttachError(result.message);
        trackEvent('Attach Backend Update Capability', { result: 'Failed' });
        return;
      }

      setAttachToken('');
      setAttachAccounts(null);
      setAttachNeedsScriptName(false);
      addToast('Key attached. You can now tap "Update Worker" above.', 'success');
      trackEvent('Attach Backend Update Capability', { result: 'Success' });
    } catch (error: any) {
      setAttachError(error?.message || 'Something went wrong while attaching the key.');
      trackEvent('Attach Backend Update Capability', { result: 'Failed' });
    } finally {
      setAttaching(false);
    }
  };

  // For manual-paste deployment. The main flow is fork sullyos-workers + connect Git on CF; this
  // is the fallback for people without a GitHub account, so it's tucked away in a collapsed
  // section of the panel.
  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker code copied. Paste it over the existing code in Edit code on the CF dashboard.', 'success');
      trackEvent('Copy 2.0 Worker Code', { result: 'ok' });
    } catch (error: any) {
      addToast(`Copy failed (${error?.message || error}). You can also get it from worker/amsg/worker.bundle.js in the repo.`, 'error');
      // The Clipboard API throws outright on non-HTTPS / some WebViews — this event measures the size of that group.
      trackEvent('Copy 2.0 Worker Code', { result: 'failed' });
    }
  };

  // The facade script for when workers.dev is unreachable from mainland China. Different from
  // the bundle above: this one isn't packaged, it's published as-is, and the user has to edit
  // the UPSTREAM line by following the comment inside it — so that comment has to stay in the source.
  const handleCopyDenoProxy = async () => {
    try {
      await ActiveMsgClient.copyDenoProxyToClipboard();
      addToast('Proxy code copied. After pasting it into a Deno Playground, remember to edit the UPSTREAM line.', 'success');
      trackEvent('Copy 2.0 Deno Proxy Code', { result: 'ok' });
    } catch (error: any) {
      addToast(`Copy failed (${error?.message || error}). You can also get it from worker/amsg/deno-proxy.ts in the repo.`, 'error');
      trackEvent('Copy 2.0 Deno Proxy Code', { result: 'failed' });
    }
  };

  /**
   * Whether copying a secret includes a `VARIABLE_NAME=` prefix depends on whether the Worker
   * address has been filled in: empty = the backend isn't installed yet, and the user needs to
   * go create a new variable in Cloudflare's Variables and secrets, so giving them the whole line
   * is most convenient (pasting a whole line in automatically splits into the name and value
   * columns, no need to type the name by hand); filled in = the backend is already installed and
   * this is a return visit to change the value of one item, with the cursor sitting right in the
   * value column, so pasting the whole line in would write the variable name into the value too.
   */
  const copyWholeEnvLine = !config?.workerUrl?.trim();

  /**
   * Hands a freshly generated secret to the user: stores it in state for display + tries to copy
   * it to the clipboard. The input field is password-type and hides its content, so the value
   * has to be shown separately when it's generated — otherwise "put this same value into the
   * Worker's environment variables" would be impossible to do. When the clipboard isn't
   * available the user copies it by hand from what's shown below, so the displayed copy has to
   * match the copied one exactly.
   */
  const revealAndCopy = async (value: string, reveal: (v: string) => void, envName: string) => {
    const text = copyWholeEnvLine ? `${envName}=${value}` : value;
    reveal(text);
    try {
      await navigator.clipboard.writeText(text);
      addToast(
        copyWholeEnvLine
          ? `Copied the whole ${envName} line — paste it into the Worker's Variables and the name and value will fill in automatically.`
          : `Copied the value of ${envName} (without the variable name) — paste it directly into the value field on Cloudflare.`,
        'success',
      );
    } catch {
      addToast(copyWholeEnvLine ? 'Generated. Copy the whole line manually from below.' : 'Generated. Copy it manually from below.', 'info');
    }
  };

  const handleGenerateMasterKey = () => {
    // Only report "which one was generated." The secret itself only exists in state for the
    // duration of this panel being open — it's never persisted client-side, let alone sent to analytics.
    trackEvent('Generate 2.0 Worker Key', { which: 'master_key' });
    return revealAndCopy(ActiveMsgClient.generateMasterKey(), setGeneratedMasterKey, 'AMSG_MASTER_KEY');
  };

  const handleWipeCloudData = async () => {
    if (!confirm(
      "Clear cloud data? These items belonging to you in the Worker's D1 database will all be deleted:\n\n"
      + '· Scheduled proactive message tasks (including ones the character scheduled itself)\n'
      + '· Synced character context and tool credentials\n'
      + '· Registered API credentials\n'
      + '· Push subscription registration\n\n'
      + 'Tasks will need to be rescheduled after deletion. Character context will sync back automatically on your next chat, '
      + 'API credentials will re-register the next time a task is scheduled or a message is sent, '
      + 'and tool credentials and the push subscription will be re-registered right away.'
    )) return;
    setLoading(true);
    try {
      const result = await wipeAmsgCloudData(realtimeConfig, {
        pushRegistered: Boolean(pushStatus?.hasSubscription),
      });

      // Spell out every spot that didn't clear cleanly, item by item: this button is mostly
      // tapped when "the cloud data has already gone wrong," and a vague "partial failure" would
      // leave the user with no idea what to do next.
      const problems: string[] = [];
      if (!result.tasks.listed) {
        problems.push("Couldn't read the task list (this happens if AMSG_MASTER_KEY was changed and old tasks can no longer be decrypted) — these tasks will fail when they come due, and the Worker will auto-clean them after 7 days");
      } else if (result.tasks.failed > 0) {
        problems.push(`${result.tasks.failed} task(s) failed to cancel — consider handling them one by one in the character's Proactive Message panel`);
      }
      if (result.stateDeleted === null) {
        problems.push("Couldn't delete character context");
      } else if (!result.toolConfigRestored) {
        problems.push('Failed to re-upload tool credentials — please save your configuration again in "Real-time Perception," otherwise scheduled AI tasks will keep failing');
      }
      if (result.llmCredentialsDeleted === null) {
        // An old Worker doesn't have this table at all, and this line holds true either way: it
        // genuinely wasn't cleared, but the next scheduling run falls back to the old
        // "credentials frozen into the task" approach anyway, so there's nothing left over to worry about.
        problems.push("Couldn't delete registered API credentials (if the Worker version is older, this table doesn't exist anyway)");
      }
      if (result.push === 'failed') {
        problems.push('Failed to clean up the push subscription — consider resubscribing in the push section above');
      }

      if (problems.length > 0) {
        addToast(`Cloud data wasn't fully cleared: ${problems.join('; ')}.`, 'error');
      } else {
        const done = [
          `${result.tasks.total} task(s)`,
          `${result.stateDeleted} state entr${result.stateDeleted === 1 ? 'y' : 'ies'}`,
          `${result.llmCredentialsDeleted} API credential row(s)`,
        ];
        if (result.push === 'reregistered') done.push('push subscription re-registered');
        addToast(`Cloud data cleared (${done.join(', ')}).`, 'success');
      }
    } catch (error: any) {
      addToast(error?.message || 'Failed to clear cloud data.', 'error');
    } finally {
      setLoading(false);
      void refresh();
    }
  };

  /**
   * Toggles Instant Chat. Persists directly rather than going through the 1-second debounced
   * autosave: the toggle is a single deliberate action, and it should take effect the instant
   * it's tapped (the very next message follows the new path) rather than "tap it and then still
   * have to wait a bit."
   */
  const handleToggleInstantChat = async () => {
    const next = !config?.instantChatEnabled;
    // Turning it on and then off again is the single most valuable signal on this path: being
    // able to enable it, having enabled it, and then giving up on it is not the same thing as "never enabled it at all."
    trackEvent('Toggle Instant Chat', { action: next ? 'on' : 'off' });
    patchConfig({ instantChatEnabled: next });
    await ActiveMsgStore.saveGlobalConfig({ instantChatEnabled: next });
    addToast(next ? 'Instant Chat is on. Future chats will be generated on your Worker.' : 'Instant Chat is off. Chat is back to local generation.', 'success');
  };

  const handleGenerateServerToken = () => {
    const token = generateClientToken();
    patchConfig({ serverToken: token });
    trackEvent('Generate 2.0 Worker Key', { which: 'server_token' });
    return revealAndCopy(token, setGeneratedServerToken, 'AMSG_SERVER_TOKEN');
  };

  if (!config) return null;

  const isConnected = Boolean(config.initializedAt);

  // Health check: the probe result + "whether this device is subscribed," a fact only the
  // frontend knows — the traffic-light determination lives entirely in the amsgDiagnostics pure
  // function (pinned down by regression tests over there).
  const diagnosticRows = diagnosticsProbe
    ? buildAmsgDiagnosticRows({
      probe: diagnosticsProbe,
      localPushSubscribed: Boolean(pushStatus?.hasSubscription),
    })
    : [];
  const diagnosticLevel = diagnosticRows.length ? summarizeAmsgDiagnostics(diagnosticRows) : 'unknown';

  const instantChatBlocker = resolveInstantChatBlocker({
    connected: isConnected,
    pushSubscribed: Boolean(pushStatus?.hasSubscription),
    workerSupportsInstantChat: instantChatSupported,
    instantPushOn: instantOn,
  });
  const instantChatBlockedReason = instantChatBlocker ? INSTANT_CHAT_BLOCKER_HINTS[instantChatBlocker] : '';

  return (
    <Modal
      isOpen={isOpen}
      title="Proactive Message 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          Close
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        {/* Health check. Every way proactive messages can break is invisible on screen: D1 not
            bound, table structure out of date, VAPID not configured, no receiving device
            registered in the cloud — tasks still get created, the panel still looks normal, and
            simply nothing ever gets sent. The Worker's /debug has always been able to compute
            all of this; this section just puts it somewhere visible. */}
        {config.workerUrl?.trim() ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
            {/* While collapsed, "all good / there's an issue" is the entire conclusion — expand for the item-by-item detail. */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setDiagnosticsOpen((prev) => !prev)}
                className="flex-1 flex items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="font-bold text-slate-700">Health Check</span>
                  {diagnosticRows.length ? (
                    <span className={`text-xs font-bold ${DIAGNOSTIC_STYLES[diagnosticLevel].text}`}>
                      {diagnosticLevel === 'ok' ? 'All good' : diagnosticLevel === 'bad' ? 'Issue found' : diagnosticLevel === 'warn' ? 'Note' : 'Incomplete'}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs font-bold text-slate-400">{diagnosticsOpen ? 'Collapse' : 'Expand'}</span>
              </button>
              {diagnosticsOpen ? (
                <button
                  type="button"
                  onClick={() => void runDiagnostics()}
                  disabled={diagnosing}
                  className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform disabled:opacity-50"
                >
                  {diagnosing ? 'Checking…' : 'Recheck'}
                </button>
              ) : null}
            </div>

            {!diagnosticsOpen ? null : diagnosticRows.length ? (
              <div className="space-y-2">
                {diagnosticRows.map((row) => {
                  const style = DIAGNOSTIC_STYLES[row.level];
                  return (
                    <div key={row.key}>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        <span className="flex-1 text-xs font-bold text-slate-600">{row.label}</span>
                        <span className={`shrink-0 text-[11px] font-bold ${style.text}`}>{style.word}</span>
                      </div>
                      {/* A normal row doesn't expand its explanation: when everything's green, this column needs to stay short enough to scan at a glance. */}
                      {row.level === 'ok' ? null : (
                        <p className="mt-1 pl-3.5 text-[11px] leading-relaxed text-slate-500 whitespace-pre-line">
                          {row.detail}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-400">
                {diagnosing ? 'Asking the Worker…' : 'No results yet — tap the check button in the top-right.'}
              </p>
            )}
          </div>
        ) : null}

        {/* Under normal circumstances, the two mutual-exclusion gates block "both enabled at
            once" — anyone who ends up here is entirely leftover dirty config. Dirty config
            still quietly routes chat through Instant, and everything 2.0 hangs on the local path
            silently stops working — no error, no warning, it just shows up as "why isn't this
            feature responding." This card is the entry point for cleaning that up. */}
        {instantOn ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="font-bold text-amber-900 text-sm">Instant Push is also on</div>
            <p className="text-xs leading-relaxed text-amber-800">
              Instant Push is detected as still on. Instant Chat already covers its capabilities (free once sent, tools run in the cloud, catch-up delivery when offline) — only one path can stay. Tap below to turn off Instant Push and hand chat over to 2.0.
            </p>
            <button
              type="button"
              onClick={disableInstantPush}
              className="w-full py-2.5 bg-amber-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform"
            >
              Turn off Instant Push (keep its configuration)
            </button>
          </div>
        ) : null}

        {/* A Worker address already being filled in means the backend is installed, so this card is collapsed; reinstalling goes through the "clear the address and come back" path. */}
        {config.workerUrl?.trim() ? null : (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-slate-700">One-Click Deploy (recommended)</span>
            <span className="shrink-0 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              Just one Token
            </span>
          </div>

          <p className="text-xs leading-relaxed text-slate-500">
            Create an API Token on Cloudflare and paste it in — creating the database, uploading the
            backend code, writing secrets, and adding the scheduled trigger all happen automatically.
            No GitHub account needed, and it works on mobile too.
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-1.5">
            <p className="text-[11px] font-bold text-slate-600">Check all three permissions when creating the Token</p>
            <ul className="text-[11px] leading-relaxed text-slate-500 space-y-0.5 list-disc list-outside pl-4">
              <li>Account → <code className="font-mono">Workers Scripts</code> : Edit</li>
              <li>Account → <code className="font-mono">D1</code> : Edit</li>
              <li>Account → <code className="font-mono">Account Settings</code> : Read</li>
            </ul>
            <a
              href={CF_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent('Open 2.0 Deploy Link', { target: 'CF Dashboard' })}
              className="inline-block mt-1 text-[11px] font-bold text-violet-600"
            >
              ↗ Go create a Token on Cloudflare
            </a>
          </div>

          <input
            type="password"
            value={cfToken}
            onChange={(e) => setCfToken(e.target.value)}
            placeholder="Paste Cloudflare API Token"
            autoComplete="off"
            className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
          />

          {provisionAccounts?.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">This Token can be used on multiple accounts — which one should it deploy to?</p>
              {provisionAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={provisioning}
                  onClick={() => void handleOneClickDeploy(account.id)}
                  className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                >
                  {account.name}
                </button>
              ))}
            </div>
          ) : null}

          {needsSubdomain ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">Give this account a workers.dev subdomain</p>
              <input
                type="text"
                value={desiredSubdomain}
                onChange={(e) => setDesiredSubdomain(e.target.value)}
                placeholder="e.g. my-name (unique across all of Cloudflare)"
                autoComplete="off"
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
              />
              <p className="text-[11px] leading-relaxed text-slate-400">
                The backend address will look like: <code className="font-mono">sullyos-amsg.your-name.workers.dev</code>.
                Once set, this name is shared by every Worker on this account and is hard to change later.
              </p>
            </div>
          ) : null}

          <button
            type="button"
            disabled={provisioning || !cfToken.trim()}
            onClick={() => void handleOneClickDeploy()}
            className="w-full py-3 rounded-xl text-sm font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning ? provisionStep || 'Deploying…' : 'Start deployment'}
          </button>

          {provisionError ? (
            <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{provisionError}</p>
          ) : null}

          <p className="text-[10px] leading-relaxed text-slate-400">
            The browser can't call Cloudflare's API directly (no cross-origin access), so this Token is
            relayed once through this site's network proxy Worker. After deployment it's stored as a
            secret in <strong>your own</strong> Worker and used later for "update backend"; this page
            doesn't save it. If that's a concern, you can deploy manually using the steps below instead.
          </p>
        </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setDeployOpen((prev) => {
              // Only record when expanding: recording on collapse too would count the same person twice, inflating the first stage of the funnel by double.
              if (!prev) trackEvent('Expand 2.0 Deploy Guide', { mode: 'main flow' });
              return !prev;
            })}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">Deploy the Worker manually (step by step)</span>
            <span className="text-xs font-bold text-slate-400">{deployOpen ? 'Collapse' : 'Expand'}</span>
          </button>

          {deployOpen ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-slate-500">
                All done by clicking through web pages, no installs or commands needed, about 15
                minutes. First time doing this, we recommend following the <strong>illustrated walkthrough</strong>;
                below is the short version.
              </p>

              <ol className="text-xs leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                <li>
                  Fork the backend repo <code className="font-mono">sullyos-workers</code>
                  {' '}(Fork → Create fork in the top-right of the page).
                </li>
                <li>
                  In the CF dashboard, Storage &amp; databases → <strong>D1 SQLite Database</strong>, create a
                  database and copy its <strong>Database ID</strong>. No need to create tables — they're
                  built automatically when you click "Connect" below.
                </li>
                <li>
                  In the CF dashboard, Workers &amp; Pages → <strong>Create application</strong> →
                  <strong> Continue with GitHub</strong>, select your forked repo, then fill in:
                  <ul className="mt-1 space-y-0.5 list-disc list-outside pl-4">
                    <li>Build command: <code className="font-mono">sh ./deploy-prepare.sh</code></li>
                    <li>Advanced settings → Path: <code className="font-mono">/amsg</code></li>
                    <li>
                      In Advanced settings, add a build variable
                      <code className="font-mono"> D1_DATABASE_ID </code>
                      = the Database ID from the previous step (<strong>don't click Encrypt</strong> — the build needs to read it)
                    </li>
                  </ul>
                </li>
                <li>After deploying, fill in the secrets in Settings → Variables and secrets per the checklist below, then Deploy again.</li>
              </ol>

              <p className="text-[11px] leading-relaxed text-slate-400">
                The D1 binding and the "check every minute" cron trigger are both defined in the repo and
                come along automatically — no need to add them by hand. To update later, just go to your
                forked repo and click <strong>Sync fork</strong>; CF will redeploy automatically.
              </p>

              <div className="grid grid-cols-3 gap-2">
                {/* All three exits are combined into one event with a target enum: they're three
                    branches of the same deployment step, and splitting them into three separate
                    event names would just clutter the event list while requiring them to be
                    manually recombined when looking at the funnel. */}
                <a
                  href={WORKERS_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('Open 2.0 Deploy Link', { target: 'fork repo' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white text-center active:scale-95 transition-transform"
                >
                  ↗ Fork repo
                </a>
                <a
                  href={SETUP_WALKTHROUGH_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('Open 2.0 Deploy Link', { target: 'walkthrough' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ Walkthrough
                </a>
                <a
                  href={buildCloudflareDashboardUrl(config.workerUrl.trim() || undefined)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('Open 2.0 Deploy Link', { target: 'CF Dashboard' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ CF Dashboard
                </a>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5 text-xs">
                <p className="font-bold text-slate-700">Environment variable checklist</p>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">AMSG_MASTER_KEY</code>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMasterKey()}
                      className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      Generate & copy
                    </button>
                  </div>
                  {generatedMasterKey ? (
                    <SecretReveal value={generatedMasterKey} />
                  ) : (
                    <p className="text-[11px] text-slate-400">
                      The key used to encrypt task content — it only exists on the Worker side. This page doesn't save it.
                      {copyWholeEnvLine
                        ? <>Copying gives you the whole <code className="font-mono">variable name=value</code> line — paste it into CF's Variables and it splits into two columns automatically.</>
                        : <>Copying gives you just the value — paste it directly into the value field on CF.</>}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">VAPID_EMAIL / PUBLIC_KEY / PRIVATE_KEY</code>
                    {onOpenVapid ? (
                      <button
                        type="button"
                        onClick={onOpenVapid}
                        className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                      >
                        Go to push credentials panel
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Must be <strong>the exact same pair</strong> as in the "Push Credentials (VAPID)" panel (shared with Instant Push) —
                    the whole site has only one browser push subscription, and signing pushes with a different key pair from the Worker will 403.
                  </p>
                </div>

                <div className="space-y-1">
                  <code className="font-mono text-[11px] text-slate-600">AMSG_SERVER_TOKEN (optional)</code>
                  <p className="text-[11px] text-slate-400">
                    Prevents others from abusing your Worker. Value = the string filled in below under "Shared Secret" — just keep both sides matching; leaving it unset opens all endpoints.
                  </p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-2.5">
                <button
                  type="button"
                  onClick={() => setPasteFallbackOpen((prev) => {
                    if (!prev) trackEvent('Expand 2.0 Deploy Guide', { mode: 'manual paste' });
                    return !prev;
                  })}
                  className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
                >
                  <span>No GitHub account? Deploy by manual paste</span>
                  <span>{pasteFallbackOpen ? 'Collapse' : 'Expand'}</span>
                </button>

                {pasteFallbackOpen ? (
                  <div className="mt-2 space-y-2">
                    <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                      <li>
                        Tap "Copy Worker Code" below, create an empty Worker via Create → Worker in the CF
                        dashboard, go into <strong>Edit code</strong>, select all and paste over it, then Deploy.
                      </li>
                      <li>
                        In Settings → Bindings, add a <strong>D1 database</strong>; the variable name
                        must be <code className="font-mono">DB</code>.
                      </li>
                      <li>
                        In Settings → Trigger Events, add a <strong>Cron Trigger</strong>:
                        <code className="font-mono"> * * * * * </code> (checks for due tasks every minute).
                      </li>
                      <li>In Settings → Variables and secrets, fill in the secrets per the checklist above, then Deploy again.</li>
                    </ol>

                    <button
                      type="button"
                      onClick={() => void handleCopyWorkerBundle()}
                      className="w-full py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      Copy Worker Code
                    </button>

                    <p className="text-[11px] leading-relaxed text-slate-400">
                      With this path, you'll need to re-paste every time the Worker updates, and you'll
                      have to add the D1 binding and cron trigger yourself — easy to miss a step. If you
                      can use GitHub, the fork flow above is preferred.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">Current Status</span>
            <span className={`text-xs font-bold ${isConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>

          {workerOutdated ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
              The Worker is still running old code and is missing new features (large-context cloud
              storage, server-side tool loop, etc.). Go to your forked <code className="font-mono">sullyos-workers</code> repo
              and click <strong>Sync fork</strong> — CF will redeploy automatically (if you deployed by
              manual paste originally, go re-copy the code and paste it over in "Deploy Worker" below).
              Existing data and tasks are not affected.
            </div>
          ) : null}

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Worker Address
            </label>
            <input
              type="text"
              value={config.workerUrl}
              onChange={(event) => patchConfig({ workerUrl: event.target.value })}
              placeholder="https://amsg.your-account.workers.dev"
              className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono"
            />

            <div className="mt-2">
              <button
                type="button"
                onClick={() => setDenoProxyOpen((prev) => {
                  if (!prev) trackEvent('Expand 2.0 Deploy Guide', { mode: 'Deno proxy' });
                  return !prev;
                })}
                className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
              >
                <span>Can't reach this address? Put a Deno layer in front of it</span>
                <span>{denoProxyOpen ? 'Collapse' : 'Expand'}</span>
              </button>

              {denoProxyOpen ? (
                <div className="mt-2 space-y-2">
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    The domain <code className="font-mono">workers.dev</code> is unreachable from within
                    mainland China. The fix is to put a facade in front of it: the Worker and its data
                    stay on Cloudflare untouched, you add a pure-forwarding Deno layer in front, and then
                    switch the address to the Deno one.
                  </p>

                  <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                    <li>
                      Go to the Deno console and click <strong>New Playground</strong> in the top-right.
                    </li>
                    <li>
                      Tap "Copy Deno Proxy Code" below, select all and paste it over the code in the
                      Playground, change the <code className="font-mono">UPSTREAM</code> line at the top
                      to the Cloudflare address you filled in above, then Deploy.
                    </li>
                    <li>
                      Take the <code className="font-mono">https://xxx.deno.net</code> address you get
                      after deploying and fill it into the input box above, replacing the original one.
                    </li>
                  </ol>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyDenoProxy()}
                      className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      Copy Deno Proxy Code
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        trackEvent('Open Deno Console');
                        window.open('https://console.deno.com', '_blank');
                      }}
                      className="shrink-0 px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      Go to Deno
                    </button>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-400">
                    Receiving messages doesn't go through this layer — push is sent directly from
                    Cloudflare to your phone, so even if this layer goes down it only affects opening this
                    panel to change settings. Once deployed, open <code className="font-mono">/__proxy-health</code> to check whether it's alive.
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Shared Secret (optional)
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={config.serverToken || ''}
                onChange={(event) => patchConfig({ serverToken: event.target.value })}
                placeholder="Only needed if the Worker has AMSG_SERVER_TOKEN configured"
                className="flex-1 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleGenerateServerToken()}
                className="shrink-0 px-3 py-3 text-xs rounded-2xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
              >
                Random
              </button>
            </div>
            {generatedServerToken ? (
              <SecretReveal value={generatedServerToken} className="mt-1.5" />
            ) : null}
          </div>

          {/*
            This button must stay untappable while deployment hasn't wrapped up yet: a freshly
            created workers.dev address takes several dozen seconds to resolve across every edge
            node, and tapping connect during that window is guaranteed to report "can't reach the
            Worker." The one-click deploy path already waits for this on its own
            (waitForWorkerReady), and creates the tables as soon as it's ready too — a user
            jumping the gun and tapping first only gets a baffling failure for their trouble.
          */}
          <button
            onClick={handleConnect}
            disabled={loading || provisioning}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning
              ? provisionStep || 'Deploying…'
              : loading ? 'Processing...' : isConnected ? 'Reconnect & Verify' : 'Connect & Enable'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            "Connect" automatically creates the tables in your D1 database (idempotent — clicking it again is fine), no need to run SQL by hand.
          </p>

          {isConnected ? (
            <div className="pt-1 space-y-2 border-t border-slate-200">
              {/*
                The button is always present, but only stands out when there's an update: when a
                new version exists it's a solid highlight spelling out which version it updates
                to; when there isn't one it fades into a light-colored "Recheck & Update" line —
                someone who wants to manually rerun the check can still tap it just fine, without
                needing to hunt for a separate entry point elsewhere for that.
              */}
              <button
                onClick={handleSelfUpdateWorker}
                disabled={loading}
                className={`w-full py-2.5 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 ${
                  workerVersion?.state === 'outdated'
                    ? 'bg-emerald-600 text-white border border-emerald-600'
                    : 'bg-white border border-slate-300 text-slate-700'
                }`}
              >
                {loading
                  ? 'Processing...'
                  : workerVersion?.state === 'outdated'
                    ? `Update Worker to ${workerVersion.expected}`
                    : 'Recheck & Update Worker'}
              </button>
              {workerVersion?.state === 'outdated' ? (
                <p className="text-xs leading-relaxed text-emerald-700">
                  Your Worker is currently running
                  {workerVersion.deployed ? <code className="font-mono"> {workerVersion.deployed} </code> : ' an earlier version'}
                  {' '}— update it so Instant Chat can use the new generation channel.
                </p>
              ) : workerVersion?.state === 'current' ? (
                <p className="text-xs leading-relaxed text-slate-500">
                  The backend is already up to date (<code className="font-mono">{workerVersion.expected}</code>).
                </p>
              ) : null}
              <p className="text-xs leading-relaxed text-slate-500">
                The backend fetches and overwrites itself with the latest code — your scheduled tasks and
                saved secrets are untouched, and it auto-verifies once the update is done. If you deployed
                via One-Click Deploy you can tap it directly; if you deployed the old way, the first tap
                will prompt you to attach a key — do that below.
              </p>
              {selfUpdateHash ? (
                <p className="text-xs leading-relaxed text-emerald-600">
                  Current backend code fingerprint: <code className="font-mono">{selfUpdateHash}</code>
                </p>
              ) : null}

              {attachOpen ? (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5">
                  <p className="text-[11px] font-bold text-slate-600">Attach an update key to this backend</p>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Create a Cloudflare API Token with only <strong>Account → Workers Scripts : Edit</strong> checked
                    and paste it in (<strong>leave Start Date empty</strong>); SullyOS will write it into your
                    Worker. Once done, future updates are just a tap of the button above.
                  </p>
                  <a
                    href={CF_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => trackEvent('Open 2.0 Deploy Link', { target: 'CF Dashboard' })}
                    className="inline-block text-[11px] font-bold text-violet-600"
                  >
                    ↗ Go create a Token on Cloudflare
                  </a>
                  <input
                    type="password"
                    value={attachToken}
                    onChange={(e) => setAttachToken(e.target.value)}
                    placeholder="Paste Cloudflare API Token"
                    autoComplete="off"
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                  />

                  {attachNeedsScriptName ? (
                    <input
                      type="text"
                      value={attachScriptName}
                      onChange={(e) => setAttachScriptName(e.target.value)}
                      placeholder="This Worker's name on Cloudflare"
                      autoComplete="off"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                    />
                  ) : null}

                  {attachAccounts?.length ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold text-slate-600">Multiple accounts have a Worker with this name — pick one:</p>
                      {attachAccounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          disabled={attaching}
                          onClick={() => void handleAttachUpdateKey(account.id)}
                          className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                        >
                          {account.name}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    disabled={attaching || !attachToken.trim()}
                    onClick={() => void handleAttachUpdateKey()}
                    className="w-full py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {attaching ? 'Attaching key…' : 'Attach key'}
                  </button>

                  {attachError ? (
                    <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{attachError}</p>
                  ) : null}

                  <p className="text-[10px] leading-relaxed text-slate-400">
                    This step only adds this one secret to your Worker — it doesn't touch the code, the
                    database, or any existing secrets. Once the Token is written in, it stays in your own
                    Worker; this page doesn't save it.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">
              {pushStatus?.transport === 'unified-push' ? 'UnifiedPush Notifications' : 'Notification Permission'}
            </span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? 'Enabled' : 'Not enabled'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            This is step two. Only needed if you actually want the character to proactively push messages in the background.
          </p>
          {pushStatus?.transport === 'unified-push' ? (
            <p className="text-xs leading-relaxed text-slate-500">
              The Android App receives messages via the open UnifiedPush standard, without depending on
              Firebase or Google services. ntfy is only responsible for waking this App in the background —
              the AMSG Worker is still the one you deployed yourself.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-slate-500">
              Push follows "whichever device the task was scheduled on": when each task comes due, it's
              pushed to the device that was used to save that schedule. After switching devices (or
              browsers), save the schedule again on the new device and future pushes will go there.
            </p>
          )}
          {pushStatus?.needsDistributor ? (
            <a
              href="https://docs.ntfy.sh/subscribe/phone/"
              target="_blank"
              rel="noreferrer"
              className="block text-xs font-bold text-violet-600 underline"
            >
              Install and open ntfy (choose the version without Firebase)
            </a>
          ) : null}
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? 'Processing...' : pushStatus?.transport === 'unified-push' ? 'Connect ntfy & Enable Notifications' : 'Enable Notifications & Push'}
          </button>
        </div>

        {/* Instant Chat: chat generation itself is also handed off to the cloud. All four gates
            are required, and whichever one is missing gets spelled out — graying it out without
            saying why would just make the user tap it over and over. */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">Instant Chat</span>
            {/* Can't just say "Enabled" when it's on but a gate hasn't been passed — those gates
                really do mean this round falls back to local generation, and labeling it a green
                "Enabled" would be lying: the user thinks chat is running in the cloud, when it's
                actually been running locally the whole time. */}
            <span className={`text-xs font-bold ${
              !config.instantChatEnabled ? 'text-slate-400'
                : instantChatBlockedReason ? 'text-amber-600' : 'text-emerald-600'
            }`}>
              {!config.instantChatEnabled ? 'Not enabled'
                : instantChatBlockedReason ? 'Enabled · Not active yet' : 'Enabled'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Once enabled, every message you send is generated into a reply by this Worker, and the reply
            comes back via push. Once sent, you can background the app or close it entirely — the message
            will already be there when you come back. Turning it off returns to local direct generation.
          </p>
          {instantChatBlockedReason ? (
            <p className="text-xs leading-relaxed text-amber-600">{instantChatBlockedReason}</p>
          ) : (
            <p className="text-[11px] leading-relaxed text-slate-400">
              No character-by-character streaming — "Typing…" is shown while generating; a resend prompt
              only appears on an explicit error from the cloud, and it just keeps waiting as long as
              generation or a retry is still in progress (a slow LLM doesn't count as a failure).
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleToggleInstantChat()}
            disabled={loading || (!config.instantChatEnabled && !!instantChatBlockedReason)}
            className={`w-full py-3 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40 ${
              config.instantChatEnabled ? 'bg-slate-200 text-slate-600' : 'bg-slate-900 text-white'
            }`}
          >
            {config.instantChatEnabled ? 'Turn off Instant Chat' : 'Turn on Instant Chat'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">Risk Disclosure</div>
          <p>Once 2.0 is enabled, proactive message content, prompts, and related configuration will all flow into the Worker and D1 database you deployed yourself.</p>
          <p>This is your own Worker and your own database — the project does not connect to any additional central server. But once the data is in the database, anyone who can reach that Worker / database (which is to say, you yourself) can see this content.</p>
          <p>If you're not comfortable putting private prompts or API keys into a service you self-host, don't enable 2.0.</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">Advanced Info</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? 'Collapse' : 'Expand'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                See the "Deploy the Worker manually" section above for the Worker-side environment
                variable checklist. The published Worker code has CORS wide open by default
                (<code className="font-mono">origin: '*'</code>) — to lock it down, change it to your own
                site's domain and redeploy.
              </p>
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-3 space-y-2">
                <div className="font-semibold text-rose-700">Clear Cloud Data</div>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  Deletes all of your data on the Worker's D1: scheduled proactive message tasks
                  (including ones the character scheduled itself), synced character context (character
                  card, recent chat window, etc.) and tool credentials, and the push subscription registration.
                </p>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  After clearing, character context will sync back automatically on your next chat, tool
                  credentials and the push subscription re-register right away, and tasks need to be
                  rescheduled yourself. Also use this if you changed <code className="font-mono">AMSG_MASTER_KEY</code> and old data can no longer be decrypted.
                </p>
                <button
                  onClick={() => void handleWipeCloudData()}
                  disabled={loading}
                  className="w-full py-2.5 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                >
                  {loading ? 'Processing...' : 'Clear Cloud Data'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);
