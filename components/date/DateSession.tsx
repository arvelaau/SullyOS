import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { CharacterProfile, Message, DateState, DialogueItem, UserProfile, DateObservation } from '../../types';
import Modal from '../../components/os/Modal';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import DateSettings from './DateSettings';
import ObserveHUD from './ObserveHUD';
import { extractObservation, hasObservation } from '../../utils/datePrompts';
import { useBlobRefUrl } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { clearDateResumeAttempt } from '../../utils/dateSessionRecovery';
import { VALID_EMOTIONS } from '../../utils/minimaxTts';
import {
    canSynthesizeSpeech,
    characterHasVoice,
    cleanTextForTtsProvider,
    stripTtsMarkupForDisplay,
    synthesizeSpeech,
} from '../../utils/ttsRouter';
import { planNovelLoadMore } from '../../utils/dateSessionHistory';
import { getPendingReplyText } from '../../utils/pendingReply';
import { fetchBlobForShare } from '../../utils/shareExport';
import VoiceFavoriteActionSheet from '../voice/VoiceFavoriteActionSheet';
import { getVoiceFavorite, makeVoiceFavoriteId, removeVoiceFavorite, saveVoiceFavorite } from '../../utils/voiceFavorites';
import { MEETING_CONTINUE_DISPLAY_TEXT } from '../../utils/meetingContinue';
import { VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguageLabel, voiceLanguagePromptLabel } from '../../utils/voiceLanguage';
import { trackEvent } from '../../utils/analytics';

// Voice emotion tag [v:xxx]: a separate channel from the sprite emotion [emotion].
// The sprite's "happy" is an exaggerated expression; the voice's "happy" is a vocal-tone
// emotion — the two differ too much in intensity/meaning to be treated as one. So voice
// emotion is tagged separately by the LLM with [v:xxx]; if untagged, nothing is passed
// (letting MiniMax read it naturally).
// Extracts [v:xxx] from a line, returning { voiceEmotion, rest (text with the tag stripped) }.
const VOICE_EMOTION_TAG_RE = /\[v:\s*([a-zA-Z]+)\s*\]/i;
const extractVoiceEmotionTag = (line: string): { voiceEmotion?: string; rest: string } => {
    let voiceEmotion: string | undefined;
    const rest = line.replace(VOICE_EMOTION_TAG_RE, (_m, e: string) => {
        const k = (e || '').toLowerCase();
        if (VALID_EMOTIONS.has(k)) voiceEmotion = k;
        return '';
    });
    return { voiceEmotion, rest };
};

// Helper: Parse dialogue with simple state machine
const isContextNoise = (line: string) => {
    const l = line.trim().toLowerCase();
    if (l.startsWith('(') && l.endsWith(')')) {
        if (l.includes('in person') || l.includes('face-to-face') || l.includes('location') || l.includes('time')) return true;
    }
    if (l.startsWith('[system') || l.startsWith('(system')) return true;
    return false;
};

// Helper: Strip emotion tags like [shy], [happy] for pure text display
const cleanTextForDisplay = (text: string) => {
    // Remove content inside brackets [] and trim extra spaces
    // Also remove typical system prompts if any leak through
    return text.replace(/\[.*?\]/g, '').trim();
};

// Helper: Check if a line is dialogue (starts with quoted speech "...")
// A dialogue line must BEGIN with a quote character (after trimming).
// Lines that merely contain incidental quotes (e.g. tucked the "collar sketch" into...) are narration.
const isDialogueLine = (text: string) => {
    const clean = cleanTextForDisplay(text);
    return /^[""\u201C\u300C]/.test(clean);
};

// Helper: Extract only the dialogue text from a line for TTS
const extractDialogueText = (text: string): string => {
    const clean = cleanTextForDisplay(text);
    const matches = clean.match(/["\u201C]([^"\u201D]*)["\u201D]/g)
        || clean.match(/[\u300C]([^\u300D]*)[\u300D]/g);
    if (matches) {
        return matches.map(m => m.replace(/["\u201C\u201D\u300C\u300D]/g, '')).join(' ');
    }
    return clean;
};

// Highlight styling for spoken-dialogue text (subtle gray background over the quoted span).
const dialogueHighlightStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.05)',
    color: '#000',
    padding: '1px 4px',
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
};

// Same quote-pair matching as extractDialogueText, but keeps each match's position so text
// attached to the same line (before/after the quotes) can stay unwrapped.
const DIALOGUE_QUOTE_SPAN_REGEX = /["\u201C][^"\u201D]*["\u201D]|\u300C[^\u300D]*\u300D/g;

// Wraps only the quoted portion(s) of a dialogue line in a highlighted span; lines that don't
// start with a quote (per isDialogueLine) are returned unchanged. Narration/action text on the
// same line as the quote (before or after it) is left as plain, unwrapped text.
const renderLineWithDialogueHighlight = (line: string): React.ReactNode => {
    if (!isDialogueLine(line)) return line;
    const segments: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    DIALOGUE_QUOTE_SPAN_REGEX.lastIndex = 0;
    let key = 0;
    while ((match = DIALOGUE_QUOTE_SPAN_REGEX.exec(line))) {
        if (match.index > lastIndex) segments.push(line.slice(lastIndex, match.index));
        segments.push(<span key={key++} style={dialogueHighlightStyle}>{match[0]}</span>);
        lastIndex = match.index + match[0].length;
    }
    // isDialogueLine matched (line starts with an opening quote) but no closed pair was found
    // (e.g. an unclosed quote) \u2014 don't wrap anything rather than guessing where it ends.
    if (lastIndex === 0) return line;
    if (lastIndex < line.length) segments.push(line.slice(lastIndex));
    return segments;
};

const parseDialogue = (fullText: string, initialEmotion: string = 'normal'): DialogueItem[] => {
    if (!fullText) return [];
    const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results: DialogueItem[] = [];
    let currentEmotion = initialEmotion;

    for (const rawLine of lines) {
        if (isContextNoise(rawLine)) continue;
        // First strip out the standalone voice emotion tag [v:xxx] (independent of the sprite emotion), then parse the sprite tag
        const { voiceEmotion, rest } = extractVoiceEmotionTag(rawLine);
        const line = rest.trim();
        if (!line) continue;
        const tagMatch = line.match(/^\[([a-zA-Z0-9_\-]+)\]\s*(.*)/);
        let content = line;

        if (tagMatch) {
            currentEmotion = tagMatch[1].toLowerCase();
            content = tagMatch[2];
        } else {
            const standaloneTag = line.match(/^\[([a-zA-Z0-9_\-]+)\]$/);
            if (standaloneTag) {
                currentEmotion = standaloneTag[1].toLowerCase();
                continue;
            }
        }
        if (content) {
            results.push({ text: content, emotion: currentEmotion, voiceEmotion });
        }
    }
    return results;
};

interface DateSessionProps {
    char: CharacterProfile;
    userProfile: UserProfile;
    messages: Message[]; // The DB messages for history/novel mode
    peekStatus: string;  // Initial text from the Peek phase
    initialState?: DateState; // Resume state
    onSendMessage: (text: string, kind?: 'continue') => Promise<string>; // Returns AI content
    onReroll: () => Promise<string>;
    onExit: (currentState: DateState) => void;
    onEditMessage: (msg: Message) => void;
    onDeleteMessage: (msg: Message) => void;
    onDeleteMessages: (ids: number[]) => Promise<void>;
    onSettings: () => void;
    /** Reading Mode's "Load Earlier" button: once the already-loaded portion is fully filled, fetch the next batch from the DB (re-query with an incrementing limit). */
    onLoadMoreHistory?: (nextLimit: number) => Promise<void>;
    /** The limit currently used for the query (increments together with onLoadMoreHistory). */
    historyLoadLimit?: number;
    /** Whether the Date history in the DB has already been fully fetched. */
    historyReachedEnd?: boolean;
}

// Long replies can expand into many DOM lines. Keeping a smaller reading window
// materially reduces iOS WebKit content-process crashes while older entries
// remain available through the existing "Load Earlier" button.
const NOVEL_MESSAGE_WINDOW_SIZE = 40;
/** How many more Date messages to fetch from the DB each time, once the already-loaded portion is fully filled. */
const NOVEL_HISTORY_FETCH_STEP = 220;
const NOVEL_MESSAGE_LOAD_STEP = 40;
const REQUIRED_EMOTIONS_SET = ['normal', 'happy', 'angry', 'sad', 'shy'];

type DateSpeechResult = { url: string; spokenText: string };
type DateVoiceFavoriteTarget = {
    sourceKey: string;
    originalText: string;
    sourceTimestamp: number;
    voiceEmotion?: string;
};

const ReadingAvatar: React.FC<{ src?: string; name: string; light: boolean }> = ({ src, name, light }) => {
    const [imageFailed, setImageFailed] = useState(false);
    useEffect(() => setImageFailed(false), [src]);

    // TokenImg resolves the blobref token into a usable url; here we only check "is there an avatar" and "did it fail to load"
    const canShowImage = !!src && !imageFailed;
    return (
        <div
            className={`mt-1 h-9 w-9 shrink-0 overflow-hidden rounded-full ring-1 shadow-sm ${
                light ? 'bg-stone-200 text-stone-500 ring-stone-300/70' : 'bg-white/10 text-white/70 ring-white/15'
            }`}
            aria-hidden="true"
        >
            {canShowImage ? (
                <TokenImg
                    value={src}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <span className="flex h-full w-full items-center justify-center text-xs font-bold">
                    {(name || '·').trim().slice(0, 1) || '·'}
                </span>
            )}
        </div>
    );
};

const DateSession: React.FC<DateSessionProps> = ({ 
    onLoadMoreHistory,
    historyLoadLimit = 0,
    historyReachedEnd = true,
    char, 
    userProfile,
    messages, 
    peekStatus, 
    initialState,
    onSendMessage, 
    onReroll, 
    onExit,
    onEditMessage,
    onDeleteMessage,
    onDeleteMessages,
    onSettings
}) => {
    const { addToast, registerBackHandler, apiConfig, updateCharacter } = useOS();
    
    // Core VN State
    const [isNovelMode, setIsNovelMode] = useState(false);
    const [bgImage, setBgImage] = useState<string>(char.dateBackground || '');
    // bgImage state always stores the raw field value (token / data: / external link); it's only resolved into a CSS-ready url at the moment of rendering
    const bgImageUrl = useBlobRefUrl(bgImage);
    const [currentSprite, setCurrentSprite] = useState<string>('');
    const [currentSpriteKey, setCurrentSpriteKey] = useState<string>('');
    const [spriteConfig, setSpriteConfig] = useState(char.spriteConfig || { scale: 1, x: 0, y: 0 });
    
    // Dialogue Engine State
    const [dialogueQueue, setDialogueQueue] = useState<DialogueItem[]>([]);
    const [dialogueBatch, setDialogueBatch] = useState<DialogueItem[]>([]); // For replaying current batch
    const [currentText, setCurrentText] = useState('');
    const [displayedText, setDisplayedText] = useState('');
    const [isTextAnimating, setIsTextAnimating] = useState(false);

    // OBSERVE protocol: the structured observation parsed from the current batch, drives the holographic HUD
    const observeEnabled = !!char.dateObserve?.enabled;
    const [observation, setObservation] = useState<DateObservation | null>(initialState?.observation ?? null);
    
    // Interaction State
    const [input, setInput] = useState('');
    const [showInputBox, setShowInputBox] = useState(false);
    const [isTyping, setIsTyping] = useState(false); // Waiting for API
    const [isShowingOpening, setIsShowingOpening] = useState(!initialState); // True until first user interaction
    const [showExitModal, setShowExitModal] = useState(false);
    // On API failure, remember this turn's input locally instead of relying on whether the parent component's DB refresh has completed; the user can directly tap retry.
    const [pendingRetryText, setPendingRetryText] = useState('');

    useEffect(() => {
        if (!getPendingReplyText(messages)) setPendingRetryText('');
    }, [messages]);
    
    // Settings Overlay State (Internal)
    const [showSettings, setShowSettings] = useState(false);

    // Top-bar collapsible menu: only the "Input" + "Menu" buttons stay persistent, all low-frequency actions are tucked away in here
    const [showMenu, setShowMenu] = useState(false);

    // Edit Msg Logic
    const [modalType, setModalType] = useState<'none' | 'options'>('none');
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [isBatchSelectMode, setIsBatchSelectMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const touchStartRef = useRef<{x: number, y: number} | null>(null);
    const novelScrollRef = useRef<HTMLDivElement>(null);

    // Voice TTS — single shared cache keyed by dialogue text, used by both GAL & novel mode
    const [dateVoicePlaying, setDateVoicePlaying] = useState(false);
    const [galVoiceLoading, setGalVoiceLoading] = useState(false);
    const [showVoiceLangPicker, setShowVoiceLangPicker] = useState(false);
    const voiceCacheRef = useRef<Record<string, DateSpeechResult>>({});
    const [novelVoiceLoading, setNovelVoiceLoading] = useState<Set<string>>(new Set());
    const [novelPlayingId, setNovelPlayingId] = useState<string | null>(null);
    const [novelVisibleCount, setNovelVisibleCount] = useState(NOVEL_MESSAGE_WINDOW_SIZE);
    const dateAudioRef = useRef<HTMLAudioElement | null>(null);
    const voiceEnabled = !!char.dateVoiceEnabled;
    const voiceLang = char.dateVoiceLang || '';
    // Bridges the current line's VOICE emotion ([v:xxx], separate from the sprite emotion) to the GAL
    // voice effect (which keys off currentText only). undefined = no emotion passed, read naturally.
    // A ref so it doesn't churn the effect's deps.
    const currentLineEmotionRef = useRef<string | undefined>(undefined);
    const [voiceFavoriteTarget, setVoiceFavoriteTarget] = useState<DateVoiceFavoriteTarget | null>(null);
    const [voiceFavoriteSaved, setVoiceFavoriteSaved] = useState(false);
    const [voiceFavoriteBusy, setVoiceFavoriteBusy] = useState(false);
    const voiceFavoriteLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const voiceFavoriteLongPressTriggered = useRef(false);

    const translateAndSpeak = async (text: string, emotion?: string): Promise<DateSpeechResult | null> => {
        if (!canSynthesizeSpeech(char, apiConfig)) return null;
        try {
            let ttsText = cleanTextForTtsProvider(text, apiConfig);
            if (!ttsText || ttsText.length < 2) return null;
            if (voiceLang) {
                const langLabel = voiceLanguagePromptLabel(voiceLang);
                try {
                    const transRes = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{ role: 'system', content: `Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.` }, { role: 'user', content: ttsText }],
                            temperature: 0.3,
                        }),
                    });
                    const transData = await transRes.json();
                    const translated = transData?.choices?.[0]?.message?.content?.trim();
                    if (translated) ttsText = translated;
                } catch { /* use original */ }
            }
            const url = await synthesizeSpeech(ttsText, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion,
            });
            return {
                url,
                spokenText: stripTtsMarkupForDisplay(ttsText, apiConfig),
            };
        } catch (err: any) {
            console.warn('Date TTS failed:', err?.message);
            return null;
        }
    };

    // GAL mode: auto-play voice only for dialogue lines (quoted text), stop previous on advance
    // Uses cache so replaying the same line doesn't re-fetch
    useEffect(() => {
        if (!voiceEnabled || isNovelMode || !currentText || isTyping) return;
        // Stop any currently playing audio when text changes (advancing to next line)
        if (dateAudioRef.current) {
            dateAudioRef.current.pause();
            dateAudioRef.current.currentTime = 0;
            setDateVoicePlaying(false);
        }
        setGalVoiceLoading(false);
        // Skip voice during opening phase and for non-dialogue lines
        if (isShowingOpening) return;
        if (!isDialogueLine(currentText)) return;
        let cancelled = false;
        const dialogueText = extractDialogueText(currentText);
        const cacheKey = dialogueText;
        const play = async () => {
            // Check cache first
            let speech: DateSpeechResult | undefined = voiceCacheRef.current[cacheKey];
            if (!speech) {
                setGalVoiceLoading(true);
                speech = await translateAndSpeak(dialogueText, currentLineEmotionRef.current) || undefined;
                if (cancelled) return;
                setGalVoiceLoading(false);
                if (!speech) return;
                voiceCacheRef.current[cacheKey] = speech;
            }
            if (cancelled) return;
            if (!dateAudioRef.current) dateAudioRef.current = new Audio();
            dateAudioRef.current.src = speech.url;
            dateAudioRef.current.onended = () => setDateVoicePlaying(false);
            dateAudioRef.current.play().catch(() => {});
            setDateVoicePlaying(true);
        };
        play();
        return () => { cancelled = true; setGalVoiceLoading(false); if (dateAudioRef.current) { dateAudioRef.current.pause(); } };
    }, [currentText, voiceEnabled, isNovelMode]);

    // GAL mode: manual play/pause for the current dialogue line
    const handleGalVoiceToggle = async () => {
        if (!currentText || !isDialogueLine(currentText)) return;
        // If playing, pause
        if (dateVoicePlaying && dateAudioRef.current) {
            dateAudioRef.current.pause();
            setDateVoicePlaying(false);
            return;
        }
        const dialogueText = extractDialogueText(currentText);
        const cacheKey = dialogueText;
        let speech: DateSpeechResult | undefined = voiceCacheRef.current[cacheKey];
        if (!speech) {
            setGalVoiceLoading(true);
            speech = await translateAndSpeak(dialogueText, currentLineEmotionRef.current) || undefined;
            setGalVoiceLoading(false);
            if (!speech) { addToast('Voice synthesis failed, please try again later', 'error'); return; }
            voiceCacheRef.current[cacheKey] = speech;
        }
        if (!dateAudioRef.current) dateAudioRef.current = new Audio();
        dateAudioRef.current.src = speech.url;
        dateAudioRef.current.onended = () => setDateVoicePlaying(false);
        dateAudioRef.current.play().catch(() => {});
        setDateVoicePlaying(true);
    };

    // Novel/Reading mode: play a specific dialogue line (shares voiceCacheRef with GAL mode)
    // voiceEmotion ([v:xxx]) is passed to TTS consistently with Visual Mode: this way the audio
    // synthesized by both modes is identical and hits the same persistent cache (ttsCache/IndexedDB) —
    // exiting the Date and coming back to tap an old line can still be pulled instantly from the local
    // cache, without needing to re-synthesize over the network under a different key.
    const handleNovelLinePlay = async (lineKey: string, dialogueText: string, voiceEmotion?: string) => {
        const cached = voiceCacheRef.current[dialogueText];
        if (cached) {
            // Already have URL (from GAL or previous novel play), just play/pause
            if (!dateAudioRef.current) dateAudioRef.current = new Audio();
            if (novelPlayingId === lineKey) {
                dateAudioRef.current.pause();
                setNovelPlayingId(null);
                return;
            }
            dateAudioRef.current.src = cached.url;
            dateAudioRef.current.onended = () => setNovelPlayingId(null);
            dateAudioRef.current.play().catch(() => {});
            setNovelPlayingId(lineKey);
            return;
        }
        setNovelVoiceLoading(prev => new Set(prev).add(lineKey));
        const speech = await translateAndSpeak(dialogueText, voiceEmotion);
        setNovelVoiceLoading(prev => { const n = new Set(prev); n.delete(lineKey); return n; });
        if (!speech) { addToast('Voice synthesis failed, please try again later', 'error'); return; }
        voiceCacheRef.current[dialogueText] = speech;
        if (!dateAudioRef.current) dateAudioRef.current = new Audio();
        dateAudioRef.current.src = speech.url;
        dateAudioRef.current.onended = () => setNovelPlayingId(null);
        dateAudioRef.current.play().catch(() => {});
        setNovelPlayingId(lineKey);
    };

    const resolveCurrentDateVoiceTarget = (): DateVoiceFavoriteTarget | null => {
        if (!currentText || !isDialogueLine(currentText)) return null;
        const originalText = extractDialogueText(currentText);
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
            const message = messages[messageIndex];
            if (message.role !== 'assistant') continue;
            const { rest: body } = extractObservation(message.content || '', { lenient: observeEnabled, custom: char.dateObserve?.custom });
            const lines = body.split('\n');
            for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
                const parsed = extractVoiceEmotionTag(lines[lineIndex]);
                if (isDialogueLine(parsed.rest) && extractDialogueText(parsed.rest) === originalText) {
                    return {
                        sourceKey: `${char.id}:${message.id}-${lineIndex}`,
                        originalText,
                        sourceTimestamp: message.timestamp,
                        voiceEmotion: parsed.voiceEmotion || currentLineEmotionRef.current,
                    };
                }
            }
        }
        return {
            sourceKey: `${char.id}:live:${makeVoiceFavoriteId('date', originalText)}`,
            originalText,
            sourceTimestamp: Date.now(),
            voiceEmotion: currentLineEmotionRef.current,
        };
    };

    const openDateVoiceFavorite = async (target: DateVoiceFavoriteTarget | null) => {
        if (!target) return;
        setVoiceFavoriteTarget(target);
        setVoiceFavoriteBusy(false);
        setVoiceFavoriteSaved(!!await getVoiceFavorite('date', target.sourceKey).catch(() => null));
    };

    const startDateVoiceLongPress = (event: React.TouchEvent, target: DateVoiceFavoriteTarget | null) => {
        event.stopPropagation();
        if (!target) return;
        voiceFavoriteLongPressTriggered.current = false;
        if (voiceFavoriteLongPressTimer.current) clearTimeout(voiceFavoriteLongPressTimer.current);
        voiceFavoriteLongPressTimer.current = setTimeout(() => {
            voiceFavoriteLongPressTriggered.current = true;
            void openDateVoiceFavorite(target);
        }, 450);
    };

    const endDateVoiceLongPress = (event: React.SyntheticEvent) => {
        event.stopPropagation();
        if (voiceFavoriteLongPressTimer.current) clearTimeout(voiceFavoriteLongPressTimer.current);
        voiceFavoriteLongPressTimer.current = null;
    };

    const toggleDateVoiceFavorite = async () => {
        const target = voiceFavoriteTarget;
        if (!target || voiceFavoriteBusy) return;
        setVoiceFavoriteBusy(true);
        try {
            if (voiceFavoriteSaved) {
                await removeVoiceFavorite('date', target.sourceKey);
                setVoiceFavoriteSaved(false);
                addToast('Removed from voice favorites', 'info');
                return;
            }
            let speech: DateSpeechResult | undefined = voiceCacheRef.current[target.originalText];
            if (!speech) {
                speech = await translateAndSpeak(target.originalText, target.voiceEmotion) || undefined;
                if (speech) voiceCacheRef.current[target.originalText] = speech;
            }
            if (!speech) throw new Error('Voice synthesis failed, please try again later');
            const blob = await fetchBlobForShare(speech.url, 'audio/mpeg');
            await saveVoiceFavorite({
                source: 'date',
                sourceKey: target.sourceKey,
                charId: char.id,
                charName: char.name,
                sourceTimestamp: target.sourceTimestamp,
                originalText: target.originalText,
                spokenText: speech.spokenText !== target.originalText ? speech.spokenText : undefined,
                language: voiceLang || undefined,
                blob,
            });
            setVoiceFavoriteSaved(true);
            addToast('Date voice added to favorites', 'success');
        } catch (error: any) {
            addToast(error?.message || 'Failed to save favorite, please check your browser storage space', 'error');
        } finally {
            setVoiceFavoriteBusy(false);
        }
    };

    // Back Handler
    useEffect(() => {
        const unregister = registerBackHandler(() => {
            if (voiceFavoriteTarget) {
                if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null);
                return true;
            }
            if (showSettings) {
                setShowSettings(false);
                return true;
            }
            if (showMenu) {
                setShowMenu(false);
                setShowVoiceLangPicker(false);
                return true;
            }
            if (showExitModal) {
                setShowExitModal(false);
                return true;
            }
            setShowExitModal(true);
            return true;
        });
        return unregister;
    }, [voiceFavoriteTarget, voiceFavoriteBusy, showSettings, showMenu, showExitModal, registerBackHandler]);

    const dateEmotionKeys = [...REQUIRED_EMOTIONS_SET, ...(char.customDateSprites || [])];

    const getSpritesForSkin = (skinId?: string): Record<string, string> => {
        const explicitSkin = skinId && char.dateSkinSets?.find(s => s.id === skinId);
        if (explicitSkin && Object.keys(explicitSkin.sprites || {}).length > 0) return explicitSkin.sprites;
        if (char.activeSkinSetId && char.dateSkinSets) {
            const activeSkin = char.dateSkinSets.find(s => s.id === char.activeSkinSetId);
            if (activeSkin && Object.keys(activeSkin.sprites || {}).length > 0) return activeSkin.sprites;
        }
        return char.sprites || {};
    };

    const activeSprites = React.useMemo(() => getSpritesForSkin(), [char.activeSkinSetId, char.dateSkinSets, char.sprites]);

    const pickFallbackSprite = (sprites: Record<string, string>) => {
        const key = ['normal', 'default', ...dateEmotionKeys].find(k => sprites[k]);
        const stray = Object.entries(sprites).find(([k, v]) => k !== 'chibi' && v);
        return { key: key || stray?.[0] || '', src: (key && sprites[key]) || stray?.[1] || char.avatar || '' };
    };

    // Look up which emotion key a sprite's "field value" belongs to by an exact character match
    // against the values in the sprites table. So the currentSprite state must always hold the
    // raw field value (blobref token / data: / external link) — resolving it into an objectURL can
    // only happen at the moment of rendering (left to TokenImg), otherwise the key can never be found here.
    const inferSpriteKey = (src?: string, skinId?: string): string => {
        if (!src) return '';
        const sprites = getSpritesForSkin(skinId);
        return Object.entries(sprites).find(([, value]) => value === src)?.[0] || '';
    };

    const resolveSpriteByKey = (key?: string, skinId?: string) => {
        const sprites = getSpritesForSkin(skinId);
        if (key && sprites[key]) return { key, src: sprites[key] };
        return pickFallbackSprite(sprites);
    };

    const resolveSpriteFromState = (state: DateState) => {
        const bySavedKey = resolveSpriteByKey(state.currentSpriteKey, state.activeSkinSetId);
        if (state.currentSpriteKey && bySavedKey.src) return bySavedKey;
        const legacyKey = inferSpriteKey(state.currentSprite, state.activeSkinSetId) || inferSpriteKey(state.currentSprite);
        if (legacyKey) return resolveSpriteByKey(legacyKey, state.activeSkinSetId);
        const fallback = resolveSpriteByKey(undefined, state.activeSkinSetId);
        return { key: fallback.key, src: state.currentSprite || fallback.src };
    };

    // Filter messages for Novel Mode: Show only current session
    // Logic: Find the LAST message with `isOpening: true`. Show all messages from there onwards.
    const sessionMessages = React.useMemo(() => {
        const openingIndex = messages.map(m => m.metadata?.isOpening).lastIndexOf(true);
        if (openingIndex !== -1) {
            return messages.slice(openingIndex);
        }
        // Fallback: If no opening found (legacy data), show all
        return messages;
    }, [messages]);

    const visibleSessionMessages = React.useMemo(() => {
        return sessionMessages.slice(-novelVisibleCount);
    }, [sessionMessages, novelVisibleCount]);
    const hiddenNovelMessageCount = Math.max(0, sessionMessages.length - visibleSessionMessages.length);

    useEffect(() => {
        setNovelVisibleCount(NOVEL_MESSAGE_WINDOW_SIZE);
    }, [char.id]);

    // Initialization
    useEffect(() => {
        if (initialState) {
            // Resume: new snapshots only save the sprite key, no longer duplicating base64; old snapshots' bg/currentSprite are still read once for backward compatibility.
            const restoredSprite = resolveSpriteFromState(initialState);
            setBgImage(char.dateBackground || initialState.bgImage || '');
            setCurrentSprite(restoredSprite.src);
            setCurrentSpriteKey(restoredSprite.key);
            setCurrentText(initialState.currentText || '');
            setDisplayedText(initialState.currentText || '');
            setDialogueQueue(Array.isArray(initialState.dialogueQueue) ? initialState.dialogueQueue : []);
            setDialogueBatch(Array.isArray(initialState.dialogueBatch) ? initialState.dialogueBatch : []);
            setIsNovelMode(!!initialState.isNovelMode);
        } else {
            // New Session - pick initial sprite from active skin set or default sprites
            const initialSprite = pickFallbackSprite(activeSprites);
            setCurrentSprite(initialSprite.src);
            setCurrentSpriteKey(initialSprite.key);
            
            // Parse Peek Status as opening — first strip out the observation block (only present if OBSERVE is enabled)
            const startText = peekStatus || "Waiting for connection...";
            const { observation: peekObs, rest: peekRest } = extractObservation(startText, { lenient: observeEnabled, custom: char.dateObserve?.custom });
            if (hasObservation(peekObs)) setObservation(peekObs);
            const items = parseDialogue(peekRest, 'normal');
            setDialogueBatch(items);
            setDialogueQueue(items);
            
            if (items.length > 0) {
                // Manually trigger first item processing
                const first = items[0];
                setCurrentText(first.text);
                currentLineEmotionRef.current = first.voiceEmotion;
                // Note: Not setting sprite here because useEffect below will handle emotion->sprite mapping if needed,
                // or we rely on default.
                setDialogueQueue(items.slice(1));
            }
        }
    }, []); // Run once on mount

    // Sprite & Config Sync (If user goes to settings and comes back, this helps)
    useEffect(() => {
        if (char.spriteConfig) setSpriteConfig(char.spriteConfig);
        if (char.dateBackground || !initialState?.bgImage) setBgImage(char.dateBackground || '');
        if (currentSpriteKey) {
            const resolved = resolveSpriteByKey(currentSpriteKey);
            if (resolved.src) setCurrentSprite(resolved.src);
        }
    }, [char, currentSpriteKey]);

    // Novel Mode Scroll
    useEffect(() => {
        if (isNovelMode && novelScrollRef.current) {
            novelScrollRef.current.scrollTop = novelScrollRef.current.scrollHeight;
        }
    }, [visibleSessionMessages.length, isNovelMode, showInputBox]);

    // Typewriter effect
    useEffect(() => {
        if (!currentText || isNovelMode) {
            if (isNovelMode) setDisplayedText(currentText);
            return;
        }
        setIsTextAnimating(true);
        setDisplayedText('');
        let i = 0;
        const timer = setInterval(() => {
            setDisplayedText(currentText.substring(0, i + 1));
            i++;
            if (i >= currentText.length) {
                clearInterval(timer);
                setIsTextAnimating(false);
            }
        }, 20);
        return () => clearInterval(timer);
    }, [currentText, isNovelMode]);

    // --- Logic ---

    const processNextDialogue = (item: DialogueItem, remaining: DialogueItem[]) => {
        setCurrentText(item.text);
        currentLineEmotionRef.current = item.voiceEmotion;
        if (item.emotion && activeSprites) {
            const emotionKey = item.emotion.toLowerCase();
            if (dateEmotionKeys.includes(emotionKey)) {
                const nextSprite = activeSprites[emotionKey];
                if (nextSprite) {
                    setCurrentSprite(nextSprite);
                    setCurrentSpriteKey(emotionKey);
                }
            } else {
                const found = dateEmotionKeys.find(k => emotionKey.includes(k));
                if (found && activeSprites[found]) {
                    setCurrentSprite(activeSprites[found]);
                    setCurrentSpriteKey(found);
                }
            }
        }
        setDialogueQueue(remaining);
    };

    // The sprite engine (dialogueQueue / currentText / dialogueBatch) by default only parses once,
    // when entering the session or receiving a new reply. If the user edits / regenerates the "last
    // AI reply" while in Reading Mode, messages updates and Reading Mode reflects it instantly, but
    // the sprite engine doesn't automatically re-parse — so the sprite stays stuck on the old text and
    // old voice, feeling "out of sync." Here we watch the content of the last assistant message, and
    // when it changes, re-parse and sync the current batch. Skip the first frame (including the
    // playback position restored from initialState), and also skip while isTyping (a new reply is
    // handled by handleSend / handleRerollClick, avoiding a duplicate parse).
    const lastAssistantContent = React.useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'assistant') return messages[i].content || '';
        }
        return '';
    }, [messages]);
    const dialogueSyncMountRef = useRef(false);
    useEffect(() => {
        if (!dialogueSyncMountRef.current) { dialogueSyncMountRef.current = true; return; }
        if (isTyping || !lastAssistantContent) return;
        const { rest } = extractObservation(lastAssistantContent, { lenient: observeEnabled, custom: char.dateObserve?.custom });
        const items = parseDialogue(rest, 'normal');
        if (items.length === 0) return;
        setDialogueBatch(items);
        processNextDialogue(items[0], items.slice(1));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastAssistantContent]);

    const handleScreenClick = (e: React.MouseEvent) => {
        if (voiceFavoriteLongPressTriggered.current) {
            voiceFavoriteLongPressTriggered.current = false;
            return;
        }
        if ((e.target as HTMLElement).closest('button, input, textarea, .control-panel')) return;
        // While the menu is expanded, clicking anywhere in the scene first collapses the menu instead of advancing the dialogue
        if (showMenu) {
            setShowMenu(false);
            setShowVoiceLangPicker(false);
            return;
        }
        if (isNovelMode) return;

        // Skip animation
        if (isTextAnimating) {
            setDisplayedText(currentText);
            setIsTextAnimating(false);
            return;
        }

        // Next item
        if (dialogueQueue.length > 0) {
            processNextDialogue(dialogueQueue[0], dialogueQueue.slice(1));
            return;
        }

        // Loop
        if (dialogueBatch.length > 0) {
            // Replay
            addToast('Replaying dialogue', 'info');
            processNextDialogue(dialogueBatch[0], dialogueBatch.slice(1));
            return;
        }
    };

    const submitTurn = async (kind?: 'continue') => {
        if (isTyping) return;
        const inputText = input.trim();
        // Locally-failed input takes priority, with the DB timeline as a fallback. This way the retry key won't go stale even if the parent component's refresh hasn't landed by this frame.
        const retryText = pendingRetryText || getPendingReplyText(messages);
        if (kind !== 'continue' && !inputText && !retryText) return;
        const text = kind === 'continue' ? MEETING_CONTINUE_DISPLAY_TEXT : (inputText || retryText);
        if (kind !== 'continue' && inputText) {
            setInput('');
            setShowInputBox(false);
        }
        setIsTyping(true);
        setIsShowingOpening(false); // First user interaction - opening phase is over

        try {
            const aiContent = await onSendMessage(text, kind);
            // First strip out the observation block to update the HUD, then parse the remaining body text
            const { observation: obs, rest } = extractObservation(aiContent, { lenient: observeEnabled, custom: char.dateObserve?.custom });
            if (hasObservation(obs)) setObservation(obs);
            const items = parseDialogue(rest, 'normal');
            setDialogueBatch(items);
            setDialogueQueue(items);
            if (items.length > 0) {
                processNextDialogue(items[0], items.slice(1));
            }
            setPendingRetryText('');
        } catch (e: any) {
            // onSendMessage internally includes the API call + post-reply processing, so a thrown error isn't necessarily a network issue. Use neutral copy instead of misleadingly implying "connection lost".
            setPendingRetryText(text);
            setCurrentText(`(Error: ${e?.message || 'Unknown error'})`);
            setShowInputBox(true);
        } finally {
            setIsTyping(false);
        }
    };

    const handleSend = () => { void submitTurn(); };
    const handleContinue = () => { void submitTurn('continue'); };

    const handleRerollClick = async () => {
        if (isTyping) return;
        setIsTyping(true);
        try {
            const aiContent = await onReroll();
            const { observation: obs, rest } = extractObservation(aiContent, { lenient: observeEnabled, custom: char.dateObserve?.custom });
            if (hasObservation(obs)) setObservation(obs);
            const items = parseDialogue(rest, 'normal');
            setDialogueBatch(items);
            setDialogueQueue(items);
            if (items.length > 0) processNextDialogue(items[0], items.slice(1));
        } catch(e: any) {
            // The parent's handleReroll only throws, it doesn't show a toast; if we don't give feedback
            // here, tapping "Regenerate" with no visible change will make the user think the tap didn't
            // register (the old version was worse: the message had already been deleted with zero feedback)
            addToast(`Failed to regenerate: ${e?.message || 'Unknown error'}`, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    const buildCurrentState = (): DateState => ({
        dialogueQueue,
        dialogueBatch,
        currentText,
        // Keep recovery snapshots light: don't duplicate base64 background/sprite data here.
        // TODO(date-assets): migrate CharacterProfile dateBackground/sprites/dateSkinSets themselves
        // into the IndexedDB assets store and keep stable asset refs on the character.
        currentSpriteKey: currentSpriteKey || inferSpriteKey(currentSprite) || undefined,
        activeSkinSetId: char.activeSkinSetId,
        isNovelMode,
        timestamp: Date.now(),
        peekStatus,
        observation: observation || undefined,
    });

    const handleExitClick = () => {
        onExit(buildCurrentState());
    };

    // Auto-save: persist date state so refresh/close doesn't lose progress
    const stateRef = useRef<() => DateState>(buildCurrentState);
    stateRef.current = buildCurrentState;
    const charRef = useRef(char);
    charRef.current = char;

    useEffect(() => {
        // Direct DB save — works during beforeunload when React state updates are useless
        const saveStateToDB = () => {
            try {
                const state = stateRef.current();
                DB.saveCharacter({ ...charRef.current, savedDateState: state });
            } catch (e) { /* best-effort */ }
        };

        // beforeunload: catch page refresh / tab close
        const handleBeforeUnload = () => { saveStateToDB(); };
        // visibilitychange: catch tab switch / app background (more reliable on mobile)
        const handleVisibilityChange = () => { if (document.visibilityState === 'hidden') saveStateToDB(); };
        window.addEventListener('beforeunload', handleBeforeUnload);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Periodic auto-save every 30s
        const interval = setInterval(saveStateToDB, 30000);

        // Date "resume last session" crash self-heal: as long as the session mounts stably and
        // renders for a short while without crashing, disarm the sentinel that DateApp armed before
        // resuming — proving this snapshot can be safely loaded. If iOS WebKit crashes the content
        // process before that point (a process-level crash, which won't run the unmount cleanup below),
        // the sentinel remains, and the next time the Date is entered, this poisoned snapshot is
        // detected and discarded. A new session (no initialState) has no sentinel, so clear is a no-op.
        const settleTimer = setTimeout(() => clearDateResumeAttempt(), 2500);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            clearInterval(interval);
            clearTimeout(settleTimer);
            // A clean unmount (in-SPA navigation away from the session) = not a crash, disarm the sentinel.
            clearDateResumeAttempt();
            // On unmount, only persist progress directly to the DB, never call onExit. onExit performs
            // the navigation for a "user-initiated exit" (setMode('select') + a "progress saved" toast),
            // but unmounting happens in many scenarios that aren't user intent — especially React.StrictMode's
            // (dev) "mount → unmount → remount" probe: entering a real Date would immediately get navigated
            // back to the selection screen by its own unmount side effect, and the "progress saved" toast
            // would fire twice. Persisting directly to the DB is consistent with the other auto-save paths
            // (beforeunload / visibilitychange / periodic timer).
            saveStateToDB();
        };
    }, []);

    // Message Touch Logic (Robust version for scrollable lists)
    const handleMsgTouchStart = (e: React.TouchEvent | React.MouseEvent, msg: Message) => {
        if (!isNovelMode) return;
        // If already in batch select mode, don't start a new long press timer
        if (isBatchSelectMode) return;
        if ('touches' in e) {
            touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else {
            touchStartRef.current = { x: e.clientX, y: e.clientY };
        }

        longPressTimer.current = setTimeout(() => {
                setSelectedMessage(msg);
            setModalType('options');
        }, 600);
    };

    const handleMsgTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
        if (!longPressTimer.current || !touchStartRef.current) return;
        
        let clientX, clientY;
        if ('touches' in e) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const dx = Math.abs(clientX - touchStartRef.current.x);
        const dy = Math.abs(clientY - touchStartRef.current.y);

        // If moved more than 10px, assume scrolling and cancel long press
        if (dx > 10 || dy > 10) {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    const handleMsgTouchEnd = () => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const toggleSelectedMsg = (id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const exitBatchMode = () => {
        setIsBatchSelectMode(false);
        setSelectedMsgIds(new Set());
    };

    const handleBatchDelete = async () => {
        if (selectedMsgIds.size === 0) return;
        await onDeleteMessages(Array.from(selectedMsgIds));
        exitBatchMode();
    };

    // Determine if we can reroll (last message is assistant)
    const canReroll = messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    return (
        <div className="h-full w-full relative bg-black overflow-hidden font-sans select-none" onClick={handleScreenClick}>
            
            {/* Background Layer */}
            <div 
                className={`absolute inset-0 bg-cover bg-center transition-all duration-1000 ${isNovelMode ? 'blur-xl opacity-30' : 'opacity-80'}`} 
                style={{ backgroundImage: bgImageUrl ? `url(${bgImageUrl})` : 'none' }}
            ></div>

            {/* Menu Layer — the Continue button sits alone on the left; Menu / Input stack on the far-right column.
                This way the second row's Input button hugs the right edge and doesn't cover the middle area of
                Reading Mode's batch-action bar. */}
            <div className="absolute top-0 right-0 p-4 pt-12 z-[100] flex flex-col items-end gap-2 pointer-events-auto">
                <div className="flex items-start gap-3">
                    <button
                        onClick={(e) => { e.stopPropagation(); setShowMenu(false); setShowVoiceLangPicker(false); handleContinue(); }}
                        disabled={isTyping}
                        className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center border bg-black/30 backdrop-blur-md border-white/20 text-white shadow-lg active:scale-95 transition-all hover:bg-white/20 disabled:opacity-40"
                        title={`Don't take initiative this turn, let ${char.name} continue accompanying you and move the Date along`}
                        aria-label="Continue current Date"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clipRule="evenodd" /></svg>
                    </button>
                    <div className="flex flex-col gap-2">
                        <button onClick={(e) => { e.stopPropagation(); setShowMenu(prev => !prev); setShowVoiceLangPicker(false); }} className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all shadow-lg active:scale-95 ${showMenu ? 'bg-white text-black border-white' : 'bg-black/30 backdrop-blur-md border-white/20 text-white hover:bg-white/20'}`}>
                            {showMenu ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" /></svg>
                            )}
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setShowInputBox(!showInputBox); setShowMenu(false); setShowVoiceLangPicker(false); }}
                            className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all shadow-lg active:scale-95 ${showInputBox ? 'bg-primary border-primary text-white' : 'bg-black/30 backdrop-blur-md border-white/20 text-white hover:bg-white/20'}`}
                            title={showInputBox ? "Hide input box" : "Show input box"}
                            aria-label={showInputBox ? "Hide input box" : "Show input box"}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                        </button>
                    </div>
                </div>

                {showMenu && (
                    <div className="flex flex-col items-end gap-1.5 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                        {!isTyping && canReroll && (
                            <button onClick={() => { setShowMenu(false); setShowVoiceLangPicker(false); handleRerollClick(); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-black/40 backdrop-blur-md border-white/15 text-white hover:bg-white/20">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                                Regenerate
                            </button>
                        )}

                        {/* Voice: tapping while disabled directly enables it and expands the language picker; tapping while enabled expands/collapses the language picker (including a Turn Off option) */}
                        <button onClick={() => {
                                if (voiceEnabled) {
                                    setShowVoiceLangPicker(prev => !prev);
                                } else {
                                    updateCharacter(char.id, { dateVoiceEnabled: true });
                                    addToast('Voice enabled', 'info');
                                    setShowVoiceLangPicker(true);
                                }
                            }}
                            className={`h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all backdrop-blur-md ${voiceEnabled ? 'bg-white/20 border-white/30 text-white' : 'bg-black/40 border-white/15 text-white/60 hover:bg-white/20'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                {voiceEnabled
                                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                                    : <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />}
                            </svg>
                            Voice{voiceEnabled ? (voiceLang ? ` · ${voiceLanguageLabel(voiceLang)}` : ' · On') : ' · Off'}
                        </button>
                        {voiceEnabled && showVoiceLangPicker && (
                            <div className="flex flex-wrap justify-end gap-1 max-w-[200px] animate-fade-in">
                                {VOICE_LANGUAGE_OPTIONS.map(opt => (
                                    <button key={opt.value} onClick={() => { updateCharacter(char.id, { dateVoiceLang: opt.value }); trackEvent('Set Date Voice Language', { Language: voiceLanguageAnalyticsValue(opt.value) }); setShowVoiceLangPicker(false); }}
                                        className={`h-7 px-2.5 rounded-full text-[10px] font-bold transition-all active:scale-95 whitespace-nowrap ${voiceLang === opt.value ? 'bg-white/30 text-white shadow-md' : 'bg-black/30 backdrop-blur-md text-white/60 border border-white/10'}`}>
                                        {opt.label}
                                    </button>
                                ))}
                                <button onClick={() => { updateCharacter(char.id, { dateVoiceEnabled: false }); setShowVoiceLangPicker(false); addToast('Voice disabled', 'info'); }}
                                    className="h-7 px-2.5 rounded-full text-[10px] font-bold transition-all active:scale-95 whitespace-nowrap bg-red-500/50 text-white border border-red-300/40 shadow-md">
                                    Turn Off Voice
                                </button>
                            </div>
                        )}

                        <button onClick={() => { setIsNovelMode(!isNovelMode); exitBatchMode(); setShowMenu(false); setShowVoiceLangPicker(false); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-black/40 backdrop-blur-md border-white/15 text-white hover:bg-white/20">
                            {isNovelMode ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>
                            )}
                            {isNovelMode ? 'Visual Mode' : 'Reading Mode'}
                        </button>

                        {isNovelMode && char.dateLightReading && !isBatchSelectMode && (
                            <button onClick={() => { setIsBatchSelectMode(true); setShowMenu(false); setShowVoiceLangPicker(false); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-black/40 backdrop-blur-md border-white/15 text-white hover:bg-white/20">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                                Multi-select
                            </button>
                        )}

                        {/* OBSERVE protocol toggle: once enabled, replies come with a "time/location/status/detail" holographic HUD */}
                        <button onClick={() => {
                                const next = !observeEnabled;
                                updateCharacter(char.id, { dateObserve: { ...char.dateObserve, enabled: next } });
                                addToast(next ? 'Observation enabled · effective next reply' : 'Observation disabled', 'info');
                                setShowMenu(false); setShowVoiceLangPicker(false);
                            }}
                            className={`h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all backdrop-blur-md ${observeEnabled ? 'bg-cyan-400/20 border-cyan-300/40 text-cyan-50' : 'bg-black/40 border-white/15 text-white/60 hover:bg-white/20'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                            Observe{observeEnabled ? ' · On' : ' · Off'}
                        </button>

                        <button onClick={() => { setShowSettings(true); setShowMenu(false); setShowVoiceLangPicker(false); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-black/40 backdrop-blur-md border-white/15 text-white hover:bg-white/20">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 2.555c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.212 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-2.555c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                            Scene Settings
                        </button>

                        <button onClick={() => { setShowMenu(false); setShowVoiceLangPicker(false); setShowExitModal(true); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-red-500/70 backdrop-blur-md border-white/20 text-white hover:bg-red-600">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" /></svg>
                            Leave
                        </button>
                    </div>
                )}
            </div>

            {/* OBSERVE protocol — floating HUD in Visual Mode (top-left, can be viewed/enlarged independently) */}
            {observeEnabled && !isNovelMode && hasObservation(observation) && (
                <div className="absolute top-0 left-0 p-4 pt-12 z-[90] pointer-events-none">
                    <div className="pointer-events-auto">
                        <ObserveHUD observation={observation!} variant="hud" charName={char.name} config={char.dateObserve} />
                    </div>
                </div>
            )}

            {/* Novel Mode View */}
            {isNovelMode && (
                <div ref={novelScrollRef} className={`absolute inset-0 z-20 overflow-y-auto no-scrollbar pt-24 pb-32 px-8 mask-image-gradient overscroll-contain ${char.dateLightReading ? 'bg-[#faf8f5]' : 'bg-black/90 backdrop-blur-sm'}`} onClick={(e) => { e.stopPropagation(); if (showMenu) { setShowMenu(false); setShowVoiceLangPicker(false); return; } setShowInputBox(true); }}>
                    <div className="min-h-full flex flex-col justify-end">
                        <div className="max-w-2xl mx-auto animate-fade-in space-y-6">
                            {isBatchSelectMode && (
                                <div className="sticky top-0 z-20 flex items-center justify-between bg-white/90 border border-stone-200 rounded-xl px-3 py-2 text-xs text-stone-700">
                                    <span>{selectedMsgIds.size} selected</span>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); exitBatchMode(); }}
                                            className="px-3 py-1 rounded-full bg-stone-200 text-stone-600"
                                        >Done</button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleBatchDelete(); }}
                                            disabled={selectedMsgIds.size === 0}
                                            className="px-3 py-1 rounded-full bg-red-500 text-white disabled:opacity-40"
                                        >Delete</button>
                                    </div>
                                </div>
                            )}
                            {sessionMessages.length === 0 && peekStatus && (() => {
                                const { observation: peekObs, rest: peekBody } = extractObservation(peekStatus, { lenient: observeEnabled, custom: char.dateObserve?.custom });
                                return (
                                    <>
                                        {observeEnabled && hasObservation(peekObs) && (
                                            <div className="max-w-md mx-auto mb-6"><ObserveHUD observation={peekObs} variant="card" charName={char.name} config={char.dateObserve} /></div>
                                        )}
                                        <div className={`italic text-center text-sm mb-8 px-4 ${char.dateLightReading ? 'text-stone-400' : 'text-slate-200/50'}`}>
                                            {cleanTextForDisplay(peekBody).split('\n').map((line, idx) => line.trim() && <p key={idx} className="whitespace-pre-wrap leading-relaxed tracking-wide my-2">{line}</p>)}
                                        </div>
                                    </>
                                );
                            })()}
                            {(hiddenNovelMessageCount > 0 || !historyReachedEnd) && (
                                <div className="flex justify-center">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            // If there's more locally that isn't shown yet, just widen the window;
                                            // once fully filled, fetch an earlier batch from the DB — otherwise
                                            // Date history beyond the initial window would be unreachable in Reading Mode forever.
                                            const plan = planNovelLoadMore({
                                                loadedCount: sessionMessages.length,
                                                visibleCount: novelVisibleCount,
                                                windowStep: NOVEL_MESSAGE_LOAD_STEP,
                                                loadLimit: historyLoadLimit,
                                                loadStep: NOVEL_HISTORY_FETCH_STEP,
                                                reachedDbEnd: historyReachedEnd,
                                            });
                                            setNovelVisibleCount(plan.nextVisibleCount);
                                            if (plan.nextLoadLimit !== null) void onLoadMoreHistory?.(plan.nextLoadLimit);
                                        }}
                                        className={`px-4 py-2 rounded-full text-xs font-bold border active:scale-95 transition-transform ${
                                            char.dateLightReading
                                                ? 'bg-stone-100 text-stone-500 border-stone-200'
                                                : 'bg-white/10 text-white/60 border-white/10'
                                        }`}
                                    >
                                        Load Earlier Date History{hiddenNovelMessageCount > 0 ? ` (${hiddenNovelMessageCount})` : ''}
                                    </button>
                                </div>
                            )}
                            {visibleSessionMessages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`group relative rounded-xl transition-colors -mx-4 px-4 py-2 ${isBatchSelectMode ? 'pl-10' : ''} ${char.dateLightReading ? 'active:bg-stone-100' : 'active:bg-white/5'}`}
                                    onClick={(e) => {
                                        if (!isBatchSelectMode) return;
                                        e.stopPropagation();
                                        toggleSelectedMsg(msg.id);
                                    }}
                                    onTouchStart={(e) => handleMsgTouchStart(e, msg)}
                                    onTouchEnd={handleMsgTouchEnd}
                                    onTouchMove={handleMsgTouchMove}
                                    onMouseDown={(e) => handleMsgTouchStart(e, msg)}
                                    onMouseUp={handleMsgTouchEnd}
                                    onMouseMove={handleMsgTouchMove}
                                    onMouseLeave={handleMsgTouchEnd}
                                    onContextMenu={(e) => { e.preventDefault(); if (!isBatchSelectMode) { setSelectedMessage(msg); setModalType('options'); } }}
                                >
                                    {isBatchSelectMode && (
                                        <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selectedMsgIds.has(msg.id) ? 'bg-primary border-primary' : 'bg-white border-stone-300'}`}>
                                            {selectedMsgIds.has(msg.id) && <span className="text-white text-[10px]">✓</span>}
                                        </div>
                                    )}
                                    {msg.role === 'user' ? (
                                        <div className="flex min-w-0 items-start justify-end gap-3">
                                            <p className={`min-w-0 flex-1 whitespace-pre-wrap font-serif text-[16px] text-right leading-loose tracking-wide italic pr-4 ${char.dateLightReading ? 'text-stone-400 border-r-2 border-stone-300/50' : 'text-slate-400 border-r-2 border-slate-600/50'}`}>{cleanTextForDisplay(msg.content)} <span className="text-[10px] uppercase font-sans not-italic ml-2 opacity-50">{userProfile.name}</span></p>
                                            {char.dateReadingShowAvatars && (
                                                <ReadingAvatar
                                                    src={userProfile.perCharAvatars?.[char.id] || userProfile.avatar}
                                                    name={userProfile.name}
                                                    light={!!char.dateLightReading}
                                                />
                                            )}
                                        </div>
                                    ) : (() => {
                                        // OBSERVE protocol: strip the observation block out of this reply, render it as a standalone card above the body text; the body itself doesn't show the block's raw text
                                        const { observation: msgObs, rest: msgBody } = extractObservation(msg.content || '', { lenient: observeEnabled, custom: char.dateObserve?.custom });
                                        return (
                                        <div className="flex min-w-0 items-start gap-3">
                                            {char.dateReadingShowAvatars && (
                                                <ReadingAvatar src={char.avatar} name={char.name} light={!!char.dateLightReading} />
                                            )}
                                            <div className="min-w-0 flex-1">
                                                {observeEnabled && hasObservation(msgObs) && (
                                                    <ObserveHUD observation={msgObs} variant="card" charName={char.name} config={char.dateObserve} />
                                                )}
                                                {(msgBody || '').split('\n').map((line, idx) => {
                                                const cleanLine = cleanTextForDisplay(line);
                                                if (!cleanLine) return null;
                                                const lineIsDialogue = isDialogueLine(line);
                                                const lineKey = `${msg.id}-${idx}`;
                                                const isOpeningMsg = msg.metadata?.isOpening === true;
                                                const parsedVoiceLine = extractVoiceEmotionTag(line);
                                                const dialogueText = extractDialogueText(parsedVoiceLine.rest);
                                                const voiceTarget: DateVoiceFavoriteTarget = {
                                                    sourceKey: `${char.id}:${lineKey}`,
                                                    originalText: dialogueText,
                                                    sourceTimestamp: msg.timestamp,
                                                    voiceEmotion: parsedVoiceLine.voiceEmotion,
                                                };
                                                return (
                                                    <div
                                                        key={idx}
                                                        className="flex items-start gap-1 mb-4 last:mb-0"
                                                        onClick={(e) => {
                                                            if (!voiceFavoriteLongPressTriggered.current) return;
                                                            e.stopPropagation();
                                                            voiceFavoriteLongPressTriggered.current = false;
                                                        }}
                                                        onTouchStart={voiceEnabled && lineIsDialogue && !isOpeningMsg ? (e) => startDateVoiceLongPress(e, voiceTarget) : undefined}
                                                        onTouchMove={voiceEnabled && lineIsDialogue && !isOpeningMsg ? endDateVoiceLongPress : undefined}
                                                        onTouchEnd={voiceEnabled && lineIsDialogue && !isOpeningMsg ? endDateVoiceLongPress : undefined}
                                                        onMouseDown={voiceEnabled && lineIsDialogue && !isOpeningMsg ? (e) => e.stopPropagation() : undefined}
                                                        onContextMenu={voiceEnabled && lineIsDialogue && !isOpeningMsg ? (e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(voiceTarget); } : undefined}
                                                    >
                                                        <p className={`flex-1 whitespace-pre-wrap font-serif text-[18px] text-justify leading-loose tracking-wide pl-4 ${char.dateLightReading ? 'text-stone-700 border-l-2 border-stone-200' : 'text-slate-200 drop-shadow-md border-l-2 border-white/10'}`}>{renderLineWithDialogueHighlight(cleanLine)}</p>
                                                        {/* Voice button: only for dialogue lines, not opening */}
                                                        {voiceEnabled && lineIsDialogue && !isOpeningMsg && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (voiceFavoriteLongPressTriggered.current) { voiceFavoriteLongPressTriggered.current = false; return; }
                                                                    handleNovelLinePlay(lineKey, dialogueText, parsedVoiceLine.voiceEmotion);
                                                                }}
                                                                onTouchStart={(e) => startDateVoiceLongPress(e, voiceTarget)}
                                                                onTouchMove={endDateVoiceLongPress}
                                                                onTouchEnd={endDateVoiceLongPress}
                                                                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(voiceTarget); }}
                                                                title="Play; long-press to favorite"
                                                                className={`shrink-0 mt-2 w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 select-none ${
                                                                    novelPlayingId === lineKey
                                                                        ? (char.dateLightReading ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-500/20 text-emerald-300')
                                                                        : (char.dateLightReading ? 'bg-stone-100 text-stone-400 hover:bg-stone-200' : 'bg-white/5 text-white/40 hover:bg-white/10')
                                                                }`}
                                                            >
                                                                {novelVoiceLoading.has(lineKey) ? (
                                                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                                                ) : novelPlayingId === lineKey ? (
                                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z" /></svg>
                                                                ) : (
                                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                                                )}
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                                })}
                                            </div>
                                        </div>
                                        ); })()}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Visual Mode View */}
            {!isNovelMode && (
                <>
                    <div className="absolute inset-x-0 bottom-0 h-[90%] flex items-end justify-center pointer-events-none z-10 overflow-hidden">
                        {currentSprite && <TokenImg value={currentSprite} className="max-h-full max-w-full object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,0.5)] transition-all duration-300 origin-bottom" style={{ filter: showInputBox ? 'brightness(1)' : (isTextAnimating ? 'brightness(1.05)' : 'brightness(1)'), transform: `translate(${spriteConfig.x}%, ${spriteConfig.y}%) scale(${isTextAnimating ? spriteConfig.scale * 1.02 : spriteConfig.scale})` }} />}
                    </div>
                    {!isTyping && (
                        <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center">
                            <div
                                className="w-[90%] max-w-lg bg-black/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 min-h-[140px] shadow-2xl animate-slide-up hover:bg-black/70 cursor-pointer"
                                onTouchStart={voiceEnabled && !isTextAnimating && !isShowingOpening && isDialogueLine(currentText) ? (e) => startDateVoiceLongPress(e, resolveCurrentDateVoiceTarget()) : undefined}
                                onTouchMove={voiceEnabled && !isTextAnimating && !isShowingOpening && isDialogueLine(currentText) ? endDateVoiceLongPress : undefined}
                                onTouchEnd={voiceEnabled && !isTextAnimating && !isShowingOpening && isDialogueLine(currentText) ? endDateVoiceLongPress : undefined}
                                onContextMenu={voiceEnabled && !isTextAnimating && !isShowingOpening && isDialogueLine(currentText) ? (e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(resolveCurrentDateVoiceTarget()); } : undefined}
                            >
                                <div className="absolute -top-3 left-6 flex items-center gap-2">
                                    <div className="bg-white/90 text-black px-4 py-1 rounded-sm text-xs font-bold tracking-widest uppercase shadow-[0_4px_10px_rgba(0,0,0,0.3)] transform -skew-x-12">{char.name}</div>
                                    {/* Voice play button next to name */}
                                    {voiceEnabled && !isTextAnimating && !isShowingOpening && isDialogueLine(currentText) && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (voiceFavoriteLongPressTriggered.current) { voiceFavoriteLongPressTriggered.current = false; return; }
                                                handleGalVoiceToggle();
                                            }}
                                            onTouchStart={(e) => startDateVoiceLongPress(e, resolveCurrentDateVoiceTarget())}
                                            onTouchMove={endDateVoiceLongPress}
                                            onTouchEnd={endDateVoiceLongPress}
                                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(resolveCurrentDateVoiceTarget()); }}
                                            title="Play; long-press to favorite"
                                            className={`w-6 h-6 rounded-full flex items-center justify-center transition-all active:scale-90 ${dateVoicePlaying ? 'bg-white/30 text-white/90' : 'bg-white/10 text-white/40 hover:bg-white/20'}`}
                                        >
                                            {galVoiceLoading ? (
                                                <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                            ) : dateVoicePlaying ? (
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z" /></svg>
                                            ) : (
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                            )}
                                        </button>
                                    )}
                                </div>
                                <p className="text-white/90 text-[16px] leading-relaxed font-light tracking-wide drop-shadow-md mt-2">{displayedText}{isTextAnimating && <span className="inline-block w-2 h-4 bg-white/70 ml-1 animate-pulse align-middle"></span>}</p>
                                {!isTextAnimating && dialogueQueue.length > 0 && <div className="absolute bottom-3 right-4 animate-bounce opacity-70"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white"><path fillRule="evenodd" d="M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z" clipRule="evenodd" /></svg></div>}
                                {!isTextAnimating && dialogueQueue.length === 0 && dialogueBatch.length > 0 && <div className="absolute bottom-3 right-4 opacity-50 text-[10px] text-white flex items-center gap-1 animate-pulse"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>Loop</div>}
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Input Layer */}
            <div className={`absolute inset-x-0 bottom-0 z-40 flex justify-center pointer-events-none transition-all duration-300 ${isTyping || showInputBox ? 'opacity-100' : 'opacity-0'}`}>
                {isTyping && (
                    <div className="absolute bottom-1/2 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-auto">
                        <div className="bg-black/80 backdrop-blur-md px-6 py-3 rounded-full border border-white/20 shadow-2xl animate-pulse flex items-center gap-3">
                             <div className="flex gap-1.5"><div className="w-2 h-2 bg-white rounded-full animate-bounce"></div><div className="w-2 h-2 bg-white rounded-full animate-bounce delay-75"></div><div className="w-2 h-2 bg-white rounded-full animate-bounce delay-150"></div></div>
                             <span className="text-xs text-white font-bold tracking-widest uppercase">Typing...</span>
                        </div>
                    </div>
                )}
                {showInputBox && (
                    <div className={`w-[90%] min-w-0 max-w-lg backdrop-blur-xl rounded-2xl p-2 flex gap-2 shadow-2xl animate-fade-in mb-8 pointer-events-auto ${char.dateLightReading ? 'bg-stone-100 border border-stone-300' : 'bg-white/10 border border-white/20'}`} onClick={(e) => e.stopPropagation()}>
                        <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={isTyping ? "Waiting for response..." : "Type a message..."} disabled={isTyping} className={`min-w-0 flex-1 bg-transparent px-3 sm:px-4 py-3 outline-none font-light resize-none h-14 no-scrollbar leading-tight ${char.dateLightReading ? 'text-stone-800 placeholder:text-stone-400' : 'text-white placeholder:text-white/30'}`} autoFocus />
                        {(() => {
                            const retryText = pendingRetryText || getPendingReplyText(messages);
                            const canRetry = !input.trim() && !isTyping && !!retryText;
                            return (
                                <button
                                    onClick={handleSend}
                                    disabled={(!input.trim() && !canRetry) || isTyping}
                                    className="shrink-0 px-4 sm:px-6 bg-white text-black rounded-xl font-bold text-sm hover:bg-slate-200 disabled:opacity-50 transition-colors h-14 flex items-center justify-center"
                                >
                                    {canRetry ? 'Retry' : 'Send'}
                                </button>
                            );
                        })()}
                    </div>
                )}
            </div>

            {/* Settings Overlay */}
            {showSettings && (
                <div className="absolute inset-0 z-[200] animate-slide-up bg-white">
                    <DateSettings char={char} onBack={() => setShowSettings(false)} />
                </div>
            )}

            <VoiceFavoriteActionSheet
                open={!!voiceFavoriteTarget}
                favorited={voiceFavoriteSaved}
                busy={voiceFavoriteBusy}
                title="Date Voice"
                preview={voiceFavoriteTarget?.originalText}
                onToggle={() => void toggleDateVoiceFavorite()}
                onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
            />

            {/* Exit Modal */}
            <Modal isOpen={showExitModal} title="Leave for now?" onClose={() => setShowExitModal(false)} footer={<div className="flex gap-3 w-full"><button onClick={() => setShowExitModal(false)} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">Stay here</button><button onClick={handleExitClick} className="flex-1 py-3 bg-slate-800 text-white rounded-2xl font-bold">Save & Exit</button></div>}>
                <div className="text-center text-slate-500 text-sm py-2 leading-relaxed">Choosing "Save & Exit" will keep your current conversation progress.<br/>Next time you Date, you can choose to continue the topic.</div>
            </Modal>

            {/* Message Options Modal */}
            <Modal isOpen={modalType === 'options'} title="Actions" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={() => {
                        if (selectedMessage) {
                            setIsBatchSelectMode(true);
                            setSelectedMsgIds(new Set([selectedMessage.id]));
                        }
                        setModalType('none');
                    }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">Multi-select</button>
                    <button onClick={() => {
                        if (selectedMessage) {
                            const clean = (selectedMessage.content || '').replace(/\[.*?\]/g, '').trim();
                            navigator.clipboard.writeText(clean).then(() => addToast('Copied', 'success')).catch(() => addToast('Copy failed', 'error'));
                        }
                        setModalType('none');
                    }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">Copy Text</button>
                    <button onClick={() => { onEditMessage(selectedMessage!); setModalType('none'); }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">Edit</button>
                    <button onClick={() => { onDeleteMessage(selectedMessage!); setModalType('none'); }} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl">Delete</button>
                </div>
            </Modal>
        </div>
    );
};

export default DateSession;
