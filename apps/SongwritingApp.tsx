
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { SongSheet, SongLine, SongComment, SongMood, SongGenre, SongAudio, MusicProvider, SongTemplateSection, LyricCoWritingStyle, AppID } from '../types';
import {
    SONG_GENRES,
    SONG_MOODS,
    SECTION_LABELS,
    COVER_STYLES,
    SongPrompts,
    LYRIC_TEMPLATES,
    LYRIC_CO_WRITING_STYLES,
    LYRIC_STYLE_CATEGORIES,
    getLyricTemplate,
    getLyricCoWritingStyle,
    extractGeneratedLyricLine,
    type LyricStyleCategory,
} from '../utils/songPrompts';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { DB } from '../utils/db';
import { putImageBlob, useBlobRefUrl, resolveRefToDataUrl } from '../utils/blobRef';
import {
    synthesizeSong,
    buildAceStepTags,
    buildAceStepLyrics,
    hashSongInputs,
    loadSongAudioBlob,
    generatePromptViaLLM,
    VOICE_PRESETS,
    type AceStepInput,
} from '../utils/aceStepApi';
import {
    synthesizeSongMinimax,
    buildMinimaxMusicPrompt,
    buildMinimaxMusicLyrics,
    hashMinimaxMusicInputs,
    loadMinimaxMusicBlob,
    type MinimaxMusicInput,
} from '../utils/minimaxMusic';
import { C as MusicC, Sparkle, CrossStar, GlassProgress, MetaChip } from './music/MusicUI';
import Modal from '../components/os/Modal';
import ConfirmDialog from '../components/os/ConfirmDialog';
import TokenImg from '../components/os/TokenImg';
import {
    Check, PencilSimple,
    Sparkle as SparkleP, Butterfly, Feather, Lightning, MicrophoneStage,
    MusicNotes, Wind, Cookie, UsersThree, Heart, Diamond, MusicNoteSimple,
    HeartStraight, UploadSimple, ChatCircleDots, BookOpenText, ArrowsClockwise,
    Plus, Trash,
} from '@phosphor-icons/react';
import { useMusic, type Song as MusicSong } from '../context/MusicContext';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';

// --- Helper Components ---

// Phosphor icon map for voice presets — replaces flat emoji with weighted line art
const VOICE_ICONS: Record<string, React.ComponentType<any>> = {
    'auto':         SparkleP,
    'female-sweet': Butterfly,
    'female-soft':  Feather,
    'female-rock':  Lightning,
    'male-deep':    MicrophoneStage,
    'male-high':    MusicNotes,
    'male-soft':    Wind,
    'child':        Cookie,
    'duet':         UsersThree,
};

// Phosphor icon map for music providers (used in modal segmented picker)
const PROVIDER_ICONS: Record<string, React.ComponentType<any>> = {
    'minimax-free': Heart,
    'minimax-paid': Diamond,
    'ace-step':     MusicNoteSimple,
};

const SectionBadge: React.FC<{ section: string; small?: boolean }> = ({ section, small }) => {
    const info = SECTION_LABELS[section] || { label: section, color: 'bg-stone-200/60 text-stone-600' };
    return (
        <span className={`${info.color} ${small ? 'text-[8px] px-1.5 py-0.5 tracking-wider' : 'text-[9px] px-2 py-0.5 tracking-wider'} rounded font-medium uppercase`}>
            {info.label}
        </span>
    );
};

type TimelineItem = { kind: 'line'; data: SongLine } | { kind: 'feedback'; data: { id: string; timestamp: number; reaction?: SongComment; details: SongComment[] } } | { kind: 'pending'; data: SongLine };

function mkLineItem(l: SongLine): TimelineItem { return { kind: 'line', data: l }; }
function mkLineItem2(group: { id: string; timestamp: number; reaction?: SongComment; details: SongComment[] }): TimelineItem { return { kind: 'feedback', data: group }; }
function mkPendingItem(l: SongLine): TimelineItem { return { kind: 'pending', data: l }; }

type LyricSlot = {
    index: number;
    section: SongLine['section'];
    chars: string;
    sectionOccurrence: number;
    lineInSection: number;
};

// SECTION_LABELS is declared as Record<string, …>, so a key pulled off of it
// is narrowed down to just string. Here we narrow the section key back to
// SongLine['section']. The only keys actually in use are these seven,
// falling back to the section picker's initial value 'verse'.
const toSectionKind = (value: string): SongLine['section'] => {
    switch (value) {
        case 'intro':
        case 'verse':
        case 'pre-chorus':
        case 'chorus':
        case 'bridge':
        case 'outro':
        case 'free':
            return value;
        default:
            return 'verse';
    }
};

type PaperTheme = {
    background: string;
    ink: string;
    muted: string;
    rule: string;
    accent: string;
    sheet: string;
};

const PAPER_THEMES: Record<string, PaperTheme> = {
    'kraft-paper': { background: '#ead7b6', ink: '#49392a', muted: '#8a7056', rule: 'rgba(113,82,51,.18)', accent: '#a6634a', sheet: 'rgba(255,248,232,.72)' },
    'old-photo':   { background: '#e9dfc8', ink: '#494137', muted: '#887b68', rule: 'rgba(92,77,57,.16)', accent: '#a87958', sheet: 'rgba(255,252,239,.74)' },
    'ink-wash':    { background: '#dce0e2', ink: '#293136', muted: '#69747a', rule: 'rgba(42,53,60,.14)', accent: '#596d77', sheet: 'rgba(250,252,252,.72)' },
    'dried-rose':  { background: '#ead9d9', ink: '#543b42', muted: '#916f78', rule: 'rgba(108,65,77,.14)', accent: '#a96679', sheet: 'rgba(255,248,248,.72)' },
    'midnight':    { background: '#1e2025', ink: '#f0e9df', muted: '#b7ada2', rule: 'rgba(255,255,255,.12)', accent: '#d8a9b8', sheet: 'rgba(34,37,43,.82)' },
    'linen':       { background: '#eeece6', ink: '#3f3d39', muted: '#817d75', rule: 'rgba(77,73,66,.13)', accent: '#827b91', sheet: 'rgba(255,255,252,.75)' },
    'tea-stain':   { background: '#eee0bd', ink: '#4d412f', muted: '#8d7756', rule: 'rgba(110,83,44,.15)', accent: '#a77645', sheet: 'rgba(255,249,229,.72)' },
    'forest':      { background: '#d9e1d8', ink: '#2f4033', muted: '#6e806f', rule: 'rgba(45,75,52,.14)', accent: '#668267', sheet: 'rgba(248,253,247,.72)' },
};

const getPaperTheme = (styleId: string): PaperTheme => {
    if (!styleId.startsWith('custom:')) return PAPER_THEMES[styleId] || PAPER_THEMES.linen;
    const palette = styleId.slice('custom:'.length).split('-');
    const from = palette[0] || '#f4c2cf';
    const via = palette[1] || '#cfc3e8';
    const to = palette[2] || '#9bcbf8';
    return {
        background: `linear-gradient(145deg, ${from} 0%, ${via} 52%, ${to} 100%)`,
        ink: '#2f2a38',
        muted: 'rgba(47,42,56,.62)',
        rule: 'rgba(47,42,56,.13)',
        accent: via,
        sheet: 'rgba(255,255,255,.68)',
    };
};

const buildLyricSlots = (song: SongSheet): LyricSlot[] => {
    const structure = song.lyricTemplate === 'custom'
        ? (song.customLyricTemplate || [])
        : getLyricTemplate(song.lyricTemplate).structure;
    const occurrences: Record<string, number> = {};
    const slots: LyricSlot[] = [];
    structure.forEach(section => {
        const occurrence = occurrences[section.section] || 0;
        occurrences[section.section] = occurrence + 1;
        for (let i = 0; i < section.lines; i++) {
            slots.push({
                index: slots.length,
                section: section.section,
                chars: section.chars,
                sectionOccurrence: occurrence,
                lineInSection: i,
            });
        }
    });
    return slots;
};

// --- Main App ---

const SongwritingApp: React.FC = () => {
    const { closeApp, openApp, songs, addSong, updateSong, deleteSong, characters, apiConfig, addToast, userProfile, characterGroups } = useOS();
    const { addLocalSong, removeLocalSong, localAlbumSongs, playSong, current: currentMusicSong, markRegenerating } = useMusic();

    // Navigation
    const [view, setView] = useState<'shelf' | 'create' | 'partner' | 'write' | 'preview'>('shelf');
    const [activeSong, setActiveSong] = useState<SongSheet | null>(null);

    // Create Form State
    const [tempTitle, setTempTitle] = useState('');
    const [tempSubtitle, setTempSubtitle] = useState('');
    const [tempGenre, setTempGenre] = useState<SongGenre>('pop');
    const [tempMood, setTempMood] = useState<SongMood>('happy');
    const [tempLyricStyle, setTempLyricStyle] = useState<LyricCoWritingStyle>('adaptive');
    const [tempLyricStyleCategory, setTempLyricStyleCategory] = useState<LyricStyleCategory>('chinese');
    const [tempCollaboratorId, setTempCollaboratorId] = useState('');
    const [partnerGroupId, setPartnerGroupId] = useState(GROUP_FILTER_ALL); // Group filter for the co-writer page
    const [tempCoverStyle, setTempCoverStyle] = useState(COVER_STYLES[0]?.id || 'dawn-blush');
    const [tempTemplate, setTempTemplate] = useState<string>('free');
    const [tempCustomSections, setTempCustomSections] = useState<SongTemplateSection[]>([
        { section: 'verse', lines: 4, chars: '8-12' },
        { section: 'chorus', lines: 4, chars: '6-10' },
    ]);
    const [showStructureBanner, setShowStructureBanner] = useState(true);
    const [customCoverFrom, setCustomCoverFrom] = useState('#FB7185');
    const [customCoverVia, setCustomCoverVia] = useState('#A855F7');
    const [customCoverTo, setCustomCoverTo] = useState('#2563EB');

    // Write View State
    const [inputText, setInputText] = useState('');
    const [currentSection, setCurrentSection] = useState<SongLine['section']>('verse');
    const [isTyping, setIsTyping] = useState(false);
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [showStructureGuide, setShowStructureGuide] = useState(false);
    const [showLyricStylePicker, setShowLyricStylePicker] = useState(false);
    const [lyricStyleCategory, setLyricStyleCategory] = useState<LyricStyleCategory>('chinese');
    const [expandedFeedbackIds, setExpandedFeedbackIds] = useState<Record<string, boolean>>({});
    const [workMode, setWorkMode] = useState<'notebook' | 'chat'>('notebook');
    const [lineDrafts, setLineDrafts] = useState<Record<number, string>>({});
    const [generatingSlotIndex, setGeneratingSlotIndex] = useState<number | null>(null);

    // Pending candidate lines (not yet committed to song)
    const [pendingLines, setPendingLines] = useState<SongLine[]>([]);

    // Modals
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; title: string; message: string; variant: 'danger' | 'warning' | 'info'; confirmText?: string; onConfirm: () => void } | null>(null);
    const [showPreviewModal, setShowPreviewModal] = useState(false);
    const [completionReview, setCompletionReview] = useState('');
    const [isCompleting, setIsCompleting] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const [shareGroupId, setShareGroupId] = useState(GROUP_FILTER_ALL); // Group filter for the share-sheet modal (shared semantics between the shelf and preview views)
    const [shareTargetCharId, setShareTargetCharId] = useState('');

    // ACE-Step audio synth (preview view)
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
    const [audioGenStatus, setAudioGenStatus] = useState<string>('');
    const [audioError, setAudioError] = useState<string | null>(null);
    const audioAbortRef = useRef<AbortController | null>(null);
    // Track which song the current blob: URL belongs to so we can revoke it on switch
    const currentAudioOwnerRef = useRef<string | null>(null);
    // Voice preset (per-song, persisted in localStorage)
    const [voicePresetId, setVoicePresetIdState] = useState<string>('auto');
    // Unified "AI song guidance" modal — entry point now lives on the big button
    const [showCustomPrompt, setShowCustomPrompt] = useState(false);
    const [promptGuidance, setPromptGuidance] = useState('');
    const [promptDraft, setPromptDraft] = useState('');
    const [isAiWritingPrompt, setIsAiWritingPrompt] = useState(false);
    // Active music provider for the modal — defaults to whichever key the user has,
    // preferring free MiniMax over paid ACE-Step. Saved per song via SongSheet.musicProvider.
    const [provider, setProvider] = useState<MusicProvider>('minimax-free');
    // Custom shizuku-styled audio player state (replaces <audio controls>)
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playProgress, setPlayProgress] = useState(0);
    const [playDuration, setPlayDuration] = useState(0);
    // Cover confirm modal — opens between ❤︎ click and music-app jump
    type CoverMode = 'char' | 'user' | 'dual' | 'upload';
    const [showCoverConfirm, setShowCoverConfirm] = useState(false);
    const [coverMode, setCoverMode] = useState<CoverMode>('char');
    const [dualCoverUrl, setDualCoverUrl] = useState<string | null>(null);
    const [isBuildingDual, setIsBuildingDual] = useState(false);
    // Cooldown disabled — the backend can handle the load; leaving this at 0 makes every
    // cooldownSecsLeft > 0 branch naturally become dead code.
    const COOLDOWN_MS = 0;
    const [cooldownSecsLeft, setCooldownSecsLeft] = useState(0);

    const scrollRef = useRef<HTMLDivElement>(null);
    const coverUploadRef = useRef<HTMLInputElement>(null);
    const uploadedCoverUrl = useBlobRefUrl(activeSong?.coverImage);

    // Long press for mobile delete
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const touchStartPos = useRef({ x: 0, y: 0 });
    const [longPressLineId, setLongPressLineId] = useState<string | null>(null);

    const handleLineTouchStart = useCallback((e: React.TouchEvent, lineId: string) => {
        touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        longPressTimerRef.current = setTimeout(() => {
            setLongPressLineId(lineId);
        }, 500);
    }, []);

    const handleLineTouchMove = useCallback((e: React.TouchEvent) => {
        if (!longPressTimerRef.current) return;
        const dx = Math.abs(e.touches[0].clientX - touchStartPos.current.x);
        const dy = Math.abs(e.touches[0].clientY - touchStartPos.current.y);
        if (dx > 10 || dy > 10) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const handleLineTouchEnd = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    // Computed
    const collaborator = useMemo(() => {
        if (!activeSong) return null;
        return characters.find(c => c.id === activeSong.collaboratorId) || null;
    }, [activeSong, characters]);

    const getCoverStyle = (styleId: string) => COVER_STYLES.find(s => s.id === styleId) || COVER_STYLES[0];

    const isCustomCoverStyle = (styleId: string) => styleId.startsWith('custom:');

    const buildCustomCoverStyleId = (from: string = customCoverFrom, via: string = customCoverVia, to: string = customCoverTo) => `custom:${from}-${via}-${to}`;

    const updateCustomCoverColor = (position: 'from' | 'via' | 'to', color: string) => {
        const nextFrom = position === 'from' ? color : customCoverFrom;
        const nextVia = position === 'via' ? color : customCoverVia;
        const nextTo = position === 'to' ? color : customCoverTo;

        if (position === 'from') setCustomCoverFrom(color);
        if (position === 'via') setCustomCoverVia(color);
        if (position === 'to') setCustomCoverTo(color);

        setTempCoverStyle(buildCustomCoverStyleId(nextFrom, nextVia, nextTo));
    };

    const getCoverVisual = (styleId: string): { textClass: string; className: string; style: React.CSSProperties } => {
        if (!isCustomCoverStyle(styleId)) {
            const preset = getCoverStyle(styleId);
            return { textClass: preset.text, className: `bg-gradient-to-br ${preset.gradient}`, style: {} };
        }

        const [, palette = ''] = styleId.split(':');
        const [from = '#FB7185', via = '#A855F7', to = '#2563EB'] = palette.split('-');
        return {
            textClass: 'text-white',
            className: '',
            style: {
                backgroundImage: `linear-gradient(135deg, ${from} 0%, ${via} 50%, ${to} 100%)`,
                backgroundColor: from,
            }
        };
    };

    const feedbackGroups = useMemo(() => {
        if (!activeSong) return [] as { id: string; timestamp: number; reaction?: SongComment; details: SongComment[] }[];
        const groups = new Map<string, { id: string; timestamp: number; reaction?: SongComment; details: SongComment[] }>();
        activeSong.comments.forEach((comment) => {
            const match = comment.id.match(/^cmt-(\d+)-/);
            const key = match?.[1] || comment.id;
            if (!groups.has(key)) groups.set(key, { id: key, timestamp: Number(key) || comment.timestamp, details: [] });
            const group = groups.get(key)!;
            if (comment.type === 'reaction' && !group.reaction) {
                group.reaction = comment;
            } else {
                group.details.push(comment);
            }
        });
        return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
    }, [activeSong]);

    const toggleFeedback = (id: string) => {
        setExpandedFeedbackIds(prev => ({ ...prev, [id]: !prev[id] }));
    };

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [activeSong?.lines, activeSong?.comments, pendingLines, isTyping]);

    // --- CRUD ---

    /** Step 1 → step 2: validate basics, then jump to partner-pick view. */
    const handleGoPartner = () => {
        if (!tempTitle.trim()) { addToast('Please give the song a title', 'error'); return; }
        setView('partner');
    };

    const handleCreate = () => {
        if (!tempTitle.trim()) { addToast('Please give the song a title', 'error'); return; }
        if (!tempCollaboratorId) { addToast('Please pick a character as your co-writer', 'error'); return; }

        const newSong: SongSheet = {
            id: `song-${Date.now()}`,
            title: tempTitle,
            subtitle: tempSubtitle || undefined,
            genre: tempGenre,
            mood: tempMood,
            collaboratorId: tempCollaboratorId,
            lines: [],
            comments: [],
            status: 'draft',
            coverStyle: tempCoverStyle,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            lyricTemplate: tempTemplate || 'free',
            lyricCoWritingStyle: tempLyricStyle,
            customLyricTemplate: tempTemplate === 'custom'
                ? tempCustomSections.map(section => ({ ...section }))
                : undefined,
        };
        addSong(newSong);
        setActiveSong(newSong);
        setWorkMode('notebook');
        setLineDrafts({});
        setView('write');
        trackEvent('Enter Songsheet Writing Mode', {
            genre: newSong.genre,
            mood: newSong.mood,
            template: newSong.lyricTemplate || 'free',
        });
        resetTempState();
    };

    const resetTempState = () => {
        setTempTitle(''); setTempSubtitle(''); setTempGenre('pop'); setTempMood('happy'); setTempLyricStyle('adaptive'); setTempLyricStyleCategory('chinese');
        setTempCollaboratorId(''); setTempCoverStyle(COVER_STYLES[0]?.id || 'dawn-blush');
        setCustomCoverFrom('#FB7185'); setCustomCoverVia('#A855F7'); setCustomCoverTo('#2563EB');
        setTempTemplate('free');
        setTempCustomSections([
            { section: 'verse', lines: 4, chars: '8-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ]);
    };

    const handleDeleteSong = (id: string) => {
        setConfirmDialog({
            isOpen: true, title: 'Delete Song', message: 'Are you sure you want to delete this song? This cannot be undone.', variant: 'danger',
            onConfirm: () => {
                deleteSong(id);
                if (activeSong?.id === id) { setActiveSong(null); setView('shelf'); }
                setConfirmDialog(null);
                addToast('Deleted', 'success');
            }
        });
    };

    // --- AI Interaction ---

    const handleSendToAI = async (userMessage: string, addAsLine: boolean = false, requestedType?: 'inspiration' | 'discussion' | 'feedback') => {
        if (!activeSong || !collaborator) return;
        setIsTyping(true);
        setLastTokenUsage(null);

        let updatedSong = { ...activeSong };
        const requestTime = Date.now();

        // If user wrote lyrics, add as a pending candidate (not committed yet)
        if (addAsLine && userMessage.trim()) {
            const newLine: SongLine = {
                id: `line-${Date.now()}`,
                authorId: 'user',
                content: userMessage.trim(),
                section: currentSection,
                timestamp: Date.now(),
            };
            setPendingLines(prev => [...prev, newLine]);
        } else if (userMessage.trim()) {
            // Discussion is a real, persistent conversation, but it never mutates lyrics.
            const userComment: SongComment = {
                id: `chat-user-${requestTime}`,
                authorId: 'user',
                type: 'reaction',
                content: userMessage.trim(),
                timestamp: requestTime,
            };
            updatedSong = { ...updatedSong, comments: [...updatedSong.comments, userComment] };
            setActiveSong(updatedSong);
            await updateSong(updatedSong.id, { comments: updatedSong.comments });
        }

        try {
            // Fetch recent 200 messages for context
            const recentMessages = await DB.getRecentMessagesByCharId(collaborator.id, 200);
            const msgContext = recentMessages.slice(-20).map(m => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            }));

            await injectMemoryPalace(collaborator, undefined, `${updatedSong.title || ''} ${userMessage}`.trim() || undefined);
            const systemPrompt = SongPrompts.buildMentorSystemPrompt(collaborator, userProfile, updatedSong, msgContext);
            let userPrompt = SongPrompts.buildUserMessage(updatedSong, userMessage, currentSection);
            if (requestedType) {
                const typeHints: Record<string, string> = {
                    inspiration: '\n\n[Request Type]: inspiration — please reply in inspiration format, providing example lyrics and an explanation of the songwriting techniques used.',
                    discussion: '\n\n[Request Type]: discussion — please reply in discussion format, discussing creative direction and structure, without providing example lyrics.',
                    feedback: '\n\n[Request Type]: feedback — please reply in feedback format, giving feedback on the lyrics the user wrote.',
                };
                userPrompt += typeHints[requestedType] || '';
            }

            // Build messages array with recent chat context
            const apiMessages: { role: string; content: string }[] = [
                { role: 'system', content: systemPrompt },
            ];

            // Include last few song comments as conversation history
            const recentSongComments = updatedSong.comments.slice(-6);
            for (const c of recentSongComments) {
                apiMessages.push({
                    role: c.authorId === 'user' ? 'user' : 'assistant',
                    content: c.authorId === 'user'
                        ? c.content
                        : JSON.stringify({ type: 'feedback', reaction: c.content.substring(0, 50), feedback: c.content }),
                });
            }

            apiMessages.push({ role: 'user', content: userPrompt });

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: apiMessages, temperature: 0.8, max_tokens: 2000 })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                if (data.usage?.total_tokens) setLastTokenUsage(data.usage.total_tokens);

                const rawContent = data.choices[0].message.content.trim();
                const parsed = extractJson(rawContent);

                const newComments: SongComment[] = [];
                const baseTime = Date.now();

                if (parsed) {
                    // Add reaction as a comment
                    if (parsed.reaction) {
                        newComments.push({
                            id: `cmt-${baseTime}-r`,
                            authorId: collaborator.id,
                            type: 'reaction',
                            content: parsed.reaction,
                            timestamp: baseTime,
                        });
                    }

                    // Type-specific handling
                    if (parsed.type === 'feedback') {
                        if (parsed.feedback) {
                            newComments.push({
                                id: `cmt-${baseTime}-f`,
                                authorId: collaborator.id,
                                type: 'suggestion',
                                content: parsed.feedback,
                                timestamp: baseTime + 1,
                            });
                        }
                        if (parsed.teaching) {
                            newComments.push({
                                id: `cmt-${baseTime}-t`,
                                authorId: collaborator.id,
                                type: 'teaching',
                                content: parsed.teaching,
                                timestamp: baseTime + 2,
                            });
                        }
                        if (parsed.suggestion) {
                            newComments.push({
                                id: `cmt-${baseTime}-s`,
                                authorId: collaborator.id,
                                type: 'guidance',
                                content: parsed.suggestion,
                                timestamp: baseTime + 3,
                            });
                        }
                        if (parsed.encouragement) {
                            newComments.push({
                                id: `cmt-${baseTime}-e`,
                                authorId: collaborator.id,
                                type: 'praise',
                                content: parsed.encouragement,
                                timestamp: baseTime + 4,
                            });
                        }
                    } else if (parsed.type === 'inspiration') {
                        if (parsed.example_lines && Array.isArray(parsed.example_lines)) {
                            const exampleCandidates: SongLine[] = [];
                            for (let i = 0; i < parsed.example_lines.length; i++) {
                                exampleCandidates.push({
                                    id: `line-${baseTime}-ex${i}`,
                                    authorId: collaborator.id,
                                    content: parsed.example_lines[i],
                                    section: currentSection,
                                    annotation: 'Example reference',
                                    timestamp: baseTime + 10 + i,
                                });
                            }
                            setPendingLines(prev => [...prev, ...exampleCandidates]);
                        }
                        if (parsed.explanation) {
                            newComments.push({
                                id: `cmt-${baseTime}-exp`,
                                authorId: collaborator.id,
                                type: 'teaching',
                                content: parsed.explanation,
                                timestamp: baseTime + 5,
                            });
                        }
                        if (parsed.challenge) {
                            newComments.push({
                                id: `cmt-${baseTime}-ch`,
                                authorId: collaborator.id,
                                type: 'guidance',
                                content: parsed.challenge,
                                timestamp: baseTime + 6,
                            });
                        }
                    } else if (parsed.type === 'discussion') {
                        if (parsed.content) {
                            newComments.push({
                                id: `cmt-${baseTime}-d`,
                                authorId: collaborator.id,
                                type: 'guidance',
                                content: parsed.content,
                                timestamp: baseTime + 1,
                            });
                        }
                        if (parsed.question) {
                            newComments.push({
                                id: `cmt-${baseTime}-q`,
                                authorId: collaborator.id,
                                type: 'guidance',
                                content: parsed.question,
                                timestamp: baseTime + 2,
                            });
                        }
                    }
                } else {
                    // Fallback: treat raw text as general feedback
                    newComments.push({
                        id: `cmt-${baseTime}-raw`,
                        authorId: collaborator.id,
                        type: 'suggestion',
                        content: rawContent,
                        timestamp: baseTime,
                    });
                }

                const finalSong = {
                    ...updatedSong,
                    comments: [...updatedSong.comments, ...newComments],
                };
                setActiveSong(finalSong);
                await updateSong(finalSong.id, { comments: finalSong.comments });
            } else {
                throw new Error(`API Error: ${response.status}`);
            }
        } catch (e: any) {
            addToast('Request failed: ' + e.message, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    const handleSend = async () => {
        const text = inputText.trim();
        if (!text) return;
        setInputText('');
        await handleSendToAI(text, true, 'feedback');
    };

    const handleAskForHelp = async () => {
        setInputText('');
        trackEvent('Ask Co-writer for Inspiration');
        await handleSendToAI("I don't know how to write this, could you give me some inspiration and an example?", false, 'inspiration');
    };

    const handleDiscuss = async () => {
        trackEvent("Discuss What's Next With Co-writer");
        const text = inputText.trim();
        if (!text) return;
        setInputText('');
        await handleSendToAI(text, false, 'discussion');
    };

    // --- Delete Line ---
    const handleDeleteLine = (lineId: string) => {
        if (!activeSong) return;
        const newLines = activeSong.lines.filter(l => l.id !== lineId);
        const updated = { ...activeSong, lines: newLines };
        setActiveSong(updated);
        updateSong(updated.id, { lines: newLines });
    };

    // --- Delete Feedback Group (comments) ---
    const handleDeleteFeedback = (groupId: string) => {
        if (!activeSong) return;
        // Remove all comments whose id starts with `cmt-{groupId}-`
        const newComments = activeSong.comments.filter(c => {
            const match = c.id.match(/^cmt-(\d+)-/);
            const key = match?.[1] || c.id;
            return key !== groupId;
        });
        const updated = { ...activeSong, comments: newComments };
        setActiveSong(updated);
        updateSong(updated.id, { comments: newComments });
    };

    // --- Accept / Dismiss Pending Lines ---
    const handleAcceptPending = (lineId: string) => {
        if (!activeSong) return;
        const line = pendingLines.find(l => l.id === lineId);
        if (!line) return;
        const newLines = [...activeSong.lines, line];
        const updated = { ...activeSong, lines: newLines };
        setActiveSong(updated);
        updateSong(updated.id, { lines: newLines });
        setPendingLines(prev => prev.filter(l => l.id !== lineId));
        trackEvent("Accept Co-writer's Lyric Line");
    };

    const handleDismissPending = (lineId: string) => {
        if (!activeSong) { setPendingLines(prev => prev.filter(l => l.id !== lineId)); return; }
        const line = pendingLines.find(l => l.id === lineId);
        if (!line) return;
        // Save as draft instead of discarding — it stays in the record, just not as a final lyric
        const draftLine: SongLine = { ...line, isDraft: true };
        const newLines = [...activeSong.lines, draftLine];
        const updated = { ...activeSong, lines: newLines };
        setActiveSong(updated);
        updateSong(updated.id, { lines: newLines });
        setPendingLines(prev => prev.filter(l => l.id !== lineId));
    };

    // --- Restore Draft Line to Active ---
    const handleRestoreDraft = (lineId: string) => {
        if (!activeSong) return;
        const newLines = activeSong.lines.map(l => l.id === lineId ? { ...l, isDraft: false } : l);
        const updated = { ...activeSong, lines: newLines };
        setActiveSong(updated);
        updateSong(updated.id, { lines: newLines });
    };

    // --- Edit Line ---
    const [editingLineId, setEditingLineId] = useState<string | null>(null);
    const [editLineContent, setEditLineContent] = useState('');

    const startEditLine = (line: SongLine) => {
        setEditingLineId(line.id);
        setEditLineContent(line.content);
    };

    const saveEditLine = () => {
        if (!activeSong || !editingLineId) return;
        const newLines = activeSong.lines.map(l => l.id === editingLineId ? { ...l, content: editLineContent } : l);
        const updated = { ...activeSong, lines: newLines };
        setActiveSong(updated);
        updateSong(updated.id, { lines: newLines });
        setEditingLineId(null);
    };

    const lineAtSlot = useCallback((song: SongSheet, slotIndex: number): SongLine | undefined => {
        const activeLines = song.lines.filter(line => !line.isDraft);
        return activeLines.find(line => line.slotIndex === slotIndex)
            || activeLines.find((line, fallbackIndex) => line.slotIndex === undefined && fallbackIndex === slotIndex);
    }, []);

    const saveNotebookLine = useCallback(async (
        slot: LyricSlot,
        content: string,
        authorId: string = 'user',
    ) => {
        if (!activeSong) return;
        const nextContent = content.trim();
        const existing = lineAtSlot(activeSong, slot.index);
        let nextLines: SongLine[];

        if (!nextContent) {
            nextLines = existing
                ? activeSong.lines.filter(line => line.id !== existing.id)
                : activeSong.lines;
        } else if (existing) {
            nextLines = activeSong.lines.map(line => line.id === existing.id
                ? {
                    ...line,
                    content: nextContent,
                    authorId,
                    section: slot.section,
                    slotIndex: slot.index,
                    annotation: authorId === 'user' ? undefined : line.annotation,
                }
                : line);
        } else {
            nextLines = [
                ...activeSong.lines,
                {
                    id: `line-${Date.now()}-${slot.index}`,
                    authorId,
                    content: nextContent,
                    section: slot.section,
                    slotIndex: slot.index,
                    timestamp: Date.now(),
                },
            ];
        }
        nextLines = [...nextLines].sort((a, b) => {
            if (!!a.isDraft !== !!b.isDraft) return a.isDraft ? 1 : -1;
            const aOrder = a.slotIndex ?? Number.MAX_SAFE_INTEGER;
            const bOrder = b.slotIndex ?? Number.MAX_SAFE_INTEGER;
            return aOrder === bOrder ? a.timestamp - b.timestamp : aOrder - bOrder;
        });

        const updated = { ...activeSong, lines: nextLines };
        setActiveSong(updated);
        setLineDrafts(prev => ({ ...prev, [slot.index]: nextContent }));
        await updateSong(updated.id, { lines: nextLines });
    }, [activeSong, lineAtSlot, updateSong]);

    const handleGenerateNotebookLine = useCallback(async (slot: LyricSlot) => {
        if (!activeSong || !collaborator || generatingSlotIndex !== null) return;
        if (!apiConfig.baseUrl || !apiConfig.apiKey) {
            addToast('Please configure your AI model in Settings first.', 'error');
            return;
        }

        setGeneratingSlotIndex(slot.index);
        try {
            // Overlay any text that is still focused so C sees the complete notebook,
            // including edits that have not blurred yet.
            let snapshotLines = [...activeSong.lines];
            Object.entries(lineDrafts).forEach(([rawIndex, rawContent]) => {
                const index = Number(rawIndex);
                const content = rawContent.trim();
                if (!content) return;
                const existing = lineAtSlot({ ...activeSong, lines: snapshotLines }, index);
                const targetSlot = buildLyricSlots(activeSong)[index]
                    || { index, section: currentSection, chars: 'Unlimited', sectionOccurrence: 0, lineInSection: index };
                if (existing) {
                    snapshotLines = snapshotLines.map(line => line.id === existing.id
                        ? { ...line, content, section: targetSlot.section, slotIndex: index }
                        : line);
                } else {
                    snapshotLines.push({
                        id: `draft-context-${index}`,
                        authorId: 'user',
                        content,
                        section: targetSlot.section,
                        slotIndex: index,
                        timestamp: Date.now() + index,
                    });
                }
            });

            const snapshot = { ...activeSong, lines: snapshotLines };
            // Query hint left in Chinese on purpose: this is an embedding-search query against
            // the character's (Chinese-language) memory store, not user-facing or AI-parsed text.
            // Translating it could degrade semantic recall quality — a quality judgment call, not
            // a safety one (see CLAUDE.md's injectMemoryPalace query-hint precedent).
            await injectMemoryPalace(
                collaborator,
                undefined,
                `${snapshot.title} 第${slot.index + 1}句 ${snapshot.lines.map(line => line.content).join(' ')}`.trim(),
            );
            const systemPrompt = SongPrompts.buildMentorSystemPrompt(collaborator, userProfile, snapshot, []);
            const existing = lineAtSlot(snapshot, slot.index);
            const request = [
                `Please ${existing ? 're-write a new version of' : 'write'} line ${slot.index + 1} of the lyric notebook.`,
                `Position: ${SECTION_LABELS[slot.section]?.label || slot.section}, suggested length: ${slot.chars} characters.`,
                'You must read the entire lyric sheet above, and pick up the meaning and rhyme from the surrounding lines.',
                'Only return inspiration JSON; example_lines must contain exactly one line — do not modify any other lines.',
            ].join('\n');
            const userPrompt = SongPrompts.buildUserMessage(snapshot, request, slot.section);
            let generated: string | null = null;
            for (let attempt = 0; attempt < 2 && !generated; attempt += 1) {
                const retryInstruction = attempt === 0
                    ? ''
                    : '\n\n[Format Correction] The previous response was not a usable single lyric line. Re-output a complete inspiration JSON; example_lines may only contain a single plain lyric string — do not output truncated JSON, field explanations, or extra prose.';
                const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt + retryInstruction },
                        ],
                        temperature: attempt === 0 ? 0.9 : 0.65,
                        max_tokens: 500,
                    }),
                });
                if (!response.ok) throw new Error(`API Error: ${response.status}`);
                const data = await safeResponseJson(response);
                const raw = data.choices?.[0]?.message?.content?.trim() || '';
                generated = extractGeneratedLyricLine(raw);
            }
            if (!generated) throw new Error('C failed to return a complete lyric line twice in a row; the abnormal content was blocked — please try again');
            await saveNotebookLine(slot, generated, collaborator.id);
            addToast(existing ? `Line ${slot.index + 1} refreshed` : `Line ${slot.index + 1} generated`, 'success');
        } catch (error: any) {
            addToast(`Generation failed: ${error?.message || error}`, 'error');
        } finally {
            setGeneratingSlotIndex(null);
        }
    }, [
        activeSong, collaborator, generatingSlotIndex, apiConfig, addToast, lineDrafts,
        lineAtSlot, currentSection, userProfile, saveNotebookLine,
    ]);

    const updateCustomTemplateSection = (
        index: number,
        updates: Partial<SongTemplateSection>,
    ) => {
        setTempCustomSections(prev => prev.map((section, i) => i === index
            ? { ...section, ...updates }
            : section));
    };

    const updateActiveLyricStyle = async (style: LyricCoWritingStyle) => {
        if (!activeSong) return;
        const updated = { ...activeSong, lyricCoWritingStyle: style };
        setActiveSong(updated);
        await updateSong(updated.id, { lyricCoWritingStyle: style });
        addToast(`C switched to the "${getLyricCoWritingStyle(style).label}" co-writing style`, 'success');
    };

    // --- Completion ---
    const handleComplete = async () => {
        if (!activeSong || !collaborator) return;
        if (activeSong.lines.filter(l => !l.isDraft).length === 0) { addToast("This song doesn't have any lyrics yet", 'error'); return; }

        setIsCompleting(true);
        setShowPreviewModal(true);
        setCompletionReview("Waiting for your co-writer to write a review...");
        trackEvent("Finish Songsheet and Get Co-writer's Review");

        try {
            await injectMemoryPalace(
                collaborator,
                undefined,
                `${activeSong.title} ${activeSong.lines.map(line => line.content).join(' ')}`.trim(),
                userProfile.name,
            );
            const systemPrompt = SongPrompts.buildCompletionSystemPrompt(collaborator, userProfile);
            const prompt = SongPrompts.buildCompletionPrompt(collaborator, userProfile, activeSong);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.7,
                    max_tokens: 500,
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                setCompletionReview(data.choices[0].message.content.trim());
            } else {
                setCompletionReview("(Review generation failed, but this won't affect saving)");
            }
        } catch {
            setCompletionReview("(Network error, but this won't affect saving)");
        } finally {
            setIsCompleting(false);
        }
    };

    const confirmComplete = async () => {
        if (!activeSong || !collaborator) return;
        const completed: SongSheet = {
            ...activeSong,
            status: 'completed',
            completedAt: Date.now(),
        };
        setActiveSong(completed);
        await updateSong(completed.id, { status: 'completed', completedAt: completed.completedAt });

        // Send system message to chat
        const genreInfo = SONG_GENRES.find(g => g.id === completed.genre);
        await DB.saveMessage({
            charId: collaborator.id,
            role: 'system',
            type: 'text',
            content: `[System: ${userProfile.name} and ${collaborator.name} finished writing the song "${completed.title}" (${genreInfo?.label || completed.genre})]`,
        });

        setShowPreviewModal(false);
        addToast('Song complete! Songsheet saved', 'success');
        setView('shelf');
    };

    // --- Share to Chat as Card ---
    const handleShareToChat = async (charId: string) => {
        if (!activeSong) return;

        // Build lyrics text (exclude draft lines)
        let lyrics = '';
        let currentSec = '';
        for (const line of activeSong.lines.filter(l => !l.isDraft)) {
            if (line.section !== currentSec) {
                currentSec = line.section;
                const secInfo = SECTION_LABELS[currentSec];
                lyrics += `\n[${secInfo?.label || currentSec}]\n`;
            }
            lyrics += `${line.content}\n`;
        }

        const genreInfo = SONG_GENRES.find(g => g.id === activeSong.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === activeSong.mood);

        const cardData = {
            songId: activeSong.id,
            title: activeSong.title,
            subtitle: activeSong.subtitle,
            genre: genreInfo?.label || activeSong.genre,
            genreIcon: genreInfo?.icon || '',
            mood: moodInfo?.label || activeSong.mood,
            moodIcon: moodInfo?.icon || '',
            coverStyle: activeSong.coverStyle,
            lyrics: lyrics.trim(),
            lineCount: activeSong.lines.filter(l => !l.isDraft).length,
            status: activeSong.status,
            completedAt: activeSong.completedAt,
        };

        await DB.saveMessage({
            charId,
            role: 'user',
            type: 'score_card',
            content: JSON.stringify(cardData),
            metadata: { scoreCard: cardData },
        });

        setShowShareModal(false);
        addToast('Songsheet shared to chat', 'success');
        trackEvent('Share Songsheet to Chat');
    };

    // --- Pause (just go back) ---
    const handlePause = () => {
        setView('shelf');
        setActiveSong(null);
        setPendingLines([]);
    };

    // --- ACE-Step audio synth (preview view) ---

    // Provider availability — detected from configured keys
    const hasMiniMaxKey = !!(apiConfig.minimaxApiKey || apiConfig.apiKey);
    const hasReplicateKey = !!apiConfig.aceStepApiKey?.trim();

    /** Pick the best default provider given keys + previous song setting. */
    const pickDefaultProvider = useCallback((song?: SongSheet | null): MusicProvider => {
        if (song?.musicProvider) {
            // Honor previous choice if its key is still configured
            if (song.musicProvider === 'ace-step' && hasReplicateKey) return 'ace-step';
            if (song.musicProvider !== 'ace-step' && hasMiniMaxKey) return song.musicProvider;
        }
        if (hasMiniMaxKey) return 'minimax-free';
        if (hasReplicateKey) return 'ace-step';
        return 'minimax-free'; // best fallback — modal will warn
    }, [hasMiniMaxKey, hasReplicateKey]);

    // Per-song voice preset persistence + reset provider on song switch
    const voicePresetStorageKey = (songId: string) => `ace-step:voice:${songId}`;
    useEffect(() => {
        if (!activeSong?.id) return;
        try {
            const stored = localStorage.getItem(voicePresetStorageKey(activeSong.id));
            setVoicePresetIdState(stored || 'auto');
        } catch {
            setVoicePresetIdState('auto');
        }
        setProvider(pickDefaultProvider(activeSong));
    }, [activeSong?.id, pickDefaultProvider]);
    const setVoicePresetId = useCallback((id: string) => {
        setVoicePresetIdState(id);
        if (activeSong?.id) {
            try { localStorage.setItem(voicePresetStorageKey(activeSong.id), id); } catch { /* ignore */ }
        }
    }, [activeSong?.id]);

    // Cooldown ticker — reads last-fire timestamp from localStorage so cooldown
    // survives reloads. Free-plan sfworker protection: 60s between requests.
    const COOLDOWN_KEY = 'ace-step:last-fire-at';
    useEffect(() => {
        const tick = () => {
            try {
                const last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10);
                if (!last) { setCooldownSecsLeft(0); return; }
                const remaining = Math.max(0, Math.ceil((last + COOLDOWN_MS - Date.now()) / 1000));
                setCooldownSecsLeft(remaining);
            } catch { setCooldownSecsLeft(0); }
        };
        tick();
        const id = setInterval(tick, 500);
        return () => clearInterval(id);
    }, []);

    // Hydrate previously rendered audio when entering preview, and revoke any
    // stale blob URL when switching songs / leaving the view.
    useEffect(() => {
        let cancelled = false;
        if (view !== 'preview' || !activeSong?.audio?.assetKey) {
            // Switching away — drop the URL we last created.
            if (audioUrl && currentAudioOwnerRef.current !== activeSong?.id) {
                URL.revokeObjectURL(audioUrl);
                setAudioUrl(null);
                currentAudioOwnerRef.current = null;
            }
            setAudioError(null);
            return;
        }
        // Already showing this song's audio — nothing to do.
        if (currentAudioOwnerRef.current === activeSong.id && audioUrl) return;

        const assetKey = activeSong.audio.assetKey;
        loadSongAudioBlob(assetKey).then(result => {
            if (cancelled || !result) return;
            const url = URL.createObjectURL(result.blob);
            setAudioUrl(url);
            currentAudioOwnerRef.current = activeSong.id;
        }).catch(() => { /* ignore — user can regenerate */ });

        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, activeSong?.id, activeSong?.audio?.assetKey]);

    // Cancel any in-flight generation when the component unmounts or song changes.
    useEffect(() => {
        return () => {
            audioAbortRef.current?.abort();
            audioAbortRef.current = null;
        };
    }, [activeSong?.id]);

    /**
     * Run a synth with the given provider + style prompt string. Single source
     * of truth for both modal confirm and the "Re-record" button.
     */
    const runSynth = async (providerArg: MusicProvider, promptArg: string) => {
        if (!activeSong) return;

        // Provider-specific key check
        if (providerArg === 'ace-step') {
            if (!apiConfig.aceStepApiKey?.trim()) {
                addToast('Please fill in your Replicate API Token in "Settings" first', 'error');
                return;
            }
        } else {
            if (!apiConfig.minimaxApiKey && !apiConfig.apiKey) {
                addToast('Please fill in your MiniMax API Key in "Settings" first', 'error');
                return;
            }
        }

        // Cooldown gate — protects sfworker / MiniMax RPM
        if (cooldownSecsLeft > 0) {
            addToast(`Cooling down, ${cooldownSecsLeft}s left`, 'info');
            return;
        }

        const finalLines = activeSong.lines.filter(l => !l.isDraft);
        if (finalLines.length === 0) {
            addToast('The lyrics are empty — write a couple lines first', 'error');
            return;
        }

        const styleStr = (promptArg || '').trim() || buildAceStepTags(activeSong, voicePresetId);

        // Stamp the cooldown immediately so a same-second double-tap is blocked
        try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch { /* ignore */ }
        setCooldownSecsLeft(Math.ceil(COOLDOWN_MS / 1000));

        setIsGeneratingAudio(true);
        setAudioError(null);
        setAudioGenStatus('Queued…');
        const ctrl = new AbortController();
        audioAbortRef.current = ctrl;

        // Push regen state to MusicContext so MusicApp / MiniPlayer also show progress
        const localId = localSongIdFor(activeSong.id);
        const wasInAlbumBefore = localAlbumSongs.some(s => s.id === localId);
        markRegenerating(localId, 'Queued…');

        const statusMap: Record<string, string> = {
            resolving: 'Checking model version…',
            starting: 'Cold-starting the model…',
            processing: 'Generating…',
            downloading: 'Downloading audio…',
            done: 'Done',
            cached: 'Using the previously generated version',
        };

        try {
            let assetKey: string;
            let resultUrl: string;
            let resultMime: string;
            let cached: boolean;
            let promptHash: string;

            // Wrap status callback so it updates BOTH local dock and global music app indicator
            const pushStatus = (s: string) => {
                const friendly = statusMap[s] || s;
                setAudioGenStatus(friendly);
                markRegenerating(localId, friendly);
            };

            if (providerArg === 'ace-step') {
                const lyrics = buildAceStepLyrics(activeSong.lines);
                const input: AceStepInput = { tags: styleStr, lyrics };
                const result = await synthesizeSong(input, apiConfig, {
                    signal: ctrl.signal,
                    onStatus: pushStatus,
                    // Modal flow always means user wants a fresh take; cooldown +
                    // explicit "Start Recording" click already establishes intent.
                    forceRegenerate: true,
                });
                assetKey = result.assetKey;
                resultUrl = result.url;
                resultMime = result.mimeType;
                cached = result.cached;
                promptHash = hashSongInputs(input);
            } else {
                const lyrics = buildMinimaxMusicLyrics(activeSong.lines);
                const model = providerArg === 'minimax-paid' ? 'music-2.6' : 'music-2.6-free';
                const input: MinimaxMusicInput = { model, prompt: styleStr, lyrics };
                const result = await synthesizeSongMinimax(input, apiConfig, {
                    signal: ctrl.signal,
                    onStatus: pushStatus,
                    forceRegenerate: true,
                });
                assetKey = result.assetKey;
                resultUrl = result.url;
                resultMime = result.mimeType;
                cached = result.cached;
                promptHash = hashMinimaxMusicInputs(input);
            }

            // Replace any previous blob URL on this song
            if (audioUrl && currentAudioOwnerRef.current === activeSong.id) {
                URL.revokeObjectURL(audioUrl);
            }
            setAudioUrl(resultUrl);
            currentAudioOwnerRef.current = activeSong.id;

            const audioMeta: SongAudio = {
                assetKey,
                mimeType: resultMime,
                generatedAt: Date.now(),
                provider: providerArg,
                promptHash,
                tagsUsed: styleStr,
                lyricsLineCount: finalLines.length,
            };
            const updated = { ...activeSong, audio: audioMeta, musicProvider: providerArg };
            setActiveSong(updated);
            await updateSong(activeSong.id, { audio: audioMeta, musicProvider: providerArg });
            addToast(cached ? 'Matched a previously generated version' : 'Song complete!', 'success');

            // ── Default like state ── as soon as it's generated, it's auto-added to the
            // "Songs We Wrote Together" album, using the character's avatar as the default
            // cover. The user can still tap ❤︎ to change the cover / remove it / listen in
            // the Music App.
            const authorNames = [
                userProfile?.name || 'Me',
                collaborator?.name || 'AI',
            ].filter(Boolean).join(' & ');
            const localSong: MusicSong = {
                id: localId,
                name: activeSong.title || 'Untitled',
                artists: authorNames,
                album: 'Songs We Wrote Together',
                albumPic: activeSong.coverImage || collaborator?.avatar || '',
                duration: audioMeta.durationSec ?? finalLines.length * 5,
                fee: 0,
                local: true,
                localAssetKey: audioMeta.assetKey,
                localMimeType: audioMeta.mimeType,
                localCoverStyle: activeSong.coverStyle,
                customAuthorCharIds: collaborator?.id ? [collaborator.id] : [],
                localLyrics: buildMinimaxMusicLyrics(activeSong.lines),
            };
            addLocalSong(localSong);

            // ── If the Music App is currently playing this song (the old version, before
            // re-recording), automatically switch playback to the new version ──
            // playSong's local branch re-reads the blob from IndexedDB → the user hears
            // the new version immediately, no manual action needed.
            if (wasInAlbumBefore && currentMusicSong?.id === localId) {
                playSong(localSong, { alsoSetQueue: false });
                addToast('Music App switched to the new version', 'info');
            }
        } catch (err: any) {
            if (err?.name === 'AbortError') {
                setAudioGenStatus('Cancelled');
            } else {
                console.error('[Music] generate failed', err);
                const msg = err?.message || String(err);
                setAudioError(msg);
                addToast(`Song generation failed: ${msg.slice(0, 60)}`, 'error');
            }
        } finally {
            setIsGeneratingAudio(false);
            audioAbortRef.current = null;
            // Always clear regen state, even on error/abort
            markRegenerating(null);
        }
    };

    const handleCancelGenerate = () => {
        audioAbortRef.current?.abort();
    };

    // ── Shizuku-styled audio player wiring ──

    // Reset player state whenever the audio source changes (new render or song switch)
    useEffect(() => {
        setIsPlaying(false);
        setPlayProgress(0);
        setPlayDuration(0);
    }, [audioUrl]);

    const handleTogglePlay = useCallback(() => {
        const el = audioElRef.current;
        if (!el) return;
        if (el.paused) {
            el.play().catch(() => { /* autoplay can fail silently */ });
        } else {
            el.pause();
        }
    }, []);

    const handleSeek = useCallback((pct: number) => {
        const el = audioElRef.current;
        if (!el || !playDuration) return;
        el.currentTime = Math.max(0, Math.min(playDuration, pct * playDuration));
        setPlayProgress(el.currentTime);
    }, [playDuration]);

    const fmtTime = (s: number): string => {
        if (!isFinite(s) || s < 0) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    // ── Prompt modal: entry point + AI helper + confirm ──

    /** Open the unified "AI Song Guidance" modal — also the entry point for generation. */
    const openCustomPromptModal = () => {
        if (!activeSong) return;
        // Pre-fill the editable tags with whatever would be sent right now
        const current = activeSong.aceStepCustomTags || buildAceStepTags(activeSong, voicePresetId);
        setPromptDraft(current);
        setPromptGuidance('');
        setShowCustomPrompt(true);
        trackEvent('Open AI Song Guidance Modal');
    };

    /**
     * Modal "Start Recording" — persist the final tags then kick off synth with them
     * passed directly (so we don't have to wait for state to flush).
     */
    const handleConfirmAndGenerate = async () => {
        if (!activeSong) return;
        if (cooldownSecsLeft > 0) {
            addToast(`Cooling down, ${cooldownSecsLeft}s left`, 'info');
            return;
        }
        const tags = promptDraft.trim();
        if (!tags) {
            addToast('Style description cannot be empty.', 'error');
            return;
        }
        const updatedSong = { ...activeSong, aceStepCustomTags: tags };
        setActiveSong(updatedSong);
        await updateSong(activeSong.id, { aceStepCustomTags: tags });
        setShowCustomPrompt(false);
        runSynth(provider, tags);
        trackEvent('Confirm Song and Start Generating');
    };

    const handleAiWritePrompt = async () => {
        if (!activeSong) return;
        if (!apiConfig.baseUrl || !apiConfig.apiKey) {
            addToast('Please configure your AI model in Settings first.', 'error');
            return;
        }
        setIsAiWritingPrompt(true);
        trackEvent('Have AI Help Write the Song Prompt');
        try {
            // MiniMax is a Chinese-language model → output a Chinese natural-language prompt
            // ACE-Step is a foreign model → output English comma-separated tags
            const lang: 'en' | 'zh' = provider === 'ace-step' ? 'en' : 'zh';
            const generated = await generatePromptViaLLM(promptGuidance.trim(), activeSong, apiConfig, collaborator, undefined, lang);
            setPromptDraft(generated);
            addToast(promptGuidance.trim() ? 'AI generated it based on the character' : `AI wrote something in the spirit of ${collaborator?.name || 'the character'}`, 'success');
        } catch (err: any) {
            console.error('[ACE-Step] LLM prompt failed', err);
            addToast(`Generation failed: ${err?.message?.slice(0, 80) || err}`, 'error');
        } finally {
            setIsAiWritingPrompt(false);
        }
    };

    /** Reset draft tags back to whatever the preset+genre+mood combo would be. */
    const handleResetCustomPrompt = () => {
        if (!activeSong) return;
        setPromptDraft(buildAceStepTags(activeSong, voicePresetId));
    };

    // ── Like → add to the "Songs We Wrote Together" album (synced to the Music App) ──

    /** Stable synthetic song id derived from songId — avoids netease numeric collision. */
    const localSongIdFor = useCallback((songId: string): number => {
        // Use a hash of songId + a fixed negative offset to guarantee non-netease range
        let h = 0;
        for (let i = 0; i < songId.length; i++) {
            h = (Math.imul(31, h) + songId.charCodeAt(i)) | 0;
        }
        // Negative range is "free" — netease ids are positive 32/64-bit ints.
        return -1_000_000 - Math.abs(h);
    }, []);

    const isLikedToMusic = useMemo(() => {
        if (!activeSong) return false;
        const localId = localSongIdFor(activeSong.id);
        return localAlbumSongs.some(s => s.id === localId);
    }, [activeSong?.id, localAlbumSongs, localSongIdFor]);

    /** Compose user + char avatars side-by-side on canvas → data URL. */
    const buildDualCover = useCallback(async (charUrl: string, userUrl: string): Promise<string | null> => {
        try {
            // The avatar might be a blobref token, and the token itself isn't a loadable
            // URL: feeding it straight to Image would fail to load, and that failure gets
            // swallowed by the catch below, silently turning the dual cover into a blank
            // gradient-only image. So resolve it to a data URL first, then load (non-token
            // values are returned as-is, so this can be called unconditionally).
            // If the image is missing, the resolved result is an empty string — throw here
            // so the caller can handle it as "this one can't be drawn."
            const loadImg = async (src: string) => {
                const url = await resolveRefToDataUrl(src);
                if (!url) throw new Error('avatar blob missing');
                return await new Promise<HTMLImageElement>((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = url;
                });
            };
            const canvas = document.createElement('canvas');
            const SIZE = 400;
            canvas.width = SIZE; canvas.height = SIZE;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            // Cherry pink → lavender → water blue gradient background
            const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
            grad.addColorStop(0, '#f2b8c6');
            grad.addColorStop(0.5, '#c5b3e6');
            grad.addColorStop(1, '#9bcbf8');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, SIZE, SIZE);

            // Circular clip on both sides — user on the left, character on the right
            const drawCircle = (img: HTMLImageElement, cx: number, cy: number, r: number) => {
                ctx.save();
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
                const ratio = Math.max(2 * r / img.width, 2 * r / img.height);
                const w = img.width * ratio; const h = img.height * ratio;
                ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
                ctx.restore();
                // Outline stroke
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255,255,255,0.85)';
                ctx.lineWidth = 5;
                ctx.stroke();
            };

            const tasks: Promise<HTMLImageElement | null>[] = [
                charUrl ? loadImg(charUrl).catch(() => null) : Promise.resolve(null),
                userUrl ? loadImg(userUrl).catch(() => null) : Promise.resolve(null),
            ];
            const [charImg, userImg] = await Promise.all(tasks);
            if (userImg) drawCircle(userImg, SIZE * 0.32, SIZE * 0.55, SIZE * 0.22);
            if (charImg) drawCircle(charImg, SIZE * 0.68, SIZE * 0.55, SIZE * 0.22);

            // Small title at the top
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.font = 'bold 22px Georgia, "Noto Serif SC", serif';
            ctx.textAlign = 'center';
            ctx.fillText('Songs We Wrote Together', SIZE / 2, SIZE * 0.18);

            try {
                return canvas.toDataURL('image/jpeg', 0.85);
            } catch {
                // CORS taint — fallback null
                return null;
            }
        } catch {
            return null;
        }
    }, []);

    /** Open the manage-album-entry modal. Always opens regardless of liked state —
     *  for liked songs it lets you edit cover / remove / go listen; for unliked
     *  (user previously removed) it re-adds. */
    const handleSendToMusicApp = async () => {
        if (!activeSong || !activeSong.audio) {
            addToast("The song hasn't been generated yet", 'info');
            return;
        }
        // Prefer the user's artwork when this song already has one.
        setCoverMode(activeSong.coverImage ? 'upload' : 'char');
        setDualCoverUrl(null);
        setShowCoverConfirm(true);
    };

    const handleCoverUpload = async (file: File) => {
        if (!activeSong) return;
        if (!file.type.startsWith('image/')) {
            addToast('Please choose an image file', 'error');
            return;
        }
        if (file.size > 12 * 1024 * 1024) {
            addToast('Please keep images under 12MB', 'error');
            return;
        }
        try {
            const coverImage = await putImageBlob(file);
            const updated = { ...activeSong, coverImage };
            setActiveSong(updated);
            await updateSong(updated.id, { coverImage });
            setCoverMode('upload');
            addToast('Cover added to the lyric notebook', 'success');
        } catch {
            addToast('Failed to save cover', 'error');
        }
    };

    /** Remove the song from local album (un-like). Closes modal. */
    const handleRemoveFromAlbum = () => {
        if (!activeSong) return;
        const localId = localSongIdFor(activeSong.id);
        removeLocalSong(localId);
        setShowCoverConfirm(false);
        addToast('Removed from "Songs We Wrote Together"', 'info');
    };

    /** Step 2: confirm cover → actually add to album + play + jump to MusicApp. */
    const handleConfirmAddToAlbum = async () => {
        if (!activeSong || !activeSong.audio) return;

        const localId = localSongIdFor(activeSong.id);
        const authorNames = [
            userProfile?.name || 'Me',
            collaborator?.name || 'AI',
        ].filter(Boolean).join(' & ');

        // Resolve the chosen albumPic
        let albumPic = '';
        if (coverMode === 'char') {
            albumPic = collaborator?.avatar || '';
        } else if (coverMode === 'user') {
            albumPic = userProfile?.avatar || '';
        } else if (coverMode === 'dual') {
            // Reuse cached dual URL or build now
            if (dualCoverUrl) {
                albumPic = dualCoverUrl;
            } else {
                setIsBuildingDual(true);
                const built = await buildDualCover(collaborator?.avatar || '', userProfile?.avatar || '');
                setIsBuildingDual(false);
                albumPic = built || collaborator?.avatar || '';
            }
        } else if (coverMode === 'upload') {
            albumPic = activeSong.coverImage || collaborator?.avatar || '';
        }

        const durationSec = activeSong.audio.durationSec
            ?? Math.max(playDuration, 0)
            ?? 0;
        const lyricsText = buildMinimaxMusicLyrics(activeSong.lines);

        const localSong: MusicSong = {
            id: localId,
            name: activeSong.title || 'Untitled',
            artists: authorNames,
            album: 'Songs We Wrote Together',
            albumPic,
            duration: durationSec,
            fee: 0,
            local: true,
            localAssetKey: activeSong.audio.assetKey,
            localMimeType: activeSong.audio.mimeType,
            localCoverStyle: activeSong.coverStyle,
            customAuthorCharIds: collaborator?.id ? [collaborator.id] : [],
            localLyrics: lyricsText,
        };
        addLocalSong(localSong);
        trackEvent('Add Finished Song to Music App Album');
        setShowCoverConfirm(false);
        addToast(`Added to the "Songs We Wrote Together" album ❤︎`, 'success');
        playSong(localSong, { alsoSetQueue: true });
        openApp(AppID.Music);
    };

    // Pre-compute the dual cover when user picks that mode for instant preview.
    useEffect(() => {
        if (coverMode !== 'dual' || dualCoverUrl || isBuildingDual) return;
        if (!collaborator?.avatar && !userProfile?.avatar) return;
        setIsBuildingDual(true);
        buildDualCover(collaborator?.avatar || '', userProfile?.avatar || '').then(url => {
            if (url) setDualCoverUrl(url);
            setIsBuildingDual(false);
        });
    }, [coverMode, collaborator?.avatar, userProfile?.avatar, dualCoverUrl, isBuildingDual, buildDualCover]);

    /** Apply a voice-preset chip click — overwrite the draft with new tag string. */
    const applyVoicePreset = (presetId: string) => {
        if (!activeSong) return;
        setVoicePresetId(presetId);
        setPromptDraft(buildAceStepTags(activeSong, presetId));
    };

    // ==================== RENDER ====================

    // --- Shelf View ---
    if (view === 'shelf') {
        const drafts = songs.filter(s => s.status === 'draft');
        const completed = songs.filter(s => s.status === 'completed');

        return (
            <div
                className="h-full w-full flex flex-col font-sans relative overflow-hidden"
                style={{ background: `linear-gradient(180deg, ${MusicC.bg} 0%, ${MusicC.bgDeep} 60%, ${MusicC.bgTint} 100%)` }}
            >
                {/* Decorative stars */}
                <Sparkle size={9} color={MusicC.glow}    delay={0}   className="absolute top-20 left-6"   />
                <Sparkle size={7} color={MusicC.sakura}  delay={1.0} className="absolute top-44 right-8"  />
                <Sparkle size={6} color={MusicC.lavender} delay={0.6} className="absolute bottom-32 left-10" />
                <CrossStar size={8} color={MusicC.glow} delay={0.4} className="absolute bottom-20 right-7" solid={false} />

                {/* Header */}
                <div className="shrink-0 z-10 relative" style={{ paddingTop: 'var(--safe-top)' }}>
                  <div className="flex items-center px-6 py-3">
                    <div className="flex justify-between items-center w-full">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-white/60 active:scale-95 transition-transform" style={{ color: MusicC.primary }}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="text-center flex flex-col items-center">
                            <div className="flex items-center gap-2">
                                <Sparkle size={7} color={MusicC.glow} delay={0} />
                                <h1 className="text-[10px] tracking-[0.4em] uppercase" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>Lyric</h1>
                                <Sparkle size={7} color={MusicC.sakura} delay={0.7} />
                            </div>
                            <p className="text-lg font-bold mt-0.5" style={{ color: MusicC.primary, fontFamily: 'Georgia, "Noto Serif SC", serif' }}>Lyric Notebook</p>
                        </div>
                        <button
                            onClick={() => { trackEvent('Start New Songsheet'); setView('create'); }}
                            className="p-2.5 rounded-full active:scale-95 transition-all"
                            style={{
                                background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})`,
                                color: 'white',
                                boxShadow: `0 3px 14px ${MusicC.sakura}55`,
                            }}
                            title="New Lyric Notebook"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                        </button>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-5 pt-5 pb-8 space-y-7 no-scrollbar z-10">
                    {songs.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-center px-8">
                            <div className="w-20 h-[2px] bg-stone-300/60 mb-8" />
                            <p className="text-base text-stone-500 leading-8" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
                                No songs written yet
                            </p>
                            <p className="text-xs text-stone-400 mt-3 leading-6">
                                Tap the + in the top right to start your first lyric notebook
                            </p>
                            <div className="w-20 h-[2px] bg-stone-300/60 mt-8" />
                            <button onClick={() => { trackEvent('Start New Songsheet'); setView('create'); }} className="mt-8 px-6 py-2.5 border border-stone-300 rounded text-sm text-stone-600 hover:bg-stone-100 active:scale-[0.98] transition-all">
                                Start Writing
                            </button>
                        </div>
                    )}

                    {/* Drafts */}
                    {drafts.length > 0 && (
                        <div>
                            <div className="flex items-center gap-3 mb-4 px-1">
                                <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                <h2 className="text-[10px] font-medium text-stone-400 uppercase tracking-[0.2em]">Drafts</h2>
                                <div className="flex-1 h-[1px] bg-stone-200/80" />
                            </div>
                            <div className="space-y-3">
                                {drafts.sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(song => {
                                    const style = getCoverVisual(song.coverStyle);
                                    const char = characters.find(c => c.id === song.collaboratorId);
                                    const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
                                    return (
                                        <div key={song.id} className="relative group">
                                            <div
                                                onClick={() => {
                                                    setActiveSong(song);
                                                    setLineDrafts({});
                                                    setWorkMode('notebook');
                                                    setView('write');
                                                }}
                                                className="flex items-stretch cursor-pointer active:scale-[0.99] transition-transform rounded-lg overflow-hidden border border-stone-200/80 bg-white shadow-sm"
                                            >
                                                {/* Mini cover spine */}
                                                <div className={`w-16 shrink-0 ${style.className} flex items-center justify-center`} style={style.style}>
                                                    <span className={`text-lg ${style.textClass}`}>{genreInfo?.icon || '♪'}</span>
                                                </div>
                                                <div className="flex-1 p-3.5 min-w-0">
                                                    <h3 className="font-semibold text-sm text-stone-700 truncate" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>{song.title}</h3>
                                                    {song.subtitle && <p className="text-[11px] text-stone-400 truncate mt-0.5 italic">{song.subtitle}</p>}
                                                    <div className="flex items-center gap-2 mt-2">
                                                        <span className="text-[10px] text-stone-400">{genreInfo?.label}</span>
                                                        <span className="text-stone-300">·</span>
                                                        <span className="text-[10px] text-stone-400">{song.lines.filter(l => !l.isDraft).length} lines</span>
                                                        {song.lines.some(l => l.isDraft) && (
                                                            <span className="text-[10px] text-stone-300">{song.lines.filter(l => l.isDraft).length} drafts</span>
                                                        )}
                                                        {char && (
                                                            <>
                                                                <span className="text-stone-300">·</span>
                                                                <span className="text-[10px] text-stone-400">with {char.name}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); handleDeleteSong(song.id); }} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 bg-stone-100 text-stone-400 w-6 h-6 rounded-full flex items-center justify-center text-xs transition-opacity hover:bg-red-50 hover:text-red-400">×</button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Completed */}
                    {completed.length > 0 && (
                        <div>
                            <div className="flex items-center gap-3 mb-4 px-1">
                                <div className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                                <h2 className="text-[10px] font-medium text-stone-400 uppercase tracking-[0.2em]">Completed</h2>
                                <div className="flex-1 h-[1px] bg-stone-200/80" />
                            </div>
                            <div className="space-y-3">
                                {completed.sort((a, b) => (b.completedAt || b.lastActiveAt) - (a.completedAt || a.lastActiveAt)).map(song => {
                                    const style = getCoverVisual(song.coverStyle);
                                    const char = characters.find(c => c.id === song.collaboratorId);
                                    const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
                                    const moodInfo = SONG_MOODS.find(m => m.id === song.mood);
                                    return (
                                        <div key={song.id} className="relative group">
                                            <div
                                                onClick={() => { setActiveSong(song); setView('preview'); }}
                                                className="flex items-stretch cursor-pointer active:scale-[0.99] transition-transform rounded-lg overflow-hidden border border-stone-200/80 bg-white shadow-sm"
                                            >
                                                <div className={`w-16 shrink-0 ${style.className} flex items-center justify-center`} style={style.style}>
                                                    <span className={`text-lg ${style.textClass}`}>{genreInfo?.icon || '♪'}</span>
                                                </div>
                                                <div className="flex-1 p-3.5 min-w-0">
                                                    <h3 className="font-semibold text-sm text-stone-700 truncate" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>{song.title}</h3>
                                                    <div className="flex items-center gap-2 mt-1.5">
                                                        <span className="text-[10px] text-stone-400">{genreInfo?.label}</span>
                                                        <span className="text-stone-300">·</span>
                                                        <span className="text-[10px] text-stone-400">{moodInfo?.icon} {moodInfo?.label}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        {char && <TokenImg value={char.avatar} className="w-4 h-4 rounded-full object-cover" />}
                                                        <span className="text-[10px] text-stone-400">written with {char?.name}</span>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setActiveSong(song); setShowShareModal(true); }}
                                                    className="p-3 text-stone-400 hover:text-stone-600 self-center transition-colors"
                                                    title="Share"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" /></svg>
                                                </button>
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); handleDeleteSong(song.id); }} className="absolute top-2 right-12 opacity-0 group-hover:opacity-100 bg-stone-100 text-stone-400 w-6 h-6 rounded-full flex items-center justify-center text-xs transition-opacity hover:bg-red-50 hover:text-red-400">×</button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>

                {/* Share Modal */}
                <Modal isOpen={showShareModal} title="Share Songsheet" onClose={() => setShowShareModal(false)}>
                    <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                        <p className="text-xs text-stone-500 mb-3">Pick a character to share the songsheet to chat as a card</p>
                        {/* Group filter (not rendered when no groups exist); light styling for the white-background modal */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={shareGroupId} onChange={setShareGroupId} className="mb-2" />
                        {filterCharactersByGroup(characters, characterGroups, shareGroupId).map(c => (
                            <button key={c.id} onClick={() => handleShareToChat(c.id)} className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-stone-50 border border-stone-100 transition-colors">
                                <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                <span className="font-medium text-sm text-stone-700">{c.name}</span>
                            </button>
                        ))}
                    </div>
                </Modal>

                <ConfirmDialog isOpen={!!confirmDialog} title={confirmDialog?.title || ''} message={confirmDialog?.message || ''} variant={confirmDialog?.variant} confirmText={confirmDialog?.confirmText} onConfirm={confirmDialog?.onConfirm || (() => {})} onCancel={() => setConfirmDialog(null)} />
            </div>
        );
    }

    // --- Create View ---
    if (view === 'create') {
        return (
            <div
                className="h-full w-full flex flex-col font-sans relative overflow-hidden"
                style={{ background: `linear-gradient(180deg, ${MusicC.bg} 0%, ${MusicC.bgDeep} 55%, ${MusicC.bgTint} 100%)` }}
            >
                {/* Floating background sparkles — purely decorative */}
                <Sparkle size={9} color={MusicC.glow}    delay={0}   className="absolute top-16 left-6"   />
                <Sparkle size={7} color={MusicC.sakura}  delay={1.2} className="absolute top-32 right-8"  />
                <Sparkle size={6} color={MusicC.lavender} delay={0.6} className="absolute top-52 left-12"  />
                <Sparkle size={8} color={MusicC.glow}    delay={1.8} className="absolute bottom-40 right-5" />
                <CrossStar size={9} color={MusicC.lavender} delay={0.4} className="absolute bottom-56 left-8" solid={false} />

                {/* Header — back + decorative title */}
                <div className="shrink-0 z-10 relative" style={{ paddingTop: 'var(--safe-top)' }}>
                  <div className="h-16 flex items-center justify-between px-4">
                    <button onClick={() => setView('shelf')} className="p-2 -ml-2 rounded-full hover:bg-white/60 active:scale-95 transition-transform" style={{ color: MusicC.primary }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="flex flex-col items-center">
                        <div className="flex items-center gap-2">
                            <Sparkle size={8} color={MusicC.glow} delay={0} />
                            <h2 className="text-sm font-bold tracking-[0.18em]" style={{ color: MusicC.primary, fontFamily: 'Georgia, "Noto Serif SC", serif' }}>New Notebook</h2>
                            <Sparkle size={8} color={MusicC.sakura} delay={0.8} />
                        </div>
                        <div className="text-[8.5px] tracking-[0.4em] mt-0.5" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>— NEW PROJECT —</div>
                    </div>
                    <div className="w-9" />
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-5 pb-32 space-y-6 no-scrollbar relative z-10">
                    {/* 01 — Title */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>01</span>
                            <CrossStar size={7} color={MusicC.glow} delay={0} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Title</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>SONG TITLE</span>
                        </div>
                        <div className="relative">
                            <input
                                value={tempTitle}
                                onChange={e => setTempTitle(e.target.value)}
                                placeholder="Give this song a name~"
                                className="w-full rounded-2xl px-4 py-3 text-[13px] focus:outline-none transition-colors shizuku-glass"
                                style={{ color: MusicC.text, border: `1px solid ${MusicC.faint}40`, fontFamily: `'Noto Serif SC', Georgia, serif` }}
                            />
                            <PencilSimple size={14} weight="duotone" className="absolute right-4 top-1/2 -translate-y-1/2" style={{ color: MusicC.accent }} />
                        </div>
                    </div>

                    {/* 02 — Subtitle */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>02</span>
                            <CrossStar size={7} color={MusicC.sakura} delay={0.4} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Subtitle</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>SUBTITLE</span>
                        </div>
                        <input
                            value={tempSubtitle}
                            onChange={e => setTempSubtitle(e.target.value)}
                            placeholder="What does this song want to say?"
                            className="w-full rounded-2xl px-4 py-3 text-[13px] focus:outline-none transition-colors italic shizuku-glass"
                            style={{ color: MusicC.text, border: `1px solid ${MusicC.faint}40`, fontFamily: `'Noto Serif SC', Georgia, serif` }}
                        />
                    </div>

                    {/* 03 — Genre */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>03</span>
                            <CrossStar size={7} color={MusicC.lavender} delay={0.7} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Genre</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>GENRE</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                            {SONG_GENRES.map(g => {
                                const active = tempGenre === g.id;
                                return (
                                    <button
                                        key={g.id}
                                        onClick={() => setTempGenre(g.id)}
                                        className="px-2 py-2 rounded-xl text-[11px] transition-all active:scale-95 flex items-center justify-center"
                                        style={active ? {
                                            background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                            color: 'white',
                                            boxShadow: `0 3px 12px ${MusicC.glow}50`,
                                            border: '1px solid transparent',
                                            fontFamily: `'Noto Serif SC', Georgia, serif`,
                                        } : {
                                            background: 'rgba(255,255,255,0.7)',
                                            color: MusicC.primary,
                                            border: `1px solid ${MusicC.faint}50`,
                                            fontFamily: `'Noto Serif SC', Georgia, serif`,
                                        }}
                                    >
                                        <span className="font-medium tracking-wider">{g.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 04 — C's co-writing style */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>04</span>
                            <CrossStar size={7} color={MusicC.sakura} delay={0.4} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>C's Co-writing Style</label>
                            <span className="text-[9px] tracking-[0.24em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>CO-WRITING</span>
                        </div>
                        <p className="text-[10px] pl-1" style={{ color: MusicC.muted }}>
                            Determines how C writes and reviews lyrics — freely mix and match with the music genre above
                        </p>
                        <div
                            className="grid grid-cols-4 p-1 rounded-xl gap-1"
                            style={{ background: 'rgba(255,255,255,.52)', border: `1px solid ${MusicC.faint}35` }}
                        >
                            {LYRIC_STYLE_CATEGORIES.map(category => {
                                const active = tempLyricStyleCategory === category.id;
                                return (
                                    <button
                                        key={category.id}
                                        onClick={() => setTempLyricStyleCategory(category.id)}
                                        className="px-1 py-1.5 rounded-lg text-[9px] font-semibold transition-all truncate"
                                        style={active
                                            ? { color: 'white', background: MusicC.primary, boxShadow: `0 2px 8px ${MusicC.glow}35` }
                                            : { color: MusicC.muted }}
                                        title={category.label}
                                    >
                                        {category.shortLabel}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                            {LYRIC_CO_WRITING_STYLES
                                .filter(style => style.category === 'adaptive' || style.category === tempLyricStyleCategory)
                                .map(style => {
                                const active = tempLyricStyle === style.id;
                                return (
                                    <button
                                        key={style.id}
                                        onClick={() => setTempLyricStyle(style.id)}
                                        className="px-2 py-2 rounded-xl text-[10px] font-medium transition-all active:scale-95 truncate"
                                        style={active ? {
                                            background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})`,
                                            color: 'white',
                                            boxShadow: `0 3px 12px ${MusicC.sakura}45`,
                                            border: '1px solid transparent',
                                        } : {
                                            background: 'rgba(255,255,255,0.7)',
                                            color: MusicC.primary,
                                            border: `1px solid ${MusicC.faint}50`,
                                        }}
                                        title={style.label}
                                    >
                                        {style.shortLabel}
                                    </button>
                                );
                            })}
                        </div>
                        <div
                            className="rounded-xl px-3 py-2.5 text-[10px] leading-relaxed"
                            style={{
                                color: MusicC.muted,
                                background: `linear-gradient(135deg, ${MusicC.glow}16, rgba(255,255,255,.55))`,
                                border: `1px solid ${MusicC.faint}40`,
                            }}
                        >
                            <span className="font-bold" style={{ color: MusicC.primary }}>
                                {getLyricCoWritingStyle(tempLyricStyle).label}
                            </span>
                            {' · '}
                            {getLyricCoWritingStyle(tempLyricStyle).desc}
                        </div>
                    </div>

                    {/* 05 — Mood */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>05</span>
                            <CrossStar size={7} color={MusicC.glow} delay={0.3} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Mood</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>MOOD</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                            {SONG_MOODS.map(m => {
                                const active = tempMood === m.id;
                                return (
                                    <button
                                        key={m.id}
                                        onClick={() => setTempMood(m.id)}
                                        className="px-2 py-2 rounded-xl text-[11px] transition-all active:scale-95 flex items-center justify-center"
                                        style={active ? {
                                            background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})`,
                                            color: 'white',
                                            boxShadow: `0 3px 12px ${MusicC.sakura}50`,
                                            border: '1px solid transparent',
                                            fontFamily: `'Noto Serif SC', Georgia, serif`,
                                        } : {
                                            background: 'rgba(255,255,255,0.7)',
                                            color: MusicC.primary,
                                            border: `1px solid ${MusicC.faint}50`,
                                            fontFamily: `'Noto Serif SC', Georgia, serif`,
                                        }}
                                    >
                                        <span className="font-medium tracking-wider">{m.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 06 — Lyric Structure */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 18, letterSpacing: '0.05em' }}>06</span>
                            <CrossStar size={7} color={MusicC.sakura} delay={0.9} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Lyric Structure</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>LYRIC STRUCTURE</span>
                        </div>
                        <p className="text-[10px] pl-1" style={{ color: MusicC.muted }}>Pick a structure as the lyric skeleton — you can freely adjust it later</p>
                        <div className="grid grid-cols-2 gap-2">
                            {LYRIC_TEMPLATES.map(t => {
                                const active = tempTemplate === t.id;
                                const totalLines = t.structure.reduce((sum, s) => sum + s.lines, 0);
                                return (
                                    <button
                                        key={t.id}
                                        onClick={() => setTempTemplate(t.id)}
                                        className="text-left p-3 rounded-2xl transition-all active:scale-[0.98] relative overflow-hidden"
                                        style={active ? {
                                            background: `linear-gradient(135deg, ${MusicC.glow}25, ${MusicC.sakura}15)`,
                                            border: `1.5px solid ${MusicC.accent}80`,
                                            boxShadow: `0 3px 14px ${MusicC.glow}30`,
                                        } : {
                                            background: 'rgba(255,255,255,0.7)',
                                            border: `1px solid ${MusicC.faint}40`,
                                        }}
                                    >
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <span className="text-[14px] leading-none" style={{ color: active ? MusicC.accent : MusicC.primary, fontFamily: 'Georgia, serif' }}>{t.icon}</span>
                                            <span className="text-[12px] font-bold" style={{ color: MusicC.primary }}>{t.label}</span>
                                            {totalLines > 0 && (
                                                <span className="text-[9px] ml-auto" style={{ color: MusicC.muted }}>
                                                    {totalLines} lines
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[10px] leading-snug" style={{ color: MusicC.muted }}>
                                            {t.desc}
                                        </div>
                                    </button>
                                );
                            })}
                            <button
                                onClick={() => setTempTemplate('custom')}
                                className="text-left p-3 rounded-2xl transition-all active:scale-[0.98] relative overflow-hidden"
                                style={tempTemplate === 'custom' ? {
                                    background: `linear-gradient(135deg, ${MusicC.glow}25, ${MusicC.sakura}15)`,
                                    border: `1.5px solid ${MusicC.accent}80`,
                                    boxShadow: `0 3px 14px ${MusicC.glow}30`,
                                } : {
                                    background: 'rgba(255,255,255,0.7)',
                                    border: `1px solid ${MusicC.faint}40`,
                                }}
                            >
                                <div className="flex items-center gap-1.5 mb-1">
                                    <span className="text-[14px] leading-none" style={{ color: MusicC.accent }}>⌘</span>
                                    <span className="text-[12px] font-bold" style={{ color: MusicC.primary }}>Advanced Custom</span>
                                    <span className="text-[9px] ml-auto" style={{ color: MusicC.muted }}>
                                        {tempCustomSections.reduce((sum, section) => sum + section.lines, 0)} lines
                                    </span>
                                </div>
                                <div className="text-[10px] leading-snug" style={{ color: MusicC.muted }}>
                                    Decide your own sections, line counts, and characters per line
                                </div>
                            </button>
                        </div>
                        {tempTemplate === 'custom' && (
                            <div
                                className="mt-3 rounded-2xl px-3 py-3 space-y-2"
                                style={{ background: 'rgba(255,255,255,.58)', border: `1px solid ${MusicC.faint}45` }}
                            >
                                {tempCustomSections.map((section, index) => (
                                    <div key={`${section.section}-${index}`} className="grid grid-cols-[1fr_64px_76px_28px] gap-2 items-center">
                                        <select
                                            value={section.section}
                                            onChange={event => updateCustomTemplateSection(index, { section: event.target.value as SongLine['section'] })}
                                            className="min-w-0 rounded-lg bg-white/80 px-2 py-2 text-[11px] outline-none"
                                            style={{ color: MusicC.primary, border: `1px solid ${MusicC.faint}45` }}
                                        >
                                            {Object.entries(SECTION_LABELS)
                                                .filter(([key]) => key !== 'free')
                                                .map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
                                        </select>
                                        <label className="relative">
                                            <input
                                                type="number"
                                                min={1}
                                                max={16}
                                                value={section.lines}
                                                onChange={event => updateCustomTemplateSection(index, { lines: Math.max(1, Math.min(16, Number(event.target.value) || 1)) })}
                                                className="w-full rounded-lg bg-white/80 pl-2 pr-5 py-2 text-[11px] outline-none"
                                                style={{ color: MusicC.primary, border: `1px solid ${MusicC.faint}45` }}
                                            />
                                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px]" style={{ color: MusicC.muted }}>lines</span>
                                        </label>
                                        <input
                                            value={section.chars}
                                            onChange={event => updateCustomTemplateSection(index, { chars: event.target.value })}
                                            placeholder="e.g. 7-10"
                                            className="w-full rounded-lg bg-white/80 px-2 py-2 text-[11px] outline-none"
                                            style={{ color: MusicC.primary, border: `1px solid ${MusicC.faint}45` }}
                                            aria-label="Characters per line"
                                        />
                                        <button
                                            onClick={() => setTempCustomSections(prev => prev.filter((_, i) => i !== index))}
                                            disabled={tempCustomSections.length <= 1}
                                            className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-25"
                                            style={{ color: MusicC.muted }}
                                            aria-label="Delete section"
                                        >
                                            <Trash size={13} />
                                        </button>
                                    </div>
                                ))}
                                <button
                                    onClick={() => setTempCustomSections(prev => [...prev, { section: 'verse', lines: 4, chars: '8-12' }])}
                                    className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] rounded-xl"
                                    style={{ color: MusicC.primary, border: `1px dashed ${MusicC.faint}70` }}
                                >
                                    <Plus size={12} /> Add a Section
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Big pink game-style "Next" button */}
                <div
                    className="absolute bottom-0 w-full px-5 pt-4 pb-6 z-20"
                    style={{
                        background: `linear-gradient(to top, ${MusicC.bg}f5 60%, ${MusicC.bg}cc 90%, ${MusicC.bg}00 100%)`,
                    }}
                >
                    <button
                        onClick={handleGoPartner}
                        className="relative w-full rounded-[28px] py-4 font-bold tracking-[0.15em] text-white active:scale-[0.98] transition-transform overflow-hidden"
                        style={{
                            background: `linear-gradient(135deg, ${MusicC.sakura} 0%, ${MusicC.lavender} 100%)`,
                            boxShadow: `0 8px 28px ${MusicC.sakura}55, 0 0 60px ${MusicC.sakura}25, inset 0 1px 0 rgba(255,255,255,0.4)`,
                            fontFamily: 'Georgia, "Noto Serif SC", serif',
                        }}
                    >
                        {/* Decorative stars */}
                        <Sparkle size={8}  color="#fff" delay={0}   className="absolute top-2 left-6  opacity-80" />
                        <Sparkle size={6}  color="#fff" delay={0.7} className="absolute bottom-3 left-12 opacity-70" />
                        <Sparkle size={7}  color="#fff" delay={1.4} className="absolute top-3 right-14 opacity-80" />
                        <CrossStar size={9} color="#fff" delay={0.5} className="absolute bottom-2 right-6" solid={false} />
                        {/* Moving highlight */}
                        <span className="absolute inset-0 pointer-events-none"
                            style={{
                                background: `linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%)`,
                                backgroundSize: '200% 100%',
                                animation: 'shizuku-shimmer 4s ease-in-out infinite',
                            }} />
                        <span className="relative inline-flex flex-col items-center justify-center gap-0.5">
                            <span className="inline-flex items-center gap-2 text-[14px]">
                                Next, pick your co-writer
                                <MusicNotes size={16} weight="fill" />
                            </span>
                            <span className="text-[9px] tracking-[0.5em] opacity-80" style={{ fontFamily: 'Georgia, serif' }}>— NEXT STEP —</span>
                        </span>
                    </button>
                </div>
            </div>
        );
    }

    // --- Partner View (Step 2 of create flow) ---
    if (view === 'partner') {
        // Candidate co-writers filtered by group (the filter only affects display; the selected tempCollaboratorId is unaffected)
        const partnerChars = filterCharactersByGroup(characters, characterGroups, partnerGroupId);
        return (
            <div
                className="h-full w-full flex flex-col font-sans relative overflow-hidden"
                style={{ background: `linear-gradient(180deg, ${MusicC.bg} 0%, ${MusicC.bgDeep} 55%, ${MusicC.bgTint} 100%)` }}
            >
                {/* Decoration */}
                <Sparkle size={9} color={MusicC.glow}    delay={0}   className="absolute top-14 right-6"  />
                <Sparkle size={7} color={MusicC.sakura}  delay={1.0} className="absolute top-36 left-7"   />
                <Sparkle size={6} color={MusicC.lavender} delay={0.5} className="absolute top-60 right-10" />
                <CrossStar size={8} color={MusicC.glow} delay={1.6} className="absolute bottom-48 left-6" solid={false} />
                <Sparkle size={8} color={MusicC.sakura}  delay={0.3} className="absolute bottom-32 right-12" />

                {/* Header */}
                <div className="shrink-0 z-10 relative" style={{ paddingTop: 'var(--safe-top)' }}>
                  <div className="h-16 flex items-center justify-between px-4">
                    <button onClick={() => setView('create')} className="p-2 -ml-2 rounded-full hover:bg-white/60 active:scale-95 transition-transform" style={{ color: MusicC.primary }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="flex flex-col items-center">
                        <div className="flex items-center gap-2">
                            <Sparkle size={8} color={MusicC.glow} delay={0} />
                            <h2 className="text-sm font-bold tracking-[0.18em]" style={{ color: MusicC.primary, fontFamily: 'Georgia, "Noto Serif SC", serif' }}>Co-writer</h2>
                            <Sparkle size={8} color={MusicC.sakura} delay={0.8} />
                        </div>
                        <div className="text-[8.5px] tracking-[0.4em] mt-0.5" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>— PARTNER —</div>
                    </div>
                    <div className="w-9" />
                  </div>
                </div>

                <p className="text-[11px] text-center pb-3 px-6 z-10 relative" style={{ color: MusicC.muted }}>Pick a partner to create with you</p>

                <div className="flex-1 overflow-y-auto px-5 pb-32 space-y-5 no-scrollbar relative z-10">
                    {/* Group filter (not rendered when no groups exist), light dreamy background */}
                    <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                        value={partnerGroupId} onChange={setPartnerGroupId} />
                    {/* Collaborator list */}
                    <div className="space-y-2">
                        {partnerChars.map(c => {
                            const active = tempCollaboratorId === c.id;
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => setTempCollaboratorId(c.id)}
                                    className="w-full flex items-center gap-3 p-3 rounded-2xl transition-all active:scale-[0.99] relative overflow-hidden"
                                    style={active ? {
                                        background: `linear-gradient(135deg, ${MusicC.glow}28, ${MusicC.sakura}15)`,
                                        border: `1.5px solid ${MusicC.accent}90`,
                                        boxShadow: `0 4px 16px ${MusicC.glow}35`,
                                    } : {
                                        background: 'rgba(255,255,255,0.75)',
                                        border: `1px solid ${MusicC.faint}40`,
                                    }}
                                >
                                    <div className="relative shrink-0">
                                        <TokenImg value={c.avatar} className="w-12 h-12 rounded-2xl object-cover" />
                                        {active && <Sparkle size={9} color={MusicC.sakura} delay={0} className="absolute -top-1 -right-1" />}
                                    </div>
                                    <div className="text-left flex-1 min-w-0">
                                        <div className="font-bold text-[13px]" style={{ color: MusicC.primary }}>{c.name}</div>
                                        <div className="text-[10px] truncate leading-snug mt-0.5" style={{ color: MusicC.muted }}>{c.description || 'Will be your music co-creation partner'}</div>
                                    </div>
                                    {active && (
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                                            style={{ background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`, color: 'white', boxShadow: `0 2px 8px ${MusicC.glow}60` }}>
                                            <Check size={11} weight="bold" />
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                        {characters.length === 0 && (
                            <div className="rounded-2xl p-5 text-center" style={{ background: 'rgba(255,255,255,0.6)', border: `1px dashed ${MusicC.faint}80` }}>
                                <p className="text-[12px]" style={{ color: MusicC.muted }}>No characters available yet — go create one first</p>
                            </div>
                        )}
                        {/* Characters exist, but the current group filter turned up empty */}
                        {characters.length > 0 && partnerChars.length === 0 && (
                            <div className="rounded-2xl p-5 text-center" style={{ background: 'rgba(255,255,255,0.6)', border: `1px dashed ${MusicC.faint}80` }}>
                                <p className="text-[12px]" style={{ color: MusicC.muted }}>No characters in this group</p>
                            </div>
                        )}
                    </div>

                    {/* Paper Tone */}
                    <div className="space-y-2 pt-1">
                        <div className="flex items-center gap-2 pl-1">
                            <CrossStar size={7} color={MusicC.glow} delay={0} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Paper Tone</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>PAPER TONE</span>
                        </div>
                        <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-1">
                            {COVER_STYLES.map(s => {
                                const active = tempCoverStyle === s.id;
                                return (
                                    <div key={s.id} className="flex flex-col items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => setTempCoverStyle(s.id)}
                                            className={`w-12 h-12 rounded-xl bg-gradient-to-br ${s.gradient} shrink-0 transition-all active:scale-95`}
                                            style={active ? {
                                                boxShadow: `0 0 0 2px ${MusicC.accent}, 0 4px 14px ${MusicC.glow}40`,
                                            } : {
                                                border: `1px solid ${MusicC.faint}60`,
                                                opacity: 0.85,
                                            }}
                                            title={s.label}
                                        />
                                        <span className="text-[8.5px]" style={{ color: active ? MusicC.primary : MusicC.muted }}>{s.label}</span>
                                    </div>
                                );
                            })}
                            <div className="flex flex-col items-center gap-1 shrink-0">
                                <button
                                    onClick={() => setTempCoverStyle(buildCustomCoverStyleId())}
                                    className="w-12 h-12 rounded-xl shrink-0 transition-all active:scale-95"
                                    style={isCustomCoverStyle(tempCoverStyle) ? {
                                        backgroundImage: `linear-gradient(135deg, ${customCoverFrom} 0%, ${customCoverVia} 50%, ${customCoverTo} 100%)`,
                                        boxShadow: `0 0 0 2px ${MusicC.accent}, 0 4px 14px ${MusicC.glow}40`,
                                    } : {
                                        backgroundImage: `linear-gradient(135deg, ${customCoverFrom} 0%, ${customCoverVia} 50%, ${customCoverTo} 100%)`,
                                        border: `1px solid ${MusicC.faint}60`,
                                        opacity: 0.85,
                                    }}
                                    title="Custom"
                                />
                                <span className="text-[8.5px]" style={{ color: isCustomCoverStyle(tempCoverStyle) ? MusicC.primary : MusicC.muted }}>Custom</span>
                            </div>
                        </div>
                    </div>

                    {/* Custom Tone */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 pl-1">
                            <CrossStar size={7} color={MusicC.sakura} delay={0.3} />
                            <label className="text-[11px] font-bold" style={{ color: MusicC.primary }}>Custom Tone</label>
                            <span className="text-[9px] tracking-[0.3em]" style={{ color: MusicC.faint, fontFamily: 'Georgia, serif' }}>CUSTOM COLOR</span>
                        </div>
                        <div className="rounded-2xl p-4 shizuku-glass" style={{ border: `1px solid ${MusicC.faint}40` }}>
                            <div className="grid grid-cols-3 gap-3">
                                {([
                                    { label: 'Start Color', color: customCoverFrom, position: 'from' },
                                    { label: 'Middle Color', color: customCoverVia, position: 'via' },
                                    { label: 'End Color', color: customCoverTo,  position: 'to'   }
                                ] as const).map(item => (
                                    <label key={item.label} className="space-y-1.5">
                                        <span className="block text-[10px]" style={{ color: MusicC.muted }}>{item.label}</span>
                                        <div className="rounded-lg overflow-hidden" style={{ height: 28, background: item.color, border: `1px solid ${MusicC.faint}40`, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.2)` }}>
                                            <input
                                                type="color"
                                                value={item.color}
                                                onChange={(e) => updateCustomCoverColor(item.position, e.target.value)}
                                                className="w-full h-full opacity-0 cursor-pointer"
                                            />
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Big purple game-style "Turn to a New First Page" button */}
                <div
                    className="absolute bottom-0 w-full px-5 pt-4 pb-6 z-20"
                    style={{
                        background: `linear-gradient(to top, ${MusicC.bg}f5 60%, ${MusicC.bg}cc 90%, ${MusicC.bg}00 100%)`,
                    }}
                >
                    <button
                        onClick={handleCreate}
                        disabled={!tempCollaboratorId}
                        className="relative w-full rounded-[28px] py-4 font-bold tracking-[0.15em] text-white active:scale-[0.98] transition-transform overflow-hidden disabled:opacity-50"
                        style={{
                            background: `linear-gradient(135deg, ${MusicC.primary} 0%, ${MusicC.accent} 55%, ${MusicC.lavender} 100%)`,
                            boxShadow: `0 8px 28px ${MusicC.glow}70, 0 0 70px ${MusicC.lavender}30, inset 0 1px 0 rgba(255,255,255,0.4)`,
                            fontFamily: 'Georgia, "Noto Serif SC", serif',
                        }}
                    >
                        <Sparkle size={8}  color="#fff" delay={0}   className="absolute top-2 left-7  opacity-80" />
                        <Sparkle size={6}  color="#fff" delay={0.7} className="absolute bottom-3 left-14 opacity-70" />
                        <CrossStar size={9} color="#fff" delay={0.4} className="absolute top-2 right-7" solid={false} />
                        <Sparkle size={7}  color="#fff" delay={1.4} className="absolute bottom-2 right-12 opacity-80" />
                        <span className="absolute inset-0 pointer-events-none"
                            style={{
                                background: `linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%)`,
                                backgroundSize: '200% 100%',
                                animation: 'shizuku-shimmer 4s ease-in-out infinite',
                            }} />
                        <span className="relative inline-flex flex-col items-center justify-center gap-0.5">
                            <span className="inline-flex items-center gap-2 text-[14px]">
                                <Feather size={16} weight="fill" />
                                Turn to a New First Page
                            </span>
                            <span className="text-[9px] tracking-[0.5em] opacity-80" style={{ fontFamily: 'Georgia, serif' }}>— LET'S BEGIN —</span>
                        </span>
                    </button>
                </div>
            </div>
        );
    }

    // --- Preview View (completed songs) ---
    if (view === 'preview' && activeSong) {
        const style = getCoverVisual(activeSong.coverStyle);
        const paper = getPaperTheme(activeSong.coverStyle);
        const genreInfo = SONG_GENRES.find(g => g.id === activeSong.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === activeSong.mood);

        let currentSec = '';
        return (
            <div className="h-full w-full flex flex-col font-sans relative overflow-hidden" style={{ background: paper.background, color: paper.ink }}>
                {/* Cover / Title Page */}
                <div className={`${style.className} ${style.textClass} relative shrink-0`} style={{ ...style.style, minHeight: 'calc(220px + var(--safe-top))', paddingTop: 'var(--safe-top)' }}>
                    <button onClick={() => { setView('shelf'); setActiveSong(null); }} className="absolute left-4 p-2 rounded-full bg-black/10 hover:bg-black/20 transition-colors z-10" style={{ top: 'calc(var(--safe-top) + 1rem)' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <button onClick={() => { setShowShareModal(true); }} className="absolute right-4 p-2 rounded-full bg-black/10 hover:bg-black/20 transition-colors z-10" style={{ top: 'calc(var(--safe-top) + 1rem)' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" /></svg>
                    </button>
                    {/* Album-style title layout */}
                    <div className="flex flex-col items-center justify-end h-full px-8 pb-8 pt-16">
                        <div className="w-12 h-[1px] bg-current opacity-20 mb-5" />
                        <h1 className="text-2xl font-semibold text-center leading-tight" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>{activeSong.title}</h1>
                        {activeSong.subtitle && <p className="text-sm opacity-60 mt-2 italic text-center">{activeSong.subtitle}</p>}
                        <div className="flex items-center gap-3 mt-4 text-[11px] opacity-50">
                            <span>{genreInfo?.label}</span>
                            <span>·</span>
                            <span>{moodInfo?.label}</span>
                        </div>
                        {collaborator && (
                            <div className="flex items-center gap-2 mt-3 opacity-50">
                                <TokenImg value={collaborator.avatar} className="w-5 h-5 rounded-full object-cover" />
                                <span className="text-[11px]">written with {collaborator.name}</span>
                            </div>
                        )}
                        <div className="w-12 h-[1px] bg-current opacity-20 mt-5" />
                    </div>
                </div>

                {/* Lyrics body — like a booklet page (draft lines excluded) */}
                <div className="flex-1 overflow-y-auto px-8 py-8 no-scrollbar relative z-10 pb-32">
                    {activeSong.lines.filter(l => !l.isDraft).map(line => {
                        const showSection = line.section !== currentSec;
                        if (showSection) currentSec = line.section;
                        return (
                            <div key={line.id}>
                                {showSection && (
                                    <div className="mt-8 mb-4 first:mt-0 flex items-center gap-3">
                                        <div className="w-6 h-[1px]" style={{ background: paper.rule }} />
                                        <span className="text-[9px] uppercase tracking-[0.2em] font-medium" style={{ color: paper.muted }}>{SECTION_LABELS[line.section]?.label || line.section}</span>
                                        <div className="flex-1 h-[1px]" style={{ background: paper.rule }} />
                                    </div>
                                )}
                                <p className="text-[15px] leading-[2.2] py-0" style={{ color: paper.ink, fontFamily: 'Georgia, "Noto Serif SC", serif' }}>{line.content}</p>
                            </div>
                        );
                    })}
                    {/* End mark */}
                    <div className="flex justify-center mt-10 mb-4">
                        <div className="w-8 h-[1px]" style={{ background: paper.rule }} />
                    </div>
                </div>

                {/* ─── Shizuku-themed AI Song Generation / Audio Dock ─── */}
                <div
                    className="absolute bottom-0 left-0 right-0 z-20 pb-safe"
                    style={{
                        background: `linear-gradient(to top, ${MusicC.bg}f8 60%, ${MusicC.bg}cc 90%, ${MusicC.bg}00 100%)`,
                        backdropFilter: 'blur(18px)',
                        WebkitBackdropFilter: 'blur(18px)',
                        borderTop: `1px solid ${MusicC.glow}25`,
                        boxShadow: `0 -8px 32px ${MusicC.glow}10`,
                    }}
                >
                    {/* Hidden audio element drives our custom shizuku player */}
                    {audioUrl && (
                        <audio
                            ref={audioElRef}
                            src={audioUrl}
                            onPlay={() => setIsPlaying(true)}
                            onPause={() => setIsPlaying(false)}
                            onLoadedMetadata={(e) => setPlayDuration((e.target as HTMLAudioElement).duration || 0)}
                            onTimeUpdate={(e) => setPlayProgress((e.target as HTMLAudioElement).currentTime || 0)}
                            onEnded={() => setIsPlaying(false)}
                            preload="metadata"
                            className="hidden"
                        />
                    )}

                    <div className="relative px-4 py-3.5">
                        {/* Floating sparkle decorations — pointer-none */}
                        <div className="pointer-events-none absolute inset-0 overflow-hidden">
                            <Sparkle size={9} className="absolute top-2 right-6" color={MusicC.glow} delay={0} />
                            <Sparkle size={7} className="absolute top-4 left-8" color={MusicC.sakura} delay={1.2} />
                            <Sparkle size={5} className="absolute bottom-3 right-1/3" color={MusicC.lavender} delay={0.6} />
                        </div>

                        {audioUrl ? (
                            // ── State A: audio ready — shizuku mini player ──
                            <div className="relative flex items-center gap-3">
                                <div
                                    className="relative w-12 h-12 rounded-full shrink-0 flex items-center justify-center overflow-hidden"
                                    style={{
                                        background: `radial-gradient(circle at 35% 35%, ${MusicC.accent}, ${MusicC.primary})`,
                                        boxShadow: `0 4px 18px ${MusicC.glow}40, inset 0 1px 0 rgba(255,255,255,0.3)`,
                                        animation: isPlaying ? 'shizuku-vinyl 6s linear infinite' : 'none',
                                    }}
                                >
                                    <div
                                        className="absolute inset-1 rounded-full pointer-events-none"
                                        style={{ background: `repeating-radial-gradient(circle at center, transparent 0px, transparent 2px, rgba(255,255,255,0.08) 3px, transparent 4px)` }}
                                    />
                                    <div
                                        className="w-4 h-4 rounded-full"
                                        style={{
                                            background: `radial-gradient(circle at 30% 30%, white, ${MusicC.soft})`,
                                            boxShadow: `inset 0 1px 2px rgba(0,0,0,0.15)`,
                                        }}
                                    />
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <MetaChip>
                                            {activeSong.audio?.provider === 'ace-step'
                                                ? 'ACE-Step'
                                                : activeSong.audio?.provider === 'minimax-paid'
                                                    ? 'MiniMax'
                                                    : 'MiniMax · Free'}
                                        </MetaChip>
                                        {activeSong.audio?.generatedAt && (
                                            <span className="text-[9px]" style={{ color: MusicC.faint, fontFamily: 'monospace' }}>
                                                {new Date(activeSong.audio.generatedAt).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        )}
                                        <div className="flex-1" />
                                        {/* ❤︎ Like → sync to the Music App's "Songs We Wrote Together" */}
                                        <button
                                            onClick={handleSendToMusicApp}
                                            className="w-7 h-7 rounded-full transition-all active:scale-90 flex items-center justify-center shrink-0"
                                            style={isLikedToMusic ? {
                                                color: 'white',
                                                background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})`,
                                                boxShadow: `0 2px 10px ${MusicC.sakura}50`,
                                            } : {
                                                color: MusicC.sakura,
                                                background: `${MusicC.sakura}18`,
                                                border: `1px solid ${MusicC.sakura}40`,
                                            }}
                                            title={isLikedToMusic ? 'Added to the "Songs We Wrote Together" album' : 'Add to Music App'}
                                            aria-label={isLikedToMusic ? 'Liked' : 'Like'}
                                        >
                                            <HeartStraight size={12} weight={isLikedToMusic ? 'fill' : 'regular'} />
                                        </button>
                                        <button
                                            onClick={openCustomPromptModal}
                                            disabled={cooldownSecsLeft > 0}
                                            className="text-[10px] px-2 py-0.5 rounded-full transition-all active:scale-95 disabled:opacity-40"
                                            style={{
                                                color: MusicC.primary,
                                                background: `${MusicC.glow}15`,
                                                border: `1px solid ${MusicC.glow}30`,
                                            }}
                                            title={cooldownSecsLeft > 0 ? `Cooling down ${cooldownSecsLeft}s` : 'Try another version'}
                                        >
                                            ↻ Re-record{cooldownSecsLeft > 0 ? ` ${cooldownSecsLeft}s` : ''}
                                        </button>
                                    </div>
                                    <GlassProgress
                                        progress={playProgress}
                                        duration={playDuration}
                                        fmtTime={fmtTime}
                                        onSeek={handleSeek}
                                    />
                                </div>

                                <button
                                    onClick={handleTogglePlay}
                                    className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 active:scale-95 transition-transform relative"
                                    style={{
                                        background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                        boxShadow: `0 4px 18px ${MusicC.glow}40, 0 0 40px ${MusicC.glow}15`,
                                        animation: isPlaying ? 'shizuku-glow 3s ease-in-out infinite' : 'none',
                                    }}
                                >
                                    {isPlaying ? (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" /></svg>
                                    ) : (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7L8 5z" /></svg>
                                    )}
                                    <div
                                        className="absolute inset-[-3px] rounded-full pointer-events-none"
                                        style={{ border: `1px solid rgba(255,255,255,0.25)` }}
                                    />
                                </button>
                            </div>
                        ) : isGeneratingAudio ? (
                            // ── State B: recording — multi-ring vinyl with deep glow ──
                            <div className="relative flex items-center gap-3.5 py-1.5">
                                {/* Three stacked vinyl layers — rotating outer conic ring + static inner stroke + inner emoji */}
                                <div className="relative w-14 h-14 shrink-0">
                                    {/* Outer glow ring */}
                                    <div className="absolute pointer-events-none rounded-full"
                                        style={{
                                            inset: -6,
                                            background: `radial-gradient(circle, ${MusicC.glow}40, ${MusicC.sakura}20 50%, transparent 75%)`,
                                            filter: 'blur(8px)',
                                            animation: 'shizuku-glow 2.5s ease-in-out infinite',
                                        }}
                                    />
                                    {/* Rotating outer ring */}
                                    <div className="absolute inset-0 rounded-full"
                                        style={{
                                            background: `conic-gradient(from 0deg, ${MusicC.primary}, ${MusicC.accent}, ${MusicC.sakura}, ${MusicC.lavender}, ${MusicC.primary})`,
                                            animation: 'shizuku-vinyl 2s linear infinite',
                                            boxShadow: `0 0 18px ${MusicC.glow}50`,
                                        }}
                                    />
                                    {/* Inner core */}
                                    <div className="absolute inset-[5px] rounded-full flex items-center justify-center"
                                        style={{
                                            background: `radial-gradient(circle at 35% 35%, white, ${MusicC.bg} 70%)`,
                                            border: `1px solid ${MusicC.glow}50`,
                                            boxShadow: `inset 0 2px 6px ${MusicC.glow}25, 0 1px 4px ${MusicC.primary}20`,
                                        }}
                                    >
                                        <span className="text-base" style={{ filter: `drop-shadow(0 1px 2px ${MusicC.primary}20)` }}>🎤</span>
                                    </div>
                                    {/* Floating star sparkles */}
                                    <CrossStar size={9} className="absolute -top-1 -right-1" color={MusicC.sakura} delay={0} />
                                    <Sparkle size={7} className="absolute -bottom-0.5 -left-1" color={MusicC.lavender} delay={0.7} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <div className="text-[14px] font-semibold tracking-wider" style={{ color: MusicC.primary, fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
                                            Recording
                                        </div>
                                        {/* Three bouncing dots */}
                                        <span className="flex gap-0.5">
                                            <span className="w-1 h-1 rounded-full" style={{ background: MusicC.accent, animation: 'shizuku-twinkle 1.2s ease-in-out infinite' }} />
                                            <span className="w-1 h-1 rounded-full" style={{ background: MusicC.accent, animation: 'shizuku-twinkle 1.2s ease-in-out 0.3s infinite' }} />
                                            <span className="w-1 h-1 rounded-full" style={{ background: MusicC.accent, animation: 'shizuku-twinkle 1.2s ease-in-out 0.6s infinite' }} />
                                        </span>
                                    </div>
                                    <div className="text-[10px] truncate mt-1 tracking-[0.2em]" style={{ color: MusicC.muted, fontFamily: `'Space Grotesk', monospace` }}>
                                        {audioGenStatus || 'Processing'}
                                    </div>
                                </div>
                                <button
                                    onClick={handleCancelGenerate}
                                    className="text-[11px] px-3.5 py-2 rounded-full transition-all active:scale-95 shrink-0 shizuku-glass"
                                    style={{
                                        color: MusicC.muted,
                                        border: `1px solid ${MusicC.faint}40`,
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            // ── State C: idle — single big shizuku button ──
                            <div className="relative flex flex-col items-center gap-1.5">
                                <button
                                    onClick={openCustomPromptModal}
                                    disabled={cooldownSecsLeft > 0}
                                    className="relative w-full py-3.5 rounded-2xl font-medium text-sm active:scale-[0.98] transition-all overflow-hidden disabled:cursor-not-allowed"
                                    style={{
                                        background: cooldownSecsLeft > 0
                                            ? `linear-gradient(135deg, ${MusicC.faint}80, ${MusicC.muted}50)`
                                            : `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                        color: 'white',
                                        boxShadow: cooldownSecsLeft > 0
                                            ? 'none'
                                            : `0 4px 24px ${MusicC.glow}50, 0 0 60px ${MusicC.glow}20`,
                                        animation: cooldownSecsLeft > 0 ? 'none' : 'shizuku-glow 3.5s ease-in-out infinite',
                                    }}
                                >
                                    {cooldownSecsLeft === 0 && (
                                        <div
                                            className="absolute inset-0 pointer-events-none"
                                            style={{
                                                background: `linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%)`,
                                                backgroundSize: '200% 100%',
                                                animation: 'shizuku-shimmer 3.5s ease-in-out infinite',
                                            }}
                                        />
                                    )}
                                    <span className="relative flex items-center justify-center gap-2.5 tracking-[0.15em]" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
                                        {cooldownSecsLeft > 0 ? (
                                            <>
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm-.75 5.25a.75.75 0 0 1 1.5 0v4.59l3.22 3.22a.75.75 0 1 1-1.06 1.06l-3.44-3.44a.75.75 0 0 1-.22-.53V7.5Z" clipRule="evenodd" /></svg>
                                                COOLING DOWN · {cooldownSecsLeft}s
                                            </>
                                        ) : (
                                            <>
                                                <span style={{ fontSize: 13 }}>✦</span>
                                                AI Song Generation · Let it sing
                                                <span style={{ fontSize: 13 }}>✦</span>
                                            </>
                                        )}
                                    </span>
                                </button>

                                {audioError ? (
                                    <div className="text-[10.5px] leading-relaxed text-center px-2 max-w-full" style={{ color: MusicC.danger }}>
                                        <span className="font-semibold">Error: </span>{audioError}
                                    </div>
                                ) : (
                                    <div className="text-[9.5px] tracking-[0.18em] text-center" style={{ color: MusicC.muted, fontFamily: 'monospace' }}>
                                        Tap to configure voice/style · ready in 30-60s
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Share Modal */}
                <Modal isOpen={showShareModal} title="Share Songsheet" onClose={() => setShowShareModal(false)}>
                    <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                        <p className="text-xs text-stone-500 mb-3">Pick a character to send the songsheet card to chat</p>
                        {/* Group filter (not rendered when no groups exist); light styling for the white-background modal */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={shareGroupId} onChange={setShareGroupId} className="mb-2" />
                        {filterCharactersByGroup(characters, characterGroups, shareGroupId).map(c => (
                            <button key={c.id} onClick={() => handleShareToChat(c.id)} className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-stone-50 border border-stone-100 transition-colors">
                                <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                <span className="font-medium text-sm text-stone-700">{c.name}</span>
                            </button>
                        ))}
                    </div>
                </Modal>

                {/* ─── Cover Confirm Modal — an intermediate step between the Like button and jumping to the Music App ─── */}
                <Modal isOpen={showCoverConfirm} title="Choose a cover for this song" onClose={() => setShowCoverConfirm(false)}>
                    <div className="space-y-4">
                        {/* Large cover preview */}
                        <div className="flex items-center justify-center">
                            <div
                                className="relative w-44 h-44 rounded-2xl overflow-hidden"
                                style={{
                                    boxShadow: `0 8px 32px ${MusicC.glow}50, inset 0 1px 0 rgba(255,255,255,0.5)`,
                                    border: `1px solid ${MusicC.glow}40`,
                                }}
                            >
                                {coverMode === 'char' && collaborator?.avatar && (
                                    <TokenImg value={collaborator.avatar} alt="" className="w-full h-full object-cover" />
                                )}
                                {coverMode === 'user' && userProfile?.avatar && (
                                    <TokenImg value={userProfile.avatar} alt="" className="w-full h-full object-cover" />
                                )}
                                {coverMode === 'dual' && (
                                    isBuildingDual ? (
                                        <div className="w-full h-full flex items-center justify-center"
                                            style={{ background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender}, ${MusicC.glow})` }}>
                                            <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        </div>
                                    ) : dualCoverUrl ? (
                                        <img src={dualCoverUrl} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-white text-xs"
                                            style={{ background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})` }}>
                                            Dual Cover
                                        </div>
                                    )
                                )}
                                {coverMode === 'upload' && (
                                    uploadedCoverUrl ? (
                                        <img src={uploadedCoverUrl} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                        <button
                                            onClick={() => coverUploadRef.current?.click()}
                                            className="w-full h-full flex flex-col items-center justify-center gap-2"
                                            style={{ background: `linear-gradient(135deg, ${MusicC.bgDeep}, ${MusicC.soft})`, color: MusicC.primary }}
                                        >
                                            <UploadSimple size={24} />
                                            <span className="text-[11px]">Upload Image</span>
                                        </button>
                                    )
                                )}
                                {/* Vinyl sheen */}
                                <div className="absolute inset-0 pointer-events-none"
                                    style={{ background: 'linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.18) 50%, transparent 60%)' }} />
                            </div>
                        </div>

                        <input
                            ref={coverUploadRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={event => {
                                const file = event.target.files?.[0];
                                if (file) handleCoverUpload(file);
                                event.currentTarget.value = '';
                            }}
                        />

                        {/* Cover source */}
                        <div className="grid grid-cols-4 gap-2">
                            {([
                                { id: 'char' as CoverMode, label: collaborator?.name || 'Co-writer', src: collaborator?.avatar || '' },
                                { id: 'user' as CoverMode, label: userProfile?.name || 'Me', src: userProfile?.avatar || '' },
                                { id: 'dual' as CoverMode, label: 'Dual', src: dualCoverUrl || '' },
                                { id: 'upload' as CoverMode, label: uploadedCoverUrl ? 'My Image' : 'Upload', src: uploadedCoverUrl || '' },
                            ]).map(opt => {
                                const active = opt.id === coverMode;
                                return (
                                    <button
                                        key={opt.id}
                                        onClick={() => {
                                            if (opt.id === 'upload' && !uploadedCoverUrl) {
                                                coverUploadRef.current?.click();
                                            } else {
                                                setCoverMode(opt.id);
                                                trackEvent('Choose Music App Cover Style', { coverMode: opt.id });
                                            }
                                        }}
                                        className="rounded-xl p-2 border transition-all active:scale-95 flex flex-col items-center gap-1"
                                        style={active ? {
                                            background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                            color: 'white',
                                            borderColor: 'transparent',
                                            boxShadow: `0 3px 14px ${MusicC.glow}50`,
                                        } : {
                                            background: 'rgba(255,255,255,0.7)',
                                            color: MusicC.text,
                                            borderColor: `${MusicC.faint}50`,
                                        }}
                                    >
                                        <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0"
                                            style={{
                                                border: `1.5px solid ${active ? 'rgba(255,255,255,0.6)' : `${MusicC.faint}50`}`,
                                            }}>
                                            {opt.src ? (
                                                <TokenImg value={opt.src} alt="" className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center"
                                                    style={{ background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})` }}>
                                                    {opt.id === 'dual' && (isBuildingDual ? (
                                                        <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                                                    ) : (
                                                        <SparkleP size={14} weight="fill" color="white" />
                                                    ))}
                                                    {opt.id === 'upload' && <UploadSimple size={16} color="white" />}
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-[10px] font-medium leading-tight">{opt.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {coverMode === 'upload' && uploadedCoverUrl && (
                            <button
                                onClick={() => coverUploadRef.current?.click()}
                                className="w-full text-[10px] py-1.5 underline underline-offset-4"
                                style={{ color: MusicC.muted }}
                            >
                                Change Image
                            </button>
                        )}

                        {/* Meta info */}
                        <div className="rounded-xl px-3 py-2 text-[11px] leading-relaxed"
                            style={{
                                background: `linear-gradient(135deg, ${MusicC.glow}15, ${MusicC.sakura}10)`,
                                border: `1px solid ${MusicC.glow}25`,
                                color: MusicC.muted,
                            }}>
                            <div><span style={{ color: MusicC.primary }}>♪ </span>《{activeSong.title}》</div>
                            <div className="mt-0.5">Artist: {userProfile?.name || 'Me'} & {collaborator?.name || 'AI'}</div>
                            <div className="mt-0.5">Album: Songs We Wrote Together</div>
                        </div>

                        {/* Buttons */}
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowCoverConfirm(false)}
                                className="flex-1 py-3 rounded-xl text-[11px] font-medium tracking-wider transition-all active:scale-[0.98]"
                                style={{
                                    background: 'rgba(255,255,255,0.7)',
                                    color: MusicC.muted,
                                    border: `1px solid ${MusicC.faint}50`,
                                }}
                            >
                                Cancel
                            </button>
                            {isLikedToMusic && (
                                <button
                                    onClick={handleRemoveFromAlbum}
                                    className="flex-1 py-3 rounded-xl text-[11px] font-medium tracking-wider transition-all active:scale-[0.98]"
                                    style={{
                                        background: 'rgba(255,255,255,0.7)',
                                        color: MusicC.danger,
                                        border: `1px solid ${MusicC.danger}40`,
                                    }}
                                >
                                    Remove
                                </button>
                            )}
                            <button
                                onClick={handleConfirmAddToAlbum}
                                disabled={isBuildingDual && coverMode === 'dual'}
                                className="flex-[2] py-3 rounded-xl text-[12px] font-bold tracking-[0.18em] transition-all active:scale-[0.98] disabled:opacity-50 relative overflow-hidden"
                                style={{
                                    background: `linear-gradient(135deg, ${MusicC.sakura}, ${MusicC.lavender})`,
                                    color: 'white',
                                    boxShadow: `0 4px 18px ${MusicC.sakura}60, 0 0 50px ${MusicC.sakura}25`,
                                    fontFamily: 'Georgia, serif',
                                }}
                            >
                                ❤︎ {isLikedToMusic ? 'Save and Listen' : 'Add and Listen'}
                            </button>
                        </div>
                    </div>
                </Modal>

                {/* ─── Unified AI Song Guidance Modal — shizuku theme ─── */}
                <Modal
                    isOpen={showCustomPrompt}
                    title="✦ Let AI Sing It"
                    onClose={() => setShowCustomPrompt(false)}
                    footer={
                        <>
                            <button
                                onClick={() => setShowCustomPrompt(false)}
                                className="flex-1 py-3 rounded-xl text-[12px] font-medium tracking-wider transition-all active:scale-[0.98]"
                                style={{
                                    background: 'rgba(255,255,255,0.7)',
                                    color: MusicC.muted,
                                    border: `1px solid ${MusicC.faint}50`,
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmAndGenerate}
                                disabled={cooldownSecsLeft > 0 || !promptDraft.trim()}
                                className="flex-[2] py-3.5 rounded-xl text-[12px] font-bold tracking-[0.25em] transition-all active:scale-[0.98] disabled:opacity-50 relative overflow-hidden"
                                style={{
                                    background: cooldownSecsLeft > 0
                                        ? `linear-gradient(135deg, ${MusicC.faint}, ${MusicC.muted})`
                                        : `linear-gradient(135deg, ${MusicC.primary} 0%, ${MusicC.accent} 60%, ${MusicC.lavender} 100%)`,
                                    color: 'white',
                                    boxShadow: cooldownSecsLeft > 0
                                        ? 'none'
                                        : `0 6px 22px ${MusicC.glow}70, 0 0 60px ${MusicC.lavender}30, inset 0 1px 0 rgba(255,255,255,0.35)`,
                                    fontFamily: 'Georgia, "Noto Serif SC", serif',
                                }}
                            >
                                {/* Moving sheen */}
                                {cooldownSecsLeft === 0 && (
                                    <span className="absolute inset-0 pointer-events-none"
                                        style={{
                                            background: `linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%)`,
                                            backgroundSize: '200% 100%',
                                            animation: 'shizuku-shimmer 4s ease-in-out infinite',
                                        }} />
                                )}
                                <span className="relative inline-flex items-center justify-center gap-2">
                                    {cooldownSecsLeft > 0 ? (
                                        `Cooling down ${cooldownSecsLeft}s`
                                    ) : (
                                        <>
                                            <CrossStar size={11} color="white" delay={0} solid />
                                            Start Recording
                                            <CrossStar size={11} color="white" delay={0.5} solid />
                                        </>
                                    )}
                                </span>
                            </button>
                        </>
                    }
                >
                    <div className="space-y-4">
                        {/* ── Provider picker — segmented ── */}
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 pl-1">
                                <Sparkle size={8} color={MusicC.accent} delay={0.2} />
                                <label className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: MusicC.primary }}>Choose Generator</label>
                            </div>
                            {(() => {
                                const opts: { id: MusicProvider; title: string; sub: string; available: boolean; needs: string }[] = [
                                    { id: 'minimax-free', title: 'MiniMax Free', sub: 'Free · Full-length song', available: hasMiniMaxKey, needs: 'MiniMax Key' },
                                    { id: 'minimax-paid', title: 'MiniMax Paid', sub: 'Token Plan · Full-length song', available: hasMiniMaxKey, needs: 'MiniMax Key' },
                                    { id: 'ace-step',     title: 'ACE-Step',       sub: '~$0.015 · Full-length song', available: hasReplicateKey, needs: 'Replicate Token' },
                                ];
                                return (
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {opts.map(opt => {
                                            const isActive = opt.id === provider;
                                            const Ico = PROVIDER_ICONS[opt.id] || Heart;
                                            return (
                                                <button
                                                    key={opt.id}
                                                    onClick={() => { setProvider(opt.id); trackEvent('Switch Song Generator', { provider: opt.id }); }}
                                                    disabled={!opt.available}
                                                    className="relative text-left p-2 rounded-xl border transition-all active:scale-95 disabled:cursor-not-allowed"
                                                    style={isActive ? {
                                                        background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                                        color: 'white',
                                                        borderColor: 'transparent',
                                                        boxShadow: `0 3px 14px ${MusicC.glow}50`,
                                                    } : opt.available ? {
                                                        background: 'rgba(255,255,255,0.7)',
                                                        color: MusicC.text,
                                                        borderColor: `${MusicC.faint}50`,
                                                    } : {
                                                        background: 'rgba(0,0,0,0.03)',
                                                        color: MusicC.faint,
                                                        borderColor: `${MusicC.faint}30`,
                                                        opacity: 0.55,
                                                    }}
                                                >
                                                    <div className="flex items-center gap-1.5 mb-0.5">
                                                        <Ico size={14} weight={isActive ? 'fill' : 'duotone'} />
                                                        <span className="text-[10.5px] font-bold leading-none">{opt.title}</span>
                                                    </div>
                                                    <div className="text-[9px] opacity-80 leading-tight">{opt.sub}</div>
                                                    {!opt.available && (
                                                        <div className="text-[8.5px] mt-0.5 leading-tight" style={{ color: MusicC.danger }}>Requires {opt.needs}</div>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })()}
                            <p className="text-[10px] leading-relaxed pl-1" style={{ color: MusicC.muted }}>
                                {provider === 'ace-step'
                                    ? 'Full-length song (up to 4 minutes) — self-funded via Replicate, about ¥0.1-0.3/song'
                                    : provider === 'minimax-paid'
                                        ? 'Full-length song (up to 4-6 minutes) — faster generation, less likely to queue'
                                        : 'Full-length song (up to 4-6 minutes) — completely free · uses your existing MiniMax Key'}
                            </p>
                        </div>

                        {/* Section I — Quick voice preset chips */}
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 pl-1">
                                <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 15, letterSpacing: '0.05em' }}>I</span>
                                <CrossStar size={7} color={MusicC.glow} delay={0} />
                                <label className="text-[10px] font-bold uppercase tracking-[0.25em]" style={{ color: MusicC.primary }}>Quick Voice Presets</label>
                                <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${MusicC.glow}55, transparent)` }} />
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                                {VOICE_PRESETS.map(preset => {
                                    const isActive = preset.id === voicePresetId;
                                    const Ico = VOICE_ICONS[preset.id] || SparkleP;
                                    return (
                                        <button
                                            key={preset.id}
                                            onClick={() => { applyVoicePreset(preset.id); trackEvent('Select Voice Preset', { preset: preset.id }); }}
                                            className="text-[11px] py-2.5 rounded-xl border transition-all active:scale-95 flex flex-col items-center justify-center gap-1 relative overflow-hidden"
                                            style={isActive ? {
                                                background: `linear-gradient(135deg, ${MusicC.primary}, ${MusicC.accent})`,
                                                color: 'white',
                                                borderColor: 'transparent',
                                                boxShadow: `0 3px 14px ${MusicC.glow}50`,
                                            } : {
                                                background: 'rgba(255,255,255,0.7)',
                                                color: MusicC.primary,
                                                borderColor: `${MusicC.faint}50`,
                                            }}
                                        >
                                            <Ico size={18} weight={isActive ? 'fill' : 'duotone'} />
                                            <span className="font-medium leading-tight">{preset.label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Section II — Natural language guidance */}
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 pl-1">
                                <span className="font-bold italic" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 15, letterSpacing: '0.05em' }}>II</span>
                                <CrossStar size={7} color={MusicC.sakura} delay={0.4} />
                                <label className="text-[10px] font-bold uppercase tracking-[0.25em]" style={{ color: MusicC.primary }}>Or Describe a More Specific Style</label>
                                <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${MusicC.sakura}55, transparent)` }} />
                            </div>
                            <textarea
                                value={promptGuidance}
                                onChange={(e) => setPromptGuidance(e.target.value)}
                                placeholder="Lazy jazz female vocals, mainly piano and saxophone, 60bpm, a rainy-night feeling…"
                                rows={3}
                                className="w-full rounded-xl px-3 py-2 text-[13px] focus:outline-none transition-colors resize-none shizuku-glass"
                                style={{
                                    color: MusicC.text,
                                    border: `1px solid ${MusicC.faint}50`,
                                    fontFamily: `'Noto Serif SC', Georgia, serif`,
                                }}
                            />
                            <button
                                onClick={handleAiWritePrompt}
                                disabled={isAiWritingPrompt}
                                className="w-full py-2.5 rounded-xl text-[12px] font-medium tracking-[0.15em] transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-2 relative overflow-hidden"
                                style={{
                                    background: `linear-gradient(135deg, ${MusicC.lavender}, ${MusicC.sakura})`,
                                    color: 'white',
                                    boxShadow: `0 3px 14px ${MusicC.sakura}40`,
                                    fontFamily: 'Georgia, serif',
                                }}
                            >
                                {isAiWritingPrompt ? (
                                    <>
                                        <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        AI is thinking…
                                    </>
                                ) : (
                                    <>
                                        <SparkleP size={14} weight="fill" />
                                        {promptGuidance.trim()
                                            ? `Let AI revise it in ${collaborator?.name || 'the character'}'s spirit`
                                            : `Let AI write something in ${collaborator?.name || 'the character'}'s spirit`}
                                    </>
                                )}
                            </button>
                            <p className="text-[10px] leading-relaxed pl-1" style={{ color: MusicC.muted }}>
                                AI will read {collaborator ? `"${collaborator.name}"'s` : "this song's"} persona and **make the call itself** — you don't need to know music.
                            </p>
                        </div>

                        {/* Section III — Final editable tag string */}
                        <div className="space-y-2">
                            <div className="flex items-center justify-between pl-1 gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span className="font-bold italic shrink-0" style={{ fontFamily: 'Georgia, serif', color: MusicC.accent, fontSize: 15, letterSpacing: '0.05em' }}>III</span>
                                    <CrossStar size={7} color={MusicC.lavender} delay={0.8} />
                                    <label className="text-[10px] font-bold uppercase tracking-[0.25em] truncate" style={{ color: MusicC.primary }}>Final Style Description (sent to AI)</label>
                                </div>
                                <button
                                    onClick={handleResetCustomPrompt}
                                    className="text-[10px] underline transition-colors"
                                    style={{ color: MusicC.muted }}
                                >
                                    Reset to Default
                                </button>
                            </div>
                            <textarea
                                value={promptDraft}
                                onChange={(e) => setPromptDraft(e.target.value)}
                                placeholder={provider === 'ace-step'
                                    ? 'female vocal, breathy, dreamy pop, soft piano, 75 bpm, c minor'
                                    /* Intentionally left as a Chinese example: MiniMax is a Chinese-language model and
                                       produces better results from natural Chinese prompts — see the hint text below. */
                                    : '女声, 气声, 梦幻流行, 钢琴轻柔, 黑胶噪点, 75bpm, c 小调'}
                                rows={3}
                                className="w-full rounded-xl px-3 py-2 text-[12px] font-mono focus:outline-none transition-colors resize-none"
                                style={{
                                    background: '#0d1418',
                                    color: '#9bcbf8',
                                    border: `1px solid ${MusicC.primary}40`,
                                }}
                            />
                            <p className="text-[10px] leading-relaxed pl-1" style={{ color: MusicC.muted }}>
                                {provider === 'ace-step'
                                    ? 'Comma-separated English tags. Common vocal tags: female/male vocal, breathy/husky/sweet; style: pop/rock/jazz/lo-fi; mood: dreamy/upbeat/melancholy.'
                                    : 'A comma-separated Chinese description works best (MiniMax is a Chinese-language model, so natural Chinese gets the best results). Example: 女声 / 气声 / 慵懒哼唱 / 爵士 / 钢琴 / 黑胶噪点 / 60bpm / e 小调 (female vocals / breathy / lazy humming / jazz / piano / vinyl crackle / 60bpm / e minor).'}
                            </p>
                        </div>

                        {/* Hint strip — content depends on provider */}
                        <div
                            className="rounded-xl px-3 py-2 flex items-center gap-2 text-[10.5px] leading-relaxed"
                            style={{
                                background: `linear-gradient(135deg, ${MusicC.glow}15, ${MusicC.sakura}10)`,
                                border: `1px solid ${MusicC.glow}25`,
                                color: MusicC.muted,
                            }}
                        >
                            <Sparkle size={9} color={MusicC.accent} delay={0} />
                            <span>
                                {provider === 'ace-step'
                                    ? 'Song ready in ~30-60s · ~¥0.1-0.3/song'
                                    : 'Song ready in ~30-60s · Free full-length song'}
                            </span>
                        </div>

                    </div>
                </Modal>
            </div>
        );
    }

    // --- Lyric notebook workspace ---
    if (view === 'write' && activeSong) {
        const genreInfo = SONG_GENRES.find(g => g.id === activeSong.genre);
        const coWritingStyle = getLyricCoWritingStyle(activeSong.lyricCoWritingStyle);
        const paper = getPaperTheme(activeSong.coverStyle);
        const fixedSlots = buildLyricSlots(activeSong);
        const activeLines = activeSong.lines
            .filter(line => !line.isDraft)
            .map((line, fallbackIndex) => ({ line, index: line.slotIndex ?? fallbackIndex }))
            .sort((a, b) => a.index - b.index);
        const isFreeNotebook = fixedSlots.length === 0;
        const nextFreeIndex = activeLines.length
            ? Math.max(...activeLines.map(item => item.index)) + 1
            : 0;
        const notebookSlots: LyricSlot[] = isFreeNotebook
            ? [
                ...activeLines.map(({ line, index }) => ({
                    index,
                    section: line.section,
                    chars: 'Unlimited',
                    sectionOccurrence: 0,
                    lineInSection: index,
                })),
                {
                    index: nextFreeIndex,
                    section: currentSection,
                    chars: 'Unlimited',
                    sectionOccurrence: 0,
                    lineInSection: nextFreeIndex,
                },
            ]
            : fixedSlots;
        const filledCount = notebookSlots.filter(slot => !!lineAtSlot(activeSong, slot.index)?.content.trim()).length;
        const discussionSuggestions = filledCount === 0
            ? [
                "Let's talk about the one image this song most wants to leave behind",
                "Let's decide together who the narrator is and who they're speaking to",
                'Where should this song\'s mood travel from and to',
            ]
            : [
                'Which line feels most like the core of the whole song right now',
                "Is the chorus's hook focused and memorable enough",
                'Does the verse actually advance the character or the story',
                'Do the neighboring lines flow well in length and rhythm',
                'Do the current images stay within the same world',
                `What role should the current ${SECTION_LABELS[currentSection]?.label || 'section'} play`,
                coWritingStyle.id === 'adaptive'
                    ? 'Which direction should this song continue in'
                    : `Do these lines really match the "${coWritingStyle.shortLabel}" style`,
            ];
        const discussionPlaceholder = `You could chat with ${collaborator?.name || 'C'} about: ${
            discussionSuggestions[(filledCount + activeSong.comments.length) % discussionSuggestions.length]
        }……`;
        const paperBackground = `radial-gradient(circle at 14% 10%, rgba(255,255,255,.24) 0 1px, transparent 1.5px), radial-gradient(circle at 80% 35%, rgba(70,55,45,.05) 0 1px, transparent 1.5px), ${paper.background}`;

        return (
            <div
                className="h-full w-full flex flex-col font-sans relative overflow-hidden transition-colors duration-500"
                style={{ background: paperBackground, color: paper.ink }}
            >
                <ConfirmDialog
                    isOpen={!!confirmDialog}
                    title={confirmDialog?.title || ''}
                    message={confirmDialog?.message || ''}
                    variant={confirmDialog?.variant}
                    confirmText={confirmDialog?.confirmText}
                    onConfirm={confirmDialog?.onConfirm || (() => {})}
                    onCancel={() => setConfirmDialog(null)}
                />

                <div
                    className="shrink-0 z-30"
                    style={{
                        paddingTop: 'var(--safe-top)',
                        background: paper.sheet,
                        borderBottom: `1px solid ${paper.rule}`,
                        backdropFilter: 'blur(18px)',
                        WebkitBackdropFilter: 'blur(18px)',
                    }}
                >
                    <div className="h-14 flex items-center justify-between px-4">
                        <button
                            onClick={handlePause}
                            className="p-2 -ml-2 rounded-full active:scale-90 transition-transform"
                            style={{ color: paper.muted }}
                            aria-label="Back to lyric notebook shelf"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="text-center min-w-0 px-3">
                            <div className="font-semibold text-[15px] truncate max-w-[190px]" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
                                {activeSong.title}
                            </div>
                            <div className="text-[9px] tracking-[.24em] uppercase mt-0.5" style={{ color: paper.muted }}>
                                {genreInfo?.label} · {filledCount}/{isFreeNotebook ? Math.max(filledCount, 1) : notebookSlots.length} lines
                            </div>
                        </div>
                        <button
                            onClick={handleComplete}
                            className="px-3 py-1.5 rounded-full text-[11px] font-semibold active:scale-95 transition-transform"
                            style={{ color: paper.ink, border: `1px solid ${paper.rule}`, background: paper.sheet }}
                        >
                            Finish
                        </button>
                    </div>

                    <div className="px-4 pb-3 flex items-center gap-3">
                        {collaborator && (
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                <TokenImg value={collaborator.avatar} className="w-7 h-7 rounded-full object-cover" alt="" />
                                <div className="min-w-0">
                                    <div className="text-[10px] truncate" style={{ color: paper.muted }}>{collaborator.name} is looking at this notebook</div>
                                    <div className="text-[9px] truncate opacity-70">{activeSong.subtitle || 'Only the line you tap on changes each time'}</div>
                                </div>
                            </div>
                        )}
                        <button
                            onClick={() => {
                                if (coWritingStyle.category !== 'adaptive') {
                                    setLyricStyleCategory(coWritingStyle.category);
                                }
                                setShowLyricStylePicker(prev => !prev);
                                setShowStructureGuide(false);
                            }}
                            className="text-[10px] px-2.5 py-1.5 rounded-full shrink-0"
                            style={{ color: paper.muted, border: `1px solid ${paper.rule}` }}
                            title="Switch the style rules C uses when writing lyrics"
                        >
                            C · {coWritingStyle.shortLabel}
                        </button>
                        <button
                            onClick={() => {
                                setShowStructureGuide(prev => !prev);
                                setShowLyricStylePicker(false);
                            }}
                            className="text-[10px] px-2.5 py-1.5 rounded-full shrink-0"
                            style={{ color: paper.muted, border: `1px solid ${paper.rule}` }}
                        >
                            Template
                        </button>
                    </div>

                    <div className="px-4 pb-3">
                        <div
                            className="grid grid-cols-2 p-1 rounded-2xl"
                            style={{ background: 'rgba(0,0,0,.055)' }}
                        >
                            <button
                                onClick={() => setWorkMode('notebook')}
                                className="flex items-center justify-center gap-2 py-2 rounded-xl text-[11px] font-semibold transition-all duration-300"
                                style={workMode === 'notebook'
                                    ? { background: paper.sheet, color: paper.ink, boxShadow: '0 2px 10px rgba(0,0,0,.08)' }
                                    : { color: paper.muted }}
                            >
                                <BookOpenText size={14} weight={workMode === 'notebook' ? 'fill' : 'regular'} />
                                Write Lyrics
                            </button>
                            <button
                                onClick={() => setWorkMode('chat')}
                                className="flex items-center justify-center gap-2 py-2 rounded-xl text-[11px] font-semibold transition-all duration-300"
                                style={workMode === 'chat'
                                    ? { background: paper.sheet, color: paper.ink, boxShadow: '0 2px 10px rgba(0,0,0,.08)' }
                                    : { color: paper.muted }}
                            >
                                <ChatCircleDots size={14} weight={workMode === 'chat' ? 'fill' : 'regular'} />
                                Discuss
                                {feedbackGroups.length > 0 && <span className="opacity-55">{feedbackGroups.length}</span>}
                            </button>
                        </div>
                    </div>
                </div>

                {showLyricStylePicker && (
                    <div
                        className="shrink-0 z-20 px-4 py-3"
                        style={{ background: paper.sheet, borderBottom: `1px solid ${paper.rule}` }}
                    >
                        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-2">
                            {LYRIC_STYLE_CATEGORIES.map(category => {
                                const active = category.id === lyricStyleCategory;
                                return (
                                    <button
                                        key={category.id}
                                        onClick={() => setLyricStyleCategory(category.id)}
                                        className="shrink-0 px-2.5 py-1 rounded-full text-[9px] font-semibold transition-all"
                                        style={active
                                            ? { color: '#fff', background: paper.ink }
                                            : { color: paper.muted }}
                                    >
                                        {category.shortLabel}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
                            {LYRIC_CO_WRITING_STYLES
                                .filter(style => style.category === 'adaptive' || style.category === lyricStyleCategory)
                                .map(style => {
                                const active = style.id === coWritingStyle.id;
                                return (
                                    <button
                                        key={style.id}
                                        onClick={() => updateActiveLyricStyle(style.id)}
                                        className="shrink-0 px-3 py-1.5 rounded-full text-[9px] transition-all"
                                        style={active
                                            ? { color: '#fff', background: paper.accent, border: '1px solid transparent' }
                                            : { color: paper.muted, border: `1px solid ${paper.rule}` }}
                                    >
                                        {style.shortLabel}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[9px] leading-relaxed px-1" style={{ color: paper.muted }}>
                            <span className="font-semibold" style={{ color: paper.ink }}>{coWritingStyle.label}</span>
                            {' · '}
                            {coWritingStyle.desc}
                        </p>
                    </div>
                )}

                {showStructureGuide && (
                    <div
                        className="shrink-0 z-20 px-5 py-3 flex gap-2 overflow-x-auto no-scrollbar"
                        style={{ background: paper.sheet, borderBottom: `1px solid ${paper.rule}` }}
                    >
                        {isFreeNotebook ? (
                            <span className="text-[10px]" style={{ color: paper.muted }}>Free-form template · add new lines anytime</span>
                        ) : (
                            (activeSong.lyricTemplate === 'custom'
                                ? activeSong.customLyricTemplate || []
                                : getLyricTemplate(activeSong.lyricTemplate).structure
                            ).map((section, index) => (
                                <span
                                    key={`${section.section}-${index}`}
                                    className="shrink-0 px-2.5 py-1 rounded-full text-[9px]"
                                    style={{ color: paper.muted, border: `1px solid ${paper.rule}` }}
                                >
                                    {SECTION_LABELS[section.section]?.label} · {section.lines} lines × {section.chars} chars
                                </span>
                            ))
                        )}
                    </div>
                )}

                {workMode === 'notebook' ? (
                    <div className="flex-1 overflow-y-auto no-scrollbar px-3.5 py-4 pb-10">
                        {isFreeNotebook && (
                            <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-3 px-1">
                                {Object.entries(SECTION_LABELS).map(([key, info]) => (
                                    <button
                                        key={key}
                                        onClick={() => setCurrentSection(toSectionKind(key))}
                                        className="shrink-0 px-2.5 py-1 rounded-full text-[9px] transition-all"
                                        style={currentSection === key
                                            ? { color: '#fff', background: paper.accent }
                                            : { color: paper.muted, border: `1px solid ${paper.rule}` }}
                                    >
                                        Next Line · {info.label}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div
                            className="relative max-w-2xl mx-auto rounded-[24px] overflow-hidden"
                            style={{
                                background: paper.sheet,
                                boxShadow: '0 18px 50px rgba(54,43,37,.13), inset 0 1px 0 rgba(255,255,255,.45)',
                                border: `1px solid ${paper.rule}`,
                            }}
                        >
                            <div className="px-6 pt-7 pb-5 text-center">
                                <div className="text-[9px] tracking-[.42em] uppercase" style={{ color: paper.muted }}>lyric notebook</div>
                                <h2 className="text-[22px] mt-2 leading-tight" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>{activeSong.title}</h2>
                                {activeSong.subtitle && <p className="text-[11px] mt-2 italic" style={{ color: paper.muted }}>{activeSong.subtitle}</p>}
                                <div className="w-10 h-px mx-auto mt-5" style={{ background: paper.rule }} />
                            </div>

                            <div className="px-4 pb-8">
                                {notebookSlots.map(slot => {
                                    const line = lineAtSlot(activeSong, slot.index);
                                    const value = lineDrafts[slot.index] ?? line?.content ?? '';
                                    const charCount = Array.from(value.trim()).length;
                                    const sectionStart = slot.lineInSection === 0;
                                    const isGenerating = generatingSlotIndex === slot.index;
                                    return (
                                        <div key={slot.index}>
                                            {sectionStart && (
                                                <div className="flex items-center gap-3 pt-5 pb-2 px-2">
                                                    <span className="text-[9px] tracking-[.28em] uppercase font-semibold" style={{ color: paper.muted }}>
                                                        {SECTION_LABELS[slot.section]?.label || slot.section}
                                                        {slot.sectionOccurrence > 0 ? ` ${slot.sectionOccurrence + 1}` : ''}
                                                    </span>
                                                    <div className="h-px flex-1" style={{ background: paper.rule }} />
                                                </div>
                                            )}
                                            <div
                                                className="group grid grid-cols-[28px_1fr_42px] gap-2 items-center px-2 min-h-[54px]"
                                                style={{ borderBottom: `1px solid ${paper.rule}` }}
                                            >
                                                <div className="text-[10px] tabular-nums text-center" style={{ color: paper.muted }}>
                                                    {String(slot.index + 1).padStart(2, '0')}
                                                </div>
                                                <div className="relative min-w-0">
                                                    <textarea
                                                        value={value}
                                                        onChange={event => setLineDrafts(prev => ({ ...prev, [slot.index]: event.target.value }))}
                                                        onBlur={() => {
                                                            if (value.trim() !== (line?.content || '').trim()) saveNotebookLine(slot, value, 'user');
                                                        }}
                                                        onKeyDown={event => {
                                                            if (event.key === 'Enter' && !event.shiftKey) {
                                                                event.preventDefault();
                                                                event.currentTarget.blur();
                                                            }
                                                        }}
                                                        rows={1}
                                                        placeholder={`Line ${slot.index + 1} · ${slot.chars === 'Unlimited' ? 'Write whatever comes to mind' : `suggested ${slot.chars} chars`}`}
                                                        className="w-full bg-transparent resize-none outline-none py-4 pr-10 text-[15px] leading-6 placeholder:opacity-35"
                                                        style={{ color: paper.ink, fontFamily: 'Georgia, "Noto Serif SC", serif' }}
                                                        aria-label={`Lyric line ${slot.index + 1}`}
                                                    />
                                                    <span className="absolute right-0 bottom-1.5 text-[8px] tabular-nums" style={{ color: paper.muted }}>
                                                        {charCount}{slot.chars !== 'Unlimited' ? `/${slot.chars}` : ''}
                                                    </span>
                                                    {line && (
                                                        <span className="absolute right-0 top-1 text-[8px]" style={{ color: paper.muted }}>
                                                            {line.authorId === 'user' ? 'Me' : collaborator?.name || 'C'}
                                                        </span>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => handleGenerateNotebookLine(slot)}
                                                    disabled={generatingSlotIndex !== null}
                                                    className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all disabled:opacity-45"
                                                    style={{ color: paper.ink, border: `1px solid ${paper.rule}`, background: 'rgba(255,255,255,.24)' }}
                                                    title={line ? `Have ${collaborator?.name || 'C'} rewrite line ${slot.index + 1}` : `Have ${collaborator?.name || 'C'} generate line ${slot.index + 1}`}
                                                    aria-label={line ? 'Refresh this line' : 'Generate this line'}
                                                >
                                                    {isGenerating
                                                        ? <ArrowsClockwise size={14} className="animate-spin" />
                                                        : line
                                                            ? <ArrowsClockwise size={14} />
                                                            : <SparkleP size={14} weight="fill" />}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="px-6 pb-7 flex items-center justify-between text-[9px]" style={{ color: paper.muted }}>
                                <span>{collaborator?.name || 'C'} reads the whole notebook, but only edits the line you tap</span>
                                <span>{filledCount} lines written</span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-5 pb-28" ref={scrollRef}>
                            {feedbackGroups.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-center px-10 pb-16">
                                    {collaborator && <TokenImg value={collaborator.avatar} className="w-14 h-14 rounded-full object-cover mb-5 opacity-90" alt="" />}
                                    <p className="text-[14px]" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>This space is just for discussion — it won't touch your lyrics</p>
                                    <p className="text-[10px] mt-2 leading-5" style={{ color: paper.muted }}>Ask about structure, request feedback, discuss rhyme — for writing, go back to "Write Lyrics".</p>
                                </div>
                            )}
                            <div className="space-y-4 max-w-2xl mx-auto">
                                {feedbackGroups.map(group => {
                                    const lead = group.reaction || group.details[0];
                                    if (!lead) return null;
                                    const isUserMessage = lead.authorId === 'user';
                                    const details = group.details.filter(detail => detail.id !== lead.id);
                                    const expanded = !!expandedFeedbackIds[group.id];
                                    return (
                                        <div key={group.id} className={`flex gap-2.5 ${isUserMessage ? 'justify-end' : 'justify-start'}`}>
                                            {!isUserMessage && collaborator && <TokenImg value={collaborator.avatar} className="w-7 h-7 rounded-full object-cover shrink-0 mt-1" alt="" />}
                                            <div className={`max-w-[82%] ${isUserMessage ? 'items-end' : 'items-start'} flex flex-col`}>
                                                <div
                                                    className={`px-4 py-3 text-[13px] leading-6 ${isUserMessage ? 'rounded-[18px_18px_5px_18px]' : 'rounded-[18px_18px_18px_5px]'}`}
                                                    style={isUserMessage
                                                        ? { background: paper.accent, color: '#fff' }
                                                        : { background: paper.sheet, color: paper.ink, border: `1px solid ${paper.rule}` }}
                                                >
                                                    <p className="whitespace-pre-wrap">{lead.content}</p>
                                                    {!isUserMessage && details.length > 0 && expanded && (
                                                        <div className="mt-3 pt-3 space-y-2" style={{ borderTop: `1px solid ${paper.rule}` }}>
                                                            {details.map(detail => (
                                                                <p key={detail.id} className="text-[11px] whitespace-pre-wrap" style={{ color: paper.muted }}>{detail.content}</p>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 mt-1.5 px-1">
                                                    {!isUserMessage && details.length > 0 && (
                                                        <button onClick={() => toggleFeedback(group.id)} className="text-[9px]" style={{ color: paper.muted }}>
                                                            {expanded ? 'Collapse' : `Show ${details.length} more details`}
                                                        </button>
                                                    )}
                                                    <button onClick={() => handleDeleteFeedback(group.id)} className="text-[9px] opacity-0 group-hover:opacity-100" style={{ color: paper.muted }}>Delete</button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                {isTyping && (
                                    <div className="flex items-center gap-2.5">
                                        {collaborator && <TokenImg value={collaborator.avatar} className="w-7 h-7 rounded-full object-cover" alt="" />}
                                        <div className="px-4 py-3 rounded-[18px_18px_18px_5px] flex gap-1.5" style={{ background: paper.sheet, border: `1px solid ${paper.rule}` }}>
                                            {[0, 1, 2].map(index => <span key={index} className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: paper.muted, animationDelay: `${index * 90}ms` }} />)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div
                            className="absolute bottom-0 left-0 right-0 z-30 pb-safe"
                            style={{ background: paper.sheet, borderTop: `1px solid ${paper.rule}`, backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}
                        >
                            <div className="p-3 flex gap-2 items-end">
                                <textarea
                                    value={inputText}
                                    onChange={event => setInputText(event.target.value)}
                                    placeholder={discussionPlaceholder}
                                    rows={1}
                                    className="flex-1 rounded-2xl px-4 py-3 text-[13px] outline-none resize-none max-h-28 placeholder:opacity-45"
                                    style={{ minHeight: 44, background: paper.sheet, color: paper.ink, border: `1px solid ${paper.rule}` }}
                                    onKeyDown={event => {
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            handleDiscuss();
                                        }
                                    }}
                                />
                                <button
                                    onClick={handleDiscuss}
                                    disabled={isTyping || !inputText.trim()}
                                    className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-transform disabled:opacity-35"
                                    style={{ background: paper.accent, color: '#fff' }}
                                    aria-label="Send discussion message"
                                >
                                    <ChatCircleDots size={17} weight="fill" />
                                </button>
                            </div>
                        </div>
                    </>
                )}

                <Modal isOpen={showPreviewModal} title="Finish Writing" onClose={() => setShowPreviewModal(false)}>
                    <div className="space-y-4">
                        <div className="bg-stone-50 border border-stone-200 p-4 rounded-lg">
                            <h3 className="text-sm font-medium text-stone-600 mb-2">Co-writer's Review</h3>
                            <p className="text-sm text-stone-500 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
                                {isCompleting ? 'Thinking……' : completionReview}
                            </p>
                        </div>
                        <p className="text-[11px] text-stone-400 leading-5">Once finished, the song will be saved as a songsheet and a notification will be sent in chat. You can also share the songsheet with other characters anytime.</p>
                        {!isCompleting && (
                            <button onClick={confirmComplete} className="w-full py-3 bg-stone-700 text-stone-50 font-medium rounded-lg text-sm">
                                Finish
                            </button>
                        )}
                    </div>
                </Modal>
            </div>
        );
    }

    return null;
};

export default SongwritingApp;
