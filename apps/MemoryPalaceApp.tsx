import React, { useState, useEffect, useCallback, useDeferredValue, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
    MemoryRoom, MemoryNode, ROOM_CONFIGS, ROOM_LABELS, getRoomLabel,
    MemoryNodeDB, AnticipationDB, MemoryLinkDB, EventBoxDB,
    migrateOldMemories, runCognitiveDigestion, getAvailableMonths, getAvailableChunks,
    detectPersonalityStyle,
    manuallyBindMemories, removeMemoryFromBox, unbindAllLiveMemories,
    reviveArchivedMemory,
    wipeAllMemoryPalace,
    exportMemoryPalace, importMemoryPalace, isMemoryPalaceExportFile,
    DigestReportDB, PLATE_TITLES,
    bootstrapPlatesFromHistory, markPlateBootstrapDone,
    getBootstrapResume, setBootstrapResume, clearBootstrapResume,
    updateStoredMemoryNode,
    DEFAULT_CHARACTER_ACCOMMODATION,
} from '../utils/memoryPalace';
import type { Anticipation, MigrationProgress, DigestResult, MemoryLink, EventBox, DigestReport } from '../utils/memoryPalace';
import { confirmExportSafety } from '../utils/exportGuard';
import type { CharacterAccommodationPolicy, CharacterProfile, MemoryPalaceWaterlinePreset, Message } from '../types';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import TokenImg from '../components/os/TokenImg';
import {
    CONTEXT_RANGE_POLICY_VERSION,
    DEFAULT_MANUAL_CONTEXT_LIMIT,
} from '../utils/chatContextRange';
import {
    buildRangeSearchEntries,
    filterRangeSearchEntries,
    getRangeEndpointLabel,
    getRangeSelectionHint,
} from '../utils/memoryPalace/rangeSelection';
import { trackEvent } from '../utils/analytics';
import { shareOrDownloadFile } from '../utils/shareExport';
import {
    EXTERNAL_MEMORY_MAX_CHARS,
    getExternalMemoryLengthInfo,
    getExternalMemoryOverLimitMessage,
} from '../utils/memoryPalace/externalMemory';
import {
    MAX_MEMORY_BUFFER_THRESHOLD,
    MAX_MEMORY_HOT_ZONE_SIZE,
    MEMORY_PALACE_WATERLINE_PRESETS,
    MIN_MEMORY_BUFFER_THRESHOLD,
    MIN_MEMORY_HOT_ZONE_SIZE,
    makeCustomMemoryPalaceWaterline,
    resolveMemoryPalaceWaterline,
} from '../utils/memoryPalace/waterline';

/** Manual summary panel: how many chat messages to render per page (pagination, avoids DOM lag from dumping hundreds at once) */
const RANGE_PAGE_SIZE = 50;

/** Manual summary panel: formats a millisecond timestamp as "2026-03-20 14:30" */
const fmtRangeTs = (ts: number): string => {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString('en-US', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
        });
    } catch { return ''; }
};

/** Internal UI type: unifies how a "link" source is described (EventBox sibling or legacy MemoryLink) */
type LinkedMemoryUI = {
    /** Pseudo link ID, used as the React key */
    id: string;
    /** Relation type: box sibling (live / summary / archived) or legacy causal link */
    relation: 'box_live' | 'box_summary' | 'box_archived' | 'legacy_causal';
    /** The EventBox it belongs to (non-null for box relations) */
    box?: EventBox | null;
    node: MemoryNode;
};

// ─── Room icon mapping ─────────────────────────────────────

/**
 * Top safe-area padding: uses the project's shared --safe-top (accounts for notch/Dynamic Island height
 * plus the standalone-PWA fallback), adds 16px of breathing room, and guarantees at least 40px so the
 * status bar never covers a button.
 * Each view's outermost scroll container (which owns the background) applies this paddingTop directly,
 * letting the background extend up under the notch.
 */
const SAFE_PAD_TOP: React.CSSProperties['paddingTop'] = 'max(40px, calc(var(--safe-top) + 16px))';

/** Room icon: plain-stroke SVG instead of emoji, uses currentColor to follow the room's theme color */
const RoomIcon: React.FC<{ room: MemoryRoom; size?: number; style?: React.CSSProperties }> = ({ room, size = 20, style }) => {
    const commonProps = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
        style: { display: 'inline-block', verticalAlign: 'middle', ...style },
    };
    switch (room) {
        case 'living_room': // sofa
            return (
                <svg {...commonProps}>
                    <path d="M3 14v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4" />
                    <path d="M4 14V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" />
                    <path d="M2 14h20" />
                    <path d="M7 14V10h10v4" />
                </svg>
            );
        case 'bedroom': // bed
            return (
                <svg {...commonProps}>
                    <path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" />
                    <path d="M3 18h18" />
                    <path d="M3 21v-3M21 21v-3" />
                    <path d="M8 10V7a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" />
                </svg>
            );
        case 'study': // book
            return (
                <svg {...commonProps}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                    <path d="M9 7h7M9 11h5" />
                </svg>
            );
        case 'user_room': // user
            return (
                <svg {...commonProps}>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
                </svg>
            );
        case 'self_room': // mirror/self
            return (
                <svg {...commonProps}>
                    <ellipse cx="12" cy="10" rx="6" ry="8" />
                    <path d="M12 18v4M8 22h8" />
                    <path d="M9 8a3 3 0 0 1 3-3" />
                </svg>
            );
        case 'attic': // brain
            return (
                <svg {...commonProps}>
                    <path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v0A3.5 3.5 0 0 0 4 12a3.5 3.5 0 0 0 2 5.5 3.5 3.5 0 0 0 3.5 3.5h0a2.5 2.5 0 0 0 2.5-2.5V5.5A2.5 2.5 0 0 0 9.5 3Z" />
                    <path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v0A3.5 3.5 0 0 1 20 12a3.5 3.5 0 0 1-2 5.5 3.5 3.5 0 0 1-3.5 3.5h0a2.5 2.5 0 0 1-2.5-2.5V5.5A2.5 2.5 0 0 1 14.5 3Z" />
                </svg>
            );
        case 'windowsill': // sunrise
            return (
                <svg {...commonProps}>
                    <path d="M12 3v2M4.6 7.6l1.4 1.4M18 9l1.4-1.4M2 14h2M20 14h2" />
                    <path d="M6 14a6 6 0 0 1 12 0" />
                    <path d="M2 19h20" />
                    <path d="M8 22h8" />
                </svg>
            );
        default:
            return null;
    }
};

/** Generic UI icons, avoids using emoji as icons */
const Icon: React.FC<{ name: string; size?: number; style?: React.CSSProperties }> = ({ name, size = 16, style }) => {
    const p = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
        style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
    };
    switch (name) {
        case 'palace': // Memory Palace master icon: brain + dome
            return (
                <svg {...p}>
                    <path d="M12 3a7 7 0 0 0-7 7v8h14v-8a7 7 0 0 0-7-7Z" />
                    <path d="M9 18v3M15 18v3M5 18h14" />
                    <path d="M12 9v6M9 12h6" />
                </svg>
            );
        case 'search':
            return (
                <svg {...p}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                </svg>
            );
        case 'settings':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
            );
        case 'list':
            return (
                <svg {...p}>
                    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
            );
        case 'box':
            return (
                <svg {...p}>
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                    <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
                </svg>
            );
        case 'link':
            return (
                <svg {...p}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
            );
        case 'sparkle':
            return (
                <svg {...p}>
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                    <path d="M5.6 5.6 8 8M16 16l2.4 2.4M5.6 18.4 8 16M16 8l2.4-2.4" />
                </svg>
            );
        case 'pin':
            return (
                <svg {...p}>
                    <path d="M12 2v6" />
                    <path d="M6 8h12l-2 6H8Z" />
                    <path d="M12 14v8" />
                </svg>
            );
        case 'trash':
            return (
                <svg {...p}>
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M10 11v6M14 11v6" />
                </svg>
            );
        case 'refresh':
            return (
                <svg {...p}>
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                    <path d="M21 4v5h-5" />
                </svg>
            );
        case 'beaker':
            return (
                <svg {...p}>
                    <path d="M9 3h6M10 3v7L5 20a1 1 0 0 0 .9 1.4h12.2A1 1 0 0 0 19 20l-5-10V3" />
                    <path d="M7 14h10" />
                </svg>
            );
        case 'cloud':
            return (
                <svg {...p}>
                    <path d="M18 10h-1.3A6 6 0 0 0 6.3 8.5 4.5 4.5 0 0 0 6 17.5h12a3.75 3.75 0 0 0 0-7.5Z" />
                </svg>
            );
        case 'target':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="5" />
                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
            );
        case 'robot':
            return (
                <svg {...p}>
                    <rect x="4" y="7" width="16" height="12" rx="2" />
                    <path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" />
                </svg>
            );
        case 'warning':
            return (
                <svg {...p}>
                    <path d="M10.3 3.86 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
                    <path d="M12 9v4M12 17h.01" />
                </svg>
            );
        case 'check':
            return (
                <svg {...p}>
                    <path d="M20 6 9 17l-5-5" />
                </svg>
            );
        case 'x':
            return (
                <svg {...p}>
                    <path d="M18 6 6 18M6 6l12 12" />
                </svg>
            );
        case 'pencil':
            return (
                <svg {...p}>
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
            );
        case 'book':
            return (
                <svg {...p}>
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
                </svg>
            );
        case 'sunrise':
            return (
                <svg {...p}>
                    <path d="M12 3v2M4.6 7.6l1.4 1.4M18 9l1.4-1.4M2 14h2M20 14h2" />
                    <path d="M6 14a6 6 0 0 1 12 0" />
                    <path d="M2 19h20" />
                </svg>
            );
        case 'lock':
            return (
                <svg {...p}>
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
            );
        case 'broken-heart':
            return (
                <svg {...p}>
                    <path d="M12 21s-8-4.5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6.5-8 11-8 11Z" />
                    <path d="m10 8 3 3-2 2 3 3" />
                </svg>
            );
        case 'moon':
            return (
                <svg {...p}>
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                </svg>
            );
        case 'bomb':
            return (
                <svg {...p}>
                    <circle cx="11" cy="15" r="7" />
                    <path d="M15 9l3-3 2 2-3 3M18 6v-2h2" />
                </svg>
            );
        case 'bolt':
            return (
                <svg {...p}>
                    <path d="M13 2 3 14h9l-1 8 10-12h-9Z" />
                </svg>
            );
        case 'arrow-left':
            return (
                <svg {...p}>
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
            );
        case 'document':
            return (
                <svg {...p}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                    <path d="M14 2v6h6M8 13h8M8 17h5" />
                </svg>
            );
        case 'download':
            return (
                <svg {...p}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m7 10 5 5 5-5M12 15V3" />
                </svg>
            );
        case 'money':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M14.5 9h-3.5a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 7v10" />
                </svg>
            );
        case 'mask':
            return (
                <svg {...p}>
                    <path d="M4 8c0-2 2-3 4-3s3 1 4 1 2-1 4-1 4 1 4 3c0 4-2 10-8 10S4 12 4 8Z" />
                    <path d="M9 11h.01M15 11h.01M10 15c.5.5 1.2.8 2 .8s1.5-.3 2-.8" />
                </svg>
            );
        case 'crystal':
            return (
                <svg {...p}>
                    <path d="M12 3 6 10l6 11 6-11-6-7Z" />
                    <path d="M6 10h12M12 3v18" />
                </svg>
            );
        case 'sync':
            return (
                <svg {...p}>
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                    <path d="M21 4v5h-5" />
                    <path d="M12 7v5l3 2" />
                </svg>
            );
        case 'square-check':
            return (
                <svg {...p}>
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="m8 12 3 3 5-6" />
                </svg>
            );
        case 'square':
            return (
                <svg {...p}>
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                </svg>
            );
        case 'celebrate':
            return (
                <svg {...p}>
                    <path d="m5 19 3-9 9 9H5Z" />
                    <path d="M12 3v3M18 6l-2 2M18 11h3" />
                </svg>
            );
        case 'hourglass':
            return (
                <svg {...p}>
                    <path d="M6 3h12M6 21h12" />
                    <path d="M6 3v5l6 4 6-4V3M6 21v-5l6-4 6 4v5" />
                </svg>
            );
        default:
            return null;
    }
};

/** Parses a result string with a status prefix ([ok]/[warn]/[err]) */
const parseStatusPrefix = (msg: string | null | undefined): { status: 'ok' | 'warn' | 'err' | 'plain'; text: string } => {
    if (!msg) return { status: 'plain', text: '' };
    if (msg.startsWith('[ok]')) return { status: 'ok', text: msg.slice(4) };
    if (msg.startsWith('[warn]')) return { status: 'warn', text: msg.slice(6) };
    if (msg.startsWith('[err]')) return { status: 'err', text: msg.slice(5) };
    return { status: 'plain', text: msg };
};

/** Renders a result message with a status icon */
const StatusMessage: React.FC<{ msg: string | null | undefined; style?: React.CSSProperties }> = ({ msg, style }) => {
    const { status, text } = parseStatusPrefix(msg);
    if (!text) return null;
    const iconName = status === 'ok' ? 'check' : status === 'warn' ? 'warning' : status === 'err' ? 'x' : null;
    const iconColor = status === 'ok' ? '#16a34a' : status === 'warn' ? '#d97706' : status === 'err' ? '#dc2626' : '#6b7280';
    return (
        <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, ...style }}>
            {iconName && <span style={{ color: iconColor, flexShrink: 0, marginTop: 2 }}><Icon name={iconName} size={12} /></span>}
            <span>{text}</span>
        </span>
    );
};

const ROOM_COLORS: Record<MemoryRoom, string> = {
    living_room: '#22c55e',
    bedroom: '#ec4899',
    study: '#3b82f6',
    user_room: '#f59e0b',
    self_room: '#8b5cf6',
    attic: '#6b7280',
    windowsill: '#f97316',
};

// ─── Shared styles ─────────────────────────────────────────

const inputClass = "w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 transition-all";
const labelClass = "text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1";

const WATERLINE_PRESET_COPY: Record<MemoryPalaceWaterlinePreset, { label: string; short: string; description: string }> = {
    online: {
        label: 'Mostly Chat',
        short: 'Default',
        description: 'Mostly slow, ongoing private chats — keeps longer stretches of raw text and organizes at a more relaxed pace.',
    },
    balanced: {
        label: 'Mixed',
        short: 'Balanced',
        description: 'A mix of chat, dates, and story mode — balances context length against how fast memories settle.',
    },
    offline: {
        label: 'Mostly Date/Story',
        short: 'Faster',
        description: 'Frequent use of Date mode or story companionship, settles memories faster; the secondary API gets called more often.',
    },
    custom: {
        label: 'Custom',
        short: 'Fine-tune',
        description: 'Decide for yourself how much raw text to keep and how much to accumulate before organizing starts.',
    },
};

const WATERLINE_PRESET_ORDER: MemoryPalaceWaterlinePreset[] = ['online', 'balanced', 'offline', 'custom'];

const MemoryWaterlineEditor: React.FC<{
    character: CharacterProfile;
    expanded: boolean;
    disabled?: boolean;
    onToggle: () => void;
    onPresetChange: (preset: MemoryPalaceWaterlinePreset) => void;
    onSaveCustom: (hotZoneSize: number, bufferThreshold: number) => void;
}> = ({ character, expanded, disabled, onToggle, onPresetChange, onSaveCustom }) => {
    const resolved = resolveMemoryPalaceWaterline(character.memoryPalaceWaterline);
    const [hotDraft, setHotDraft] = useState(String(resolved.hotZoneSize));
    const [bufferDraft, setBufferDraft] = useState(String(resolved.bufferThreshold));
    const [showHelp, setShowHelp] = useState(false);

    useEffect(() => {
        setHotDraft(String(resolved.hotZoneSize));
        setBufferDraft(String(resolved.bufferThreshold));
    }, [character.id, resolved.hotZoneSize, resolved.bufferThreshold]);

    const saveCustom = () => {
        const hot = Number(hotDraft);
        const buffer = Number(bufferDraft);
        onSaveCustom(hot, buffer);
    };

    return (
        <div
            style={{
                marginTop: -2,
                borderRadius: 15,
                border: '1px solid #f5d0e3',
                background: 'linear-gradient(135deg, rgba(253,242,248,0.9), rgba(250,245,255,0.9))',
                overflow: 'hidden',
                opacity: disabled ? 0.65 : 1,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', paddingRight: 10 }}>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={e => { e.stopPropagation(); onToggle(); }}
                    style={{
                        minWidth: 0, flex: 1, border: 0, background: 'transparent', padding: '10px 6px 10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        cursor: disabled ? 'wait' : 'pointer', textAlign: 'left',
                    }}
                >
                    <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 11, fontWeight: 800, color: '#9d174d' }}>Chat memory organizing pace</span>
                        <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: '#9ca3af' }}>
                            {WATERLINE_PRESET_COPY[resolved.preset].label} · AI reads the most recent {resolved.hotZoneSize} directly · organizes every {resolved.bufferThreshold} accumulated
                        </span>
                    </span>
                    <span style={{ color: '#be185d', fontSize: 14, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
                </button>
                <button
                    type="button"
                    aria-label="What is the waterline?"
                    title="What is the waterline?"
                    onClick={e => { e.stopPropagation(); setShowHelp(open => !open); }}
                    style={{
                        width: 22, height: 22, flexShrink: 0, borderRadius: '50%',
                        border: '1px solid #e9a8c7', background: showHelp ? '#db2777' : 'rgba(255,255,255,0.8)',
                        color: showHelp ? '#fff' : '#be185d', fontSize: 11, fontWeight: 900,
                        lineHeight: 1, display: 'grid', placeItems: 'center', cursor: 'pointer',
                    }}
                >
                    ?
                </button>
            </div>

            {showHelp && (
                <div
                    style={{
                        margin: '0 10px 10px', padding: '11px 12px', borderRadius: 12,
                        background: '#fff', border: '1px solid #f1d5e4', color: '#6b4b64',
                        fontSize: 10, lineHeight: 1.65, boxShadow: '0 5px 14px rgba(88,28,135,0.08)',
                    }}
                    onClick={e => e.stopPropagation()}
                >
                    <div style={{ fontSize: 11, fontWeight: 900, color: '#9d174d', marginBottom: 6 }}>Chats are laid out on one timeline</div>
                    <div style={{ padding: '7px 8px', borderRadius: 9, background: '#faf5ff', color: '#6d28d9', fontWeight: 800, textAlign: 'center' }}>
                        Older　Vectorized &amp; organized　| Waterline |　Awaiting organizing　·　Recent raw text　Newer
                    </div>
                    <div style={{ marginTop: 7 }}><b style={{ color: '#7c3aed' }}>Before the waterline (older side)</b>: chats have already been vectorized and organized into the Memory Palace. The original records stay in the database, nothing is deleted; the AI no longer re-reads the whole thing day to day, and recalls from the Memory Palace when needed.</div>
                    <div style={{ marginTop: 4 }}><b style={{ color: '#7c3aed' }}>After the waterline (newer side)</b>: chats are temporarily kept as raw text, including content awaiting organizing and the recent raw text the AI reads directly each time.</div>
                    <div style={{ marginTop: 4 }}>Once the waiting area accumulates the configured count, roughly the earliest 85% gets vectorized and moved before the waterline, leaving about 15% to bridge into the next round of organizing.</div>
                    <div style={{ marginTop: 6, padding: '7px 8px', borderRadius: 9, background: '#faf5ff', color: '#6d28d9' }}>
                        For example, 50 / 20: the AI directly reads the most recent 50 each time; once another 20 messages accumulate beyond those 50, about 17 get vectorized and moved before the waterline, and about 3 are left to bridge. One exchange (question + answer) is usually about 2 messages.
                    </div>
                    <div style={{ marginTop: 7, padding: '7px 8px', borderRadius: 9, background: '#fff1f7', color: '#9d174d' }}>
                        <b>Does content from Dates and story mode also get organized? Yes.</b><br />
                        Private chat, Date, calls, story mode, proactive messages, Dwelling, and Beyond all get queued up here as long as they contain readable content that enters this character's context timeline, then cross the same waterline into the Memory Palace. It's not just private chat that gets organized, and each entry point isn't counted as its own separate line.
                    </div>
                </div>
            )}

            {expanded && (
                <div style={{ padding: '0 10px 11px' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                        {WATERLINE_PRESET_ORDER.map(preset => {
                            const active = resolved.preset === preset;
                            const presetNumbers = preset === 'custom'
                                ? null
                                : MEMORY_PALACE_WATERLINE_PRESETS[preset];
                            return (
                                <button
                                    key={preset}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onPresetChange(preset)}
                                    style={{
                                        border: active ? '1px solid #db2777' : '1px solid #f1d5e4',
                                        borderRadius: 11,
                                        padding: '8px 7px',
                                        background: active ? '#fff1f7' : 'rgba(255,255,255,0.78)',
                                        color: active ? '#9d174d' : '#6b7280',
                                        textAlign: 'left', cursor: disabled ? 'wait' : 'pointer',
                                        boxShadow: active ? '0 2px 8px rgba(219,39,119,0.1)' : 'none',
                                    }}
                                >
                                    <span style={{ display: 'block', fontSize: 10, fontWeight: 800 }}>{WATERLINE_PRESET_COPY[preset].label}</span>
                                    <span style={{ display: 'block', marginTop: 2, fontSize: 9, opacity: 0.72 }}>
                                        {presetNumbers
                                            ? `Recent ${presetNumbers.hotZoneSize} · Buffer ${presetNumbers.bufferThreshold}`
                                            : WATERLINE_PRESET_COPY[preset].short}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <div style={{ marginTop: 8, padding: '8px 9px', borderRadius: 10, background: 'rgba(255,255,255,0.68)', fontSize: 9.5, lineHeight: 1.5, color: '#7c3aed' }}>
                        {WATERLINE_PRESET_COPY[resolved.preset].description}
                    </div>

                    {resolved.preset === 'custom' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'end', marginTop: 8 }}>
                            <label style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 9, color: '#9ca3af', marginBottom: 3 }}>AI reads the most recent raw text directly (20-500)</span>
                                <input
                                    type="number"
                                    min={MIN_MEMORY_HOT_ZONE_SIZE}
                                    max={MAX_MEMORY_HOT_ZONE_SIZE}
                                    step={10}
                                    value={hotDraft}
                                    onChange={e => setHotDraft(e.target.value)}
                                    style={{ width: '100%', minWidth: 0, border: '1px solid #e9d5ff', borderRadius: 9, padding: '7px 6px', fontSize: 11, color: '#581c87', background: '#fff' }}
                                />
                            </label>
                            <label style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 9, color: '#9ca3af', marginBottom: 3 }}>How many to accumulate before organizing starts (10-200)</span>
                                <input
                                    type="number"
                                    min={MIN_MEMORY_BUFFER_THRESHOLD}
                                    max={MAX_MEMORY_BUFFER_THRESHOLD}
                                    step={10}
                                    value={bufferDraft}
                                    onChange={e => setBufferDraft(e.target.value)}
                                    style={{ width: '100%', minWidth: 0, border: '1px solid #e9d5ff', borderRadius: 9, padding: '7px 6px', fontSize: 11, color: '#581c87', background: '#fff' }}
                                />
                            </label>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={saveCustom}
                                style={{ border: 0, borderRadius: 9, padding: '8px 9px', background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 800, cursor: disabled ? 'wait' : 'pointer' }}
                            >
                                Save
                            </button>
                        </div>
                    )}

                    <div style={{ marginTop: 8, fontSize: 9, lineHeight: 1.45, color: '#9ca3af' }}>
                        Setting it faster organizes the next time the threshold is reached; the raw text isn't hidden until it succeeds. Setting it slower doesn't roll back the waterline or duplicate memories — the raw-text window just gradually grows with new conversation.
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── Main component ───────────────────────────────────────────

export default function MemoryPalaceApp() {
    const { activeCharacterId, characters, updateCharacter, setActiveCharacterId, closeApp, apiPresets, userProfile, memoryPalaceConfig, updateMemoryPalaceConfig, remoteVectorConfig, updateRemoteVectorConfig, addToast, apiConfig, characterGroups } = useOS();
    const char = characters.find(c => c.id === activeCharacterId);
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // Group filter for the character-picker page

    const [view, setView] = useState<'picker' | 'palace' | 'room' | 'memory' | 'settings' | 'globalSettings' | 'all' | 'boxes'>('picker');
    const [selectedRoom, setSelectedRoom] = useState<MemoryRoom | null>(null);
    const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
    const [roomCounts, setRoomCounts] = useState<Record<MemoryRoom, number>>({} as any);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectMode, setSelectMode] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [roomNodes, setRoomNodes] = useState<MemoryNode[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [linkCount, setLinkCount] = useState(0);
    const [boxCount, setBoxCount] = useState(0);
    const [anticipations, setAnticipations] = useState<Anticipation[]>([]);
    const [pinnedNodes, setPinnedNodes] = useState<MemoryNode[]>([]);
    const [editingAnticipation, setEditingAnticipation] = useState<Anticipation | null>(null);
    const [anticipationDraft, setAnticipationDraft] = useState('');
    const [savingAnticipation, setSavingAnticipation] = useState(false);
    const anticipationPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const anticipationPressStartRef = React.useRef<{ x: number; y: number } | null>(null);

    // Event box view
    const [allBoxes, setAllBoxes] = useState<EventBox[]>([]);
    const [expandedBoxId, setExpandedBoxId] = useState<string | null>(null);
    const [boxMembers, setBoxMembers] = useState<Record<string, { summary: MemoryNode | null; live: MemoryNode[]; archived: MemoryNode[] }>>({});
    // Event box name/tag manual-edit state (box.name / box.tags are display-only headers, not used in recall scoring)
    const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
    const [boxNameDraft, setBoxNameDraft] = useState('');
    const [boxTagsDraft, setBoxTagsDraft] = useState('');
    const [savingBox, setSavingBox] = useState(false);

    // Migration state
    const [migrating, setMigrating] = useState(false);
    const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
    const [migrationResult, setMigrationResult] = useState<string | null>(null);

    // Month selection (importing old memories)
    const [availableMonths, setAvailableMonths] = useState<string[]>([]);
    const [availableChunks, setAvailableChunks] = useState<{ key: string; count: number }[]>([]);
    const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());

    // Manual summarization & vectorization (fallback mechanism): select a chat range -> run one summarization pass, doesn't touch the waterline
    const [rangeModalOpen, setRangeModalOpen] = useState(false);
    const [rangeMessages, setRangeMessages] = useState<Message[]>([]);
    const [rangeLoading, setRangeLoading] = useState(false);
    const [rangeQuery, setRangeQuery] = useState('');
    const [rangePage, setRangePage] = useState(0); // Current page (0-indexed)
    const [rangeStartId, setRangeStartId] = useState<number | null>(null);
    const [rangeEndId, setRangeEndId] = useState<number | null>(null);
    // Tapping a message first enters "pending confirmation", showing [Set as start / Set as end] to avoid mis-taps
    const [rangePendingId, setRangePendingId] = useState<number | null>(null);
    const [rangeRunning, setRangeRunning] = useState(false);
    const [rangeProgress, setRangeProgress] = useState('');
    const [rangeResult, setRangeResult] = useState<string | null>(null);
    // Input takes priority for responsiveness; message content and formatted dates are only precomputed once when the record set changes.
    const deferredRangeQuery = useDeferredValue(rangeQuery);
    const rangeSearchEntries = useMemo(
        () => buildRangeSearchEntries(rangeMessages, fmtRangeTs),
        [rangeMessages],
    );
    const filteredRangeMessages = useMemo(
        () => filterRangeSearchEntries(rangeSearchEntries, deferredRangeQuery),
        [rangeSearchEntries, deferredRangeQuery],
    );
    // Result modal after completion (lists newly added memories one by one, consistent with waterline summarization)
    const [rangeResultData, setRangeResultData] = useState<import('../utils/memoryPalace/pipeline').RangeProcessResult | null>(null);

    // All-memories view
    const [allNodes, setAllNodes] = useState<MemoryNode[]>([]);
    const [allSortBy, setAllSortBy] = useState<'time' | 'importance'>('time');
    const [allSortDir, setAllSortDir] = useState<'desc' | 'asc'>('desc');
    const [prevView, setPrevView] = useState<'room' | 'all' | 'boxes'>('room');

    // Cognitive digestion state
    const [digesting, setDigesting] = useState(false);
    const [digestResult, setDigestResult] = useState<string | null>(null);
    // Digestion log: null = not opened; [] = opened but no records
    const [digestReports, setDigestReports] = useState<DigestReport[] | null>(null);
    const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
    useEffect(() => { setDigestReports(null); setExpandedReportId(null); }, [char?.id]);
    // Room-plate history backfill (lets existing users put up plates for their backlog)
    const [bootstrapping, setBootstrapping] = useState(false);
    const [bootstrapStatus, setBootstrapStatus] = useState<string | null>(null);

    const handleBootstrapPlates = async () => {
        if (!char || bootstrapping) return;
        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setBootstrapStatus('[err]Please configure the secondary API in Settings first');
            return;
        }
        setBootstrapping(true);
        setBootstrapStatus(null);
        trackEvent('Organize Historical Memories to Plates');
        try {
            // Each press only clears a small chunk (resumable): users with thousands of memories won't be
            // scared off by one huge batch, and can stop anytime -- progress is saved locally, resume next press
            const MANUAL_BATCHES_PER_PRESS = 5;
            const result = await bootstrapPlatesFromHistory(char.id, char.name, userProfile?.name, lightApi, {
                startBatch: getBootstrapResume(char.id),
                maxBatches: MANUAL_BATCHES_PER_PRESS,
                onProgress: (done, total) => setBootstrapStatus(`Organizing historical memory batch ${done}/${total}... (please stay on this page)`),
            });
            if (result.totalLines === 0) {
                setBootstrapStatus('There is no history in the Memory Palace yet that can be put on a plate');
            } else if (result.complete) {
                markPlateBootstrapDone(char.id);
                clearBootstrapResume(char.id);
                setBootstrapStatus(`[ok]All history organized (${result.neededBatches} batches total), updated ${result.updated.length} plates -- check the "Plates" page in Neural Link`);
            } else {
                setBootstrapResume(char.id, result.nextBatch);
                setBootstrapStatus(`[ok]Organized ${result.batches} batches this time (total progress ${result.nextBatch}/${result.neededBatches}), updated ${result.updated.length} plates. Press again to continue`);
            }
        } catch (err: any) {
            setBootstrapStatus(`[err]Organizing failed: ${err?.message || err} (you can press again to retry, already-organized parts won't be double-counted)`);
        } finally {
            setBootstrapping(false);
        }
    };


    // One-click wipe
    const [wiping, setWiping] = useState(false);
    const [wipeResult, setWipeResult] = useState<string | null>(null);

    // Export memory (for connecting to an external memory store)
    const [exporting, setExporting] = useState(false);
    const [exportResult, setExportResult] = useState<string | null>(null);
    // Vectors included by default: most users stick with the same embedding model long-term, so vectors can be reused directly without re-vectorizing
    const [exportWithVectors, setExportWithVectors] = useState(true);

    // Import memory
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<string | null>(null);
    const importInputRef = React.useRef<HTMLInputElement>(null);
    // Raw text moved over from other apps: the same cleanup pass writes to both the vector palace and the Neural Link character profile.
    const [externalMemoryText, setExternalMemoryText] = useState('');
    const [externalImporting, setExternalImporting] = useState(false);
    const [externalImportProgress, setExternalImportProgress] = useState('');
    const [externalImportResult, setExternalImportResult] = useState<string | null>(null);
    const externalLengthInfo = useMemo(
        () => getExternalMemoryLengthInfo(externalMemoryText),
        [externalMemoryText],
    );

    // Linked-memory state (the memory detail page shows EventBox siblings + legacy causal links for backward compat)
    const [linkedMemories, setLinkedMemories] = useState<LinkedMemoryUI[]>([]);
    const [currentBox, setCurrentBox] = useState<EventBox | null>(null);
    const [loadingLinks, setLoadingLinks] = useState(false);
    const [showLinkSearch, setShowLinkSearch] = useState(false);
    const [linkSearchQuery, setLinkSearchQuery] = useState('');
    const [linkSearchResults, setLinkSearchResults] = useState<MemoryNode[]>([]);

    // Global search state
    const [globalSearchQuery, setGlobalSearchQuery] = useState('');
    const [globalSearchResults, setGlobalSearchResults] = useState<MemoryNode[]>([]);
    const globalSearchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Full-auto memory (auto-archive) catch-up state: tracked separately per character id
    const [autoArchiveSyncingId, setAutoArchiveSyncingId] = useState<string | null>(null);
    const [autoArchiveSyncProgress, setAutoArchiveSyncProgress] = useState('');
    const [waterlineEditorCharId, setWaterlineEditorCharId] = useState<string | null>(null);

    // Full-auto memory catch-up confirm dialog (replaces the native confirm)
    const [autoArchiveConfirm, setAutoArchiveConfirm] = useState<{
        charId: string;
        charName: string;
        unprocessedCount: number;
        minutes: number;
        mpEmb: any;
        mpLLM: any;
    } | null>(null);

    // Memory edit state
    const [editing, setEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [editImportance, setEditImportance] = useState(5);
    const [editMood, setEditMood] = useState('');
    const [editRoom, setEditRoom] = useState<MemoryRoom>('living_room');
    const [editTags, setEditTags] = useState('');
    const [saving, setSaving] = useState(false);

    // Embedding config local state (initialized from global config)
    const [embUrl, setEmbUrl] = useState(memoryPalaceConfig.embedding.baseUrl || 'https://api.siliconflow.cn/v1');
    const [embKey, setEmbKey] = useState(memoryPalaceConfig.embedding.apiKey || '');
    const [embModel, setEmbModel] = useState(memoryPalaceConfig.embedding.model || 'BAAI/bge-m3');
    const [embDimensions, setEmbDimensions] = useState(memoryPalaceConfig.embedding.dimensions || 1024);
    const [configSaved, setConfigSaved] = useState(false);
    const [testingEmb, setTestingEmb] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    // Secondary API config (global config)
    const [lightUrl, setLightUrl] = useState(memoryPalaceConfig.lightLLM.baseUrl || '');
    const [lightKey, setLightKey] = useState(memoryPalaceConfig.lightLLM.apiKey || '');
    const [lightModel, setLightModel] = useState(memoryPalaceConfig.lightLLM.model || '');
    const [lightSaved, setLightSaved] = useState(false);
    const [testingLight, setTestingLight] = useState(false);
    const [lightTestResult, setLightTestResult] = useState<string | null>(null);

    // Rerank config (global; cross-encoder re-ranking, an optional enhancement channel independent of primary recall)
    const [rrEnabled, setRrEnabled] = useState(!!memoryPalaceConfig.rerank?.enabled);
    const [rrUrl, setRrUrl] = useState(memoryPalaceConfig.rerank?.baseUrl || '');
    const [rrKey, setRrKey] = useState(memoryPalaceConfig.rerank?.apiKey || '');
    const [rrModel, setRrModel] = useState(memoryPalaceConfig.rerank?.model || 'BAAI/bge-reranker-v2-m3');
    const [rrTopN, setRrTopN] = useState(memoryPalaceConfig.rerank?.topN || 5);
    const [rrSaved, setRrSaved] = useState(false);
    const [rrTesting, setRrTesting] = useState(false);
    const [rrTestResult, setRrTestResult] = useState<string | null>(null);

    // Remote vector storage config
    const [rvUrl, setRvUrl] = useState(remoteVectorConfig.supabaseUrl);
    const [rvKey, setRvKey] = useState(remoteVectorConfig.supabaseAnonKey);
    const [rvTestResult, setRvTestResult] = useState('');
    const [rvTesting, setRvTesting] = useState(false);
    const [rvSyncing, setRvSyncing] = useState(false);
    const [showInitSQL, setShowInitSQL] = useState(false);

    // Sync to local state when global config changes
    useEffect(() => {
        setEmbUrl(memoryPalaceConfig.embedding.baseUrl || 'https://api.siliconflow.cn/v1');
        setEmbKey(memoryPalaceConfig.embedding.apiKey || '');
        setEmbModel(memoryPalaceConfig.embedding.model || 'BAAI/bge-m3');
        setEmbDimensions(memoryPalaceConfig.embedding.dimensions || 1024);
        setLightUrl(memoryPalaceConfig.lightLLM.baseUrl || '');
        setLightKey(memoryPalaceConfig.lightLLM.apiKey || '');
        setLightModel(memoryPalaceConfig.lightLLM.model || '');
        setRrEnabled(!!memoryPalaceConfig.rerank?.enabled);
        setRrUrl(memoryPalaceConfig.rerank?.baseUrl || '');
        setRrKey(memoryPalaceConfig.rerank?.apiKey || '');
        setRrModel(memoryPalaceConfig.rerank?.model || 'BAAI/bge-reranker-v2-m3');
        setRrTopN(memoryPalaceConfig.rerank?.topN || 5);
    }, [memoryPalaceConfig]);

    // Sync to local state when remote vector config changes
    useEffect(() => {
        setRvUrl(remoteVectorConfig.supabaseUrl);
        setRvKey(remoteVectorConfig.supabaseAnonKey);
    }, [remoteVectorConfig.supabaseUrl, remoteVectorConfig.supabaseAnonKey]);

    // Personality style + rumination-tendency detection
    const [detectingPersonality, setDetectingPersonality] = useState(false);
    const [pendingPersonality, setPendingPersonality] = useState<{ style: string; ruminationTendency: number; reasoning: string } | null>(null);
    // pendingPersonality is bound to the character id that produced it, preventing the old result from being applied to a new character after switching
    const [pendingPersonalityCharId, setPendingPersonalityCharId] = useState<string | null>(null);
    // Extract raw fields as useEffect deps to avoid re-running whenever memoryPalaceConfig gets a new object reference
    const lightLLMBaseUrl = memoryPalaceConfig.lightLLM?.baseUrl || '';
    const lightLLMApiKey = memoryPalaceConfig.lightLLM?.apiKey || '';

    // Clear the previous character's leftover pending-confirmation result when switching characters
    useEffect(() => {
        if (pendingPersonalityCharId && pendingPersonalityCharId !== char?.id) {
            setPendingPersonality(null);
            setPendingPersonalityCharId(null);
        }
    }, [char?.id, pendingPersonalityCharId]);

    useEffect(() => {
        if (!char || (char as any).personalityStyle) return;
        // Only detect in the palace view; picker is just the character-select page, where char is still the
        // activeCharacterId left over from the previous context (e.g. opening Memory Palace right after leaving
        // Sully's chat) -- running it in picker would detect against the old character
        if (view !== 'palace') return;
        // Already attempted or already confirmed, don't detect again (avoids the LLM occasionally resetting personality)
        const skipKey = `mp_personality_tried_${char.id}`;
        if (localStorage.getItem(skipKey)) return;
        if (!lightLLMBaseUrl || !lightLLMApiKey) return;

        // When switching characters, discard the old character's not-yet-returned detection result to avoid applying A's personality to B
        let cancelled = false;
        const detectingCharId = char.id;

        setDetectingPersonality(true);
        const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
        detectPersonalityStyle(detectingCharId, char.name, persona, memoryPalaceConfig.lightLLM)
            .then(result => {
                if (cancelled) return;
                setPendingPersonality(result);
                setPendingPersonalityCharId(detectingCharId);
            })
            .catch(e => {
                if (cancelled) return;
                console.warn('🎭 Personality detection failed:', e.message);
                // Mark as attempted to avoid showing the dialog again; the user can adjust manually in Settings
                localStorage.setItem(skipKey, '1');
            })
            .finally(() => {
                if (!cancelled) setDetectingPersonality(false);
            });

        return () => { cancelled = true; };
        // Depend on raw string fields to avoid re-running every time memoryPalaceConfig gets a new object reference
    }, [char?.id, (char as any)?.personalityStyle, view, lightLLMBaseUrl, lightLLMApiKey]);

    // Manually triggered AI evaluation (the button in the cognitive-parameters settings area). Shares the
    // detecting/pending state with automatic detection, so the result also goes through the same
    // "analyzing -> confirm" two-screen flow. Falls back to the primary apiConfig when the secondary
    // API isn't configured -- matching the mpLLM fallback strategy in useChatAI.
    const manualDetectPersonality = () => {
        if (!char || detectingPersonality) return;
        const llm = (lightLLMBaseUrl && lightLLMApiKey)
            ? memoryPalaceConfig.lightLLM
            : (apiConfig?.baseUrl && apiConfig?.apiKey
                ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }
                : null);
        if (!llm) {
            addToast('Please configure the secondary API (Memory Palace global settings) or the primary API first', 'error');
            return;
        }
        const detectingCharId = char.id;
        const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
        setDetectingPersonality(true);
        trackEvent('Evaluate Character Cognitive Parameters');
        detectPersonalityStyle(detectingCharId, char.name, persona, llm)
            .then(result => {
                setPendingPersonality(result);
                setPendingPersonalityCharId(detectingCharId);
            })
            .catch(e => {
                console.warn('🎭 Manual personality evaluation failed:', e?.message || e);
                addToast(`Evaluation failed: ${e?.message || e}`, 'error');
            })
            .finally(() => setDetectingPersonality(false));
    };

    // Check whether it's already configured (using global config)
    const hasEmbeddingConfig = !!(memoryPalaceConfig.embedding.baseUrl && memoryPalaceConfig.embedding.apiKey);
    const hasLightApi = !!(memoryPalaceConfig.lightLLM.baseUrl && memoryPalaceConfig.lightLLM.apiKey);

    // Load data
    const loadStats = useCallback(async () => {
        if (!char) return;

        const allNodes = await MemoryNodeDB.getByCharId(char.id);
        setTotalCount(allNodes.length);

        const counts: Record<string, number> = {};
        const rooms: MemoryRoom[] = ['living_room', 'bedroom', 'study', 'user_room', 'self_room', 'attic', 'windowsill'];
        for (const room of rooms) {
            counts[room] = allNodes.filter(n => n.room === room).length;
        }
        setRoomCounts(counts as any);

        const boxes = await EventBoxDB.getByCharId(char.id);
        setBoxCount(boxes.length);

        const ants = await AnticipationDB.getByCharId(char.id);
        setAnticipations(ants);

        // Load sticky-note pinned memories
        const now = Date.now();
        setPinnedNodes(allNodes.filter(n => n.pinnedUntil && n.pinnedUntil > now));

        let links = 0;
        for (const node of allNodes.slice(0, 5)) {
            const nodeLinks = await MemoryLinkDB.getByNodeId(node.id);
            links += nodeLinks.length;
        }
        setLinkCount(links);
    }, [char]);

    useEffect(() => { loadStats(); }, [loadStats]);

    const cancelAnticipationLongPress = useCallback(() => {
        if (anticipationPressTimerRef.current) {
            clearTimeout(anticipationPressTimerRef.current);
            anticipationPressTimerRef.current = null;
        }
        anticipationPressStartRef.current = null;
    }, []);

    const openAnticipationEditor = useCallback((ant: Anticipation) => {
        cancelAnticipationLongPress();
        setEditingAnticipation(ant);
        setAnticipationDraft(ant.content);
    }, [cancelAnticipationLongPress]);

    const startAnticipationLongPress = useCallback((e: React.PointerEvent<HTMLDivElement>, ant: Anticipation) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        cancelAnticipationLongPress();
        anticipationPressStartRef.current = { x: e.clientX, y: e.clientY };
        anticipationPressTimerRef.current = setTimeout(() => {
            anticipationPressTimerRef.current = null;
            anticipationPressStartRef.current = null;
            setEditingAnticipation(ant);
            setAnticipationDraft(ant.content);
        }, 550);
    }, [cancelAnticipationLongPress]);

    const moveAnticipationLongPress = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const start = anticipationPressStartRef.current;
        if (!start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
            cancelAnticipationLongPress();
        }
    }, [cancelAnticipationLongPress]);

    useEffect(() => () => cancelAnticipationLongPress(), [cancelAnticipationLongPress]);
    useEffect(() => {
        setEditingAnticipation(null);
        setAnticipationDraft('');
    }, [char?.id]);

    const handleSaveAnticipation = async () => {
        if (!editingAnticipation) return;
        const content = anticipationDraft.trim();
        if (!content) {
            addToast('Anticipation content cannot be empty', 'error');
            return;
        }
        setSavingAnticipation(true);
        try {
            const updated = { ...editingAnticipation, content };
            await AnticipationDB.save(updated);
            setAnticipations(prev => prev.map(ant => ant.id === updated.id ? updated : ant));
            setEditingAnticipation(null);
            setAnticipationDraft('');
            addToast('Windowsill anticipation updated', 'success');
        } finally {
            setSavingAnticipation(false);
        }
    };

    const handleDeleteAnticipation = async () => {
        if (!editingAnticipation) return;
        if (!window.confirm('Delete this windowsill anticipation? It cannot be automatically restored after deletion.')) return;
        setSavingAnticipation(true);
        try {
            await AnticipationDB.delete(editingAnticipation.id);
            setAnticipations(prev => prev.filter(ant => ant.id !== editingAnticipation.id));
            setEditingAnticipation(null);
            setAnticipationDraft('');
            addToast('Windowsill anticipation deleted', 'success');
        } finally {
            setSavingAnticipation(false);
        }
    };

    // Load available months and chunks (for legacy memory migration)
    useEffect(() => {
        if (char?.memories && char.memories.length > 0) {
            const months = getAvailableMonths(char.memories as any);
            setAvailableMonths(months);
            const chunks = getAvailableChunks(char.memories as any);
            setAvailableChunks(chunks);
        } else {
            setAvailableMonths([]);
            setAvailableChunks([]);
        }
    }, [char?.id, char?.memories?.length]);

    const openAllMemories = async () => {
        if (!char) return;
        const nodes = await MemoryNodeDB.getByCharId(char.id);
        setAllNodes(nodes);
        setView('all');
    };

    const openAllBoxes = async () => {
        if (!char) return;
        trackEvent('Open Event Box List');
        const boxes = await EventBoxDB.getByCharId(char.id);
        boxes.sort((a, b) => b.updatedAt - a.updatedAt);
        setAllBoxes(boxes);
        setExpandedBoxId(null);
        setBoxMembers({});
        setView('boxes');
    };

    /** Revives an archived memory back into a live node.
     *  Archived nodes are folded into the summary by default and excluded from recall -- manually tapping "revive"
     *  returns it to the live pool to participate in recall independently.
     *  Data layer goes through reviveArchivedMemory: archived=false + box.archivedMemoryIds -> liveMemoryIds
     *  + MemoryNodeDB.save triggers a remote upsertVector to sync archived=false to the cloud. */
    const handleReviveArchived = async (box: EventBox, node: MemoryNode) => {
        if (!char) return;
        try {
            await reviveArchivedMemory(node.id);
            // Re-fetch this box's members (archived -> live position change + box metadata updatedAt)
            const fresh = (await EventBoxDB.getById(box.id)) || box;
            const summary = fresh.summaryNodeId ? await MemoryNodeDB.getById(fresh.summaryNodeId) : null;
            const live: MemoryNode[] = [];
            for (const id of fresh.liveMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) live.push(n);
            }
            const archived: MemoryNode[] = [];
            for (const id of fresh.archivedMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) archived.push(n);
            }
            setBoxMembers(prev => ({ ...prev, [box.id]: { summary: summary || null, live, archived } }));
            // The box list's updatedAt also changed, refresh it
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            loadStats();
        } catch (e: any) {
            alert(`Revive failed: ${e?.message || e}`);
        }
    };

    /** Enters/exits the name+tag edit state for a box. box.name/box.tags only determine the display header shown
     *  during recall -- they don't participate in vector/BM25 retrieval scoring (retrieval only reads member
     *  nodes' content/tags), so editing it doesn't affect recall results. */
    const startEditBoxMeta = (box: EventBox) => {
        setEditingBoxId(box.id);
        setBoxNameDraft(box.name || '');
        setBoxTagsDraft(box.tags.join(', '));
    };
    const cancelEditBoxMeta = () => {
        setEditingBoxId(null);
        setBoxNameDraft('');
        setBoxTagsDraft('');
    };
    const handleSaveBoxMeta = async (box: EventBox) => {
        if (!char) return;
        setSavingBox(true);
        try {
            const fresh = (await EventBoxDB.getById(box.id)) || box;
            // Leave name blank -> falls back to a default value, avoids saving an empty title
            fresh.name = boxNameDraft.trim() || 'Untitled Event';
            fresh.tags = boxTagsDraft.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 20);
            fresh.updatedAt = Date.now();
            await EventBoxDB.save(fresh);
            // Refresh the box list (keep the original order: descending by updatedAt)
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            cancelEditBoxMeta();
        } catch (e: any) {
            alert(`Save failed: ${e?.message || e}`);
        } finally {
            setSavingBox(false);
        }
    };

    /** One-click removes all live nodes from a box (emergency exit: for when repeated compression failures
     *  pile dozens of nodes into the live pool). Memories aren't deleted, they return to "solid ground" as
     *  independent memories. summary / archived are left untouched. */
    const handleUnbindAllLive = async (box: EventBox) => {
        if (!char) return;
        const liveCount = box.liveMemoryIds.length;
        if (liveCount === 0) return;
        if (!confirm(
            `Remove all ${liveCount} live nodes from "${box.name || 'Untitled'}"?\n\n`
            + `These memories won't be deleted -- they'll just leave the current event box and return to "solid ground" as independent memories.\n`
            + `The consolidated memory (summary) and archived nodes will stay untouched.`
        )) return;
        try {
            await unbindAllLiveMemories(box.id);
            // Refresh allBoxes + expand state (the box may have been deleted entirely)
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            const stillExists = boxes.some(b => b.id === box.id);
            if (!stillExists) {
                setExpandedBoxId(null);
                setBoxMembers(prev => {
                    const next = { ...prev };
                    delete next[box.id];
                    return next;
                });
            } else {
                setBoxMembers(prev => ({
                    ...prev,
                    [box.id]: { ...(prev[box.id] || { summary: null, live: [], archived: [] }), live: [] },
                }));
            }
            loadStats();
        } catch (e: any) {
            alert(`Removal failed: ${e?.message || e}`);
        }
    };

    const toggleBoxExpand = async (box: EventBox) => {
        if (expandedBoxId === box.id) {
            setExpandedBoxId(null);
            return;
        }
        if (!boxMembers[box.id]) {
            const summary = box.summaryNodeId ? await MemoryNodeDB.getById(box.summaryNodeId) : null;
            const live: MemoryNode[] = [];
            for (const id of box.liveMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) live.push(n);
            }
            const archived: MemoryNode[] = [];
            for (const id of box.archivedMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) archived.push(n);
            }
            setBoxMembers(prev => ({ ...prev, [box.id]: { summary: summary || null, live, archived } }));
        }
        setExpandedBoxId(box.id);
    };

    const openRoom = async (room: MemoryRoom) => {
        if (!char) return;
        trackEvent('Open Memory Palace Room', { room });
        const nodes = await MemoryNodeDB.getByRoom(char.id, room);
        nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
        setRoomNodes(nodes);
        setSelectedRoom(room);
        setView('room');
    };

    const loadLinkedMemories = async (nodeId: string) => {
        setLoadingLinks(true);
        try {
            const node = await MemoryNodeDB.getById(nodeId);
            const results: LinkedMemoryUI[] = [];
            let box: EventBox | null = null;

            // 1) If it belongs to an EventBox -> list the summary + all siblings (live / archived)
            if (node?.eventBoxId) {
                box = (await EventBoxDB.getById(node.eventBoxId)) || null;
                if (box) {
                    // summary node
                    if (box.summaryNodeId && box.summaryNodeId !== nodeId) {
                        const s = await MemoryNodeDB.getById(box.summaryNodeId);
                        if (s) results.push({
                            id: `eb-summary-${box.id}`, relation: 'box_summary', box, node: s,
                        });
                    }
                    // live siblings
                    for (const id of box.liveMemoryIds) {
                        if (id === nodeId) continue;
                        const n = await MemoryNodeDB.getById(id);
                        if (n) results.push({
                            id: `eb-live-${box.id}-${id}`, relation: 'box_live', box, node: n,
                        });
                    }
                    // archived siblings (shown but visually de-emphasized)
                    for (const id of box.archivedMemoryIds) {
                        if (id === nodeId) continue;
                        const n = await MemoryNodeDB.getById(id);
                        if (n) results.push({
                            id: `eb-arch-${box.id}-${id}`, relation: 'box_archived', box, node: n,
                        });
                    }
                }
            }

            // 2) Backward-compat display of legacy causal MemoryLinks (leftover from older versions, new code no longer creates these)
            const legacyLinks = await MemoryLinkDB.getByNodeId(nodeId);
            for (const link of legacyLinks.filter(l => l.type === 'causal')) {
                const otherId = link.sourceId === nodeId ? link.targetId : link.sourceId;
                if (results.some(r => r.node.id === otherId)) continue; // already shown in the box, don't duplicate
                const otherNode = await MemoryNodeDB.getById(otherId);
                if (otherNode) results.push({
                    id: link.id, relation: 'legacy_causal', node: otherNode,
                });
            }

            setCurrentBox(box);
            setLinkedMemories(results);
        } catch {
            setCurrentBox(null);
            setLinkedMemories([]);
        } finally {
            setLoadingLinks(false);
        }
    };

    const openMemory = (node: MemoryNode, from?: 'room' | 'all' | 'boxes') => {
        setSelectedNode(node);
        setEditing(false);
        setEditContent(node.content);
        setEditImportance(node.importance);
        setEditMood(node.mood);
        setEditRoom(node.room);
        setEditTags(node.tags.join(', '));
        setLinkedMemories([]);
        setCurrentBox(null);
        setPrevView(from || 'room');
        setView('memory');
        loadLinkedMemories(node.id);
    };

    const handleSaveEdit = async () => {
        if (!selectedNode || !char) return;
        setSaving(true);
        try {
            const result = await updateStoredMemoryNode(
                selectedNode.id,
                {
                content: editContent.trim(),
                importance: editImportance,
                mood: editMood.trim(),
                room: editRoom,
                tags: editTags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
                },
                memoryPalaceConfig.embedding,
                remoteVectorConfig,
            );
            const updated = result.node;
            setSelectedNode(updated);
            setEditing(false);
            addToast(
                result.reembedded ? 'Memory saved, semantic vector synced' : 'Memory settings saved',
                'success',
            );
            // If the room changed, refresh the room list
            if (selectedRoom) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            }
            loadStats();
        } catch (error: any) {
            addToast(error?.message || 'Failed to save memory', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveEmbeddingConfig = () => {
        updateMemoryPalaceConfig({
            embedding: {
                baseUrl: embUrl.trim(),
                apiKey: embKey.trim(),
                model: embModel.trim() || 'BAAI/bge-m3',
                dimensions: embDimensions || 1024,
            },
        });
        // Sync to the current character's embeddingConfig (for compat with existing injectMemoryPalace calls)
        if (char) {
            updateCharacter(char.id, {
                embeddingConfig: {
                    baseUrl: embUrl.trim(),
                    apiKey: embKey.trim(),
                    model: embModel.trim() || 'BAAI/bge-m3',
                    dimensions: embDimensions || 1024,
                },
            } as any);
        }
        setConfigSaved(true);
        setTimeout(() => setConfigSaved(false), 2000);
    };

    const handleSaveRerankConfig = () => {
        updateMemoryPalaceConfig({
            rerank: {
                enabled: rrEnabled,
                baseUrl: rrUrl.trim(),
                apiKey: rrKey.trim(),
                model: rrModel.trim() || 'BAAI/bge-reranker-v2-m3',
                topN: Math.max(1, Math.min(20, rrTopN || 5)),
            },
        });
        setRrSaved(true);
        setTimeout(() => setRrSaved(false), 2000);
    };

    const updateAccommodation = (key: keyof CharacterAccommodationPolicy, value: number) => {
        if (!char) return;
        updateCharacter(char.id, {
            interactionAccommodation: {
                ...DEFAULT_CHARACTER_ACCOMMODATION,
                ...(char.interactionAccommodation || {}),
                [key]: value,
            },
        });
    };

    const handleSaveLightApi = () => {
        const api = {
            baseUrl: lightUrl.trim(),
            apiKey: lightKey.trim(),
            model: lightModel.trim(),
        };
        // Only writes the global lightLLM; entirely independent from the emotion API (emotionConfig.api), no cross-effect.
        updateMemoryPalaceConfig({ lightLLM: api });
        setLightSaved(true);
        setTimeout(() => setLightSaved(false), 2000);
    };

    const handleSwitchChar = (id: string) => {
        setActiveCharacterId(id);
        setShowCharPicker(false);
        setView('palace');
        setSelectedRoom(null);
        setSelectedNode(null);
    };

    // Toggle the master "Memory Palace" switch (on the picker card)
    const handleTogglePalaceFromPicker = (charId: string, on: boolean) => {
        trackEvent('Enable Memory Palace', { enabled: on ? 'on' : 'off' });
        if (on) {
            updateCharacter(charId, { memoryPalaceEnabled: true } as any);
        } else {
            // Turning off palace necessarily also turns off full-auto memory; also clears any leftover
            // vector-recall injection, otherwise the old memoryPalaceInjection would be persisted by
            // saveCharacter and keep getting injected into the prompt.
            updateCharacter(charId, {
                memoryPalaceEnabled: false,
                autoArchiveEnabled: false,
                memoryPalaceInjection: undefined,
                contextRangeMode: 'manual',
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            } as any);
        }
    };

    // Toggle the "Full-Auto Memory" (formerly autoArchive) switch: reuses the catch-up logic from the original Character.tsx
    const handleToggleAutoArchiveFromPicker = async (charId: string, on: boolean): Promise<void> => {
        trackEvent('Enable Full-Auto Memory', { enabled: on ? 'on' : 'off' });
        const target = characters.find(c => c.id === charId);
        if (!target) return;

        if (!on) {
            updateCharacter(charId, {
                autoArchiveEnabled: false,
                contextRangeMode: 'manual',
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            } as any);
            addToast('Full-Auto Memory turned off (palace vectorization keeps running normally)', 'info');
            return;
        }

        if (!(target as any).memoryPalaceEnabled) {
            addToast('Please enable Memory Palace first before turning on Full-Auto Memory', 'error');
            return;
        }
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl || !mpLLM?.apiKey) {
            addToast('Please configure Embedding + the secondary API in Memory Palace settings first', 'error');
            return;
        }

        updateCharacter(charId, {
            autoArchiveEnabled: true,
            contextRangeMode: 'adaptive',
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
            contextUserStartMessageId: undefined,
        } as any);

        // Count unsynced messages and decide whether to catch up on history immediately
        // The measure must match pipeline's buffer definition: exclude the hot zone specified by this
        // character's tier, otherwise the hot zone that will "never be processed" gets counted as
        // unsynced too, misleading the user into tapping catch-up.
        const { getMemoryPalaceUnprocessedBufferCount } = await import('../utils/memoryPalace/pipeline');
        const unprocessedCount = await getMemoryPalaceUnprocessedBufferCount(charId);

        if (unprocessedCount < 10) {
            addToast('Full-Auto Memory enabled (all historical messages are already synced)', 'success');
            return;
        }

        const minutes = Math.max(1, Math.ceil(unprocessedCount / 300));
        // Show a nicer confirm dialog (replaces the native confirm)
        setAutoArchiveConfirm({
            charId,
            charName: target.name,
            unprocessedCount,
            minutes,
            mpEmb,
            mpLLM,
        });
    };

    const saveCharacterWaterline = (
        target: CharacterProfile,
        nextConfig: CharacterProfile['memoryPalaceWaterline'],
    ) => {
        const before = resolveMemoryPalaceWaterline(target.memoryPalaceWaterline);
        const after = resolveMemoryPalaceWaterline(nextConfig);
        updateCharacter(target.id, { memoryPalaceWaterline: nextConfig });

        const faster = after.hotZoneSize <= before.hotZoneSize
            && after.bufferThreshold <= before.bufferThreshold
            && (after.hotZoneSize < before.hotZoneSize || after.bufferThreshold < before.bufferThreshold);
        const slower = after.hotZoneSize >= before.hotZoneSize
            && after.bufferThreshold >= before.bufferThreshold
            && (after.hotZoneSize > before.hotZoneSize || after.bufferThreshold > before.bufferThreshold);
        if (faster) {
            addToast('Sped up: organizing starts next time the new threshold is reached, raw text stays visible until it succeeds', 'success');
        } else if (slower) {
            addToast('Slowed down: the old waterline will not roll back, the raw-text window will gradually grow with new conversation', 'success');
        } else {
            addToast('Memory-processing pace saved for this character', 'success');
        }
    };

    const handleWaterlinePresetChange = (
        target: CharacterProfile,
        preset: MemoryPalaceWaterlinePreset,
    ) => {
        if (preset === 'custom') {
            const current = resolveMemoryPalaceWaterline(target.memoryPalaceWaterline);
            saveCharacterWaterline(target, makeCustomMemoryPalaceWaterline(
                current.hotZoneSize,
                current.bufferThreshold,
            ));
            return;
        }
        saveCharacterWaterline(target, { preset });
    };

    const handleSaveCustomWaterline = (
        target: CharacterProfile,
        hotZoneSize: number,
        bufferThreshold: number,
    ) => {
        saveCharacterWaterline(target, makeCustomMemoryPalaceWaterline(hotZoneSize, bufferThreshold));
    };

    // Full-Auto Memory: the loop logic that runs after the user taps "Catch Up Now"
    const runAutoArchiveCatchUp = async (params: {
        charId: string;
        charName: string;
        unprocessedCount: number;
        mpEmb: any;
        mpLLM: any;
    }) => {
        const { charId, charName, unprocessedCount, mpEmb, mpLLM } = params;
        const target = characters.find(c => c.id === charId);
        if (!target) return;

        const {
            getMemoryPalaceHighWaterMark,
            getMemoryPalaceUnprocessedBufferCount,
            processNewMessages,
            mergePalaceFragmentsIntoMemories,
        } = await import('../utils/memoryPalace/pipeline');

        setAutoArchiveSyncingId(charId);
        setAutoArchiveSyncProgress(`Preparing... (${unprocessedCount})`);
        try {
            const MAX_ROUNDS = 50;
            let accumulatedMemories = (target as any).memories ? [...(target as any).memories] : [];
            let latestHideBefore = (target as any).hideBeforeMessageId;
            let totalProcessed = 0;

            for (let round = 1; round <= MAX_ROUNDS; round++) {
                const curHwm = getMemoryPalaceHighWaterMark(charId);
                // Uses pipeline's real buffer measure (excludes this character's tier hot zone), to avoid
                // repeatedly retrying the hot zone as if it were unsynced -- the force=true call below
                // actually only processes the buffer anyway, looping with the same measure is the only
                // way to converge correctly.
                const remaining = await getMemoryPalaceUnprocessedBufferCount(charId);
                if (remaining < 10) break;
                setAutoArchiveSyncProgress(`Round ${round}: ${remaining} remaining`);

                // processNewMessages ignores the first argument (loads directly from the DB internally), passing [] is fine
                const result = await processNewMessages([], charId, charName, mpEmb, mpLLM, userProfile.name, true);

                // Soft skip: buffer hasn't hit the threshold / hot zone hasn't been pushed out yet / a task is already running -- not a palace failure
                if (result?.skipReason) {
                    if (result.skipReason !== 'lock') {
                        addToast('Not enough chat yet to trigger a summary -- keep chatting like this~', 'info');
                    }
                    break;
                }

                if (result?.autoArchive) {
                    accumulatedMemories = mergePalaceFragmentsIntoMemories(accumulatedMemories, result.autoArchive.fragments);
                    latestHideBefore = result.autoArchive.hideBeforeMessageId;
                }

                const newHwm = getMemoryPalaceHighWaterMark(charId);
                if (newHwm <= curHwm) {
                    addToast('Catch-up interrupted: palace processing failed, please check the secondary API config', 'error');
                    break;
                }
                totalProcessed += result?.processedMessages || 0;
            }

            updateCharacter(charId, { memories: accumulatedMemories, hideBeforeMessageId: latestHideBefore } as any);
            addToast(`History catch-up complete, processed ${totalProcessed} messages`, 'success');
        } catch (e: any) {
            addToast(`Catch-up failed: ${e?.message || 'Unknown error'} (the switch stays on, processing will continue at the normal pace)`, 'error');
        } finally {
            setAutoArchiveSyncingId(null);
            setAutoArchiveSyncProgress('');
        }
    };

    // Remote vector: test connection
    const handleTestRemoteVector = async () => {
        setRvTesting(true);
        setRvTestResult('');
        try {
            const { testConnection } = await import('../utils/memoryPalace/supabaseVector');
            const result = await testConnection({ enabled: true, supabaseUrl: rvUrl, supabaseAnonKey: rvKey, initialized: false });
            if (result.ok && result.tableExists) setRvTestResult('[ok]' + result.message);
            else if (result.ok) setRvTestResult('[warn]' + result.message);
            else setRvTestResult('[err]' + result.message);
        } catch (e: any) { setRvTestResult('[err]' + e.message); }
        setRvTesting(false);
    };

    // Remote vector: save config
    const handleSaveRemoteVector = () => {
        const initialized = rvTestResult.startsWith('[ok]');
        updateRemoteVectorConfig({ enabled: true, supabaseUrl: rvUrl, supabaseAnonKey: rvKey, initialized });
        addToast('Remote vector storage config saved', 'success');
    };

    // Remote vector: disable
    const handleDisableRemoteVector = () => {
        updateRemoteVectorConfig({ enabled: false, initialized: false });
        addToast('Remote vector storage disabled', 'info');
    };

    // Remote vector: sync local to remote
    const handleSyncToRemote = async () => {
        setRvSyncing(true);
        trackEvent('Sync Memory Vectors to Cloud');
        try {
            const { syncLocalToRemote } = await import('../utils/memoryPalace/supabaseVector');
            const { MemoryNodeDB } = await import('../utils/memoryPalace/db');
            const result = await syncLocalToRemote(
                remoteVectorConfig,
                async () => {
                    const allVectors = await (await import('../utils/db')).openDB().then(db => new Promise<any[]>((resolve, reject) => {
                        const tx = db.transaction('memory_vectors', 'readonly');
                        const req = tx.objectStore('memory_vectors').getAll();
                        req.onsuccess = () => resolve(req.result || []);
                        req.onerror = () => reject(req.error);
                    }));
                    const items = [];
                    for (const v of allVectors) {
                        const node = await MemoryNodeDB.getById(v.memoryId);
                        if (node) items.push({ memoryId: v.memoryId, charId: node.charId, vector: v.vector, node, dimensions: v.dimensions, model: v.model });
                    }
                    return items;
                },
                () => {},
            );
            addToast(`Sync complete: ${result.synced} succeeded, ${result.failed} failed`, result.failed > 0 ? 'error' : 'success');
        } catch (e: any) { addToast(`Sync failed: ${e.message}`, 'error'); }
        setRvSyncing(false);
    };

    // Remote vector: copy init SQL
    const handleCopyInitSQL = async () => {
        try {
            const { INIT_SQL } = await import('../utils/memoryPalace/supabaseVector');
            await navigator.clipboard.writeText(INIT_SQL).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = INIT_SQL;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            });
            addToast('SQL copied to clipboard', 'success');
        } catch { addToast('Copy failed', 'error'); }
    };

    // ─── Manual summarization & vectorization (fallback mechanism) ───────────────────────
    // Opens the range-selection modal: loads this character's entire chat history (including messages already auto-summarized)
    const openRangeModal = async () => {
        if (!char) return;
        trackEvent('Open Manual Range Summary Panel');
        setRangeModalOpen(true);
        setRangeLoading(true);
        setRangeResult(null);
        setRangeResultData(null);
        setRangeProgress('');
        setRangeStartId(null);
        setRangeEndId(null);
        setRangePendingId(null);
        setRangeQuery('');
        try {
            const { DB } = await import('../utils/db');
            // includeProcessed=true: the manual fallback needs to be able to re-summarize old messages that have already crossed the waterline
            const msgs = await DB.getMessagesByCharId(char.id, true);
            const list = (msgs || [])
                .filter((m: Message) => m && typeof m.content === 'string' && m.content.trim().length > 0)
                .sort((a: Message, b: Message) => a.id - b.id);
            setRangeMessages(list);
            // Defaults to the last page (most recent messages), matching how chat history scrolls to the bottom
            setRangePage(Math.max(0, Math.ceil(list.length / RANGE_PAGE_SIZE) - 1));
        } catch (e: any) {
            addToast(`Failed to load chat history: ${e?.message || e}`, 'error');
            setRangeMessages([]);
        } finally {
            setRangeLoading(false);
        }
    };

    // Tapping a message: first enters "pending confirmation", then the user taps [Set as start] / [Set as end] to avoid mis-taps
    const onTapRangeMessage = (id: number) => {
        setRangePendingId(prev => prev === id ? null : id); // tapping the same one again = collapse the menu
    };
    // Confirms from the pending menu that this one is the start / end
    const confirmRangeEndpoint = (id: number, which: 'start' | 'end') => {
        if (which === 'start') setRangeStartId(id);
        else setRangeEndId(id);
        setRangePendingId(null);
    };

    // Runs one range summarization: calls processMessageRange, never touches the waterline throughout
    const runRangeSummary = async () => {
        if (!char || rangeRunning) return;
        if (rangeStartId == null || rangeEndId == null) {
            addToast('Please select a start and end point first', 'info');
            return;
        }
        const emb = memoryPalaceConfig.embedding;
        const llm = memoryPalaceConfig.lightLLM;
        if (!emb?.baseUrl || !emb?.apiKey) {
            addToast('Please configure the Embedding API first', 'error');
            return;
        }
        if (!llm?.baseUrl || !llm?.apiKey) {
            addToast('Please configure the secondary API first (used for LLM memory extraction)', 'error');
            return;
        }

        const lo = Math.min(rangeStartId, rangeEndId);
        const hi = Math.max(rangeStartId, rangeEndId);

        setRangeRunning(true);
        setRangeResult(null);
        setRangeProgress('Preparing...');
        trackEvent('Run Manual Range Summary');
        try {
            const { processMessageRange } = await import('../utils/memoryPalace/pipeline');
            const r = await processMessageRange(
                char.id, char.name, emb, llm, lo, hi, userProfile?.name || '',
                (s) => setRangeProgress(s),
            );
            if (r.error === 'lock') {
                setRangeResult('[err]Another memory task is currently running, please try again later');
            } else if (r.error === 'empty') {
                setRangeResult('[err]No processable messages in the selected range');
            } else if (r.error === 'no_memories') {
                setRangeResult('[warn]No new memories were extracted from this conversation (the content may be too fragmentary, or it already exists in memory)');
            } else if (r.error) {
                setRangeResult(`[err]Summarization failed: ${r.error}`);
            } else {
                setRangeResult(`[ok]Done! Added ${r.stored} new memories${r.skipped > 0 ? `, ${r.skipped} skipped as duplicates` : ''} (processed ${r.processedMessages} messages, waterline unchanged)`);
                // Shows the "memory organizing complete" result modal (lists new content one by one, consistent with waterline summarization)
                setRangeResultData(r);
                // Reset the selection to avoid accidentally re-running the same range
                setRangeStartId(null);
                setRangeEndId(null);
                setRangePendingId(null);
            }
            loadStats();
        } catch (e: any) {
            setRangeResult(`[err]Summarization failed: ${e?.message || e}`);
        } finally {
            setRangeRunning(false);
            setRangeProgress('');
        }
    };

    const handleMigrate = async () => {
        if (!char || migrating) return;
        const emb = memoryPalaceConfig.embedding;
        if (!emb?.baseUrl || !emb?.apiKey) {
            setMigrationResult('[err]Please configure the Embedding API first');
            return;
        }

        const oldMemories = char.memories || [];
        if (oldMemories.length === 0) {
            setMigrationResult('No old memories to migrate');
            return;
        }

        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setMigrationResult('[err]Requires the secondary API (a lightweight secondary model) to be configured, used for LLM memory extraction');
            return;
        }

        setMigrating(true);
        setMigrationResult(null);

        try {
            const { ContextBuilder } = await import('../utils/context');
            const charContext = ContextBuilder.buildCoreContext(char, userProfile, false);
            // selectedMonths now stores chunk keys (e.g. "2026-03 early")
            const monthsToProcess = selectedMonths.size > 0 ? Array.from(selectedMonths) : undefined;
            const result = await migrateOldMemories(
                char.id,
                char.name,
                oldMemories,
                char.refinedMemories,
                lightApi,
                emb,
                (p) => setMigrationProgress(p),
                charContext,
                monthsToProcess,
                userProfile?.name,
                remoteVectorConfig,
            );
            setMigrationResult(`[ok]Migration complete: ${result.months} months -> ${result.migrated} memories, ${result.skipped} skipped as duplicates`);
            loadStats(); // Refresh data
        } catch (err: any) {
            setMigrationResult(`[err]Migration failed: ${err.message}`);
        } finally {
            setMigrating(false);
            setMigrationProgress(null);
        }
    };

    const handleDigest = async () => {
        if (!char || digesting) return;
        trackEvent('Manually Trigger Cognitive Digestion');
        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setDigestResult('[err]Please configure the secondary API in Settings first');
            return;
        }

        setDigesting(true);
        setDigestResult(null);

        try {
            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
            const embApi = memoryPalaceConfig.embedding;
            const result = await runCognitiveDigestion(
                char.id, char.name, persona, lightApi, true, userProfile?.name, embApi,
                (stage) => setDigestResult(stage), // review -> backfill/resume -> organize plates, refreshed stage by stage for the user to see
            );
            if (!result) {
                setDigestResult('Nothing needs digesting');
            } else {
                // Self-insight now lands on the self_room plate instead (committed internally by digestion),
                // no longer appended to char.selfInsights; this just shows a result summary
                const parts: string[] = [];
                if (result.resolved.length) parts.push(`${result.resolved.length} confusions resolved`);
                if (result.deepened.length) parts.push(`${result.deepened.length} traumas deepened`);
                if (result.faded.length) parts.push(`${result.faded.length} faded`);
                if (result.fulfilled.length) parts.push(`${result.fulfilled.length} anticipations fulfilled`);
                if (result.disappointed.length) parts.push(`${result.disappointed.length} anticipations unfulfilled`);
                if (result.internalized.length) parts.push(`${result.internalized.length} knowledge internalized`);
                if (result.synthesizedUser.length) parts.push(`${result.synthesizedUser.length} user-cognition syntheses`);
                if (result.selfInsights.length) parts.push(`${result.selfInsights.length} self-insights`);
                if (result.selfConfused.length) parts.push(`${result.selfConfused.length} new confusions`);
                if (result.worries?.length) parts.push(`${result.worries.length} retrospective worries`);
                if (result.aspirations?.length) parts.push(`${result.aspirations.length} new anticipations`);
                if (result.distilled?.length) parts.push(`${result.distilled.length} distilled to plates`);
                if (result.plateUpdated?.length) parts.push(`${result.plateUpdated.length} plates updated`);
                // Plate organizing is handed off to run in the cloud (it can finish even with the page closed) --
                // it returns as soon as it's handed off, and the plates take a few minutes to actually move. When
                // manually digesting, the user has been watching "Organizing plates..." the whole way here; without
                // this line, what they'd see is the organizing stage flash by with the plates not moving at all,
                // indistinguishable from not having run.
                if (result.plateCloudPending) parts.push('Plate organizing is running in the cloud, results land a few minutes later');
                setDigestResult(parts.length > 0 ? `[ok]${parts.join(', ')}` : 'No change');
            }
            loadStats();
            // If the digestion log panel is open, refresh in the report that just landed
            if (digestReports !== null) {
                try { setDigestReports(await DigestReportDB.getByCharId(char.id)); } catch { /* ignore */ }
            }
        } catch (err: any) {
            setDigestResult(`[err]Digestion failed: ${err.message}`);
        } finally {
            setDigesting(false);
        }
    };

    /** Permanently deletes a memory (node + vector + links + EventBox membership reference + remote sync) */
    const deleteMemory = async (nodeId: string) => {
        // First remove from the EventBox (if it belongs to one)
        try { await removeMemoryFromBox(nodeId); } catch { /* ignore */ }
        // Delete links
        const links = await MemoryLinkDB.getByNodeId(nodeId);
        for (const link of links) {
            await MemoryLinkDB.delete(link.id);
        }
        // Delete vector (local)
        const { MemoryVectorDB } = await import('../utils/memoryPalace');
        await MemoryVectorDB.delete(nodeId);
        // Delete vector (remote sync)
        if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
            import('../utils/memoryPalace/supabaseVector').then(({ deleteVector }) =>
                deleteVector(remoteVectorConfig, nodeId).catch(() => {})
            );
        }
        // Delete node
        await MemoryNodeDB.delete(nodeId);
    };

    /** Bulk-deletes selected memories */
    const handleBatchDelete = async () => {
        if (selectedIds.size === 0 || !char) return;
        setDeleting(true);
        try {
            for (const id of selectedIds) {
                await deleteMemory(id);
            }
            // Refresh room data
            if (selectedRoom) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            }
            setSelectedIds(new Set());
            setSelectMode(false);
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    /** Deletes a single memory and returns to the previous view */
    const handleDeleteSingle = async (nodeId: string) => {
        setDeleting(true);
        try {
            await deleteMemory(nodeId);
            setSelectedNode(null);
            setView(prevView);
            if (prevView === 'room' && selectedRoom && char) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            } else if (prevView === 'all' && char) {
                const nodes = await MemoryNodeDB.getByCharId(char.id);
                setAllNodes(nodes);
            } else if (prevView === 'boxes' && char) {
                const boxes = await EventBoxDB.getByCharId(char.id);
                boxes.sort((a, b) => b.updatedAt - a.updatedAt);
                setAllBoxes(boxes);
                setBoxMembers({});
                setExpandedBoxId(null);
            }
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    /** Clears all migrated data */
    /** One-click wipes the Memory Palace (local + optional cloud). Executes after double confirmation. */
    const handleWipeAll = async (includeRemote: boolean) => {
        const firstPrompt = includeRemote
            ? 'About to wipe ALL Memory Palace data [local + cloud Supabase], including:\n\n' +
              '- Memory nodes, vectors, links, and event boxes for every character\n- High-watermark markers\n- The entire cloud memory_vectors table\n\n' +
              'This cannot be undone. Continue?'
            : 'About to wipe ALL [local] Memory Palace data (cloud data is kept).\n\n' +
              'Includes memory nodes, vectors, links, event boxes, and high-watermark markers for every character.\n\n' +
              'This cannot be undone. Continue?';
        if (!confirm(firstPrompt)) return;
        if (!confirm('Confirm once more: really wipe everything?')) return;

        setWiping(true);
        setWipeResult(null);
        trackEvent('Wipe All Memory Data', { scope: includeRemote ? 'all' : 'local' });
        try {
            const result = await wipeAllMemoryPalace({
                remoteConfig: includeRemote ? remoteVectorConfig : undefined,
                skipRemote: !includeRemote,
            });
            // Friendly breakdown: only memory nodes are really "a memory", the rest is derived data
            const STORE_LABELS: Record<string, string> = {
                memory_nodes: 'memories',
                memory_vectors: 'vectors',
                memory_links: 'links',
                memory_batches: 'batches',
                anticipations: 'anticipations',
                event_boxes: 'event boxes',
            };
            const parts: string[] = [];
            for (const [store, count] of Object.entries(result.local)) {
                if (count > 0) parts.push(`${STORE_LABELS[store] || store} ${count}`);
            }
            const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
            const msg = `Local data wiped${breakdown}; ${result.highWatermarks} high-watermark markers`
                + (result.remoteAttempted ? `; ${result.remote} cloud vector rows` : '; cloud data not wiped');
            setWipeResult(msg);
            await loadStats();
        } catch (e: any) {
            setWipeResult(`[err]Wipe failed: ${e?.message || e}`);
        } finally {
            setWiping(false);
        }
    };

    /** Exports the current character's Memory Palace as a JSON file (for connecting to an external memory store).
     *  Includes memory nodes / event boxes / anticipations, but not vectors (vectors are tightly bound to the
     *  embedding model, meaningless for an external store). */
    const handleExportMemories = async () => {
        if (!char) return;
        setExporting(true);
        setExportResult(null);
        try {
            const data = await exportMemoryPalace(
                [{ id: char.id, name: char.name }],
                { includeVectors: exportWithVectors },
            );
            const c = data.characters[0]?.counts;
            const nodeCount = c?.nodes ?? 0;
            if (nodeCount === 0) {
                setExportResult('[warn]This character has no Memory Palace nodes yet, nothing to export');
                return;
            }
            // Pre-export plaintext-key check + second confirmation (Memory Palace data normally has no keys -> shows "safe to share").
            if (!(await confirmExportSafety(data))) return;
            const json = JSON.stringify(data, null, 2);
            const safeName = (char.name || 'character').replace(/[\\/:*?"<>|]/g, '_');
            const fileName = `${safeName}_MemoryPalace_${new Date().toISOString().slice(0, 10)}.json`;
            const exportDisposition = await shareOrDownloadFile({
                content: json,
                fileName,
                mimeType: 'application/json;charset=utf-8',
                shareTitle: `${char.name}'s Memory Palace`,
            });
            trackEvent('Export Memory Palace Backup');
            const vecPart = exportWithVectors ? `, ${c.vectors} vectors` : '';
            setExportResult(`[ok]${exportDisposition === 'shared' ? 'Opened share panel: ' : 'Exported '}${nodeCount} memories, ${c.eventBoxes} event boxes, ${c.anticipations} anticipations${vecPart}`);
        } catch (e: any) {
            setExportResult(`[err]Export failed: ${e?.message || e}`);
        } finally {
            setExporting(false);
        }
    };

    /** After selecting an import file: parses JSON -> validates -> merges into the current character's Memory Palace. */
    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const fileObj = e.target.files?.[0];
        // Clear the input, so re-selecting the same file can still re-trigger onChange
        if (importInputRef.current) importInputRef.current.value = '';
        if (!fileObj || !char) return;
        setImporting(true);
        setImportResult(null);
        try {
            const text = await fileObj.text();
            const data = JSON.parse(text);
            if (!isMemoryPalaceExportFile(data)) {
                setImportResult('[err]This is not a SullyOS Memory Palace export file');
                return;
            }
            const totalNodes = data.characters.reduce((s, c) => s + (c.nodes?.length || 0), 0);
            const hadVectors = data.includeVectors;
            if (!confirm(
                `About to merge ${totalNodes} memories from this file into ${char.name}'s Memory Palace.\n\n`
                + `- This won't overwrite existing memories, it appends and merges (re-importing the same file will create duplicates).\n`
                + (hadVectors ? '- The file includes vectors, which will be imported along with it.\n' : '- The file has no vectors; after importing, these memories will need vectors rebuilt before semantic search will find them.\n')
                + `\nContinue?`
            )) return;

            const result = await importMemoryPalace(data, char.id);
            trackEvent('Import Memory Palace Backup');
            const vecPart = result.vectors > 0 ? `, ${result.vectors} vectors` : '';
            const platePart = result.roomPlateEntries > 0 ? `, ${result.roomPlateEntries} plate insights` : '';
            setImportResult(
                `[ok]Imported ${result.nodes} memories, ${result.eventBoxes} event boxes, ${result.anticipations} anticipations${vecPart}${platePart}`
                + (hadVectors ? '' : ' (no vectors -- rebuild vectors in "Global Settings" before using semantic search)')
            );
            await loadStats();
        } catch (err: any) {
            setImportResult(`[err]Import failed: ${err?.message || err}`);
        } finally {
            setImporting(false);
        }
    };

    /** External raw text -> lossless cleanup -> written to both the vector palace and the legacy Neural Link profile. */
    const handleExternalMemoryImport = async () => {
        if (!char || externalImporting) return;
        const text = externalMemoryText.trim();
        if (!text) {
            setExternalImportResult('[err]Please paste the memory text to move over first');
            return;
        }
        if (externalLengthInfo.overLimit) {
            setExternalImportResult(`[err]${getExternalMemoryOverLimitMessage(externalMemoryText)}`);
            return;
        }
        const emb = memoryPalaceConfig.embedding;
        const llm = memoryPalaceConfig.lightLLM;
        if (!emb?.baseUrl || !emb?.apiKey || !emb?.model) {
            setExternalImportResult('[err]Please configure the Embedding API in Memory Palace settings first');
            return;
        }
        if (!llm?.baseUrl || !llm?.apiKey || !llm?.model) {
            setExternalImportResult('[err]Please configure the secondary API in Memory Palace settings first');
            return;
        }

        const target = { id: char.id, name: char.name };
        setExternalImporting(true);
        setExternalImportResult(null);
        setExternalImportProgress('Preparing to move: only organizing timing and structure, not compressing content...');
        try {
            const {
                importExternalMemoryText,
                mergePalaceFragmentsIntoMemories,
            } = await import('../utils/memoryPalace/pipeline');
            const result = await importExternalMemoryText(
                text,
                target.id,
                target.name,
                emb,
                llm,
                userProfile?.name || '',
                stage => setExternalImportProgress(stage),
            );
            if (result.error === 'lock') {
                setExternalImportResult('[err]This character already has another memory task running, please try again later');
            } else if (result.error === 'no_memories') {
                setExternalImportResult('[warn]No importable memories were organized -- please check the source text or the secondary API response');
            } else if (result.error) {
                setExternalImportResult(`[err]Move failed: ${result.error}`);
            } else {
                // Shares the same bridging logic with the full-auto summarization waterline: merges this batch
                // of nodes that actually got written to the vector store into character.memories, grouped by
                // date. External imports have no message ID, so only memories get double-written --
                // hideBeforeMessageId / the chat waterline are not advanced.
                setExternalImportProgress(`Syncing this batch of memories to ${target.name}'s Neural Link profile...`);
                const latestMemories = characters.find(c => c.id === target.id)?.memories || [];
                const mergedMemories = mergePalaceFragmentsIntoMemories(
                    latestMemories,
                    result.archiveFragments,
                );
                updateCharacter(target.id, { memories: mergedMemories });
                setExternalImportResult(
                    `[ok]Added to ${target.name}: ${result.stored} vector memories; the same batch has been synced to the Neural Link profile`
                    + (result.skipped ? `, ${result.skipped} duplicate items skipped` : ''),
                );
                setExternalMemoryText('');
                await loadStats();
            }
        } catch (error: any) {
            setExternalImportResult(`[err]Move failed: ${error?.message || error}`);
        } finally {
            setExternalImporting(false);
            setExternalImportProgress('');
        }
    };

    const handleClearMigrated = async () => {
        if (!char) return;
        setDeleting(true);
        try {
            const allNodes = await MemoryNodeDB.getByCharId(char.id);
            const migrated = allNodes.filter(n => n.boxId?.startsWith('migrated_'));
            for (const node of migrated) {
                await deleteMemory(node.id);
            }
            setMigrationResult(`Cleared ${migrated.length} migrated items`);
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // ─── Entry page: character picker -- rendered when view='picker' or no activeCharacterId is selected ─────
    //     The Exit button here is the only one that actually closes the app; other views' "<- Back" just returns to this layer

    if (view === 'picker' || (!char && view !== 'globalSettings')) {
        return (
            <div
                style={{
                    paddingLeft: 20, paddingRight: 20, paddingBottom: 28, paddingTop: SAFE_PAD_TOP,
                    maxHeight: '100%', overflowY: 'auto',
                    background: 'linear-gradient(180deg, #faf5ff 0%, #f5f3ff 40%, #ffffff 100%)',
                    minHeight: '100%',
                    position: 'relative',
                }}
            >
                {/* Decorative background glow */}
                <div
                    style={{
                        position: 'absolute', top: -40, right: -40, width: 220, height: 220,
                        borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(167,139,250,0.22) 0%, rgba(167,139,250,0) 70%)',
                        pointerEvents: 'none',
                    }}
                />
                <div
                    style={{
                        position: 'absolute', top: 160, left: -60, width: 200, height: 200,
                        borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(236,72,153,0.14) 0%, rgba(236,72,153,0) 70%)',
                        pointerEvents: 'none',
                    }}
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, position: 'relative', zIndex: 1 }}>
                    <div
                        onClick={closeApp}
                        style={{
                            fontSize: 12, color: '#7c3aed', cursor: 'pointer',
                            padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
                            borderRadius: 999, background: 'rgba(124,58,237,0.08)',
                            border: '1px solid rgba(124,58,237,0.15)', fontWeight: 600,
                            letterSpacing: '0.04em',
                        }}
                    >
                        <Icon name="arrow-left" size={11} />
                        <span>Exit</span>
                    </div>
                    <div
                        onClick={() => setView('globalSettings')}
                        title="Memory Palace global config (API, etc.)"
                        style={{
                            position: 'relative',
                            width: 36, height: 36, borderRadius: 12,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                            background: hasEmbeddingConfig
                                ? 'rgba(255,255,255,0.8)'
                                : 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                            border: hasEmbeddingConfig
                                ? '1px solid rgba(124,58,237,0.15)'
                                : '1.5px solid #f59e0b',
                            color: hasEmbeddingConfig ? '#7c3aed' : '#b45309',
                            boxShadow: hasEmbeddingConfig
                                ? '0 2px 6px rgba(124,58,237,0.08)'
                                : '0 0 0 3px rgba(245,158,11,0.15), 0 4px 10px rgba(245,158,11,0.2)',
                            animation: hasEmbeddingConfig ? undefined : 'pulse 2s ease-in-out infinite',
                        }}
                    >
                        <Icon name="settings" size={16} />
                        {!hasEmbeddingConfig && (
                            <span style={{
                                position: 'absolute', top: -3, right: -3,
                                width: 10, height: 10, borderRadius: '50%',
                                background: '#ef4444', border: '2px solid #fff',
                            }} />
                        )}
                    </div>
                </div>

                {/* Embedding not configured highlight reminder */}
                {!hasEmbeddingConfig && (
                    <div
                        onClick={() => setView('globalSettings')}
                        style={{
                            position: 'relative', zIndex: 1,
                            marginBottom: 20, padding: '12px 14px', borderRadius: 16,
                            background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                            border: '1.5px solid #f59e0b',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 10,
                            boxShadow: '0 4px 14px rgba(245,158,11,0.2)',
                        }}
                    >
                        <span style={{
                            width: 32, height: 32, borderRadius: 10,
                            background: 'rgba(245,158,11,0.2)',
                            color: '#b45309',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            <Icon name="warning" size={16} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#78350f' }}>
                                Embedding API not configured
                            </div>
                            <div style={{ fontSize: 10, color: '#92400e', marginTop: 2 }}>
                                Tap here to go to global config · without it, vectorization won't work
                            </div>
                        </div>
                        <span style={{ color: '#b45309', flexShrink: 0 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                        </span>
                    </div>
                )}

                {/* Hero title area */}
                <div style={{ textAlign: 'center', marginBottom: 28, position: 'relative', zIndex: 1 }}>
                    <div
                        style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: '0.42em',
                            color: '#a78bfa', marginBottom: 10, textTransform: 'uppercase',
                        }}
                    >
                        Memory Palace
                    </div>
                    <div
                        style={{
                            fontSize: 28, fontWeight: 800, color: '#1f1147',
                            letterSpacing: '-0.01em',
                            background: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #db2777 100%)',
                            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                            marginBottom: 6,
                        }}
                    >
                        Memory Palace
                    </div>
                    <div style={{ fontSize: 12, color: '#8b5cf6', opacity: 0.8, letterSpacing: '0.04em' }}>
                        Select a character · unlock their seven-room mind space
                    </div>
                </div>

                {/* Group filter (not rendered if no groups exist) */}
                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                    value={selectGroupId} onChange={setSelectGroupId}
                    className="mb-4 relative z-[1]" />
                {characters.length === 0 ? (
                    <div
                        style={{
                            textAlign: 'center', color: '#9ca3af', fontSize: 13, marginTop: 40,
                            padding: 32, borderRadius: 24, background: 'rgba(255,255,255,0.6)',
                            border: '1px dashed #ddd6fe',
                            position: 'relative', zIndex: 1,
                        }}
                    >
                        No characters yet -- go create one in Neural Link
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'relative', zIndex: 1 }}>
                        {filterCharactersByGroup(characters, characterGroups, selectGroupId).map(c => {
                            const isActive = c.id === activeCharacterId;
                            const palaceOn = !!(c as any).memoryPalaceEnabled;
                            const autoOn = !!(c as any).autoArchiveEnabled;
                            const syncing = autoArchiveSyncingId === c.id;

                            return (
                                <div
                                    key={c.id}
                                    style={{
                                        position: 'relative',
                                        borderRadius: 22,
                                        padding: 2,
                                        background: palaceOn
                                            ? 'linear-gradient(135deg, #a78bfa 0%, #ec4899 100%)'
                                            : 'linear-gradient(135deg, #e5e7eb 0%, #f3f4f6 100%)',
                                        boxShadow: palaceOn
                                            ? '0 10px 30px -8px rgba(167,139,250,0.35), 0 4px 12px rgba(236,72,153,0.12)'
                                            : '0 4px 14px rgba(15,23,42,0.05)',
                                        transition: 'all 0.3s ease',
                                    }}
                                >
                                    <div
                                        style={{
                                            borderRadius: 20,
                                            background: isActive
                                                ? 'linear-gradient(180deg, #ffffff 0%, #faf5ff 100%)'
                                                : '#ffffff',
                                            padding: 16,
                                            display: 'flex', flexDirection: 'column', gap: 12,
                                        }}
                                    >
                                        {/* Top: avatar + name + enter button */}
                                        <div
                                            style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
                                            onClick={() => handleSwitchChar(c.id)}
                                        >
                                            <div
                                                style={{
                                                    position: 'relative',
                                                    width: 56, height: 56, borderRadius: 18, overflow: 'hidden',
                                                    flexShrink: 0,
                                                    boxShadow: palaceOn
                                                        ? '0 0 0 2px #fff, 0 0 0 4px rgba(167,139,250,0.5), 0 6px 16px rgba(167,139,250,0.25)'
                                                        : '0 2px 8px rgba(15,23,42,0.08)',
                                                    background: '#f3f4f6',
                                                }}
                                            >
                                                <TokenImg value={c.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                {palaceOn && (
                                                    <div
                                                        style={{
                                                            position: 'absolute', bottom: 2, right: 2,
                                                            width: 12, height: 12, borderRadius: '50%',
                                                            background: 'linear-gradient(135deg, #a78bfa, #ec4899)',
                                                            border: '2px solid #fff',
                                                            boxShadow: '0 0 6px rgba(167,139,250,0.6)',
                                                        }}
                                                    />
                                                )}
                                            </div>

                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div
                                                    style={{
                                                        fontSize: 16, fontWeight: 700, color: '#1f1147',
                                                        letterSpacing: '-0.01em', marginBottom: 3,
                                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {c.name}
                                                </div>
                                                <div
                                                    style={{
                                                        fontSize: 10, fontWeight: 600, letterSpacing: '0.12em',
                                                        textTransform: 'uppercase',
                                                        color: palaceOn ? '#7c3aed' : '#9ca3af',
                                                    }}
                                                >
                                                    {palaceOn ? (syncing ? 'Syncing' : 'Ready') : 'Not enabled'}
                                                </div>
                                            </div>

                                            {palaceOn && (
                                                <div
                                                    style={{
                                                        width: 34, height: 34, borderRadius: 12,
                                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                                        color: '#fff',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        boxShadow: '0 4px 10px rgba(124,58,237,0.3)',
                                                    }}
                                                >
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                                                </div>
                                            )}
                                        </div>

                                        {/* Divider */}
                                        <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, #ede9fe, transparent)' }} />

                                        {/* Toggle area */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                            {/* Memory Palace toggle */}
                                            <div
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                    padding: '6px 4px',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            width: 30, height: 30, borderRadius: 10,
                                                            background: palaceOn
                                                                ? 'linear-gradient(135deg, rgba(167,139,250,0.2), rgba(236,72,153,0.15))'
                                                                : '#f3f4f6',
                                                            color: palaceOn ? '#7c3aed' : '#9ca3af',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M12 2a9 9 0 0 0-9 9c0 3 1.5 5.5 4 7v3h10v-3c2.5-1.5 4-4 4-7a9 9 0 0 0-9-9Z" />
                                                            <path d="M9 22v-4M15 22v-4M12 12v6M9 15h6" />
                                                        </svg>
                                                    </div>
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f1147' }}>
                                                            Memory Palace
                                                        </div>
                                                        <div
                                                            style={{
                                                                fontSize: 10, color: '#9ca3af', marginTop: 1,
                                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            }}
                                                        >
                                                            Seven-room space model · vector search
                                                        </div>
                                                    </div>
                                                </div>
                                                <label
                                                    style={{
                                                        position: 'relative', display: 'inline-block',
                                                        width: 42, height: 24, cursor: 'pointer', flexShrink: 0,
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={palaceOn}
                                                        onChange={e => handleTogglePalaceFromPicker(c.id, e.target.checked)}
                                                        style={{ opacity: 0, width: 0, height: 0 }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', inset: 0, borderRadius: 24,
                                                            background: palaceOn
                                                                ? 'linear-gradient(135deg, #a78bfa, #7c3aed)'
                                                                : '#e5e7eb',
                                                            transition: 'background 0.25s',
                                                            boxShadow: palaceOn
                                                                ? 'inset 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(124,58,237,0.3)'
                                                                : 'inset 0 1px 2px rgba(0,0,0,0.05)',
                                                        }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', top: 2, left: palaceOn ? 20 : 2,
                                                            width: 20, height: 20, borderRadius: '50%',
                                                            background: '#fff',
                                                            transition: 'left 0.25s',
                                                            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                                                        }}
                                                    />
                                                </label>
                                            </div>

                                            {/* Full-Auto Memory toggle (depends on palace) */}
                                            <div
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                    padding: '6px 4px',
                                                    opacity: palaceOn ? 1 : 0.4,
                                                    pointerEvents: palaceOn ? 'auto' : 'none',
                                                    transition: 'opacity 0.25s',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            width: 30, height: 30, borderRadius: 10,
                                                            background: autoOn && palaceOn
                                                                ? 'linear-gradient(135deg, rgba(236,72,153,0.2), rgba(251,146,60,0.15))'
                                                                : '#f3f4f6',
                                                            color: autoOn && palaceOn ? '#db2777' : '#9ca3af',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                                                            <path d="M21 4v5h-5" />
                                                            <path d="M12 7v5l3 2" />
                                                        </svg>
                                                    </div>
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f1147' }}>
                                                            Full-Auto Memory
                                                        </div>
                                                        <div
                                                            style={{
                                                                fontSize: 10, color: '#9ca3af', marginTop: 1,
                                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            }}
                                                        >
                                                            {syncing
                                                                ? autoArchiveSyncProgress || 'Catching up...'
                                                                : 'Auto-archives · advances the waterline · hides summarized'}
                                                        </div>
                                                    </div>
                                                </div>
                                                <label
                                                    style={{
                                                        position: 'relative', display: 'inline-block',
                                                        width: 42, height: 24, cursor: syncing ? 'wait' : 'pointer', flexShrink: 0,
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={autoOn}
                                                        disabled={syncing || !palaceOn}
                                                        onChange={e => handleToggleAutoArchiveFromPicker(c.id, e.target.checked)}
                                                        style={{ opacity: 0, width: 0, height: 0 }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', inset: 0, borderRadius: 24,
                                                            background: autoOn
                                                                ? 'linear-gradient(135deg, #f472b6, #db2777)'
                                                                : '#e5e7eb',
                                                            transition: 'background 0.25s',
                                                            boxShadow: autoOn
                                                                ? 'inset 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(219,39,119,0.3)'
                                                                : 'inset 0 1px 2px rgba(0,0,0,0.05)',
                                                            opacity: syncing ? 0.6 : 1,
                                                        }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', top: 2, left: autoOn ? 20 : 2,
                                                            width: 20, height: 20, borderRadius: '50%',
                                                            background: '#fff',
                                                            transition: 'left 0.25s',
                                                            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                                                        }}
                                                    />
                                                </label>
                                            </div>

                                            {palaceOn && autoOn && (
                                                <MemoryWaterlineEditor
                                                    character={c}
                                                    expanded={waterlineEditorCharId === c.id}
                                                    disabled={syncing}
                                                    onToggle={() => setWaterlineEditorCharId(current => current === c.id ? null : c.id)}
                                                    onPresetChange={preset => handleWaterlinePresetChange(c, preset)}
                                                    onSaveCustom={(hotZoneSize, bufferThreshold) => handleSaveCustomWaterline(
                                                        c,
                                                        hotZoneSize,
                                                        bufferThreshold,
                                                    )}
                                                />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Full-Auto Memory catch-up confirm dialog (replaces the native confirm) */}
                {autoArchiveConfirm && (
                    <div
                        style={{
                            position: 'fixed', inset: 0, zIndex: 200,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 24,
                            background: 'rgba(31,17,71,0.45)',
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                            animation: 'fade-in 0.2s ease-out',
                        }}
                        onClick={() => {
                            setAutoArchiveConfirm(null);
                            addToast('Full-Auto Memory enabled, historical messages will be processed at the normal pace', 'info');
                        }}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 360,
                                borderRadius: 28, overflow: 'hidden',
                                background: 'linear-gradient(180deg, #ffffff 0%, #faf5ff 100%)',
                                boxShadow: '0 25px 60px -15px rgba(124,58,237,0.4), 0 10px 30px rgba(0,0,0,0.15)',
                                border: '1px solid rgba(167,139,250,0.25)',
                            }}
                        >
                            {/* Hero header */}
                            <div
                                style={{
                                    padding: '26px 24px 20px',
                                    background: 'linear-gradient(135deg, rgba(167,139,250,0.12) 0%, rgba(236,72,153,0.08) 100%)',
                                    textAlign: 'center',
                                    position: 'relative',
                                }}
                            >
                                <div
                                    style={{
                                        width: 54, height: 54, borderRadius: 18,
                                        margin: '0 auto 12px',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                        color: '#fff',
                                        boxShadow: '0 8px 20px rgba(124,58,237,0.35)',
                                    }}
                                >
                                    <Icon name="sync" size={26} />
                                </div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.32em', color: '#a78bfa', textTransform: 'uppercase', marginBottom: 6 }}>
                                    Auto Memory
                                </div>
                                <div style={{ fontSize: 17, fontWeight: 800, color: '#1f1147', letterSpacing: '-0.01em' }}>
                                    Full-Auto Memory Enabled
                                </div>
                                <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 4, opacity: 0.85 }}>
                                    {autoArchiveConfirm.charName} · Catching up on history
                                </div>
                            </div>

                            {/* Data cards */}
                            <div style={{ padding: '18px 24px 4px' }}>
                                <div
                                    style={{
                                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
                                        marginBottom: 14,
                                    }}
                                >
                                    <div
                                        style={{
                                            padding: '12px 14px', borderRadius: 16,
                                            background: 'rgba(167,139,250,0.08)',
                                            border: '1px solid rgba(167,139,250,0.2)',
                                        }}
                                    >
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', letterSpacing: '0.16em', textTransform: 'uppercase' }}>Unsynced</div>
                                        <div style={{ fontSize: 22, fontWeight: 800, color: '#4c1d95', marginTop: 4, fontFamily: `'Space Grotesk', sans-serif`, lineHeight: 1 }}>
                                            {autoArchiveConfirm.unprocessedCount}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 2 }}>historical messages</div>
                                    </div>
                                    <div
                                        style={{
                                            padding: '12px 14px', borderRadius: 16,
                                            background: 'rgba(236,72,153,0.08)',
                                            border: '1px solid rgba(236,72,153,0.2)',
                                        }}
                                    >
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#ec4899', letterSpacing: '0.16em', textTransform: 'uppercase' }}>Estimated</div>
                                        <div style={{ fontSize: 22, fontWeight: 800, color: '#9d174d', marginTop: 4, fontFamily: `'Space Grotesk', sans-serif`, lineHeight: 1 }}>
                                            ~{autoArchiveConfirm.minutes}
                                            <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 2 }}>min</span>
                                        </div>
                                        <div style={{ fontSize: 10, color: '#db2777', marginTop: 2 }}>Keep the app open</div>
                                    </div>
                                </div>

                                {/* Note */}
                                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.7, padding: '4px 2px' }}>
                                    Catching up hands unsynced past messages to the secondary API in batches, auto-archives them, and advances the waterline.
                                </div>
                            </div>

                            {/* Action buttons */}
                            <div
                                style={{
                                    padding: '14px 24px 22px',
                                    display: 'flex', flexDirection: 'column', gap: 8,
                                }}
                            >
                                <button
                                    onClick={() => {
                                        const conf = autoArchiveConfirm;
                                        setAutoArchiveConfirm(null);
                                        runAutoArchiveCatchUp({
                                            charId: conf.charId,
                                            charName: conf.charName,
                                            unprocessedCount: conf.unprocessedCount,
                                            mpEmb: conf.mpEmb,
                                            mpLLM: conf.mpLLM,
                                        });
                                    }}
                                    style={{
                                        padding: '13px 0', borderRadius: 16,
                                        border: 'none', cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                        color: '#fff', fontSize: 14, fontWeight: 700,
                                        letterSpacing: '0.02em',
                                        boxShadow: '0 6px 16px rgba(124,58,237,0.35)',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                    }}
                                >
                                    <Icon name="bolt" size={14} />
                                    Catch Up History Now
                                </button>
                                <button
                                    onClick={() => {
                                        setAutoArchiveConfirm(null);
                                        addToast('Full-Auto Memory enabled, historical messages will be processed at the normal pace', 'info');
                                    }}
                                    style={{
                                        padding: '11px 0', borderRadius: 16,
                                        border: '1px solid rgba(124,58,237,0.2)',
                                        cursor: 'pointer',
                                        background: 'transparent',
                                        color: '#7c3aed', fontSize: 13, fontWeight: 600,
                                    }}
                                >
                                    Process gradually later at the selected pace
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ─── Memory Palace not enabled ─────────────────────────────────

    if (!char!.memoryPalaceEnabled && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div
                    onClick={() => setView('picker')}
                    style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', marginBottom: 16, padding: '4px 0' }}
                >
                    ← Back
                </div>
                <div style={{ textAlign: 'center', color: '#9ca3af' }}>
                    <div style={{ marginBottom: 16, color: '#c4b5fd', display: 'inline-flex' }}>
                        <Icon name="palace" size={56} />
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Memory Palace</div>
                    <div style={{ fontSize: 13, marginBottom: 20 }}>
                        {char.name} hasn't enabled Memory Palace yet
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 20 }}>
                        Please go back to the character-select page to enable it
                    </div>
                </div>
                {/* Switch to another character */}
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Switch Character</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {characters.filter(c => c.id !== char.id).map(c => (
                        <div
                            key={c.id}
                            onClick={() => handleSwitchChar(c.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: 10, borderRadius: 12, cursor: 'pointer',
                                border: '1px solid #e5e7eb', backgroundColor: '#fafafa',
                            }}
                        >
                            <TokenImg value={c.avatar} alt="" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover' }} />
                            <div>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</div>
                                <div style={{ fontSize: 10, color: '#7c3aed', display: 'inline-flex' }}>
                                    {(c as any).memoryPalaceEnabled ? <Icon name="palace" size={12} /> : null}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ─── Personality detection dialog (detecting / awaiting confirmation) ──────────────

    const STYLE_LABELS: Record<string, string> = {
        emotional: 'Emotional', narrative: 'Narrative', imagery: 'Imagery', analytical: 'Analytical',
    };
    const STYLE_DESCS: Record<string, string> = {
        emotional: 'Thinking is emotion-led, associations favor the emotional pathway first',
        narrative: 'Thinking is timeline-led, likes to recall experiences and tell stories',
        imagery: 'Thinking is metaphor- and image-led, likes to understand the world through comparisons',
        analytical: 'Thinking is logic- and causality-led, likes to analyze and reason',
    };
    const RUM_LABELS = (v: number) =>
        v <= 0.2 ? 'Carefree, rarely dwells on the past' :
        v <= 0.5 ? 'Occasionally thinks back on old things' :
        v <= 0.8 ? 'Sensitive, easily gets stuck on old things' : 'Deeply fixated, hard to let go';

    if (detectingPersonality && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 32, paddingRight: 32, paddingBottom: 32, paddingTop: SAFE_PAD_TOP, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                <div style={{ marginBottom: 16, color: '#7c3aed', animation: 'pulse 2s ease-in-out infinite', display: 'inline-flex' }}>
                    <Icon name="crystal" size={40} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#4b5563', marginBottom: 8 }}>
                    Analyzing {char.name}'s personality traits...
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', lineHeight: 1.6 }}>
                    Based on the character's persona and existing memories<br />determines cognitive style and rumination tendency
                </div>
            </div>
        );
    }

    if (pendingPersonality && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 24, paddingRight: 24, paddingBottom: 24, paddingTop: SAFE_PAD_TOP, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                <div style={{ marginBottom: 12, color: '#7c3aed', display: 'inline-flex' }}>
                    <Icon name="mask" size={40} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', marginBottom: 16 }}>
                    {char.name}'s Personality Analysis Results
                </div>

                <div style={{
                    width: '100%', maxWidth: 320, borderRadius: 16, overflow: 'hidden',
                    border: '1px solid #e5e7eb', background: 'white',
                }}>
                    {/* Cognitive Style */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Cognitive Style</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#7c3aed' }}>
                            {STYLE_LABELS[pendingPersonality.style] || pendingPersonality.style}
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                            {STYLE_DESCS[pendingPersonality.style] || ''}
                        </div>
                    </div>
                    {/* Rumination Tendency */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Rumination Tendency</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 18, fontWeight: 700, color: '#7c3aed' }}>
                                {pendingPersonality.ruminationTendency.toFixed(1)}
                            </span>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                                {RUM_LABELS(pendingPersonality.ruminationTendency)}
                            </span>
                        </div>
                    </div>
                    {/* Reasoning */}
                    {pendingPersonality.reasoning && (
                        <div style={{ padding: '12px 20px', background: '#faf5ff' }}>
                            <div style={{ fontSize: 12, color: '#7c3aed', fontStyle: 'italic', lineHeight: 1.5 }}>
                                "{pendingPersonality.reasoning}"
                            </div>
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 20, width: '100%', maxWidth: 320 }}>
                    <button
                        onClick={() => {
                            // Guard: only apply the result to the character that produced it
                            if (pendingPersonalityCharId && pendingPersonalityCharId !== char.id) {
                                setPendingPersonality(null);
                                setPendingPersonalityCharId(null);
                                return;
                            }
                            updateCharacter(char.id, {
                                personalityStyle: pendingPersonality.style,
                                ruminationTendency: pendingPersonality.ruminationTendency,
                            } as any);
                            // Mark personality as set, never auto-retest afterward
                            try { localStorage.setItem(`mp_personality_tried_${char.id}`, '1'); } catch {}
                            setPendingPersonality(null);
                            setPendingPersonalityCharId(null);
                        }}
                        style={{
                            flex: 1, padding: '12px 0', borderRadius: 12, border: 'none',
                            fontSize: 14, fontWeight: 700, color: 'white', background: '#7c3aed',
                            cursor: 'pointer',
                        }}
                    >
                        Confirm
                    </button>
                    <button
                        onClick={() => {
                            // Guard: only write the skip to the character that produced the result
                            if (pendingPersonalityCharId && pendingPersonalityCharId !== char.id) {
                                setPendingPersonality(null);
                                setPendingPersonalityCharId(null);
                                return;
                            }
                            // Use default values, letting the user adjust later in cognitive parameters
                            updateCharacter(char.id, {
                                personalityStyle: 'emotional',
                                ruminationTendency: 0.3,
                            } as any);
                            try { localStorage.setItem(`mp_personality_tried_${char.id}`, '1'); } catch {}
                            setPendingPersonality(null);
                            setPendingPersonalityCharId(null);
                        }}
                        style={{
                            padding: '12px 16px', borderRadius: 12, border: '1px solid #e5e7eb',
                            fontSize: 13, fontWeight: 600, color: '#6b7280', background: 'white',
                            cursor: 'pointer',
                        }}
                    >
                        Skip
                    </button>
                </div>

                <div style={{ fontSize: 10, color: '#c4c4c4', marginTop: 12, textAlign: 'center' }}>
                    Adjustable anytime in Settings under "Cognitive Parameters"
                </div>
            </div>
        );
    }

    // ─── Settings view (Embedding config) ──────────────────────

    if (view === 'settings' || view === 'globalSettings') {
        const isGlobal = view === 'globalSettings';
        const backTarget: 'palace' | 'picker' = isGlobal ? 'picker' : 'palace';
        const backLabel = isGlobal ? '← Back to character select' : '← Back to palace';
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div
                    onClick={() => setView(backTarget)}
                    style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', marginBottom: 16 }}
                >
                    {backLabel}
                </div>

                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div style={{ marginBottom: 6, color: '#7c3aed', display: 'inline-flex' }}>
                        <Icon name="settings" size={28} />
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>
                        {isGlobal ? 'Memory Palace · Global Config' : `${char?.name ?? ''}'s Memory Settings`}
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        {isGlobal ? 'All characters share the same API · not character-specific' : 'Applies only to the current character'}
                    </div>
                </div>

                {/* Cost warning */}
                {isGlobal && (<>

                <div style={{
                    padding: 14, borderRadius: 14, marginBottom: 16,
                    background: '#fef2f2', border: '2px solid #fca5a5',
                    fontSize: 12, color: '#991b1b', lineHeight: 1.7,
                }}>
                    <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="warning" size={14} />
                        <span>Recommend using an ultra-cheap model</span>
                    </div>
                    Memory Palace's background processing (topic splitting, memory extraction, link analysis, cognitive digestion) uses the "secondary API" configured below,
                    called a few times per turn during everyday chatting.<br/>
                    <b>Recommend setting an ultra-cheap model</b> to run background tasks -- pick whichever provider/model you like; at this volume, pay-per-token vs pay-per-call barely matters, just compare unit prices if you want to be thorough.<br/>
                    <span style={{ fontSize: 11, color: '#b91c1c' }}>
                        Note: "Import Old Memories" is a one-time bulk operation with noticeably more calls than everyday use -- see the separate notice there.
                    </span>
                </div>

                {/* Secondary API config */}
                <div style={{ background: '#f0fdf4', borderRadius: 16, padding: 16, border: '1px solid #bbf7d0', marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="robot" size={14} />
                        <span>Secondary API (for background processing)</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 10, lineHeight: 1.6 }}>
                        Used for background tasks like <b>memory extraction, link analysis, and cognitive digestion</b>. This config applies globally and is shared by all characters.
                        <span style={{ color: '#9ca3af' }}>Only affects Memory Palace-related processes -- doesn't affect the main chat or emotion perception.</span>
                    </div>
                    <div style={{
                        fontSize: 10, color: '#9a3412', background: '#fff7ed',
                        border: '1px solid #fed7aa', borderRadius: 8, padding: '6px 8px',
                        marginBottom: 12, lineHeight: 1.6,
                    }}>
                        When left <b>blank</b> below (URL empty), Memory Palace will <b>automatically fall back to the primary API</b> for background processing.
                        To route background tasks through a cheaper account / avoid using up your primary API quota, fill in a cheap model here.
                        Not sure what to pick? Just grab any model at <b>a few cents per million tokens</b> -- background tasks don't need reasoning ability.
                    </div>

                    {/* API preset quick-fill */}
                    {apiPresets.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                            <label className={labelClass}>Import from preset</label>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {apiPresets.map(p => (
                                    <button key={p.id} onClick={() => {
                                        setLightUrl(p.config.baseUrl);
                                        setLightKey(p.config.apiKey);
                                        setLightModel(p.config.model);
                                    }} style={{
                                        padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                                        border: '1px solid #bbf7d0', background: 'white', color: '#166534',
                                        cursor: 'pointer',
                                    }}>
                                        {p.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input type="text" value={lightUrl} onChange={e => setLightUrl(e.target.value)}
                                placeholder="https://..." className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>API KEY</label>
                            <input type="password" value={lightKey} onChange={e => setLightKey(e.target.value)}
                                placeholder="sk-..." className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>MODEL</label>
                            <input type="text" value={lightModel} onChange={e => setLightModel(e.target.value)}
                                placeholder="A cheap chat model name" className={inputClass} />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                Fill in any cheap <b>chat model</b> from any provider (same format as the primary API), pick whichever you like.
                                Note: this needs a <b>chat</b> model for running background text tasks, <b>not</b> an embedding vector model -- don't put in the kind that belongs in the Embedding section below.
                            </div>
                        </div>
                    </div>

                    <button onClick={handleSaveLightApi}
                        disabled={!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()}
                        style={{
                            width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                            background: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? '#cbd5e1' : '#16a34a',
                            cursor: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {lightSaved ? '✓ Saved' : 'Save Secondary API Config'}
                    </button>

                    {/* Test secondary API connection */}
                    <button
                        onClick={async () => {
                            if (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) return;
                            setTestingLight(true);
                            setLightTestResult(null);
                            try {
                                const res = await fetch(`${lightUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${lightKey.trim()}`,
                                    },
                                    body: JSON.stringify({
                                        model: lightModel.trim(),
                                        messages: [{ role: 'user', content: 'Hi' }],
                                        max_tokens: 5,
                                    }),
                                });
                                if (res.ok) {
                                    const data = await res.json();
                                    const reply = (data.choices?.[0]?.message?.content || '').toString();
                                    setLightTestResult(`[ok]Connected successfully -- model replied: "${reply.slice(0, 30)}"`);
                                } else {
                                    const text = await res.text().catch(() => '');
                                    setLightTestResult(`[err]HTTP ${res.status}: ${text.slice(0, 120)}`);
                                }
                            } catch (err: any) {
                                setLightTestResult(`[err]Connection failed: ${err?.message || String(err)}`);
                            } finally {
                                setTestingLight(false);
                            }
                        }}
                        disabled={testingLight || !lightUrl.trim() || !lightKey.trim() || !lightModel.trim()}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                            border: '1px solid #16a34a44', fontWeight: 600, fontSize: 13,
                            color: '#16a34a', background: 'white',
                            cursor: (testingLight || !lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 'not-allowed' : 'pointer',
                            opacity: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 0.5 : 1,
                        }}
                    >
                        {testingLight ? 'Testing...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>Test API Connection</span>
                            </span>
                        )}
                    </button>

                    {lightTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: lightTestResult.startsWith('[ok]') ? '#f0fdf4' : '#fef2f2',
                            color: lightTestResult.startsWith('[ok]') ? '#16a34a' : '#dc2626',
                        }}>
                            <StatusMessage msg={lightTestResult} />
                        </div>
                    )}

                    {!hasLightApi && (
                        <div style={{ marginTop: 8, fontSize: 11, color: '#a16207', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="warning" size={12} />
                            <span>Secondary API not configured -- background processing will <b>fall back to the primary API</b> (still works, but uses up your primary API quota)</span>
                        </div>
                    )}
                </div>

                {/* Embedding API */}
                <div style={{ background: '#f8f7ff', borderRadius: 16, padding: 16, border: '1px solid #e9e5ff' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="link" size={14} />
                        <span>Embedding API (OpenAI-compatible format)</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 16, lineHeight: 1.6 }}>
                        Recommend using SiliconFlow -- free quota just for signing up.
                        Pick a model below, then just fill in your API Key.
                        <br/>
                        <span style={{ color: '#a16207', fontWeight: 600 }}>
                            Note: Embedding uses the <code>/embeddings</code> endpoint, which isn't shared with the primary API, so
                            <b>it won't automatically fall back</b>. Without it configured, Memory Palace's vectorization pipeline can't run.
                        </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input
                                type="text"
                                value={embUrl}
                                onChange={e => setEmbUrl(e.target.value)}
                                placeholder="https://api.siliconflow.cn/v1"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>API KEY</label>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                    type="password"
                                    value={embKey}
                                    onChange={e => setEmbKey(e.target.value)}
                                    placeholder="sk-..."
                                    className={inputClass}
                                    style={{ flex: 1 }}
                                />
                                <button onClick={() => window.open('https://cloud.siliconflow.cn/account/ak', '_blank')} style={{
                                    padding: '8px 12px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                    border: '1px solid #e9e5ff', background: 'white', color: '#7c3aed',
                                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                                }}>
                                    Get Key →
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>EMBEDDING MODEL</label>

                            {/* Red-box warning: reminds not to casually switch models once memories exist */}
                            {memoryPalaceConfig.embedding.model && totalCount > 0 && (
                                <div style={{
                                    margin: '0 0 10px 0', padding: '10px 14px', borderRadius: 12,
                                    border: '1.5px solid #fca5a5', background: '#fef2f2',
                                    fontSize: 11, color: '#991b1b', lineHeight: 1.7,
                                }}>
                                    <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 4 }}>
                                        <Icon name="warning" size={12} />
                                        <span>Important:</span>
                                    </span>
                                    Currently <b>{totalCount}</b> memories were generated using the <b>{memoryPalaceConfig.embedding.model.split('/').pop()}</b> model.
                                    Switching models will automatically regenerate all vectors (takes some time and API quota),
                                    <b>recommend not switching again once you've picked one</b>. If unsure, just go with "Recommended".
                                </div>
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                {[
                                    { model: 'BAAI/bge-m3', dim: 1024, tag: 'Recommended', desc: 'Top multilingual model, free', color: '#7c3aed' },
                                    { model: 'Pro/BAAI/bge-m3', dim: 1024, tag: 'Strongest', desc: 'Accelerated inference version, ¥0.7/million tokens', color: '#f59e0b' },
                                ].map(opt => {
                                    const isActive = embModel === opt.model && embDimensions === opt.dim;
                                    return (
                                        <button key={opt.model} onClick={() => {
                                            setEmbModel(opt.model);
                                            setEmbDimensions(opt.dim);
                                            if (!embUrl.trim()) setEmbUrl('https://api.siliconflow.cn/v1');
                                        }} style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '10px 14px', borderRadius: 12, fontSize: 12,
                                            border: isActive ? `2px solid ${opt.color}` : '1px solid #e5e7eb',
                                            background: isActive ? `${opt.color}11` : 'white',
                                            cursor: 'pointer', textAlign: 'left', width: '100%',
                                            transition: 'all 0.15s',
                                        }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: opt.color, whiteSpace: 'nowrap' }}>{opt.tag}</span>
                                            <span style={{ flex: 1 }}>
                                                <span style={{ fontWeight: 600, fontSize: 12, color: '#1f2937' }}>{opt.model.split('/').pop()}</span>
                                                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>{opt.desc}</span>
                                            </span>
                                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{opt.dim}d</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 4, marginBottom: 4 }}>
                                Or type in a model name manually (supports any OpenAI-compatible Embedding endpoint)
                            </div>
                            <input
                                type="text"
                                value={embModel}
                                onChange={e => setEmbModel(e.target.value)}
                                placeholder="BAAI/bge-m3"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>DIMENSIONS</label>
                            <input
                                type="number"
                                value={embDimensions}
                                onChange={e => setEmbDimensions(parseInt(e.target.value) || 1024)}
                                placeholder="1024"
                                className={inputClass}
                            />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                Selecting a preset model fills this in automatically. Recommend 1024 for manual entry; some models support 512 / 768
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={handleSaveEmbeddingConfig}
                        disabled={!embUrl.trim() || !embKey.trim()}
                        style={{
                            width: '100%',
                            marginTop: 16,
                            padding: '12px 0',
                            borderRadius: 16,
                            border: 'none',
                            fontWeight: 700,
                            fontSize: 14,
                            color: 'white',
                            background: (!embUrl.trim() || !embKey.trim()) ? '#cbd5e1' : '#7c3aed',
                            cursor: (!embUrl.trim() || !embKey.trim()) ? 'not-allowed' : 'pointer',
                            transition: 'all 0.15s',
                        }}
                    >
                        {configSaved ? '✓ Saved' : 'Save Config'}
                    </button>

                    {/* Test Embedding connection */}
                    <button
                        onClick={async () => {
                            if (!embUrl.trim() || !embKey.trim()) return;
                            setTestingEmb(true);
                            setTestResult(null);
                            try {
                                const { getEmbedding } = await import('../utils/memoryPalace/embedding');
                                const config = {
                                    baseUrl: embUrl.trim(),
                                    apiKey: embKey.trim(),
                                    model: embModel.trim() || 'BAAI/bge-m3',
                                    dimensions: embDimensions || 1024,
                                };
                                const vec = await getEmbedding('test text', config);
                                setTestResult(`[ok]Success! Returned a ${vec.length}-dimension vector`);
                            } catch (err: any) {
                                setTestResult(`[err]Failed: ${err.message}`);
                            } finally {
                                setTestingEmb(false);
                            }
                        }}
                        disabled={testingEmb || !embUrl.trim() || !embKey.trim()}
                        style={{
                            width: '100%',
                            marginTop: 8,
                            padding: '10px 0',
                            borderRadius: 12,
                            border: '1px solid #7c3aed44',
                            fontWeight: 600,
                            fontSize: 13,
                            color: '#7c3aed',
                            background: 'white',
                            cursor: testingEmb ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {testingEmb ? 'Testing...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>Test Connection</span>
                            </span>
                        )}
                    </button>

                    {testResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: testResult.startsWith('[ok]') ? '#f0fdf4' : '#fef2f2',
                            color: testResult.startsWith('[ok]') ? '#16a34a' : '#dc2626',
                        }}>
                            <StatusMessage msg={testResult} />
                        </div>
                    )}
                </div>

                {/* Rerank API (optional cross-encoder re-ranking) */}
                <details style={{ marginTop: 16, background: '#f0f9ff', borderRadius: 16, padding: 16, border: '1px solid #bae6fd' }}>
                    <summary style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#0369a1', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="target" size={14} />
                            <span>Rerank Model (optional / re-ranking enhancement)</span>
                        </span>
                        {rrEnabled && (
                            <span style={{
                                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                                color: (rrUrl && rrKey) ? '#15803d' : '#92400e',
                                background: (rrUrl && rrKey) ? '#dcfce7' : '#fef3c7',
                            }}>
                                {(rrUrl && rrKey) ? 'Enabled' : 'Pending Config'}
                            </span>
                        )}
                    </summary>

                    <div style={{
                        marginTop: 12, padding: 12, borderRadius: 12,
                        background: '#eff6ff', border: '1px solid #bfdbfe',
                        fontSize: 11, color: '#1e3a8a', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>What does rerank do?</div>
                        Turning it on makes the memories most relevant to what you just said get surfaced more accurately; it's an optional enhancement, and leaving it off doesn't hurt anything.
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                        {/* Enable toggle */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={rrEnabled}
                                onChange={e => setRrEnabled(e.target.checked)}
                                style={{ accentColor: '#0369a1' }}
                            />
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#0369a1' }}>
                                Enable Rerank Channel
                            </span>
                        </label>

                        {/* One-click sync from embedding provider */}
                        <button
                            onClick={() => {
                                setRrUrl(embUrl.trim());
                                setRrKey(embKey.trim());
                            }}
                            disabled={!embUrl.trim() || !embKey.trim()}
                            style={{
                                padding: '8px 12px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                border: '1px solid #bae6fd',
                                background: (!embUrl.trim() || !embKey.trim()) ? '#f1f5f9' : 'white',
                                color: (!embUrl.trim() || !embKey.trim()) ? '#94a3b8' : '#0369a1',
                                cursor: (!embUrl.trim() || !embKey.trim()) ? 'not-allowed' : 'pointer',
                                textAlign: 'left',
                            }}
                            title="Copies the Embedding baseUrl and API Key above directly into rerank (usually reusable if it's the same provider)"
                        >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <Icon name="document" size={13} />
                                <span>One-click sync from Embedding config (baseUrl + API Key)</span>
                            </span>
                        </button>

                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input
                                type="text"
                                value={rrUrl}
                                onChange={e => setRrUrl(e.target.value)}
                                placeholder="https://api.siliconflow.cn/v1"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>API KEY</label>
                            <input
                                type="password"
                                value={rrKey}
                                onChange={e => setRrKey(e.target.value)}
                                placeholder="sk-..."
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>RERANK MODEL</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                {[
                                    { model: 'BAAI/bge-reranker-v2-m3', tag: 'Recommended', desc: 'Multilingual cross-encoder, strong at Chinese, generous free quota', color: '#0369a1' },
                                    { model: 'Pro/BAAI/bge-reranker-v2-m3', tag: 'Pro Version', desc: 'Accelerated inference, lower latency, pay-per-use', color: '#f59e0b' },
                                    { model: 'netease-youdao/bce-reranker-base_v1', tag: 'Free', desc: 'NetEase Youdao BCE, Chinese-specialized', color: '#10b981' },
                                ].map(opt => {
                                    const isActive = rrModel === opt.model;
                                    return (
                                        <button key={opt.model} onClick={() => setRrModel(opt.model)} style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '10px 14px', borderRadius: 12, fontSize: 12,
                                            border: isActive ? `2px solid ${opt.color}` : '1px solid #e5e7eb',
                                            background: isActive ? `${opt.color}11` : 'white',
                                            cursor: 'pointer', textAlign: 'left', width: '100%',
                                        }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: opt.color, whiteSpace: 'nowrap' }}>{opt.tag}</span>
                                            <span style={{ flex: 1 }}>
                                                <span style={{ fontWeight: 600, fontSize: 12, color: '#1f2937' }}>{opt.model.split('/').pop()}</span>
                                                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>{opt.desc}</span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 4, marginBottom: 4 }}>
                                Or type in manually (supports any /rerank endpoint that follows the Cohere/Jina protocol)
                            </div>
                            <input
                                type="text"
                                value={rrModel}
                                onChange={e => setRrModel(e.target.value)}
                                placeholder="BAAI/bge-reranker-v2-m3"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>Extra Recall Count (TOP N)</label>
                            <input
                                type="number"
                                value={rrTopN}
                                onChange={e => setRrTopN(parseInt(e.target.value) || 5)}
                                min={1}
                                max={20}
                                className={inputClass}
                            />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                Appended after the primary 15 memories, after dedup. Default 5, usually 3-10 works well.
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={handleSaveRerankConfig}
                        style={{
                            width: '100%', marginTop: 16, padding: '12px 0',
                            borderRadius: 16, border: 'none', fontWeight: 700, fontSize: 14,
                            color: 'white', background: '#0369a1', cursor: 'pointer',
                        }}
                    >
                        {rrSaved ? '✓ Saved' : 'Save Rerank Config'}
                    </button>

                    {/* Test rerank connection */}
                    <button
                        onClick={async () => {
                            if (!rrUrl.trim() || !rrKey.trim()) return;
                            setRrTesting(true);
                            setRrTestResult(null);
                            try {
                                const { rerankDocuments } = await import('../utils/memoryPalace/rerank');
                                const results = await rerankDocuments(
                                    { baseUrl: rrUrl.trim(), apiKey: rrKey.trim(), model: rrModel.trim() || 'BAAI/bge-reranker-v2-m3' },
                                    'Test question: how is grandpa doing health-wise',
                                    ['Grandpa went to the hospital a few days ago for a heart checkup, results were normal', 'It rained today, traffic was a bit jammed', 'Her favorite dish is the braised pork her mom makes'],
                                    3,
                                );
                                if (results.length > 0) {
                                    setRrTestResult(`[ok]Success! Returned ${results.length} results, top1 index=${results[0].index} score=${results[0].relevance_score.toFixed(3)}`);
                                } else {
                                    setRrTestResult(`[warn]API connected but returned an empty array, check whether the model name is correct`);
                                }
                            } catch (err: any) {
                                setRrTestResult(`[err]Failed: ${err.message}`);
                            } finally {
                                setRrTesting(false);
                            }
                        }}
                        disabled={rrTesting || !rrUrl.trim() || !rrKey.trim()}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0',
                            borderRadius: 12, border: '1px solid #0369a144',
                            fontWeight: 600, fontSize: 13, color: '#0369a1',
                            background: 'white',
                            cursor: rrTesting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {rrTesting ? 'Testing...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>Test Rerank Connection</span>
                            </span>
                        )}
                    </button>

                    {rrTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: rrTestResult.startsWith('[ok]') ? '#f0fdf4' : rrTestResult.startsWith('[warn]') ? '#fffbeb' : '#fef2f2',
                            color: rrTestResult.startsWith('[ok]') ? '#16a34a' : rrTestResult.startsWith('[warn]') ? '#92400e' : '#dc2626',
                        }}>
                            <StatusMessage msg={rrTestResult} />
                        </div>
                    )}
                </details>

                {/* Remote vector storage (Supabase, optional) -- collapsed by default */}
                <details style={{ marginTop: 16, background: '#faf5ff', borderRadius: 16, padding: 16, border: '1px solid #e9d5ff' }}>
                    <summary style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="cloud" size={14} />
                            <span>Remote Vector Storage (optional / Supabase)</span>
                        </span>
                        {remoteVectorConfig.enabled && (
                            <span style={{
                                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                                color: remoteVectorConfig.initialized ? '#15803d' : '#92400e',
                                background: remoteVectorConfig.initialized ? '#dcfce7' : '#fef3c7',
                            }}>
                                {remoteVectorConfig.initialized ? 'Connected' : 'Pending Init'}
                            </span>
                        )}
                    </summary>

                    {/* When to consider using this */}
                    <div style={{
                        marginTop: 12, padding: 12, borderRadius: 12,
                        background: '#fffbeb', border: '1px solid #fde68a',
                        fontSize: 11, color: '#78350f', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>When should you bother with this?</div>
                        When you notice <b>vector search getting sluggish</b> (usually only noticeable above 20-30k memories).
                        Local handles anything under 10k just fine, <b>no need to bother with this</b>.
                        <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                            <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="warning" size={12} /></span>
                            <div>
                                <b>Turning on remote storage does not mean your data is now bulletproof.</b>
                                It's currently double-write mode (a copy is still kept locally, not moved to the cloud),
                                and Supabase's free tier doesn't guarantee it'll be around forever either.
                                <b>You should still export backups</b> -- don't assume turning this on means you can stop worrying.
                            </div>
                        </div>
                    </div>

                    {/* Illustrated tutorial */}
                    <a href="https://www.kdocs.cn/l/ctifnJA5VGA3" target="_blank" rel="noopener noreferrer"
                        style={{
                            display: 'block', marginTop: 10, padding: '10px 12px', borderRadius: 12,
                            background: 'white', border: '1px dashed #c4b5fd', color: '#7c3aed',
                            fontSize: 11, fontWeight: 600, textDecoration: 'none', textAlign: 'center',
                        }}
                    >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="book" size={13} />
                            <span>View the detailed illustrated tutorial (Kingsoft Docs) →</span>
                        </span>
                    </a>

                    {/* 3-step setup guide */}
                    <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: '#f5f3ff', fontSize: 11, color: '#5b21b6', lineHeight: 1.8 }}>
                        <b>3 steps to set up:</b><br/>
                        1. Sign up for Supabase (one-click GitHub login, see the tutorial above)<br/>
                        2. Run the init SQL below in the Supabase SQL Editor<br/>
                        3. Fill in the Project URL and anon key, then tap Test Connection
                        <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer"
                            style={{
                                marginTop: 8, display: 'inline-block', padding: '6px 12px', borderRadius: 8,
                                background: '#7c3aed', color: 'white', fontSize: 11, fontWeight: 700, textDecoration: 'none',
                            }}>
                            Go to Supabase →
                        </a>
                    </div>

                    {/* Init SQL */}
                    <div style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Init SQL</span>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button onClick={() => setShowInitSQL(!showInitSQL)} style={{
                                    fontSize: 10, color: '#7c3aed', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer',
                                }}>
                                    {showInitSQL ? 'Hide' : 'View'}
                                </button>
                                <button onClick={handleCopyInitSQL} style={{
                                    fontSize: 10, color: 'white', fontWeight: 700, background: '#7c3aed',
                                    border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
                                }}>
                                    Copy
                                </button>
                            </div>
                        </div>
                        {showInitSQL && (
                            <pre style={{
                                background: '#0f172a', color: '#86efac', fontSize: 9, padding: 12, borderRadius: 10,
                                overflow: 'auto', maxHeight: 200, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                            }}>{`create extension if not exists vector;
create table if not exists memory_vectors (
  memory_id text primary key, char_id text not null,
  content text not null default '', vector vector(1024),
  dimensions int default 1024, model text, room text,
  importance int default 5, tags text[] default '{}',
  mood text default '',
  created_at bigint default (extract(epoch from now()) * 1000)::bigint,
  last_accessed_at bigint default 0,
  access_count int default 0
);
-- Click the "Copy" button to get the full SQL`}</pre>
                        )}
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>Copy this SQL → Supabase Dashboard → SQL Editor → Run</div>
                    </div>

                    {/* Project URL & anon key */}
                    <div style={{ marginTop: 12 }}>
                        <label className={labelClass}>PROJECT URL</label>
                        <input type="url" value={rvUrl} onChange={e => setRvUrl(e.target.value)}
                            placeholder="https://xxxxx.supabase.co" className={inputClass} />
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, paddingLeft: 4 }}>Settings → API → Project URL</div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <label className={labelClass}>ANON / PUBLIC KEY</label>
                        <input type="password" value={rvKey} onChange={e => setRvKey(e.target.value)}
                            placeholder="eyJhbGciOiJIUzI1NiIs..." className={inputClass} />
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, paddingLeft: 4 }}>Settings → API → anon public key</div>
                    </div>

                    {/* Test + Save */}
                    <button onClick={handleTestRemoteVector} disabled={rvTesting || !rvUrl || !rvKey}
                        style={{
                            width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 12,
                            border: '1px solid #e5e7eb', fontWeight: 600, fontSize: 12,
                            color: '#475569', background: 'white',
                            cursor: (rvTesting || !rvUrl || !rvKey) ? 'not-allowed' : 'pointer',
                            opacity: (rvTesting || !rvUrl || !rvKey) ? 0.5 : 1,
                        }}
                    >
                        {rvTesting ? 'Testing...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>Test Connection</span>
                            </span>
                        )}
                    </button>
                    {rvTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 11, textAlign: 'center', fontWeight: 600,
                            color: rvTestResult.startsWith('[ok]') ? '#16a34a' : rvTestResult.startsWith('[warn]') ? '#d97706' : '#dc2626',
                        }}>
                            <StatusMessage msg={rvTestResult} />
                        </div>
                    )}
                    <button onClick={handleSaveRemoteVector} disabled={!rvUrl || !rvKey}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                            background: (!rvUrl || !rvKey) ? '#cbd5e1' : '#7c3aed',
                            cursor: (!rvUrl || !rvKey) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        Save Config
                    </button>

                    {/* Actions after enabling */}
                    {remoteVectorConfig.enabled && remoteVectorConfig.initialized && (
                        <button onClick={handleSyncToRemote} disabled={rvSyncing}
                            style={{
                                width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                                border: '1px solid #e9d5ff', fontWeight: 600, fontSize: 12,
                                color: '#7c3aed', background: 'white',
                                cursor: rvSyncing ? 'not-allowed' : 'pointer',
                                opacity: rvSyncing ? 0.5 : 1,
                            }}
                        >
                            {rvSyncing ? 'Syncing...' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="refresh" size={13} />
                                    <span>Sync Local Vectors to Remote</span>
                                </span>
                            )}
                        </button>
                    )}
                    {remoteVectorConfig.enabled && (
                        <button onClick={handleDisableRemoteVector}
                            style={{
                                width: '100%', marginTop: 8, padding: '8px 0',
                                border: 'none', background: 'none',
                                fontSize: 11, color: '#ef4444', fontWeight: 600, cursor: 'pointer',
                            }}
                        >
                            Disable Remote Storage
                        </button>
                    )}
                </details>
                </>)}

                {/* Personality style & rumination tendency: auto-inferred by the LLM, collapsed by default */}
                {!isGlobal && (<>
                <details style={{ marginTop: 16 }}>
                    <summary style={{ fontSize: 10, color: '#c4c4c4', cursor: 'pointer', userSelect: 'none' }}>
                        Cognitive Parameters
                    </summary>
                    <div style={{ marginTop: 8, background: '#f9fafb', borderRadius: 12, padding: 14, border: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                            <label className={labelClass}>Cognitive Style</label>
                            <select
                                value={(char as any).personalityStyle || ''}
                                onChange={e => updateCharacter(char.id, { personalityStyle: e.target.value } as any)}
                                className={inputClass}
                                style={{ fontFamily: 'inherit', fontSize: 12 }}
                            >
                                {/* When not yet evaluated, show that honestly instead of pretending it's "Emotional" (retrieval runs with the Emotional default) */}
                                {!(char as any).personalityStyle && (
                                    <option value="" disabled>Not evaluated (defaults to Emotional)</option>
                                )}
                                <option value="emotional">Emotional</option>
                                <option value="narrative">Narrative</option>
                                <option value="imagery">Imagery</option>
                                <option value="analytical">Analytical</option>
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>
                                Rumination Tendency {(char as any).ruminationTendency == null
                                    ? 'Not evaluated (default 0.3)'
                                    : ((char as any).ruminationTendency).toFixed(1)}
                            </label>
                            <input
                                type="range" min="0" max="1" step="0.1"
                                value={(char as any).ruminationTendency ?? 0.3}
                                onChange={e => updateCharacter(char.id, { ruminationTendency: parseFloat(e.target.value) } as any)}
                                style={{ width: '100%' }}
                            />
                        </div>
                        <button
                            onClick={manualDetectPersonality}
                            disabled={detectingPersonality}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 10,
                                border: '1px solid #ddd6fe', background: '#f5f3ff',
                                fontSize: 12, fontWeight: 700, color: '#7c3aed',
                                cursor: detectingPersonality ? 'wait' : 'pointer',
                                opacity: detectingPersonality ? 0.6 : 1,
                            }}
                        >
                            {detectingPersonality ? 'Evaluating...' : 'AI Evaluate Cognitive Parameters'}
                        </button>
                        <div style={{ fontSize: 10, color: '#b0b0b0', lineHeight: 1.5 }}>
                            Cognitive style affects memory-association preference; rumination tendency affects the odds of recalling old things.
                            You can adjust manually, or have the AI evaluate based on the persona (the result takes effect only after you confirm it).
                        </div>
                    </div>
                </details>

                <details style={{ marginTop: 12 }}>
                    <summary style={{ fontSize: 10, color: '#0f766e', cursor: 'pointer', userSelect: 'none' }}>
                        ChatApp Conversational Pacing
                    </summary>
                    <div style={{ marginTop: 8, background: '#f0fdfa', borderRadius: 12, padding: 14, border: '1px solid #99f6e4' }}>
                        <div style={{ fontSize: 11, color: '#115e59', lineHeight: 1.65, marginBottom: 12 }}>
                            Sets how much this character is willing to follow the user's current conversational pace. 0% means fully staying themselves on that dimension; even at 100% it only adapts within a safe range and never rewrites the character's personality.
                        </div>
                        {([
                            ['length', 'Reply Length'],
                            ['rhythm', 'Back-and-forth Rhythm'],
                            ['energy', 'Emotional Energy'],
                            ['punctuation', 'Punctuation Intensity'],
                            ['emoji', 'Emoji Usage'],
                        ] as Array<[keyof CharacterAccommodationPolicy, string]>).map(([key, label]) => {
                            const value = char.interactionAccommodation?.[key]
                                ?? DEFAULT_CHARACTER_ACCOMMODATION[key];
                            return (
                                <div key={key} style={{ marginBottom: key === 'emoji' ? 0 : 10 }}>
                                    <label className={labelClass} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span>{label}</span>
                                        <span style={{ color: '#0f766e' }}>{Math.round(value * 100)}%</span>
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={value}
                                        onChange={event => updateAccommodation(key, parseFloat(event.target.value))}
                                        style={{ width: '100%', accentColor: '#0f766e' }}
                                    />
                                </div>
                            );
                        })}
                        <button
                            onClick={() => updateCharacter(char.id, { interactionAccommodation: { ...DEFAULT_CHARACTER_ACCOMMODATION } })}
                            style={{
                                width: '100%', marginTop: 12, padding: '8px 0', borderRadius: 9,
                                border: '1px solid #99f6e4', background: '#ffffff',
                                fontSize: 11, fontWeight: 700, color: '#0f766e', cursor: 'pointer',
                            }}
                        >
                            Restore Gentle Defaults
                        </button>
                        <div style={{ fontSize: 10, color: '#0f766e', lineHeight: 1.55, marginTop: 10 }}>
                            This only affects ChatApp replies. Character replies are never used to reverse-train these values, and the writing persona in other apps stays unchanged.
                        </div>
                    </div>
                </details>

                {/* Manual summarization & vectorization (fallback mechanism): select a chat range for a one-off summarization pass, doesn't touch the waterline */}
                <div style={{ marginTop: 16, background: '#f5f3ff', borderRadius: 16, padding: 16, border: '1px solid #ddd6fe' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#5b21b6', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="book" size={14} />
                        <span>Manual Summarization &amp; Vectorization</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        Browse your chat history and select a range of dialogue (tap your own <b>start</b> and <b>end</b> points, fuzzy search supported), and run a one-off summarization + vectorization pass on it.
                        This is a <b>fallback for when repeated summarization keeps failing or you're not sure vectorization actually went through</b> --
                        it <b>never touches the waterline</b> and doesn't interfere with Full-Auto Memory; re-summarizing the same range won't create duplicate memories either (dedup is on).
                    </div>

                    {rangeResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: rangeResult.startsWith('[ok]') ? '#16a34a' : rangeResult.startsWith('[warn]') ? '#d97706' : '#dc2626' }}>
                            <StatusMessage msg={rangeResult} />
                        </div>
                    )}

                    <button
                        onClick={openRangeModal}
                        disabled={!hasEmbeddingConfig}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: !hasEmbeddingConfig ? '#cbd5e1' : '#7c3aed',
                            cursor: !hasEmbeddingConfig ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {!hasEmbeddingConfig ? 'Please configure the Embedding API first' : 'Select a Chat Range to Summarize'}
                    </button>
                </div>

                {/* Manual summarization: range-selection modal (browse chat history -> tap start/end points -> summarize) */}
                {rangeModalOpen && char && (() => {
                    const bothSet = rangeStartId != null && rangeEndId != null;
                    const hasEndpoint = rangeStartId != null || rangeEndId != null;
                    const lo = bothSet ? Math.min(rangeStartId!, rangeEndId!) : null;
                    const hi = bothSet ? Math.max(rangeStartId!, rangeEndId!) : null;
                    const selectedCount = (lo != null && hi != null)
                        ? rangeMessages.filter(m => m.id >= lo && m.id <= hi).length
                        : (hasEndpoint ? 1 : 0);

                    // Pagination: RANGE_PAGE_SIZE per page, avoids rendering hundreds of DOM nodes at once
                    const totalPages = Math.max(1, Math.ceil(filteredRangeMessages.length / RANGE_PAGE_SIZE));
                    const page = Math.min(Math.max(0, rangePage), totalPages - 1);
                    const pageStart = page * RANGE_PAGE_SIZE;
                    const shown = filteredRangeMessages.slice(pageStart, pageStart + RANGE_PAGE_SIZE);

                    return (
                        <div
                            style={{
                                position: 'fixed', inset: 0, zIndex: 210,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: 12,
                                background: 'rgba(31,17,71,0.45)',
                                animation: 'fade-in 0.2s ease-out',
                            }}
                            onClick={() => { if (!rangeRunning) setRangeModalOpen(false); }}
                        >
                            <div
                                onClick={e => e.stopPropagation()}
                                style={{
                                    width: '100%', maxWidth: 420, height: 'min(82dvh, 720px)', maxHeight: 'calc(100dvh - 24px)',
                                    minHeight: 0,
                                    display: 'flex', flexDirection: 'column',
                                    borderRadius: 24, overflow: 'hidden',
                                    background: '#ffffff',
                                    boxShadow: '0 25px 60px -15px rgba(124,58,237,0.4), 0 10px 30px rgba(0,0,0,0.15)',
                                    border: '1px solid rgba(167,139,250,0.25)',
                                }}
                            >
                                {/* Header */}
                                <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #f1f5f9' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <div style={{ fontSize: 15, fontWeight: 800, color: '#1f1147' }}>Manual Summarization &amp; Vectorization</div>
                                        <button
                                            onClick={() => { if (!rangeRunning) setRangeModalOpen(false); }}
                                            style={{ border: 'none', background: 'transparent', cursor: rangeRunning ? 'not-allowed' : 'pointer', color: '#94a3b8', padding: 4 }}
                                        >
                                            <Icon name="x" size={18} />
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#7c3aed' }}>{char.name} · Tap a message, then choose "Set as start / end"</div>

                                    {/* Fuzzy search */}
                                    <div style={{ marginTop: 10, position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }}>
                                            <Icon name="search" size={14} />
                                        </span>
                                        <input
                                            value={rangeQuery}
                                            onChange={e => { setRangeQuery(e.target.value); setRangePage(0); }}
                                            placeholder="Fuzzy search content or date (e.g. birthday / 2026-03)"
                                            style={{
                                                width: '100%', padding: '8px 10px 8px 30px', borderRadius: 10,
                                                border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', boxSizing: 'border-box',
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* Message list */}
                                <div style={{
                                    flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px',
                                    WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y',
                                }}>
                                    {rangeLoading && (
                                        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 24 }}>Loading chat history...</div>
                                    )}
                                    {!rangeLoading && shown.length === 0 && (
                                        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 24 }}>
                                            {rangeMessages.length === 0 ? 'This character has no chat history yet' : 'No matching messages'}
                                        </div>
                                    )}
                                    {!rangeLoading && filteredRangeMessages.length > RANGE_PAGE_SIZE && (
                                        <div style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                            gap: 8, padding: '6px 8px', marginBottom: 6,
                                            background: '#faf5ff', borderRadius: 8,
                                        }}>
                                            <button
                                                onClick={() => setRangePage(p => Math.max(0, p - 1))}
                                                disabled={page <= 0}
                                                style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: '1px solid #ddd6fe', background: page <= 0 ? '#f1f5f9' : '#fff', color: page <= 0 ? '#cbd5e1' : '#7c3aed', cursor: page <= 0 ? 'not-allowed' : 'pointer' }}
                                            >
                                                ‹ Earlier
                                            </button>
                                            <span style={{ fontSize: 10, color: '#7c3aed', fontWeight: 600 }}>
                                                Page {page + 1} / {totalPages} · {filteredRangeMessages.length} total
                                            </span>
                                            <button
                                                onClick={() => setRangePage(p => Math.min(totalPages - 1, p + 1))}
                                                disabled={page >= totalPages - 1}
                                                style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: '1px solid #ddd6fe', background: page >= totalPages - 1 ? '#f1f5f9' : '#fff', color: page >= totalPages - 1 ? '#cbd5e1' : '#7c3aed', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
                                            >
                                                Later ›
                                            </button>
                                        </div>
                                    )}
                                    {!rangeLoading && shown.map(m => {
                                        const isStart = m.id === rangeStartId;
                                        const isEnd = m.id === rangeEndId;
                                        const endpointLabel = getRangeEndpointLabel(m.id, rangeStartId, rangeEndId);
                                        const isPending = m.id === rangePendingId;
                                        const inRange = lo != null && hi != null && m.id >= lo && m.id <= hi;
                                        const isEndpoint = !!endpointLabel;
                                        const who = m.role === 'user' ? 'Me' : m.role === 'system' ? 'System' : char.name;
                                        const isDate = (m.metadata as any)?.source === 'date';
                                        const preview = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
                                        return (
                                            <div
                                                key={m.id}
                                                onClick={() => { if (!rangeRunning) onTapRangeMessage(m.id); }}
                                                style={{
                                                    padding: '8px 10px', marginBottom: 4, borderRadius: 10, cursor: rangeRunning ? 'default' : 'pointer',
                                                    background: isEndpoint ? '#ede9fe' : isPending ? '#faf5ff' : inRange ? '#f5f3ff' : '#fff',
                                                    border: isPending ? '1.5px solid #c4b5fd' : isEndpoint ? '1.5px solid #7c3aed' : inRange ? '1px solid #ddd6fe' : '1px solid #f1f5f9',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                                    <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                                        {isDate && (
                                                            <span style={{ fontSize: 9, fontWeight: 700, color: '#db2777', background: '#fce7f3', borderRadius: 5, padding: '0 5px' }}>Date</span>
                                                        )}
                                                        {who} · {fmtRangeTs(m.timestamp)}
                                                    </span>
                                                    {(isStart || isEnd) && (
                                                        <span style={{ fontSize: 9, fontWeight: 800, color: '#fff', background: '#7c3aed', borderRadius: 6, padding: '1px 6px' }}>
                                                            {endpointLabel}
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: 12, color: '#334155', marginTop: 2, lineHeight: 1.4 }}>
                                                    {preview || '(no text content)'}
                                                </div>

                                                {/* Pending-confirmation menu: only appears after tapping this one, avoids accidentally changing start/end */}
                                                {isPending && (
                                                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={e => e.stopPropagation()}>
                                                        <button
                                                            onClick={() => confirmRangeEndpoint(m.id, 'start')}
                                                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid #7c3aed', background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                        >
                                                            Set as start
                                                        </button>
                                                        <button
                                                            onClick={() => confirmRangeEndpoint(m.id, 'end')}
                                                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                        >
                                                            Set as end
                                                        </button>
                                                        <button
                                                            onClick={() => setRangePendingId(null)}
                                                            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Bottom actions */}
                                <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 14px 14px' }}>
                                    {rangeRunning && rangeProgress && (
                                        <div style={{ fontSize: 11, color: '#7c3aed', marginBottom: 8, textAlign: 'center' }}>{rangeProgress}</div>
                                    )}
                                    {!rangeRunning && rangeResult && (
                                        <div style={{ fontSize: 12, marginBottom: 8, color: rangeResult.startsWith('[ok]') ? '#16a34a' : rangeResult.startsWith('[warn]') ? '#d97706' : '#dc2626' }}>
                                            <StatusMessage msg={rangeResult} />
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                        <span style={{ fontSize: 11, color: '#64748b' }}>
                                            {getRangeSelectionHint(rangeStartId, rangeEndId, selectedCount)}
                                        </span>
                                        <button
                                            onClick={() => { setRangeStartId(null); setRangeEndId(null); }}
                                            disabled={rangeRunning || !hasEndpoint}
                                            style={{
                                                fontSize: 11, fontWeight: 600, color: (rangeRunning || !hasEndpoint) ? '#cbd5e1' : '#dc2626',
                                                background: 'transparent', border: 'none',
                                                cursor: (rangeRunning || !hasEndpoint) ? 'not-allowed' : 'pointer',
                                            }}
                                        >
                                            Clear Selection
                                        </button>
                                    </div>
                                    <button
                                        onClick={runRangeSummary}
                                        disabled={rangeRunning || !bothSet}
                                        style={{
                                            width: '100%', padding: '11px 0', borderRadius: 12,
                                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                                            background: (rangeRunning || !bothSet) ? '#cbd5e1' : '#7c3aed',
                                            cursor: (rangeRunning || !bothSet) ? 'not-allowed' : 'pointer',
                                        }}
                                    >
                                        {rangeRunning ? 'Summarizing... please keep the app open' : 'Start Summarizing + Vectorizing'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Manual summarization: completion result modal (lists new memories one by one, consistent with waterline summarization) */}
                {rangeResultData && (
                    <div
                        style={{
                            position: 'fixed', inset: 0, zIndex: 220,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
                            background: 'rgba(15,23,42,0.55)',
                            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                            animation: 'fade-in 0.2s ease-out',
                        }}
                        onClick={() => setRangeResultData(null)}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 380, maxHeight: '82vh',
                                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                                background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                                borderRadius: 28, border: '1px solid rgba(148,163,184,0.18)',
                                boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                            }}
                        >
                            <div style={{ padding: '26px 24px 14px', textAlign: 'center' }}>
                                <div style={{
                                    width: 54, height: 54, margin: '0 auto 12px', borderRadius: 18,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'linear-gradient(135deg, rgba(124,58,237,0.14), rgba(167,139,250,0.06))',
                                    border: '1px solid rgba(124,58,237,0.15)', fontSize: 26,
                                }}>🗂️</div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.25em', textTransform: 'uppercase', color: '#7c3aed' }}>Manual Summary</div>
                                <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>Manual Summary Complete</div>
                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                                    Added {rangeResultData.stored} · skipped {rangeResultData.skipped} as duplicates
                                    {rangeResultData.batches.length > 1 && ` · ${rangeResultData.batches.length} batches`}
                                    {' · '}processed {rangeResultData.processedMessages} messages
                                </div>
                                <div style={{ fontSize: 10, color: '#16a34a', marginTop: 2 }}>Waterline unchanged, doesn't interfere with Full-Auto Memory</div>
                                {rangeResultData.batches.some(b => !b.ok) && (
                                    <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>
                                        {rangeResultData.batches.filter(b => !b.ok).map(b => `batch ${b.index} failed`).join(', ')}
                                    </div>
                                )}
                            </div>

                            <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {rangeResultData.memories.map((m, i) => {
                                    const roomMeta: Record<string, { label: string; color: string }> = {
                                        living_room: { label: 'Living Room', color: '#f59e0b' },
                                        bedroom: { label: 'Bedroom', color: '#8b5cf6' },
                                        study: { label: 'Study', color: '#0ea5e9' },
                                        user_room: { label: "User's Room", color: '#ec4899' },
                                        self_room: { label: 'Self Room', color: '#10b981' },
                                        attic: { label: 'Attic', color: '#6366f1' },
                                        windowsill: { label: 'Windowsill', color: '#14b8a6' },
                                    };
                                    const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                    const roomLabel = getRoomLabel(m.room as any, userProfile?.name) || meta.label;
                                    return (
                                        <div key={i} style={{
                                            padding: 12, borderRadius: 16,
                                            background: 'rgba(255,255,255,0.75)', border: `1px solid ${meta.color}22`,
                                            boxShadow: `0 2px 8px ${meta.color}14`,
                                        }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                                <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: `${meta.color}18`, color: meta.color }}>{roomLabel}</span>
                                                <span style={{ fontSize: 10, color: '#94a3b8' }}>{m.mood}</span>
                                                <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 'auto', color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.6 }}>{m.content}</div>
                                            {m.tags.length > 0 && (
                                                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                                                    {m.tags.map((t, j) => (
                                                        <span key={j} style={{ fontSize: 9, padding: '1px 6px', borderRadius: 999, background: 'rgba(148,163,184,0.15)', color: '#64748b' }}>{t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {rangeResultData.memories.length === 0 && (
                                    <div style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', padding: 16 }}>
                                        No new memories were extracted this time{rangeResultData.skipped > 0 ? ' (memories from this conversation already existed)' : ''}
                                    </div>
                                )}
                            </div>

                            <div style={{ padding: '8px 24px 22px' }}>
                                <button
                                    onClick={() => setRangeResultData(null)}
                                    style={{
                                        width: '100%', padding: '12px 0', borderRadius: 14, border: 'none',
                                        color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                                        boxShadow: '0 6px 18px -6px rgba(124,58,237,0.5)',
                                    }}
                                >
                                    Confirm
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Chat history vectorization */}
                {/* Migrate old memories */}
                <div style={{ marginTop: 16, background: '#fefce8', borderRadius: 16, padding: 16, border: '1px solid #fde68a' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="download" size={14} />
                        <span>Import Old Memories</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#78716c', marginBottom: 12, lineHeight: 1.6 }}>
                        Sends the old daily memories ({char.memories?.length || 0} entries) to the LLM month by month,
                        re-extracting them as memory nodes from {char.name}'s first-person perspective. You can pick specific months, or leave it unselected to import everything. Old data isn't deleted.
                    </div>

                    {/* Cost notice: dumping old memories into the LLM all at once is a one-time high-consumption operation, reminds the user to avoid accidentally burning an expensive API */}
                    <div style={{
                        marginBottom: 12, padding: 10, borderRadius: 10,
                        border: '1px solid #fca5a5', background: '#fef2f2',
                        fontSize: 11, color: '#991b1b', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="money" size={12} />
                            <span>Cost Notice (please read before running)</span>
                        </div>
                        <div>
                            <b>1.</b> Each chunk (e.g. "early January") calls the secondary API 1-2 times -&gt; <b>up to 3-12 times per month</b>. Strongly recommend using a <b>cheap pay-per-call API</b>, don't burn a premium subscription model on this.
                        </div>
                        <div>
                            <b>2.</b> This uses the <b>secondary API configured on this page</b> (not the main chat API) -- confirm which model you've set before running.
                        </div>
                        <div>
                            <b>3.</b> Recommend <b>checking just one chunk and running it once first</b>, then deciding whether to import everything after seeing the bill.
                        </div>
                        <div>
                            <b>4.</b> This <b>converts historical memories into palace nodes all at once</b>, so the cost can look a bit scary. Everyday chat's auto-archiving doesn't work this way.
                        </div>
                    </div>

                    {/* Chunk selector (each month split into early/mid/late) */}
                    {availableChunks.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 6 }}>
                                Select chunks (none selected = all) · each month is split into early/mid/late, pick individually to avoid re-running
                            </div>
                            {availableMonths.map(month => {
                                const monthChunks = availableChunks.filter(c => c.key.startsWith(month));
                                if (monthChunks.length === 0) return null;
                                return (
                                    <div key={month} style={{ marginBottom: 6 }}>
                                        <div style={{ fontSize: 10, color: '#78716c', marginBottom: 3, fontWeight: 600 }}>{month}</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                            {monthChunks.map(chunk => (
                                                <button
                                                    key={chunk.key}
                                                    onClick={() => {
                                                        setSelectedMonths(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(chunk.key)) next.delete(chunk.key);
                                                            else next.add(chunk.key);
                                                            return next;
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                                                        border: selectedMonths.has(chunk.key) ? '2px solid #f59e0b' : '1px solid #d4d4d4',
                                                        background: selectedMonths.has(chunk.key) ? '#fef3c7' : 'white',
                                                        color: selectedMonths.has(chunk.key) ? '#92400e' : '#6b7280',
                                                        cursor: 'pointer',
                                                    }}
                                                >
                                                    {chunk.key.replace(month + ' ', '')} ({chunk.count})
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                            {selectedMonths.size > 0 && (
                                <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>
                                    Selected {selectedMonths.size} chunks
                                    <span
                                        onClick={() => setSelectedMonths(new Set())}
                                        style={{ marginLeft: 8, color: '#dc2626', cursor: 'pointer', textDecoration: 'underline' }}
                                    >
                                        Clear Selection
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {migrationProgress && (
                        <div style={{ fontSize: 11, color: '#92400e', marginBottom: 8 }}>
                            {migrationProgress.phase === 'grouping' && `Grouping by month...`}
                            {migrationProgress.phase === 'extracting' && `LLM extracting... ${migrationProgress.currentMonth || ''} (${migrationProgress.current}/${migrationProgress.total} chunks)`}
                            {migrationProgress.phase === 'vectorizing' && `Embedding vectorizing... ${migrationProgress.current}/${migrationProgress.total}`}
                            {migrationProgress.phase === 'linking' && `Building memory links...`}
                            {migrationProgress.phase === 'done' && `Done`}
                        </div>
                    )}

                    {migrationResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: migrationResult.startsWith('[ok]') ? '#16a34a' : '#dc2626' }}>
                            <StatusMessage msg={migrationResult} />
                        </div>
                    )}

                    <button
                        onClick={handleMigrate}
                        disabled={migrating || !hasEmbeddingConfig}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: migrating ? '#d4d4d4' : !hasEmbeddingConfig ? '#cbd5e1' : '#f59e0b',
                            cursor: migrating || !hasEmbeddingConfig ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {migrating ? 'Migrating...' : !hasEmbeddingConfig ? 'Please configure the Embedding API first' : selectedMonths.size > 0 ? `Start Migration (${selectedMonths.size} chunks)` : 'Start Migration (All)'}
                    </button>

                    <button
                        onClick={() => {
                            if (confirm('Really clear all migrated data? (memories, vectors, and links whose boxId starts with migrated_)')) {
                                handleClearMigrated();
                            }
                        }}
                        disabled={deleting}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #fecaca',
                            fontSize: 12, fontWeight: 600,
                            color: '#dc2626', background: 'white',
                            cursor: deleting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {deleting ? 'Clearing...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="trash" size={13} />
                                <span>Clear Migrated Data</span>
                            </span>
                        )}
                    </button>
                </div>

                {/* Cognitive digestion (manual trigger/test) */}
                <div style={{ marginTop: 16, background: '#f0fdf4', borderRadius: 16, padding: 16, border: '1px solid #bbf7d0' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <RoomIcon room="attic" size={14} style={{ color: ROOM_COLORS.attic }} />
                        <span>Cognitive Digestion</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        The character quietly reflects on recent things: has the confusion in the attic been resolved? Have the anticipations on the windowsill come true?
                        Has repeatedly-learned material become internalized as part of their personality? Auto-triggers every 50 chat turns, and can also be triggered manually anytime.
                        The distilled takeaways (user cognition / knowledge internalization / self-insight) settle onto the room plates, no new memory entries are added.
                    </div>

                    {digestResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: digestResult.startsWith('[ok]') ? '#16a34a' : digestResult.startsWith('[err]') ? '#dc2626' : '#6b7280' }}>
                            <StatusMessage msg={digestResult} />
                        </div>
                    )}

                    <button
                        onClick={handleDigest}
                        disabled={digesting}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: digesting ? '#d4d4d4' : '#16a34a',
                            cursor: digesting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {digesting ? `${char.name} is quietly reflecting...` : 'Manually Trigger Digestion'}
                    </button>

                    {/* Room-plate history backfill: existing users' backlog shouldn't go to waste -- scans all history in batches to put up plates */}
                    {bootstrapStatus && (
                        <div style={{ fontSize: 12, marginTop: 8, color: bootstrapStatus.startsWith('[ok]') ? '#7c3aed' : bootstrapStatus.startsWith('[err]') ? '#dc2626' : '#6b7280' }}>
                            <StatusMessage msg={bootstrapStatus} />
                        </div>
                    )}
                    <button
                        onClick={handleBootstrapPlates}
                        disabled={bootstrapping}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #ddd6fe',
                            fontSize: 12, fontWeight: 600,
                            color: '#7c3aed', background: 'white',
                            cursor: bootstrapping ? 'not-allowed' : 'pointer',
                            opacity: bootstrapping ? 0.6 : 1,
                        }}
                    >
                        {bootstrapping ? 'Organizing...' : 'Organize Historical Memories to Plates (a small chunk each time, can be split across multiple runs)'}
                    </button>

                    {/* Digestion log: exactly what each digestion pass reviewed, changed, and submitted to the plates */}
                    <button
                        onClick={async () => {
                            if (!char || digestReports !== null) { setDigestReports(null); return; }
                            try {
                                setDigestReports(await DigestReportDB.getByCharId(char.id));
                            } catch { setDigestReports([]); }
                        }}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #bbf7d0',
                            fontSize: 12, fontWeight: 600,
                            color: '#166534', background: 'white', cursor: 'pointer',
                        }}
                    >
                        {digestReports === null ? 'View Digestion Log' : 'Hide Digestion Log'}
                    </button>

                    {digestReports !== null && (
                        <div style={{ marginTop: 10 }}>
                            {digestReports.length === 0 && (
                                <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', padding: '12px 0' }}>
                                    No digestion records yet -- once you trigger a digestion, what it did will show up here
                                </div>
                            )}
                            {digestReports.map(report => {
                                const expanded = expandedReportId === report.id;
                                const outcomeCount = report.outcomes.reduce((s, sec) => s + sec.items.length, 0);
                                const submitCount = report.plateSubmissions.reduce((s, sec) => s + sec.items.length, 0);
                                const examinedCount = report.examined.reduce((s, sec) => s + sec.items.length, 0);
                                const renderSection = (sec: { label: string; items: string[] }, color: string) => (
                                    <div key={sec.label} style={{ marginTop: 6 }}>
                                        <div style={{ fontSize: 10, fontWeight: 700, color }}>{sec.label}</div>
                                        {sec.items.map((it, i) => (
                                            <div key={i} style={{ fontSize: 11, color: '#475569', lineHeight: 1.5, padding: '2px 0 2px 8px', borderLeft: `2px solid ${color}22` }}>{it}</div>
                                        ))}
                                    </div>
                                );
                                return (
                                    <div
                                        key={report.id}
                                        style={{ background: 'white', borderRadius: 10, border: '1px solid #e5e7eb', padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}
                                        onClick={() => setExpandedReportId(expanded ? null : report.id)}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
                                                {fmtRangeTs(report.createdAt)}
                                                <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>{report.trigger === 'auto' ? 'Auto' : 'Manual'}</span>
                                            </span>
                                            <span style={{ fontSize: 10, color: '#94a3b8' }}>
                                                Reviewed {examinedCount} · Changed {outcomeCount} · Submitted to plates {submitCount}
                                            </span>
                                        </div>
                                        {expanded && (
                                            <div style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>
                                                {examinedCount === 0 && outcomeCount === 0 && submitCount === 0 && (
                                                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Nothing needed digesting this time{report.plateUpdated.length > 0 ? ', but plates were organized' : ''}</div>
                                                )}
                                                {report.examined.map(sec => renderSection(sec, '#0ea5e9'))}
                                                {report.outcomes.map(sec => renderSection(sec, '#16a34a'))}
                                                {report.plateSubmissions.map(sec => renderSection(sec, '#8b5cf6'))}
                                                {report.plateUpdated.length > 0 && (
                                                    <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 6 }}>
                                                        Plates updated: {report.plateUpdated.map(r => (PLATE_TITLES as Record<string, string>)[r] || r).join(', ')}
                                                    </div>
                                                )}
                                                {report.plateCloudPending && (
                                                    <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 6 }}>
                                                        Plate organizing has been handed off to run in the cloud, results land a few minutes later
                                                    </div>
                                                )}
                                                {submitCount > 0 && report.plateUpdated.length === 0 && !report.plateCloudPending && (
                                                    <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 6 }}>
                                                        ⚠️ The candidates submitted this time weren't merged into the plates (organizing didn't complete or wasn't adopted)
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Export / import memory: connecting to an external memory store, cross-device migration */}
                <div style={{ marginTop: 16, background: '#eff6ff', borderRadius: 16, padding: 16, border: '1px solid #bfdbfe' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="download" size={14} />
                        <span>Export / Import Memory</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        Exports all of <b>{char.name}</b>'s Memory Palace memories to JSON: includes each memory's content, room, importance, mood, tags, and time,
                        plus event boxes (consolidated memories), windowsill anticipations, and room plates (persistent cognition).
                    </div>

                    {/* Whether to include vectors: check this if you'll keep using the same embedding model long-term, vectors can then be reused directly without re-vectorizing */}
                    <label style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                        marginBottom: 12, fontSize: 11, color: '#334155', lineHeight: 1.6,
                    }}>
                        <input
                            type="checkbox"
                            checked={exportWithVectors}
                            onChange={e => setExportWithVectors(e.target.checked)}
                            style={{ marginTop: 2, flexShrink: 0, cursor: 'pointer' }}
                        />
                        <span>
                            <b>Also export vectors</b> (recommended)<br/>
                            <span style={{ color: '#64748b' }}>
                                Vectors can be reused directly if you keep using <b>the same embedding model</b>, skipping re-vectorization with consistent search results;
                                switching models makes them useless. Uncheck to export just the text structure, for a smaller file.
                            </span>
                        </span>
                    </label>

                    {exportResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: exportResult.startsWith('[err]') ? '#dc2626' : exportResult.startsWith('[warn]') ? '#d97706' : '#16a34a' }}>
                            <StatusMessage msg={exportResult} />
                        </div>
                    )}

                    <button
                        onClick={handleExportMemories}
                        disabled={exporting}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: exporting ? '#d4d4d4' : '#2563eb',
                            cursor: exporting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {exporting ? 'Exporting...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="download" size={13} />
                                <span>Export as JSON</span>
                            </span>
                        )}
                    </button>

                    {/* External text migration: raw text gets cleaned then vectorized directly, assigned to rooms, and linked */}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #dbeafe' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 6 }}>
                            Move Raw Memories in From Elsewhere
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, lineHeight: 1.65 }}>
                            Up to 50,000 characters, counted entirely locally. The AI only organizes timing and event structure, <b>never summarizes, merges, or omits details</b>;
                            it then generates vectors directly, assigns rooms in the palace, and syncs <b>the same batch of content</b> into
                            <b>{char?.name || 'the current character'}'s Neural Link memory profile</b>.
                            Anything under 50,000 characters is automatically split into batches by paragraph, no manual splitting needed.
                        </div>
                        <textarea
                            value={externalMemoryText}
                            onChange={event => setExternalMemoryText(event.target.value)}
                            disabled={externalImporting}
                            placeholder="Paste raw text brought over from another app, device, or memory system..."
                            style={{
                                width: '100%',
                                minHeight: 150,
                                resize: 'vertical',
                                borderRadius: 12,
                                border: '1px solid #bfdbfe',
                                background: externalImporting ? '#f8fafc' : 'white',
                                color: '#334155',
                                fontSize: 12,
                                lineHeight: 1.65,
                                padding: 12,
                                outline: 'none',
                            }}
                        />
                        <div style={{
                            fontSize: 10,
                            color: externalLengthInfo.overLimit ? '#dc2626' : '#94a3b8',
                            fontWeight: externalLengthInfo.overLimit ? 700 : 400,
                            textAlign: 'right',
                            margin: '4px 2px 8px',
                        }}>
                            {externalLengthInfo.count.toLocaleString()} / {EXTERNAL_MEMORY_MAX_CHARS.toLocaleString()} characters (counted locally)
                        </div>
                        {externalLengthInfo.overLimit && (
                            <div style={{
                                fontSize: 11,
                                lineHeight: 1.65,
                                color: '#92400e',
                                background: '#fffbeb',
                                border: '1px solid #fde68a',
                                borderRadius: 10,
                                padding: 10,
                                marginBottom: 8,
                            }}>
                                {getExternalMemoryOverLimitMessage(externalMemoryText)}
                            </div>
                        )}
                        <details style={{
                            fontSize: 11,
                            color: '#475569',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 10,
                            padding: '8px 10px',
                            marginBottom: 10,
                        }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#475569' }}>
                                Common Questions Before Importing
                            </summary>
                            <div style={{ marginTop: 8, lineHeight: 1.75 }}>
                                <div><b>Who does it import to?</b> Only the currently selected {char?.name || 'current character'}; it never bleeds into other characters.</div>
                                <div><b>Does it overwrite old memories?</b> No; it only appends new nodes, and similar content gets deduped during vectorization.</div>
                                <div><b>Does it compress the source text?</b> No; it only organizes timing, event boundaries, and first-person perspective -- long events would rather be split into multiple entries than have details omitted.</div>
                                <div><b>Where does it get written?</b> The same cleaned result gets double-written: one copy into the Memory Palace vector store, one merged by date into the Neural Link character memory profile.</div>
                                <div><b>How is it different from the full-auto waterline?</b> The double-write approach is the same; but external text has no chat message ID, so it never advances the waterline and never hides chat history.</div>
                                <div><b>What does it call?</b> First cleans and assigns rooms using the secondary API, then generates vectors with the Embedding API; memory links are still established inside the palace.</div>
                                <div><b>What if it's over 50,000 characters?</b> The page computes locally and suggests a batch count; content over the limit is never uploaded or sent to any API.</div>
                                <div><b>What if it fails partway through?</b> If any batch's format is incomplete or looks truncated during cleaning, nothing from that run gets saved and the input box keeps your original text; the system automatically retries once first.</div>
                            </div>
                        </details>
                        {externalImportProgress && (
                            <div style={{ fontSize: 11, color: '#2563eb', marginBottom: 8 }}>
                                {externalImportProgress}
                            </div>
                        )}
                        {externalImportResult && (
                            <div style={{
                                fontSize: 12,
                                marginBottom: 8,
                                color: externalImportResult.startsWith('[err]')
                                    ? '#dc2626'
                                    : externalImportResult.startsWith('[warn]') ? '#d97706' : '#16a34a',
                            }}>
                                <StatusMessage msg={externalImportResult} />
                            </div>
                        )}
                        <button
                            onClick={handleExternalMemoryImport}
                            disabled={externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit}
                            style={{
                                width: '100%',
                                padding: '10px 0',
                                borderRadius: 12,
                                border: 'none',
                                fontWeight: 700,
                                fontSize: 13,
                                color: 'white',
                                background: externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit ? '#cbd5e1' : '#4f46e5',
                                cursor: externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {externalImporting
                                ? 'Cleaning and generating vectors...'
                                : externalLengthInfo.overLimit ? 'Please split into batches as suggested before importing' : 'Start Cleaning and Importing'}
                        </button>
                    </div>

                    {/* Structured import: merges JSON exported by this system back into the current character (cross-device migration / restore) */}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #dbeafe' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, lineHeight: 1.6 }}>
                            Files already in SullyOS Memory Palace JSON format need no cleaning, and can be merged directly into <b>{char.name}</b> (appended, not overwritten).
                        </div>

                        {importResult && (
                            <div style={{ fontSize: 12, marginBottom: 8, color: importResult.startsWith('[err]') ? '#dc2626' : importResult.startsWith('[warn]') ? '#d97706' : '#16a34a' }}>
                                <StatusMessage msg={importResult} />
                            </div>
                        )}

                        <input
                            ref={importInputRef}
                            type="file"
                            accept="application/json,.json"
                            onChange={handleImportFile}
                            style={{ display: 'none' }}
                        />
                        <button
                            onClick={() => importInputRef.current?.click()}
                            disabled={importing}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: '1px solid #bfdbfe', fontWeight: 700, fontSize: 13,
                                color: '#1d4ed8', background: 'white',
                                cursor: importing ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {importing ? 'Importing...' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="document" size={13} />
                                    <span>Import from SullyOS JSON</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
                </>)}

                {/* Danger zone: one-click wipe */}
                {isGlobal && (
                <div style={{ marginTop: 16, background: '#fef2f2', borderRadius: 16, padding: 16, border: '2px solid #fca5a5' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#991b1b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="warning" size={14} />
                        <span>Danger Zone: One-Click Wipe Vector Memory</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#7f1d1d', marginBottom: 12, lineHeight: 1.7 }}>
                        Wipes memory nodes, vectors, links, event boxes, sticky notes, anticipations, and high-watermark markers for ALL characters.
                        You can optionally also wipe the entire cloud Supabase <code>memory_vectors</code> table.
                        <b> This cannot be undone.</b>
                    </div>

                    {wipeResult && (
                        <div style={{
                            fontSize: 12, marginBottom: 10,
                            color: wipeResult.startsWith('[err]') ? '#dc2626' : '#166534',
                        }}>
                            <StatusMessage msg={wipeResult} />
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button
                            onClick={() => handleWipeAll(false)}
                            disabled={wiping}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: '1px solid #fecaca', fontWeight: 700, fontSize: 13,
                                color: '#b91c1c', background: 'white',
                                cursor: wiping ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {wiping ? 'Wiping...' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="trash" size={13} />
                                    <span>Local Only</span>
                                </span>
                            )}
                        </button>
                        <button
                            onClick={() => handleWipeAll(true)}
                            disabled={wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized}
                            title={
                                !remoteVectorConfig?.enabled ? 'Cloud vector storage not enabled'
                                : !remoteVectorConfig?.initialized ? 'Cloud vector storage not initialized'
                                : undefined
                            }
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: 'none', fontWeight: 700, fontSize: 13,
                                color: 'white',
                                background: (wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized)
                                    ? '#d4d4d4' : '#dc2626',
                                cursor: (wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized)
                                    ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {wiping ? 'Wiping...' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="bomb" size={13} />
                                    <span>Wipe Local + Cloud Supabase</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
                )}
            </div>
        );
    }

    // ─── Palace overview view ────────────────────────────────

    if (view === 'palace') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                {/* Title + Back + Settings */}
                <div style={{ textAlign: 'center', marginBottom: 20, position: 'relative' }}>
                    {/* Back (to character-select screen) button */}
                    <div
                        onClick={() => setView('picker')}
                        style={{
                            position: 'absolute', left: 0, top: 0,
                            fontSize: 13, color: '#6b7280', cursor: 'pointer',
                            padding: '4px 0',
                        }}
                    >
                        ← Back
                    </div>
                    {/* Settings gear */}
                    <div
                        onClick={() => setView('settings')}
                        style={{
                            position: 'absolute', right: 0, top: 0,
                            width: 32, height: 32, borderRadius: 10,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                            background: '#f3f0ff', color: '#7c3aed',
                        }}
                    >
                        <Icon name="settings" size={16} />
                    </div>

                    {/* Character name (tap to switch) */}
                    <div
                        onClick={() => setShowCharPicker(!showCharPicker)}
                        style={{ fontSize: 18, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                        <TokenImg value={char.avatar} alt="" style={{ width: 24, height: 24, borderRadius: 8, objectFit: 'cover' }} />
                        {char.name}'s Memory Palace
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>▼</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        {totalCount} memories · {boxCount} event boxes · {anticipations.length} anticipations
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <div
                            onClick={openAllMemories}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                fontSize: 11, fontWeight: 600, color: '#7c3aed',
                                cursor: 'pointer', padding: '4px 12px',
                                borderRadius: 8, border: '1px solid #e9e5ff',
                                background: '#f8f6ff',
                            }}
                        >
                            <Icon name="list" size={13} />
                            <span>View All Memories</span>
                        </div>
                        <div
                            onClick={openAllBoxes}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                fontSize: 11, fontWeight: 600, color: '#6366f1',
                                cursor: 'pointer', padding: '4px 12px',
                                borderRadius: 8, border: '1px solid #c7d2fe',
                                background: '#eef2ff',
                            }}
                        >
                            <Icon name="box" size={13} />
                            <span>View Event Boxes</span>
                        </div>
                    </div>

                    {/* Global search */}
                    <div style={{ marginTop: 12, textAlign: 'left', position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', display: 'inline-flex', pointerEvents: 'none' }}>
                            <Icon name="search" size={14} />
                        </span>
                        <input
                            type="text"
                            value={globalSearchQuery}
                            onChange={(e) => {
                                const q = e.target.value;
                                setGlobalSearchQuery(q);
                                if (globalSearchTimerRef.current) clearTimeout(globalSearchTimerRef.current);
                                if (q.trim().length < 2) { setGlobalSearchResults([]); return; }
                                globalSearchTimerRef.current = setTimeout(async () => {
                                    const allNodes = await MemoryNodeDB.getByCharId(char!.id);
                                    const keywords = q.trim().toLowerCase().split(/\s+/);
                                    const filtered = allNodes
                                        .filter(n => {
                                            const text = (n.content + ' ' + n.tags.join(' ') + ' ' + n.mood).toLowerCase();
                                            return keywords.every(kw => text.includes(kw));
                                        })
                                        .sort((a, b) => b.importance - a.importance)
                                        .slice(0, 20);
                                    setGlobalSearchResults(filtered);
                                }, 300);
                            }}
                            placeholder="Search memories (keywords, tags, mood...)"
                            style={{
                                width: '100%', padding: '10px 14px 10px 34px', borderRadius: 12,
                                border: '1px solid #e5e7eb', background: '#f9fafb',
                                fontSize: 13, outline: 'none', boxSizing: 'border-box',
                            }}
                        />
                    </div>

                    {/* Character switch panel */}
                    {showCharPicker && (
                        <div style={{
                            marginTop: 12, padding: 8, borderRadius: 12,
                            border: '1px solid #e5e7eb', backgroundColor: 'white',
                            textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                        }}>
                            {characters.map(c => (
                                <div
                                    key={c.id}
                                    onClick={() => handleSwitchChar(c.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10,
                                        padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                                        backgroundColor: c.id === activeCharacterId ? '#f3f0ff' : 'transparent',
                                    }}
                                >
                                    <TokenImg value={c.avatar} alt="" style={{ width: 32, height: 32, borderRadius: 10, objectFit: 'cover' }} />
                                    <div>
                                        <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                                            {(c as any).memoryPalaceEnabled ? 'Enabled' : 'Not Enabled'}
                                        </div>
                                    </div>
                                    {c.id === activeCharacterId && (
                                        <span style={{ marginLeft: 'auto', color: '#7c3aed', display: 'inline-flex' }}>
                                            <Icon name="check" size={14} />
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Embedding config warning */}
                    {!hasEmbeddingConfig && (
                        <div
                            onClick={() => setView('globalSettings')}
                            style={{
                                marginTop: 12, padding: '8px 12px', borderRadius: 10,
                                background: '#fef3c7', border: '1px solid #fde68a',
                                fontSize: 12, color: '#92400e', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}
                        >
                            <Icon name="warning" size={14} />
                            <span>Embedding API not configured yet — tap here to configure</span>
                        </div>
                    )}
                </div>

                {/* Pinned sticky notes */}
                {pinnedNodes.length > 0 && !globalSearchQuery.trim() && (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="pin" size={14} />
                            <span>Sticky Notes</span>
                        </div>
                        {pinnedNodes.map(node => {
                            const daysLeft = Math.ceil((node.pinnedUntil! - Date.now()) / (24 * 60 * 60 * 1000));
                            const color = ROOM_COLORS[node.room];
                            return (
                                <div key={node.id} style={{
                                    padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                    border: '1px solid #fde68a', background: '#fffbeb',
                                    display: 'flex', alignItems: 'flex-start', gap: 8,
                                }}>
                                    <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => openMemory(node, 'all')}>
                                        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#1f2937' }}>
                                            {node.content.length > 80 ? node.content.slice(0, 80) + '...' : node.content}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#92400e', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                            <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                            <span>{getRoomLabel(node.room, userProfile?.name)} · {daysLeft} days left</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            const updated = { ...node, pinnedUntil: null };
                                            await MemoryNodeDB.save(updated);
                                            setPinnedNodes(prev => prev.filter(n => n.id !== node.id));
                                        }}
                                        style={{
                                            flexShrink: 0, padding: '4px 8px', borderRadius: 6,
                                            border: '1px solid #fde68a', background: 'white',
                                            fontSize: 10, color: '#92400e', cursor: 'pointer',
                                        }}
                                    >
                                        Unpin
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Search results or the seven rooms */}
                {globalSearchQuery.trim().length >= 2 ? (
                    <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>
                            {globalSearchResults.length > 0
                                ? `Found ${globalSearchResults.length} memories`
                                : 'No matching memories found'}
                        </div>
                        {globalSearchResults.map(node => {
                            const color = ROOM_COLORS[node.room];
                            return (
                                <div
                                    key={node.id}
                                    onClick={() => openMemory(node, 'all')}
                                    style={{
                                        padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                        border: `1px solid ${color}33`, background: `${color}08`,
                                        cursor: 'pointer',
                                    }}
                                >
                                    <div style={{ fontSize: 13, lineHeight: 1.5, color: '#1f2937' }}>
                                        {node.content.length > 100 ? node.content.slice(0, 100) + '...' : node.content}
                                    </div>
                                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                            <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                            {getRoomLabel(node.room, userProfile?.name)}
                                        </span>
                                        <span>{new Date(node.createdAt).toLocaleDateString('en-US')}</span>
                                        <span style={{ color }}>{'★'.repeat(Math.min(node.importance, 5))}</span>
                                        <span>{node.mood}</span>
                                    </div>
                                    {node.tags.length > 0 && (
                                        <div style={{ marginTop: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                                            {node.tags.map((t: string) => (
                                                <span key={t} style={{
                                                    fontSize: 9, padding: '1px 6px', borderRadius: 4,
                                                    backgroundColor: `${color}18`, color,
                                                }}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <>
                        {/* The seven rooms */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                            {(Object.keys(ROOM_CONFIGS) as MemoryRoom[]).map(room => {
                                const config = ROOM_CONFIGS[room];
                                const count = roomCounts[room] || 0;
                                const color = ROOM_COLORS[room];
                                return (
                                    <div
                                        key={room}
                                        onClick={() => openRoom(room)}
                                        style={{
                                            padding: 14,
                                            borderRadius: 12,
                                            border: `1px solid ${color}33`,
                                            backgroundColor: `${color}11`,
                                            cursor: 'pointer',
                                            transition: 'transform 0.15s',
                                        }}
                                    >
                                        <div style={{ marginBottom: 6, color }}><RoomIcon room={room} size={26} /></div>
                                        <div style={{ fontSize: 14, fontWeight: 600, color }}>{getRoomLabel(room, userProfile?.name)}</div>
                                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{config.description}</div>
                                        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 8, color }}>
                                            {count}
                                            <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>
                                                {config.capacity ? `/ ${config.capacity}` : ''}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                {/* Anticipations area */}
                {anticipations.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="sunrise" size={14} />
                            <span>Windowsill Anticipations</span>
                            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>Long-press to edit or delete</span>
                        </div>
                        {anticipations.map((ant: Anticipation) => (
                            <div
                                key={ant.id}
                                onPointerDown={(e) => startAnticipationLongPress(e, ant)}
                                onPointerMove={moveAnticipationLongPress}
                                onPointerUp={cancelAnticipationLongPress}
                                onPointerCancel={cancelAnticipationLongPress}
                                onPointerLeave={cancelAnticipationLongPress}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    openAnticipationEditor(ant);
                                }}
                                style={{
                                padding: 10, borderRadius: 8, marginBottom: 6,
                                backgroundColor: ant.status === 'fulfilled' ? '#ecfdf5' :
                                    ant.status === 'disappointed' ? '#fef2f2' : '#fefce8',
                                fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 6,
                                cursor: 'pointer', userSelect: 'none', touchAction: 'pan-y',
                            }}>
                                <span style={{ display: 'inline-flex', color:
                                    ant.status === 'active' ? '#7c3aed' :
                                    ant.status === 'anchor' ? '#6b7280' :
                                    ant.status === 'fulfilled' ? '#16a34a' : '#ef4444'
                                }}>
                                    <Icon
                                        name={ant.status === 'active' ? 'sparkle' :
                                            ant.status === 'anchor' ? 'lock' :
                                            ant.status === 'fulfilled' ? 'celebrate' : 'broken-heart'}
                                        size={14}
                                    />
                                </span>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ lineHeight: 1.5, color: '#1f2937', whiteSpace: 'pre-wrap' }}>{ant.content}</div>
                                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                                        {new Date(ant.createdAt).toLocaleDateString('en-US')} · {ant.status}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {editingAnticipation && (
                    <div
                        onClick={() => {
                            if (!savingAnticipation) {
                                setEditingAnticipation(null);
                                setAnticipationDraft('');
                            }
                        }}
                        style={{
                            position: 'fixed', inset: 0, zIndex: 120,
                            background: 'rgba(15,23,42,0.42)', backdropFilter: 'blur(4px)',
                            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                            padding: 16,
                        }}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 520, padding: 18,
                                borderRadius: 22, background: 'white',
                                boxShadow: '0 18px 50px rgba(15,23,42,0.22)',
                            }}
                        >
                            <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Edit Windowsill Anticipation</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3, marginBottom: 12 }}>
                                Only edits the sticky note's content; status and creation time stay unchanged
                            </div>
                            <textarea
                                autoFocus
                                value={anticipationDraft}
                                onChange={e => setAnticipationDraft(e.target.value)}
                                rows={5}
                                maxLength={2000}
                                style={{
                                    width: '100%', boxSizing: 'border-box', resize: 'vertical',
                                    border: '1px solid #e5e7eb', borderRadius: 14,
                                    background: '#fffbeb', color: '#1f2937',
                                    fontSize: 14, lineHeight: 1.6, padding: 12, outline: 'none',
                                }}
                            />
                            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                                <button
                                    onClick={handleDeleteAnticipation}
                                    disabled={savingAnticipation}
                                    style={{
                                        padding: '10px 14px', borderRadius: 12,
                                        border: '1px solid #fecaca', background: '#fef2f2',
                                        color: '#dc2626', fontWeight: 700, cursor: 'pointer',
                                    }}
                                >
                                    Delete
                                </button>
                                <button
                                    onClick={() => {
                                        setEditingAnticipation(null);
                                        setAnticipationDraft('');
                                    }}
                                    disabled={savingAnticipation}
                                    style={{
                                        marginLeft: 'auto', padding: '10px 16px', borderRadius: 12,
                                        border: '1px solid #e5e7eb', background: 'white',
                                        color: '#6b7280', fontWeight: 600, cursor: 'pointer',
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveAnticipation}
                                    disabled={savingAnticipation || !anticipationDraft.trim()}
                                    style={{
                                        padding: '10px 18px', borderRadius: 12,
                                        border: 'none', background: '#7c3aed',
                                        color: 'white', fontWeight: 700, cursor: 'pointer',
                                        opacity: savingAnticipation || !anticipationDraft.trim() ? 0.5 : 1,
                                    }}
                                >
                                    {savingAnticipation ? 'Saving...' : 'Save'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ─── All-memories view ────────────────────────────────

    if (view === 'all') {
        const sorted = [...allNodes].sort((a, b) => {
            const dir = allSortDir === 'desc' ? -1 : 1;
            if (allSortBy === 'time') return dir * (a.createdAt - b.createdAt);
            return dir * (a.importance - b.importance);
        });

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← Back to Palace
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{allNodes.length} memories</div>
                </div>

                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="list" size={18} />
                    <span>All Memories</span>
                </div>

                {/* Sort controls */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>Sort:</span>
                    {(['time', 'importance'] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => setAllSortBy(s)}
                            style={{
                                padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                border: allSortBy === s ? '2px solid #7c3aed' : '1px solid #d4d4d4',
                                background: allSortBy === s ? '#f3f0ff' : 'white',
                                color: allSortBy === s ? '#7c3aed' : '#6b7280',
                                cursor: 'pointer',
                            }}
                        >
                            {s === 'time' ? 'Time' : 'Importance'}
                        </button>
                    ))}
                    <button
                        onClick={() => setAllSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                        style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                            border: '1px solid #d4d4d4', background: 'white', color: '#6b7280',
                            cursor: 'pointer',
                        }}
                    >
                        {allSortDir === 'desc' ? '↓ Descending' : '↑ Ascending'}
                    </button>
                </div>

                {sorted.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        No memories yet
                    </div>
                ) : (
                    sorted.map((node: MemoryNode) => (
                        <div
                            key={node.id}
                            onClick={() => openMemory(node, 'all')}
                            style={{
                                padding: 12, borderRadius: 10, marginBottom: 8,
                                border: '1px solid #e5e7eb', cursor: 'pointer',
                                backgroundColor: '#fafafa',
                            }}
                        >
                            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{node.content}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                    <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                    {getRoomLabel(node.room, userProfile?.name)}
                                </span>
                                <span>Importance: {node.importance}</span>
                                <span>{node.mood}</span>
                                <span>{new Date(node.createdAt).toLocaleDateString('en-US')}</span>
                                <span>Accessed {node.accessCount} times</span>
                            </div>
                            {node.tags.length > 0 && (
                                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {node.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                            backgroundColor: '#f3f0ff', color: '#7c3aed',
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        );
    }

    // ─── Event box list view ────────────────────────────────

    if (view === 'boxes') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← Back to Palace
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{allBoxes.length} event boxes</div>
                </div>

                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="box" size={18} />
                    <span>Event Boxes</span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>
                    Memories automatically grouped by the same event. Tap to expand and view the consolidated memory, live nodes, and archived nodes.
                </div>

                {allBoxes.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        No event boxes yet -- these are created automatically when related events come up in conversation or when you manually bind a link
                    </div>
                ) : (
                    allBoxes.map(box => {
                        const expanded = expandedBoxId === box.id;
                        const members = boxMembers[box.id];
                        return (
                            <div
                                key={box.id}
                                style={{
                                    borderRadius: 12, marginBottom: 10,
                                    border: '1px solid #c7d2fe',
                                    background: expanded ? '#f5f7ff' : '#fafbff',
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    onClick={() => toggleBoxExpand(box)}
                                    style={{ padding: 12, cursor: 'pointer' }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: '#3730a3', flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <Icon name="box" size={14} />
                                            <span>{box.name || 'Untitled'}</span>
                                            {box.sealed && <span style={{ fontSize: 10, marginLeft: 4, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e' }}>Sealed</span>}
                                        </div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); editingBoxId === box.id ? cancelEditBoxMeta() : startEditBoxMeta(box); }}
                                            title="Edit box name and tags"
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                                                border: '1px solid #c7d2fe',
                                                background: editingBoxId === box.id ? '#e0e7ff' : '#fff',
                                                color: '#6366f1', cursor: 'pointer', padding: 0,
                                            }}
                                        >
                                            <Icon name="pencil" size={12} />
                                        </button>
                                        <div style={{ fontSize: 11, color: '#6366f1' }}>{expanded ? '▲' : '▼'}</div>
                                    </div>
                                    {box.tags.length > 0 && (
                                        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {box.tags.slice(0, 6).map(t => (
                                                <span key={t} style={{
                                                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                                    backgroundColor: '#e0e7ff', color: '#4338ca',
                                                }}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                        <span>Live {box.liveMemoryIds.length}</span>
                                        <span>Archived {box.archivedMemoryIds.length}</span>
                                        {box.compressionCount > 0 && <span>Compressed {box.compressionCount} times</span>}
                                        <span>Updated {new Date(box.updatedAt).toLocaleDateString('en-US')}</span>
                                    </div>
                                </div>

                                {editingBoxId === box.id && (
                                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid #e0e7ff' }}>
                                        <div style={{ fontSize: 10, color: '#6b7280', margin: '10px 0 8px', lineHeight: 1.5 }}>
                                            Box name and tags are only the display header shown during recall, not part of retrieval scoring (editing them doesn't affect which memories get recalled).
                                            Note: when the box gets compressed again later, the secondary API may regenerate the box name/tags and overwrite your edits -- just edit again if you don't like the result.
                                        </div>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#4338ca' }}>Box Name</label>
                                        <input
                                            value={boxNameDraft}
                                            onChange={e => setBoxNameDraft(e.target.value)}
                                            placeholder="Untitled Event"
                                            maxLength={40}
                                            style={{
                                                width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 10,
                                                padding: '6px 8px', borderRadius: 6, border: '1px solid #c7d2fe',
                                                fontSize: 13, outline: 'none',
                                            }}
                                        />
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#4338ca' }}>Tags (comma-separated, up to 20)</label>
                                        <input
                                            value={boxTagsDraft}
                                            onChange={e => setBoxTagsDraft(e.target.value)}
                                            placeholder="e.g. clothes shopping, return, trending style"
                                            style={{
                                                width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 10,
                                                padding: '6px 8px', borderRadius: 6, border: '1px solid #c7d2fe',
                                                fontSize: 13, outline: 'none',
                                            }}
                                        />
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                onClick={() => handleSaveBoxMeta(box)}
                                                disabled={savingBox}
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none',
                                                    background: '#6366f1', color: '#fff',
                                                    cursor: savingBox ? 'default' : 'pointer', opacity: savingBox ? 0.6 : 1,
                                                }}
                                            >
                                                <Icon name="check" size={12} />
                                                <span>{savingBox ? 'Saving...' : 'Save'}</span>
                                            </button>
                                            <button
                                                onClick={cancelEditBoxMeta}
                                                disabled={savingBox}
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: 12, padding: '5px 12px', borderRadius: 6,
                                                    border: '1px solid #d1d5db', background: '#fff', color: '#6b7280',
                                                    cursor: savingBox ? 'default' : 'pointer',
                                                }}
                                            >
                                                <Icon name="x" size={12} />
                                                <span>Cancel</span>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {expanded && members && (
                                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid #e0e7ff' }}>
                                        {members.summary && (
                                            <div
                                                onClick={() => openMemory(members.summary!, 'boxes')}
                                                style={{
                                                    marginTop: 10, padding: 10, borderRadius: 8,
                                                    border: '1px solid #fcd34d', background: '#fef3c7',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                <div style={{ fontSize: 10, color: '#92400e', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name="sparkle" size={11} />
                                                    <span>Consolidated Memory</span>
                                                </div>
                                                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                    {members.summary.content.length > 120 ? members.summary.content.slice(0, 120) + '...' : members.summary.content}
                                                </div>
                                            </div>
                                        )}

                                        {members.live.length > 0 && (
                                            <>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 4 }}>
                                                    <div style={{ fontSize: 10, fontWeight: 600, color: '#6366f1', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                        <Icon name="box" size={11} />
                                                        <span>Live Nodes ({members.live.length})</span>
                                                        {members.live.length >= 15 && (
                                                            <span style={{ marginLeft: 4, fontSize: 9, color: '#b91c1c', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                                <Icon name="warning" size={10} />
                                                                <span>Compression may be repeatedly failing</span>
                                                            </span>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleUnbindAllLive(box); }}
                                                        style={{
                                                            fontSize: 10, padding: '3px 8px', borderRadius: 6,
                                                            border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c',
                                                            cursor: 'pointer',
                                                        }}
                                                        title="Removes all live nodes from the box, turning them back into independent memories (memories aren't deleted)"
                                                    >
                                                        One-Click Remove Live Nodes
                                                    </button>
                                                </div>
                                                {members.live.map(n => (
                                                    <div
                                                        key={n.id}
                                                        onClick={() => openMemory(n, 'boxes')}
                                                        style={{
                                                            padding: 8, borderRadius: 8, marginBottom: 4,
                                                            border: '1px solid #e0e7ff', background: 'white',
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                            {n.content.length > 80 ? n.content.slice(0, 80) + '...' : n.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={n.room} size={11} style={{ color: ROOM_COLORS[n.room] }} />
                                                            <span>{getRoomLabel(n.room, userProfile?.name)} · {new Date(n.createdAt).toLocaleDateString('en-US')}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {members.archived.length > 0 && (
                                            <>
                                                <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginTop: 10, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name="moon" size={11} />
                                                    <span>Archived ({members.archived.length})</span>
                                                </div>
                                                {members.archived.map(n => (
                                                    <div
                                                        key={n.id}
                                                        onClick={() => openMemory(n, 'boxes')}
                                                        style={{
                                                            padding: 8, borderRadius: 8, marginBottom: 4,
                                                            border: '1px solid #e5e7eb', background: '#f9fafb',
                                                            cursor: 'pointer', opacity: 0.75,
                                                            position: 'relative',
                                                        }}
                                                    >
                                                        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#4b5563', paddingRight: 56 }}>
                                                            {n.content.length > 80 ? n.content.slice(0, 80) + '...' : n.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={n.room} size={11} style={{ color: ROOM_COLORS[n.room] }} />
                                                            <span>{getRoomLabel(n.room, userProfile?.name)} · {new Date(n.createdAt).toLocaleDateString('en-US')}</span>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleReviveArchived(box, n); }}
                                                            title="Revive: pulls this memory out on its own and makes it active again."
                                                            style={{
                                                                position: 'absolute', top: 6, right: 6,
                                                                fontSize: 10, padding: '3px 8px', borderRadius: 6,
                                                                border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#15803d',
                                                                fontWeight: 600, cursor: 'pointer',
                                                            }}
                                                        >
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                                <Icon name="sparkle" size={10} />
                                                                <span>Revive</span>
                                                            </span>
                                                        </button>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {!members.summary && members.live.length === 0 && members.archived.length === 0 && (
                                            <div style={{ fontSize: 11, color: '#c4c4c4', textAlign: 'center', padding: '12px 0' }}>
                                                No members in this box yet
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        );
    }

    // ─── Room detail view ────────────────────────────────

    if (view === 'room' && selectedRoom) {
        const roomLabel = getRoomLabel(selectedRoom, userProfile?.name);
        const roomColor = ROOM_COLORS[selectedRoom];

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); setSelectedRoom(null); setSelectMode(false); setSelectedIds(new Set()); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← Back to Palace
                    </div>
                    {roomNodes.length > 0 && (
                        <div
                            onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); }}
                            style={{ fontSize: 12, color: selectMode ? '#dc2626' : '#6b7280', cursor: 'pointer', fontWeight: 600 }}
                        >
                            {selectMode ? 'Cancel Selection' : 'Select'}
                        </div>
                    )}
                </div>

                <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: roomColor, display: 'inline-flex' }}><RoomIcon room={selectedRoom} size={26} /></span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: roomColor }}>{roomLabel}</span>
                    <span style={{ fontSize: 12, color: '#9ca3af' }}>{roomNodes.length} memories</span>
                </div>

                {/* Bulk delete toolbar */}
                {selectMode && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '8px 12px', borderRadius: 10, marginBottom: 12,
                        background: '#fef2f2', border: '1px solid #fecaca',
                    }}>
                        <div style={{ fontSize: 12, color: '#991b1b' }}>
                            Selected {selectedIds.size}
                            <span
                                onClick={() => setSelectedIds(new Set(roomNodes.map(n => n.id)))}
                                style={{ marginLeft: 8, color: '#6b7280', cursor: 'pointer', textDecoration: 'underline' }}
                            >Select All</span>
                        </div>
                        <button
                            onClick={handleBatchDelete}
                            disabled={selectedIds.size === 0 || deleting}
                            style={{
                                padding: '4px 12px', borderRadius: 8, border: 'none',
                                fontSize: 12, fontWeight: 700,
                                color: 'white', background: selectedIds.size > 0 ? '#dc2626' : '#d4d4d4',
                                cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed',
                            }}
                        >
                            {deleting ? 'Deleting...' : `Delete (${selectedIds.size})`}
                        </button>
                    </div>
                )}

                {roomNodes.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        This room is still empty
                    </div>
                ) : (
                    roomNodes.map((node: MemoryNode) => (
                        <div
                            key={node.id}
                            onClick={() => selectMode ? toggleSelect(node.id) : openMemory(node)}
                            style={{
                                padding: 12, borderRadius: 10, marginBottom: 8,
                                border: `1px solid ${selectMode && selectedIds.has(node.id) ? '#dc2626' : '#e5e7eb'}`,
                                cursor: 'pointer',
                                backgroundColor: selectMode && selectedIds.has(node.id) ? '#fef2f2' : '#fafafa',
                            }}
                        >
                            {selectMode && (
                                <div style={{ float: 'right', marginLeft: 8, color: selectedIds.has(node.id) ? '#dc2626' : '#9ca3af', display: 'inline-flex' }}>
                                    <Icon name={selectedIds.has(node.id) ? 'square-check' : 'square'} size={16} />
                                </div>
                            )}
                            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{node.content}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, display: 'flex', gap: 8 }}>
                                <span>Importance: {node.importance}</span>
                                <span>{node.mood}</span>
                                <span>{new Date(node.createdAt).toLocaleDateString('en-US')}</span>
                                <span>Accessed {node.accessCount} times</span>
                            </div>
                            {node.tags.length > 0 && (
                                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {node.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                            backgroundColor: `${roomColor}22`, color: roomColor,
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        );
    }

    // ─── Single memory detail ────────────────────────────────

    if (view === 'memory' && selectedNode) {
        const roomColor = ROOM_COLORS[editing ? editRoom : selectedNode.room];
        const MOODS = ['happy', 'sad', 'angry', 'anxious', 'tender', 'peaceful', 'excited', 'nostalgic', 'frustrated', 'hopeful', 'lonely', 'grateful'];

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView(prevView); setSelectedNode(null); setEditing(false); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← Back to {prevView === 'all' ? 'All Memories' : prevView === 'boxes' ? 'Event Boxes' : getRoomLabel(selectedRoom || selectedNode.room, userProfile?.name)}
                    </div>
                    {!editing && (
                        <div
                            onClick={() => setEditing(true)}
                            style={{ fontSize: 12, color: '#3b82f6', cursor: 'pointer', fontWeight: 600 }}
                        >
                            Edit
                        </div>
                    )}
                </div>

                <div style={{
                    padding: 16, borderRadius: 12,
                    border: `1px solid ${roomColor}44`,
                    backgroundColor: `${roomColor}08`,
                }}>
                    {editing ? (
                        /* ─── Edit mode ─── */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <label className={labelClass}>Content</label>
                                <textarea
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                    className={inputClass}
                                    style={{ minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }}
                                />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                <div>
                                    <label className={labelClass}>Room</label>
                                    <select
                                        value={editRoom}
                                        onChange={e => setEditRoom(e.target.value as MemoryRoom)}
                                        className={inputClass}
                                        style={{ fontFamily: 'inherit' }}
                                    >
                                        {(Object.keys(ROOM_CONFIGS) as MemoryRoom[]).map(r => (
                                            <option key={r} value={r}>{getRoomLabel(r, userProfile?.name)}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Mood</label>
                                    <select
                                        value={editMood}
                                        onChange={e => setEditMood(e.target.value)}
                                        className={inputClass}
                                        style={{ fontFamily: 'inherit' }}
                                    >
                                        {MOODS.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>Importance: {editImportance}</label>
                                <input
                                    type="range" min="1" max="10" step="1"
                                    value={editImportance}
                                    onChange={e => setEditImportance(parseInt(e.target.value))}
                                    style={{ width: '100%' }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
                                    <span>1</span>
                                    <span style={{ color: roomColor, fontWeight: 600 }}>{'★'.repeat(editImportance)}{'☆'.repeat(10 - editImportance)}</span>
                                    <span>10</span>
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>Tags (comma-separated)</label>
                                <input
                                    value={editTags}
                                    onChange={e => setEditTags(e.target.value)}
                                    className={inputClass}
                                    placeholder="tag1, tag2, ..."
                                />
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                    onClick={handleSaveEdit}
                                    disabled={saving || !editContent.trim()}
                                    style={{
                                        flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
                                        fontSize: 13, fontWeight: 700, color: 'white',
                                        background: saving ? '#d4d4d4' : '#3b82f6',
                                        cursor: saving ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </button>
                                <button
                                    onClick={() => {
                                        setEditing(false);
                                        setEditContent(selectedNode.content);
                                        setEditImportance(selectedNode.importance);
                                        setEditMood(selectedNode.mood);
                                        setEditRoom(selectedNode.room);
                                        setEditTags(selectedNode.tags.join(', '));
                                    }}
                                    style={{
                                        padding: '10px 16px', borderRadius: 10, border: '1px solid #e5e7eb',
                                        fontSize: 13, fontWeight: 600, color: '#6b7280', background: 'white',
                                        cursor: 'pointer',
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        /* ─── View mode ─── */
                        <>
                            <div style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 12 }}>{selectedNode.content}</div>

                            <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.8 }}>
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <RoomIcon room={selectedNode.room} size={14} style={{ color: ROOM_COLORS[selectedNode.room] }} />
                                    <span>{getRoomLabel(selectedNode.room, userProfile?.name)}</span>
                                </div>
                                <div>Importance: {'★'.repeat(selectedNode.importance)}{'☆'.repeat(10 - selectedNode.importance)}</div>
                                <div>Mood: {selectedNode.mood}</div>
                                <div>Created: {new Date(selectedNode.createdAt).toLocaleString('en-US')}</div>
                                <div>Last accessed: {new Date(selectedNode.lastAccessedAt).toLocaleString('en-US')}</div>
                                <div>Access count: {selectedNode.accessCount}</div>
                                {currentBox && <div>Event box: {currentBox.name || 'Untitled'}</div>}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span>Vectorized:</span>
                                    <span style={{ color: selectedNode.embedded ? '#16a34a' : '#dc2626', display: 'inline-flex' }}>
                                        <Icon name={selectedNode.embedded ? 'check' : 'x'} size={12} />
                                    </span>
                                </div>
                            </div>

                            {selectedNode.tags.length > 0 && (
                                <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {selectedNode.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 11, padding: '2px 8px', borderRadius: 6,
                                            backgroundColor: `${roomColor}22`, color: roomColor,
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}

                            {/* Related events */}
                            <div style={{ marginTop: 14 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                        <Icon name="link" size={12} />
                                        <span>Related Events{linkedMemories.length > 0 ? ` (${linkedMemories.length})` : ''}</span>
                                    </div>
                                    <button
                                        onClick={() => { setShowLinkSearch(!showLinkSearch); setLinkSearchQuery(''); setLinkSearchResults([]); }}
                                        style={{
                                            fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                                            border: '1px solid #e0e7ff', background: showLinkSearch ? '#e0e7ff' : 'white',
                                            color: '#6366f1', cursor: 'pointer',
                                        }}
                                    >
                                        {showLinkSearch ? 'Cancel' : '+ Add Link'}
                                    </button>
                                </div>

                                {/* Search to add a link */}
                                {showLinkSearch && (
                                    <div style={{ marginBottom: 10, padding: 10, borderRadius: 10, border: '1px solid #e0e7ff', background: '#faf9ff' }}>
                                        <input
                                            type="text"
                                            value={linkSearchQuery}
                                            onChange={async (e) => {
                                                const q = e.target.value;
                                                setLinkSearchQuery(q);
                                                if (q.trim().length < 2) { setLinkSearchResults([]); return; }
                                                // Search for keywords across all of the current character's memories
                                                const allNodes = await MemoryNodeDB.getByCharId(char!.id);
                                                const filtered = allNodes
                                                    .filter(n => n.id !== selectedNode.id && !n.archived && (
                                                        n.content.includes(q.trim()) ||
                                                        n.tags.some(t => t.includes(q.trim()))
                                                    ))
                                                    .sort((a, b) => b.importance - a.importance)
                                                    .slice(0, 8);
                                                setLinkSearchResults(filtered);
                                            }}
                                            placeholder="Type keywords to search memories..."
                                            className={inputClass}
                                            style={{ fontSize: 12, marginBottom: 6 }}
                                        />
                                        {linkSearchResults.map(node => {
                                            const alreadyLinked = linkedMemories.some(l => l.node.id === node.id);
                                            return (
                                                <div key={node.id} style={{
                                                    padding: '8px 10px', borderRadius: 8, marginBottom: 4,
                                                    border: '1px solid #e5e7eb', background: 'white',
                                                    display: 'flex', alignItems: 'flex-start', gap: 8,
                                                    opacity: alreadyLinked ? 0.5 : 1,
                                                }}>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ fontSize: 11, lineHeight: 1.5, color: '#1f2937' }}>
                                                            {node.content.length > 60 ? node.content.slice(0, 60) + '...' : node.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={node.room} size={11} style={{ color: ROOM_COLORS[node.room] }} />
                                                            <span>{getRoomLabel(node.room, userProfile?.name)} · {new Date(node.createdAt).toLocaleDateString('en-US')}</span>
                                                        </div>
                                                    </div>
                                                    <button
                                                        disabled={alreadyLinked}
                                                        onClick={async () => {
                                                            // New version: binds into an EventBox (replaces the old one-sided causal MemoryLink)
                                                            const box = await manuallyBindMemories(char!.id, selectedNode.id, node.id);
                                                            if (box) {
                                                                trackEvent('Manually Link Two Memories');
                                                                // Reload the sibling list to show the latest box state
                                                                await loadLinkedMemories(selectedNode.id);
                                                            }
                                                        }}
                                                        style={{
                                                            flexShrink: 0, padding: '4px 10px', borderRadius: 6,
                                                            border: 'none', fontSize: 10, fontWeight: 600,
                                                            color: 'white', background: alreadyLinked ? '#d4d4d4' : '#6366f1',
                                                            cursor: alreadyLinked ? 'not-allowed' : 'pointer',
                                                        }}
                                                    >
                                                        {alreadyLinked ? 'Linked' : 'Bind to Event Box'}
                                                    </button>
                                                </div>
                                            );
                                        })}
                                        {linkSearchQuery.trim().length >= 2 && linkSearchResults.length === 0 && (
                                            <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', padding: 8 }}>
                                                No matching memories found
                                            </div>
                                        )}
                                    </div>
                                )}

                                {loadingLinks && (
                                    <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading...</div>
                                )}

                                {currentBox && (
                                    <div style={{
                                        padding: '8px 10px', borderRadius: 8, marginBottom: 8,
                                        border: '1px solid #c7d2fe', background: '#eef2ff',
                                        fontSize: 11, lineHeight: 1.5, color: '#3730a3',
                                    }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                            <Icon name="box" size={12} />
                                            <span>Event Box: <b>{currentBox.name || 'Untitled'}</b></span>
                                        </span>
                                        {currentBox.tags.length > 0 && (
                                            <span style={{ color: '#6366f1', fontSize: 10 }}> 〈{currentBox.tags.slice(0, 4).join(' · ')}〉</span>
                                        )}
                                        <span style={{ color: '#6b7280', fontSize: 10 }}>
                                            {' '}· Live {currentBox.liveMemoryIds.length} Archived {currentBox.archivedMemoryIds.length}
                                            {currentBox.compressionCount > 0 && ` · Compressed ${currentBox.compressionCount} times`}
                                        </span>
                                    </div>
                                )}

                                {linkedMemories.map(({ id, relation, node: linkedNode }) => {
                                    const isSummary = relation === 'box_summary';
                                    const isArchived = relation === 'box_archived';
                                    const isLegacy = relation === 'legacy_causal';
                                    const bg = isSummary ? '#fef3c7' : isArchived ? '#f5f5f5' : '#f5f3ff';
                                    const border = isSummary ? '#fcd34d' : isArchived ? '#e5e7eb' : '#e0e7ff';
                                    const relationIcon = isSummary ? 'sparkle'
                                        : isArchived ? 'moon'
                                        : isLegacy ? 'link'
                                        : 'box';
                                    const relationText = isSummary ? 'Consolidated Memory'
                                        : isArchived ? 'Archived'
                                        : isLegacy ? 'Legacy Link'
                                        : 'Live Node in Same Box';
                                    return (
                                        <div key={id} style={{
                                            padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                            border: `1px solid ${border}`, background: bg,
                                            display: 'flex', alignItems: 'flex-start', gap: 8,
                                            opacity: isArchived ? 0.75 : 1,
                                        }}>
                                            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => openMemory(linkedNode, prevView)}>
                                                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name={relationIcon} size={11} />
                                                    <span>{relationText}</span>
                                                </div>
                                                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                    {linkedNode.content.length > 80 ? linkedNode.content.slice(0, 80) + '...' : linkedNode.content}
                                                </div>
                                                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <RoomIcon room={linkedNode.room} size={11} style={{ color: ROOM_COLORS[linkedNode.room] }} />
                                                    <span>{getRoomLabel(linkedNode.room, userProfile?.name)} · {new Date(linkedNode.createdAt).toLocaleDateString('en-US')}</span>
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (isLegacy) {
                                                        // Delete legacy causal link
                                                        if (confirm('Remove this legacy link? (the memory itself will not be deleted)')) {
                                                            await MemoryLinkDB.delete(id);
                                                            setLinkedMemories(prev => prev.filter(l => l.id !== id));
                                                        }
                                                    } else if (isSummary) {
                                                        alert('The consolidated memory is a product of the event box being compressed and cannot be removed on its own; to rebuild it, delete all members of the event box.');
                                                    } else {
                                                        if (confirm('Remove this memory from the event box? (the memory itself will not be deleted, it will return to "solid ground" as an independent memory)')) {
                                                            await removeMemoryFromBox(linkedNode.id);
                                                            await loadLinkedMemories(selectedNode!.id);
                                                        }
                                                    }
                                                }}
                                                style={{
                                                    flexShrink: 0, padding: '4px 8px', borderRadius: 6,
                                                    border: '1px solid #e5e7eb', background: 'white',
                                                    fontSize: 10, color: '#9ca3af', cursor: 'pointer',
                                                }}
                                            >
                                                {isSummary ? 'View' : 'Remove'}
                                            </button>
                                        </div>
                                    );
                                })}

                                {!loadingLinks && linkedMemories.length === 0 && !showLinkSearch && (
                                    <div style={{ fontSize: 11, color: '#c4c4c4', textAlign: 'center', padding: '8px 0' }}>
                                        No event-box links yet
                                    </div>
                                )}
                            </div>

                            {/* Delete button */}
                            <button
                                onClick={() => {
                                    if (confirm('Delete this memory? (including its vector and links)')) {
                                        handleDeleteSingle(selectedNode.id);
                                    }
                                }}
                                disabled={deleting}
                                style={{
                                    marginTop: 16, width: '100%', padding: '10px 0',
                                    borderRadius: 10, border: '1px solid #fecaca',
                                    fontSize: 12, fontWeight: 600,
                                    color: '#dc2626', background: '#fef2f2',
                                    cursor: deleting ? 'not-allowed' : 'pointer',
                                }}
                            >
                                {deleting ? 'Deleting...' : (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                        <Icon name="trash" size={13} />
                                        <span>Delete This Memory</span>
                                    </span>
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return null;
}
