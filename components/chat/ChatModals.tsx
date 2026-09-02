
import React, { useRef, useState } from 'react';
import Modal from '../os/Modal';
import TokenImg from '../os/TokenImg';
import { CharacterProfile, Message, EmojiCategory, DailySchedule, ScheduleSlot, ApiPreset, APIConfig } from '../../types';
import ScheduleCard from '../schedule/ScheduleCard';
import EmotionSettingsPanel from './EmotionSettingsPanel';
import { isTranslationLangPreset, normalizeTranslationLangLabel, TRANSLATION_LANG_MAX_LENGTH, TRANSLATION_LANG_PRESETS } from '../../utils/translationLang';
import type { ContextRangeMode, ContextRangeSnapshot } from '../../utils/chatContextRange';
import { trackEvent } from '../../utils/analytics';
import { CANTONESE_VOICE_SUPPORT_NOTE, VOICE_LANGUAGE_OPTIONS } from '../../utils/voiceLanguage';
import { chatMessageFuzzyMatchesKeyword } from '../../utils/chatMessageSearch';

interface ChatModalsProps {
    modalType: string;
    setModalType: (v: any) => void;
    // Data Props
    transferAmt: string;
    setTransferAmt: (v: string) => void;
    transferNote: string;
    setTransferNote: (v: string) => void;
    emojiImportText: string;
    setEmojiImportText: (v: string) => void;
    settingsContextLimit: number;
    setSettingsContextLimit: (v: number) => void;
    settingsContextRangeMode: ContextRangeMode;
    setSettingsContextRangeMode: (v: ContextRangeMode) => void;
    settingsHideSysLogs: boolean;
    setSettingsHideSysLogs: (v: boolean) => void;
    contextSuiteAnyEnabled: boolean;
    contextSuiteAllEnabled: boolean;
    onToggleContextSuite: () => void;
    preserveContext: boolean;
    setPreserveContext: (v: boolean) => void;
    editContent: string;
    setEditContent: (v: string) => void;

    // New Category Props
    newCategoryName: string;
    setNewCategoryName: (v: string) => void;
    onAddCategory: () => void;

    // Emoji rename Props
    newEmojiName: string;
    setNewEmojiName: (v: string) => void;
    onRenameEmoji: () => void;

    // Archive Props
    archivePrompts: {id: string, name: string, content: string}[];
    selectedPromptId: string;
    setSelectedPromptId: (id: string) => void;
    editingPrompt: {id: string, name: string, content: string} | null;
    setEditingPrompt: (p: any) => void;
    isSummarizing: boolean;
    archiveProgress?: string;

    // Selection Props
    selectedMessage: Message | null;
    selectedEmoji: {name: string, url: string} | null;
    selectedCategory: EmojiCategory | null;
    activeCharacter: CharacterProfile;
    messages: Message[];
    allHistoryMessages?: Message[];
    contextRangeSnapshot?: ContextRangeSnapshot;

    // Handlers
    onTransfer: () => void;
    onImportEmoji: () => void;
    onSaveSettings: () => void;
    onBgUpload: (file: File) => void;
    onRemoveBg: () => void;
    onClearHistory: () => void;
    onArchive: () => void;
    onCreatePrompt: () => void;
    onEditPrompt: () => void;
    onSavePrompt: () => void;
    onDeletePrompt: (id: string) => void;
    onSetHistoryStart: (id: number | undefined) => void;
    onRestoreAdaptiveContext?: () => void;
    onJumpToMessageInChat?: (id: number) => void;
    onEnterSelectionMode: () => void;
    onReplyMessage: () => void;
    onEditMessageStart: () => void;
    onConfirmEditMessage: () => void;
    onDeleteMessage: () => void;
    onCopyMessage: () => void;
    onToggleMessageFavorite?: () => void;
    messageFavorited?: boolean;
    onDeleteEmoji: () => void;
    onDeleteCategory: () => void;
    // Category Visibility
    allCharacters?: CharacterProfile[];
    onSaveCategoryVisibility?: (categoryId: string, allowedCharacterIds: string[] | undefined) => void;
    // Translation
    translationEnabled?: boolean;
    onToggleTranslation?: () => void;
    translationExpanded?: boolean;
    onToggleTranslationExpanded?: () => void;
    translateSourceLang?: string;
    translateTargetLang?: string;
    onSetTranslateSourceLang?: (lang: string) => void;
    onSetTranslateLang?: (lang: string) => void;
    // XHS toggle
    xhsEnabled?: boolean;
    onToggleXhs?: () => void;
    // HTML mode
    htmlModeEnabled?: boolean;
    onToggleHtmlMode?: () => void;
    htmlModeCustomPrompt?: string;
    setHtmlModeCustomPrompt?: (v: string) => void;
    // Voice TTS
    chatVoiceEnabled?: boolean;
    onToggleChatVoice?: () => void;
    chatVoiceAutoPlay?: boolean;
    onToggleChatVoiceAutoPlay?: () => void;
    chatVoiceLang?: string;
    onSetChatVoiceLang?: (lang: string) => void;
    // Voice generation from long-press
    onGenerateVoice?: () => void;
    voiceAvailable?: boolean; // true if char has voiceProfile configured
    onDownloadVoice?: () => void;
    voiceDownloadable?: boolean; // true if the selected message already has generated voice
    voiceCollectable?: boolean; // true for a generated voice or an unsynthesized <语音> message
    onToggleVoiceFavorite?: () => void;
    voiceFavorited?: boolean;
    // Schedule
    scheduleData?: DailySchedule | null;
    isScheduleGenerating?: boolean;
    onScheduleEdit?: (index: number, slot: ScheduleSlot) => void;
    onScheduleDelete?: (index: number) => void;
    onScheduleReroll?: () => void;
    onScheduleCoverChange?: (dataUrl: string) => void;
    onScheduleStyleChange?: (style: 'lifestyle' | 'mindful') => void;
    onPlayTheater?: (index: number) => void;
    // Schedule master toggle
    isScheduleFeatureEnabled?: boolean;
    onToggleScheduleFeature?: () => void;
    // Memory Palace force vectorize
    isMemoryPalaceEnabled?: boolean;
    isVectorizing?: boolean;
    /** Pending count (real buffer measure, excluding the hot zone): null = not yet computed / modal not open, 0 = fully synced */
    vectorizePendingCount?: number | null;
    /** Turn-by-turn progress text while processing, e.g. "Round 2 · 340 remaining" */
    vectorizeProgress?: string;
    retainRecentForVectorize?: boolean;
    setRetainRecentForVectorize?: (value: boolean) => void;
    vectorizeResult?: {
        processedMessages: number;
        storedMemories: number;
        retainedMessages: number;
        waterlineAlreadyAhead: boolean;
    } | null;
    onForceVectorize?: () => void;
    // Emotion (embedded under schedule modal, synced on/off with scheduleStyle)
    apiPresets?: ApiPreset[];
    onAddApiPreset?: (name: string, config: APIConfig) => void;
    onSaveEmotion?: (config: NonNullable<CharacterProfile['emotionConfig']>) => void;
    onClearBuffs?: () => void;
}

interface TranslationLanguagePickerProps {
    label: string;
    value?: string;
    tone: 'source' | 'target';
    inputPlaceholder: string;
    onSelect?: (lang: string) => void;
}

const TranslationLanguagePicker: React.FC<TranslationLanguagePickerProps> = ({
    label,
    value,
    tone,
    inputPlaceholder,
    onSelect,
}) => {
    const [customLang, setCustomLang] = useState('');
    const selectedClass = tone === 'source' ? 'bg-slate-700 text-white' : 'bg-primary text-white';
    const customSelected = !!value && !isTranslationLangPreset(value);
    const normalizedCustomLang = normalizeTranslationLangLabel(customLang);

    const applyCustomLang = () => {
        if (!normalizedCustomLang) return;
        onSelect?.(normalizedCustomLang);
        setCustomLang('');
    };

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">{label}</label>
            <div className="flex flex-wrap gap-1.5">
                {TRANSLATION_LANG_PRESETS.map(lang => (
                    <button
                        type="button"
                        key={`${tone}-${lang}`}
                        onClick={() => onSelect?.(lang)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${value === lang ? selectedClass : 'bg-slate-100 text-slate-500'}`}
                    >
                        {lang}
                    </button>
                ))}
                {customSelected && (
                    <button
                        type="button"
                        onClick={() => value && onSelect?.(value)}
                        className={`max-w-full px-2.5 py-1 rounded-full text-[11px] font-bold transition-all truncate ${selectedClass}`}
                        title={value}
                    >
                        {value}
                    </button>
                )}
            </div>
            <div className="mt-2 flex gap-1.5">
                <input
                    value={customLang}
                    onChange={e => setCustomLang(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            applyCustomLang();
                        }
                    }}
                    maxLength={TRANSLATION_LANG_MAX_LENGTH}
                    placeholder={inputPlaceholder}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 outline-none focus:border-primary"
                />
                <button
                    type="button"
                    onClick={applyCustomLang}
                    disabled={!normalizedCustomLang}
                    className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${normalizedCustomLang ? selectedClass : 'bg-slate-100 text-slate-300'}`}
                >
                    Apply
                </button>
            </div>
        </div>
    );
};

const ChatModals: React.FC<ChatModalsProps> = ({
    modalType, setModalType,
    transferAmt, setTransferAmt,
    transferNote, setTransferNote,
    emojiImportText, setEmojiImportText,
    settingsContextLimit, setSettingsContextLimit,
    settingsContextRangeMode, setSettingsContextRangeMode,
    settingsHideSysLogs, setSettingsHideSysLogs,
    contextSuiteAnyEnabled, contextSuiteAllEnabled, onToggleContextSuite,
    preserveContext, setPreserveContext,
    editContent, setEditContent,
    newCategoryName, setNewCategoryName, onAddCategory,
    newEmojiName, setNewEmojiName, onRenameEmoji,
    archivePrompts, selectedPromptId, setSelectedPromptId,
    editingPrompt, setEditingPrompt, isSummarizing, archiveProgress,
    selectedMessage, selectedEmoji, selectedCategory, activeCharacter, messages,
    allHistoryMessages = [],
    contextRangeSnapshot,
    onTransfer, onImportEmoji, onSaveSettings,
    onBgUpload, onRemoveBg, onClearHistory,
    onArchive, onCreatePrompt, onEditPrompt, onSavePrompt, onDeletePrompt,
    onSetHistoryStart, onRestoreAdaptiveContext, onJumpToMessageInChat, onEnterSelectionMode, onReplyMessage, onEditMessageStart, onConfirmEditMessage, onDeleteMessage, onCopyMessage, onToggleMessageFavorite, messageFavorited, onDeleteEmoji, onDeleteCategory,
    allCharacters = [], onSaveCategoryVisibility,
    translationEnabled, onToggleTranslation, translationExpanded, onToggleTranslationExpanded, translateSourceLang, translateTargetLang, onSetTranslateSourceLang, onSetTranslateLang,
    xhsEnabled, onToggleXhs,
    htmlModeEnabled, onToggleHtmlMode, htmlModeCustomPrompt, setHtmlModeCustomPrompt,
    chatVoiceEnabled, onToggleChatVoice, chatVoiceAutoPlay, onToggleChatVoiceAutoPlay, chatVoiceLang, onSetChatVoiceLang,
    onGenerateVoice, voiceAvailable, onDownloadVoice, voiceDownloadable, voiceCollectable, onToggleVoiceFavorite, voiceFavorited,
    scheduleData, isScheduleGenerating, onScheduleEdit, onScheduleDelete, onScheduleReroll, onScheduleCoverChange,
    onScheduleStyleChange, onPlayTheater,
    isScheduleFeatureEnabled, onToggleScheduleFeature,
    isMemoryPalaceEnabled, isVectorizing, vectorizePendingCount, vectorizeProgress,
    retainRecentForVectorize, setRetainRecentForVectorize, vectorizeResult, onForceVectorize,
    apiPresets, onAddApiPreset, onSaveEmotion, onClearBuffs,
}) => {
    const bgInputRef = useRef<HTMLInputElement>(null);
    const [visibilitySelection, setVisibilitySelection] = useState<Set<string>>(new Set());
    const [historyPage, setHistoryPage] = useState(0);
    const [historySearch, setHistorySearch] = useState('');
    const longPressTimerRef = useRef<number | null>(null);
    const longPressTriggeredRef = useRef(false);
    const HISTORY_PAGE_SIZE = 50;
    const HISTORY_SEARCH_MAX = 200;
    const LONG_PRESS_MS = 450;

    const startHistoryLongPress = (msgId: number) => {
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = window.setTimeout(() => {
            longPressTriggeredRef.current = true;
            if (onJumpToMessageInChat) {
                setModalType('none');
                setHistoryPage(0);
                setHistorySearch('');
                onJumpToMessageInChat(msgId);
            }
        }, LONG_PRESS_MS);
    };
    const cancelHistoryLongPress = () => {
        if (longPressTimerRef.current) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };
    const handleHistoryItemClick = (msgId: number) => {
        if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
        }
        // Set directly when within range; when out of range, the parent layer directly prompts to adjust the slider first.
        onSetHistoryStart(msgId);
    };

    // Highlight the matched contiguous substring (preferred), otherwise no highlight (a highlight is not very meaningful for a subsequence match).
    const renderHighlighted = (text: string, query: string, baseClass: string) => {
        if (!query) return <span className={baseClass}>{text}</span>;
        const lower = text.toLowerCase();
        const q = query.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx < 0) return <span className={baseClass}>{text}</span>;
        return (
            <span className={baseClass}>
                {text.slice(0, idx)}
                <mark className="bg-yellow-200 text-slate-800 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
                {text.slice(idx + q.length)}
            </span>
        );
    };

    const openVisibilityModal = () => {
        if (selectedCategory) {
            setVisibilitySelection(new Set(selectedCategory.allowedCharacterIds || []));
            setModalType('category-visibility');
        }
    };

    const toggleVisibilityChar = (charId: string) => {
        setVisibilitySelection(prev => {
            const next = new Set(prev);
            if (next.has(charId)) next.delete(charId);
            else next.add(charId);
            return next;
        });
    };

    const handleSaveVisibility = () => {
        if (selectedCategory && onSaveCategoryVisibility) {
            const ids = Array.from(visibilitySelection);
            onSaveCategoryVisibility(selectedCategory.id, ids.length > 0 ? ids : undefined);
        }
        setModalType('none');
    };

    return (
        <>
            <Modal
                isOpen={modalType === 'transfer'} title="Credits Transfer" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={onTransfer} className="flex-1 py-3 bg-orange-500 text-white rounded-2xl">Confirm</button></>}
            >
                <input type="number" value={transferAmt} onChange={e => setTransferAmt(e.target.value)} placeholder="Amount" className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-lg font-bold" autoFocus />
                <input type="text" value={transferNote} onChange={e => setTransferNote(e.target.value)} maxLength={30} placeholder="Add a transfer note (optional)" className="w-full bg-slate-100 rounded-2xl px-5 py-3 text-sm mt-3" />
            </Modal>

            {/* New Category Modal */}
            <Modal
                isOpen={modalType === 'add-category'} title="New Emoji Category" onClose={() => setModalType('none')}
                footer={<button onClick={onAddCategory} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Create</button>}
            >
                <input
                    value={newCategoryName}
                    onChange={e => setNewCategoryName(e.target.value)}
                    placeholder="Enter category name..."
                    className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-base font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-slate-700"
                    autoFocus
                />
            </Modal>

            <Modal
                isOpen={modalType === 'emoji-import'} title="Emoji Import" onClose={() => setModalType('none')}
                footer={<button onClick={onImportEmoji} className="w-full py-4 bg-primary text-white font-bold rounded-2xl">Add to Current Category</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-400">Emoji will be imported into your currently selected category.</p>
                    <textarea value={emojiImportText} onChange={e => setEmojiImportText(e.target.value)} placeholder="Name--URL (one per line)" className="w-full h-40 bg-slate-100 rounded-2xl p-4 resize-none" />
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'chat-settings'} title="Chat Settings" onClose={() => setModalType('none')}
                footer={<button onClick={onSaveSettings} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Save Settings</button>}
            >
                <div className="space-y-6">
                     <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3.5">
                         <div className="flex items-center gap-3">
                             <div className="min-w-0 flex-1">
                                 <div className="text-xs font-bold text-violet-700">Smart Context</div>
                                 <p className="mt-1 text-[10px] leading-relaxed text-violet-600/90">
                                     Picks up context more accurately, keeps pace with the conversation, and stays aware of what is currently unfolding. Applies to all private chats, runs locally, adds no extra API calls.
                                 </p>
                                 <p className="mt-1.5 text-[10px] font-bold text-violet-600">
                                     {contextSuiteAllEnabled
                                         ? 'On'
                                         : contextSuiteAnyEnabled
                                             ? 'Some legacy capabilities are still running; turning off lets you re-enable them all at once'
                                             : 'Off, replies keep their original behavior'}
                                 </p>
                             </div>
                             <button
                                 type="button"
                                 onClick={onToggleContextSuite}
                                 aria-pressed={contextSuiteAnyEnabled}
                                 className={`shrink-0 rounded-full px-3.5 py-2 text-[11px] font-extrabold transition-colors ${contextSuiteAnyEnabled
                                     ? 'bg-white text-violet-700 ring-1 ring-violet-200'
                                     : 'bg-violet-600 text-white'}`}
                             >
                                 {contextSuiteAnyEnabled ? 'Turn Off' : 'Turn On'}
                             </button>
                         </div>
                     </div>

                     <div>
                         <label className="text-xs font-bold text-slate-400 uppercase mb-2 block">Chat Background</label>
                         <div onClick={() => bgInputRef.current?.click()} className="h-24 bg-slate-100 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center cursor-pointer hover:border-primary/50 overflow-hidden relative">
                             {activeCharacter.chatBackground ? <TokenImg value={activeCharacter.chatBackground} className="w-full h-full object-cover opacity-60" /> : <span className="text-xs text-slate-400">Tap to upload an image (original quality)</span>}
                             {activeCharacter.chatBackground && <span className="absolute z-10 text-xs bg-white/80 px-2 py-1 rounded">Change</span>}
                         </div>
                         <input type="file" ref={bgInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && onBgUpload(e.target.files[0])} />
                         {activeCharacter.chatBackground && <button onClick={onRemoveBg} className="text-[10px] text-red-400 mt-1">Remove Background</button>}
                     </div>
                     <div>
                         {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && settingsContextRangeMode === 'adaptive' ? (
                             <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3.5">
                                 <div className="flex items-start justify-between gap-3">
                                     <div>
                                         <div className="text-xs font-bold text-violet-700">
                                             {activeCharacter.autoArchiveEnabled ? 'Adaptive Full-Auto Memory Active' : 'Raw Text Range Follows Memory Watermark'}
                                         </div>
                                         <p className="text-[10px] text-violet-600/80 mt-1 leading-relaxed">
                                             Processed raw text is no longer re-injected; earlier content is recalled via vector memory. Please do not adjust unless you have a special need.
                                         </p>
                                         {activeCharacter.contextUserStartMessageId && (
                                             <p className="text-[10px] text-sky-700 mt-1.5 leading-relaxed">
                                                 There is also a user breakpoint right now — the actual raw text range will be further narrowed within the adaptive cap.
                                             </p>
                                         )}
                                     </div>
                                     <div className="shrink-0 flex flex-col gap-1.5">
                                         <button
                                             type="button"
                                             onClick={() => setSettingsContextRangeMode('manual')}
                                             className="px-3 py-1.5 rounded-xl bg-white border border-violet-200 text-[11px] font-bold text-violet-700"
                                         >
                                             Custom Range
                                         </button>
                                         {activeCharacter.contextUserStartMessageId && (
                                             <button
                                                 type="button"
                                                 onClick={onRestoreAdaptiveContext}
                                                 className="px-3 py-1.5 rounded-xl bg-violet-600 text-[11px] font-bold text-white"
                                             >
                                                 One-Click Restore
                                             </button>
                                         )}
                                     </div>
                                 </div>
                             </div>
                         ) : (
                             <>
                                 <div className="flex items-center justify-between gap-2 mb-2">
                                     <label className="text-xs font-bold text-slate-400 uppercase">Max Context Messages ({settingsContextLimit})</label>
                                     {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && (
                                         <button
                                             type="button"
                                             onClick={onRestoreAdaptiveContext}
                                             className="text-[10px] font-bold text-violet-600 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-1"
                                         >
                                             {activeCharacter.autoArchiveEnabled ? 'One-Click Restore Adaptive' : 'Restore Watermark Following'}
                                         </button>
                                     )}
                                 </div>
                                 <input
                                     type="range"
                                     min="10"
                                     max="5000"
                                     step="10"
                                     value={settingsContextLimit}
                                     onChange={e => {
                                         setSettingsContextRangeMode('manual');
                                         setSettingsContextLimit(parseInt(e.target.value));
                                     }}
                                     className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-primary"
                                 />
                                 <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>10 (data saver)</span><span>5000 (max range)</span></div>
                                 {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && (
                                     <p className="text-[10px] text-amber-600 mt-2 leading-relaxed">
                                         Customizing only changes the raw text range the AI can directly read — it does not roll back the Memory Palace watermark, nor does it re-vectorize old messages.
                                     </p>
                                 )}
                             </>
                         )}
                     </div>

                     <div className="pt-2 border-t border-slate-100">
                         <div className="flex justify-between items-center cursor-pointer" onClick={() => setSettingsHideSysLogs(!settingsHideSysLogs)}>
                             <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">Hide System Logs</label>
                             <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${settingsHideSysLogs ? 'bg-primary' : 'bg-slate-200'}`}>
                                 <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${settingsHideSysLogs ? 'translate-x-4' : ''}`}></div>
                             </div>
                         </div>
                         <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                             When on, hides gray auto-generated notices from Date / mini-programs etc. (except transfer, poke, and image-sent notices).
                         </p>
                     </div>

                     {/* Translation Settings */}
                     <div className="pt-2 border-t border-slate-100">
                         <div className="flex justify-between items-center cursor-pointer" onClick={onToggleTranslation}>
                             <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">Message Translation</label>
                             <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${translationEnabled ? 'bg-primary' : 'bg-slate-200'}`}>
                                 <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${translationEnabled ? 'translate-x-4' : ''}`}></div>
                             </div>
                         </div>
                         <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                             When on, AI messages are automatically shown translated into the "Show" language; tap "Translate" to switch to the target language.
                         </p>
                         {translationEnabled && (
                             <div className="mt-3 space-y-3">
                                 <TranslationLanguagePicker
                                     label="Show (bubble display language)"
                                     value={translateSourceLang}
                                     tone="source"
                                     inputPlaceholder="Custom, e.g. Cantonese"
                                     onSelect={onSetTranslateSourceLang}
                                 />
                                 <TranslationLanguagePicker
                                     label="Translate (translation target language)"
                                     value={translateTargetLang}
                                     tone="target"
                                     inputPlaceholder="Custom, e.g. Chinese (Traditional)"
                                     onSelect={onSetTranslateLang}
                                 />
                                 <button
                                     type="button"
                                     onClick={onToggleTranslationExpanded}
                                     className="w-full flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left active:bg-slate-50"
                                 >
                                     <span>
                                         <span className="block text-[11px] font-bold text-slate-600">Show original and translation together</span>
                                         <span className="block mt-0.5 text-[9px] leading-relaxed text-slate-400">When on, no more tapping to switch each message — bilingual bubbles show both languages stacked directly.</span>
                                     </span>
                                     <span className={`shrink-0 w-10 h-6 rounded-full p-1 transition-colors flex items-center ${translationExpanded ? 'bg-primary' : 'bg-slate-200'}`}>
                                         <span className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${translationExpanded ? 'translate-x-4' : ''}`} />
                                     </span>
                                 </button>
                                 {/* Preview */}
                                 <div className="text-[11px] text-center text-slate-500 bg-slate-50 rounded-lg py-2">
                                     Show<span className="font-bold text-slate-700">{translateSourceLang || '?'}</span> Translate<span className="font-bold text-primary">{translateTargetLang || '?'}</span>
                                 </div>
                             </div>
                         )}
                     </div>

                     {/* XHS Toggle */}
                     <div className="pt-2 border-t border-slate-100">
                         <div className="flex justify-between items-center cursor-pointer" onClick={onToggleXhs}>
                             <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">Xiaohongshu</label>
                             <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${xhsEnabled ? 'bg-red-400' : 'bg-slate-200'}`}>
                                 <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${xhsEnabled ? 'translate-x-4' : ''}`}></div>
                             </div>
                         </div>
                         <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                             When on, the character can search, browse, post, and comment on Xiaohongshu in chat. Requires configuring MCP or a cookie in global settings.
                         </p>
                     </div>

                     {/* HTML Module Mode */}
                     <div className="pt-2 border-t border-slate-100">
                         <div className="flex justify-between items-center cursor-pointer" onClick={onToggleHtmlMode}>
                             <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">HTML Module Mode</label>
                             <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${htmlModeEnabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}>
                                 <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${htmlModeEnabled ? 'translate-x-4' : ''}`}></div>
                             </div>
                         </div>
                         <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                             When on, injects a prompt telling the AI to "wrap polished cards in [html]...[/html]" — the AI will output visual modules like invitations / tickets / notices in suitable scenes.
                         </p>
                         {htmlModeEnabled && (
                             <div className="mt-3">
                                 <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">Custom prompt addition (appended after the built-in prompt, does not overwrite it)</label>
                                 <textarea
                                     value={htmlModeCustomPrompt || ''}
                                     onChange={e => setHtmlModeCustomPrompt?.(e.target.value)}
                                     placeholder="e.g.: prefer warm tones / default to a minimal magazine feel / ticket-type cards must include a QR code placeholder..."
                                     className="w-full h-28 bg-slate-50 rounded-2xl p-3 text-[12px] resize-none border border-slate-200 focus:outline-none focus:border-fuchsia-300"
                                 />
                                 <p className="text-[10px] text-slate-400 mt-1">Leave blank to use only the built-in prompt.</p>
                             </div>
                         )}
                     </div>

                     {/* Voice TTS */}
                     <div className="pt-2 border-t border-slate-100">
                         <div className="flex justify-between items-center cursor-pointer" onClick={onToggleChatVoice}>
                             <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">Voice Messages</label>
                             <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${chatVoiceEnabled ? 'bg-emerald-400' : 'bg-slate-200'}`}>
                                 <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${chatVoiceEnabled ? 'translate-x-4' : ''}`}></div>
                             </div>
                         </div>
                         <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                             When on, AI replies will include voice bars (requires configuring MiniMax and the character's voice).
                         </p>
                         {chatVoiceEnabled && (
                             <div className="mt-3 pt-3 border-t border-slate-100">
                                 <div className="flex justify-between items-center cursor-pointer" onClick={onToggleChatVoiceAutoPlay}>
                                     <label className="text-[10px] font-bold text-slate-400 uppercase pointer-events-none">Auto-play on receipt</label>
                                     <div className={`w-9 h-5 rounded-full p-1 transition-colors flex items-center ${chatVoiceAutoPlay ? 'bg-emerald-400' : 'bg-slate-200'}`}>
                                         <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${chatVoiceAutoPlay ? 'translate-x-4' : ''}`}></div>
                                     </div>
                                 </div>
                                 <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                     When on, voice is synthesized and played as soon as a message arrives. When off, the voice bar still appears as usual — it is only synthesized and played when tapped, so if you do not listen it does not use your voice quota (you can also tap "To Text" to view the content directly).
                                 </p>
                             </div>
                         )}
                         {chatVoiceEnabled && (
                             <div className="mt-3">
                                 <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">Voice Language</label>
                                 <div className="flex flex-wrap gap-1.5">
                                     {VOICE_LANGUAGE_OPTIONS.map(opt => (
                                         <button key={opt.value} onClick={() => onSetChatVoiceLang?.(opt.value)}
                                             className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${chatVoiceLang === opt.value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                             {opt.label}
                                         </button>
                                     ))}
                                 </div>
                                 {chatVoiceLang === 'yue' && <p className="text-[10px] text-amber-600/80 mt-1.5">{CANTONESE_VOICE_SUPPORT_NOTE}</p>}
                                 {chatVoiceLang && <p className="text-[10px] text-emerald-600/70 mt-1.5">When a non-default language is selected, the AI's lines are translated first, then synthesized into voice.</p>}
                             </div>
                         )}
                     </div>

                     {/* Time awareness / custom timezone / offline time awareness have all been moved to the "Neural Link" character settings page */}

                     <div className="pt-2 border-t border-slate-100">
                         <button onClick={() => setModalType('history-manager')} className="w-full py-3 bg-slate-50 text-slate-600 font-bold rounded-2xl border border-slate-200 active:scale-95 transition-transform flex items-center justify-center gap-2">
                             View Raw Text Range / Set User Breakpoint
                         </button>
                         <p className="text-[10px] text-slate-400 mt-2 text-center">View the slider cap and memory watermark, and further narrow the AI's raw text range within the max range.</p>
                     </div>

                     {/* Memory Palace: one-click vectorize all chat history */}
                     {isMemoryPalaceEnabled && onForceVectorize && (
                         <div className="pt-2 border-t border-slate-100">
                             <button
                                 type="button"
                                 onClick={() => setRetainRecentForVectorize?.(!retainRecentForVectorize)}
                                 className={`w-full mb-2.5 rounded-2xl border p-3 text-left transition-colors ${retainRecentForVectorize ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}
                             >
                                 <span className="flex items-center gap-2.5">
                                     <span className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${retainRecentForVectorize ? 'bg-amber-500 border-amber-500' : 'bg-white border-slate-300'}`}>
                                         {retainRecentForVectorize && <span className="text-white text-[11px] font-bold">✓</span>}
                                     </span>
                                     <span>
                                         <span className="block text-xs font-bold text-slate-700">Keep the most recent 10 injected into context for me</span>
                                         <span className="block text-[10px] text-slate-400 mt-0.5 leading-relaxed">If off, processes up through the current last message; processed raw text is no longer sent directly to the model.</span>
                                     </span>
                                 </span>
                             </button>
                             <button
                                 onClick={() => { setModalType('memory-vectorize-confirm'); trackEvent('One-Click Save Chat to Memory Palace'); }}
                                 disabled={isVectorizing}
                                 className="w-full py-3 bg-emerald-50 text-emerald-600 font-bold rounded-2xl border border-emerald-200 active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-70"
                             >
                                 {(vectorizePendingCount != null && vectorizePendingCount > 0)
                                     ? `🏰 One-Click Save to Memory Palace · ${vectorizePendingCount} pending`
                                     : (vectorizePendingCount === 0)
                                         ? '🏰 Sync Raw Text Range · Nothing pending right now'
                                         : '🏰 One-Click Save All Chat to Memory Palace'}
                             </button>
                             <p className="text-[10px] text-slate-400 mt-2 text-center leading-relaxed">
                                 Uses the secondary API to process in batches. The impact will be explained again before it actually starts — it will not run immediately.
                             </p>
                         </div>
                     )}

                     <div className="pt-2 border-t border-slate-100">
                         <label className="text-xs font-bold text-red-400 uppercase mb-3 block">Danger Zone</label>
                         <div className="flex items-center gap-2 mb-3 cursor-pointer" onClick={() => setPreserveContext(!preserveContext)}>
                             <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${preserveContext ? 'bg-primary border-primary' : 'bg-slate-100 border-slate-300'}`}>
                                 {preserveContext && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                             </div>
                             <span className="text-sm text-slate-600">Keep the last 10 messages when clearing (preserve context)</span>
                         </div>
                         <button onClick={onClearHistory} className="w-full py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 active:scale-95 transition-transform flex items-center justify-center gap-2">
                             Clear Now
                         </button>
                     </div>
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'memory-vectorize-confirm'}
                title="Confirm Save to Memory Palace"
                onClose={() => { if (!isVectorizing) setModalType('chat-settings'); }}
                footer={isVectorizing ? (
                    <div className="w-full py-3 rounded-2xl bg-emerald-50 text-emerald-700 text-center text-sm font-bold flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        {vectorizeProgress || 'Processing...'}
                    </div>
                ) : (
                    <div className="w-full flex gap-2">
                        <button type="button" onClick={() => setModalType('chat-settings')} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold">Cancel</button>
                        <button type="button" onClick={onForceVectorize} className="flex-1 py-3 rounded-2xl bg-emerald-500 text-white font-bold">Confirm &amp; Start</button>
                    </div>
                )}
            >
                <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
                        <p className="font-bold text-emerald-800 mb-2">After you confirm:</p>
                        <ul className="space-y-1.5 text-xs text-emerald-900/80 list-disc pl-4">
                            <li>All currently processable chat content will be fully organized into memory.</li>
                            <li>{retainRecentForVectorize ? 'The most recent 10 messages continue to be injected into chat context.' : 'Processed raw text is no longer directly injected into chat context.'}</li>
                            <li>The purple watermark and orange raw text range will sync, and the pending count restarts from the new watermark.</li>
                        </ul>
                    </div>
                    <p className="text-[11px] text-slate-400">Please keep the app open during processing and do not clear the chat. If any batch fails, the watermark will not move, so it is safe to retry.</p>
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'memory-vectorize-result'}
                title="Memory Processing Complete"
                onClose={() => { setModalType('none'); }}
                footer={<button type="button" onClick={() => setModalType('none')} className="w-full py-3 rounded-2xl bg-emerald-500 text-white font-bold">Got it</button>}
            >
                <div className="space-y-3">
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                        <div className="text-2xl mb-1">✓</div>
                        <p className="text-sm font-bold text-emerald-800">This chat's memory-processing boundary has been synced</p>
                        <p className="text-[11px] text-emerald-700/70 mt-1">
                            Processed {vectorizeResult?.processedMessages || 0} messages · Added {vectorizeResult?.storedMemories || 0} long-term memories
                        </p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs text-slate-600 leading-relaxed">
                        {(vectorizeResult?.retainedMessages || 0) > 0
                            ? <>The most recent <b>{vectorizeResult?.retainedMessages}</b> messages will continue to be injected into chat context; earlier processed raw text is no longer re-injected.</>
                            : <>Processed raw text will no longer be directly injected into chat context — earlier content will instead be recalled by the Memory Palace as needed.</>}
                    </div>
                    <p className="text-[11px] text-slate-400 text-center">The vectorization pending count has restarted from the new watermark.</p>
                    {vectorizeResult?.waterlineAlreadyAhead && (
                        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-2.5 leading-relaxed">
                            The most recent 10 messages were already processed before. To avoid re-vectorizing, the watermark has not been rolled back, but these 10 messages are still kept in context per your choice.
                        </p>
                    )}
                </div>
            </Modal>

            {/* Archive Settings Modal */}
            <Modal isOpen={modalType === 'archive-settings'} title="Memory Archive Settings" onClose={() => { if (!isSummarizing) setModalType('none'); }} footer={
                isSummarizing ?
                <div className="w-full py-3 bg-slate-100 text-indigo-600 font-bold rounded-2xl text-center flex items-center justify-center gap-2"><div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>{archiveProgress || 'Archiving...'}</div> :
                <button onClick={onArchive} disabled={isSummarizing} className="w-full py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200">Start Archiving</button>
            }>
                <div className="space-y-4">
                    {(() => {
                        const palaceOn = !!(activeCharacter as any).memoryPalaceEnabled;
                        const autoOn = !!(activeCharacter as any).autoArchiveEnabled;
                        const activePrompt = archivePrompts.find(p => p.id === selectedPromptId);
                        const activeName = activePrompt?.name || 'Rational Refinement';
                        if (palaceOn && autoOn) {
                            return (
                                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-[11px] text-emerald-800 leading-relaxed">
                                    ✅ <b>Auto-archive is on</b>. After Palace processing, the system automatically archives chat by date into "This Month's Daily Summary."<br/>
                                    Auto-archive uses the <b>Memory Palace's built-in style</b> (to keep vector-retrieval quality stable);
                                    the template below <b>only affects the "Start Archiving" button here</b> — changing the style here will not affect auto-archive.
                                </div>
                            );
                        }
                        if (palaceOn && !autoOn) {
                            return (
                                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 leading-relaxed">
                                    ⚠️ Memory Palace is on, but <b>auto-archive is off</b> — Memory Palace only quietly builds memories in the background, and will not write into the monthly summary.<br/>
                                    To make it write automatically → Neural Link → Character → the <b>"📚 Auto-Archive"</b> toggle below the Memory Palace switch;
                                    or keep using the button below to run manually with the currently selected <b>"{activeName}"</b> style.
                                </div>
                            );
                        }
                        return (
                            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[11px] text-slate-700 leading-relaxed">
                                📋 <b>Pure manual mode</b> (Memory Palace is off). The button below will use the selected
                                <b className="text-slate-900"> "{activeName}"</b> style to summarize chat by day into "This Month's Daily Summary."
                                Once archiving finishes, already-summarized old messages are automatically hidden (a recent portion stays visible).
                            </div>
                        );
                    })()}
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                        <label className="text-[10px] font-bold text-indigo-400 uppercase mb-2 block">Choose Prompt Template</label>
                        <div className="flex flex-col gap-2">
                            {archivePrompts.map(p => {
                                const isSelected = selectedPromptId === p.id;
                                return (
                                <div key={p.id} onClick={() => setSelectedPromptId(p.id)} className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between ${isSelected ? 'bg-white border-indigo-500 shadow-sm ring-1 ring-indigo-500' : 'bg-white/50 border-indigo-200 hover:bg-white'}`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className={`text-xs font-bold ${isSelected ? 'text-indigo-700' : 'text-slate-600'}`}>{p.name}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={(e) => { e.stopPropagation(); setSelectedPromptId(p.id); onEditPrompt(); }} className="text-[10px] text-slate-400 hover:text-indigo-500 px-2 py-1 rounded bg-slate-100 hover:bg-indigo-50">Edit / View</button>
                                        {!p.id.startsWith('preset_') && (
                                            <button onClick={(e) => { e.stopPropagation(); onDeletePrompt(p.id); }} className="text-[10px] text-red-300 hover:text-red-500 px-2 py-1 rounded hover:bg-red-50">×</button>
                                        )}
                                    </div>
                                </div>
                                );
                            })}
                        </div>
                        <button onClick={onCreatePrompt} className="mt-3 w-full py-2 text-xs font-bold text-indigo-500 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-100">+ New Custom Prompt</button>
                    </div>
                    <div className="text-[10px] text-slate-400 bg-slate-50 p-3 rounded-xl leading-relaxed">
                        • <b>Rational Refinement</b>: good for generating clearly organized event logs, easy for the AI's long-term memory retrieval.<br/>
                        • <b>Diary Style</b>: good for generating first-person character diary entries, more immersive and emotionally colored.<br/>
                        • Supported variables: <code>{'${dateStr}'}</code>, <code>{'${char.name}'}</code>, <code>{'${userProfile.name}'}</code>, <code>{'${rawLog}'}</code>
                    </div>
                </div>
            </Modal>

            {/* Prompt Editor Modal */}
            <Modal isOpen={modalType === 'prompt-editor'} title="Edit Prompt" onClose={() => setModalType('archive-settings')} footer={<button onClick={onSavePrompt} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Save Preset</button>}>
                <div className="space-y-3">
                    <input
                        value={editingPrompt?.name || ''}
                        onChange={e => setEditingPrompt((prev: any) => prev ? {...prev, name: e.target.value} : null)}
                        placeholder="Preset name"
                        className="w-full px-4 py-2 bg-slate-100 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <textarea
                        value={editingPrompt?.content || ''}
                        onChange={e => setEditingPrompt((prev: any) => prev ? {...prev, content: e.target.value} : null)}
                        className="w-full h-64 bg-slate-100 rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 leading-relaxed"
                        placeholder="Enter prompt content..."
                    />
                </div>
            </Modal>

            {/* History Manager Modal */}
            <Modal
                isOpen={modalType === 'history-manager'} title="AI Raw Text Read Range" onClose={() => { setModalType('none'); setHistoryPage(0); setHistorySearch(''); }}
                footer={<><button onClick={() => onSetHistoryStart(undefined)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Clear User Breakpoint</button><button onClick={() => { setModalType('none'); setHistoryPage(0); setHistorySearch(''); }} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">Done</button></>}
            >
                <div className="space-y-2 max-h-[50vh] overflow-y-auto no-scrollbar p-1">
                    <p className="text-xs text-slate-400 text-center mb-2"><b>Tap</b> a message = set a user breakpoint (can only narrow the range) · <b>Long-press</b> a message = jump to view the raw text</p>
                    <div className="grid gap-2 mb-2">
                        <div className="bg-violet-50 border border-violet-200 rounded-xl p-2.5 text-[11px] text-violet-800 leading-relaxed">
                            <b>Purple · Memory Palace Watermark</b>: messages before this have already been processed and will not be re-vectorized by adjusting context.
                        </div>
                        <div className="bg-orange-50 border border-orange-200 rounded-xl p-2.5 text-[11px] text-orange-800 leading-relaxed">
                            <b>Orange · Max Range Start</b>: determined by {contextRangeSnapshot?.mode === 'adaptive' ? (activeCharacter.contextFollowsMemoryPalaceHwm ? 'the memory watermark' : 'full-auto memory') : `the slider (${settingsContextLimit})`}, the user breakpoint cannot go past it to read earlier content.
                            {contextRangeSnapshot?.mode === 'adaptive' && !contextRangeSnapshot.maxRangeStartMessageId && ' There are currently 0 messages after the watermark, so there is no extra orange start point in the list.'}
                        </div>
                        {contextRangeSnapshot?.userStartMessageId && (
                            <div className="bg-sky-50 border border-sky-200 rounded-xl p-2.5 text-[11px] text-sky-800 leading-relaxed">
                                <b>Blue · User Breakpoint</b>: only further hides earlier raw text within the max range; automatically becomes invalid once the moving max range passes it.
                            </div>
                        )}
                    </div>
                    <div className="sticky top-0 bg-white/95 backdrop-blur-sm z-10 pb-1.5 -mx-1 px-1">
                        <div className="relative">
                            <input
                                type="text"
                                value={historySearch}
                                onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(0); }}
                                placeholder="Fuzzy search history messages (keyword / character-order match)"
                                className="w-full pl-8 pr-8 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-primary focus:bg-white transition-colors"
                            />
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                            </svg>
                            {historySearch && (
                                <button onClick={() => { setHistorySearch(''); setHistoryPage(0); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-base leading-none">×</button>
                            )}
                        </div>
                    </div>
                    {(() => {
                        const reversed = allHistoryMessages.slice().reverse();
                        const query = historySearch.trim();
                        const filtered = query ? reversed.filter(message => chatMessageFuzzyMatchesKeyword(message, query)) : reversed;
                        const limited = query ? filtered.slice(0, HISTORY_SEARCH_MAX) : filtered;
                        const totalPages = Math.max(1, Math.ceil(limited.length / HISTORY_PAGE_SIZE));
                        const pageMessages = limited.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
                        const hwm = contextRangeSnapshot?.hwm || 0;
                        const maxCut = contextRangeSnapshot?.maxRangeStartMessageId;
                        const userCut = contextRangeSnapshot?.userStartMessageId;
                        const effectiveCut = contextRangeSnapshot?.effectiveStartMessageId;
                        return (<>
                            {query && (
                                <div className="text-xs text-slate-500 px-1 py-1">
                                    Found <b className="text-primary">{filtered.length}</b> matches
                                    {filtered.length > HISTORY_SEARCH_MAX && <span className="text-slate-400">(showing only the first {HISTORY_SEARCH_MAX})</span>}
                                </div>
                            )}
                            {!query && filtered.length === 0 && (
                                <div className="text-xs text-slate-400 text-center py-4">No history messages yet</div>
                            )}
                            {query && filtered.length === 0 && (
                                <div className="text-xs text-slate-400 text-center py-4">No matching messages</div>
                            )}
                            {limited.length > HISTORY_PAGE_SIZE && (
                                <div className="flex items-center justify-between px-1 py-1">
                                    <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0} className={`px-3 py-1 text-xs rounded-lg ${historyPage === 0 ? 'text-slate-300' : 'text-primary hover:bg-primary/10'}`}>Previous</button>
                                    <span className="text-xs text-slate-400">{historyPage + 1} / {totalPages} ({limited.length} total)</span>
                                    <button onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))} disabled={historyPage >= totalPages - 1} className={`px-3 py-1 text-xs rounded-lg ${historyPage >= totalPages - 1 ? 'text-slate-300' : 'text-primary hover:bg-primary/10'}`}>Next</button>
                                </div>
                            )}
                            {pageMessages.map(m => {
                                const isWatermark = hwm === m.id;
                                const isMaxStart = maxCut === m.id;
                                const isUserStart = userCut === m.id;
                                const isHidden = !!(effectiveCut && m.id < effectiveCut);
                                const isVectorized = hwm > 0 && m.id <= hwm;
                                const cls = isUserStart
                                    ? 'bg-sky-50 border-sky-300 ring-1 ring-sky-300'
                                    : isMaxStart
                                        ? 'bg-orange-50 border-orange-300 ring-1 ring-orange-300'
                                        : isWatermark
                                            ? 'bg-violet-50 border-violet-300 ring-1 ring-violet-300'
                                            : isHidden
                                                ? 'bg-slate-50 border-slate-100 opacity-55'
                                                : 'bg-white border-slate-100 hover:bg-slate-50';
                                const contentClass = isHidden ? 'text-slate-400 line-through decoration-slate-300/70' : 'text-slate-500';
                                return (
                                    <div
                                        key={m.id}
                                        id={`history-msg-${m.id}`}
                                        onClick={() => handleHistoryItemClick(m.id)}
                                        onPointerDown={() => startHistoryLongPress(m.id)}
                                        onPointerUp={cancelHistoryLongPress}
                                        onPointerLeave={cancelHistoryLongPress}
                                        onPointerCancel={cancelHistoryLongPress}
                                        onContextMenu={(e) => e.preventDefault()}
                                        className={`p-3 rounded-xl border cursor-pointer text-xs flex gap-2 items-start transition-colors select-none ${cls}`}
                                    >
                                        <span className="text-slate-400 font-mono whitespace-nowrap pt-0.5">[{new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}]</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-bold text-slate-600 mb-0.5">{m.role === 'user' ? 'Me' : activeCharacter.name}</div>
                                            <div className="truncate">{renderHighlighted(m.content || '', query, contentClass)}</div>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-1 max-w-[42%]">
                                            {isWatermark && <span className="text-violet-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-violet-200">Watermark</span>}
                                            {isMaxStart && <span className="text-orange-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-orange-200">Max Range</span>}
                                            {isUserStart && <span className="text-sky-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-sky-200">User Breakpoint</span>}
                                            {!isWatermark && !isMaxStart && !isUserStart && isHidden && <span className="text-slate-400 font-bold text-[9px] bg-white px-1.5 rounded-full border border-slate-200">AI does not read this</span>}
                                            {!isWatermark && !isMaxStart && !isUserStart && isVectorized && !isHidden && <span className="text-violet-400 font-bold text-[9px] bg-white px-1.5 rounded-full border border-violet-100">Vectorized</span>}
                                        </div>
                                    </div>
                                );
                            })}
                            {limited.length > HISTORY_PAGE_SIZE && (
                                <div className="flex items-center justify-center px-1 pt-2">
                                    <span className="text-xs text-slate-400">{historyPage + 1} / {totalPages}</span>
                                </div>
                            )}
                        </>);
                    })()}
                </div>
            </Modal>

            <Modal isOpen={modalType === 'message-options'} title="Message Actions" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={onEnterSelectionMode} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        Multi-select / Bulk Delete
                    </button>
                    <button onClick={onReplyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        Quote / Reply
                    </button>
                    {selectedMessage?.type === 'text' && (
                        <button onClick={onEditMessageStart} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            Edit Content
                        </button>
                    )}
                    {selectedMessage?.type === 'text' && (
                        <button onClick={onCopyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            Copy Text
                        </button>
                    )}
                    {selectedMessage && onToggleMessageFavorite && (
                        <button onClick={() => { onToggleMessageFavorite(); setModalType('none'); }} className={`w-full py-3 font-medium rounded-2xl transition-colors flex items-center justify-center gap-2 ${messageFavorited ? 'bg-violet-100 text-violet-700 active:bg-violet-200' : 'bg-violet-50 text-violet-600 active:bg-violet-100'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={messageFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m11.48 3.499-2.13 4.316-4.763.692c-.963.14-1.348 1.323-.651 2.002l3.447 3.36-.814 4.744c-.165.96.842 1.691 1.703 1.238L12.532 17.6l4.26 2.24c.862.453 1.869-.278 1.704-1.238l-.814-4.744 3.447-3.36c.697-.679.312-1.862-.651-2.002l-4.763-.692-2.13-4.316c-.43-.873-1.675-.873-2.105.011Z" /></svg>
                            {messageFavorited
                                ? (selectedMessage.type === 'image' ? 'Unfavorite Image' : 'Unfavorite Chat Message')
                                : (selectedMessage.type === 'image' ? 'Favorite Image' : 'Favorite Chat Message')}
                        </button>
                    )}
                    {voiceAvailable && selectedMessage?.role === 'assistant' && selectedMessage?.type === 'text' && onGenerateVoice && (
                        <button onClick={() => { onGenerateVoice(); setModalType('none'); }} className="w-full py-3 bg-emerald-50 text-emerald-600 font-medium rounded-2xl active:bg-emerald-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg>
                            Convert to Voice
                        </button>
                    )}
                    {voiceDownloadable && onDownloadVoice && (
                        <button onClick={() => { onDownloadVoice(); setModalType('none'); }} className="w-full py-3 bg-sky-50 text-sky-600 font-medium rounded-2xl active:bg-sky-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                            Download Voice
                        </button>
                    )}
                    {voiceCollectable && selectedMessage?.role === 'assistant' && onToggleVoiceFavorite && (
                        <button onClick={() => { onToggleVoiceFavorite(); setModalType('none'); }} className={`w-full py-3 font-medium rounded-2xl transition-colors flex items-center justify-center gap-2 ${voiceFavorited ? 'bg-amber-100 text-amber-700 active:bg-amber-200' : 'bg-amber-50 text-amber-600 active:bg-amber-100'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={voiceFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m11.48 3.499-2.13 4.316-4.763.692c-.963.14-1.348 1.323-.651 2.002l3.447 3.36-.814 4.744c-.165.96.842 1.691 1.703 1.238L12.532 17.6l4.26 2.24c.862.453 1.869-.278 1.704-1.238l-.814-4.744 3.447-3.36c.697-.679.312-1.862-.651-2.002l-4.763-.692-2.13-4.316c-.43-.873-1.675-.873-2.105.011Z" /></svg>
                            {voiceFavorited ? 'Unfavorite Voice' : 'Favorite Voice'}
                        </button>
                    )}
                    <button onClick={onDeleteMessage} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                        Delete Message
                    </button>
                </div>
            </Modal>

             <Modal
                isOpen={modalType === 'delete-emoji'} title="Delete Emoji" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={onDeleteEmoji} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">Delete</button></>}
            >
                <div className="flex flex-col items-center gap-4 py-2">
                    {Array.isArray(selectedEmoji) ? (
                        <div className="flex flex-wrap justify-center gap-2 max-h-48 overflow-y-auto no-scrollbar w-full px-2">
                            {selectedEmoji.map((e: any, idx: number) => (
                                <TokenImg key={idx} value={e.url} className="w-16 h-16 object-contain rounded-xl border border-slate-200" />
                            ))}
                        </div>
                    ) : (
                        selectedEmoji && <TokenImg value={selectedEmoji.url} className="w-24 h-24 object-contain rounded-xl border" />
                    )}
                    <p className="text-center text-sm text-slate-500">
                        {Array.isArray(selectedEmoji) ? `Are you sure you want to delete these ${selectedEmoji.length} emoji?` : "Are you sure you want to delete this emoji?"}
                    </p>
                </div>
            </Modal>

            {/* Emoji Options Modal (shown on long-press) */}
            <Modal isOpen={modalType === 'emoji-options'} title="Emoji Actions" onClose={() => setModalType('none')}>
                <div className="flex flex-col items-center gap-4 py-1">
                    {selectedEmoji && !Array.isArray(selectedEmoji) && (
                        <div className="flex flex-col items-center gap-2">
                            <TokenImg value={selectedEmoji.url} className="w-20 h-20 object-contain rounded-xl border border-slate-200" />
                            <span className="text-sm font-medium text-slate-600 max-w-[12rem] truncate">{selectedEmoji.name}</span>
                        </div>
                    )}
                    <div className="w-full space-y-3">
                        <button
                            onClick={() => { if (selectedEmoji && !Array.isArray(selectedEmoji)) setNewEmojiName(selectedEmoji.name); setModalType('rename-emoji'); }}
                            className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                            </svg>
                            Rename
                        </button>
                        <button
                            onClick={() => setModalType('delete-emoji')}
                            className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                            Delete
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Rename Emoji Modal */}
            <Modal
                isOpen={modalType === 'rename-emoji'} title="Rename Emoji" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={onRenameEmoji} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">Save</button></>}
            >
                <input
                    value={newEmojiName}
                    onChange={e => setNewEmojiName(e.target.value)}
                    placeholder="Enter emoji name..."
                    className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-base font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-slate-700"
                    autoFocus
                />
            </Modal>

            {/* Delete Category Modal */}
            <Modal
                isOpen={modalType === 'delete-category'} title="Delete Category" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={onDeleteCategory} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">Delete</button></>}
            >
                <div className="py-4 text-center">
                    <p className="text-sm text-slate-600">Are you sure you want to delete the category <br/><span className="font-bold">"{selectedCategory?.name}"</span>?</p>
                    <p className="text-[10px] text-red-400 mt-2">Note: all emoji under this category will also be deleted!</p>
                </div>
            </Modal>

            {/* Category Options Modal (shown on long-press) */}
            <Modal isOpen={modalType === 'category-options'} title="Category Actions" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={openVisibilityModal} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                        Set Visible Characters
                    </button>
                    {selectedCategory && !selectedCategory.isSystem && selectedCategory.id !== 'default' && (
                        <button onClick={() => setModalType('delete-category')} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                            Delete Category
                        </button>
                    )}
                </div>
            </Modal>

            {/* Category Visibility Modal */}
            <Modal
                isOpen={modalType === 'category-visibility'} title={`"${selectedCategory?.name}" Visible Characters`} onClose={() => setModalType('none')}
                footer={<button onClick={handleSaveVisibility} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Save Settings</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-400 leading-relaxed">
                        Choose which characters can use this emoji group. If none are checked, all characters can use it.
                    </p>
                    <div className="space-y-2 max-h-[40vh] overflow-y-auto no-scrollbar">
                        {allCharacters.map(c => (
                            <div
                                key={c.id}
                                onClick={() => toggleVisibilityChar(c.id)}
                                className={`flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all ${visibilitySelection.has(c.id) ? 'bg-primary/5 border-primary/30' : 'bg-white border-slate-100 hover:bg-slate-50'}`}
                            >
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors shrink-0 ${visibilitySelection.has(c.id) ? 'bg-primary border-primary' : 'bg-slate-100 border-slate-300'}`}>
                                    {visibilitySelection.has(c.id) && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                                <TokenImg value={c.avatar} className="w-9 h-9 rounded-xl object-cover" />
                                <div className="flex-1 min-w-0">
                                    <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                    <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    {visibilitySelection.size > 0 && (
                        <div className="text-[11px] text-center text-slate-500 bg-slate-50 rounded-lg py-2">
                            <span className="font-bold text-primary">{visibilitySelection.size}</span> character(s) selected who can use this group
                        </div>
                    )}
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'edit-message'} title="Edit Content" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={onConfirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">Save</button></>}
            >
                <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed"
                />
            </Modal>

            {/* Schedule Modal */}
            <Modal
                isOpen={modalType === 'schedule'} title={`${activeCharacter?.name || 'Character'}'s Schedule / Mood`} onClose={() => setModalType('none')}
            >
                <div className="max-h-[70vh] overflow-y-auto -mx-2 px-2">
                    {/* Master toggle: when off, does not call the secondary API, does not generate a schedule, does not inject emotion buffs */}
                    {onToggleScheduleFeature && (
                        <div className="mb-4 bg-slate-50 border border-slate-200 rounded-2xl p-3">
                            <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0 pr-3">
                                    <p className="text-xs font-bold text-slate-700">Schedule &amp; Emotion Buffs</p>
                                    <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5">
                                        {isScheduleFeatureEnabled
                                            ? 'On: the character will have a schedule for today, and carry their current mood into chat.'
                                            : 'Off: no secondary API calls, no schedule generation, no emotion buffs injected.'}
                                    </p>
                                </div>
                                <button
                                    onClick={onToggleScheduleFeature}
                                    aria-label="Toggle schedule and emotion master switch"
                                    className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${isScheduleFeatureEnabled ? 'bg-primary' : 'bg-slate-300'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${isScheduleFeatureEnabled ? 'translate-x-4' : ''}`}></div>
                                </button>
                            </div>
                        </div>
                    )}

                    {isScheduleFeatureEnabled && (
                        <>
                            {/* Schedule Style Selector */}
                            {onScheduleStyleChange && (
                                <div className="mb-4">
                                    {!activeCharacter?.scheduleStyle && (
                                        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-3">
                                            <p className="text-xs text-amber-700 font-bold mb-1">Please choose a schedule style</p>
                                            <p className="text-[11px] text-amber-600 leading-relaxed">
                                                Different styles affect how the character's inner monologue is generated. Choosing one automatically regenerates today's schedule.
                                            </p>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => onScheduleStyleChange('lifestyle')}
                                            disabled={isScheduleGenerating}
                                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                                (activeCharacter?.scheduleStyle || 'lifestyle') === 'lifestyle'
                                                    ? 'bg-violet-100 border-violet-300 text-violet-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                            }`}
                                        >
                                            <span className="block text-sm mb-0.5">Lifestyle</span>
                                            <span className="block text-[10px] opacity-70 font-normal">Fictional daily life · running, cooking, shopping</span>
                                        </button>
                                        <button
                                            onClick={() => onScheduleStyleChange('mindful')}
                                            disabled={isScheduleGenerating}
                                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                                activeCharacter?.scheduleStyle === 'mindful'
                                                    ? 'bg-teal-100 border-teal-300 text-teal-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                            }`}
                                        >
                                            <span className="block text-sm mb-0.5">Mindful</span>
                                            <span className="block text-[10px] opacity-70 font-normal">Real inner thoughts · no fiction, no lying</span>
                                        </button>
                                    </div>
                                </div>
                            )}

                            <ScheduleCard
                                schedule={scheduleData || null}
                                character={activeCharacter}
                                compact={false}
                                onEdit={onScheduleEdit}
                                onDelete={onScheduleDelete}
                                onReroll={onScheduleReroll}
                                onCoverImageChange={onScheduleCoverChange}
                                onPlayTheater={onPlayTheater}
                                isGenerating={isScheduleGenerating}
                            />
                            <p className="text-[10px] text-slate-400 text-center mt-3 leading-relaxed">
                                Tap a schedule item to edit · long-press to delete
                            </p>

                            {/* Emotion / stream-of-consciousness API — forced in sync with the schedule */}
                            {activeCharacter && apiPresets && onAddApiPreset && onSaveEmotion && onClearBuffs && (
                                <EmotionSettingsPanel
                                    char={activeCharacter}
                                    apiPresets={apiPresets}
                                    addApiPreset={onAddApiPreset}
                                    onSave={onSaveEmotion}
                                    onClearBuffs={onClearBuffs}
                                />
                            )}
                        </>
                    )}
                </div>
            </Modal>
        </>
    );
};

export default ChatModals;
