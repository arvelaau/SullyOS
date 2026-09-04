
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { AppID, CharacterProfile, CharacterExportData, UserImpression, MemoryFragment } from '../types';
import { SlidersHorizontal, SpeakerHigh, Books, BookOpen } from '@phosphor-icons/react';
import Modal from '../components/os/Modal';
import { processImage } from '../utils/file';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { formatMessageWithTime, formatMessageForPrompt } from '../utils/messageFormat';
import { DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import ImpressionPanel from '../components/character/ImpressionPanel';
import RoomPlatePanel from '../components/character/RoomPlatePanel';
import MemoryArchivist from '../components/character/MemoryArchivist';
import ChibiStudio, { ChibiShelfPanel } from '../components/character/ChibiStudio';
import TokenImg from '../components/os/TokenImg';
import { resolveBlobRefsDeep, migrateDataUrlToRef } from '../utils/blobRef';
import { characterLaunch } from '../utils/characterLaunch';
import { safeFetchJson, extractContent } from '../utils/safeApi';
import { fetchMiniMaxVoices, MiniMaxVoiceItem } from '../utils/minimaxVoice';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { normalizeElevenLabsVoiceId, synthesizeSpeechElevenLabsDetailed } from '../utils/elevenLabsTts';
import { normalizeUserImpression } from '../utils/impression';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { COMMON_TIMEZONES } from '../utils/timezone';
import { toMountedWorldbook } from '../utils/worldbook';
import { stripSensitiveCardFields } from '../utils/characterCard';
import { shareOrDownloadFile } from '../utils/shareExport';
import { confirmExportSafety } from '../utils/exportGuard';
import { trackEvent } from '../utils/analytics';
import { sortCharacterGroups, GROUP_FILTER_UNGROUPED } from '../components/character/CharacterGroupFilter';
import {
    EXTERNAL_MEMORY_MAX_CHARS,
    extractExternalMemoryText,
    getExternalMemoryLengthInfo,
    getExternalMemoryOverLimitMessage,
} from '../utils/memoryPalace/externalMemory';

// ── Neural Link · list page visuals (lavender whitespace style) ────────────────────
// The old "starlight + glass ribbon + ornate avatar frame" got tiring to look at, and repainting was
// laggy on low-end devices.
// Switched to a clean, whitespace-first version: plain lavender background, rounded square buttons,
// plain round avatars, plain white cards.
// No persistent animation / no filter / no big blur shadows — cleaner and more battery-friendly.
// List page only, edit page untouched.

/** Top-bar rounded-square button (squircle): white background with thin violet outline + line icon + small label underneath */
const ToolButton: React.FC<{ label: string; title?: string; onClick: () => void; children: React.ReactNode }> = ({ label, title, onClick, children }) => (
    <button onClick={onClick} title={title} className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform">
        <span className="w-12 h-12 flex items-center justify-center rounded-2xl bg-white border border-violet-200/80 text-violet-500 shadow-[0_2px_6px_rgba(140,120,200,0.10)]">
            {children}
        </span>
        <span className="text-[11px] text-violet-400/90 font-medium tracking-wider">{label}</span>
    </button>
);

const CharacterCard: React.FC<{
    char: CharacterProfile;
    /** The currently active (chatting) character gets a lavender highlight */
    active?: boolean;
    onClick: () => void;
    onDelete: (e: React.MouseEvent) => void;
}> = ({ char, active, onClick, onDelete }) => (
    <div
        onClick={onClick}
        className={`relative px-4 py-3.5 rounded-3xl border bg-white transition-colors cursor-pointer group shrink-0 shadow-[0_2px_10px_rgba(140,120,200,0.07)] ${
            active ? 'border-violet-300' : 'border-slate-100 hover:border-violet-200'
        }`}
    >
        <div className="flex items-center gap-4">
            <div className="w-14 h-14 shrink-0 rounded-full overflow-hidden border border-violet-100 bg-violet-50">
                <TokenImg value={char.avatar} className="w-full h-full object-cover" alt={char.name} />
            </div>
            <div className="flex-1 min-w-0 pr-6">
                <h3 className="text-lg font-bold truncate text-slate-800">
                    {char.name}
                </h3>
                <p className="text-xs truncate mt-0.5 text-violet-400/80">
                    {char.description || 'No description yet'}
                </p>
            </div>
        </div>
        <button
            onClick={onDelete}
            className="absolute top-1/2 -translate-y-1/2 right-4 w-7 h-7 flex items-center justify-center rounded-full bg-slate-50 border border-slate-100 text-slate-300 hover:text-violet-400 hover:border-violet-200 active:scale-90 transition-colors"
        >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
        </button>
    </div>
);

const Character: React.FC = () => {
  const { closeApp, openApp, characters, activeCharacterId, setActiveCharacterId, addCharacter, updateCharacter, deleteCharacter, characterGroups, createCharacterGroup, renameCharacterGroup, deleteCharacterGroup, apiConfig, addToast, userProfile, worldbooks, addWorldbook } = useOS();
  const launchIntent = characterLaunch.peek();
  const [view, setView] = useState<'list' | 'detail'>(() => launchIntent ? 'detail' : 'list');
  const [charPage, setCharPage] = useState(0); // Character list pagination (6 per page, only when no groups exist)
  // Group expand state: stores "expanded" group ids (not recorded = collapsed). Remembered across sessions, key below
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => {
      try {
          const raw = localStorage.getItem('os_char_groups_expanded');
          if (raw) {
              const arr = JSON.parse(raw);
              if (Array.isArray(arr)) return arr;
          }
      } catch {}
      return [GROUP_FILTER_UNGROUPED]; // On first entry only expand "Ungrouped" — named groups start collapsed
  });
  const toggleGroupExpanded = (id: string) => {
      setExpandedGroups(prev => {
          const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
          try { localStorage.setItem('os_char_groups_expanded', JSON.stringify(next)); } catch {}
          return next;
      });
  };
  const [detailTab, setDetailTab] = useState<'identity' | 'memory' | 'impression' | 'plates' | 'chibi'>(() => launchIntent?.openChibiStudio ? 'chibi' : 'identity');
  // QQ Character Workshop (Figure Studio) full-screen overlay
  const [showChibiStudio, setShowChibiStudio] = useState(() => !!launchIntent?.openChibiStudio);
  const [editingId, setEditingId] = useState<string | null>(() => launchIntent?.charId || null);
  const [formData, setFormData] = useState<CharacterProfile | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  // Draft for the avatar URL input — not committed to formData.avatar character-by-character,
  // otherwise every keystroke would leave every <img> referencing char.avatar requesting the
  // root path with an incomplete string as a relative path, causing a flurry of GET / calls
  // and broken images across the screen while typing. Only validated + committed on blur / Enter.
  const [avatarUrlDraft, setAvatarUrlDraft] = useState('');
  // Life record modules globally hidden (long-press-hidden on a tab in the Profile app) —
  // the corresponding toggle row just isn't shown
  const [hiddenLifeModules, setHiddenLifeModules] = useState<string[]>([]);
  useEffect(() => {
      DB.getLifeRecordSettings()
          .then(s => setHiddenLifeModules(s?.hiddenModules || []))
          .catch(() => {});
  }, []);
  useEffect(() => {
      characterLaunch.consume();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardImportRef = useRef<HTMLInputElement>(null);
  
  // Race Condition Guards
  const editingIdRef = useRef<string | null>(null);
  
  // Modals
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<string | null>(null);
  // A character whose cloud amsg2 tasks didn't fully clear, blocking local delete → pops the "Retry / Delete Anyway" confirmation.
  const [cloudCleanupFailTarget, setCloudCleanupFailTarget] = useState<string | null>(null);
  // Deletion must first await cloud task cancellation (when the character has amsg2 tasks) — lock the button meanwhile to prevent double-taps.
  const [isDeleting, setIsDeleting] = useState(false);
  const [showWorldbookModal, setShowWorldbookModal] = useState(false); // New Modal
  // Worldbook-mounting modal: search term + currently expanded category (categories collapsed by default, to avoid rendering every entry at once and choking the UI)
  const [wbModalSearch, setWbModalSearch] = useState('');
  const [wbModalExpandedCategory, setWbModalExpandedCategory] = useState<string | null>(null);
  const [showGroupModal, setShowGroupModal] = useState(false); // Character group management
  const [newGroupName, setNewGroupName] = useState('');
  // Inline input on the edit page for "create a new group and assign"
  const [detailGroupDraft, setDetailGroupDraft] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [exportText, setExportText] = useState('');
  const [isProcessingMemory, setIsProcessingMemory] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const importLengthInfo = useMemo(() => getExternalMemoryLengthInfo(importText), [importText]);

  // Batch Summarize State
  const [batchRange, setBatchRange] = useState({ start: '', end: '' });
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

  // Archive Prompts State (shared with ChatApp)
  const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
  const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
  const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  // Impression State
  const [isGeneratingImpression, setIsGeneratingImpression] = useState(false);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [isTestingElevenLabsVoice, setIsTestingElevenLabsVoice] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState<Record<'system' | 'voice_cloning' | 'voice_generation', MiniMaxVoiceItem[]>>({
      system: [],
      voice_cloning: [],
      voice_generation: [],
  });

  const handleLoadMiniMaxVoices = async () => {
      const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
      if (!minimaxApiKey) {
          addToast('Please fill in your MiniMax API Key in Settings first (falls back to the general API Key if left blank)', 'error');
          return;
      }

      setIsLoadingVoices(true);
      try {
          const result = await fetchMiniMaxVoices(minimaxApiKey, 'all');
          setVoiceOptions({
              system: result.system_voice,
              voice_cloning: result.voice_cloning,
              voice_generation: result.voice_generation,
          });
          addToast(`Voices fetched: System ${result.system_voice.length} / Cloned ${result.voice_cloning.length} / Generated ${result.voice_generation.length}`, 'success');
      } catch (e: any) {
          console.error('[MiniMax Voice] load failed', e);
          addToast(e?.message || 'Failed to fetch MiniMax voices', 'error');
      } finally {
          setIsLoadingVoices(false);
      }
  };

  const applyVoiceToCharacter = (voice: MiniMaxVoiceItem, source: 'system' | 'voice_cloning' | 'voice_generation') => {
      if (!formData) return;
      handleChange('voiceProfile', {
          ...(formData.voiceProfile || {}),
          provider: 'minimax',
          voiceId: voice.voice_id,
          voiceName: voice.voice_name || '',
          source,
          model: formData.voiceProfile?.model || 'speech-2.8-hd',
          notes: formData.voiceProfile?.notes || '',
      });
      addToast(`Voice applied: ${voice.voice_name || voice.voice_id}`, 'success');
      trackEvent('Apply Voice to Character', { source });
  };

  const handleTestElevenLabsVoice = async () => {
      if (!formData || isTestingElevenLabsVoice) return;
      const voiceId = normalizeElevenLabsVoiceId(formData.voiceProfile?.elevenLabsVoiceId);
      if (!voiceId) {
          addToast('Please fill in an ElevenLabs Voice ID first', 'info');
          return;
      }
      if (!apiConfig.elevenLabsApiKey?.trim()) {
          addToast('Please save an ElevenLabs Key under Settings → Other APIs first', 'info');
          return;
      }
      setIsTestingElevenLabsVoice(true);
      let previewUrl = '';
      const releasePreviewUrl = () => {
          if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
          previewUrl = '';
      };
      try {
          const previewChar: CharacterProfile = {
              ...formData,
              voiceProfile: { ...(formData.voiceProfile || {}), elevenLabsVoiceId: voiceId },
          };
          const { url } = await synthesizeSpeechElevenLabsDetailed(
              `Hi, I'm ${formData.name || 'your character'}. Can you hear my voice now?`,
              previewChar,
              apiConfig,
          );
          previewUrl = url;
          const audio = new Audio(url);
          audio.onended = releasePreviewUrl;
          audio.onerror = releasePreviewUrl;
          await audio.play();
          addToast('ElevenLabs preview started', 'success');
      } catch (error: any) {
          releasePreviewUrl();
          addToast(error?.message || 'ElevenLabs preview failed', 'error');
      } finally {
          setIsTestingElevenLabsVoice(false);
      }
  };

  // Load archive prompts from localStorage (shared with ChatApp)
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
      if (savedId) setSelectedPromptId(savedId);
  }, []);

  // Sync Ref with State
  useEffect(() => {
      editingIdRef.current = editingId;
  }, [editingId]);

  // CRITICAL FIX: Breaking the render loop.
  // We only sync from global 'characters' to local 'formData' when:
  // 1. We enter edit mode (view becomes detail)
  // 2. We switch character IDs
  useEffect(() => {
    if (editingId && view === 'detail') {
        // Only if formData is not set OR the ID doesn't match
        if (!formData || formData.id !== editingId) {
            const target = characters.find(c => c.id === editingId);
            if (target) setFormData(target);
        }
    }
  }, [editingId, view]);

  // When switching characters, sync the URL draft to that character's current https avatar
  // (if any), otherwise clear it. Doesn't watch every change to formData.avatar — when file
  // upload goes through the data-URL path, the draft should stay untouched.
  useEffect(() => {
    if (!editingId) return;
    const target = characters.find(c => c.id === editingId);
    const av = target?.avatar || '';
    setAvatarUrlDraft(/^https?:\/\/.+/i.test(av) ? av : '');
  }, [editingId]);

  // EXTERNAL-UPDATE SYNC: pull in memories/refinedMemories written by other apps
  // (e.g. Chat archive calling updateCharacter) so stale formData doesn't overwrite them.
  useEffect(() => {
    if (!editingId || !formData || formData.id !== editingId) return;
    const latest = characters.find(c => c.id === editingId);
    if (!latest) return;
    const latestMemCount = latest.memories?.length ?? 0;
    const localMemCount = formData.memories?.length ?? 0;
    const latestRefKeys = Object.keys(latest.refinedMemories || {}).length;
    const localRefKeys = Object.keys(formData.refinedMemories || {}).length;
    if (latestMemCount > localMemCount || latestRefKeys > localRefKeys) {
        setFormData(prev => prev && prev.id === editingId
            ? { ...prev, memories: latest.memories, refinedMemories: latest.refinedMemories }
            : prev);
    }
  }, [characters, editingId]);

  // Auto-save Effect with Safety Guard
  useEffect(() => {
    if (formData && editingId) {
        // SAFETY GUARD: Only save if the formData ID matches the currently active editing ID.
        // This prevents overwriting Character B with Character A's data if a delayed async call updates formData.
        if (formData.id === editingId) {
            updateCharacter(editingId, formData);
        } else {
            console.warn(`Race condition prevented: Tried to save data for ${formData.id} into slot ${editingId}`);
        }
    }
  }, [formData]);

  const handleBack = () => {
      if (view === 'detail') {
          setView('list');
          setEditingId(null);
      } else closeApp();
  };

  const handleAddGroup = async () => {
      const name = newGroupName.trim();
      if (!name) return;
      if (characterGroups.some(g => g.name === name)) {
          addToast('A group with this name already exists', 'error');
          return;
      }
      await createCharacterGroup(name);
      setNewGroupName('');
  };

  // Create character: go straight into the "Identity" edit page once created (rather than
  // staying on the list and dropping a blank card into Ungrouped, which feels counterintuitive —
  // when a user taps New, they want to fill in the persona right away). Once editingId is set,
  // the sync effect below finds this new card in characters and fills formData with it.
  const handleAddCharacter = async () => {
      const created = await addCharacter();
      setEditingId(created.id);
      setFormData(created); // Fill it in directly, to avoid a flash of blank content on the detail page during the moment characters hasn't synced yet
      setDetailTab('identity');
      setView('detail');
  };

  const handleChange = (field: keyof CharacterProfile, value: any) => {
      // Functional update to prevent stale state issues in simple closures
      setFormData(prev => {
          if (!prev) return null;
          return { ...prev, [field]: value };
      });
  };

  // Worldbook Logic
  const mountWorldbook = (bookId: string) => {
      if (!formData) return;
      const book = worldbooks.find(b => b.id === bookId);
      if (!book) return;

      const currentBooks = formData.mountedWorldbooks || [];
      if (currentBooks.some(b => b.id === book.id)) {
          addToast('This worldbook is already mounted', 'info');
          return;
      }

      // CACHE THE CONTENT, include category
      const newBookEntry = toMountedWorldbook(book);
      handleChange('mountedWorldbooks', [...currentBooks, newBookEntry]);
      setShowWorldbookModal(false);
      addToast(`Mounted: ${book.title}`, 'success');
      trackEvent('Mount Worldbook to Character');
  };

  // New: Mount entire category
  const mountCategory = (category: string) => {
      if (!formData) return;
      const booksToMount = worldbooks.filter(b => (b.category || 'Uncategorized (General)') === category);
      if (booksToMount.length === 0) return;

      const currentBooks = formData.mountedWorldbooks || [];
      const newEntries = [];
      let addedCount = 0;

      for (const book of booksToMount) {
          if (!currentBooks.some(b => b.id === book.id)) {
              newEntries.push(toMountedWorldbook(book));
              addedCount++;
          }
      }

      if (addedCount > 0) {
          handleChange('mountedWorldbooks', [...currentBooks, ...newEntries]);
          addToast(`Bulk-mounted ${addedCount} worldbook(s)`, 'success');
      } else {
          addToast('Every worldbook in this group is already mounted', 'info');
      }
      setShowWorldbookModal(false);
  };

  const unmountWorldbook = (bookId: string) => {
      if (!formData) return;
      const currentBooks = formData.mountedWorldbooks || [];
      handleChange('mountedWorldbooks', currentBooks.filter(b => b.id !== bookId));
  };

  // Grouped data for the mount modal. Must be useMemo: this reduce used to be inlined in JSX,
  // which meant every keystroke in the edit form re-grouped every worldbook even while the modal was closed.
  const wbModalGroups = useMemo(() => {
      const groups: Record<string, typeof worldbooks> = {};
      worldbooks.forEach(wb => {
          const cat = wb.category || 'Uncategorized (General)';
          if (!groups[cat]) groups[cat] = [];
          groups[cat].push(wb);
      });
      return Object.entries(groups);
  }, [worldbooks]);

  // Search state: filter by title/category name, showing at most the first 60 results to avoid a long-list slowdown.
  const WB_SEARCH_LIMIT = 60;
  const wbModalSearchResults = useMemo(() => {
      const query = wbModalSearch.trim().toLowerCase();
      if (!query) return null;
      const matched = worldbooks.filter(wb =>
          wb.title.toLowerCase().includes(query) ||
          (wb.category || 'Uncategorized (General)').toLowerCase().includes(query)
      );
      return { books: matched.slice(0, WB_SEARCH_LIMIT), total: matched.length };
  }, [worldbooks, wbModalSearch]);

  const openWorldbookModal = () => {
      setWbModalSearch('');
      setWbModalExpandedCategory(null);
      setShowWorldbookModal(true);
      trackEvent('Open Mount Worldbook Modal');
  };

  // ... (Other handlers unchanged)
  const handleToggleActiveMonth = (year: string, month: string) => {
      if (!formData) return;
      const key = `${year}-${month}`;
      const current = formData.activeMemoryMonths || [];
      const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      handleChange('activeMemoryMonths', next);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          try {
              setIsCompressing(true);
              const processedBase64 = await processImage(file);
              // The avatar field stores a token; the binary sits separately in blob_assets
              // (saves the ~33% bloat from base64). If this exact image was already stored,
              // its token gets reused; if the conversion fails, the raw data URL is returned
              // unchanged so the image isn't lost.
              handleChange('avatar', await migrateDataUrlToRef(processedBase64));
              // Clear the URL draft, otherwise a later onBlur on the URL input would overwrite
              // the just-uploaded data-URL avatar with a stale URL. Not handled via an effect
              // watching avatar — that would eat the draft while the user is still typing a URL.
              setAvatarUrlDraft('');
              addToast('Avatar uploaded successfully', 'success');
          } catch (error: any) {
              addToast(error.message || 'Image processing failed', 'error');
          } finally {
              setIsCompressing(false);
              if (fileInputRef.current) fileInputRef.current.value = '';
          }
      }
  };
  
  const handleRefineMonth = async (year: string, month: string, rawText: string, formattedPrompt?: string) => {
      if (!apiConfig.apiKey) { addToast('Please configure an API Key first', 'error'); return; }
      if (!formData) return;

      const targetId = formData.id; // LOCK ID
      trackEvent('Refine Current Month Core Memory');

      // Build lightweight character identity context (no memories - we're generating those)
      let identityContext = `[Character Identity]\nName: ${formData.name}\n`;
      if (formData.systemPrompt) identityContext += `Core personality/instructions:\n${formData.systemPrompt}\n`;
      if (formData.worldview?.trim()) identityContext += `Worldview: ${formData.worldview}\n`;
      identityContext += `Interacting with: ${userProfile.name}`;
      if (userProfile.bio) identityContext += ` (${userProfile.bio})`;
      identityContext += '\n\n';

      // Gemini 3.1 preview silently refuses to answer (completion_tokens=0, the proxy echoes
      // back a "Token count: N" stub that pollutes the memory store) when an all-in-one user
      // message stacks a 3000+ token persona in front of a task sentence that shows up late.
      // Two countermeasures together:
      //   (A) State the task declaration first, making clear this is summarization, not roleplay
      //   (B) Split system+user: rules/identity/task go in system, the raw diary goes in user,
      //       so the model can clearly tell which part is instruction and which is data
      const taskPreamble = `### Task (highest priority — read this section before anything else)
You are performing a "monthly memory refinement": compress the [${year}-${month} daily memory fragments] provided in the user message into a concise monthly core memory.
This is a **summarization writing task**, not a roleplay conversation — do not enter chat mode, do not wait for the other party to speak, do not output only blank text or silence. Output the summary body directly.`;

      const systemContent = formattedPrompt
          ? `${taskPreamble}\n\n### Character perspective (for writing tone reference only)\n${identityContext}### Detailed rules and output format\n${formattedPrompt}`
          : `${taskPreamble}\n\n### Character perspective (for writing tone reference only)\n${identityContext}### Detailed rules\nWrite in this character's first person, using the same language as the diary (Chinese), and output a concise monthly core memory.`;
      const userContent = rawText;

      const refineUrl = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const t0 = performance.now();
      try {
          const data = await safeFetchJson(refineUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({
                  model: apiConfig.model,
                  messages: [
                      { role: 'system', content: systemContent },
                      { role: 'user', content: userContent },
                  ],
                  temperature: 0.3,
              })
          }, 0);
          const dt = Math.round(performance.now() - t0);
          const summary = extractContent(data);
          if (!summary) {
              // Leave a diagnostic warn on failure: Gemini 3.1 preview silently refuses to
              // answer under certain prompts (completion_tokens=0, the proxy echoes back a
              // "Token count: N" stub) — this info helps quickly confirm if the same issue recurs.
              const msg = data?.choices?.[0]?.message;
              const rawContent = typeof msg?.content === 'string' ? msg.content : '';
              const finishReason = data?.choices?.[0]?.finish_reason;
              console.warn(`🧠 [Refine ${year}-${month}] Model returned empty: dt=${dt}ms finish=${finishReason} content.length=${rawContent.length} preview=${rawContent.slice(0, 120)} usage=`, data?.usage);
              addToast(`Refinement failed: model returned empty (${dt}ms, finish=${finishReason || 'n/a'}), see console for details`, 'error');
              return;
          }
          const key = `${year}-${month}`;

          // CHECK IF USER SWITCHED
          if (editingIdRef.current === targetId) {
              // Still on same page
              handleChange('refinedMemories', { ...(formData.refinedMemories || {}), [key]: summary });
              addToast(`Memory refinement for ${year}-${month} complete`, 'success');
          } else {
              // Switched page - Save to DB directly
              const currentRefined = characters.find(c => c.id === targetId)?.refinedMemories || {};
              updateCharacter(targetId, { refinedMemories: { ...currentRefined, [key]: summary } });
              addToast('Background task complete: memory saved to the original character', 'success');
          }
      } catch (e: any) { addToast(`Refinement failed: ${e.message}`, 'error'); }
  };

  const handleDeleteMemories = (ids: string[]) => { if (!formData) return; handleChange('memories', (formData.memories || []).filter(m => !ids.includes(m.id))); addToast(`Deleted ${ids.length} memory item(s)`, 'success'); };
  const handleUpdateMemory = (id: string, newSummary: string) => { if (!formData) return; handleChange('memories', (formData.memories || []).map(m => m.id === id ? { ...m, summary: newSummary } : m)); addToast('Memory updated', 'success'); };

  /**
   * Force re-summarize a given date: read the raw chat log (ignoring hideBeforeMessageId), have the
   * LLM summarize it, then upsert the same-date 'archive' MemoryFragment ('palace' auto-archived ones
   * are left untouched, so both coexist).
   * This is the automated fallback path: even after the 4.5 log has already been processed+hidden+
   * vectorized by the Palace, the user can still have the AI re-read the raw 4.5 chat for a manual summary.
   */
  /**
   * @param overridePromptId the template id the user picked on the spot in MemoryArchivist's
   *                        re-summarize modal; falls back to the current selectedPromptId if not provided
   */
  const handleForceArchiveDate = async (dateStr: string, overridePromptId?: string): Promise<void> => {
      if (!apiConfig.apiKey || !formData) { addToast('Please configure an API Key first', 'error'); return; }
      const targetId = formData.id;
      try {
          const allMsgs = await DB.getMessagesByCharId(targetId, true);
          // Ignore hideBeforeMessageId — this is the whole point of the forced re-summarize
          const dayMsgs = allMsgs.filter(m => {
              const d = new Date(m.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              return key === dateStr;
          });
          if (dayMsgs.length === 0) { addToast(`No messages on ${dateStr} to summarize`, 'info'); return; }

          const timeFmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          const rawLog = dayMsgs
              .map(m => formatMessageWithTime(m, formData.name, userProfile.name, timeFmt))
              .join('\n');

          // Template priority: override (picked on the spot in the modal) → current state → default preset
          const effectivePromptId = overridePromptId || selectedPromptId;
          const templateObj = archivePrompts.find(p => p.id === effectivePromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
          const baseContext = ContextBuilder.buildCoreContext(formData, userProfile);
          let prompt = baseContext + '\n\n' + templateObj.content;
          prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
          prompt = prompt.replace(/\$\{char\.name\}/g, formData.name);
          prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
          prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

          const data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 8000, stream: false }),
          }, 0);
          let summary = extractContent(data).replace(/^["']|["']$/g, '');
          if (!summary) throw new Error('Empty response');

          // upsert: same-date mood='archive' entries get replaced; 'palace' auto-archived entries are untouched
          const existing = formData.memories || [];
          const kept = existing.filter(m => !(m.date === dateStr && (m.mood === 'archive' || !m.mood)));
          const newFrag: MemoryFragment = {
              id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              date: dateStr,
              summary,
              mood: 'archive',
          };

          if (editingIdRef.current === targetId) {
              handleChange('memories', [...kept, newFrag]);
          } else {
              // User switched characters — write straight back to the target character
              const currentMems = characters.find(c => c.id === targetId)?.memories || [];
              const curKept = currentMems.filter(m => !(m.date === dateStr && (m.mood === 'archive' || !m.mood)));
              updateCharacter(targetId, { memories: [...curKept, newFrag] });
          }
          addToast(`${dateStr} force-resummarized`, 'success');
      } catch (e: any) {
          addToast(`Re-summarize failed: ${e.message || 'Unknown error'}`, 'error');
      }
  };

  // NEW: Core Memory Handlers
  const handleUpdateRefinedMemory = (year: string, month: string, newContent: string) => {
      if (!formData) return;
      const key = `${year}-${month}`;
      handleChange('refinedMemories', { ...(formData.refinedMemories || {}), [key]: newContent });
      addToast('Core memory updated', 'success');
  };

  const handleDeleteRefinedMemory = (year: string, month: string) => {
      if (!formData || !formData.refinedMemories) return;
      const key = `${year}-${month}`;
      const newRefined = { ...formData.refinedMemories };
      delete newRefined[key];
      handleChange('refinedMemories', newRefined);
      addToast('Core memory deleted', 'success');
  };

  const handleExportPreview = () => { if (!formData) return; const mems = formData.memories as any[]; if (!mems || mems.length === 0) { addToast('No memory data to export yet', 'info'); return; } const sortedMemories = [...mems].sort((a, b) => a.date.localeCompare(b.date)); let text = `[Character Profile]\nName: ${formData.name}\nExported: ${new Date().toLocaleString()}\n\n`; if (formData.refinedMemories) { text += `=== Core Memories ===\n`; Object.entries(formData.refinedMemories).sort().forEach(([k, v]) => { text += `[${k}]: ${v}\n`; }); text += `\n=== Detailed Log ===\n`; } let currentYear = '', currentMonth = ''; sortedMemories.forEach(mem => { const match = mem.date.match(/(\d{4})[-/年](\d{1,2})/); if (match) { const y = match[1], m = match[2]; if (y !== currentYear) { text += `\n[ ${y} ]\n`; currentYear = y; currentMonth = ''; } if (m !== currentMonth) { text += `\n-- Month ${parseInt(m)} --\n\n`; currentMonth = m; } } text += `${mem.date} ${mem.mood ? `(#${mem.mood})` : ''}\n${mem.summary}\n\n--------------------------\n\n`; }); setExportText(text); setShowExportModal(true); navigator.clipboard.writeText(text).then(() => addToast('Content auto-copied to clipboard', 'info')).catch(() => {}); };
  const handleExportMemoryFile = async () => {
      if (!exportText) return;
      try {
          const result = await shareOrDownloadFile({
              content: exportText,
              fileName: `${formData?.name || 'character'}_memories.txt`,
              mimeType: 'text/plain;charset=utf-8',
              shareTitle: 'Memory Archive',
          });
          addToast(result === 'shared' ? 'Memory archive share panel opened' : 'Memory archive exported', 'success');
      } catch (error) {
          console.error('Memory export failed', error);
          addToast('File export failed, please copy the text directly', 'error');
      }
  };

  const handleImportMemories = async () => {
      if (!importText.trim() || !apiConfig.apiKey) { addToast('Please check the input content or API settings', 'error'); return; }
      if (!formData) return;
      if (importLengthInfo.overLimit) {
          const message = getExternalMemoryOverLimitMessage(importText);
          setImportStatus(message);
          addToast(`Content exceeds 50,000 characters, suggest importing in ${importLengthInfo.suggestedBatches} batches`, 'error');
          return;
      }

      const targetId = formData.id; // LOCK ID
      setIsProcessingMemory(true);
      setImportStatus('Preparing cleanup: organizing time and structure only, not compressing content...');
      trackEvent('Run Memory Import Cleanup');
      
      try { 
          const result = await extractExternalMemoryText(
              importText,
              targetId,
              formData.name,
              userProfile.name,
              {
                  baseUrl: apiConfig.baseUrl,
                  apiKey: apiConfig.apiKey,
                  model: apiConfig.model,
              },
              stage => setImportStatus(stage),
          );
          const failedBatch = result.batches.find(batch => !batch.ok);
          if (failedBatch) {
              throw new Error(
                  `Batch ${failedBatch.index}/${failedBatch.total} failed lossless cleanup: ${failedBatch.error || 'integrity check failed'}. No memories were written this time`,
              );
          }
          if (result.memories.length === 0) {
              throw new Error('No importable memories were extracted');
          }

          const pad2 = (value: number) => String(value).padStart(2, '0');
          const newMems: MemoryFragment[] = result.memories.map(memory => {
              const date = new Date(memory.createdAt);
              return {
                  id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
                  // content is the full, faithfully-cleaned event — not re-condensed into a short summary again.
                  summary: memory.content,
                  mood: memory.mood || 'Record',
              };
          });
          if (editingIdRef.current === targetId) {
              handleChange('memories', [...(formData.memories || []), ...newMems]);
              setShowImportModal(false);
              setImportText('');
              addToast(`Successfully imported ${newMems.length} memory item(s)`, 'success');
          } else {
              // Background update
              const currentMems = characters.find(c => c.id === targetId)?.memories || [];
              updateCharacter(targetId, { memories: [...currentMems, ...newMems] });
              addToast(`Background task complete: saved ${newMems.length} imported memory item(s)`, 'success');
          }
      } catch (e: any) { setImportStatus(`Error: ${e.message || 'Unknown error'}`); addToast('Memory cleanup failed', 'error'); } finally { setIsProcessingMemory(false); }
  };
  
  const handleBatchSummarize = async () => {
        if (!apiConfig.apiKey || !formData) return;
        
        const targetId = formData.id; // LOCK ID
        setIsBatchProcessing(true);
        setBatchProgress('Initializing...');
        trackEvent('Run Batch Memory Summarization');
        
        try {
            const msgs = await DB.getMessagesByCharId(targetId, true);
            const validMsgs = msgs.filter(m => !formData.hideBeforeMessageId || m.id >= formData.hideBeforeMessageId);
            const msgsByDate: Record<string, any[]> = {};
            
            msgs.forEach(m => {
                const d = new Date(m.timestamp);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                if (batchRange.start && dateStr < batchRange.start) return;
                if (batchRange.end && dateStr > batchRange.end) return;
                
                if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
                msgsByDate[dateStr].push(m);
            });

            const dates = Object.keys(msgsByDate).sort();
            const newMemories: MemoryFragment[] = [];

            await injectMemoryPalace(formData);
            const baseContext = ContextBuilder.buildCoreContext(formData, userProfile);

            for (let i = 0; i < dates.length; i++) {
                const date = dates[i];
                setBatchProgress(`Processing ${date} (${i+1}/${dates.length})`);
                
                const dayMsgs = msgsByDate[date];
                const timeFmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, formData.name, userProfile.name, timeFmt))
                    .join('\n');

                // Use selected template (same as ChatApp) with variable substitution
                const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
                let prompt = baseContext + '\n\n' + templateObj.content;
                prompt = prompt.replace(/\$\{dateStr\}/g, date);
                prompt = prompt.replace(/\$\{char\.name\}/g, formData.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                let data: any = null;
                try {
                    data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{ role: "user", content: prompt }],
                            max_tokens: 8000,
                            temperature: 0.5
                        })
                    }, 0);
                } catch {
                    // Soft-skip a single failed day and continue with later dates (matches the original if(response.ok) semantics)
                }

                if (data) {
                    let summary = extractContent(data);
                    summary = summary.replace(/^["']|["']$/g, '').trim();

                    if (summary) {
                        newMemories.push({
                            id: `mem-${Date.now()}-${Math.random()}`,
                            date: date,
                            summary: summary,
                            mood: 'auto'
                        });
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const totalDays = dates.length;
            const okCount = newMemories.length;
            const toastLevel: 'success' | 'info' | 'error' =
                okCount === 0 ? 'error' : okCount < totalDays ? 'info' : 'success';
            const toastMsg = okCount === 0
                ? `Batch summarization failed: no memories were generated for any of the ${totalDays} day(s) (check API/model)`
                : okCount < totalDays
                    ? `Batch summarization complete: ${okCount}/${totalDays} day(s) succeeded (some failed)`
                    : `Batch summarization complete: generated ${okCount} memory item(s)`;

            if (editingIdRef.current === targetId) {
                if (okCount > 0) handleChange('memories', [...(formData.memories || []), ...newMemories]);
                setBatchProgress('Done!');
                setTimeout(() => {
                    setIsBatchProcessing(false);
                    setShowBatchModal(false);
                    addToast(toastMsg, toastLevel);
                }, 1000);
            } else {
                // Background update
                if (okCount > 0) {
                    const currentMems = characters.find(c => c.id === targetId)?.memories || [];
                    updateCharacter(targetId, { memories: [...currentMems, ...newMemories] });
                }
                setIsBatchProcessing(false);
                setShowBatchModal(false);
                addToast(`${formData.name}: ${toastMsg}`, toastLevel);
            }

        } catch (e: any) {
            setBatchProgress(`Error: ${e.message}`);
            setIsBatchProcessing(false);
            setShowBatchModal(false);
            addToast(`Batch summarization failed: ${e.message}`, 'error');
        }
    };

  const handleGenerateImpression = async (type: 'initial' | 'update') => {
      if (!formData || !apiConfig.apiKey) {
          addToast('Please configure an API Key first', 'error');
          return;
      }

      const targetId = formData.id; // LOCK ID
      setIsGeneratingImpression(true);
      trackEvent('Generate Character Impression', { type });
      try {
          const charName = formData.name;
          const boundUser = userProfile;

          // Build the full character context (persona, worldview, user profile, refined memories, and other macro-level info)
          await injectMemoryPalace(formData);
          const fullContext = ContextBuilder.buildCoreContext(formData, userProfile);

          let messagesToAnalyze = "";

          // Layer 1: full context — the foundation for macro personality analysis
          messagesToAnalyze += `\n[Full Character Context (Full Context - foundation for macro analysis)]:\n${fullContext}\n`;

          // Layer 2: recent chats — used only to detect recent changes
          // The memory portion is already included in buildCoreContext (refined monthly summaries +
          // detailed memories for activated months), identical to what the character sees during chat,
          // so it isn't fetched separately here.
          // In reset mode the number of recent chats is greatly reduced, to avoid recency bias
          const recentMsgs = await DB.getRecentMessagesByCharId(targetId, type === 'initial' ? 15 : 50);
          const msgText = recentMsgs
              .map(m => formatMessageForPrompt(m, charName, boundUser.name))
              .join('\n');

          if (msgText) messagesToAnalyze += `\n[Recent Chats - used only to detect recent changes]:\n${msgText}\n`;

          // Don't pass the old impression on reset, to avoid the model anchoring on old content
          const normalizedCurrentImpression = normalizeUserImpression(formData.impression);
          const currentProfileJSON = (type === 'initial') ? "null" : (normalizedCurrentImpression ? JSON.stringify(normalizedCurrentImpression, null, 2) : "null");
          const isInitialGeneration = type === 'initial' || !normalizedCurrentImpression;

          const summaryInstruction = isInitialGeneration
              ? "In one paragraph (under 100 words), summarize your [overall macro impression] of them. Don't limit yourself to recent conversations — define what kind of person they fundamentally are, and what they mean to you. Must be written in the first person."
              : "Based on the old summary, combined with new findings, update your [overall macro impression] of them. Maintain long-term-perspective continuity — unless a major turning point has occurred, don't completely overturn your judgment of their fundamental nature just because of a bit of recent small talk. Must be written in the first person.";

          const listInstruction = isInitialGeneration ? `"Item 1", "Item 2"` : `"Keep old item", "New item"`;
          const changesInstruction = isInitialGeneration ? "" : `"Describe change 1", "Describe change 2"`;

          const prompt = `
Current profile (your past observations)
\`\`\`json
${currentProfileJSON}
\`\`\`
${messagesToAnalyze}

[Important: Tone and Perspective]
You [are] "${charName}". This profile is your [private notebook].
Therefore, every summary-type field (such as \`core_values\`, \`summary\`, \`emotion_summary\`, etc.) [must] be written from your own first-person ("I") perspective.

[Core Instructions: Data Tiers and Weighting]
1. **Full Character Context**: This is your [most important analytical foundation]. It contains your persona, worldview, user profile, and the whole of your memory (monthly core summaries + detailed memories for activated months). Your judgment of their core personality, core values, interaction patterns, and personality traits must be based primarily on this macro-level data spanning the full timeline. You must treat early memories and recent memories [equally], distilling personality traits from the complete arc of the whole relationship.
2. **Recent Chats**: This [only] represents a snapshot of their current state. Its role is [strictly limited] to updating the two fields [behavior_profile.emotion_summary] and [observed_changes]. Unless a major event has occurred (such as a values conflict or life turning point), [absolutely do not] change your judgment of their fundamental personality just because of emotional fluctuations in the last few chats.
${isInitialGeneration ? `
[Reset Mode Special Instructions - CRITICAL]
This is a [complete reset] — you need to rebuild your full understanding of them from scratch, based on all available macro-level data.
- Your analysis must cover the [full time span] from the earliest memory to the most recent
- Early memories and recent memories carry [equal weight] — don't give a memory more influence just because it happened more recently
- personality_core, value_map, and emotion_schema must reflect the stable traits they've shown [across the whole relationship], not just their recent state
- If their behavior differs between early and recent memories, record that evolution in observed_changes, but personality_core should reflect the most persistent, stable traits
` : ''}
[Bad Examples - Strictly Forbidden]
- Do NOT summarize "they're a person who likes discussing XX topic" based only on recent chats — that mistakes a recent topic for a personality trait
- Do NOT let personality_core.summary contain time-limited phrases like "recently" or "these past few days" — summary should be a macro-level summary spanning all memories
- Correct approach: base personality_core on the full context and long-term memory; base observed_changes on a comparison between recent chats and the long-term impression

Analysis Instructions: Five-Dimension Profile Update (First-Person Perspective)
Following the [mandatory comparison protocol] and your own perspective, analyze the new messages and ${isInitialGeneration ? '[generate]' : '[incrementally update]'} the following JSON structure.

Output JSON structure v3.0 (follow strictly — do not wrap in a markdown code block, return raw JSON directly)
{
  "version": 3.0,
  "lastUpdated": ${Date.now()},
  "value_map": {
    "likes": [${listInstruction}],
    "dislikes": [${listInstruction}],
    "core_values": "..."
  },
  "behavior_profile": {
    "tone_style": "...",
    "emotion_summary": "...",
    "response_patterns": "..."
  },
  "emotion_schema": {
    "triggers": { 
        "positive": [${listInstruction}],
        "negative": [${listInstruction}]
    },
    "comfort_zone": "...",
    "stress_signals": [${listInstruction}]
  },
  "personality_core": {
    "observed_traits": [${listInstruction}],
    "interaction_style": "...",
    "summary": "..."
  },
  "mbti_analysis": {
    "type": "XXXX",
    "reasoning": "...",
    "dimensions": {
        "e_i": 50,
        "s_n": 50,
        "t_f": 50,
        "j_p": 50
    }
  },
  "observed_changes": [
    ${changesInstruction}
  ]
}
Note: each item in observed_changes must be a plain string, e.g. ["became more cheerful lately", "started proactively sharing daily life"]. Object formats like {"period": "...", "description": "..."} are strictly forbidden.`;

          const data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({
                  model: apiConfig.model,
                  messages: [{ role: "user", content: prompt }],
                  max_tokens: 8000,
                  temperature: 0.5,
                  // Kept consistent with "Settings → API → Streaming Output" — not forcibly overridden inside the impression feature.
                  // Streamed responses are stitched back into a full object by safeResponseJson, so extractContent downstream needs no changes.
                  stream: apiConfig.stream === true
              })
          }, 0);
          let content = extractContent(data);

          content = content.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = normalizeUserImpression(JSON.parse(content));
          if (!parsed) throw new Error('Impression generation result is incomplete');

          if (editingIdRef.current === targetId) {
              handleChange('impression', parsed);
              addToast(isInitialGeneration ? 'Impression profile generated' : 'Impression profile updated', 'success');
          } else {
              updateCharacter(targetId, { impression: parsed });
              addToast('Background task complete: impression updated on the original character', 'success');
          }

      } catch (e: any) {
          console.error(e);
          addToast(`Generation failed: ${e.message}`, 'error');
      } finally {
          setIsGeneratingImpression(false);
      }
  };

  // Actually performs the deletion. For a character with amsg2 tasks under its name, deleteCharacter
  // first awaits cloud cleanup — if that fails it returns cloud-cleanup-failed and doesn't delete
  // locally → routes into the "Retry / Delete Anyway" modal;
  // force=true means the user picked "Delete Anyway" in that modal, allowing local deletion through.
  const runDeleteCharacter = async (targetId: string, force = false) => {
      setIsDeleting(true);
      try {
          const result = await deleteCharacter(targetId, force ? { force: true } : undefined);
          if (result.status === 'cloud-cleanup-failed') {
              setDeleteConfirmTarget(null);
              setCloudCleanupFailTarget(targetId);
              return;
          }
          setDeleteConfirmTarget(null);
          setCloudCleanupFailTarget(null);
          addToast('Connection disconnected', 'success');
      } finally {
          setIsDeleting(false);
      }
  };

  const confirmDeleteCharacter = () => {
      if (deleteConfirmTarget && !isDeleting) {
          void runDeleteCharacter(deleteConfirmTarget);
      }
  };

  const handleExportCard = async () => {
      if (!formData) return;
      
      const {
          id, memories, refinedMemories, activeMemoryMonths, impression, guidebookInsights,
          ...rest
      } = formData;

      // Only export the "character" itself: credentials / styling / language preference / runtime
      // state are all stripped — the card must never bundle the exporter's own private fields like
      // API keys. See utils/characterCard.ts for the full list.
      const cardProps = stripSensitiveCardFields(rest);

      const exportData: CharacterExportData = {
          ...cardProps,
          version: 1,
          type: 'sully_character_card'
      };

      // Plaintext-key check + confirmation before export: normally reports "safe to share"; if a key
      // is unexpectedly detected, export is aborted with a prompt to report it.
      if (!(await confirmExportSafety(exportData))) return;

      // Images on the character (chibi sprites, date skin sets) are stored as tokens that only this
      // device recognizes — exporting them as-is would just hand the recipient a dead string with no
      // image. So first, on a deep copy, swap the tokens back for embedded data URLs
      // (resolveBlobRefsDeep mutates in place, so it must never be fed formData directly — that would
      // wipe out the user's own character images).
      const portableData: CharacterExportData =
          typeof structuredClone === 'function'
              ? structuredClone(exportData)
              : JSON.parse(JSON.stringify(exportData));
      try {
          await resolveBlobRefsDeep(portableData);
      } catch {
          addToast('Export failed: could not read the images on this character', 'error');
          return;
      }

      trackEvent('Export Character Card');

      const json = JSON.stringify(portableData, null, 2);
      const fileName = `${formData.name || 'Character'}_Card.json`;

      const result = await shareOrDownloadFile({
          content: json,
          fileName,
          mimeType: 'application/json;charset=utf-8',
          shareTitle: 'Export Character Card',
      });
      addToast(result === 'shared' ? 'Character card share panel opened' : 'Character card generated and exported', 'success');
  };

  const handleImportCard = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (ev) => {
          try {
              const json = ev.target?.result as string;
              const data: CharacterExportData = JSON.parse(json);
              
              if (data.type !== 'sully_character_card') {
                  throw new Error('Invalid character card file');
              }

              // The import side strips credentials / styling / language / runtime state the same
              // way: even if the sender handed over an old-format card that bundled private fields
              // like an API key, none of that gets written into your local character — your own key /
              // theme / language preference won't be overwritten by the sender's. See utils/characterCard.ts for the full list.
              const safeData = stripSensitiveCardFields(data);

              // Sync mounted worldbooks into the global worldbook app so they
              // appear under their original category (or the character's name
              // as a sensible fallback when the card has no category set).
              const incomingMounted = (data.mountedWorldbooks || []).map(wb => ({ ...wb }));
              const fallbackCategory = `${data.name || 'Imported Character'}'s Worldbook`;
              let importedWbCount = 0;
              for (const wb of incomingMounted) {
                  if (!wb.id || worldbooks.some(existing => existing.id === wb.id)) continue;
                  const category = wb.category && wb.category.trim() ? wb.category : fallbackCategory;
                  wb.category = category;
                  await addWorldbook({
                      ...wb,
                      id: wb.id,
                      title: wb.title || 'Untitled Entry',
                      content: wb.content || '',
                      category,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                  });
                  importedWbCount++;
              }

              const newChar: CharacterProfile = {
                  ...safeData,
                  id: `char-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  memories: [],
                  refinedMemories: {},
                  activeMemoryMonths: [],
                  mountedWorldbooks: incomingMounted,
              } as CharacterProfile;

              await DB.saveCharacter(newChar);
              trackEvent('Import Character Card');
              // Don't call addCharacter() — it isn't a "refresh," it genuinely creates a new blank
              // "New Character" and writes it to DB, which would leave an extra blank card after reload.
              // The imported character is already saved to DB (line above); on reload OSContext will
              // re-read every character from DB, so the imported one shows up naturally — no manual state refresh needed.
              setTimeout(() => window.location.reload(), 500);

              const wbToastSuffix = importedWbCount > 0 ? `, and synced ${importedWbCount} worldbook(s)` : '';
              addToast(`Character ${newChar.name} imported successfully${wbToastSuffix}`, 'success');

          } catch (err: any) {
              console.error(err);
              addToast(err.message || 'Import failed', 'error');
          } finally {
              if (cardImportRef.current) cardImportRef.current.value = '';
          }
      };
      reader.readAsText(file);
  };

  return (
    <div className="h-full w-full bg-slate-50/30 font-light relative">
       {view === 'list' ? (
           <div className="flex flex-col h-full animate-fade-in relative"
                style={{ background: 'linear-gradient(180deg, #f5f2fb 0%, #ece6f6 100%)' }}>
               {/* safe-area: pt uses max(3.5rem, notch height) — keeps breathing room while not getting blocked on taller-notch devices */}
               <div className="px-6 pb-4 shrink-0 flex items-start justify-between" style={{ paddingTop: 'max(3.5rem, var(--safe-top))' }}>
                   <div className="relative">
                       <span className="absolute -top-3 -left-2 text-violet-300 text-xs select-none">✦</span>
                       <span className="absolute -top-1 left-9 text-violet-200 text-[10px] select-none">✦</span>
                       <h1 className="text-[30px] font-serif font-bold tracking-wide leading-tight text-slate-800">Neural Link</h1>
                       <p className="text-xs text-violet-400/90 mt-2">Established <span className="font-bold text-violet-500">{characters.length}</span> character connection(s)</p>
                   </div>
                   <div className="flex gap-3 pt-1">
                        <ToolButton label="Groups" title="Character Group Management" onClick={() => { setShowGroupModal(true); trackEvent('Open Character Group Management Modal'); }}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                            </svg>
                        </ToolButton>
                        <ToolButton label="Import" title="Import Character Card" onClick={() => cardImportRef.current?.click()}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                            </svg>
                        </ToolButton>
                        <ToolButton label="Close" title="Close" onClick={closeApp}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        </ToolButton>
                        <input type="file" ref={cardImportRef} className="hidden" accept=".json" onChange={handleImportCard} />
                   </div>
               </div>
               <div className="flex-1 overflow-y-auto px-5 pb-20 no-scrollbar flex flex-col gap-3">
                   {(() => {
                       // If groups exist → collapse/expand by group (no more pagination, since grouping already shortens the list);
                       // If no groups exist yet → keep the original paginated list, unchanged.
                       if (characterGroups.length > 0) {
                           const knownGroupIds = new Set(characterGroups.map(g => g.id));
                           const sections = [
                               ...sortCharacterGroups(characterGroups).map(g => ({
                                   id: g.id,
                                   name: g.name,
                                   chars: characters.filter(c => c.groupId === g.id),
                               })),
                               {
                                   id: GROUP_FILTER_UNGROUPED,
                                   name: 'Ungrouped',
                                   // Characters whose groupId points to a deleted group also land here — they don't just vanish
                                   chars: characters.filter(c => !c.groupId || !knownGroupIds.has(c.groupId)),
                               },
                           ].filter(s => s.id !== GROUP_FILTER_UNGROUPED || s.chars.length > 0);
                           return (
                               <>
                                   {sections.map(section => {
                                       const expanded = expandedGroups.includes(section.id);
                                       return (
                                           <div key={section.id} className="shrink-0">
                                               {/* Group bar: clean rounded white card, collapse arrow + group name + count pill on the left, ">" indicator on the right */}
                                               <button onClick={() => toggleGroupExpanded(section.id)}
                                                   className={`w-full h-14 flex items-center gap-3 px-5 rounded-2xl bg-white border transition-colors active:scale-[0.99] ${expanded ? 'border-violet-200' : 'border-slate-100 hover:border-violet-200'} shadow-[0_2px_10px_rgba(140,120,200,0.07)]`}>
                                                   <svg viewBox="0 0 12 12" className={`w-3 h-3 text-violet-400 transition-transform ${expanded ? '' : '-rotate-90'}`}>
                                                       <path d="M2 4l4 5 4-5z" fill="currentColor" />
                                                   </svg>
                                                   <span className="text-base font-bold text-slate-700 tracking-wide truncate">{section.name}</span>
                                                   <span className="min-w-[26px] px-2 py-0.5 rounded-full bg-violet-100/70 text-[12px] text-violet-500 text-center font-medium tabular-nums">{section.chars.length}</span>
                                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-4 h-4 ml-auto text-slate-300 transition-transform ${expanded ? 'rotate-90' : ''}`}><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                               </button>
                                               {expanded && (
                                                   <div className="flex flex-col gap-3 mt-3">
                                                       {section.chars.map(char => (
                                                           <CharacterCard
                                                               key={char.id}
                                                               char={char}
                                                               active={char.id === activeCharacterId}
                                                               onClick={() => { setEditingId(char.id); setView('detail'); }}
                                                               onDelete={(e) => {
                                                                   e.stopPropagation();
                                                                   setDeleteConfirmTarget(char.id);
                                                               }}
                                                           />
                                                       ))}
                                                       {section.chars.length === 0 && (
                                                           <div className="text-xs text-violet-300 px-3 pb-1">Empty group — assign one on a character's "Identity" page</div>
                                                       )}
                                                   </div>
                                               )}
                                           </div>
                                       );
                                   })}
                                   <button onClick={handleAddCharacter} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2 shrink-0">
                                       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>New Link
                                   </button>
                               </>
                           );
                       }
                       const PAGE_SIZE = 6;
                       const totalPages = Math.max(1, Math.ceil(characters.length / PAGE_SIZE));
                       const page = Math.min(charPage, totalPages - 1);
                       const pageChars = characters.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
                       return (
                           <>
                               {pageChars.map(char => (
                                   <CharacterCard
                                       key={char.id}
                                       char={char}
                                       active={char.id === activeCharacterId}
                                       onClick={() => { setEditingId(char.id); setView('detail'); }}
                                       onDelete={(e) => {
                                           e.stopPropagation();
                                           setDeleteConfirmTarget(char.id);
                                       }}
                                   />
                               ))}
                               <button onClick={handleAddCharacter} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2 shrink-0">
                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>New Link
                               </button>
                               {totalPages > 1 && (
                                   <div className="flex items-center justify-center gap-3 pt-2 shrink-0">
                                       <button onClick={() => setCharPage(Math.max(0, page - 1))} disabled={page === 0}
                                           className="w-9 h-9 rounded-full bg-white/70 border border-violet-100 shadow-sm flex items-center justify-center text-violet-400 disabled:opacity-30 active:scale-90 transition-all">
                                           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                                       </button>
                                       <span className="text-sm text-violet-500 font-medium tabular-nums min-w-[40px] text-center">{page + 1}/{totalPages}</span>
                                       <button onClick={() => setCharPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
                                           className="w-9 h-9 rounded-full bg-white/70 border border-violet-100 shadow-sm flex items-center justify-center text-violet-400 disabled:opacity-30 active:scale-90 transition-all">
                                           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                       </button>
                                   </div>
                               )}
                           </>
                       );
                   })()}
               </div>
           </div>
       ) : formData && (
           <div className="flex flex-col h-full animate-fade-in bg-slate-50/50 relative">
               {/* safe-area: OUTER keeps the gradient background + blur + sticky, with paddingTop yielding room for
                   the notch height; INNER no longer bottoms out at h-32 — that was the old "tall bar + bottom-anchored
                   content" status-bar-reservation approach, which stacks with safe-top into one big blank block.
                   Changed to natural content height, sitting directly below safe-top. */}
               {/* Top bar paddingTop uses max(2.75rem, safe-top) as a floor: in environments where --safe-top is 0
                   (no notch / some WebViews), it still reserves status-bar height so "List/Send Message" doesn't
                   sit flush against the status bar. Matches the list page and every other detail top-bar convention
                   in the project (max(rem, var(--safe-top))). */}
               <div className="bg-gradient-to-b from-white/90 to-transparent backdrop-blur-sm shrink-0 z-40 sticky top-0" style={{ paddingTop: 'max(2.75rem, var(--safe-top))' }}>
                 <div className="flex flex-col px-5 pt-2 pb-2">
                   <div className="flex justify-between items-center mb-3">
                       <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-white/60 flex items-center gap-1 text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg><span className="text-sm font-medium">List</span></button>
                       <button onClick={() => { setActiveCharacterId(formData.id); openApp(AppID.Chat); }} className="text-xs px-3 py-1.5 bg-primary text-white rounded-full font-bold shadow-sm shadow-primary/30 flex items-center gap-1 active:scale-95 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926H16.5a.75.75 0 0 1 0 1.5H3.693l-1.414 4.926a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.155.75.75 0 0 0 0-1.114A28.897 28.897 0 0 0 3.105 2.288Z" /></svg>Send Message</button>
                   </div>
                   <div className="flex gap-6 text-sm font-medium text-slate-400 pl-1">
                       <button onClick={() => { setDetailTab('identity'); trackEvent('Switch Character Detail Tab', { tab: 'identity' }); }} className={`pb-2 transition-colors relative ${detailTab === 'identity' ? 'text-slate-800' : ''}`}>Identity{detailTab === 'identity' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('memory'); trackEvent('Switch Character Detail Tab', { tab: 'memory' }); }} className={`pb-2 transition-colors relative ${detailTab === 'memory' ? 'text-slate-800' : ''}`}>Memory ({(formData.memories || []).length}){detailTab === 'memory' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('impression'); trackEvent('Switch Character Detail Tab', { tab: 'impression' }); }} className={`pb-2 transition-colors relative ${detailTab === 'impression' ? 'text-slate-800' : ''}`}>Impression{detailTab === 'impression' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('plates'); trackEvent('Switch Character Detail Tab', { tab: 'plates' }); }} className={`pb-2 transition-colors relative ${detailTab === 'plates' ? 'text-slate-800' : ''}`}>Plates{detailTab === 'plates' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('chibi'); trackEvent('Switch Character Detail Tab', { tab: 'chibi' }); }} className={`pb-2 transition-colors relative ${detailTab === 'chibi' ? 'text-slate-800' : ''}`}>Figures{detailTab === 'chibi' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                   </div>
                 </div>
               </div>
               <div className="flex-1 overflow-y-auto p-5 no-scrollbar pb-10">
                   {detailTab === 'identity' && (
                       <div className="space-y-6 animate-fade-in">
                           <div className="flex items-center gap-5">
                               <div className="relative group cursor-pointer w-24 h-24 shrink-0" onClick={() => fileInputRef.current?.click()}>
                                   <div className="w-full h-full rounded-[2rem] shadow-md bg-white border-4 border-white overflow-hidden relative"><TokenImg value={formData.avatar} className={`w-full h-full object-cover ${isCompressing ? 'opacity-50 blur-sm' : ''}`} alt="A" /></div>
                                   <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} />
                               </div>
                               <div className="flex-1 space-y-3">
                                   <input value={formData.name} onChange={(e) => handleChange('name', e.target.value)} className="w-full bg-transparent py-1 text-xl font-medium text-slate-800 border-b border-slate-200" placeholder="Name" />
                                   <input value={formData.description} onChange={(e) => handleChange('description', e.target.value)} className="w-full bg-transparent py-1 text-sm text-slate-500 border-b border-slate-200" placeholder="Description" />
                                   {/* Avatar URL entry: sits alongside the file upload on the left. Goes through a draft ->
                                       commit-on-blur/Enter flow, to avoid every <img> referencing char.avatar firing off
                                       requests for an incomplete URL while typing. An https URL gets sent to the worker as
                                       the Instant Push notification icon; a local upload (data URL) only displays locally
                                       and never enters the push payload (data: URLs are rejected by 0.6+). */}
                                   <input
                                       type="url"
                                       value={avatarUrlDraft}
                                       onChange={(e) => setAvatarUrlDraft(e.target.value)}
                                       onBlur={() => {
                                           const v = avatarUrlDraft.trim();
                                           // Empty draft splits into two cases:
                                           //  - current avatar is an https URL: user cleared it = wants to remove this URL, commit '' to clear the avatar
                                           //  - current avatar is a data URL / emoji / empty: input was already empty, do nothing (avoid accidentally clearing an uploaded image)
                                           if (!v) {
                                               if (/^https?:\/\//i.test(formData.avatar || '')) {
                                                   handleChange('avatar', '');
                                                   addToast('Avatar URL removed', 'info');
                                               }
                                               return;
                                           }
                                           try {
                                               const u = new URL(v);
                                               if (!/^https?:$/.test(u.protocol)) throw new Error();
                                           } catch {
                                               addToast('Please enter a valid http(s) image link', 'error');
                                               return;
                                           }
                                           if (v !== formData.avatar) {
                                               handleChange('avatar', v);
                                               addToast('Avatar URL saved', 'success');
                                           }
                                       }}
                                       onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                       placeholder="Or paste an image URL (press Enter to confirm)"
                                       className="w-full bg-transparent py-1 text-xs text-slate-400 border-b border-slate-200 placeholder:text-slate-300"
                                   />
                               </div>
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">Group</label>
                               <div className="flex gap-2 items-center">
                                   <select
                                       value={formData.groupId && characterGroups.some(g => g.id === formData.groupId) ? formData.groupId : ''}
                                       onChange={e => handleChange('groupId', e.target.value || undefined)}
                                       className="flex-1 bg-white rounded-2xl px-4 py-2.5 text-sm text-slate-700 shadow-sm focus:ring-1 focus:ring-primary/20 outline-none appearance-none"
                                   >
                                       <option value="">Ungrouped</option>
                                       {sortCharacterGroups(characterGroups).map(g => (
                                           <option key={g.id} value={g.id}>{g.name}</option>
                                       ))}
                                   </select>
                                   {detailGroupDraft === null ? (
                                       <button onClick={() => setDetailGroupDraft('')} className="px-3 py-2.5 rounded-2xl bg-white text-xs text-slate-500 shadow-sm active:scale-95 transition-transform shrink-0">+ New</button>
                                   ) : (
                                       <input
                                           autoFocus
                                           value={detailGroupDraft}
                                           onChange={e => setDetailGroupDraft(e.target.value)}
                                           onBlur={async () => {
                                               const name = detailGroupDraft.trim();
                                               setDetailGroupDraft(null);
                                               if (!name) return;
                                               const existing = characterGroups.find(g => g.name === name);
                                               // A group with the same name is assigned directly, not re-created
                                               const group = existing || await createCharacterGroup(name);
                                               if (group) handleChange('groupId', group.id);
                                           }}
                                           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                           placeholder="Group name, press Enter to confirm"
                                           className="w-36 px-3 py-2.5 rounded-2xl bg-white text-xs text-slate-700 shadow-sm outline-none focus:ring-1 focus:ring-primary/20 shrink-0"
                                       />
                                   )}
                               </div>
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">Core Instructions (System Prompt)</label>
                               <textarea value={formData.systemPrompt} onChange={(e) => handleChange('systemPrompt', e.target.value)} className="w-full h-40 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll" placeholder="Persona..." />
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">Worldview / Additional Lore (Worldview & Lore)</label>
                               <textarea
                                    value={formData.worldview || ''}
                                    onChange={(e) => handleChange('worldview', e.target.value)}
                                    className="w-full h-24 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                                    placeholder="In this world, magic is real..."
                                />
                           </div>

                           {/* Time Awareness & Timezone: three independent toggles that can be combined freely (chat time awareness / custom timezone / offline time awareness) */}
                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
                               <div>
                                   <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">Time Awareness & Timezone</label>
                                   <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">The three toggles below are independent and can be combined freely. Changes take effect immediately (starting from the next reply).</p>
                               </div>

                               {/* 1. Chat · Time Awareness Boost */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">Chat · Time Awareness Boost</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">On by default. When on, the character remembers how long it's been since you last talked and leans toward real elapsed time; turning it off weakens that sense.</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('timeAwarenessEnabled', formData.timeAwarenessEnabled === false)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.timeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.timeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>

                               {/* 2. Custom Timezone (long-distance relationships etc.) */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">Custom Timezone</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">Off by default (follows this device). When on, the character lives in their own timezone, keeping their own daily schedule and knowing there's a time difference with you — good for long-distance relationships or a character living abroad.</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('customTimezoneEnabled', !formData.customTimezoneEnabled)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.customTimezoneEnabled ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.customTimezoneEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                                   {formData.customTimezoneEnabled && (
                                       <select
                                           value={formData.customTimezone || ''}
                                           onChange={(e) => handleChange('customTimezone', e.target.value)}
                                           className="mt-3 w-full bg-slate-50 rounded-2xl px-3 py-2.5 text-xs border border-slate-200 outline-none focus:ring-1 focus:ring-primary/30"
                                       >
                                           <option value="">Select the character's timezone...</option>
                                           {COMMON_TIMEZONES.map(tz => (
                                               <option key={tz.id} value={tz.id}>{tz.label}</option>
                                           ))}
                                       </select>
                                   )}
                               </div>

                               {/* 3. Offline Time Awareness (Date app) */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">Offline Time Awareness (Date)</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">On by default. During a Date, the story follows real-world time. Turning it off decouples the story from real time — better suited to a purely fictional setting.</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('dateTimeAwarenessEnabled', formData.dateTimeAwarenessEnabled === false ? undefined : false)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.dateTimeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.dateTimeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>
                           </div>

                           {/* Life Record Injection: master toggle + 4 module-level toggles (data is maintained in the Profile app's "Life Record" section) */}
                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
                               <div>
                                   <label className="text-[10px] font-bold text-rose-500 uppercase tracking-widest block">Life Record Injection</label>
                                   <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">Injects your Period / Pharmacy / Ledger / Exercise entries from "Profile → Life Record" into this character as subconscious background context; when you explicitly mention a related fact, they can also log it for you on the spot (a card appears in chat that you can confirm or dismiss).</p>
                               </div>

                               {/* Master toggle */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">Master Toggle</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">Off by default. When off, no life record content is injected at all — the character isn't even taught how to log entries on your behalf.</p>
                                       </div>
                                       <button
                                           onClick={() => { handleChange('lifeRecordEnabled', !formData.lifeRecordEnabled); trackEvent('Enable Character Life Record Injection', { state: formData.lifeRecordEnabled ? 'off' : 'on' }); }}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.lifeRecordEnabled ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.lifeRecordEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>

                               {/* Module toggles (all grayed out together when the master toggle is off) */}
                               <div className={`border-t border-slate-100 pt-3 space-y-3 ${formData.lifeRecordEnabled ? '' : 'opacity-40 pointer-events-none'}`}>
                                   {([
                                       ['lifeRecordPeriodEnabled', 'period', 'Period', "Cycle status / prediction + logging 'started / ended' on your behalf"],
                                       ['lifeRecordMedEnabled', 'med', 'Pharmacy', "Today's medication schedule and check-ins + logging 'took xx medicine' on your behalf"],
                                       ['lifeRecordExpenseEnabled', 'expense', 'Ledger', "Today's spending (linked with the Bank app) + logging 'spent xx' on your behalf"],
                                       ['lifeRecordExerciseEnabled', 'exercise', 'Exercise', "Today's / this week's exercise + logging 'did xx exercise' on your behalf"],
                                   ] as const).filter(([, moduleKey]) => !hiddenLifeModules.includes(moduleKey)).map(([field, , label, desc]) => (
                                       <div key={field} className="flex items-center justify-between gap-3">
                                           <div className="min-w-0">
                                               <p className="text-xs font-bold text-slate-700">{label}</p>
                                               <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{desc}</p>
                                           </div>
                                           <button
                                               onClick={() => handleChange(field, formData[field] === false)}
                                               className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData[field] !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                           >
                                               <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData[field] !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                           </button>
                                       </div>
                                   ))}
                               </div>
                           </div>

                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3">
                               <div className="flex items-center justify-between">
                                   <label className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest flex items-center gap-1"><SpeakerHigh size={12} /> Character Voice</label>
                                   <div className="flex gap-1.5">
                                       <button
                                           onClick={() => { setActiveCharacterId(formData.id); openApp(AppID.VoiceDesigner); }}
                                           className="text-[10px] bg-violet-50 text-violet-700 px-2 py-1 rounded font-bold hover:bg-violet-100 flex items-center gap-0.5"
                                       >
                                           <SlidersHorizontal size={10} weight="bold" /> Design Voice
                                       </button>
                                       <button
                                           onClick={handleLoadMiniMaxVoices}
                                           className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold hover:bg-emerald-100 disabled:opacity-60"
                                           disabled={isLoadingVoices}
                                       >
                                           {isLoadingVoices ? 'Fetching...' : 'Fetch Available Voices'}
                                       </button>
                                   </div>
                               </div>
                               <p className="text-[11px] text-slate-500">If you already have a voice_id you can fill it in directly, no lookup needed. Once configured on the chat character, it can be read directly by TTS later.</p>

                               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-2">
                                   <div className="flex items-center justify-between gap-2">
                                       <span className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">MiniMax Synthesis Parameters</span>
                                       <span className="text-[9px] text-slate-400">Existing characters default to Classic</span>
                                   </div>
                                   <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/80 p-1">
                                       {([
                                           ['legacy', 'Classic Parameters'],
                                           ['natural-v2', 'New Natural Parameters'],
                                       ] as const).map(([version, label]) => {
                                           const activeVersion = formData.voiceProfile?.minimaxParamVersion === 'natural-v2' ? 'natural-v2' : 'legacy';
                                           return (
                                               <button
                                                   key={version}
                                                   type="button"
                                                   onClick={() => handleChange('voiceProfile', {
                                                       ...(formData.voiceProfile || {}),
                                                       minimaxParamVersion: version,
                                                   })}
                                                   className={`rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors ${activeVersion === version ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-400'}`}
                                               >
                                                   {label}
                                               </button>
                                           );
                                       })}
                                   </div>
                                   <p className="text-[10px] text-slate-400 leading-relaxed">
                                       {formData.voiceProfile?.minimaxParamVersion === 'natural-v2'
                                           ? "Aligned with the Design Voice preview and Chat/Date/Call parameters, preserving the model's native prosody — no longer auto-inserting a pause at every punctuation mark."
                                           : 'Keeps the existing auto-pause, parameter clamping, and dynamic-emotion-priority rules — historical results are unchanged.'}
                                   </p>
                               </div>

                               <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                   <input
                                       value={formData.voiceProfile?.voiceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           provider: 'minimax',
                                           voiceId: e.target.value,
                                           voiceName: formData.voiceProfile?.voiceName || '',
                                           source: formData.voiceProfile?.source || 'custom',
                                           model: formData.voiceProfile?.model || 'speech-2.8-hd',
                                           notes: formData.voiceProfile?.notes || '',
                                       })}
                                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="voice_id (paste directly)"
                                   />
                                   <input
                                       value={formData.voiceProfile?.model || 'speech-2.8-hd'}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           provider: 'minimax',
                                           voiceId: formData.voiceProfile?.voiceId || '',
                                           voiceName: formData.voiceProfile?.voiceName || '',
                                           source: formData.voiceProfile?.source || 'custom',
                                           model: e.target.value,
                                           notes: formData.voiceProfile?.notes || '',
                                       })}
                                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="TTS model (default speech-2.8-hd)"
                                   />
                               </div>

                               {/* Fish Audio voice: only takes effect when the global voice provider is switched to Fish Audio (Settings → Other APIs) */}
                               <div className="rounded-2xl border border-sky-200/60 bg-sky-50/40 p-2.5 space-y-1.5">
                                   <div className="text-[10px] font-bold text-sky-600 uppercase tracking-widest">Fish Audio Voice</div>
                                   <input
                                       value={formData.voiceProfile?.fishReferenceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           fishReferenceId: e.target.value,
                                       })}
                                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="Paste a reference_id or the full fish.audio link"
                                   />
                                   <p className="text-[10px] text-slate-400">After picking a voice on fish.audio, paste either that page's link (including ?modelId=...) or the 32-character id — either is auto-detected. Once "Fish Audio" is selected as the voice in Settings, this character will use it for synthesis; it's stored separately from the MiniMax voice_id above.</p>
                               </div>

                               {/* ElevenLabs voice: saved per-character; the Settings page only handles the Key / model. */}
                               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-1.5">
                                   <div className="flex items-center justify-between gap-2">
                                       <div className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">ElevenLabs Voice</div>
                                       <button
                                           type="button"
                                           onClick={() => void handleTestElevenLabsVoice()}
                                           disabled={isTestingElevenLabsVoice}
                                           className="text-[10px] rounded-lg border border-violet-200 bg-white px-2 py-1 font-bold text-violet-600 disabled:opacity-50"
                                       >
                                           {isTestingElevenLabsVoice ? 'Previewing...' : 'Preview'}
                                       </button>
                                   </div>
                                   <input
                                       value={formData.voiceProfile?.elevenLabsVoiceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           elevenLabsVoiceId: e.target.value,
                                       })}
                                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="Paste a Voice ID or the ElevenLabs voice page link"
                                   />
                                   <p className="text-[10px] text-slate-400">Copy a Voice ID from ElevenLabs Voices / Voice Library, or paste the page link containing voiceId directly. Used once ElevenLabs is selected as the voice in Settings; stored separately from the MiniMax and Fish Audio voices.</p>
                               </div>

                               {/* Speed: voiceProfile.speed is shared across all three TTS providers */}
                               <div className="space-y-1 pt-1">
                                   <div className="flex items-center justify-between">
                                       <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Speed</label>
                                       <span className="text-[11px] font-mono text-slate-500">{(formData.voiceProfile?.speed ?? 1).toFixed(2)}×</span>
                                   </div>
                                   <input
                                       type="range"
                                       min={0.5}
                                       max={1.5}
                                       step={0.05}
                                       value={formData.voiceProfile?.speed ?? 1}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           speed: parseFloat(e.target.value),
                                       })}
                                       className="w-full accent-primary"
                                   />
                                   <p className="text-[10px] text-slate-400">Lower is slower, more like a gentle, unhurried narration. 1.0 is normal; if it feels rushed, try 0.85-0.95. MiniMax, Fish Audio, and ElevenLabs all share this character's speed setting.</p>
                               </div>

                               {(voiceOptions.system.length + voiceOptions.voice_cloning.length + voiceOptions.voice_generation.length) > 0 && (
                                   <div className="space-y-2 pt-1">
                                       {([
                                           ['system', 'System Voices'],
                                           ['voice_cloning', 'Cloned Voices'],
                                           ['voice_generation', 'Generated Voices'],
                                       ] as const).map(([source, label]) => {
                                           const list = voiceOptions[source];
                                           if (!list.length) return null;
                                           return (
                                               <div key={source}>
                                                   <div className="text-[10px] text-slate-400 mb-1">{label}</div>
                                                   <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                                                       {list.slice(0, 50).map((v) => (
                                                           <button
                                                               key={`${source}-${v.voice_id}`}
                                                               onClick={() => applyVoiceToCharacter(v, source)}
                                                               className="w-full text-left px-2 py-1 rounded-xl text-xs border border-slate-200 hover:border-emerald-200 hover:bg-emerald-50/40"
                                                           >
                                                               <div className="font-medium text-slate-700 truncate">{v.voice_name || 'Unnamed Voice'}</div>
                                                               <div className="text-[10px] text-slate-400 truncate">{v.voice_id}</div>
                                                           </button>
                                                       ))}
                                                   </div>
                                               </div>
                                           );
                                       })}
                                   </div>
                               )}
                           </div>

                           {/* Worldbook Section */}
                           <div>
                               <div className="flex justify-between items-center mb-2 px-1">
                                   <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block flex items-center gap-1"><Books size={12} /> Extended Lore (Worldbooks)</label>
                                   <button onClick={openWorldbookModal} className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100">+ Mount</button>
                                </div>
                                <div className="space-y-2">
                                   {formData.mountedWorldbooks && formData.mountedWorldbooks.length > 0 ? (
                                       formData.mountedWorldbooks.map(wb => (
                                           <div key={wb.id} className="flex items-center justify-between bg-white px-4 py-3 rounded-2xl border border-indigo-50 shadow-sm group">
                                               <div className="flex items-center gap-2 min-w-0">
                                                   <BookOpen size={20} className="shrink-0 text-indigo-400" />
                                                   <div className="flex flex-col min-w-0">
                                                       <span className="text-sm font-bold text-slate-700 truncate">{wb.title}</span>
                                                       {wb.category && <span className="text-[9px] text-slate-400">{wb.category}</span>}
                                                   </div>
                                               </div>
                                               <button onClick={() => unmountWorldbook(wb.id)} className="text-slate-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1 ml-2">×</button>
                                           </div>
                                       ))
                                   ) : (
                                       <div className="text-center py-4 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-xs">
                                           No worldbooks mounted yet
                                       </div>
                                   )}
                               </div>
                           </div>

                           {/* Export Card Button */}
                           <div className="pt-4">
                               <button
                                   onClick={handleExportCard}
                                   className="w-full py-4 bg-slate-800 text-white rounded-2xl text-xs font-bold shadow-lg flex items-center justify-center gap-2 hover:bg-slate-700 active:scale-95 transition-all"
                               >
                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                                       <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
                                   </svg>
                                   Share / Export Character Card
                               </button>
                               <p className="text-[10px] text-slate-400 text-center mt-2">Exported content does not include the memory store or chat history</p>
                           </div>
                       </div>
                   )}

                   {detailTab === 'memory' && (
                       <div className="space-y-4 animate-fade-in">
                           <div className="flex justify-center gap-2 mb-4">
                               <button onClick={() => { setShowBatchModal(true); trackEvent('Open Batch Memory Summarization Modal'); }} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">Batch Summarize (date range optional)</button>
                               <button onClick={() => setShowImportModal(true)} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">Import/Cleanup</button>
                               <button onClick={handleExportPreview} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">Backup</button>
                           </div>
                           <MemoryArchivist
                               memories={formData.memories || []}
                               refinedMemories={formData.refinedMemories || {}}
                               activeMemoryMonths={formData.activeMemoryMonths || []}
                               charName={formData.name || ''}
                               userName={userProfile.name}
                               onRefine={handleRefineMonth}
                               onDeleteMemories={handleDeleteMemories}
                               onUpdateMemory={handleUpdateMemory}
                               onToggleActiveMonth={handleToggleActiveMonth}
                               onUpdateRefinedMemory={handleUpdateRefinedMemory}
                               onDeleteRefinedMemory={handleDeleteRefinedMemory}
                               onForceArchiveDate={handleForceArchiveDate}
                               forceArchiveTemplates={archivePrompts}
                               forceArchiveDefaultPromptId={selectedPromptId}
                           />
                       </div>
                   )}

                   {detailTab === 'impression' && (
                       <ImpressionPanel
                           impression={formData.impression}
                           isGenerating={isGeneratingImpression}
                           onGenerate={handleGenerateImpression}
                           onUpdateImpression={(newImp) => handleChange('impression', newImp)}
                           onDelete={() => handleChange('impression', undefined)}
                       />
                   )}

                   {detailTab === 'chibi' && formData.id && (
                       <ChibiShelfPanel charId={formData.id} onOpen={() => { setShowChibiStudio(true); trackEvent('Open QQ Character Workshop'); }} />
                   )}

                   {detailTab === 'plates' && formData.id && (
                       <RoomPlatePanel charId={formData.id} userName={userProfile.name} />
                   )}
               </div>
           </div>
       )}
       
       {/* QQ Character Workshop: writes straight to the DB (sprites / vrState / specialMomentRecords / chibiStudio);
           on close, pull the latest character data back into formData — otherwise later edits would auto-save
           a stale copy and overwrite the workshop's results */}
       {showChibiStudio && formData && (
           <ChibiStudio
               charId={formData.id}
               onClose={() => {
                   setShowChibiStudio(false);
                   const latest = characters.find(c => c.id === formData.id);
                   if (latest) setFormData(latest);
               }}
           />
       )}

       {/* Modals ... */}
       <Modal isOpen={showImportModal} title="Memory Import/Cleanup" onClose={() => setShowImportModal(false)} footer={<><button onClick={() => setShowImportModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">Cancel</button><button onClick={handleImportMemories} disabled={isProcessingMemory || importLengthInfo.overLimit} className={`flex-1 py-3 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2 ${importLengthInfo.overLimit ? 'bg-slate-300 cursor-not-allowed shadow-none' : 'bg-primary shadow-primary/30'}`}>{isProcessingMemory && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>}{isProcessingMemory ? 'Processing...' : importLengthInfo.overLimit ? 'Please batch first' : 'Start'}</button></>}>
           <div className="space-y-3">
               <div className="text-xs text-slate-400 leading-relaxed bg-slate-50 p-3 rounded-xl border border-slate-100">
                   Good for "moving house" from another app. Up to 50,000 characters, counted locally only; the AI only organizes time and event structure — it doesn't summarize, merge, or omit original detail. Content under 50,000 characters is auto-batched, no need to split manually.
               </div>
               {importStatus && <div className="text-xs text-primary font-medium">{importStatus}</div>}
               <textarea
                   value={importText}
                   onChange={e => setImportText(e.target.value)}
                   placeholder="Paste memory text brought over from elsewhere here..."
                   className="w-full h-40 bg-slate-100 border-none rounded-2xl px-4 py-3 text-sm text-slate-700 resize-none focus:ring-2 focus:ring-primary/20 transition-all"
               />
               {importLengthInfo.overLimit && (
                   <div className="text-xs leading-relaxed rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-700">
                       {getExternalMemoryOverLimitMessage(importText)}
                   </div>
               )}
               <div className={`text-right text-[10px] ${importLengthInfo.overLimit ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                   {importLengthInfo.count.toLocaleString()} / {EXTERNAL_MEMORY_MAX_CHARS.toLocaleString()} characters (counted locally)
               </div>
           </div>
       </Modal>

       <Modal isOpen={showBatchModal} title="Batch Memory Summarization" onClose={() => { setShowBatchModal(false); setShowPromptEditor(false); }} footer={
           isBatchProcessing ?
           <div className="w-full py-3 bg-slate-100 text-primary font-bold rounded-2xl text-center flex items-center justify-center gap-2"><div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>{batchProgress}</div> :
           <button onClick={handleBatchSummarize} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Start Generating</button>
       }>
           <div className="space-y-3">
               <p className="text-xs text-slate-400">Walks through all chat history and generates a memory summary per day using the selected prompt template.</p>
               {/* Prompt Selection */}
               <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-100">
                   <label className="text-[10px] font-bold text-indigo-400 uppercase mb-2 block">Select Prompt Template</label>
                   <div className="flex flex-col gap-2">
                       {archivePrompts.map(p => (
                           <div key={p.id} onClick={() => { setSelectedPromptId(p.id); localStorage.setItem('chat_active_archive_prompt_id', p.id); }} className={`p-2.5 rounded-lg border cursor-pointer flex items-center justify-between ${selectedPromptId === p.id ? 'bg-white border-indigo-500 shadow-sm ring-1 ring-indigo-500' : 'bg-white/50 border-indigo-200 hover:bg-white'}`}>
                               <span className={`text-xs font-bold ${selectedPromptId === p.id ? 'text-indigo-700' : 'text-slate-600'}`}>{p.name}</span>
                               <div className="flex gap-1.5">
                                   <button onClick={(e) => { e.stopPropagation(); setEditingPrompt(p); setShowPromptEditor(true); }} className="text-[10px] text-slate-400 hover:text-indigo-500 px-2 py-0.5 rounded bg-slate-100 hover:bg-indigo-50">View</button>
                                   {!p.id.startsWith('preset_') && (
                                       <button onClick={(e) => { e.stopPropagation(); const next = archivePrompts.filter(ap => ap.id !== p.id); setArchivePrompts(next); localStorage.setItem('chat_archive_prompts', JSON.stringify(next.filter(ap => !ap.id.startsWith('preset_')))); if (selectedPromptId === p.id) setSelectedPromptId('preset_rational'); }} className="text-[10px] text-red-300 hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-red-50">x</button>
                                   )}
                               </div>
                           </div>
                       ))}
                   </div>
                   <button onClick={() => { const newP = { id: `custom_${Date.now()}`, name: 'New Custom Template', content: DEFAULT_ARCHIVE_PROMPTS[0].content }; setEditingPrompt(newP); setShowPromptEditor(true); }} className="mt-2 w-full py-1.5 text-xs font-bold text-indigo-500 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-100">+ New Custom Prompt</button>
               </div>
               {/* Date Range */}
               <div className="flex gap-2">
                   <div className="flex-1"><label className="text-[10px] uppercase text-slate-400 font-bold">Start Date (optional)</label><input type="date" value={batchRange.start} onChange={e => setBatchRange({...batchRange, start: e.target.value})} className="w-full bg-slate-100 rounded-xl px-3 py-2 text-xs" /></div>
                   <div className="flex-1"><label className="text-[10px] uppercase text-slate-400 font-bold">End Date (optional)</label><input type="date" value={batchRange.end} onChange={e => setBatchRange({...batchRange, end: e.target.value})} className="w-full bg-slate-100 rounded-xl px-3 py-2 text-xs" /></div>
               </div>
               <div className="text-[10px] text-slate-400 bg-slate-50 p-2.5 rounded-xl leading-relaxed">
                   Supported variables: <code>{'${dateStr}'}</code>, <code>{'${char.name}'}</code>, <code>{'${userProfile.name}'}</code>, <code>{'${rawLog}'}</code>
               </div>
           </div>
       </Modal>

       {/* Prompt Editor Modal */}
       <Modal isOpen={showPromptEditor} title="Edit Prompt" onClose={() => setShowPromptEditor(false)} footer={<button onClick={() => {
           if (!editingPrompt) return;
           const isNew = !archivePrompts.some(p => p.id === editingPrompt.id);
           const next = isNew ? [...archivePrompts, editingPrompt] : archivePrompts.map(p => p.id === editingPrompt.id ? editingPrompt : p);
           setArchivePrompts(next);
           setSelectedPromptId(editingPrompt.id);
           localStorage.setItem('chat_archive_prompts', JSON.stringify(next.filter(p => !p.id.startsWith('preset_'))));
           localStorage.setItem('chat_active_archive_prompt_id', editingPrompt.id);
           setShowPromptEditor(false);
           addToast('Prompt saved', 'success');
       }} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Save</button>}>
           <div className="space-y-3">
               <input
                   value={editingPrompt?.name || ''}
                   onChange={e => setEditingPrompt(prev => prev ? {...prev, name: e.target.value} : null)}
                   placeholder="Preset Name"
                   className="w-full px-4 py-2 bg-slate-100 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                   readOnly={editingPrompt?.id.startsWith('preset_')}
               />
               <textarea
                   value={editingPrompt?.content || ''}
                   onChange={e => setEditingPrompt(prev => prev ? {...prev, content: e.target.value} : null)}
                   className="w-full h-64 bg-slate-100 rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 leading-relaxed"
                   placeholder="Enter prompt content..."
                   readOnly={editingPrompt?.id.startsWith('preset_')}
               />
               {editingPrompt?.id.startsWith('preset_') && (
                   <p className="text-[10px] text-slate-400 text-center">Preset templates cannot be edited (view only)</p>
               )}
           </div>
       </Modal>

       <Modal isOpen={showExportModal} title="Export Text" onClose={() => setShowExportModal(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => { navigator.clipboard.writeText(exportText); addToast('Copied', 'success'); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Copy Full Text</button><button onClick={handleExportMemoryFile} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" /></svg>Export File</button></div>}>
           <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100 space-y-2"><div className="text-[10px] text-slate-400">Auto-copied to clipboard. If sharing fails, please copy it manually.</div><textarea value={exportText} readOnly className="w-full h-40 bg-transparent border-none text-[10px] font-mono text-slate-600 resize-none focus:ring-0 leading-relaxed select-all" onClick={(e) => e.currentTarget.select()}/></div>
       </Modal>

        {/* Worldbook Select Modal */}
        <Modal
            isOpen={showWorldbookModal}
            title="Mount Worldbook"
            onClose={() => setShowWorldbookModal(false)}
        >
            <div className="max-h-[50vh] overflow-y-auto no-scrollbar space-y-3 p-1">
                {worldbooks.length === 0 ? (
                    <div className="text-center text-slate-400 text-xs py-8">
                        No worldbooks yet — create one in the [Worldbook] App on the home screen.
                    </div>
                ) : (
                    <>
                        <input
                            value={wbModalSearch}
                            onChange={e => setWbModalSearch(e.target.value)}
                            placeholder="Search worldbook titles or categories..."
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 outline-none focus:bg-white focus:border-indigo-300 transition-all"
                        />
                        {wbModalSearchResults ? (
                            // Search state: flat results list
                            <div className="space-y-2">
                                {wbModalSearchResults.books.length === 0 ? (
                                    <div className="text-center text-slate-400 text-xs py-6">No matching worldbooks.</div>
                                ) : (
                                    wbModalSearchResults.books.map(wb => {
                                        const isMounted = formData?.mountedWorldbooks?.some(m => m.id === wb.id);
                                        return (
                                            <button
                                                key={wb.id}
                                                onClick={() => !isMounted && mountWorldbook(wb.id)}
                                                disabled={isMounted}
                                                className={`w-full p-3 rounded-xl border text-left transition-all ${isMounted ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed' : 'bg-white border-indigo-100 hover:border-indigo-300 shadow-sm active:scale-95'}`}
                                            >
                                                <div className="flex justify-between items-center gap-2">
                                                    <span className="font-bold text-slate-700 text-sm truncate">{wb.title}</span>
                                                    {isMounted && <span className="text-[10px] text-slate-400 shrink-0">Mounted</span>}
                                                </div>
                                                <div className="text-[10px] text-slate-400 truncate mt-0.5">{wb.category || 'Uncategorized (General)'}</div>
                                            </button>
                                        );
                                    })
                                )}
                                {wbModalSearchResults.total > wbModalSearchResults.books.length && (
                                    <div className="text-center text-[10px] text-slate-400 py-1">
                                        {wbModalSearchResults.total} match(es) total, showing only the first {wbModalSearchResults.books.length} — keep typing to narrow the results.
                                    </div>
                                )}
                            </div>
                        ) : (
                            // Default state: category accordion, only rendering entries of an expanded category
                            wbModalGroups.map(([category, books]) => {
                                const isExpanded = wbModalExpandedCategory === category;
                                return (
                                    <div key={category} className="rounded-xl border border-slate-100 bg-slate-50/50 overflow-hidden">
                                        <div
                                            onClick={() => setWbModalExpandedCategory(isExpanded ? null : category)}
                                            className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                                        >
                                            <span className={`transition-transform duration-200 text-slate-400 ${isExpanded ? 'rotate-90' : ''}`}>
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                                            </span>
                                            <h4 className="flex-1 min-w-0 text-xs font-bold text-slate-500 truncate">{category}</h4>
                                            <span className="text-[10px] text-slate-400 shrink-0">{books.length}</span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); mountCategory(category); }}
                                                className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded font-bold hover:bg-indigo-100 shrink-0"
                                            >
                                                Mount Group
                                            </button>
                                        </div>
                                        {isExpanded && (
                                            <div className="px-2 pb-2 space-y-2">
                                                {books.map(wb => {
                                                    const isMounted = formData?.mountedWorldbooks?.some(m => m.id === wb.id);
                                                    return (
                                                        <button
                                                            key={wb.id}
                                                            onClick={() => !isMounted && mountWorldbook(wb.id)}
                                                            disabled={isMounted}
                                                            className={`w-full p-3 rounded-xl border text-left transition-all ${isMounted ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed' : 'bg-white border-indigo-100 hover:border-indigo-300 shadow-sm active:scale-95'}`}
                                                        >
                                                            <div className="flex justify-between items-center gap-2">
                                                                <span className="font-bold text-slate-700 text-sm truncate">{wb.title}</span>
                                                                {isMounted && <span className="text-[10px] text-slate-400 shrink-0">Mounted</span>}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </>
                )}
            </div>
        </Modal>

        {/* Character Group Management */}
        <Modal isOpen={showGroupModal} title="Character Group Management" onClose={() => { setShowGroupModal(false); setNewGroupName(''); }}>
            <div className="space-y-3">
                <div className="flex gap-2">
                    <input
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddGroup(); }}
                        placeholder="New group name"
                        className="flex-1 px-4 py-2.5 bg-slate-100 rounded-xl text-sm text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <button onClick={handleAddGroup} className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl shadow-sm shadow-primary/30 active:scale-95 transition-transform shrink-0">Add</button>
                </div>
                {characterGroups.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-6">No groups yet. Create one — the character list and every character picker will show them grouped.</div>
                ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto no-scrollbar">
                        {sortCharacterGroups(characterGroups).map(g => (
                            <div key={g.id} className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                                <input
                                    defaultValue={g.name}
                                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== g.name) renameCharacterGroup(g.id, v); else e.target.value = g.name; }}
                                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    className="flex-1 min-w-0 bg-transparent text-sm text-slate-700 outline-none border-b border-transparent focus:border-slate-300 py-0.5"
                                />
                                <span className="text-xs text-slate-400 tabular-nums shrink-0">{characters.filter(c => c.groupId === g.id).length} character(s)</span>
                                <button
                                    onClick={() => { deleteCharacterGroup(g.id); addToast(`Group "${g.name}" deleted — its characters moved back to Ungrouped`, 'info'); }}
                                    className="p-1.5 rounded-full text-slate-300 hover:bg-red-50 hover:text-red-400 transition-all shrink-0"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-50 p-2.5 rounded-xl">Deleting a group does not delete its characters — they move back to "Ungrouped". To assign a character to a group, go to that character's "Identity" page.</p>
            </div>
        </Modal>

        <Modal
            isOpen={!!deleteConfirmTarget}
            title="Disconnect"
            onClose={() => setDeleteConfirmTarget(null)}
            footer={<div className="flex gap-2 w-full"><button onClick={() => setDeleteConfirmTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">Keep</button><button onClick={confirmDeleteCharacter} disabled={isDeleting} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 disabled:opacity-50">{isDeleting ? 'Disconnecting...' : 'Confirm Disconnect'}</button></div>}
        >
            <div className="flex flex-col items-center gap-3 py-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>
                <p className="text-sm text-slate-600 text-center leading-relaxed">
                    Are you sure you want to delete every connection with this character?<br/>
                    <span className="text-xs text-red-400 font-bold">This cannot be undone — all memories will be wiped.</span><br/>
                    <span className="text-[10px] text-slate-400">Emotion categories visible only to them will also be deleted.</span>
                </p>
            </div>
        </Modal>

        {/* When cloud amsg2 tasks aren't fully cleared, deletion gets blocked (otherwise a deleted
            character's push notifications could still show up later) — this offers a retry or a
            forced-through option. */}
        <Modal
            isOpen={!!cloudCleanupFailTarget}
            title="Cloud Tasks Still Pending"
            onClose={() => setCloudCleanupFailTarget(null)}
            footer={<div className="flex gap-2 w-full">
                <button
                    onClick={() => { if (cloudCleanupFailTarget && !isDeleting) void runDeleteCharacter(cloudCleanupFailTarget); }}
                    disabled={isDeleting}
                    className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-2xl font-bold disabled:opacity-50"
                >{isDeleting ? 'Retrying...' : 'Retry'}</button>
                <button
                    onClick={() => { if (cloudCleanupFailTarget && !isDeleting) void runDeleteCharacter(cloudCleanupFailTarget, true); }}
                    disabled={isDeleting}
                    className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 disabled:opacity-50"
                >Delete Anyway</button>
            </div>}
        >
            <p className="text-sm text-slate-600 leading-relaxed py-2">
                Some Proactive Message 2.0 tasks under this character couldn't be canceled in the cloud (possibly a network drop or the Worker not responding) — the character has not been deleted.<br/>
                <span className="text-xs text-red-400 font-bold">If you choose "Delete Anyway," leftover tasks may still push notifications later</span>
                <span className="text-xs text-slate-400"> — you can fall back on "Clear Cloud State" in Settings when that happens.</span>
            </p>
        </Modal>
    </div>
  );
};
export default Character;
