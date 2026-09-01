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

// 满血链路吃满这些 worker 特性（amsg-server 2.6.0-next.4+）。探测不到端点（老部署
// 404 → null）或缺任何一项，就亮「重新部署」提示——worker 跑在用户自己的账号里，
// 站点这边发新版不会自动同步过去。
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
  // 后台 fire 每轮把 tools 参数带给 LLM（角色在主动消息里用得上用户自配的 MCP 工具）。
  'agentic-fire-tools',
  // hook 载荷自带 readState / writeState，配置级 hook 不用再自己攒一份写口。
  'hook-state-accessors',
  // onAfterSend 拿到本次 fire 的 scratch：自述回写按真正送出去的段数落账。
  'after-send-scratch',
  // 任务身份直接挂在 ctx 和 push 顶层，两条排程路径不用各抄一份 metadata。
  'fire-task-identity',
  'push-task-identity',
  // 库导出信封余量常量，push 体积按「库补完字段之后」的尺寸算。
  'push-envelope-reserved-bytes',
  // 角色自排撞车时回已存在那行的投影，重跑那轮也记得下账。
  'schedule-task-duplicate-row',
  // 循环任务的过期快进也回调，攒下的那几次跳过在面板上看得见。
  'recurring-stale-skip-hook',
  // 任务行带时区，daily / weekly 按角色所在时区的墙钟推进。
  'task-timezone',
  // 推送订阅按用户存一份，排程不再携带；换订阅后已排的任务自动跟上。
  'user-push-subscription',
  // 凭据存成表里的一行、任务只带引用（credRefs）。换 Key 只要覆盖那一行，已排的任务
  // ——包括角色在触发时给自己排的那些——下次触发就用新凭据。缺了它就退回「凭据冻结
  // 进每条任务」的老路：换 Key 要逐条补刷，漏一条到点就是 401。
  'llm-credentials',
];
// features 之外还必须比版本：这波依赖的能力大多没发独立 flag，光查 features 分不出新旧。
//   next.5 — GET /messages 投影（charId/clientTaskId）、onBeforeFire 的 { skip } 出口
//   next.6 — 任务占位租约（带工具的 AI 任务常跑过一分钟，没有占位会被相邻 cron tick 重复推）
//   next.7 — hook 的 writeState（大内容旁路存 client_state）、Web Push payload 大小护栏
//   next.8 — fire 循环透传 tools 请求参数（后台调用户自配 MCP 的前置）
//   next.9 — 这一档还兼做「bundle 里有没有自述回写」的判据：角色发完把正文记回
//            client_state、下次到点接着说（fire_pack 的 self_log 槽位），是随本波
//            bundle 一起上去的。旧 bundle 收到带槽位的 fire_pack 只会把
//            `{{AMSG_SELF_LOG}}` 原样发给 LLM，而 SERVER_VERSION 是打包时那份
//            amsg-server 的版本号，正好能把这类旧粘贴认出来。
//   next.11 — 推送订阅改成按用户存一份：这一档起排程不再携带订阅，前端走
//            /push-subscription 端点登记，旧 worker 上这个端点不存在。
//   next.12 — 「角色说过什么」的落盘改挂在 onFireSettled 上（不论这次是发出去了、
//            跳过了还是抛错了都调一次）。旧 worker 认不得这个 hook，会把它当成
//            无关配置直接忽略——而 bundle 这边已经不再用 onAfterSend，表现就是
//            self_log 永远不写：角色到点不知道自己上次说过什么，天天重复同一句。
//            同一档还带 run-tick 的同角色任务串行（serializeBy）。
//   next.15 — 这一档能力密集，而且 bundle 里的 wrapper 已经按新上游行为改写：
//            即时对话 immediate 落库即到期 + supersedesUuid 原子顶替；llmExtraBody
//            （思考链三件套上云）；租约心跳续租（wrapper 不再配 claimLeaseMs，旧
//            上游没有心跳 → 退回 10 分钟死租约，isolate 死后任务干等）；fire ctx
//            的 cancelTask / renewTask（角色取消 / 改期自己的排程）；client_state
//            条件写（旧包不盖新包）；任务行 last_error（失败原因可查）。
//   next.16 — 即时对话改由 Durable Object 起跳，靠的就是这一档的 runTask（按 uuid
//            跑单条）；错误响应带 error.cause（真因不再只进 worker 日志）；
//            getSchemaVersion（表结构对不对得上，由上游按自己的建表语句比对）。
//   next.17 — 用户级 LLM 凭据表（PUT/GET/DELETE /llm-credentials）、任务的 credRefs、
//            fire hook 的 resolveLlmCredential。这一档有独立 flag（上面那条
//            'llm-credentials'），版本号列在这里只是备个案。
//   next.20 — 推送被推送服务判死（410 / 404）时当终态，不再空转重试——投递是先生成
//            后推送，每重试一跳就白跑一整轮 LLM；同时把状态码结构化写进 last_error
//            的 pushStatus，体检的「这台设备」靠它拆穿「登记全绿但一条都不来」。
//            另外 client_state 的前缀清理改走字典序范围：D1 把 LIKE pattern 压到
//            50 字节（官方文档没写），key 一长就整条语句报 pattern too complex，
//            同批的状态写入跟着一起回滚。
//   next.21 — 带 body 的端点认 `Content-Encoding: gzip`：即时对话那条路上的正文
//            （整轮聊天）在客户端压过再发，旧 worker 不认这个头，会把压缩字节当
//            明文读，报出来是一句「请求体不是合法的 JSON」——大消息一条都发不出去。
//            同一档还有失败记录里的 errorCode（`LLM_CALL_FAILED` 之类）和上游拒绝
//            请求时的原话：卡片上那句「生成失败」从此说得出到底是模型名写错了、
//            余额不够，还是订阅失效该去重新登记。
//   next.23 — 跟着 amsg-shared 0.4.0-next.8 一起升：shared 的通知字段校验放行了
//            `silent: 'when-visible'`（静音改由 Service Worker 按窗口可见性算）。
//            server 侧没有行为变化，单升这一档不解决任何问题；这批真正要用户去点
//            一次「更新 Worker」的是通知策略本身，见 utils/amsgBundleVersion.ts。
// 不比版本的话，旧粘贴部署会被误判为最新，问题全在 worker 侧静默发生。
const REQUIRED_WORKER_VERSION = '2.6.0-next.23';

/** 装着打包好的 worker 代码的部署仓库：fork 它 → 在 Cloudflare 连上 → 以后点 Sync fork 更新。 */
const WORKERS_REPO_URL = 'https://github.com/Tosd0/sullyos-workers';
const SETUP_WALKTHROUGH_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md';
/** 一键部署要的那枚 API Token 在这里建。 */
const CF_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

// 探测结果每次会话只报一次。refresh() 在开面板、连接成功、订阅成功后都会跑一遍，
// 一个连不上、反复点「连接」的人否则能一个人刷出十几条同样的结果，把分布带歪。
let workerCapsReported = false;
// 「即时对话开不了卡在哪」同样每次会话只报一次，理由同上。
let instantChatGateReported = false;

/** 体检每一行的配色与那一列小字。unknown 用灰：查不出结论时别拿颜色暗示好坏。 */
const DIAGNOSTIC_STYLES: Record<AmsgDiagnosticLevel, { dot: string; text: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600', word: 'OK' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', word: 'Note' },
  bad: { dot: 'bg-rose-500', text: 'text-rose-600', word: 'Issue' },
  unknown: { dot: 'bg-slate-300', text: 'text-slate-400', word: 'Unknown' },
};

/** 刚生成的密钥明文：输入框是 password 型，只能在这一处让用户看见并手动复制。 */
const SecretReveal: React.FC<{ value: string; className?: string }> = ({ value, className = '' }) => (
  <p className={`font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5 ${className}`}>
    {value}
  </p>
);

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** 「清空云端数据」清完要立刻把工具凭据补传回去，所以这里需要当前这份配置。 */
  realtimeConfig: RealtimeConfig;
  /** 由 Settings 注入：点「去推送凭据面板」时打开顶层 PushVapidSettingsModal */
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
  // 手动粘贴部署：给没有 GitHub 账号的人留的退路，默认收着不干扰主流程。
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  // Deno 门面：workers.dev 在国内连不上时才需要，默认收着。
  const [denoProxyOpen, setDenoProxyOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // 「生成 Master Key」只在本次打开期间展示，前端不落盘——它是 worker 侧密钥，粘进 CF env 即可。
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');
  const [generatedServerToken, setGeneratedServerToken] = useState('');

  // 一键部署：填一枚 CF Token，剩下的（建库、传 worker、写密钥、加定时）都自动做完。
  // Token 只在这次部署期间留在内存里，成功与否都不落盘——它是能改整个账号 Workers 的
  // 权限，真正需要长期留着的那一份已经作为 secret 写进用户自己的 worker 了（自更新用）。
  const [cfToken, setCfToken] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState('');
  /** token 能用在多个账号上时让用户挑一个。 */
  const [provisionAccounts, setProvisionAccounts] = useState<CfAccount[] | null>(null);
  /** 全新的 CF 账号还没有 workers.dev 子域，得先起一个。 */
  const [needsSubdomain, setNeedsSubdomain] = useState(false);
  const [desiredSubdomain, setDesiredSubdomain] = useState('');
  const [provisionError, setProvisionError] = useState('');

  // 补装更新能力：老办法装的后端里没有 CF_API_TOKEN，点更新会被顶回来。
  // 粘一枚 token 就能就地补上，不用去 Cloudflare 面板。只在真的缺钥匙时才露出来。
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachToken, setAttachToken] = useState('');
  const [attachScriptName, setAttachScriptName] = useState('');
  const [attachNeedsScriptName, setAttachNeedsScriptName] = useState(false);
  const [attachAccounts, setAttachAccounts] = useState<CfAccount[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');

  // 体检：worker 的 GET /debug 结果。它早就把「缺哪个变量、缺哪张表、缺哪几列、cron
  // 有没有停」都算好了，但入口一直只有手拼 URL——而这几样恰恰是「界面上一切正常、
  // 就是一条都不发」的全部原因。存原始探测结果，红绿灯在渲染时算（推送状态一变就跟着走）。
  const [diagnosticsProbe, setDiagnosticsProbe] = useState<AmsgDiagnosticsProbe | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // 体检摆在最上面，但默认收着：装好之后它天天是「都正常」，摊开占掉半屏。
  // 标题那一行已经把结论说了，要看是哪一项才需要点开。
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [workerOutdated, setWorkerOutdated] = useState(false);
  /**
   * 用户那台 Worker 上的后端代码是不是最新的（见 ActiveMsgClient.probeWorkerVersion）。
   * null = 还没探到（没填地址 / 正在探）。界面拿它决定更新按钮是高亮催更新还是弱化。
   */
  const [workerVersion, setWorkerVersion] = useState<
    { state: 'current' | 'outdated' | 'unknown'; deployed: string | null; expected: string } | null
  >(null);
  /** 自更新成功后 worker 报回来的代码指纹，显示出来好让人确认这次真换了。 */
  const [selfUpdateHash, setSelfUpdateHash] = useState('');
  // Instant Push 也开着：聊天会走它，2.0 挂在本地那条路上的几样东西全静默失效——设置页
  // 两道双向门通常已经拦住这种组合，这里读一次是给漏网脏配置兜底，关掉后立刻更新。
  const [instantOn, setInstantOn] = useState(false);
  // 这台 worker 认不认 /instant-chat。即时对话的**唯一**版本门槛就在这儿，
  // 别处不做逐调用预检——每发一条消息多探一次网络，探失败还分不清是旧版还是网抖。
  const [instantChatSupported, setInstantChatSupported] = useState(false);

  // 特性探测：确认「过老」（端点 404 → null，或缺关键特性）才亮牌；
  // 探测本身失败（断网 / 密钥不对 / 没填地址）不亮，避免误报。
  const probeWorkerCaps = async (workerConfigured: boolean) => {
    // 只有配了地址才报：没填地址时这次探测必然失败，那不是版本问题。
    const shouldReport = workerConfigured && !workerCapsReported;
    if (shouldReport) workerCapsReported = true;
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      const missingFeature = !caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f));
      const versionTooOld = !caps || !isAmsgServerVersionAtLeast(caps.serverVersion, REQUIRED_WORKER_VERSION);
      setWorkerOutdated(missingFeature || versionTooOld);
      // 跑着旧 worker 的表现是**静默错**（自述回写不落盘、任务重复推），用户不会来报，
      // 面板这一句提示是唯一的出口。这里数的就是「有多少人正跑着一个不该跑的版本」。
      if (shouldReport) {
        trackEvent('Probe 2.0 Worker Capabilities', {
          result: !caps ? 'Endpoint not found' : missingFeature ? 'Missing feature' : versionTooOld ? 'Version too old' : 'ok',
        });
      }
    } catch {
      setWorkerOutdated(false);
      // 探测本身炸了（断网 / 地址不通）不亮牌，免得误报；但它跟「版本旧」是两回事，
      // 单独占一格，看分布时能一眼把这批人排除掉。
      if (shouldReport) trackEvent('Probe 2.0 Worker Capabilities', { result: 'Probe failed' });
    }
  };

  // 已经存过盘的那个 Worker 地址。清空确认要用它：确认之前不能换地址，
  // 取消远端任务的那几个请求还得发到旧那台上去。
  const savedWorkerUrlRef = useRef('');

  /**
   * 拉一次体检。没填地址时不拉——那时候唯一该做的事是把地址填上，
   * 摆一排红灯只会让人以为哪儿坏了。
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
   * 报一次「即时对话此刻能不能开、开不了卡在哪」。
   *
   * 这一格只能在这儿收：开关灰着的时候用户什么都点不动，也就不会产生任何别的事件——
   * 光看配置快照里那个开/关，被挡在门外的人和「不想要这功能的人」长得一模一样。
   * 判定跟界面上那行黄字共用 resolveInstantChatBlocker，两处不会各说各话。
   */
  const reportInstantChatGate = (gate: InstantChatGateInput, enabled: boolean) => {
    if (instantChatGateReported) return;
    instantChatGateReported = true;
    trackEvent('Can Instant Chat Be Enabled', {
      result: resolveInstantChatBlocker(gate) ?? 'Can enable',
      // 已经开着的人也报：他们卡住意味着「开的时候好好的，后来 Worker 退回旧版了」，
      // 那是一种发一条挂一条、但设置页还写着「已开启」的坏法。
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

  /** 关掉 Instant Push 的开关，worker 地址等配置留着——以后想切回去不用重填。 */
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
    // 两个明文密钥都要清：留到下次打开面板还挂在页面上，就是白白多摊一次。
    setGeneratedMasterKey('');
    setGeneratedServerToken('');
    // CF Token 更要清：它比上面两个都重，绝不留到下次打开。
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
   * 地址被清空时的收尾：先问一句，再拿**旧地址**把远端任务取消干净，最后才存空值。
   *
   * 光存空值的话，前端这边所有同步立刻停摆，D1 里的任务却一条没少：cron 每分钟照常
   * 消费、照烧 LLM、照推送（推送订阅也还在），只是内容永远停在最后一次同步的样子。
   * 用户以为自己关掉了一切，实际只是把自己变成了看不见的那一方。
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
        // 用户反悔：把地址填回输入框，别留一个「界面空着、库里还存着」的错位。
        patchConfig({ workerUrl: savedWorkerUrlRef.current });
        return;
      }
    }
    await ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
      instantChatEnabled: config.instantChatEnabled,
      // 一键部署生成的 Master Key 也要跟着存：这是本地唯一的一份，Worker 那边读不回来。
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
      // 建完浏览器订阅还要登记到 worker 上那一份用户级订阅——worker 到点读的是它，
      // 只在浏览器建订阅的话云端仍是空的，到点会抛 PUSH_SUBSCRIPTION_MISSING，
      // 而这句 toast 已经报了「准备完成」。
      await ActiveMsgClient.registerPushSubscription();
      await refresh();
      addToast('Notification permission and push subscription are ready.', 'success');
      trackEvent('Enable Notifications & Push Subscription', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || 'Failed to create push subscription.', 'error');
      // 只报抛错那一刻挂上的代号（源码里写死的枚举）。错误原文可能带 push endpoint，
      // 留在 toast 和 console 里，不进上报。
      trackEvent('Enable Notifications & Push Subscription', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 一键部署：只要一枚 Cloudflare API Token，把后端从零装好，装完顺手连上。
   *
   * 密钥全部在本地生成，用户不用复制粘贴任何东西。已经有的一律沿用——Master Key 换了
   * 之前排的任务全解不开，VAPID 换了浏览器现有的推送订阅会全部 403。
   *
   * Token 只在这次操作期间留在内存里，成功与否都不落盘。需要长期留着的那一份已经作为
   * secret 写进用户自己的 Worker 了（以后「更新后端」用的就是它）。
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
        // 这两种不是失败，是「还差一个信息」，界面上补个输入再点一次就能接着走。
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

      // 先把密钥落盘再连接：连接要用 serverToken，而 Master Key 一旦丢了就再也读不回来。
      const { secrets } = result;
      savePushVapid({
        vapidPublicKey: secrets.VAPID_PUBLIC_KEY,
        vapidPrivateKey: secrets.VAPID_PRIVATE_KEY,
        vapidEmail: secrets.VAPID_EMAIL || undefined,
      });
      // instantChatEnabled 跟着一起写：面板渲染时 config 一定不是 null（文件末尾有空值
      // 早退），读到的就是界面上当前的值，不显式带上会被这次保存冲掉。
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
      // 别在这儿说「装好了」就完事：地址还要几十秒才在各个边缘节点上生效，而上面那句
      // patchConfig 一落地，一键部署那张卡片就因为「地址已填」收起来了——进度条跟着消失，
      // 看上去像是全部办妥。用户于是去点「连接并启用」，撞上还没生效的地址。
      addToast(`Backend deployed: ${result.workerUrl}. The address takes a few dozen seconds to become active — just wait for it to connect on its own.`, 'success');
      trackEvent('One-Click Deploy 2.0 Backend', { result: 'Success' });

      // 刚建好的 workers.dev 地址要等一会儿才解析得到，等它活过来再建表。
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
      // 报错原文只进界面，不进上报（可能带地址、账号 id）。
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
      // 连上了但有一块是哑的（最典型是 VAPID 没配齐：任务建得成、到点一条都推不出去，
      // 而界面上没有任何异常）。这类问题用户自己发现不了，连接这一刻不说就没人说了。
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      // 只报「这次连接成没成 / 卡在哪一类」。连接串 / tenantToken / 错误原文一概不带，
      // 也不报「之前配没配过 tenant」——那等于把两项凭据的配置状态压成一位发出去。
      // 失败代号是抛错时按 HTTP 状态挂上的字面量（见 activeMsgClient 的 AmsgFailKind），
      // 分开是因为「密钥对不上」和「D1 没绑」要用户去改的地方完全不同。
      trackEvent('Connect & Enable Proactive Message 2.0', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || 'Connection failed.', 'error');
      trackEvent('Connect & Enable Proactive Message 2.0', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 让后端自己更新到最新版本。
   *
   * 三种装法（fork 后连 Git / Deploy 按钮 / 找人代配）此前更新方式各不相同，最麻烦的一种
   * 要在两个网站之间倒腾一个几百 KB 的文件。有了这个按钮都变成点一下。
   *
   * 更新成功后接着跑一次「连接并验证」（POST /init-tenant，幂等）。
   *
   * 这一步不是可有可无的收尾：新版后端可能带了新的表结构，而 D1 的建表只在这个端点里做。
   * 少了它，Worker 代码是新的、库还是旧的，cron 每分钟静默失败，主动消息整个停摆——
   * 而界面上一切正常，用户完全看不出来（这个坑踩过）。让「更新」自己把它带上，
   * 就不必指望每个人都记得再手动点一次。
   *
   * 失败不改判这次更新：代码确实已经换上了，只是库没跟上。分开报，用户才知道该点哪个。
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
        // 「缺 CF_API_TOKEN」是这里唯一能就地解决的一种：露出补装那一块，
        // 用户粘一枚 token 就好，不用去 Cloudflare 面板加变量。
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
   * 给已经装好的后端补上「自己更新自己」的钥匙。
   *
   * 只写 CF_API_TOKEN / CF_SCRIPT_NAME 两条密钥，不碰脚本也不碰别的绑定——手动部署的
   * 用户，前端手里根本没有他们的 Master Key，走重传那条路会把密钥抹掉。
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

  // 手动粘贴部署用。主流程是 fork sullyos-workers + 在 CF 连 Git，这条是给没有 GitHub
  // 账号的人留的退路，所以在面板里收在折叠区里。
  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker code copied. Paste it over the existing code in Edit code on the CF dashboard.', 'success');
      trackEvent('Copy 2.0 Worker Code', { result: 'ok' });
    } catch (error: any) {
      addToast(`Copy failed (${error?.message || error}). You can also get it from worker/amsg/worker.bundle.js in the repo.`, 'error');
      // 剪贴板 API 在非 HTTPS / 部分 WebView 里会直接抛，这条就是那批人的规模。
      trackEvent('Copy 2.0 Worker Code', { result: 'failed' });
    }
  };

  // workers.dev 在国内连不上时的门面脚本。跟上面那份不一样：这份不打包、原样发布，
  // 用户要照着里面的注释改 UPSTREAM 那一行，所以注释必须留着。
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
   * 复制密钥时带不带 `变量名=` 前缀，看 Worker 地址填了没：
   * 空着 = 还没装后端，用户要去 Cloudflare 的 Variables and secrets 里新建变量，
   * 给整行最省事（粘一行进去会自动拆成名字和值两栏，不用对着抄名字）；
   * 填了 = 后端早装好了，这会儿是回来改某一项的值，光标就停在值那一栏，
   * 整行粘进去会把变量名一起写成值。
   */
  const copyWholeEnvLine = !config?.workerUrl?.trim();

  /**
   * 把刚生成的密钥交给用户：存进 state 供展示 + 尽量复制到剪贴板。
   * 输入框是 password 型看不见内容，所以生成时必须把值显示出来，
   * 否则「把同样的值填进 Worker 环境变量」这一步没法做。
   * 剪贴板不可用时用户是从下方手抄的，所以展示的那份要和复制的一模一样。
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
    // 只报「生成了哪一个」。密钥本体只在这次面板打开期间存在于 state，前端不落盘，
    // 更不会进上报。
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

      // 没清干净的地方逐条说明白：这个按钮多半是在「云端数据已经出问题」时点的，
      // 含糊一句「部分失败」会让人不知道下一步该干嘛。
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
        // 老 Worker 上压根没有这张表，这一句同样成立：那边确实没清成，而下次排程会
        // 走回「凭据冻结进任务」的老路，也就无所谓残留。
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
   * 开关即时对话。直接落盘而不是走那条 1 秒去抖的自动保存：开关是一次明确的动作，
   * 点完立刻生效（下一条消息就按新路走），而不是「点完还得等一下」。
   */
  const handleToggleInstantChat = async () => {
    const next = !config?.instantChatEnabled;
    // 开了又关是这条路上最值钱的信号：能开、开过、然后放弃了，跟「压根没开」不是一回事。
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

  // 体检：探测结果 + 「这台设备订阅了没」这个只有前端知道的事实，红绿灯判定全在
  // amsgDiagnostics 那份纯函数里（那边有回归测试钉着）。
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
        {/* 体检。主动消息坏掉的那几种方式在界面上全是隐形的：D1 没绑、表结构是旧的、
            VAPID 没配、云端没登记收件设备——任务照建、面板照常，就是一条都不发。
            Worker 的 /debug 一直算得出这些，这里只是把它摆到看得见的地方。 */}
        {config.workerUrl?.trim() ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
            {/* 收着时那句「都正常 / 有问题」就是全部结论，逐项细节点开再看。 */}
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
                      {/* 正常的行不展开说明：全绿时这一列要短到能一眼扫完。 */}
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

        {/* 正常情况下两道双向门会拦住「两个都开」，能走到这儿全是脏配置遗留。
            脏配置照样会让聊天悄悄走 Instant，2.0 挂在本地那条路上的东西全静默失效——
            没有报错也没有提示，只会表现成「这功能怎么不响」，这张卡就是收拾它的入口。 */}
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

        {/* 已经填了 Worker 地址就说明后端装好了，这张卡收起来；重装走「清掉地址再回来」这条路。 */}
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
              // 只在展开时记一笔：收起也记的话同一个人会被数两次，漏斗第一格直接虚高一倍。
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
                {/* 三个出口合成一个事件带 target 枚举：它们是部署流程同一步的三条岔路，
                    拆成三个事件名只是多占清单行数，看漏斗时还得自己加回去。 */}
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
            部署还没收尾时这个按钮必须是点不动的：刚建好的 workers.dev 地址要过几十秒才在
            各个边缘节点上都解析得到，这期间点连接必然报「连不上 Worker」。一键部署那条路
            自己会等（waitForWorkerReady），等到了还会顺手把表建好——用户抢在前面点，
            收获的只有一次莫名其妙的失败。
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
                按钮常驻，但有更新时才抢眼：有新版就实心高亮并写明更新到哪一版，
                没新版时弱化成一行浅色的「重新检查并更新」——想手动重跑一次的人照样点得到，
                不用为了这个去别处找入口。
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

        {/* 即时对话：聊天本身也交给云端跑。四道门缺一不可，缺哪道就把哪道写出来——
            置灰而不说原因的话，用户只会反复点它。 */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">Instant Chat</span>
            {/* 开着但有门没过时不能只写「已开启」——那几道门是真的会让这一轮走本地生成的，
                标成绿色的「已开启」就是在骗人：用户以为聊天在云端跑，实际一直在本地。 */}
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
