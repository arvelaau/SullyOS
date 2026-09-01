// 设置页的「推送订阅状态」面板。
//
// 主动消息 2.0 最难自己发现的故障是「静默失联」：任务建得成、界面全绿、到点一条
// 消息都不来。原因通常在推送这条链路上——权限没给、订阅被浏览器吊销、或者 worker
// 上登记的订阅根本不是这台设备。这个面板把这条链路从头到尾摊开，最后一行「云端
// 登记」正是拆穿静默失联的那一行。
//
// 只读诊断走 pushSubscribeShared 的 readBrowserPushState（各推送层共用同一份判定），
// 重置走 ActiveMsgClient 的 amsg2 路径——退订、按 worker 自己的 VAPID 重订、再覆盖
// 登记回 worker。三步缺一不可，少了最后一步就是把这个面板要治的病再犯一遍。

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActiveMsgClient,
  compareRemotePushSubscription,
  fetchWorkerDiagnostics,
  readAmsgFailKind,
  type AmsgPushRegistrationState,
  type AmsgRemotePushSubscription,
} from '../../utils/activeMsgClient';
import {
  judgePushDeliveryFailure,
  type AmsgPushDeliveryProbe,
} from '../../utils/amsgDiagnostics';
import { catchUpMissedPushesManually } from '../../utils/activeMsgRuntime';
import { readBrowserPushState, type BrowserPushState } from '../../utils/pushSubscribeShared';
import {
  describeElapsed,
  describePermission,
  describeServiceWorker,
  describeSubscription,
  describeSupport,
  hasLiveFailure,
  isSupportBad,
  liveFailureKind,
} from '../../utils/pushDiagnosticsView';
import { bucketRetryCount, trackEvent } from '../../utils/analytics';

interface PushSubscriptionPanelProps {
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/** 连续几次僵尸失败之后，「重置订阅」升级成「深度重置」。 */
const DEEP_RESET_THRESHOLD = 3;

const Row: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className="flex items-start justify-between gap-3">
    <span className="text-slate-500 shrink-0">{label}</span>
    <span className={`text-right font-medium ${bad ? 'text-rose-600' : 'text-slate-700'}`}>{value}</span>
  </div>
);


const REGISTRATION_TEXT: Record<AmsgPushRegistrationState, { value: string; bad: boolean }> = {
  'worker-unset': { value: 'Worker URL not filled in yet', bad: true },
  unreachable: { value: "Can't reach it (Worker unreachable, or too old a version to have this endpoint)", bad: true },
  missing: { value: 'Not registered', bad: true },
  'other-endpoint': { value: 'A different device is registered', bad: true },
  matched: { value: 'Registered (this device)', bad: false },
};

const PushSubscriptionPanel: React.FC<PushSubscriptionPanelProps> = ({ addToast }) => {
  const [browser, setBrowser] = useState<BrowserPushState | null>(null);
  const [remote, setRemote] = useState<AmsgRemotePushSubscription | null>(null);
  // 「登记的确实是这台设备，但推送根本送不到」——只有 Worker 那侧的投递结果知道这件事。
  // null = 还没问到（没填 Worker / 连不上），那时这一行照实说「没查到」。
  const [delivery, setDelivery] = useState<AmsgPushDeliveryProbe | null>(null);
  const [workerConfigured, setWorkerConfigured] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  // 连续几次僵尸失败。不落盘：刷新页面就归零，用户不会莫名其妙看到一个红按钮。
  const [zombieStreak, setZombieStreak] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const browserState = await readBrowserPushState();
      setBrowser(browserState);
      // 没填 Worker 地址就别去问了——问也是白问，还会在控制台留一串没用的报错。
      const config = await ActiveMsgClient.getGlobalConfig().catch(() => null);
      const configured = Boolean(config?.workerUrl?.trim());
      setWorkerConfigured(configured);
      setRemote(configured ? await ActiveMsgClient.getRemotePushSubscription() : null);
      // 「推送有没有真的送出去」是 Worker 那侧算好的（见 /debug 的 pushDelivery）。
      // 这一行和体检面板读的是同一份，不会一个说红一个说绿。
      const probe = configured ? await fetchWorkerDiagnostics() : null;
      setDelivery(probe?.reachable ? probe.report.storage.pushDelivery ?? null : null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const deepMode = zombieStreak >= DEEP_RESET_THRESHOLD;

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      if (deepMode) {
        await ActiveMsgClient.deepResetPushSubscription();
      } else {
        await ActiveMsgClient.resetPushSubscription();
      }
      setZombieStreak(0);
      addToast('Subscription rebuilt and registered with the Worker.', 'success');
      // 只报「成不成 / 是哪一档 / 之前失败了几次」，全是源码里写死的枚举。
      trackEvent(deepMode ? 'Deep Reset Push Subscription' : 'Reset Push Subscription', {
        result: 'success',
        attempt: bucketRetryCount(zombieStreak),
      });
    } catch (error: any) {
      const failKind = readAmsgFailKind(error);
      // 僵尸端点是「重试也没用」的那一类，攒够次数把按钮升级成深度重置。
      // 别的失败（没配 VAPID、权限被拒、断网）换深度重置一点用没有，不计数。
      // NOTE (translation risk): '端点僵尸' is a literal produced by utils/activeMsgClient.ts's
      // readAmsgFailKind() (zombie: '端点僵尸') — matching key, left untranslated on purpose.
      if (failKind === '端点僵尸') setZombieStreak((count) => count + 1);
      // 报错原文可能带 push endpoint，只留在 toast 和控制台里，不进上报。
      addToast(error?.message || 'Failed to reset subscription.', 'error');
      trackEvent(deepMode ? 'Deep Reset Push Subscription' : 'Reset Push Subscription', {
        result: failKind,
        attempt: bucketRetryCount(zombieStreak),
      });
    } finally {
      setResetting(false);
      await refresh();
    }
  };

  /**
   * 手动补收：去云端账本上把没收到的消息捞回来。
   *
   * 结果照实说，不含糊：捞回来几条、翻过多少条都报出来。「一条都没补回来」跟「压根没读成」
   * 是两个结论，用户拿它决定下一步该干嘛（前者说明消息不在账本上、该查别处，后者只是这趟
   * 没读成、再点一次就行），混在一起说等于什么都没说。
   */
  const handleCatchUp = async () => {
    setCatchingUp(true);
    try {
      const { written, scanned, stale } = await catchUpMissedPushesManually();
      if (written > 0) {
        // 补回来了，但同一趟里还有超窗的——两件事都得说，不然用户以为全找回来了。
        addToast(
          stale > 0
            ? `Recovered ${written} message(s) — check your chat. Also, ${stale} more are over two days old and can't be recovered.`
            : `Recovered ${written} message(s) — check your chat.`,
          'success',
        );
      } else if (stale > 0) {
        // 有本该收到的消息、但全都过了两天：说清楚是「丢了」不是「没有」——这是用户
        // 唯一一次知道这件事的机会，含糊过去他会以为链路是好的。
        addToast(`${stale} message(s) are over two days old and were never received — they can't be recovered anymore.`, 'error');
      } else if (scanned > 0) {
        // 账本上有行，但没一条是该上屏的聊天内容（思维链、工具请求这些不进聊天流）。
        addToast('Everything left in the ledger is non-chat content — there is nothing to recover.', 'info');
      } else {
        addToast('No missed messages in the ledger — this pipeline is working.', 'info');
      }
    } catch (error: any) {
      addToast(error?.message || 'Failed to read the cloud ledger — try again later.', 'error');
    } finally {
      setCatchingUp(false);
    }
  };

  const registration: AmsgPushRegistrationState = workerConfigured
    ? compareRemotePushSubscription(browser?.endpoint, remote)
    : 'worker-unset';
  const registrationText = REGISTRATION_TEXT[registration];

  // 上一次推送到底送没送到。判定跟体检面板共用 judgePushDeliveryFailure——两处各写一套的话，
  // 用户会看到一个红一个绿，而这正是他判断该不该重置订阅的唯一依据。
  const deliveryVerdict = judgePushDeliveryFailure(delivery);
  const deliveryText: { value: string; bad: boolean } = !workerConfigured || !delivery
    ? { value: 'Not checked (connect to a Worker first)', bad: false }
    : !delivery.probed
      ? { value: delivery.reason === 'unsupported' ? "This Worker doesn't check yet" : 'Check failed', bad: false }
      : delivery.gone && deliveryVerdict
        ? { value: `Rejected by the push service (${delivery.gone.status})`, bad: true }
        // 有旧账但已经不算数了：说清楚「那是上一条订阅的事」，别让人以为从来没坏过。
        : { value: delivery.gone ? 'This subscription has not been rejected since it was registered' : 'No rejection on record', bad: false };

  const resetLabel = resetting
    ? (deepMode ? 'Deep resetting…' : 'Resetting…')
    : (deepMode ? 'Deep Reset' : 'Reset Subscription');

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3 leading-relaxed">
        Proactive messages reach you via web push when they're due. If any link in this chain breaks, it looks the
        same either way — the task gets created but nothing arrives when it's due — with no visible error on
        screen. This panel lays out every link in the chain for you.
      </p>

      <div className="bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-600">Pipeline Status</p>
          <button
            onClick={() => {
              // 全是浏览器/设备状态的固定枚举，不含端点地址、也不含任何用户配置值
              trackEvent('Refresh Web Push Diagnostics', browser ? {
                permission: browser.permission,
                subscription: !browser.endpoint ? 'none' : browser.endpointDead ? 'dead' : 'active',
                swState: browser.swState === 'activated' ? 'activated' : browser.swState === 'none' ? 'none' : 'other',
                platform: browser.capacitorNative ? 'capacitor_native' : browser.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                registration,
                // 「接口全在但这台设备就是建不出订阅」的唯一可见出口。取的是共用层那个
                // 固定枚举，不含报错原文。
                lastFailure: liveFailureKind(browser) ?? 'none',
                // 「登记全对但推送被退回」有多普遍。四个取值全是这儿写死的字面量，
                // 不带状态码原文、不带端点、不带失败原因。
                delivery: !delivery || !delivery.probed ? 'unknown'
                  : delivery.gone && deliveryVerdict ? 'gone'
                    : delivery.gone ? 'recovered' : 'clean',
              } : undefined);
              void refresh();
            }}
            disabled={refreshing || resetting}
            className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:text-slate-300"
          >
            {refreshing ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {browser ? (
          <div className="space-y-1.5 text-[11px]">
            <Row label="Browser Support" value={describeSupport(browser)} bad={isSupportBad(browser)} />
            <Row label="Notification Permission" value={describePermission(browser.permission)} bad={browser.permission !== 'granted'} />
            <Row label="Service Worker" value={describeServiceWorker(browser)} bad={browser.swState !== 'activated'} />
            <Row
              label="Browser Subscription"
              value={describeSubscription(browser)}
              bad={!browser.endpoint || browser.endpointDead}
            />
            <Row label="Push Channel" value={browser.channel} />
            <Row label="Cloud Registration" value={registrationText.value} bad={registrationText.bad} />
            {/* 上面每一行答的都是「配好了吗」，这一行答的是「实际推出去了吗」。前面全绿
                后面照样能红——那正是「任务建得成、到点没消息」最难自己发现的一种坏法。 */}
            <Row label="Last Delivery" value={deliveryText.value} bad={deliveryText.bad} />

            {browser.endpoint && (
              <div className="pt-2 mt-2 border-t border-slate-200">
                <p className="text-[10px] text-slate-400 mb-1">Subscription endpoint (first 60 chars)</p>
                <p className={`text-[10px] font-mono break-all leading-relaxed ${browser.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>
                  {browser.endpoint.slice(0, 60)}…
                </p>
              </div>
            )}

            {browser.capabilityGap && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                {browser.capabilityGap}.
              </div>
            )}
            {/* 失败原文以前只走 toast，一闪而过就没了——而这类失败恰恰最需要照着原文
                排查。这里把它固定显示出来，直到订阅真的建起来为止。 */}
            {hasLiveFailure(browser) && browser.lastSubscribeFailure && (() => {
              const failure = browser.lastSubscribeFailure!;
              const elapsed = describeElapsed(failure.at);
              return (
                <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                  <p className="font-semibold mb-1">Last subscription build failed{elapsed && ` (${elapsed})`}</p>
                  <p>{failure.text}.</p>
                  {(failure.kind === 'channel-unreachable' || failure.kind === 'no-subscription') && (
                    <p className="mt-1.5 pt-1.5 border-t border-rose-200">
                      This category <b>gives the same result no matter how many times you retry</b> — the problem isn't
                      this site or your permissions. Switching browsers, networks, or devices is what actually helps.
                    </p>
                  )}
                </div>
              );
            })()}
            {browser.endpointDead && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                The subscription address became <code className="font-mono">permanently-removed.invalid</code>,
                meaning the browser revoked this subscription (common causes: not opened in a long time, notification
                permission changed, or site data cleared). This domain never resolves anywhere, so any push sent to
                it is guaranteed to fail. Click "Reset Subscription" below to rebuild one.
              </div>
            )}
            {deliveryVerdict?.level === 'bad' && (
              <div className={`mt-2 p-2 border rounded-lg text-[10px] leading-relaxed ${
                deliveryVerdict.level === 'bad'
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}>
                <p className="font-semibold mb-1">Push was rejected</p>
                <p>{deliveryVerdict.what}.</p>
                {/* 这段解释只在坐实了的时候说：warn 那档是 Worker 问不到，上面几行本来
                    就红着，再说一句「上面都没问题」只会自相矛盾。 */}
                {deliveryVerdict.level === 'bad' && (
                  <p className="mt-1.5 pt-1.5 border-t border-current/20">
                    Every line above <b>checks out fine</b> — what's broken is the subscription itself. It has gone
                    stale on the push service side (Chrome via FCM, Firefox via Mozilla, iOS via Apple), and only the
                    push service knows this — none of the lines above can detect it. Click "Reset Subscription" below
                    for a new one.
                  </p>
                )}
              </div>
            )}
            {registration === 'other-endpoint' && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                The subscription registered with the Worker isn't this device — proactive messages will push to
                <b> somewhere else</b>, and this device won't receive them. This happens after switching devices,
                browsers, or Workers (each account stores only one subscription — the newest registration overwrites
                the previous one). Click "Reset Subscription" to switch it to this device.
              </div>
            )}
            {/* 通道不通 / 内核不支持的时候不提「点重置订阅」：那一步必挂在建订阅上，
                登记根本轮不到，上面那个失败框才是这台设备真正的结论。 */}
            {registration === 'missing' && !isSupportBad(browser) && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                There's no subscription registered with the Worker at all, so there's nowhere to push to when it's
                due. Click "Reset Subscription" to register this device.
              </div>
            )}
            {browser.iosNeedsPwa && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                iOS Safari detected, but it's not currently launched from a home-screen icon.
                Web push on iOS only works after "Add to Home Screen," launched from that home-screen icon.
              </div>
            )}
            {browser.capacitorNative && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                You're currently using the <b>packaged app</b>, not a browser page. The web push channel doesn't
                exist in the app — you can ignore this panel entirely, it doesn't affect normal use.
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-slate-400">Loading…</p>
        )}

        <button
          disabled={resetting || refreshing || browser?.capacitorNative}
          onClick={() => void handleReset()}
          className={`mt-4 w-full py-2 rounded-xl text-xs font-bold border ${
            resetting || refreshing || browser?.capacitorNative
              ? 'bg-slate-100 text-slate-400 border-slate-200'
              : deepMode || browser?.endpointDead || registrationText.bad || deliveryText.bad
                ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          {resetLabel}
        </button>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          "Reset Subscription" clears the current one, rebuilds it, and re-registers it with the Worker. Click it
          after switching browsers, switching Workers, or if the subscription gets revoked.
          {deepMode && <><br/>Several attempts in a row haven't worked, so it's switched to "Deep Reset" — it reinstalls the Service Worker entirely, for a more thorough fix.</>}
        </p>

        {/* 上面那条链路修好了也追不回已经丢掉的消息——那些还在云端账本上躺着，得有人去拿。
            平时冷启动和回到前台会自动捞一次，这个按钮是给「我确实少收了东西」的时候用的：
            它连头一趟的账本存量也当补收处理，而自动那条路会把存量整批销掉（分不清哪些是
            真丢的、哪些是当时收到了只是老版本不会销账，倒出来就是重放）。 */}
        {workerConfigured && !browser?.capacitorNative && (
          <>
            <button
              disabled={catchingUp || resetting || refreshing}
              onClick={() => void handleCatchUp()}
              className={`mt-3 w-full py-2 rounded-xl text-xs font-bold border ${
                catchingUp || resetting || refreshing
                  ? 'bg-slate-100 text-slate-400 border-slate-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {catchingUp ? 'Searching…' : 'Recover Missed Messages'}
            </button>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
              Before every message is sent, the cloud logs a line for it first, and it's only cleared once you've
              received it. So if a push gets lost along the way (unstable network, a proxy running, the phone
              backgrounded), the content is still sitting in the cloud — click this to recover anything missed in
              the last day.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default PushSubscriptionPanel;
