/**
 * WorkerUpdateReminderEvent.tsx
 * 后端 (Instant Push Worker) 更新提醒弹窗。
 *
 * 背景：用户的 worker 跑在自己的 Cloudflare 账户里，目前没法保证自动跟上游同步
 * (见 worker/instant-push/README.md 阶段 2 第 5 条存疑说明)。所以每次我们更新
 * worker 代码就 bump utils/instantWorkerVersion.ts 里的 INSTANT_WORKER_VERSION,
 * 启用了 Instant Push 的用户会被提醒一次：去重新部署 / 同步一下 worker。
 *
 * 只提醒启用了 Instant Push 的用户；没开的人完全不受打扰。
 * 「稍后处理」只贪睡 3 天（不算确认）；sullyos_worker_build_seen 只在用户真正
 * 部署过的语境写入（设置里保存/对比一致）。启动时的 /version 异步探测（PhoneShell）
 * 若确认部署的 worker 过旧，会清掉 seen 重新武装提醒。
 */

import React, { useState } from 'react';
import {
  loadInstantConfig,
  copyInstantWorkerBundleToClipboard,
  buildCloudflareDashboardUrl,
} from '../utils/instantPushClient';
import { INSTANT_WORKER_VERSION } from '../utils/instantWorkerVersion';
import { trackEvent } from '../utils/analytics';

// 记录用户「已确认过的 worker 版本号」。
const WORKER_UPDATE_SEEN_KEY = 'sullyos_worker_build_seen';
// 「稍后处理」的贪睡截止时间戳。过去「稍后处理」直接 markWorkerBuildSeen 永久压掉提醒，
// 结果一批用户点完就再也想不起来更新，worker 长期停在旧版 —— 前端持续自动更新、
// worker 原地踏步，instant 各种「时灵时不灵」的反馈都从这条漂移里长出来。
// 现在「稍后处理」只贪睡 3 天，直到用户真正部署 (设置里保存/对比一致才 markSeen)。
const WORKER_UPDATE_SNOOZE_KEY = 'sullyos_worker_update_snooze_until';

/**
 * 把当前 worker 版本标记为已确认。只在用户**真正部署过**的语境调用
 * (设置里保存启用配置 / 对比已部署一致)，不要在「稍后处理」时调。
 */
export const markWorkerBuildSeen = (): void => {
  try {
    localStorage.setItem(WORKER_UPDATE_SEEN_KEY, INSTANT_WORKER_VERSION);
    trackEvent('Mark Worker Deployed New Version');
  } catch { /* ignore */ }
};

/** 「稍后处理」：贪睡 N 天后再提醒（默认 3 天）。 */
export const snoozeWorkerUpdateReminder = (days = 3): void => {
  try {
    localStorage.setItem(WORKER_UPDATE_SNOOZE_KEY, String(Date.now() + days * 86_400_000));
  } catch { /* ignore */ }
};

/**
 * 重新武装提醒（清掉已确认标记）。启动时的 /version 异步探测确认「部署的 worker
 * 确实旧了」时调用 —— 即使用户以前确认过这个版本号，实际部署漂移了也要再提醒。
 * 贪睡窗口仍然生效，不会连日轰炸。
 */
export const rearmWorkerUpdateReminder = (): void => {
  try {
    localStorage.removeItem(WORKER_UPDATE_SEEN_KEY);
    trackEvent('Detected Worker Version Drift');
  } catch { /* ignore */ }
};

/**
 * 是否要弹「worker 有更新」提醒：
 *  - 只对启用了 Instant Push 的用户弹
 *  - 贪睡窗口内不弹
 *  - 已确认版本与当前内置版本不一致才弹 (null 也算不一致 —— 老用户首次铺该功能时提醒一次)
 */
export const shouldShowWorkerUpdateReminder = (): boolean => {
  try {
    const cfg = loadInstantConfig();
    if (!cfg.enabled) return false;
    const snoozeUntil = Number(localStorage.getItem(WORKER_UPDATE_SNOOZE_KEY) || 0);
    if (Date.now() < snoozeUntil) return false;
    const seen = localStorage.getItem(WORKER_UPDATE_SEEN_KEY);
    return seen !== INSTANT_WORKER_VERSION;
  } catch {
    return false;
  }
};

interface WorkerUpdateReminderPopupProps {
  onClose: () => void;
}

export const WorkerUpdateReminderPopup: React.FC<WorkerUpdateReminderPopupProps> = ({ onClose }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [copyError, setCopyError] = useState('');

  React.useEffect(() => {
    trackEvent('Show Worker Update Reminder');
  }, []);

  const cfg = loadInstantConfig();
  const dashboardUrl = buildCloudflareDashboardUrl(cfg.workerUrl);
  // workers.dev 子域才能推出确切的 worker name; 自定义域 / 反代退化成 workers 列表页。
  const dashboardLabel = dashboardUrl.includes('/services/view/')
    ? 'Open My Worker'
    : 'Open Worker List';

  const handleCopy = async () => {
    setCopyStatus('loading');
    try {
      await copyInstantWorkerBundleToClipboard();
      setCopyStatus('done');
      trackEvent('Copy Latest Worker Code', { Result: 'Success', Entry: 'Update Reminder Popup' });
      setTimeout(() => setCopyStatus((s) => (s === 'done' ? 'idle' : s)), 2500);
    } catch (e) {
      const err = e as { message?: string } | null;
      setCopyError(err?.message ?? 'Unknown error');
      setCopyStatus('error');
      trackEvent('Copy Latest Worker Code', { Result: 'Failure', Entry: 'Update Reminder Popup' });
    }
  };

  const handleOpenWorker = () => {
    // 不在这里 markWorkerBuildSeen —— 用户可能只是先打开 dashboard, 还没真粘贴部署。
    // 等他再次回来发"对比已部署"时若一致, 那个流程会顺其自然不再触发提醒。
    window.open(dashboardUrl, '_blank', 'noopener,noreferrer');
    trackEvent('Open Worker Console');
  };

  const handleLater = () => {
    // 只贪睡, 不 markSeen —— 否则用户点完就永远想不起来更新, worker 长期漂在旧版
    snoozeWorkerUpdateReminder();
    trackEvent('Snooze Worker Update');
    onClose();
  };

  const copyButtonLabel = copyStatus === 'loading'
    ? 'Copying…'
    : copyStatus === 'done'
      ? '✓ Copied'
      : copyStatus === 'error'
        ? 'Retry Copy'
        : 'Copy Latest Code';

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
      <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
        <div className="pt-7 pb-3 px-6 text-center">
          <img
            src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6e0.png"
            alt="worker update"
            className="w-10 h-10 mx-auto mb-2"
          />
          <h2 className="text-lg font-extrabold text-slate-800">Worker backend has an update</h2>
          <p className="text-[11px] text-slate-400 mt-1">Latest version {INSTANT_WORKER_VERSION} · Instant Push</p>
        </div>

        <div className="px-6 pb-4 space-y-3">
          <div className="bg-gradient-to-br from-indigo-50 to-sky-50 border border-indigo-100 rounded-2xl p-4 space-y-2">
            <p className="text-[13px] text-slate-700 leading-relaxed">
              The push worker has a new version — you'll need to sync it:
            </p>
            <p className="text-[12px] text-slate-600 leading-relaxed">
              <strong>Deno deployment</strong>: go to the Playground and redeploy once (just save) — the loader will automatically pull the latest code.
            </p>
            <p className="text-[12px] text-slate-600 leading-relaxed"><strong>Cloudflare deployment</strong>:</p>
            <ol className="text-[12px] text-slate-600 leading-relaxed list-decimal pl-5 space-y-0.5">
              <li>Tap 「Copy Latest Code」below</li>
              <li>Open your Cloudflare worker editor</li>
              <li>Select all, paste to overwrite, and click Deploy</li>
            </ol>
            <p className="text-[11px] text-slate-500 leading-relaxed pt-1">
              If now isn't a good time, the new code is also synced to 「Settings → Instant Message Settings」 —
              just follow the prompts there whenever you're ready.
            </p>
            {copyStatus === 'error' && (
              <p className="text-[11px] text-rose-500 leading-relaxed">Copy failed: {copyError}</p>
            )}
          </div>
        </div>

        <div className="px-6 pb-7 pt-2 space-y-2">
          <button
            onClick={() => void handleCopy()}
            disabled={copyStatus === 'loading'}
            className={`w-full py-3.5 font-bold rounded-2xl text-sm transition-transform active:scale-95 ${
              copyStatus === 'done'
                ? 'bg-emerald-500 text-white'
                : 'bg-gradient-to-r from-indigo-500 to-sky-500 text-white shadow-lg shadow-indigo-200'
            }`}
          >
            {copyButtonLabel}
          </button>
          <button
            onClick={handleOpenWorker}
            className="w-full py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-2xl text-sm active:scale-95 transition-transform"
          >
            ↗ {dashboardLabel}
          </button>
          <button
            onClick={handleLater}
            className="w-full py-2.5 text-slate-400 font-medium text-[12px]"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
};

interface WorkerUpdateReminderControllerProps {
  onClose: () => void;
}

export const WorkerUpdateReminderController: React.FC<WorkerUpdateReminderControllerProps> = ({ onClose }) => {
  return <WorkerUpdateReminderPopup onClose={onClose} />;
};
