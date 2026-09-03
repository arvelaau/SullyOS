
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { extractContent, safeResponseJson } from '../utils/safeApi';
import { extractModelIds, normalizeModelIds } from '../utils/modelList';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { bucketRetryCount, isAnalyticsConfigured, isAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../utils/analytics';
import Modal from '../components/os/Modal';
import { NotionManager, FeishuManager, RealtimeContextManager, fetchOwmWeather, fetchOpenMeteoWeather } from '../utils/realtimeContext';
import { XhsMcpClient } from '../utils/xhsMcpClient';
import { resolveXhsDeploymentMode } from '../utils/xhsMcpConfig';
import { getMcdToken, setMcdToken as saveMcdToken, isMcdEnabled, setMcdEnabled as saveMcdEnabled, testMcdConnection, resetMcdSession } from '../utils/mcdMcpClient';
import { getLuckinToken, setLuckinToken as saveLuckinToken, isLuckinEnabled, setLuckinEnabled as saveLuckinEnabled, testLuckinConnection, resetLuckinSession } from '../utils/luckinMcpClient';
import { consumeProxyWorkerSettingsFocus, getProxyWorkerUrl, setProxyWorkerUrl, DEFAULT_PROXY_WORKER } from '../utils/proxyWorker';
import { VOICE_ACTING_GUIDE } from '../utils/minimaxTts';
import { FISH_VOICE_ACTING_GUIDE } from '../utils/fishAudioTts';
import {
    DEFAULT_ELEVENLABS_MODEL,
    ELEVENLABS_MODEL_OPTIONS,
    getElevenLabsVoiceActingGuide,
} from '../utils/elevenLabsTts';
import { DATE_VOICE_GUIDE } from '../utils/datePrompts';
import { Sun, Newspaper, NotePencil, Notebook, Book, ForkKnife, Coffee, PlugsConnected } from '@phosphor-icons/react';
import { loadMcpServers, saveMcpServers, createMcpServer, testMcpConnection, resetMcpSession, getMcpUseNativeTools, setMcpUseNativeTools, type McpServerConfig } from '../utils/mcpClient';
import { loadPushConfig, savePushConfig, registerScheduleOnWorker, startHeartbeat, stopHeartbeat, isPushConfigAvailable, ensureSubscribed, sendTestPush, getPushDiagnostics, resetSubscription, deepResetSubscription, type PushDiagnostics } from '../utils/proactivePushConfig';
import { ProactiveChat } from '../utils/proactiveChat';
import { InstantPushSettingsModal } from '../components/settings/InstantPushSettingsModal';
import { PushVapidSettingsModal } from '../components/settings/PushVapidSettingsModal';
import PushSubscriptionPanel from '../components/settings/PushSubscriptionPanel';
import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { syncAmsgLlmCredentials, syncAmsgToolConfig, syncAmsgToolConfigAndPrompts } from '../utils/amsgStateSync';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import VersionInfo from '../components/settings/VersionInfo';
import { isPushVapidReady } from '../utils/pushVapid';
import ApiCallLogModal from '../components/settings/ApiCallLogModal';
import StorageUsagePanel from '../components/settings/StorageUsagePanel';
import McpConnectionConsole from '../components/settings/McpConnectionConsole';
import { DB } from '../utils/db';
import { getBackupReminderState, setBackupReminderIntervalDays, daysSinceLastBackup, BACKUP_REMINDER_MIN_DAYS, BACKUP_REMINDER_MAX_DAYS } from '../utils/backupReminder';
import {
    createAvatarModelBackup,
    getAvatarModelBackupInventory,
    restoreAvatarModelBackup,
    type AvatarModelBackupInventory,
    type AvatarModelBackupProgress,
} from '../utils/avatarModelBackup';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../utils/apiConfigNormalize';
import { configFromPreset, findActivePresetId, type PresetSwitchPatch } from '../utils/apiPresetSwitch';
import type { APIConfig, TtsProvider } from '../types';
import { describeImageWithVisionApi, VISION_API_TEST_IMAGE_DATA_URL, visionApiConfigFromPreset } from '../utils/visionApi';
import {
    FIRECRAWL_API_KEYS_URL,
    getFirecrawlApiKey,
    getFirecrawlCreditUsage,
    setFirecrawlApiKey,
    type FirecrawlCreditUsage,
} from '../utils/firecrawl';

// Optional hot-news platforms (news.orz.ai). key must exactly match the API's ?platform= param.
const HOTNEWS_PLATFORM_OPTIONS: { key: string; label: string }[] = [
    { key: 'weibo', label: 'Weibo' },
    { key: 'zhihu', label: 'Zhihu' },
    { key: 'baidu', label: 'Baidu' },
    { key: 'bilibili', label: 'Bilibili' },
    { key: 'douyin', label: 'Douyin' },
    { key: 'jinritoutiao', label: 'Toutiao' },
    { key: 'tieba', label: 'Baidu Tieba' },
    { key: 'hupu', label: 'Hupu' },
    { key: 'douban', label: 'Douban' },
    { key: 'tskr', label: '36Kr' },
    { key: 'juejin', label: 'Juejin' },
    { key: 'sspai', label: 'SSPai' },
    { key: 'vtex', label: 'V2EX' },
    { key: 'github', label: 'GitHub' },
    { key: 'hackernews', label: 'Hacker News' },
    { key: 'sina_finance', label: 'Sina Finance' },
    { key: 'eastmoney', label: 'East Money' },
    { key: 'xueqiu', label: 'Xueqiu' },
    { key: 'cls', label: 'CLS' },
    { key: 'tenxunwang', label: 'Tencent' },
];

// Entry-point toggle for the "Proactive Message Push Boost" panel. The underlying logic
// (heartbeat, subscription, diagnostics) is all kept — setting this to false just hides
// the entry point on the settings page; flip it back to true to restore it.
const SHOW_PROACTIVE_PUSH_ACCEL_UI = false;
// Firecrawl "Ark Plan": implementation, quota detection, and the scraping fallback chain
// are all kept, just not shown to users by default. Set to true to re-enable.
const SHOW_FIRECRAWL_ARK_UI = false;
const VISION_MODEL_LIST_STORAGE_KEY = 'os_vision_available_models';

const readStoredVisionModels = (): string[] => {
    try {
        return normalizeModelIds(JSON.parse(localStorage.getItem(VISION_MODEL_LIST_STORAGE_KEY) || '[]'));
    } catch {
        return [];
    }
};

const buildModelPickerView = (models: unknown[], filter: string) => {
    const q = filter.trim().toLowerCase();
    const safeModels = normalizeModelIds(models);
    const filtered = q ? safeModels.filter(model => model.toLowerCase().includes(q)) : safeModels;
    let commonPrefix = '';
    if (filtered.length >= 2) {
        let prefix = filtered[0];
        for (let index = 1; index < filtered.length; index += 1) {
            const candidate = filtered[index];
            let cursor = 0;
            while (cursor < prefix.length && cursor < candidate.length && prefix[cursor] === candidate[cursor]) cursor += 1;
            prefix = prefix.slice(0, cursor);
            if (!prefix) break;
        }
        const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('-'));
        if (cut > 3) prefix = prefix.slice(0, cut + 1);
        if (prefix.length >= 4) commonPrefix = prefix;
    }
    return { filtered, commonPrefix };
};

const DiagRow: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
    <div className="flex items-start justify-between gap-3">
        <span className="text-slate-500 shrink-0">{label}</span>
        <span className={`text-right ${bad ? 'text-rose-600 font-medium' : 'text-slate-700'}`}>{value}</span>
    </div>
);

// User-facing MCP tutorial (self-contained, written for users and their AI assistants to read).
// Statically deployed sites can't see the in-repo docs, so the help popup can only link to GitHub's blob page.
const MCP_USER_GUIDE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/mcp-user-guide.md';
const PROXY_WORKER_SOURCE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/worker/index.js';

const formatBackupBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
};

/**
 * Collapsible shell for a top-level settings section: collapsed by default, the title row
 * always shows and toggles on click; `actions` holds right-side controls (config button /
 * status chip / help icon) that don't trigger the toggle.
 */
const SettingsSection: React.FC<{
    icon: React.ReactNode;
    title: string;
    badge?: React.ReactNode;
    actions?: React.ReactNode;
    sectionProps?: Record<string, any>;
    children: React.ReactNode;
}> = ({ icon, title, badge, actions, sectionProps, children }) => {
    const [open, setOpen] = useState(false);
    return (
        <section {...sectionProps} className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    {icon}
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">{title}</h2>
                    {badge}
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
                {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            </div>
            {open && children}
        </section>
    );
};

let mcpToolConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMcpToolConfigSync: (() => void) | null = null;

const runMcpToolConfigSync = () => {
    const sync = pendingMcpToolConfigSync;
    mcpToolConfigSyncTimer = null;
    pendingMcpToolConfigSync = null;
    // Retry/bookkeeping for the upload itself lives in syncAmsgToolConfig (see amsgStateSync) — this just throttles.
    sync?.();
};

/**
 * The MCP card has no "Save" button — every keystroke would persist immediately, and
 * pushing to the cloud on every single change would turn each edit into its own request.
 * Batch changes for 800ms of inactivity before sending; further edits during that window push it back.
 */
const scheduleMcpToolConfigSync = (sync: () => void) => {
    pendingMcpToolConfigSync = sync;
    if (mcpToolConfigSyncTimer) clearTimeout(mcpToolConfigSyncTimer);
    mcpToolConfigSyncTimer = setTimeout(runMcpToolConfigSync, 800);
};

/** When closing the MCP settings, don't let that 800ms window keep dangling — flush any pending change immediately. */
const flushMcpToolConfigSync = () => {
    if (!mcpToolConfigSyncTimer) return;
    clearTimeout(mcpToolConfigSyncTimer);
    runMcpToolConfigSync();
};

/**
 * Legacy general-purpose MCP management card. Kept for a short migration window — the real
 * entry point has moved to the new MCP management panel. Config is stored in localStorage
 * (utils/mcpClient); servers that are enabled and have discovered tools get injected into
 * chat via function-calling, see docs/mcp-client.md.
 */
const McpServersCard: React.FC<{
    addToast: (msg: string, type?: any) => void;
    /** Server list or the "native tools" toggle changed → let the proactive-message side re-push the new config to the cloud */
    onMcpConfigChanged?: () => void;
}> = ({ addToast, onMcpConfigChanged }) => {
    const { characters, groups } = useOS();
    const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testStatus, setTestStatus] = useState<Record<string, string>>({});
    const [useNativeTools, setUseNativeToolsState] = useState<boolean>(() => getMcpUseNativeTools());

    const persist = (next: McpServerConfig[]) => {
        setServers(next);
        saveMcpServers(next);
        onMcpConfigChanged?.();
    };

    const update = (id: string, patch: Partial<McpServerConfig>) => {
        persist(servers.map(s => s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
        // URL / auth header / proxy changed — the old session can no longer be used
        if (patch.url !== undefined || patch.token !== undefined || patch.customHeaders !== undefined || patch.proxyUrl !== undefined || patch.proxyKey !== undefined) {
            resetMcpSession(id);
        }
    };

    const addServer = () => {
        const s = createMcpServer(`MCP Server ${servers.length + 1}`, '');
        persist([...servers, s]);
        setExpandedId(s.id);
    };

    const removeServer = (id: string) => {
        resetMcpSession(id);
        persist(servers.filter(s => s.id !== id));
    };

    const discover = async (server: McpServerConfig) => {
        if (!server.url.trim()) { addToast('Please fill in the server URL first', 'error'); return; }
        setTestingId(server.id);
        setTestStatus(prev => ({ ...prev, [server.id]: '' }));
        try {
            const r = await testMcpConnection(server);
            setTestStatus(prev => ({ ...prev, [server.id]: r.ok ? `✅ ${r.message}` : `❌ ${r.message}` }));
            // Only report the classified fixed enum for the failure reason — the raw error may contain the server address and response body, must not be sent out
            if (r.ok) {
                trackEvent('Test MCP Server Connection', { result: r.tools?.length ? 'connected' : 'connected-no-tools' });
            } else {
                const msg = r.message || '';
                // NOTE: these regexes match literal Chinese error text thrown by out-of-scope utils/mcpClient.ts —
                // do not translate them, translating would silently break failure-kind classification.
                const failureKind =
                    /超时/.test(msg) ? 'timeout'
                    : /鉴权失败/.test(msg) ? 'auth-failed'
                    : /请求失败/.test(msg) ? 'fetch-failed'
                    : /MCP HTTP/.test(msg) ? 'http-error'
                    : 'other';
                trackEvent('Test MCP Server Connection', { result: 'failed', failureKind });
            }
            if (r.ok && r.tools) {
                update(server.id, { tools: r.tools });
            }
        } finally {
            setTestingId(null);
        }
    };

    return (
        <div className="bg-violet-50/60 p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <PlugsConnected size={20} weight="fill" className="text-violet-600" />
                    <span className="text-sm font-bold text-violet-700">MCP Tool Server</span>
                    <span className="text-[9px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">Universal</span>
                </div>
                <button onClick={addServer} className="text-[11px] font-bold text-violet-600 bg-violet-100 px-2.5 py-1 rounded-lg active:scale-95 transition-transform">+ Add</button>
            </div>
            <p className="text-[10px] text-violet-700/70 leading-relaxed">
                Connect any standard MCP server (Streamable HTTP): fill in the URL → test connection → flip the switch, and the character can call these tools in chat.
                If the browser CORS policy blocks it, configure a "Proxy URL": run <code className="bg-violet-100/80 px-1 rounded">node scripts/mcp-proxy.mjs</code> locally, or deploy <code className="bg-violet-100/80 px-1 rounded">worker/mcp-proxy</code> to your own Cloudflare account. Config is stored locally only — see docs/mcp-client.md.
            </p>
            <div className="flex items-center justify-between gap-3 bg-white/70 border border-violet-100 rounded-xl px-3 py-2.5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <div className="text-xs font-bold text-slate-700">Native Tool Calling</div>
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] font-bold text-emerald-700">Recommended</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                        When on, sends standard tools calls — more stable, more reliable parameters. Only turn it off if the model or proxy explicitly doesn't support function calling, falling back to text-compatible mode.
                    </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" checked={useNativeTools} onChange={e => {
                        const next = e.target.checked;
                        setUseNativeToolsState(next);
                        setMcpUseNativeTools(next);
                        onMcpConfigChanged?.();
                        trackEvent('Toggle Native Tool Calling', { state: next ? 'on' : 'off' });
                    }} className="sr-only peer" />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                </label>
            </div>
            <div className="border-l-2 border-violet-300 pl-3 text-[10px] leading-relaxed text-violet-700/80">
                <p>
                    <b>In short:</b> tools / function calling is a chat model capability that lets the character tell the API "which tool to call, with what parameters" in a standard format so the system can actually execute it; when unsupported, the model may just write the tool call as ordinary chat text.
                </p>
                <p className="mt-1.5 text-violet-600/75">
                    Not sure if your model or proxy supports it? Ask whoever runs or sells your API whether it supports <b>tools / function calling</b>. Keep it on if unsure — only turn it off if they explicitly say it's unsupported, or requests start erroring on tools / function calling.
                </p>
            </div>
            {servers.map(server => (
                <div key={server.id} className="bg-white/70 border border-violet-100 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <button className="flex-1 text-left min-w-0" onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}>
                            <div className="text-xs font-bold text-slate-700 truncate">{server.name || '(Unnamed)'}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                                {server.url || 'URL not filled in'}{server.tools?.length ? ` · ${server.tools.length} tools` : ' · no tools fetched'}{server.charIds?.length ? ` · linked to ${server.charIds.length} chats` : ''}
                            </div>
                        </button>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                            <input type="checkbox" checked={server.enabled} onChange={e => {
                                if (e.target.checked && !(server.tools?.length)) {
                                    addToast('Click "Test Connection" first to get the tool list before enabling', 'error');
                                    trackEvent('Enable Untested MCP Server Blocked');
                                    return;
                                }
                                update(server.id, { enabled: e.target.checked });
                            }} className="sr-only peer" />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                        </label>
                    </div>
                    {expandedId === server.id && (
                        <div className="space-y-2 pt-1">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Name</label>
                                <input type="text" value={server.name} onChange={e => update(server.id, { name: e.target.value })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm" placeholder="e.g. Notion" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Server URL</label>
                                <input type="text" value={server.url} onChange={e => update(server.id, { url: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="https://mcp.example.com/mcp" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Bearer Token (optional)</label>
                                <input type="password" value={server.token || ''} onChange={e => update(server.id, { token: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Fill in if the server requires authentication" />
                            </div>
                            <div>
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Custom Request Headers (optional)</label>
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { customHeaders: [...(server.customHeaders || []), { name: '', value: '' }] })}
                                        className="text-[10px] font-bold text-violet-600"
                                    >+ Add Header</button>
                                </div>
                                {(server.customHeaders || []).map((header, index) => (
                                    <div key={index} className="flex gap-1.5 mb-1.5">
                                        <input
                                            type="text"
                                            value={header.name}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, name: e.target.value } : item) })}
                                            className="min-w-0 flex-[0.9] bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="XBY-APIKEY"
                                            aria-label={`Custom request header ${index + 1} name`}
                                        />
                                        <input
                                            type="password"
                                            value={header.value}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, value: e.target.value } : item) })}
                                            className="min-w-0 flex-1 bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="Header value"
                                            aria-label={`Custom request header ${index + 1} value`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => update(server.id, { customHeaders: (server.customHeaders || []).filter((_, i) => i !== index) })}
                                            className="w-9 shrink-0 rounded-xl bg-red-50 text-red-500 text-base"
                                            aria-label={`Delete custom request header ${index + 1}`}
                                        >×</button>
                                    </div>
                                ))}
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    For non-Bearer auth like X-API-Key, XBY-APIKEY, etc. — rows with an empty name or value won't be sent.
                                </p>
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Proxy URL (optional, leave empty = direct connection)</label>
                                <input type="text" value={server.proxyUrl || ''} onChange={e => update(server.id, { proxyUrl: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="http://localhost:18061 or your Worker address" />
                            </div>
                            {(server.proxyUrl || '').trim() && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Proxy Key (optional, the PROXY_KEY of a self-deployed Worker)</label>
                                    <input type="password" value={server.proxyKey || ''} onChange={e => update(server.id, { proxyKey: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Leave empty if not set" />
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Available Chats</label>
                                <div className="flex flex-wrap gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { charIds: [] })}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${!server.charIds?.length ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                    >Universal (all DMs and group chats)</button>
                                </div>
                                {characters.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">Characters</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {characters.map(c => {
                                        const bound = !!server.charIds?.includes(c.id);
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== c.id) : [...cur, c.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{c.name}</button>
                                        );
                                    })}
                                </div>
                                {groups.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">Group Chats</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {groups.map(group => {
                                        const bound = !!server.charIds?.includes(group.id);
                                        return (
                                            <button
                                                key={group.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== group.id) : [...cur, group.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{group.name}</button>
                                        );
                                    })}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                    Universal = usable by all DMs and group chats; once bound, only the selected characters or group chats can see this batch of tools.
                                </p>
                                {!!server.charIds?.length && server.charIds.some(id => !characters.some(c => c.id === id) && !groups.some(g => g.id === id)) && (
                                    <p className="text-[10px] text-amber-600 mt-1">
                                        ⚠️ Some bindings point to deleted characters or group chats — those bindings no longer take effect, re-select to clean them up.
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => discover(server)} disabled={testingId === server.id} className="flex-1 py-2 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                                    {testingId === server.id ? 'Testing…' : 'Test Connection'}
                                </button>
                                <button onClick={() => removeServer(server.id)} className="px-4 py-2 bg-red-50 text-red-500 text-xs font-bold rounded-xl active:scale-95 transition-transform">Delete</button>
                            </div>
                            {testStatus[server.id] && (
                                <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${testStatus[server.id].startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                                    {testStatus[server.id]}
                                </div>
                            )}
                            {!!server.tools?.length && (
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    Tools: {server.tools.map(t => t.name).join(', ')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            ))}
            <p className="text-[10px] text-violet-700/60 leading-relaxed bg-violet-100/40 rounded-lg px-2 py-1.5">
                Once MCP tools are on, chat switches to local tool requests (bypassing Instant Push), and that turn's thinking chain yields to the tool call; actions like posting, ordering, or deleting will still ask for your confirmation first. Tokens, custom headers, and config are stored locally; if a proxy is configured, requests are forwarded through it per your settings.
            </p>
        </div>
    );
};

const Settings: React.FC = () => {
  const {
      apiConfig, updateApiConfig, closeApp, availableModels, setAvailableModels,
      theme, updateTheme,
      exportSystem, importSystem, addToast, showError, resetSystem, updateCharacter,
      apiPresets, addApiPreset, updateApiPreset, removeApiPreset,
      sysOperation, // Get progress state
      realtimeConfig, updateRealtimeConfig, // Real-time Perception config
      // When tool credentials change, refresh the cloud prompts along with them (see syncAmsgToolConfigAndPrompts)
      characters, groups, userProfile,
      cloudBackupConfig, updateCloudBackupConfig,
      cloudBackupToWebDAV, cloudRestoreFromWebDAV, listCloudBackups,
  } = useOS();
  
  const [localKey, setLocalKey] = useState(apiConfig.apiKey);
  const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
  const [localModel, setLocalModel] = useState(String(apiConfig.model || ''));
  const [localStream, setLocalStream] = useState<boolean>(apiConfig.stream === true);
  const [localTemperature, setLocalTemperature] = useState<number>(
    typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85
  );
  const [localVisionEnabled, setLocalVisionEnabled] = useState(apiConfig.visionApi?.enabled === true);
  const [localVisionUrl, setLocalVisionUrl] = useState(apiConfig.visionApi?.baseUrl || '');
  const [localVisionKey, setLocalVisionKey] = useState(apiConfig.visionApi?.apiKey || '');
  const [localVisionModel, setLocalVisionModel] = useState(apiConfig.visionApi?.model || '');
  const [availableVisionModels, setAvailableVisionModels] = useState<string[]>(readStoredVisionModels);
  const [selectedVisionPresetId, setSelectedVisionPresetId] = useState<string | null>(null);
  const [visionStatusMsg, setVisionStatusMsg] = useState('');
  const [testingVisionApi, setTestingVisionApi] = useState(false);
  const [visionTestResult, setVisionTestResult] = useState<string | null>(null);
  const [localMiniMaxKey, setLocalMiniMaxKey] = useState(apiConfig.minimaxApiKey || '');
  const [localMiniMaxGroupId, setLocalMiniMaxGroupId] = useState(apiConfig.minimaxGroupId || '');
  const [localMiniMaxRegion, setLocalMiniMaxRegion] = useState<'domestic' | 'overseas'>(
    apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic'
  );
  const [localAceStepKey, setLocalAceStepKey] = useState(apiConfig.aceStepApiKey || '');
  const [localTtsProvider, setLocalTtsProvider] = useState<TtsProvider>(
    apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
      ? apiConfig.ttsProvider
      : 'minimax'
  );
  const [localFishKey, setLocalFishKey] = useState(apiConfig.fishAudioApiKey || '');
  const [localFishModel, setLocalFishModel] = useState(apiConfig.fishAudioModel || 's2.1-pro');
  const [localElevenLabsKey, setLocalElevenLabsKey] = useState(apiConfig.elevenLabsApiKey || '');
  const [localElevenLabsModel, setLocalElevenLabsModel] = useState(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
  const [localElevenLabsStability, setLocalElevenLabsStability] = useState(apiConfig.elevenLabsStability ?? 0.5);
  const [localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost] = useState(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
  const [localElevenLabsStyle, setLocalElevenLabsStyle] = useState(apiConfig.elevenLabsStyle ?? 0);
  const [localElevenLabsUseSpeakerBoost, setLocalElevenLabsUseSpeakerBoost] = useState(apiConfig.elevenLabsUseSpeakerBoost === true);
  // Custom voice-acting guide (empty → use the built-in default). Saved separately per provider.
  const [localVoicePromptMinimax, setLocalVoicePromptMinimax] = useState(apiConfig.voicePrompts?.minimax || '');
  const [localVoicePromptFish, setLocalVoicePromptFish] = useState(apiConfig.voicePrompts?.fishaudio || '');
  const [localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs] = useState(apiConfig.voicePrompts?.elevenlabs || '');
  const [localVoicePromptDate, setLocalVoicePromptDate] = useState(apiConfig.voicePrompts?.dateVoice || '');
  const [showVoicePrompts, setShowVoicePrompts] = useState(false);
  const [showAceStepGuide, setShowAceStepGuide] = useState(false);
  const [otherStatusMsg, setOtherStatusMsg] = useState('');
  // Advanced settings (streaming/temperature) collapsed by default — most users don't need to touch them
  const [showApiAdvanced, setShowApiAdvanced] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingVisionModels, setIsLoadingVisionModels] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  // Edit a preset in place: only changes the preset itself; if it happens to be the currently active one, the live config follows along too
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [editPresetUrl, setEditPresetUrl] = useState('');
  const [editPresetKey, setEditPresetKey] = useState('');
  const [editPresetModel, setEditPresetModel] = useState('');
  const [editPresetStream, setEditPresetStream] = useState(false);
  const [editPresetTemperature, setEditPresetTemperature] = useState(0.85);
  const [holdingDeletePresetId, setHoldingDeletePresetId] = useState<string | null>(null);
  const presetDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // UI States
  const [showModelModal, setShowModelModal] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [showVisionModelModal, setShowVisionModelModal] = useState(false);
  const [visionModelFilter, setVisionModelFilter] = useState('');
  const [showExportModal, setShowExportModal] = useState(false); // Used for completion now
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showApiCallLog, setShowApiCallLog] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpHelp, setShowMcpHelp] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [showCloudRestoreModal, setShowCloudRestoreModal] = useState(false);
  const [cloudBackupFiles, setCloudBackupFiles] = useState<import('../types').CloudBackupFile[]>([]);
  const [cloudBackupListState, setCloudBackupListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cloudBackupListError, setCloudBackupListError] = useState('');
  const [cloudTestResult, setCloudTestResult] = useState<string>('');
  const [cloudTesting, setCloudTesting] = useState(false);
  const [avatarModelInventory, setAvatarModelInventory] = useState<AvatarModelBackupInventory | null>(null);
  const [avatarModelBackupBusy, setAvatarModelBackupBusy] = useState(false);
  const [avatarModelBackupProgress, setAvatarModelBackupProgress] = useState<AvatarModelBackupProgress | null>(null);

  // "Time to back up" reminder frequency (1-30 days). Changes persist to localStorage immediately (the backupReminder module manages its own persistence).
  const [backupReminderDays, setBackupReminderDays] = useState<number>(() => getBackupReminderState().intervalDays);
  const backupDaysAgo = daysSinceLastBackup();
  const hasJournalAppearanceOverride = Boolean(
    theme.journalAppearance
    && ((theme.journalAppearance.preset || 'original') !== 'original'
      || theme.journalAppearance.customCss?.trim())
  );

  const handleJournalAppearanceEmergencyReset = async () => {
    await updateTheme({ journalAppearance: undefined });
    addToast('Restored the original Exchange Diary style from system settings', 'success');
  };

  // Cloud backup local config state (WebDAV)
  const [cbUrl, setCbUrl] = useState(cloudBackupConfig.webdavUrl);
  const [cbUsername, setCbUsername] = useState(cloudBackupConfig.username);
  const [cbPassword, setCbPassword] = useState(cloudBackupConfig.password);
  const [cbPath, setCbPath] = useState(cloudBackupConfig.remotePath || '/SullyBackup/');

  // GitHub local state
  const [ghToken, setGhToken] = useState(cloudBackupConfig.githubToken || '');
  const [ghRepo, setGhRepo] = useState(cloudBackupConfig.githubRepo || 'sully-backup');
  // Safe default: the old version used to have the proxy on by default. Old configs are now
  // all treated as not-yet-reconfirmed — the checkbox only stays checked if the user manually
  // enabled it under the new version's disclosure (consentVersion=1).
  const [ghUseProxy, setGhUseProxy] = useState(
      cloudBackupConfig.githubUseProxy === true && cloudBackupConfig.githubProxyConsentVersion === 1
  );
  const [ghShowAdvanced, setGhShowAdvanced] = useState(false);
  const [ghTesting, setGhTesting] = useState(false);
  const [ghTestResult, setGhTestResult] = useState<string>('');

  // Main proxy Worker address (web search / backup proxy / Notion / Feishu / McDonald's·Luckin MCP / web scraping / image generation all go through it).
  // The entry point is deliberately low-key: collapsed by default, most users never need to touch it, works out of the box.
  const [focusProxyConfigOnMount] = useState(() => consumeProxyWorkerSettingsFocus());
  const [proxyWorkerInput, setProxyWorkerInput] = useState(getProxyWorkerUrl());
  const [showProxyConfig, setShowProxyConfig] = useState(focusProxyConfigOnMount);
  const proxyConfigSectionRef = useRef<HTMLElement | null>(null);
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(() => isAnalyticsEnabled());
  const [firecrawlKeyInput, setFirecrawlKeyInput] = useState(getFirecrawlApiKey);
  const [firecrawlUsage, setFirecrawlUsage] = useState<FirecrawlCreditUsage | null>(null);
  const [firecrawlChecking, setFirecrawlChecking] = useState(false);
  const [firecrawlCheckResult, setFirecrawlCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
      if (!focusProxyConfigOnMount || !showProxyConfig) return;
      const frame = window.requestAnimationFrame(() => {
          proxyConfigSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return () => window.cancelAnimationFrame(frame);
  }, [focusProxyConfigOnMount, showProxyConfig]);

  // Check the balance every time the Real-time Perception panel opens — doesn't consume a scraping credit. Failure doesn't affect other config.
  useEffect(() => {
      if (!showRealtimeModal) return;
      const key = getFirecrawlApiKey();
      if (!key) return;
      let active = true;
      setFirecrawlChecking(true);
      getFirecrawlCreditUsage(key)
          .then(usage => {
              if (!active) return;
              setFirecrawlUsage(usage);
              setFirecrawlCheckResult({ ok: true, text: 'Firecrawl connected' });
          })
          .catch((error: any) => {
              if (!active) return;
              setFirecrawlUsage(null);
              setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl connection failed' });
          })
          .finally(() => { if (active) setFirecrawlChecking(false); });
      return () => { active = false; };
  }, [showRealtimeModal]);

  // Local state for Real-time Perception config
  const [rtWeatherEnabled, setRtWeatherEnabled] = useState(realtimeConfig.weatherEnabled);
  const [rtWeatherKey, setRtWeatherKey] = useState(realtimeConfig.weatherApiKey);
  const [rtWeatherCity, setRtWeatherCity] = useState(realtimeConfig.weatherCity);
  const [rtNewsEnabled, setRtNewsEnabled] = useState(realtimeConfig.newsEnabled);
  const [rtNewsApiKey, setRtNewsApiKey] = useState(realtimeConfig.newsApiKey || '');
  const [rtNewsPlatforms, setRtNewsPlatforms] = useState<string[]>(realtimeConfig.newsPlatforms || ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin']);
  const [rtNotionEnabled, setRtNotionEnabled] = useState(realtimeConfig.notionEnabled);
  const [rtNotionKey, setRtNotionKey] = useState(realtimeConfig.notionApiKey);
  const [rtNotionDbId, setRtNotionDbId] = useState(realtimeConfig.notionDatabaseId);
  const [rtNotionNotesDbId, setRtNotionNotesDbId] = useState(realtimeConfig.notionNotesDatabaseId || '');
  const [rtFeishuEnabled, setRtFeishuEnabled] = useState(realtimeConfig.feishuEnabled);
  const [rtFeishuAppId, setRtFeishuAppId] = useState(realtimeConfig.feishuAppId);
  const [rtFeishuAppSecret, setRtFeishuAppSecret] = useState(realtimeConfig.feishuAppSecret);
  const [rtFeishuBaseId, setRtFeishuBaseId] = useState(realtimeConfig.feishuBaseId);
  const [rtFeishuTableId, setRtFeishuTableId] = useState(realtimeConfig.feishuTableId);
  const [rtXhsEnabled, setRtXhsEnabled] = useState(realtimeConfig.xhsEnabled);
  // Lite mode uses the centrally-configured main proxy worker (/api is the XHSLite bridge in worker/index.js).
  // If the user changes the "Custom Network Proxy," Lite mode automatically switches to the new worker.
  const XHS_LITE_URL = `${getProxyWorkerUrl()}/api`;
  const XHS_RISK_TEXT = "Usage note: Lite connects to Xiaohongshu via its web interface — login may become invalid or features may be temporarily unavailable when the platform changes its rules. It's recommended to try it with a secondary account first, and confirm content before posting or interacting.";
  const XHS_COOKIE_GUIDE = [
    '[How to Get Your Xiaohongshu Cookie]',
    '1. Log into whichever site is actually assigned to you (www.xiaohongshu.com or www.rednote.com) using a desktop browser (Chrome/Edge)',
    '2. Press F12 to open Developer Tools, switch to the "Network" tab',
    '3. Refresh the page, click the topmost "explore" entry in the list (a document-type request, the main request sent to the current site)',
    '4. Switch to "Headers" on the right, scroll down to "Request Headers"',
    '5. Find the line starting with cookie: (a very long string)',
    '6. Copy the whole value after it: you can toggle "Raw" on the right side of Request Headers to see plain text for easier selecting, or right-click the value and Copy value, or select it and Ctrl+C',
    '7. Make sure this string contains the fields a1= and web_session= (the most important ones), then paste it into the "Xiaohongshu Lite" cookie box',
    'Lite automatically detects whether this cookie belongs to domestic Xiaohongshu or global RedNote — no need to manually add fields like gid or bRequestId that vary by site.',
    "Note: don't use document.cookie in the Console — it can't get web_session (httpOnly). Cookies expire after days to weeks; just copy a fresh one if it stops working.",
  ].join('\n');
  const _xhsCfgUrl = realtimeConfig.xhsMcpConfig?.serverUrl || '';
  // Deployment mode and protocol are saved separately: both local Skills and cloud Lite use /api, so it can no longer be determined by path alone.
  const _xhsStoredMode = resolveXhsDeploymentMode(realtimeConfig.xhsMcpConfig, XHS_LITE_URL);
  const _xhsIsLocal = _xhsStoredMode === 'local';
  const [rtXhsMcpEnabled, setRtXhsMcpEnabled] = useState(realtimeConfig.xhsMcpConfig?.enabled || false);
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local'>(_xhsIsLocal ? 'local' : 'lite');
  const [rtXhsLocalUrl, setRtXhsLocalUrl] = useState(_xhsIsLocal ? _xhsCfgUrl : 'http://localhost:18060/mcp');
  const [rtXhsNickname, setRtXhsNickname] = useState(realtimeConfig.xhsMcpConfig?.loggedInNickname || '');
  const [rtXhsUserId, setRtXhsUserId] = useState(realtimeConfig.xhsMcpConfig?.loggedInUserId || '');
  const [rtXhsCookie, setRtXhsCookie] = useState(realtimeConfig.xhsMcpConfig?.cookie || '');
  const [rtXhsPlatform, setRtXhsPlatform] = useState<'xhs' | 'rednote' | undefined>(realtimeConfig.xhsMcpConfig?.platform);
  const [rtXhsGuideOpen, setRtXhsGuideOpen] = useState(false);
  const [rtTestStatus, setRtTestStatus] = useState('');

  // McDonald's MCP (token / enabled state are both stored directly in localStorage, not in realtimeConfig)
  const [mcdToken, setMcdTokenState] = useState(() => getMcdToken());
  const [mcdEnabled, setMcdEnabledState] = useState(() => isMcdEnabled());
  const [mcdTestStatus, setMcdTestStatus] = useState('');
  const [mcdTesting, setMcdTesting] = useState(false);

  // Luckin MCP (structured the same as McDonald's)
  const [luckinToken, setLuckinTokenState] = useState(() => getLuckinToken());
  const [luckinEnabled, setLuckinEnabledState] = useState(() => isLuckinEnabled());
  const [luckinTestStatus, setLuckinTestStatus] = useState('');
  const [luckinTesting, setLuckinTesting] = useState(false);

  // Proactive Push accelerator (Worker URL / VAPID public key are hardcoded as constants in proactivePushConfig.ts)
  const initialPushCfg = loadPushConfig();
  const ppAvailable = isPushConfigAvailable();
  const [ppEnabled, setPpEnabled] = useState(initialPushCfg.enabled);
  const [ppStatus, setPpStatus] = useState<string>('');
  const [ppBusy, setPpBusy] = useState(false);
  const [showPpConfirm, setShowPpConfirm] = useState(false);
  const [ppDiag, setPpDiag] = useState<PushDiagnostics | null>(null);
  const [ppTestBusy, setPpTestBusy] = useState(false);
  const [ppResetBusy, setPpResetBusy] = useState(false);
  const [ppDeepResetBusy, setPpDeepResetBusy] = useState(false);
  // Consecutive zombie-reset failure count — once it reaches >= 3, the "Reset Subscription" button
  // automatically morphs into "Deep Reset". Not persisted, resets to zero on page refresh (per the user's
  // own words: "goes away normally on page refresh").
  const [ppZombieStreak, setPpZombieStreak] = useState(0);
  const [showInstantModal, setShowInstantModal] = useState(false);
  const [showAmsg2Modal, setShowAmsg2Modal] = useState(false);
  const [showVapidModal, setShowVapidModal] = useState(false);
  const [vapidReadyTick, setVapidReadyTick] = useState(0); // Refresh the top-level badge after closing the VAPID modal

  // Model-picker modal filtering + common prefix (memoized to avoid recomputing on every Settings re-render)
  const modelPickerView = useMemo(
      () => buildModelPickerView(availableModels, modelFilter),
      [modelFilter, availableModels],
  );
  const visionModelPickerView = useMemo(
      () => buildModelPickerView(availableVisionModels, visionModelFilter),
      [visionModelFilter, availableVisionModels],
  );

  const refreshPpDiag = useCallback(async () => {
      try { setPpDiag(await getPushDiagnostics()); } catch { /* ignore */ }
  }, []);

  const doEnablePushAccelerator = async () => {
      if (ppBusy) return;
      setPpBusy(true);
      setPpStatus('Connecting to Worker…');
      try {
          const res = await fetch(`${initialPushCfg.workerUrl}/health`);
          if (!res.ok) {
              trackEvent('Enable Proactive Message Push Boost', { result: 'fail', failStage: 'worker_health' });
              trackEvent('Push Booster Enable Result', { result: 'worker-unreachable' });
              setPpStatus(`Failed: Worker HTTP ${res.status}`); setPpBusy(false); return;
          }
      } catch (e: any) {
          trackEvent('Enable Proactive Message Push Boost', { result: 'fail', failStage: 'network' });
          trackEvent('Push Booster Enable Result', { result: 'worker-unreachable' });
          setPpStatus(`Failed: ${e?.message || 'network error'}`); setPpBusy(false); return;
      }

      // Step 1: ensure permission + subscription up front, regardless of schedules.
      // This is the fix for the old bug where toggle "succeeded" without ever
      // requesting permission when the user hadn't enabled any character timer yet.
      setPpStatus('Requesting notification permission and creating subscription…');
      const sub = await ensureSubscribed();
      if (!sub.ok) {
          trackEvent('Enable Proactive Message Push Boost', { result: 'fail', failStage: 'subscribe' });
          trackEvent('Push Booster Enable Result', { result: 'subscribe-failed' });
          setPpStatus(`Failed: ${sub.reason || 'subscription creation failed'}`);
          setPpBusy(false);
          await refreshPpDiag();
          return;
      }

      // Step 2: persist enabled flag and start heartbeat.
      savePushConfig(true);
      setPpEnabled(true);
      startHeartbeat();

      // Step 3: register any existing per-character schedules.
      const schedules = ProactiveChat.getSchedules();
      let okCount = 0;
      for (const s of schedules) {
          if (await registerScheduleOnWorker(s.charId, s.intervalMs)) okCount++;
      }

      if (schedules.length === 0) {
          trackEvent('Enable Proactive Message Push Boost', { result: 'success' });
          trackEvent('Push Booster Enable Result', { result: 'ok-no-schedule' });
          setPpStatus('Enabled (subscription established. No proactive-message schedules yet — one will register automatically next time a character has proactive messages turned on)');
      } else if (okCount < schedules.length) {
          trackEvent('Enable Proactive Message Push Boost', { result: 'partial' });
          trackEvent('Push Booster Enable Result', { result: 'ok-partial-schedule' });
          setPpStatus(`Enabled: ${okCount}/${schedules.length} schedules registered successfully`);
      } else {
          trackEvent('Enable Proactive Message Push Boost', { result: 'success' });
          trackEvent('Push Booster Enable Result', { result: 'ok' });
          setPpStatus(`Enabled, ${okCount} proactive-message schedules registered`);
      }
      setPpBusy(false);
      await refreshPpDiag();
  };

  const doDisablePushAccelerator = async () => {
      trackEvent('Disable Proactive Message Push Boost');
      savePushConfig(false);
      setPpEnabled(false);
      stopHeartbeat();
      setPpStatus('Disabled (proactive messages fall back to the local timer)');
      await refreshPpDiag();
  };

  const doSendTestPush = async () => {
      if (ppTestBusy) return;
      setPpTestBusy(true);
      setPpStatus('Asking the Worker to send a test push…');
      const res = await sendTestPush();
      if (res.ok) {
          trackEvent('Send Test Push (Proactive Message Boost)', { result: 'sent' });
          trackEvent('Send a Test Push', { result: 'sent' });
          setPpStatus('Test push sent. If "Push test succeeded" does not show up in system notifications within 5 seconds, something is wrong with delivery — check the diagnostics panel below.');
      } else if (res.deadSubscription) {
          trackEvent('Send Test Push (Proactive Message Boost)', { result: 'dead_subscription' });
          trackEvent('Send a Test Push', { result: 'dead-subscription' });
          setPpStatus('The subscription was revoked by the browser (zombie endpoint). Click "Reset Subscription" below to rebuild it, then test again.');
      } else {
          trackEvent('Send Test Push (Proactive Message Boost)', { result: 'fail' });
          trackEvent('Send a Test Push', { result: 'failed' });
          setPpStatus(`Test failed: ${res.reason || 'unknown error'}${res.status ? ` (HTTP ${res.status})` : ''}`);
      }
      setPpTestBusy(false);
      await refreshPpDiag();
  };

  const doResetSubscription = async () => {
      if (ppResetBusy || ppDeepResetBusy) return;
      setPpResetBusy(true);
      setPpStatus('Resetting subscription…');
      const res = await resetSubscription();
      if (res.ok) {
          trackEvent('Reset Push Subscription', { result: 'success', attempt: bucketRetryCount(ppZombieStreak) });
          setPpZombieStreak(0);
          setPpStatus('Subscription rebuilt. You can try "Send a Test Push" again.');
      } else {
          const reason = res.reason || '';
          // Accumulate when the failure reason points to a zombie endpoint; after 3 times the button auto-morphs into Deep Reset
          if (/permanently-removed|zombie/i.test(reason)) {
              setPpZombieStreak(c => c + 1);
          }
          // Only report the classified fixed enum, never a word of the raw failure text; retry count is likewise bucketed first
          trackEvent('Reset Push Subscription', {
              result: /permanently-removed|zombie/i.test(reason) ? 'fail_zombie' : 'fail_other',
              attempt: bucketRetryCount(ppZombieStreak),
          });
          setPpStatus(`Reset failed: ${reason || 'unknown error'}`);
      }
      setPpResetBusy(false);
      await refreshPpDiag();
  };

  const doDeepResetSubscription = async () => {
      if (ppDeepResetBusy || ppResetBusy) return;
      setPpDeepResetBusy(true);
      setPpStatus('Deep resetting…');
      const res = await deepResetSubscription();
      // Whether it succeeds or fails, the button always reverts to "Reset Subscription" — the morph triggers again next time the count builds back up
      setPpZombieStreak(0);
      if (res.ok) {
          // ProactiveChat.resume() pushes all schedules back to the new SW. deepResetSubscription doesn't
          // call it internally, to avoid a circular dependency (ProactiveChat depends back on proactivePushConfig).
          try { ProactiveChat.resume(); } catch (e) { console.warn('[Settings] ProactiveChat.resume failed', e); }
          trackEvent('Deep Reset Push Subscription', { result: 'success' });
          setPpStatus('Subscription rebuilt. You can try "Send a Test Push" again.');
      } else {
          trackEvent('Deep Reset Push Subscription', { result: 'fail' });
          setPpStatus(`Deep reset failed: ${res.reason || 'unknown error'}`);
      }
      setPpDeepResetBusy(false);
      await refreshPpDiag();
  };

  // Refresh diagnostics whenever the panel is mounted or the toggle changes.
  useEffect(() => {
      void refreshPpDiag();
  }, [refreshPpDiag, ppEnabled]);

  // For web download link
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  const [downloadFileName, setDownloadFileName] = useState('Sully_Backup.zip');
  // Track the current object URL with a ref so closing the modal / re-exporting / unmounting can
  // always revoke the latest one, unaffected by stale state closures.
  const downloadUrlRef = useRef<string>('');
  const revokeDownloadUrl = useCallback(() => {
      if (downloadUrlRef.current) {
          URL.revokeObjectURL(downloadUrlRef.current);
          downloadUrlRef.current = '';
      }
      setDownloadUrl('');
  }, []);
  useEffect(() => () => {
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  const [statusMsg, setStatusMsg] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [testApiResult, setTestApiResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const avatarModelBackupInputRef = useRef<HTMLInputElement>(null);
  const refreshAvatarModelInventory = useCallback(async () => {
      try {
          setAvatarModelInventory(await getAvatarModelBackupInventory());
      } catch (error) {
          console.warn('[Settings] Failed to read model backup inventory', error);
      }
  }, []);
  useEffect(() => { void refreshAvatarModelInventory(); }, [refreshAvatarModelInventory]);

  // Sync the saved config into these input fields above.
  //
  // Each of the three sections (main API / vision / other) syncs its own, with dependencies
  // pinned to specific field values — the dependency **must not** be the whole apiConfig object:
  // updateApiConfig returns a new object every time, so clicking save in the vision section would
  // silently flush the main API section's not-yet-saved inputs back to their old values, with no
  // visible indication in the UI.
  useEffect(() => {
      setLocalUrl(apiConfig.baseUrl);
      setLocalKey(apiConfig.apiKey);
      setLocalModel(String(apiConfig.model || ''));
      setLocalStream(apiConfig.stream === true);
      setLocalTemperature(typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85);
  }, [apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model, apiConfig.stream, apiConfig.temperature]);

  useEffect(() => {
      setLocalVisionEnabled(apiConfig.visionApi?.enabled === true);
      setLocalVisionUrl(apiConfig.visionApi?.baseUrl || '');
      setLocalVisionKey(apiConfig.visionApi?.apiKey || '');
      setLocalVisionModel(apiConfig.visionApi?.model || '');
  }, [apiConfig.visionApi?.enabled, apiConfig.visionApi?.baseUrl, apiConfig.visionApi?.apiKey, apiConfig.visionApi?.model]);

  useEffect(() => {
      setLocalMiniMaxKey(apiConfig.minimaxApiKey || '');
      setLocalMiniMaxGroupId(apiConfig.minimaxGroupId || '');
      setLocalMiniMaxRegion(apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic');
      setLocalAceStepKey(apiConfig.aceStepApiKey || '');
      setLocalTtsProvider(
          apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
              ? apiConfig.ttsProvider
              : 'minimax'
      );
      setLocalFishKey(apiConfig.fishAudioApiKey || '');
      setLocalFishModel(apiConfig.fishAudioModel || 's2.1-pro');
      setLocalElevenLabsKey(apiConfig.elevenLabsApiKey || '');
      setLocalElevenLabsModel(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
      setLocalElevenLabsStability(apiConfig.elevenLabsStability ?? 0.5);
      setLocalElevenLabsSimilarityBoost(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
      setLocalElevenLabsStyle(apiConfig.elevenLabsStyle ?? 0);
      setLocalElevenLabsUseSpeakerBoost(apiConfig.elevenLabsUseSpeakerBoost === true);
      setLocalVoicePromptMinimax(apiConfig.voicePrompts?.minimax || '');
      setLocalVoicePromptFish(apiConfig.voicePrompts?.fishaudio || '');
      setLocalVoicePromptElevenLabs(apiConfig.voicePrompts?.elevenlabs || '');
      setLocalVoicePromptDate(apiConfig.voicePrompts?.dateVoice || '');
  }, [
      apiConfig.minimaxApiKey, apiConfig.minimaxGroupId, apiConfig.minimaxRegion, apiConfig.aceStepApiKey,
      apiConfig.ttsProvider, apiConfig.fishAudioApiKey, apiConfig.fishAudioModel,
      apiConfig.elevenLabsApiKey, apiConfig.elevenLabsModel, apiConfig.elevenLabsStability,
      apiConfig.elevenLabsSimilarityBoost, apiConfig.elevenLabsStyle, apiConfig.elevenLabsUseSpeakerBoost,
      apiConfig.voicePrompts?.minimax, apiConfig.voicePrompts?.fishaudio,
      apiConfig.voicePrompts?.elevenlabs, apiConfig.voicePrompts?.dateVoice,
  ]);

  // Which preset is currently active — derived by looking up the saved config, no extra state tracked.
  // That way, after a refresh, manual URL edit, or backup import, "In Use" on screen always matches where requests actually go.
  const activePresetId = useMemo(
      () => findActivePresetId(apiPresets, apiConfig),
      [apiPresets, apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model],
  );

  /**
   * Actually switches over to a given config. The Save button and clicking a preset take the same
   * path — besides writing the global config, it also swaps the credentials for already-scheduled
   * proactive messages, otherwise the chat switches but the background job keeps firing requests with the old key.
   */
  const commitApiConfig = (patch: PresetSwitchPatch | Partial<APIConfig>) => {
    updateApiConfig(patch);
    // On a Worker that supports the credential-reference table, tasks only carry a reference, so
    // swapping the key just means overwriting those few cloud rows — no need to edit tasks one by one.
    // On an older Worker this call is a no-op; credentials there still rely on the old per-task refresh path below.
    syncAmsgLlmCredentials({ ...apiConfig, ...patch });
    // Scheduled Proactive Message 2.0 AI tasks freeze the credentials as of the moment they were scheduled —
    // if they aren't re-pushed after changing the key/model, they'll all fire with the old credentials once due
    // (a whole chain of 401s the moment the old key is revoked). Best-effort: the save itself doesn't wait on
    // this, failures are only surfaced as a toast; it's a no-op when 2.0 isn't configured or there are no
    // pending AI tasks. Legacy inline tasks still rely on this, so it still runs for users on the reference
    // path too (tasks that carry credRefs only look at the reference once due, so this refresh is a harmless
    // no-op for them).
    void ActiveMsgClient.refreshApiCredentialsForPendingTasks({ ...apiConfig, ...patch })
      .then((result) => {
        if (result.status === 'partial') {
          addToast(`API saved, but ${result.failed} scheduled proactive message(s) did not get the new credentials — try saving again later.`, 'error');
        }
      })
      .catch((error) => {
        console.warn('[Settings] Failed to refresh API credentials for scheduled tasks', error);
        addToast('API saved, but refreshing credentials for scheduled proactive messages failed — try saving again later.', 'error');
      });
  };

  /**
   * Clicking a preset = switch to it and apply immediately, no "loaded but not yet saved"
   * intermediate state. The input fields above catch up on their own via the apiConfig sync
   * effect, not set manually here. MiniMax / AceStep etc. aren't managed by presets: a person
   * usually has only one voice account, switching LLM shouldn't touch it.
   */
  const applyPreset = (preset: typeof apiPresets[0]) => {
      // Re-apply even if already active: "In Use" only looks at the URL/Key/Model trio, while
      // temperature/streaming may have been manually tweaked — clicking again means "revert the
      // whole thing to exactly what this preset has saved."
      commitApiConfig(configFromPreset(preset));
      addToast(`Switched to "${preset.name}", now in effect`, 'success');
  };

  const openEditPreset = (preset: typeof apiPresets[0]) => {
      cancelPresetDeleteHold();
      const isActive = activePresetId === preset.id;
      setEditingPresetId(preset.id);
      setEditPresetName(preset.name);
      setEditPresetUrl(preset.config.baseUrl || '');
      setEditPresetKey(preset.config.apiKey || '');
      setEditPresetModel(preset.config.model || '');
      // The currently active preset should pick up advanced settings just changed in the main form:
      // the user can click the pencil then save to write it back, without having to guess they need
      // to press "Fill in from current config" separately. A non-active/old preset reads its own values, falling back only for missing fields.
      setEditPresetStream(
          isActive ? localStream : (typeof preset.config.stream === 'boolean' ? preset.config.stream : localStream),
      );
      setEditPresetTemperature(
          isActive
              ? localTemperature
              : (typeof preset.config.temperature === 'number' ? preset.config.temperature : localTemperature),
      );
  };

  const handleUpdatePreset = () => {
      const preset = apiPresets.find(item => item.id === editingPresetId);
      if (!preset) return;
      const name = editPresetName.trim();
      if (!name) {
          addToast('Preset name cannot be empty', 'error');
          return;
      }
      const nextConfig = {
          ...preset.config,
          baseUrl: normalizeApiBaseUrl(editPresetUrl),
          apiKey: normalizeApiCredential(editPresetKey),
          model: normalizeApiModel(editPresetModel),
          stream: editPresetStream,
          temperature: editPresetTemperature,
      };
      // "Is this the one currently in use" must be checked before the change — once the values are updated it can no longer be compared
      const wasActive = activePresetId === preset.id;
      updateApiPreset(preset.id, name, nextConfig);
      // If the one just edited happens to be the currently active one → the live config follows along, otherwise the UI would show a new key while requests still use the old one
      if (wasActive) commitApiConfig(configFromPreset({ ...preset, name, config: nextConfig }));
      setEditingPresetId(null);
      addToast(wasActive ? `"${name}" updated, now in effect` : `"${name}" updated`, 'success');
  };

  const cancelPresetDeleteHold = useCallback(() => {
      if (presetDeleteTimerRef.current) {
          clearTimeout(presetDeleteTimerRef.current);
          presetDeleteTimerRef.current = null;
      }
      setHoldingDeletePresetId(null);
  }, []);

  useEffect(() => () => {
      if (presetDeleteTimerRef.current) clearTimeout(presetDeleteTimerRef.current);
  }, []);

  // Deleting a preset just tosses out that "save card" — the currently active config is a copy, unaffected.
  const deleteApiPreset = (id: string, name: string) => {
      cancelPresetDeleteHold();
      removeApiPreset(id);
      setEditingPresetId(current => (current === id ? null : current));
      addToast(`Preset deleted: ${name}`, 'success');
  };

  const beginPresetDeleteHold = (id: string, name: string) => {
      cancelPresetDeleteHold();
      setHoldingDeletePresetId(id);
      presetDeleteTimerRef.current = setTimeout(() => {
          presetDeleteTimerRef.current = null;
          setHoldingDeletePresetId(null);
          removeApiPreset(id);
          setEditingPresetId(current => (current === id ? null : current));
          addToast(`Preset deleted: ${name}`, 'success');
      }, 700);
  };

  const handleSavePreset = () => {
      if (!newPresetName.trim()) {
          addToast('Please enter a preset name', 'error');
          return;
      }
      addApiPreset(newPresetName, {
        baseUrl: normalizeApiBaseUrl(localUrl),
        apiKey: normalizeApiCredential(localKey),
        model: normalizeApiModel(localModel),
        stream: localStream,
        temperature: localTemperature,
      });
      setNewPresetName('');
      setShowPresetModal(false);
      addToast('Preset saved', 'success');
  };

  /**
   * Saving this form below = change "the currently active config", it will **not** also
   * overwrite any preset. To save the change back into a preset, use the pencil in the preset
   * row (the popup has a one-click "fill in from current config").
   */
  const handleSaveApi = () => {
    const nextConfig = {
      apiKey: normalizeApiCredential(localKey),
      baseUrl: normalizeApiBaseUrl(localUrl),
      model: normalizeApiModel(localModel),
      stream: localStream,
      temperature: localTemperature,
    };
    setLocalKey(nextConfig.apiKey);
    setLocalUrl(nextConfig.baseUrl);
    setLocalModel(nextConfig.model);
    commitApiConfig(nextConfig);
    setStatusMsg('Configuration saved');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const handleSaveVisionApi = () => {
    const nextVisionApi = {
      enabled: localVisionEnabled,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (nextVisionApi.enabled && (!nextVisionApi.baseUrl || !nextVisionApi.apiKey || !nextVisionApi.model)) {
      addToast('Before enabling the Image Recognition API, please fill in the URL, Key, and Model completely', 'error');
      return;
    }
    setLocalVisionUrl(nextVisionApi.baseUrl);
    setLocalVisionKey(nextVisionApi.apiKey);
    setLocalVisionModel(nextVisionApi.model);
    updateApiConfig({ visionApi: nextVisionApi });
    setVisionStatusMsg(nextVisionApi.enabled ? 'Image Recognition API connected' : 'Disabled, falling back to the original image-recognition method');
    setTimeout(() => setVisionStatusMsg(''), 2200);
  };

  const loadVisionApiPreset = (preset: typeof apiPresets[0]) => {
    const next = visionApiConfigFromPreset(preset);
    setSelectedVisionPresetId(preset.id);
    setLocalVisionEnabled(true);
    setLocalVisionUrl(next.baseUrl);
    setLocalVisionKey(next.apiKey);
    setLocalVisionModel(next.model);
    setVisionTestResult(null);
    setVisionStatusMsg(`Loaded preset: ${preset.name}`);
    setTimeout(() => setVisionStatusMsg(''), 2200);
    addToast(`Filled the Image Recognition API in from "${preset.name}"; takes effect after saving`, 'info');
  };

  const fetchVisionModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localVisionUrl);
    const apiKey = normalizeApiCredential(localVisionKey);
    if (!baseUrl) { setVisionStatusMsg('Please fill in the vision URL first'); return; }
    setIsLoadingVisionModels(true);
    setVisionStatusMsg('Fetching vision models...');
    setVisionTestResult(null);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = extractModelIds(await safeResponseJson(response));
      if (models.length === 0) {
        setVisionStatusMsg('Model list is empty or in an unsupported format');
        return;
      }
      setAvailableVisionModels(models);
      try { localStorage.setItem(VISION_MODEL_LIST_STORAGE_KEY, JSON.stringify(models)); } catch { /* ignore */ }
      if (!models.includes(normalizeApiModel(localVisionModel))) {
        setLocalVisionModel(models[0]);
        setSelectedVisionPresetId(null);
      }
      setVisionStatusMsg(`Found ${models.length} vision models`);
      setVisionModelFilter('');
      setShowVisionModelModal(true);
    } catch (error: any) {
      console.error('Fetch Vision Models Error', error);
      setVisionStatusMsg(`Fetch failed${error?.message ? `: ${error.message}` : ''}`);
    } finally {
      setIsLoadingVisionModels(false);
    }
  };

  const handleTestVisionApi = async () => {
    const config = {
      enabled: true,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (!config.baseUrl || !config.apiKey || !config.model) {
      setVisionTestResult('❌ Please fill in the URL, Key, and Model completely first');
      return;
    }
    setTestingVisionApi(true);
    setVisionTestResult(null);
    try {
      const description = await describeImageWithVisionApi(VISION_API_TEST_IMAGE_DATA_URL, config);
      setVisionTestResult(`✅ Image recognition succeeded — ${description.slice(0, 80)}`);
      trackEvent('Test Image Recognition API', { result: 'success' });
    } catch (error: any) {
      console.error('Test Vision API Error', error);
      setVisionTestResult(`❌ Image recognition failed: ${error?.message || 'unknown error'}`);
      trackEvent('Test Image Recognition API', { result: 'failed' });
    } finally {
      setTestingVisionApi(false);
    }
  };

  const buildOtherApiConfig = (overrides: Partial<APIConfig> = {}): Partial<APIConfig> => ({
      minimaxApiKey: localMiniMaxKey,
      minimaxGroupId: localMiniMaxGroupId,
      minimaxRegion: localMiniMaxRegion,
      aceStepApiKey: localAceStepKey,
      ttsProvider: localTtsProvider,
      fishAudioApiKey: localFishKey,
      fishAudioModel: localFishModel,
      elevenLabsApiKey: localElevenLabsKey,
      elevenLabsModel: localElevenLabsModel,
      elevenLabsStability: localElevenLabsStability,
      elevenLabsSimilarityBoost: localElevenLabsSimilarityBoost,
      elevenLabsStyle: localElevenLabsStyle,
      elevenLabsUseSpeakerBoost: localElevenLabsUseSpeakerBoost,
      voicePrompts: {
        minimax: localVoicePromptMinimax.trim() ? localVoicePromptMinimax : undefined,
        fishaudio: localVoicePromptFish.trim() ? localVoicePromptFish : undefined,
        elevenlabs: localVoicePromptElevenLabs.trim() ? localVoicePromptElevenLabs : undefined,
        dateVoice: localVoicePromptDate.trim() ? localVoicePromptDate : undefined,
      },
      ...overrides,
  });

  const handleSaveOtherApis = () => {
    updateApiConfig(buildOtherApiConfig());
    setOtherStatusMsg('Saved');
    setTimeout(() => setOtherStatusMsg(''), 2000);
  };

  // Picking "who does voice generation" persists immediately — no need to click Save below.
  // Submitted together with the current "Other APIs" draft (same payload as the Save button):
  // partly to take effect immediately, partly to avoid the [apiConfig] sync effect flushing away a
  // just-typed, not-yet-saved key draft.
  const selectTtsProvider = (provider: TtsProvider) => {
    setLocalTtsProvider(provider);
    updateApiConfig(buildOtherApiConfig({ ttsProvider: provider }));
    const providerLabel = provider === 'fishaudio' ? 'Fish Audio' : provider === 'elevenlabs' ? 'ElevenLabs' : 'MiniMax';
    addToast(`Voice generation switched to ${providerLabel}`, 'success');
  };

  // Picking a Fish Audio model: persists immediately (same as above, submitted together with the draft to avoid being flushed by the sync effect).
  const selectFishModel = (model: string) => {
    setLocalFishModel(model);
    updateApiConfig(buildOtherApiConfig({ fishAudioModel: model }));
  };

  // The ElevenLabs model changes which voice tags are available, so like the Fish Audio model it persists immediately too.
  const selectElevenLabsModel = (model: string) => {
    setLocalElevenLabsModel(model);
    updateApiConfig(buildOtherApiConfig({ elevenLabsModel: model }));
  };

  const fetchModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localUrl);
    const apiKey = normalizeApiCredential(localKey);
    if (!baseUrl) { setStatusMsg('Please fill in the URL first'); return; }
    setIsLoadingModels(true);
    setStatusMsg('Connecting...');
    try {
        const response = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await safeResponseJson(response);
        // Support common OpenAI-compatible and nested gateway response formats.
        const models = extractModelIds(data);
        if (models.length > 0) {
            setAvailableModels(models);
            if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
            setStatusMsg(`Found ${models.length} models`);
            setShowModelModal(true); // Open selector immediately
        } else { setStatusMsg('Model list is empty or in an unsupported format'); }
    } catch (error: any) {
        console.error(error);
        setStatusMsg(`Connection failed${error?.message ? `: ${error.message}` : ''}`);
    } finally {
        setIsLoadingModels(false);
    }
  };

  // One-click cleanup of "ghost emoji pack" leftovers: dry-run scan first, only actually delete after confirming in the popup.
  // How the leftovers happen: older versions didn't cascade-clean emoji categories when deleting a
  // character, so per-character categories only visible to an already-deleted character get stuck
  // in the database — invisible (and undeletable) in the single-chat panel, yet still visible in the group-chat panel.
  const [isCleaningResidue, setIsCleaningResidue] = useState(false);
  const handleCleanupResidue = async () => {
      if (isCleaningResidue) return;
      setIsCleaningResidue(true);
      try {
          const validIds = (await DB.getAllCharacters()).map(c => c.id);
          const scan = await DB.cleanupEmojiResidue(validIds, { dryRun: true });
          if (scan.removedCategories.length === 0 && scan.fixedCategories.length === 0 && scan.removedEmojiCount === 0) {
              addToast('All clean, no emoji-pack leftovers found ✨', 'success');
              return;
          }
          const lines = [
              scan.removedCategories.length > 0 ? `• Removed ${scan.removedCategories.length} orphaned per-character categories: ${scan.removedCategories.map(c => `"${c.name}"`).join(', ')}` : '',
              scan.removedEmojiCount > 0 ? `• Removed ${scan.removedEmojiCount} emoji that became orphaned/unowned along with their categories` : '',
              scan.fixedCategories.length > 0 ? `• Fixed bindings pointing to deleted characters in ${scan.fixedCategories.length} categories: ${scan.fixedCategories.map(c => `"${c.name}"`).join(', ')}` : '',
          ].filter(Boolean).join('\n');
          if (!window.confirm(`Found the following leftovers (character deleted but emoji pack remains):\n\n${lines}\n\nClick "OK" to clean up — this action cannot be undone.`)) return;
          const report = await DB.cleanupEmojiResidue(validIds);
          addToast(`Cleanup complete: removed ${report.removedCategories.length} categories, ${report.removedEmojiCount} emoji${report.fixedCategories.length > 0 ? `, fixed ${report.fixedCategories.length} bindings` : ''}`, 'success');
      } catch (err) {
          console.error('[Settings] Emoji-pack residue cleanup failed', err);
          addToast('Cleanup failed, please try again', 'error');
      } finally {
          setIsCleaningResidue(false);
      }
  };

  const handleExport = async (mode: 'text_only' | 'media_only' | 'full') => {
      trackEvent('Export Local Backup', { scope: mode });
      try {
          // Second confirmation: full backups (full / text_only) inherently include settings like
          // your API key — that's expected, but it must never be sent to anyone else. media_only
          // contains only media, no keys, and is treated as shareable.
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              const includesSettings = mode !== 'media_only';
              const msg = includesSettings
                  ? 'This export contains your key in plain text — please do not send it to anyone'
                  : 'This export is safe and can be shared';
              if (!window.confirm(`${msg}\n\nClick "OK" to continue exporting, "Cancel" to abort.`)) {
                  trackEvent('Cancel Pre-Export Key Confirmation', { mode });
                  return;
              }
          }

          // Trigger export (Context handles loading state UI)
          const blob = await exportSystem(mode);
          
          const fileName = `Sully_Backup_${mode}_${new Date().toISOString().slice(0, 10)}.zip`;
          if (!Capacitor.isNativePlatform()) {
              // On the web, also keep a manual download link as a last-resort fallback when the browser blocks file sharing/auto-download.
              if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
              const url = URL.createObjectURL(blob);
              downloadUrlRef.current = url;
              setDownloadUrl(url);
              setDownloadFileName(fileName);
              setShowExportModal(true);
          }
          const result = await shareOrDownloadBlob({
              blob,
              fileName,
              shareTitle: 'Sully Backup',
              nativeChunked: true,
          });
          if (result === 'cancelled') return;
      } catch (e: any) {
          // Only report the export tier — the error text is a dynamic string and must not go into a property
          trackEvent('Export Backup Failed', { mode });
          addToast(e.message, 'error');
      }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Pass the File object directly to importSystem
      importSystem(file).catch(err => {
          console.error(err);
          // Only report the classified fixed enum: the raw error text (may contain a file path/content fragment) stays in the console only
          const rawMessage = String(err?.message || '');
          trackEvent('Import Backup Failed', {
              source: file.name.toLowerCase().endsWith('.zip') ? 'zip' : 'json',
              reason:
                  /无效的文件格式/.test(rawMessage) ? 'invalid_file_format'
                  : /缺少 data\.json/.test(rawMessage) ? 'missing_data_json'
                  : /manifest\.json 解析失败/.test(rawMessage) ? 'bad_manifest'
                  : /JSON 格式错误/.test(rawMessage) ? 'json_syntax'
                  : 'other',
          });
          const details = err?.stack || err?.message || String(err || 'unknown error');
          showError('Import failed', details);
          addToast('Import failed, error details expanded', 'error');
      });

      if (importInputRef.current) importInputRef.current.value = '';
  };

  const deliverStandaloneBackup = async (blob: Blob, fileName: string, shareTitle: string) => {
      if (!Capacitor.isNativePlatform()) {
          if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
          const url = URL.createObjectURL(blob);
          downloadUrlRef.current = url;
          setDownloadUrl(url);
          setDownloadFileName(fileName);
          setShowExportModal(true);
      }
      await shareOrDownloadBlob({ blob, fileName, shareTitle, nativeChunked: true });
  };

  const handleAvatarModelExport = async () => {
      if (avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      setAvatarModelBackupProgress({ phase: 'scan', done: 0, total: 1, label: 'Reading local models…' });
      try {
          const blob = await createAvatarModelBackup(setAvatarModelBackupProgress);
          const fileName = `Sully_Models_${new Date().toISOString().slice(0, 10)}_${Date.now()}.zip`;
          await deliverStandaloneBackup(blob, fileName, 'Sully Model Backup');
          addToast(`Model backup generated (${formatBackupBytes(blob.size)})`, 'success');
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || 'unknown error');
          showError('Model backup export failed', details);
          addToast(error?.message || 'Model backup export failed', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          void refreshAvatarModelInventory();
      }
  };

  const handleAvatarModelImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      if (!files.length || avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      let restored = 0;
      let skipped = 0;
      let restoredBytes = 0;
      try {
          for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
              const file = files[fileIndex];
              const result = await restoreAvatarModelBackup(file, progress => {
                  setAvatarModelBackupProgress({
                      ...progress,
                      label: files.length > 1 ? `[${fileIndex + 1}/${files.length}] ${progress.label}` : progress.label,
                  });
              });
              restored += result.restored;
              skipped += result.skipped;
              restoredBytes += result.restoredBytes;
              for (const model of result.models) {
                  updateCharacter(model.characterId, { videoAvatar: model.config });
              }
          }
          await refreshAvatarModelInventory();
          addToast(
              skipped > 0
                  ? `Restored ${restored} models, skipped ${skipped} characters not found`
                  : `Restored ${restored} models in order (${formatBackupBytes(restoredBytes)})`,
              skipped > 0 ? 'info' : 'success',
          );
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || 'unknown error');
          showError('Model backup import failed', details);
          addToast(restored > 0 ? `Restored ${restored} models before interruption` : 'Model backup import failed', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          if (avatarModelBackupInputRef.current) avatarModelBackupInputRef.current.value = '';
      }
  };
  // Cloud Backup Handlers
  const handleTestCloudConnection = async () => {
      setCloudTesting(true);
      setCloudTestResult('');
      try {
          const { testConnection } = await import('../utils/webdavClient');
          const tempConfig = { ...cloudBackupConfig, webdavUrl: cbUrl, username: cbUsername, password: cbPassword, remotePath: cbPath };
          const result = await testConnection(tempConfig);
          setCloudTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // Failure reasons are collapsed into a fixed set of categories — address/username/password and the raw error are never reported
          if (result.ok) {
              trackEvent('Test WebDAV Connection', { result: 'success' });
          } else {
              const m = result.message || '';
              trackEvent('Test WebDAV Connection', {
                  result: 'failed',
                  failure_kind:
                      /认证失败/.test(m) ? 'auth_401'
                      : /无法创建/.test(m) ? 'dir_missing_uncreatable'
                      : /服务器返回/.test(m) ? 'http_status'
                      : 'network_error',
              });
          }
      } catch (e: any) {
          trackEvent('Test WebDAV Connection', { result: 'failed', failure_kind: 'network_error' });
          setCloudTestResult(`✗ ${e.message}`);
      }
      setCloudTesting(false);
  };

  const handleSaveCloudConfig = () => {
      updateCloudBackupConfig({
          enabled: true,
          provider: 'webdav',
          webdavUrl: cbUrl, username: cbUsername, password: cbPassword,
          remotePath: cbPath,
      });
      addToast('Cloud backup config saved', 'success');
      setShowCloudModal(false);
  };

  // Save / restore the main proxy Worker address
  // Proactive messages' search, Notion, and Feishu are all forwarded through this address
  // (tool_config.proxyWorkerUrl), so after changing it, tool_config must be re-pushed —
  // otherwise the cloud copy still points at the old address, and the character's tools all
  // silently stop working once due.
  const handleSaveProxyWorker = () => {
      const raw = proxyWorkerInput.trim();
      if (raw && !/^https?:\/\//i.test(raw)) {
          addToast('The address must start with http:// or https://', 'error');
          trackEvent('Proxy Address Format Rejected');
          return;
      }
      setProxyWorkerUrl(raw);                 // Passing empty / the default address → automatically falls back to default
      const applied = getProxyWorkerUrl();
      setProxyWorkerInput(applied);
      // The cloud copy's proxyWorkerUrl is computed live (reads getProxyWorkerUrl), so it must be pushed after the change takes effect.
      syncAmsgToolConfig(realtimeConfig);
      if (applied === DEFAULT_PROXY_WORKER) trackEvent('Restore Default Proxy Worker', { via: 'save-empty' });
      addToast(applied === DEFAULT_PROXY_WORKER ? 'Restored to the default Worker' : 'Worker address saved', 'success');
  };

  const handleResetProxyWorker = () => {
      setProxyWorkerUrl('');
      setProxyWorkerInput(getProxyWorkerUrl());
      syncAmsgToolConfig(realtimeConfig);
      trackEvent('Restore Default Proxy Worker', { via: 'reset-button' });
      addToast('Restored to the default Worker', 'info');
  };

  const handleCheckFirecrawl = async () => {
      const key = firecrawlKeyInput.trim();
      if (!key) {
          setFirecrawlApiKey('');
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: 'Please fill in a Firecrawl API Key first' });
          return;
      }
      setFirecrawlChecking(true);
      setFirecrawlCheckResult(null);
      try {
          const usage = await getFirecrawlCreditUsage(key);
          setFirecrawlApiKey(key);
          setFirecrawlKeyInput(key);
          setFirecrawlUsage(usage);
          setFirecrawlCheckResult({ ok: true, text: 'Key is valid, web reading enabled' });
          addToast('Firecrawl connected', 'success');
      } catch (error: any) {
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl connection failed' });
      } finally {
          setFirecrawlChecking(false);
      }
  };

  const handleClearFirecrawl = () => {
      setFirecrawlApiKey('');
      setFirecrawlKeyInput('');
      setFirecrawlUsage(null);
      setFirecrawlCheckResult(null);
      addToast('Firecrawl disabled — web reading will continue using its existing fallback', 'info');
  };

  const handleCloudBackup = async (mode: 'text_only' | 'full') => {
      try { await cloudBackupToWebDAV(mode); } catch { /* toast handled in context */ }
  };

  const handleOpenCloudRestore = async () => {
      setShowCloudRestoreModal(true);
      setCloudBackupFiles([]);
      setCloudBackupListState('loading');
      setCloudBackupListError('');
      try {
          const files = await listCloudBackups();
          setCloudBackupFiles(files);
          setCloudBackupListState('ready');
          trackEvent('Load Cloud Backup List', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: 'success' });
      } catch (error: any) {
          const message = error?.message || 'Failed to fetch cloud backup list';
          setCloudBackupListError(message);
          setCloudBackupListState('error');
          trackEvent('Load Cloud Backup List', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: 'failed' });
          addToast(message, 'error');
      }
  };

  const handleCloudRestore = async (file: import('../types').CloudBackupFile) => {
      if (file.status === 'incomplete') {
          addToast(file.statusMessage || 'This backup did not finish uploading, cannot restore it yet', 'error');
          return;
      }
      setShowCloudRestoreModal(false);
      try {
          await cloudRestoreFromWebDAV(file);
      } catch (err: any) {
          // Only distinguish "download stage" from "import stage" — the raw error text only goes to showError / console
          trackEvent('Restore From Cloud Failed', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              stage: /^恢复失败/.test(String(err?.message || '')) ? 'import' : 'download',
          });
          const details = err?.stack || err?.message || String(err || 'unknown error');
          showError('Cloud restore failed', details);
      }
  };

  // GitHub backup handlers — single "Test & Connect" button does verify-token +
  // ensure-repo, persists owner/login on success so users never type 'owner'.
  const handleTestGithub = async () => {
      if (!ghToken.trim()) {
          trackEvent('Test & Connect GitHub', { result: 'failed', failure_stage: 'no_token' });
          setGhTestResult('✗ Please paste a Token first');
          return;
      }
      setGhTesting(true);
      setGhTestResult('');
      try {
          const { testConnection } = await import('../utils/githubClient');
          const result = await testConnection({
              ...cloudBackupConfig,
              githubToken: ghToken.trim(),
              githubRepo: ghRepo.trim() || 'sully-backup',
              githubUseProxy: ghUseProxy,
              githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
          });
          setGhTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // On failure only report which step it got stuck on: token verification failed → no login, repo prep failed → has login
          trackEvent('Test & Connect GitHub', result.ok
              ? { result: 'success' }
              : { result: 'failed', failure_stage: result.login ? 'ensure_repo' : 'verify_token' });
          if (result.ok && result.login) {
              updateCloudBackupConfig({
                  enabled: true,
                  provider: 'github',
                  githubToken: ghToken.trim(),
                  githubOwner: result.login,
                  githubRepo: ghRepo.trim() || 'sully-backup',
                  githubUseProxy: ghUseProxy,
                  githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
              });
          }
      } catch (e: any) {
          trackEvent('Test & Connect GitHub', { result: 'failed', failure_stage: 'exception' });
          setGhTestResult(`✗ ${e?.message || 'Connection failed'}`);
      }
      setGhTesting(false);
  };

  const handleGithubProxyToggle = (enabled: boolean) => {
      setGhUseProxy(enabled);
      // Checking the box is itself explicit user consent to the relay, persisted immediately. The old
      // behavior only saved it once "Test & Connect" was completed again — a user could check it and
      // close right away, with the actual upload still going direct.
      updateCloudBackupConfig({
          githubUseProxy: enabled,
          githubProxyConsentVersion: enabled ? 1 : undefined,
      });
      trackEvent('Toggle GitHub Backup Route', { route: enabled ? 'cloudflare_worker' : 'direct' });
      addToast(
          enabled ? 'Switched to the in-app Cloudflare relay, takes effect on the next backup' : 'Switched to connecting directly to the GitHub attachment domain',
          'info',
      );
  };

  const handleDisableCloud = () => {
      trackEvent('Disable Cloud Backup', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' });
      updateCloudBackupConfig({ enabled: false });
      setShowCloudModal(false);
      setShowGithubModal(false);
      addToast('Cloud backup disabled', 'info');
  };

  // One-click provider switch — if the target provider was already configured
  // before, just flip the 'provider' field and show a toast. Otherwise open
  // the setup modal. Critically: switching does NOT touch the other side's
  // saved credentials, so old WebDAV users keep their old backups visible
  // when they switch back.
  const switchToGithub = () => {
      trackEvent('Switch Cloud Backup Provider', { to: 'github' });
      if (cloudBackupConfig.githubToken && cloudBackupConfig.githubOwner) {
          updateCloudBackupConfig({ provider: 'github' });
          addToast(`Switched to GitHub @${cloudBackupConfig.githubOwner}`, 'success');
      } else {
          setShowGithubModal(true);
      }
  };
  const switchToWebDAV = () => {
      trackEvent('Switch Cloud Backup Provider', { to: 'webdav' });
      if (cloudBackupConfig.webdavUrl && cloudBackupConfig.username) {
          updateCloudBackupConfig({ provider: 'webdav' });
          addToast('Switched back to WebDAV, old backups are still there', 'success');
      } else {
          setShowCloudModal(true);
      }
  };

  const confirmReset = () => {
      resetSystem();
      setShowResetConfirm(false);
  };

  // Save Real-time Perception config
  const handleSaveRealtimeConfig = () => {
      const updates = {
          weatherEnabled: rtWeatherEnabled,
          weatherApiKey: rtWeatherKey,
          weatherCity: rtWeatherCity,
          newsEnabled: rtNewsEnabled,
          newsApiKey: rtNewsApiKey,
          newsPlatforms: rtNewsPlatforms,
          notionEnabled: rtNotionEnabled,
          notionApiKey: rtNotionKey,
          notionDatabaseId: rtNotionDbId,
          notionNotesDatabaseId: rtNotionNotesDbId || undefined,
          feishuEnabled: rtFeishuEnabled,
          feishuAppId: rtFeishuAppId,
          feishuAppSecret: rtFeishuAppSecret,
          feishuBaseId: rtFeishuBaseId,
          feishuTableId: rtFeishuTableId,
          xhsEnabled: rtXhsEnabled,
          xhsMcpConfig: {
              enabled: rtXhsMcpEnabled,
              mode: rtXhsMode,
              serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl,
              cookie: rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined,
              platform: rtXhsMode === 'lite' ? rtXhsPlatform : undefined,
              loggedInNickname: rtXhsNickname || undefined,
              loggedInUserId: rtXhsUserId || undefined,
              userXsecToken: realtimeConfig.xhsMcpConfig?.userXsecToken,
          }
      };
      updateRealtimeConfig(updates);
      RealtimeContextManager.clearCache();
      const nextRealtimeConfig = { ...realtimeConfig, ...updates };
      // Refresh cloud credentials + prompts trimmed to match the config together — otherwise the character will call now-disabled tools per the old prompt once due.
      syncAmsgToolConfigAndPrompts(nextRealtimeConfig, { characters, userProfile, groups });
      addToast('Real-time Perception config saved', 'success');
      setShowRealtimeModal(false);
  };

  // Test the weather API connection: tests OpenWeatherMap if a key is filled in, tests the free Open-Meteo if not
  const testWeatherApi = async () => {
      if (!rtWeatherCity) {
          setRtTestStatus('Please fill in a city first');
          return;
      }
      setRtTestStatus('Testing...');
      try {
          const weather = rtWeatherKey
              ? await fetchOwmWeather(rtWeatherCity, rtWeatherKey)
              : await fetchOpenMeteoWeather(rtWeatherCity);
          const source = rtWeatherKey ? 'OpenWeatherMap' : 'Open-Meteo';
          // Deliberately omit the data source name: that is equivalent to "was a weather key filled in", which is config state
          trackEvent('Test Weather Data Source Connection', { result: 'ok' });
          setRtTestStatus(`Connected! (${source}) ${weather.city}: ${weather.description}, ${weather.temp}°C`);
      } catch (e: any) {
          trackEvent('Test Weather Data Source Connection', { result: 'failed' });
          setRtTestStatus(`Connection failed: ${e.message}`);
      }
  };

  // Test the Notion connection
  const testNotionApi = async () => {
      if (!rtNotionKey || !rtNotionDbId) {
          setRtTestStatus('Please fill in the Notion API Key and Database ID');
          return;
      }
      setRtTestStatus('Testing Notion connection...');
      try {
          const result = await NotionManager.testConnection(rtNotionKey, rtNotionDbId);
          trackEvent('Test Notion Connection', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('Test Notion Connection', { result: 'network-error' });
          setRtTestStatus(`Network error: ${e.message}`);
      }
  };

  // Test the Feishu connection
  const testFeishuApi = async () => {
      if (!rtFeishuAppId || !rtFeishuAppSecret || !rtFeishuBaseId || !rtFeishuTableId) {
          setRtTestStatus('Please fill in the Feishu App ID, App Secret, Base ID, and Table ID');
          return;
      }
      setRtTestStatus('Testing Feishu connection...');
      try {
          const result = await FeishuManager.testConnection(rtFeishuAppId, rtFeishuAppSecret, rtFeishuBaseId, rtFeishuTableId);
          trackEvent('Test Feishu Connection', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('Test Feishu Connection', { result: 'network-error' });
          setRtTestStatus(`Network error: ${e.message}`);
      }
  };

  // Test the Xiaohongshu Bridge connection
  const testXhsMcp = async () => {
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl;
      const cookieToUse = rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined;
      if (!urlToUse) {
          setRtTestStatus('Please fill in the server URL');
          return;
      }
      if (rtXhsMode === 'lite' && !cookieToUse) {
          setRtTestStatus('Please paste your Xiaohongshu cookie first');
          return;
      }
      setRtTestStatus('Connecting...');
      try {
          const result = await XhsMcpClient.testConnection(
              urlToUse,
              cookieToUse,
          );
          if (result.connected) {
              // Never include nickname / user ID / xsecToken
              trackEvent('Test Xiaohongshu Bridge Connection', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'connected' });
              const toolCount = result.tools?.length || 0;
              const tokenInfo = result.xsecToken ? ' | xsecToken obtained' : '';
              const platformInfo = result.platform ? ` | Platform: ${result.platform === 'rednote' ? 'RedNote' : 'Xiaohongshu'}` : '';
              const loginInfo = result.loggedIn
                  ? `${platformInfo} | ${result.nickname ? `Account: ${result.nickname}` : 'Logged in'}${result.userId ? ` (ID: ${result.userId})` : ''}${tokenInfo}`
                  : ' | Not logged in, please check the cookie or log into Xiaohongshu';
              setRtTestStatus(`Connected! ${toolCount} feature(s) available${loginInfo}`);
              // Auto-fill: only overwrite fields the user has not manually filled in
              if (result.nickname && !rtXhsNickname) setRtXhsNickname(result.nickname);
              if (result.userId && !rtXhsUserId) setRtXhsUserId(result.userId);
              setRtXhsPlatform(result.platform);
              const xhsUpdates = {
                  xhsMcpConfig: {
                      enabled: rtXhsMcpEnabled,
                      mode: rtXhsMode,
                      serverUrl: urlToUse,
                      cookie: cookieToUse,
                      platform: result.platform,
                      loggedInNickname: rtXhsNickname || result.nickname,
                      loggedInUserId: rtXhsUserId || result.userId,
                      userXsecToken: result.xsecToken,
                  }
              };
              updateRealtimeConfig(xhsUpdates);
              const nextConfig = { ...realtimeConfig, ...xhsUpdates };
              syncAmsgToolConfigAndPrompts(nextConfig, { characters, userProfile, groups });
          } else {
              trackEvent('Test Xiaohongshu Bridge Connection', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'failed' });
              setRtTestStatus(`Connection failed: ${result.error}`);
          }
      } catch (e: any) {
          trackEvent('Test Xiaohongshu Bridge Connection', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'network-error' });
          setRtTestStatus(`Network error: ${e.message}`);
      }
  };

  // McDonald's MCP: changing the token / enabled state both persist to localStorage immediately; "Test Connection" calls initialize+tools/list
  const handleMcdTokenChange = (v: string) => {
      setMcdTokenState(v);
      saveMcdToken(v);
      resetMcdSession();
      setMcdTestStatus('');
  };
  const handleMcdEnabledChange = (v: boolean) => {
      setMcdEnabledState(v);
      saveMcdEnabled(v);
      if (!v) resetMcdSession();
  };
  const testMcdApi = async () => {
      if (!mcdToken.trim()) { setMcdTestStatus('Please fill in the MCP Token first'); return; }
      setMcdTesting(true);
      setMcdTestStatus("Connecting to McDonald's MCP...");
      try {
          const r = await testMcdConnection();
          if (r.ok) {
              trackEvent('Test Order MCP Connection', { provider: 'mcdonalds', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setMcdTestStatus(`✅ ${r.message}${names ? `\nTools: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('Test Order MCP Connection', { provider: 'mcdonalds', result: 'failed' });
              setMcdTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('Test Order MCP Connection', { provider: 'mcdonalds', result: 'exception' });
          setMcdTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setMcdTesting(false);
      }
  };

  // Luckin MCP (structured the same as McDonald's)
  const handleLuckinTokenChange = (v: string) => {
      setLuckinTokenState(v);
      saveLuckinToken(v);
      resetLuckinSession();
      setLuckinTestStatus('');
  };
  const handleLuckinEnabledChange = (v: boolean) => {
      setLuckinEnabledState(v);
      saveLuckinEnabled(v);
      if (!v) resetLuckinSession();
  };
  const testLuckinApi = async () => {
      if (!luckinToken.trim()) { setLuckinTestStatus('Please fill in the MCP Token first'); return; }
      setLuckinTesting(true);
      setLuckinTestStatus('Connecting to Luckin MCP...');
      try {
          const r = await testLuckinConnection();
          if (r.ok) {
              trackEvent('Test Order MCP Connection', { provider: 'luckin', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setLuckinTestStatus(`✅ ${r.message}${names ? `\nTools: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('Test Order MCP Connection', { provider: 'luckin', result: 'failed' });
              setLuckinTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('Test Order MCP Connection', { provider: 'luckin', result: 'exception' });
          setLuckinTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setLuckinTesting(false);
      }
  };

  return (
    <div className="h-full w-full bg-[#f3f4f8] flex flex-col font-light relative isolate">

      {/* GLOBAL PROGRESS OVERLAY */}
      {sysOperation.status === 'processing' && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center animate-fade-in">
              <div className="bg-white p-6 rounded-3xl shadow-2xl flex flex-col items-center gap-4 w-64">
                  <div className="w-12 h-12 border-4 border-slate-200 border-t-primary rounded-full animate-spin"></div>
                  <div className="text-sm font-bold text-slate-700 text-center leading-relaxed whitespace-pre-wrap break-words max-w-full">{sysOperation.message}</div>
                  {sysOperation.progress > 0 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${sysOperation.progress}%` }}></div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* Header */}
      <div className="bg-[#fffefe] border-b border-slate-200 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center px-4 py-3">
        <div className="flex items-center gap-2 w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
            </button>
            <h1 className="text-xl font-medium text-slate-700 tracking-wide">System Settings</h1>
        </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar pb-20">

        {/* When the appearance-editor entry itself is covered up by broken CSS, there must be an emergency channel that bypasses the Journal app entirely. */}
        <SettingsSection
            title="Appearance Emergency Reset"
            badge={hasJournalAppearanceOverride
                ? <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-bold shrink-0">Journal styling enabled</span>
                : undefined}
            icon={
                <div className="p-2 bg-amber-100/70 rounded-xl text-amber-700">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21a2.12 2.12 0 0 0 3-3l-5.84-5.84M11.42 15.17l2.83-2.83M11.42 15.17l-4.68 4.68a2.121 2.121 0 0 1-3-3l6.59-6.59m4.08 1.9 2.83-2.83m0 0 1.5-1.5a2.121 2.121 0 0 0-3-3l-1.5 1.5m3 3-3-3m-3.91 3.91-4.95-4.95a2.121 2.121 0 0 0-3 3l4.95 4.95" /></svg>
                </div>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                If Exchange Diary's custom CSS covers up the back/settings buttons or makes them unclickable, you can clear the diary theme and CSS directly from here without affecting the diary content.
            </p>
            <button
                type="button"
                disabled={!hasJournalAppearanceOverride}
                onClick={handleJournalAppearanceEmergencyReset}
                className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white shadow-sm transition active:scale-[.98] disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
            >
                {hasJournalAppearanceOverride ? 'Reset Exchange Diary Styling' : 'Exchange Diary is currently original'}
            </button>
        </SettingsSection>

        {/* Data backup section */}
        <SettingsSection
            title="Backup & Restore (ZIP)"
            icon={
                <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                </div>
            }
        >
            <StorageUsagePanel />

            <div className="mb-3">
                <button onClick={() => handleExport('full')} className="w-full py-4 bg-gradient-to-r from-violet-500 to-purple-600 border border-violet-300 rounded-xl text-xs font-bold text-white shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden mb-3">
                    <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-white/20 text-[9px] text-white rounded-bl-lg font-bold">Full</div>
                    <div className="p-2 bg-white/20 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg></div>
                    <span>Combined Export (Text + Media)</span>
                </button>
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-3 text-center">The following are step-by-step exports, suited for backing up in stages on lower-spec devices</p>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <button onClick={() => handleExport('text_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden">
                    <div className="p-2 bg-blue-50 rounded-full text-blue-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg></div>
                    <span>Text-Only Backup</span>
                </button>
                 <button onClick={() => handleExport('media_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2">
                    <div className="p-2 bg-pink-50 rounded-full text-pink-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg></div>
                    <span>Media & Styling Assets</span>
                </button>
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
                 <div onClick={() => importInputRef.current?.click()} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 cursor-pointer hover:bg-emerald-50 hover:border-emerald-200">
                    <div className="p-2 bg-emerald-100 rounded-full text-emerald-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div>
                    <span>Import Backup (.zip / .json)</span>
                </div>
                <input type="file" ref={importInputRef} className="hidden" accept=".json,.zip" onChange={handleImport} />
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                • <b>Combined Export</b>: exports text and image media in one go; use the standalone backup below for VRM / Live2D models.<br/>
                • <b>Text-Only Backup</b>: includes all chat history, character settings, and story data. All images are stripped out (to reduce size).<br/>
                • <b>Media & Styling Assets</b>: exports the gallery, emoji packs, chat images, avatars, theme bubbles, wallpapers, icons, and other image resources plus appearance config.<br/>
                • <b>Voice scope</b>: combined/media backups only include favorited voice lines, plus the voice lines actually referenced by Live2D startup/touch presets; unfavorited temporary voice lines from chat, calls, etc. are not exported.<br/>
                • Compatible with importing older JSON backup files.
            </p>

            <div data-testid="avatar-model-backup-section" className="mb-5 border-y border-violet-100 py-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-xs font-bold text-slate-700">Video Models · Separate Backup</h3>
                        <p className="mt-0.5 text-[10px] text-slate-400">VRM / Live2D no longer mixed into the regular data package</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-600">
                        {avatarModelInventory
                            ? `${avatarModelInventory.availableCount} · ${formatBackupBytes(avatarModelInventory.totalBytes)}`
                            : 'Scanning…'}
                    </span>
                </div>

                {avatarModelInventory && avatarModelInventory.models.length > 0 && (
                    <div className="mb-3 divide-y divide-slate-100 border-y border-slate-100">
                        {avatarModelInventory.models.map(model => (
                            <div key={model.characterId} className="flex items-center justify-between gap-3 py-2">
                                <div className="min-w-0">
                                    <p className="truncate text-[11px] font-semibold text-slate-600">{model.characterName}</p>
                                    <p className="truncate text-[9px] uppercase tracking-wide text-slate-400">{model.format} · {model.fileName}</p>
                                </div>
                                <span className={`shrink-0 text-[10px] font-medium ${model.available ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {model.available ? formatBackupBytes(model.byteLength) : 'File missing'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleAvatarModelExport}
                        disabled={avatarModelBackupBusy || !avatarModelInventory?.availableCount}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 text-xs font-bold text-white transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3.75m0 0 4.5 4.5M12 3.75l-4.5 4.5M3.75 15v4.125c0 .621.504 1.125 1.125 1.125h14.25c.621 0 1.125-.504 1.125-1.125V15" /></svg>
                        Export Model Package
                    </button>
                    <button
                        type="button"
                        onClick={() => avatarModelBackupInputRef.current?.click()}
                        disabled={avatarModelBackupBusy}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white px-3 text-xs font-bold text-violet-600 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v12m0 0 4.5-4.5M12 19.5 7.5 15M3.75 9V4.875c0-.621.504-1.125 1.125-1.125h14.25c.621 0 1.125.504 1.125 1.125V9" /></svg>
                        Import in Order
                    </button>
                    <input
                        ref={avatarModelBackupInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        multiple
                        className="hidden"
                        onChange={handleAvatarModelImport}
                    />
                </div>

                {avatarModelBackupProgress && (
                    <div className="mt-3" aria-live="polite">
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-violet-600">
                            <span className="truncate">{avatarModelBackupProgress.label}</span>
                            <span className="shrink-0 font-bold">
                                {Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%
                            </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-violet-100">
                            <div
                                className="h-full rounded-full bg-violet-500 transition-[width] duration-200"
                                style={{ width: `${Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%` }}
                            />
                        </div>
                    </div>
                )}

                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                    One ZIP can contain multiple character models. When restoring, import the regular data above first, then import the model package; the system will read and write them one at a time. Selecting multiple model packages at once is also processed in selection order.
                </p>
                {avatarModelInventory && avatarModelInventory.missingCount > 0 && (
                    <p className="mt-2 text-[10px] leading-relaxed text-rose-500">
                        {avatarModelInventory.missingCount} character(s) only have a model index left — the local binary is already gone, cannot be exported.
                    </p>
                )}
            </div>
            {/* Backup reminder frequency: local data only lives on this device — a reminder pops up if N days pass without exporting */}
            <div className="mb-4 p-3.5 bg-gradient-to-br from-rose-50 to-orange-50 border border-rose-100 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-600">Backup Reminder Frequency</span>
                    <span className="text-xs font-bold text-rose-500">Every {backupReminderDays} days</span>
                </div>
                <input
                    type="range"
                    min={BACKUP_REMINDER_MIN_DAYS}
                    max={BACKUP_REMINDER_MAX_DAYS}
                    step={1}
                    value={backupReminderDays}
                    onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        setBackupReminderDays(v);
                        setBackupReminderIntervalDays(v);
                    }}
                    className="w-full h-2 bg-rose-100 rounded-full appearance-none accent-rose-500"
                />
                <div className="flex justify-between text-[9px] text-slate-400 mt-1 px-0.5">
                    <span>{BACKUP_REMINDER_MIN_DAYS} days</span>
                    <span>{BACKUP_REMINDER_MAX_DAYS} days</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    A reminder pops up once you go past this many days without exporting.
                    {backupDaysAgo == null
                        ? ' You have not exported a backup yet — remember to keep one.'
                        : ` The last backup was ${backupDaysAgo} days ago.`}
                </p>
            </div>

            <button onClick={handleCleanupResidue} disabled={isCleaningResidue} className="w-full py-3 mb-2 bg-amber-50 border border-amber-100 text-amber-600 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50">
                {isCleaningResidue ? 'Scanning…' : 'One-Click Cleanup of Emoji Pack Leftovers'}
            </button>
            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                Cleans up "ghost emoji packs" left behind by deleted characters: once a character with a per-character category is gone, the single-chat emoji panel can no longer see it, but it still shows up in the group-chat panel. Scans and lists results first, only deletes after you confirm.
            </p>

            <button onClick={() => setShowResetConfirm(true)} className="w-full py-3 bg-red-50 border border-red-100 text-red-500 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                Format System (Factory Reset)
            </button>
        </SettingsSection>

        {/* Cloud backup section */}
        <SettingsSection
            title="Cloud Backup"
            icon={
                <div className="p-2 bg-sky-100 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                </div>
            }
        >
            {!cloudBackupConfig.enabled ? (
                <div className="space-y-3 py-2">
                    <p className="text-[11px] text-slate-400 leading-relaxed text-center">
                        Upload backups to your own cloud — safe even if you switch devices or lose your phone.<br/>
                        For large files, <b>GitHub</b> is recommended (automatic chunked upload).
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => { trackEvent('Connect Cloud Backup Provider', { provider: 'github' }); setShowGithubModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5 relative"
                        >
                            <span className="absolute top-1 right-1.5 text-[8px] bg-amber-300 text-slate-800 px-1.5 py-0.5 rounded-full font-bold">Recommended</span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                            <span>GitHub</span>
                            <span className="text-[9px] text-slate-300 font-normal">Automatic chunking for large files</span>
                        </button>
                        <button
                            onClick={() => { trackEvent('Connect Cloud Backup Provider', { provider: 'webdav' }); setShowCloudModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-sky-500 to-blue-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                            <span>WebDAV</span>
                            <span className="text-[9px] text-sky-100 font-normal">Japan/NAS · VPN required</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${cloudBackupConfig.provider === 'github' ? 'bg-slate-100' : 'bg-sky-50'}`}>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                            <span className="text-[11px] text-slate-600 font-medium">
                                Connected · {cloudBackupConfig.provider === 'github'
                                    ? `GitHub${cloudBackupConfig.githubOwner ? ` (@${cloudBackupConfig.githubOwner})` : ''}`
                                    : 'WebDAV'}
                            </span>
                        </div>
                        <button
                            onClick={() => cloudBackupConfig.provider === 'github' ? setShowGithubModal(true) : setShowCloudModal(true)}
                            className={`text-[10px] font-medium ${cloudBackupConfig.provider === 'github' ? 'text-slate-600' : 'text-sky-500'}`}
                        >
                            Edit Config
                        </button>
                    </div>

                    {/* Quick link to the GitHub releases page so the user knows
                        where their backups physically live and can browse /
                        delete them on github.com directly if they want. */}
                    {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                        <a
                            href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                            target="_blank" rel="noopener noreferrer"
                            className="block text-center text-[10px] text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline transition-colors"
                        >
                            🔗 View backups on GitHub (github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases) ↗
                        </a>
                    )}

                    {/* Switch-provider hint — shown to existing users so the
                        new GitHub option is discoverable from the connected
                        state, not only on the first-time setup screen. If the
                        other provider was previously configured, the click is
                        a one-shot flip; old credentials and backups stay put. */}
                    {cloudBackupConfig.provider !== 'github' ? (
                        <>
                            <button
                                onClick={switchToGithub}
                                className="w-full py-2 bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-xl text-[11px] font-bold shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                                <span>{cloudBackupConfig.githubToken ? 'Switch to GitHub' : 'Try GitHub backup (automatic chunking for large files)'}</span>
                            </button>
                            <p className="text-[10px] text-slate-400 text-center">
                                Your old backups on WebDAV are untouched — you can switch back anytime.
                            </p>
                        </>
                    ) : (
                        <button
                            onClick={switchToWebDAV}
                            className="w-full py-1.5 text-[10px] text-slate-400 hover:text-sky-500 transition-colors"
                        >
                            {cloudBackupConfig.webdavUrl ? 'Switch back to WebDAV →' : 'Use WebDAV backup instead →'}
                        </button>
                    )}
                    {cloudBackupConfig.lastBackupTime && (
                        <p className="text-[10px] text-slate-400 text-center">
                            Last backup: {new Date(cloudBackupConfig.lastBackupTime).toLocaleString('en-US')}
                            {cloudBackupConfig.lastBackupSize && ` (${(cloudBackupConfig.lastBackupSize / 1024 / 1024).toFixed(1)} MB)`}
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => handleCloudBackup('text_only')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-sky-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>Back Up to Cloud</span>
                            <span className="text-[9px] text-slate-400">(text only)</span>
                        </button>
                        <button
                            onClick={() => handleCloudBackup('full')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-violet-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>Back Up to Cloud</span>
                            <span className="text-[9px] text-slate-400">(full)</span>
                        </button>
                    </div>

                    <button
                        onClick={handleOpenCloudRestore}
                        className="w-full py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-emerald-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                        Restore From Cloud
                    </button>
                </div>
            )}

            <p className="text-[10px] text-slate-400 px-1 mt-3 leading-relaxed">
                Backups always live in your own WebDAV or GitHub account — the project does not maintain a user backup database.
                Web WebDAV needs a relay due to cross-origin restrictions; GitHub connects directly by default, with an optional relay if your network is restricted.
            </p>
        </SettingsSection>

        {/* AI connection settings section */}
        <SettingsSection
            title="API Configuration"
            icon={
                <div className="p-2 bg-emerald-100/50 rounded-xl text-emerald-600">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { setNewPresetName(''); setShowPresetModal(true); }} className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    New Preset
                </button>
            }
        >
            {/* Presets List */}
            {apiPresets.length > 0 && (
                <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">My Presets</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <div key={preset.id} className={`flex items-center rounded-lg pl-3 pr-1 py-1 shadow-sm border transition-colors ${
                                activePresetId === preset.id
                                    ? 'bg-primary/5 border-primary/30'
                                    : 'bg-white border-slate-200'
                            }`}>
                                <button type="button" onClick={() => applyPreset(preset)}
                                    title={`Switch to ${preset.name}`}
                                    className={`text-xs font-medium cursor-pointer mr-1.5 transition-colors ${
                                        activePresetId === preset.id ? 'text-primary' : 'text-slate-600 hover:text-primary'
                                    }`}>
                                    {preset.name}
                                    {activePresetId === preset.id && <span className="ml-1 text-[9px] font-bold">· In Use</span>}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Edit preset ${preset.name}`}
                                    title="Edit this preset"
                                    onClick={(event) => { event.stopPropagation(); openEditPreset(preset); }}
                                    className="p-1 rounded-full text-slate-300 hover:bg-primary/10 hover:text-primary transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" /></svg>
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Hold or double-click to delete preset ${preset.name}`}
                                    title="Hold or double-click to delete"
                                    onPointerDown={(event) => { event.stopPropagation(); beginPresetDeleteHold(preset.id, preset.name); }}
                                    onPointerUp={cancelPresetDeleteHold}
                                    onPointerCancel={cancelPresetDeleteHold}
                                    onPointerLeave={cancelPresetDeleteHold}
                                    onDoubleClick={(event) => { event.stopPropagation(); deleteApiPreset(preset.id, preset.name); }}
                                    onContextMenu={(event) => event.preventDefault()}
                                    className={`p-1 rounded-full transition-colors select-none touch-none ${
                                        holdingDeletePresetId === preset.id
                                            ? 'bg-red-100 text-red-500 scale-110'
                                            : 'text-slate-300 hover:bg-red-50 hover:text-red-400'
                                    }`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="text-[9px] text-slate-300 mt-1.5 pl-1">Click the name to switch and apply immediately; the pencil edits this preset's content; only holding or double-clicking × deletes it.</p>
                </div>
            )}

            <div className="space-y-4">
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                {/* Advanced (stream / temperature) — collapsed by default, low-key gray, explicitly says "not recommended to change" */}
                <div className="pt-1">
                    <button
                        type="button"
                        onClick={() => setShowApiAdvanced(v => !v)}
                        className="text-[10px] text-slate-300 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1 active:scale-95"
                    >
                        <span>Advanced (not recommended to change)</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}>
                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {showApiAdvanced && (
                        <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
                            <p className="text-[10px] text-slate-300 leading-relaxed">
                                Most users should leave these two at their defaults. Only change them if the API errors with "only stream supported" or you have a strong preference for reply style.
                            </p>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">Streaming Output (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">Only turn on if your API requires it</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocalStream(v => !v)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localStream ? 'bg-slate-400' : 'bg-slate-200'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${localStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">Temperature</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">Default 0.85; only affects the main reply in chat and dates</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : 'Refresh Model List'}</button>
                    </div>
                    
                    <button
                        onClick={() => setShowModelModal(true)}
                        title={localModel || 'Select Model...'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || 'Select Model...'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>

                <button onClick={handleSaveApi} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all mt-2">
                    {statusMsg || 'Save Configuration'}
                </button>
                {apiPresets.length > 0 && (
                    <p className="text-[9px] text-slate-300 px-1 leading-relaxed">
                        This changes the currently active config, it will not touch the presets above; to save the change back into a preset, click its pencil.
                    </p>
                )}

                <button
                    onClick={async () => {
                        if (!localUrl.trim() || !localKey.trim() || !localModel.trim()) return;
                        setTestingApi(true);
                        setTestApiResult(null);
                        try {
                            const res = await fetch(`${localUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey.trim()}` },
                                body: JSON.stringify({
                                    model: localModel.trim(),
                                    messages: [{ role: 'user', content: 'Hi' }],
                                    max_tokens: 5,
                                    stream: localStream,
                                }),
                            });
                            if (res.ok) {
                                // Use safeResponseJson — it can transparently stitch an SSE streaming response back into a normal chat/completion structure
                                const data = await safeResponseJson(res);
                                const reply = extractContent(data);
                                setTestApiResult(`✅ Connected — model replied: "${reply.slice(0, 30)}"`);
                            } else {
                                const text = await res.text().catch(() => '');
                                setTestApiResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
                            }
                        } catch (err: any) {
                            setTestApiResult(`❌ Connection failed: ${err.message}`);
                        } finally {
                            setTestingApi(false);
                        }
                    }}
                    disabled={testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()}
                    className={`w-full py-2.5 rounded-2xl font-bold text-sm border mt-2 active:scale-95 transition-all ${
                        testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()
                            ? 'border-slate-200 text-slate-400 bg-slate-50'
                            : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                    }`}
                >
                    {testingApi ? 'Testing...' : '🧪 Test Connection'}
                </button>

                {testApiResult && (
                    <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${
                        testApiResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {testApiResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* Standalone Image Recognition API: adds vision capability for main models that don't support image_url; can be loaded manually from a general model preset. */}
        <SettingsSection
            title="Image Recognition API"
            badge={
                <span className={`text-[9px] font-bold px-2 py-1 rounded-full ${
                    apiConfig.visionApi?.enabled
                        ? 'bg-violet-100 text-violet-600'
                        : 'bg-slate-100 text-slate-400'
                }`}>
                    {apiConfig.visionApi?.enabled ? 'Connected' : 'Not Connected'}
                </span>
            }
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-4">
                <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3.5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-xs font-bold text-slate-600">Connect a Standalone Image Recognition API</div>
                            <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                Suited for main models like DeepSeek that can't view images directly.
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={localVisionEnabled}
                            onClick={() => setLocalVisionEnabled(value => !value)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${localVisionEnabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                        >
                            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${localVisionEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                </div>

                <p className="text-[10px] text-slate-400 leading-relaxed px-1">
                    Once enabled, each chat image is first passed to the vision model here for recognition just once, and the result is written as
                    <span className="font-semibold text-violet-600"> [Image: what the model sees] </span>
                    before being sent to the main API; chat and re-rolls afterward directly reuse it, no repeated image-recognition charges. When disabled, the original image-sending logic is used as-is.
                </p>

                <div className="rounded-2xl border border-violet-100 bg-white/70 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <label className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">Load From a Model Preset</label>
                        <span className="text-[9px] text-slate-300">Will not switch the main API</span>
                    </div>
                    {apiPresets.length > 0 ? (
                        <div className="flex gap-2 flex-wrap">
                            {apiPresets.map(preset => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => loadVisionApiPreset(preset)}
                                    className={`max-w-full px-3 py-1.5 rounded-lg border text-[11px] font-medium truncate transition-colors ${
                                        selectedVisionPresetId === preset.id
                                            ? 'bg-violet-100 border-violet-200 text-violet-700'
                                            : 'bg-white border-slate-200 text-slate-500 hover:border-violet-200'
                                    }`}
                                    title={`${preset.name} · ${preset.config.model || 'No model configured'}`}
                                >
                                    {preset.name}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className="text-[10px] text-slate-400 leading-relaxed">No model presets yet; you can save one in "API Configuration" above, or fill this in manually.</p>
                    )}
                </div>

                <div className={`space-y-3 transition-opacity ${localVisionEnabled ? 'opacity-100' : 'opacity-50'}`}>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input
                            type="text"
                            value={localVisionUrl}
                            onChange={event => { setLocalVisionUrl(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="https://.../v1"
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input
                            type="password"
                            value={localVisionKey}
                            onChange={event => { setLocalVisionKey(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="sk-..."
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button
                                type="button"
                                onClick={fetchVisionModels}
                                disabled={!localVisionEnabled || isLoadingVisionModels}
                                className="text-[10px] text-violet-600 font-bold disabled:text-slate-300"
                            >
                                {isLoadingVisionModels ? 'Fetching...' : 'Refresh Model List'}
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowVisionModelModal(true)}
                            disabled={!localVisionEnabled}
                            title={localVisionModel || 'Select or manually enter a model'}
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm disabled:cursor-not-allowed"
                        >
                            <span className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left text-ellipsis">
                                {localVisionModel || 'Select or manually enter a model...'}
                            </span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleTestVisionApi}
                        disabled={testingVisionApi || !localVisionEnabled || !localVisionUrl.trim() || !localVisionKey.trim() || !localVisionModel.trim()}
                        className="py-3 rounded-2xl font-bold text-violet-600 border border-violet-200 bg-violet-50 active:scale-95 transition-all disabled:opacity-40"
                    >
                        {testingVisionApi ? 'Testing image recognition…' : '🧪 Test Image Recognition'}
                    </button>
                    <button
                        type="button"
                        onClick={handleSaveVisionApi}
                        disabled={isLoadingVisionModels || testingVisionApi}
                        className="py-3 rounded-2xl font-bold text-white shadow-lg shadow-violet-500/20 bg-violet-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                        Save Image Recognition API
                    </button>
                </div>
                {visionStatusMsg && (
                    <div className="text-[11px] text-center text-violet-600 bg-violet-50 px-3 py-2 rounded-xl">{visionStatusMsg}</div>
                )}
                <p className="text-[9px] text-slate-300 px-1">Testing sends a built-in purple-dot image to confirm the model can actually see images, and uses one very small request.</p>
                {visionTestResult && (
                    <div className={`text-xs px-3 py-2 rounded-xl leading-relaxed ${
                        visionTestResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {visionTestResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* API call log entry point — open to see call details for the last 5 days by App / character / purpose */}
        <button
            type="button"
            onClick={() => setShowApiCallLog(true)}
            className="w-full bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 flex items-center gap-3 active:scale-[0.99] transition-transform text-left"
        >
            <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
            </div>
            <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">API Call Log</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">Last 5 days: time · which API · which App · which character · purpose</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 shrink-0">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
        </button>

        {/* Other APIs section — non-LLM (voice, songwriting, etc.), not affected by preset switching */}
        <SettingsSection
            title="Other APIs"
            icon={
                <div className="p-2 bg-amber-100/50 rounded-xl text-amber-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                    </svg>
                </div>
            }
        >
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed pl-1">
                Non-LLM APIs like voice and songwriting. These settings <span className="font-semibold text-slate-500">are not affected by preset switching</span>, usually configured just once.
            </p>

            <div className="space-y-4">
                <p className="text-[11px] text-slate-400 -mt-1 pl-1 leading-relaxed">
                    🎙️ Voice generation supports <span className="font-semibold text-slate-500">MiniMax</span>, <span className="font-semibold text-slate-500">Fish Audio</span>, and <span className="font-semibold text-slate-500">ElevenLabs</span>. Config for all three is kept; pick the current engine at the bottom.
                </p>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Server</label>
                    <div className="flex bg-white/50 border border-slate-200/60 rounded-xl p-1 gap-1">
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('domestic')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'domestic' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            Domestic (China)
                        </button>
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('overseas')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'overseas' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            Overseas
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localMiniMaxRegion === 'overseas'
                            ? 'Overseas site (api.minimax.io) — please use a Key issued from an overseas account.'
                            : 'Domestic (api.minimaxi.com) — default, for mainland China accounts.'}
                    </p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Key (optional)</label>
                    <input type="password" name="minimax-api-secret" autoComplete="new-password" spellCheck={false} value={localMiniMaxKey} onChange={(e) => setLocalMiniMaxKey(e.target.value)} placeholder="MiniMax API Secret (leave empty to reuse the Key)" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">Calls / voice lookups prefer this Key, falling back to the general Key when left empty.</p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Group ID (optional)</label>
                    <input type="text" value={localMiniMaxGroupId} onChange={(e) => setLocalMiniMaxGroupId(e.target.value)} placeholder="group_id (required by some accounts/models)" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">If your console gave you a group_id, fill it in here; it gets passed through to the TTS request body and proxy logs.</p>
                </div>

                {/* Fish Audio — an alternate voice system on par with MiniMax, neutral styling, no visual favoritism */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Fish Audio Key</label>
                    <input type="password" name="fish-api-key" autoComplete="new-password" spellCheck={false} value={localFishKey} onChange={(e) => setLocalFishKey(e.target.value)} placeholder="Fish Audio API Key (issued from the fish.audio console)" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">Get a Key on the <a href="https://fish.audio/zh-CN/developers/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">fish.audio developer page</a> (<span className="text-amber-600 font-medium">VPN required</span>). Fill in reference_id under "Character → Voice." In a statically-deployed web environment, the Key and text to synthesize are relayed through a network Worker during synthesis — the project does not retain them.</p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">Fish Audio Model</label>
                    <select
                        value={localFishModel}
                        onChange={(e) => selectFishModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        <option value="s2.1-pro-free">s2.1-pro-free — Free (same model, $0, best for testing/personal use)</option>
                        <option value="s2.1-pro">s2.1-pro — Paid, better quality/latency, recommended for production</option>
                        <option value="s2-pro">s2-pro — Previous generation, multi-speaker / natural-language control</option>
                        <option value="s1">s1 — Legacy, (parenthesis) emotion tags</option>
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localFishModel === 's2.1-pro-free'
                            ? 'Free tier: same model as s2.1-pro, $0, but no TTFA / DPA guarantee — good for personal testing. Takes effect immediately once selected.'
                            : 'Switching takes effect immediately. A character can also override the model individually under "Character → Voice" (leave empty to use the global default here).'}
                    </p>
                </div>

                {/* ElevenLabs — Voice ID is configured on the character page; this saves the account, global model, and shared voice parameters. */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">ElevenLabs API Key</label>
                    <input
                        type="password"
                        name="elevenlabs-api-key"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={localElevenLabsKey}
                        onChange={(e) => setLocalElevenLabsKey(e.target.value)}
                        placeholder="ElevenLabs API Key"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        Create one at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">ElevenLabs API Keys</a>. Fill in the Voice ID under "Character → Voice"; web-based synthesis is relayed through the project proxy and not written to server-side storage.
                    </p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">ElevenLabs Model</label>
                    <select
                        value={localElevenLabsModel}
                        onChange={(e) => selectElevenLabsModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        {ELEVENLABS_MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        Flash v2.5 is better suited for real-time chat by default; v3 supports richer bracketed Audio Tags. The corresponding built-in voice-prompt rules switch along with it.
                    </p>

                    <details className="mt-3 rounded-xl border border-slate-200/60 bg-white/35 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 select-none">Voice Parameters (Advanced)</summary>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {([
                                ['Stability', localElevenLabsStability, setLocalElevenLabsStability],
                                ['Similarity', localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost],
                                ['Style Strength', localElevenLabsStyle, setLocalElevenLabsStyle],
                            ] as const).map(([label, value, setter]) => (
                                <label key={label} className="text-[11px] text-slate-500">
                                    <span className="flex justify-between mb-1"><span>{label}</span><span className="font-mono">{value.toFixed(2)}</span></span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={value}
                                        onChange={(e) => setter(Number(e.target.value))}
                                        className="w-full accent-primary"
                                    />
                                </label>
                            ))}
                            <label className="flex items-center justify-between gap-3 text-[11px] text-slate-500 sm:col-span-2">
                                <span>Speaker Boost (closer to the original voice, may add a little latency)</span>
                                <input
                                    type="checkbox"
                                    checked={localElevenLabsUseSpeakerBoost}
                                    onChange={(e) => setLocalElevenLabsUseSpeakerBoost(e.target.checked)}
                                    className="w-4 h-4 accent-primary"
                                />
                            </label>
                        </div>
                    </details>
                </div>

                {/* Bottom: pick one of three current voice engines — radio style (config is all above, here just picks which provider) */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5 block">Current Voice Engine (pick one)</label>
                    <p className="text-[11px] text-slate-400 mb-2.5">Which provider chat voice bubbles / dates / calls use. Config for all three above is kept — this only switches which one is currently active.</p>
                    <div className="space-y-2">
                        {([
                            ['minimax', 'MiniMax', 'Direct connection in China, default recommendation'],
                            ['fishaudio', 'Fish Audio', 'Requires a VPN, otherwise synthesis keeps failing'],
                            ['elevenlabs', 'ElevenLabs', 'Rich multilingual voices; requires access to the ElevenLabs API'],
                        ] as const).map(([key, name, desc]) => {
                            const active = localTtsProvider === key;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => selectTtsProvider(key)}
                                    className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-slate-200 bg-white/70 active:bg-white'}`}
                                >
                                    <span className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${active ? 'border-primary' : 'border-slate-300'}`}>
                                        {active && <span className="w-2 h-2 rounded-full bg-primary" />}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className={`text-sm font-semibold ${active ? 'text-primary' : 'text-slate-700'}`}>{name}</span>
                                        <span className="block text-[11px] text-slate-400 mt-0.5">{desc}</span>
                                    </span>
                                    {active && <span className="text-[10px] font-bold text-primary shrink-0">In use</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Voice prompts (advanced) — custom "voice-acting guide" injected into the character system prompt, saved separately per provider */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <button
                        type="button"
                        onClick={() => setShowVoicePrompts(v => !v)}
                        className="w-full flex items-center justify-between text-left"
                    >
                        <span>
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Voice Prompts (Advanced · Customizable)</span>
                            <span className="block text-[11px] text-slate-400 mt-0.5">Teaches the model how to write voice lines with emotion and pauses (used in chat / calls / dates). Leave empty to use the built-in default.</span>
                        </span>
                        <span className={`shrink-0 ml-2 text-slate-400 transition-transform ${showVoicePrompts ? 'rotate-180' : ''}`}>▾</span>
                    </button>

                    {showVoicePrompts && (
                        <div className="mt-3 space-y-4">
                            <p className="text-[11px] text-amber-600 leading-relaxed pl-0.5">
                                ⚠️ This is a format spec for the model (pause markers / emotion tags / action words, etc.), not the character's persona. Breaking it may cause voice-tag parsing to fail — if unsure, click "Clear" to revert to the default. Remember to click "Save" below when done.
                            </p>

                            {([
                                ['minimax', 'MiniMax Voice Guide', localVoicePromptMinimax, setLocalVoicePromptMinimax, VOICE_ACTING_GUIDE, 'Chat + calls · active when using the MiniMax engine'] as const,
                                ['fishaudio', 'Fish Audio Voice Guide', localVoicePromptFish, setLocalVoicePromptFish, FISH_VOICE_ACTING_GUIDE, 'Chat + calls · active when using the Fish Audio engine'] as const,
                                ['elevenlabs', 'ElevenLabs Voice Guide', localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs, getElevenLabsVoiceActingGuide(localElevenLabsModel), 'Chat + calls · active when using the ElevenLabs engine; the default template changes with the model'] as const,
                                ['dateVoice', 'Date Voice Emotion', localVoicePromptDate, setLocalVoicePromptDate, DATE_VOICE_GUIDE, 'Date-only [v:xxx] rules · active when a character has date voice enabled, regardless of engine'] as const,
                            ]).map(([key, title, value, setValue, def, hint]) => {
                                const active = localTtsProvider === key;
                                const usingDefault = !value.trim();
                                return (
                                    <div key={key}>
                                        <div className="flex items-center justify-between mb-1 pl-0.5">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                                {title}
                                                {active && <span className="ml-1.5 text-[9px] font-bold text-primary normal-case tracking-normal">· Current engine</span>}
                                            </label>
                                            <span className={`text-[10px] font-medium ${usingDefault ? 'text-slate-400' : 'text-primary'}`}>
                                                {usingDefault ? 'Using built-in default' : 'Customized'}
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-slate-400 mb-1.5 pl-0.5">{hint}</p>
                                        <textarea
                                            value={value}
                                            onChange={(e) => setValue(e.target.value)}
                                            placeholder="Leave empty → uses the built-in default. Click 'Load Default Template' below to fill in the built-in text and edit it."
                                            rows={6}
                                            spellCheck={false}
                                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-3 py-2.5 text-xs font-mono leading-relaxed focus:bg-white transition-all resize-y"
                                        />
                                        <div className="flex items-center justify-between mt-1.5 pl-0.5">
                                            <span className="text-[10px] text-slate-400">{value.length} chars</span>
                                            <span className="flex gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setValue(def)}
                                                    className="text-[11px] font-semibold text-slate-500 hover:text-primary active:scale-95 transition-all"
                                                >
                                                    Load Default Template
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setValue('')}
                                                    disabled={usingDefault}
                                                    className="text-[11px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all disabled:opacity-30 disabled:pointer-events-none"
                                                >
                                                    Clear (revert to default)
                                                </button>
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="group">
                    <div className="flex items-center justify-between mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Songwriting · Replicate Token (optional)</label>
                        <button
                            type="button"
                            onClick={() => setShowAceStepGuide(v => !v)}
                            className="text-[10px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all flex items-center gap-1"
                        >
                            {showAceStepGuide ? 'Collapse' : 'How do I get one?'}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${showAceStepGuide ? 'rotate-180' : ''}`}>
                                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    <input type="password" name="ace-step-api-token" autoComplete="new-password" spellCheck={false} value={localAceStepKey} onChange={(e) => setLocalAceStepKey(e.target.value)} placeholder="r8_xxx (used by the Songwriting App to call ACE-Step for a full song)" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">Once filled in, the Songwriting App's lyrics page can call ACE-Step with one click to generate a full song with real vocals (about ¥0.1/song). During generation, the Token, lyrics, and style parameters are relayed to Replicate through a network Worker — the project does not retain them.</p>

                    {showAceStepGuide && (
                        <div className="mt-3 rounded-2xl overflow-hidden border border-rose-200/60 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 shadow-sm animate-slide-down">
                            <div className="px-4 pt-3.5 pb-2 flex items-center gap-2 border-b border-rose-200/40">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white flex items-center justify-center text-base shadow-sm shadow-rose-500/30">🎤</div>
                                <div className="flex-1">
                                    <div className="text-[12px] font-bold text-stone-700">Get a Replicate Token in 3 Steps</div>
                                    <div className="text-[10px] text-stone-500">Let ACE-Step sing the song for you</div>
                                </div>
                            </div>
                            <div className="px-4 py-3 space-y-2.5">
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">1</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">Sign up for a Replicate account</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">Fastest with one-click GitHub sign-in. No email verification needed.</p>
                                        <a
                                            href="https://replicate.com/signin"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-rose-600 hover:text-rose-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-rose-200/50"
                                        >
                                            Open Sign-Up Page
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-orange-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">2</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">Copy the API Token</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">After logging in, go to Account → API Tokens, and copy the string starting with <span className="font-mono text-rose-600">r8_</span>.</p>
                                        <a
                                            href="https://replicate.com/account/api-tokens"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-orange-200/50"
                                        >
                                            Open Token Page
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">3</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">Add a card and top up (required)</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">Replicate has no free trial credit, you need to add a credit card first. <span className="text-rose-600 font-semibold">Mainland China cards mostly do not work</span> — a US-region Visa/MC card is recommended. A minimum $1 top-up (about ¥7.3) covers roughly 50-100 songs.</p>
                                    </div>
                                </div>
                                <div className="mt-2 pt-2.5 border-t border-rose-200/40 flex gap-2 items-start">
                                    <span className="text-rose-500 text-sm leading-none mt-0.5">💡</span>
                                    <p className="text-[11px] text-stone-500 leading-relaxed">
                                        Paste it into the field above → click Save Configuration → open the Songwriting App, open any song's preview page → tap "AI Generate Song" at the bottom.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <button onClick={handleSaveOtherApis} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-amber-500/20 bg-amber-500 active:scale-95 transition-all mt-2">
                    {otherStatusMsg || 'Save Other APIs'}
                </button>
            </div>
        </SettingsSection>

        {/* Real-time Perception config section */}
        <SettingsSection
            title="Real-time Perception"
            icon={
                <div className="p-2 bg-violet-100/50 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { trackEvent('Open Real-time Perception Settings'); setShowRealtimeModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    Configure
                </button>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                Let the AI character perceive the real world: weather, trending news, current time. The character can check in about the weather or chat about recent trending topics.
            </p>

            <div className="grid grid-cols-5 gap-2 text-center">
                <div className={`py-3 rounded-xl text-xs font-bold ${rtWeatherEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtWeatherEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f32b.png" className="w-5 h-5 inline" alt="" />}</div>
                    Weather
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNewsEnabled ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNewsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f0.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" className="w-5 h-5 inline" alt="" />}</div>
                    News
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNotionEnabled ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNotionEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Notion
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtFeishuEnabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtFeishuEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d2.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Feishu
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtXhsEnabled ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtXhsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Xiaohongshu
                </div>
            </div>
        </SettingsSection>

        {/* General MCP, independent of Real-time Perception */}
        <SettingsSection
            title="MCP"
            badge={<span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-bold shrink-0">Local Config</span>}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <PlugsConnected size={16} weight="fill" />
                </div>
            }
            actions={
                <>
                    <button
                        onClick={() => { trackEvent('Open "What Is MCP" Explainer'); setShowMcpHelp(true); }}
                        aria-label="What is MCP?"
                        className="w-7 h-7 rounded-full border border-slate-200 bg-white text-[12px] font-bold text-slate-400 active:scale-90 transition-all"
                    >?</button>
                    <button onClick={() => { trackEvent('Open MCP Tool Server Settings'); setShowMcpModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                        Manage
                    </button>
                </>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                Connect standard MCP servers so chat can call tools like knowledge bases, search, notes, or smart home devices.
            </p>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed border-l-2 border-violet-200 pl-2">
                Requires setting up a Streamable HTTP service yourself; leaving it unconfigured does not affect built-in Sully, memory, or normal chat.
            </p>
            {(() => {
                const list = loadMcpServers();
                if (!list.length) return null;
                const on = list.filter(s => s.enabled && s.tools?.length);
                const toolCount = on.reduce((n, s) => n + (s.tools?.length || 0), 0);
                return (
                    <p className="text-[10px] text-slate-400 mt-2">
                        {list.length} server(s) configured · {on.length} enabled{toolCount ? ` · ${toolCount} tools total` : ''}
                    </p>
                );
            })()}
        </SettingsSection>

        {/* ───────── Push Credentials (VAPID) ───────── */}
        {/* VAPID public/private key pair, shared with Proactive / Instant Push — kept as its own section to */}
        {/* avoid being mistaken for a sub-config of Instant Push, and to avoid the two sides' keys getting out */}
        {/* of sync and fighting over the same pushManager subscription. */}
        {/* vapidReadyTick: +1 after the VAPID modal closes, so this node re-renders and re-reads isPushVapidReady(). */}
        <SettingsSection
            title="Push Credentials (VAPID)"
            sectionProps={{ 'data-vapid-tick': vapidReadyTick }}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isPushVapidReady() ? 'bg-violet-100 text-violet-600' : 'bg-rose-100 text-rose-600'}`}>
                    {isPushVapidReady() ? 'Configured' : 'Not Configured'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                Proactive Push and Instant Push <b>share the same VAPID key pair</b>. Regenerating it invalidates any push already turned on, which will need to be re-enabled.
            </p>
            <button
                type="button"
                onClick={() => setShowVapidModal(true)}
                className={`w-full py-2.5 rounded-xl text-xs font-bold ${isPushVapidReady() ? 'bg-white text-violet-700 border border-violet-200 hover:bg-violet-50' : 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-200'}`}
            >
                {isPushVapidReady() ? 'View / Regenerate' : 'Generate a VAPID Key Pair →'}
            </button>
        </SettingsSection>

        {/* ───────── Push Subscription Status (diagnostics + reset) ───────── */}
        <SettingsSection
            title="Push Subscription Status"
            icon={
                <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
                    </svg>
                </div>
            }
        >
            <PushSubscriptionPanel addToast={addToast} />
        </SettingsSection>

        {/* ───────── Proactive Message Push Accelerator (toggle) ───────── */}
        {SHOW_PROACTIVE_PUSH_ACCEL_UI && ppAvailable && (
        <SettingsSection
            title="Proactive Message Push Boost"
            icon={
                <div className="p-2 bg-teal-100/60 rounded-xl text-teal-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ppEnabled ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-400'}`}>
                    {ppEnabled ? 'Enabled' : 'Not Enabled'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                Lets proactive messages still fire on time even in a backgrounded browser tab. The AI still generates locally — the cloud just handles "wake the browser up when it's time."
                It can't wake the browser once its process is fully closed — the next time you open the app, it automatically catches up on any missed proactive messages,
                so what you see is "open the app and it's there," never a mid-nowhere popup interrupting you.
            </p>

            {ppStatus && (
                <div className={`mb-3 p-3 rounded-xl text-xs font-medium text-center ${ppStatus.includes('success') || ppStatus.includes('succeeded') || ppStatus.includes('Enabled') || ppStatus.includes('OK') || ppStatus.includes('ok') ? 'bg-emerald-100 text-emerald-700' : ppStatus.includes('fail') || ppStatus.includes('Fail') || ppStatus.includes('error') || ppStatus.includes('Error') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                    {ppStatus}
                </div>
            )}

            <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                <div>
                    <p className="text-[11px] text-slate-600 font-medium">Enable Push Boost</p>
                    <p className="text-[10px] text-slate-400">Falls back to a purely local timer when off</p>
                </div>
                <button
                    disabled={ppBusy}
                    onClick={() => {
                        if (ppBusy) return;
                        trackEvent('Toggle Proactive Message Push Boost', { action: ppEnabled ? 'disable' : 'enable' });
                        if (ppEnabled) {
                            void doDisablePushAccelerator();
                        } else {
                            setShowPpConfirm(true);
                        }
                    }}
                    className={`w-10 h-5 rounded-full transition-colors ${ppEnabled ? 'bg-teal-500' : 'bg-slate-300'} ${ppBusy ? 'opacity-60' : ''}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${ppEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            {/* ───── Diagnostics panel ───── */}
            <div className="mt-4 bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-slate-600">Web Push Status</p>
                    <button
                        onClick={() => {
                            // All fixed enums of browser/device state — never includes the endpoint address or any user config value
                            trackEvent('Refresh Web Push Diagnostics', ppDiag ? {
                                permission: ppDiag.permission,
                                subscription: !ppDiag.endpoint ? 'none' : ppDiag.endpointDead ? 'dead' : 'active',
                                swState: ppDiag.swState === 'activated' ? 'activated' : ppDiag.swState === 'none' ? 'none' : 'other',
                                platform: ppDiag.capacitorNative ? 'capacitor_native' : ppDiag.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                            } : undefined);
                            void refreshPpDiag();
                        }}
                        className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50"
                    >
                        Refresh
                    </button>
                </div>

                {ppDiag ? (
                    <div className="space-y-1.5 text-[11px]">
                        <DiagRow
                            label="Browser Support"
                            value={
                                ppDiag.capacitorNative ? 'No (currently running inside the App)' :
                                ppDiag.supported ? 'Yes' : 'No (browser is missing push-related APIs)'
                            }
                            bad={!ppDiag.supported || ppDiag.capacitorNative}
                        />
                        <DiagRow
                            label="Notification Permission"
                            value={
                                ppDiag.permission === 'granted' ? 'Granted' :
                                ppDiag.permission === 'denied' ? 'Denied (please enable manually in your browser site settings)' :
                                ppDiag.permission === 'default' ? 'Undecided' :
                                'Unavailable'
                            }
                            bad={ppDiag.permission !== 'granted'}
                        />
                        <DiagRow
                            label="Service Worker"
                            value={
                                ppDiag.swState === 'activated' ? `Activated (scope: ${ppDiag.swScope || '?'})` :
                                ppDiag.swState === 'none' ? 'Not registered' :
                                `${ppDiag.swState} (scope: ${ppDiag.swScope || '?'})`
                            }
                            bad={ppDiag.swState !== 'activated'}
                        />
                        <DiagRow
                            label="Subscription"
                            value={
                                !ppDiag.endpoint ? 'None' :
                                ppDiag.endpointDead ? 'Dead (zombie endpoint)' :
                                'Established'
                            }
                            bad={!ppDiag.endpoint || ppDiag.endpointDead}
                        />
                        <DiagRow label="Push Channel" value={ppDiag.channel} />
                        <DiagRow
                            label="Last Wake"
                            value={
                                ppDiag.lastWakeAt
                                    ? `${new Date(ppDiag.lastWakeAt).toLocaleString()}${ppDiag.lastWakeChar ? ` (${ppDiag.lastWakeChar})` : ''}`
                                    : 'Never'
                            }
                        />
                        {ppDiag.endpoint && (
                            <div className="pt-2 mt-2 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 mb-1">Subscription Endpoint (first 60 characters)</p>
                                <p className={`text-[10px] font-mono break-all leading-relaxed ${ppDiag.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>{ppDiag.endpoint.slice(0, 60)}…</p>
                            </div>
                        )}
                        {ppDiag.endpointDead && (
                            <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                                The subscription address is <code className="font-mono">permanently-removed.invalid</code> — the browser has already revoked this subscription
                                (common causes: long inactivity, notification permission was toggled, browser cleared site data).<br/>
                                This domain is an RFC-reserved TLD that never resolves anywhere; when the Worker tries to deliver a push there, it gets back HTTP 530.<br/>
                                Clicking <b>"Reset Subscription"</b> below clears this dead subscription and rebuilds a new one.
                            </div>
                        )}
                        {ppDiag.iosNeedsPwa && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                Detected iOS Safari, but this is not currently a PWA added to the home screen.<br/>
                                iOS Web Push only works after the site has been "Added to Home Screen" and launched from there.
                            </div>
                        )}
                        {ppDiag.capacitorNative && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                You are currently running inside the <b>packaged App</b> (not a browser web page).<br/>
                                This "Push Boost" only applies to the web version — the App has no web push channel, but this <b>does not affect normal use</b>:
                                proactive messages are sent through the App's local notifications, which arrive even while the App is backgrounded/locked.<br/>
                                The "Send Test Push / Reset Subscription" buttons below do nothing when tapped inside the App — feel free to ignore this panel there.
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-[10px] text-slate-400">Loading…</p>
                )}

                {(() => {
                    const inDeepMode = ppZombieStreak >= 3;
                    const resetLabel = inDeepMode
                        ? (ppDeepResetBusy ? 'Deep resetting…' : 'Deep Reset')
                        : (ppResetBusy ? 'Resetting…' : 'Reset Subscription');
                    const resetBusy = ppResetBusy || ppDeepResetBusy;
                    return (
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            <button
                                disabled={ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative}
                                onClick={() => void doSendTestPush()}
                                className={`py-2 rounded-xl text-xs font-bold ${ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative ? 'bg-slate-200 text-slate-400' : 'bg-teal-500 text-white hover:bg-teal-600'}`}
                            >
                                {ppTestBusy ? 'Testing…' : 'Send a Test Push'}
                            </button>
                            <button
                                disabled={resetBusy || ppTestBusy || ppDiag?.capacitorNative}
                                onClick={() => inDeepMode ? void doDeepResetSubscription() : void doResetSubscription()}
                                className={`py-2 rounded-xl text-xs font-bold border ${resetBusy || ppTestBusy || ppDiag?.capacitorNative ? 'bg-slate-100 text-slate-400 border-slate-200' : inDeepMode || ppDiag?.endpointDead ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                            >
                                {resetLabel}
                            </button>
                        </div>
                    );
                })()}
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    "Send a Test Push" makes the Worker send a push to this device right away — a "Push test succeeded" system notification within 5 seconds means the pipe is working.
                    "Reset Subscription" clears the old subscription and builds a new one — good after a subscription goes stale or you switch browsers.
                    {ppZombieStreak >= 3 && <><br/>Several attempts in a row have not worked, so it has switched to "Deep Reset" — click it for a more thorough cleanup.</>}
                </p>
            </div>
        </SettingsSection>
        )}

        {/* ───────── Instant Push ───────── */}
        <SettingsSection
            title="Instant Push"
            icon={
                <div className="p-2 bg-indigo-100/60 rounded-xl text-indigo-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 0 1 0-5.303m5.304 0a3.75 3.75 0 0 1 0 5.303m-7.425 2.122a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.789M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                    </svg>
                </div>
            }
            actions={
                <button
                    onClick={() => { trackEvent('Open Instant Push Settings'); setShowInstantModal(true); }}
                    className="text-[10px] bg-indigo-100 text-indigo-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    Configure
                </button>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                Different from the Push Booster above: the frontend sends the prompt to your own self-deployed Worker, which calls your own LLM to generate a reply and then Web Pushes it sentence by sentence. Zero database, zero cron.
            </p>
        </SettingsSection>

        {/* ───────── Proactive Message 2.0 (scheduled push) ───────── */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">Proactive Message 2.0</h2>
                </div>
                <button
                    onClick={() => { trackEvent('Open Proactive Message 2.0 Settings'); setShowAmsg2Modal(true); }}
                    className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    Configure
                </button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
                The character automatically messages you when it is time, receivable even with the App closed. Requires deploying your own Cloudflare Worker (comes with a D1 database + scheduled triggers) — just fill in the address in settings. It handles both cloud-hosted chat (Instant Chat) and scheduled proactive messages.
            </p>
        </section>

        {/* Custom network proxy — a deliberately low-key advanced entry point. Collapsed by default, essentially undiscoverable without being pointed to it.
            Ordinary users never need to configure this: everything works out of the box using the author's deployed public Worker by default. */}
        {!showProxyConfig ? (
            <button
                onClick={() => setShowProxyConfig(true)}
                className="w-full text-center text-[10px] text-slate-300 hover:text-slate-400 py-1 transition-colors"
            >
                · Custom Network Proxy ·
            </button>
        ) : (
            <section ref={proxyConfigSectionRef} className="scroll-mt-4 bg-white/60 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-xs font-semibold text-slate-500">Custom Network Proxy (Worker)</h2>
                    <button onClick={() => { setShowProxyConfig(false); setProxyWorkerInput(getProxyWorkerUrl()); }} className="text-[10px] text-slate-400">Collapse</button>
                </div>

                <div className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-2 mb-3 leading-relaxed">
                    <b>You usually don't need to change this.</b> The default address handles internet-connected features that need cross-origin forwarding in a statically-deployed web environment;
                    GitHub backup still connects directly by default, only using the Worker after you actively turn on the relay in backup settings.
                    If you have deployed your own <b>worker/index.js</b>, you can switch to your own instance here.
                </div>

                <div className="mb-3 rounded-xl border border-sky-100 bg-sky-50/80 px-3 py-2.5 text-[10px] leading-relaxed text-sky-900">
                    <p className="mb-1.5 font-bold">Deploy Your Own Worker</p>
                    <ol className="space-y-1">
                        <li><b>1.</b> In the Cloudflare dashboard, go to Workers &amp; Pages and create a new Worker.</li>
                        <li><b>2.</b> Open and copy the full <a href={PROXY_WORKER_SOURCE_URL} target="_blank" rel="noreferrer" className="font-bold underline underline-offset-2">worker/index.js source</a>, replace the default code in the editor, then deploy.</li>
                        <li><b>3.</b> Copy the resulting <b>https://xxx.workers.dev</b> address, paste it below, and save.</li>
                    </ol>
                </div>

                <input
                    type="text"
                    value={proxyWorkerInput}
                    onChange={(e) => setProxyWorkerInput(e.target.value)}
                    placeholder={DEFAULT_PROXY_WORKER}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200 mb-2"
                />

                <div className="grid grid-cols-2 gap-2">
                    <button onClick={handleResetProxyWorker} className="py-2 bg-slate-100 rounded-xl text-[11px] font-bold text-slate-500 active:scale-95 transition-transform">
                        Restore Default
                    </button>
                    <button onClick={handleSaveProxyWorker} className="py-2 bg-slate-700 rounded-xl text-[11px] font-bold text-white active:scale-95 transition-transform">
                        Save
                    </button>
                </div>

                <p className="text-[10px] text-slate-400 px-1 mt-2 leading-relaxed">
                    Only fill in up to the domain (e.g. <b>{DEFAULT_PROXY_WORKER}</b>), without paths like /search, /webdav, /api.
                    Web search / backup proxy / Notion / Feishu / ordering / web scraping / image generation / Xiaohongshu Lite / music will all switch to the Worker filled in here.
                    (The music player still has its own separate address box — filling that in separately takes priority for it.)
                </p>
            </section>
        )}

        {/* ───────── Usage Analytics ─────────
            Only shown in builds with analytics environment variables configured. A self-hosted instance
            never sends a single analytics request to begin with — giving it an unremovable, functionless
            toggle would only make people more suspicious. */}
        {isAnalyticsConfigured() && (
        <SettingsSection
            title="Usage Analytics"
            icon={
                <div className="p-2 bg-slate-100/60 rounded-xl text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-slate-600">Participate in Usage Analytics</span>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                            type="checkbox"
                            checked={analyticsEnabled}
                            onChange={e => {
                                setAnalyticsEnabledState(e.target.checked);
                                setAnalyticsEnabled(e.target.checked);
                            }}
                            className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-500"></div>
                    </label>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                    Only counts "which page was opened, which feature was used once," which bucket your memory count / character count falls into,
                    and how long this device took to open the page (milliseconds measured by the browser itself).
                    Never touches any conversation, memory, or settings between you and a character, never touches any text you type, never touches API or MCP config.
                </p>
                <p className="text-xs text-slate-500 leading-relaxed">
                    SullyOS already has more features than even we can keep track of, but "which ones people actually use, where people get stuck configuring"
                    is mostly guesswork. Keeping this toggle on helps us see that clearly, so we can focus effort where it is actually used.
                    Turn it off if you would rather not participate — it has zero effect on functionality.
                </p>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                    If your browser has Do Not Track on, this is automatically skipped without touching this toggle.
                    Turning it off stops sending immediately, and the analytics script itself won't even load on the next launch. If you want to verify it yourself, open the Network panel with F12 —
                    every request this page sends, and what's in it, is right there in your own browser.
                </p>
            </div>
        </SettingsSection>
        )}

        <VersionInfo />

      </div>

      {/* Proactive Message Push Boost · confirm before enabling */}
      <Modal
          isOpen={showPpConfirm}
          title="Enable Push Boost?"
          onClose={() => setShowPpConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button
                      onClick={() => { trackEvent('Choice Made in Push Boost Enable Confirm Dialog', { choice: 'cancel' }); setShowPpConfirm(false); }}
                      className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl"
                  >
                      Cancel
                  </button>
                  <button
                      onClick={() => {
                          trackEvent('Choice Made in Push Boost Enable Confirm Dialog', { choice: 'confirm' });
                          setShowPpConfirm(false);
                          void doEnablePushAccelerator();
                      }}
                      className="flex-1 py-3 bg-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-teal-200"
                  >
                      Got it, enable
                  </button>
              </div>
          }
      >
          <div className="space-y-3 text-[12px] leading-relaxed text-slate-600">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="font-bold text-amber-800 mb-1">Three things happen once enabled</p>
                  <ol className="list-decimal pl-4 space-y-1 text-amber-900">
                      <li>The browser will pop up a system dialog asking <b>"Allow notifications?"</b> — please click "Allow," otherwise it can't wake up in the background</li>
                      <li>The browser generates a <b>push subscription credential</b> (just a "doorbell address," containing no chat content) and uploads it to Cloudflare</li>
                      <li>While this app's tab is open, it sends Cloudflare a heartbeat every 2 minutes; Cloudflare automatically stops pinging you 5 minutes after it's closed</li>
                  </ol>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <p className="font-bold text-emerald-800 mb-1">Who can see what</p>
                  <div className="space-y-1.5 text-emerald-900">
                      <p><b>What Cloudflare can see:</b> the push subscription credential + character ID (a random string) + interval in minutes. <b>Cannot see</b> chat content, character personas, AI replies, API keys, or who you are.</p>
                      <p><b>Browser vendors' push services (Google / Mozilla / Apple):</b> know that you received a push at a certain time; the content is encrypted and unreadable to them.</p>
                      <p><b>Your AI API provider:</b> exactly like normal chat — when it's time, the browser calls the endpoint you filled in under "API Configuration" directly and <b>locally</b>, using your own key. Cloudflare has no part in this step at all.</p>
                  </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="font-bold text-slate-700 mb-1">In one sentence</p>
                  <p className="text-slate-700">Chat history and AI requests stay strictly between you and your AI provider, exactly the same as when Push Boost is off. Cloudflare is just an alarm clock that "rings the doorbell when it's time."</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <p className="font-bold text-blue-800 mb-1">Never pops up a notification to interrupt you</p>
                  <p className="text-blue-900">Browser tab in background → fires silently, you see it when you open the app. Browser fully closed → automatically catches up next time you open the app, so it's already there. No "someone's looking for you" window pops up in between to bother you.</p>
              </div>
          </div>
      </Modal>

      {/* Cloud Config Modal */}
      <Modal isOpen={showCloudModal} title="Cloud Backup Configuration" onClose={() => setShowCloudModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
                  <p className="text-[10px] text-rose-700 leading-relaxed">
                      <b>🪜 VPN required</b><br/>
                      InfiniCloud is a Japan-based service — connecting directly from mainland China usually can't reach the sign-up page or sync backups. <b>Keep a VPN on for sign-up and every sync afterward</b>, otherwise it will fail to connect or time out.
                  </p>
              </div>
              <div className="bg-sky-50 rounded-xl p-3">
                  <p className="text-[10px] text-sky-700 leading-relaxed">
                      <b>Quick start (InfiniCloud, free 20GB):</b><br/>
                      1. Sign up at <a href="https://infini-cloud.net/" target="_blank" rel="noopener noreferrer" className="text-sky-600 underline font-bold hover:text-sky-800">infini-cloud.net ↗</a> (email verification)<br/>
                      2. After logging in, go to the bottom of <b>My Page</b> → check <b>Turn on Apps Connection</b><br/>
                      3. Top bar <b>Apps</b> → copy the <b>WebDAV URL</b> / <b>Connection ID</b> / <b>Apps Password</b><br/>
                      4. Fill in <b>Connection ID</b> (not your email) as the username, and <b>Apps Password</b> as the password
                  </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ Apps Password ≠ login password</b><br/>
                      <b>Apps Password</b> is a <b>copyable</b> app-specific password shown <b>below</b> <b>WebDAV URL</b> and <b>Connection ID</b> on the <b>Apps</b> page — scroll down to find it. Just copy-paste it directly into the "Password" box above; using your account login password will get a 401.
                  </p>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">WebDAV Address</label>
                  <input type="url" value={cbUrl} onChange={(e) => setCbUrl(e.target.value)} placeholder="https://xxx.infini-cloud.net/dav/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">Username</label>
                      <input type="text" value={cbUsername} onChange={(e) => setCbUsername(e.target.value)} placeholder="Email or username" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">Password</label>
                      <input type="password" value={cbPassword} onChange={(e) => setCbPassword(e.target.value)} placeholder="App-specific password" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">Backup Directory</label>
                  <input type="text" value={cbPath} onChange={(e) => setCbPath(e.target.value)} placeholder="/SullyBackup/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <button onClick={handleTestCloudConnection} disabled={cloudTesting || !cbUrl || !cbUsername || !cbPassword} className="w-full py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 disabled:opacity-40">
                  {cloudTesting ? 'Testing...' : 'Test Connection'}
              </button>
              {cloudTestResult && (
                  <p className={`text-[11px] text-center font-medium ${cloudTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>{cloudTestResult}</p>
              )}
              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowCloudModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">Cancel</button>
                  <button onClick={handleSaveCloudConfig} disabled={!cbUrl || !cbUsername || !cbPassword} className="py-2.5 bg-sky-500 rounded-xl text-xs font-bold text-white disabled:opacity-40">Save Configuration</button>
              </div>
              {cloudBackupConfig.enabled && (
                  <button onClick={() => { trackEvent('Disable Cloud Backup', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' }); updateCloudBackupConfig({ enabled: false }); setShowCloudModal(false); addToast('Cloud backup disabled', 'info'); }} className="w-full py-2 text-[11px] text-red-400 font-medium">Disable Cloud Backup</button>
              )}
          </div>
      </Modal>

      {/* GitHub Backup Modal — minimum-input flow: paste a token, we figure
          out owner via /user and auto-create a private 'sully-backup' repo. */}
      <Modal isOpen={showGithubModal} title="GitHub Backup" onClose={() => setShowGithubModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-slate-700 leading-relaxed">
                      <b>Connect GitHub in three steps:</b><br/>
                      ① Click the button below to go create a Token on GitHub<br/>
                      ② Copy the token, come back and paste it in the box below<br/>
                      ③ Click <b>Test & Connect</b> — we'll automatically create the private repo <code className="bg-white px-1 rounded">{ghRepo || 'sully-backup'}</code> for you
                  </p>
                  <p className="text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      <b>A successful connection doesn't guarantee uploads will always go through.</b> GitHub's web page, account API, and ZIP attachment upload use
                      <code className="mx-0.5 bg-white px-1 rounded">github.com</code>,
                      <code className="mx-0.5 bg-white px-1 rounded">api.github.com</code>, and
                      <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code> respectively.
                      Different networks, VPN split-routing, and iOS PWAs may only cover some of these, so you can see "the page loads but uploads fail" or "it breaks specifically with the VPN on."
                  </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ Only change one thing on that GitHub page:</b><br/>
                      Change the <b>Expiration</b> dropdown <b>from 90 days to No expiration</b>.
                      If you don't, the token expires after 90 days and backups will suddenly start getting 401s.<br/>
                      Leave everything else alone — the Note is already filled in as "Sully Backup," the <b>repo</b> scope is already checked,
                      just scroll to the bottom and click the green <b>Generate token</b> button.
                  </p>
              </div>

              <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Sully%20%E5%A4%87%E4%BB%BD"
                  target="_blank" rel="noopener noreferrer"
                  onClick={() => trackEvent('Go to GitHub to Create Token')}
                  className="block w-full py-3 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold text-center shadow-sm active:scale-95 transition-all"
              >
                  ① Go to GitHub to Create a Token ↗
              </a>

              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">② Personal Access Token</label>
                  <input
                      type="password"
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 focus:ring-1 focus:ring-slate-300 outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                      The Token is saved in local config. GitHub connects directly by default; if the attachment domain isn't reachable, turn on the in-app relay under Advanced Options below.
                      Only after you turn it on manually does the Token pass through the selected Worker with GitHub requests — the project does not retain it.
                  </p>
              </div>

              <button
                  onClick={handleTestGithub}
                  disabled={ghTesting || !ghToken.trim()}
                  className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all disabled:opacity-40"
              >
                  {ghTesting ? 'Connecting...' : '③ Test & Connect'}
              </button>
              {ghTestResult && (
                  <p className={`text-[11px] text-center font-medium ${ghTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>
                      {ghTestResult}
                  </p>
              )}
              {ghTestResult.startsWith('✓') && cloudBackupConfig.githubOwner && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                      <p className="text-[11px] text-emerald-800 font-medium">
                          🎉 Backups will upload here:
                      </p>
                      <a
                          href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                          target="_blank" rel="noopener noreferrer"
                          className="block text-[10px] text-emerald-700 font-mono break-all underline hover:text-emerald-900"
                      >
                          github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases ↗
                      </a>
                      <p className="text-[10px] text-emerald-700 leading-relaxed">
                          Each backup creates a new release (timestamped). Go to this URL to view / delete old backups.
                      </p>
                  </div>
              )}

              <button
                  onClick={() => { if (!ghShowAdvanced) trackEvent('Expand GitHub Advanced Options'); setGhShowAdvanced(v => !v); }}
                  className="w-full text-[10px] text-slate-400 underline-offset-2 hover:underline"
              >
                  {ghShowAdvanced ? 'Collapse Advanced Options ▲' : 'Advanced Options ▼'}
              </button>
              {ghShowAdvanced && (
                  <div className="space-y-3 bg-slate-50 rounded-xl p-3">
                      <div>
                          <label className="text-[11px] text-slate-500 font-medium mb-1 block">Backup Repository Name</label>
                          <input
                              type="text"
                              value={ghRepo}
                              onChange={(e) => setGhRepo(e.target.value)}
                              placeholder="sully-backup"
                              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 outline-none"
                          />
                          <p className="text-[10px] text-slate-400 mt-1">Automatically created as a private repository if it doesn't exist.</p>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                          <input
                              type="checkbox"
                              checked={ghUseProxy}
                              onChange={(e) => handleGithubProxyToggle(e.target.checked)}
                              className="rounded"
                          />
                          <span>In-app Cloudflare relay (a separate thing from your phone's/computer's VPN)</span>
                      </label>
                      <p className="text-[10px] text-slate-500 leading-relaxed pl-5">
                          <b>{ghUseProxy ? 'Current route: browser → Cloudflare Worker → GitHub.' : 'Current route: browser → GitHub directly.'}</b>
                          The checkbox state saves immediately, no need to reconnect. Your system VPN may miss
                          <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code> due to rule-based split-routing, node selection, or the PWA not covering it; the in-app relay is a separate independent route, which some networks may also block.
                      </p>
                      <p className="text-[10px] text-slate-400 leading-relaxed pl-5">
                          The relay only forwards traffic — backups still live in your own private GitHub repo; the project does not maintain a backup database and does not retain your Token or backup files.
                          Files larger than 32MB are automatically chunked and published once all parts complete.
                      </p>
                  </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowGithubModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">Close</button>
                  {cloudBackupConfig.enabled && cloudBackupConfig.provider === 'github' ? (
                      <button onClick={handleDisableCloud} className="py-2.5 bg-red-50 text-red-500 rounded-xl text-xs font-bold">Disconnect GitHub</button>
                  ) : (
                      <button
                          onClick={() => setShowGithubModal(false)}
                          disabled={!cloudBackupConfig.enabled || cloudBackupConfig.provider !== 'github'}
                          className="py-2.5 bg-slate-800 text-white rounded-xl text-xs font-bold disabled:opacity-30"
                      >
                          Done
                      </button>
                  )}
              </div>
          </div>
      </Modal>

      {/* Cloud Restore Modal */}
      <Modal isOpen={showCloudRestoreModal} title="Restore From Cloud" onClose={() => setShowCloudRestoreModal(false)}>
          <div className="space-y-2 p-1">
              {cloudBackupListState === 'loading' ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">Loading cloud backup list...</p></div>
              ) : cloudBackupListState === 'error' ? (
                  <div className="text-center py-7 px-3 space-y-3">
                      <p className="text-[11px] text-red-500 leading-relaxed">{cloudBackupListError || 'Failed to fetch cloud backup list'}</p>
                      <button onClick={handleOpenCloudRestore} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-[11px] font-bold">Reload</button>
                  </div>
              ) : cloudBackupListState === 'ready' && cloudBackupFiles.length === 0 ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">No backups in the cloud yet</p></div>
              ) : (
                  <>
                      <p className="text-[10px] text-slate-400 mb-2">Select a backup file to restore:</p>
                      <div className="max-h-[50vh] overflow-y-auto space-y-2">
                          {cloudBackupFiles.map((file, i) => file.status === 'incomplete' ? (
                              <div key={file.href || i} className="w-full p-3 bg-amber-50/70 border border-amber-200 rounded-xl text-left">
                                  <div className="flex items-start justify-between gap-2">
                                      <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-bold">Upload incomplete</span>
                                  </div>
                                  <p className="text-[10px] text-amber-700 mt-1 leading-relaxed">{file.statusMessage || 'Attachment is incomplete, cannot restore'}</p>
                                  <div className="flex items-center justify-between gap-3 mt-2">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('en-US') : 'Unknown time'}</span>
                                      {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                                          <a
                                              href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-[10px] text-amber-700 font-semibold hover:underline"
                                          >View on GitHub ↗</a>
                                      )}
                                  </div>
                              </div>
                          ) : (
                              <button key={file.href || i} onClick={() => handleCloudRestore(file)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-left hover:bg-sky-50 hover:border-sky-200 transition-colors active:scale-[0.98]">
                                  <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('en-US') : 'Unknown time'}</span>
                                      <span className="text-[10px] text-slate-400">{file.size > 0 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                                  </div>
                              </button>
                          ))}
                      </div>
                  </>
              )}
          </div>
      </Modal>

      {/* Model Picker Modal */}
      <Modal isOpen={showModelModal} title="Select Model" onClose={() => setShowModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = modelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localModel}
                            onChange={(e) => setLocalModel(e.target.value)}
                            placeholder="Manually enter a model name..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowModelModal(false)}
                            className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            OK
                        </button>
                    </div>
                    {availableModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={modelFilter}
                                onChange={(e) => setModelFilter(e.target.value)}
                                placeholder={`🔍 Search ${availableModels.length} models...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-primary focus:bg-white transition-all"
                            />
                            {modelFilter && (
                                <button
                                    onClick={() => setModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>Common prefix:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(dimmed below)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(m => {
                            const suffix = commonPrefix && m.startsWith(commonPrefix) ? m.slice(commonPrefix.length) : m;
                            const selected = m === localModel;
                            return (
                                <button
                                    key={m}
                                    onClick={() => { setLocalModel(m); setShowModelModal(false); }}
                                    title={m}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-primary/10 text-primary font-bold ring-1 ring-primary/20' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== m && (
                                            <span className={selected ? 'text-primary/40 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0"></div>}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableModels.length === 0
                                    ? 'List is empty — you can enter one manually or click "Refresh Model List" to fetch'
                                    : `No models matching "${modelFilter}"`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* The Image Recognition API uses a separate model list, to avoid overwriting the main API's model selection. */}
      <Modal isOpen={showVisionModelModal} title="Select Image Recognition Model" onClose={() => setShowVisionModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = visionModelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localVisionModel}
                            onChange={(event) => {
                                setLocalVisionModel(event.target.value);
                                setSelectedVisionPresetId(null);
                                setVisionTestResult(null);
                            }}
                            placeholder="Manually enter a vision model name..."
                            className="flex-1 min-w-0 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-violet-500 focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowVisionModelModal(false)}
                            className="px-4 py-2.5 bg-violet-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            OK
                        </button>
                    </div>
                    {availableVisionModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={visionModelFilter}
                                onChange={(event) => setVisionModelFilter(event.target.value)}
                                placeholder={`🔍 Search ${availableVisionModels.length} vision models...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-violet-500 focus:bg-white transition-all"
                            />
                            {visionModelFilter && (
                                <button
                                    onClick={() => setVisionModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >×</button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>Common prefix:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(dimmed below)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(model => {
                            const suffix = commonPrefix && model.startsWith(commonPrefix) ? model.slice(commonPrefix.length) : model;
                            const selected = model === localVisionModel;
                            return (
                                <button
                                    key={model}
                                    onClick={() => {
                                        setLocalVisionModel(model);
                                        setSelectedVisionPresetId(null);
                                        setVisionTestResult(null);
                                        setShowVisionModelModal(false);
                                    }}
                                    title={model}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-violet-100 text-violet-700 font-bold ring-1 ring-violet-200' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== model && (
                                            <span className={selected ? 'text-violet-400 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-violet-500 mt-1.5 shrink-0" />}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableVisionModels.length === 0
                                    ? 'List is empty — you can enter one manually or click "Refresh Model List" to fetch'
                                    : `No models matching "${visionModelFilter}"`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* API Call Log page */}
      <ApiCallLogModal isOpen={showApiCallLog} onClose={() => setShowApiCallLog(false)} />

      {/* Preset Name Modal */}
      <Modal isOpen={showPresetModal} title="New Preset" onClose={() => setShowPresetModal(false)} footer={<button onClick={handleSavePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Create</button>}>
          <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">Preset Name (e.g. DeepSeek)</label>
              <input value={newPresetName} onChange={e => setNewPresetName(e.target.value)} className="w-full bg-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-primary" autoFocus placeholder="Name..." />
              <p className="text-[10px] text-slate-400 leading-relaxed pt-1">Saves the URL / Key / Model from the form above, plus streaming and temperature from Advanced settings.</p>
          </div>
      </Modal>

      {/* Edit preset: only changes this preset itself; if it's currently active, the live config follows along too */}
      <Modal
          isOpen={!!editingPresetId}
          title="Edit Preset"
          onClose={() => setEditingPresetId(null)}
          footer={<button onClick={handleUpdatePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Save</button>}
      >
          <div className="space-y-3">
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Name</label>
                  <input value={editPresetName} onChange={e => setEditPresetName(e.target.value)} placeholder="Preset name" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">URL</label>
                  <input value={editPresetUrl} onChange={e => setEditPresetUrl(e.target.value)} placeholder="https://..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Key</label>
                  <input type="password" value={editPresetKey} onChange={e => setEditPresetKey(e.target.value)} placeholder="sk-..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                  <input value={editPresetModel} onChange={e => setEditPresetModel(e.target.value)} placeholder="Model name" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Streaming Output (Stream)</p>
                          <p className="text-[9px] text-slate-300 mt-0.5">Saved independently with this preset</p>
                      </div>
                      <button
                          type="button"
                          aria-label="Preset streaming output"
                          aria-pressed={editPresetStream}
                          onClick={() => setEditPresetStream(value => !value)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${editPresetStream ? 'bg-primary' : 'bg-slate-200'}`}
                      >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${editPresetStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                  </div>
                  <div>
                      <div className="flex items-center justify-between">
                          <label htmlFor="edit-preset-temperature" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Temperature</label>
                          <span className="text-[10px] font-mono text-slate-400">{editPresetTemperature.toFixed(2)}</span>
                      </div>
                      <input
                          id="edit-preset-temperature"
                          type="range"
                          min="0"
                          max="2"
                          step="0.05"
                          value={editPresetTemperature}
                          onChange={event => setEditPresetTemperature(parseFloat(event.target.value))}
                          className="w-full accent-primary mt-1"
                      />
                  </div>
              </div>
              <button
                  type="button"
                  onClick={() => {
                      setEditPresetUrl(localUrl);
                      setEditPresetKey(localKey);
                      setEditPresetModel(localModel);
                      setEditPresetStream(localStream);
                      setEditPresetTemperature(localTemperature);
                      addToast('Filled in from current config', 'info');
                  }}
                  className="w-full py-2 bg-slate-100 text-slate-500 text-xs font-bold rounded-xl active:scale-95 transition-transform"
              >
                  Fill In From Current Config
              </button>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                  {editingPresetId && activePresetId === editingPresetId
                      ? 'This one is currently in use — saving will also switch the current config to the new values.'
                      : 'This only changes this preset; the currently active config is unaffected.'}
              </p>
          </div>
      </Modal>

      {/* Forced Export Modal */}
      <Modal isOpen={showExportModal} title="Backup Download" onClose={() => { revokeDownloadUrl(); setShowExportModal(false); }} footer={
          <div className="flex gap-2 w-full">
               <button onClick={() => { revokeDownloadUrl(); setShowExportModal(false); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Close</button>
          </div>
      }>
          <div className="space-y-4 text-center py-4">
              <div className="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
              </div>
              <p className="text-sm font-bold text-slate-700">Backup file generated!</p>
              <p className="text-xs text-slate-500">If the browser did not download automatically, click the link below.</p>
              {downloadUrl && <a href={downloadUrl} download={downloadFileName} className="text-primary text-sm underline block py-2">Click to download .zip manually</a>}
          </div>
      </Modal>

      {/* Real-time Perception Settings Modal */}
      <Modal
          isOpen={showRealtimeModal}
          title="Real-time Perception Settings"
          onClose={() => setShowRealtimeModal(false)}
          footer={<button onClick={handleSaveRealtimeConfig} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg">Save Configuration</button>}
      >
          <div className="space-y-5 max-h-[60vh] overflow-y-auto no-scrollbar">
              {/* Weather config */}
              <div className="bg-emerald-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Sun size={20} weight="fill" />
                          <span className="text-sm font-bold text-emerald-700">Weather Perception</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtWeatherEnabled} onChange={e => setRtWeatherEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                      </label>
                  </div>
                  {rtWeatherEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">OpenWeatherMap API Key (optional)</label>
                              <input type="password" value={rtWeatherKey} onChange={e => setRtWeatherKey(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Leave empty to use the free Open-Meteo, no sign-up needed" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">City</label>
                              <input type="text" value={rtWeatherCity} onChange={e => setRtWeatherCity(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm" placeholder="Beijing / Shanghai" />
                          </div>
                          <button onClick={testWeatherApi} className="w-full py-2 bg-emerald-100 text-emerald-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">Test Weather API</button>
                      </div>
                  )}
              </div>

              {/* News config */}
              <div className="bg-blue-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Newspaper size={20} weight="fill" />
                          <span className="text-sm font-bold text-blue-700">Trending News</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNewsEnabled} onChange={e => setRtNewsEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  {rtNewsEnabled && (
                      <div className="space-y-2">
                          <p className="text-xs text-blue-600/70">Default main source: multi-platform Chinese trending charts (no auth needed, the character auto-picks up trending topics during chat). Select which platforms to follow:</p>
                          <div className="flex flex-wrap gap-1.5">
                              {HOTNEWS_PLATFORM_OPTIONS.map(p => {
                                  const active = rtNewsPlatforms.includes(p.key);
                                  return (
                                      <button
                                          key={p.key}
                                          type="button"
                                          onClick={() => setRtNewsPlatforms(prev => prev.includes(p.key) ? prev.filter(k => k !== p.key) : [...prev, p.key])}
                                          className={`text-[11px] px-2.5 py-1 rounded-full font-bold transition-colors active:scale-95 ${active ? 'bg-blue-500 text-white shadow-sm' : 'bg-white/80 text-slate-500 border border-blue-200'}`}
                                      >
                                          {p.label}
                                      </button>
                                  );
                              })}
                          </div>
                          {rtNewsPlatforms.length === 0 && (
                              <p className="text-[10px] text-rose-500/80">Falls back to Brave / Hacker News when no platform is selected.</p>
                          )}
                          <details className="border-t border-blue-200/50 pt-2 mt-1 group">
                              <summary className="text-[10px] font-bold text-slate-400 uppercase cursor-pointer select-none list-none flex items-center gap-1.5">
                                  <span className="transition-transform group-open:rotate-90">›</span>
                                  Brave Search (fallback source · <span className="text-rose-400">not recommended to configure</span>)
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                  <p className="text-[10px] text-slate-400/90 leading-relaxed">
                                      The Chinese trending charts above work ten thousand times better than Brave for mainland-China use cases — <b className="text-slate-500">you basically don't need to configure this</b>.
                                      It's only an English-language fallback for when the trending charts fail completely; configuring it may actually crowd out Chinese trending topics. Leave it empty unless you know exactly what you're doing.
                                  </p>
                                  <input type="password" value={rtNewsApiKey} onChange={e => setRtNewsApiKey(e.target.value)} className="w-full bg-white/60 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-slate-500" placeholder="(not recommended) brave.com/search/api" />
                                  <p className="text-[10px] text-slate-400/70">Only kicks in when the Chinese trending charts fail to load; falls back further to Hacker News (English) when neither is available.</p>
                              </div>
                          </details>
                      </div>
                  )}
              </div>

              {/* Firecrawl web reading: the Ark Plan is hidden by default, code and fallback capability are kept. */}
              {SHOW_FIRECRAWL_ARK_UI && (
              <div className="bg-amber-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                          <PlugsConnected size={20} weight="fill" className="text-amber-600 shrink-0" />
                          <div className="min-w-0">
                              <span className="text-sm font-bold text-amber-800">Firecrawl Web Reading</span>
                              <p className="text-[10px] text-amber-700/60">Enhanced web-share scraping · optional</p>
                          </div>
                      </div>
                      <a
                          href={FIRECRAWL_API_KEYS_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[10px] bg-white border border-amber-200 text-amber-700 px-2.5 py-1.5 rounded-full font-bold"
                      >
                          Sign Up Free ↗
                      </a>
                  </div>

                  <p className="text-[10px] text-amber-800/70 leading-relaxed">
                      When a regular web page is pasted into chat, Firecrawl automatically reads dynamic pages after the original extraction fails; if that fails too, it still falls back to Jina and the Worker, so a shared link never breaks just because a quota ran out. The free plan currently covers about 1,000 pages/month.
                  </p>

                  {!firecrawlKeyInput.trim() && (
                      <ol className="rounded-xl border border-amber-200/80 bg-white/70 px-3 py-2 text-[10px] text-amber-900/75 leading-relaxed space-y-1">
                          <li><b>1.</b> Click "Sign Up Free" to sign up for or log into Firecrawl.</li>
                          <li><b>2.</b> Go to API Keys, create and copy a Key starting with <b>fc-</b>.</li>
                          <li><b>3.</b> Come back here to paste it, then click "Save & Check Quota."</li>
                      </ol>
                  )}

                  <input
                      type="password"
                      value={firecrawlKeyInput}
                      onChange={e => {
                          setFirecrawlKeyInput(e.target.value);
                          setFirecrawlCheckResult(null);
                          setFirecrawlUsage(null);
                      }}
                      className="w-full bg-white/90 border border-amber-200 rounded-xl px-3 py-2 text-sm font-mono"
                      placeholder="fc-..."
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                  />

                  <div className="grid grid-cols-2 gap-2">
                      <button
                          type="button"
                          onClick={handleClearFirecrawl}
                          disabled={firecrawlChecking || !firecrawlKeyInput}
                          className="py-2 bg-white/80 border border-amber-200 text-amber-700 text-xs font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-transform"
                      >
                          Clear
                      </button>
                      <button
                          type="button"
                          onClick={() => void handleCheckFirecrawl()}
                          disabled={firecrawlChecking}
                          className="py-2 bg-amber-500 text-white text-xs font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform"
                      >
                          {firecrawlChecking ? 'Checking…' : 'Save & Check Quota'}
                      </button>
                  </div>

                  {firecrawlUsage && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[10px] text-emerald-800 leading-relaxed">
                          <b>{firecrawlUsage.remainingCredits.toLocaleString()} / {firecrawlUsage.planCredits.toLocaleString()} credits remaining</b>
                          {firecrawlUsage.billingPeriodEnd && (
                              <span> · refreshes {new Date(firecrawlUsage.billingPeriodEnd).toLocaleDateString('en-US')}</span>
                          )}
                      </div>
                  )}
                  {firecrawlCheckResult && !firecrawlUsage && (
                      <p className={`text-[10px] leading-relaxed ${firecrawlCheckResult.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {firecrawlCheckResult.ok ? '✓ ' : '✗ '}{firecrawlCheckResult.text}
                      </p>
                  )}

                  <p className="text-[9px] text-slate-400 leading-relaxed">
                      The Key is only saved on this device, and the device connects to Firecrawl directly, not through the project Worker. Requests explicitly disable Firecrawl's page cache; do not share private links that require login.
                  </p>
              </div>
              )}

              {/* Notion config */}
              <div className="bg-orange-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <NotePencil size={20} weight="fill" />
                          <span className="text-sm font-bold text-orange-700">Notion Journal</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNotionEnabled} onChange={e => setRtNotionEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                      </label>
                  </div>
                  {rtNotionEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Notion Integration Token</label>
                              <input type="password" value={rtNotionKey} onChange={e => setRtNotionKey(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="ntn_... or secret_..." />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Database ID</label>
                              <input type="text" value={rtNotionDbId} onChange={e => setRtNotionDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Copy from the database URL" />
                          </div>
                          <button onClick={testNotionApi} className="w-full py-2 bg-orange-100 text-orange-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">Test Notion Connection</button>
                          <div className="border-t border-orange-200/50 pt-2 mt-2">
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Notes Database ID (optional)</label>
                              <input type="text" value={rtNotionNotesDbId} onChange={e => setRtNotionNotesDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Database ID for your everyday notes" />
                              <p className="text-[10px] text-orange-500/60 leading-relaxed mt-1">
                                  When filled in, the character can occasionally see your note titles and warmly bring up what you wrote. Leave empty to keep this disabled.
                              </p>
                          </div>
                          <p className="text-[10px] text-orange-500/70 leading-relaxed">
                               1. Create an Integration at <a href="https://www.notion.so/my-integrations" target="_blank" className="underline">Notion Developers</a> (new-style tokens start with ntn_, older ones with secret_ — both work)<br/>
                               2. Create a journal database, add "Name" (title) and "Date" properties<br/>
                               3. Connect your Integration from the menu in the top-right corner of the database<br/>
                               The Token is saved in local config; once enabled, requests for the selected database are relayed through a network Worker — the project does not retain journal content.
                          </p>
                      </div>
                  )}
              </div>

              {/* Feishu config (mainland-China alternative) */}
              <div className="bg-indigo-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Notebook size={20} weight="fill" />
                          <span className="text-sm font-bold text-indigo-700">Feishu Journal</span>
                          <span className="text-[9px] bg-indigo-100 text-indigo-500 px-1.5 py-0.5 rounded-full">Mainland China</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtFeishuEnabled} onChange={e => setRtFeishuEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                      A mainland-China alternative to Notion, no VPN needed. Uses Feishu Base (multi-dimensional tables) to store journal entries.
                  </p>
                  {rtFeishuEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Feishu App ID</label>
                              <input type="text" value={rtFeishuAppId} onChange={e => setRtFeishuAppId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="cli_xxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Feishu App Secret</label>
                              <input type="password" value={rtFeishuAppSecret} onChange={e => setRtFeishuAppSecret(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="xxxxxxxxxxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Base App Token</label>
                              <input type="text" value={rtFeishuBaseId} onChange={e => setRtFeishuBaseId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Get this from the Base URL" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Table ID</label>
                              <input type="text" value={rtFeishuTableId} onChange={e => setRtFeishuTableId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="tblxxxxxxxx" />
                          </div>
                           <button onClick={testFeishuApi} className="w-full py-2 bg-indigo-100 text-indigo-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">Test Read Connection</button>
                           <p className="rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
                               Testing does not add records — it only verifies the credentials, read permission, and Table ID. If reads succeed but writes say Forbidden, you're still missing the add-record permission.
                           </p>
                           <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                                1. Create a custom enterprise app at the <a href="https://open.feishu.cn/app" target="_blank" className="underline">Feishu Open Platform</a> to get an App ID and Secret<br/>
                                2. Enable the "View, comment, edit, and manage Base" permission, create and publish a new version, and complete admin approval<br/>
                                3. Add this app under "Add document app" in your target Base, and grant edit access (also allow adding records if advanced permissions are on)<br/>
                                4. Add fields: Title (text), Content (text), Date (date), Mood (text), Character (text)<br/>
                                5. Get the App Token and Table ID from the Base URL<br/>
                                The App Secret is saved in local config; once enabled, Base requests are relayed through a network Worker — the project does not retain table content.
                           </p>
                      </div>
                  )}
              </div>

              {/* Xiaohongshu automation */}
              <div className="bg-red-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-red-700">Xiaohongshu · Local</span>
                          <span className="text-[9px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">MCP compatible / Skills</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'local'} onChange={e => { if (e.target.checked) { setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('local'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-red-500/70 leading-relaxed">
                      Local mode remains available: xiaohongshu-mcp uses the MCP protocol, xhs-bridge / Skills use a local /api. MCP compatibility is kept, but is no longer guaranteed to keep pace with its upstream version; new setups should use the actively-maintained Lite below instead.
                  </p>
                  {rtXhsMcpEnabled && rtXhsMode === 'local' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Server URL</label>
                              <input value={rtXhsLocalUrl} onChange={e => setRtXhsLocalUrl(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="http://localhost:18060/mcp" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-red-100 text-red-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">Test Connection</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Xiaohongshu Nickname</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px]" placeholder="Fill in manually" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">User ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="Optional, used to view the profile" />
                              </div>
                          </div>
                          <p className="text-[10px] text-red-500/70 leading-relaxed">
                              <b>MCP mode:</b> download xiaohongshu-mcp + run the script, fill in the URL as http://localhost:18060/mcp (or 18061/mcp if proxied)<br/>
                              <b>Skills mode:</b> fill in the URL as http://localhost:18061/api (requires Python + xhs-bridge.mjs, additionally supports video/long-form posts)<br/>
                              The system auto-detects based on the URL ending (/mcp or /api).
                          </p>
                      </div>
                  )}
              </div>

              {/* Xiaohongshu Lite (cloud) */}
              <div className="bg-rose-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-rose-700">Xiaohongshu Lite</span>
                          <span className="text-[9px] bg-rose-100 text-rose-500 px-1.5 py-0.5 rounded-full">Actively maintained</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'lite'} onChange={e => { if (e.target.checked) { if (!window.confirm(XHS_RISK_TEXT + '\n\nAre you sure you want to enable this?')) return; setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('lite'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-rose-500/70 leading-relaxed">
                      No computer, no QR-code scanning needed: paste your Xiaohongshu / RedNote cookie once, and you get search, browsing, viewing details, and interactions; domestic Xiaohongshu also supports posting (with images). The address is built in, no need to fill it in.
                  </p>
                  <p className="text-[10px] text-amber-700 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{XHS_RISK_TEXT}</p>
                  {rtXhsMcpEnabled && rtXhsMode === 'lite' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Xiaohongshu Cookie</label>
                              <textarea value={rtXhsCookie} onChange={e => { setRtXhsCookie(e.target.value); setRtXhsPlatform(undefined); }} rows={2} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[10px] font-mono resize-y" placeholder="a1=...; web_session=...; (copy the full cookie after logging in from your browser)" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-rose-100 text-rose-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">Test Connection</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Xiaohongshu Nickname</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px]" placeholder="Auto-filled after testing the connection" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">User ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="Auto-filled" />
                              </div>
                          </div>
                          <div>
                              <button type="button" onClick={() => { if (!rtXhsGuideOpen) trackEvent('Expand Cookie Guide'); setRtXhsGuideOpen(v => !v); }} className="text-[11px] font-bold text-rose-600 underline">📖 Click for the cookie guide {rtXhsGuideOpen ? '▲' : '▼'}</button>
                              {rtXhsGuideOpen && (
                                  <div className="mt-1 bg-white/70 rounded-lg p-2 space-y-1.5">
                                      <pre className="text-[10px] text-slate-600 whitespace-pre-wrap font-sans leading-relaxed">{XHS_COOKIE_GUIDE}</pre>
                                      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(XHS_COOKIE_GUIDE); trackEvent('Copy Cookie Guide Text', { result: 'copied' }); addToast('Guide copied — you can paste it to ask another AI', 'success'); } catch { trackEvent('Copy Cookie Guide Text', { result: 'clipboard-failed' }); addToast('Copy failed, please long-press to select manually', 'error'); } }} className="w-full py-1.5 bg-rose-100 text-rose-600 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">Copy Guide</button>
                                  </div>
                              )}
                          </div>
                          <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-100/60 rounded-lg px-2 py-1.5">
                              Usage note: the Cookie is saved in local config; when using Lite, it's sent with requests to a network Worker for login verification and API request signing — the current open-source Worker does not retain it. Using a secondary account is recommended, and update it promptly if you log out or it expires.
                          </p>
                      </div>
                  )}
              </div>

              {/* McDonald's MCP */}
              <div className="bg-yellow-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <ForkKnife size={20} weight="fill" className="text-yellow-600" />
                          <span className="text-sm font-bold text-yellow-700">McDonald's</span>
                          <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">Official MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={mcdEnabled} onChange={e => handleMcdEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                      Once enabled, tap + in chat → second page → McDonald's, send "麦请求" to activate (this exact phrase is what the app matches against — do not translate it), and the character can look up the menu, find stores, order delivery / pickup / group orders, redeem points for coupons, and check promotions for you.
                  </p>
                  {mcdEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (personal)</label>
                              <input type="password" value={mcdToken} onChange={e => handleMcdTokenChange(e.target.value)} className="w-full bg-white/80 border border-yellow-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Get one at open.mcd.cn/mcp" />
                          </div>
                          <button onClick={testMcdApi} disabled={mcdTesting} className="w-full py-2 bg-yellow-100 text-yellow-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {mcdTesting ? 'Testing…' : 'Test Connection'}
                          </button>
                          {mcdTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${mcdTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : mcdTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {mcdTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                              1. Visit <a href="https://open.mcd.cn/mcp" target="_blank" className="underline">open.mcd.cn/mcp</a> and log in with your McDonald's account to get a Token<br/>
                              2. The Token is saved in local config; when using the ordering feature, it's relayed through a network Worker with MCP requests — the project does not retain it<br/>
                              3. Ordering actions involve real payment — the character will read back the order for you to confirm before placing it<br/>
                              4. Mainland China only (excludes Hong Kong, Macau, Taiwan)
                          </p>
                      </div>
                  )}
              </div>

              {/* Luckin MCP */}
              <div className="bg-blue-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Coffee size={20} weight="fill" className="text-blue-600" />
                          <span className="text-sm font-bold text-blue-700">Luckin Coffee</span>
                          <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">Official MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={luckinEnabled} onChange={e => handleLuckinEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-blue-700/70 leading-relaxed">
                      Once enabled, tap + in chat → second page → Grab a Luckin, send "瑞一杯" to activate (this exact phrase is what the app matches against — do not translate it), and the character can find stores, search coffee, pick a size, place a pickup order, and check your pickup code for you.
                  </p>
                  {luckinEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (personal)</label>
                              <input type="password" value={luckinToken} onChange={e => handleLuckinTokenChange(e.target.value)} className="w-full bg-white/80 border border-blue-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="Copy this after logging in at open.lkcoffee.com" />
                          </div>
                          <button onClick={testLuckinApi} disabled={luckinTesting} className="w-full py-2 bg-blue-100 text-blue-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {luckinTesting ? 'Testing…' : 'Test Connection'}
                          </button>
                          {luckinTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${luckinTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : luckinTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {luckinTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-blue-700/70 leading-relaxed">
                              1. Visit <a href="https://open.lkcoffee.com" target="_blank" className="underline">open.lkcoffee.com</a>, log in with your Luckin account, and copy the Token (valid for about 1 month)<br/>
                              2. The Token is saved in local config; when using the ordering feature, it's relayed through a network Worker with MCP requests — the project does not retain it<br/>
                              3. Ordering actions involve real payment — the character will read back the order for you to confirm before placing it<br/>
                              4. Upstream requires the Worker proxy (/mcp/luckin) — make sure you've deployed the latest worker
                          </p>
                      </div>
                  )}
              </div>

              {/* Test status */}
              {rtTestStatus && (
                  <div className={`p-3 rounded-xl text-xs font-medium text-center ${rtTestStatus.includes('success') || rtTestStatus.includes('Connected') || rtTestStatus.includes('ok') ? 'bg-emerald-100 text-emerald-700' : rtTestStatus.includes('failed') || rtTestStatus.includes('error') || rtTestStatus.includes('Error') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                      {rtTestStatus}
                  </div>
              )}
          </div>
      </Modal>

      {/* General MCP management (broken out separately from Real-time Perception) */}
      <Modal isOpen={showMcpModal} title="MCP" onClose={() => { setShowMcpModal(false); flushMcpToolConfigSync(); }}>
          <div className="space-y-4">
              <McpConnectionConsole addToast={addToast} onMcpConfigChanged={() => {
                  // MCP config changes only need to re-push tool_config: the prompt block and tools array
                  // are generated live by the worker from tool_config at fire time (see mcpFireCore), never
                  // going through fire_pack, so there's no staleness issue — no need to refresh the prompts
                  // together like Real-time Perception does (syncAmsgToolConfigAndPrompts).
                  // This one especially must not get lost in transit: if a deleted server fails to sync up,
                  // the worker could still be connecting directly to it with the old token in the middle of
                  // the night. Retries and bookkeeping are handled by syncAmsgToolConfig.
                  scheduleMcpToolConfigSync(() => syncAmsgToolConfig(realtimeConfig));
              }} />
          </div>
      </Modal>

      {/* MCP Help Modal — aimed at users who know nothing about MCP, explains what it's for and how to deploy it */}
      <Modal isOpen={showMcpHelp} title="What Is MCP?" onClose={() => setShowMcpHelp(false)}>
          <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="bg-violet-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-violet-700">MCP Tool Server</p>
                  <p>
                      MCP (Model Context Protocol) is an open protocol. Once you connect a knowledge base, web
                      search, notes, or smart home devices, Sully can call them during chat. MCP config never overrides character settings, relationships, or memory.
                  </p>
              </div>
              <div className="bg-sky-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-sky-700">🏠 Why do I have to set up the server myself?</p>
                  <p>
                      SullyOS's core frontend can be deployed statically, and it doesn't force all MCP traffic
                      through a central project-run proxy. URLs and credentials stay local by default — you need to set up the tool server yourself, three options:
                  </p>
                  <p>
                      ☁️ <b>Use an existing cloud MCP service</b>: the provider gives you a public https address (maybe a Token too) — just fill it into the config.<br/>
                      🖥️ <b>Run it on your own computer</b>: fill in <code className="bg-white/80 px-1 rounded">http://localhost:port</code> directly from a browser on that computer;
                      if you also want it usable from your phone, set up a tunnel (e.g. Cloudflare Tunnel).<br/>
                      🚀 <b>Deploy it to the cloud yourself</b>: VPS / Cloudflare / Zeabur, etc. — usable from any device anytime.
                  </p>
              </div>
              <div className="bg-amber-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-amber-700">🚧 Test connection says "Failed to fetch"?</p>
                  <p>
                      It's most likely the browser's CORS cross-origin block (another cost of a static web page).
                      If you can change the server, configure CORS there; if you can't, fill in a "Proxy URL" in the config — run a small local proxy, or deploy the Worker proxy from this repo to your own Cloudflare account — the tutorial has ready-made steps for both.
                  </p>
              </div>
              <div className="space-y-2">
                  <a
                      href={MCP_USER_GUIDE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackEvent('Go to Full MCP Tutorial')}
                      className="block w-full py-2.5 bg-violet-500 text-white text-center text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >📖 Open the Full Tutorial (with deployment examples)</a>
                  <button
                      type="button"
                      onClick={async () => {
                          const text = `Please read this tutorial, then walk me step by step through connecting an MCP tool server to SullyOS. First ask me what tool I want to connect and where I plan to deploy it (cloud / local computer / local + tunnel), then give the steps for that path:\n${MCP_USER_GUIDE_URL}`;
                          try { await navigator.clipboard.writeText(text); trackEvent('Copy MCP Deployment Guide for AI', { result: 'copied' }); addToast('Copied — go paste it for your AI', 'success'); }
                          catch { trackEvent('Copy MCP Deployment Guide for AI', { result: 'clipboard-failed' }); addToast('Copy failed, please copy the tutorial link manually', 'error'); }
                      }}
                      className="w-full py-2.5 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >🤖 Copy the Link for Your AI to Walk You Through Deployment</button>
                  <p className="text-[10px] text-slate-400 text-center">The tutorial is self-contained — any AI assistant can read it and walk you through the whole process.</p>
              </div>
          </div>
      </Modal>

      {/* Confirm Reset Modal */}
      <Modal
          isOpen={showResetConfirm}
          title="System Warning"
          onClose={() => setShowResetConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Cancel</button>
                  <button onClick={confirmReset} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">Confirm Format</button>
              </div>
          }
      >
          <div className="flex flex-col items-center gap-3 py-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-red-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
              <p className="text-center text-sm text-slate-600 font-medium">
                  This will <span className="text-red-500 font-bold">permanently delete</span> all characters, chat history, and settings — and cannot be undone!
              </p>
          </div>
      </Modal>

      <InstantPushSettingsModal
        open={showInstantModal}
        onClose={() => setShowInstantModal(false)}
        onOpenVapid={() => { setShowInstantModal(false); setShowVapidModal(true); }}
      />
      <PushVapidSettingsModal
        open={showVapidModal}
        onClose={() => { setShowVapidModal(false); setVapidReadyTick((n) => n + 1); }}
      />
      <ActiveMsgGlobalSettingsModal
        isOpen={showAmsg2Modal}
        onClose={() => setShowAmsg2Modal(false)}
        addToast={addToast}
        realtimeConfig={realtimeConfig}
        onOpenVapid={() => { setShowAmsg2Modal(false); setShowVapidModal(true); }}
      />

    </div>
  );
};

export default Settings;
