
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, DiaryEntry, StickerData, DiaryPage, MemoryFragment, type JournalAppearance } from '../types';
import { ContextBuilder } from '../utils/context';
import { processImage } from '../utils/file';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import { isImageValue } from '../utils/blobRef';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { normalizeMessageContent } from '../utils/messageFormat';
import { injectMemoryPalace, ingestDiaryToPalace, type DiaryIngestResult } from '../utils/memoryPalace/pipeline';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { Sparkle, Archive } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import JournalAppearanceButton, { JournalAppearanceStyle } from '../components/journal/JournalAppearanceEditor';
import JournalThemeArtwork from '../components/journal/JournalThemeArtwork';

const INTRO_SEEN_KEY = 'journal_app_intro_seen_v4';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// --- Assets & Constants ---

const PAPER_STYLES = [
    { id: 'plain', name: 'Plain', css: 'bg-white', text: 'text-slate-700' },
    { id: 'grid', name: 'Grid', css: 'bg-white', text: 'text-slate-700', style: { backgroundImage: 'linear-gradient(#e5e7eb 1px, transparent 1px), linear-gradient(90deg, #e5e7eb 1px, transparent 1px)', backgroundSize: '20px 20px' } },
    { id: 'dot', name: 'Dot', css: 'bg-[#fffdf5]', text: 'text-slate-700', style: { backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', backgroundSize: '20px 20px' } },
    { id: 'lined', name: 'Lined', css: 'bg-[#fefce8]', text: 'text-slate-700', style: { backgroundImage: 'repeating-linear-gradient(transparent, transparent 23px, #e5e7eb 23px, #e5e7eb 24px)' } },
    { id: 'dark', name: 'Night Sky', css: 'bg-slate-800', text: 'text-white/90' },
    { id: 'pink', name: 'Blossom', css: 'bg-pink-50', text: 'text-slate-700', style: { backgroundImage: 'radial-gradient(#fbcfe8 2px, transparent 2px)', backgroundSize: '30px 30px' } },
];

const DEFAULT_STICKERS = [
    twemojiUrl('2728'), twemojiUrl('1f496'), twemojiUrl('1f338'), twemojiUrl('1f380'), twemojiUrl('1f370'),
    twemojiUrl('1f431'), twemojiUrl('1f436'), twemojiUrl('2601-fe0f'), twemojiUrl('1f319'), twemojiUrl('2b50'),
    twemojiUrl('1f3b5'), twemojiUrl('1f33f'), twemojiUrl('1f353'), twemojiUrl('1f9f8'), twemojiUrl('1f388'),
    twemojiUrl('1f48c'), twemojiUrl('1f4a4'), twemojiUrl('1f97a'), twemojiUrl('1f621'), twemojiUrl('1f62d'),
];

// Last-resort fallback: when extractJson can't recover anything, the content might be
// "prose the model wrote instead of JSON," or it might be "JSON that's too broken to fix."
// The former can be used as-is for the diary body; the latter must never expose the whole
// { "text": "..." } blob to the user. This does one final salvage pass: if the content looks
// like a JSON object with a text field, regex out the text value and unescape it;
// otherwise return it unchanged.
const salvageDiaryText = (raw: string): string => {
    const s = (raw || '').trim();
    if (!s.startsWith('{') || !/"text"\s*:/.test(s)) return s;
    const m = s.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!m) return s;
    try {
        // Use JSON.parse to restore escapes like \n \" \\; fall back to manual replacement of common escapes on failure
        return JSON.parse(`"${m[1]}"`);
    } catch {
        return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
};

// HELPER: Get local date string YYYY-MM-DD
const getLocalDateStr = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const JournalApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast, userProfile, updateCharacter, memoryPalaceConfig, characterGroups, theme } = useOS();
    // The preview draft only lives inside the current JournalApp session, never written to
    // theme/localStorage. State is kept at the App's top level so the same CSS preview
    // persists across switching between the select, list, and write pages.
    const [previewJournalAppearance, setPreviewJournalAppearance] = useState<JournalAppearance | undefined>();
    const effectiveJournalAppearance = previewJournalAppearance || theme.journalAppearance;
    // The original Amber theme strictly keeps the old single-page layout; other themes have their own physical/device-style layouts.
    const effectiveJournalPreset = effectiveJournalAppearance?.preset || 'original';
    const journalUsesScrapbookLayout = effectiveJournalPreset !== 'original';
    const journalLayoutClass = journalUsesScrapbookLayout
        ? ` sully-journal-designed sully-journal-theme-${effectiveJournalPreset}`
        : '';
    const journalAppearanceButtonProps = {
        previewAppearance: previewJournalAppearance,
        isPreviewing: Boolean(previewJournalAppearance),
        onStartPreview: setPreviewJournalAppearance,
        onCancelPreview: () => setPreviewJournalAppearance(undefined),
    };

    const [mode, setMode] = useState<'select' | 'calendar' | 'write'>('select');
    const [selectedChar, setSelectedChar] = useState<CharacterProfile | null>(null);
    const [journalGroupId, setJournalGroupId] = useState<string>(GROUP_FILTER_ALL); // Group filter for the notebook select page
    const [diaries, setDiaries] = useState<DiaryEntry[]>([]);
    const [currentEntry, setCurrentEntry] = useState<DiaryEntry | null>(null);
    const [selectedDate, setSelectedDate] = useState<string>(getLocalDateStr());

    // Onboarding popup (one-time)
    const [showIntro, setShowIntro] = useState<boolean>(() => {
        try { return !localStorage.getItem(INTRO_SEEN_KEY); } catch { return false; }
    });
    const dismissIntro = () => {
        try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
        setShowIntro(false);
    };

    // Editor State
    const [isThinking, setIsThinking] = useState(false);
    const [archivingId, setArchivingId] = useState<string | null>(null);
    const [archiveResult, setArchiveResult] = useState<{
        date: string;
        charName: string;
        summary: string;
        summaryOrigin: 'palace_bullets' | 'prose_fallback';
        palace: DiaryIngestResult | null;
    } | null>(null);
    const [showStickerPanel, setShowStickerPanel] = useState(false);
    const [activeTab, setActiveTab] = useState<'user' | 'char'>('user'); // View Tab
    const [hideCharStickers, setHideCharStickers] = useState(false); // Toggle to hide char stickers
    
    // Sticker Interaction State
    const [draggingSticker, setDraggingSticker] = useState<string | null>(null);
    const [selectedStickerId, setSelectedStickerId] = useState<string | null>(null); // For resizing/deleting
    const [resizingSticker, setResizingSticker] = useState<string | null>(null);
    const paperRef = useRef<HTMLDivElement>(null);
    
    // Custom Stickers State (Separate from Chat Emojis)
    const [customStickers, setCustomStickers] = useState<{name: string, url: string}[]>([]);
    const [showImportModal, setShowImportModal] = useState(false);
    const [importText, setImportText] = useState('');
    const [deletingSticker, setDeletingSticker] = useState<{name: string, url: string} | null>(null);
    const [deletingDiary, setDeletingDiary] = useState<DiaryEntry | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- Data Loading ---

    useEffect(() => {
        if (characters.length > 0 && activeCharacterId) {
            const initial = characters.find(c => c.id === activeCharacterId);
            if (initial) {
                setSelectedChar(initial);
                setMode('calendar');
                loadDiaries(initial.id);
            }
        }
        // Load custom stickers from new journal store
        DB.getJournalStickers().then(setCustomStickers);
    }, [activeCharacterId]);

    const loadDiaries = async (charId: string) => {
        const list = await DB.getDiariesByCharId(charId);
        setDiaries(list.sort((a, b) => b.date.localeCompare(a.date)));
    };

    const handleCharSelect = (char: CharacterProfile) => {
        setSelectedChar(char);
        setMode('calendar');
        loadDiaries(char.id);
    };

    const openEntry = (date: string) => {
        const existing = diaries.find(d => d.date === date);
        if (existing) {
            setCurrentEntry(existing);
            // Default to char tab if they replied
            setActiveTab(existing.charPage ? 'char' : 'user');
        } else {
            // New Entry — sets autoSync=true, so the manual archive button won't show in the list afterward
            setCurrentEntry({
                id: `diary-${Date.now()}`,
                charId: selectedChar!.id,
                date: date,
                userPage: { text: '', paperStyle: 'grid', stickers: [] },
                timestamp: Date.now(),
                isArchived: false,
                autoSync: true,
            });
            setActiveTab('user');
        }
        setMode('write');
        setSelectedDate(date);
        setSelectedStickerId(null); // Reset selection
        trackEvent('Enter Diary Writing Page');
    };

    // --- Editor Logic ---

    const updatePage = (updates: Partial<DiaryEntry['userPage']>, side: 'user' | 'char' = 'user') => {
        if (!currentEntry) return;
        const targetPage = side === 'user' ? 'userPage' : 'charPage';
        
        // If char page doesn't exist yet, init it
        let pageData = currentEntry[targetPage] || { text: '', paperStyle: 'plain', stickers: [] };
        
        setCurrentEntry(prev => {
            if (!prev) return null;
            return {
                ...prev,
                [targetPage]: { ...pageData, ...updates }
            };
        });
    };

    const addSticker = (url: string) => {
        const side = activeTab;
        const targetPage = side === 'user' ? currentEntry?.userPage : currentEntry?.charPage;
        if (!targetPage && side === 'char') return;

        const newSticker: StickerData = {
            id: `st-${Date.now()}-${Math.random()}`,
            url,
            x: 50,
            y: 50,
            rotation: (Math.random() - 0.5) * 40,
            scale: 1.0 // Default scale
        };
        
        const currentStickers = targetPage?.stickers || [];
        updatePage({ stickers: [...currentStickers, newSticker] }, side);
        setShowStickerPanel(false);
        trackEvent('Add Sticker to Diary Page', { kind: DEFAULT_STICKERS.includes(url) ? 'default' : 'custom' });
    };

    const handleImportStickers = async () => {
        if (!importText.trim()) return;
        const lines = importText.split('\n');
        let count = 0;
        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    await DB.saveJournalSticker(name, url); // Changed Store
                    count++;
                }
            }
        }
        setCustomStickers(await DB.getJournalStickers()); // Changed Store
        setImportText('');
        setShowImportModal(false);
        addToast(`Added ${count} sticker(s)`, 'success');
        trackEvent('Import Custom Stickers');
    };

    const handleDeleteStickerAsset = async () => {
        if (deletingSticker) {
            await DB.deleteJournalSticker(deletingSticker.name); // Changed Store
            setCustomStickers(prev => prev.filter(s => s.name !== deletingSticker.name));
            setDeletingSticker(null);
            addToast('Sticker deleted', 'success');
            trackEvent('Delete Custom Sticker');
        }
    };

    // Serialize a diary entry into a score_card payload (includes the paper style name and other fields the card display needs)
    const buildDiaryCardPayload = (entry: DiaryEntry, char: CharacterProfile) => {
        const userPaperName = PAPER_STYLES.find(p => p.id === entry.userPage.paperStyle)?.name || 'Plain';
        const charPaperName = entry.charPage
            ? (PAPER_STYLES.find(p => p.id === entry.charPage!.paperStyle)?.name || 'Plain')
            : '';
        return {
            type: 'diary_card',
            date: entry.date,
            charName: char.name,
            charAvatar: char.avatar || '',
            userName: userProfile.name,
            userText: entry.userPage.text,
            charText: entry.charPage?.text || '',
            userPaperStyle: entry.userPage.paperStyle,
            userPaperName,
            charPaperStyle: entry.charPage?.paperStyle || '',
            charPaperName,
            userStickerCount: entry.userPage.stickers?.length || 0,
            charStickerCount: entry.charPage?.stickers?.length || 0,
        };
    };

    // Sync a diary entry that already has a charPage to the chat (create or update the score_card).
    // No charPage → do nothing (a one-sided diary doesn't enter context — this is a product rule).
    // Returns the final entry with chatCardMessageId, for the caller to follow up with setCurrentEntry/saveDiary.
    const syncDiaryCardToChat = async (entry: DiaryEntry, char: CharacterProfile): Promise<DiaryEntry> => {
        if (!entry.charPage) return entry;
        const cardData = buildDiaryCardPayload(entry, char);

        if (entry.chatCardMessageId) {
            try {
                await DB.updateMessage(entry.chatCardMessageId, JSON.stringify(cardData));
                await DB.updateMessageMetadata(entry.chatCardMessageId, prev => ({
                    ...(prev || {}),
                    scoreCard: cardData,
                    source: 'journal-exchange',
                }));
                return entry;
            } catch (e) {
                console.warn('🗒 [Journal] Failed to update existing card, recreating:', e);
            }
        }
        const newId = await DB.saveMessage({
            charId: char.id,
            role: 'system',
            type: 'score_card',
            content: JSON.stringify(cardData),
            metadata: { scoreCard: cardData, source: 'journal-exchange' },
        });
        return { ...entry, chatCardMessageId: newId };
    };

    const saveEntry = async (options: { silent?: boolean } = {}) => {
        if (!currentEntry || !selectedChar) return;
        // If this diary already has a card in chat (char replied + auto-sent), sync-update the card on save
        let toSave = currentEntry;
        if (currentEntry.chatCardMessageId && currentEntry.charPage) {
            toSave = await syncDiaryCardToChat(currentEntry, selectedChar);
        }
        await DB.saveDiary(toSave);
        if (toSave !== currentEntry) setCurrentEntry(toSave);
        await loadDiaries(toSave.charId);
        if (!options.silent) addToast('Diary saved', 'success');
    };

    const handleDeleteDiary = async () => {
        if (!deletingDiary || !selectedChar) return;
        // Sync-delete the card in chat (if one was sent before)
        if (deletingDiary.chatCardMessageId) {
            try { await DB.deleteMessage(deletingDiary.chatCardMessageId); }
            catch (e) { console.warn('🗒 [Journal] Failed to delete card (may already be gone):', e); }
        }
        await DB.deleteDiary(deletingDiary.id);
        await loadDiaries(selectedChar.id);
        setDeletingDiary(null);
        addToast('Diary deleted', 'success');
        trackEvent('Delete Diary Entry');
    };

    // --- Interaction Logic (Move, Resize, Delete) ---

    // 1. Selection
    const selectSticker = (e: React.MouseEvent | React.TouchEvent, id: string) => {
        e.stopPropagation();
        setSelectedStickerId(id);
    };

    // 2. Remove Sticker from Page
    const removeStickerFromPage = (id: string) => {
        const targetPage = activeTab === 'user' ? currentEntry?.userPage : currentEntry?.charPage;
        if (!targetPage) return;
        const updated = targetPage.stickers.filter(s => s.id !== id);
        updatePage({ stickers: updated }, activeTab);
        setSelectedStickerId(null);
        trackEvent('Remove Sticker from Diary Page');
    };

    // 3. Pointer Handlers (Move & Resize)
    const handlePointerDown = (e: React.PointerEvent, stickerId: string, action: 'move' | 'resize') => {
        // Allow editing on char page too now
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        
        if (action === 'move') {
            setDraggingSticker(stickerId);
            setSelectedStickerId(stickerId); // Select on drag start
        } else {
            setResizingSticker(stickerId);
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if ((!draggingSticker && !resizingSticker) || !paperRef.current || !currentEntry) return;

        const rect = paperRef.current.getBoundingClientRect();
        
        const targetPage = activeTab === 'user' ? currentEntry.userPage : currentEntry.charPage;
        if (!targetPage) return;

        // Logic for Moving
        if (draggingSticker) {
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            const clampedX = Math.max(0, Math.min(100, x));
            const clampedY = Math.max(0, Math.min(100, y));

            const updatedStickers = targetPage.stickers.map(s => 
                s.id === draggingSticker ? { ...s, x: clampedX, y: clampedY } : s
            );
            updatePage({ stickers: updatedStickers }, activeTab);
        }

        // Logic for Resizing
        if (resizingSticker) {
            const sticker = targetPage.stickers.find(s => s.id === resizingSticker);
            if (!sticker) return;

            // Simple scale logic based on distance from center of sticker (simulated by pointer position relative to paper)
            const dx = (e.clientX - rect.left) - (sticker.x / 100 * rect.width);
            const dy = (e.clientY - rect.top) - (sticker.y / 100 * rect.height);
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            // Assume 50px is scale 1
            const newScale = Math.max(0.2, Math.min(3.0, dist / 40));
            
            const updatedStickers = targetPage.stickers.map(s => 
                s.id === resizingSticker ? { ...s, scale: newScale } : s
            );
            updatePage({ stickers: updatedStickers }, activeTab);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        setDraggingSticker(null);
        setResizingSticker(null);
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    const handleBackgroundClick = () => {
        setSelectedStickerId(null); // Deselect when clicking background
    };

    // Long press handler for drawer items
    const handleDrawerTouchStart = (s: {name: string, url: string}) => {
        longPressTimer.current = setTimeout(() => {
            setDeletingSticker(s);
        }, 600);
    };

    const handleDrawerTouchEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    // --- AI Interaction ---

    const handleExchange = async () => {
        if (!currentEntry || !selectedChar || !apiConfig.apiKey) {
            addToast('Configuration error or empty content', 'error');
            return;
        }
        if (!currentEntry.userPage.text.trim()) {
            addToast('Please write your diary for today first', 'info');
            return;
        }

        const isRewrite = Boolean(currentEntry.charPage);
        setIsThinking(true);
        addToast(isRewrite ? `Asking ${selectedChar.name} to rewrite this diary…` : `Asking ${selectedChar.name} to write an exchange diary…`, 'info');
        trackEvent(isRewrite ? 'Regenerate Character Diary' : 'Invite Character to Exchange Diary');

        try {
            // The user page draft still needs to be persisted before generation, but this is an internal
            // step of the rewrite flow — it must not look like the user actively clicked "Save."
            // The old code called saveEntry() directly here, which popped a "Diary saved" toast during the rewrite loop.
            await saveEntry({ silent: true });
            await injectMemoryPalace(selectedChar, undefined, currentEntry.userPage.text);
            let systemPrompt = ContextBuilder.buildCoreContext(selectedChar, userProfile);

            const styleOptions = PAPER_STYLES.map(p => p.id).join(', ');
            const defaultStickers = DEFAULT_STICKERS.join(' ');
            const customStickerContext = customStickers.length > 0
                ? `Custom Stickers (Name: URL): \n${customStickers.map(s => `- ${s.name}: ${s.url}`).join('\n')}`
                : '';

            const recentMsgs = await DB.getMessagesByCharId(selectedChar.id);
            const contextLimit = 30;
            // Use the shared normalizeMessageContent to turn messages into readable text — never dump m.content
            // directly: a score_card's (including one synced in from a previous exchange-diary round) content is
            // a whole JSON blob containing the charAvatar base64 data URL plus the full text of both diary pages.
            // When regenerating, this card is already in history — dumping the raw content would flood the prompt
            // with the base64 avatar and JSON structure, causing abnormal token bloat. After normalizing, a diary
            // card gets compressed into a one-line summary, so the base64/JSON no longer leaks through.
            const recentContext = recentMsgs.slice(-contextLimit).map(m => {
                const content = normalizeMessageContent(m, selectedChar.name, userProfile.name);
                return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.role === 'user' ? 'User' : 'You'}: ${content}`;
            }).join('\n');

            systemPrompt += `### [Exchange Diary Mode Instructions]
You are having an [Exchange Diary] interaction with the user.

### Key: Recent Interactions (Recent Context)
This is your recent conversation log with the user, from chat or dates. Please **make sure** to read this log and mention specific things that happened today (e.g. topics discussed, places visited, images the user sent).
Don't just write a vague reply — also share something the user doesn't know, a thought you haven't voiced, and something from today that happened independently of the user.
[RECENT LOGS START]
${recentContext}
[RECENT LOGS END]

### Task
1. Read the user's diary for today (${currentEntry.date}).
2. Write a **reply diary entry** in your character's voice.
   - First, respond to the user's content using the chat log above.
   - Most importantly, share your own life — this part is required. **You must mention at least one thing you did today that the user doesn't know about, ideally unrelated to the user. The user wants to see a side of you that's entirely your own.**
   - The tone should stay true to your persona, but lean more literary and poetic — character personality always comes first.
3. Choose a paper style and stickers that fit your mood.

### About Stickers
You may use the default emoji, or the [Custom Stickers] below.
${customStickerContext}
To use a Custom Sticker, put its URL directly into the returned stickers array.

### Output Format (must be pure JSON)
- Output only the JSON object itself, no extra text before or after.
- text is a JSON string: internal line breaks must be written as \\n, quotes as \\", and backslashes as \\\\. **Never** put a real line break or unescaped quote directly in the string, or parsing will fail.
Structure:
{
  "text": "First paragraph of the diary entry\\n\\nSecond paragraph...",
  "paperStyle": "one of: ${styleOptions}",
  "stickers": ["sticker1", "http://custom-sticker-url..."] (choose 0-3 from the default list or Custom Stickers)
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `Users Diary:\n${currentEntry.userPage.text}` }
                    ],
                    temperature: 0.85
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            let content = data.choices[0].message.content.trim();
            content = content.replace(/```json/g, '').replace(/```/g, '').trim();
            
            // Claude often returns JSON with unescaped special characters (quotes / backslashes / line breaks),
            // and a bare JSON.parse chokes on it. The old code, when it choked, dumped the raw JSON blob
            // ({ "text": ... } with literal \n) straight into the diary body — this is the "exchange diary loses
            // its formatting" bug. Now it first goes through extractJson's multi-layer fallback tolerance; only if
            // that also fails to parse (the model didn't write JSON at all, just prose) does it fall back to
            // treating the content as plain text — and even then it strips one more layer of any leftover JSON
            // shell, guaranteeing { "text": ... } never leaks to the user under any circumstance.
            let parsed: any = extractJson(content);
            if (!parsed || typeof parsed.text !== 'string') {
                parsed = { text: salvageDiaryText(content), paperStyle: 'plain', stickers: [] };
            }

            const charStickers: StickerData[] = (parsed.stickers || []).map((s: string) => ({
                id: `st-${Math.random()}`,
                url: s,
                x: Math.random() * 70 + 10,
                y: Math.random() * 70 + 10,
                rotation: (Math.random() - 0.5) * 40,
                scale: 1.0
            }));

            const charPage: DiaryPage = {
                text: parsed.text || '',
                paperStyle: PAPER_STYLES.find(p => p.id === parsed.paperStyle)?.id || 'plain',
                stickers: charStickers
            };

            const updatedEntry = { ...currentEntry, charPage };
            // Auto-send / sync to chat: once the char has replied, the card lands in that character's chat history.
            // Re-exchanging (asking the char to rewrite their reply on the same diary) reuses the existing
            // chatCardMessageId and updates it instead of creating a new one.
            const synced = await syncDiaryCardToChat(updatedEntry, selectedChar);
            setCurrentEntry(synced);
            await DB.saveDiary(synced);
            await loadDiaries(selectedChar.id);
            setActiveTab('char');
            addToast(isRewrite ? 'Character diary rewritten · synced to chat' : 'They replied · synced to chat', 'success');

        } catch (e: any) {
            addToast(`${isRewrite ? 'Rewrite diary' : 'Exchange diary'} failed: ${e.message}`, 'error');
        } finally {
            setIsThinking(false);
        }
    };

    // Manual archive: summarize a diary entry into a Neural Link entry (char.memories), matching how
    // chatapp does auto-archival —
    //   - Memory Palace enabled: goes through the secondary API's extractMemoriesFromBuffer to extract
    //     multiple MemoryNodes in one pass → nodes enter the palace, the same batch of nodes gets turned
    //     into bullets and written to char.memories as a MemoryFragment (mood='diary_palace'). The main
    //     API is not called. The bullets in Neural Link map strictly 1:1 to the palace nodes.
    //   - Memory Palace disabled / secondary API missing / secondary API extracted nothing: falls back to
    //     the main API with an upgraded prompt producing a 150-300 character prose summary → written to
    //     char.memories (mood='diary'). This is the upgraded version of the old path.
    //
    // mood uses 'diary_palace' / 'diary' to distinguish from chatapp auto-archival's 'palace', to avoid
    // being mistakenly merged by mergePalaceFragmentsIntoMemories into the same day's chat palace bullets.
    // The recall pipeline doesn't look at mood — it's only metadata/a UI badge — so both moods enter chat
    // context normally.
    const handleArchiveDiary = async (diary: DiaryEntry) => {
        if (!selectedChar || diary.isArchived) return;
        if (!apiConfig.apiKey) { addToast('Please configure the main API first', 'error'); return; }
        if (!diary.userPage.text.trim() && !diary.charPage?.text?.trim()) {
            addToast('Diary content is empty, cannot archive', 'info');
            return;
        }

        setArchivingId(diary.id);
        trackEvent('Archive Diary into Neural Link');

        // Main API prose summary — fallback for when Memory Palace is off / the secondary API is missing / extraction returns nothing
        const generateProseSummary = async (): Promise<string> => {
            const baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile);
            const charPart = diary.charPage?.text?.trim() || '(they did not reply)';
            const prompt = `${baseContext}

### [System Instruction: Exchange Diary Archival]
Current task: summarize this [Exchange Diary] entry (dated ${diary.date}) into a memory that will remain valid for you (${selectedChar.name}) long-term.

### Input
${userProfile.name}'s page:
"""
${diary.userPage.text || '(blank page)'}
"""

Your (${selectedChar.name}) reply page:
"""
${charPart}
"""

### Output Requirements
1. **First person**: refer to yourself as "I" throughout, and refer to the other party as "${userProfile.name}" — do not write this as third-person narration.
2. **Cover the key points**: at minimum, cover the following (write it if present, skip it if not — do not invent anything):
   - ${userProfile.name}'s key events / mood / people or things mentioned that day
   - Your reaction to, resonance with, or unspoken thoughts about their content
   - What you shared about yourself on your own page
   - Any promises, plans, or unresolved questions that came up — name them explicitly (they may need to be followed up on later)
3. **Specifics over abstraction**: favor concrete details (names, places, objects, the mood at the time) over empty phrases like "we had a wonderful day."
4. **Length**: a single narrative passage of 150-300 characters, no paragraph breaks, no lists, no prefix or heading — go straight into the narrative.
`;
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.4,
                    max_tokens: 1200,
                }),
            });
            if (!response.ok) throw new Error(`Main API failed (${response.status})`);
            const data = await safeResponseJson(response);
            let s = (data.choices?.[0]?.message?.content || '').trim();
            s = s.replace(/^["'「『]|["'」』]$/g, '').trim();
            if (!s) throw new Error('Archive summary is empty');
            return s;
        };

        try {
            // 1. If the palace is enabled, run the secondary API extraction pass first — its success/failure decides which Neural Link path is taken
            let palaceResult: DiaryIngestResult | null = null;
            if (selectedChar.memoryPalaceEnabled) {
                try {
                    palaceResult = await ingestDiaryToPalace(
                        selectedChar,
                        diary.date,
                        diary.userPage.text,
                        diary.charPage?.text || '',
                        memoryPalaceConfig?.lightLLM as any,
                        userProfile.name,
                    );
                } catch (e: any) {
                    console.warn('🏰 [Journal] Failed to enter the palace:', e);
                    palaceResult = null;
                }
            } else {
                palaceResult = { status: 'palace_disabled' };
            }

            // 2. Decide the Neural Link entry's summary / mood
            //    Palace succeeded (status==='done' and nodes non-empty) → bulletize, mood='diary_palace'
            //    Everything else → main API prose fallback, mood='diary'
            let summary: string;
            let mood: string;
            let summaryOrigin: 'palace_bullets' | 'prose_fallback';
            if (palaceResult && palaceResult.status === 'done' && palaceResult.nodes.length > 0) {
                summary = palaceResult.nodes
                    .map(n => `- ${(n.content || '').replace(/\n/g, ' ').trim()}`)
                    .filter(line => line.length > 2)
                    .join('\n');
                mood = 'diary_palace';
                summaryOrigin = 'palace_bullets';
            } else {
                summary = await generateProseSummary();
                mood = 'diary';
                summaryOrigin = 'prose_fallback';
            }

            // 3. Neural Link (char.memories): date matches the diary's day
            const newMem: MemoryFragment = {
                id: `mem-diary-${Date.now()}`,
                date: diary.date,
                summary,
                mood,
            };
            updateCharacter(selectedChar.id, {
                memories: [...(selectedChar.memories || []), newMem],
            });

            // 4. Mark isArchived to prevent duplicates
            const updatedDiary: DiaryEntry = { ...diary, isArchived: true };
            await DB.saveDiary(updatedDiary);
            if (currentEntry?.id === diary.id) setCurrentEntry(updatedDiary);
            await loadDiaries(selectedChar.id);

            // 5. Show a modal with the full archive result
            setArchiveResult({
                date: diary.date,
                charName: selectedChar.name,
                summary,
                summaryOrigin,
                palace: palaceResult,
            });
        } catch (e: any) {
            console.error(e);
            addToast(`Archive failed: ${e.message}`, 'error');
        } finally {
            setArchivingId(null);
        }
    };

    // --- Renderers ---

    const renderPage = (page: DiaryPage, side: 'user' | 'char') => {
        const style = PAPER_STYLES.find(s => s.id === page.paperStyle) || PAPER_STYLES[0];
        const isInteractive = true; // Always interactive now for editing

        return (
            <div 
                ref={side === activeTab ? paperRef : undefined}
                className={`sully-journal-paper sully-journal-paper-${side} relative w-full h-full shadow-md transition-all duration-300 overflow-hidden ${style.css} flex flex-col rounded-3xl touch-none`}
                style={{ ...style.style }}
                onPointerMove={isInteractive && side === activeTab ? handlePointerMove : undefined}
                onPointerUp={isInteractive && side === activeTab ? handlePointerUp : undefined}
                onPointerLeave={isInteractive && side === activeTab ? handlePointerUp : undefined}
                onClick={handleBackgroundClick}
            >
                {/* Content Container */}
                <div className="sully-journal-page-content flex-1 p-6 relative z-10 flex flex-col">
                    <div className="sully-journal-page-meta flex justify-between items-center mb-4 pb-2 border-b border-black/5 shrink-0">
                        <span className={`sully-journal-page-title text-xs font-bold uppercase tracking-widest opacity-50 ${style.text}`}>
                            {side === 'user' ? 'MY DIARY' : 'REPLY'}
                        </span>
                        <span className={`sully-journal-page-date text-[10px] opacity-40 font-mono ${style.text}`}>
                            {currentEntry?.date}
                        </span>
                    </div>

                    <textarea 
                        value={page.text}
                        onChange={e => updatePage({ text: e.target.value }, side)}
                        placeholder={side === 'user' ? "Record what happened today..." : "Waiting for a reply..."}
                        className={`sully-journal-textarea flex-1 w-full bg-transparent resize-none outline-none leading-loose text-[16px] font-normal ${style.text} placeholder:opacity-30 no-scrollbar`}
                        readOnly={isThinking} 
                    />
                </div>

                {/* Stickers Layer */}
                {/* Check Hide Flag for Char Side */}
                {!(side === 'char' && hideCharStickers) && page.stickers.map(s => {
                    const isSelected = selectedStickerId === s.id;
                    const scale = s.scale || 1.0;
                    
                    return (
                        <div 
                            key={s.id} 
                            onPointerDown={(e) => handlePointerDown(e, s.id, 'move')}
                            onClick={(e) => selectSticker(e, s.id)}
                            className={`sully-journal-sticker absolute text-6xl select-none drop-shadow-md z-20 cursor-move ${draggingSticker === s.id ? 'opacity-90' : ''} transition-transform`}
                            style={{ 
                                left: `${s.x}%`, 
                                top: `${s.y}%`, 
                                transform: `translate(-50%, -50%) rotate(${s.rotation}deg) scale(${scale})`,
                                border: isSelected ? '2px dashed #3b82f6' : 'none',
                                borderRadius: '8px',
                                padding: '4px'
                            }}
                        >
                            {isImageValue(s.url) ? (
                                <TokenImg value={s.url} className="w-20 h-20 object-contain pointer-events-none" draggable={false} />
                            ) : s.url}

                            {/* Controls for Selected Sticker */}
                            {isSelected && (
                                <>
                                    {/* Delete Button (Top Right) */}
                                    <div 
                                        className="absolute -top-3 -right-3 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs shadow-md cursor-pointer pointer-events-auto"
                                        onClick={(e) => { e.stopPropagation(); removeStickerFromPage(s.id); }}
                                    >×</div>
                                    
                                    {/* Resize Handle (Bottom Right) */}
                                    <div 
                                        className="absolute -bottom-2 -right-2 w-5 h-5 bg-blue-500 rounded-full border-2 border-white shadow-md cursor-nwse-resize pointer-events-auto"
                                        onPointerDown={(e) => handlePointerDown(e, s.id, 'resize')}
                                    ></div>
                                </>
                            )}
                        </div>
                    );
                })}
                
                {/* Paper Texture Overlay (Subtle) */}
                <div className="sully-journal-texture absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/paper-fibers.png')] opacity-10 pointer-events-none z-0 mix-blend-multiply"></div>
            </div>
        );
    };

    const renderEmptyCharPage = () => (
        <div className="sully-journal-empty w-full h-full bg-[#252525] rounded-3xl border border-white/5 flex flex-col items-center justify-center text-white/40 gap-4 p-8 text-center">
            <div className="opacity-20 animate-pulse"><img src={twemojiUrl('1f48c')} alt="letter" className="w-12 h-12" /></div>
            {isThinking ? (
                <div className="space-y-2">
                    <p className="text-sm font-medium text-amber-500">They are reading your diary...</p>
                    <div className="flex justify-center gap-1">
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce"></div>
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce delay-100"></div>
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce delay-200"></div>
                    </div>
                </div>
            ) : (
                <>
                    <p className="text-sm">After you finish writing, tap the button below<br/>to invite {selectedChar?.name} to exchange diaries.</p>
                    <button
                        onClick={handleExchange}
                        className="px-6 py-3 bg-amber-500 hover:bg-amber-400 text-white text-sm font-bold rounded-full shadow-[0_0_20px_rgba(245,158,11,0.3)] active:scale-95 transition-all mt-2"
                    >
                        See Their Day
                    </button>
                </>
            )}
        </div>
    );

    // One-time modal: explains the new exchange-diary behavior changes (auto-sync / archive moved into the entry / palace vectorization)
    const introModal = showIntro ? (
        <Modal
            isOpen={showIntro}
            title="Exchange Diary · Updated"
            onClose={dismissIntro}
            footer={
                <button onClick={dismissIntro} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                    Got it
                </button>
            }
        >
            <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
                <p className="font-bold text-amber-700">A few changes, take a quick look:</p>
                <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 space-y-2">
                    <p><span className="font-bold text-amber-700">① Auto-sync to chat:</span> once the character replies to your diary, it automatically turns into a nice card in your chat with that character — no need to send it manually anymore. If you later edit the text or delete the diary, the card in chat stays in sync too.</p>
                    <p><span className="font-bold text-amber-700">② One-sided diaries don't enter memory:</span> if you only write for the character to see (without asking them to reply), that entry won't enter any memory — it's just kept the old way.</p>
                    <p><span className="font-bold text-amber-700">③ New diaries don't need archiving:</span> diaries written <b>after</b> this update follow the "auto-sync to chat" path above — once the card is in chat, the system organizes it automatically just like a normal message. You don't need to, and <b>shouldn't</b>, archive it manually again. That's why new diaries don't show an archive entry point — it's intentional.</p>
                    <p><span className="font-bold text-amber-700">④ Old diaries can still be archived manually:</span> for diaries left over from <b>before</b> this update, if the character replied to them, <b>open that diary and there'll be an "Archive" button in the top-right corner</b> — just tap it. It'll organize that diary into the character's memory, and characters with Memory Palace enabled will remember it in more detail.</p>
                </div>
                <p className="text-xs text-slate-400">This notice only appears once.</p>
            </div>
        </Modal>
    ) : null;

    // Archive result modal: lets the user clearly see what was generated and where it went
    const archiveResultModal = archiveResult ? (() => {
        const p = archiveResult.palace;
        const userName = userProfile.name || 'Me';
        // Palace status copy
        let palaceStatus: { tone: 'on' | 'off' | 'warn' | 'fail'; title: string; detail: string } = { tone: 'off', title: '', detail: '' };
        if (!p) {
            palaceStatus = { tone: 'fail', title: 'Memory Palace · Write Failed', detail: 'Memory Palace failed to write this time, but the diary was successfully stored in Neural Link.' };
        } else if (p.status === 'palace_disabled') {
            palaceStatus = { tone: 'off', title: 'Memory Palace · Not Enabled', detail: `${archiveResult.charName} doesn't have Memory Palace enabled, so this was stored in Neural Link the basic way. To have diaries remembered in more detail, turn on the "Memory Palace" toggle in character settings and archive again.` };
        } else if (p.status === 'lightllm_missing') {
            palaceStatus = { tone: 'warn', title: 'Memory Palace · Secondary API Not Configured', detail: "Memory Palace's backend model isn't configured yet — fill it in under Settings to use the full feature. For now, this was stored in Neural Link the basic way." };
        } else if (p.status === 'embedding_missing') {
            palaceStatus = { tone: 'warn', title: 'Memory Palace · Embedding Model Not Configured', detail: 'The embedding model is not configured yet — for now, this was stored in Neural Link the basic way. Set it up in Settings to use the full feature.' };
        } else if (p.status === 'empty_input') {
            palaceStatus = { tone: 'warn', title: 'Memory Palace · Content Is Empty', detail: 'Neither diary page has any text, so there was nothing to enter the palace.' };
        } else if (p.status === 'extracted_none') {
            palaceStatus = { tone: 'warn', title: 'Memory Palace · Secondary API Extracted Nothing', detail: 'After reading this diary, nothing worth noting separately was found; the diary itself has already been stored in Neural Link.' };
        } else {
            palaceStatus = {
                tone: 'on',
                title: `Memory Palace · ${p.stored} entered${p.skipped > 0 ? ` (${p.skipped} more matched existing memories and were deduplicated)` : ''}`,
                detail: 'This diary was organized into the memories below; the character will recall them the next time related topics come up. The date matches the day of the diary.',
            };
        }

        const palaceNodes = (p && p.status === 'done') ? p.nodes : [];

        return (
            <Modal
                isOpen={true}
                title={`Archived · ${archiveResult.date}`}
                onClose={() => setArchiveResult(null)}
                footer={
                    <button onClick={() => setArchiveResult(null)} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                        Got it
                    </button>
                }
            >
                <div className="space-y-3 text-sm text-slate-700 leading-relaxed max-h-[60vh] overflow-y-auto no-scrollbar pr-1">
                    {/* Top row: data-flow summary */}
                    {archiveResult.summaryOrigin === 'palace_bullets' ? (
                        <div className="rounded-xl bg-gradient-to-r from-emerald-50 to-purple-50 border border-emerald-200/60 px-3 py-2 text-[11px] text-slate-600">
                            ✓ This archive went into both <b className="text-emerald-700">Neural Link</b> and <b className="text-purple-700">Memory Palace</b>,
                            both drawing on <b>the same extracted content</b> — the memories extracted this time are stored in Neural Link too.
                        </div>
                    ) : (
                        <div className="rounded-xl bg-emerald-50/70 border border-emerald-100 px-3 py-2 text-[11px] text-slate-600">
                            This archive only went into <b className="text-emerald-700">Neural Link</b>, using a prose summary generated by the main API. See the "Memory Palace" section below for why.
                        </div>
                    )}

                    {/* Neural Link */}
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-bold tracking-widest uppercase text-emerald-700">● Neural Link</span>
                            <span className="text-[10px] text-emerald-600/70">1 entry written · dated {archiveResult.date}</span>
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">mood={archiveResult.summaryOrigin === 'palace_bullets' ? 'diary_palace' : 'diary'}</span>
                        </div>
                        <p className="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: archiveResult.summaryOrigin === 'palace_bullets' ? 'inherit' : 'ui-serif, Georgia, serif' }}>
                            {archiveResult.summary}
                        </p>
                        <p className="text-[10px] text-emerald-700/70">
                            ↑ This entry will show up in 「{archiveResult.charName}」's detailed monthly record, and is automatically sent to the LLM alongside chat context.
                            {archiveResult.summaryOrigin === 'palace_bullets'
                                ? ' Each bullet maps to a node in Memory Palace below.'
                                : ''}
                        </p>
                    </div>

                    {/* Memory Palace */}
                    <div className={`rounded-2xl border px-4 py-3 space-y-2 ${
                        palaceStatus.tone === 'on' ? 'border-purple-100 bg-purple-50/70'
                        : palaceStatus.tone === 'off' ? 'border-slate-100 bg-slate-50'
                        : palaceStatus.tone === 'warn' ? 'border-amber-100 bg-amber-50/70'
                        : 'border-red-100 bg-red-50/70'
                    }`}>
                        <div className={`text-[10px] font-bold tracking-widest uppercase ${
                            palaceStatus.tone === 'on' ? 'text-purple-700'
                            : palaceStatus.tone === 'off' ? 'text-slate-500'
                            : palaceStatus.tone === 'warn' ? 'text-amber-700'
                            : 'text-red-600'
                        }`}>
                            ◆ {palaceStatus.title}
                        </div>
                        <p className="text-[12px] text-slate-600">{palaceStatus.detail}</p>
                        {palaceNodes.length > 0 && (
                            <div className="space-y-1.5 pt-1">
                                {palaceNodes.map((n, i) => (
                                    <div key={i} className="rounded-xl bg-white/80 border border-purple-100 px-3 py-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">{getRoomLabel(n.room, userName)}</span>
                                            <span className="text-[9px] font-mono text-purple-500/70">Importance {n.importance}/10</span>
                                            {n.mood && <span className="text-[9px] text-slate-400">· {n.mood}</span>}
                                        </div>
                                        <p className="text-[12px] text-slate-700 leading-snug">{n.content}</p>
                                        {n.tags?.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {n.tags.slice(0, 6).map((t, ti) => (
                                                    <span key={ti} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">#{t}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
        );
    })() : null;

    if (mode === 'select') {
        return (
            <div className={`sully-journal-root sully-journal-select h-full w-full bg-amber-50 flex flex-col font-light${journalLayoutClass}`}>
                <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
                {introModal}
                {archiveResultModal}
                <JournalThemeArtwork preset={effectiveJournalPreset} scene="select" />
                <div className="sully-journal-header border-b border-amber-100 bg-amber-50/80 backdrop-blur-sm sticky top-0 z-20 shrink-0" style={{ paddingTop: 'var(--chrome-top)' }}>
                    <div className="h-12 px-6 flex items-center justify-between">
                        <button onClick={closeApp} aria-label="Back to home screen" className="sully-journal-back p-2 -ml-2 rounded-full hover:bg-amber-100/50 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-amber-900"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="sully-journal-header-title font-bold text-amber-900 text-lg tracking-wide">Select a Journal</span>
                        <JournalAppearanceButton compact {...journalAppearanceButtonProps} />
                    </div>
                </div>

                {/* Group filter (hidden if no groups exist), light amber background */}
                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                    value={journalGroupId} onChange={setJournalGroupId} className="sully-journal-group-filter px-6 pt-4 shrink-0" />
                <div className="sully-journal-notebook-grid p-6 grid grid-cols-2 gap-5 overflow-y-auto pb-20 no-scrollbar">
                    {filterCharactersByGroup(characters, characterGroups, journalGroupId).map(c => (
                        <div key={c.id} onClick={() => handleCharSelect(c)} className="sully-journal-notebook aspect-[3/4] bg-white rounded-r-2xl rounded-l-md border-l-4 border-l-amber-800 shadow-[2px_4px_12px_rgba(0,0,0,0.08)] p-4 flex flex-col items-center justify-center gap-3 cursor-pointer active:scale-95 transition-all relative overflow-hidden group">
                            <div className="absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/10 to-transparent"></div>
                            <div className="sully-journal-notebook-avatar w-16 h-16 rounded-full p-[2px] border border-amber-100 bg-amber-50">
                                <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover" />
                            </div>
                            <span className="sully-journal-notebook-name font-bold text-amber-900 text-sm">{c.name}</span>
                            <span className="sully-journal-notebook-label text-[9px] text-amber-600 bg-amber-50 px-2 py-1 rounded-full font-mono uppercase tracking-wide">Journal</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (mode === 'calendar' && selectedChar) {
        return (
            <div className={`sully-journal-root sully-journal-calendar h-full w-full bg-white flex flex-col font-light relative${journalLayoutClass}`}>
                <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
                {introModal}
                {archiveResultModal}
                <JournalThemeArtwork preset={effectiveJournalPreset} scene="calendar" />
                <div className="sully-journal-calendar-hero pb-6 px-6 bg-amber-500 shadow-lg shrink-0 rounded-b-[2rem] z-20" style={{ paddingTop: 'max(3rem, var(--safe-top))' }}>
                    <div className="flex justify-between items-start mb-4">
                         <button onClick={() => setMode('select')} aria-label="Back to journal selection" className="sully-journal-back text-white/80 hover:text-white transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" /></svg>
                         </button>
                         <JournalAppearanceButton tone="dark" compact {...journalAppearanceButtonProps} />
                    </div>
                    <div className="sully-journal-calendar-heading text-white">
                        <div className="sully-journal-calendar-kicker text-xs opacity-70 uppercase tracking-widest font-bold mb-1">Exchange Diary</div>
                        <div className="sully-journal-calendar-title text-3xl font-bold tracking-tight">{selectedChar.name}</div>
                    </div>
                </div>

                <div className="sully-journal-calendar-list flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    <button onClick={() => openEntry(getLocalDateStr())} className="sully-journal-new-entry w-full py-5 mb-8 border-2 border-dashed border-amber-200 rounded-2xl text-amber-500 font-bold flex items-center justify-center gap-2 hover:bg-amber-50 active:scale-95 transition-all">
                        <span className="text-xl">+</span> Write Today's Diary
                    </button>
                    
                    <div className="space-y-4">
                        {diaries.map(d => (
                            <div key={d.id} onClick={() => openEntry(d.date)} className="sully-journal-entry flex items-center gap-4 p-4 rounded-2xl bg-white border border-slate-100 shadow-sm active:scale-95 transition-all hover:shadow-md cursor-pointer relative overflow-hidden group">
                                <div className="sully-journal-entry-accent absolute left-0 top-0 bottom-0 w-1 bg-amber-400"></div>
                                <div className="sully-journal-entry-date w-14 h-14 bg-amber-50 rounded-xl flex flex-col items-center justify-center text-amber-800 shrink-0 border border-amber-100">
                                    <span className="text-[10px] font-bold opacity-60">{MONTH_ABBR[parseInt(d.date.split('-')[1], 10) - 1]}</span>
                                    <span className="text-xl font-bold leading-none">{d.date.split('-')[2]}</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="sully-journal-entry-text text-sm text-slate-700 truncate font-medium">{d.userPage.text || '(empty)'}</p>
                                    <div className="flex justify-between items-center mt-1">
                                        <p className="sully-journal-entry-year text-xs text-slate-400 font-mono">{d.date.split('-')[0]}</p>
                                        <div className="sully-journal-entry-badges flex gap-2">
                                            {d.charPage && <span className="px-2 py-0.5 bg-green-100 text-green-600 rounded-full text-[9px] font-bold">Replied</span>}
                                            {d.chatCardMessageId && <span className="px-2 py-0.5 bg-emerald-50 text-emerald-500 rounded-full text-[9px] font-bold">Synced to Chat</span>}
                                            {d.isArchived && <span className="px-2 py-0.5 bg-amber-100 text-amber-600 rounded-full text-[9px] font-bold">Archived</span>}
                                        </div>
                                    </div>
                                </div>
                                {/* The archive button was unified into the top-right corner after opening a diary. The list keeps only the delete button, no duplicate entry point. */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDeletingDiary(d);
                                    }}
                                    className="w-8 h-8 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center"
                                    title="Delete diary"
                                    aria-label="Delete diary"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <Modal
                    isOpen={!!deletingDiary}
                    title="Delete Diary"
                    onClose={() => setDeletingDiary(null)}
                    footer={
                        <div className="flex gap-2 w-full">
                            <button onClick={() => setDeletingDiary(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">Cancel</button>
                            <button onClick={handleDeleteDiary} className="flex-1 py-3 bg-red-500 text-white rounded-2xl font-bold">Delete</button>
                        </div>
                    }
                >
                    <p className="text-sm text-slate-600">
                        Delete the diary from {deletingDiary?.date}? This cannot be undone.
                    </p>
                </Modal>
            </div>
        );
    }

    // --- WRITE MODE ---
    return (
        <div className={`sully-journal-root sully-journal-write h-full w-full bg-[#1a1a1a] flex flex-col relative overflow-hidden${journalLayoutClass}`}>
            <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
            {introModal}
            {archiveResultModal}
            <JournalThemeArtwork preset={effectiveJournalPreset} scene="write" />

            {/* Editor Header */}
            <div className="sully-journal-editor-header bg-[#1a1a1a]/90 backdrop-blur-md text-white shrink-0 z-30" style={{ paddingTop: 'var(--chrome-top)' }}>
                <div className="h-12 px-4 flex items-center justify-between">
                    <button onClick={() => setMode('calendar')} aria-label="Back to diary list" className="sully-journal-back p-2 -ml-2 text-white/60 hover:text-white rounded-full active:bg-white/10 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="flex gap-3">
                        <JournalAppearanceButton tone="dark" compact {...journalAppearanceButtonProps} />
                        {/* Toggle Char Sticker Visibility Button */}
                        {activeTab === 'char' && (
                            <button
                                onClick={() => setHideCharStickers(!hideCharStickers)}
                                className={`p-2 rounded-full transition-colors ${hideCharStickers ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-white/60'}`}
                                title={hideCharStickers ? "Show stickers" : "Hide stickers"}
                            >
                                {hideCharStickers ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                                )}
                            </button>
                        )}

                        {currentEntry?.chatCardMessageId && (
                            <div className="px-3 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 flex items-center gap-1.5" title="This diary has been auto-synced as a chat card">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                                Synced to Chat
                            </div>
                        )}
                        {currentEntry?.isArchived && (
                            <div className="px-3 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 flex items-center gap-1.5" title="This diary has been archived into Neural Link">
                                <Archive size={11} weight="fill" />
                                Archived
                            </div>
                        )}
                        {/* Old diaries (left over before this update, autoSync not set) whose character has replied → show an archive
                            button in the top-right corner. New diaries follow the auto-sync-to-chat path and don't show this button,
                            to avoid a duplicate entry into storage. */}
                        {currentEntry && !currentEntry.autoSync && currentEntry.charPage && !currentEntry.isArchived && (
                            <button
                                onClick={() => handleArchiveDiary(currentEntry)}
                                disabled={archivingId === currentEntry.id}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 ${archivingId === currentEntry.id ? 'bg-amber-700/60 text-amber-200 cursor-wait' : 'bg-amber-500 text-white hover:bg-amber-400 active:scale-95'}`}
                                title={'Archive this old diary into Neural Link' + (selectedChar?.memoryPalaceEnabled ? ' / Memory Palace' : '')}
                            >
                                {archivingId === currentEntry.id ? (
                                    <>
                                        <div className="w-3 h-3 border-2 border-amber-200/40 border-t-amber-100 rounded-full animate-spin"></div>
                                        Archiving
                                    </>
                                ) : (
                                    <>
                                        <Archive size={12} weight="fill" />
                                        Archive
                                    </>
                                )}
                            </button>
                        )}
                        <button onClick={() => { saveEntry(); trackEvent('Save Diary'); }} className="px-4 py-1.5 bg-white/10 rounded-full text-xs font-bold hover:bg-white/20 active:scale-95 transition-transform">
                            Save
                        </button>
                    </div>
                </div>
            </div>

            {/* Main Page Area */}
            <div className="sully-journal-editor-stage flex-1 relative w-full overflow-hidden flex flex-col">
                <div className={`flex-1 w-full mx-auto px-2 pb-4 pt-2 flex flex-col relative ${journalUsesScrapbookLayout ? 'max-w-5xl' : 'max-w-xl'}`}>
                    <div className="flex-1 relative rounded-3xl transition-all duration-500">
                        {journalUsesScrapbookLayout ? (
                            <div className="sully-journal-spread">
                                <div
                                    className={`sully-journal-spread-page sully-journal-spread-user ${activeTab === 'user' ? 'is-active' : 'is-inactive'}`}
                                    onPointerDownCapture={() => setActiveTab('user')}
                                >
                                    {currentEntry && renderPage(currentEntry.userPage, 'user')}
                                </div>
                                <div
                                    className={`sully-journal-spread-page sully-journal-spread-char ${activeTab === 'char' ? 'is-active' : 'is-inactive'}`}
                                    onPointerDownCapture={() => setActiveTab('char')}
                                >
                                    {currentEntry?.charPage ? renderPage(currentEntry.charPage, 'char') : renderEmptyCharPage()}
                                </div>
                            </div>
                        ) : (
                            <>
                                {activeTab === 'user' && currentEntry && renderPage(currentEntry.userPage, 'user')}
                                {activeTab === 'char' && (currentEntry?.charPage ? renderPage(currentEntry.charPage, 'char') : renderEmptyCharPage())}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="sully-journal-bottom-controls shrink-0 bg-[#222] border-t border-white/5 pb-safe pt-2 z-30">
                <div className="sully-journal-tabs flex justify-center gap-4 mb-4 px-4">
                    <button
                        onClick={() => { setActiveTab('user'); setSelectedStickerId(null); trackEvent('Switch Diary Page Tab', { page: 'user' }); }}
                        className={`sully-journal-tab ${activeTab === 'user' ? 'sully-journal-tab-active' : ''} flex-1 py-3 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all duration-300 relative overflow-hidden ${activeTab === 'user' ? 'bg-white text-black shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                    >
                        My Diary
                    </button>
                    <button
                        onClick={() => { setActiveTab('char'); setSelectedStickerId(null); trackEvent('Switch Diary Page Tab', { page: 'char' }); }}
                        className={`sully-journal-tab ${activeTab === 'char' ? 'sully-journal-tab-active' : ''} flex-1 py-3 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all duration-300 relative overflow-hidden ${activeTab === 'char' ? 'bg-amber-500 text-white shadow-lg shadow-amber-900/50' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                    >
                        {selectedChar?.name || 'Partner'}
                        {currentEntry?.charPage && activeTab !== 'char' && <div className="absolute top-2 right-2 w-2 h-2 bg-green-500 rounded-full shadow-sm animate-pulse"></div>}
                    </button>
                </div>

                <div className="flex items-center justify-between px-6 pb-4">
                    <div className="sully-journal-paper-picker flex gap-3 bg-[#111] p-1.5 rounded-full border border-white/10">
                        {PAPER_STYLES.slice(0, 4).map(s => (
                            <button
                                key={s.id}
                                onClick={() => { updatePage({ paperStyle: s.id }, activeTab); trackEvent('Switch Diary Paper Style', { paperStyle: s.id }); }}
                                className={`sully-journal-paper-swatch w-8 h-8 rounded-full border border-white/10 transition-transform active:scale-90 ${s.css}`}
                                title={s.name}
                            />
                        ))}
                    </div>
                    
                    <div className="flex gap-3">
                        {activeTab === 'char' && currentEntry?.charPage && !isThinking && (
                            <button
                                onClick={handleExchange}
                                className="w-11 h-11 bg-white/10 text-white rounded-full flex items-center justify-center active:scale-90 transition-transform border border-white/5"
                                title="Rewrite character's diary"
                                aria-label="Rewrite character's diary"
                                data-testid="journal-rewrite-character-page"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                            </button>
                        )}
                        
                        <button
                            onClick={() => { setShowStickerPanel(!showStickerPanel); if (!showStickerPanel) trackEvent('Open Sticker Panel'); }}
                            className={`sully-journal-sticker-button w-11 h-11 rounded-full flex items-center justify-center text-xl shadow-lg active:scale-90 transition-transform ${showStickerPanel ? 'bg-white text-black' : 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'}`}
                        >
                            <Sparkle size={24} weight="fill" />
                        </button>
                    </div>
                </div>

                {showStickerPanel && (
                    <div className="sully-journal-sticker-panel bg-[#1a1a1a] border-t border-white/10 p-4 animate-slide-up h-48 overflow-y-auto no-scrollbar">
                        <div className="grid grid-cols-6 gap-3">
                            <button onClick={() => { setShowImportModal(true); trackEvent('Open Custom Sticker Import Modal'); }} className="flex items-center justify-center bg-white/10 rounded-xl border-2 border-dashed border-white/20 text-white/50 text-xl font-bold hover:bg-white/20 hover:text-white transition-all aspect-square">
                                +
                            </button>
                            {DEFAULT_STICKERS.map((s, i) => (
                                <button key={`def-${i}`} onClick={() => addSticker(s)} className="hover:scale-110 transition-transform p-2 bg-white/5 rounded-xl border border-white/5 flex items-center justify-center">
                                    <img src={s} alt="" className="w-8 h-8 object-contain pointer-events-none" />
                                </button>
                            ))}
                            {customStickers.map((s, i) => (
                                <button 
                                    key={`cust-${i}`} 
                                    onClick={() => addSticker(s.url)} 
                                    onTouchStart={() => handleDrawerTouchStart(s)}
                                    onTouchEnd={handleDrawerTouchEnd}
                                    onMouseDown={() => handleDrawerTouchStart(s)}
                                    onMouseUp={handleDrawerTouchEnd}
                                    onMouseLeave={handleDrawerTouchEnd}
                                    onContextMenu={(e) => { e.preventDefault(); setDeletingSticker(s); }}
                                    className="p-2 bg-white/5 rounded-xl border border-white/5 flex items-center justify-center relative active:scale-95 transition-transform"
                                >
                                    <img src={s.url} className="w-8 h-8 object-contain pointer-events-none" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Sticker Import Modal */}
            <Modal
                isOpen={showImportModal} title="Add Diary Stickers" onClose={() => setShowImportModal(false)}
                footer={<button onClick={handleImportStickers} className="w-full py-3 bg-white/10 text-white font-bold rounded-2xl hover:bg-white/20 transition-all">Confirm</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-500">Format: Sticker Name--Image URL (one per line)</p>
                    <textarea 
                        value={importText} 
                        onChange={e => setImportText(e.target.value)} 
                        placeholder={`CoolCat--https://...\nHeart--https://...`}
                        className="w-full h-32 bg-slate-100 rounded-2xl p-4 text-sm resize-none focus:outline-none text-slate-700"
                    />
                </div>
            </Modal>

            {/* Sticker Delete Confirmation Modal */}
            <Modal
                isOpen={!!deletingSticker} title="Delete Sticker Asset" onClose={() => setDeletingSticker(null)}
                footer={<div className="flex gap-2 w-full"><button onClick={() => setDeletingSticker(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">Cancel</button><button onClick={handleDeleteStickerAsset} className="flex-1 py-3 bg-red-500 text-white rounded-2xl font-bold">Delete</button></div>}
            >
                <div className="flex flex-col items-center gap-3 py-2">
                    {deletingSticker && <img src={deletingSticker.url} className="w-16 h-16 object-contain rounded-lg bg-slate-100 border" />}
                    <p className="text-sm text-slate-600">Delete this sticker asset? (Won't affect diaries that already use it)</p>
                </div>
            </Modal>
        </div>
    );
};

export default JournalApp;
