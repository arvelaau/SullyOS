import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Modal from '../os/Modal';
import { DB } from '../../utils/db';
import {
    API_REQUEST_CAPTURE_EVENT,
    formatApiRequestCaptureTxt,
    getApiRequestCaptureSectionContent,
    getApiRequestCaptureSectionSource,
    isApiRequestCaptureArmed,
    isSameCoreModel,
    isFixedPromptBlockLabel,
    setApiRequestCaptureArmed,
    summarizeApiRequestCaptureDuplicates,
} from '../../utils/apiCallLog';
import type {
    ApiCallLogEntry,
    ApiRequestCapture,
    ApiRequestCaptureSection,
    ApiRequestCaptureSectionKind,
    PromptBlockStat,
} from '../../utils/apiCallLog';
import { trackEvent } from '../../utils/analytics';
import { shareOrDownloadFile } from '../../utils/shareExport';

interface ApiCallLogModalProps {
    isOpen: boolean;
    onClose: () => void;
}

/** 把时间戳格式化成「今天 14:03:21 / 昨天 09:12 / 06-04 22:08」这种好扫的形态。 */
function formatTime(ts: number): { day: string; time: string } {
    const d = new Date(ts);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const sameDay = (a: Date, b: Date) =>
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    let day: string;
    if (sameDay(d, now)) day = 'Today';
    else if (sameDay(d, yesterday)) day = 'Yesterday';
    else day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { day, time };
}

const ApiCallLogModal: React.FC<ApiCallLogModalProps> = ({ isOpen, onClose }) => {
    const [entries, setEntries] = useState<ApiCallLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [capture, setCapture] = useState<ApiRequestCapture | null>(null);
    const [captureArmed, setCaptureArmedState] = useState(() => isApiRequestCaptureArmed());

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [data, savedCapture] = await Promise.all([
                DB.getApiCallLog(),
                DB.getApiRequestCapture(),
            ]);
            // DB 里已按新→旧 unshift，这里再兜底排一次序
            data.sort((a: ApiCallLogEntry, b: ApiCallLogEntry) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            setEntries(data);
            setCapture(savedCapture);
            setCaptureArmedState(isApiRequestCaptureArmed());
            // 这一批记录里只要有一条「实际后端」跟请求的模型对不上，就记一次。
            // 只记「出现过」这件事，模型名一个字都不带出去。
            if (data.some((e: ApiCallLogEntry) =>
                !!e.backendModel && e.backendModel !== e.model && !isSameCoreModel(e.model, e.backendModel)
            )) {
                trackEvent('Model Mismatch Warning Appeared in Log');
            }
        } catch {
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) load();
    }, [isOpen, load]);

    useEffect(() => {
        const handleCaptureChange = async (event: Event) => {
            setCaptureArmedState(isApiRequestCaptureArmed());
            if ((event as CustomEvent)?.detail?.status === 'saved') {
                setCapture(await DB.getApiRequestCapture());
            }
        };
        window.addEventListener(API_REQUEST_CAPTURE_EVENT, handleCaptureChange);
        return () => window.removeEventListener(API_REQUEST_CAPTURE_EVENT, handleCaptureChange);
    }, []);

    const handleClear = useCallback(async () => {
        if (!window.confirm('Clear all API call logs? This action cannot be undone.')) return;
        await DB.clearApiCallLog();
        setEntries([]);
        trackEvent('Clear API Call Log');
    }, []);

    const handleCaptureToggle = useCallback(() => {
        setApiRequestCaptureArmed(!captureArmed);
        setCaptureArmedState(isApiRequestCaptureArmed());
    }, [captureArmed]);

    const handleCaptureClear = useCallback(async () => {
        if (!window.confirm('Clear the full captured send content?')) return;
        await DB.clearApiRequestCapture();
        setCapture(null);
    }, []);

    return (
        <Modal
            isOpen={isOpen}
            title="API Call Log"
            onClose={onClose}
            footer={
                <div className="flex gap-2 w-full">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform"
                    >
                        Close
                    </button>
                    <button
                        onClick={handleClear}
                        disabled={entries.length === 0}
                        className="px-5 py-3 bg-rose-50 text-rose-500 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40"
                    >
                        Clear
                    </button>
                </div>
            }
        >
            <div className="flex items-start justify-between gap-2 mb-3 px-1">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                    Only calls from the last <span className="font-semibold text-slate-500">5 days</span> are kept; older ones are dropped automatically. Logged in your local browser, never uploaded.
                </p>
                <button
                    onClick={() => { if (!showHelp) trackEvent('Open Backend Model Field Explanation'); setShowHelp(v => !v); }}
                    className={`shrink-0 w-5 h-5 rounded-full text-[11px] font-bold leading-none flex items-center justify-center transition-colors ${
                        showHelp ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'
                    }`}
                    aria-label="Field explanation"
                >
                    ?
                </button>
            </div>

            {showHelp && (
                <div className="mb-3 rounded-2xl bg-amber-50/70 border border-amber-200/60 px-4 py-3 text-[11px] text-slate-600 leading-relaxed space-y-2">
                    <p className="font-bold text-amber-700">What "Backend Model" means — for reference only, not a lie detector</p>
                    <p>
                        It's <span className="font-semibold">the model name the other side reports about itself in the reply</span>. Note: this name is self-reported by the other side — it can be true, or it can be fake.
                    </p>
                    <p className="font-semibold">Three cases:</p>
                    <p>
                        <span className="font-semibold text-amber-600">🟡 Amber + ⚠️</span>: the reported name doesn't match what you requested.
                        <span className="font-semibold">Possibly</span> swapped for a cheaper model, but it could also just be an inconsistently-formatted provider label — don't convict based on this line alone.
                    </p>
                    <p>
                        <span className="font-semibold">⚪ Gray</span>: names basically match, just formatted differently (e.g. missing a [channel], (per-call), gcli- style prefix). Normal.
                    </p>
                    <p>
                        <span className="font-semibold">🫥 No such line</span>: the most common case. Either the other side <span className="font-semibold">echoed back the name you requested verbatim</span> (equivalent to saying nothing), or it simply didn't report one.
                        <span className="font-semibold">Doesn't mean there's a problem, and doesn't mean there isn't — this clue alone just can't tell.</span>
                    </p>
                    <p>
                        To judge whether the model was secretly swapped, look at several signals <span className="font-semibold">together</span>: whether the token count suddenly doesn't add up (e.g. usually 40k, this time 15k), whether speed suddenly changes, whether the character suddenly gets dumber or loses formatting. If only one signal looks off, wait and watch for a few more turns before concluding anything.
                    </p>
                    <div className="pt-2 border-t border-amber-200/60 space-y-2">
                        <p className="font-bold text-sky-700">What the "☁️ Cloud" tag means</p>
                        <p>
                            Once <span className="font-semibold">Instant Chat</span> is on, chat messages are no longer sent from this page — your own Worker sends them in the cloud instead, so you can close the page right after sending and still get the reply. These calls are logged here too, just with a few things you can't see:
                        </p>
                        <p>
                            <span className="font-semibold">"Generating"</span>: the cloud has accepted it, the reply hasn't come back yet. It only becomes a success once the reply arrives.
                        </p>
                        <p>
                            <span className="font-semibold">No duration, no backend model</span>: the request was sent from the cloud, so locally we can't measure the time or see the self-reported model name.
                        </p>
                        <p>
                            <span className="font-semibold text-amber-600">"Final turn only"</span>: for the kind where the character looks something up before replying, several model calls happen in one turn, and the cloud only reports back the token count from the last one. The number on this entry is <span className="font-semibold">smaller than actual usage</span> — don't use it to reconcile against your bill.
                        </p>
                        <p>
                            <span className="font-semibold">"Superseded"</span>: you sent another message before this one got a reply, and the cloud merged both into a single response. This turn no longer waits for a reply on its own.
                        </p>
                    </div>
                </div>
            )}

            <OneShotCapturePanel
                capture={capture}
                armed={captureArmed}
                onToggle={handleCaptureToggle}
                onClear={handleCaptureClear}
            />

            {entries.length > 0 && (() => {
                const totalTok = entries.reduce((s, e) => s + (e.totalTokens ?? 0), 0);
                const promptTok = entries.reduce((s, e) => s + (e.promptTokens ?? 0), 0);
                const compTok = entries.reduce((s, e) => s + (e.completionTokens ?? 0), 0);
                const fmt = (n: number) => n.toLocaleString('en-US');
                return (
                    <div className="mb-3 rounded-2xl bg-primary/5 border border-primary/15 px-4 py-3 flex items-center justify-around text-center">
                        <div>
                            <div className="text-[10px] text-slate-400">Calls</div>
                            <div className="text-sm font-bold text-slate-600">{entries.length}</div>
                        </div>
                        <div className="w-px h-7 bg-slate-200" />
                        <div>
                            <div className="text-[10px] text-slate-400">Total Tokens</div>
                            <div className="text-sm font-bold text-primary">{fmt(totalTok)}</div>
                        </div>
                        <div className="w-px h-7 bg-slate-200" />
                        <div>
                            <div className="text-[10px] text-slate-400">Input / Output</div>
                            <div className="text-[11px] font-semibold text-slate-500">{fmt(promptTok)} / {fmt(compTok)}</div>
                        </div>
                    </div>
                );
            })()}

            {loading ? (
                <div className="py-10 text-center text-sm text-slate-400">Loading…</div>
            ) : entries.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-400">
                    No call logs yet.<br />
                    <span className="text-[11px]">Chat with a character or have them browse Xiaohongshu, and data will show up here.</span>
                </div>
            ) : (
                <div className="space-y-2">
                    {entries.map((e) => {
                        const { day, time } = formatTime(e.timestamp);
                        const hasBreakdown = !!e.promptBreakdown?.length;
                        const expanded = expandedId === e.id;
                        return (
                            <div
                                key={e.id}
                                onClick={hasBreakdown ? () => { if (!expanded) trackEvent('Expand Single Entry Input Breakdown'); setExpandedId(expanded ? null : e.id); } : undefined}
                                className={`rounded-2xl border p-3 ${
                                    e.ok ? 'bg-white/70 border-slate-200/60' : 'bg-rose-50/60 border-rose-200/60'
                                } ${hasBreakdown ? 'cursor-pointer active:scale-[0.99] transition-transform' : ''}`}
                            >
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="text-[11px] font-bold text-slate-400 shrink-0">{day}</span>
                                        <span className="text-[11px] font-mono text-slate-500 shrink-0">{time}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {/* 这条不是浏览器自己发的，是云端那台 Worker 发的。不标出来的话，
                                            同一条记录里「没有耗时、没有实际后端、Token 偏小」全都没法解释 */}
                                        {e.route && (
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-600">
                                                ☁️ Cloud
                                            </span>
                                        )}
                                        <span
                                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                                e.superseded ? 'bg-slate-100 text-slate-500'
                                                    : e.pending ? 'bg-amber-100 text-amber-600'
                                                        : e.ok ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'
                                            }`}
                                        >
                                            {e.superseded ? 'Superseded'
                                                : e.pending ? 'Generating'
                                                    : e.ok ? 'Success' : `Failed${e.status ? ` ${e.status}` : ''}`}
                                        </span>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                                    <Field label="API" value={e.presetName} accent />
                                    <Field label="App" value={e.appName} />
                                    <Field label="Character" value={e.charName} />
                                    <Field label="Purpose" value={e.purpose} />
                                    <div className="col-span-2">
                                        {/* 模型/实际后端两行不截断（break-all 换行）：截断会把「为什么黄了」的
                                            关键差异（后缀 -c、渠道标签）藏进省略号里，用户看着两行一样却标黄一头雾水 */}
                                        <Field label="Model" value={e.model} mono wrap />
                                    </div>
                                    {/* 后端自报身份（response.model）：字符串不同就展示；琥珀判定见
                                        isSameCoreModel——渠道标签/前缀（[渠道]、(按次)、gcli-、models/）算同名
                                        （灰色），尾巴长出变体（X-c / X-lite）才是真被换了后端（琥珀）。 */}
                                    {e.backendModel && e.backendModel !== e.model && (() => {
                                        const swapped = !isSameCoreModel(e.model, e.backendModel);
                                        return (
                                            <div className="col-span-2 flex items-baseline gap-1.5 min-w-0">
                                                <span className={`text-[10px] shrink-0 ${swapped ? 'text-amber-500' : 'text-slate-400'}`}>Backend Model</span>
                                                <span className={`break-all font-mono ${swapped ? 'font-semibold text-amber-600' : 'text-slate-500'}`}>
                                                    {e.backendModel}{swapped ? ' ⚠️' : ''}
                                                </span>
                                            </div>
                                        );
                                    })()}
                                    {e.durationMs != null && (
                                        <Field label="Duration" value={e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`} />
                                    )}
                                    {(e.totalTokens != null || e.promptTokens != null || e.completionTokens != null) && (
                                        <div className="col-span-2 flex items-baseline gap-1.5 min-w-0">
                                            <span className="text-[10px] text-slate-400 shrink-0">Token</span>
                                            <span className="text-slate-600 truncate">
                                                {(e.totalTokens ?? 0).toLocaleString('en-US')}
                                                <span className="text-slate-400">
                                                    {' '}(in {(e.promptTokens ?? 0).toLocaleString('en-US')} · out {(e.completionTokens ?? 0).toLocaleString('en-US')})
                                                </span>
                                                {/* 云端这一轮调了不止一次模型时，回传的用量只有最后那次。
                                                    不注明的话这个数拿去对账永远对不上，还会以为是被多扣了 */}
                                                {e.tokensPartial && <span className="text-amber-500"> · final turn only</span>}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                {hasBreakdown && (
                                    <div className="mt-1.5 text-[10px] text-slate-300 select-none">
                                        {expanded ? '▲ Hide input breakdown' : '▼ Click to see input breakdown (what took up how much)'}
                                    </div>
                                )}
                                {expanded && e.promptBreakdown && (
                                    <>
                                        {/* 只有聊天那条路会被云端二次加料（当前时间、天气热搜这些当下才知道的东西）。
                                            后台活儿（门牌整理）交上去的就是最终提示词，别让用户以为还有看不见的部分 */}
                                        {e.route === 'cloud-instant-chat' && (
                                            <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                                                What's counted here is the version assembled locally and handed to the cloud. Before actually sending, the cloud adds a few things only known at that moment (current time, trending weather/news), so the actual input is slightly larger than shown below.
                                            </p>
                                        )}
                                        <PromptBreakdownView blocks={e.promptBreakdown} promptTokens={e.promptTokens} />
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Modal>
    );
};

const CAPTURE_KIND_LABEL: Record<ApiRequestCaptureSectionKind, string> = {
    request: 'Params',
    tools: 'Tools',
    system: 'System Prompt',
    memory: 'Memory Recall',
    worldbook: 'Worldbook',
    group: 'Group Chat Context',
    history: 'Chat History',
    context: 'Character Context',
    user: 'User Message',
    assistant: 'Character History',
    tool: 'Tool Result',
};

const CAPTURE_KIND_STYLE: Record<ApiRequestCaptureSectionKind, string> = {
    request: 'bg-slate-100 text-slate-500',
    tools: 'bg-sky-50 text-sky-600',
    system: 'bg-violet-50 text-violet-600',
    memory: 'bg-amber-50 text-amber-700',
    worldbook: 'bg-emerald-50 text-emerald-700',
    group: 'bg-fuchsia-50 text-fuchsia-700',
    history: 'bg-orange-50 text-orange-700',
    context: 'bg-indigo-50 text-indigo-600',
    user: 'bg-blue-50 text-blue-600',
    assistant: 'bg-rose-50 text-rose-600',
    tool: 'bg-cyan-50 text-cyan-700',
};

async function copyCaptureText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

async function downloadCaptureTxt(capture: ApiRequestCapture, content: string): Promise<void> {
    const d = new Date(capture.capturedAt);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    await shareOrDownloadFile({
        content: `\uFEFF${content}`,
        fileName: `SullyOS-LLM-Send-Stats-${stamp}.txt`,
        mimeType: 'text/plain;charset=utf-8',
        shareTitle: 'SullyOS LLM Send Stats',
    });
}

const OneShotCapturePanel: React.FC<{
    capture: ApiRequestCapture | null;
    armed: boolean;
    onToggle: () => void;
    onClear: () => void;
}> = ({ capture, armed, onToggle, onClear }) => {
    const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
    const [showFixedSections, setShowFixedSections] = useState(false);
    const [copyNotice, setCopyNotice] = useState('');

    useEffect(() => {
        setExpandedSectionId(null);
        setShowFixedSections(false);
        setCopyNotice('');
    }, [capture?.id]);

    const copy = useCallback(async (value: string, notice: string) => {
        try {
            await copyCaptureText(value);
            setCopyNotice(notice);
            window.setTimeout(() => setCopyNotice(''), 1600);
        } catch {
            setCopyNotice('Copy failed, please expand and copy manually');
        }
    }, []);

    const capturedTime = capture ? formatTime(capture.capturedAt) : null;
    const fmt = (n: number) => n.toLocaleString('en-US');
    const rawId = '__raw_request__';
    const txtReport = useMemo(() => capture ? formatApiRequestCaptureTxt(capture) : '', [capture]);
    const promptTokenValue = !capture
        ? '—'
        : capture.promptTokens != null
            ? fmt(capture.promptTokens)
            : capture.usageStatus === 'pending'
                ? 'Waiting for response…'
                : capture.usageStatus === 'failed'
                    ? 'Request failed'
                    : capture.usageStatus == null
                        ? 'Not captured on old record'
                        : 'Not returned by API';
    const fixedSections = useMemo(
        () => capture?.sections.filter(section => section.kind === 'system') || [],
        [capture],
    );
    const detailSections = useMemo(
        () => capture?.sections.filter(section => section.kind !== 'system') || [],
        [capture],
    );
    const duplicateSummary = useMemo(
        () => capture ? summarizeApiRequestCaptureDuplicates(capture) : null,
        [capture],
    );
    const sourceStats = useMemo(() => {
        if (!capture) return [];
        const grouped = new Map<ApiRequestCaptureSectionKind, { chars: number; count: number; source: string }>();
        capture.sections
            .filter(section => section.kind !== 'system' && section.kind !== 'request' && section.kind !== 'tools')
            .forEach(section => {
            const current = grouped.get(section.kind) || {
                chars: 0,
                count: 0,
                source: getApiRequestCaptureSectionSource(section),
            };
            current.chars += section.chars;
            current.count++;
            grouped.set(section.kind, current);
            });
        const total = [...grouped.values()].reduce((sum, item) => sum + item.chars, 0) || 1;
        return [...grouped.entries()]
            .map(([kind, item]) => ({ ...item, kind, pct: item.chars / total * 100 }))
            .sort((a, b) => b.chars - a.chars);
    }, [capture]);

    const exportTxt = useCallback(async () => {
        if (!capture || !txtReport) return;
        await downloadCaptureTxt(capture, txtReport);
        setCopyNotice('TXT exported');
        window.setTimeout(() => setCopyNotice(''), 1600);
    }, [capture, txtReport]);

    const renderSection = (section: ApiRequestCaptureSection) => {
        const expanded = expandedSectionId === section.id;
        return (
            <div key={section.id} className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/80">
                <button
                    type="button"
                    onClick={() => setExpandedSectionId(expanded ? null : section.id)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                >
                    <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${CAPTURE_KIND_STYLE[section.kind]}`}>
                        {CAPTURE_KIND_LABEL[section.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-600" title={section.label}>{section.label}</span>
                            <span className="shrink-0 font-mono text-[9px] text-slate-400">{fmt(section.chars)} chars</span>
                        </span>
                        <span className="mt-0.5 block break-words text-[9px] leading-relaxed text-slate-400">
                            From: {getApiRequestCaptureSectionSource(section)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[8px] text-slate-300" title={section.path || ''}>
                            {section.path || (section.messageIndex != null ? `messages[${section.messageIndex}]` : 'request body')}
                        </span>
                    </span>
                    <span className="mt-0.5 shrink-0 text-[9px] text-slate-300">{expanded ? '▲' : '▼'}</span>
                </button>
                {expanded && (
                    <CaptureSectionContent
                        content={getApiRequestCaptureSectionContent(capture!, section)}
                        mono={section.kind === 'request' || section.kind === 'tools' || section.kind === 'tool'}
                        onCopy={value => copy(value, 'Section copied')}
                    />
                )}
            </div>
        );
    };

    return (
        <section className="mb-4 border-y border-slate-200/70 py-4" aria-labelledby="one-shot-capture-title">
            <div className="flex items-start justify-between gap-4 px-1">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 id="one-shot-capture-title" className="text-sm font-bold text-slate-700">Send Capture</h3>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold text-slate-400">Auto-off after one use</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                        Once enabled, fully records the content of the next LLM send, so you can see which memory, prompt, or history block is bloating the context.
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={armed}
                    aria-label="Send capture"
                    onClick={onToggle}
                    className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${armed ? 'bg-primary' : 'bg-slate-200'}`}
                >
                    <span className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${armed ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            <div className={`mt-3 rounded-2xl border px-4 py-3 ${
                armed ? 'border-primary/25 bg-primary/5' : capture ? 'border-emerald-200/70 bg-emerald-50/40' : 'border-slate-200/60 bg-slate-50/60'
            }`}>
                <div className="flex items-center gap-2 text-[11px] font-semibold">
                    <span className={`h-2 w-2 rounded-full ${armed ? 'animate-pulse bg-primary' : capture ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className={armed ? 'text-primary' : capture ? 'text-emerald-700' : 'text-slate-500'}>
                        {armed ? 'Waiting for next LLM call…' : capture ? 'Captured, switch turned off automatically' : 'Capture not enabled yet'}
                    </span>
                </div>
                {armed && capture && (
                    <p className="mt-1 pl-4 text-[10px] text-slate-400">Below is the previous result; the next call will overwrite it.</p>
                )}

                {capture && (
                    <div className="mt-3">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                            <Field label="Time" value={`${capturedTime?.day} ${capturedTime?.time}`} />
                            <Field label="App" value={capture.meta.appName} />
                            <Field label="Purpose" value={capture.meta.purpose} />
                            <Field label="Character" value={capture.meta.charName} />
                            <div className="col-span-2"><Field label="Model" value={capture.model} mono wrap /></div>
                        </div>
                        <div className="mt-3 border-y border-emerald-100/80 py-3">
                            <div className="flex items-end justify-between gap-4">
                                <div>
                                    <div className="text-[9px] font-semibold text-slate-400">Input Tokens for This Send</div>
                                    <div className="mt-0.5 text-xl font-bold tracking-tight text-slate-700">{promptTokenValue}</div>
                                </div>
                                <div className="pb-0.5 text-right text-[9px] leading-relaxed text-slate-400">
                                    <div>Self-reported by model response</div>
                                    <div>Not a character-count estimate</div>
                                </div>
                            </div>
                            <div className="mt-2 border-t border-emerald-100/70 pt-2 text-[9px] leading-relaxed text-slate-400">
                                Also: request JSON is {fmt(capture.totalChars)} chars (not tokens) · {capture.messageCount} messages · {capture.sections.length} sections
                            </div>
                        </div>

                        {duplicateSummary && (
                            <div className={`mt-3 border-l-2 py-1.5 pl-3 ${
                                duplicateSummary.groups === 0 ? 'border-emerald-400' : 'border-amber-400'
                            }`}>
                                <div className={`text-[10px] font-bold ${
                                    duplicateSummary.groups === 0 ? 'text-emerald-700' : 'text-amber-700'
                                }`}>
                                    {duplicateSummary.groups === 0
                                        ? '✓ No fully duplicated large blocks found before the request left the client'
                                        : `! Found ${duplicateSummary.groups} duplicate block group(s) within the client request`}
                                </div>
                                <p className="mt-0.5 text-[9px] leading-relaxed text-slate-500">
                                    {duplicateSummary.groups === 0
                                        ? 'If your provider dashboard still shows the same prompt appearing twice, the duplication happened after the request left the client.'
                                        : `The duplicate content adds an extra ${fmt(duplicateSummary.extraChars)} chars; check the source of each section below.`}
                                </p>
                            </div>
                        )}

                        <p className="mt-2 text-[10px] leading-relaxed text-amber-700/80">
                            Content is saved locally only and may include private chat and memory data. Please review before sharing for troubleshooting.
                            {capture.binaryPlaceholders > 0 && ` ${capture.binaryPlaceholders} image/audio binary item(s) only kept their type and original length.`}
                        </p>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => copy(txtReport, 'Full TXT report copied')}
                                className="rounded-xl bg-primary px-3 py-2.5 text-[10px] font-bold text-white active:scale-[0.98] transition-transform"
                            >
                                Copy Full Report
                            </button>
                            <button
                                type="button"
                                onClick={exportTxt}
                                className="rounded-xl border border-primary/20 bg-white px-3 py-2.5 text-[10px] font-bold text-primary active:scale-[0.98] transition-transform"
                            >
                                Export TXT
                            </button>
                        </div>

                        {sourceStats.length > 0 && (
                            <div className="mt-4 border-t border-slate-200/70 pt-3">
                                <div className="flex items-baseline justify-between gap-2">
                                    <h4 className="text-[11px] font-bold text-slate-600">Variable Content Breakdown</h4>
                                    <span className="text-[9px] text-slate-400">Compares dynamic content only · not tokens</span>
                                </div>
                                <p className="mt-1 text-[9px] leading-relaxed text-slate-400">
                                    This focuses on the history, memory, and scene content that changes as you chat; the fixed base instructions are collapsed separately and excluded from the percentages.
                                </p>
                                <div className="mt-2.5 space-y-2.5">
                                    {sourceStats.map(item => (
                                        <div key={item.kind}>
                                            <div className="flex items-baseline gap-2">
                                                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-600" title={item.source}>
                                                    {CAPTURE_KIND_LABEL[item.kind]}
                                                </span>
                                                <span className="shrink-0 font-mono text-[9px] text-slate-400">
                                                    {fmt(item.chars)} chars · {item.pct < 1 ? '<1' : Math.round(item.pct)}%
                                                </span>
                                            </div>
                                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                                                <div
                                                    className="h-full rounded-full bg-primary/55"
                                                    style={{ width: `${Math.max(item.pct, 1.5)}%` }}
                                                />
                                            </div>
                                            <p className="mt-0.5 break-words text-[9px] leading-relaxed text-slate-400">
                                                From: {item.source} · {item.count} section(s)
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {fixedSections.length > 0 && (
                            <div className="mt-4 border-t border-slate-200/70 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setShowFixedSections(value => !value)}
                                    className="flex w-full items-start gap-3 text-left"
                                >
                                    <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-violet-300" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2">
                                            <span className="text-[11px] font-bold text-slate-600">Base Fixed Instructions</span>
                                            <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[8px] font-semibold text-violet-500">Stable baseline</span>
                                        </span>
                                        <span className="mt-0.5 block text-[9px] leading-relaxed text-slate-400">
                                            Needed for the app and presets to work; usually doesn't keep growing with chat turns. Merged into one line here, not treated as a primary bloat source.
                                        </span>
                                    </span>
                                    <span className="shrink-0 pt-0.5 text-[9px] font-semibold text-violet-500">
                                        {showFixedSections ? 'Hide' : 'View Details'}
                                    </span>
                                </button>
                                {showFixedSections && (
                                    <div className="mt-2 space-y-1.5 border-l border-violet-100 pl-3">
                                        {fixedSections.map(renderSection)}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="mt-4 border-t border-slate-200/70 pt-3">
                            <div className="mb-2">
                                <h4 className="text-[11px] font-bold text-slate-600">Dynamic Content & Request Config</h4>
                                <p className="mt-0.5 text-[9px] text-slate-400">Listed in the order actually sent; each section marks its source and original request position.</p>
                            </div>
                            <div className="space-y-1.5">
                            {detailSections.map(renderSection)}

                            <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/80">
                                <button
                                    type="button"
                                    onClick={() => setExpandedSectionId(expandedSectionId === rawId ? null : rawId)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                                >
                                    <span className="shrink-0 rounded-md bg-slate-800 px-1.5 py-0.5 text-[9px] font-semibold text-white">Raw</span>
                                    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-600">Full Request JSON (verify all fields)</span>
                                    <span className="shrink-0 text-[9px] text-slate-300">{expandedSectionId === rawId ? '▲' : '▼'}</span>
                                </button>
                                {expandedSectionId === rawId && (
                                    <CaptureSectionContent
                                        content={JSON.stringify(capture.payload, null, 2)}
                                        mono
                                        onCopy={value => copy(value, 'Full request copied')}
                                    />
                                )}
                            </div>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3">
                            <span className="text-[10px] font-semibold text-primary">{copyNotice}</span>
                            <button type="button" onClick={onClear} className="ml-auto text-[10px] font-semibold text-rose-500">Clear This Capture</button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
};

const CaptureSectionContent: React.FC<{ content: string; mono?: boolean; onCopy: (value: string) => void }> = ({ content, mono, onCopy }) => (
    <div className="border-t border-slate-100 bg-slate-50/70 p-2.5">
        <div className="mb-2 flex justify-end">
            <button type="button" onClick={() => onCopy(content)} className="rounded-lg bg-white px-2 py-1 text-[9px] font-semibold text-primary shadow-sm">
                Copy Section
            </button>
        </div>
        <pre
            tabIndex={0}
            className={`max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200/70 bg-white p-3 text-[10px] leading-5 text-slate-700 select-text ${mono ? 'font-mono' : 'font-sans'}`}
        >
            {content || '(empty content)'}
        </pre>
    </div>
);

/**
 * 输入构成面板：按字数降序列出每块（system 的 ### 段落 / 聚合的聊天历史），
 * 附占比条 + 按字符占比折算的 token 估算（分词器差异下只是量级参考，不是精确值）。
 */
const PromptBreakdownView: React.FC<{ blocks: PromptBlockStat[]; promptTokens?: number }> = ({ blocks, promptTokens }) => {
    const totalChars = blocks.reduce((sum, b) => sum + b.chars, 0) || 1;
    // 写死的固定骨架块（行为规范/表达底线/钢印等）合并成一行——它们不随用户数据
    // 变化、也没有可优化空间，散成一堆小行只会淹没真正有信息量的数据块。
    const fixed = blocks.filter(b => isFixedPromptBlockLabel(b.label));
    const merged: PromptBlockStat[] = fixed.length >= 2
        ? [
            ...blocks.filter(b => !isFixedPromptBlockLabel(b.label)),
            { label: `Fixed prompt (rules/format, ${fixed.length} blocks)`, chars: fixed.reduce((s, b) => s + b.chars, 0) },
        ]
        : blocks;
    const rows = [...merged].sort((a, b) => b.chars - a.chars);
    const fmt = (n: number) => n.toLocaleString('en-US');
    return (
        <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-bold text-slate-400">Input Breakdown · {fmt(totalChars)} chars total</span>
                {promptTokens != null && (
                    <span className="text-[9px] text-slate-300">token counts are estimates prorated by char share</span>
                )}
            </div>
            {rows.map((b, i) => {
                const pct = (b.chars / totalChars) * 100;
                const estTok = promptTokens != null ? Math.round(promptTokens * b.chars / totalChars) : null;
                return (
                    <div key={i} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-2 min-w-0">
                            <span className="text-[10px] text-slate-500 truncate" title={b.label}>{b.label}</span>
                            <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                {fmt(b.chars)} chars{estTok != null ? ` · ~${fmt(estTok)} tok` : ''} · {pct < 1 ? '<1' : Math.round(pct)}%
                            </span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full rounded-full bg-primary/50" style={{ width: `${Math.max(pct, 1.5)}%` }} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const Field: React.FC<{ label: string; value?: string; accent?: boolean; mono?: boolean; wrap?: boolean }> = ({
    label,
    value,
    accent,
    mono,
    wrap,
}) => (
    <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-[10px] text-slate-400 shrink-0">{label}</span>
        <span
            className={`${wrap ? 'break-all' : 'truncate'} ${mono ? 'font-mono' : ''} ${
                accent ? 'font-semibold text-primary' : 'text-slate-600'
            }`}
            title={value || ''}
        >
            {value && value.trim() ? value : '—'}
        </span>
    </div>
);

export default ApiCallLogModal;
