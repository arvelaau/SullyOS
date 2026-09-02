import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, Lightning, Stop } from '@phosphor-icons/react';
import { CharacterBuff, CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';

/** The header only actually uses these fields -- the type is loosened so Group Chat can pass a composite object (group name/group avatar) and reuse this component */
type HeaderCharacter = Pick<CharacterProfile, 'id' | 'name' | 'avatar'> & { activeBuffs?: CharacterBuff[] };

interface TokenBreakdown {
    prompt: number;
    completion: number;
    total: number;
    msgCount: number;
    pass: string;
}

interface ChatHeaderShellProps {
    selectionMode: boolean;
    selectedCount: number;
    onCancelSelection: () => void;
    activeCharacter: HeaderCharacter;
    isTyping: boolean;
    isSummarizing: boolean;
    /** Overrides the status area's "Online" text (Group Chat passes "N members"). Not passed = original behavior */
    statusText?: string;
    /** Optional extra action; Group Chat uses this to place a "memory rules" help entry point. */
    extraAction?: { label: string; icon: React.ReactNode; onClick: () => void };
    /** Trigger-button icon: pass 'stop' to show "stop" while generating. Not passed = original behavior (lightning bolt) */
    triggerIcon?: 'lightning' | 'stop';
    isEmotionEvaluating?: boolean;
    isInstantSending?: boolean;
    isMemoryPalaceProcessing?: boolean;
    memoryPalaceStatusText?: string;
    lastTokenUsage: number | null;
    tokenBreakdown?: TokenBreakdown | null;
    onClose: () => void;
    onTriggerAI: () => void;
    onShowCharsPanel: () => void;
    onDeleteBuff?: (buffId: string) => void;
    /** Hides the header's emotion buff row (the "Show Emotion Row" toggle in Appearance). */
    hideBuffs?: boolean;
    headerStyle?: 'default' | 'minimal' | 'gradient' | 'wechat' | 'telegram' | 'discord' | 'pixel';
    avatarShape?: 'circle' | 'rounded' | 'square';
    headerAlign?: 'left' | 'center';
    headerDensity?: 'compact' | 'default' | 'airy';
    statusStyle?: 'subtle' | 'pill' | 'dot';
    chromeStyle?: 'soft' | 'flat' | 'floating' | 'pixel';
    /** Animal Crossing easter-egg mode: swaps the header for a wood-and-grass-green bar. */
    acnh?: boolean;
}

const COLLAPSED_BUFF_MIN = 2;
const COLLAPSED_BUFF_MAX = 3;
const CHIP_GAP_PX = 2;

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const intensityDots = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

const ChatHeaderShell: React.FC<ChatHeaderShellProps> = ({
    selectionMode,
    selectedCount,
    onCancelSelection,
    activeCharacter,
    isEmotionEvaluating,
    isInstantSending,
    isMemoryPalaceProcessing,
    memoryPalaceStatusText,
    lastTokenUsage,
    tokenBreakdown,
    onClose,
    onTriggerAI,
    onShowCharsPanel,
    onDeleteBuff,
    statusText,
    extraAction,
    triggerIcon = 'lightning',
    hideBuffs = false,
    headerStyle = 'default',
    avatarShape = 'circle',
    headerAlign = 'left',
    headerDensity = 'default',
    statusStyle = 'subtle',
    chromeStyle = 'soft',
    acnh = false,
}) => {
    const buffs: CharacterBuff[] = hideBuffs ? [] : (activeCharacter.activeBuffs || []);
    const [openBuff, setOpenBuff] = useState<CharacterBuff | null>(null);
    const [isBuffListExpanded, setIsBuffListExpanded] = useState(false);
    const [confirmDeleteBuff, setConfirmDeleteBuff] = useState<CharacterBuff | null>(null);
    const [collapsedVisibleCount, setCollapsedVisibleCount] = useState(() => Math.min(COLLAPSED_BUFF_MAX, buffs.length));
    const cardRef = useRef<HTMLDivElement>(null);
    const buffPanelRef = useRef<HTMLDivElement>(null);
    const buffPreviewRef = useRef<HTMLDivElement>(null);
    const measureChipRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const visibleBuffs = buffs.slice(0, collapsedVisibleCount);
    const hiddenBuffCount = Math.max(0, buffs.length - collapsedVisibleCount);

    const toggleBuff = (buff: CharacterBuff) => {
        setOpenBuff((prev) => (prev?.id === buff.id ? null : buff));
    };

    const handleLongPressStart = (buff: CharacterBuff) => {
        longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            setConfirmDeleteBuff(buff);
            setOpenBuff(null);
        }, 600);
    };

    const handleLongPressEnd = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const handleConfirmDelete = () => {
        if (confirmDeleteBuff && onDeleteBuff) {
            onDeleteBuff(confirmDeleteBuff.id);
        }
        setConfirmDeleteBuff(null);
    };

    useEffect(() => {
        if (!openBuff && !isBuffListExpanded) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            const clickedInsideCard = !!cardRef.current?.contains(target);
            const clickedInsideBuffPanel = !!buffPanelRef.current?.contains(target);
            if (!clickedInsideCard && !clickedInsideBuffPanel) {
                setOpenBuff(null);
                setIsBuffListExpanded(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [openBuff, isBuffListExpanded]);

    useEffect(() => {
        setIsBuffListExpanded(false);
        setOpenBuff(null);
        setCollapsedVisibleCount(Math.min(COLLAPSED_BUFF_MAX, buffs.length));
    }, [activeCharacter.id, buffs.length]);

    useEffect(() => {
        if (buffs.length <= COLLAPSED_BUFF_MIN) {
            setCollapsedVisibleCount(buffs.length);
            return;
        }

        const updateCollapsedCount = () => {
            const previewNode = buffPreviewRef.current;
            const containerWidth = previewNode?.clientWidth ?? 0;
            const candidateCount = Math.min(COLLAPSED_BUFF_MAX, buffs.length);
            const widths = measureChipRefs.current
                .slice(0, candidateCount)
                .map((node) => node?.offsetWidth ?? 0);

            if (!containerWidth || widths.length < candidateCount || widths.some((width) => width <= 0)) {
                return;
            }

            const hiddenChipWidth = buffs.length > candidateCount ? 30 : 0;
            const totalWidth = widths.reduce((sum, width) => sum + width, 0)
                + CHIP_GAP_PX * Math.max(0, widths.length - 1)
                + hiddenChipWidth
                + (hiddenChipWidth > 0 ? CHIP_GAP_PX : 0);
            const liveOverflow = !!previewNode && previewNode.scrollWidth - previewNode.clientWidth > 1;
            const nextCount = candidateCount >= 3 && (totalWidth > containerWidth || liveOverflow) ? COLLAPSED_BUFF_MIN : candidateCount;
            setCollapsedVisibleCount((prev) => (prev === nextCount ? prev : nextCount));
        };

        updateCollapsedCount();

        const resizeObserver = typeof ResizeObserver !== 'undefined' && buffPreviewRef.current
            ? new ResizeObserver(updateCollapsedCount)
            : null;
        if (resizeObserver && buffPreviewRef.current) {
            resizeObserver.observe(buffPreviewRef.current);
        }
        window.addEventListener('resize', updateCollapsedCount);
        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', updateCollapsedCount);
        };
    }, [activeCharacter.id, buffs.length]);

    const isDarkHeader = headerStyle === 'discord';
    const isPixelHeader = headerStyle === 'pixel';
    const useCenteredLayout = headerAlign === 'center';
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    // Animal Crossing: emotion buff pills all use a uniform cream background + brown text so they blend into the green header (otherwise each buff's own colored background looks muddy on green)
    const buffChipStyle = (buff: CharacterBuff): React.CSSProperties => acnh
        ? { color: '#6b5a3e', borderColor: '#e6dab4', background: '#fbf4de' }
        : { color: buff.color || '#db2777', borderColor: `${buff.color || '#db2777'}40`, background: `${buff.color || '#db2777'}10` };

    const headerToneClass =
        acnh
          ? 'bg-[#a8d6bb] border-b-[3px] border-[#86c29a] shadow-[0_3px_0_rgba(110,160,130,0.22)]'
          :
        headerStyle === 'gradient'
            ? 'bg-gradient-to-r from-primary/20 via-primary/10 to-white/80 backdrop-blur-xl border-b border-slate-200/60 shadow-sm'
            : headerStyle === 'minimal'
              ? 'bg-white/95 backdrop-blur-md border-b border-slate-200/50 shadow-sm'
              : headerStyle === 'wechat'
                ? 'bg-[#f7f7f7]/95 backdrop-blur-md border-b border-black/5 shadow-none'
                : headerStyle === 'telegram'
                  ? 'bg-white/85 backdrop-blur-xl border-b border-sky-100 shadow-sm'
                  : headerStyle === 'discord'
                    ? 'bg-slate-900/95 backdrop-blur-xl border-b border-white/10 shadow-[0_10px_30px_rgba(15,23,42,0.35)]'
                    : headerStyle === 'pixel'
                      ? 'bg-[#c99872] border-b-[3px] border-[#7b5a40] shadow-[0_4px_0_rgba(123,90,64,0.25)]'
                      : chromeStyle === 'flat'
                        ? 'bg-white border-b border-slate-200 shadow-none'
                        : chromeStyle === 'floating'
                          ? 'bg-white/85 backdrop-blur-xl border-b border-white/70 shadow-sm'
                          : 'bg-white/80 backdrop-blur-xl border-b border-slate-200/60 shadow-sm';
    const headerBaseHeight = headerDensity === 'compact' ? '5rem' : headerDensity === 'airy' ? '7rem' : '6rem';
    // Both alignments use symmetric py so content is vertically centered (the original standard layout only had pb -> content stuck to the bottom, blank space up top, not centered overall).
    const headerDensityClass = headerDensity === 'compact' ? 'px-4 py-2' : headerDensity === 'airy' ? 'px-6 py-4' : 'px-5 py-3';
    // The header background extends under the notch itself: paddingTop yields the safe-top area while the background
    // still stretches from y=0 along with .sully-chat-header, so the notch strip is just the header's own color,
    // seamless with the rest of the app (replaces the old "transparent spacer" approach).
    // minHeight is a floor, not a fixed height -- under border-box, padding stacks on top of it and grows the
    // element instead of squeezing the content (unlike a fixed h-NN, which would clip it).
    // Chat is on the SELF_SAFE_AREA_APPS list, so the shell no longer adds safe-top; adding it once here doesn't double up.
    const headerSafeStyle: React.CSSProperties = { minHeight: headerBaseHeight, paddingTop: 'var(--safe-top)' };
    const primaryTextClass = acnh ? 'text-[#6b5a3e]' : isDarkHeader ? 'text-white' : isPixelHeader ? 'text-[#fff7ed]' : 'text-slate-800';
    const secondaryTextClass = acnh ? 'text-[#5a9e7a]' : isDarkHeader ? 'text-slate-400' : isPixelHeader ? 'text-[#f3ddc7]' : 'text-slate-400';
    const iconButtonClass = acnh
        ? 'text-[#6b5a3e] hover:bg-black/5 rounded-full'
        : isDarkHeader
        ? 'text-slate-200 hover:bg-white/10 rounded-full'
        : isPixelHeader
          ? 'text-[#fff7ed] hover:bg-[#f8f0e0]/20 rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0]/10'
          : 'text-slate-500 hover:bg-slate-100 rounded-full';
    const actionButtonClass = acnh
        ? 'text-[#6b5a3e] hover:bg-black/5 rounded-full'
        : isDarkHeader
        ? 'text-sky-300 hover:bg-sky-400/10 rounded-full'
        : isPixelHeader
          ? 'text-[#fff7ed] hover:bg-[#f8f0e0]/20 rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0]/10'
          : 'text-indigo-500 hover:bg-indigo-50 rounded-full';

    const onlineStatusNode = headerStyle === 'telegram'
        ? null
        : statusStyle === 'pill' ? (
            <div className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold border ${isDarkHeader ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/25' : 'bg-emerald-50 text-emerald-500 border-emerald-100'}`}>
                {statusText ?? 'online'}
            </div>
        ) : statusStyle === 'dot' ? (
            <div className={`flex items-center gap-1 text-[10px] ${secondaryTextClass}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>{statusText ?? 'Online'}</span>
            </div>
        ) : (
            <div className={`text-[10px] uppercase ${secondaryTextClass}`}>{statusText ?? 'Online'}</div>
        );

    const triggerIconNode = triggerIcon === 'stop'
        ? <Stop className="w-5 h-5" weight="fill" />
        : <Lightning className="w-5 h-5" weight="bold" />;

    const renderBuffRow = (centered: boolean) => {
        if (buffs.length === 0) return null;
        return (
            <div className={`sully-chat-buffs relative w-full min-w-0 max-w-full ${centered ? 'flex justify-center' : ''}`}>
                <div
                    ref={buffPreviewRef}
                    className={`flex w-full min-w-0 max-w-full items-center gap-0.5 overflow-x-auto whitespace-nowrap pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${centered ? 'justify-center' : ''}`}
                >
                    {visibleBuffs.map((buff) => (
                        <button
                            key={buff.id}
                            onClick={(e) => { e.stopPropagation(); toggleBuff(buff); }}
                            onTouchStart={(e) => { e.stopPropagation(); handleLongPressStart(buff); }}
                            onTouchEnd={handleLongPressEnd}
                            onTouchCancel={handleLongPressEnd}
                            onMouseDown={(e) => { if (e.button === 0) handleLongPressStart(buff); }}
                            onMouseUp={handleLongPressEnd}
                            onMouseLeave={handleLongPressEnd}
                            className="shrink-0 max-w-[8.75rem] truncate text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border cursor-pointer transition-colors select-none"
                            style={buffChipStyle(buff)}
                            title={buff.label}
                        >
                            {buff.emoji ? `${buff.emoji} ` : ''}
                            {buff.label}
                        </button>
                    ))}
                    {hiddenBuffCount > 0 && (
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsBuffListExpanded((prev) => !prev); }}
                            className={`shrink-0 min-w-[22px] text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border transition-colors ${acnh ? 'border-[#e6dab4] text-[#6b5a3e] bg-[#fbf4de]' : 'border-slate-300 text-slate-500 bg-slate-100/90 hover:bg-slate-200/80'}`}
                            title="View all states"
                        >
                            +{hiddenBuffCount}
                        </button>
                    )}
                </div>

                <div className="pointer-events-none absolute -z-10 h-0 overflow-hidden opacity-0" aria-hidden>
                    <div className="flex items-center gap-0.5 whitespace-nowrap">
                        {buffs.slice(0, Math.min(COLLAPSED_BUFF_MAX, buffs.length)).map((buff, index) => (
                            <span
                                key={`measure-${buff.id}`}
                                ref={(node) => { measureChipRefs.current[index] = node; }}
                                className="inline-flex shrink-0 max-w-[8.75rem] text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border"
                                style={buffChipStyle(buff)}
                            >
                                {buff.emoji ? `${buff.emoji} ` : ''}
                                {buff.label}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const floatingStatusNodes = (lastTokenUsage || isInstantSending || isEmotionEvaluating || isMemoryPalaceProcessing) ? (
        <div className={`absolute ${extraAction ? 'right-20' : 'right-12'} top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none`}>
            {lastTokenUsage && (
                <div className={`sully-chat-token text-[9px] px-1.5 py-0.5 rounded-md font-mono border ${isDarkHeader ? 'bg-slate-800 text-slate-300 border-white/10' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-slate-100/95 text-slate-400 border-slate-200'}`}>
                    {lastTokenUsage}
                </div>
            )}
            {isInstantSending && (
                <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-sky-500/15 text-sky-200 border-sky-400/20' : isPixelHeader ? 'bg-[#eff6ff] text-[#1d4ed8] border-[#1d4ed8]/20' : 'bg-sky-50/95 text-sky-600 border-sky-200'}`}>
                    Sending…
                </div>
            )}
            {isEmotionEvaluating && (
                <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-violet-500/15 text-violet-200 border-violet-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-violet-50/95 text-violet-500 border-violet-200'}`}>
                    Analyzing mood
                </div>
            )}
            {isMemoryPalaceProcessing && (
                <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-indigo-500/15 text-indigo-200 border-indigo-400/20' : isPixelHeader ? 'bg-[#f5f3ff] text-[#4338ca] border-[#4338ca]/20' : 'bg-indigo-50/95 text-indigo-600 border-indigo-200'}`}>
                    {memoryPalaceStatusText || 'Organizing memories'}
                </div>
            )}
        </div>
    ) : null;

    const renderCenteredInfo = () => (
        <div className="flex w-full min-w-0 max-w-full flex-col items-center text-center">
            <TokenImg value={activeCharacter.avatar} className={`sully-chat-avatar w-10 h-10 object-cover shadow-sm ${avatarRadiusClass}`} alt="avatar" />
            <div className={`sully-chat-name mt-1 font-bold ${primaryTextClass}`}>{activeCharacter.name}</div>
            {buffs.length > 0 && (
                <div className="mt-1 min-h-[18px] w-full">
                    {renderBuffRow(true)}
                </div>
            )}
        </div>
    );

    const renderStandardInfo = () => (
        <>
            <TokenImg value={activeCharacter.avatar} className={`sully-chat-avatar w-10 h-10 object-cover shadow-sm ${avatarRadiusClass}`} alt="avatar" />
            <div className="sully-chat-info flex-1 min-w-0 flex flex-col items-start text-left">
                <div className={`sully-chat-name font-bold ${primaryTextClass}`}>{activeCharacter.name}</div>
                <div className="sully-chat-status flex items-center gap-2 flex-wrap">
                    {onlineStatusNode}
                    {lastTokenUsage && (
                        <div className={`sully-chat-token text-[9px] px-1.5 py-0.5 rounded-md font-mono border ${isDarkHeader ? 'bg-slate-800 text-slate-300 border-white/10' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-slate-100 text-slate-400 border-slate-200'}`} title={tokenBreakdown ? `prompt: ${tokenBreakdown.prompt} | completion: ${tokenBreakdown.completion} | msgs: ${tokenBreakdown.msgCount} | pass: ${tokenBreakdown.pass}` : ''}>
                            {lastTokenUsage}
                        </div>
                    )}
                    {isInstantSending && (
                        <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-sky-500/15 text-sky-200 border-sky-400/20' : isPixelHeader ? 'bg-[#eff6ff] text-[#1d4ed8] border-[#1d4ed8]/20' : 'bg-sky-50 text-sky-600 border-sky-200'}`}>
                            Sending…
                        </div>
                    )}
                    {isEmotionEvaluating && (
                        <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-violet-500/15 text-violet-200 border-violet-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-violet-50 text-violet-500 border-violet-200'}`}>
                            Analyzing mood
                        </div>
                    )}
                </div>
                {buffs.length > 0 && (
                    <div className="mt-1 w-full">
                        {renderBuffRow(false)}
                    </div>
                )}
            </div>
        </>
    );

    return (
        <div className="shrink-0 z-30 sticky top-0">
        {/* Header body: the sully-chat-header hook's background stretches from y=0, paddingTop yields safe-top, and the notch strip is the header's own background (seamless, matches the rest of the app); content is vertically centered */}
        <div className={`sully-chat-header ${headerDensityClass} flex items-center relative ${headerToneClass}`} style={headerSafeStyle}>
            {/* Animal Crossing easter egg: a solid-color pine-tree silhouette in the header's bottom-right corner (z-[-1], below the content, doesn't block buttons). Placed inside the header body itself rather than the outer spacer, otherwise it would drift up onto the notch */}
            {acnh && !selectionMode && (
                <svg viewBox="0 0 140 46" className="absolute right-2 bottom-[5px] h-9 w-auto pointer-events-none" style={{ zIndex: -1, opacity: 0.9 }} fill="#76b48f" aria-hidden>
                    <rect x="98" y="40" width="4" height="6" /><path d="M84 41 L116 41 L100 24Z" /><path d="M88 32 L112 32 L100 18Z" /><path d="M91 24 L109 24 L100 10Z" />
                    <rect x="72" y="40" width="4" height="6" /><path d="M62 41 L86 41 L74 27Z" /><path d="M65 33 L83 33 L74 21Z" />
                    <rect x="122" y="41" width="3" height="5" /><path d="M114 42 L134 42 L124 30Z" /><path d="M117 35 L131 35 L124 24Z" />
                </svg>
            )}
            {selectionMode ? (
                <div className="flex items-center justify-between w-full">
                    <button onClick={onCancelSelection} className={`text-sm font-bold px-2 py-1 ${secondaryTextClass}`}>Cancel</button>
                    <span className={`text-sm font-bold ${primaryTextClass}`}>{selectedCount} selected</span>
                    <div className="w-10" />
                </div>
            ) : useCenteredLayout ? (
                <div className="relative w-full min-h-[56px] flex items-end justify-center">
                    <button onClick={onClose} className={`sully-chat-back absolute left-0 bottom-2 p-2 ${iconButtonClass}`}>
                        <CaretLeft className="w-5 h-5" weight="bold" />
                    </button>

                    {floatingStatusNodes}

                    <div
                        onClick={onShowCharsPanel}
                        className={`flex ${extraAction ? 'w-[calc(100%-11rem)]' : 'w-[calc(100%-7rem)]'} max-w-[420px] cursor-pointer items-end justify-center`}
                    >
                        {renderCenteredInfo()}
                    </div>

                    <button onClick={onTriggerAI} className={`sully-chat-trigger absolute right-0 bottom-2 p-2 ${actionButtonClass}`} title={triggerIcon === 'stop' ? 'Stop generating' : 'Trigger AI'}>
                        {triggerIconNode}
                    </button>
                    {extraAction && (
                        <button onClick={extraAction.onClick} className={`absolute right-10 bottom-2 p-2 ${iconButtonClass}`} title={extraAction.label} aria-label={extraAction.label}>
                            {extraAction.icon}
                        </button>
                    )}

                </div>
            ) : (
                <div className="flex items-center gap-3 w-full">
                    <button onClick={onClose} className={`sully-chat-back p-2 -ml-2 ${iconButtonClass}`}>
                        <CaretLeft className="w-5 h-5" weight="bold" />
                    </button>

                    <div onClick={onShowCharsPanel} className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer">
                        {renderStandardInfo()}
                    </div>

                    {extraAction && (
                        <button onClick={extraAction.onClick} className={`p-2 ml-auto ${iconButtonClass}`} title={extraAction.label} aria-label={extraAction.label}>
                            {extraAction.icon}
                        </button>
                    )}
                    <button onClick={onTriggerAI} className={`sully-chat-trigger p-2 ${extraAction ? '' : 'ml-auto'} ${actionButtonClass}`} title={triggerIcon === 'stop' ? 'Stop generating' : 'Trigger AI'}>
                        {triggerIconNode}
                    </button>
                </div>
            )}

            {isBuffListExpanded && hiddenBuffCount > 0 && (
                <div ref={buffPanelRef} className="absolute top-full left-4 right-4 mt-1 bg-white rounded-xl shadow-lg border border-slate-200 p-3 z-40">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">All States</div>
                    <div className="max-h-36 overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <div className="flex flex-wrap gap-1.5">
                            {buffs.map((buff) => (
                                <button
                                    key={`panel-${buff.id}`}
                                    onClick={(e) => { e.stopPropagation(); toggleBuff(buff); }}
                                    onTouchStart={(e) => { e.stopPropagation(); handleLongPressStart(buff); }}
                                    onTouchEnd={handleLongPressEnd}
                                    onTouchCancel={handleLongPressEnd}
                                    onMouseDown={(e) => { if (e.button === 0) handleLongPressStart(buff); }}
                                    onMouseUp={handleLongPressEnd}
                                    onMouseLeave={handleLongPressEnd}
                                    className="text-[10px] px-2 py-1 rounded-lg font-bold border cursor-pointer transition-colors select-none"
                                    style={buffChipStyle(buff)}
                                >
                                    {buff.emoji ? `${buff.emoji} ` : ''}
                                    {buff.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {openBuff && (
                <div ref={cardRef} className="absolute top-full left-4 right-4 mt-1 bg-white rounded-xl shadow-lg border border-slate-200 p-3 z-50">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold" style={{ color: openBuff.color || '#db2777' }}>
                                {openBuff.emoji ? `${openBuff.emoji} ` : ''}
                                {openBuff.label}
                            </span>
                            <div className="text-xs font-bold tracking-wide" style={{ color: openBuff.color || '#db2777' }}>
                                {intensityDots(openBuff.intensity)}{' '}
                                {normalizeIntensity(openBuff.intensity) === 1 ? 'Mild' : normalizeIntensity(openBuff.intensity) === 2 ? 'Moderate' : 'Strong'}
                            </div>
                        </div>
                        <button onClick={() => setOpenBuff(null)} className="text-slate-300 hover:text-slate-500 text-lg leading-none px-1">
                            {'\u00d7'}
                        </button>
                    </div>
                    {openBuff.description ? (
                        <p className="text-sm text-slate-600 leading-relaxed">{openBuff.description}</p>
                    ) : (
                        <p className="text-xs text-slate-400 italic">No details yet</p>
                    )}
                </div>
            )}

            {confirmDeleteBuff && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 bg-slate-900/45 backdrop-blur-[1px] z-[100]" onClick={() => setConfirmDeleteBuff(null)}>
                    <div className="absolute left-1/2 top-1/2 w-[min(88vw,360px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-white/40 bg-white/95 p-5 shadow-2xl shadow-slate-900/25" onClick={(e) => e.stopPropagation()}>
                        <div className="text-center mb-4">
                            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-100 to-red-100 text-xl shadow-inner">
                                {confirmDeleteBuff.emoji || '🗑'}
                            </div>
                            <div className="font-bold text-slate-800 text-sm">Delete Emotion State</div>
                            <div className="text-xs text-slate-500 mt-1 leading-relaxed">
                                Are you sure you want to delete "{confirmDeleteBuff.label}"?
                                <br />
                                Its matching prompt will be removed too.
                            </div>
                        </div>
                        <div className="flex gap-2.5">
                            <button
                                onClick={() => setConfirmDeleteBuff(null)}
                                className="flex-1 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 rounded-2xl hover:bg-slate-200 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmDelete}
                                className="flex-1 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-rose-500 to-red-500 rounded-2xl hover:from-rose-600 hover:to-red-600 shadow-lg shadow-red-200/80 transition-all"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
        </div>
    );
};

export default ChatHeaderShell;
