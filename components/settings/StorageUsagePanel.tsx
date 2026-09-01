/**
 * 本机存储用量面板
 *
 * 摆在「备份与恢复」板块顶部，回答两件事：数据多大、系统会不会随手把它清掉。
 *
 * 总量和持久化状态是秒回的，进来就显示；「都是些什么占的」要翻库，所以折叠起来、
 * 点开才算，算的时候显示进度，别让用户对着空白等。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    readStorageOverview,
    requestPersistentStorage,
    computeStorageBreakdown,
    formatBytes,
    type StorageOverview,
    type StorageBreakdown,
    type BreakdownProgress,
} from '../../utils/storageStats';
import { optimizeResourceStorage, type OptimizeProgress, type OptimizeResult } from '../../utils/storageOptimize';
import { trackEvent } from '../../utils/analytics';

/**
 * 算好的结果放模块级缓存：SettingsSection 收起时会把子树整个卸载，
 * 不缓存的话用户每收一次再展开就得重算一遍。要最新数字点「重新计算」。
 */
let cachedBreakdown: StorageBreakdown | null = null;

/**
 * 分类合计和 estimate() 总量差多少才值得单独交代。
 * 绝对值够大、或者占了总量一成以上都算 —— 只看绝对值的话，几百 KB 的小库永远不显示，
 * 用户会盯着「总共 165 KB，细分只有 9 KB」发懵。
 */
const OTHER_USAGE_MIN_BYTES = 1024 * 1024;
const OTHER_USAGE_MIN_RATIO = 0.1;

/** 合并完成后自动刷新前留的一点时间，让用户看清这轮到底做了什么。 */
const MERGE_RELOAD_DELAY_MS = 2500;

/**
 * 合并过重复图片就排一次整页刷新，排过了就不再排。
 *
 * 计时器和标记都放在组件外面，是因为这次刷新是数据一致性动作，不是界面上的顺手事：
 * 合并只改了库里的引用，内存里的 theme / customIcons 还捏着合并前的令牌，带着它导出
 * 备份，同一张图会被写成两份。所以用户在这 2.5 秒里收起板块、退出设置页、或者再点一次
 * 「一键优化」（这些都会把面板卸掉或重置状态），刷新照样得来。
 */
let mergeReloadScheduled = false;
function scheduleMergeReload(): void {
    if (mergeReloadScheduled) return;
    mergeReloadScheduled = true;
    setTimeout(() => window.location.reload(), MERGE_RELOAD_DELAY_MS);
}

type PersistAttempt = 'none' | 'granted' | 'denied';

/**
 * 把优化结果讲成人话。两笔账分开说：转格式是当场就省下的，合并重复要等下一次
 * 孤儿清理才真的把空间还回来（合并只改引用、不删图，见 utils/blobDedupe.ts）。
 */
function describeOptimizeResult(r: OptimizeResult): string {
    const parts: string[] = [];
    if (r.converted > 0) {
        parts.push(`Converted ${r.converted} image(s) to binary storage, freeing about ${formatBytes(Math.max(0, r.bytesBefore - r.bytesAfter))}`);
    }
    if (r.mergedDuplicates > 0) {
        parts.push(`Merged ${r.mergedDuplicates} duplicate image(s) into one — about ${formatBytes(r.reclaimableBytes)} will be freed on the next cleanup`);
    }
    if (r.vectorsCompacted > 0) {
        parts.push(`Compacted ${r.vectorsCompacted} memory vector(s) into a compact format`);
    }
    const reloadNote = r.mergedDuplicates > 0 ? ' The page will reload shortly so the UI and backups both use the merged images.' : '';
    const vectorNote = r.vectorError ? ` The memory-vector step didn't finish: ${r.vectorError}. Click again to continue compacting.` : '';
    if (parts.length === 0) {
        if (r.failed > 0) return `${r.failed} image(s) failed to convert (kept as-is); nothing else needs optimizing.${vectorNote}`;
        if (vectorNote) return `No images need optimizing.${vectorNote}`;
        return r.scanUnavailable
            ? 'No images need optimizing. Could not check for duplicate images this time — try again in a different environment.'
            : 'Nothing needs optimizing — storage is already as compact as it gets.';
    }
    let text = `${parts.join('; ')}.`;
    if (r.failed > 0) text += ` Also, ${r.failed} failed to convert and were kept as-is.`;
    if (r.skippedGroups > 0) text += ` ${r.skippedGroups} duplicate group(s) were not merged — they're used somewhere that deletes the old image on replacement, so merging them risked accidental deletion.`;
    if (r.scanUnavailable) text += ' Could not check for duplicate images this time — try again in a different environment.';
    return text + vectorNote + reloadNote;
}

const StorageUsagePanel: React.FC = () => {
    const [overview, setOverview] = useState<StorageOverview | null>(null);
    const [persisting, setPersisting] = useState(false);
    const [attempt, setAttempt] = useState<PersistAttempt>('none');

    const [expanded, setExpanded] = useState(false);
    const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(cachedBreakdown);
    const [computing, setComputing] = useState(false);
    const [progress, setProgress] = useState<BreakdownProgress | null>(null);
    const [breakdownError, setBreakdownError] = useState(false);

    const [optimizing, setOptimizing] = useState(false);
    const [optimizeProgress, setOptimizeProgress] = useState<OptimizeProgress | null>(null);
    const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
    const [optimizeError, setOptimizeError] = useState<string | null>(null);

    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const refreshOverview = useCallback(async () => {
        const next = await readStorageOverview();
        if (aliveRef.current) setOverview(next);
    }, []);

    useEffect(() => { void refreshOverview(); }, [refreshOverview]);

    const runBreakdown = useCallback(async () => {
        setComputing(true);
        setBreakdownError(false);
        setProgress(null);
        try {
            const result = await computeStorageBreakdown(p => {
                if (aliveRef.current) setProgress(p);
            });
            cachedBreakdown = result;
            if (aliveRef.current) setBreakdown(result);
        } catch {
            if (aliveRef.current) setBreakdownError(true);
        } finally {
            if (aliveRef.current) { setComputing(false); setProgress(null); }
        }
    }, []);

    const handleToggle = useCallback(() => {
        const next = !expanded;
        setExpanded(next);
        if (next) trackEvent('View Storage Usage Details');
        if (next && !cachedBreakdown && !computing) void runBreakdown();
    }, [expanded, computing, runBreakdown]);

    const handleOptimize = useCallback(async () => {
        if (optimizing) return;
        setOptimizing(true);
        setOptimizeResult(null);
        setOptimizeError(null);
        setOptimizeProgress(null);
        try {
            const result = await optimizeResourceStorage(p => {
                if (aliveRef.current) setOptimizeProgress(p);
            });
            // 排在面板存活判断之前：引用已经在库里合并了，内存里的旧令牌就得靠刷新换掉，
            // 这件事跟面板还在不在没关系。
            if (result.mergedDuplicates > 0) scheduleMergeReload();
            if (!aliveRef.current) return;
            setOptimizeResult(result);
            // 用量和细分都变了：总量刷新，细分缓存作废（下次展开重算）
            cachedBreakdown = null;
            setBreakdown(null);
            await refreshOverview();
        } catch (error) {
            if (aliveRef.current) setOptimizeError(error instanceof Error ? error.message : String(error));
        } finally {
            if (aliveRef.current) { setOptimizing(false); setOptimizeProgress(null); }
        }
    }, [optimizing, refreshOverview]);

    const handlePersist = useCallback(async () => {
        setPersisting(true);
        try {
            const granted = await requestPersistentStorage();
            // 成败都记一笔：要是这个按钮的通过率常年是 0，那它就是个摆设，得换做法。
            trackEvent('Request Persistent Storage Permission', { result: granted ? 'granted' : 'denied' });
            if (!aliveRef.current) return;
            setAttempt(granted ? 'granted' : 'denied');
            await refreshOverview();
        } finally {
            if (aliveRef.current) setPersisting(false);
        }
    }, [refreshOverview]);

    const usage = overview?.usageBytes ?? null;
    const quota = overview?.quotaBytes ?? null;
    const percent = usage != null && quota != null && quota > 0
        ? Math.min(100, (usage / quota) * 100)
        : null;
    const barColor = percent == null ? 'bg-slate-300'
        : percent >= 90 ? 'bg-gradient-to-r from-rose-400 to-red-500'
        : percent >= 70 ? 'bg-gradient-to-r from-amber-400 to-orange-500'
        : 'bg-gradient-to-r from-violet-400 to-purple-500';

    // estimate() 的总量还包含 Cache Storage（离线缓存的 JS / 图片）这类我们碰不到的东西，
    // 所以分类合计天然会少一截。差得多的时候单独列一行，省得用户以为数字对不上。
    const otherUsage = usage != null && breakdown != null ? usage - breakdown.totalBytes : null;
    const showOtherUsage = otherUsage != null && otherUsage > 0 && (
        otherUsage >= OTHER_USAGE_MIN_BYTES || (usage != null && usage > 0 && otherUsage / usage >= OTHER_USAGE_MIN_RATIO)
    );

    const persisted = overview?.persisted ?? null;

    return (
        <div data-testid="storage-usage-panel" className="mb-5 pb-4 border-b border-slate-100">
            {/* ── 总量 ── */}
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-xs font-bold text-slate-600">Local Data</span>
                <span className="text-sm font-bold text-slate-700 tabular-nums">
                    {overview == null ? 'Loading…' : formatBytes(usage)}
                </span>
            </div>

            {percent != null && (
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-1.5">
                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.max(1, percent)}%` }} />
                </div>
            )}

            <p className="text-[10px] text-slate-400 mb-3">
                {overview == null
                    ? 'Reading the usage figures from your browser…'
                    : !overview.supported
                        ? 'This browser does not provide storage usage info'
                        : quota != null
                            ? `Limit ${formatBytes(quota)}${percent != null ? ` · ${percent.toFixed(1)}% used` : ''} · Estimated by the browser`
                            : 'Browser did not report a limit · Estimated by the browser'}
            </p>

            {/* ── 持久化许可 ── */}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            persisted === true ? 'bg-emerald-500' : persisted === false ? 'bg-amber-500' : 'bg-slate-300'
                        }`} />
                        <span className="text-[11px] font-bold text-slate-600">Persistent Storage Permission</span>
                        <span className={`text-[11px] font-bold ${
                            persisted === true ? 'text-emerald-600' : persisted === false ? 'text-amber-600' : 'text-slate-400'
                        }`}>
                            {persisted === true ? 'Granted' : persisted === false ? 'Not Granted' : 'Unable to Check'}
                        </span>
                    </div>
                    {persisted !== true && overview != null && (
                        <button
                            type="button"
                            onClick={handlePersist}
                            disabled={persisting}
                            className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50"
                        >
                            {persisting ? 'Requesting…' : 'Try Again'}
                        </button>
                    )}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
                    {persisted === true
                        ? 'The system will not clear your data when reclaiming storage space.'
                        : attempt === 'denied'
                            ? 'The browser did not approve it this time. Install SullyOS to your home screen, or allow notifications, then try again — that noticeably improves the odds of approval.'
                            : 'When storage runs low, the system may clear your data along with everything else. Installing SullyOS to your home screen, or allowing notifications, can improve the approval odds.'}
                </p>
            </div>

            {/* ── 优化资源存储（一次性迁移，幂等可重跑） ── */}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-600">Optimize Resource Storage</span>
                    <button
                        type="button"
                        onClick={handleOptimize}
                        disabled={optimizing}
                        className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                        {optimizing ? 'Optimizing…' : 'Optimize Now'}
                    </button>
                </div>
                <p className={`mt-1.5 text-[10px] leading-relaxed ${optimizeError ? 'text-rose-500' : 'text-slate-400'}`}>
                    {optimizing
                        ? (optimizeProgress
                            ? `Processing: ${optimizeProgress.label} (${optimizeProgress.done}/${optimizeProgress.total})…`
                            : 'Scanning…')
                        : optimizeError
                            ? optimizeError
                            : optimizeResult
                                ? describeOptimizeResult(optimizeResult)
                                : 'Converts images still stored as base64 in old data to binary all at once, merges duplicate copies of the same image into one, and compacts memory vectors into a compact format. Once run, things are clean; run it again after importing an old backup.'}
                </p>
                {/* 合并动的是库里的引用，内存里的 theme / customIcons 还捏着合并前的令牌。
                    不刷新的话：界面照常显示，但导出的备份里 metadata 写的仍是旧令牌，
                    同一张图又变成两份进包——看起来就像「优化根本没生效」。所以优化一跑完就
                    排好了自动刷新（见 scheduleMergeReload），不指望用户记得点；
                    这个按钮只是让人不想等的时候立刻走。 */}
                {!optimizing && optimizeResult && optimizeResult.mergedDuplicates > 0 && (
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-2 w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all"
                    >
                        Refresh Now
                    </button>
                )}
            </div>

            {/* ── 细分（折叠） ── */}
            <button
                type="button"
                onClick={handleToggle}
                className="w-full flex items-center gap-1.5 text-[11px] font-bold text-slate-500 py-1 active:scale-[0.99] transition-all"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
                <span>See what's taking up space</span>
            </button>

            {expanded && (
                <div className="mt-2">
                    {computing ? (
                        <div className="flex items-center gap-2 px-1 py-3">
                            <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-violet-400 animate-spin shrink-0" />
                            <span className="text-[10px] text-slate-400">
                                {progress && progress.total > 0
                                    ? `Calculating… scanned ${progress.done}/${progress.total} tables`
                                    : 'Calculating…'}
                            </span>
                        </div>
                    ) : breakdownError ? (
                        <div className="px-1 py-3">
                            <p className="text-[10px] text-rose-500 mb-2">Could not read the breakdown (the database may be in use by another tab).</p>
                            <button type="button" onClick={() => void runBreakdown()} className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                Retry
                            </button>
                        </div>
                    ) : breakdown ? (
                        <>
                            <div className="space-y-1.5 mb-2">
                                {breakdown.categories.map(c => (
                                    <div key={c.key} className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-500 truncate">{c.label}</span>
                                        <span className="text-[11px] text-slate-600 font-medium tabular-nums shrink-0">
                                            {c.estimated ? 'approx. ' : ''}{formatBytes(c.bytes)}
                                        </span>
                                    </div>
                                ))}
                                {showOtherUsage && (
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-400 truncate">Web cache, etc.</span>
                                        <span className="text-[11px] text-slate-400 font-medium tabular-nums shrink-0">approx. {formatBytes(otherUsage)}</span>
                                    </div>
                                )}
                                {breakdown.categories.length === 0 && !showOtherUsage && (
                                    <p className="text-[10px] text-slate-400">Nothing has been stored yet.</p>
                                )}
                            </div>

                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[10px] text-slate-300 leading-relaxed">
                                    {[
                                        breakdown.categories.some(c => c.estimated) ? 'Items marked "approx." are sampled estimates' : '',
                                        // 数据的原始大小比它实际占的地方大——浏览器落盘时会压一道。
                                        // 不折算的话细分加起来会超过上面的总量，看着像算错了。
                                        breakdown.calibrated ? 'Each figure is adjusted for actual on-disk usage, a bit smaller than the raw data size' : '',
                                        showOtherUsage ? '"Web cache, etc." is system usage like offline caching — it cannot be removed and does not need attention' : '',
                                        breakdown.failedStores.length > 0 ? `${breakdown.failedStores.length} table(s) could not be read` : '',
                                    ].filter(Boolean).join('; ')}
                                </p>
                                <button type="button" onClick={() => void runBreakdown()} className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                    Recalculate
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
};

export default StorageUsagePanel;
