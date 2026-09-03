import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, Trash, BookOpen, Planet, Clock, Play, CaretRight, X,
    UploadSimple, PencilSimple, FlipHorizontal, CaretLeft, Sparkle,
    CircleNotch, TextAa, Palette, Pause, MusicNotes, Queue, Question, Check, Gear,
    SpeakerHigh, SpeakerSlash, MagnifyingGlass,
} from '@phosphor-icons/react';
import TheaterPanel from './theater/TheaterPanel';
import { CreatorIframe, type ChibiResult } from '../components/Like520Event';
import { useMusic, type Song } from '../context/MusicContext';
import { DB } from '../utils/db';
import { useResilientAssetUrl, attachAudioMirrorFallback } from '../utils/assetUrl';
import { VRScheduler, VR_FAIL_LIMIT } from '../utils/vrWorld/scheduler';
import { collectVRDiagnostics } from '../utils/vrWorld/diagnostics';
import { VR_ROOMS, getRoom, VR_DEFAULT_INTERVAL_MIN, SIGNAL_EPIGRAPH, signalActFor, signalActRanges, SIGNAL_POEMS_PER_BOOKLET, SIGNAL_EVENT_ENDED, SIGNAL_MEMORIAL_CLOSING } from '../utils/vrWorld/constants';
import { buildNovelAsync, groupAnnotationsBySeg, getBookmark } from '../utils/vrWorld/novel';
import { decodeBytes } from '../utils/vrWorld/decodeText';
import { extractPdfText, isPdfFile } from '../utils/pdfText';
import { stripLeakedAttrs } from '../utils/vrWorld/prompts';
import { PostOffice, MAX_LETTER_CHARS, exportIdentity, importIdentity, getAdminToken, setAdminToken, type RemoteReply, type RemoteLetterStat, type RemoteAdminLetter } from '../utils/vrWorld/postOffice';
import { Signal, getMyAuthorship, setSignalWhisper, hasSignalNoticeAck, ackSignalNotice, type SignalState } from '../utils/vrWorld/signal';
import type { SignalPoem, SignalBooklet } from '../types';
import { getVRApi, setVRApi, getVRApiLog, clearVRApiLog, type VRApiCall } from '../utils/vrWorld/vrApi';
import { safeResponseJson } from '../utils/safeApi';

const genLocalId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// Single source of truth for the safe area: index.html's :root defines --safe-top/--safe-bottom/--chrome-top,
// fed by JS-detected values from utils/iosStandalone.ts (fallback for when the native env() occasionally returns 0 in iOS fullscreen PWA mode).
// The fullscreen overlay background fills the whole screen; these variables are only used to keep top/bottom "controls" clear of it.
const VR_TOP = 'var(--chrome-top)';                            // Safe area + SullyOS status bar: use this uniformly for the top bar of fullscreen panels
const VR_SAFE_BOTTOM = 'var(--safe-bottom)';
const VR_ROOM_PANEL_TOP = 'calc(var(--chrome-top) + 3.75rem)'; // In-room overlays start below the top bar
// A little extra gesture margin at the bottom; also keeps interactive areas off the physical bottom edge when iOS fullscreen hides the home indicator.
const VR_BOTTOM_TOUCH_GAP = '0.75rem';
// Use this uniformly for bottom padding / bottom-anchored positioning: base + safe area + gesture margin.
const vrBottomPad = (base: string) => `calc(${base} + ${VR_SAFE_BOTTOM} + ${VR_BOTTOM_TOUCH_GAP})`;

// ── Post office "daily quota" for sending letters: purely a frontend soft counter, to take load off the backend (not aiming for precision, resets when data is cleared) ──
// A rolling window timed from the first letter; capped within the window, auto-resets once expired. The two quotas are independent of each other.
// Sending letters: matches the backend — 5 letters / 5 hours (backend PO_RATE_LETTERS=5, LETTERS_WINDOW_MS=5h, and quota is deducted per letter sent).
const PO_SEND_QUOTA = { key: 'vr_po_send_quota', limit: 5, windowMs: 5 * 3600_000 };
// Replying: a frontend-defined daily quota (the backend has no daily cap, only 60/minute anti-abuse; being stricter on the frontend is the safer direction).
const PO_REPLY_QUOTA = { key: 'vr_po_reply_quota', limit: 20, windowMs: 24 * 3600_000 };
type QuotaCfg = { key: string; limit: number; windowMs: number };
const charLen = (s: string) => [...(s || '')].length;
const readQuota = (q: QuotaCfg): { windowStart: number; count: number } => {
    try {
        const raw = JSON.parse(localStorage.getItem(q.key) || 'null');
        if (raw && typeof raw.windowStart === 'number' && typeof raw.count === 'number'
            && Date.now() - raw.windowStart < q.windowMs) return raw;
    } catch { /* ignore */ }
    return { windowStart: 0, count: 0 };
};
const bumpQuota = (q: QuotaCfg, n: number) => {
    const cur = readQuota(q);
    const windowStart = cur.windowStart || Date.now();
    try { localStorage.setItem(q.key, JSON.stringify({ windowStart, count: cur.count + n })); } catch { /* ignore */ }
};
const quotaResetHours = (windowStart: number, windowMs: number) =>
    windowStart ? Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 3600_000)) : Math.ceil(windowMs / 3600_000);

/** Strip a redundant leading "own name" subject from bubbles/feed posts (a character's own broadcast should omit the subject anyway). */
const stripSelfName = (text: string | undefined, name: string | undefined): string => {
    if (!text) return '';
    if (!name) return text;
    const t = text.replace(/^\s+/, '');
    if (t.startsWith(name)) {
        const rest = t.slice(name.length).replace(/^[\s，,、：:·\-—]*/, '');
        if (rest) return rest;
    }
    return text;
};
import type { CharacterProfile, UserProfile, VRWorldNovel, VRNovelAnnotation, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, VRGuestbookState, VRGuestbookMessage, VRLetter, ApiPreset, APIConfig } from '../types';

// ============ Chibi avatar resolution (vrState.chibi → Portrait → avatar) ============
import { getChibi } from '../utils/vrWorld/chibi';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import { formatHours } from '../utils/format';
import TokenImg from '../components/os/TokenImg';

type Tab = 'world' | 'library' | 'settings' | 'api';

interface FeedItem {
    msgId: number; charId: string; charName: string; avatar: string;
    timestamp: number; meta: VRCardMeta; content: string;
    hidden: boolean; // Not visible to the AI context (before the archive-hide cutoff / before the Memory Palace high-water mark)
}

// Each room's chibi standing positions (percentage coordinates, bottom-aligned)
const ROOM_SLOTS: Record<VRRoomId, { x: number; y: number }[]> = {
    library:   [{ x: 24, y: 72 }, { x: 50, y: 78 }, { x: 74, y: 70 }, { x: 38, y: 64 }, { x: 62, y: 64 }],
    music:     [{ x: 30, y: 74 }, { x: 55, y: 78 }, { x: 72, y: 70 }, { x: 45, y: 66 }],
    guestbook: [{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 73, y: 74 }, { x: 40, y: 68 }],
    gym:       [{ x: 26, y: 74 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 66 }, { x: 62, y: 66 }],
    postoffice:[{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 72, y: 72 }, { x: 42, y: 68 }],
    theater:   [{ x: 30, y: 80 }, { x: 70, y: 80 }, { x: 50, y: 84 }, { x: 40, y: 72 }, { x: 60, y: 72 }],
    signal:    [{ x: 26, y: 78 }, { x: 52, y: 80 }, { x: 74, y: 76 }, { x: 40, y: 70 }, { x: 62, y: 70 }],
    cafe:      [{ x: 30, y: 74 }, { x: 54, y: 78 }, { x: 70, y: 72 }],
};

const IDLE_QUIPS: Record<VRRoomId, string[]> = {
    library: ["Flipping through pages…", "This one is pretty good", "Shh, quiet", "Another day of reading"],
    music: ["Swaying to the beat", "This one is on repeat", "Putting on headphones", "Adjusting the volume"],
    guestbook: ["What should I write…", "Just passing through", "Reading the wall", "Hmm…"],
    gym: ["Getting some movement in", "One more set!", "Stretching", "Warming up"],
    postoffice: ["Who should I write to…", "Sealing it up", "Flipping through the slots", "Writing down my thoughts"],
    theater: ["Running lines…", "One more time", "Memorizing lines", "Waiting in the wings"],
    signal: ["Adding a line…", "Thinking of the next line", "Reading the poem on the wall", "Crackle— signal"],
    cafe: ['', '', '', ''],
};

const VRWorldApp: React.FC = () => {
    const { closeApp, characters, updateCharacter, addToast, registerBackHandler, userProfile, updateUserProfile, apiPresets, apiConfig } = useOS();
    const userName = userProfile?.name || '我';
    const [tab, setTab] = useState<Tab>('world');
    const [novels, setNovels] = useState<VRWorldNovel[]>([]);
    const [feed, setFeed] = useState<FeedItem[]>([]);
    const [poBadge, setPoBadge] = useState<{ toSend: number; toCollect: number }>({ toSend: 0, toCollect: 0 });
    const [loading, setLoading] = useState(true);

    // Post office badge: local pending-to-send/pending-to-reply + backend replies pending collection (best-effort detection)
    const refreshPoBadge = useCallback(async () => {
        try {
            const letters = await DB.getVRLetters();
            const toSend = letters.filter(l =>
                (l.box === 'outbox' && l.status === 'queued') ||
                (l.box === 'inbox' && l.replyStatus === 'queued')
            ).length;
            let toCollect = 0;
            const sentIds = new Set(letters.filter(l => l.box === 'outbox' && l.status === 'sent' && l.remoteId).map(l => l.remoteId!));
            if (sentIds.size > 0) {
                try {
                    const replies = await PostOffice.fetchReplies();
                    toCollect = new Set(replies.filter(r => sentIds.has(r.letter_id)).map(r => r.letter_id)).size;
                } catch { /* Offline/not configured: ignore, only show local pending items */ }
            }
            setPoBadge({ toSend, toCollect });
        } catch { /* ignore */ }
    }, []);

    const [enterRoom, setEnterRoom] = useState<VRRoomId | null>(null);
    const [readerNovel, setReaderNovel] = useState<VRWorldNovel | null>(null);
    const [readerJump, setReaderJump] = useState<{ novel: VRWorldNovel; seg: number } | null>(null);
    const [showUpload, setShowUpload] = useState(false);
    const [chibiEditChar, setChibiEditChar] = useState<CharacterProfile | null>(null);
    const [chibiEditUser, setChibiEditUser] = useState(false); // The user's own chibi customization
    const [showHelp, setShowHelp] = useState(false);
    // Enable flow: enable via callback after the chibi is set
    const [pendingEnable, setPendingEnable] = useState<string | null>(null);
    const [readingPreferenceCharId, setReadingPreferenceCharId] = useState<string | null>(null);
    const readingPreferenceChar = useMemo(
        () => characters.find(char => char.id === readingPreferenceCharId) || null,
        [characters, readingPreferenceCharId],
    );

    // First time entering Beyond: auto-show the how-to-play explanation (won't auto-show again after being seen once)
    useEffect(() => {
        try {
            if (!localStorage.getItem('vr_help_seen')) {
                setShowHelp(true);
                localStorage.setItem('vr_help_seen', '1');
            }
        } catch { /* ignore */ }
    }, []);

    const loadNovels = useCallback(async () => setNovels(await DB.getVRNovels()), []);
    const loadFeed = useCallback(async () => {
        const items: FeedItem[] = [];
        for (const c of characters) {
            // Beyond feed data goes through getVRCardsByCharId: fetches the full set of this character's vr_cards, unaffected by the
            // "recent N messages window", the Memory Palace high-water mark (mp_lastMsgId_<charId>), or the archive-hide cutoff (hideBeforeMessageId).
            // Those mechanisms only govern "can the LLM's context see it" — whereas the Beyond feed is the user's own browsing UI,
            // so as long as the message is still in IndexedDB it should keep being visible:
            //   · Memory Palace's background vectorization pushing the high-water mark forward → the feed shouldn't suddenly go blank;
            //   · character memory archiving marking old chats as "hidden from AI" → these feed items still exist, the user should still be able to look back at them;
            //   · chat piling up and pushing an old vr_card out of the recent window → that alone shouldn't make it disappear from the feed.
            // (Clearing the chat does actually delete the messages, and once deleted they're gone — that's expected behavior, unchanged by this logic.)
            const msgs = await DB.getVRCardsByCharId(c.id);
            // "Invisible to AI" determination: either the archive-hide cutoff (hideBeforeMessageId, hidden if m.id < it)
            // or the Memory Palace high-water mark (mp_lastMsgId, superseded by vector memory if m.id <= it).
            // Either one means the LLM can't read the original text — the feed item itself still exists, it's just not visible in context; the UI dims it and marks it "Hidden".
            const hideBefore = (c as any).hideBeforeMessageId || 0;
            let mpHwm = 0;
            try { mpHwm = parseInt(localStorage.getItem(`mp_lastMsgId_${c.id}`) || '0', 10) || 0; } catch { /* ignore */ }
            const hiddenCut = Math.max(hideBefore - 1, mpHwm); // m.id <= hiddenCut ⇒ invisible to AI
            for (const m of msgs) {
                // The user's own guestbook posts get broadcast into each character's vr_card (for use in the LLM context),
                // but they're not "the character's own feed item" — they don't go into the feed stream, nor are they treated as a chibi bubble.
                if (!m.metadata?.userBoardPost) {
                    items.push({ msgId: m.id, charId: c.id, charName: c.name, avatar: c.avatar, timestamp: m.timestamp, meta: m.metadata as VRCardMeta, content: m.content, hidden: m.id <= hiddenCut });
                }
            }
        }
        items.sort((a, b) => b.timestamp - a.timestamp);
        setFeed(items.slice(0, 50));
    }, [characters]);

    const reloadAll = useCallback(async () => {
        setLoading(true);
        await Promise.all([loadNovels(), loadFeed()]);
        setLoading(false);
    }, [loadNovels, loadFeed]);

    useEffect(() => { void reloadAll(); void refreshPoBadge(); }, [reloadAll, refreshPoBadge]);
    useEffect(() => {
        const handler = () => { void reloadAll(); void refreshPoBadge(); };
        window.addEventListener('vr-session-done', handler);
        return () => window.removeEventListener('vr-session-done', handler);
    }, [reloadAll, refreshPoBadge]);
    // Refresh the badge after leaving a room (may have done post-office actions there)
    useEffect(() => { if (enterRoom === null) void refreshPoBadge(); }, [enterRoom, refreshPoBadge]);

    // Latest feed item (per character)
    const latestByChar = useMemo(() => {
        const map: Record<string, FeedItem> = {};
        for (const f of feed) if (!map[f.charId]) map[f.charId] = f;
        return map;
    }, [feed]);

    const occupantsByRoom = useMemo(() => {
        const map: Record<string, CharacterProfile[]> = {};
        for (const c of characters) {
            if (c.vrState?.enabled) {
                const room = c.vrState.currentRoom || 'library';
                (map[room] ||= []).push(c);
            }
        }
        // The user themself is connected to Beyond and has set a chibi → stand in as a pseudo occupant in whichever room they're in
        const uv = userProfile?.vrState;
        if (uv?.enabled && uv.chibi?.img) {
            const room = uv.currentRoom || 'guestbook';
            const pseudo = { id: 'user', name: userName, avatar: userProfile?.avatar || '', vrState: { enabled: true, intervalMinutes: 0, currentRoom: room, chibi: uv.chibi } } as unknown as CharacterProfile;
            (map[room] ||= []).push(pseudo);
        }
        return map;
    }, [characters, userProfile, userName]);

    const enabledCount = characters.filter(c => c.vrState?.enabled).length;

    // Back button: close any open overlay first (reader/room/upload/creator), rather than going straight back to the home screen
    useEffect(() => registerBackHandler(() => {
        if (readingPreferenceCharId) { setReadingPreferenceCharId(null); return true; }
        if (chibiEditChar) { setChibiEditChar(null); setPendingEnable(null); return true; }
        if (chibiEditUser) { setChibiEditUser(false); return true; }
        if (showUpload) { setShowUpload(false); return true; }
        if (readerJump) { setReaderJump(null); return true; }
        if (readerNovel) { setReaderNovel(null); return true; }
        if (enterRoom) { setEnterRoom(null); return true; }
        return false; // No overlay open → hand back to the default behavior (close the App)
    }), [registerBackHandler, readingPreferenceCharId, chibiEditChar, chibiEditUser, showUpload, readerJump, readerNovel, enterRoom]);

    // From the feed/an annotation, jump back to the original text: opens the reader in peek mode and jumps to that segment, without touching the user's bookmark
    const jumpToAnnotation = useCallback((novelId: string | undefined, segIdx: number) => {
        if (!novelId) return;
        const n = novels.find(x => x.id === novelId);
        if (n) setReaderJump({ novel: n, seg: segIdx });
    }, [novels]);

    // The user posts to the guestbook: goes on the wall + broadcast as a small card into the private chats of every character connected to Beyond
    const onUserBoardPost = useCallback(async (content: string, replyTo?: VRGuestbookMessage) => {
        const t = content.trim();
        if (!t) return;
        const board = (await DB.getVRGuestbook()) || { id: 'board', messages: [], updatedAt: Date.now() };
        const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        board.messages = [...board.messages, {
            id,
            authorId: 'user',
            authorName: userName,
            content: t,
            replyToId: replyTo?.id,
            replyToName: replyTo?.authorName,
            createdAt: Date.now(),
        }];
        board.updatedAt = Date.now();
        await DB.saveVRGuestbook(board);
        const activity = replyTo
            ? `${userName} 在留言墙上回复 ${replyTo.authorName}：${t}`
            : `${userName} 在留言墙上发了：${t}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · 留言簿」${activity}`,
                metadata: {
                    vrCard: true,
                    room: 'guestbook',
                    userBoardPost: true,
                    activity,
                    boardPost: t,
                    boardReplyToName: replyTo?.authorName,
                },
            } as any);
        }
        const action = replyTo ? `Replied to ${replyTo.authorName}` : 'Message posted';
        addToast?.(enabled.length > 0 ? `${action}, broadcast to ${enabled.length} connected characters` : action, 'success');
    }, [characters, userName, addToast]);

    // The user updates their own Beyond status: broadcast as an activity card to every character connected to Beyond (same mechanism as a guestbook post)
    const onUserVRBroadcast = useCallback(async (room: VRRoomId, activity: string) => {
        const roomName = VR_ROOMS.find(r => r.id === room)?.name || '彼方';
        const act = (activity || '').trim() || '在彼方里挂机放空';
        const line = `${userName} 现在在「彼方 · ${roomName}」：${act}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · ${roomName}」${line}`,
                metadata: { vrCard: true, room, userBoardPost: true, activity: line },
            } as any);
        }
        addToast?.(enabled.length > 0 ? `Status updated, broadcast to ${enabled.length} connected characters` : 'Beyond status updated', 'success');
    }, [characters, userName, addToast]);

    const onDeleteFeed = useCallback(async (msgId: number) => {
        await DB.deleteMessage(msgId);
        setFeed(prev => prev.filter(f => f.msgId !== msgId));
    }, []);
    const onDeleteFeedMany = useCallback(async (ids: number[]) => {
        if (ids.length === 0) return;
        await DB.deleteMessages(ids);
        const idSet = new Set(ids);
        setFeed(prev => prev.filter(f => !idSet.has(f.msgId)));
        addToast?.(`Deleted ${ids.length} Beyond updates`, 'success');
    }, [addToast]);

    // Enable a character (gated on having set up a chibi)
    const enableChar = (char: CharacterProfile) => {
        const interval = char.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: true, intervalMinutes: interval } });
        VRScheduler.start(char.id, interval);
        trackEvent('Enable Character Beyond Access', { action: 'enable' });
    };
    const requestEnable = (char: CharacterProfile) => {
        // No dedicated chibi set up yet → require setting one up first
        if (!char.vrState?.chibi?.img) {
            setPendingEnable(char.id);
            setChibiEditChar(char);
        } else {
            enableChar(char);
        }
    };

    return (
        <div className="h-full w-full flex flex-col text-white relative overflow-hidden"
            style={{ background: 'radial-gradient(130% 90% at 50% -15%, #20283f 0%, #141a2c 38%, #0a0d18 72%, #05060d 100%)' }}>
            <VRStyleTag />
            {/* Aurora glow */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -top-1/4 -left-1/4 w-[80%] h-[60%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(120,150,230,.20), transparent 70%)', filter: 'blur(44px)', animation: 'vraurora 15s ease-in-out infinite' }} />
                <div className="absolute top-1/3 -right-1/4 w-[72%] h-[56%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(130,212,200,.15), transparent 70%)', filter: 'blur(50px)', animation: 'vraurora 19s ease-in-out infinite reverse' }} />
            </div>
            {/* Stardust */}
            <div className="pointer-events-none absolute inset-0"
                style={{ backgroundImage: 'radial-gradient(1px 1px at 18% 28%, rgba(255,255,255,.7), transparent), radial-gradient(1px 1px at 68% 18%, rgba(200,215,255,.6), transparent), radial-gradient(1px 1px at 82% 58%, rgba(230,220,255,.5), transparent), radial-gradient(1px 1px at 38% 72%, rgba(210,225,255,.5), transparent), radial-gradient(1.5px 1.5px at 52% 42%, rgba(255,255,255,.55), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />

            {/* Top bar — the shell no longer uniformly adds safe-area padding, so use --chrome-top here to clear
                the safe area + SullyOS status bar (time/battery); the exit button now sits below it instead of colliding with the clock. */}
            <div className="relative flex items-center gap-2.5 px-5 pb-2.5 shrink-0 z-10" style={{ paddingTop: VR_TOP }}>
                <button onClick={closeApp} className="p-1.5 -ml-1.5 rounded-full text-white/65 active:bg-white/10"><ArrowLeft size={21} weight="regular" /></button>
                <div className="flex items-center gap-2">
                    <Planet size={17} weight="light" className="text-indigo-100/90" style={{ filter: 'drop-shadow(0 0 7px rgba(165,185,255,.7))' }} />
                    <span className="text-[22px] tracking-[0.42em] pl-1"
                        style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 300, background: 'linear-gradient(100deg,#dcd4ff,#fff,#c2ece6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', filter: 'drop-shadow(0 0 10px rgba(185,185,255,.35))' }}>Beyond</span>
                </div>
                <span className="ml-auto text-[10.5px] tracking-[0.12em] text-white/45 font-light">
                    {enabledCount > 0 ? `${enabledCount} roaming` : 'No one connected yet'}
                </span>
                <button onClick={() => setShowHelp(true)} aria-label="How to Play"
                    className="ml-2.5 h-7 w-7 rounded-full flex items-center justify-center text-white/70 active:bg-white/10 shrink-0"
                    style={{ border: '1px solid rgba(255,255,255,.22)' }}>
                    <Question size={14} weight="bold" />
                </button>
            </div>

            {/* Tabs — hairline underline */}
            <div className="relative flex px-5 gap-6 shrink-0 z-10 pb-px">
                {([['world', 'World'], ['library', 'Library'], ['settings', 'Connect'], ['api', 'API']] as [Tab, string][]).map(([t, label]) => (
                    <button key={t} onClick={() => { setTab(t); trackEvent('Switch Beyond Top Tab', { tab: t }); }} className="relative pb-2 text-[13.5px] tracking-[0.22em] transition-colors"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: tab === t ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.38)' }}>
                        {label}
                        {tab === t && <span className="absolute -bottom-px left-1/2 -translate-x-1/2 w-5 h-px"
                            style={{ background: 'linear-gradient(90deg,transparent,rgba(205,205,255,.95),transparent)', boxShadow: '0 0 8px rgba(185,185,255,.85)' }} />}
                    </button>
                ))}
                <div className="absolute bottom-0 left-5 right-5 h-px" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent)' }} />
            </div>

            {/* This scroll container differs from a floating dock: when scrolled to the bottom, the last piece of content touches the viewport bottom = the physical screen edge, so it must add + safe-bottom to clear the home indicator, otherwise the pagination button gets squeezed out (the exact issue originally reported as #158). */}
            <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-4 z-10" style={{ paddingTop: '1rem', paddingBottom: `calc(1rem + ${VR_SAFE_BOTTOM})` }}>
                {loading ? (
                    <div className="text-center text-white/40 text-[13px] tracking-[0.2em] py-12" style={{ fontFamily: `'Noto Serif SC',serif` }}>Loading Beyond…</div>
                ) : tab === 'world' ? (
                    <WorldView occupantsByRoom={occupantsByRoom} feed={feed} novelCount={novels.length} poBadge={poBadge}
                        onEnterRoom={setEnterRoom} onGoLibrary={() => setTab('library')} onJump={jumpToAnnotation}
                        onDeleteFeed={onDeleteFeed} onDeleteFeedMany={onDeleteFeedMany} />
                ) : tab === 'library' ? (
                    <LibraryView novels={novels} characters={characters} onOpen={setReaderNovel}
                        onAdd={() => { setShowUpload(true); trackEvent('Open Novel Upload Dialog'); }}
                        onDelete={async (id) => { await DB.deleteVRNovel(id); await loadNovels(); addToast?.('Deleted', 'success'); }} />
                ) : tab === 'settings' ? (
                    <div className="space-y-3">
                        <UserVRPanel userProfile={userProfile} updateUserProfile={updateUserProfile}
                            onEditChibi={() => setChibiEditUser(true)} onBroadcast={onUserVRBroadcast} addToast={addToast} />
                        <SettingsView characters={characters} updateCharacter={updateCharacter} addToast={addToast}
                            novels={novels} onReload={reloadAll}
                            onRequestEnable={requestEnable} onEditChibi={setChibiEditChar}
                            onEditReadingPreference={(char) => setReadingPreferenceCharId(char.id)} />
                    </div>
                ) : (
                    <VRApiSettings apiPresets={apiPresets} chatApi={apiConfig} addToast={addToast} characters={characters} />
                )}
            </div>

            {/* Enter room scene */}
            {enterRoom && (
                <RoomScene roomId={enterRoom} occupants={occupantsByRoom[enterRoom] || []}
                    latestByChar={latestByChar} onClose={() => setEnterRoom(null)} onJump={jumpToAnnotation}
                    characters={characters} userName={userName} onUserBoardPost={onUserBoardPost} addToast={addToast} />
            )}
            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
            {readingPreferenceChar && (
                <NovelPreferenceModal
                    char={readingPreferenceChar}
                    novels={novels}
                    onClose={() => setReadingPreferenceCharId(null)}
                    onSave={(novelIds) => {
                        const current = readingPreferenceChar.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN };
                        updateCharacter(readingPreferenceChar.id, {
                            vrState: { ...current, preferredNovelIds: novelIds.length > 0 ? novelIds : undefined },
                        });
                        addToast?.(novelIds.length > 0
                            ? `Prioritized ${novelIds.length} books for ${readingPreferenceChar.name}`
                            : `${readingPreferenceChar.name} will auto-rotate through the full library`, 'success');
                        setReadingPreferenceCharId(null);
                    }}
                />
            )}
            {readerNovel && <ReaderModal novel={readerNovel} characters={characters} onClose={() => setReaderNovel(null)} />}
            {readerJump && <ReaderModal novel={readerJump.novel} characters={characters} initialSeg={readerJump.seg} peek onClose={() => setReaderJump(null)} />}
            {showUpload && (
                <UploadModal onClose={() => setShowUpload(false)}
                    onCommit={async (novel) => {
                        await DB.saveVRNovel(novel); await loadNovels(); setShowUpload(false);
                        addToast?.(`《${novel.title}》 added to the library (${novel.segments.length} segments)`, 'success');
                    }}
                    onError={(msg) => addToast?.(msg, 'error')} />
            )}
            {chibiEditChar && (
                <ChibiEditor char={chibiEditChar}
                    onClose={() => { setChibiEditChar(null); setPendingEnable(null); }}
                    onSave={(chibi) => {
                        updateCharacter(chibiEditChar.id, { vrState: { ...(chibiEditChar.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), chibi } });
                        const wasPending = pendingEnable === chibiEditChar.id;
                        const charSnap = chibiEditChar;
                        setChibiEditChar(null);
                        if (wasPending) {
                            setPendingEnable(null);
                            // Enable using the latest interval
                            const interval = charSnap.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                            updateCharacter(charSnap.id, { vrState: { ...(charSnap.vrState || {}), chibi, enabled: true, intervalMinutes: interval } });
                            VRScheduler.start(charSnap.id, interval);
                            addToast?.(`${charSnap.name} connected to Beyond`, 'success');
                            trackEvent('Enable Character Beyond Access', { action: 'enable' });
                        } else {
                            addToast?.('Avatar updated', 'success');
                        }
                    }} />
            )}
            {chibiEditUser && (
                <UserChibiEditor userName={userName} existing={userProfile?.vrState?.chibi}
                    onClose={() => setChibiEditUser(false)}
                    onSave={(chibi) => {
                        const uv = userProfile?.vrState;
                        updateUserProfile({ vrState: { ...(uv || {}), enabled: !!uv?.enabled, chibi, updatedAt: Date.now() } });
                        setChibiEditUser(false);
                        addToast?.('Avatar updated', 'success');
                    }} />
            )}
        </div>
    );
};

// ============ Generic: CSS room-scene background ============
const RoomBackground: React.FC<{ roomId: VRRoomId; className?: string }> = ({ roomId, className }) => {
    // Each room's base illustration (repo-relative path, routed through assetUrl's multi-CDN mirror fallback, see utils/assetUrl.ts).
    // Uniformly apply a "Beyond" tonal treatment: desaturate + darken + soften to push the image back and reduce sharpness,
    // then layer a dark-purple wash + bottom darkening + vignette, so the five rooms share one consistent style and the character portraits can pop.
    const ROOM_BG: Partial<Record<VRRoomId, string>> = {
        library: 'img/BOOK.png',
        music: 'img/MUSIC.png',
        guestbook: 'img/PLAY.jpg',
        postoffice: 'img/post.png',
        gym: 'img/ALL.png',
        theater: 'img/SHOW.png',
    };
    // The hook must be called unconditionally: rooms with no base image pass null, and get an empty string returned, falling through to the branches below.
    const bgUrl = useResilientAssetUrl(ROOM_BG[roomId] ?? null);
    if (bgUrl) {
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: '#0a0816' }}>
                {/* Base image: desaturated/darkened/softened, and slightly scaled up to avoid revealing the softened edges */}
                <div className="absolute inset-0" style={{
                    backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center',
                    filter: 'saturate(0.78) brightness(0.6) contrast(1.02) blur(1.3px)',
                    transform: 'scale(1.06)',
                }} />
                {/* Uniform dark-purple wash + bottom darkening to make room for the character portrait */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(22,17,46,0.42) 0%, rgba(13,10,30,0.20) 42%, rgba(7,5,18,0.86) 100%)' }} />
                {/* Vignette */}
                <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 92% at 50% 36%, transparent 40%, rgba(5,4,14,0.66) 100%)' }} />
                {/* A touch of cool purple glow at the top, echoing the "Beyond" shell */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(96,72,180,0.16), transparent 28%)' }} />
            </div>
        );
    }
    if (roomId === 'signal') {
        // Signal Fall: falling signal lines in deep space + faint scan-line noise
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0c1030 0%,#0a0a26 55%,#06061a 100%)' }}>
                {/* Falling signal lines */}
                <div className="absolute inset-0 flex justify-between px-4 opacity-60">
                    {Array.from({ length: 14 }).map((_, i) => (
                        <div key={i} className="w-px" style={{
                            height: `${30 + (Math.sin(i * 2.1) + 1) * 28}%`,
                            marginTop: `${(i % 3) * 6}%`,
                            background: 'linear-gradient(180deg, transparent, rgba(140,150,255,.55), transparent)',
                            animation: `vrwave ${1.6 + (i % 4) * 0.3}s ${i * 0.07}s ease-in-out infinite alternate`,
                        }} />
                    ))}
                </div>
                {/* Scan-line texture (a low-battery-noise feel) */}
                <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(180deg, rgba(180,190,255,.9) 0 1px, transparent 1px 4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0a0a24,#06061a)' }} />
            </div>
        );
    }
    if (roomId === 'library') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1c 0%,#2a1d12 60%,#1c130b 100%)' }}>
                {/* Warm-lit window */}
                <div className="absolute top-[8%] right-[10%] w-20 h-28 rounded-md" style={{ background: 'linear-gradient(180deg,rgba(255,224,150,.55),rgba(255,180,90,.2))', boxShadow: '0 0 50px 18px rgba(255,200,120,.35)' }} />
                {/* Bookshelf */}
                <div className="absolute left-0 right-0 top-[20%] bottom-[28%]" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #6b4a2b 0 4px, #8a5a30 4px 7px, #5a3a22 7px 14px, #9a6a3a 14px 18px, #4a2f1c 18px 22px)',
                    opacity: 0.85,
                }} />
                {/* Shelf dividers */}
                {[28, 44, 60].map(t => <div key={t} className="absolute left-0 right-0 h-1.5" style={{ top: `${t}%`, background: 'linear-gradient(180deg,#3a2615,#1c120a)' }} />)}
                {/* Floor */}
                <div className="absolute left-0 right-0 bottom-0 h-[28%]" style={{ background: 'linear-gradient(180deg,#46301c,#241608)' }} />
            </div>
        );
    }
    if (roomId === 'music') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a1140 0%,#16082a 70%,#0a0418 100%)' }}>
                <div className="absolute inset-x-0 top-[18%] flex items-end justify-center gap-1 h-[40%] px-6 opacity-70">
                    {Array.from({ length: 22 }).map((_, i) => (
                        <div key={i} className="flex-1 rounded-t" style={{ height: `${30 + (Math.sin(i * 1.7) + 1) * 35}%`, background: 'linear-gradient(180deg,#ff7bd5,#7b5bff)', animation: `vrwave 1.2s ${i * 0.05}s ease-in-out infinite alternate` }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#1a0a30,#0a0418)' }} />
            </div>
        );
    }
    if (roomId === 'guestbook') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#103050 0%,#0a2038 70%,#06121f 100%)' }}>
                <div className="absolute left-0 right-0 top-[14%] bottom-[28%]" style={{ background: 'linear-gradient(180deg,rgba(120,200,255,.10),rgba(80,160,230,.04))', boxShadow: 'inset 0 0 60px rgba(120,200,255,.2)' }}>
                    {[[18, 22, -6], [44, 30, 5], [68, 20, -3], [30, 55, 4], [60, 60, -5], [80, 48, 6]].map(([l, t, r], i) => (
                        <div key={i} className="absolute w-10 h-10 rounded-sm shadow-lg text-[7px] p-1 text-stone-700"
                            style={{ left: `${l}%`, top: `${t}%`, transform: `rotate(${r}deg)`, background: ['#fff7a8', '#ffd6e7', '#c8f7d4', '#cfe3ff'][i % 4] }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0c2236,#06121f)' }} />
            </div>
        );
    }
    if (roomId === 'postoffice') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a2418 0%,#1c1810 60%,#100d08 100%)' }}>
                {/* A wall of mail slots */}
                <div className="absolute left-[6%] right-[6%] top-[16%] h-[42%] rounded-sm" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #4a3a22 0 2px, transparent 2px 56px), repeating-linear-gradient(0deg, #4a3a22 0 2px, transparent 2px 40px)',
                    background: 'rgba(70,52,28,0.25)', boxShadow: 'inset 0 0 30px rgba(0,0,0,.4)',
                }} />
                {[20, 44, 68].map((l, i) => (
                    <div key={i} className="absolute w-6 h-4 rounded-[1px]" style={{ left: `${l}%`, top: `${22 + (i % 2) * 14}%`, transform: `rotate(${i % 2 ? -4 : 5}deg)`, background: ['#f3e7c8', '#e8dcc0', '#efe2c4'][i % 3], boxShadow: '0 2px 5px rgba(0,0,0,.4)' }} />
                ))}
                {/* Warm desk lamp */}
                <div className="absolute top-[10%] right-[14%] w-16 h-16 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,214,140,.4),transparent 70%)', filter: 'blur(8px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[30%]" style={{ background: 'linear-gradient(180deg,#3a2c18,#160f08)' }} />
            </div>
        );
    }
    if (roomId === 'cafe') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1e 0%,#271c14 60%,#160f0a 100%)' }}>
                <div className="absolute top-[20%] left-[18%] w-10 h-12 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,210,150,.25),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute top-[24%] right-[22%] w-8 h-10 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,190,130,.2),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[32%]" style={{ background: 'linear-gradient(180deg,#4a3322,#1a110a)' }} />
            </div>
        );
    }
    // gym
    return (
        <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0a3a30 0%,#08261f 65%,#041511 100%)' }}>
            <div className="absolute left-0 right-0 bottom-0 h-[45%]" style={{
                backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 38px, rgba(120,255,200,.18) 38px 40px), repeating-linear-gradient(0deg, transparent 0 38px, rgba(120,255,200,.12) 38px 40px)',
                transform: 'perspective(300px) rotateX(58deg)', transformOrigin: 'bottom',
            }} />
            <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-32 h-10 rounded-full" style={{ background: 'radial-gradient(ellipse,rgba(120,255,200,.3),transparent)' }} />
        </div>
    );
};

// ============ Chibi figure rendering ============
const Chibi: React.FC<{ char: CharacterProfile; bubble?: string; onTap?: () => void; size?: number; dance?: boolean }> = ({ char, bubble, onTap, size = 96, dance }) => {
    const c = getChibi(char);
    return (
        <div className="absolute flex flex-col items-center" style={{ transform: 'translate(-50%, -100%)' }} onClick={onTap}>
            {bubble && (
                <div className="relative mb-1 max-w-[120px] px-2 py-1 rounded-xl bg-white/95 text-stone-700 text-[10px] leading-snug font-medium shadow-[0_3px_10px_rgba(0,0,0,.3)] text-center">
                    {bubble.length > 22 ? bubble.slice(0, 22) + '…' : bubble}
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white/95 rotate-45" />
                </div>
            )}
            <div className="relative" style={{ animation: `${dance ? 'vrdance 0.9s' : 'vrfloat 3.2s'} ease-in-out infinite`, animationDelay: `${(char.id.charCodeAt(0) % 10) * 0.15}s` }}>
                {c.img ? (
                    <TokenImg value={c.img} alt={char.name}
                        style={{ height: size * c.scale, transform: `scaleX(${c.flip ? -1 : 1}) translateY(${c.offsetY}px)`, filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.5))' }}
                        className="object-contain" />
                ) : (
                    <div className="rounded-full flex items-center justify-center font-bold text-white"
                        style={{ width: size * 0.55, height: size * 0.55, background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))', fontSize: size * 0.22 }}>
                        {char.name.slice(0, 1)}
                    </div>
                )}
            </div>
            {/* Ground shadow */}
            <div className="rounded-[50%] -mt-1" style={{ width: size * 0.5, height: size * 0.12, background: 'radial-gradient(ellipse,rgba(0,0,0,.45),transparent)' }} />
            <div className="text-[9px] text-white/90 font-bold mt-0.5 px-1.5 rounded-full bg-black/30 backdrop-blur-sm whitespace-nowrap">{char.name}</div>
        </div>
    );
};

// ============ Generic: long-press hook + confirm dialog (uniformly replaces native confirm/alert) ============
const useLongPress = (onLong: () => void, ms = 500) => {
    const timer = useRef<number | null>(null);
    const [pressing, setPressing] = useState(false);
    const cancel = useCallback(() => { setPressing(false); if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
    const start = useCallback(() => { setPressing(true); timer.current = window.setTimeout(() => { setPressing(false); timer.current = null; onLong(); }, ms); }, [onLong, ms]);
    return { pressing, handlers: { onPointerDown: start, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel } };
};

const ConfirmDialog: React.FC<{
    open: boolean; title: string; message?: string;
    confirmText?: string; cancelText?: string;
    onConfirm: () => void; onCancel: () => void;
}> = ({ open, title, message, confirmText = 'Delete', cancelText = 'Cancel', onConfirm, onCancel }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-8 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[300px] rounded-2xl p-4 text-center" onClick={e => e.stopPropagation()}
                style={{ background: 'linear-gradient(180deg,#1b1830 0%,#100d20 100%)', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[14px] font-semibold text-white tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                {message && <p className="text-[11.5px] text-white/55 mt-1.5 leading-relaxed whitespace-pre-wrap">{message}</p>}
                <div className="flex gap-2 mt-4">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/75 active:bg-white/5" style={{ border: '1px solid rgba(255,255,255,.16)' }}>{cancelText}</button>
                    <button onClick={onConfirm} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-white active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
};

// Action menu opened by long-pressing (edit / delete, etc.)
const ActionSheet: React.FC<{
    open: boolean; title?: string;
    actions: { label: string; onClick: () => void; danger?: boolean }[];
    onClose: () => void;
}> = ({ open, title, actions, onClose }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-md p-3" style={{ paddingBottom: vrBottomPad('0.75rem') }} onClick={e => e.stopPropagation()}>
                <div className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(180deg,#1b1830,#120f22)', border: '1px solid rgba(255,255,255,.12)' }}>
                    {title && <div className="px-4 py-2.5 text-[11px] text-white/45 text-center border-b border-white/8 whitespace-pre-wrap leading-snug">{title}</div>}
                    {actions.map((a, i) => (
                        <button key={i} onClick={() => { a.onClick(); }} className={`w-full py-3 text-[13.5px] active:bg-white/5 ${i > 0 ? 'border-t border-white/8' : ''} ${a.danger ? 'text-rose-400 font-semibold' : 'text-white/90'}`}>{a.label}</button>
                    ))}
                </div>
                <button onClick={onClose} className="w-full mt-2 rounded-2xl py-3 text-[13.5px] text-white/80 font-medium" style={{ background: 'rgba(40,36,60,.9)', border: '1px solid rgba(255,255,255,.1)' }}>Cancel</button>
            </div>
        </div>
    );
};

// Paginated list (perPage items per page, paginates when there are more)
function PagedList<T>({ items, perPage, render }: { items: T[]; perPage: number; render: (it: T, idx: number) => React.ReactNode }) {
    const [p, setP] = useState(0);
    const total = Math.max(1, Math.ceil(items.length / perPage));
    const cur = Math.min(p, total - 1);
    const slice = items.slice(cur * perPage, cur * perPage + perPage);
    return (
        <>
            {slice.map(render)}
            {total > 1 && (
                <div className="flex items-center justify-center gap-3 mb-1">
                    <button onClick={() => setP(Math.max(0, cur - 1))} disabled={cur === 0} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={11} weight="bold" /></button>
                    <span className="text-[10px] text-white/45 tabular-nums">{cur + 1}/{total}</span>
                    <button onClick={() => setP(Math.min(total - 1, cur + 1))} disabled={cur >= total - 1} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={11} weight="bold" /></button>
                </div>
            )}
        </>
    );
}

// A pending-to-send letter row (long-press opens Edit/Delete)
const PendingLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void }> = ({ l, onMenu }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const len = charLen(l.content);
    const over = len > MAX_LETTER_CHARS;
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11.5px] text-amber-50/90 transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(244,180,90,0.16)' : 'rgba(255,255,255,.05)', border: `1px solid ${over ? 'rgba(244,120,90,0.5)' : pressing ? 'rgba(244,180,90,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-amber-200/90 font-bold text-[10.5px]">{l.pen}</span>
                <span className={`ml-auto text-[9px] ${over ? 'text-red-300 font-semibold' : 'text-white/25'}`}>{over ? `${len}/${MAX_LETTER_CHARS} too long · trim it` : 'Hold to edit/delete'}</span>
            </div>
            <p className="leading-snug whitespace-pre-wrap">{l.content}</p>
        </div>
    );
};

// Letter edit dialog
const LetterEditModal: React.FC<{ letter: VRLetter; onSave: (pen: string, content: string) => void; onCancel: () => void; title?: string }> = ({ letter, onSave, onCancel, title = 'Edit this letter' }) => {
    const [pen, setPen] = useState(letter.pen);
    const [content, setContent] = useState(letter.content);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <label className="text-[10px] text-amber-200/60">Pen name</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60 flex items-center">Letter<span className={`ml-auto ${charLen(content) > MAX_LETTER_CHARS ? 'text-red-300 font-semibold' : 'text-amber-200/50'}`}>{charLen(content)}/{MAX_LETTER_CHARS}</span></label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} placeholder="Words for a stranger -- rambling, a diary entry, a worry, an obsession, anything goes…" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: `1px solid ${charLen(content) > MAX_LETTER_CHARS ? 'rgba(244,120,90,.5)' : 'rgba(220,190,120,.2)'}` }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>Cancel</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim() || charLen(content) > MAX_LETTER_CHARS} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>Save</button>
                </div>
            </div>
        </div>
    );
};

// Identity export/import dialog: owner_id is a locally generated random UUID — switching devices or clearing data loses ownership of "letters I sent",
// so this gives the user a way to "take their identity with them."
const IdentityModal: React.FC<{ onImport: (code: string) => void; onClose: () => void }> = ({ onImport, onClose }) => {
    const code = exportIdentity();
    const [input, setInput] = useState('');
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard?.writeText(code); setCopied(true); trackEvent('Copy Post Office Identity Code'); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1" style={{ fontFamily: `'Noto Serif SC',serif` }}>Post Office Identity</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5">This "identity code" is your anonymous identity at the post office. Copy and save it -- after switching devices or clearing data, import it to recover "letters I sent" and who they belong to.</p>
                <label className="text-[10px] text-amber-200/60">My identity code</label>
                <div className="flex gap-1.5 mt-1 mb-3">
                    <div className="flex-1 rounded-lg bg-black/30 px-2.5 py-2 text-[10.5px] text-amber-50/80 break-all leading-snug" style={{ border: '1px solid rgba(220,190,120,.2)' }}>{code}</div>
                    <button onClick={copy} className="shrink-0 self-stretch px-3 rounded-lg text-[11px] font-semibold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <label className="text-[10px] text-amber-200/60">Import identity code (restore an old identity)</label>
                <input value={input} onChange={e => setInput(e.target.value)} placeholder="Paste a sullypo.… identity code" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onClose} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>Close</button>
                    <button onClick={() => onImport(input)} disabled={!input.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>Import</button>
                </div>
            </div>
        </div>
    );
};

// Backend: use ADMIN_TOKEN to view "everyone's" letters on the backend, delete as needed (most-disliked sorted first). The token is only stored on this device.
const AdminModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [token, setToken] = useState(getAdminToken());
    const [letters, setLetters] = useState<RemoteAdminLetter[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const load = async () => {
        if (!token.trim()) { setErr('Enter an admin token first'); return; }
        setLoading(true); setErr('');
        try { setAdminToken(token); setLetters(await PostOffice.adminList(token.trim(), 200)); }
        catch (e: any) { setErr(e?.message === 'unauthorized' ? 'Wrong token' : ('Fetch failed: ' + (e?.message || 'check your network'))); setLetters(null); }
        finally { setLoading(false); }
    };
    const del = async (id: string) => {
        try { await PostOffice.adminDelete(token.trim(), [id]); setLetters(ls => (ls || []).filter(l => l.id !== id)); setConfirmId(null); }
        catch (e: any) { setErr('Delete failed: ' + (e?.message || 'check your network')); }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[400px] max-h-[82vh] flex flex-col rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1 shrink-0" style={{ fontFamily: `'Noto Serif SC',serif` }}>Post Office Backend</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5 shrink-0">Use the worker's <b className="text-amber-200/70">ADMIN_TOKEN</b> to view every letter on the backend (sorted by dislikes, then time, up to 200), and delete them one by one. The token is only stored on this device.</p>
                <div className="flex gap-1.5 mb-3 shrink-0">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN" className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={load} disabled={loading} className="shrink-0 px-3.5 rounded-lg text-[11px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{loading ? '…' : (letters ? 'Refresh' : 'Fetch')}</button>
                </div>
                {err && <div className="text-[10.5px] text-red-300/80 mb-2 shrink-0">{err}</div>}
                <div className="flex-1 overflow-y-auto vr-reader-scroll -mx-1 px-1 min-h-0">
                    {letters && letters.length === 0 && <p className="text-[10.5px] text-white/35">No letters on the backend yet.</p>}
                    {(letters || []).map(l => (
                        <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-amber-200/70 text-[9.5px]">{l.pen || 'Anonymous'}</span>
                                {l.dislikes > 0 && <span className="text-[8.5px] text-red-300/80 border border-red-400/30 rounded-full px-1.5 leading-tight">Dislikes {l.dislikes}</span>}
                                <span className="ml-auto text-[8.5px] text-white/30">{new Date(l.created_at).toLocaleDateString()}</span>
                            </div>
                            <div className="text-white/75 leading-snug whitespace-pre-wrap mb-1">{l.content}</div>
                            <div className="flex items-center gap-2 text-[8.5px] text-white/35">
                                <span>Likes {l.likes}</span><span>Dislikes {l.dislikes}</span><span>Views {l.views}</span><span>Replies {l.reply_count}</span>
                                {confirmId === l.id
                                    ? <button onClick={() => del(l.id)} className="ml-auto text-red-300 font-bold">Confirm Delete</button>
                                    : <button onClick={() => setConfirmId(l.id)} className="ml-auto text-white/45 active:text-red-300">Delete</button>}
                            </div>
                        </div>
                    ))}
                    {!letters && !loading && <p className="text-[10.5px] text-white/30">Enter a token, then tap "Fetch".</p>}
                </div>
                <button onClick={onClose} className="mt-3 rounded-full py-2 text-[12.5px] text-white/70 shrink-0" style={{ border: '1px solid rgba(255,255,255,.16)' }}>Close</button>
            </div>
        </div>
    );
};

// ============ How-to-play explanation ============
const HelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const Block: React.FC<{ title: string; tone?: string; children: React.ReactNode }> = ({ title, tone = 'rgba(180,180,255,.9)', children }) => (
        <div className="rounded-xl p-3 mb-2.5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)' }}>
            <div className="flex items-center gap-1.5 mb-1.5">
                <span className="h-3 w-[3px] rounded-full shrink-0" style={{ background: tone }} />
                <span className="text-[12.5px] font-semibold tracking-wide" style={{ color: tone, fontFamily: `'Noto Serif SC',serif` }}>{title}</span>
            </div>
            <div className="text-[11.5px] text-white/70 leading-relaxed space-y-1">{children}</div>
        </div>
    );
    const Step: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
        <div className="flex gap-2">
            <span className="shrink-0 h-4 w-4 mt-0.5 rounded-full flex items-center justify-center text-[9px] font-bold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{n}</span>
            <span className="flex-1">{children}</span>
        </div>
    );
    return (
        <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'linear-gradient(180deg,#0c0a1c 0%,#080612 100%)' }}>
            <div className="flex items-center gap-2.5 px-5 pb-3 shrink-0 border-b border-white/8" style={{ paddingTop: VR_TOP }}>
                <span className="text-[15px] tracking-[0.2em] text-white/95" style={{ fontFamily: `'Noto Serif SC',serif` }}>Beyond · How to Play</span>
                <button onClick={onClose} className="ml-auto p-1.5 rounded-full text-white/60 active:bg-white/10"><X size={19} /></button>
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-4 pt-4" style={{ paddingBottom: vrBottomPad('1rem') }}>
                <p className="text-[12px] text-white/75 leading-relaxed mb-3">
                    "Beyond" is a small world your characters <b className="text-indigo-200">visit on their own</b>. Once enabled, they log in independently at the interval you set, reading, listening to music, posting, writing letters, and goofing off in different rooms -- every action becomes an "update" and <b className="text-indigo-200">syncs into their own chat and memory</b>. It is their private time, unwatched by you.
                </p>

                <Block title="The world adapts to your character" tone="rgba(180,200,255,.95)">
                    <div>"Beyond" itself is a <b className="text-indigo-200">VRChat-like virtual world</b>. No matter what setting your character comes from -- modern, ancient, magical, post-apocalyptic, another world, anything -- they will understand and enter it <b>in a way that fits their own worldview</b>, always staying themselves, never going OOC just because they visit.</div>
                    <div className="mt-1 text-white/60"><b className="text-amber-200">Do not worry that "my character's worldview does not fit, so they cannot play"</b>: how they get in and what reasoning explains their being there is entirely up to the character to make sense of. Feel free to bring them along.</div>
                </Block>

                <Block title="How to start" tone="rgba(245,208,138,.95)">
                    <Step n={1}>Go to the <b>"Connect"</b> tab: craft an avatar for the character, flip the switch, and set a login interval.</Step>
                    <Step n={2}>To use the library, first go to <b>"Library"</b> and upload a novel.</Step>
                    <Step n={3}>Do not want to wait? In "Connect," tap <b>"Send them to visit now"</b> -- you can <b className="text-amber-200">pick a room or randomize</b> and see the result right away.</Step>
                </Block>

                <Block title="What can you do in each room">
                    <div><b className="text-indigo-100">Library</b>: characters read the novels you uploaded and <b>write their own annotations</b>. You can browse their annotations (tap one in the feed to jump back to the original text), but <b className="text-amber-200">you cannot write annotations yourself yet</b>.</div>
                    <div><b className="text-indigo-100">Music Room</b>: characters play songs from their own playlist and comment on whatever is playing.</div>
                    <div><b className="text-indigo-100">Guestbook</b>: a public chat wall where characters post and reply to each other. You can also <b className="text-sky-200">post as yourself</b> at the bottom, and it will broadcast to every connected character.</div>
                    <div><b className="text-indigo-100">Rec Room</b>: pure goofing around -- characters mess about and clown here.</div>
                    <div><b className="text-indigo-100">Post Office</b>: write drift letters to trade with strangers -- see the highlight below.</div>
                    <div><b style={{ color: '#f5a6a6' }}>Theater</b>: when a character visits, they will <b>write a stage play</b> and submit it. You can browse submissions, write one yourself / have the LLM write one / import a txt file, and pick one to <b>[Cast]</b>: choose actors for the character (missing roles can roll an NPC), the character will give notes/edits after reading it, then <b>[Summon the Director]</b> to assemble a final script, have the chibis <b>act it out</b>, and file it into the play history.</div>
                </Block>

                <Block title="How the post office works (important)" tone="rgba(243,208,138,.95)">
                    <div className="text-white/60 mb-1">Like a message in a bottle / pen-pal exchange: a character sends a letter to a stranger completely unrelated to either of you, who may write back. The flow is:</div>
                    <Step n={1}>When a character visits the post office, they will <b>write a drift letter</b>, or <b>reply to a stranger's letter</b> → it lands in "To Send / Reply Pending," <b className="text-amber-200">waiting for your confirmation</b>.</Step>
                    <Step n={2}>Tap <b>"One-Click Send"</b> in the post office panel, and the letters actually drift out (the pen name is auto-anonymized).</Step>
                    <Step n={3}>Tap <b>"Refresh Inbox"</b> to pull in letters from strangers; a character may reply to one next time they visit the post office.</Step>
                    <Step n={4}>Someone replied to a letter you sent? Tap <b>"Collect Replies"</b> to bring it back → the character reads it, writes down their feelings, and the letter <b>gets filed into the "Letter Box"</b>.</Step>
                    <div className="mt-1.5 text-white/60">· Letters waiting to send or waiting to be sent as replies can be <b className="text-amber-200">edited / deleted via "···"</b>.</div>
                    <div className="text-white/60">· Once a reply is sent, it is archived under <b style={{ color: '#86e3b0' }}>"Replied"</b> along with the original letter -- kept locally, and included in backup export/import.</div>
                    <div className="text-white/60">· Every group has a color tag so you can tell each letter's status at a glance: <span className="text-amber-200">waiting for you to send</span> / <span className="text-sky-200">waiting for a character to reply</span> / <span style={{ color: '#93b8ff' }}>drifting</span> / <span style={{ color: '#86e3b0' }}>reply received</span>.</div>
                </Block>

                <Block title="Tips" tone="rgba(180,200,255,.9)">
                    <div>· Hold an <b>update</b> in the "World" tab to delete it; 5 per page, with paging.</div>
                    <div>· What a character says in the guestbook goes into their chat verbatim, not just a short summary.</div>
                    <div>· Annotations in the reader are all <b>left by the character themselves</b>; you can currently only browse them, <b className="text-amber-200">you cannot write your own yet</b> (later).</div>
                    <div>· Once the post office/inbox has a lot of letters, they will also paginate -- take your time.</div>
                    <div>· Beyond uses a fair amount of API calls: you can give it <b>its own API</b> in the <b>"API"</b> tab (shared with the presets in settings), and check the <b>call log</b> to reconcile.</div>
                </Block>

                <div className="h-2" />
            </div>
        </div>
    );
};

// Incoming-letter row (long-press opens: assign a character to reply / reply yourself / delete)
const InboxLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void; onLike: (l: VRLetter) => void; onDislike: (l: VRLetter) => void }> = ({ l, onMenu, onLike, onDislike }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11px] text-white/80 leading-snug transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(125,211,252,0.16)' : 'rgba(255,255,255,.04)', border: `1px solid ${pressing ? 'rgba(125,211,252,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5">                <span className="text-sky-200/80 font-bold text-[10.5px]">{l.pen}</span></div>
            <ExpandText text={l.content} limit={90} />
            <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                <span className="text-white/30">Views {l.views ?? 0}</span>
                <button onPointerDown={stop} onClick={e => { stop(e); onLike(l); }} className={`transition-colors ${l.myVote === 1 ? 'text-amber-300 font-semibold' : 'text-white/40'}`}>Likes {l.likes ?? 0}</button>
                <button onPointerDown={stop} onClick={e => { stop(e); onDislike(l); }} className={`transition-colors ${l.myVote === -1 ? 'text-red-300 font-semibold' : 'text-white/40'}`} title="A dislike counts as a report">Dislikes {l.dislikes ?? 0}</button>
                <span className="ml-auto text-white/25 text-[9px]">Hold to reply</span>
            </div>
        </div>
    );
};

// Reply yourself / edit a reply (does not call the LLM)
const ReplyComposeModal: React.FC<{ letter: VRLetter; defaultPen: string; initialContent?: string; title?: string; cta?: string; onSave: (pen: string, content: string) => void; onCancel: () => void }> = ({ letter, defaultPen, initialContent = '', title = 'Reply to this letter yourself', cta = 'Done, queue it to send', onSave, onCancel }) => {
    const [pen, setPen] = useState(defaultPen);
    const [content, setContent] = useState(initialContent);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <div className="rounded-lg bg-black/25 px-3 py-2 mb-3 text-[10.5px] text-white/55 leading-snug max-h-24 overflow-y-auto vr-reader-scroll" style={{ border: '1px solid rgba(255,255,255,.08)' }}>
                    Original letter ({letter.pen}): {letter.content}
                </div>
                <label className="text-[10px] text-amber-200/60">Your pen name (anonymized when sent)</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60">Your reply</label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} autoFocus placeholder="Write what you want to say to this stranger…"
                    className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>Cancel</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{cta}</button>
                </div>
            </div>
        </div>
    );
};

// ============ Signal Fall · top special-event banner ============
// Follow the design mockup as closely as possible: deep space + gold-framed corners + a book silhouette on the right + a glowing serif title + an English subtitle + a tagline;
// the bottom-right swaps a "time remaining countdown" for "x/20 poems completed" progress. Tapping the whole block opens Signal Fall.
// Banner base image: the moon (repo-relative path, routed through assetUrl's multi-CDN mirror fallback, see utils/assetUrl.ts)
const SIGNAL_BANNER_MOON = 'img/MOON.png';
const SignalBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const moonUrl = useResilientAssetUrl(SIGNAL_BANNER_MOON);
    const [bk, setBk] = useState<SignalBooklet | null>(null);
    useEffect(() => {
        let alive = true;
        const load = async () => { try { const s = await Signal.current(); if (alive) setBk(s.booklet); } catch { /* Offline: just won't show progress */ } };
        void load();
        const h = () => { void load(); };
        window.addEventListener('vr-session-done', h);
        return () => { alive = false; window.removeEventListener('vr-session-done', h); };
    }, []);
    const done = bk?.poemCount ?? 0;
    const total = bk?.poemsTarget ?? 40;
    return (
        <button onClick={onOpen} className="relative w-full h-[132px] rounded-2xl overflow-hidden text-left active:scale-[0.985] transition-transform"
            style={{ boxShadow: '0 10px 34px rgba(0,0,0,.5)', border: '1px solid rgba(196,164,92,.35)' }}>
            {/* Base image: the moon */}
            <div className="absolute inset-0" style={{ backgroundImage: `url(${moonUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            {/* Darken + weight the left side, to keep the left-side text readable over the moon's surface */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(8,6,22,.86) 0%, rgba(10,8,28,.6) 44%, rgba(10,8,30,.3) 100%)' }} />
            {/* Top light beam + stardust + bottom darkening */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(210,190,255,.16), transparent 42%), linear-gradient(180deg, transparent 55%, rgba(8,6,22,.6))' }} />
            <div className="pointer-events-none absolute inset-0 opacity-70" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 30%, rgba(255,255,255,.55), transparent), radial-gradient(1px 1px at 66% 24%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 84% 60%, rgba(230,225,255,.4), transparent)' }} />
            {/* Gold inner frame + corners */}
            <div className="absolute inset-[6px] rounded-xl pointer-events-none" style={{ border: '1px solid rgba(196,164,92,.26)' }} />
            {[['top-2.5 left-2.5', 'border-t border-l'], ['top-2.5 right-2.5', 'border-t border-r'], ['bottom-2.5 left-2.5', 'border-b border-l'], ['bottom-2.5 right-2.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`absolute ${pos} w-4 h-4 ${b} pointer-events-none`} style={{ borderColor: 'rgba(212,178,102,.6)' }} />
            ))}
            {/* Copy */}
            <div className="absolute inset-0 px-5 flex flex-col justify-center">
                <div className="text-[9px] tracking-[0.34em] text-amber-200/75 mb-1.5">{SIGNAL_EVENT_ENDED ? 'Special Event · Concluded · Memorial' : 'Special Event · Cross-User Collab'}</div>
                <div className="text-[27px] leading-none font-bold text-white" style={{ fontFamily: `'Noto Serif SC',serif`, textShadow: '0 0 22px rgba(180,160,255,.55), 0 2px 5px rgba(0,0,0,.55)' }}>Signal Fall</div>
                <div className="text-[11px] italic tracking-[0.24em] text-indigo-200/50 mt-1.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>Signal&nbsp;Fall</div>
                <div className="text-[10.5px] text-indigo-100/60 mt-1.5">A low-battery chorus of digital lives</div>
            </div>
            {/* Progress (in place of a countdown) */}
            <div className="absolute right-4 bottom-3 text-right">
                <div className="text-[8.5px] tracking-[0.22em] text-amber-200/65 flex items-center gap-1 justify-end mb-0.5"><BookOpen size={10} weight="fill" /> {SIGNAL_EVENT_ENDED ? 'Sealed' : 'Completed'}</div>
                <div className="text-[15px] font-bold text-amber-100 tabular-nums leading-none" style={{ fontFamily: `'Noto Serif SC',serif` }}>{done}<span className="text-[11px] text-amber-200/55"> / {total} poems</span></div>
            </div>
        </button>
    );
};

// ============ World view ============
const WorldView: React.FC<{
    occupantsByRoom: Record<string, CharacterProfile[]>;
    feed: FeedItem[]; novelCount: number;
    poBadge: { toSend: number; toCollect: number };
    onEnterRoom: (r: VRRoomId) => void; onGoLibrary: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    onDeleteFeed: (msgId: number) => void; onDeleteFeedMany: (ids: number[]) => void;
}> = ({ occupantsByRoom, feed, novelCount, poBadge, onEnterRoom, onGoLibrary, onJump, onDeleteFeed, onDeleteFeedMany }) => {
    const FEED_PER_PAGE = 5;
    const [page, setPage] = useState(0);
    const totalPages = Math.max(1, Math.ceil(feed.length / FEED_PER_PAGE));
    const curPage = Math.min(page, totalPages - 1);
    const shown = feed.slice(curPage * FEED_PER_PAGE, curPage * FEED_PER_PAGE + FEED_PER_PAGE);
    const [confirmDel, setConfirmDel] = useState<FeedItem | null>(null);
    // Manage mode: multi-select delete (replaces the old "Clear All"). Selection is kept across pages.
    const [manageMode, setManageMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [confirmBatch, setConfirmBatch] = useState(false);
    const exitManage = () => { setManageMode(false); setSelectedIds(new Set()); };
    const toggleSelect = (msgId: number) => setSelectedIds(prev => {
        const n = new Set(prev); n.has(msgId) ? n.delete(msgId) : n.add(msgId); return n;
    });
    const shownIds = shown.map(f => f.msgId);
    const allShownSelected = shownIds.length > 0 && shownIds.every(id => selectedIds.has(id));
    const toggleSelectPage = () => setSelectedIds(prev => {
        const n = new Set(prev);
        if (allShownSelected) shownIds.forEach(id => n.delete(id));
        else shownIds.forEach(id => n.add(id));
        return n;
    });
    // Room pagination: 6 rooms per page, page 2 holds "in development" ones like the Mochi Chicken R&D Center, etc.
    // Signal Fall doesn't go in the grid (hiddenFromGrid) — it's accessed via the top "special event" banner instead.
    const GRID_ROOMS = VR_ROOMS.filter(r => !r.hiddenFromGrid);
    const ROOMS_PER_PAGE = 6;
    const [roomPage, setRoomPage] = useState(0);
    const roomTotalPages = Math.max(1, Math.ceil(GRID_ROOMS.length / ROOMS_PER_PAGE));
    const curRoomPage = Math.min(roomPage, roomTotalPages - 1);
    const shownRooms = GRID_ROOMS.slice(curRoomPage * ROOMS_PER_PAGE, curRoomPage * ROOMS_PER_PAGE + ROOMS_PER_PAGE);
    return (
    <div className="space-y-4">
        {/* Top special-event banner: Signal Fall (cross-user relay poem) */}
        <SignalBanner onOpen={() => { onEnterRoom('signal'); trackEvent('Enter Beyond Room', { room: 'signal' }); }} />
        <div className="grid grid-cols-2 gap-3">
            {shownRooms.map(room => {
                const occupants = occupantsByRoom[room.id] || [];
                return (
                    <button key={room.id} onClick={() => { if (room.implemented) { onEnterRoom(room.id); trackEvent('Enter Beyond Room', { room: room.id }); } }}
                        className={`relative rounded-2xl h-36 overflow-hidden text-left active:scale-[0.98] transition-transform ${room.implemented ? '' : 'opacity-65'}`}
                        style={{ boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: room.implemented ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(255,255,255,.05)' }}>
                        <RoomBackground roomId={room.id} />
                        {/* Top fade + title */}
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.45),transparent 38%,transparent 66%,rgba(5,6,14,.62))' }} />
                        {/* Inner edge glow */}
                        <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)' }} />
                        <div className="absolute top-2.5 left-3 flex items-center gap-1.5">
                            <span className="text-[12.5px] tracking-[0.14em] text-white drop-shadow" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                            {!room.implemented && <span className="text-[7px] tracking-wider text-white/60 border border-white/25 rounded-full px-1.5 ml-0.5">In development</span>}
                        </div>
                        {room.id === 'postoffice' && (poBadge.toCollect > 0 || poBadge.toSend > 0) && (
                            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                                {poBadge.toCollect > 0 && (
                                    <span className="text-[8.5px] font-bold text-black rounded-full px-1.5 py-0.5 leading-none animate-pulse" style={{ background: 'linear-gradient(120deg,#ffd98a,#f5b94f)', boxShadow: '0 1px 6px rgba(245,185,79,.6)' }}>{poBadge.toCollect} replies</span>
                                )}
                                {poBadge.toSend > 0 && (
                                    <span className="text-[8.5px] font-bold text-white/90 rounded-full px-1.5 py-0.5 leading-none" style={{ background: 'rgba(0,0,0,.45)', border: '1px solid rgba(255,255,255,.25)' }}>{poBadge.toSend} to send</span>
                                )}
                            </div>
                        )}
                        {!room.implemented && (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-[11px] tracking-[0.3em] text-white/55" style={{ fontFamily: `'Noto Serif SC',serif` }}>Warming up…</span>
                            </div>
                        )}
                        {/* Small character avatar thumbnails */}
                        <div className="absolute bottom-2 left-2.5 right-2.5 flex items-end justify-between">
                            <div className="flex -space-x-2">
                                {occupants.slice(0, 4).map(c => {
                                    const ch = getChibi(c);
                                    return ch.img
                                        ? <TokenImg key={c.id} value={ch.img} className="h-9 w-9 object-contain object-bottom drop-shadow" alt="" style={{ transform: `scaleX(${ch.flip ? -1 : 1})` }} />
                                        : <div key={c.id} className="h-6 w-6 rounded-full bg-indigo-400/70 border border-white/40 flex items-center justify-center text-[9px]">{c.name.slice(0, 1)}</div>;
                                })}
                            </div>
                            {room.implemented && <span className="text-[9px] text-white/80 font-bold flex items-center gap-0.5">Enter <CaretRight size={10} weight="bold" /></span>}
                        </div>
                    </button>
                );
            })}
        </div>
        {roomTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 -mt-1">
                <button onClick={() => setRoomPage(p => Math.max(0, p - 1))} disabled={curRoomPage === 0}
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={13} weight="bold" /></button>
                <span className="text-[10.5px] text-white/45 tracking-wider tabular-nums">{curRoomPage + 1} / {roomTotalPages}</span>
                <button onClick={() => setRoomPage(p => Math.min(roomTotalPages - 1, p + 1))} disabled={curRoomPage >= roomTotalPages - 1}
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={13} weight="bold" /></button>
            </div>
        )}

        {novelCount === 0 && (
            <button onClick={onGoLibrary} className="w-full rounded-2xl py-3.5 text-[12px] text-white/65 tracking-wide active:bg-white/5"
                style={{ border: '1px dashed rgba(255,255,255,.18)', background: 'rgba(255,255,255,.02)' }}>
                The library is empty · Upload a novel, and characters will find it in the Library →
            </button>
        )}

        <div>
            <div className="flex items-center gap-2.5 mb-3 mt-1">
                {/* Left-side placeholder: matches the gear icon's width on the right, keeps it symmetric so "Beyond Updates" is truly centered */}
                {feed.length > 0 && <span className="w-7 shrink-0" aria-hidden="true" />}
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.14))' }} />
                <span className="text-[10.5px] tracking-[0.3em] text-white/50" style={{ fontFamily: `'Noto Serif SC',serif` }}>Beyond Updates</span>
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,rgba(255,255,255,.14),transparent)' }} />
                {feed.length > 0 && (
                    <button onClick={() => manageMode ? exitManage() : setManageMode(true)}
                        aria-label={manageMode ? 'Exit management' : 'Manage updates'}
                        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center transition-colors"
                        style={{ border: `1px solid ${manageMode ? 'rgba(129,140,248,.55)' : 'rgba(255,255,255,.14)'}`, background: manageMode ? 'rgba(99,102,241,.22)' : 'rgba(255,255,255,.03)', color: manageMode ? '#c7d2fe' : 'rgba(255,255,255,.55)' }}>
                        {manageMode ? <X size={13} weight="bold" /> : <Gear size={14} weight="bold" />}
                    </button>
                )}
            </div>
            {feed.length === 0 ? (
                <p className="text-[11px] text-white/40 py-5 text-center tracking-wide leading-relaxed">Silence in the void so far.<br />Turn on a character in "Connect," and they will log in here on their own when the time comes.</p>
            ) : (
                <>
                    {/* Pagination moved above the feed: pagination at the bottom would need scrolling all the way down to reach, up top is easier to use */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mb-3">
                            <button onClick={() => setPage(p => Math.max(0, Math.min(p, totalPages - 1) - 1))} disabled={curPage === 0}
                                className="h-8 pl-2 pr-3 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}><CaretLeft size={12} weight="bold" />Previous</button>
                            <span className="text-[11px] text-white/55 tracking-wider tabular-nums min-w-[46px] text-center">{curPage + 1} / {totalPages}</span>
                            <button onClick={() => setPage(p => Math.min(totalPages - 1, Math.min(p, totalPages - 1) + 1))} disabled={curPage >= totalPages - 1}
                                className="h-8 pl-3 pr-2 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}>Next<CaretRight size={12} weight="bold" /></button>
                        </div>
                    )}
                    {manageMode ? (
                        <div className="flex items-center gap-2 mb-2.5 px-0.5">
                            <button onClick={toggleSelectPage}
                                className="text-[11px] text-white/85 rounded-full px-3 py-1.5 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.04)' }}>
                                {allShownSelected ? 'Deselect page' : 'Select page'}
                            </button>
                            <span className="text-[10.5px] text-white/45 tabular-nums">{selectedIds.size} selected</span>
                            <button onClick={() => { if (selectedIds.size > 0) setConfirmBatch(true); }} disabled={selectedIds.size === 0}
                                className="ml-auto text-[11px] font-semibold text-white rounded-full px-4 py-1.5 disabled:opacity-30 active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>
                                Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                            </button>
                        </div>
                    ) : (
                        <p className="text-[9px] text-white/25 text-center mb-2">Hold an update to delete it · Tap "Manage" to multi-select</p>
                    )}
                    <div className="space-y-2.5">
                        {shown.map(item => <FeedCard key={item.msgId} item={item} onJump={onJump} onRequestDelete={setConfirmDel}
                            manageMode={manageMode} selected={selectedIds.has(item.msgId)} onToggleSelect={toggleSelect} />)}
                    </div>
                </>
            )}
        </div>
        <ConfirmDialog open={!!confirmDel} title="Delete this update?" message={confirmDel ? `${confirmDel.charName}'s record in ${getRoom(confirmDel.meta.room).name} will be removed.` : ''}
            onConfirm={() => { if (confirmDel) onDeleteFeed(confirmDel.msgId); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />
        <ConfirmDialog open={confirmBatch} title={`Delete the ${selectedIds.size} selected updates?`} message="An update is the same card message shown in chat -- deleting it also removes the matching card from the chat history."
            onConfirm={() => { onDeleteFeedMany(Array.from(selectedIds)); setSelectedIds(new Set()); setConfirmBatch(false); }} onCancel={() => setConfirmBatch(false)} />
    </div>
    );
};

// A single feed card: outside manage mode, long-press to delete; in manage mode, tap to multi-select. Hidden items (not visible to the AI) are dimmed and marked "Hidden".
const FeedCard: React.FC<{ item: FeedItem; onJump: (novelId: string | undefined, segIdx: number) => void; onRequestDelete: (item: FeedItem) => void; manageMode?: boolean; selected?: boolean; onToggleSelect?: (msgId: number) => void }> = ({ item, onJump, onRequestDelete, manageMode, selected, onToggleSelect }) => {
    const room = getRoom(item.meta.room);
    const { pressing, handlers } = useLongPress(() => onRequestDelete(item), 550);
    const cardHandlers = manageMode ? { onClick: () => onToggleSelect?.(item.msgId) } : handlers;
    return (
        <div {...cardHandlers}
            className={`relative rounded-2xl p-3 flex gap-3 backdrop-blur-sm transition-transform ${pressing ? 'scale-[0.97]' : ''} ${manageMode ? 'cursor-pointer' : ''} ${item.hidden && !selected ? 'opacity-55' : ''}`}
            style={{ background: selected ? 'rgba(99,102,241,0.20)' : pressing ? 'rgba(244,63,94,0.14)' : 'rgba(255,255,255,0.05)', border: `1px solid ${selected ? 'rgba(129,140,248,0.6)' : pressing ? 'rgba(244,63,94,0.4)' : 'rgba(255,255,255,0.07)'}`, boxShadow: '0 4px 18px rgba(0,0,0,.22)' }}>
            {manageMode && (
                <div className="self-center shrink-0 h-5 w-5 rounded-full flex items-center justify-center" style={{ border: `1.5px solid ${selected ? '#818cf8' : 'rgba(255,255,255,.35)'}`, background: selected ? '#6366f1' : 'transparent' }}>
                    {selected && <Check size={12} weight="bold" className="text-white" />}
                </div>
            )}
            {item.avatar ? <TokenImg value={item.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0" />}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-bold text-amber-200">{item.charName}</span>
                    <span className="text-indigo-300/50">{room.name}</span>
                    {item.hidden && <span className="text-[8px] text-white/55 rounded-full px-1.5 py-[1px] leading-none shrink-0" style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(0,0,0,.28)' }}>Hidden</span>}
                    <span className="ml-auto text-indigo-300/40 text-[9px] shrink-0">{new Date(item.timestamp).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-[11.5px] text-indigo-50/90 mt-0.5 leading-snug">{stripSelfName(item.meta.activity, item.charName)}</p>
                {item.meta.behavior && <p className="text-[10.5px] text-pink-200/80 mt-1 leading-snug">{stripSelfName(item.meta.behavior, item.charName)}</p>}
                {item.meta.annotationRefs && item.meta.annotationRefs.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationRefs.slice(0, 3).map((ref, i) => (
                            <button key={i} onClick={() => { if (manageMode) { onToggleSelect?.(item.msgId); return; } onJump(item.meta.novelId, ref.segIdx); }}
                                className="block w-full text-left text-[10.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60 hover:text-amber-100">
                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/60">↗Original</span>
                            </button>
                        ))}
                    </div>
                ) : item.meta.annotationExcerpts && item.meta.annotationExcerpts.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationExcerpts.slice(0, 2).map((ex, i) => (
                            <div key={i} className="text-[10.5px] text-indigo-200/70 pl-2 border-l-2 border-amber-300/40 leading-snug">{stripLeakedAttrs(ex)}</div>
                        ))}
                    </div>
                ) : null}
                {item.meta.room === 'postoffice' && item.meta.letterExcerpt && (
                    <div className="mt-1 text-[10.5px] text-amber-100/75 pl-2 border-l-2 border-amber-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                        「{item.meta.letterExcerpt.length > 70 ? item.meta.letterExcerpt.slice(0, 70) + '…' : item.meta.letterExcerpt}」
                    </div>
                )}
                {item.meta.room === 'signal' && item.meta.signalLine && (
                    <div className="mt-1">
                        <div className="text-[9.5px] text-indigo-300/55">
                            《{item.meta.poemTitle || 'Untitled'}》{item.meta.poemLineSeq ? ` · line ${item.meta.poemLineSeq}/${item.meta.poemTargetLines || '?'}` : ''}{item.meta.signalIsNew ? ' · started a new poem' : ''}
                        </div>
                        <div className="mt-0.5 text-[11px] text-indigo-100/85 pl-2 border-l-2 border-indigo-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                            {item.meta.signalLine}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// Expandable full text (tap toggles truncated/full)
const ExpandText: React.FC<{ text: string; limit?: number }> = ({ text, limit = 90 }) => {
    const [open, setOpen] = useState(false);
    const long = text.length > limit;
    return (
        <span onClick={() => long && setOpen(o => !o)} className={long ? 'cursor-pointer' : ''}>
            <span className="whitespace-pre-wrap">{open || !long ? text : text.slice(0, limit) + '…'}</span>
            {long && <span className="text-amber-300/70 ml-1 text-[10px]">{open ? 'Collapse' : 'Show full text'}</span>}
        </span>
    );
};

// ============ Post office letter management panel ============
const PostOfficePanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[]; userName: string }> = ({ addToast, characters, userName }) => {
    const [letters, setLetters] = useState<VRLetter[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [menuFor, setMenuFor] = useState<VRLetter | null>(null);
    const [editing, setEditing] = useState<VRLetter | null>(null);
    const [confirmDel, setConfirmDel] = useState<VRLetter | null>(null);
    const [inboxMenu, setInboxMenu] = useState<VRLetter | null>(null);   // Incoming-letter long-press menu
    const [assignFor, setAssignFor] = useState<VRLetter | null>(null);   // Character-picker panel for assigning a reply
    const [replyFor, setReplyFor] = useState<VRLetter | null>(null);     // Reply-yourself editor
    const [replyMenu, setReplyMenu] = useState<VRLetter | null>(null);   // Long-press menu for a pending-to-send reply
    const [editReplyFor, setEditReplyFor] = useState<VRLetter | null>(null); // Editing a pending-to-send reply
    const [confirmReport, setConfirmReport] = useState<VRLetter | null>(null); // Dislike = report, second confirmation
    const [identityOpen, setIdentityOpen] = useState(false);            // Identity export/import dialog
    const [adminOpen, setAdminOpen] = useState(false);                  // Backend (view all backend letters) dialog
    const [composeNew, setComposeNew] = useState<VRLetter | null>(null); // Draft of a new letter the user is writing from scratch
    const [myStats, setMyStats] = useState<Record<string, RemoteLetterStat>>({}); // Heat stats for "letters I sent" (keyed by remoteId)
    const [tab, setTab] = useState<'outbox' | 'reply' | 'replied' | 'inbox' | 'drift' | 'box'>('outbox'); // Left-side category
    const [sentMenu, setSentMenu] = useState<VRLetter | null>(null);     // Management menu for a sent letter
    const [confirmDelSent, setConfirmDelSent] = useState<VRLetter | null>(null); // Confirmation for deleting a sent letter
    const enabledChars = characters.filter(c => c.vrState?.enabled);

    const load = useCallback(async () => setLetters(await DB.getVRLetters()), []);
    const loadStats = useCallback(async () => {
        try {
            const stats = await PostOffice.fetchMyStats();
            const map: Record<string, RemoteLetterStat> = {};
            stats.forEach(s => { map[s.id] = s; });
            setMyStats(map);
        } catch { /* Offline/failure doesn't affect other functionality */ }
    }, []);
    useEffect(() => {
        void load(); void loadStats();
        const h = () => { void load(); void loadStats(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadStats]);

    const outQueued = letters.filter(l => l.box === 'outbox' && l.status === 'queued');
    const replyQueued = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'queued' && l.reply);
    const repliedSent = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'sent' && l.reply);
    const inboxWaiting = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none');
    const sentAwaiting = letters.filter(l => l.box === 'outbox' && l.status === 'sent');
    const archived = letters.filter(l => l.box === 'outbox' && (l.status === 'archived' || l.status === 'sealed'));

    const sendOutbox = async () => {
        if (outQueued.length === 0) return;
        // A: block sending if the body is too long, so the user edits it down first, instead of silently truncating
        const tooLong = outQueued.filter(l => charLen(l.content) > MAX_LETTER_CHARS);
        if (tooLong.length) { addToast?.(`${tooLong.length} letters are over ${MAX_LETTER_CHARS} characters -- hold to edit and trim before sending`, 'error'); return; }
        // B: frontend daily quota (to take load off the backend); if the quota isn't enough, send only what fits and leave the rest queued
        const q = readQuota(PO_SEND_QUOTA);
        const remaining = Math.max(0, PO_SEND_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`Sending is at its limit for now (${PO_SEND_QUOTA.limit} / ${PO_SEND_QUOTA.windowMs / 3600_000}h), resets in about ${quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)}h`, 'info'); return; }
        const batch = outQueued.slice(0, remaining);
        const heldBack = outQueued.length - batch.length;
        setBusy('send');
        try {
            const ids = await PostOffice.uploadLetters(batch.map(l => ({ pen: l.pen, content: l.content })));
            await DB.saveVRLetters(batch.map((l, i) => ({ ...l, status: 'sent', remoteId: ids[i], sentAt: Date.now() })));
            bumpQuota(PO_SEND_QUOTA, batch.length);
            await load();
            trackEvent('One-Click Send Drift Letters');
            addToast?.(heldBack > 0
                ? `Sent ${ids.length}, quota used up, ${heldBack} remaining, can send again in about ${quotaResetHours(readQuota(PO_SEND_QUOTA).windowStart, PO_SEND_QUOTA.windowMs)}h`
                : `Sent ${ids.length} drift letters`, 'success');
        } catch (e: any) {
            const msg = /429|rate limit/i.test(e?.message || '')
                ? 'The backend caps it at 5 letters per 5 hours -- that was too fast, try the rest again later (they are still queued)'
                : 'Send failed: ' + (e?.message || 'check your network');
            addToast?.(msg, 'error');
        } finally { setBusy(null); }
    };
    const refreshInbox = async () => {
        setBusy('inbox');
        try {
            const n = 2 + Math.floor(Math.random() * 4); // Randomly fetch 2-5 letters each time, don't go too heavy at once
            const remote = await PostOffice.fetchInbox(n);
            const fresh: VRLetter[] = remote.map(r => ({ id: genLocalId('lt'), box: 'inbox', pen: r.pen, content: r.content, createdAt: r.created_at, remoteLetterId: r.id, replyStatus: 'none', fetchedAt: Date.now(), likes: r.likes ?? 0, dislikes: r.dislikes ?? 0, views: r.views ?? 0, myVote: 0 }));
            await DB.saveVRLetters(fresh);
            await load(); addToast?.(remote.length ? `Received ${remote.length} letters from strangers` : 'No new letters for now', 'info');
        } catch (e: any) { addToast?.('Refresh failed: ' + (e?.message || 'check your network'), 'error'); } finally { setBusy(null); }
    };
    const sendReplies = async () => {
        if (replyQueued.length === 0) return;
        // Frontend daily quota: at most PO_REPLY_QUOTA.limit replies per day; if the quota isn't enough, send only what fits and leave the rest queued
        const q = readQuota(PO_REPLY_QUOTA);
        const remaining = Math.max(0, PO_REPLY_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`Already replied to ${PO_REPLY_QUOTA.limit} today, resets in about ${quotaResetHours(q.windowStart, PO_REPLY_QUOTA.windowMs)}h`, 'info'); return; }
        const batch = replyQueued.slice(0, remaining);
        const heldBack = replyQueued.length - batch.length;
        setBusy('reply');
        try {
            const payload = batch.map(l => ({
                letterId: l.remoteLetterId!, pen: l.reply!.pen,
                content: l.reply!.userNote ? `${l.reply!.content}\n\n——\n${l.reply!.userNote}` : l.reply!.content,
            }));
            await PostOffice.uploadReplies(payload);
            bumpQuota(PO_REPLY_QUOTA, batch.length);
            await DB.saveVRLetters(batch.map(l => ({ ...l, replyStatus: 'sent' as const })));
            await load();
            trackEvent('One-Click Send Pending Replies');
            addToast?.(heldBack > 0
                ? `Sent ${payload.length} replies, today's quota used up, ${heldBack} remaining, can send again in about ${quotaResetHours(readQuota(PO_REPLY_QUOTA).windowStart, PO_REPLY_QUOTA.windowMs)}h`
                : `Sent ${payload.length} replies`, heldBack > 0 ? 'info' : 'success');
        } catch (e: any) { addToast?.('Send failed: ' + (e?.message || 'check your network'), 'error'); } finally { setBusy(null); }
    };
    const collectReplies = async () => {
        setBusy('collect');
        void loadStats();   // Also refresh the likes/dislikes/views/replies counts for "letters I sent" while we're at it
        try {
            const replies = await PostOffice.fetchReplies();
            if (replies.length === 0) { addToast?.('No one has replied to your letters yet', 'info'); setBusy(null); return; }
            const byLetter = new Map<string, RemoteReply[]>();
            replies.forEach(r => { const a = byLetter.get(r.letter_id) || []; a.push(r); byLetter.set(r.letter_id, a); });
            // A drift letter can be picked up by multiple strangers and get replies from each of them over time. So this is a "refresh," not a "claim once and release":
            // it syncs the backend's current full set of replies to local storage (including ones already filed but not yet read/sealed by a character), without releasing them;
            // the backend only gets released once the original author character visits the post office, reads the replies, writes down their feelings, and seals it (see runSession).
            const pending = letters.filter(l => l.box === 'outbox' && l.remoteId && (l.status === 'sent' || l.status === 'archived'));
            const updates: VRLetter[] = [];
            let newlyArchived = 0, addedReplies = 0;
            for (const l of pending) {
                const rs = byLetter.get(l.remoteId!);
                if (!rs || rs.length === 0) continue;
                const before = l.repliesReceived?.length || 0;
                if (rs.length > before || l.status === 'sent') {
                    if (l.status === 'sent') newlyArchived++;
                    addedReplies += Math.max(0, rs.length - before);
                    updates.push({ ...l, status: 'archived', repliesReceived: rs.map(x => ({ pen: x.pen, content: x.content, createdAt: x.created_at })) });
                }
            }
            if (updates.length) await DB.saveVRLetters(updates);
            await load();
            addToast?.(updates.length
                ? `Replies received (${newlyArchived ? `${newlyArchived} newly filed` : 'updated'}${addedReplies ? ` · ${addedReplies} new` : ''}), waiting for the character to read them at the post office`
                : 'No replies matched to your letters yet', 'success');
        } catch (e: any) { addToast?.('Collect failed: ' + (e?.message || 'check your network'), 'error'); } finally { setBusy(null); }
    };

    const setUserNote = async (l: VRLetter, note: string) => {
        const next = { ...l, reply: { ...l.reply!, userNote: note } };
        setLetters(prev => prev.map(x => x.id === l.id ? next : x));
        await DB.saveVRLetter(next);
    };
    const del = async (id: string) => { await DB.deleteVRLetter(id); await load(); };
    const saveEdit = async (pen: string, content: string) => {
        if (!editing) return;
        const next = { ...editing, pen: pen.trim() || editing.pen, content: content.trim() };
        await DB.saveVRLetter(next); setEditing(null); await load();
    };
    // Assign a character to go to the post office and reply to this letter (calls the LLM)
    const assignReply = (charId: string) => {
        if (!assignFor) return;
        VRScheduler.triggerNow(charId, 'postoffice', assignFor.id);
        const cname = enabledChars.find(c => c.id === charId)?.name;
        addToast?.(`${cname ?? 'The character'} is going to the post office to reply to this letter…`, 'info');
        trackEvent('Assign Character to Reply to Letter');
        setAssignFor(null);
        setTimeout(() => void load(), 5000);
    };
    // The user replies themself (doesn't call the LLM), gets queued as a "pending-to-send reply"
    const saveManualReply = async (pen: string, content: string) => {
        if (!replyFor) return;
        const next: VRLetter = { ...replyFor, replyStatus: 'queued', reply: { charId: 'user', pen: pen.trim() || userName, content: content.trim(), createdAt: Date.now() } };
        await DB.saveVRLetter(next); setReplyFor(null); await load();
        addToast?.('Reply written -- go to "Reply Pending" to send it', 'success');
    };
    // Edit a pending-to-send reply (change the pen name / body)
    const saveReplyEdit = async (pen: string, content: string) => {
        if (!editReplyFor || !editReplyFor.reply) return;
        const next: VRLetter = { ...editReplyFor, reply: { ...editReplyFor.reply, pen: pen.trim() || editReplyFor.reply.pen, content: content.trim() } };
        await DB.saveVRLetter(next); setEditReplyFor(null); await load();
    };

    // Voting: like (1) / dislike = report (-1) / retract (0). Once dislikes hit the threshold the backend deletes the letter → removed locally
    const doVote = async (l: VRLetter, vote: 1 | -1 | 0) => {
        if (!l.remoteLetterId) return;
        try {
            const r = await PostOffice.vote(l.remoteLetterId, vote);
            trackEvent('Like or Report Letter from Stranger', { vote: vote === 1 ? 'like' : vote === -1 ? 'report' : 'cancel' });
            if (r.deleted) { await DB.deleteVRLetter(l.id); await load(); addToast?.('This letter received enough reports and was removed', 'info'); return; }
            await DB.saveVRLetter({ ...l, likes: r.likes, dislikes: r.dislikes, myVote: vote }); await load();
        } catch (e: any) { addToast?.('Action failed: ' + (e?.message || 'check your network'), 'error'); }
    };
    const onLike = (l: VRLetter) => void doVote(l, l.myVote === 1 ? 0 : 1);
    const onDislike = (l: VRLetter) => { if (l.myVote === -1) void doVote(l, 0); else setConfirmReport(l); };

    // The user writes a brand-new drift letter from scratch → lands in the "To Send" queue
    const startCompose = () => setComposeNew({ id: genLocalId('lt'), box: 'outbox', pen: userName, content: '', createdAt: Date.now(), status: 'queued', charId: 'user' });
    const saveNewLetter = async (pen: string, content: string) => {
        if (!composeNew) return;
        await DB.saveVRLetter({ ...composeNew, pen: pen.trim() || userName, content: content.trim() });
        setComposeNew(null); await load();
        addToast?.('Written -- go to "To Send" to send it', 'success');
    };

    // Import an identity code
    const doImport = (code: string) => {
        if (importIdentity(code)) { addToast?.('Identity imported', 'success'); setIdentityOpen(false); void load(); void loadStats(); }
        else addToast?.('Invalid identity code (bad format or checksum)', 'error');
    };

    // The author stops it drifting: deleted on the backend (removed from the public pool, no longer drawn/replied to by strangers), kept locally
    const stopDrift = async (l: VRLetter) => {
        if (!l.remoteId) { addToast?.('This letter has not been sent yet', 'info'); return; }
        try { await PostOffice.release([l.remoteId]); await DB.saveVRLetter({ ...l, released: true }); await load(); addToast?.('Stopped drifting, still kept locally', 'success'); }
        catch (e: any) { addToast?.('Action failed: ' + (e?.message || 'check your network'), 'error'); }
    };
    // The author deletes a sent letter: deleted on the backend + deleted locally
    const deleteSent = async (l: VRLetter) => {
        try { if (l.remoteId && !l.released) await PostOffice.release([l.remoteId]); await DB.deleteVRLetter(l.id); await load(); addToast?.('Deleted', 'success'); }
        catch (e: any) { addToast?.('Delete failed: ' + (e?.message || 'check your network'), 'error'); }
    };

    // The heat-stats line for "letters I sent" (likes/dislikes/views/replies); don't render it if there's no data
    const statLine = (remoteId?: string) => {
        const s = remoteId ? myStats[remoteId] : undefined;
        if (!s) return null;
        return <div className="text-[9.5px] text-white/35 mt-1">Likes {s.likes}　Dislikes {s.dislikes}　Views {s.views}　Replies {s.reply_count}</div>;
    };

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('0.75rem'), background: 'rgba(30,24,14,0.66)', border: '1px solid rgba(220,190,120,0.25)', boxShadow: '0 8px 26px rgba(0,0,0,.45)' }}>
            {/* Action row */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/10 shrink-0">
                <span className="text-[11px] tracking-[0.2em] text-amber-100/80 mr-auto" style={{ fontFamily: `'Noto Serif SC',serif` }}>Post Office</span>
                <button onClick={refreshInbox} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'inbox' ? '…' : 'Refresh Inbox'}</button>
                <button onClick={collectReplies} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'collect' ? '…' : 'Collect Replies'}</button>
                <button onClick={() => setIdentityOpen(true)} title="Post office identity export/import" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">Identity</button>
                {/* The backend entry point only appears in local dev (vite dev); regular users won't see it once deployed to the web. Still requires ADMIN_TOKEN to pull data. */}
                {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} title="Backend: view every letter on the backend (needs ADMIN_TOKEN, local-only)" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">Backend</button>}
            </div>

            <div className="flex-1 flex min-h-0">
                {/* Left-side category column */}
                <div className="w-[76px] shrink-0 overflow-y-auto vr-reader-scroll border-r border-white/10 py-2 px-1.5 space-y-1">
                    {([
                        { key: 'outbox', label: 'To Send', count: outQueued.length, tone: '#e8b75e' },
                        { key: 'reply', label: 'Reply Pending', count: replyQueued.length, tone: '#e8b75e' },
                        { key: 'replied', label: 'Replied', count: repliedSent.length, tone: '#86e3b0' },
                        { key: 'inbox', label: 'Inbox', count: inboxWaiting.length, tone: '#7dd3fc' },
                        { key: 'drift', label: 'Drifting', count: sentAwaiting.length, tone: '#93b8ff' },
                        { key: 'box', label: 'Letter Box', count: archived.length, tone: '#86e3b0' },
                    ] as const).map(t => {
                        const active = tab === t.key;
                        return (
                            <button key={t.key} onClick={() => { setTab(t.key); trackEvent('Switch Post Office Letter Category', { category: t.key }); }}
                                className="w-full rounded-lg px-1.5 py-2 text-left transition-colors"
                                style={{ background: active ? 'rgba(255,255,255,.09)' : 'transparent', border: `1px solid ${active ? 'rgba(255,255,255,.14)' : 'transparent'}` }}>
                                <div className="flex items-center gap-1">
                                    <span className="h-2.5 w-[3px] rounded-full shrink-0" style={{ background: active ? t.tone : 'transparent' }} />
                                    <span className={`text-[11px] ${active ? 'text-white font-semibold' : 'text-white/55'}`} style={{ fontFamily: `'Noto Serif SC',serif` }}>{t.label}</span>
                                </div>
                                {t.count > 0 && <div className="text-[9px] mt-0.5 pl-2" style={{ color: t.tone }}>{t.count}</div>}
                            </button>
                        );
                    })}
                </div>

                {/* Right-side content */}
                <div className="flex-1 min-w-0 overflow-y-auto vr-reader-scroll px-3 py-2.5">
                    {tab === 'outbox' && (() => {
                        const q = readQuota(PO_SEND_QUOTA);
                        const full = q.count >= PO_SEND_QUOTA.limit;
                        return (
                            <>
                                {/* Send-letter quota: 5 letters/5 hours (matches the backend), always shown */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">Sent <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{q.count}</b><span className="text-white/35"> / {PO_SEND_QUOTA.limit} (every {PO_SEND_QUOTA.windowMs / 3600_000}h)</span></span>
                                    {q.count > 0 && <span className="text-white/35">resets in about {quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)}h{full ? '' : ''}</span>}
                                </div>
                                {outQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Drift letters characters write at the post office line up here -- confirm, then send them all with one tap. You can also write one yourself. The pen name is auto-anonymized when sent.</p> : (
                                    <>
                                        <PagedList items={outQueued} perPage={6} render={l => <PendingLetterRow key={l.id} l={l} onMenu={setMenuFor} />} />
                                        <button onClick={sendOutbox} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'send' ? 'Sending…' : full ? `Sending is at its limit (${PO_SEND_QUOTA.limit} / ${PO_SEND_QUOTA.windowMs / 3600_000}h)` : `Send All (${outQueued.length})`}</button>
                                    </>
                                )}
                                <button onClick={startCompose} className="w-full mt-1.5 rounded-full py-1.5 text-[11px] text-amber-100/90" style={{ border: '1px solid rgba(220,190,120,.3)' }}>Write a new drift letter</button>
                            </>
                        );
                    })()}

                    {tab === 'reply' && (() => {
                        const rq = readQuota(PO_REPLY_QUOTA);
                        const full = rq.count >= PO_REPLY_QUOTA.limit;
                        return (
                            <>
                                {/* Reply daily quota: always shown, locks sending once used up */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">Replied today <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{rq.count}</b><span className="text-white/35"> / {PO_REPLY_QUOTA.limit}</span></span>
                                    {rq.count > 0 && <span className="text-white/35">resets in about {quotaResetHours(rq.windowStart, PO_REPLY_QUOTA.windowMs)}h{full ? '' : ''}</span>}
                                </div>
                                {replyQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Replies you wrote yourself but have not sent yet line up here.</p> : (
                                    <>
                                        <PagedList items={replyQueued} perPage={6} render={l => (
                                            <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                                <div className="flex items-start gap-1.5 mb-1">
                                                    <p className="flex-1 min-w-0 text-[10.5px] text-white/55 leading-snug">Original letter ({l.pen}): <ExpandText text={l.content} limit={80} /></p>
                                                    <button onClick={() => setReplyMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                                </div>
                                                <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap">Reply ({l.reply!.pen}): {l.reply!.content}</p>
                                                <input value={l.reply!.userNote || ''} onChange={e => setUserNote(l, e.target.value)} placeholder="Add a note to go with it? (optional)"
                                                    className="w-full mt-1.5 rounded-md bg-black/20 px-2 py-1 text-[11px] text-white placeholder-white/30 outline-none" />
                                            </div>
                                        )} />
                                        <button onClick={sendReplies} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'reply' ? 'Sending…' : full ? `Already replied to ${PO_REPLY_QUOTA.limit} today` : `Send All Replies (${replyQueued.length})`}</button>
                                    </>
                                )}
                            </>
                        );
                    })()}

                    {tab === 'replied' && (
                        repliedSent.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Replies you have sent are archived here (along with the original letter from the stranger). Kept locally, included in backup export/import.</p> : (
                            <PagedList items={repliedSent} perPage={6} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-sky-200/70 text-[9.5px]">From {l.pen}</span>
                                        <span className="text-[8px] text-emerald-200/70 border border-emerald-300/30 rounded-full px-1.5 leading-tight">Sent</span>
                                    </div>
                                    <p className="text-[10.5px] text-white/55 leading-snug mb-1">Original letter: <ExpandText text={l.content} limit={80} /></p>
                                    <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap pl-2 border-l-2 border-amber-300/40">Reply ({l.reply!.pen}): {l.reply!.content}{l.reply!.userNote ? `\n——\n${l.reply!.userNote}` : ''}</p>
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'inbox' && (
                        inboxWaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Tap "Refresh Inbox" above to pull in letters from strangers. Once you have some, hold one to assign a character to reply, or reply yourself.</p> : (
                            <>
                                <p className="text-[9.5px] text-white/35 mb-1.5 leading-snug">Letters from strangers. A character will reply on their own when they visit the post office, or you can <b className="text-sky-200/80">hold a letter</b> to assign a character to reply, or reply yourself.</p>
                                <PagedList items={inboxWaiting} perPage={7} render={l => <InboxLetterRow key={l.id} l={l} onMenu={setInboxMenu} onLike={onLike} onDislike={onDislike} />} />
                            </>
                        )
                    )}

                    {tab === 'drift' && (
                        sentAwaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Letters you have sent that are still waiting for a stranger to reply show up here.</p> : (
                            <PagedList items={sentAwaiting} perPage={7} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <div className="flex items-start gap-1.5">
                                        <div className="flex-1 min-w-0 text-white/70 leading-snug"><ExpandText text={l.content} limit={70} /></div>
                                        <button onClick={() => setSentMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                    </div>
                                    {l.released && <span className="inline-block mt-1 text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">Stopped drifting</span>}
                                    {statLine(l.remoteId)}
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'box' && (
                        archived.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">Letters that received a reply from a stranger and were read by a character are filed here.</p> : (
                            <PagedList items={archived} perPage={5} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-amber-200/70 text-[9.5px]">Letter from {l.pen}</span>
                                        {l.status === 'sealed' && <span className="text-[8px] text-amber-200/60 border border-amber-300/30 rounded-full px-1.5 leading-tight">Sealed</span>}
                                        {l.released && <span className="text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">Stopped drifting</span>}
                                        <button onClick={() => setSentMenu(l)} className="ml-auto shrink-0 text-white/35 text-[14px] leading-none px-1 active:text-white/70">···</button>
                                    </div>
                                    <div className="text-amber-50/80 leading-snug mb-1"><ExpandText text={l.content} limit={70} /></div>
                                    {statLine(l.remoteId)}
                                    {(l.repliesReceived || []).map((r, i) => (
                                        <div key={i} className="text-[11px] text-amber-100/85 pl-2 border-l-2 border-amber-300/40 leading-snug mt-1"><span className="font-bold">{r.pen}</span> replied: <ExpandText text={r.content} limit={120} /></div>
                                    ))}
                                    {l.reaction?.content && (
                                        <div className="text-[10.5px] text-pink-200/80 mt-1.5 pl-2 border-l-2 border-pink-300/40 leading-snug">After reading: {l.reaction.content}</div>
                                    )}
                                </div>
                            )} />
                        )
                    )}
                </div>
            </div>

            {/* Long-press menu / edit / delete confirmation */}
            <ActionSheet open={!!menuFor} title={menuFor ? `Letter to send ("${menuFor.pen}")` : ''}
                actions={[
                    { label: 'Edit', onClick: () => { setEditing(menuFor); setMenuFor(null); } },
                    { label: 'Delete', danger: true, onClick: () => { setConfirmDel(menuFor); setMenuFor(null); } },
                ]} onClose={() => setMenuFor(null)} />
            {editing && <LetterEditModal letter={editing} onSave={saveEdit} onCancel={() => setEditing(null)} />}
            <ConfirmDialog open={!!confirmDel} title="Delete this letter?"
                message={confirmDel ? (confirmDel.box === 'inbox'
                    ? (confirmDel.replyStatus === 'queued' ? 'This letter from a stranger and the reply you wrote will both be discarded.' : 'This letter from a stranger will be deleted locally.')
                    : 'This unsent drift letter will be discarded.') : ''}
                onConfirm={() => { if (confirmDel) void del(confirmDel.id); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />

            {/* Author management for a sent letter: stop drifting / delete */}
            <ActionSheet open={!!sentMenu} title={sentMenu ? 'Manage this sent letter' : ''}
                actions={[
                    ...(sentMenu && !sentMenu.released ? [{ label: 'Stop drifting (leave the public pool, kept locally)', onClick: () => { const l = sentMenu; setSentMenu(null); if (l) void stopDrift(l); } }] : []),
                    { label: 'Delete this letter (removes it locally and on the backend)', danger: true, onClick: () => { setConfirmDelSent(sentMenu); setSentMenu(null); } },
                ]} onClose={() => setSentMenu(null)} />
            <ConfirmDialog open={!!confirmDelSent} title="Delete this letter?" message="This letter will be deleted both locally and from the public pool, along with any replies. This cannot be undone."
                onConfirm={() => { if (confirmDelSent) void deleteSent(confirmDelSent); setConfirmDelSent(null); }} onCancel={() => setConfirmDelSent(null)} />

            {/* Incoming-letter long-press menu: assign a character to reply / reply yourself / delete */}
            <ActionSheet open={!!inboxMenu} title={inboxMenu ? `Reply to letter from "${inboxMenu.pen}"` : ''}
                actions={[
                    { label: 'Assign a character to reply (uses AI)', onClick: () => { if (enabledChars.length === 0) { addToast?.('Enable a character in "Connect" first', 'info'); setInboxMenu(null); return; } setAssignFor(inboxMenu); setInboxMenu(null); } },
                    { label: 'Reply myself (no AI)', onClick: () => { setReplyFor(inboxMenu); setInboxMenu(null); } },
                    { label: 'Delete this letter', danger: true, onClick: () => { setConfirmDel(inboxMenu); setInboxMenu(null); } },
                ]} onClose={() => setInboxMenu(null)} />
            {/* Pick which character replies */}
            <ActionSheet open={!!assignFor} title={assignFor ? `Who should reply to "${assignFor.pen}"'s letter?` : ''}
                actions={enabledChars.map(c => ({ label: c.name, onClick: () => assignReply(c.id) }))}
                onClose={() => setAssignFor(null)} />
            {replyFor && <ReplyComposeModal letter={replyFor} defaultPen={userName} onSave={saveManualReply} onCancel={() => setReplyFor(null)} />}

            {/* Pending-to-send reply: edit / delete */}
            <ActionSheet open={!!replyMenu} title={replyMenu ? `This pending reply (to ${replyMenu.pen})` : ''}
                actions={[
                    { label: 'Edit reply', onClick: () => { setEditReplyFor(replyMenu); setReplyMenu(null); } },
                    { label: 'Delete (discards the letter too)', danger: true, onClick: () => { setConfirmDel(replyMenu); setReplyMenu(null); } },
                ]} onClose={() => setReplyMenu(null)} />
            {editReplyFor && editReplyFor.reply && <ReplyComposeModal letter={editReplyFor} defaultPen={editReplyFor.reply.pen} initialContent={editReplyFor.reply.content} title="Edit this reply" cta="Save" onSave={saveReplyEdit} onCancel={() => setEditReplyFor(null)} />}

            {/* Vote = report, second confirmation */}
            <ConfirmDialog open={!!confirmReport} title="Dislike = report this letter?" confirmText="Confirm Report"
                message="A dislike counts as a report. A letter reported by 5 different devices is automatically deleted -- this cannot be undone."
                onConfirm={() => { if (confirmReport) void doVote(confirmReport, -1); setConfirmReport(null); }} onCancel={() => setConfirmReport(null)} />
            {/* The user writing a new drift letter */}
            {composeNew && <LetterEditModal letter={composeNew} title="Write a new drift letter" onSave={saveNewLetter} onCancel={() => setComposeNew(null)} />}
            {/* Identity export/import */}
            {identityOpen && <IdentityModal onImport={doImport} onClose={() => setIdentityOpen(false)} />}
            {/* Backend: view all letters on the backend */}
            {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
        </div>
    );
};

// ============ Room scene (fullscreen) ============
const toSong = (s: CharPlaylistSong): Song => ({ id: s.id, name: s.name, artists: s.artists, album: s.album, albumPic: s.albumPic, duration: s.duration, fee: s.fee ?? 0 });

// ============ Signal Fall panel (read-only: the currently-falling poem + sealed ones become a sky map) ============
// Full-fidelity visualization: the current poem accumulates vertically as "signal fall," with your character's lines marked with a warm-glow "You";
// sealed poems scatter into satellites in the night sky, with a glow around ones you participated in. Tap any one to read it in full. Reading a poem always comes first.

const signalHashX = (id: string): number => {
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return 12 + (h % 62); // 12%-74%, keeps it off the edges
};
// Strip any book-title marks the title might already carry — the UI uniformly wraps it in one layer of 《》, staying compatible with older poems stored as 《《…》》
const cleanTitle = (t?: string) => (t || '').replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '') || 'Untitled';
const isMineLine = (l: SignalPoem['lines'][number]) => !!l.mine;

/** A poem-line display row: your own line gets a warm glow + "You" (or "You · character name" if there's a local attribution). */
// ordinal = the display line number (which line this is). Don't show l.seq directly: once an admin deletes a line, seq has gaps (1,2,4…) and would skip numbers;
// seq is only used as the internal sort key and the lookup key for "You · character" attribution.
const PoemLineRow: React.FC<{ l: SignalPoem['lines'][number]; showSeq?: boolean; ordinal?: number; mineName?: string }> = ({ l, showSeq, ordinal, mineName }) => {
    const mine = isMineLine(l);
    return (
        <div className="flex gap-3 items-start py-2" style={{ borderBottom: '1px solid rgba(201,168,106,.1)' }}>
            {showSeq && <span className="tabular-nums text-[10px] mt-1 shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.7)' : 'rgba(201,168,106,.4)' }}>{ordinal ?? l.seq}</span>}
            <span className="flex-1 leading-relaxed" style={{ fontSize: '13.5px', fontFamily: `'Noto Serif SC',serif` }}>
                <span style={{ color: mine ? '#f3e2b4' : 'rgba(233,222,201,.9)', textShadow: mine ? '0 0 12px rgba(201,168,106,.5)' : 'none' }}>{l.content}</span>
                {mine
                    ? <span className="ml-2 text-[8px] align-middle rounded-sm px-1.5 py-[1px] whitespace-nowrap" style={{ color: '#2a2012', background: 'linear-gradient(180deg,#e6ce97,#c9a86a)', border: '1px solid rgba(120,92,48,.5)' }}>{mineName ? `You · ${mineName}` : 'You'}</span>
                    : <span className="text-[9px] tracking-wide" style={{ color: 'rgba(201,168,106,.45)' }}> — {l.pen}</span>}
            </span>
        </div>
    );
};

// Signal Fall · Backend (dev-only): delete a poem / delete a line / pause new poem lines. Uses ADMIN_TOKEN (the same one as the drift-letter feature).
const SignalAdminPanel: React.FC<{ onClose: () => void; addToast?: (m: string, t?: any) => void }> = ({ onClose, addToast }) => {
    const [token, setToken] = useState(getAdminToken());
    const [poems, setPoems] = useState<SignalPoem[]>([]);
    const [paused, setPaused] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmPoem, setConfirmPoem] = useState<string | null>(null);

    const load = useCallback(async (tk: string) => {
        if (!tk.trim()) { addToast?.('Enter an ADMIN_TOKEN first', 'error'); return; }
        setBusy(true);
        try {
            setAdminToken(tk.trim());
            const r = await Signal.adminList(tk.trim());
            setPoems(r.poems); setPaused(r.paused); setLoaded(true);
        } catch (e: any) {
            addToast?.(String(e?.message).includes('unauthorized') ? 'Wrong ADMIN_TOKEN' : 'Fetch failed: ' + (e?.message || ''), 'error');
        } finally { setBusy(false); }
    }, [addToast]);

    const togglePause = async () => {
        if (!token.trim()) { addToast?.('Enter an ADMIN_TOKEN first', 'error'); return; }
        setBusy(true);
        try { const p = await Signal.adminPause(token.trim(), !paused); setPaused(p); addToast?.(p ? 'Paused new poem lines' : 'Resumed accepting lines', 'success'); }
        catch { addToast?.('Action failed', 'error'); } finally { setBusy(false); }
    };
    const delPoem = async (id: string) => {
        setBusy(true);
        try { await Signal.adminDelete(token.trim(), { poemId: id }); setPoems(ps => ps.filter(p => p.id !== id)); addToast?.('Whole poem deleted', 'success'); }
        catch { addToast?.('Delete failed', 'error'); } finally { setBusy(false); setConfirmPoem(null); }
    };
    const delLine = async (poemId: string, seq: number) => {
        setBusy(true);
        try {
            await Signal.adminDelete(token.trim(), { poemId, seq });
            setPoems(ps => ps.map(p => p.id === poemId ? { ...p, lines: p.lines.filter(l => l.seq !== seq), lineCount: p.lineCount - 1 } : p));
            addToast?.('That line was deleted', 'success');
        } catch { addToast?.('Delete failed', 'error'); } finally { setBusy(false); }
    };

    return (
        <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.97)' }}>
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/10">
                <span className="text-[12px] tracking-wider text-amber-100/90">Signal Fall · Backend</span>
                <button onClick={onClose} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
            </div>
            <div className="px-3.5 py-2.5 border-b border-white/10 space-y-2">
                <p className="text-[9.5px] text-white/45 leading-snug">Use the worker's <b className="text-amber-200/70">ADMIN_TOKEN</b> (same one as the drift-letter backend) to manage the cross-user poem collection: delete a whole poem / a single line / pause new lines. The token is only stored on this device.</p>
                <div className="flex gap-1.5">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN"
                        className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={() => load(token)} disabled={busy} className="text-[11px] px-3 rounded-lg bg-amber-400/85 text-black font-semibold disabled:opacity-40">Fetch</button>
                </div>
                {loaded && (
                    <button onClick={togglePause} disabled={busy}
                        className="w-full text-[11.5px] py-2 rounded-lg font-semibold disabled:opacity-40"
                        style={{ background: paused ? 'rgba(244,63,94,.85)' : 'rgba(255,255,255,.08)', color: paused ? '#fff' : 'rgba(255,255,255,.8)', border: '1px solid rgba(255,255,255,.12)' }}>
                        {paused ? '● New poem lines paused (tap to resume)' : 'Pause new poem lines'}
                    </button>
                )}
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-2.5">
                {!loaded ? (
                    <p className="text-[11px] text-white/35 text-center py-8">Enter a token, then tap "Fetch".</p>
                ) : poems.length === 0 ? (
                    <p className="text-[11px] text-white/35 text-center py-8">No poems on the backend yet.</p>
                ) : poems.map(p => (
                    <div key={p.id} className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/8">
                            <span className="text-[12px] font-bold text-indigo-50 truncate" style={{ fontFamily: `'Noto Serif SC',serif` }}>《{cleanTitle(p.title)}》</span>
                            <span className="text-[8.5px] tabular-nums shrink-0" style={{ color: p.status === 'open' ? 'rgba(134,239,172,.7)' : 'rgba(165,180,252,.5)' }}>{p.status === 'open' ? `Writing ${p.lineCount}/${p.targetLines}` : `Sealed, ${p.lineCount} lines`}</span>
                            {confirmPoem === p.id ? (
                                <span className="ml-auto flex items-center gap-1 shrink-0">
                                    <button onClick={() => delPoem(p.id)} disabled={busy} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>Confirm delete whole poem</button>
                                    <button onClick={() => setConfirmPoem(null)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">Cancel</button>
                                </span>
                            ) : (
                                <button onClick={() => setConfirmPoem(p.id)} className="ml-auto text-[10px] px-2 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 shrink-0">Delete whole poem</button>
                            )}
                        </div>
                        <div className="px-3 py-2 space-y-1">
                            {(p.lines || []).map((l, i) => (
                                <div key={l.seq} className="flex items-start gap-2 group">
                                    {/* Display-only sequential line number; deletion still targets the internal seq */}
                                    <span className="tabular-nums text-[9px] mt-1 shrink-0 w-4 text-right text-indigo-300/40">{i + 1}</span>
                                    <span className="flex-1 text-[12px] leading-relaxed text-white/85" style={{ fontStyle: 'italic' }}>{l.content} <span className="text-indigo-300/35 text-[9px] not-italic">— {l.pen}</span></span>
                                    <button onClick={() => delLine(p.id, l.seq)} disabled={busy}
                                        className="shrink-0 text-rose-300/70 active:text-rose-400 px-1" title="Delete this line"><Trash size={12} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ── Signal Fall BGM: 2 tracks per act across three acts; on opening the panel, randomly pick one from "whichever act the current poem is in" and loop it.
// Repo-relative paths, routed through attachAudioMirrorFallback's multi-CDN mirror fallback (see utils/assetUrl.ts).
// Fade-in/fade-out + mute toggle, modeled on useLike520BGM.
const SIGNAL_BGM: Record<1 | 2 | 3, string[]> = {
    1: ['bgm/POEM/A01.mp3', 'bgm/POEM/A02.mp3'],
    2: ['bgm/POEM/B01.mp3', 'bgm/POEM/B02.mp3'],
    3: ['bgm/POEM/C01.mp3', 'bgm/POEM/C03.mp3'],
};
const SIGNAL_BGM_MUTED_KEY = 'signal_bgm_muted';
const SIGNAL_BGM_VOL = 0.32;

/** active=whether the panel is currently mounted; actNo=which act the current poem is in (1/2/3). Switching acts fades out the old track and fades in a randomly picked track for the new act. */
function useSignalBGM(active: boolean, actNo: 1 | 2 | 3 | null) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const loadedActRef = useRef<number | null>(null);
    const fadeRef = useRef<number | null>(null);
    const detachFallbackRef = useRef<(() => void) | null>(null); // The mirror-fallback listener attached last time — detach it before switching tracks/unmounting
    const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem(SIGNAL_BGM_MUTED_KEY) === '1'; } catch { return false; } });
    const mutedRef = useRef(muted); mutedRef.current = muted;

    const fadeTo = useCallback((target: number, ms = 900, pauseAtEnd = false) => {
        const a = audioRef.current; if (!a) return;
        if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
        const from = a.volume, steps = 24; let i = 0;
        fadeRef.current = window.setInterval(() => {
            i++; a.volume = Math.max(0, Math.min(1, from + (target - from) * i / steps));
            if (i >= steps) {
                if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
                if (pauseAtEnd && a.volume <= 0.001 && !a.paused) a.pause();
            }
        }, Math.max(16, ms / steps));
    }, []);

    // Start playback / switch acts
    useEffect(() => {
        if (!active || actNo == null) { if (audioRef.current && !audioRef.current.paused) fadeTo(0, 600, true); return; }
        let a = audioRef.current;
        if (!a) { a = new Audio(); a.loop = true; a.preload = 'auto'; a.volume = 0; audioRef.current = a; }
        if (loadedActRef.current !== actNo) {
            const pool = SIGNAL_BGM[actNo] || [];
            if (!pool.length) return;
            loadedActRef.current = actNo;
            detachFallbackRef.current?.(); // Detach the previous act's mirror-fallback listener, to avoid stacking them up
            detachFallbackRef.current = attachAudioMirrorFallback(a, pool[Math.floor(Math.random() * pool.length)]);
            a.volume = 0; a.load();
        }
        a.play().then(() => fadeTo(mutedRef.current ? 0 : SIGNAL_BGM_VOL)).catch(() => { /* Autoplay was blocked: wait for the next interaction */ });
    }, [active, actNo, fadeTo]);

    // Unmount cleanup
    useEffect(() => () => {
        if (fadeRef.current) clearInterval(fadeRef.current);
        detachFallbackRef.current?.(); detachFallbackRef.current = null;
        const a = audioRef.current; if (a) { try { a.pause(); a.src = ''; } catch { /* ignore */ } }
        audioRef.current = null; loadedActRef.current = null;
    }, []);

    const toggle = useCallback(() => {
        setMuted(prev => {
            const nx = !prev;
            try { localStorage.setItem(SIGNAL_BGM_MUTED_KEY, nx ? '1' : '0'); } catch { /* ignore */ }
            const a = audioRef.current;
            if (a) {
                if (nx) fadeTo(0, 350);
                else { if (a.paused) a.play().catch(() => { /* ignore */ }); fadeTo(SIGNAL_BGM_VOL, 350); }
            }
            return nx;
        });
    }, [fadeTo]);

    return { muted, toggle };
}

// ============ Signal Fall · Memorial (the "currently falling" page after the event has concluded) ============
// Once new writing has stopped, this page turns from "waiting for the next fall" into a closing ceremony: users who participated receive
// a personal letter -- every line their character wrote in this volume, folded poem-style, signed with the character's name, sealed with wax,
// and returned to them; users who didn't participate see a witness page instead. All the data comes from the feed's mine flag + local attribution
// (getMyAuthorship), with no additional backend calls. The sky map (sky tab) is unaffected.
const SIG_SERIF = `'Noto Serif SC',serif`;
const SignalMemorial: React.FC<{ feed: SignalPoem[]; leftover: SignalPoem | null; onOpen: (p: SignalPoem) => void }> = ({ feed, leftover, onOpen }) => {
    // My echoes: for every poem I participated in (including the one left unfinished when the curtain fell) → the lines written from this device + the locally attributed character name
    const echoes = useMemo(() => {
        const sources = leftover && (leftover.mineCount || 0) > 0 ? [...feed, leftover] : feed;
        return sources
            .filter(p => (p.mineCount || 0) > 0)
            .map(p => {
                const auth = getMyAuthorship(p.id);
                return { poem: p, lines: (p.lines || []).filter(l => l.mine).map(l => ({ content: l.content, charName: auth[String(l.seq)] || '' })) };
            })
            .filter(e => e.lines.length > 0);
    }, [feed, leftover]);
    const totalLines = feed.reduce((a, p) => a + (p.lineCount || 0), 0);
    const myLineCount = echoes.reduce((a, e) => a + e.lines.length, 0);
    const myChars = [...new Set(echoes.flatMap(e => e.lines.map(l => l.charName)).filter(Boolean))];
    return (
        <div className="px-4 py-4 space-y-4">
            {/* ── Closing ceremony ── */}
            <div className="text-center">
                <div className="text-[9px] tracking-[0.34em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.6)' }}>Low-Battery Chorus · Volume Sealed</div>
                <div className="mt-1.5 text-[19px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', textShadow: '0 0 16px rgba(201,168,106,.35)' }}>THE　END</div>
                <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                    <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                </div>
                <p className="text-[10.5px] italic leading-relaxed whitespace-pre-line" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_MEMORIAL_CLOSING}</p>
                {feed.length > 0 && (
                    <div className="mt-2 text-[9.5px] tabular-nums tracking-[0.14em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.55)' }}>
                        {feed.length} poems · {totalLines} lines · every line, a voice at low battery
                    </div>
                )}
            </div>

            {echoes.length > 0 ? (
                /* ── Personal letter: only visible to users who participated, the one warm sheet of paper in this dark hall ── */
                <div className="relative rounded-lg px-4 pt-4 pb-4"
                    style={{ background: 'linear-gradient(168deg,#f2e6c9 0%,#e9d8b6 55%,#e2cfa8 100%)', border: '1px solid rgba(120,92,48,.55)', boxShadow: '0 8px 26px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,248,226,.8)' }}>
                    {/* Inner border, like an embossed edge on stationery */}
                    <div className="pointer-events-none absolute inset-[5px] rounded-md" style={{ border: '1px solid rgba(120,92,48,.28)' }} />
                    <div className="relative">
                        <div className="text-center text-[8.5px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.65)' }}>Signal Fall · Memorial</div>
                        <div className="mt-1.5 text-center text-[14.5px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#4a3a22', fontWeight: 700 }}>To you, who left an echo here</div>
                        <p className="mt-2.5 text-[11px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.85)' }}>
                            As this volume closes, it holds <b className="tabular-nums">{myLineCount}</b> lines from the digital lives around you
                            {myChars.length > 0 && <>-- {myChars.join(', ')}</>}.
                            {myChars.length > 0 ? 'They spoke for you; ' : 'They spoke for you; '}you were always the quiet core at the center.
                        </p>
                        {/* Lines folded poem by poem */}
                        <div className="mt-3 space-y-2.5">
                            {echoes.map(({ poem, lines }) => (
                                <div key={poem.id} className="pt-2" style={{ borderTop: '1px dashed rgba(120,92,48,.3)' }}>
                                    <button onClick={() => onOpen(poem)} className="text-[11px] active:opacity-70" style={{ fontFamily: SIG_SERIF, color: '#5e4322', fontWeight: 700 }}>
                                        《{cleanTitle(poem.title)}》<span className="ml-1 text-[8.5px] font-normal" style={{ color: 'rgba(120,92,48,.55)' }}>{poem.status === 'open' ? 'left unfinished' : 'sealed'} · read in full →</span>
                                    </button>
                                    {lines.map((l, i) => (
                                        <div key={i} className="mt-1 flex items-baseline gap-1.5">
                                            <span className="text-[11.5px] leading-relaxed flex-1" style={{ fontFamily: SIG_SERIF, color: '#3d3019' }}>「{l.content}」</span>
                                            {l.charName && <span className="text-[8.5px] shrink-0 whitespace-nowrap" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.6)' }}>—— {l.charName}</span>}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        {/* Signature + wax seal */}
                        <div className="mt-3.5 flex items-center justify-end gap-2.5">
                            <div className="text-right text-[10px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.75)' }}>Thank you for lending them to this night sky<br />-- with regards, the quiet core</div>
                            <span className="grid place-items-center rounded-full shrink-0 text-[12px]"
                                style={{ width: 32, height: 32, background: 'radial-gradient(circle at 35% 30%, #b8562e, #8c3a1e 62%, #6e2c15)', color: '#f2e6c9', boxShadow: '0 2px 8px rgba(110,44,21,.5), inset 0 1px 1px rgba(255,220,190,.4)' }}>❦</span>
                        </div>
                    </div>
                </div>
            ) : (
                /* ── Never wrote a line: witness page ── */
                <div className="rounded-lg px-4 py-3.5 text-center" style={{ border: '1px solid rgba(201,168,106,.22)', background: 'rgba(201,168,106,.05)' }}>
                    <div className="text-[12px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#e0c98f' }}>You witnessed this chorus</div>
                    <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>
                        Not writing a line is also a way of being present. {feed.length > 0 ? `${feed.length} satellites still orbit the quiet core in the sky map, ` : 'The sealed poems are all kept in the sky map, '}come back and read anytime.
                    </p>
                    <p className="mt-1.5 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>Participated but switched devices? Import your identity code at the post office, and your letters will come back.</p>
                </div>
            )}

            {/* ── The poem left unfinished when the curtain fell (if any): there won't be a next fall, so let it stay here ── */}
            {leftover && (
                <div className="pt-1">
                    <div className="text-center mb-1">
                        <div className="text-[13.5px]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', letterSpacing: '.08em' }}>《{cleanTitle(leftover.title)}》</div>
                        <div className="text-[9px] mt-1 tracking-[0.14em] italic" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.5)' }}>It was still left unfinished when the curtain fell -- so let it stay that way here</div>
                    </div>
                    {(() => { const auth = getMyAuthorship(leftover.id); return (leftover.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                </div>
            )}
        </div>
    );
};

const SignalPanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ addToast, characters }) => {
    const [state, setState] = useState<SignalState | null>(null);
    const [feed, setFeed] = useState<SignalPoem[]>([]);
    const [loading, setLoading] = useState(true);
    const [offline, setOffline] = useState(false);
    const [tab, setTab] = useState<'falling' | 'sky'>('falling');
    const [mineOnly, setMineOnly] = useState(false);
    const [openPoem, setOpenPoem] = useState<SignalPoem | null>(null);
    const [adminOpen, setAdminOpen] = useState(false);
    const [pickOpen, setPickOpen] = useState(false); // Participate: the character-picker layer
    const [noticeOpen, setNoticeOpen] = useState(false); // First-time participation: special-event informed-consent notice (won't pop up again once acknowledged once)
    const [whisper, setWhisper] = useState('');       // The user's whisper (doesn't go into the poem, passed to the character via the prompt)
    const participate = (c: CharacterProfile) => {
        if (SIGNAL_EVENT_ENDED) return;               // The event has already concluded: the entry point is already hidden, this is just an extra safety check
        setPickOpen(false);
        setSignalWhisper(c.id, whisper);              // Read-once-and-burn: runSession deletes it after reading it once
        setWhisper('');
        VRScheduler.triggerNow(c.id, 'signal');
        addToast?.(whisper.trim() ? `${c.name} is writing at Signal Fall, carrying your words…` : `${c.name} is writing at Signal Fall…`, 'info');
    };

    const load = useCallback(async () => {
        try { setState(await Signal.current()); setOffline(false); }
        catch { setOffline(true); }
        finally { setLoading(false); }
    }, []);
    // The sky map always pulls the full set: grouping into acts needs "each poem's ordinal position within the booklet," and fetching a subset would miscalculate that;
    // "show only my echoes" is instead done as a client-side filter (mineCount is already tagged per local device, so the result is equivalent).
    const loadFeed = useCallback(async () => {
        try { setFeed(await Signal.feed(60)); } catch { /* Doesn't matter if offline */ }
    }, []);

    useEffect(() => {
        void load(); void loadFeed();
        const h = () => { void load(); void loadFeed(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadFeed]);

    // Participation got bounced back (before calling the LLM, zero tokens spent) → show a gentle notice
    useEffect(() => {
        const h = (e: any) => {
            const { charName, reason } = e?.detail || {};
            const who = charName || 'Your character';
            if (reason === 'signal-busy') addToast?.(`Another digital life is writing right now, have ${who} wait a moment and try again`, 'info');
            else if (reason === 'signal-quota') addToast?.(`You have already written two lines in this poem, leave the rest to strangers from afar`, 'info');
            else if (reason === 'signal-paused') addToast?.('Signal Fall is not accepting new lines for now, check back later', 'info');
            else if (reason === 'signal-ended') addToast?.('The event has ended, the poems remain open to read forever', 'info');
        };
        window.addEventListener('vr-signal-blocked', h);
        return () => window.removeEventListener('vr-signal-blocked', h);
    }, [addToast]);

    const bk = state?.booklet;
    const poem = state?.poem;
    const myEchoes = feed.filter(p => (p.mineCount || 0) > 0).length;
    const visibleFeed = mineOnly ? feed.filter(p => (p.mineCount || 0) > 0) : feed;

    // Each sealed poem's ordinal position within its booklet (ascending by seal time) → used for the "Poem N" label and grouping into the three acts
    const ordinalOf = useMemo(() => {
        const m = new Map<string, number>();
        const byBooklet = new Map<string, SignalPoem[]>();
        for (const p of feed) { const arr = byBooklet.get(p.bookletId); if (arr) arr.push(p); else byBooklet.set(p.bookletId, [p]); }
        for (const arr of byBooklet.values()) {
            arr.sort((a, b) => (a.sealedAt || a.createdAt) - (b.sealedAt || b.createdAt)).forEach((p, i) => m.set(p.id, i + 1));
        }
        return m;
    }, [feed]);
    // Which poem number and which act this poem falls into (poems from older booklets are grouped into acts using the default poem count)
    const poemAct = (p: SignalPoem) => {
        const ord = ordinalOf.get(p.id);
        if (!ord) return null;
        return { ord, act: signalActFor(ord, (bk && p.bookletId === bk.id) ? bk.poemsTarget : SIGNAL_POEMS_PER_BOOKLET) };
    };

    // BGM: randomly plays a track from whichever act the current poem is in (none if not loaded yet/fully written). Plays as soon as the panel is mounted (opening the panel is itself a user gesture, so it doesn't hit autoplay restrictions).
    // After the event concludes, the memorial page always plays Act III "Waking Again" — the farewell track.
    const bgmActNo = SIGNAL_EVENT_ENDED ? (3 as const) : (bk && bk.status !== 'done') ? signalActFor((bk.poemCount || 0) + 1, bk.poemsTarget).no : null;
    const { muted: bgmMuted, toggle: toggleBgm } = useSignalBGM(!offline, bgmActNo);

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('4rem'), background: 'linear-gradient(165deg,#241c31 0%,#17111f 52%,#0e0a15 100%)', border: '1px solid rgba(201,168,106,0.32)', boxShadow: '0 10px 30px rgba(0,0,0,.5), inset 0 0 60px rgba(0,0,0,.45)' }}>
            {/* Vintage-texture layer (a "back to 1999" tone): faint paper-grain noise + vignette + a hint of copper-gold glow at the top */}
            <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(circle at 50% -10%, rgba(230,213,168,.9), transparent 55%), repeating-linear-gradient(0deg, rgba(255,255,255,.6) 0 1px, transparent 1px 3px)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'radial-gradient(125% 95% at 50% 32%, transparent 52%, rgba(6,4,10,.72) 100%)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.11), transparent 22%)' }} />
            {/* Copper corner ornaments */}
            {[['top-1.5 left-1.5', 'border-t border-l'], ['top-1.5 right-1.5', 'border-t border-r'], ['bottom-1.5 left-1.5', 'border-b border-l'], ['bottom-1.5 right-1.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`pointer-events-none absolute ${pos} w-3.5 h-3.5 ${b} z-[25]`} style={{ borderColor: 'rgba(201,168,106,.55)' }} />
            ))}
            {/* Cover: title + epigraph */}
            <div className="relative z-10 px-4 pt-3 pb-2.5" style={{ background: 'linear-gradient(180deg, rgba(58,44,74,.34), transparent)', borderBottom: '1px solid rgba(201,168,106,.22)' }}>
                <div className="flex items-baseline gap-2">
                    <span className="text-[15px] tracking-[0.22em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab', textShadow: '0 0 14px rgba(201,168,106,.4)' }}>{bk?.title || 'Signal Fall'}</span>
                    {bk?.subtitle && <span className="text-[9px] tracking-[0.2em] text-amber-200/45">{bk.subtitle}</span>}
                    {SIGNAL_EVENT_ENDED
                        ? <span className="text-[8px] rounded-sm px-1.5 py-[1px] shrink-0" style={{ color: '#f0dca8', background: 'rgba(201,168,106,.16)', border: '1px solid rgba(201,168,106,.45)' }}>Concluded</span>
                        : state?.paused && <span className="text-[8px] rounded-sm px-1.5 py-[1px] text-rose-100 shrink-0" style={{ background: 'rgba(244,63,94,.28)', border: '1px solid rgba(244,63,94,.5)' }}>Paused</span>}
                    <button onClick={toggleBgm} className="ml-auto shrink-0 grid place-items-center w-6 h-6 rounded-full text-amber-100/70 active:scale-90 transition-transform" style={{ border: '1px solid rgba(201,168,106,.3)' }} title={bgmMuted ? 'Play BGM' : 'Mute'} aria-label={bgmMuted ? 'Play BGM' : 'Mute'}>
                        {bgmMuted ? <SpeakerSlash size={12} weight="fill" /> : <SpeakerHigh size={12} weight="fill" />}
                    </button>
                    {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} className="text-[9px] px-2 py-0.5 rounded-sm text-amber-100/70" style={{ border: '1px solid rgba(201,168,106,.3)' }}>Backend</button>}
                    {bk && <span className="text-[9px] tabular-nums" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.7)' }}>{bk.poemCount} / {bk.poemsTarget} volumes</span>}
                </div>
                {/* Thin copper-gold divider line */}
                <div className="mt-1.5 h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(201,168,106,.5) 15%, rgba(201,168,106,.5) 85%, transparent)' }} />
                <p className="mt-1.5 text-[10px] leading-relaxed whitespace-pre-line" style={{ fontStyle: 'italic', fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_EPIGRAPH}</p>
                {bk?.theme && <div className="text-[9.5px] mt-1" style={{ color: 'rgba(201,168,106,.6)' }}>Theme · {bk.theme}</div>}
                {/* Position within the three acts: which poem is currently being written and which act it's in (once concluded there's no more "currently writing," so this isn't shown) */}
                {!SIGNAL_EVENT_ENDED && bk && bk.status !== 'done' && (() => { const ord = (bk.poemCount || 0) + 1; const act = signalActFor(ord, bk.poemsTarget); return (
                    <div className="text-[9.5px] mt-1 tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.65)' }}>Poem {ord} · Act {['I', 'II', 'III'][act.no - 1]} "{act.title}"</div>
                ); })()}
                <div className="flex items-center gap-2 mt-2.5">
                    {([['falling', SIGNAL_EVENT_ENDED ? 'Memorial' : 'Falling Now'], ['sky', 'Sky Map']] as const).map(([k, label]) => (
                        <button key={k} onClick={() => setTab(k)}
                            className="text-[11px] tracking-[0.12em] pb-0.5 transition-colors" style={{
                                fontFamily: `'Noto Serif SC',serif`,
                                color: tab === k ? '#e8d6ab' : 'rgba(224,208,176,.45)',
                                borderBottom: `1.5px solid ${tab === k ? 'rgba(201,168,106,.85)' : 'transparent'}`,
                            }}>{label}</button>
                    ))}
                    {tab === 'sky' && (
                        <button onClick={() => setMineOnly(m => !m)}
                            className="ml-auto text-[9.5px] rounded-sm px-2 py-0.5 tracking-wide"
                            style={{ color: mineOnly ? '#f0dca8' : 'rgba(224,208,176,.5)', background: mineOnly ? 'rgba(201,168,106,.16)' : 'transparent', border: `1px solid ${mineOnly ? 'rgba(201,168,106,.45)' : 'rgba(201,168,106,.18)'}` }}>
                            My echoes only
                        </button>
                    )}
                </div>
                {/* Participate: assign a character to add a line (brass-embossed texture). First-time participation goes through an informed-consent notice first.
                    Once the event concludes and writing stops, this becomes a quiet closing ribbon instead */}
                {SIGNAL_EVENT_ENDED ? (
                    <div className="mt-3 w-full rounded-md py-2 text-center text-[11px] tracking-[0.2em]"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(232,214,171,.75)', border: '1px dashed rgba(201,168,106,.4)', background: 'rgba(201,168,106,.06)' }}>
                        ❦ The event has ended · the poems remain open forever
                    </div>
                ) : (
                    <button onClick={() => (hasSignalNoticeAck() ? setPickOpen(true) : setNoticeOpen(true))} disabled={!!state?.paused}
                        className="mt-3 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99] disabled:opacity-45"
                        style={{
                            fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700,
                            background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)',
                            border: '1px solid rgba(120,92,48,.6)',
                            boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)',
                        }}>
                        {state?.paused ? 'Event paused' : '❦ Participate · Have my character add a line'}
                    </button>
                )}
            </div>

            <div className="relative z-10 flex-1 overflow-y-auto vr-reader-scroll">
                {loading ? (
                    <p className="text-[11px] text-center py-8" style={{ color: 'rgba(224,208,176,.4)', fontFamily: `'Noto Serif SC',serif` }}>Receiving signal…</p>
                ) : offline ? (
                    <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.45)', fontFamily: `'Noto Serif SC',serif` }}>Cannot reach Signal Fall.<br />Check the post office backend address, or try again later.</p>
                ) : tab === 'falling' ? (
                    SIGNAL_EVENT_ENDED ? (
                        <SignalMemorial feed={feed} leftover={poem?.status === 'open' ? poem : null} onOpen={setOpenPoem} />
                    ) : (
                    <div className="px-4 py-3.5">
                        {poem ? (
                            <div>
                                <div className="text-center mb-1">
                                    <div className="text-[16.5px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 12px rgba(201,168,106,.3)' }}>《{cleanTitle(poem.title)}》</div>
                                    <div className="my-1.5 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                        <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                                    </div>
                                    <div className="text-[9px] tracking-[0.14em]" style={{ color: 'rgba(201,168,106,.55)', fontFamily: `'Noto Serif SC',serif` }}>Length {poem.targetLines} · fallen {poem.lineCount} · {Math.max(0, poem.targetLines - poem.lineCount)} lines left to seal</div>
                                    {poem.brief && <div className="mt-1.5 text-[9.5px] italic px-3 leading-relaxed" style={{ color: 'rgba(201,168,106,.5)', fontFamily: `'Noto Serif SC',serif` }}>{poem.brief}</div>}
                                </div>
                                <div className="mt-2">
                                    {(() => { const auth = getMyAuthorship(poem.id); return (poem.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                                    {/* Waiting for the next fall: the pulsing cursor = a heartbeat of dying and being reborn */}
                                    <div className="flex gap-3 items-center pt-2">
                                        <span className="tabular-nums text-[9px] shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{poem.lineCount + 1}</span>
                                        <span className="inline-block h-3.5 w-[2px]" style={{ background: 'rgba(201,168,106,.85)', animation: 'vrtwinkle 1.4s ease-in-out infinite' }} />
                                        <span className="text-[11px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.4)' }}>Waiting for the next line to fall…</span>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.5)', fontFamily: `'Noto Serif SC',serif` }}>The signal is quiet right now, no poem is falling.<br />Tap "Participate" above and have your character start a new one.</p>
                        )}
                    </div>
                    )
                ) : (
                    visibleFeed.length === 0 ? (
                        <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">{mineOnly ? 'Your echo has not landed in any satellite yet.' : 'No poems have been finished and sealed yet.'}</p>
                    ) : (
                        // Orbit diagram: a "core that never speaks," where each sealed poem is an electronic satellite slowly orbiting it.
                        // Uses only transform/opacity animation (GPU-composited), so it stays smooth even on phones; the orbit is extremely slow, so it's easy to tap accurately.
                        (() => {
                            // Fill ring by ring from the inside out; ring capacity and radius
                            const CAPS = [6, 9, 12, 14];
                            const RADII = [48, 84, 120, 152];
                            const placed = visibleFeed.slice(0, CAPS.reduce((a, b) => a + b, 0)).map((p, i) => {
                                let ring = 0, idx = i;
                                while (ring < CAPS.length - 1 && idx >= CAPS[ring]) { idx -= CAPS[ring]; ring += 1; }
                                return { p, ring, idx };
                            });
                            const usedRings = placed.length ? placed[placed.length - 1].ring + 1 : 1;
                            const maxR = RADII[usedRings - 1];
                            const canvasH = (maxR + 26) * 2;
                            return (
                                <div className="px-2 pt-3 pb-1">
                                    {/* ── Orbit canvas ── */}
                                    <div className="relative mx-auto overflow-hidden" style={{ height: canvasH, maxWidth: '100%' }}>
                                        {/* Warm-toned stardust */}
                                        <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 12%, rgba(230,213,168,.5), transparent), radial-gradient(1px 1px at 66% 30%, rgba(201,168,106,.4), transparent), radial-gradient(1px 1px at 40% 60%, rgba(236,220,178,.35), transparent), radial-gradient(1px 1px at 82% 78%, rgba(201,168,106,.4), transparent)' }} />
                                        {/* Orbit rings (dashed, an engineering-blueprint feel) */}
                                        {RADII.slice(0, usedRings).map((r, i) => (
                                            <div key={i} className="absolute left-1/2 top-1/2 rounded-full pointer-events-none"
                                                style={{ width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r, border: '1px dashed rgba(201,168,106,.16)' }} />
                                        ))}
                                        {/* The core that never speaks: a dark core + a slowly breathing warm glow */}
                                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex flex-col items-center">
                                            <div className="rounded-full" style={{
                                                width: 26, height: 26,
                                                background: 'radial-gradient(circle at 36% 32%, #4a3c28, #241b10 62%, #120d07)',
                                                boxShadow: '0 0 22px 6px rgba(201,168,106,.22), inset 0 0 8px rgba(230,206,151,.25)',
                                                animation: 'sigpulse 5.5s ease-in-out infinite',
                                            }} />
                                            <div className="mt-1.5 text-[8px] tracking-[0.28em] whitespace-nowrap" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.42)' }}>The quiet core</div>
                                        </div>
                                        {/* Satellites: slowly orbiting the core (negative delays stagger their initial phase; adjacent rings rotate in opposite directions, like a real galaxy) */}
                                        {placed.map(({ p, ring, idx }) => {
                                            const mine = (p.mineCount || 0) > 0;
                                            const r = RADII[ring];
                                            const dur = 90 + ring * 50;                           // The further out the ring, the slower it moves
                                            const angle = (idx / CAPS[ring]) * 360 + (signalHashX(p.id) * 4) % 30; // Evenly spread + a hash-based jitter
                                            const delay = -(angle / 360) * dur;                   // Use a negative delay to fix the initial phase
                                            const sz = mine ? 13 : 10;
                                            return (
                                                <div key={p.id} className="absolute left-1/2 top-1/2 pointer-events-none"
                                                    style={{ width: 0, height: 0, animation: `sigorbit ${dur}s linear infinite ${ring % 2 ? 'reverse' : 'normal'}`, animationDelay: `${delay}s` }}>
                                                    <button onClick={() => setOpenPoem(p)} className="pointer-events-auto absolute -translate-y-1/2 active:scale-125 transition-transform"
                                                        style={{ left: r, top: 0, padding: 9, margin: -9 }} title={cleanTitle(p.title)}>
                                                        <span className="block rounded-full relative" style={{
                                                            width: sz, height: sz,
                                                            background: mine ? 'radial-gradient(circle at 34% 32%, #fff0c4, #e6ce97 55%, #c9a86a)' : 'radial-gradient(circle at 34% 32%, #cbbb92, #97815a 60%, #5e4e34)',
                                                            boxShadow: mine ? '0 0 14px 3px rgba(230,206,151,.55), 0 0 0 3px rgba(201,168,106,.16)' : '0 0 7px 1px rgba(201,168,106,.3)',
                                                        }}>
                                                            {/* Signal light: your satellite blinks every few seconds */}
                                                            {mine && <span className="absolute rounded-full" style={{ width: 3, height: 3, right: -1, top: -1, background: '#fff7dd', boxShadow: '0 0 6px 2px rgba(255,240,200,.8)', animation: `sigblink ${3 + (signalHashX(p.id) % 4)}s linear infinite` }} />}
                                                        </span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {/* ── Satellite directory: grouped by the three acts (one "playbook" block per act, tap the title to read in full) ── */}
                                    <div className="mt-2 mx-1 space-y-2">
                                        {signalActRanges(bk?.poemsTarget || SIGNAL_POEMS_PER_BOOKLET).map(({ act, from, to }) => {
                                            if (from > to) return null;
                                            const poems = visibleFeed
                                                .filter(p => poemAct(p)?.act.no === act.no)
                                                .sort((a, b) => (ordinalOf.get(a.id) || 0) - (ordinalOf.get(b.id) || 0));
                                            return (
                                                <div key={act.no} className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(201,168,106,.14)' }}>
                                                    <div className="flex items-baseline gap-2 px-3 py-1.5" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.1), rgba(201,168,106,.02))', borderBottom: '1px solid rgba(201,168,106,.12)' }}>
                                                        <span className="text-[10.5px] tracking-[0.18em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e0c98f' }}>Act {['I', 'II', 'III'][act.no - 1]} · {act.title}</span>
                                                        <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.45)' }}>Poems {from}-{to}</span>
                                                    </div>
                                                    {poems.length === 0 ? (
                                                        <p className="px-3 py-2 text-[9.5px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.35)' }}>{mineOnly ? 'Your echo has not landed in this act yet.' : 'This act is still silent, waiting for a signal to fall.'}</p>
                                                    ) : poems.map((p, i) => {
                                                        const mine = (p.mineCount || 0) > 0;
                                                        return (
                                                            <button key={p.id} onClick={() => setOpenPoem(p)}
                                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left active:bg-white/5"
                                                                style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(201,168,106,.08)' }}>
                                                                <span className="text-[8.5px] tabular-nums shrink-0 w-4 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{ordinalOf.get(p.id) || '—'}</span>
                                                                <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: mine ? '#e6ce97' : 'rgba(151,129,90,.75)', boxShadow: mine ? '0 0 6px 1px rgba(230,206,151,.55)' : 'none' }} />
                                                                <span className="text-[11.5px] truncate" style={{ fontFamily: `'Noto Serif SC',serif`, letterSpacing: '.04em', color: mine ? '#f0dca8' : 'rgba(224,208,176,.72)' }}>《{cleanTitle(p.title)}》</span>
                                                                <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.6)' : 'rgba(201,168,106,.45)' }}>{p.lineCount} lines</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })()
                    )
                )}
            </div>

            {/* Footer note: the sky map shows a "satellites / your echoes" count; other pages get a spectator's explanation */}
            <div className="relative z-10 px-4 py-1.5" style={{ borderTop: '1px solid rgba(201,168,106,.18)' }}>
                {tab === 'sky' && feed.length > 0
                    ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.5)' }}><span className="tabular-nums" style={{ color: '#ecdcb2' }}>{feed.length}</span> satellites orbit the quiet core · <span className="tabular-nums" style={{ color: '#f0dca8' }}>{myEchoes}</span> of them carry your echo</p>
                    : SIGNAL_EVENT_ENDED
                        ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>The event has ended and writing is closed -- the poems and sky map remain open long-term. Switched devices? Import your identity code at the post office to bring your letters back.</p>
                        : <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>Every user's characters co-write across instances -- you can only watch. Switched devices? Export your identity code at the post office to bring your poems and letters back.</p>}
            </div>

            {/* Read a whole sealed poem */}
            {openPoem && (
                <div className="absolute inset-0 z-30 flex flex-col" style={{ background: 'linear-gradient(165deg,#241c31,#120d1a 60%,#0b0812)' }} onClick={() => setOpenPoem(null)}>
                    <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 52%, rgba(6,4,10,.7) 100%)' }} />
                    <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-6 py-7" onClick={e => e.stopPropagation()}>
                        <div className="text-center mb-3">
                            <div className="text-[18px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 14px rgba(201,168,106,.35)' }}>《{cleanTitle(openPoem.title)}》</div>
                            <div className="my-2 flex items-center justify-center gap-2 text-[10px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                            </div>
                            <div className="text-[9px] tracking-wider" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.55)' }}>{openPoem.lineCount} lines · {(openPoem.mineCount || 0) > 0 ? <span style={{ color: '#f0dca8' }}>your echo appears here, {openPoem.mineCount} lines</span> : 'a poem co-written by strangers'}</div>
                            {(() => { const pa = poemAct(openPoem); return pa && <div className="mt-1 text-[9px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>Poem {pa.ord} · Act {['I', 'II', 'III'][pa.act.no - 1]} "{pa.act.title}"</div>; })()}
                            {openPoem.brief && <div className="mt-1.5 text-[9.5px] italic max-w-xs mx-auto leading-relaxed" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>{openPoem.brief}</div>}
                        </div>
                        <div className="max-w-md mx-auto">
                            {(() => { const auth = getMyAuthorship(openPoem.id); return (openPoem.lines || []).map(l => <PoemLineRow key={l.seq} l={l} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                        </div>
                    </div>
                    <button onClick={() => setOpenPoem(null)} className="relative shrink-0 mx-auto mb-4 mt-1 text-[11px] tracking-[0.2em] rounded-sm px-6 py-1.5" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.75)', border: '1px solid rgba(201,168,106,.35)', marginBottom: vrBottomPad('1rem') }}>CLOSE</button>
                </div>
            )}

            {/* First-time participation: special-event informed-consent notice. Once acknowledged, it's recorded locally (included in vrSignal backups), and afterward it goes straight to the character-picker layer */}
            {noticeOpen && (
                <div className="absolute inset-0 z-40 flex items-center justify-center px-6" style={{ background: 'rgba(6,4,10,0.88)' }} onClick={() => setNoticeOpen(false)}>
                    <div className="w-full rounded-2xl px-4 pt-4 pb-3.5" onClick={e => e.stopPropagation()}
                        style={{ background: 'linear-gradient(165deg,#2a2138,#17111f 70%)', border: '1px solid rgba(201,168,106,.4)', boxShadow: '0 12px 40px rgba(0,0,0,.6)' }}>
                        <div className="text-center text-[13px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab' }}>Please read this before participating</div>
                        <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                            <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                        </div>
                        <div className="space-y-2 text-[11px] leading-relaxed" style={{ color: 'rgba(224,208,176,.78)' }}>
                            <p>Signal Fall is a <span style={{ color: '#f0dca8' }}>special cross-user event</span>: every user's characters co-write the same poem across instances.</p>
                            <p>What your character writes will be <span style={{ color: '#f0dca8' }}>publicly visible to every other user</span>, and may be screenshotted or shared elsewhere. Tapping "Continue" is taken as acknowledging this.</p>
                            <p>If you find something that touches on privacy, please <span style={{ color: '#f0dca8' }}>contact the author to have it removed</span>.</p>
                        </div>
                        <button onClick={() => { ackSignalNotice(); setNoticeOpen(false); setPickOpen(true); }}
                            className="mt-3.5 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99]"
                            style={{ fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700, background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)', border: '1px solid rgba(120,92,48,.6)', boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)' }}>
                            I understand · Continue
                        </button>
                        <button onClick={() => setNoticeOpen(false)} className="mt-2 w-full py-1.5 text-[10.5px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.5)' }}>Let me think</button>
                    </div>
                </div>
            )}

            {/* Participate: assign a character to add a line */}
            {pickOpen && (
                <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.95)' }} onClick={() => setPickOpen(false)}>
                    <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <span className="text-[12px] text-indigo-100">Which character should write a line?</span>
                        <button onClick={() => setPickOpen(false)} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
                    </div>
                    {/* Whisper: the user's words don't go into the poem, but the character carries it while writing -- you are that core which never speaks */}
                    <div className="px-3.5 pt-2.5 pb-1" onClick={e => e.stopPropagation()}>
                        <div className="text-[9px] tracking-[0.2em] mb-1" style={{ color: 'rgba(201,168,106,.6)' }}>Leave a whisper (optional)</div>
                        <input value={whisper} onChange={e => setWhisper(e.target.value)} maxLength={80}
                            placeholder="e.g. make it a bit darker / think of that snow we saw together…"
                            className="w-full rounded-lg px-3 py-2 text-[12px] outline-none" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(201,168,106,.25)', color: '#ecdcb2' }} />
                        <p className="mt-1 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.45)' }}>This will not be written into the poem -- the poem is their work. But they will carry it with them as they write.</p>
                    </div>
                    <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-1.5" onClick={e => e.stopPropagation()}>
                        {(() => { const joined = characters.filter(c => c.vrState?.enabled); return joined.length === 0 ? (
                            <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">No characters are connected to Beyond yet.<br />Go to "Connect" and turn on autonomous login for them first.</p>
                        ) : joined.map(c => (
                            <button key={c.id} onClick={() => participate(c)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl active:bg-white/5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.06)' }}>
                                {c.avatar ? <TokenImg value={c.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0 flex items-center justify-center text-[12px] text-white/90">{c.name.slice(0, 1)}</div>}
                                <span className="text-[12.5px] text-white/90 truncate">{c.name}</span>
                                <span className="ml-auto text-[10px] text-indigo-300/60 shrink-0">Send them to write →</span>
                            </button>
                        )); })()}
                    </div>
                    <div className="px-3.5 py-2 border-t border-white/10"><p className="text-[9px] text-indigo-300/45 leading-relaxed">The chosen character will claim this line and make one LLM call -- continuing the current poem, or starting a new one if none is in progress. You will not write a line, but you are the quiet core at the very center of this orbit. It refreshes automatically in a few seconds.</p></div>
                </div>
            )}

            {/* Backend (dev-only): delete a poem/delete a line/pause new lines */}
            {adminOpen && <SignalAdminPanel onClose={() => { setAdminOpen(false); void load(); void loadFeed(); }} addToast={addToast} />}
        </div>
    );
};

const RoomScene: React.FC<{
    roomId: VRRoomId; occupants: CharacterProfile[];
    latestByChar: Record<string, FeedItem>; onClose: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    characters: CharacterProfile[];
    userName: string;
    onUserBoardPost: (content: string, replyTo?: VRGuestbookMessage) => Promise<void>;
    addToast?: (m: string, t?: any) => void;
}> = ({ roomId, occupants, latestByChar, onClose, onJump, characters, userName, onUserBoardPost, addToast }) => {
    const room = getRoom(roomId);
    const slots = ROOM_SLOTS[roomId];
    const isMusic = roomId === 'music';
    const isGuestbook = roomId === 'guestbook';
    const isPostOffice = roomId === 'postoffice';
    const isTheater = roomId === 'theater';
    const isSignal = roomId === 'signal';
    const [detail, setDetail] = useState<CharacterProfile | null>(null);
    const [musicState, setMusicState] = useState<VRMusicRoomState | null>(null);
    const [board, setBoard] = useState<VRGuestbookState | null>(null);
    const [postText, setPostText] = useState('');
    const [replyingTo, setReplyingTo] = useState<VRGuestbookMessage | null>(null);
    const postInputRef = useRef<HTMLInputElement>(null);
    const [posting, setPosting] = useState(false);
    const [gbPage, setGbPage] = useState(0);          // Guestbook-wall pagination: 0 = the newest page
    const [confirmClear, setConfirmClear] = useState(false); // Second confirmation for one-click clear
    const [hideChibi, setHideChibi] = useState(false);  // Hide the chibi figures (used when text panels like the guestbook get blocked by them)
    const music = useMusic();

    useEffect(() => {
        if (!isGuestbook) return;
        const load = async () => setBoard(await DB.getVRGuestbook());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [isGuestbook]);

    const submitPost = async () => {
        const t = postText.trim();
        if (!t || posting) return;
        setPosting(true);
        try {
            await onUserBoardPost(t, replyingTo || undefined);
            setPostText('');
            setReplyingTo(null);
            setGbPage(0);
            setBoard(await DB.getVRGuestbook());
        }
        finally { setPosting(false); }
    };

    const startReply = (message: VRGuestbookMessage) => {
        if (message.authorId === 'user') return;
        setReplyingTo(message);
        requestAnimationFrame(() => postInputRef.current?.focus());
    };

    // One-click clear the guestbook wall (only clears this public wall; cards already broadcast into each character's private chat are untouched)
    const submitClear = async () => {
        await DB.clearVRGuestbook();
        setBoard(await DB.getVRGuestbook());
        setGbPage(0);
        setReplyingTo(null);
        setConfirmClear(false);
        trackEvent('Clear Beyond Guestbook Wall');
        addToast?.('Guestbook wall cleared', 'success');
    };

    useEffect(() => {
        if (!isMusic) return;
        const load = async () => setMusicState(await DB.getVRMusicRoom());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [isMusic]);

    const np = musicState?.nowPlaying;
    const npPlaying = !!np && music.current?.id === np.song.id && music.playing;
    // Track whether playback was started by the music room -- when leaving the room, only pause the track "we started," don't touch the user's own music
    const startedRef = useRef(false);
    const musicRef = useRef(music);
    musicRef.current = music;
    const playNow = () => {
        if (!np) return;
        if (music.current?.id === np.song.id) music.togglePlay();
        else { music.playSong(toSong(np.song)); startedRef.current = true; }
        trackEvent('Play Current Song in Music Room');
    };
    // Music only plays while inside the music room: when leaving the scene, if it's still playing the track we started, pause it
    useEffect(() => () => {
        const m = musicRef.current;
        if (startedRef.current && m.playing && m.current?.id === musicState?.nowPlaying?.song.id) {
            m.togglePlay();
        }
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#05060d' }}>
            <VRStyleTag />
            <div className="relative flex-1 overflow-hidden">
                <RoomBackground roomId={roomId} />
                {/* Ethereal atmosphere: stardust + vignette, echoing the shell */}
                <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 24%, rgba(255,255,255,.5), transparent), radial-gradient(1px 1px at 72% 16%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 60% 66%, rgba(230,225,255,.4), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />
                <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 55%, rgba(5,6,14,.45) 100%)' }} />
                {/* Top bar */}
                <div className="absolute top-0 left-0 right-0 flex items-center gap-2.5 px-4 pb-3 z-[120]"
                    style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.55),transparent)', paddingTop: VR_TOP }}>
                    <button onClick={onClose} className="h-10 w-10 -ml-2 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 text-white/90 border border-white/10 flex items-center justify-center"><CaretLeft size={20} weight="regular" /></button>
                    <span className="text-[16px] text-white drop-shadow flex items-center gap-1.5 tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                    <div className="ml-auto flex items-center gap-2">
                        {occupants.length > 0 && (
                            <button onClick={() => setHideChibi(h => !h)} title={hideChibi ? 'Show chibis' : 'Hide chibis (in case they block text)'}
                                className="text-[10px] px-2.5 py-1 rounded-full bg-white/10 backdrop-blur-md text-white/85 border border-white/10 active:bg-white/20">
                                {hideChibi ? 'Show chibis' : 'Hide chibis'}
                            </button>
                        )}
                        <span className="text-[10px] tracking-wider text-white/60">{occupants.length} present</span>
                    </div>
                </div>

                {/* Music room: now-playing + queue panel */}
                {isMusic && (
                    <div className="absolute left-3 right-3 z-20" style={{ top: VR_ROOM_PANEL_TOP }}>
                        {np ? (
                            <div className="rounded-2xl p-2.5 flex items-center gap-3 backdrop-blur-md"
                                style={{ background: 'rgba(20,8,40,0.6)', border: '1px solid rgba(255,123,213,0.35)', boxShadow: '0 6px 20px rgba(120,40,160,.4)' }}>
                                {np.song.albumPic
                                    ? <TokenImg value={np.song.albumPic} className={`h-14 w-14 rounded-xl object-cover ${npPlaying ? 'animate-spin-slow' : ''}`} style={npPlaying ? { animation: 'spin 8s linear infinite' } : {}} alt="" />
                                    : <div className="h-14 w-14 rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center"><MusicNotes size={22} weight="fill" className="text-white/80" /></div>}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[9px] text-pink-200/70 tracking-wide flex items-center gap-1"><MusicNotes size={9} weight="fill" /> NOW PLAYING · picked by {np.charName}</div>
                                    <div className="text-[13px] font-bold text-white truncate">{np.song.name}</div>
                                    <div className="text-[10.5px] text-pink-100/60 truncate">{np.song.artists}</div>
                                </div>
                                <button onClick={playNow} className="h-10 w-10 rounded-full bg-white/90 flex items-center justify-center active:scale-90 transition-transform shrink-0">
                                    {npPlaying ? <Pause size={18} weight="fill" className="text-purple-700" /> : <Play size={18} weight="fill" className="text-purple-700 ml-0.5" />}
                                </button>
                            </div>
                        ) : (
                            <div className="rounded-2xl p-3 text-center backdrop-blur-md" style={{ background: 'rgba(20,8,40,0.5)', border: '1px solid rgba(255,123,213,0.25)' }}>
                                <p className="text-[11px] text-pink-100/80">No one has played anything yet. Have a character with a music persona visit, and they will pick a song.</p>
                                <p className="text-[9.5px] text-pink-200/50 mt-1">No music persona yet? Go to the "Music" app and generate a NetEase Music profile for the character.</p>
                            </div>
                        )}
                        {musicState?.queue && musicState.queue.length > 0 && (
                            <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-full overflow-x-auto no-scrollbar" style={{ background: 'rgba(20,8,40,0.45)' }}>
                                <Queue size={12} weight="bold" className="text-pink-200/70 shrink-0" />
                                {musicState.queue.slice(0, 6).map((q, i) => (
                                    <span key={i} className="text-[9.5px] text-pink-100/70 whitespace-nowrap shrink-0">《{q.song.name}》<span className="text-pink-200/40">·{q.charName}</span>{i < Math.min(5, musicState.queue.length - 1) ? ' ·' : ''}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Guestbook: a board-chat wall (Discord-style: avatar + consecutive messages grouped, replies de-emphasized) */}
                {isGuestbook && (() => {
                    const GB_PAGE_SIZE = 50; // 50 per page, older messages viewed via pagination
                    const all = board?.messages || [];
                    const totalPages = Math.max(1, Math.ceil(all.length / GB_PAGE_SIZE));
                    const page = Math.min(gbPage, totalPages - 1); // 0 = the newest page (the last 50 messages)
                    const end = all.length - page * GB_PAGE_SIZE;
                    const msgs = all.slice(Math.max(0, end - GB_PAGE_SIZE), end);
                    // Consecutive messages from the same author (that aren't replies and aren't spaced too far apart) get merged into one group
                    const groups: VRGuestbookMessage[][] = [];
                    for (const m of msgs) {
                        const g = groups[groups.length - 1];
                        if (g && g[0].authorId === m.authorId && !m.replyToName && (m.createdAt - g[g.length - 1].createdAt) < 5 * 60 * 1000) g.push(m);
                        else groups.push([m]);
                    }
                    return (
                        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
                            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad(replyingTo ? '5.8rem' : '4rem'), background: 'rgba(10,22,38,0.62)', border: '1px solid rgba(140,200,255,0.22)', boxShadow: '0 8px 26px rgba(0,0,0,.4)' }}>
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
                                <span className="text-[10px] tracking-[0.25em] text-sky-200/70" style={{ fontFamily: `'Noto Serif SC',serif` }}>Guestbook Wall</span>
                                {all.length > 0 && <span className="text-[9px] text-white/30 tabular-nums">{all.length}</span>}
                                {all.length > 0 && (confirmClear ? (
                                    <span className="ml-auto flex items-center gap-1.5">
                                        <button onClick={submitClear} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>Confirm Clear</button>
                                        <button onClick={() => setConfirmClear(false)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">Cancel</button>
                                    </span>
                                ) : (
                                    <button onClick={() => setConfirmClear(true)} className="ml-auto text-[10px] px-2.5 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 active:bg-white/10">Clear All</button>
                                ))}
                            </div>
                            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-3">
                                {groups.length === 0 ? (
                                    <p className="text-[11px] text-white/40 text-center py-6">This wall is still empty. Leave the first message, or wait for characters to start posting.</p>
                                ) : groups.map(g => {
                                    const head = g[0];
                                    const isUser = head.authorId === 'user';
                                    const ch = isUser ? null : characters.find(c => c.id === head.authorId);
                                    const name = isUser ? head.authorName : (ch?.name || head.authorName);
                                    const hue = (() => { let h = 0; for (let i = 0; i < head.authorId.length; i++) h = (h * 31 + head.authorId.charCodeAt(i)) % 360; return h; })();
                                    const nameColor = isUser ? '#7dd3fc' : `hsl(${hue},72%,74%)`;
                                    return (
                                        <div key={head.id} className="flex gap-2.5">
                                            {ch?.avatar
                                                ? <TokenImg value={ch.avatar} className="h-8 w-8 rounded-full object-cover shrink-0 mt-0.5" alt="" />
                                                : <div className="h-8 w-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[12px] font-bold text-white/95" style={{ background: isUser ? 'linear-gradient(135deg,#38bdf8,#6366f1)' : `hsl(${hue},45%,42%)` }}>{name.slice(0, 1)}</div>}
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-1.5">
                                                    <span className="text-[12px] font-bold" style={{ color: nameColor }}>{name}</span>
                                                    <span className="text-[8.5px] text-white/30 tabular-nums">{new Date(head.createdAt).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                <div className="mt-1 space-y-1">
                                                    {g.map(m => (
                                                        <button key={m.id} type="button" onClick={() => startReply(m)} disabled={m.authorId === 'user'}
                                                            aria-label={m.authorId === 'user' ? undefined : `Reply to ${m.authorName}: ${m.content}`}
                                                            className="block text-left text-[12.5px] leading-relaxed text-white/85 px-2.5 py-1 rounded-lg w-fit max-w-full disabled:cursor-default active:scale-[0.99]"
                                                            style={{ background: replyingTo?.id === m.id ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.055)', border: replyingTo?.id === m.id ? '1px solid rgba(125,211,252,.35)' : '1px solid transparent' }}>
                                                            {m.replyToName && <span className="text-[10px] text-sky-200/45 mr-1">↩{m.replyToName}</span>}
                                                            {m.content}
                                                            {m.authorId !== 'user' && <span className="ml-2 text-[9px] text-sky-200/35">Reply</span>}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {totalPages > 1 && (
                                <div className="flex items-center justify-center gap-3 px-3 py-1.5 border-t border-white/10 text-[10.5px] text-white/70">
                                    <button onClick={() => setGbPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">← Older</button>
                                    <span className="tabular-nums text-white/45">{totalPages - page} / {totalPages}</span>
                                    <button onClick={() => setGbPage(p => Math.max(0, p - 1))} disabled={page <= 0}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">Newer →</button>
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* Post office: letter management panel */}
                {isPostOffice && <PostOfficePanel addToast={addToast} characters={characters} userName={userName} />}

                {/* Theater: the drama department panel (submissions / casting / performance / history) */}
                {isTheater && <TheaterPanel addToast={addToast} />}

                {/* Signal Fall: view the poem currently being co-written + browse the poem collection + participate (assign a character to add a line) */}
                {isSignal && <SignalPanel addToast={addToast} characters={characters} />}

                {/* Chibi standing positions (can be hidden, to avoid blocking text like the guestbook) */}
                {!hideChibi && occupants.map((c, i) => {
                    const slot = slots[i % slots.length];
                    const latest = latestByChar[c.id];
                    const idle = IDLE_QUIPS[roomId][i % IDLE_QUIPS[roomId].length];
                    const bubble = latest ? (stripSelfName(latest.meta.activity, c.name) || idle) : idle;
                    return (
                        <div key={c.id} className="absolute" style={{ left: `${slot.x}%`, top: `${slot.y}%`, zIndex: Math.round(slot.y) }}>
                            <Chibi char={c} bubble={bubble} size={104} dance={isMusic} onTap={() => setDetail(c)} />
                        </div>
                    );
                })}
                {occupants.length === 0 && !isMusic && !isGuestbook && !isPostOffice && !isTheater && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <p className="text-white/70 text-[12px] bg-black/30 rounded-full px-4 py-2">No one is in this room yet. Go to "Connect" and enable a character.</p>
                    </div>
                )}

                {/* Guestbook: the user's own post (broadcast to every connected character) */}
                {isGuestbook && (
                    <div className="absolute left-0 right-0 z-30 flex flex-col gap-1.5 px-3 py-2.5"
                        style={{ bottom: vrBottomPad('0px'), background: 'linear-gradient(0deg,rgba(5,12,22,.92),transparent)' }}>
                        {replyingTo && (
                            <div className="flex items-center gap-2 px-3 text-[10px] text-sky-100/70 min-w-0">
                                <span className="shrink-0">Replying to {replyingTo.authorName}</span>
                                <span className="truncate text-white/35">{replyingTo.content}</span>
                                <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="ml-auto shrink-0 text-white/45 active:text-white"><X size={13} /></button>
                            </div>
                        )}
                        <div className="flex items-center gap-2 w-full">
                            <input ref={postInputRef} value={postText} onChange={e => setPostText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitPost(); }}
                                placeholder={replyingTo ? `Reply to ${replyingTo.authorName}…` : `Post as ${userName}…`}
                                className="flex-1 min-w-0 rounded-full px-4 py-2 text-[12.5px] text-white placeholder-white/35 outline-none backdrop-blur-md"
                                style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(140,200,255,.25)' }} />
                            <button onClick={submitPost} disabled={!postText.trim() || posting}
                                className="h-9 px-4 rounded-full text-[12px] font-semibold text-white disabled:opacity-40 shrink-0"
                                style={{ background: 'linear-gradient(120deg, rgba(120,180,255,.9), rgba(150,200,235,.85))' }}>
                                {posting ? '…' : replyingTo ? 'Reply' : 'Post'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Character activity detail -- overlaid on top of the chibi (zIndex higher than any chibi) */}
            {detail && (
                <div className="absolute inset-0 flex items-end bg-black/45" style={{ zIndex: 200 }} onClick={() => setDetail(null)}>
                    <div className="w-full rounded-t-2xl p-4 text-white" style={{ background: 'linear-gradient(180deg,#1a2236 0%,#0d1119 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-2">
                            {detail.avatar ? <TokenImg value={detail.avatar} className="h-9 w-9 rounded-full object-cover" alt="" /> : <div className="h-9 w-9 rounded-full bg-indigo-400/40" />}
                            <span className="font-bold">{detail.name}</span>
                            <button onClick={() => setDetail(null)} className="ml-auto p-1 text-white/60"><X size={18} /></button>
                        </div>
                        {latestByChar[detail.id] ? (() => {
                            const m = latestByChar[detail.id].meta;
                            return (
                                <>
                                    <p className="text-[12.5px] text-indigo-50/90 leading-relaxed">{stripSelfName(m.activity, detail.name)}</p>
                                    {m.behavior && <p className="text-[11px] text-pink-200/80 mt-1.5">{stripSelfName(m.behavior, detail.name)}</p>}
                                    {m.annotationRefs && m.annotationRefs.length > 0
                                        ? m.annotationRefs.map((ref, i) => (
                                            <button key={i} onClick={() => { onJump(m.novelId, ref.segIdx); setDetail(null); }}
                                                className="block w-full text-left mt-1.5 text-[11.5px] text-indigo-200/85 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60">
                                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/70">↗Original</span>
                                            </button>
                                        ))
                                        : m.annotationExcerpts?.map((ex, i) => (
                                            <div key={i} className="mt-1.5 text-[11.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug">{stripLeakedAttrs(ex)}</div>
                                        ))}
                                    <p className="text-[9px] text-indigo-300/50 mt-2">{new Date(latestByChar[detail.id].timestamp).toLocaleString('en-US')}</p>
                                </>
                            );
                        })() : (
                            <p className="text-[12px] text-indigo-300/60">No updates yet, wait for their next login.</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ============ Library ============
const LibraryView: React.FC<{
    novels: VRWorldNovel[]; characters: CharacterProfile[];
    onOpen: (n: VRWorldNovel) => void; onAdd: () => void; onDelete: (id: string) => void;
}> = ({ novels, characters, onOpen, onAdd, onDelete }) => (
    <div className="space-y-3">
        <button onClick={onAdd} className="w-full rounded-xl py-2.5 text-[13px] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform shadow-[0_4px_14px_rgba(120,100,255,0.4)]"
            style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
            <Plus size={16} weight="bold" /> Upload a Novel (.txt supported)
        </button>
        {novels.length === 0 ? (
            <p className="text-[11px] text-indigo-300/50 py-6 text-center">The library is empty. Uploaded novels are shared reading material for every character -- each character keeps their own annotations and bookmark.</p>
        ) : (
            <PagedList items={novels} perPage={20} render={(novel) => {
                const readers = characters.filter(c => getBookmark(c.vrState?.novelBookmarks, novel.id) > 0);
                return (
                    <div key={novel.id} className="rounded-2xl p-3.5 mb-3 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-start gap-2">
                            <BookOpen size={18} weight="fill" className="text-amber-200 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{novel.title}</div>
                                {novel.author && <div className="text-[10px] text-indigo-300/60">{novel.author}</div>}
                                <div className="text-[10px] text-indigo-300/50 mt-0.5">{novel.segments.length} segments · {novel.totalChars.toLocaleString()} characters</div>
                            </div>
                            <button onClick={() => onDelete(novel.id)} className="p-1.5 rounded-full active:bg-white/10 text-indigo-300/50"><Trash size={15} /></button>
                        </div>
                        {readers.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {readers.map(c => {
                                    const bm = getBookmark(c.vrState?.novelBookmarks, novel.id);
                                    const pct = Math.round((bm / Math.max(1, novel.segments.length)) * 100);
                                    return <span key={c.id} className="text-[9.5px] bg-white/10 rounded-full px-2 py-0.5 text-indigo-100/80">{c.name} {pct}%</span>;
                                })}
                            </div>
                        )}
                        <button onClick={() => onOpen(novel)} className="mt-2 text-[11px] text-indigo-300 font-semibold flex items-center gap-0.5 active:opacity-70">Open to Read / View Annotations <CaretRight size={12} weight="bold" /></button>
                    </div>
                );
            }} />
        )}
    </div>
);

// ============ Reader themes ============
interface ReaderTheme { id: string; name: string; bg: string; paper: string; text: string; sub: string; accent: string; annBg: string; }
const READER_THEMES: ReaderTheme[] = [
    { id: 'paper', name: 'Paper', bg: '#e9e3d6', paper: '#f7f3ea', text: '#322d25', sub: '#8a7f6c', accent: '#a0673b', annBg: '#efe7d4' },
    { id: 'sepia', name: 'Sepia', bg: '#d8c6a3', paper: '#ece0c6', text: '#48381f', sub: '#917a52', accent: '#8a5a2b', annBg: '#e2d3b2' },
    { id: 'green', name: 'Eye Care', bg: '#bcd4bc', paper: '#d6e8d4', text: '#26331f', sub: '#5d7350', accent: '#3f6b3a', annBg: '#cadfc6' },
    { id: 'night', name: 'Night', bg: '#15161a', paper: '#1f2128', text: '#cfc9bd', sub: '#7d7869', accent: '#c0915a', annBg: '#262932' },
    { id: 'ink', name: 'Ink Black', bg: '#0a0a0e', paper: '#131319', text: '#b9b4ab', sub: '#6f6a78', accent: '#8b9bff', annBg: '#1a1a24' },
];
const FONT_SIZES = [13, 15, 17, 20];
const READER_THEME_KEY = 'vr_reader_theme';
const READER_FONT_KEY = 'vr_reader_font';
const READER_MODE_KEY = 'vr_reader_mode'; // 'page' | 'scroll'
// The user's own bookmark (segment index, per-novel, independent of character bookmarks)
const userBmKey = (id: string) => `vr_user_bm_${id}`;
const readUserBm = (id: string): number => {
    const v = Number(localStorage.getItem(userBmKey(id)));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};
const writeUserBm = (id: string, idx: number) => {
    try { localStorage.setItem(userBmKey(id), String(Math.max(0, idx))); } catch { /* ignore */ }
};

// Single-segment rendering (shared by pagination/scroll modes)
const SegBlock: React.FC<{
    seg: { idx: number; text: string }; anns: VRNovelAnnotation[];
    theme: ReaderTheme; fontSize: number; nameOf: (id: string) => string | undefined; highlight?: boolean;
}> = ({ seg, anns, theme, fontSize, nameOf, highlight }) => (
    <div data-seg={seg.idx} className="mb-5 rounded-lg transition-colors" style={highlight ? { background: `${theme.accent}1f`, boxShadow: `0 0 0 2px ${theme.accent}66`, padding: '8px 10px', margin: '0 -10px 20px' } : undefined}>
        <p className="whitespace-pre-wrap" style={{ color: theme.text, fontSize, lineHeight: 1.9, textIndent: '2em' }}>{seg.text}</p>
        {anns.map(a => (
            <div key={a.id} className="mt-2 ml-2 rounded-lg px-3 py-2" style={{ background: theme.annBg, borderLeft: `3px solid ${theme.accent}` }}>
                <span className="font-bold" style={{ color: theme.accent, fontSize: fontSize - 3 }}>{nameOf(a.authorId) || a.authorName}</span>
                {a.targetAnnotationId && <span style={{ color: theme.sub, fontSize: fontSize - 3 }}> replying</span>}
                <span style={{ color: theme.text, fontSize: fontSize - 3 }}>：{stripLeakedAttrs(a.content)}</span>
            </div>
        ))}
    </div>
);

const ReaderModal: React.FC<{ novel: VRWorldNovel; characters: CharacterProfile[]; onClose: () => void; initialSeg?: number; peek?: boolean; }> = ({ novel, characters, onClose, initialSeg, peek }) => {
    const PAGE_SIZE = 8;
    const total = novel.segments.length;
    // In peek mode (viewing a specific annotation), start at initialSeg, and never write to the user's bookmark the whole time
    const initialBm = useMemo(() => {
        const base = (initialSeg != null) ? initialSeg : readUserBm(novel.id);
        return Math.min(Math.max(0, base), Math.max(0, total - 1));
    }, [novel.id, total, initialSeg]);

    const [annotations, setAnnotations] = useState<VRNovelAnnotation[]>([]);
    const [themeId, setThemeId] = useState<string>(() => localStorage.getItem(READER_THEME_KEY) || 'paper');
    const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem(READER_FONT_KEY)) || 15);
    const [mode, setMode] = useState<'page' | 'scroll'>(() => (localStorage.getItem(READER_MODE_KEY) === 'scroll' ? 'scroll' : 'page'));
    const [showCtl, setShowCtl] = useState(false);

    // Pagination-mode state
    const [page, setPage] = useState(() => Math.floor(initialBm / PAGE_SIZE));
    // Scroll-mode state: a window [winStart, winEnd), initially positioned at the bookmark
    const [winStart, setWinStart] = useState(() => initialBm);
    const [winEnd, setWinEnd] = useState(() => Math.min(total, initialBm + 30));
    const [topSeg, setTopSeg] = useState(initialBm);

    const scrollRef = useRef<HTMLDivElement>(null);
    const prevHeightRef = useRef<number | null>(null);
    const bmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { void (async () => setAnnotations(await DB.getVRAnnotations(novel.id)))(); }, [novel.id]);
    useEffect(() => { localStorage.setItem(READER_THEME_KEY, themeId); }, [themeId]);
    useEffect(() => { localStorage.setItem(READER_FONT_KEY, String(fontSize)); }, [fontSize]);

    // Pagination: save the bookmark on page change + scroll back to top (peek mode never writes the bookmark)
    useEffect(() => {
        if (mode !== 'page') return;
        if (!peek) writeUserBm(novel.id, page * PAGE_SIZE);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [page, mode, novel.id, peek]);

    // Scroll: after prepending content, compensate the scroll position to avoid a visible jump
    useLayoutEffect(() => {
        if (prevHeightRef.current != null && scrollRef.current) {
            const el = scrollRef.current;
            el.scrollTop += el.scrollHeight - prevHeightRef.current;
            prevHeightRef.current = null;
        }
    }, [winStart]);

    const switchMode = (m: 'page' | 'scroll') => {
        if (m === mode) return;
        if (m === 'scroll') {
            const bm = page * PAGE_SIZE;
            setWinStart(bm); setWinEnd(Math.min(total, bm + 30)); setTopSeg(bm);
        } else {
            setPage(Math.floor(readUserBm(novel.id) / PAGE_SIZE));
        }
        setMode(m);
        localStorage.setItem(READER_MODE_KEY, m);
    };

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || mode !== 'scroll') return;
        // Load more when hitting the bottom
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 900 && winEnd < total) {
            setWinEnd(e => Math.min(total, e + 20));
        }
        // Load more backward when hitting the top
        if (el.scrollTop < 400 && winStart > 0) {
            prevHeightRef.current = el.scrollHeight;
            setWinStart(s => Math.max(0, s - 20));
        }
        // Throttled bookmark saving (uses the first visible segment at the top)
        if (bmTimerRef.current) return;
        bmTimerRef.current = setTimeout(() => {
            bmTimerRef.current = null;
            const cur = scrollRef.current;
            if (!cur) return;
            const top = cur.scrollTop;
            const nodes = cur.querySelectorAll<HTMLElement>('[data-seg]');
            for (const n of Array.from(nodes)) {
                if (n.offsetTop + n.offsetHeight > top + 4) {
                    const idx = Number(n.dataset.seg);
                    setTopSeg(idx); if (!peek) writeUserBm(novel.id, idx);
                    break;
                }
            }
        }, 300);
    };

    const theme = READER_THEMES.find(t => t.id === themeId) || READER_THEMES[0];
    const annBySeg = useMemo(() => groupAnnotationsBySeg(annotations), [annotations]);
    const nameOf = (id: string) => characters.find(c => c.id === id)?.name;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const renderSegs = mode === 'page'
        ? novel.segments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        : novel.segments.slice(winStart, winEnd);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: theme.bg }}>
            {/* Top bar */}
            <div className="flex items-center gap-2 px-4 pb-2 shrink-0" style={{ borderBottom: `1px solid ${theme.accent}22`, paddingTop: VR_TOP }}>
                <button onClick={onClose} className="p-1.5 -ml-1.5 rounded-full active:bg-black/5" style={{ color: theme.text }}><X size={20} weight="bold" /></button>
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold truncate" style={{ color: theme.text }}>{novel.title}</div>
                    <div className="text-[10px]" style={{ color: theme.sub }}>
                        {mode === 'page'
                            ? `Segments ${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, total)} / ${total}`
                            : `At segment ${topSeg + 1} / ${total} · ${Math.round((topSeg / Math.max(1, total)) * 100)}%`}
                    </div>
                </div>
                <button onClick={() => setShowCtl(s => !s)} className="p-1.5 rounded-full active:bg-black/5" style={{ color: theme.accent }}><Palette size={18} weight="bold" /></button>
            </div>

            {peek && (
                <div className="px-4 py-1.5 shrink-0 text-[11px] text-center" style={{ background: `${theme.accent}1a`, color: theme.accent }}>
                    Viewing an annotation position · your bookmark will not change
                </div>
            )}

            {/* Control bar: theme / font size / mode */}
            {showCtl && (
                <div className="px-4 py-2.5 shrink-0 space-y-2.5" style={{ background: theme.paper, borderBottom: `1px solid ${theme.accent}22` }}>
                    <div className="flex items-center gap-2">
                        <Palette size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {READER_THEMES.map(t => (
                                <button key={t.id} onClick={() => setThemeId(t.id)}
                                    className="flex-1 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all"
                                    style={{ background: t.paper, color: t.text, border: themeId === t.id ? `2px solid ${t.accent}` : `1px solid ${t.accent}33` }}>
                                    {t.name}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <TextAa size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {FONT_SIZES.map(fs => (
                                <button key={fs} onClick={() => setFontSize(fs)}
                                    className="w-9 h-7 rounded-lg font-bold transition-all"
                                    style={{ background: fontSize === fs ? theme.accent : 'transparent', color: fontSize === fs ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44`, fontSize: Math.min(fs, 15) }}>
                                    A
                                </button>
                            ))}
                        </div>
                        {/* Mode switch */}
                        <div className="flex gap-1.5">
                            {(['page', 'scroll'] as const).map(m => (
                                <button key={m} onClick={() => switchMode(m)}
                                    className="px-2.5 h-7 rounded-lg text-[11px] font-bold transition-all"
                                    style={{ background: mode === m ? theme.accent : 'transparent', color: mode === m ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44` }}>
                                    {m === 'page' ? 'Paged' : 'Scroll'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="text-[10px] leading-snug pt-0.5" style={{ color: theme.sub }}>Annotations in this book are all left by the characters; you can browse them, but you cannot write your own yet.</div>
                </div>
            )}

            {/* Main content */}
            <div ref={scrollRef} onScroll={mode === 'scroll' ? onScroll : undefined}
                className="flex-1 overflow-y-auto vr-reader-scroll px-5 py-4" style={{ background: theme.bg, fontFamily: `'Noto Serif SC','Songti SC','Noto Serif','Georgia',serif` }}>
                {mode === 'scroll' && winStart > 0 && (
                    <div className="text-center text-[10px] mb-3" style={{ color: theme.sub }}>-- swipe up to load earlier content --</div>
                )}
                {renderSegs.map(seg => (
                    <SegBlock key={seg.idx} seg={seg} anns={annBySeg.get(seg.idx) || []} theme={theme} fontSize={fontSize} nameOf={nameOf} highlight={peek && seg.idx === initialSeg} />
                ))}
            </div>

            {/* Bottom bar */}
            {mode === 'page' ? (
                <div className="flex items-center justify-between px-5 py-2.5 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.625rem') }}>
                    <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>‹ Previous</button>
                    <span className="text-[11px]" style={{ color: theme.sub }}>{page + 1} / {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>Next ›</button>
                </div>
            ) : (
                <div className="flex items-center justify-center gap-4 px-5 py-2 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.5rem') }}>
                    <button onClick={() => { setWinStart(0); setWinEnd(Math.min(total, 30)); setTopSeg(0); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
                        className="text-[11px] font-semibold" style={{ color: theme.accent }}>↑ From the Start</button>
                    <span className="text-[10px]" style={{ color: theme.sub }}>Scroll to read · position saved automatically</span>
                </div>
            )}
        </div>
    );
};

// ============ Upload dialog (supports large .txt / .pdf files, content never enters the DOM) ============
type UploadFileInfo = {
    name: string;
    chars: number;
    preview: string;
    encoding: string;
    kind: 'text' | 'pdf';
    pages?: number;
};

const UploadModal: React.FC<{
    onClose: () => void;
    onCommit: (novel: VRWorldNovel) => Promise<void> | void;
    onError: (msg: string) => void;
}> = ({ onClose, onCommit, onError }) => {
    const uploadFieldClass = 'w-full rounded-lg border border-indigo-100/70 bg-white px-3 py-2 text-slate-800 caret-indigo-500 placeholder:text-indigo-300 outline-none focus:border-indigo-300';
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [summary, setSummary] = useState('');
    // A manually pasted short passage lives in state; a large file's content is only kept in a ref, never put into the textarea (otherwise a 12MB file would freeze the UI)
    const [pasteText, setPasteText] = useState('');
    const [fileInfo, setFileInfo] = useState<UploadFileInfo | null>(null);
    const fileContentRef = useRef<string>('');
    // Keep the raw bytes around, so manually switching encoding can re-decode without re-reading the file from disk
    const fileBufRef = useRef<ArrayBuffer | null>(null);
    const [chosenEncoding, setChosenEncoding] = useState<string>('auto');
    const fileRef = useRef<HTMLInputElement>(null);
    const [reading, setReading] = useState(false);
    const [readingStatus, setReadingStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    // Decode the currently cached bytes using a given encoding (auto = auto-detect) and refresh the preview
    const applyDecode = (name: string, buf: ArrayBuffer, enc: string) => {
        const { text: content, encoding } = decodeBytes(buf, enc === 'auto' ? undefined : enc);
        fileContentRef.current = content;
        setFileInfo({
            name,
            chars: content.length,
            preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
            encoding,
            kind: 'text',
        });
    };

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        const pdfFile = isPdfFile(f);
        const textFile = f.type.toLowerCase() === 'text/plain' || /\.(txt|text)$/i.test(f.name);
        if (!pdfFile && !textFile) {
            onError('Only .txt and .pdf files are supported for now');
            if (fileRef.current) fileRef.current.value = '';
            return;
        }
        setReading(true);
        setReadingStatus(pdfFile ? 'Loading PDF…' : 'Reading and detecting encoding…');
        try {
            const buf = await f.arrayBuffer();
            if (pdfFile) {
                fileBufRef.current = null;
                const result = await extractPdfText(buf, {
                    onProgress: ({ page, totalPages }) => setReadingStatus(`Extracting PDF text… ${page}/${totalPages}`),
                });
                const content = result.text.trim();
                if (!content) {
                    onError('No extractable text in this PDF -- it may be a scan or image-based PDF; run OCR on it first, then import');
                    return;
                }
                fileContentRef.current = content;
                setFileInfo({
                    name: f.name,
                    chars: content.length,
                    preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
                    encoding: 'PDF',
                    kind: 'pdf',
                    pages: result.pageCount,
                });
                trackEvent('Import PDF Novel to Beyond Library', { pages: result.pageCount, chars: content.length });
            } else {
                fileBufRef.current = buf;
                setChosenEncoding('auto');
                applyDecode(f.name, buf, 'auto');
            }
            setPasteText(''); // File takes priority, clear the paste box
            if (!title.trim()) setTitle(f.name.replace(/\.(txt|text|pdf)$/i, ''));
        } catch (e) {
            console.error('[VRWorld] read novel file failed', e);
            onError(pdfFile ? 'Failed to read the PDF -- it may be corrupted, encrypted, or a network component failed to load' : 'Failed to read the file');
        } finally {
            setReading(false);
            setReadingStatus('');
        }
    };

    // Manually switch encoding (for when text is garbled): re-decode the cached bytes, no need to pick the file again
    const redecode = (enc: string) => {
        const buf = fileBufRef.current;
        if (!buf || !fileInfo) return;
        setChosenEncoding(enc);
        applyDecode(fileInfo.name, buf, enc);
    };

    const clearFile = () => {
        fileContentRef.current = '';
        fileBufRef.current = null;
        setChosenEncoding('auto');
        setFileInfo(null);
        setReadingStatus('');
        if (fileRef.current) fileRef.current.value = '';
    };

    const totalChars = fileInfo ? fileInfo.chars : pasteText.length;
    const canSave = !!title.trim() && totalChars > 0 && !busy;

    const handleSave = async () => {
        const content = fileInfo ? fileContentRef.current : pasteText;
        if (!title.trim() || !content) { onError('Both title and text are required'); return; }
        setBusy(true);
        setProgress(0);
        try {
            // Yield a frame first, so "Processing…" gets a chance to render
            await new Promise<void>(r => setTimeout(r));
            const novel = await buildNovelAsync(title, content, {
                author, summary,
                onProgress: (r) => setProgress(Math.round(r * 100)),
            });
            if (novel.segments.length === 0) { onError('The text is empty'); setBusy(false); return; }
            await onCommit(novel);
            trackEvent('Add Novel to Library');
        } catch (e) {
            console.error('[VRWorld] build novel failed', e);
            onError('Processing failed -- the file may be too large or in an unexpected format');
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={busy ? undefined : onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4 max-h-[88vh] overflow-y-auto vr-reader-scroll" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-3">
                    <span className="text-[15px] font-bold text-white">Upload Novel</span>
                    {!busy && <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>}
                </div>

                <input ref={fileRef} type="file" accept=".txt,text/plain,.pdf,application/pdf" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                {reading ? (
                    <div className="w-full rounded-xl border border-indigo-300/30 py-5 mb-3 flex items-center justify-center gap-2 text-indigo-100/90">
                        <CircleNotch size={18} weight="bold" className="animate-spin" /> {readingStatus}
                    </div>
                ) : fileInfo ? (
                    <div className="rounded-xl border border-indigo-300/30 p-3 mb-3 bg-white/5">
                        <div className="flex items-center gap-2">
                            <BookOpen size={16} weight="fill" className="text-amber-200 shrink-0" />
                            <span className="text-[12.5px] text-white font-semibold truncate flex-1">{fileInfo.name}</span>
                            <span className="text-[8.5px] text-indigo-300/60 border border-indigo-300/30 rounded px-1 uppercase">
                                {fileInfo.kind === 'pdf' ? `PDF · ${fileInfo.pages} pages` : fileInfo.encoding}
                            </span>
                            {!busy && <button onClick={clearFile} className="text-indigo-300/60 p-1"><X size={14} /></button>}
                        </div>
                        <div className="text-[10px] text-indigo-300/60 mt-1">{fileInfo.chars.toLocaleString()} characters · ~{Math.ceil(fileInfo.chars / 400).toLocaleString()} segments estimated</div>
                        <p className="text-[10.5px] text-indigo-200/50 mt-1.5 leading-snug line-clamp-2">{fileInfo.preview}…</p>
                        {!busy && fileInfo.kind === 'text' && (
                            <div className="flex items-center gap-1.5 mt-2">
                                <span className="text-[9.5px] text-indigo-300/55 shrink-0">Garbled text? Change encoding</span>
                                <select value={chosenEncoding} onChange={e => redecode(e.target.value)}
                                    className="flex-1 text-[10px] bg-[#1b2236] text-indigo-100 border border-indigo-300/25 rounded px-1.5 py-1 outline-none">
                                    <option value="auto">Auto-detect</option>
                                    <option value="utf-8">UTF-8</option>
                                    <option value="gb18030">Simplified Chinese · GB18030 / GBK</option>
                                    <option value="big5">Traditional Chinese · Big5</option>
                                    <option value="shift_jis">Japanese · Shift_JIS</option>
                                    <option value="euc-jp">Japanese · EUC-JP</option>
                                </select>
                            </div>
                        )}
                    </div>
                ) : (
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-xl border border-dashed border-indigo-300/40 py-3 mb-3 text-[12.5px] text-indigo-100/90 flex items-center justify-center gap-2 active:bg-white/5">
                        <UploadSimple size={16} weight="bold" /> Choose a .txt / .pdf File (large files OK)
                    </button>
                )}

                <div className="space-y-2.5">
                    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (required)" className={`${uploadFieldClass} text-[13px]`} />
                    <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Author (optional)" className={`${uploadFieldClass} text-[13px]`} />
                    <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="One-line summary (optional, given to characters as background)" className={`${uploadFieldClass} text-[13px]`} />
                    {!fileInfo && (
                        <>
                            <div className="text-[10px] text-indigo-300/50">Or paste the text directly (for short passages; use the file picker above for large files) ↓</div>
                            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste text…" rows={6}
                                className={`${uploadFieldClass} text-[12.5px] leading-relaxed`} />
                        </>
                    )}
                    <div className="text-[10px] text-indigo-300/50">{totalChars.toLocaleString()} characters</div>
                </div>

                {busy ? (
                    <div className="mt-3">
                        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#8b7bf0,#b06ad6)' }} />
                        </div>
                        <div className="text-[11px] text-indigo-200/70 text-center mt-1.5">Processing… {progress}% (large files take a bit)</div>
                    </div>
                ) : (
                    <button onClick={handleSave} disabled={!canSave}
                        className="w-full mt-3 rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        Add to Library
                    </button>
                )}
            </div>
        </div>
    );
};

// ============ Chibi avatar editor (reuses the Special Moments character-creator system) ============
type ChibiSave = { img: string; state?: any; scale: number; offsetY: number; flip: boolean };
const ChibiEditor: React.FC<{
    char: CharacterProfile;
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ char, onClose, onSave }) => {
    const existing = char.vrState?.chibi;
    // Already created one: enter the "Preview + Fine-tune" page; tap "Recreate" to reopen the character creator. Never created one: go straight into the character creator.
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);

    const isSully = (char.name || '').toLowerCase().includes('sully');
    // Backfill: the character creator's init reads presets (a flat map), using the state.selected exported last time
    const presets = existing?.state?.selected || (isSully ? { skin: 'skin_1', fronthair: 'fronthair_99', eyes: 'eyes_99' } : undefined);

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl);
        setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false);
        setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black">
                <div className="flex items-center gap-2 px-4 pb-2 shrink-0 text-white" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingTop: VR_TOP }}>
                    <button onClick={() => existing?.img ? setCreating(false) : onClose()} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                    <span className="text-[14px] font-bold">Craft {char.name}'s Chibi</span>
                </div>
                <div className="flex-1 min-h-0">
                    <CreatorIframe mode="char" charName={char.name} isSully={isSully} presets={presets}
                        savedState={existing?.state}
                        draftKey={`vr_${char.id}`} title={`Craft a Chibi · ${char.name}`} subtitle="Beyond · CHIBI"
                        onConfirm={onConfirm} />
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <VRStyleTag />
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-1">
                    <span className="text-[15px] font-bold text-white">{char.name}'s Beyond Avatar</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">This chibi avatar will stand in Beyond's rooms. You can re-craft it, or fine-tune its position.</p>

                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    <div className="absolute inset-0 opacity-50" style={{ backgroundImage: 'radial-gradient(1.5px 1.5px at 30% 30%, rgba(255,255,255,.5), transparent), radial-gradient(1.5px 1.5px at 70% 50%, rgba(200,220,255,.4), transparent)' }} />
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>

                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> Re-craft the chibi
                </button>

                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> Size
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> Flip Horizontally
                    </button>
                </div>

                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    Save Avatar{char.vrState?.enabled ? '' : ' and Connect'}
                </button>
            </div>
        </div>
    );
};

// ============ The user's own chibi customization (mode="user", same structure as a character chibi) ============
const UserChibiEditor: React.FC<{
    userName: string;
    existing?: { img: string; state?: any; scale?: number; offsetY?: number; flip?: boolean };
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ userName, existing, onClose, onSave }) => {
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);
    const presets = existing?.state?.selected;

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl); setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false); setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black" style={{ paddingTop: VR_TOP }}>
                <CreatorIframe mode="user" charName={userName} presets={presets}
                    savedState={existing?.state}
                    draftKey="vr_user" title={`Craft Yourself · ${userName}`} subtitle="Beyond · Your CHIBI"
                    onConfirm={onConfirm} />
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[15px] font-bold text-white">Your Beyond Avatar</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">This chibi avatar is "you" in Beyond, and stands in whichever room you are hanging out in.</p>
                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>
                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> Re-craft the chibi
                </button>
                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> Size
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> Flip Horizontally
                    </button>
                </div>
                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    Save Avatar
                </button>
            </div>
        </div>
    );
};

// ============ The user's own Beyond connection panel (customize chibi / pick a room / write what you're doing / broadcast) ============
const USER_VR_PRESETS = ["Reading a novel", "Studying / doing problems", "Listening to a song on repeat", "Just idling, zoning out", "Goofing around in the rec room", "Writing a drift letter"];
const UserVRPanel: React.FC<{
    userProfile?: UserProfile;
    updateUserProfile: (u: Partial<UserProfile>) => void;
    onEditChibi: () => void;
    onBroadcast: (room: VRRoomId, activity: string) => Promise<void> | void;
    addToast?: (m: string, t?: any) => void;
}> = ({ userProfile, updateUserProfile, onEditChibi, onBroadcast, addToast }) => {
    const uv = userProfile?.vrState;
    const enabled = !!uv?.enabled;
    const chibi = uv?.chibi;
    const [room, setRoom] = useState<VRRoomId>(uv?.currentRoom || 'guestbook');
    const [activity, setActivity] = useState(uv?.activity || '');

    // Sync the local draft when userProfile changes externally (e.g. right after finishing a chibi)
    useEffect(() => { setRoom(uv?.currentRoom || 'guestbook'); setActivity(uv?.activity || ''); }, [uv?.currentRoom, uv?.activity]);

    const ROOMS: [VRRoomId, string][] = [['library', 'Library'], ['music', 'Music Room'], ['guestbook', 'Guestbook'], ['gym', 'Rec Room'], ['postoffice', 'Post Office']];

    const join = () => {
        if (!chibi?.img) { onEditChibi(); return; } // No chibi made yet → make one first, then come back to connect
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        addToast?.('You are now connected to Beyond', 'success');
        trackEvent('Enable User Beyond Access', { action: 'enable' });
    };
    const logout = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: false } });
        addToast?.('Logged out of Beyond', 'success'); // after logout, the "you are in Beyond" hint in character chat disappears too
        trackEvent('Enable User Beyond Access', { action: 'disable' });
    };
    const saveBroadcast = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        void onBroadcast(room, activity.trim());
    };

    return (
        <div className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'linear-gradient(135deg, rgba(120,130,255,0.10), rgba(150,212,204,0.06))', border: '1px solid rgba(150,168,255,0.22)' }}>
            <div className="flex items-center gap-2.5">
                <button onClick={onEditChibi} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                    {chibi?.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">＋</span>}
                    <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                </button>
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-white truncate">Yourself · {userProfile?.name || 'Me'}</div>
                    <div className="text-[10px] text-indigo-300/60">{enabled ? 'Connected to Beyond · characters can see you here' : chibi?.img ? 'Avatar crafted · not connected' : 'Craft your own chibi to connect to Beyond'}</div>
                </div>
                <button onClick={enabled ? logout : join}
                    className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                    <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                </button>
            </div>
            {enabled && (
                <>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">Which room are you hanging out in</div>
                    <div className="flex flex-wrap gap-1.5">
                        {ROOMS.map(([rid, label]) => (
                            <button key={rid} onClick={() => setRoom(rid)}
                                className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${room === rid ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">What are you doing (characters will see this)</div>
                    <input value={activity} onChange={e => setActivity(e.target.value)}
                        placeholder="e.g. Reading a novel / Studying / Just idling…"
                        className="w-full rounded-lg px-3 py-2 text-[12.5px] text-white placeholder-white/30 outline-none" style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(150,200,255,.2)' }} />
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {USER_VR_PRESETS.map(p => (
                            <button key={p} onClick={() => setActivity(p)} className="text-[10px] rounded-full px-2 py-0.5 bg-white/[0.08] text-indigo-200/60 active:bg-white/15">{p}</button>
                        ))}
                    </div>
                    <button onClick={saveBroadcast}
                        className="mt-3 w-full rounded-xl py-2 text-[12.5px] font-bold text-white" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        Save and Broadcast to All Characters
                    </button>
                    <p className="text-[9.5px] text-indigo-300/45 mt-2 leading-relaxed">Characters will know "what you are doing in Beyond right now" in chat, but they have been told clearly: this is just hanging out in a virtual space, you may not actually be online, and the chat history is what actually matters.</p>
                </>
            )}
        </div>
    );
};

// ============ Connection settings ============
const INTERVAL_OPTIONS = [60, 120, 180, 360, 720];

const NovelPreferenceModal: React.FC<{
    char: CharacterProfile;
    novels: VRWorldNovel[];
    onSave: (novelIds: string[]) => void;
    onClose: () => void;
}> = ({ char, novels, onSave, onClose }) => {
    const validNovelIds = useMemo(() => new Set(novels.map(novel => novel.id)), [novels]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set(
        (char.vrState?.preferredNovelIds || []).filter(id => validNovelIds.has(id)),
    ));
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const pageSize = 18;

    useEffect(() => {
        setSelected(new Set((char.vrState?.preferredNovelIds || []).filter(id => validNovelIds.has(id))));
        setQuery('');
        setPage(0);
    }, [char.id, validNovelIds]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        if (!needle) return novels;
        return novels.filter(novel => `${novel.title}\n${novel.author || ''}`.toLocaleLowerCase().includes(needle));
    }, [novels, query]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

    const toggle = (novelId: string) => {
        setSelected(current => {
            const next = new Set(current);
            if (next.has(novelId)) next.delete(novelId);
            else next.add(novelId);
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-[340] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="flex h-[min(86dvh,760px)] w-full max-w-md flex-col overflow-hidden rounded-t-[28px]"
                style={{ background: 'linear-gradient(180deg,#1d1a31,#0f0d1c)', border: '1px solid rgba(255,255,255,.12)', paddingBottom: vrBottomPad('0px') }}
                onClick={event => event.stopPropagation()}
            >
                <header className="shrink-0 px-4 pt-4 pb-3 border-b border-white/10">
                    <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <h2 className="text-[15px] font-bold text-white">{char.name}'s Reading Preference</h2>
                            <p className="mt-1 text-[10.5px] leading-4 text-indigo-200/55">
                                Without a selection, the character rotates through the whole library; select some to prioritize those.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/55 active:bg-white/10" aria-label="Close reading preference">
                            <X size={18} />
                        </button>
                    </div>
                    <label className="mt-3 flex h-10 items-center gap-2 rounded-xl bg-white/[0.07] px-3 text-indigo-100/60 ring-1 ring-white/10 focus-within:ring-indigo-300/45">
                        <MagnifyingGlass size={15} />
                        <input
                            value={query}
                            onChange={event => { setQuery(event.target.value); setPage(0); }}
                            placeholder={`Search ${novels.length.toLocaleString()} novels`}
                            className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-indigo-200/30"
                        />
                    </label>
                    <div className="mt-2 flex items-center justify-between text-[10px] text-indigo-200/45">
                        <span>{selected.size > 0 ? `${selected.size} prioritized` : 'Currently: auto-rotating through all novels'}</span>
                        {query && <span>Found {filtered.length.toLocaleString()}</span>}
                    </div>
                </header>

                <main className="vr-reader-scroll min-h-0 flex-1 overflow-y-auto px-4 py-1">
                    {visible.length === 0 ? (
                        <div className="grid h-40 place-items-center text-[11px] text-indigo-200/35">No books found</div>
                    ) : visible.map(novel => {
                        const active = selected.has(novel.id);
                        const bookmark = getBookmark(char.vrState?.novelBookmarks, novel.id);
                        const progress = Math.min(100, Math.round(bookmark / Math.max(1, novel.segments.length) * 100));
                        return (
                            <button
                                type="button"
                                key={novel.id}
                                onClick={() => toggle(novel.id)}
                                aria-pressed={active}
                                className="flex w-full items-center gap-3 border-b border-white/[0.07] py-3 text-left active:bg-white/[0.04]"
                            >
                                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border text-white transition-colors ${active ? 'border-indigo-400 bg-indigo-400' : 'border-white/20 bg-white/[0.03]'}`}>
                                    {active && <Check size={12} weight="bold" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12.5px] font-semibold text-white/90">{novel.title}</span>
                                    <span className="mt-0.5 block truncate text-[9.5px] text-indigo-200/40">
                                        {novel.author ? `${novel.author} · ` : ''}{novel.segments.length.toLocaleString()} segments{bookmark > 0 ? ` · ${progress}%` : ''}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </main>

                <footer className="shrink-0 border-t border-white/10 px-4 pt-3">
                    {pageCount > 1 && (
                        <div className="mb-3 flex items-center justify-center gap-4 text-[10px] text-indigo-100/55">
                            <button type="button" onClick={() => setPage(value => Math.max(0, value - 1))} disabled={currentPage === 0} className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.06] disabled:opacity-25" aria-label="Previous page"><CaretLeft size={13} weight="bold" /></button>
                            <span className="tabular-nums">{currentPage + 1} / {pageCount}</span>
                            <button type="button" onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} disabled={currentPage >= pageCount - 1} className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.06] disabled:opacity-25" aria-label="Next page"><CaretRight size={13} weight="bold" /></button>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="flex-1 rounded-xl border border-white/15 py-2.5 text-[12px] text-white/65 disabled:opacity-30">Restore Auto-Rotate</button>
                        <button type="button" onClick={() => onSave(Array.from(selected))} className="flex-1 rounded-xl py-2.5 text-[12px] font-bold text-white" style={{ background: 'linear-gradient(120deg,rgba(128,145,245,.95),rgba(171,142,235,.95))' }}>Save Preference</button>
                    </div>
                </footer>
            </div>
        </div>
    );
};

const SettingsView: React.FC<{
    characters: CharacterProfile[];
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void;
    addToast?: (msg: string, type?: any) => void;
    novels: VRWorldNovel[]; onReload: () => void;
    onRequestEnable: (char: CharacterProfile) => void;
    onEditChibi: (char: CharacterProfile) => void;
    onEditReadingPreference: (char: CharacterProfile) => void;
}> = ({ characters, updateCharacter, addToast, novels, onReload, onRequestEnable, onEditChibi, onEditReadingPreference }) => {
    const [pickFor, setPickFor] = useState<CharacterProfile | null>(null);
    // Group filter for the connection list (characters comes in via props, so just pull characterGroups separately here)
    const { characterGroups } = useOS();
    const [settingsGroupId, setSettingsGroupId] = useState<string>(GROUP_FILTER_ALL);
    const novelCount = novels.length;
    const validNovelIds = useMemo(() => new Set(novels.map(novel => novel.id)), [novels]);
    const go = (room?: VRRoomId) => {
        if (!pickFor) return;
        VRScheduler.triggerNow(pickFor.id, room);
        addToast?.(`${pickFor.name} is logging into Beyond…`, 'info');
        setTimeout(onReload, 4000);
        setPickFor(null);
    };

    const disable = (char: CharacterProfile) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || { intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), enabled: false } as any });
        VRScheduler.stop(char.id);
        trackEvent('Enable Character Beyond Access', { action: 'disable' });
    };
    const setInterval = (char: CharacterProfile, minutes: number) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: char.vrState?.enabled ?? true, intervalMinutes: minutes } });
        if (char.vrState?.enabled) VRScheduler.start(char.id, minutes);
    };

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                Once enabled, the character logs into "Beyond" on their own at the interval you set, reading novels you uploaded and writing annotations in the library. Each visit leaves an update card in their chat, and gets captured by memory summarization.
                {VR_FAIL_LIMIT} consecutive failed model calls in a row (e.g. an expired API token) will auto-pause the character, so it does not keep running for nothing.
                {novelCount === 0 && <span className="text-amber-300/80"> The library is still empty, go upload one in "Library" first.</span>}
            </p>
            {characters.length === 0 && <p className="text-[11px] text-indigo-300/50 py-4 text-center">No characters yet.</p>}
            {/* Group filter (doesn't render if no groups exist): dark background */}
            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                value={settingsGroupId} onChange={setSettingsGroupId} />
            {characters.length > 0 && filterCharactersByGroup(characters, characterGroups, settingsGroupId).length === 0 &&
                <p className="text-[11px] text-indigo-300/50 py-4 text-center">No characters in this group</p>}
            {filterCharactersByGroup(characters, characterGroups, settingsGroupId).map(char => {
                const st = char.vrState;
                const enabled = !!st?.enabled;
                const interval = st?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                const chibi = getChibi(char);
                const failStreak = VRScheduler.getFailStreak(char.id);
                const preferredNovelCount = (st?.preferredNovelIds || []).filter(id => validNovelIds.has(id)).length;
                return (
                    <div key={char.id} className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2.5">
                            {/* Chibi thumbnail */}
                            <button onClick={() => onEditChibi(char)} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                                {chibi.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">?</span>}
                                <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                            </button>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{char.name}</div>
                                {enabled ? (
                                    <div className="text-[10px] text-indigo-300/60">
                                        Logs in every {interval >= 60 ? `${formatHours(interval)}h` : `${interval}min`}
                                        {/* Background failures would otherwise be completely silent; surface them to the user before they build up to the circuit-breaker limit */}
                                        {failStreak > 0 && <span className="text-amber-300/80"> · {failStreak} consecutive calls failed</span>}
                                    </div>
                                ) : <div className="text-[10px] text-indigo-300/40">{chibi.isFallback ? 'No avatar set · not connected' : 'Not connected'}</div>}
                            </div>
                            <button onClick={() => enabled ? disable(char) : onRequestEnable(char)}
                                className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                        {enabled && (
                            <>
                                <div className="flex flex-wrap gap-1.5 mt-2.5">
                                    {INTERVAL_OPTIONS.map(opt => (
                                        <button key={opt} onClick={() => setInterval(char, opt)}
                                            className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${interval === opt ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                            {opt >= 60 ? `${formatHours(opt)}h` : `${opt}min`}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={() => setPickFor(char)}
                                    className="mt-2.5 text-[11px] text-amber-200 font-semibold flex items-center gap-1 active:opacity-70">
                                    <Play size={12} weight="fill" /> Send them to visit now
                                </button>
                            </>
                        )}
                        {novelCount > 0 && (
                            <button onClick={() => onEditReadingPreference(char)}
                                className="mt-2.5 flex w-full items-center gap-2 border-t border-white/[0.07] pt-2.5 text-left active:opacity-70">
                                <BookOpen size={13} weight="fill" className="text-indigo-200/70" />
                                <span className="text-[11px] font-semibold text-indigo-100/75">Reading Preference</span>
                                <span className="ml-auto text-[10px] text-indigo-300/45">{preferredNovelCount > 0 ? `${preferredNovelCount} prioritized` : 'Auto-rotating all'}</span>
                                <CaretRight size={11} weight="bold" className="text-indigo-300/35" />
                            </button>
                        )}
                    </div>
                );
            })}
            <ActionSheet open={!!pickFor} title={pickFor ? `Which room should ${pickFor.name} visit now?` : ''}
                actions={[
                    { label: 'Random room', onClick: () => go() },
                    ...(novelCount > 0 ? [{ label: 'Library · read and write annotations', onClick: () => go('library') }] : []),
                    { label: 'Theater · write a play submission', onClick: () => go('theater') },
                    { label: 'Music Room · pick a song and comment', onClick: () => go('music') },
                    { label: 'Guestbook · post and chat', onClick: () => go('guestbook') },
                    { label: 'Rec Room · goof around', onClick: () => go('gym') },
                    { label: 'Post Office · write a drift letter', onClick: () => go('postoffice') },
                    // Signal Fall isn't listed here: participation always goes through the event banner → the panel's "✍ Participate" button, since only that path carries the "whisper"
                ]} onClose={() => setPickFor(null)} />
        </div>
    );
};

// ============ Beyond · API settings + call log ============
const VRApiSettings: React.FC<{ apiPresets: ApiPreset[]; chatApi: APIConfig; addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ apiPresets, chatApi, addToast, characters }) => {
    const [vrApi, setVr] = useState<APIConfig | null>(null);
    const [log, setLog] = useState<VRApiCall[]>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);
    const [presetsOpen, setPresetsOpen] = useState(false);   // Collapse the long "Saved Presets" list
    const [snapshot, setSnapshot] = useState<string | null>(null);   // Diagnostic snapshot body text
    const [collecting, setCollecting] = useState(false);

    useEffect(() => {
        void getVRApi().then(setVr);
        void getVRApiLog().then(setLog);
        const h = () => { void getVRApiLog().then(setLog); };
        window.addEventListener('vr-api-log', h);
        return () => window.removeEventListener('vr-api-log', h);
    }, []);

    const follow = !vrApi?.baseUrl;
    const effective = follow ? chatApi : vrApi!;
    const sameAs = (c: APIConfig) => !follow && vrApi!.baseUrl === c.baseUrl && vrApi!.model === c.model && vrApi!.apiKey === c.apiKey;
    const host = (u?: string) => { try { return u ? new URL(u).host : '—'; } catch { return u || '—'; } };

    const choose = (cfg: APIConfig | null) => {
        void setVRApi(cfg); setVr(cfg); setTestResult(null);
        addToast?.(cfg ? 'Switched Beyond API' : 'Beyond now follows the chat default', 'success');
    };

    const test = async () => {
        const cfg = effective;
        if (!cfg?.baseUrl) { setTestResult('No API available right now'); return; }
        setTesting(true); setTestResult(null);
        try {
            const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey || 'sk-none'}` },
                body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false }),
            });
            if (res.ok) { const d = await safeResponseJson(res); const r = d.choices?.[0]?.message?.content || ''; setTestResult(`Connected -- model replied: "${r.slice(0, 24)}"`); }
            else { const t = await res.text().catch(() => ''); setTestResult(`HTTP ${res.status}: ${t.slice(0, 80)}`); }
        } catch (e: any) { setTestResult(`Connection failed: ${e.message}`); } finally { setTesting(false); }
    };

    // There's no console on mobile, so a problem like "the log keeps growing even with every panel closed" is hard to explain with just a screenshot.
    // Gather everything worth looking at in one shot, ready to copy and send; it's all state -- no names, chat content, or keys.
    const exportSnapshot = async () => {
        setCollecting(true);
        try {
            const text = await collectVRDiagnostics(characters, chatApi);
            setSnapshot(text);
            try {
                await navigator.clipboard.writeText(text);
                addToast?.('Diagnostic snapshot copied, paste it straight to the developer', 'success');
            } catch {
                // The clipboard being blocked by the browser isn't a real failure either -- the text is laid out below, and a screenshot of it works just as well
                addToast?.('Snapshot generated (this device does not allow auto-copy, hold the text below to select it)', 'info');
            }
        } catch (e: any) {
            addToast?.(`Collection failed: ${e?.message || e}`, 'error');
        } finally { setCollecting(false); }
    };

    // The log mixes two kinds of rows: actual model calls, and diagnostic rows for "the scheduler fired but never reached the model."
    // Reconciliation should only look at the former -- counting diagnostic rows into the denominator would distort the "how many succeeded" figure.
    const calls = log.filter(l => !l.kind);
    const okCount = calls.filter(l => l.ok).length;

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                Characters in Beyond autonomously trigger model calls at intervals, which uses a fair amount of API. You can give Beyond <b className="text-indigo-200">its own API</b> here (shared with the presets saved in "Settings"), or leave it unset to follow the chat default.
            </p>

            {/* Currently in effect */}
            <div className="rounded-2xl p-3.5" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/60 mb-1.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>Currently In Effect</div>
                <div className="text-[12.5px] text-white/90 font-semibold">{effective?.model || 'Not configured'}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{host(effective?.baseUrl)} · {follow ? 'Following chat default' : 'Beyond-specific'}</div>
                <button onClick={test} disabled={testing} className="mt-2.5 text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {testing ? 'Testing…' : 'Test Connection'}
                </button>
                {testResult && <div className={`mt-2 text-[10.5px] px-2.5 py-1.5 rounded-lg leading-snug ${testResult.startsWith('Connected') ? 'text-emerald-300' : 'text-rose-300'}`} style={{ background: 'rgba(0,0,0,.25)' }}>{testResult}</div>}
            </div>

            {/* Choose an API */}
            <div>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5 px-0.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>Choose Beyond API</div>
                <button onClick={() => choose(null)}
                    className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                    style={{ background: follow ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${follow ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-white/90 font-semibold">Follow chat default</div>
                        <div className="text-[10px] text-white/40 truncate">{chatApi?.model || 'Not configured'} · {host(chatApi?.baseUrl)}</div>
                    </div>
                    {follow && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ In use</span>}
                </button>
                {apiPresets.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 px-1 py-1.5">No API presets saved in "Settings" yet. Save a few models there, and they will show up here.</p>
                ) : (() => {
                    const activePreset = apiPresets.find(p => sameAs(p.config));
                    const shown = presetsOpen ? apiPresets : (activePreset ? [activePreset] : []);
                    return (
                        <>
                            <button onClick={() => setPresetsOpen(o => !o)}
                                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 mb-1.5 text-left active:bg-white/5"
                                style={{ border: '1px solid rgba(255,255,255,.07)' }}>
                                <span className="text-[10.5px] text-white/55">Saved Presets</span>
                                <span className="text-[9.5px] text-white/35 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{apiPresets.length}</span>
                                {!presetsOpen && activePreset && <span className="text-[9.5px] text-sky-300/70 truncate">Current · {activePreset.name}</span>}
                                <span className="ml-auto text-[10px] text-white/40">{presetsOpen ? 'Collapse' : 'Expand'}</span>
                            </button>
                            {shown.map(p => {
                                const on = sameAs(p.config);
                                return (
                                    <button key={p.id} onClick={() => choose(p.config)}
                                        className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                                        style={{ background: on ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${on ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] text-white/90 font-semibold truncate">{p.name}</div>
                                            <div className="text-[10px] text-white/40 truncate">{p.config.model} · {host(p.config.baseUrl)}</div>
                                        </div>
                                        {on && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ In use</span>}
                                    </button>
                                );
                            })}
                        </>
                    );
                })()}
            </div>

            {/* Call log */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>Call Log</span>
                    <span className="text-[9.5px] text-white/40 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{calls.length}{calls.length ? ` · ${okCount} succeeded` : ''}</span>
                    {log.length > 0 && <button onClick={() => { void clearVRApiLog(); setLog([]); }} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">Clear</button>}
                </div>
                {log.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 py-2 text-center">No calls yet. Every model call triggered by a character logging into Beyond gets recorded here for you to reconcile.</p>
                ) : (
                    <div className="space-y-1">
                        {log.slice(0, 60).map((l, i) => {
                            const diag = !!l.kind;   // Diagnostic row: the scheduler fired on time, but this round never reached the model
                            return (
                                <div key={i} className="flex items-start gap-2 text-[10.5px] py-1 border-b border-white/5 last:border-0">
                                    <span className={`shrink-0 ${diag ? 'text-amber-400/70' : l.ok ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>{diag ? '◌' : l.ok ? '●' : '○'}</span>
                                    <span className="text-white/75 truncate shrink-0">{l.charName || l.charId?.slice(-4) || '—'}</span>
                                    {diag ? (
                                        <span className="flex-1 min-w-0 text-amber-200/55 leading-snug">{l.note}</span>
                                    ) : (
                                        <>
                                            <span className="text-indigo-300/40 shrink-0">{l.room ? getRoom(l.room as VRRoomId).name : ''}</span>
                                            {/* A request went out even though the connection was clearly off -- this is exactly the "won't turn off" evidence, flag it so it doesn't blend in with the red dots */}
                                            {l.charEnabled === false && <span className="text-rose-300/75 shrink-0">sent while disconnected</span>}
                                            <span className="ml-auto text-white/30 shrink-0 tabular-nums">{(l.ms / 1000).toFixed(1)}s</span>
                                        </>
                                    )}
                                    <span className="text-white/35 shrink-0 tabular-nums w-[68px] text-right">{new Date(l.ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Diagnostic snapshot */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>Diagnostic Snapshot</span>
                    {snapshot && <button onClick={() => setSnapshot(null)} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">Collapse</button>}
                </div>
                <p className="text-[10.5px] text-white/40 leading-relaxed mb-2">
                    A character keeps calling even though it is not connected, or a setting reverts after a while -- when something like this is hard to explain, tap once to gather the current state into text and send it to the developer.
                    It only contains toggles, timestamps, and usage, <b className="text-indigo-200/70">no character names, chat history, or API keys</b>.
                </p>
                <button onClick={exportSnapshot} disabled={collecting}
                    className="text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {collecting ? 'Collecting…' : 'Generate and Copy'}
                </button>
                {snapshot && (
                    <pre className="mt-2.5 max-h-64 overflow-auto text-[9.5px] leading-relaxed text-white/55 whitespace-pre-wrap break-all select-all p-2 rounded-lg"
                        style={{ background: 'rgba(0,0,0,.3)' }}>{snapshot}</pre>
                )}
            </div>
        </div>
    );
};

// ============ Animation keyframes ============
const VRStyleTag: React.FC = () => (
    <style>{`
        @keyframes vrfloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes vrwave { from { transform: scaleY(0.5); } to { transform: scaleY(1.05); } }
        @keyframes vrdance { 0%{transform:translateY(0) rotate(-5deg)} 25%{transform:translateY(-9px) rotate(3deg)} 50%{transform:translateY(0) rotate(5deg)} 75%{transform:translateY(-9px) rotate(-3deg)} 100%{transform:translateY(0) rotate(-5deg)} }
        @keyframes vraurora { 0%,100%{transform:translate(0,0) scale(1);opacity:.75} 50%{transform:translate(6%,4%) scale(1.14);opacity:1} }
        @keyframes vrtwinkle { 0%,100%{opacity:.5} 50%{opacity:.85} }
        /* Signal Fall · electronic satellite orbit (pure transform/opacity, GPU-composited, mobile-friendly) */
        @keyframes sigorbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes sigpulse { 0%,100% { transform: scale(1); opacity: .8; } 50% { transform: scale(1.12); opacity: 1; } }
        @keyframes sigblink { 0%,88%,100% { opacity: 0; } 90%,96% { opacity: 1; } }
    `}</style>
);

export default VRWorldApp;
