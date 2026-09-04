import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Message, MessageType, MemoryFragment, Emoji, EmojiCategory, DailySchedule, ScheduleSlot } from '../types';
import { processImage, processImageToBlob } from '../utils/file';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import { buildChatFineTuneCss, mergeChatFineTune } from '../utils/chatFineTuneCss';
import ChatFineTunePanel from '../components/chat/ChatFineTunePanel';
import TokenImg from '../components/os/TokenImg';
import { FadersHorizontal } from '@phosphor-icons/react';
import { generateDailyScheduleForChar, isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../utils/timezone';
import { generateSlotTheater } from '../utils/theaterGenerator';
import TheaterPlayer from '../components/schedule/TheaterPlayer';
import { formatMessageWithTime, normalizeMessageContent } from '../utils/messageFormat';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { XhsMcpClient, extractNotesFromMcpData, normalizeXhsLiteDetail } from '../utils/xhsMcpClient';
import { extractWebpageContent, detectFirstUrl, detectXhsShortUrl, extractXhsShareTitle, isXhsUrl, extractXhsNoteId, expandShortUrl, type ExtractedWebpage } from '../utils/webpageExtractor';
import { isVideoShareUrl, parseVideoShareUrl } from '../utils/videoParser';
import { isDevDebugAvailable } from '../utils/devDebug';
import { isImageValue, migrateDataUrlToRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import { resolveLifeRecordCard } from '../utils/lifeRecords';
import { isMcdConfigured } from '../utils/mcdMcpClient';
import { isMcdActivatedInMessages, MCD_ACTIVATE_TRIGGER, MCD_DEACTIVATE_TRIGGER } from '../utils/mcdToolBridge';
import { isLuckinConfigured } from '../utils/luckinMcpClient';
import { isLuckinActivatedInMessages, LUCKIN_ACTIVATE_TRIGGER, LUCKIN_DEACTIVATE_TRIGGER } from '../utils/luckinToolBridge';
import MessageItem, { ThinkingChainBlock } from '../components/chat/MessageItem';
import McdMiniApp from '../components/mcd/McdMiniApp';
import LuckinMiniApp from '../components/luckin/LuckinMiniApp';
import LuckinLocationModal from '../components/luckin/LuckinLocationModal';
import LuckinHelpModal from '../components/luckin/LuckinHelpModal';
import { PRESET_THEMES, DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import { resolveChatTheme } from '../utils/groupChat/theme';
import ChatHeader from '../components/chat/ChatHeaderShell';
import CharacterEntryTransition from '../components/chat/CharacterEntryTransition';
import ChromeCssEditor from '../components/chat/ChromeCssEditor';
import ChatInputArea from '../components/chat/ChatInputArea';
import InstantChatRouteNotice from '../components/chat/InstantChatRouteNotice';
import MemoryRepairPortal from '../components/chat/MemoryRepairPortal';
import FavoritesPortal from '../components/chat/VoiceFavoritesPortal';
import ChatModals from '../components/chat/ChatModals';
import Modal from '../components/os/Modal';
import ProactiveSettingsModal from '../components/chat/ProactiveSettingsModal';
import ActiveMsg2SettingsModal from '../components/chat/ActiveMsg2SettingsModal';
import ThinkingChainSettingsModal from '../components/chat/ThinkingChainSettingsModal';
import ScheduleChangeNotice from '../components/chat/ScheduleChangeNotice';
import { useChatAI } from '../hooks/useChatAI';
import { cleanTextForTts, parseVoiceOutput } from '../utils/minimaxTts';
import { collectVoiceBatchSubtitle, isPoisonedVoiceSubtitle } from '../utils/voiceSubtitle';
import {
    canSynthesizeSpeech,
    characterHasVoice,
    cleanTextForTtsProvider,
    providerUsesRawVoiceMarkup,
    stripTtsMarkupForDisplay,
    synthesizeSpeechDetailed,
} from '../utils/ttsRouter';
import { shouldAutoGenerateVoice, shouldAutoPlayGeneratedVoice } from '../utils/voicePlayback';
import { voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from '../utils/voiceLanguage';
import { fetchBlobForShare, shareOrDownloadBlob } from '../utils/shareExport';
import { CollaborationStore } from '../features/collaboration/store';
import { resolveTtsProvider } from '../utils/ttsProvider';
import { isInstantConfigReady, loadInstantConfig } from '../utils/instantPushClient';
import { resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio, parseWhiteboxSound, upsertWhiteboxSound, stripWhiteboxSoundDirective, WhiteboxSound } from '../utils/whiteboxSound';
import WhiteboxSoundEditor from '../components/chat/WhiteboxSoundEditor';
import { normalizeTranslationLangLabel, isTranslationLangPreset } from '../utils/translationLang';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent, noteMessageSent, presetOrCustom } from '../utils/analytics';
import { markAmsgStateDirty, markAmsgStateDirtyForAll } from '../utils/amsgStateSync';
import { AMSG_INSTANT_CHAT_PENDING_EVENT, AMSG_INSTANT_CHAT_PENDING_LS_KEY, getInstantChatPending } from '../utils/amsgInstantChat';
import { formatAmsgToolTrace } from '../utils/amsgToolTrace';
import { formatHours } from '../utils/format';
import {
    VOICE_FAVORITES_CHANGED_EVENT,
    getVoiceFavorite,
    listVoiceFavorites,
    removeVoiceFavorite,
    saveVoiceFavorite,
} from '../utils/voiceFavorites';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    contentFavoriteIdForMessage,
    listContentFavorites,
    removeContentFavoriteById,
    saveMessageContentFavorite,
} from '../utils/contentFavorites';
import { SCHEDULE_CHANGE_EVENT, type ScheduleChangeEventDetail } from '../utils/scheduleChange';
import {
    CONTEXT_RANGE_POLICY_VERSION,
    computeContextRangeSnapshot,
    countMessagesFrom,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
    resolveContextRangeMode,
    type ContextRangeMode,
} from '../utils/chatContextRange';
import {
    createChatHistoryWindow,
    expandChatHistoryWindow,
    type ChatHistoryWindowRange,
} from '../utils/chatHistoryWindow';
import type { CollaborationTransferMessage } from '../features/collaboration/types';
import type { CollaborationInstallableArtifact } from '../features/collaboration/types';
import {
    installableToCharacterPatch,
    installableToChatTheme,
    installableToThemePatch,
    installableToWorldbooks,
    validateInstallableArtifact,
} from '../features/collaboration/makers';
import { upsertMountedWorldbooks } from '../utils/worldbook';

const CollaborationWindow = React.lazy(() => import('../features/collaboration/CollaborationWindow'));

const HISTORY_WINDOW_RADIUS = 25;
const HISTORY_WINDOW_BATCH_SIZE = 30;

const isVisibleChatMessage = (message: Message, hideSystemLogs = false) => (
    message.metadata?.source !== 'date'
    && message.metadata?.source !== 'call'
    && message.metadata?.source !== 'story_theater_memory'
    && !message.metadata?.proactiveHint
    && !(hideSystemLogs && message.role === 'system' && message.type !== 'score_card')
);

/** Grace window for Instant Chat's "pushes trickling in" for that round of replies — i.e. how long the auto-synthesis catch-up scan window lasts (see the auto-TTS effect below). */
const INSTANT_VOICE_SCAN_WINDOW_MS = 30_000;
type InstantToolUiStatus = {
    charId: string;
    phase: 'running' | 'continuing' | 'done' | 'failed';
    text: string;
    sessionId?: string;
    updatedAt?: number;
};

const Chat: React.FC = () => {
    const { characters, activeCharacterId, setActiveCharacterId, addCharacter, updateCharacter, apiConfig, apiPresets, availableModels, addApiPreset, closeApp, customThemes, addCustomTheme, removeCustomTheme, addWorldbook, updateTheme, saveAppearancePreset, addToast, showError, userProfile, lastMsgTimestamp, groups, characterGroups, clearUnread, unreadMessages, realtimeConfig, memoryPalaceConfig, updateMemoryPalaceConfig, remoteVectorConfig, syncEmotionApiToAllCharacters, theme: osTheme, proactiveComposingChars, openDateWithChar } = useOS();
    const isProactiveComposing = !!(activeCharacterId && proactiveComposingChars[activeCharacterId]);
    const localDateKey = useLocalDateKey();

    // Memory Palace high water mark (used for the safety check when clearing chat)
    const getMemoryPalaceHWM = useCallback(async (charId: string): Promise<number> => {
        try {
            const { getMemoryPalaceHighWaterMark } = await import('../utils/memoryPalace/pipeline');
            return getMemoryPalaceHighWaterMark(charId);
        } catch { return 0; }
    }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    // Instant Push path: the "preparing" three dots = the message is being assembled + sent; it
    // disappearing = the SSE POST has been queued into the browser's network stack. On page close,
    // the SSE is proactively aborted so the worker falls back to Web Push as much as possible.
    const [instantSendingActive, setInstantSendingActive] = useState(false);
    // Instant Chat: this round has already been handed off to the cloud and hasn't gotten a reply
    // back yet. Different from isTyping — generation doesn't run on this device, so it has to survive
    // the page being closed and reopened (the record lives in localStorage, see amsgInstantChat).
    const [instantChatPending, setInstantChatPending] = useState(false);
    const [instantToolStatus, setInstantToolStatus] = useState<InstantToolUiStatus | null>(null);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const [visibleCount, setVisibleCount] = useState(30);
    const [windowedFocusMsgId, setWindowedFocusMsgId] = useState<number | null>(null);
    const [historyWindowRange, setHistoryWindowRange] = useState<ChatHistoryWindowRange | null>(null);
    const [flashMsgId, setFlashMsgId] = useState<number | null>(null);
    // Fade-in switch for character switch/enter: starts false (transparent), flips to true next
    // frame, so a CSS transition fades it in smoothly. Starting at false means even the first open
    // fades in too, with no "show then go transparent" flicker.
    // Whether the character-switch "entry" transition is shown. Set true by useLayoutEffect before
    // paint when switching/entering a character, covering the load so it doesn't flash to the new chat.
    const [showEntry, setShowEntry] = useState(false);
    const [input, setInput] = useState('');
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [collaborationOpen, setCollaborationOpen] = useState(false);
    const [collaborationPreviewAssetId, setCollaborationPreviewAssetId] = useState<string | null>(null);
    const [memoryRepairOpen, setMemoryRepairOpen] = useState(false);
    const [favoritesOpen, setFavoritesOpen] = useState(false);
    
    // Emoji State
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [activeCategory, setActiveCategory] = useState<string>('default');
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newEmojiName, setNewEmojiName] = useState(''); // Emoji rename input field

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMsgIdRef = useRef<number | null>(null);
    // On mobile, the latest image decoding asynchronously keeps pushing the message list further
    // down. Track that message, and once its real height settles, re-anchor to the bottom once more;
    // the moment the user scrolls up on their own, clear it — never fight the user for scroll position.
    const pendingMediaAutoScrollIdRef = useRef<number | null>(null);
    const scrollThrottleRef = useRef(0);
    const visibleCountRef = useRef(30);
    const pendingFavoriteJumpRef = useRef<{ charId: string; messageId: number } | null>(null);
    const historyWindowRangeRef = useRef<ChatHistoryWindowRange | null>(null);
    const historyWindowTotalRef = useRef(0);
    const historyWindowLoadingRef = useRef(false);
    const historyPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const historyJumpUnlockTimerRef = useRef<number | null>(null);
    const historyWindowScrollEnabledRef = useRef(false);
    const activeCharIdRef = useRef(activeCharacterId);
    // A real message that took over from a streaming preview always skips the entry animation for
    // the rest of this session, so a later DB refresh doesn't re-add the animation class.
    const streamPreviewHandoverIdsRef = useRef<Set<number>>(new Set());
    const registerStreamPreviewHandover = useCallback((charId: string, messageIds: number[]) => {
        if (activeCharIdRef.current !== charId) return;
        messageIds.forEach(id => streamPreviewHandoverIdsRef.current.add(id));
    }, []);
    const charRef = useRef<typeof char>(null as any);
    // Whitebox notification sound: tracks the current character's "highest message ID seen" +
    // "arrival time of the last bubble" — plays only once on the first bubble of a reply round.
    // The max-id baseline naturally guards against: switching/entering a character (baseline is
    // recorded first, no sound), scrolling back through old history (trailing ID goes down, no sound),
    // sending your own message (role != assistant, no sound).
    // lastAt dedupes rounds: their one reply gets split into multiple bubbles sent out one at a time
    // (gap <= 2s) — only counts as a new round (and plays) once the gap since the last bubble exceeds 3s.
    const soundSyncRef = useRef<{ charId: string | null; maxId: number | null; lastAt: number | null }>({ charId: null, maxId: null, lastAt: null });
    // Round-dedup threshold: max gap between bubbles = clamp(charCount*50,500,2000)=2s; 3s is chosen
    // to safely merge the same round, since a cross-round gap (LLM latency) is usually much larger.
    const SOUND_ROUND_GAP_MS = 3000;

    // Reply Logic
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);

    const [modalType, setModalType] = useState<'none' | 'transfer' | 'emoji-import' | 'chat-settings' | 'message-options' | 'edit-message' | 'delete-emoji' | 'delete-category' | 'add-category' | 'history-manager' | 'archive-settings' | 'prompt-editor' | 'category-options' | 'category-visibility' | 'emoji-options' | 'rename-emoji' | 'schedule' | 'chrome-css' | 'chrome-sound' | 'memory-vectorize-confirm' | 'memory-vectorize-result'>('none');
    // "Chat Styling" floating state: not a full-screen modal — a round bubble hangs over the chat,
    // and tapping it opens a small panel so you can tune it while watching the real chat.
    const [fineTuneOpen, setFineTuneOpen] = useState(false);          // Round bubble is present
    const [fineTunePanelOpen, setFineTunePanelOpen] = useState(false); // Small panel expanded/collapsed
    // Close the styling bubble when switching characters: customization is per-character, avoid
    // accidentally editing the next character's settings
    useEffect(() => { setFineTuneOpen(false); setFineTunePanelOpen(false); }, [activeCharacterId]);
    const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
    const [scheduleChangeNotice, setScheduleChangeNotice] = useState<ScheduleChangeEventDetail | null>(null);
    const dismissScheduleChangeNotice = useCallback(() => setScheduleChangeNotice(null), []);
    // Theater (peek performance): index of the currently-playing time slot (null = not open), plus a generating flag
    const [theaterSlotIdx, setTheaterSlotIdx] = useState<number | null>(null);
    const [isTheaterGenerating, setIsTheaterGenerating] = useState(false);
    const [isScheduleGenerating, setIsScheduleGenerating] = useState(false);
    const [allHistoryMessages, setAllHistoryMessages] = useState<Message[]>([]);
    const [transferAmt, setTransferAmt] = useState('');
    const [transferNote, setTransferNote] = useState('');
    const [emojiImportText, setEmojiImportText] = useState('');
    const [settingsContextLimit, setSettingsContextLimit] = useState(500);
    const [settingsContextRangeMode, setSettingsContextRangeMode] = useState<ContextRangeMode>('manual');
    const [settingsHideSysLogs, setSettingsHideSysLogs] = useState(false);
    const [settingsHtmlModeCustomPrompt, setSettingsHtmlModeCustomPrompt] = useState('');
    const contextSuiteAnyEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        || memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        || memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const contextSuiteAllEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        && memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        && memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const [preserveContext, setPreserveContext] = useState(true);
    const [isVectorizing, setIsVectorizing] = useState(false);
    // Memory Palace "one-click save": computes the pending count when the settings modal opens
    // (the real figure, excluding the hot zone), shows round-by-round progress while processing
    const [vectorizePendingCount, setVectorizePendingCount] = useState<number | null>(null);
    const [vectorizeProgress, setVectorizeProgress] = useState('');
    const [retainRecentForVectorize, setRetainRecentForVectorize] = useState(false);
    const [vectorizeResult, setVectorizeResult] = useState<{
        processedMessages: number;
        storedMemories: number;
        retainedMessages: number;
        waterlineAlreadyAhead: boolean;
    } | null>(null);
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [selectedEmoji, setSelectedEmoji] = useState<Emoji | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<EmojiCategory | null>(null); // For deletion modal
    const [editContent, setEditContent] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [archiveProgress, setArchiveProgress] = useState('');
    const [showProactiveModal, setShowProactiveModal] = useState(false);
    const [showActiveMsg2Modal, setShowActiveMsg2Modal] = useState(false);
    const [showThinkingChainModal, setShowThinkingChainModal] = useState(false);

    // Archive Prompts State
    const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
    const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
    const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);

    // --- Multi-Select State ---
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
    // A thinking chain is metadata.thinkingChain — it has no id of its own, so the host message's
    // id is used as the key, existing in parallel with selectedMsgIds — checking only the thinking
    // chain clears just the metadata, keeping the host message.
    const [selectedThinkingMsgIds, setSelectedThinkingMsgIds] = useState<Set<number>>(new Set());

    // --- Translation State (per-character) ---
    const [translationEnabled, setTranslationEnabled] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    const [translateSourceLang, setTranslateSourceLang] = useState(() => {
        // Fallback to legacy global key so existing users don't lose their setting on upgrade.
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_source_lang')
            || '日本語') || '日本語';
    });
    const [translateTargetLang, setTranslateTargetLang] = useState(() => {
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_lang')
            || '中文') || '中文';
    });
    const [translationExpanded, setTranslationExpanded] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    // Which messages are currently showing the translated version (toggle state only, no API calls)
    const [showingTargetIds, setShowingTargetIds] = useState<Set<number>>(new Set());

    const char = characters.find(c => c.id === activeCharacterId) || characters[0];
    const memoryRepairRound = useMemo(() => {
        let assistantIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                assistantIndex = i;
                break;
            }
        }
        if (assistantIndex < 0) {
            return { sinceTs: Date.now(), userMessage: '', assistantReply: '' };
        }
        let userIndex = -1;
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                userIndex = i;
                break;
            }
        }
        const assistantReply = messages
            .slice(userIndex + 1)
            .filter(message => message.role === 'assistant')
            .map(message => message.content)
            .join('\n');
        return {
            // The receipt is produced after the user message is saved but before the assistant reply
            // is saved; leave a 1-second clock-drift tolerance.
            sinceTs: userIndex >= 0 ? Math.max(0, messages[userIndex].timestamp - 1000) : messages[assistantIndex].timestamp - 60_000,
            userMessage: userIndex >= 0 ? messages[userIndex].content : '',
            assistantReply,
        };
    }, [messages]);
    const charDateKey = useLocalDateKey(resolveCharTimeZone(char));
    charRef.current = char; // Keep ref in sync for async callbacks
    const historyContextRange = useMemo(() => {
        if (!char) return undefined;
        return computeContextRangeSnapshot(
            allHistoryMessages,
            {
                ...char,
                contextRangeMode: settingsContextRangeMode,
                contextLimit: settingsContextLimit,
            },
            getMemoryPalaceHighWaterMarkForContext(char.id),
        );
    }, [
        allHistoryMessages,
        char,
        settingsContextLimit,
        settingsContextRangeMode,
    ]);
    useEffect(() => {
        if (
            modalType !== 'history-manager'
            || allHistoryMessages.length === 0
            || !char?.contextUserStartMessageId
            || !historyContextRange?.userBreakpointExpired
        ) return;
        // The max range has already moved past the user breakpoint: clear the persisted breakpoint
        // right away, so an old breakpoint doesn't come back to life if the range is widened later.
        updateCharacter(char.id, { contextUserStartMessageId: undefined });
    }, [
        modalType,
        allHistoryMessages.length,
        char?.id,
        char?.contextUserStartMessageId,
        historyContextRange?.userBreakpointExpired,
        updateCharacter,
    ]);
    const currentThemeId = char?.bubbleStyle || 'default';
    // Resolution logic factored out to utils/groupChat/theme.ts (shared with Group Chat), behavior unchanged
    const activeTheme = useMemo(
        () => resolveChatTheme(currentThemeId, customThemes, PRESET_THEMES),
        [currentThemeId, customThemes],
    );
    const draftKey = `chat_draft_${activeCharacterId}`;

    // Filter categories and emojis by active character's visibility (used for both AI prompt and UI)
    const visibleCategories = useMemo(() => categories.filter(cat => {
        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
        return cat.allowedCharacterIds.includes(activeCharacterId);
    }), [categories, activeCharacterId]);

    const aiVisibleEmojis = useMemo(() => {
        const hiddenIds = new Set(categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id));
        if (hiddenIds.size === 0) return emojis;
        return emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
    }, [emojis, categories, visibleCategories]);




    // Mini-app snapshot ref: filled in when MiniApp state changes; useChatAI reads and injects it when building the system prompt
    const mcdMiniAppRef = useRef<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>(undefined);
    const luckinMiniAppRef = useRef<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>(undefined);
    // Luckin chat order mode (activated by typing "瑞一杯" — the literal trigger phrase, kept in Chinese to match LUCKIN_ACTIVATE_TRIGGER: the character calls the real tool directly, location gets injected)
    const luckinChatRef = useRef<import('../utils/luckinToolBridge').LuckinChatState | undefined>(undefined);

    // Fallback guard for generation closures: when triggerAI's async closure finishes only after
    // the user has switched to a different character (switching characters within Chat doesn't
    // unmount the component), a late setMessages would flood the current session view with the old
    // character's messages. Discard fallbacks whose message charId doesn't belong to the current
    // session — the DB has already saved them, and OSContext bumps lastMsgTimestamp via
    // chat-gen-reply-arrived, so switching back to that character naturally picks them up again.
    const setMessagesFromGen = useCallback((msgs: Message[]) => {
        if (msgs.some(m => m.charId && m.charId !== activeCharIdRef.current)) return;
        setMessages(msgs);
    }, []);

    // Instant Chat's "typing…": accepted / reply received / timed-out-as-failed each broadcast once,
    // and the UI lights up or off following it. When entering this character, first read the saved
    // record once — the previous round's reply may still not have come back while the app was closed.
    // This CustomEvent is only dispatched within this tab; other tabs settle up via the storage
    // listener below (search AMSG_INSTANT_CHAT_PENDING_LS_KEY).
    useEffect(() => {
        const sync = () => setInstantChatPending(!!activeCharacterId && !!getInstantChatPending(activeCharacterId));
        sync();
        window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
    }, [activeCharacterId]);

    // --- Initialize Hook ---
    const { isTyping, streamingBubbles, streamingThinking, recallStatus, searchStatus, diaryStatus, emotionStatus, memoryPalaceStatus, memoryPalaceResult, setMemoryPalaceResult, lastDigestResult, setLastDigestResult, lastTokenUsage, tokenBreakdown, setLastTokenUsage, triggerAI, startProactiveChat, stopProactiveChat, isProactiveActive } = useChatAI({
        char,
        userProfile,
        apiConfig,
        groups,
        emojis: aiVisibleEmojis,
        categories: visibleCategories,
        addToast,
        showError,
        setMessages: setMessagesFromGen,
        onStreamPreviewHandover: registerStreamPreviewHandover,
        realtimeConfig,
        translationConfig: translationEnabled
            ? { enabled: true, sourceLang: translateSourceLang, targetLang: translateTargetLang }
            : undefined,
        memoryPalaceConfig,
        mcdMiniAppRef,
        luckinMiniAppRef,
        luckinChatRef,
        updateCharacter,
    });

    // --- Voice TTS for chat messages ---
    interface VoiceData { url: string; originalText: string; spokenText?: string; lang?: string; favorite?: boolean; }
    // Persisted shape (IndexedDB assets store). `blob` is the raw audio;
    // `remoteUrl` is the fallback when fetching the MiniMax CDN blob was blocked by CORS.
    interface StoredVoice {
        blob?: Blob;
        remoteUrl?: string;
        favorite?: boolean;
        originalText: string;
        spokenText?: string;
        lang?: string;
    }
    type GeneratedVoiceData = VoiceData & { blob: Blob | null };
    const voiceAssetKey = (msgId: number) => `voice_msg_${msgId}`;
    const chatFavoriteSourceKey = (msg: Pick<Message, 'charId' | 'id'>) => `${msg.charId}:${msg.id}`;
    const [voiceDataMap, setVoiceDataMap] = useState<Record<number, VoiceData>>({});
    const [chatFavoriteKeys, setChatFavoriteKeys] = useState<Set<string>>(new Set());
    const [contentFavoriteIds, setContentFavoriteIds] = useState<Set<string>>(new Set());
    const [voiceLoading, setVoiceLoading] = useState<Set<number>>(new Set());
    const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
    const chatAudioRef = useRef<HTMLAudioElement | null>(null);
    const prevIsTypingRef = useRef(false);
    // Auto-synthesis scan window for the Instant Chat path (usage in the auto-TTS effect below):
    // opens the moment the "typing" light goes off; every message change inside the window triggers
    // another catch-up scan; the whole thing is voided if the character doesn't match.
    const prevInstantPendingRef = useRef(false);
    const instantVoiceScanUntilRef = useRef(0);
    const instantVoiceScanCharRef = useRef<string | undefined>(undefined);
    // IDs of messages that have failed auto-synthesis before. The scan window re-scans on every new
    // message; without tracking this, the same failed message would be retried repeatedly, popping a
    // "voice generation failed" toast each time. This only blocks the auto path: the user tapping
    // "Convert to Voice" themselves can still retry (should work after switching networks / adding a
    // key). Cleared on character switch.
    const voiceFailedRef = useRef<Set<number>>(new Set());
    // Track blob: URLs we created so we can revoke them on character switch / unmount.
    const voiceBlobUrlsRef = useRef<Set<string>>(new Set());
    // We warn the user at most once (per character) that the active TTS provider isn't configured —
    // a character can produce many <语音> messages and we don't want to spam toasts.
    const ttsWarnedRef = useRef(false);

    /** Whether this character can synthesize real voice under the active TTS provider (key + a voice profile). */
    const isTtsReady = useCallback(() => canSynthesizeSpeech(char, apiConfig), [char, apiConfig]);

    const persistVoice = async (msgId: number, url: string, blob: Blob | null, originalText: string, spokenText: string | undefined, lang: string | undefined) => {
        try {
            const stored: StoredVoice = blob
                ? { blob, originalText, spokenText, lang, favorite: false }
                : { remoteUrl: url, originalText, spokenText, lang, favorite: false };
            await DB.saveAssetRaw(voiceAssetKey(msgId), stored);
        } catch (e) {
            console.warn('[Chat] persist voice failed', e);
        }
    };

    /** Drop in-memory + on-disk voice data for the given message ids. */
    const discardVoiceForMessages = (ids: Iterable<number>) => {
        const idList = Array.from(ids);
        if (!idList.length) return;
        setVoiceDataMap(prev => {
            let changed = false;
            const next = { ...prev };
            for (const id of idList) {
                const entry = next[id];
                if (!entry) continue;
                if (entry.url && entry.url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
                    voiceBlobUrlsRef.current.delete(entry.url);
                }
                delete next[id];
                changed = true;
            }
            return changed ? next : prev;
        });
        // Best-effort: remove persisted entries so they don't reappear on next load.
        for (const id of idList) {
            DB.deleteAsset(voiceAssetKey(id)).catch(() => { /* ignore */ });
        }
    };

    const handlePlayVoice = (msgId: number) => {
        const data = voiceDataMap[msgId];
        if (!data) {
            // No voice data yet — trigger TTS generation (e.g. placeholder voice bar clicked)
            const msg = messages.find(m => m.id === msgId);
            if (msg) handleManualTts(msg, false);
            return;
        }
        if (!chatAudioRef.current) chatAudioRef.current = new Audio();
        const audio = chatAudioRef.current;
        if (playingMsgId === msgId) {
            audio.pause();
            setPlayingMsgId(null);
            return;
        }
        audio.src = data.url;
        audio.onended = () => setPlayingMsgId(null);
        audio.play().catch(() => {});
        setPlayingMsgId(msgId);
    };

    // Stable playback callback: holds the latest closure in a ref, the reference itself never
    // changes — avoids creating a new arrow function for every message on every render, otherwise
    // MessageItem's React.memo gets defeated (all 30 heavy components fully re-rendering every time
    // is one of the main causes of lag entering a chat).
    const handlePlayVoiceRef = useRef(handlePlayVoice);
    handlePlayVoiceRef.current = handlePlayVoice;
    const onPlayVoiceStable = useCallback((id: number) => handlePlayVoiceRef.current(id), []);

    // LLM translation fallback (used for the foreign/native side-by-side text on voice bubbles).
    // Checks res.ok and retries once on failure — it used to not check the status code and silently
    // swallow failures, so if a translation attempt failed once it stayed empty forever (the main
    // cause of "foreign-language voice message never gets translated").
    const llmTranslate = async (systemPrompt: string, text: string): Promise<string> => {
        const attempt = async (): Promise<string> => {
            const res = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
                    temperature: 0.3,
                }),
            });
            if (!res.ok) throw new Error(`translate http ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content?.trim() || '';
        };
        try { return await attempt(); }
        catch { try { return await attempt(); } catch { return ''; } }
    };

    const handleManualTts = async (msg: Message, autoTriggered = false): Promise<GeneratedVoiceData | null> => {
        if (voiceLoading.has(msg.id)) return null;
        if (voiceDataMap[msg.id]) {
            if (autoTriggered) return null;
            // Manually tapping "Convert to Voice" = the user asking for a regeneration (typical case:
            // after editing the message content). Discard this old voice clip and go through normal
            // synthesis again; if the text hasn't changed it'll hit the shared TTS cache, so the API
            // won't be called again.
            discardVoiceForMessages([msg.id]);
        }

        // Parse the structured voice output: spoken text (sanitized) + per-message emotion.
        const parsedVoice = parseVoiceOutput(msg.content);
        // The Fish / ElevenLabs adapters need to see the raw inline cues; MiniMax uses the sanitized speech.
        const ttsProvider = resolveTtsProvider(apiConfig);
        const preserveRawMarkup = providerUsesRawVoiceMarkup(apiConfig);
        const voiceTagContent = parsedVoice.hasVoiceTag ? (preserveRawMarkup ? parsedVoice.rawSpeech : parsedVoice.speech) : '';
        const voiceEmotion = parsedVoice.emotion;

        // Auto-TTS: only generate voice when AI explicitly used <语音> tag
        if (autoTriggered && !parsedVoice.hasVoiceTag) return null;
        // F12 debugging: print the LLM's raw tagged text for this message, to make it easy to check
        // whether the voice tag was written correctly. Placed after the gate above: the Instant Chat
        // scan window re-scans on every new message, so if this were before the gate, ordinary
        // messages without a voice tag would get printed repeatedly and flood the console.
        console.log('[voice] LLM raw text (tagged):', { provider: ttsProvider, content: msg.content, voiceTagContent, emotion: voiceEmotion });

        // Don't attempt synthesis while the active TTS engine isn't fully configured (otherwise every
        // voice message, every click, would throw and flood the screen with errors).
        // Warn only once; the <语音> bubble still keeps its "Convert to Text" entry, so the line isn't
        // lost — the text stays readable, matching real voice messages.
        if (!isTtsReady()) {
            if (!autoTriggered && !ttsWarnedRef.current) {
                ttsWarnedRef.current = true;
                const tip = ttsProvider === 'fishaudio'
                    ? 'This character has no Fish Audio voice configured, or the Fish API Key is missing, so real voice playback is unavailable. Tap "Convert to Text" to read the content.'
                    : ttsProvider === 'elevenlabs'
                        ? 'This character has no ElevenLabs Voice ID configured, or the ElevenLabs Key is missing, so real voice playback is unavailable. Tap "Convert to Text" to read the content.'
                        : 'This character has no MiniMax voice configured, so real voice playback is unavailable. Tap "Convert to Text" to read the content.';
                addToast(tip, 'info');
            }
            return null;
        }

        setVoiceLoading(prev => new Set(prev).add(msg.id));
        try {
            let spokenText: string;
            let originalText: string;
            const voiceLang = char.chatVoiceLang || '';

            if (voiceTagContent) {
                // AI already provided the spoken text (possibly translated) in <语音> tag.
                // parseVoiceOutput already sanitized it (whitelisted sound tags only).
                spokenText = voiceTagContent;
                // Top translation priority: the model's explicit <字幕> subtitle tag — deterministic,
                // no guessing and no LLM call needed. Next is text outside the tag (legacy format /
                // fallback for when the model didn't write a subtitle).
                // parseVoiceOutput already self-heals + extracts the tag, don't replace it again here.
                originalText = parsedVoice.subtitle
                    || (parsedVoice.display ? cleanTextForTts(parsedVoice.display) : '');
                // In subtitle-alignment mode the Chinese subtitle is usually chunked into separate
                // bubbles of the same batch, with no text outside the tag on the voice message itself.
                // First try collecting the subtitle back from sibling bubbles as the translation —
                // deterministic, zero cost, and matches the subtitle the user actually sees word for
                // word. (Has internal structural-alignment validation: returns empty if the model
                // didn't keep the subtitle format, or if the text outside the tag is a short chitchat
                // line — falls through to the LLM below in that case.)
                if (voiceLang && !originalText) {
                    originalText = collectVoiceBatchSubtitle(messages, msg.id);
                }
                // If it still couldn't be collected (pure-voice round / subtitle misaligned), have the
                // LLM translate the foreign text back to Chinese, with an ok check + retry.
                if (voiceLang && !originalText && spokenText) {
                    originalText = await llmTranslate('Translate the following into Chinese. Only output the translation, no explanation.', spokenText);
                }
            } else {
                // Manual TTS (long-press): no <语音> tag.
                // Bilingual messages already contain both a target-language side (before
                // %%BILINGUAL%%) and a Chinese side (after). When the char's voice language
                // matches the message's target language we reuse those halves directly —
                // translating again would just echo the target language back and produce
                // two identical foreign-language lines in the expanded voice bar.
                const bilingualIdx = msg.content.toLowerCase().indexOf('%%bilingual%%');
                const hasBilingual = bilingualIdx !== -1;
                if (hasBilingual && voiceLang) {
                    const langAText = cleanTextForTtsProvider(msg.content.substring(0, bilingualIdx), apiConfig);
                    const langBText = stripTtsMarkupForDisplay(msg.content.substring(bilingualIdx + '%%BILINGUAL%%'.length), apiConfig);
                    if (!langAText || langAText.length < 2) return null;
                    spokenText = langAText;
                    originalText = langBText || '';
                } else {
                    spokenText = cleanTextForTtsProvider(msg.content, apiConfig);
                    if (!spokenText || spokenText.length < 2) return null;
                    originalText = stripTtsMarkupForDisplay(spokenText, apiConfig) || spokenText;
                    if (voiceLang) {
                        const langLabel = voiceLanguagePromptLabel(voiceLang);
                        const translated = await llmTranslate(`Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.`, originalText);
                        if (translated) spokenText = translated;
                    }
                }
            }

            if (!spokenText || spokenText.length < 2) return null;

            const { url: blobUrl, blob } = await synthesizeSpeechDetailed(spokenText, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion: voiceEmotion,
            });
            if (blobUrl.startsWith('blob:')) voiceBlobUrlsRef.current.add(blobUrl);
            // The "Convert to Text" panel only shows the actual line, not the active engine's pause / performance markup.
            const displaySpoken = stripTtsMarkupForDisplay(spokenText, apiConfig);
            const storedSpokenText = voiceTagContent ? displaySpoken : (voiceLang ? displaySpoken : undefined);
            const storedLang = voiceLang || undefined;
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang } }));
            // Persist so the voice bar survives leaving and re-entering the chat.
            persistVoice(msg.id, blobUrl, blob, originalText, storedSpokenText, storedLang);
            // Whether to play immediately after synthesis (rules and rationale in
            // shouldAutoPlayGeneratedVoice): a message the AI sent automatically defaults to silent,
            // waiting for the user to tap; one the user explicitly tapped for always plays.
            if (shouldAutoPlayGeneratedVoice({ autoTriggered, autoPlayEnabled: char.chatVoiceAutoPlay })) {
                if (!chatAudioRef.current) chatAudioRef.current = new Audio();
                chatAudioRef.current.src = blobUrl;
                chatAudioRef.current.onended = () => setPlayingMsgId(null);
                chatAudioRef.current.play().catch(() => {});
                setPlayingMsgId(msg.id);
            }
            return { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang, blob };
        } catch (err: any) {
            // Record the failure: the auto path skips it next time it scans by (see the note on voiceFailedRef).
            voiceFailedRef.current.add(msg.id);
            addToast(`Voice generation failed: ${err?.message || 'Unknown error'}`, 'error');
            return null;
        } finally {
            setVoiceLoading(prev => { const next = new Set(prev); next.delete(msg.id); return next; });
        }
    };

    // "Download" in the long-press voice menu: on mobile, prefer the system share/save sheet; on desktop, fall back to a browser download.
    const handleDownloadVoice = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;
            let blob: Blob | null = stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob && stored?.remoteUrl) {
                try { blob = await fetchBlobForShare(stored.remoteUrl, 'audio/mpeg'); } catch { /* Explicit toast shown below */ }
            }
            const fname = `${(char?.name || 'Voice').replace(/[\\/:*?"<>|]/g, '_')}_voice_${msg.id}.mp3`;
            if (!blob) {
                addToast('This one has no downloadable voice yet', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({ blob, fileName: fname, shareTitle: `${char?.name || 'Character'}'s voice message` });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? 'Opened the system save/share sheet' : 'Voice download started', 'success');
            trackEvent('Download Voice Message');
        } catch {
            addToast('Voice download failed', 'error');
        }
    };

    const handleToggleVoiceFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const sourceKey = chatFavoriteSourceKey(msg);
            if (await getVoiceFavorite('chat', sourceKey)) {
                await removeVoiceFavorite('chat', sourceKey);
                setChatFavoriteKeys(prev => { const next = new Set(prev); next.delete(sourceKey); return next; });
                setVoiceDataMap(prev => prev[msg.id] ? ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: false } }) : prev);
                addToast('Removed voice message from favorites', 'info');
                return;
            }
            let current: GeneratedVoiceData | VoiceData | undefined = voiceDataMap[msg.id];
            if (!current) current = await handleManualTts(msg, false) || undefined;
            if (!current) return;
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;

            let blob: Blob | null = 'blob' in current && current.blob instanceof Blob
                ? current.blob
                : stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob) {
                try { blob = await fetchBlobForShare(current.url, 'audio/mpeg'); } catch { /* handled below */ }
            }
            if (!blob) {
                addToast('Could not get the audio file for this voice message, unable to favorite it', 'error');
                return;
            }
            await saveVoiceFavorite({
                source: 'chat',
                sourceKey,
                charId: msg.charId,
                charName: char?.name || 'Unknown character',
                sourceTimestamp: msg.timestamp,
                originalText: current.originalText,
                spokenText: current.spokenText,
                language: current.lang,
                blob,
            });
            setChatFavoriteKeys(prev => new Set(prev).add(sourceKey));
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: true } }));
            addToast('Voice message favorited — view it under "Favorites"', 'success');
            trackEvent('Favorite Voice Message');
        } catch (e) {
            console.warn('[Chat] favorite voice failed', e);
            addToast('Favoriting failed, please check your browser storage space', 'error');
        }
    };

    // --- Auto-TTS: when chatVoiceEnabled, auto-generate voice when AI uses <语音> tag ---
    // Scans ALL recent assistant messages (not just the last one) because chunkText
    // may split a single AI response into multiple messages, and the <语音> tag could
    // end up in any chunk — not necessarily the final one.
    //
    // Two trigger sources:
    //   · Local generation: the moment typing ends (wasTyping → !isTyping).
    //   · Instant Chat: the reply is generated in the cloud and lands via push, so the local isTyping
    //     turns off right after the POST completes and never gets that moment — a character with
    //     auto-play on would stay silent the whole way through. Instead, watch the "typing" indicator
    //     going dark (instantChatPending flipping from true to false); when it goes dark, open a
    //     30-second scan window — a reply round is often split into several pushes that arrive one
    //     after another, the light goes out on the first one, and the rest need a catch-up scan on
    //     every messages change within the window. Only scans within the window, so a cold start or
    //     scrolling through history doesn't batch-synthesize a whole pile of old messages at once.
    useEffect(() => {
        const wasTyping = prevIsTypingRef.current;
        prevIsTypingRef.current = isTyping;
        const wasPending = prevInstantPendingRef.current;
        prevInstantPendingRef.current = instantChatPending;
        // Zero out the window first on character switch: switching characters within Chat doesn't
        // unmount the component, so these refs persist across characters. If character A still owes
        // a reply and you switch to character B, instantChatPending would flip false following B's
        // own record — that's not "B's reply arrived," so it can't be used to open the window, and A's
        // window definitely shouldn't be used to scan B's history. Both trigger sources require a
        // "before the change" state to be valid, so bailing out here can't miss a real trigger.
        if (instantVoiceScanCharRef.current !== char?.id) {
            instantVoiceScanCharRef.current = char?.id;
            instantVoiceScanUntilRef.current = 0;
            return;
        }
        // That's the extent of the coverage: settling up happens within the page, so if the user isn't
        // on this chat page when the push lands, there's no true→false transition, and that reply
        // stays silent (the same trade-off as "don't batch-synthesize history").
        if (wasPending && !instantChatPending) {
            instantVoiceScanUntilRef.current = Date.now() + INSTANT_VOICE_SCAN_WINDOW_MS;
        }
        // Only trigger when AI just finished typing (wasTyping → !isTyping), or still within Instant
        // Chat's scan window. This gate is also the safety net for the local path now that messages
        // is a dependency: outside the window, it still only scans the moment typing ends, and won't
        // re-scan on every incoming message under normal conditions.
        const typingJustEnded = wasTyping && !isTyping;
        const inInstantWindow = Date.now() < instantVoiceScanUntilRef.current;
        if (!typingJustEnded && !inInstantWindow) return;
        if (!char.chatVoiceEnabled) return;
        // Don't pre-synthesize while "auto-play on receipt" is off (rationale in
        // shouldAutoGenerateVoice): an empty voice bar still appears as usual, and synthesis only
        // happens (and plays immediately) once the user taps it.
        if (!shouldAutoGenerateVoice({ autoPlayEnabled: char.chatVoiceAutoPlay })) return;
        if (!characterHasVoice(char, apiConfig)) return;
        // Scan recent assistant messages for unprocessed <语音> tags
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Stop scanning once we hit a non-assistant message (end of current AI response batch)
            if (msg.role !== 'assistant') break;
            if (msg.type !== 'text') continue;
            if (voiceDataMap[msg.id] || voiceLoading.has(msg.id)) continue;
            // Don't auto-retry once synthesis has failed for this message: the scan window re-scans
            // on every incoming message, so the same one would keep retrying until the window closes,
            // popping a failure toast every time. Doesn't affect the user tapping it manually.
            if (voiceFailedRef.current.has(msg.id)) continue;
            handleManualTts(msg, true);
        }
    }, [isTyping, instantChatPending, messages]); // eslint-disable-line react-hooks/exhaustive-deps

    const canReroll = !isTyping && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    // --- Translation: pure frontend toggle (no API calls, bilingual data is already in message content) ---
    const handleTranslateToggle = useCallback((msgId: number) => {
        setShowingTargetIds(prev => {
            const next = new Set(prev);
            if (next.has(msgId)) next.delete(msgId);
            else next.add(msgId);
            return next;
        });
    }, []);

    const loadEmojiData = async () => {
        await DB.initializeEmojiData();
        const [es, cats] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
        setEmojis(es);
        setCategories(cats);
        if (activeCategory !== 'default' && !cats.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    };

    // Hydrate voice data from IndexedDB for currently visible messages.
    // Voice URLs are stored as blob: URLs that become invalid whenever the
    // component unmounts — persisting the raw blob and rebuilding the URL on
    // mount is what keeps previously-generated voice bars alive across
    // chat entries.
    useEffect(() => {
        if (!messages.length) return;
        const map = voiceDataMap;
        const toFetch = messages.filter(m => m.id && m.type === 'text' && m.role !== 'user' && !map[m.id]);
        if (!toFetch.length) return;
        let cancelled = false;
        (async () => {
            const updates: Record<number, VoiceData> = {};
            const favoriteKeys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            if (!cancelled) setChatFavoriteKeys(favoriteKeys);
            for (const m of toFetch) {
                try {
                    const stored = await DB.getAssetRaw(voiceAssetKey(m.id)) as StoredVoice | null;
                    if (!stored) continue;
                    let url: string | null = null;
                    if (stored.blob instanceof Blob) {
                        url = URL.createObjectURL(stored.blob);
                        voiceBlobUrlsRef.current.add(url);
                    } else if (stored.remoteUrl) {
                        url = stored.remoteUrl;
                    }
                    if (!url) continue;
                    let originalText = stored.originalText || '';
                    // Self-heal for existing poisoned data: versions from 07-02~07-04 used to save a
                    // same-round chitchat line as the translation (subtitle collection had no
                    // alignment check). Once recognized, clear it and write it back — don't let a
                    // wrong translation keep hanging around on the panel.
                    if (stored.lang && originalText && isPoisonedVoiceSubtitle(messages, m.id, originalText)) {
                        originalText = '';
                        DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, originalText: '' })
                            .catch(() => { /* If the write-back fails, retry next time the chat is opened */ });
                    }
                    let favorited = favoriteKeys.has(chatFavoriteSourceKey(m));
                    // One-time migration for the short-lived per-message favorite shape.
                    // The dedicated archive survives message deletion and is shared by all three apps.
                    if (!favorited && stored.favorite === true && stored.blob instanceof Blob) {
                        try {
                            await saveVoiceFavorite({
                                source: 'chat',
                                sourceKey: chatFavoriteSourceKey(m),
                                charId: m.charId,
                                charName: char?.name || 'Unknown character',
                                sourceTimestamp: m.timestamp,
                                originalText,
                                spokenText: stored.spokenText,
                                language: stored.lang,
                                blob: stored.blob,
                            });
                            favorited = true;
                            DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, favorite: undefined }).catch(() => undefined);
                        } catch { /* keep the legacy marker and retry next entry */ }
                    }
                    updates[m.id] = { url, originalText, spokenText: stored.spokenText, lang: stored.lang, favorite: favorited };
                } catch { /* ignore single-message hydration errors */ }
            }
            if (cancelled || !Object.keys(updates).length) return;
            setVoiceDataMap(prev => ({ ...updates, ...prev }));
        })();
        return () => { cancelled = true; };
    }, [messages]);

    // The archive can remove an item while this chat stays mounted. Keep the
    // long-press menu's Favorite/Unfavorite label in sync without touching audio data.
    useEffect(() => {
        const syncFavoriteFlags = async () => {
            const keys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            setChatFavoriteKeys(keys);
            setVoiceDataMap(prev => {
                let changed = false;
                const next = { ...prev };
                for (const message of messages) {
                    const voice = next[message.id];
                    if (!voice) continue;
                    const favorite = keys.has(chatFavoriteSourceKey(message));
                    if (!!voice.favorite !== favorite) {
                        next[message.id] = { ...voice, favorite };
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        };
        window.addEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
        return () => window.removeEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
    }, [messages]);

    // Revoke blob URLs when switching characters / unmounting to avoid leaks.
    useEffect(() => {
        // Reset the "active TTS not configured" warning so each character gets one reminder.
        ttsWarnedRef.current = false;
        // The auto-synthesis failure record also clears on character switch: this one's failures shouldn't block the next one.
        voiceFailedRef.current.clear();
        const urls = voiceBlobUrlsRef.current;
        return () => {
            urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
            urls.clear();
        };
    }, [activeCharacterId]);

    // How many messages to load per batch (initial load + each "load more" click)
    const LOAD_BATCH_SIZE = 30;

    const reloadMessages = useCallback(async (requestedVisibleCount: number) => {
        if (!activeCharacterId) return;

        const charIdAtStart = activeCharacterId;
        // Use only a reverse cursor to fetch the "most recent N" (with a small buffer, to offset the
        // count shrinking once date/call/system messages are filtered out) — no longer a full getAll
        // + deserialize: for accounts with lots of images/messages this used to have to read the
        // entire history (including inline images) into memory at once just to show 30 — the first
        // open would freeze for several seconds. totalCount goes through index.count, no
        // deserialization, extremely cheap.
        const fetchLimit = requestedVisibleCount >= 100000 ? requestedVisibleCount : requestedVisibleCount + 16;
        const applyResult = (recent: Message[], totalCount: number) => {
            // Use the ref to get the current char (avoids a stale closure)
            const currentChar = charRef.current;
            // hideBeforeMessageId is not filtered at the display layer — the user can still scroll
            // up to see it; context truncation only applies to the prompt sent to the LLM (handled in chatPrompts.ts).
            const chatScopeMsgs = recent
                .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call' && m.metadata?.source !== 'story_theater_memory')
                .filter(m => !(currentChar?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card'));
            // totalCount goes through the full charId-index count, which includes group-chat messages
            // (as well as the date/call messages filtered out above) — these will never appear in the
            // 1:1 chat list. Using it directly for "Load Earlier History" would produce a ghost button
            // that shows a count but loads nothing when clicked. If the reverse cursor doesn't fill up
            // fetchLimit, it means all of this character's 1:1 messages are already in hand — in that
            // case, clamp the total to however many can actually be shown.
            const exhausted = recent.length < fetchLimit;
            setTotalMsgCount(exhausted ? chatScopeMsgs.length : totalCount);
            setMessages(chatScopeMsgs.slice(-requestedVisibleCount));
        };
        try {
            const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit);
            // Guard against stale async results: if the user switched characters
            // while the DB query was in flight, discard this result.
            if (activeCharIdRef.current !== charIdAtStart) return;
            applyResult(recent, totalCount);
        } catch (e) {
            // DB read failed — retry once after a short delay
            if (activeCharIdRef.current !== charIdAtStart) return;
            await new Promise(r => setTimeout(r, 200));
            if (activeCharIdRef.current !== charIdAtStart) return;
            try {
                const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit);
                if (activeCharIdRef.current !== charIdAtStart) return;
                applyResult(recent, totalCount);
            } catch { /* give up silently */ }
        }
    }, [activeCharacterId]);

    useEffect(() => {
        if (activeCharacterId) {
            // Update ref BEFORE any async work so stale reloadMessages calls
            // from a previous character can detect the switch and bail out.
            activeCharIdRef.current = activeCharacterId;

            // Clear messages immediately to prevent showing stale chat from previous character
            setMessages([]);
            setAllHistoryMessages([]);
            setTotalMsgCount(0);
            // Reset voice map — stale blob: URLs from the previous char are revoked
            // by the cleanup effect and must not be reused against new messages.
            setVoiceDataMap({});
            setPlayingMsgId(null);
            if (chatAudioRef.current) { try { chatAudioRef.current.pause(); } catch { /* ignore */ } }

            reloadMessages(LOAD_BATCH_SIZE);
            loadEmojiData();
            const savedDraft = localStorage.getItem(draftKey);
            setInput(savedDraft || '');
            if (char) {
                setSettingsContextLimit(char.contextLimit || 500);
                setSettingsContextRangeMode(resolveContextRangeMode(char));
                setSettingsHideSysLogs(char.hideSystemLogs || false);
                setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
                clearUnread(char.id);
            }
            // Per-character translation toggle + language pair
            try {
                setTranslationEnabled(JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'));
            } catch { setTranslationEnabled(false); }
            setTranslateSourceLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_source_lang')
                || '日本語') || '日本語'
            );
            setTranslateTargetLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_lang')
                || '中文') || '中文'
            );
            try {
                setTranslationExpanded(JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'));
            } catch { setTranslationExpanded(false); }
            setVisibleCount(30);
            visibleCountRef.current = 30;
            lastMsgIdRef.current = null;
            scrollThrottleRef.current = 0;
            setLastTokenUsage(null);
            setReplyTarget(null);
            setSelectionMode(false);
            setSelectedMsgIds(new Set());
            setRetainRecentForVectorize(false);
            setVectorizeResult(null);
            setShowingTargetIds(new Set());
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowLoadingRef.current = false;
            historyPrependAnchorRef.current = null;
            historyWindowScrollEnabledRef.current = false;
            if (historyJumpUnlockTimerRef.current) {
                window.clearTimeout(historyJumpUnlockTimerRef.current);
                historyJumpUnlockTimerRef.current = null;
            }
            setFlashMsgId(null);
            try {
                const rawToolStatus = localStorage.getItem(`instant_tool_status_${activeCharacterId}`);
                const parsed = rawToolStatus ? JSON.parse(rawToolStatus) as InstantToolUiStatus : null;
                const fresh = parsed?.updatedAt && Date.now() - parsed.updatedAt < 2 * 60_000;
                setInstantToolStatus(fresh && parsed.phase !== 'done' ? parsed : null);
            } catch {
                setInstantToolStatus(null);
            }
        }
    }, [activeCharacterId, reloadMessages]);

    // Triggers the "entry" transition when entering/switching characters. useLayoutEffect sets it
    // true before the browser paints, letting the transition layer cover things first so there's no
    // one-frame flash of the new character's empty chat screen.
    useLayoutEffect(() => {
        if (!activeCharacterId || osTheme.chatCharacterSwitchAnimationEnabled === false) {
            setShowEntry(false);
            return;
        }
        setShowEntry(true);
    }, [activeCharacterId, osTheme.chatCharacterSwitchAnimationEnabled]);

    useEffect(() => {
        let clearTimer: ReturnType<typeof setTimeout> | null = null;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<InstantToolUiStatus>).detail;
            if (!detail?.charId || detail.charId !== activeCharIdRef.current) return;

            setInstantToolStatus(detail);
            if (clearTimer) {
                clearTimeout(clearTimer);
                clearTimer = null;
            }
            if (detail.phase === 'done' || detail.phase === 'failed') {
                clearTimer = setTimeout(() => {
                    setInstantToolStatus((prev) => (
                        prev?.sessionId && detail.sessionId && prev.sessionId !== detail.sessionId ? prev : null
                    ));
                    clearTimer = null;
                }, detail.phase === 'failed' ? 8000 : 5000);
            }
        };
        const receivedHandler = (e: Event) => {
            const detail = (e as CustomEvent<{ charId?: string }>).detail;
            if (detail?.charId && detail.charId !== activeCharIdRef.current) return;
            try {
                const charId = detail?.charId || activeCharIdRef.current;
                if (charId) localStorage.removeItem(`instant_tool_status_${charId}`);
            } catch { /* ignore */ }
            setInstantToolStatus(null);
        };
        window.addEventListener('instant-tool-status', handler);
        window.addEventListener('active-msg-received', receivedHandler);
        return () => {
            window.removeEventListener('instant-tool-status', handler);
            window.removeEventListener('active-msg-received', receivedHandler);
            if (clearTimer) clearTimeout(clearTimer);
        };
    }, []);

    useEffect(() => {
        const onScheduleChange = (event: Event) => {
            const detail = (event as CustomEvent<ScheduleChangeEventDetail>).detail;
            if (!detail || detail.charId !== activeCharIdRef.current) return;
            setScheduleData(detail.schedule);
            setScheduleChangeNotice(detail);
        };
        window.addEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
        return () => window.removeEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
    }, []);

    useEffect(() => setScheduleChangeNotice(null), [activeCharacterId]);

    // Auto-generate daily schedule (fire-and-forget on chat load)
    // Skip entirely when the master switch is off: no DB query, no secondary API call, no fallback run
    useEffect(() => {
        if (!char || !apiConfig.apiKey) return;
        if (!isScheduleFeatureOn(char)) {
            setScheduleData(null);
            return;
        }
        getDailyScheduleForChar(char).then(existing => {
            if (!existing) {
                // Generate in background, don't block chat
                generateDailySchedule(char, false);
            } else {
                setScheduleData(existing);
            }
        }).catch(() => {});
    }, [activeCharacterId, char?.scheduleFeatureEnabled, char?.customTimezoneEnabled, char?.customTimezone, charDateKey]);

    // Re-initialize from the character's persisted values every time chat settings is actually
    // opened; avoids the hidden Chat component still carrying the old toggle state after the user
    // switches Full-Auto mode on the Memory Palace page.
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char) return;
        setSettingsContextLimit(char.contextLimit || 500);
        setSettingsContextRangeMode(resolveContextRangeMode(char));
        setSettingsHideSysLogs(char.hideSystemLogs || false);
        setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
    }, [modalType, char?.id]);

    // Load all messages when history-manager modal opens
    useEffect(() => {
        if (modalType === 'history-manager' && activeCharacterId) {
            DB.getMessagesByCharId(activeCharacterId, true).then(allMsgs => {
                // Range management must use the full 1:1 message sequence the AI could possibly read
                // — it can't be pre-filtered by the chat UI's display preferences to hide
                // system/date/call messages, or the "most recent N" starting point would drift from the real prompt.
                setAllHistoryMessages(allMsgs);
            });
        }
    }, [modalType, activeCharacterId]);

    useEffect(() => {
        const savedPrompts = localStorage.getItem('chat_archive_prompts');
        if (savedPrompts) {
            try {
                const parsed = JSON.parse(savedPrompts);
                const merged = [...DEFAULT_ARCHIVE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('preset_'))];
                setArchivePrompts(merged);
            } catch(e) {}
        }
        const savedId = localStorage.getItem('chat_active_archive_prompt_id');
        if (savedId && archivePrompts.some(p => p.id === savedId)) setSelectedPromptId(savedId);
    }, []);

    useEffect(() => {
        if (activeCharacterId && lastMsgTimestamp > 0) {
            reloadMessages(visibleCountRef.current);
            clearUnread(activeCharacterId);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearUnread is stable (useCallback with []), omit to prevent stale-dep lint noise
    }, [lastMsgTimestamp, activeCharacterId, reloadMessages, clearUnread]);

    // Cross-tab catch-up for Instant Chat's pending record. When the same chat is open in two tabs,
    // once the reply push arrives the SW broadcasts it to all clients — a background tab's flush
    // might grab it and save it to the DB first, and since the settle-up CustomEvent only fires on
    // that tab's own side, this tab never receives it — "typing…" would stay lit forever and the
    // reply never appears on screen. The pending record already lives in localStorage, and the
    // storage event conveniently only fires in "other" tabs — that's exactly the gap this fills: the
    // moment this key changes, follow the same handling as the CustomEvent above — refresh the
    // indicator, and reload messages to bring the other tab's saved data on screen. The in-tab
    // CustomEvent mechanism itself is left unchanged.
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            // Filter strictly by key; ignore any other localStorage change (drafts, translation toggle, etc).
            if (e.key !== AMSG_INSTANT_CHAT_PENDING_LS_KEY) return;
            const charId = activeCharIdRef.current;
            setInstantChatPending(!!charId && !!getInstantChatPending(charId));
            if (charId) reloadMessages(visibleCountRef.current);
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [reloadMessages]);

    useEffect(() => {
        visibleCountRef.current = visibleCount;
    }, [visibleCount]);

    // (The old "first auto-archive banner" has been removed; auto-archive is now an explicit opt-in the user sets in Neural Link)

    // Buff syncing has been moved up to OSContext's App-level 'emotion-updated' listener (updates
    // memory unconditionally by the event's charId, no longer limited by "is this character's chat
    // page currently open"). There used to be a handler here gated on `charId === activeCharacterId`,
    // which meant in instant mode, if the user wasn't on that character's page, the buff never made
    // it back to the frontend (only got saved to the DB) — so it was removed, while also avoiding a double-write with OSContext.

    const handleInputChange = (val: string) => {
        setInput(val);
        if (val.trim()) localStorage.setItem(draftKey, val);
        else localStorage.removeItem(draftKey);
    };

    useLayoutEffect(() => {
        if (!scrollRef.current || selectionMode) return;
        const currentLastId = messages.length > 0 ? messages[messages.length - 1].id : null;
        // Only auto-scroll when a new message is appended (ID changes),
        // not when loading older history or updating existing messages in-place.
        // In windowed mode the user is browsing old messages — don't let a new message interrupt and scroll them away.
        if (currentLastId !== lastMsgIdRef.current) {
            if (windowedFocusMsgId === null) {
                pendingMediaAutoScrollIdRef.current = currentLastId;
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            } else {
                pendingMediaAutoScrollIdRef.current = null;
            }
            lastMsgIdRef.current = currentLastId;
        }
    }, [messages, activeCharacterId, selectionMode, windowedFocusMsgId]);

    const extendHistoryWindow = useCallback((direction: 'older' | 'newer') => {
        const scroller = scrollRef.current;
        const range = historyWindowRangeRef.current;
        if (!scroller || !range || historyWindowLoadingRef.current) return;

        const nextRange = expandChatHistoryWindow(
            range,
            historyWindowTotalRef.current,
            direction,
            HISTORY_WINDOW_BATCH_SIZE,
        );
        if (nextRange.start === range.start && nextRange.end === range.end) return;

        historyWindowLoadingRef.current = true;
        if (direction === 'older') {
            // Prepending messages pushes all current content down as a whole; record the original
            // height, and compensate for the difference after the DOM commits, so the position the user sees doesn't suddenly jump.
            historyPrependAnchorRef.current = {
                scrollHeight: scroller.scrollHeight,
                scrollTop: scroller.scrollTop,
            };
        }
        historyWindowRangeRef.current = nextRange;
        setHistoryWindowRange(nextRange);
    }, []);

    useLayoutEffect(() => {
        if (!historyWindowRange) return;
        const anchor = historyPrependAnchorRef.current;
        const scroller = scrollRef.current;
        if (anchor && scroller) {
            scroller.scrollTop = anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
        }
        historyPrependAnchorRef.current = null;
        historyWindowLoadingRef.current = false;
    }, [historyWindowRange]);

    const handleChatScroll = useCallback(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (distanceFromBottom > 96) pendingMediaAutoScrollIdRef.current = null;

        if (historyWindowScrollEnabledRef.current && historyWindowRangeRef.current) {
            if (scroller.scrollTop <= 96) extendHistoryWindow('older');
            else if (distanceFromBottom <= 96) extendHistoryWindow('newer');
        }
    }, [extendHistoryWindow]);

    const handleMessageMediaLoad = useCallback((messageId: number) => {
        if (windowedFocusMsgId !== null || pendingMediaAutoScrollIdRef.current !== messageId) return;
        requestAnimationFrame(() => {
            if (pendingMediaAutoScrollIdRef.current !== messageId) return;
            const scroller = scrollRef.current;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            pendingMediaAutoScrollIdRef.current = null;
        });
    }, [windowedFocusMsgId]);

    useEffect(() => {
        if (isTyping && scrollRef.current && !selectionMode && windowedFocusMsgId === null) {
            const now = Date.now();
            if (now - scrollThrottleRef.current > 150) {
                scrollThrottleRef.current = now;
                scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, isTyping, streamingBubbles, streamingThinking, recallStatus, searchStatus, diaryStatus, selectionMode, windowedFocusMsgId]);

    // Whitebox notification sound: plays once when a new message the character sent becomes the last
    // one in the session (the user's own / history / scrolling old messages never trigger it).
    // The sound config is encoded in a Whitebox CSS comment (the character's chromeCustomCss
    // overrides the global chatChromeCustomCss), and travels along with the Whitebox share.
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        // Switching character / first entry: only record the baseline, don't play (avoids it going
        // off the moment chat is opened); reset the round timer.
        if (sync.charId !== activeCharacterId) {
            sync.charId = activeCharacterId ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew) {
            // Only triggered by "the newest one, sent by the character, landing at the bottom":
            // assistant role and not a side-channel message like date/call.
            const src = last?.metadata?.source;
            if (last?.role === 'assistant' && src !== 'date' && src !== 'call') {
                // Plays on the first bubble of a round: a gap of >3s since the last bubble counts as a
                // new round and plays immediately; later bubbles in the same round only refresh the timer and don't play again.
                const now = Date.now();
                if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                    playWhiteboxSound(resolveActiveSound(char?.chromeCustomCss, char?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
                }
                sync.lastAt = now;
            }
        }
        // The baseline only ever goes up, never down: scrolling through old history, where the
        // trailing ID gets smaller, doesn't lower it, so returning to the bottom doesn't re-trigger it either.
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeCharacterId, osTheme.chatChromeCustomCss, osTheme.chatSound, char?.chromeCustomCss, char?.chatSound]);

    const formatTime = (ts: number) => {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    // --- Actions ---

    const handleSendText = async (customContent?: string, customType?: MessageType, metadata?: any) => {
        if (!char || (!input.trim() && !customContent)) return;
        // Only accumulates an in-memory count here, no request is sent; reported once per interval
        // when leaving the page. See utils/analytics.ts
        noteMessageSent();
        // Piggyback on the user's "send" gesture to unlock the audio context, so the Whitebox
        // notification sound can play smoothly once the AI replies later (mobile autoplay policy).
        unlockWhiteboxAudio();
        const text = customContent || input.trim();
        const type = customType || 'text';

        // Sending a message implicitly means "return to the current chat" — exit windowed old-message browsing mode
        if (windowedFocusMsgId !== null) {
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowScrollEnabledRef.current = false;
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            setFlashMsgId(null);
        }

        // User types the literal trigger phrase "麦请求" (kept in Chinese to match MCD_ACTIVATE_TRIGGER)
        // → equivalent to tapping the mic button (brings up the McDonald's menu). Not saved to the DB,
        // behaves exactly like the button tap, avoiding a weird "banner is there but menu didn't come up" state.
        if (!customContent && type === 'text' && text === MCD_ACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            if (!isMcdConfigured()) {
                addToast("Please go to Settings → McDonald's to enable it and fill in the MCP Token first", 'info');
                return;
            }
            setMcdAppOpen(true);
            trackEvent("Open McDonald's Order Mini-App");
            setShowPanel('none');
            return;
        }

        // User types the literal trigger phrase "瑞一杯" (kept in Chinese to match LUCKIN_ACTIVATE_TRIGGER)
        // → activates the character's Luckin ordering mode (injects prompt + tools + location, character orders itself)
        if (!customContent && type === 'text' && text === LUCKIN_ACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            activateLuckin();
            return;
        }
        if (!customContent && type === 'text' && text === LUCKIN_DEACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            deactivateLuckin();
            return;
        }

        if (!customContent) { setInput(''); localStorage.removeItem(draftKey); }
        
        // Image / emoji messages store a short token; the image binary sits separately in
        // blob_assets, saving the ~33% base64 bloat. If the same image was stored before, its token
        // is reused directly; if conversion fails, the original data URL is returned as-is so the
        // image isn't lost. http external links (web emoji) and values that are already tokens pass through unchanged.
        // Note: this message and the one saved into the gallery below share the same token (identified
        // by content hash, only one Blob stored) — so deleting a message must never delete the Blob
        // along with it, that would break the same image in the gallery too. Blobs that lose their
        // reference are collected by orphan GC (see utils/blobGc.ts).
        const storedContent = (type === 'image' || type === 'emoji') && text.startsWith('data:')
            ? await migrateDataUrlToRef(text)
            : text;

        const imageChatContext = type === 'image'
            ? messages.slice(-10).map(m => {
                const sender = m.role === 'user' ? userProfile.name : char.name;
                const isMedia = m.type === 'image' || m.type === 'emoji' || isImageValue(m.content);
                const preview = isMedia
                    ? buildReplySnapshotContent(m)
                    : m.content.substring(0, 100);
                return `${sender}: ${preview}`;
            })
            : null;

        const msgPayload: any = { charId: char.id, role: 'user', type, content: storedContent, metadata };
        
        if (replyTarget) {
            msgPayload.replyTo = {
                // When quoting an image / emoji, the snapshot stores a placeholder like '[Image]' —
                // it doesn't carry the raw token into this message (same function as the character-side quote snapshot, kept consistent)
                id: replyTarget.id,
                content: buildReplySnapshotContent(replyTarget),
                // Kept literally '我' (not translated): utils/chatPrompts.ts:1179 (out of scope)
                // compares replyTo.name === '我' to decide the reply-quote wording it teaches the AI
                // ("something you said before" vs "something they said") — translating this string
                // would silently break that match.
                name: replyTarget.role === 'user' ? '我' : char.name
            };
            setReplyTarget(null);
        }

        const savedUserMsgId = await DB.saveMessage(msgPayload);

        if (type === 'image') {
            // The gallery is a secondary record of the message: it keeps a reference to the source
            // message for favoriting/dedup purposes, but a gallery write failure must not block the
            // chat message, which has already been saved to the DB.
            try {
                await DB.saveGalleryImage({
                    id: `img-${Date.now()}-${Math.random()}`,
                    charId: char.id,
                    url: storedContent,
                    timestamp: Date.now(),
                    sourceMessageId: savedUserMsgId,
                    savedDate: localDateKey,
                    chatContext: imageChatContext || undefined,
                });
                addToast('Image saved to Gallery', 'info');
            } catch (err) {
                console.warn('[Chat] Failed to save image to gallery, message sent as usual', err);
                addToast('Could not save the image to Gallery, message sent as usual', 'error');
            }
        }

        // Xiaohongshu link → xhs_card. The main path doesn't depend on any backend: the Xiaohongshu
        // share text already carries a title (【title】) and the note id/token, so it can be parsed
        // directly into a card, letting users without a deployed Xiaohongshu MCP still have the
        // character see which note was shared. If MCP is configured, fetch the details too, to fill
        // in the body/cover/author (a nice-to-have — a failed fetch doesn't affect the basic card).
        if (type === 'text') {
            let xhsCardCreated = false;
            let webpageCardCreated = false;
            const xhsFullNoteId = extractXhsNoteId(text);
            // Recognizes both desktop/legacy xhslink.com and the newer mobile xhslink.cn short links.
            const xhsShortUrl = detectXhsShortUrl(text);
            if (xhsFullNoteId || xhsShortUrl) {
                let noteId = xhsFullNoteId || '';
                let xsecToken = text.match(/xsec_token=([^&\s]+)/)?.[1];
                let shortLinkError = '';
                // Short links (xhslink.com / xhslink.cn) don't contain the id/token — expand to the real link via sfworker first, then extract.
                if (!noteId && xhsShortUrl) {
                    try {
                        const finalUrl = await expandShortUrl(xhsShortUrl);
                        noteId = extractXhsNoteId(finalUrl) || '';
                        xsecToken = xsecToken || finalUrl.match(/xsec_token=([^&\s]+)/)?.[1];
                        if (isDevDebugAvailable()) console.log('[Card Debug] Xiaohongshu short link expanded →', finalUrl, '| noteId =', noteId);
                    } catch (e) {
                        console.warn('xhslink short link expansion failed:', e);
                        shortLinkError = e instanceof Error ? e.message : 'Short link expansion failed';
                    }
                }
                // Compatible with both the legacy "【Title | Xiaohongshu】" and the newer "Title ... short link Open in【Xiaohongshu】".
                // Can't just take the first 【】 block: in the new format, the only bracketed content
                // is the app name, which would wrongly write the card title as "Xiaohongshu".
                const titleFromText = extractXhsShareTitle(text);

                // If noteId can't be obtained (short link expansion failed / blocked), don't create an
                // empty card — keep the original text for the user, and clearly tell them how to
                // troubleshoot. This used to fail completely silently, which looked like "the
                // character can share, but the user can't."
                if (noteId) {
                    // Basic card data comes from the share text, zero backend dependency.
                    let note: any = {
                        noteId, title: titleFromText || '', desc: '', author: '',
                        authorId: '', likes: 0, xsecToken,
                    };

                    // Only fetch details to fill in the rest (body/cover/author/likes) if Xiaohongshu MCP/Lite is configured.
                    const mcpUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
                    if (mcpUrl && realtimeConfig?.xhsMcpConfig?.enabled) {
                        try {
                            const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${xsecToken}&xsec_source=pc_share` : ''}`;
                            // loadAllComments: fetches the comment section too, consistent with the
                            // character's own note-browsing flow (XHS_DETAIL) — otherwise a note the
                            // user shared would only have a title/body, and the character couldn't
                            // read the comments (even though it can when the character shares to the user).
                            const result = await XhsMcpClient.getNoteDetail(mcpUrl, noteUrl, xsecToken, { loadAllComments: true });
                            if (isDevDebugAvailable()) console.log('[Card Debug] Xiaohongshu fetch result =', result);
                            if (result.success && result.data) {
                                const fetched = normalizeXhsLiteDetail(result.data);
                                // Fill in the basic card with fetched fields; id/title/token fall back
                                // safely, title prefers the share-text title (more complete and readable).
                                note = { ...note, ...fetched, noteId: fetched.noteId || note.noteId, title: titleFromText || fetched.title || note.title, xsecToken: fetched.xsecToken || xsecToken };
                            } else if (!result.success) {
                                // The basic card can still be sent; just note that fetching the details
                                // failed, so it isn't mistaken for the whole share having failed.
                                addToast(`Failed to load the Xiaohongshu post body — sent the basic card instead. Try toggling your VPN/proxy, switching Wi‑Fi/mobile data, or checking your Lite configuration.${result.error ? ` (${result.error})` : ''}`, 'info');
                            }
                        } catch (e) {
                            console.warn('XHS link fetch via MCP failed (fell back to share text):', e);
                            addToast('Failed to load the Xiaohongshu post body — sent the basic card instead. Try toggling your VPN/proxy, switching Wi‑Fi/mobile data, or checking your Lite configuration.', 'info');
                        }
                    }

                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'xhs_card',
                        content: note.title || 'Xiaohongshu note',
                        metadata: { xhsNote: note }
                    });
                    // F12 debugging (dev branch only): print what the card stored + the text the character will actually read.
                    if (isDevDebugAvailable()) {
                        console.log('[Card Debug] Xiaohongshu card · metadata =', note);
                        console.log('[Card Debug] Xiaohongshu card · character will read =\n' + normalizeMessageContent(
                            { type: 'xhs_card', role: 'user', content: note.title || 'Xiaohongshu note', metadata: { xhsNote: note } } as any,
                            char.name, userProfile.name,
                        ));
                    }
                    xhsCardCreated = true;
                } else {
                    addToast(`Failed to parse the Xiaohongshu link, the original message was kept. This is usually a network/proxy issue preventing the short link from expanding: try toggling your VPN/proxy, switching Wi‑Fi/mobile data, and check your network proxy and Xiaohongshu Lite configuration.${shortLinkError ? ` (${shortLinkError})` : ''}`, 'error');
                }
            }

            // General webpage share: when a plain http(s) link is detected → fetch the body and save
            // it as a webpage_card, letting the character "see" the webpage content. Skips XHS links
            // (already has its own dedicated MCP card path above). Video-platform links
            // (Douyin/Bilibili/Kuaishou…) are basically unfetchable via Jina (SPA + login wall) —
            // prefer the apizero video parser for title/author/cover/popularity first; fall back to
            // general webpage fetching if that fails.
            const sharedUrl = detectFirstUrl(text);
            if (sharedUrl && !isXhsUrl(sharedUrl) && !(xhsFullNoteId || xhsShortUrl)) {
                let webpage: ExtractedWebpage | null = null;
                if (isVideoShareUrl(sharedUrl)) {
                    try {
                        addToast('Parsing video link…', 'info');
                        webpage = await parseVideoShareUrl(sharedUrl);
                    } catch (e) {
                        console.warn('Video parse failed, fallback to webpage fetch:', e);
                    }
                }
                if (!webpage) {
                    try {
                        addToast('Reading webpage content…', 'info');
                        webpage = await extractWebpageContent(sharedUrl);
                    } catch (e: any) {
                        console.warn('Webpage fetch failed:', e);
                        addToast(`Webpage fetch failed: ${e?.message || 'This site may be blocking it — try a different link or try again later.'}`, 'error');
                    }
                }
                if (webpage) {
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'webpage_card',
                        content: webpage.title,
                        metadata: { webpage },
                    });
                    // F12 debugging (dev branch only): print what the card stored + the text the character will actually read.
                    if (isDevDebugAvailable()) {
                        console.log('[Card Debug] Webpage card · metadata =', webpage);
                        console.log('[Card Debug] Webpage card · character will read =\n' + normalizeMessageContent(
                            { type: 'webpage_card', role: 'user', content: webpage.title, metadata: { webpage } } as any,
                            char.name, userProfile.name,
                        ));
                    }
                    webpageCardCreated = true;
                }
            }

            // A link appearing in a message = the whole message is a share (matches user expectations) → delete the original text once the card is successfully created, keeping only the card.
            if ((xhsCardCreated || webpageCardCreated) && savedUserMsgId) {
                await DB.deleteMessage(savedUserMsgId);
            }
        }

        await reloadMessages(visibleCountRef.current);
        setShowPanel('none');

        // Instant Push mode: automatically triggers the AI after sending text (the response runs on
        // the worker side, and a background push writes it back to the chat page). Local mode still
        // keeps manual triggering to preserve the existing UX. triggerAI pulls the full history from
        // the DB internally, so it's fine that the closure's messages doesn't yet include the just-written user msg.
        // Only triggered by text messages; card messages like image / xhs_card don't trigger it, matching local manual behavior.
        // autoTriggerOnSend gate: even when instant is ready, it only auto-replies once the user has
        // explicitly turned on "auto-trigger after send" — otherwise manual ⚡ is kept (avoiding the
        // counterintuitive hard-binding of "enabling instant = automatic replies").
        const instantCfg = loadInstantConfig();
        if (type === 'text' && isInstantConfigReady(instantCfg) && instantCfg.autoTriggerOnSend) {
            // Skip outright if the previous round is still running: triggerAI silently rejects
            // internally when isTyping=true — guarding here up front avoids lighting up the
            // "preparing" indicator with nothing left to clear it, leaving the UI light stuck on.
            if (isTyping) return;
            // Mark the "preparing" three dots: shown while assembling + sending, cleared once the SSE POST is queued (onInstantPosted).
            setInstantSendingActive(true);
            triggerAI(messages, undefined, () => setInstantSendingActive(false));
        }
    };

    // The user opens a "received transfer" card (sent by the character, pending) and chooses to
    // accept / return it: marks the original transfer status + appends a small receipt card
    // (role=user; the character-side prompt sees [[记录:TRANSFER|to=user|...|status=已收下/已退回]]).
    // Note: content below is just a display placeholder — utils/messageFormat.ts:117-127 rebuilds
    // the actual AI-facing [[记录:TRANSFER|...]] wire string from metadata.receipt via
    // utils/transferFormat.ts, never reading this content field, so translating it is safe.
    const handleResolveTransfer = useCallback(async (msg: Message, action: 'accepted' | 'returned') => {
        if (!char) return;
        // Only handle transfers still pending, to avoid multiple receipts from repeated clicks.
        if (msg.metadata?.receipt) return;
        if (msg.metadata?.status && msg.metadata.status !== 'pending') return;
        await DB.updateMessageMetadata(msg.id, (prev) => ({ ...(prev || {}), status: action, resolvedAt: Date.now() }));
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'transfer',
            content: action === 'accepted' ? '[Payment Received]' : '[Payment Returned]',
            metadata: { receipt: action, amount: msg.metadata?.amount, ref: msg.id },
        });
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // The user taps a "Life Record" auto-logged card and chooses to confirm / reject it:
    // Reject → mark the record rejected (no longer counted in the injected summary) + roll back the
    // bank transaction (expense) + attach a one-time piece of feedback to the recording character, so
    // the next round's system prompt tells the character it got something wrong.
    const handleResolveLifeRecord = useCallback(async (msg: Message, action: 'confirmed' | 'rejected') => {
        if (!char) return;
        // Only handle cards still pending review, to avoid repeated clicks.
        if (msg.metadata?.reviewStatus && msg.metadata.reviewStatus !== 'active') return;
        try {
            await resolveLifeRecordCard(msg, action);
            // Rejecting kicks this record out of the injected summary and rolls back the bank
            // transaction. Life Record is shared material injected into every character with the
            // toggle on, so mark each of them dirty individually (same as the emoji library).
            markAmsgStateDirtyForAll({ characters, userProfile, groups, realtimeConfig });
            addToast(action === 'confirmed' ? 'Record confirmed' : 'Rejected, record reverted', action === 'confirmed' ? 'success' : 'info');
        } catch (e) {
            console.error('[LifeRecord] resolve failed:', e);
        }
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages, addToast, characters, userProfile, groups, realtimeConfig]);

    // Manual ⚡ trigger in the top bar. In instant mode, marks "all user messages after the last
    // assistant message" with "preparing" three dots (between being written to the DB and the SSE
    // POST being queued), cleared by onInstantPosted — matching the indicator behavior of the
    // autoTriggerOnSend automatic path. Local mode has no such indicator, calls triggerAI directly.
    const handleManualTrigger = () => {
        // Same as above: if the previous round is still running, triggerAI silently rejects — guard here up front to avoid the indicator getting stuck.
        if (isTyping) return;
        if (!isInstantConfigReady()) { triggerAI(messages); return; }
        // instantSendingActive drives the header's "Sending…" badge (the assemble + send window). The
        // three small dots on a message use a separate, purely frontend check (isTyping && it's the last message), see the render site.
        setInstantSendingActive(true);
        triggerAI(messages, undefined, () => setInstantSendingActive(false));
    };

    const handleReroll = async () => {
        if (isTyping || messages.length === 0) return;

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        discardVoiceForMessages(toDeleteIds);
        // Re-rolling also deletes messages: under the normal path, this round's generation finishing
        // marks it dirty again — marking it here first covers the case where "the trigger failed and
        // never reached the end of generation," since the cloud fire_pack can't be left stuck before the deletion.
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('Rewinding conversation...', 'info');
        trackEvent('Regenerate Reply');

        // Re-roll: doesn't inject the leftover emotion buff and stream of consciousness (innerState) from the previous round — both are regenerated independently.
        triggerAI(newHistory, undefined, undefined, { skipEmotionInjection: true });
    };

    const handleImageSelect = async (file: File) => {
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.6, forceJpeg: true });
            setShowPanel('none');
            await handleSendText(base64, 'image');
        } catch (err: any) {
            addToast(err.message || 'Image processing failed', 'error');
        }
    };

    const handlePanelAction = (type: string, payload?: any) => {
        // Only tracks these fixed entry points for "opening a panel / toggling a capability" — the
        // list is hardcoded here; actions like picking an emoji or a category aren't reported.
        if ([
            'transfer', 'archive', 'settings', 'chrome-css', 'chrome-sound', 'fine-tune',
            'meetup', 'proactive', 'active-msg-2', 'schedule', 'mcd-request', 'luckin-request',
            'html-mode-toggle', 'html-mode-settings', 'thinking-settings', 'favorites', 'collaboration',
            // Standalone small features: one tap = one use, the same kind of thing as "opening a panel."
            // send-emoji / select-category are "which one did you pick" actions, they don't go in this list.
            'poke', 'emoji-import', 'add-category', 'mcd-end', 'luckin-end',
        ].includes(type)) {
            trackEvent('Open Chat Feature Panel Item', { action: type });
        }
        switch (type) {
            case 'collaboration': setShowPanel('none'); setCollaborationOpen(true); break;
            case 'memory-link': setShowPanel('none'); setMemoryRepairOpen(true); break;
            case 'favorites': setShowPanel('none'); setFavoritesOpen(true); break;
            case 'transfer': setModalType('transfer'); break;
            // '[戳一戳]' ("poke") content is confirmed tier-2 safe: chatPrompts.ts (out of scope)
            // rebuilds the AI-facing text for type==='interaction' entirely from the type itself
            // (a fixed "[System: user poked you]" string), never reading this literal content field —
            // so it's a pure display placeholder. NOTE: an AI-initiated poke uses this same literal
            // string via a DIFFERENT out-of-scope file, utils/chatParser.ts:210, triggered by the tag
            // [[ACTION:POKE]] — translating only this copy means user-pokes and AI-pokes will render
            // with different text until that file gets its own translation pass.
            case 'poke': handleSendText('[Poked]', 'interaction'); break;
            case 'archive': setModalType('archive-settings'); break;
            case 'settings': setModalType('chat-settings'); break;
            case 'chrome-css': setModalType('chrome-css'); break;
            case 'chrome-sound': setModalType('chrome-sound'); break;
            case 'fine-tune': setShowPanel('none'); setFineTuneOpen(true); setFineTunePanelOpen(true); break;
            case 'emoji-import': setModalType('emoji-import'); break;
            case 'send-emoji': if (payload) handleSendText(payload.url, 'emoji'); break;
            case 'delete-emoji-req': setSelectedEmoji(payload); setModalType('delete-emoji'); break;
            case 'emoji-options': setSelectedEmoji(payload); setModalType('emoji-options'); break;
            case 'add-category': setModalType('add-category'); break;
            case 'select-category': setActiveCategory(payload); break;
            case 'category-options': setSelectedCategory(payload); setModalType('category-options'); break;
            case 'delete-category-req': setSelectedCategory(payload); setModalType('delete-category'); break;
            case 'meetup': if (char) { setShowPanel('none'); openDateWithChar(char.id); } break;
            case 'proactive': setShowProactiveModal(true); break;
            case 'active-msg-2': setShowActiveMsg2Modal(true); break;
            case 'emotion': setModalType('schedule'); break; // Emotion has been merged into Schedule, opens the same modal
            case 'schedule': setModalType('schedule'); break;
            case 'mcd-not-configured':
                addToast("Please go to Settings → McDonald's to enable it and fill in the MCP Token first", 'info');
                break;
            case 'mcd-request':
                setMcdAppOpen(true);
                trackEvent("Open McDonald's Order Mini-App");
                break;
            case 'mcd-end':
                handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true });
                break;
            case 'luckin-not-configured':
                addToast('Please go to Settings → Luckin to enable it and fill in the MCP Token first', 'info');
                break;
            case 'luckin-request':
                activateLuckin();
                break;
            case 'luckin-end':
                deactivateLuckin();
                break;
            case 'html-mode-toggle': {
                if (!char) break;
                const next = !((char as any).htmlModeEnabled);
                updateCharacter(char.id, { htmlModeEnabled: next } as any);
                addToast(next ? 'HTML mode is now on' : 'HTML mode is now off', next ? 'success' : 'info');
                break;
            }
            case 'html-mode-settings': {
                // Long-press → jump into the HTML section of the chat settings modal (also makes sure
                // the toggle is on first, otherwise scrolling down won't show the textarea)
                if (!char) break;
                if (!(char as any).htmlModeEnabled) {
                    updateCharacter(char.id, { htmlModeEnabled: true } as any);
                }
                setModalType('chat-settings');
                break;
            }
            case 'thinking-settings': {
                // "Show Thinking" button → opens the thinking-chain settings modal (toggle / card style / colors / extra prompt)
                if (!char) break;
                setShowThinkingChainModal(true);
                break;
            }
        }
    };

    // Whether the McDonald's request is currently active in this session (derived from message history, no separate storage)
    const mcdActivated = useMemo(() => isMcdActivatedInMessages(messages), [messages]);
    const [mcdAppOpen, setMcdAppOpen] = useState(false);
    // mcdMiniAppRef is declared earlier in the file (passed to useChatAI), just a placeholder here
    const mcdConfiguredFlag = useMemo(() => isMcdConfigured(), [showPanel, mcdActivated]);

    // Luckin chat order mode: active state uses React state (temporary session state, not persisted)
    const [luckinMode, setLuckinMode] = useState(false);
    const [showLuckinLoc, setShowLuckinLoc] = useState(false); // "Grab a Luckin" location-picker modal
    const [showLuckinHelp, setShowLuckinHelp] = useState(false); // "Grab a Luckin" usage instructions
    const luckinActivated = luckinMode;
    const [luckinAppOpen, setLuckinAppOpen] = useState(false); // Old mini-app shell, no longer opened proactively
    const luckinConfiguredFlag = useMemo(() => isLuckinConfigured(), [showPanel, luckinActivated]);

    const activateLuckin = useCallback(() => {
        if (!isLuckinConfigured()) { addToast('Please go to Settings → Luckin to enable it and fill in the MCP Token first', 'info'); return; }
        setShowPanel('none');
        setShowLuckinLoc(true); // Pick a location first (GPS often picks up the data center's location, so let the user choose a city)
    }, [addToast]);

    // Once a location is picked → formally activates Luckin mode for the character, injecting the coordinates
    const onLuckinLocationPick = useCallback((lng: number, lat: number, cityName?: string) => {
        luckinChatRef.current = { active: true, longitude: lng, latitude: lat, cityName };
        setLuckinMode(true);
        setShowLuckinLoc(false);
        trackEvent('Enable Luckin Chat Ordering');
        addToast(`Luckin ordering enabled ☕ Location: ${cityName || 'Set'}`, 'info');
        // First launch: automatically shows the usage instructions once (tucked into the banner's ? afterward)
        try {
            if (localStorage.getItem('aetheros.luckin.helpSeen') !== '1') {
                setShowLuckinHelp(true);
                localStorage.setItem('aetheros.luckin.helpSeen', '1');
            }
        } catch { /* ignore */ }
    }, [addToast]);

    const deactivateLuckin = useCallback(() => {
        luckinChatRef.current = { active: false };
        setLuckinMode(false);
    }, []);

    // When the user taps "Send to Character" on the menu card, insert the cart as a user message
    const handleMcdSendCart = useCallback(async (items: import('../components/chat/McdCard').McdCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join(', ');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` total ¥${total.toFixed(2)}` : '';
        const content = `Want to order: ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'cart', mcdCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // When the user taps 💭 on a single item on the menu card → immediately hands it to the character for their opinion (candidate state, doesn't go into the cart)
    const handleMcdCandidate = useCallback(async (item: import('../components/chat/McdCard').McdCartItem) => {
        if (!char || !item) return;
        const priceStr = typeof item.price === 'number' ? ` ¥${item.price}` : (typeof item.price === 'string' && item.price ? ` ¥${item.price}` : '');
        const content = `"${item.name}"${priceStr} — what do you think of this one?`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'candidate', mcdCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // Input typed inside the mini-app → saves a user message directly + immediately triggers the AI
    // (the main chat's handleSendText doesn't auto-trigger — that's the deliberate "manual ⚡ trigger"
    // flow — but inside the mini-app the user expects a reply right after sending, so that step is skipped).
    // Goes through the full pipeline: useChatAI reads mcdMiniAppRef when building the prompt and injects the mini-app state.
    const handleMcdMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromMcdMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    // Mini-app state syncs to the ref in real time, so it can be injected into the system prompt the next time send goes through the main pipeline
    const handleMcdMiniAppStateChange = useCallback((state: import('../utils/mcdToolBridge').McdMiniAppSnapshot) => {
        mcdMiniAppRef.current = state;
    }, []);

    // "Finalizing" the cart inside the mini-app → converts the cart into a cart card (reuses existing
    // rendering); Phase 2 will later hook calculate-price + create-order in here. For now, just let the character see and comment on the cart.
    const handleMcdAppConfirm = useCallback(async (
        cart: import('../components/mcd/McdMiniApp').CartLine[],
        ctx: import('../components/mcd/McdMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/McdCard').McdCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join(', ');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` total ¥${total.toFixed(2)}` : '';
        const where = ctx.orderType === 2
            ? `Delivery to ${ctx.addressLabel || ctx.addressId}`
            : `Pickup at store (${ctx.storeName || ctx.storeCode})`;
        const content = `${where} · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: {
                mcdCardKind: 'cart',
                mcdCartItems: items,
                mcdOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // ─── Luckin handlers (mirrors McDonald's) ───
    // NOTE: unlike mcd_card, utils/chatPrompts.ts (out of scope) has no metadata-rebuild case for
    // 'luckin_card' — its content field falls through to the generic default and is sent to the AI
    // verbatim. Confirmed via repo-wide grep that nothing regex-matches or string-compares against
    // this content, so translating it is still tier-2 safe — just noting the asymmetry with mcd_card for a future consistency pass.
    const handleLuckinSendCart = useCallback(async (items: import('../components/chat/LuckinCard').LuckinCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join(', ');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` total ¥${total.toFixed(2)}` : '';
        const content = `Want to order: ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'cart', luckinCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinCandidate = useCallback(async (item: import('../components/chat/LuckinCard').LuckinCartItem) => {
        if (!char || !item) return;
        const priceStr = (typeof item.price === 'number' || (typeof item.price === 'string' && item.price)) ? ` ¥${item.price}` : '';
        const content = `"${item.name}"${priceStr} — what do you think of this one?`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'candidate', luckinCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromLuckinMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    const handleLuckinMiniAppStateChange = useCallback((state: import('../utils/luckinToolBridge').LuckinMiniAppSnapshot) => {
        luckinMiniAppRef.current = state;
    }, []);

    const handleLuckinAppConfirm = useCallback(async (
        cart: import('../components/luckin/LuckinMiniApp').CartLine[],
        ctx: import('../components/luckin/LuckinMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/LuckinCard').LuckinCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
            spec: l.spec,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join(', ');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` total ¥${total.toFixed(2)}` : '';
        const content = `Pickup at store (${ctx.storeName || ctx.deptId}) · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: {
                luckinCardKind: 'cart',
                luckinCartItems: items,
                luckinOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // --- Schedule Handlers ---
    const loadSchedule = async () => {
        if (!char) return;
        if (!isScheduleFeatureOn(char)) { setScheduleData(null); return; }
        const s = await getDailyScheduleForChar(char);
        setScheduleData(s);
    };

    // Load schedule when modal opens
    React.useEffect(() => {
        if (modalType === 'schedule') loadSchedule();
    }, [modalType]);

    // The schedule goes to the cloud together with the fire_pack (the character says what they're
    // doing based on it, right on time), so an edit has to keep the cloud copy in sync: if the user
    // changes "Working out" to "Recovering at home" and the character still says "just got back from
    // the gym" that evening, the illusion breaks.
    const handleScheduleEdit = async (index: number, slot: ScheduleSlot) => {
        if (!scheduleData) return;
        const newSlots = [...scheduleData.slots];
        newSlots[index] = slot;
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
    };

    const handleScheduleDelete = async (index: number) => {
        if (!scheduleData) return;
        const newSlots = scheduleData.slots.filter((_, i) => i !== index);
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
    };

    const handleScheduleCoverChange = async (dataUrl: string) => {
        if (!scheduleData) return;
        const updated = { ...scheduleData, coverImage: dataUrl };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    // Theater: tap a time slot's play button. Play directly if cached; otherwise generate first then play (forceRegenerate = replay).
    const runTheater = async (index: number, forceRegenerate: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot) return;
        trackEvent('Open Schedule Theater', { mode: forceRegenerate ? 'replay' : 'play' });
        // Cache hit and not a replay: open directly, no tokens burned
        if (!forceRegenerate && slot.theater && slot.theater.lines.length > 0) {
            setTheaterSlotIdx(index);
            return;
        }
        setTheaterSlotIdx(index);
        setIsTheaterGenerating(true);
        try {
            const updated = await generateSlotTheater(char, userProfile, scheduleData, index, apiConfig, forceRegenerate);
            if (updated) {
                setScheduleData(updated);
            } else {
                addToast('Theater generation failed, please try again later', 'error');
                setTheaterSlotIdx(null);
            }
        } catch (e) {
            console.error('[Theater] play failed:', e);
            addToast('Theater generation failed, please try again later', 'error');
            setTheaterSlotIdx(null);
        } finally {
            setIsTheaterGenerating(false);
        }
    };

    const handlePlayTheater = (index: number) => { runTheater(index, false); };

    // Sends this theater scene to chat as a card. Both states "leave a trace" — the character always
    // knows what they were doing at the time; the only difference is exposed: whether they know "the
    // user saw."
    //   exposed=true  → they'll find out you were peeking
    //   exposed=false → they don't know you watched (but still remember what they were doing)
    // Sending the card itself no longer auto-triggers a reply — it just leaves a trace, and the character naturally carries that memory into the next chat.
    const handleSendTheaterCard = async (index: number, exposed: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot?.theater || slot.theater.lines.length === 0) return;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'theater_card',
            content: `${slot.startTime} · ${slot.activity}`,
            metadata: {
                theater: slot.theater,
                slotTime: slot.startTime,
                activity: slot.activity,
                emoji: slot.emoji,
                date: scheduleData.date,
                exposed,
            },
        });
        // Close the player + schedule modal, return to chat and see the card (but don't force-trigger a reply)
        setTheaterSlotIdx(null);
        setModalType('none');
        await reloadMessages(visibleCountRef.current);
        addToast(exposed ? 'They now know you were watching 👀' : 'Quietly recorded · they do not know you watched 🙈', 'info');
    };

    const generateDailySchedule = async (targetChar: typeof char, forceRegenerate: boolean = false) => {
        if (!targetChar || isScheduleGenerating) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(targetChar, userProfile, apiConfig, forceRegenerate);
            if (result) {
                setScheduleData(result);
                // Background regeneration across a day boundary also needs to refresh the cloud copy:
                // without it, the character would keep talking about yesterday's routine right on schedule.
                markAmsgStateDirty({ char: targetChar, userProfile, groups, realtimeConfig });
            }
        } catch (e) {
            console.error('[Schedule] Generation error:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    const handleScheduleStyleChange = async (style: 'lifestyle' | 'mindful') => {
        if (!char) return;
        // Force-synced with emotion/stream of consciousness: enabling schedule automatically enables emotion awareness
        const prevEmotion = char.emotionConfig;
        const nextEmotion = { ...(prevEmotion || {}), enabled: true };
        updateCharacter(char.id, { scheduleStyle: style, emotionConfig: nextEmotion });
        // Force regenerate with new style — use updated char object
        const updatedChar = { ...char, scheduleStyle: style, emotionConfig: nextEmotion };
        if (!isScheduleFeatureOn(updatedChar)) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(updatedChar, userProfile, apiConfig, true);
            if (result) setScheduleData(result);
        } catch (e) {
            console.error('[Schedule] Regeneration after style change failed:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    // Schedule / emotion buff master switch
    // Off: clears the frontend scheduleData, and also clears any cached buff injection (prevents it from continuing to pollute the next prompt)
    // On: if today's schedule hasn't been generated yet, generate it right away
    const handleToggleScheduleFeature = async () => {
        if (!char) return;
        const nextEnabled = !isScheduleFeatureOn(char);
        const patch: any = { scheduleFeatureEnabled: nextEnabled };
        if (nextEnabled) {
            // Aligned with handleScheduleStyleChange: enabling schedule = enabling emotion/stream of
            // consciousness together. Under the old logic, a new character's emotionConfig was never
            // initialized (undefined), so just flipping the master switch without picking a style
            // always left emotionConfig?.enabled false, and the secondary-API gate
            // (isScheduleFeatureOn && emotionConfig?.enabled) could never pass.
            patch.emotionConfig = { ...(char.emotionConfig || {}), enabled: true };
        } else {
            // While turning it off, also clear the buff injection, to avoid leftovers from the previous round still being injected
            patch.buffInjection = '';
            patch.activeBuffs = [];
        }
        updateCharacter(char.id, patch);
        if (!nextEnabled) {
            setScheduleData(null);
            addToast('Schedule and emotion turned off', 'info');
            return;
        }
        addToast('Schedule and emotion turned on', 'success');
        // Try to generate immediately after turning on (if not yet generated today and a style is already chosen)
        const updatedChar = { ...char, ...patch };
        if (updatedChar.scheduleStyle) {
            const existing = await getDailyScheduleForChar(updatedChar).catch(() => null);
            if (existing) {
                setScheduleData(existing);
            } else {
                generateDailySchedule(updatedChar, false);
            }
        }
    };

    // --- Modal Handlers ---

    /**
     * The emoji library is global: adding/deleting/renaming, deleting a category, or changing a
     * category's visibility scope all make the emoji list inside every character's cloud fire_pack
     * stale. When the character sends [[SEND_EMOJI]] right on schedule against the old list, the
     * client can't look it up and has to fall back to a plain text bubble — so all these entry points need to repack.
     */
    const markEmojiLibraryChanged = () => markAmsgStateDirtyForAll({ characters, userProfile, groups, realtimeConfig });

    const handleAddCategory = async () => {
        if (!newCategoryName.trim()) {
             addToast('Please enter a category name', 'error');
             return;
        }
        const newCat = { id: `cat-${Date.now()}`, name: newCategoryName.trim() };
        await DB.saveEmojiCategory(newCat);
        await loadEmojiData();
        setActiveCategory(newCat.id);
        setModalType('none');
        setNewCategoryName('');
        addToast('Category created', 'success');
    };

    const handleImportEmoji = async () => {
        if (!emojiImportText.trim()) return;
        const lines = emojiImportText.split('\n');
        const targetCatId = activeCategory === 'default' ? undefined : activeCategory;

        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    // What's pasted in might be a data: image (copy-pasted picture), or it might be an
                    // external image-hosting link. The former gets converted to a token, keeping only
                    // the binary; the latter is an address on someone else's server, stored as-is.
                    const stored = url.startsWith('data:') ? await migrateDataUrlToRef(url) : url;
                    await DB.saveEmoji(name, stored, targetCatId);
                }
            }
        }
        await loadEmojiData();
        markEmojiLibraryChanged();
        setModalType('none');
        setEmojiImportText('');
        addToast('Emoji pack imported', 'success');
    };

    const handleDeleteCategory = async () => {
        if (!selectedCategory) return;
        await DB.deleteEmojiCategory(selectedCategory.id);
        await loadEmojiData();
        markEmojiLibraryChanged();
        setActiveCategory('default');
        setModalType('none');
        setSelectedCategory(null);
        addToast('Category and its emoji deleted', 'success');
    };

    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {
        const cat = categories.find(c => c.id === categoryId);
        if (!cat) return;
        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });
        await loadEmojiData();
        markEmojiLibraryChanged();
        setSelectedCategory(null);
        addToast(allowedCharacterIds ? `Set visible to ${allowedCharacterIds.length} character(s)` : 'Set to visible to all characters', 'success');
    };

    const handleSavePrompt = () => {
        if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.content.trim()) {
            addToast('Please fill in all fields', 'error');
            return;
        }
        setArchivePrompts(prev => {
            let next;
            if (prev.some(p => p.id === editingPrompt.id)) {
                next = prev.map(p => p.id === editingPrompt.id ? editingPrompt : p);
            } else {
                next = [...prev, editingPrompt];
            }
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        setSelectedPromptId(editingPrompt.id);
        setModalType('archive-settings');
        setEditingPrompt(null);
    };

    const handleDeletePrompt = (id: string) => {
        if (id.startsWith('preset_')) {
            addToast('Default presets cannot be deleted', 'error');
            return;
        }
        setArchivePrompts(prev => {
            const next = prev.filter(p => p.id !== id);
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        if (selectedPromptId === id) setSelectedPromptId('preset_rational');
        addToast('Preset deleted', 'success');
    };

    const createNewPrompt = () => {
        setEditingPrompt({ id: `custom_${Date.now()}`, name: 'New Preset', content: DEFAULT_ARCHIVE_PROMPTS[0].content });
        setModalType('prompt-editor');
    };

    const editSelectedPrompt = () => {
        const p = archivePrompts.find(a => a.id === selectedPromptId);
        if (!p) return;
        if (p.id.startsWith('preset_')) {
            setEditingPrompt({ id: `custom_${Date.now()}`, name: `${p.name} (Copy)`, content: p.content });
        } else {
            setEditingPrompt({ ...p });
        }
        setModalType('prompt-editor');
    };

    const handleBgUpload = async (file: File) => {
        try {
            // Stores as a Blob now: no re-render at original quality, binary goes into blob_assets,
            // the field only stores a blobref token (saves the ~33% base64 bloat, and stops keeping
            // the whole image resident on the character's row).
            const blob = await processImageToBlob(file, { skipCompression: true });
            const ref = await putImageBlob(blob);
            updateCharacter(char.id, { chatBackground: ref });
            addToast('Chat background updated', 'success');
        } catch(err: any) {
            addToast(err.message, 'error');
        }
    };

    const saveSettings = async () => {
        const canUseAdaptiveRange = !!(char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm);
        const nextMode: ContextRangeMode = canUseAdaptiveRange
            ? settingsContextRangeMode
            : 'manual';
        const nextFollowsOneShotWaterline = nextMode === 'adaptive'
            && !!char.contextFollowsMemoryPalaceHwm;
        const candidate = {
            ...char,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: nextMode,
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
        };
        let nextUserStart = char.contextUserStartMessageId;
        try {
            const range = await loadCharacterContextRange(candidate);
            if (range.userBreakpointExpired) nextUserStart = undefined;
        } catch {
            // Saving the rest of the settings shouldn't be blocked by one range-check failure; the same safety clamp runs again on the AI request anyway.
        }
        updateCharacter(char.id, {
            contextLimit: settingsContextLimit,
            contextRangeMode: nextMode,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
            contextUserStartMessageId: nextUserStart,
            hideSystemLogs: settingsHideSysLogs,
            htmlModeCustomPrompt: settingsHtmlModeCustomPrompt,
        } as any);
        setModalType('none');
        addToast('Settings saved', 'success');
    };

    const handleToggleContextSuite = () => {
        const enabled = !contextSuiteAnyEnabled;
        trackEvent('Toggle Smart Context', {
            Status: enabled ? 'On' : 'Off',
            Previous: contextSuiteAllEnabled ? 'All On' : contextSuiteAnyEnabled ? 'Partially On' : 'All Off',
        });
        updateMemoryPalaceConfig({
            featureFlags: {
                ...memoryPalaceConfig.featureFlags,
                recallRouter: enabled,
                interactionAdaptation: enabled,
                deepEngagement: enabled,
            },
        });
        addToast(enabled ? 'Smart Context enabled' : 'Smart Context disabled, replies revert to the old flow', 'success');
    };

    const restoreAdaptiveContext = () => {
        if (!char.autoArchiveEnabled && !char.contextFollowsMemoryPalaceHwm) return;
        trackEvent('Restore Adaptive Context', {
            Source: char.autoArchiveEnabled ? 'Full-Auto Memory' : 'Waterline',
        });
        setSettingsContextRangeMode('adaptive');
        setSettingsContextLimit(500);
        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: 'adaptive',
            contextLimit: 500,
            contextFollowsMemoryPalaceHwm: !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: undefined,
        });
        addToast(
            char.autoArchiveEnabled
                ? 'Restored adaptive context for Full-Auto Memory'
                : 'Restored following the Waterline',
            'success',
        );
    };

    const handleClearHistory = async () => {
        if (!char) return;

        // Memory Palace safety check: if the character has Memory Palace enabled, check whether any messages haven't been vectorized yet
        if (char.memoryPalaceEnabled) {
            const hwm = await getMemoryPalaceHWM(char.id);
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const textMessages = allMessages.filter(m => m.type === 'text' && m.content?.trim());
            const unprocessedCount = textMessages.filter(m => m.id > hwm).length;

            if (unprocessedCount > 0) {
                // There are unprocessed messages, show a choice dialog
                const processedMsgs = allMessages.filter(m => m.id <= hwm);
                const choice = confirm(
                    `⚠️ Memory Palace Notice\n\n` +
                    `There are currently ${unprocessedCount} chat messages that Memory Palace hasn't processed (vectorized) yet.\n` +
                    `Clearing directly will permanently lose these messages — the character will never be able to remember them.\n\n` +
                    `Click "OK" → only delete messages already processed by Memory Palace (safe)\n` +
                    `Click "Cancel" → cancel the clear operation\n\n` +
                    `(If you don't understand the question, just click OK)`
                );

                if (!choice) {
                    return; // User cancelled
                }

                // Safe delete: only delete messages before the high water mark
                if (processedMsgs.length === 0) {
                    addToast('No processed messages to delete', 'info');
                    return;
                }
                const processedIds = processedMsgs.map(m => m.id);
                await DB.deleteMessages(processedIds);
                discardVoiceForMessages(processedIds);
                // Clearing history also touches the source of the cloud fire_pack's conversation snapshot — mark it dirty after the DB write (same below).
                markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
                const remaining = allMessages.filter(m => m.id > hwm);
                setMessages(remaining.slice(-200));
                setTotalMsgCount(remaining.length);
                setVisibleCount(LOAD_BATCH_SIZE);
                visibleCountRef.current = LOAD_BATCH_SIZE;
                addToast(`Safely cleared ${processedMsgs.length} processed message(s), kept ${remaining.length} unprocessed message(s)`, 'success');
                trackEvent('Clear Chat History');
                setModalType('none');
                return;
            }
        }

        // Original logic (no Memory Palace, or all messages already processed)
        if (preserveContext) {
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const toKeep = allMessages.slice(-10);
            const toKeepIds = new Set(toKeep.map(m => m.id));
            const toDelete = allMessages.filter(m => !toKeepIds.has(m.id));
            if (toDelete.length === 0) {
                addToast('Too few messages, nothing to clean up', 'info');
                return;
            }
            const toDeleteIds = toDelete.map(m => m.id);
            await DB.deleteMessages(toDeleteIds);
            discardVoiceForMessages(toDeleteIds);
            setMessages(toKeep);
            setTotalMsgCount(toKeep.length);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast(`Cleared ${toDelete.length} history message(s), kept the most recent 10`, 'success');
        } else {
            const allIds = (await DB.getMessagesByCharId(char.id, true)).map(m => m.id);
            await DB.clearMessages(char.id);
            discardVoiceForMessages(allIds);
            setMessages([]);
            setTotalMsgCount(0);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast('Cleared', 'success');
        }
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        trackEvent('Clear Chat History');
        setModalType('none');
    };

    // Only computes the one-click-save pending count when chat settings is opened; users who don't
    // open the modal get no extra DB scan. This counts by the button's real meaning: by default
    // processes up to the current end, and once checked, keeps exactly the last 10 messages of raw text.
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char?.memoryPalaceEnabled) {
            setVectorizePendingCount(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { getMemoryPalaceOneShotPendingCount } = await import('../utils/memoryPalace/pipeline');
                const n = await getMemoryPalaceOneShotPendingCount(
                    char.id,
                    retainRecentForVectorize ? 10 : 0,
                );
                if (!cancelled) setVectorizePendingCount(n);
            } catch {
                // If it can't be computed, just don't show the count — doesn't affect the button's availability
            }
        })();
        return () => { cancelled = true; };
    }, [modalType, char?.id, char?.memoryPalaceEnabled, retainRecentForVectorize]);

    const handleForceVectorize = async () => {
        if (!char || !char.memoryPalaceEnabled || isVectorizing) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl) {
            addToast('Please configure the API in Memory Palace settings first', 'error');
            return;
        }

        const retainedCount = retainRecentForVectorize ? 10 : 0;
        const charIdAtStart = char.id;
        setIsVectorizing(true);
        setVectorizeProgress('Preparing...');
        addToast(
            retainedCount === 10
                ? '🏰 Starting to organize chat, keeping the last 10 raw messages...'
                : '🏰 Starting to organize all chat history...',
            'info',
        );

        try {
            const {
                processNewMessages,
                getMemoryPalaceHighWaterMark,
                getMemoryPalaceOneShotPendingCount,
                mergePalaceFragmentsIntoMemories,
            } = await import('../utils/memoryPalace/pipeline');
            const pendingBefore = await getMemoryPalaceOneShotPendingCount(char.id, retainedCount);
            const hwmBefore = getMemoryPalaceHighWaterMark(char.id);
            setVectorizePendingCount(pendingBefore);
            setVectorizeProgress(pendingBefore > 0 ? `${pendingBefore} pending` : 'Syncing raw-text boundary...');

            const pipelineResult = await processNewMessages(
                [],
                char.id,
                char.name,
                mpEmb,
                mpLLM,
                userProfile?.name || '',
                true,
                setVectorizeProgress,
                {
                    drainBuffer: true,
                    retainRecentMessages: retainedCount,
                    requireAllBatches: true,
                },
            );

            if (charIdAtStart !== activeCharIdRef.current) return;
            if (!pipelineResult) throw new Error('Memory processing did not complete, please check the secondary API and network');
            if (pipelineResult.skipReason === 'lock') throw new Error('This character already has a memory task running, please try again later');
            const failedBatches = pipelineResult.batches.filter(batch => !batch.ok);
            if (failedBatches.length > 0) {
                throw new Error(`Batch ${failedBatches.map(batch => batch.index).join(', ')} failed, the waterline was not moved`);
            }

            const rangeMessages = (await DB.getMessagesByCharId(char.id, true))
                .filter(message => !message.groupId)
                .sort((a, b) => a.id - b.id);
            const expectedRetained = Math.min(retainedCount, rangeMessages.length);
            const targetBoundaryIndex = rangeMessages.length - expectedRetained - 1;
            const targetBoundaryId = targetBoundaryIndex >= 0 ? rangeMessages[targetBoundaryIndex].id : 0;
            const hwmAfter = getMemoryPalaceHighWaterMark(char.id);
            if (targetBoundaryId > hwmBefore && hwmAfter < targetBoundaryId) {
                throw new Error('Processing did not reach the intended boundary, raw-text range unchanged, please retry');
            }

            // The waterline only moves forward, never backward. In the rare case where the user first
            // picks "keep 0 messages" and then switches to "keep 10," those 10 have already been
            // processed — in that case, manually keeping 10 ensures the raw text is still readable, while avoiding re-vectorizing.
            const waterlineAlreadyAhead = expectedRetained > 0 && hwmBefore > targetBoundaryId;
            const nextMode: ContextRangeMode = waterlineAlreadyAhead ? 'manual' : 'adaptive';
            const nextLimit = expectedRetained > 0 ? 10 : (char.contextLimit || 500);
            const updates: Record<string, any> = {
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
                contextRangeMode: nextMode,
                contextLimit: nextLimit,
                contextFollowsMemoryPalaceHwm: !waterlineAlreadyAhead,
                contextUserStartMessageId: undefined,
            };

            if (char.autoArchiveEnabled) {
                updates.hideBeforeMessageId = Math.max(char.hideBeforeMessageId || 0, hwmAfter);
                if (pipelineResult.autoArchive) {
                    updates.memories = mergePalaceFragmentsIntoMemories(
                        char.memories ? [...char.memories] : [],
                        pipelineResult.autoArchive.fragments,
                    );
                }
            }
            updateCharacter(char.id, updates);
            setAllHistoryMessages(rangeMessages);
            setSettingsContextRangeMode(nextMode);
            setSettingsContextLimit(nextLimit);
            setVectorizePendingCount(await getMemoryPalaceOneShotPendingCount(char.id, retainedCount));
            setVectorizeResult({
                processedMessages: pipelineResult.processedMessages || pendingBefore,
                storedMemories: pipelineResult.stored,
                retainedMessages: expectedRetained,
                waterlineAlreadyAhead,
            });
            setModalType('memory-vectorize-result');
            addToast('✅ Memory processing complete, raw-text range synced', 'success');
        } catch (e: any) {
            addToast(`❌ Vectorization failed: ${e.message}`, 'error');
            if (charIdAtStart === activeCharIdRef.current) setModalType('chat-settings');
        } finally {
            setIsVectorizing(false);
            setVectorizeProgress('');
        }
    };

    const handleSetHistoryStart = (messageId: number | undefined) => {
        if (!messageId) {
            updateCharacter(char.id, {
                contextUserStartMessageId: undefined,
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            });
            setModalType('none');
            addToast('User breakpoint cleared, raw-text range now follows the slider limit again', 'success');
            return;
        }

        const range = historyContextRange;
        const maxStart = range?.maxRangeStartMessageId;
        // Not using Array.prototype.at: tsconfig's lib doesn't have es2022 enabled, tsc would error
        const rangeMessages = range?.messages ?? [];
        const latestId = rangeMessages[rangeMessages.length - 1]?.id
            || allHistoryMessages[allHistoryMessages.length - 1]?.id;
        if (maxStart === undefined || latestId === undefined || messageId < maxStart || messageId > latestId) {
            const required = countMessagesFrom(allHistoryMessages, messageId);
            const hint = settingsContextRangeMode === 'adaptive'
                ? `This message is outside Full-Auto Memory's current raw-text range. Please switch to a custom range first, and set the slider to at least ${required}.`
                : required > 5000
                    ? 'This message exceeds the context slider limit of 5000 and cannot be set as a user breakpoint.'
                    : `This message is outside the current slider range. Please set context to at least ${required} first.`;
            addToast(hint, 'error');
            return;
        }

        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: (char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm)
                ? settingsContextRangeMode
                : 'manual',
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: settingsContextRangeMode === 'adaptive'
                && !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: messageId,
        });
        setModalType('none');
        addToast('AI raw-text read breakpoint set', 'success');
    };

    // Jump to an old message: first position to a small window around the target, then expand
    // forward/backward in batches as the user scrolls to the window's edge. This way, neither is the
    // whole giant DOM mounted on first load, nor is the user locked into just 51 messages.
    const handleJumpToMessageInChat = async (messageId: number) => {
        if (!activeCharacterId) return;
        setModalType('none');
        const requestCharId = activeCharacterId;
        const LARGE = 999999;
        visibleCountRef.current = LARGE;
        setVisibleCount(LARGE);
        const allMsgs = await DB.getMessagesByCharId(requestCharId, true);
        if (activeCharIdRef.current !== requestCharId) return;
        const browseableMessages = allMsgs.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs));
        const targetIndex = browseableMessages.findIndex(message => message.id === messageId);
        if (targetIndex < 0) {
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            addToast('This message is not currently shown in the chat view', 'info');
            await reloadMessages(LOAD_BATCH_SIZE);
            return;
        }

        const nextRange = createChatHistoryWindow(
            browseableMessages.length,
            targetIndex,
            HISTORY_WINDOW_RADIUS,
        );
        setMessages(allMsgs);
        setTotalMsgCount(browseableMessages.length);
        historyWindowTotalRef.current = browseableMessages.length;
        historyWindowRangeRef.current = nextRange;
        historyWindowScrollEnabledRef.current = false;
        setHistoryWindowRange(nextRange);
        setWindowedFocusMsgId(messageId);
        setFlashMsgId(messageId);
        // Wait for the window's nodes to mount to the DOM before positioning; only allow edge
        // continuation-loading after the positioning animation ends, so the scroll animation itself doesn't trigger onScroll and shift the window early.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const el = document.getElementById(`chat-msg-${messageId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (historyJumpUnlockTimerRef.current) window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = window.setTimeout(() => {
                historyWindowScrollEnabledRef.current = true;
                historyJumpUnlockTimerRef.current = null;
            }, 450);
        }));
        window.setTimeout(() => setFlashMsgId(null), 2200);
    };

    const refreshContentFavoriteIds = useCallback(async () => {
        const items = await listContentFavorites().catch(() => []);
        setContentFavoriteIds(new Set(items.map(item => item.id)));
    }, []);

    useEffect(() => {
        void refreshContentFavoriteIds();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
        return () => window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
    }, [refreshContentFavoriteIds]);

    const handleToggleContentFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        const favoriteId = contentFavoriteIdForMessage(msg);
        try {
            if (contentFavoriteIds.has(favoriteId)) {
                await removeContentFavoriteById(favoriteId);
                setContentFavoriteIds(previous => {
                    const next = new Set(previous);
                    next.delete(favoriteId);
                    return next;
                });
                addToast(msg.type === 'image' ? 'Removed image from favorites' : 'Removed chat message from favorites', 'info');
                return;
            }
            await saveMessageContentFavorite(msg, char?.name || 'Unknown character');
            setContentFavoriteIds(previous => new Set(previous).add(favoriteId));
            addToast(msg.type === 'image' ? 'Image favorited (reference only)' : 'Chat message favorited', 'success');
            trackEvent(msg.type === 'image' ? 'Favorite Chat Image' : 'Favorite Chat Message');
        } catch (error) {
            console.warn('[Chat] favorite content failed', error);
            addToast('Favoriting failed, please try again later', 'error');
        }
    };

    const handleOpenFavoriteMessage = (charId: string, messageId: number) => {
        setFavoritesOpen(false);
        if (activeCharIdRef.current === charId) {
            void handleJumpToMessageInChat(messageId);
            return;
        }
        pendingFavoriteJumpRef.current = { charId, messageId };
        setActiveCharacterId(charId);
    };

    useEffect(() => {
        const pending = pendingFavoriteJumpRef.current;
        if (!pending || pending.charId !== activeCharacterId) return;
        pendingFavoriteJumpRef.current = null;
        const timer = window.setTimeout(() => void handleJumpToMessageInChat(pending.messageId), 0);
        return () => window.clearTimeout(timer);
    // handleJumpToMessageInChat intentionally uses the freshly rendered character state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCharacterId]);

    const handleBackToCurrent = async () => {
        setWindowedFocusMsgId(null);
        setHistoryWindowRange(null);
        historyWindowRangeRef.current = null;
        historyWindowTotalRef.current = 0;
        historyWindowLoadingRef.current = false;
        historyPrependAnchorRef.current = null;
        historyWindowScrollEnabledRef.current = false;
        if (historyJumpUnlockTimerRef.current) {
            window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = null;
        }
        setFlashMsgId(null);
        visibleCountRef.current = LOAD_BATCH_SIZE;
        setVisibleCount(LOAD_BATCH_SIZE);
        await reloadMessages(LOAD_BATCH_SIZE);
        requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        });
    };

    const handleFullArchive = async () => {
        if (!apiConfig.apiKey || !char) {
            addToast('Please configure an API Key first', 'error');
            return;
        }
        const allMessages = await DB.getMessagesByCharId(char.id, true);
        const msgsByDate: Record<string, Message[]> = {};
        allMessages
        .filter(m => !char.hideBeforeMessageId || m.id >= char.hideBeforeMessageId)
        .forEach(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
            msgsByDate[dateStr].push(m);
        });

        const datesToProcess = Object.keys(msgsByDate).sort();
        if (datesToProcess.length === 0) {
            addToast('Chat history is empty, nothing to archive', 'info');
            return;
        }

        setIsSummarizing(true);
        setShowPanel('none');
        setArchiveProgress(`Preparing to archive ${datesToProcess.length} day(s)...`);
        addToast(`Starting to archive ${datesToProcess.length} day(s) of chat history`, 'info');
        trackEvent('Archive Chat History');

        try {
            let processedCount = 0;
            const newMemories: MemoryFragment[] = [];
            const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
            const template = templateObj.content;

            for (let idx = 0; idx < datesToProcess.length; idx++) {
                const dateStr = datesToProcess[idx];
                setArchiveProgress(`Archiving ${dateStr} (${idx + 1}/${datesToProcess.length})`);
                const dayMsgs = msgsByDate[dateStr];
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, char.name, userProfile.name, formatTime))
                    .join('\n');
                
                let prompt = template;
                prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
                prompt = prompt.replace(/\$\{char\.name\}/g, char.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.5,
                        max_tokens: 8000 
                    })
                });

                if (!response.ok) throw new Error(`API Error on ${dateStr}`);
                const data = await safeResponseJson(response);
                let summary = extractContent(data);
                summary = summary.replace(/^["']|["']$/g, '').trim();

                if (summary) {
                    newMemories.push({ id: `mem-${Date.now()}-${idx}`, date: dateStr, summary: summary, mood: 'archive' });
                    processedCount++;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const total = datesToProcess.length;

            if (processedCount === 0) {
                addToast(`Archive failed: no summary was generated for any of the ${total} day(s) (please check API/model)`, 'error');
                setModalType('none');
            } else {
                const finalMemories = [...(char.memories || []), ...newMemories];

                // Key fix: once a full archive succeeds, push hideBeforeMessageId to the position of
                // "the reserve-th message from the end." Without pushing it, clicking archive again
                // next time would make the hideBefore filter ineffective — the already-archived days
                // would get re-summarized, piling duplicate entries into char.memories. Keeps the most
                // recent max(100, 15%) messages unhidden (aligned with palace auto-archive's hot-zone
                // concept), so the chat UI doesn't suddenly go empty.
                //
                // On a partial failure, don't push hideBefore — the raw messages for those days were
                // never written into a MemoryFragment, and pushing it would make them truly
                // unreadable. The user retrying archive next time will fill in the failed days.
                let newHideBefore = char.hideBeforeMessageId;
                let reservedCount = 0;
                let hiddenCount = 0;
                if (processedCount === total) {
                    const allArchivedMsgs: Message[] = [];
                    for (const d of datesToProcess) allArchivedMsgs.push(...msgsByDate[d]);
                    allArchivedMsgs.sort((a, b) => a.id - b.id);
                    const RESERVE = Math.max(100, Math.ceil(allArchivedMsgs.length * 0.15));
                    if (allArchivedMsgs.length > RESERVE) {
                        const candidate = allArchivedMsgs[allArchivedMsgs.length - RESERVE].id;
                        // Only moves forward, never backward
                        if (!char.hideBeforeMessageId || candidate > char.hideBeforeMessageId) {
                            newHideBefore = candidate;
                            reservedCount = RESERVE;
                            hiddenCount = allArchivedMsgs.length - RESERVE;
                        }
                    }
                }

                const updates: Partial<typeof char> = { memories: finalMemories };
                if (newHideBefore !== char.hideBeforeMessageId) {
                    (updates as any).hideBeforeMessageId = newHideBefore;
                }
                updateCharacter(char.id, updates as any);

                const hideStr = hiddenCount > 0
                    ? ` (hid ${hiddenCount} old message(s), kept the most recent ${reservedCount} visible)`
                    : '';
                if (processedCount < total) {
                    addToast(`Archiving complete: ${processedCount}/${total} day(s) succeeded (some failed, clicking again next time will fill them in)`, 'info');
                } else {
                    addToast(`Archiving complete: successfully archived ${processedCount} day(s)${hideStr}`, 'success');
                }
                setModalType('none');
            }

        } catch (e: any) {
            addToast(`Archiving interrupted: ${e.message}`, 'error');
        } finally {
            setIsSummarizing(false);
            setArchiveProgress('');
        }
    };

    // --- Message Management ---
    const handleDeleteMessage = async () => {
        if (!selectedMessage) return;
        const deletedId = selectedMessage.id;
        await DB.deleteMessage(deletedId);
        discardVoiceForMessages([deletedId]);
        // Full-fat proactive messages: the cloud fire_pack carries the raw text of recent
        // conversation — if a deleted message doesn't get marked dirty, the character will bring up
        // this already-deleted message right on schedule (the snapshot's messages are re-read from
        // the DB on flush; this call only handles marking it dirty).
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        setMessages(prev => prev.filter(m => m.id !== deletedId));
        setTotalMsgCount(prev => Math.max(0, prev - 1));
        setModalType('none');
        setSelectedMessage(null);
        addToast('Message deleted', 'success');
        trackEvent('Delete a Message');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        const contentChanged = editContent !== selectedMessage.content;
        await DB.updateMessage(selectedMessage.id, editContent);
        // If the content changed, the old voice clip is invalidated, otherwise the voice bar would still play the pre-edit audio.
        if (contentChanged) discardVoiceForMessages([selectedMessage.id]);
        // Same as handleDeleteMessage: if the body text changed, the cloud fire_pack needs to catch up.
        if (contentChanged) markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('Message updated', 'success');
        trackEvent('Edit a Message');
    };

    const handleQuickReply = useCallback((message: Message) => {
        setReplyTarget({
            ...message,
            // Kept literally '我' (not translated) — see the matching note in handleSendText above
            // (utils/chatPrompts.ts:1179, out of scope, compares against this literal string)
            metadata: { ...message.metadata, senderName: message.role === 'user' ? '我' : char.name }
        });
        trackEvent('Quote-Reply a Message');
    }, [char.name]);

    const handleReplyMessage = () => {
        if (!selectedMessage) return;
        handleQuickReply(selectedMessage);
        setModalType('none');
    };

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('Copied to clipboard', 'success');
        trackEvent('Copy a Message');
    };

    const handleDeleteEmoji = async () => {
        if (!selectedEmoji) return;
        const emojisToDelete = Array.isArray(selectedEmoji) ? selectedEmoji : [selectedEmoji];
        try {
            await Promise.all(emojisToDelete.map(emoji => DB.deleteEmoji(emoji.name)));
            addToast(Array.isArray(selectedEmoji) ? `Deleted ${selectedEmoji.length} emoji(s)` : 'Emoji deleted', 'success');
        } catch (err) {
            console.error('Failed to delete emojis:', err);
            addToast('Failed to delete emoji', 'error');
        } finally {
            await loadEmojiData();
            // Placed in finally: even on a partial Promise.all failure, a few were still deleted, and the cloud copy is stale regardless.
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
        }
    };

    const handleRenameEmoji = async () => {
        if (!selectedEmoji || Array.isArray(selectedEmoji)) return;
        const newName = newEmojiName.trim();
        if (!newName) { addToast('Emoji name cannot be empty', 'error'); return; }
        if (newName === selectedEmoji.name) { setModalType('none'); setSelectedEmoji(null); return; }
        try {
            await DB.renameEmoji(selectedEmoji.name, newName);
            addToast('Emoji name updated', 'success');
            await loadEmojiData();
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
            setNewEmojiName('');
        } catch (err: any) {
            console.error('Failed to rename emoji:', err);
            addToast(err?.message || 'Failed to update name', 'error');
        }
    };

    // --- Batch Selection ---
    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleThinkingSelection = useCallback((id: number) => {
        setSelectedThinkingMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Memoized callbacks for MessageItem to avoid busting React.memo
    const handleMessageLongPress = useCallback((msg: Message) => {
        setSelectedMessage(msg);
        setModalType('message-options');
    }, []);

    const handleBatchDelete = async () => {
        const msgIdsToDelete = new Set<number>(selectedMsgIds);
        // Thinking chain checked on its own, but the host message isn't -> only clear metadata.thinkingChain, keep the message
        const thinkingIdsToClear = new Set<number>();
        selectedThinkingMsgIds.forEach(id => {
            if (!msgIdsToDelete.has(id)) thinkingIdsToClear.add(id);
        });
        if (msgIdsToDelete.size === 0 && thinkingIdsToClear.size === 0) return;

        // When deleting a message, if its thinking chain wasn't checked, try migrating it onto the
        // next assistant message in the same round — making "only wanted to delete the first output, but keep the thinking chain" work.
        const sorted = [...messages].sort((a, b) => a.id - b.id);
        const idxById = new Map<number, number>();
        sorted.forEach((m, i) => idxById.set(m.id, i));
        const migrations: { targetId: number; chain: string }[] = [];
        msgIdsToDelete.forEach(id => {
            const msg = messages.find(x => x.id === id);
            const chain = msg?.metadata?.thinkingChain;
            if (!msg || !chain) return;
            if (selectedThinkingMsgIds.has(id)) return; // The user chose to delete the thinking chain along with it
            const startIdx = idxById.get(id);
            if (startIdx == null) return;
            for (let i = startIdx + 1; i < sorted.length; i++) {
                const next = sorted[i];
                if (next.role !== 'assistant') break; // Out of this round, nowhere left to attach it to
                if (msgIdsToDelete.has(next.id)) continue;
                migrations.push({ targetId: next.id, chain: String(chain) });
                break;
            }
        });

        for (const mig of migrations) {
            await DB.updateMessageMetadata(mig.targetId, (prev) => ({ ...(prev || {}), thinkingChain: mig.chain }));
        }
        for (const id of thinkingIdsToClear) {
            await DB.updateMessageMetadata(id, (prev) => {
                if (!prev || !('thinkingChain' in prev)) return prev;
                const { thinkingChain, ...rest } = prev;
                return rest;
            });
        }
        const ids = Array.from(msgIdsToDelete);
        if (ids.length > 0) {
            await DB.deleteMessages(ids);
            discardVoiceForMessages(ids);
        }

        const migMap = new Map(migrations.map(m => [m.targetId, m.chain]));
        setMessages(prev => prev
            .filter(m => !msgIdsToDelete.has(m.id))
            .map(m => {
                if (migMap.has(m.id)) {
                    return { ...m, metadata: { ...(m.metadata || {}), thinkingChain: migMap.get(m.id) } };
                }
                if (thinkingIdsToClear.has(m.id) && m.metadata?.thinkingChain) {
                    const { thinkingChain, ...rest } = m.metadata;
                    return { ...m, metadata: rest };
                }
                return m;
            })
        );
        setTotalMsgCount(prev => Math.max(0, prev - msgIdsToDelete.size));

        const parts: string[] = [];
        if (msgIdsToDelete.size > 0) parts.push(`Deleted ${msgIdsToDelete.size} message(s)`);
        if (thinkingIdsToClear.size > 0) parts.push(`Cleared ${thinkingIdsToClear.size} thinking chain(s)`);
        addToast(parts.join(', '), 'success');

        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        setSelectedThinkingMsgIds(new Set());
    };

    // --- Forward Chat Records ---
    const [showForwardModal, setShowForwardModal] = useState(false);
    const [forwardGroupId, setForwardGroupId] = useState(GROUP_FILTER_ALL); // Character group filter for the forward modal

    const handleForwardSelected = () => {
        if (selectedMsgIds.size === 0) return;
        setShowForwardModal(true);
    };

    const handleForwardToCharacter = async (targetCharId: string) => {
        if (!char) return;
        const selectedMsgs = messages
            .filter(m => selectedMsgIds.has(m.id))
            .sort((a, b) => a.id - b.id);

        if (selectedMsgs.length === 0) return;

        // Build preview text (first few messages)
        const previewLines = selectedMsgs.slice(0, 4).map(m => {
            const sender = m.role === 'user' ? userProfile.name : char.name;
            const text = m.type === 'text' ? m.content.slice(0, 30) : `[${m.type === 'image' ? 'Image' : m.type === 'emoji' ? 'Emoji' : m.type}]`;
            return `${sender}: ${text}`;
        });
        if (selectedMsgs.length > 4) previewLines.push(`... ${selectedMsgs.length} messages total`);

        const forwardData = {
            fromUserName: userProfile.name,
            fromCharName: char.name,
            count: selectedMsgs.length,
            preview: previewLines,
            messages: selectedMsgs.map(m => ({
                role: m.role,
                type: m.type,
                content: m.content,
                timestamp: m.timestamp || Date.now()
            }))
        };

        // Save forward card to target character's chat
        await DB.saveMessage({
            charId: targetCharId,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
        });

        // Also save a copy in the current chat so the user can see what they forwarded
        const targetChar = characters.find(c => c.id === targetCharId);
        if (char.id !== targetCharId) {
            await DB.saveMessage({
                charId: char.id,
                role: 'system',
                type: 'text' as MessageType,
                content: `[Forwarded ${selectedMsgs.length} message(s) to ${targetChar?.name || ''}]`,
            });
            // Refresh messages to show the forwarding system message
            reloadMessages(visibleCountRef.current);
        }

        addToast(`Forwarded ${selectedMsgs.length} message(s) to ${targetChar?.name || ''}`, 'success');
        setShowForwardModal(false);
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
    };

    const handleOpenCollaborationFile = useCallback(async (msg: Message) => {
        const assetId = String(msg.metadata?.collaborationAssetId || '');
        const fileName = String(msg.metadata?.fileName || 'Collaboration File');
        if (!assetId) {
            addToast('This file message is missing its original file reference', 'error');
            return;
        }
        const isInstallable = msg.metadata?.collaborationAttachmentKind === 'installable'
            || String(msg.metadata?.mimeType || '').includes('vnd.sullyos.installable');
        if (isInstallable) {
            setCollaborationPreviewAssetId(assetId);
            setCollaborationOpen(true);
            return;
        }
        try {
            const blob = await CollaborationStore.getAsset(assetId);
            if (!blob) {
                addToast('The original file no longer exists and cannot be opened', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({
                blob,
                fileName,
                shareTitle: `File from ${char?.name || 'the character'}`,
                preferDownloadOnWeb: true,
            });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? 'Opened the system save/share sheet' : 'File download started', 'success');
        } catch (error: any) {
            addToast(error?.message || 'Failed to open file', 'error');
        }
    }, [addToast, char?.name]);

    const handleCollaborationPreviewHandled = useCallback(() => {
        setCollaborationPreviewAssetId(null);
    }, []);

    // Collaboration is an independent sidecar: only when the user taps "Send to Chat App" does it
    // write into the main message table through this narrow bridge. Every other collaboration
    // session, prompt, API, and file stays in its own separate database and never enters the main chat pipeline.
    const handleCollaborationTransfer = useCallback(async (
        sessionTitle: string,
        transferredMessages: CollaborationTransferMessage[],
    ) => {
        if (!char || transferredMessages.length === 0) return;
        const preview = transferredMessages.slice(0, 4).map(message => {
            const sender = message.role === 'user' ? userProfile.name : char.name;
            return `${sender}: ${message.content.replace(/\s+/g, ' ').slice(0, 36)}`;
        });
        if (transferredMessages.length > 4) preview.push(`… ${transferredMessages.length} messages total`);
        const forwardData = {
            fromUserName: userProfile.name,
            fromCharName: `${char.name} · Collaboration`,
            count: transferredMessages.length,
            preview,
            messages: transferredMessages,
            collaborationTitle: sessionTitle,
        };
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
            metadata: {
                source: 'collaboration_transfer',
                collaborationTitle: sessionTitle,
            },
        });
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        await reloadMessages(visibleCountRef.current);
    }, [char, userProfile, groups, realtimeConfig, reloadMessages]);

    const handleCollaborationNotify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
        addToast(message, type);
    }, [addToast]);

    const handleCollaborationArchiveToMemory = useCallback(async (
        summary: string,
        occurredAt: number,
        sourceId: string,
    ): Promise<string> => {
        if (!char) throw new Error('Current character does not exist');
        const occurred = new Date(occurredAt);
        const date = `${occurred.getFullYear()}-${String(occurred.getMonth() + 1).padStart(2, '0')}-${String(occurred.getDate()).padStart(2, '0')}`;
        const fragmentId = `collab_archive_${sourceId}`;

        if (char.memoryPalaceEnabled) {
            const embedding = memoryPalaceConfig.embedding;
            const lightLLM = memoryPalaceConfig.lightLLM;
            if (!embedding?.baseUrl || !embedding?.apiKey || !embedding?.model || !lightLLM?.baseUrl || !lightLLM?.model) {
                throw new Error('This character has Memory Palace enabled, but the Palace vector API or secondary LLM is not fully configured yet');
            }
            const { importExternalMemoryText, mergePalaceFragmentsIntoMemories } = await import('../utils/memoryPalace/pipeline');
            const imported = await importExternalMemoryText(
                summary,
                char.id,
                char.name,
                embedding,
                lightLLM,
                userProfile.name,
            );
            if (imported.error && imported.error !== 'no_memories') {
                throw new Error(`Memory Palace failed to save: ${imported.error}`);
            }
            if (imported.stored === 0 && imported.skipped === 0) {
                throw new Error('Memory Palace did not extract any experience worth saving');
            }
            const palaceFragment: { id: string; date: string; summary: string; mood: string } = {
                id: fragmentId,
                date,
                summary: `- ${summary}`,
                mood: 'palace',
            };
            await updateCharacter(char.id, current => ({
                memories: (current.memories || []).some(memory => memory.id === fragmentId)
                    ? current.memories
                    : mergePalaceFragmentsIntoMemories(current.memories || [], [palaceFragment]),
            }));
            return `Saved a summary of this collaboration into ${char.name}'s Memory Palace and Neural Link`;
        }

        const archiveFragment: MemoryFragment = {
            id: fragmentId,
            date,
            summary,
            mood: 'collaboration',
        };
        await updateCharacter(char.id, current => ({
            memories: (current.memories || []).some(memory => memory.id === fragmentId)
                ? current.memories
                : [...(current.memories || []), archiveFragment],
        }));
        return `Saved a summary of this collaboration into ${char.name}'s Neural Link`;
    }, [char, memoryPalaceConfig.embedding, memoryPalaceConfig.lightLLM, updateCharacter, userProfile.name]);

    const handleCollaborationInstall = useCallback(async (
        artifact: CollaborationInstallableArtifact,
        targetCharacterId?: string,
    ): Promise<string> => {
        const errors = validateInstallableArtifact(artifact);
        if (errors.length > 0) throw new Error(errors[0]);

        if (artifact.kind === 'bubble-theme') {
            const nextTheme = installableToChatTheme(artifact);
            await addCustomTheme(nextTheme);
            if (targetCharacterId) await updateCharacter(targetCharacterId, { bubbleStyle: nextTheme.id });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `Bubble theme saved, and applied to ${target.name}` : 'Bubble theme saved to Bubble Workshop';
        }

        if (artifact.kind === 'whitebox-css') {
            const css = String(artifact.payload.css || '');
            const stored = await DB.getAssetRaw('chrome_css_presets').catch(() => null);
            const presets = Array.isArray(stored) ? stored.filter(item => item && typeof item === 'object') : [];
            const nextPreset = { name: artifact.title.slice(0, 50), code: css, swatch: '#e2e8f0' };
            await DB.saveAssetRaw('chrome_css_presets', [nextPreset, ...presets.filter((item: any) => item.name !== nextPreset.name)].slice(0, 60));
            if (targetCharacterId) await updateCharacter(targetCharacterId, { chromeCustomCss: css });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `Whitebox saved to presets, and applied to ${target.name}` : 'Whitebox saved to presets';
        }

        if (artifact.kind === 'journal-css') {
            await updateTheme({ journalAppearance: { preset: 'original', customCss: String(artifact.payload.css || '') } });
            return 'Exchange Diary styling saved and enabled';
        }

        if (artifact.kind === 'schedule-css') {
            await updateTheme({
                scheduleCardAppearance: {
                    ...(osTheme.scheduleCardAppearance || {}),
                    customCss: String(artifact.payload.css || ''),
                },
            });
            return 'Schedule card styling saved and enabled';
        }

        if (artifact.kind === 'psyche-css') {
            if (!targetCharacterId) throw new Error('Please select a character to apply the Psyche card styling to');
            await updateCharacter(targetCharacterId, { thinkingChainCustomCss: String(artifact.payload.css || '') });
            const target = characters.find(item => item.id === targetCharacterId);
            return `Psyche card styling applied to ${target?.name || 'the selected character'}`;
        }

        if (artifact.kind === 'appearance-preset') {
            const patch = installableToThemePatch(artifact);
            const presetTheme = { ...osTheme, ...patch };
            await saveAppearancePreset(artifact.title.slice(0, 50), presetTheme);
            await updateTheme(patch);
            return 'The full interface has been saved as an Appearance preset and enabled';
        }

        if (artifact.kind === 'character-card') {
            const created = await addCharacter();
            await updateCharacter(created.id, installableToCharacterPatch(artifact));
            return `Character "${String(artifact.payload.name || artifact.title)}" created`;
        }

        const books = installableToWorldbooks(artifact);
        for (const book of books) await addWorldbook(book);
        if (targetCharacterId) {
            await updateCharacter(targetCharacterId, current => ({
                mountedWorldbooks: upsertMountedWorldbooks(current.mountedWorldbooks || [], books),
            }));
        }
        const target = characters.find(item => item.id === targetCharacterId);
        return target
            ? `${books.length} entries from Worldbook "${String(artifact.payload.category || artifact.title)}" saved and mounted to ${target.name}`
            : `Worldbook saved to the worldbook library, ${books.length} entries total`;
    }, [addCharacter, addCustomTheme, addWorldbook, characters, osTheme, saveAppearancePreset, updateCharacter, updateTheme]);

    // hideBeforeMessageId is not filtered at the display layer: the user can still scroll up to old
    // messages, the LLM just can't pull them. To truly erase something from chat history, use "Delete."
    // Old-message positioning mode still maintains a limited DOM window, but the window keeps expanding as the user scrolls up/down.
    const chatDisplayMessages = useMemo(
        () => messages.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs)),
        [messages, char?.id, char?.hideSystemLogs],
    );

    useEffect(() => {
        if (windowedFocusMsgId !== null) historyWindowTotalRef.current = chatDisplayMessages.length;
    }, [chatDisplayMessages.length, windowedFocusMsgId]);

    const displayMessages = useMemo(() => {
        if (windowedFocusMsgId !== null) {
            if (historyWindowRange) {
                return chatDisplayMessages.slice(
                    Math.max(0, historyWindowRange.start),
                    Math.min(chatDisplayMessages.length, historyWindowRange.end),
                );
            }
            const idx = chatDisplayMessages.findIndex(m => m.id === windowedFocusMsgId);
            if (idx >= 0) {
                return chatDisplayMessages.slice(
                    Math.max(0, idx - HISTORY_WINDOW_RADIUS),
                    Math.min(chatDisplayMessages.length, idx + HISTORY_WINDOW_RADIUS + 1),
                );
            }
        }
        return chatDisplayMessages.slice(-visibleCount);
    }, [chatDisplayMessages, visibleCount, windowedFocusMsgId, historyWindowRange]);

    const collapsedCount = Math.max(0, totalMsgCount - displayMessages.length);
    const hasOlderHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.start > 0;
    const hasNewerHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.end < chatDisplayMessages.length;

    // ── New message entry animation ──────────────────────────────────────────────
    // Only fades in the "just-appended newest message" (sent by the user / replied by AI) once, as a whole.
    // Doesn't play on the first frame of entering chat, switching characters, or scrolling through
    // history (older messages have smaller ids) — avoids the whole screen flashing at once.
    const animSeenMaxIdRef = useRef<number | null>(null);
    const [animatingIds, setAnimatingIds] = useState<Set<number>>(() => new Set());
    // Switching character / first entry: clear the baseline, the next detection round only records it, doesn't play
    useEffect(() => {
        animSeenMaxIdRef.current = null;
        streamPreviewHandoverIdsRef.current.clear();
        setAnimatingIds(new Set());
    }, [activeCharacterId]);
    // Detect additions: only fades in ids past the baseline; the first frame only records the baseline, doesn't play
    useEffect(() => {
        if (displayMessages.length === 0) return;
        let maxId = -Infinity;
        for (const m of displayMessages) if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
        if (animSeenMaxIdRef.current === null) { animSeenMaxIdRef.current = maxId; return; }
        const baseline = animSeenMaxIdRef.current;
        const fresh = displayMessages
            .filter(m => typeof m.id === 'number' && m.id > baseline && !streamPreviewHandoverIdsRef.current.has(m.id))
            .map(m => m.id);
        if (fresh.length > 0) {
            setAnimatingIds(prev => { const next = new Set(prev); fresh.forEach(id => next.add(id)); return next; });
            animSeenMaxIdRef.current = maxId;
        }
    }, [displayMessages]);

    // Stable thinking-chain config object: only rebuilt when the character/style changes, avoiding a new object on every render defeating MessageItem.memo.
    const thinkingChainOptions = useMemo(() => ({
        styleId: (char as any)?.thinkingChainStyle || 'echo',
        customColors: (char as any)?.thinkingChainCustomColors,
        onOpenSettings: () => setShowThinkingChainModal(true),
    }), [(char as any)?.thinkingChainStyle, (char as any)?.thinkingChainCustomColors]);

    // The gray tool-trace line needs to hug the bubble, so most of the bubble's own group spacing
    // (the mb-3 / mb-6 / mb-8 set in MessageItem) is offset away. Bubbles within a group already sit right next to each other, no need to offset those.
    const toolTracePullClass = osTheme.chatMessageSpacing === 'compact' ? '-mt-2'
        : osTheme.chatMessageSpacing === 'spacious' ? '-mt-6' : '-mt-5';

    // Reset active category if it becomes invisible for the current character
    useEffect(() => {
        if (activeCategory !== 'default' && visibleCategories.length > 0 && !visibleCategories.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    }, [visibleCategories, activeCategory]);

    // Build a set of hidden category IDs for quick lookup
    const hiddenCategoryIds = useMemo(() => {
        const visible = new Set(visibleCategories.map(c => c.id));
        return new Set(categories.filter(c => !visible.has(c.id)).map(c => c.id));
    }, [categories, visibleCategories]);

    // Memoize filtered emojis for ChatInputArea
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        // Exclude emojis from hidden categories
        if (e.categoryId && hiddenCategoryIds.has(e.categoryId)) return false;
        if (activeCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeCategory;
    }), [emojis, activeCategory, hiddenCategoryIds]);

    // Memoize ChatInputArea callbacks
    const handleSendCallback = useCallback(() => handleSendText(), [char, input, replyTarget]);
    const handleCharSelectCallback = useCallback((id: string) => { setActiveCharacterId(id); setShowPanel('none'); }, []);
    // Character's custom chat background: the field value might be a blobref token (binary lives in
    // IndexedDB) — resolved here into an address that can be fed directly into CSS url(); non-token
    // values like data: / http(s) pass through unchanged at render time.
    // The hook must be called before the empty-state early return below, so char is read via optional chaining.
    const resolvedChatBackground = useBlobRefUrl(char?.chatBackground);
    // Fallback: under normal conditions OSContext guarantees a character on startup, so char
    // shouldn't be empty. But if some store fails to read during init (the data is actually still in IndexedDB), characters might be temporarily empty,
    // At this point, reading a field off char below would directly throw "undefined is not an object" and crash the whole App to an error page.
    // Provide a gentle empty state here instead, to avoid a hard crash, and let the user recover by returning to the desktop / restarting.
    if (!char) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[#f1f5f9] text-center px-8 gap-3">
                <div className="text-4xl">💤</div>
                <div className="text-slate-600 text-sm font-medium">No character available right now</div>
                <div className="text-slate-400 text-xs leading-relaxed">Data may not have finished loading. Please return to the desktop and come back in; if it's still empty, restarting the app should fix it.</div>
                <button onClick={closeApp} className="mt-2 px-4 py-2 rounded-full bg-slate-800 text-white text-xs">Back to Desktop</button>
            </div>
        );
    }

    // Animal Crossing easter-egg mode (controlled by the "Chat Tie-In" toggle: turning it off keeps the chat in its original style)
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const chatRootClass =
        chatChromeStyle === 'pixel'
            ? 'flex flex-col h-full bg-[#efe1cf] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'flat'
              ? 'flex flex-col h-full bg-white overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
              : chatChromeStyle === 'floating'
                ? 'flex flex-col h-full bg-[#eef2ff] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
                : 'flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';
    // resolvedChatBackground is undefined while the token is still being read from disk, or if the
    // image was lost — this frame falls back to the "no background set" style, to avoid rendering a url("undefined").
    const chatRootStyle: React.CSSProperties = resolvedChatBackground
        ? {
            backgroundImage: `url("${resolvedChatBackground}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        }
        : chatBackgroundStyle === 'grid'
          ? {
              backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
              backgroundImage:
                  'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }
          : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
              }
            : chatBackgroundStyle === 'mesh'
              ? {
                  backgroundColor: '#f8fafc',
                  backgroundImage:
                      'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
              : {
                  backgroundImage: 'none',
                };
    // Animal Crossing easter egg: light cream-yellow center (the green bars top/bottom are handled by header/input bar), color scheme referenced from Pocket Camp.
    const acnhRootClass = 'flex flex-col h-full overflow-hidden relative font-sans transition-[background-color] duration-500';
    const acnhRootStyle: React.CSSProperties = {
        backgroundColor: '#F6F0D8',
        backgroundImage: 'none',
    };
    const finalRootClass = acnh ? acnhRootClass : chatRootClass;
    // Force-overrides the character's custom chat background under Animal Crossing, to guarantee a consistent easter-egg look across the whole device
    // The entry/switch transition is handled by the CharacterEntryTransition overlay; the root container no longer fades in on its own.
    const finalRootStyle = acnh ? acnhRootStyle : chatRootStyle;
    // Chat fine-tuning (Appearance → Chat Details, global base layer; overridden field-by-field when
    // a character has "Chat Styling" turned on): when the CSS is all default it's an empty string and
    // not injected; chatModuleAlign doesn't go through CSS, it's passed to MessageItem as a layout prop.
    const mergedFineTune = useMemo(() => mergeChatFineTune(osTheme, char?.chatFineTune), [osTheme, char?.chatFineTune]);
    const chatFineTuneCss = useMemo(() => buildChatFineTuneCss(mergedFineTune), [mergedFineTune]);
    const chatAvatarSizeClass = osTheme.chatAvatarSize === 'small' ? 'w-7 h-7' : osTheme.chatAvatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const chatAvatarRadiusClass = osTheme.chatAvatarShape === 'square' ? 'rounded-sm' : osTheme.chatAvatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const chatPendingAvatarClass = `${chatAvatarSizeClass} ${chatAvatarRadiusClass} object-cover`;

    return (
        <div
            className={`sully-chat-root ${finalRootClass}`}
            style={finalRootStyle}
        >
             {/* Chat fine-tuning (generated from the Appearance app's visual settings): placed before
                 the user's custom CSS — when both use !important, the one written later wins, so hand-written styling code can always override the visual settings. */}
             {chatFineTuneCss && <style>{chatFineTuneCss}</style>}
             {/* Whitebox custom CSS: the global default comes first, character-specific comes after (the latter overrides on top). Applies to each .sully-chat-* part.
                 The guard style is placed uniformly after the bubble theme's customCss (see below), guaranteeing it as a fallback against all user CSS. */}
             {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
             {char.chromeCustomCss && <style>{char.chromeCustomCss}</style>}
             {scheduleChangeNotice && (
               <ScheduleChangeNotice
                 key={scheduleChangeNotice.eventId}
                 detail={scheduleChangeNotice}
                 onDone={dismissScheduleChangeNotice}
               />
             )}
             {/* Character "entry" transition: on switch/enter, lays down an ambiance built from their avatar first, then pushes through into the chat. Replays whenever the key changes. */}
             {showEntry && char && (
               <CharacterEntryTransition
                 key={activeCharacterId}
                 name={char.name}
                 avatar={char.avatar}
                 onDone={() => setShowEntry(false)}
               />
             )}

             {activeTheme.customCss && <style>{activeTheme.customCss}</style>}
             {/* Bubble Workshop's tail-frequency logic depends on a stable class attached directly to
                 the bubble. Even if user CSS puts !important on ::before/::after, mid-group bubbles
                 will still tuck their tail away according to the "group-end only / hidden" setting. */}
             <style>{`
               .sully-bubble-tail-hidden::before,
               .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
             `}</style>

             {/* Psyche card custom CSS (per-character): applies to each .sully-psyche-* part, editable from the Psyche settings modal */}
             {(char as any).thinkingChainCustomCss && <style>{(char as any).thinkingChainCustomCss}</style>}

             {/* Guard style (injected after all user CSS — Whitebox global/character, bubble theme
                 customCss, Psyche card CSS): guarantees the back button and input bar are always
                 visible and clickable. When bad CSS (often imported via a backup/share) hides them,
                 makes them transparent, or sets pointer-events:none, the user hits "tapping the input
                 does nothing, keyboard won't come up" or can't exit chat — and neither restarting nor
                 re-importing the backup fixes it. With this fallback in place, they can at least back
                 out to Appearance → Chat Screen → Reset Whitebox to clear the bad CSS.
                 Doesn't lock position or colors, so normal styling is unaffected. */}
             {(osTheme.chatChromeCustomCss || char.chromeCustomCss || activeTheme.customCss || (char as any).thinkingChainCustomCss) && (
               <style>{`
                 .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
               `}</style>
             )}

             {/* Animal Crossing easter egg: scoped CSS overrides bubbles — cream AI bubble + peach user bubble, warm-brown text, bypassing MessageItem's complex logic */}
             {acnh && <style>{`
                .sully-bubble-ai {
                    background: #FBF4DE !important;
                    color: #6b5a3e !important;
                    border: 1.5px solid #efe6c8 !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(120,95,45,0.28) !important;
                }
                .sully-bubble-user {
                    background: #F5C896 !important;
                    color: #6b4a2f !important;
                    border: 1.5px solid #eeb87f !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(150,100,55,0.32) !important;
                }
                /* Animal Crossing only: bump up the chat body text size a bit */
                .sully-bubble-ai .text-\\[15px\\], .sully-bubble-user .text-\\[15px\\] {
                    font-size: 16.5px !important;
                    line-height: 1.7 !important;
                }
             `}</style>}

             {/* Organizing memory — floating capsule at the top (non-blocking, lightweight, no backdrop-filter) */}
             {memoryPalaceStatus && (
                 <div
                     className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                     style={{
                         transform: 'translateX(-50%)',
                         pointerEvents: 'none',
                         willChange: 'transform, opacity',
                     }}
                 >
                     <div
                         className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[18rem]"
                         style={{
                             background: 'rgba(255,255,255,0.88)',
                             borderRadius: 999,
                             border: '1px solid rgba(99,102,241,0.18)',
                             boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                         }}
                     >
                         <span
                             className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                             style={{ borderTopColor: '#6366f1', animationDuration: '0.9s' }}
                         />
                         <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                             {char?.name || 'The character'} is deep in thought
                         </span>
                         <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                     </div>
                 </div>
             )}


             {/* Memory organization result — modal (premium feel) */}
             {memoryPalaceResult && (
                 <div
                     className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                     style={{
                         pointerEvents: 'all',
                         background: 'rgba(15,23,42,0.55)',
                     }}
                     onClick={() => setMemoryPalaceResult(null)}
                 >
                     <div
                         className="w-full max-w-sm max-h-[82vh] overflow-hidden flex flex-col relative"
                         style={{
                             background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                             borderRadius: 28,
                             border: '1px solid rgba(148,163,184,0.18)',
                             boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                         }}
                         onClick={(e) => e.stopPropagation()}
                     >
                         <div
                             className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
                             style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)' }}
                         />
                         <div className="px-6 pt-7 pb-4 text-center">
                             <div
                                 className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                 style={{
                                     background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(129,140,248,0.06))',
                                     border: '1px solid rgba(99,102,241,0.15)',
                                 }}
                             >
                                 <span style={{ fontSize: 26 }}>🗂️</span>
                             </div>
                             <div className="text-[10px] tracking-[0.25em] uppercase font-semibold" style={{ color: '#6366f1' }}>Memory Palace</div>
                             <p className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>Memory Organization Complete</p>
                             <p className="text-[11px] text-slate-400 mt-1">
                                 {memoryPalaceResult.stored} added · {memoryPalaceResult.skipped} skipped as duplicates
                                 {memoryPalaceResult.batches.length > 1 && ` · ${memoryPalaceResult.batches.length} batches`}
                             </p>
                             {memoryPalaceResult.batches.some(b => !b.ok) && (
                                 <p className="text-[10px] text-red-500 mt-1">
                                     {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `batch ${b.index} failed`).join(', ')}
                                 </p>
                             )}
                         </div>
                         <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2 no-scrollbar">
                             {memoryPalaceResult.memories.map((m, i) => {
                                 // NOTE: getRoomLabel() below still returns Chinese text — its source,
                                 // utils/memoryPalace/types.ts's ROOM_LABELS, hasn't been translated
                                 // yet (out of scope for this batch, flagged as a producer gap). This
                                 // local fallback dict (only used if getRoomLabel returns falsy) is
                                 // translated to the established English room names for consistency.
                                 const roomMeta: Record<string, { label: string; color: string }> = {
                                     living_room: { label: 'Living Room', color: '#f59e0b' },
                                     bedroom: { label: 'Bedroom', color: '#8b5cf6' },
                                     study: { label: 'Study', color: '#0ea5e9' },
                                     user_room: { label: 'User Room', color: '#ec4899' },
                                     self_room: { label: 'Self Room', color: '#10b981' },
                                     attic: { label: 'Attic', color: '#6366f1' },
                                     windowsill: { label: 'Windowsill', color: '#14b8a6' },
                                 };
                                 const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                 const roomLabel = getRoomLabel(m.room as any, userProfile?.name) || meta.label;
                                 return (
                                     <div
                                         key={i}
                                         className="p-3 rounded-2xl"
                                         style={{
                                             background: 'rgba(255,255,255,0.75)',
                                             border: `1px solid ${meta.color}22`,
                                             boxShadow: `0 2px 8px ${meta.color}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                         }}
                                     >
                                         <div className="flex items-center gap-2 mb-1.5">
                                             <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                                                 style={{ background: `${meta.color}18`, color: meta.color }}
                                             >
                                                 {roomLabel}
                                             </span>
                                             <span className="text-[10px] text-slate-400">{m.mood}</span>
                                             <span className="text-[10px] font-bold ml-auto" style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                         </div>
                                         <p className="text-[12px] text-slate-700 leading-relaxed">{m.content}</p>
                                         {m.tags.length > 0 && (
                                             <div className="flex gap-1 mt-2 flex-wrap">
                                                 {m.tags.map((t, j) => (
                                                     <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full"
                                                         style={{ background: 'rgba(148,163,184,0.15)', color: '#64748b' }}
                                                     >{t}</span>
                                                 ))}
                                             </div>
                                         )}
                                     </div>
                                 );
                             })}
                             {memoryPalaceResult.memories.length === 0 && (
                                 <p className="text-center text-xs text-slate-400 py-4">No new memories were extracted this time</p>
                             )}
                         </div>
                         <div className="px-6 pb-6 pt-2">
                             <button
                                 onClick={() => setMemoryPalaceResult(null)}
                                 className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                 style={{
                                     background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                     boxShadow: '0 6px 18px -6px rgba(79,70,229,0.5)',
                                 }}
                             >
                                 Confirm
                             </button>
                         </div>
                     </div>
                 </div>
             )}

             <ChatModals
                modalType={modalType} setModalType={setModalType}
                transferAmt={transferAmt} setTransferAmt={setTransferAmt}
                transferNote={transferNote} setTransferNote={setTransferNote}
                emojiImportText={emojiImportText} setEmojiImportText={setEmojiImportText}
                settingsContextLimit={settingsContextLimit} setSettingsContextLimit={setSettingsContextLimit}
                settingsContextRangeMode={settingsContextRangeMode} setSettingsContextRangeMode={setSettingsContextRangeMode}
                settingsHideSysLogs={settingsHideSysLogs} setSettingsHideSysLogs={setSettingsHideSysLogs}
                contextSuiteAnyEnabled={contextSuiteAnyEnabled}
                contextSuiteAllEnabled={contextSuiteAllEnabled}
                onToggleContextSuite={handleToggleContextSuite}
                preserveContext={preserveContext} setPreserveContext={setPreserveContext}
                editContent={editContent} setEditContent={setEditContent}
                archivePrompts={archivePrompts} selectedPromptId={selectedPromptId} setSelectedPromptId={(id: string) => {
                    setSelectedPromptId(id);
                    // Also writes to localStorage in sync, so the palace extraction's style append can read the latest selection
                    try { localStorage.setItem('chat_active_archive_prompt_id', id); } catch {}
                }}
                editingPrompt={editingPrompt} setEditingPrompt={setEditingPrompt} isSummarizing={isSummarizing} archiveProgress={archiveProgress}
                selectedMessage={selectedMessage} selectedEmoji={selectedEmoji} activeCharacter={char} messages={messages}
                allHistoryMessages={allHistoryMessages}
                contextRangeSnapshot={historyContextRange}
                
                newCategoryName={newCategoryName} setNewCategoryName={setNewCategoryName} onAddCategory={handleAddCategory}
                newEmojiName={newEmojiName} setNewEmojiName={setNewEmojiName} onRenameEmoji={handleRenameEmoji}
                selectedCategory={selectedCategory}

                onTransfer={() => { if(transferAmt) handleSendText(`[Transfer]`, 'transfer', { amount: transferAmt, note: transferNote.trim() || undefined, status: 'pending' }); setTransferNote(''); setModalType('none'); }}
                onImportEmoji={handleImportEmoji}
                onSaveSettings={saveSettings} onBgUpload={handleBgUpload} onRemoveBg={() => updateCharacter(char.id, { chatBackground: undefined })}
                onClearHistory={handleClearHistory} onArchive={handleFullArchive}
                onCreatePrompt={createNewPrompt} onEditPrompt={editSelectedPrompt} onSavePrompt={handleSavePrompt} onDeletePrompt={handleDeletePrompt}
                onSetHistoryStart={handleSetHistoryStart} onRestoreAdaptiveContext={restoreAdaptiveContext} onJumpToMessageInChat={handleJumpToMessageInChat} onEnterSelectionMode={handleEnterSelectionMode}
                onReplyMessage={handleReplyMessage} onEditMessageStart={() => { if (selectedMessage) { setEditContent(selectedMessage.content); setModalType('edit-message'); } }}
                onConfirmEditMessage={confirmEditMessage} onDeleteMessage={handleDeleteMessage} onCopyMessage={handleCopyMessage}
                messageFavorited={!!(selectedMessage && contentFavoriteIds.has(contentFavoriteIdForMessage(selectedMessage)))}
                onToggleMessageFavorite={selectedMessage ? () => handleToggleContentFavorite(selectedMessage) : undefined}
                onDeleteEmoji={handleDeleteEmoji} onDeleteCategory={handleDeleteCategory}
                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility}
                translationEnabled={translationEnabled}
                onToggleTranslation={() => { const next = !translationEnabled; setTranslationEnabled(next); localStorage.setItem(`chat_translate_enabled_${activeCharacterId}`, JSON.stringify(next)); if (next) { trackEvent('Enable Chat Translation', { targetLang: isTranslationLangPreset(translateTargetLang) ? translateTargetLang : 'custom' }); } if (!next) { setShowingTargetIds(new Set()); } }}
                translateSourceLang={translateSourceLang}
                translateTargetLang={translateTargetLang}
                translationExpanded={translationExpanded}
                onToggleTranslationExpanded={() => {
                    const next = !translationExpanded;
                    setTranslationExpanded(next);
                    localStorage.setItem(`chat_translate_expanded_${activeCharacterId}`, JSON.stringify(next));
                    setShowingTargetIds(new Set());
                    trackEvent('Toggle Translation Expand Mode', { enabled: next ? 'on' : 'off' });
                }}
                onSetTranslateSourceLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateSourceLang(next); localStorage.setItem(`chat_translate_source_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                onSetTranslateLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateTargetLang(next); localStorage.setItem(`chat_translate_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                xhsEnabled={!!char.xhsEnabled}
                onToggleXhs={() => updateCharacter(char.id, { xhsEnabled: !char.xhsEnabled })}
                htmlModeEnabled={!!(char as any).htmlModeEnabled}
                onToggleHtmlMode={() => updateCharacter(char.id, { htmlModeEnabled: !((char as any).htmlModeEnabled) } as any)}
                htmlModeCustomPrompt={settingsHtmlModeCustomPrompt}
                setHtmlModeCustomPrompt={setSettingsHtmlModeCustomPrompt}
                chatVoiceEnabled={!!char.chatVoiceEnabled}
                onToggleChatVoice={() => updateCharacter(char.id, { chatVoiceEnabled: !char.chatVoiceEnabled })}
                chatVoiceAutoPlay={!!char.chatVoiceAutoPlay}
                onToggleChatVoiceAutoPlay={() => updateCharacter(char.id, { chatVoiceAutoPlay: !char.chatVoiceAutoPlay })}
                chatVoiceLang={char.chatVoiceLang || ''}
                onSetChatVoiceLang={(lang: string) => {
                    updateCharacter(char.id, { chatVoiceLang: lang });
                    trackEvent('Set Chat Voice Language', { Language: voiceLanguageAnalyticsValue(lang) });
                }}
                voiceAvailable={characterHasVoice(char, apiConfig)}
                onGenerateVoice={selectedMessage ? () => handleManualTts(selectedMessage) : undefined}
                voiceDownloadable={!!(selectedMessage?.id && voiceDataMap[selectedMessage.id])}
                voiceCollectable={!!(selectedMessage?.id && (voiceDataMap[selectedMessage.id] || parseVoiceOutput(selectedMessage.content || '').hasVoiceTag))}
                onDownloadVoice={selectedMessage ? () => handleDownloadVoice(selectedMessage) : undefined}
                voiceFavorited={!!(selectedMessage?.id && chatFavoriteKeys.has(chatFavoriteSourceKey(selectedMessage)))}
                onToggleVoiceFavorite={selectedMessage ? () => handleToggleVoiceFavorite(selectedMessage) : undefined}
                scheduleData={scheduleData}
                isScheduleGenerating={isScheduleGenerating}
                onScheduleEdit={handleScheduleEdit}
                onScheduleDelete={handleScheduleDelete}
                onScheduleReroll={() => generateDailySchedule(char, true)}
                onScheduleCoverChange={handleScheduleCoverChange}
                onScheduleStyleChange={handleScheduleStyleChange}
                onPlayTheater={handlePlayTheater}
                isScheduleFeatureEnabled={isScheduleFeatureOn(char)}
                onToggleScheduleFeature={handleToggleScheduleFeature}
                isMemoryPalaceEnabled={!!char.memoryPalaceEnabled}
                isVectorizing={isVectorizing}
                vectorizePendingCount={vectorizePendingCount}
                vectorizeProgress={vectorizeProgress}
                retainRecentForVectorize={retainRecentForVectorize}
                setRetainRecentForVectorize={setRetainRecentForVectorize}
                vectorizeResult={vectorizeResult}
                onForceVectorize={handleForceVectorize}
                apiPresets={apiPresets}
                onAddApiPreset={addApiPreset}
                onSaveEmotion={(config) => {
                    // API syncs to all characters; enabled is only written to the current character
                    syncEmotionApiToAllCharacters(config.api);
                    updateCharacter(char.id, {
                        emotionConfig: {
                            enabled: config.enabled,
                            ...(config.api && config.api.baseUrl ? { api: config.api } : {}),
                        },
                    });
                }}
                onClearBuffs={() => {
                    updateCharacter(char.id, { activeBuffs: [], buffInjection: '' });
                    addToast('Emotion state cleared', 'info');
                }}
             />

             {/* Theater player: peek at the character's behavior performance for a given schedule time slot */}
             {theaterSlotIdx !== null && scheduleData && createPortal(
                <TheaterPlayer
                    character={char}
                    slot={scheduleData.slots[theaterSlotIdx] || null}
                    lines={scheduleData.slots[theaterSlotIdx]?.theater?.lines || null}
                    isGenerating={isTheaterGenerating}
                    onReplay={() => runTheater(theaterSlotIdx, true)}
                    onSendCard={(exposed) => handleSendTheaterCard(theaterSlotIdx, exposed)}
                    onClose={() => setTheaterSlotIdx(null)}
                />,
                document.body,
             )}

             <ChatHeader
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); setSelectedThinkingMsgIds(new Set()); }}
                activeCharacter={char}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isEmotionEvaluating={emotionStatus === 'evaluating'}
                isInstantSending={instantSendingActive}
                isMemoryPalaceProcessing={!!memoryPalaceStatus}
                memoryPalaceStatusText={memoryPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                onClose={closeApp}
                onTriggerAI={handleManualTrigger}
                onShowCharsPanel={() => setShowPanel('chars')}
                onDeleteBuff={(buffId) => {
                    const currentBuffs = char.activeBuffs || [];
                    const newBuffs = currentBuffs.filter(b => b.id !== buffId);
                    const newInjection = '';
                    updateCharacter(char.id, { activeBuffs: newBuffs, buffInjection: newInjection });
                    addToast('Emotion state deleted', 'info');
                }}
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                hideBuffs={osTheme.chatHideHeaderBuffs}
                acnh={acnh}
             />

            {/* Cognitive digestion result modal — full-screen glassmorphism */}
            {lastDigestResult && (() => {
                const r = lastDigestResult;
                const groups: Array<{
                    key: string;
                    label: string;
                    icon: string;
                    accent: string;       // base hue for chip/dot
                    items: Array<{ content: string; sub?: string }>;
                }> = [];
                if (r.resolved.length) groups.push({ key: 'resolved', label: 'Confusion Resolved', icon: '🕊️', accent: '#10b981', items: r.resolved.map(e => ({ content: e.content })) });
                if (r.deepened.length) groups.push({ key: 'deepened', label: 'Trauma Deepened', icon: '💢', accent: '#f43f5e', items: r.deepened.map(e => ({ content: e.content })) });
                if (r.internalized.length) groups.push({ key: 'internalized', label: 'Knowledge Internalized', icon: '🪞', accent: '#8b5cf6', items: r.internalized.map(e => ({ content: e.content })) });
                if (r.selfInsights.length) groups.push({ key: 'insights', label: 'Self-Insight', icon: '💡', accent: '#f59e0b', items: r.selfInsights.map(t => ({ content: t })) });
                if (r.selfConfused.length) groups.push({ key: 'confused', label: 'New Self-Confusion', icon: '🌀', accent: '#6366f1', items: r.selfConfused.map(e => ({ content: e.content })) });
                if (r.synthesizedUser.length) groups.push({ key: 'synth', label: 'User Understanding Synthesized', icon: '👤', accent: '#0ea5e9', items: r.synthesizedUser.map(e => ({ content: e.content, sub: e.category })) });
                if (r.worries?.length) groups.push({ key: 'worries', label: 'Worries from Looking Back', icon: '😟', accent: '#f97316', items: r.worries.map(e => ({ content: e.content })) });
                if (r.aspirations?.length) groups.push({ key: 'aspirations', label: 'New Anticipation', icon: '🌟', accent: '#eab308', items: r.aspirations.map(e => ({ content: e.content })) });
                if (r.distilled?.length) groups.push({ key: 'distilled', label: 'Settled into a Room Plate', icon: '🚪', accent: '#a855f7', items: r.distilled.map(e => ({ content: e.content })) });
                if (r.fulfilled.length) groups.push({ key: 'fulfilled', label: 'Anticipation Fulfilled', icon: '✨', accent: '#22c55e', items: r.fulfilled.map(e => ({ content: e.content })) });
                if (r.disappointed.length) groups.push({ key: 'disappointed', label: 'Anticipation Unmet', icon: '🍂', accent: '#94a3b8', items: r.disappointed.map(e => ({ content: e.content })) });
                if (r.faded.length) groups.push({ key: 'faded', label: 'Faded', icon: '🌫️', accent: '#cbd5e1', items: r.faded.map(e => ({ content: e.content })) });
                if (groups.length === 0) return null;
                return (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(16,185,129,0.18), rgba(0,0,0,0.55))',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                        }}
                        onClick={() => setLastDigestResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[85vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, rgba(255,255,255,0.98) 0%, rgba(240,253,250,0.96) 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(255,255,255,0.7)',
                                boxShadow: '0 30px 80px -20px rgba(16,185,129,0.35), 0 10px 40px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Top glow bar */}
                            <div
                                className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #10b981, #6ee7b7, #10b981, transparent)' }}
                            />
                            {/* Header */}
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.08))',
                                        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.9), 0 4px 16px rgba(16,185,129,0.2)',
                                    }}
                                >
                                    <span style={{ fontSize: 28 }}>🧠</span>
                                </div>
                                <div className="text-[11px] tracking-[0.2em] uppercase font-semibold" style={{ color: '#059669' }}>Cognitive Digest</div>
                                <div className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>{char.name} completed a round of cognitive digestion</div>
                                <div className="text-[11px] text-slate-400 mt-1">Inner sorting · {groups.reduce((s, g) => s + g.items.length, 0)} changes</div>
                            </div>

                            {/* Content list */}
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3 no-scrollbar">
                                {groups.map(g => (
                                    <div key={g.key}
                                        className="rounded-2xl overflow-hidden"
                                        style={{
                                            background: 'rgba(255,255,255,0.7)',
                                            border: `1px solid ${g.accent}22`,
                                            boxShadow: `0 2px 8px ${g.accent}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                        }}
                                    >
                                        <div className="px-4 py-2.5 flex items-center gap-2"
                                            style={{ background: `linear-gradient(90deg, ${g.accent}18, transparent)` }}
                                        >
                                            <span style={{ fontSize: 14 }}>{g.icon}</span>
                                            <span className="text-[12px] font-bold" style={{ color: g.accent }}>{g.label}</span>
                                            <span className="text-[10px] font-bold ml-auto px-1.5 py-0.5 rounded-full"
                                                style={{ background: `${g.accent}22`, color: g.accent }}
                                            >{g.items.length}</span>
                                        </div>
                                        <div className="px-4 py-2 space-y-1.5">
                                            {g.items.slice(0, 3).map((it, i) => (
                                                <div key={i} className="text-[12px] leading-relaxed text-slate-700 flex gap-2">
                                                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: g.accent }} />
                                                    <span className="flex-1">
                                                        {it.sub && <span className="text-[10px] font-semibold mr-1.5 px-1.5 py-0.5 rounded" style={{ background: `${g.accent}18`, color: g.accent }}>{it.sub}</span>}
                                                        <span>{it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content}</span>
                                                    </span>
                                                </div>
                                            ))}
                                            {g.items.length > 3 && (
                                                <div className="text-[10px] text-slate-400 pl-3">{g.items.length - 3} more…</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Confirm button */}
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setLastDigestResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #10b981, #059669)',
                                        boxShadow: '0 8px 24px -4px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
                                    }}
                                >
                                    Taken to heart
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            <div ref={scrollRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" style={{ backgroundImage: activeTheme.type === 'custom' && activeTheme.user.backgroundImage ? 'none' : undefined }}>
                {windowedFocusMsgId !== null && (
                    <div className="sticky top-0 z-20 flex justify-center pb-2 pointer-events-none">
                        <button onClick={handleBackToCurrent} className="pointer-events-auto px-4 py-2 bg-primary text-white rounded-full text-xs font-bold shadow-lg active:scale-95 transition-transform flex items-center gap-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
                            Back to Current Chat
                        </button>
                    </div>
                )}
                {collapsedCount > 0 && windowedFocusMsgId === null && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + LOAD_BATCH_SIZE;
                            visibleCountRef.current = nextVisibleCount;
                            setVisibleCount(nextVisibleCount);
                            await reloadMessages(nextVisibleCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">Load Earlier Messages ({collapsedCount})</button>
                    </div>
                )}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mb-4 px-4">
                        {hasOlderHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('older')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                Swipe up for earlier messages
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">Reached the earliest message</span>
                        )}
                    </div>
                )}

                {displayMessages.map((m, i) => {
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const breaksWithPrevious =
                        !prevMessage ||
                        prevMessage.role !== m.role ||
                        Math.abs(m.timestamp - prevMessage.timestamp) > messageGroupGapMs;
                    const breaksWithNext =
                        !nextMessage ||
                        nextMessage.role !== m.role ||
                        Math.abs(nextMessage.timestamp - m.timestamp) > messageGroupGapMs;
                    const suppressEntranceAnimation = streamPreviewHandoverIdsRef.current.has(m.id);
                    // Which tools ran in the cloud for this round (only exists for Instant Chat, the
                    // worker attaches it to the last push). Every bubble split out from one push
                    // inherits the same copy (metadata is spread over the whole thing, see
                    // activeMsgRuntime's mcdInheritMeta), so it's only drawn under the last bubble of
                    // that push, otherwise a single reply would show three identical lines underneath it.
                    // Not drawn in multi-select state: same as the two overlays next to it, making way for the selection checkbox.
                    const toolTraceText = selectionMode
                        ? '' : formatAmsgToolTrace((m.metadata as any)?.amsgToolTrace);
                    const pushMessageId = (m.metadata as any)?.activeMsg2?.messageId;
                    const showToolTrace = !!toolTraceText
                        && !(pushMessageId && (nextMessage?.metadata as any)?.activeMsg2?.messageId === pushMessageId);
                    return (
                        <div
                            key={m.id || i}
                            id={`chat-msg-${m.id}`}
                            className={[
                                flashMsgId === m.id ? 'ring-2 ring-yellow-300 bg-yellow-50/40 rounded-2xl mx-2' : '',
                                animatingIds.has(m.id) && !suppressEntranceAnimation ? 'animate-fade-in' : '',
                                'transition-all duration-300',
                            ].filter(Boolean).join(' ')}
                            onAnimationEnd={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (animatingIds.has(m.id)) setAnimatingIds(prev => { const next = new Set(prev); next.delete(m.id); return next; });
                            }}
                        >
                        <MessageItem
                            msg={m}
                            isFirstInGroup={breaksWithPrevious}
                            isLastInGroup={breaksWithNext}
                            activeTheme={activeTheme}
                            charAvatar={char.avatar}
                            charName={char.name}
                            userAvatar={userProfile.perCharAvatars?.[char.id] || userProfile.avatar}
                            isLatestMessage={!nextMessage}
                            onMediaLoad={handleMessageMediaLoad}
                            moduleAlign={mergedFineTune.chatModuleAlign || 'center'}
                            onLongPress={handleMessageLongPress}
                            onReply={handleQuickReply}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            isThinkingSelected={selectedThinkingMsgIds.has(m.id)}
                            onToggleThinkingSelect={toggleThinkingSelection}
                            translationEnabled={translationEnabled && m.type === 'text' && m.role === 'assistant'}
                            translationExpanded={translationExpanded}
                            isShowingTarget={showingTargetIds.has(m.id)}
                            onTranslateToggle={handleTranslateToggle}
                            voiceData={voiceDataMap[m.id]}
                            voiceLoading={voiceLoading.has(m.id)}
                            isVoicePlaying={playingMsgId === m.id}
                            onPlayVoice={onPlayVoiceStable}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                            suppressEntranceAnimation={suppressEntranceAnimation}
                            isPending={false}
                            pendingIndicator={osTheme.chatPendingIndicator !== false}
                            onMcdSendCart={handleMcdSendCart}
                            onMcdCandidate={handleMcdCandidate}
                            onResolveTransfer={handleResolveTransfer}
                            onResolveLifeRecord={handleResolveLifeRecord}
                            onOpenCollaborationFile={handleOpenCollaborationFile}
                            thinkingChainOptions={thinkingChainOptions}
                        />
                        {showToolTrace && (
                            <div className={`px-3 mb-4 ${breaksWithNext ? toolTracePullClass : ''}`}>
                                <div className="ml-12 text-[10px] leading-relaxed text-slate-400">
                                    Called tools: {toolTraceText}
                                </div>
                            </div>
                        )}
                        </div>
                    );
                })}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mt-2 mb-4 px-4">
                        {hasNewerHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('newer')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                Swipe down for newer messages
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">Reached the current newest message</span>
                        )}
                    </div>
                )}

                {/* Pure-frontend "preparing to send" three dots: doesn't go through MessageItem (that
                    per-message path doesn't actually render it), attached directly at the end of the
                    message list, right-aligned (user side). Lights up/off together with the header's
                    "sending" state, sharing the same instantSendingActive source. The original polished
                    look = small size (w-1) + a gentle pulse. But the original used a custom Tailwind
                    class animate-dot-pulse that the CDN never generated (disappears whenever it
                    switches), and the original color slate-400/70 was too faint to see. Solution: write
                    an inline @keyframes by hand (no CDN dependency) to recreate the pulse, using a
                    solid slate-400 (full opacity at the peak) to guarantee visibility, back to the
                    original size w-1. */}
                {instantSendingActive && !selectionMode && (
                    <div className="flex justify-end px-3 -mt-1 -mb-4">
                        <style>{`@keyframes chatPendingDot{0%,80%,100%{opacity:.35;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>
                        <span className="inline-flex items-center gap-[3px] mr-12 select-none pointer-events-none" role="status" aria-label="Preparing to send">
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite' }} />
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
                        </span>
                    </div>
                )}

                {instantToolStatus && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-4 animate-fade-in">
                        <TokenImg value={char.avatar} className={chatPendingAvatarClass} />
                        <div className={`max-w-[78%] px-4 py-3 rounded-2xl shadow-sm border ${
                            instantToolStatus.phase === 'failed'
                                ? 'bg-rose-50 border-rose-100 text-rose-700'
                                : 'bg-white/95 border-white/70 text-slate-600'
                        }`}>
                            <div className="flex items-center gap-2 text-xs font-semibold leading-relaxed">
                                {instantToolStatus.phase === 'failed' ? (
                                    <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
                                ) : instantToolStatus.phase === 'done' ? (
                                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                                ) : (
                                    <svg className="animate-spin h-3 w-3 shrink-0 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                )}
                                <span>{instantToolStatus.text}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* When the channel actually sends reasoning deltas, show them live with the real Psyche card first; once saved, hand off to the real message in the same frame. */}
                {streamingThinking && !selectionMode && (
                    <div className="group flex items-end justify-start relative px-3 mb-1.5 animate-fade-in">
                        <div className="relative max-w-[72%] min-w-0 ml-12">
                            <ThinkingChainBlock
                                chain={streamingThinking}
                                styleId={thinkingChainOptions.styleId}
                                customColors={thinkingChainOptions.customColors}
                                onOpenSettings={thinkingChainOptions.onOpenSettings}
                            />
                        </div>
                    </div>
                )}

                {/* The streaming preview directly reuses the real MessageItem: bubble variant, theme
                    background image/decoration, avatar frame, grouped/every_message, message spacing,
                    timestamp, Markdown, and all custom CSS are naturally consistent.
                    On save, useChatAI registers the handover id, so the real message's first frame doesn't replay the fade-in. */}
                {streamingBubbles.length > 0 && !selectionMode && (
                    <>
                        {streamingBubbles.map((bubble, i) => (
                            <div key={`stream-preview-${i}`} className="transition-all duration-300">
                                <MessageItem
                                    msg={{
                                        id: -(i + 1),
                                        charId: char.id,
                                        role: 'assistant',
                                        type: 'text',
                                        content: bubble,
                                        timestamp: Date.now(),
                                    }}
                                    isFirstInGroup={i === 0}
                                    isLastInGroup={i === streamingBubbles.length - 1}
                                    activeTheme={activeTheme}
                                    charAvatar={char.avatar}
                                    charName={char.name}
                                    userAvatar={userProfile.perCharAvatars?.[char.id] || userProfile.avatar}
                                    onLongPress={() => {}}
                                    onReply={() => {}}
                                    selectionMode={false}
                                    isSelected={false}
                                    onToggleSelect={() => {}}
                                    avatarShape={osTheme.chatAvatarShape}
                                    avatarSize={osTheme.chatAvatarSize}
                                    avatarMode={osTheme.chatAvatarMode}
                                    bubbleVariant={osTheme.chatBubbleStyle}
                                    messageSpacing={osTheme.chatMessageSpacing}
                                    showTimestamp={osTheme.chatShowTimestamp}
                                    thinkingChainOptions={thinkingChainOptions}
                                />
                            </div>
                        ))}
                    </>
                )}
                {/* instantChatPending: this round is running in the cloud, this device can have its page closed, and the indicator stays alive via the saved-to-disk record. */}
                {(isTyping || instantChatPending || recallStatus || searchStatus || diaryStatus || isProactiveComposing) && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-6 animate-fade-in">
                        <TokenImg value={char.avatar} className={chatPendingAvatarClass} />
                        <div className="bg-white px-4 py-3 rounded-2xl shadow-sm">
                            {isProactiveComposing && !isTyping && !recallStatus && !searchStatus && !diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-teal-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {char.name} is writing you a message…
                                </div>
                            ) : searchStatus ? (
                                <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    🔍 {searchStatus}
                                </div>
                            ) : recallStatus ? (
                                <div className="flex items-center gap-2 text-xs text-indigo-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {recallStatus}
                                </div>
                            ) : diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    📖 {diaryStatus}
                                </div>
                            ) : (
                                <div className="flex gap-1"><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-75"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-150"></div></div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="relative z-40">
                {mcdActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-yellow-50 border-b border-yellow-200 text-xs">
                        <div className="flex items-center gap-1.5 text-yellow-700 font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"/>
                            🍔 McDonald's Request in progress
                        </div>
                        <button
                          onClick={() => handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true })}
                          className="px-2.5 py-0.5 bg-yellow-200/80 text-yellow-800 rounded-full text-[11px] font-bold active:scale-95"
                        >
                          End
                        </button>
                    </div>
                )}
                {luckinActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-[#0B1F3A]/5 border-b border-[#0B1F3A]/15 text-xs">
                        <div className="flex items-center gap-1.5 text-[#0B1F3A] font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#C6A15B] animate-pulse"/>
                            🦌 Grab a Luckin in progress
                            {luckinChatRef.current?.cityName && <span className="font-normal text-[#0B1F3A]/60">· {luckinChatRef.current.cityName}</span>}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => setShowLuckinHelp(true)}
                              title="How to use Grab a Luckin"
                              className="w-5 h-5 flex items-center justify-center bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              ?
                            </button>
                            <button
                              onClick={() => setShowLuckinLoc(true)}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              📍 Change Location
                            </button>
                            <button
                              onClick={deactivateLuckin}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              End
                            </button>
                        </div>
                    </div>
                )}
                {replyTarget && (
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                        {/* When quoting an image / emoji, a placeholder is shown here, matching the saved snapshot */}
                        <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">Replying to:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                        <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                    </div>
                )}

                {/* When the toggle says "enabled" but this round is generating locally anyway, tell the user why */}
                <InstantChatRouteNotice charId={activeCharacterId} />

                <ChatInputArea
                    input={input} setInput={handleInputChange}
                    isTyping={isTyping} selectionMode={selectionMode}
                    showPanel={showPanel} setShowPanel={setShowPanel}
                    onSend={handleSendCallback}
                    onDeleteSelected={handleBatchDelete}
                    onForwardSelected={handleForwardSelected}
                    selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                    emojis={filteredEmojis}
                    characters={characters} activeCharacterId={activeCharacterId}
                    onCharSelect={handleCharSelectCallback}
                    unreadMessages={unreadMessages}
                    customThemes={customThemes} onUpdateTheme={(id) => updateCharacter(char.id, { bubbleStyle: id })}
                    onRemoveTheme={removeCustomTheme} activeThemeId={currentThemeId}
                    onPanelAction={handlePanelAction}
                    onImageSelect={handleImageSelect}
                    isSummarizing={isSummarizing}
                    categories={visibleCategories}
                    activeCategory={activeCategory}
                    onReroll={handleReroll}
                    canReroll={canReroll}
                    isProactiveActive={isProactiveActive}
                    mcdConfigured={mcdConfiguredFlag}
                    mcdActivated={mcdActivated}
                    luckinConfigured={luckinConfiguredFlag}
                    luckinActivated={luckinActivated}
                    htmlModeEnabled={!!(char as any).htmlModeEnabled}
                    showThinkingChain={!!(char as any).showThinkingChain}
                    inputStyle={osTheme.chatInputStyle}
                    sendButtonStyle={osTheme.chatSendButtonStyle}
                    chromeStyle={osTheme.chatChromeStyle}
                    acnh={acnh}
                />
            </div>


            {/* Proactive Settings Modal */}
            {char && (
                <ProactiveSettingsModal
                    isOpen={showProactiveModal}
                    onClose={() => setShowProactiveModal(false)}
                    char={char}
                    isProactiveActive={isProactiveActive}
                    onSave={(config) => {
                        updateCharacter(char.id, { proactiveConfig: config });
                        if (config.enabled) {
                            startProactiveChat(config.intervalMinutes);
                            // The UI only offers 7 preset intervals, but this value is read back from
                            // persisted state — an imported backup or an old version could have
                            // written any arbitrary integer. Collapses to the hardcoded presets, everything else falls under custom.
                            trackEvent('Start Proactive Message', {
                                intervalMinutes: presetOrCustom(
                                    String(config.intervalMinutes),
                                    ['30', '60', '120', '240', '480', '720', '1440'],
                                    'Not set',
                                ),
                            });
                            addToast(`Proactive Message started, sending every ${config.intervalMinutes >= 60 ? formatHours(config.intervalMinutes) + ' hour(s)' : config.intervalMinutes + ' minute(s)'}`, 'success');
                        } else {
                            stopProactiveChat();
                            addToast('Proactive Message turned off', 'info');
                        }
                    }}
                    onStop={() => {
                        stopProactiveChat();
                        updateCharacter(char.id, { proactiveConfig: { ...char.proactiveConfig!, enabled: false } });
                        addToast('Proactive Message stopped', 'info');
                    }}
                />
            )}

            {/* Proactive Message 2.0 (cloud worker scheduled task) Settings Modal */}
            {char && (
                <ActiveMsg2SettingsModal
                    isOpen={showActiveMsg2Modal}
                    onClose={() => setShowActiveMsg2Modal(false)}
                    char={char}
                    apiConfig={apiConfig}
                    userProfile={userProfile}
                    groups={groups}
                    realtimeConfig={realtimeConfig}
                    // Updater form: the merge happens inside setCharacters' functional updater, so
                    // the prev it receives is the latest already-queued state, and won't get
                    // overwritten by the panel's render-time snapshot (this is exactly how tasks the
                    // character queued via a tool mid-chat used to get lost).
                    onSave={(updater) => updateCharacter(char.id, (prev) => ({
                        activeMsg2Config: updater(prev.activeMsg2Config),
                    }))}
                    addToast={addToast}
                />
            )}

            {/* Thinking Chain Settings Modal — entry point: long-press the "Show Thinking" button in the chat's + panel / the gear icon on the top-right of the thinking chain card */}
            {char && (
                <ThinkingChainSettingsModal
                    isOpen={showThinkingChainModal}
                    onClose={() => setShowThinkingChainModal(false)}
                    value={{
                        enabled: !!(char as any).showThinkingChain,
                        styleId: ((char as any).thinkingChainStyle as any) || 'echo',
                        customColors: {
                            bg: (char as any).thinkingChainCustomColors?.bg || '#1f2937',
                            accent: (char as any).thinkingChainCustomColors?.accent || '#fbbf24',
                            text: (char as any).thinkingChainCustomColors?.text || '#f1f5f9',
                        },
                        customPrompt: (char as any).thinkingChainCustomPrompt || '',
                        customCss: (char as any).thinkingChainCustomCss || '',
                    }}
                    onChange={(next) => {
                        const patch: any = {};
                        if (next.enabled !== undefined) patch.showThinkingChain = next.enabled;
                        if (next.styleId !== undefined) patch.thinkingChainStyle = next.styleId;
                        if (next.customColors !== undefined) patch.thinkingChainCustomColors = next.customColors;
                        if (next.customPrompt !== undefined) patch.thinkingChainCustomPrompt = next.customPrompt;
                        if (next.customCss !== undefined) patch.thinkingChainCustomCss = next.customCss;
                        if (Object.keys(patch).length) updateCharacter(char.id, patch as any);
                    }}
                />
            )}

            {/* Character-specific "Chat Styling" floating bubble + small panel — entered from the +
                panel's "Chat Styling" button. Not a full-screen modal: no overlay, the chat content
                stays visible the whole time as a live preview. Tapping the round bubble
                collapses/expands the panel (once collapsed you can see the whole chat before
                continuing to adjust), tapping "Done" makes the bubble disappear and ends tuning.
                Global settings are the base layer; once "customize for them individually" is turned
                on, only the fields you've changed override the global ones (written to char.chatFineTune). */}
            {char && fineTuneOpen && (() => {
                const override = char.chatFineTune;
                const customized = override?.enabled === true;
                // The controls display the merged effective value: fields that aren't overridden show the current global value, only changed fields override it
                const effective = mergeChatFineTune(osTheme, override);
                return (
                    <>
                        {/* Floating round bubble: hangs at the right-middle, tap = collapse/expand the small panel */}
                        <button
                            onClick={() => setFineTunePanelOpen(v => !v)}
                            className={`fixed right-3 z-[106] flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all active:scale-90 ${fineTunePanelOpen ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-white/95 text-primary ring-1 ring-primary/30 backdrop-blur'}`}
                            style={{ top: 'calc(var(--safe-top) + 35vh)' }}
                            aria-label={fineTunePanelOpen ? 'Collapse the Chat Styling panel' : 'Expand the Chat Styling panel'}
                        >
                            <FadersHorizontal className="h-6 w-6" weight="bold" />
                        </button>
                        {/* Small panel: docked at the bottom without covering the whole screen — the upper half of the chat stays visible and scrollable as usual */}
                        {fineTunePanelOpen && (
                            <div
                                className="fixed left-1/2 z-[105] w-[94%] max-w-md -translate-x-1/2 overflow-y-auto rounded-3xl border border-white/60 bg-white/95 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.22)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                                style={{ bottom: 'calc(84px + var(--safe-bottom))', maxHeight: '46vh' }}
                            >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-[13px] font-bold text-slate-800">Chat Styling · {char.name}</div>
                                        <div className="mt-0.5 text-[10px] text-slate-400">Changes take effect immediately in the chat above; tap the round bubble on the right to collapse the panel and see the result.</div>
                                    </div>
                                    <button
                                        onClick={() => { setFineTuneOpen(false); setFineTunePanelOpen(false); }}
                                        className="shrink-0 rounded-full bg-primary px-4 py-1.5 text-[11px] font-bold text-white shadow-sm transition-all active:scale-95">
                                        Done
                                    </button>
                                </div>
                                <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                                    <div className="min-w-0 pr-3">
                                        <div className="text-[11px] font-bold text-slate-700">{customized ? 'Customizing individually for them' : 'Following global settings (default)'}</div>
                                        <div className="mt-0.5 text-[10px] text-slate-400">
                                            {customized
                                                ? 'Only the items that were changed override the global settings; everything else still follows Appearance → Chat Screen. Turning the toggle off goes back to following global, and the customization is kept.'
                                                : 'Currently using the global settings from Appearance → Chat Screen. Turn the toggle on to customize just for this character.'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateCharacter(char.id, { chatFineTune: { ...override, enabled: !customized } } as any)}
                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${customized ? 'bg-primary' : 'bg-slate-300'}`}
                                        aria-pressed={customized}
                                    >
                                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${customized ? 'left-[22px]' : 'left-0.5'}`} />
                                    </button>
                                </div>
                                {customized && (
                                    <>
                                        <ChatFineTunePanel
                                            value={effective}
                                            onChange={(patch) => updateCharacter(char.id, { chatFineTune: { ...override, enabled: true, ...patch } } as any)}
                                        />
                                        <button
                                            onClick={() => { updateCharacter(char.id, { chatFineTune: undefined } as any); addToast('Cleared Chat Styling for this character, back to following global', 'success'); }}
                                            className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-bold text-slate-500 transition-all hover:bg-slate-100 active:scale-[0.99]">
                                            Clear customization, back to following global
                                        </button>
                                    </>
                                )}
                                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                                    Only affects the 1:1 chat screen, Group Chat is unaffected. No need to worry if you've hand-written "Whitebox" custom CSS: <b>custom CSS has higher priority</b> and always overrides the settings here.
                                </p>
                            </div>
                        )}
                    </>
                );
            })()}

            {/* Character-specific "Whitebox Customization" Modal — entered from the + panel's "Whitebox" button; writes to char.chromeCustomCss, layered on top of global */}
            {char && modalType === 'chrome-css' && (
                <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                    <div
                        className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-2 flex items-start justify-between">
                            <div>
                                <div className="text-sm font-bold text-slate-800">Whitebox Customization · {char.name}</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">↑ The chat screen above is a live preview; only applies to this character, layered on top of the global settings.</div>
                            </div>
                            <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                        </div>
                        <ChromeCssEditor value={char.chromeCustomCss || ''} onChange={(css) => updateCharacter(char.id, { chromeCustomCss: css } as any)} />
                    </div>
                    {/* Rescue button that stays free of CSS control: only appears while the "Whitebox"
                        customization modal is open (hidden the rest of the time, so it isn't ugly).
                        Portalled to body, outside the chat DOM + guarded by id
                        (#sully-safe-reset's specificity beats *), can't even be covered by
                        *{display:none!important} — guarantees this reset button is always clickable
                        the moment bad CSS you just pasted in crashes the view. */}
                    {createPortal(
                        <>
                            <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
                            <button
                                id="sully-safe-reset"
                                onClick={() => { updateCharacter(char.id, { chromeCustomCss: '' } as any); addToast('Whitebox reset for this character', 'success'); }}
                                style={{
                                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', left: '50%', transform: 'translateX(-50%)',
                                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '5px 12px', borderRadius: '999px',
                                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                                }}
                            >⟲ Reset this character's Whitebox</button>
                        </>,
                        document.body,
                    )}
                </div>
            )}

            {/* Whitebox "Notification Sound" Modal — entered from the + panel's "Notification Sound"
                button. Stored independently in char.chatSound by default; turning on "Bind to
                Whitebox" instead stores it in the @sully-sound directive inside char.chromeCustomCss, traveling with Whitebox sharing. */}
            {char && modalType === 'chrome-sound' && (() => {
                const boundSound = parseWhiteboxSound(char.chromeCustomCss);
                const isBound = !!char.chatSoundBound || !!boundSound;
                const curSound: WhiteboxSound | null = isBound ? boundSound : (char.chatSound || null);
                const changeSound = (s: WhiteboxSound | null) => {
                    if (isBound) {
                        updateCharacter(char.id, { chromeCustomCss: upsertWhiteboxSound(char.chromeCustomCss || '', s), chatSound: undefined } as any);
                    } else {
                        updateCharacter(char.id, { chatSound: s || undefined } as any);
                    }
                };
                const changeBound = (b: boolean) => {
                    if (b) {
                        // Bind: writes the current notification sound into the Whitebox CSS directive, clears the standalone field.
                        updateCharacter(char.id, { chromeCustomCss: upsertWhiteboxSound(char.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true } as any);
                    } else {
                        // Unbind: pulls the notification sound out of the Whitebox CSS directive, puts it back into the standalone field.
                        updateCharacter(char.id, { chromeCustomCss: stripWhiteboxSoundDirective(char.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false } as any);
                    }
                };
                return (
                    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                        <div
                            className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                            style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-3 flex items-start justify-between">
                                <div>
                                    <div className="text-sm font-bold text-slate-800">Notification Sound · {char.name}</div>
                                    <div className="mt-0.5 text-[10px] text-slate-400">Plays once when their new message becomes the latest one. Independent of Whitebox by default, can optionally be bound to share together.</div>
                                </div>
                                <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                            </div>
                            <WhiteboxSoundEditor
                                sound={curSound}
                                bound={isBound}
                                onChangeSound={changeSound}
                                onChangeBound={changeBound}
                                hint={<>🔔 Plays only once when <b>their new message becomes the latest one</b>. This is <b>specific to this character</b>; if not set, the global default notification sound from Appearance → Chat Screen is used.</>}
                            />
                        </div>
                    </div>
                );
            })()}

            {/* Emotion settings are embedded in the Schedule Modal (force-synced on/off with Schedule), no longer rendered separately */}

            {/* 🍔 McDonald's Mini-App — MCP data flow driven by buttons, collaborative chat goes through the main pipeline (full persona/memory/schedule) */}
            {memoryRepairOpen && char && (
                <MemoryRepairPortal
                    char={char}
                    user={userProfile}
                    apiConfig={apiConfig}
                    embeddingConfig={memoryPalaceConfig.embedding}
                    remoteVectorConfig={remoteVectorConfig}
                    sinceTs={memoryRepairRound.sinceTs}
                    userMessage={memoryRepairRound.userMessage}
                    assistantReply={memoryRepairRound.assistantReply}
                    onClose={() => {
                        setMemoryRepairOpen(false);
                        setShowPanel('none');
                    }}
                />
            )}

            {favoritesOpen && (
                <FavoritesPortal
                    onClose={() => setFavoritesOpen(false)}
                    onJumpToMessage={handleOpenFavoriteMessage}
                />
            )}

            {char && (
                <React.Suspense fallback={collaborationOpen ? <div className="absolute inset-0 z-[120] grid place-items-center bg-slate-50 text-xs text-slate-400">Opening Collaboration…</div> : null}>
                    <CollaborationWindow
                        open={collaborationOpen}
                        character={char}
                        user={userProfile}
                        theme={activeTheme}
                        backgroundUrl={resolvedChatBackground}
                        chatApi={apiConfig}
                        apiPresets={apiPresets}
                        availableModels={availableModels}
                        characters={characters}
                        groups={groups}
                        emojis={emojis}
                        emojiCategories={categories}
                        recentChatMessages={messages}
                        realtimeConfig={realtimeConfig}
                        chatCollaborationEnabled={!!char.chatCollaborationEnabled}
                        requestedPreviewAssetId={collaborationPreviewAssetId}
                        onRequestedPreviewHandled={handleCollaborationPreviewHandled}
                        onClose={() => { setCollaborationOpen(false); setCollaborationPreviewAssetId(null); }}
                        onSendToChat={handleCollaborationTransfer}
                        onInstallArtifact={handleCollaborationInstall}
                        onArchiveToMemory={handleCollaborationArchiveToMemory}
                        onToggleChatCollaboration={enabled => updateCharacter(char.id, { chatCollaborationEnabled: enabled })}
                        notify={handleCollaborationNotify}
                    />
                </React.Suspense>
            )}

            <McdMiniApp
                open={mcdAppOpen}
                onClose={() => setMcdAppOpen(false)}
                char={char}
                userProfile={userProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleMcdMiniAppSend}
                onStateChange={handleMcdMiniAppStateChange}
                onConfirmOrder={handleMcdAppConfirm}
            />

            {/* 🦌 Luckin Mini-App — mirrors McDonald's */}
            <LuckinMiniApp
                open={luckinAppOpen}
                onClose={() => setLuckinAppOpen(false)}
                char={char}
                userProfile={userProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleLuckinMiniAppSend}
                onStateChange={handleLuckinMiniAppStateChange}
                onConfirmOrder={handleLuckinAppConfirm}
            />

            {/* 🦌 Grab a Luckin location picker */}
            <LuckinLocationModal
                open={showLuckinLoc}
                onClose={() => setShowLuckinLoc(false)}
                onPick={onLuckinLocationPick}
            />

            {/* 🦌 Grab a Luckin usage instructions (auto-shown on first launch + brought up via the banner's ?) */}
            <LuckinHelpModal
                open={showLuckinHelp}
                onClose={() => setShowLuckinHelp(false)}
            />


            {/* Forward Modal */}
            <Modal isOpen={showForwardModal} title="Forward Chat History" onClose={() => setShowForwardModal(false)}>
                {(() => {
                    const forwardCandidates = characters.filter(c => c.id !== activeCharacterId);
                    const forwardChars = filterCharactersByGroup(forwardCandidates, characterGroups, forwardGroupId);
                    return (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            <p className="text-xs text-slate-400 mb-3">Select a character to forward to ({selectedMsgIds.size} message(s) selected)</p>
                            <CharacterGroupFilterBar characters={forwardCandidates} groups={characterGroups} value={forwardGroupId} onChange={setForwardGroupId} className="mb-2 -mx-1 px-1" />
                            {forwardChars.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => handleForwardToCharacter(c.id)}
                                    className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all border border-slate-100"
                                >
                                    <TokenImg value={c.avatar} className="w-10 h-10 rounded-xl object-cover" />
                                    <div className="flex-1 text-left">
                                        <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                        <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                                    </div>
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                </button>
                            ))}
                            {forwardChars.length === 0 && (
                                <div className="text-center text-xs text-slate-400 py-8">{forwardCandidates.length === 0 ? 'No other characters available to forward to' : 'No characters in this group'}</div>
                            )}
                        </div>
                    );
                })()}
            </Modal>
        </div>
    );
};

export default Chat;
