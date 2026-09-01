import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateClientToken } from '../../utils/vapidGen';
import {
  loadInstantConfig,
  saveInstantConfig,
  getOrCreateInstantSubscription,
  sendTestInstantPush,
  probeInstantWorkerCapabilities,
  probeInstantWorkerVersion,
  copyInstantWorkerBundleToClipboard,
  copyDenoLoaderToClipboard,
  buildCloudflareDashboardUrl,
  normalizeWorkerUrl,
} from '../../utils/instantPushClient';
import { isPushVapidReady } from '../../utils/pushVapid';
import { isInstantChatReady } from '../../utils/amsgInstantChat';
import {
  markWorkerBuildSeen,
} from '../WorkerUpdateReminderEvent';
import {
  INSTANT_PUSH_SUNSET_DATE,
  INSTANT_PUSH_MIGRATION_GUIDE_URL,
} from '../InstantPushSunsetEvent';
import { INSTANT_WORKER_VERSION } from '../../utils/instantWorkerVersion';
import { trackEvent } from '../../utils/analytics';
import { FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_05_27 } from '../UpdateNotificationEvent';
import { InstantPushConfig, AppID } from '../../types';

interface InstantPushSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** 由 Settings 注入: 点"去配置 VAPID"时打开顶层 PushVapidSettingsModal */
  onOpenVapid?: () => void;
}

export const InstantPushSettingsModal: React.FC<InstantPushSettingsModalProps> = ({
  open,
  onClose,
  onOpenVapid,
}) => {
  const { apiConfig, addToast, openApp } = useOS();

  const [workerUrl, setWorkerUrl] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [autoTriggerOnSend, setAutoTriggerOnSend] = useState(false);
  const [useD1BlobStore, setUseD1BlobStore] = useState(false);
  const [d1Available, setD1Available] = useState(false);
  const [d1CheckedAt, setD1CheckedAt] = useState<number | undefined>(undefined);
  const [d1CheckedWorkerUrl, setD1CheckedWorkerUrl] = useState('');

  const [vapidReady, setVapidReady] = useState(false);
  // 即时对话（主动消息 2.0）已取代 Instant Push，两条发送路互斥。对面（amsg2 面板）
  // 有一道同款的门，这里是反方向那一半：少了它，用户可以先开即时对话、再回这里把
  // IP 勾回来，聊天就会静默走 IP、即时对话开关亮着却不生效。
  const [instantChatOn, setInstantChatOn] = useState(false);
  // Instant Push 停止接入：打开面板时存档里没开着的人，一律不允许再勾上。
  // 依据必须是**存档里的状态**而不是界面上的实时勾选 —— 拿实时值的话，已经开着的人
  // 手滑取消一下，勾选框立刻锁死、再也勾不回来。
  const [enableLocked, setEnableLocked] = useState(false);

  const [testStatus, setTestStatus] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [capabilityStatus, setCapabilityStatus] = useState('');
  const [capabilityStatusKind, setCapabilityStatusKind] = useState<'idle' | 'loading' | 'success' | 'warning' | 'error'>('idle');
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [denoCopyStatus, setDenoCopyStatus] = useState('');
  // 对比已部署的 worker 自报版本: 'idle' 初始, 'checking' 拉取中, 'latest' 完全匹配, 'stale' 任何
  // 不匹配 (拉不到 / 旧 bundle 没 /version / 版本对不上). 故意不展开 stale 的子情况 —— 对用户而言
  // 都是"该重新部署"。staleDetail 仅用于在 stale 时给出可读的原因 (HTTP xxx / 网络错误等)。
  const [versionCheck, setVersionCheck] = useState<'idle' | 'checking' | 'latest' | 'stale'>('idle');
  const [versionCheckDetail, setVersionCheckDetail] = useState('');

  // GitHub 上 worker.bundle.js 的地址 — 主路径是 app 内「复制 Worker 代码」直接拷贝
  // 本地随包的 bundle; 这个 URL 仅作复制失败时的兜底入口. vite.config.ts 注入的
  // __BUILD_BRANCH__: release (master / main) 或非 git 环境 (unknown) 走 master,
  // 其他分支用当前分支, 方便 PR 前在自己 fork / 分支上测 (分支需已推到远端).
  const INSTANT_PUSH_BUNDLE_URL = (() => {
    const branch = (typeof __BUILD_BRANCH__ !== 'undefined' && __BUILD_BRANCH__) || 'master';
    const ref = branch === 'master' || branch === 'main' || branch === 'unknown' ? 'master' : branch;
    return `https://github.com/qegj567-cloud/SullyOS/blob/${ref}/worker/instant-push/worker.bundle.js`;
  })();

  useEffect(() => {
    if (!open) return;
    const cfg = loadInstantConfig();
    setWorkerUrl(cfg.workerUrl);
    setClientToken(cfg.clientToken ?? '');
    setEnabled(cfg.enabled);
    setEnableLocked(!cfg.enabled);
    setAutoTriggerOnSend(cfg.autoTriggerOnSend ?? false);
    setUseD1BlobStore(!!cfg.useD1BlobStore && !!cfg.d1Available);
    setD1Available(!!cfg.d1Available);
    setD1CheckedAt(cfg.d1CheckedAt);
    setD1CheckedWorkerUrl(cfg.d1CheckedWorkerUrl ?? normalizeWorkerUrl(cfg.workerUrl ?? '') ?? '');
    setVapidReady(isPushVapidReady());
    setTestStatus('');
    setCapabilityStatus('');
    setCapabilityStatusKind('idle');
    setCopyStatus('');
    setDenoCopyStatus('');
    setVersionCheck('idle');
    setVersionCheckDetail('');
    void isInstantChatReady().then(setInstantChatOn).catch(() => setInstantChatOn(false));
  }, [open]);

  const normalizedWorkerUrl = normalizeWorkerUrl(workerUrl);
  const canUseD1 = !!d1Available && !!normalizedWorkerUrl && d1CheckedWorkerUrl === normalizedWorkerUrl;
  // 即时对话开着、IP 还没开：勾选框锁死 + 底下那句提示都看这一个值，取消永远不受影响。
  const enableBlockedByInstantChat = instantChatOn && !enabled;
  // 勾选框到底能不能点：停止接入这道门更宽（谁都不许新开），互斥那道门留着当兜底。
  // 两道门都只挡「开」，取消永远放行。
  const enableBlocked = enableLocked || enableBlockedByInstantChat;

  const resetD1State = () => {
    setD1Available(false);
    setUseD1BlobStore(false);
    setD1CheckedAt(undefined);
    setD1CheckedWorkerUrl('');
  };

  const currentCfg = (): InstantPushConfig => ({
    enabled,
    workerUrl: normalizedWorkerUrl,
    clientToken: clientToken.trim() || undefined,
    autoTriggerOnSend,
    useD1BlobStore: canUseD1 ? useD1BlobStore : false,
    d1Available: canUseD1,
    d1CheckedAt: canUseD1 ? d1CheckedAt : undefined,
    d1CheckedWorkerUrl: canUseD1 ? d1CheckedWorkerUrl : undefined,
  });

  const handleWorkerUrlChange = (value: string) => {
    setWorkerUrl(value);
    const nextUrl = normalizeWorkerUrl(value);
    if (d1CheckedWorkerUrl && nextUrl !== d1CheckedWorkerUrl) {
      resetD1State();
      setCapabilityStatus('Worker URL changed, D1 capability needs to be re-checked');
      setCapabilityStatusKind('warning');
    }
  };

  const handleGenerateToken = () => {
    setClientToken(generateClientToken());
  };

  const handleCopyWorkerCode = async () => {
    setCopyStatus('Loading…');
    try {
      await copyInstantWorkerBundleToClipboard();
      setCopyStatus('Copied');
      trackEvent('Copy Instant Push Worker Code', { result: 'success' });
      setTimeout(() => setCopyStatus(''), 2000);
    } catch (e) {
      const err = e as { message?: string } | null;
      setCopyStatus('');
      addToast(`Copy failed: ${err?.message ?? 'Unknown error'}`, 'error');
      trackEvent('Copy Instant Push Worker Code', { result: 'fail' });
    }
  };

  const handleCheckDeployedVersion = async () => {
    if (versionCheck === 'checking') return;
    if (!normalizedWorkerUrl) {
      setVersionCheck('stale');
      setVersionCheckDetail('Please fill in the Worker URL first');
      trackEvent('Compare Deployed Worker Version', { result: 'no_url', clientVersion: INSTANT_WORKER_VERSION });
      return;
    }
    setVersionCheck('checking');
    setVersionCheckDetail('');
    const result = await probeInstantWorkerVersion(currentCfg());
    if (result.ok) {
      setVersionCheck('latest');
      setVersionCheckDetail('');
      trackEvent('Compare Deployed Worker Version', { result: 'latest', clientVersion: INSTANT_WORKER_VERSION });
    } else {
      // 任何拉取失败 / 版本不匹配 → 一律视为旧版, 不再细分 404/405/网络错误。
      setVersionCheck('stale');
      setVersionCheckDetail(result.error ?? 'Unknown error');
      trackEvent('Compare Deployed Worker Version', { result: 'stale', clientVersion: INSTANT_WORKER_VERSION });
    }
  };

  const handleOpenTutorial = () => {
    trackEvent('Open Instant Push Video Tutorial');
    try {
      sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_05_27);
    } catch { /* ignore */ }
    openApp(AppID.FAQ);
    onClose();
  };

  const handleOpenCF = () => {
    trackEvent('Open Cloudflare Dashboard');
    window.open('https://dash.cloudflare.com/?to=/:account/workers-and-pages/create', '_blank');
  };

  // Deno loader 是 8 行自动追新片段 (站点 origin 由 buildDenoLoaderSnippet 现场推算),
  // 贴一次之后 Worker 每次冷启动自动拉站点最新 bundle, 不需要「复制 Worker 代码」式更新。
  const handleCopyDenoLoader = async () => {
    try {
      await copyDenoLoaderToClipboard();
      setDenoCopyStatus('Copied');
      trackEvent('Copy Deno Loader', { result: 'success' });
      setTimeout(() => setDenoCopyStatus(''), 2000);
    } catch (e) {
      const err = e as { message?: string } | null;
      setDenoCopyStatus('');
      addToast(`Copy failed: ${err?.message ?? 'Unknown error'}`, 'error');
      trackEvent('Copy Deno Loader', { result: 'fail' });
    }
  };

  const handleOpenDeno = () => {
    trackEvent('Open Deno Console');
    window.open('https://app.deno.com', '_blank');
  };

  const handleProbeCapabilities = async () => {
    if (capabilityBusy) return;
    const cfg = {
      ...currentCfg(),
      useD1BlobStore: false,
      d1Available: false,
      d1CheckedAt: undefined,
      d1CheckedWorkerUrl: undefined,
    };
    setCapabilityBusy(true);
    setCapabilityStatus('Checking Worker connection…');
    setCapabilityStatusKind('loading');
    try {
      const result = await probeInstantWorkerCapabilities(cfg);
      const checkedAt = Date.now();
      const checkedWorkerUrl = cfg.workerUrl;
      if (!result.ok) {
        const errorText = result.error === 'X-Client-Token required'
          ? 'Worker requires a Client Token'
          : (result.error === 'X-Client-Token invalid' ? 'Client Token is incorrect' : result.error);
        resetD1State();
        setCapabilityStatus(`Connection failed: ${errorText ?? 'Unknown error'}`);
        setCapabilityStatusKind('error');
        saveInstantConfig({ ...cfg, d1Available: false, useD1BlobStore: false });
        // 「要 token」和「token 不对」统一收敛成 fail_auth: 只区分这两种就等于把
        // 用户有没有配 token 报上去了。原始 error 文本只留在界面上, 不进上报。
        trackEvent('Check Instant Push Worker Connection', {
          result: result.error === 'X-Client-Token required' || result.error === 'X-Client-Token invalid'
            ? 'fail_auth'
            : 'fail_other',
        });
        return;
      }

      if (result.d1Available) {
        setD1Available(true);
        setD1CheckedAt(checkedAt);
        setD1CheckedWorkerUrl(checkedWorkerUrl);
        setCapabilityStatus('Connection OK, D1 detected — D1 envelope can be enabled');
        setCapabilityStatusKind('success');
        saveInstantConfig({
          ...cfg,
          useD1BlobStore,
          d1Available: true,
          d1CheckedAt: checkedAt,
          d1CheckedWorkerUrl: checkedWorkerUrl,
        });
        trackEvent('Check Instant Push Worker Connection', { result: 'ok_with_d1' });
      } else {
        const reasonText = result.d1Reason === 'DB binding missing'
          ? 'Worker has no DB binding'
          : (result.d1Reason === 'D1 schema init failed' ? 'D1 table initialization failed' : result.d1Reason);
        resetD1State();
        setCapabilityStatus(`Connection OK, D1 not detected: ${reasonText ?? 'Worker has no DB binding'}`);
        setCapabilityStatusKind('warning');
        saveInstantConfig({ ...cfg, d1Available: false, useD1BlobStore: false });
        // d1Reason 是 worker 回的字符串, 只把两种已知情况映射成固定枚举, 其余一律 other。
        trackEvent('Check Instant Push Worker Connection', {
          result: 'ok_no_d1',
          d1Reason: result.d1Reason === 'DB binding missing'
            ? 'binding_missing'
            : result.d1Reason === 'D1 schema init failed'
              ? 'schema_init_failed'
              : 'other',
        });
      }
    } catch (e) {
      const err = e as { message?: string } | null;
      resetD1State();
      setCapabilityStatus(`Check failed: ${err?.message ?? String(e)}`);
      setCapabilityStatusKind('error');
      saveInstantConfig({ ...cfg, d1Available: false, useD1BlobStore: false });
      trackEvent('Check Instant Push Worker Connection', { result: 'fail_other' });
    } finally {
      setCapabilityBusy(false);
    }
  };

  const handleTest = async () => {
    if (testBusy) return;
    if (!isPushVapidReady()) {
      setTestStatus('Please generate a key pair in "Push Credentials (VAPID)" first');
      trackEvent('Send Instant Push Test Push', { result: 'vapid_missing' });
      return;
    }
    const cfg = currentCfg();
    saveInstantConfig(cfg);
    setTestBusy(true);
    setTestStatus('Getting subscription…');
    try {
      const { sub, reason } = await getOrCreateInstantSubscription();
      if (!sub) {
        setTestStatus(`Subscription failed: ${reason ?? 'unknown'}`);
        trackEvent('Send Instant Push Test Push', { result: 'subscribe_failed' });
        return;
      }
      setTestStatus('Calling LLM and pushing…');
      const result = await sendTestInstantPush(apiConfig);
      if (result.ok) {
        setTestStatus('Push sent — check your system notifications');
        trackEvent('Send Instant Push Test Push', { result: 'pushed' });
      } else {
        setTestStatus(`Failed: ${result.error ?? 'Unknown error'}`);
        trackEvent('Send Instant Push Test Push', { result: 'push_failed' });
      }
    } catch (e) {
      const err = e as { message?: string } | null;
      setTestStatus(`Error: ${err?.message ?? String(e)}`);
      trackEvent('Send Instant Push Test Push', { result: 'error' });
    } finally {
      setTestBusy(false);
    }
  };

  const handleSave = async () => {
    const cfg = currentCfg();
    // 存档这一层也要有跟界面上同一道门：勾选框锁死只挡住了正常操作，modal 刚打开
    // instantChatOn / enableLocked 还没落地那一小段时间里手快勾上就点保存，能在它们生效前
    // 把 off→on 抢跑过去。这里只夹 enabled 这一个字段，其余字段照常存盘；已经是 on 的 IP
    // 不受影响，取消永远放行。
    const turningOn = !loadInstantConfig().enabled && cfg.enabled;
    // 停止接入之后任何 off→on 都不成立；即时对话开没开只决定提示词怎么写（反向互斥门）。
    const raceBlocked = turningOn && await isInstantChatReady();
    if (turningOn) {
      cfg.enabled = false;
      setEnabled(false);
      setEnableLocked(true);
      if (raceBlocked) setInstantChatOn(true);
    }
    saveInstantConfig(cfg);
    // 保存为启用状态视为「已按当前 worker 版本配好」，避免随后被无意义地提醒更新。
    if (cfg.enabled) markWorkerBuildSeen();
    if (turningOn) {
      addToast(
        raceBlocked
          ? "Proactive Message 2.0's Instant Chat is already on, so Instant Push can't be enabled at the same time. The rest of your settings have been saved."
          : `Instant Push has been discontinued (sunsetting ${INSTANT_PUSH_SUNSET_DATE}) and can't be turned back on. The rest of your settings have been saved.`,
        'error',
      );
      return;
    }
    addToast('Instant Push settings saved', 'success');
    onClose();
  };

  const testStatusColor = testStatus.includes('Push sent')
    ? 'text-emerald-600'
    : /failed|error|please generate/i.test(testStatus)
    ? 'text-rose-500'
    : 'text-slate-500';

  return (
    <Modal
      isOpen={open}
      title="Instant Push Settings"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            Save
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        {/* 下线通告 — 排在最上面，进面板第一眼就看见 */}
        <div className="rounded-2xl p-3 bg-amber-50 border border-amber-200 space-y-2">
          <p className="text-[12px] font-bold text-amber-800">
            Instant Push will be discontinued on {INSTANT_PUSH_SUNSET_DATE}
          </p>
          <p className="text-[11px] text-amber-700 leading-relaxed">
            Cloud chat delivery is now handled by "Proactive Message 2.0 · Instant Chat": it covers everything
            Instant Push did, deployment only needs a single Cloudflare Token, and it adds scheduled proactive
            messages, cloud-run MCP tools, and weather / trending-topic / holiday awareness. This path won't be
            maintained after that date.
          </p>
          <a
            href={INSTANT_PUSH_MIGRATION_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('Open Instant Push Migration Guide')}
            className="block w-full text-center py-2 rounded-xl text-[11px] font-bold bg-amber-500 text-white hover:bg-amber-600"
          >
            View Migration Guide →
          </a>
        </div>

        {/* 顶部教程入口 — 打开面板第一眼就能看到，方便第一次自己配的用户 */}
        <button
          type="button"
          onClick={handleOpenTutorial}
          className="w-full flex items-center gap-3 rounded-2xl p-3 bg-gradient-to-r from-rose-50 to-amber-50 border border-rose-200 hover:from-rose-100 hover:to-amber-100 text-left transition-colors"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-[12px] font-bold text-rose-600">First time configuring? Watch the video tutorial first</span>
            <span className="block text-[11px] text-slate-500">Follow along step by step — takes about ten minutes</span>
          </span>
          <span className="shrink-0 text-rose-500 font-bold text-sm">Watch Tutorial →</span>
        </button>

        {/* VAPID 状态横条 */}
        <div className={`rounded-2xl p-3 border ${vapidReady ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] leading-relaxed">
              <p className={`font-bold ${vapidReady ? 'text-emerald-700' : 'text-rose-700'}`}>
                {vapidReady ? 'VAPID Configured' : 'VAPID Not Configured'}
              </p>
              <p className={vapidReady ? 'text-emerald-600' : 'text-rose-600'}>
                {vapidReady
                  ? 'Shared with Proactive Push. Changing it will renew subscriptions on both sides.'
                  : 'You need to generate a VAPID key pair first, and fill it into the Worker env too.'}
              </p>
            </div>
            {onOpenVapid && (
              <button
                type="button"
                onClick={() => {
                  trackEvent('Go to Configure Push Credentials (VAPID)');
                  onOpenVapid?.();
                }}
                className={`shrink-0 px-3 py-2 text-[11px] rounded-xl font-bold ${vapidReady ? 'bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50' : 'bg-rose-500 text-white hover:bg-rose-600'}`}
              >
                {vapidReady ? 'View / Regenerate' : 'Generate →'}
              </button>
            )}
          </div>
        </div>

        {/* ① Worker 配置 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">① Worker Configuration</p>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Worker URL</label>
            <input
              type="url"
              value={workerUrl}
              onChange={(e) => handleWorkerUrlChange(e.target.value)}
              placeholder="https://instant-push.xxx.workers.dev"
              className="w-full text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Client Token (optional, prevents others from abusing your Worker)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientToken}
                onChange={(e) => setClientToken(e.target.value)}
                placeholder="Leave blank to run without a token"
                className="flex-1 text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={handleGenerateToken}
                className="shrink-0 px-3 py-2 text-[11px] bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 font-medium"
              >
                Random
              </button>
            </div>
          </div>

          <label className={`flex items-center gap-2 ${enableBlocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={enableBlocked}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            <span className="text-[12px] text-slate-600 font-medium">Enable Instant Push</span>
          </label>
          {enableBlocked && (
            <p className="text-[11px] text-amber-600 leading-relaxed">
              Instant Push is no longer accepting new setups — it stops being maintained on {INSTANT_PUSH_SUNSET_DATE}.
              For cloud chat delivery, use "Proactive Message 2.0 · Instant Chat" instead — it covers everything
              Instant Push does, and deployment also only needs a single Cloudflare Token.
            </p>
          )}

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoTriggerOnSend}
              onChange={(e) => setAutoTriggerOnSend(e.target.checked)}
              className="accent-indigo-500 mt-0.5"
            />
            <span className="text-[12px] text-slate-600 font-medium leading-relaxed">
              Auto-trigger reply after sending
              <span className="block text-[11px] text-slate-400 font-normal">
                When off, you still need to manually tap ⚡ to trigger a reply after sending text, same as local
                mode; when on, sending text automatically makes the character reply.
              </span>
            </span>
          </label>

          <div className="border-t border-slate-200 pt-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] text-slate-600 font-bold">D1 envelope</p>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Uses chunking by default; once the Worker is detected to have D1 bound, large payloads can switch
                  to short push + full-payload fetch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleProbeCapabilities()}
                disabled={capabilityBusy || !normalizedWorkerUrl}
                className={`shrink-0 px-3 py-2 text-[11px] rounded-xl font-bold ${capabilityBusy || !normalizedWorkerUrl ? 'bg-slate-100 text-slate-400' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {capabilityBusy ? 'Checking…' : 'Check Connection'}
              </button>
            </div>

            <label className={`flex items-start gap-2 ${canUseD1 ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input
                type="checkbox"
                checked={canUseD1 && useD1BlobStore}
                disabled={!canUseD1}
                onChange={(e) => setUseD1BlobStore(e.target.checked)}
                className="accent-indigo-500 mt-0.5"
              />
              <span className="text-[12px] text-slate-600 font-medium leading-relaxed">
                Use D1 envelope for large payloads
                <span className="block text-[11px] text-slate-400 font-normal">
                  {canUseD1
                    ? 'D1 detected and available; when off, default chunking continues to be used.'
                    : 'Check the connection first; this option stays off if D1 is not available.'}
                </span>
              </span>
            </label>

            {capabilityStatus && (
              <p className={`text-[11px] leading-relaxed ${capabilityStatusKind === 'error' || capabilityStatusKind === 'warning' ? 'text-amber-600' : capabilityStatusKind === 'success' ? 'text-emerald-600' : 'text-slate-500'}`}>
                {capabilityStatus}
              </p>
            )}
          </div>
        </div>

        {/* ② 部署 Worker */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">② Deploy Worker</p>

          {/* 方式 A · Deno (推荐): loader 冷启动自动拉最新 bundle, 部署一次永久追新 */}
          <div className="rounded-xl bg-white border border-indigo-200 p-3 space-y-2">
            <p className="text-[12px] text-slate-600 font-bold">Method A · Deno Deploy (recommended, auto-updates)</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Create a new <strong>Playground</strong> in the Deno console, paste in the copied loader (only 8
              lines), and deploy; go to the "Push Credentials (VAPID)" panel to copy the env list for the VAPID
              public/private keys, and paste it into the Playground's environment variables. After that, the Worker
              automatically pulls the latest site code on every cold start — <strong>no manual updates needed</strong>.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleCopyDenoLoader()}
                className="py-2 rounded-xl text-[11px] font-bold bg-indigo-500 text-white hover:bg-indigo-600"
              >
                {denoCopyStatus || 'Copy Deno Loader'}
              </button>
              <button
                type="button"
                onClick={handleOpenDeno}
                className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                ↗ Deno Console
              </button>
            </div>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            <strong>Method B · Cloudflare (manual updates):</strong> In the CF dashboard, Create → Worker to make a
            blank Worker, go into
            <strong> Edit code</strong> and paste over everything with the
            <code className="font-mono"> worker.bundle.js </code>content copied below, then Deploy;
            go to the "Push Credentials (VAPID)" panel to copy the env list for the VAPID public/private keys, and
            paste it into the Worker's Variables.
          </p>

          {/* Worker 代码版本 + 对比已部署: 拉 worker /version 跟随包版本对, 拉不到 / 不一致都算旧 */}
          <div className="flex items-center justify-between gap-3 rounded-xl bg-white border border-slate-200 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-500">Latest Worker code version</p>
              <p className="text-[12px] font-bold text-slate-700 font-mono">{INSTANT_WORKER_VERSION}</p>
            </div>
            <button
              type="button"
              onClick={() => void handleCheckDeployedVersion()}
              disabled={versionCheck === 'checking' || !normalizedWorkerUrl}
              className={`shrink-0 px-3 py-2 text-[11px] rounded-xl font-bold ${
                versionCheck === 'checking' || !normalizedWorkerUrl
                  ? 'bg-slate-100 text-slate-400'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {versionCheck === 'checking' ? 'Checking…' : 'Compare Deployed'}
            </button>
          </div>
          {versionCheck === 'latest' && (
            <p className="text-[11px] leading-relaxed text-emerald-600">
              ✓ Your deployed Worker is up to date ({INSTANT_WORKER_VERSION})
            </p>
          )}
          {versionCheck === 'stale' && (
            <p className="text-[11px] leading-relaxed text-amber-600">
              Your deployed Worker isn't the latest version — Deno: go into Playground and redeploy once (just
              save); CF: copy the latest code below and paste-deploy again
              {versionCheckDetail ? ` (${versionCheckDetail})` : ''}
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleCopyWorkerCode()}
              className="py-2 rounded-xl text-[11px] font-bold bg-indigo-500 text-white hover:bg-indigo-600"
            >
              {copyStatus || 'Copy Worker Code'}
            </button>
            <button
              type="button"
              onClick={handleOpenCF}
              className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              ↗ CF Dashboard
            </button>
          </div>
          {/* 非 release 分支提示: 兜底 GitHub 链接指向当前分支的 bundle */}
          {typeof __BUILD_BRANCH__ !== 'undefined'
            && __BUILD_BRANCH__
            && __BUILD_BRANCH__ !== 'master'
            && __BUILD_BRANCH__ !== 'main'
            && __BUILD_BRANCH__ !== 'unknown' && (
            <p className="text-[10px] text-amber-600 leading-tight pt-1">
              Currently on branch <code className="font-mono">{__BUILD_BRANCH__}</code> — the fallback GitHub link
              points to that branch's bundle, make sure it's been pushed to the remote.
            </p>
          )}

          <div className="flex items-center justify-end pt-1">
            <a
              href={INSTANT_PUSH_BUNDLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent('Click Copy-Failed Fallback GitHub Bundle Link')}
              className="text-[11px] text-slate-400 hover:text-slate-600 underline-offset-2 hover:underline"
            >
              Copy failed? Open worker.bundle.js on GitHub →
            </a>
          </div>
        </div>

        {/* ③ 测试推送 */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testBusy}
            className={`w-full py-3 rounded-xl text-sm font-bold ${testBusy ? 'bg-slate-200 text-slate-400' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
          >
            {testBusy ? 'Testing…' : '🔔 Send Test Push'}
          </button>
          {testStatus && (
            <p className={`text-[11px] text-center ${testStatusColor}`}>{testStatus}</p>
          )}
          {!apiConfig.baseUrl && (
            <p className="text-[11px] text-amber-600 text-center">Please configure the Chat API in Settings → API first — the test push will reuse it</p>
          )}
          <p className="text-[11px] text-slate-400 text-center leading-relaxed">
            The test push carries a <code>metadata.test=true</code> flag — when the SW receives it, it forces a
            system notification even if the app is in the foreground. Real messages still stay silent in the
            foreground, handled by the in-app UI as usual.
          </p>
        </div>

      </div>
    </Modal>
  );
};
