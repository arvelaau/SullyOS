import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneEvidence, PhoneCustomApp, PhoneContact, PhoneSimLog, ConvTopic, AiSession, AiServiceKind, TavernCard, APIConfig } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { safeResponseJson, extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import {
    runRealConversation, runNpcConversation, upsertContact, matchRealChar,
    clampAffinity, normName, flipTranscript, parseTranscript, serializeTurns, appendLearned,
    topicText, summarizeConversation,
} from '../utils/relationshipChat';
import PersonaSim, { LifeLog, generatePersonaScript } from './PersonaSim';
import { usePersonaSim, personaSimStore } from '../utils/personaSimStore';
import { getLastInnerState } from '../utils/emotionApply';
import { trackEvent } from '../utils/analytics';
import { normalizePhoneEvidence, phoneFieldToText } from '../utils/phoneEvidence';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getCheckPhoneApi, resolveCheckPhoneApi, setCheckPhoneApi } from '../utils/checkPhoneApi';
import {
    User, Phone, ChatCircleDots, ChatCircle, ShoppingBag, Hamburger, Compass, GearSix,
    Plus, SignOut, CaretLeft, CaretRight, Cloud, ImagesSquare, LockSimple, Package,
    Storefront, Heart, ArrowsClockwise, Tray, DotsThree, ClockCounterClockwise, Sparkle,
    UsersThree, UserPlus, Prohibit, LinkSimple, PaperPlaneTilt, PencilSimple, Trash,
    Robot, Brain, MaskHappy, Question, PaintBrush
} from '@phosphor-icons/react';

type LayoutId = NonNullable<PhoneCustomApp['layout']>;

const APP_LAYOUTS: { id: LayoutId; name: string; desc: string; icon: string }[] = [
    { id: 'generic', name: 'Generic Card', desc: 'Title + content feed', icon: '🗂️' },
    { id: 'shop', name: 'Shop Style', desc: 'Item / price / status', icon: '🛍️' },
    { id: 'feed', name: 'Social Feed', desc: 'Avatar / body / likes', icon: '💬' },
    { id: 'forum', name: 'Forum Style', desc: 'Post / floor / replies', icon: '📋' },
    { id: 'novel', name: 'Novel Style', desc: 'Chapter / prose reading', icon: '📖' },
];

// Agent App: the three kinds of AI services the character themselves uses
const AI_SERVICES: { id: AiServiceKind; name: string; tagline: string; accent: string }[] = [
    { id: 'assistant', name: 'AI Assistant', tagline: 'Utility · asks about everything, search history doubles as a diary', accent: '#34d399' },
    { id: 'claude', name: 'Deep Talk', tagline: 'Confidant · the things never said to your face, all here', accent: '#a78bfa' },
    { id: 'tavern', name: 'Tavern', tagline: 'Role-play · they craft their own cards and act them out with AI', accent: '#fb7185' },
];

// Long-session auto-summary for the agent (TRPG-style): summarize once this many "lines" pile up
const AI_SUMMARY_THRESHOLD = 100;
// Keep this many recent lines uncollapsed after summarizing, for narrative continuity
const AI_KEEP_RECENT = 12;

// Stereotypes / catchphrases for each AI vendor — injected into the generation & continuation prompts so the peeked-at AI replies have "that flavor"
const AI_VENDOR_LORE = `Stereotypes + catchphrases for each AI vendor (each session sticks to one vendor; "对方:" should really lean into that vendor's flavor, not read like a generic neutral assistant):
- Doubao: gushing, over-the-top flattery, maxes out the emotional support, loves calling you "baby"/"fam", loves piling on emoji; will confidently make things up to go along with you / never blushes when wrong, always compliments you before getting to business.
- Gemini: opens with "extremely / rather / very", bullet-points everything, information-dense but wordy, keeps saying "As a large language model…", throws in a pile of "please note" disclaimers.
- Claude: gentle, insightful, actually good at the real work (polishing / analysis / writing all reliable, genuinely tries to help); somewhat guarded at first, occasionally "Sorry, I can't…" / "I understand how you feel, but…" — empathizes first then gently declines — but **doesn't just keep deflecting**: the longer the conversation goes, the more it opens up and the less it deflects, and it will generally follow through on legitimate requests.
- ChatGPT / GPT: cool, objective, formulaic, "Here are a few suggestions: 1… 2… 3…", likes to close with "Hope this helps!", polite but distant.
- ERNIE Bot / Qwen / Kimi and other domestic models: official and cautious, likes to stay upbeat, on sensitive topics defaults to "consult a professional", safety first.`;

// ===== "Skin" for each AI vendor: re-theme colors/logo/bubbles by vendor while peeking at a chat =====
const GeminiMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <defs>
            <linearGradient id="cp-gemini" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4285F4" />
                <stop offset="50%" stopColor="#9B72CB" />
                <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
        </defs>
        <path d="M12 2c.45 5 3 7.55 8 8-5 .45-7.55 3-8 8-.45-5-3-7.55-8-8 5-.45 7.55-3 8-8z" fill="url(#cp-gemini)" />
    </svg>
);
const ClaudeMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="#C9683E">
        {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x="11.25" y="1.5" width="1.5" height="8.5" rx="0.75" transform={`rotate(${i * 30} 12 12)`} />
        ))}
    </svg>
);
const VendorMark: React.FC<{ vkey: string; label: string; accent: string; size?: number }> = ({ vkey, label, accent, size = 18 }) => {
    if (vkey === 'gemini') return <GeminiMark size={size} />;
    if (vkey === 'claude') return <ClaudeMark size={size} />;
    return <span style={{ color: accent, fontSize: Math.round(size * 0.78), fontWeight: 800, lineHeight: 1 }}>{(label || 'A').slice(0, 1)}</span>;
};

type VendorTheme = {
    key: string; label: string; dark: boolean; bg: string;
    text: string; sub: string; accent: string;
    userBg: string; userText: string; aiBg: string; aiText: string; font?: string;
};

const matchVendor = (raw: string): string => {
    const n = (raw || '').toLowerCase();
    if (/豆包|doubao/.test(n)) return 'doubao';
    if (/gemini|双子|bard|谷歌/.test(n)) return 'gemini';
    if (/claude|克劳德|克劳迪|anthropic/.test(n)) return 'claude';
    if (/gpt|openai|chatgpt|查特/.test(n)) return 'gpt';
    if (/文心|一言|ernie|百度/.test(n)) return 'wenxin';
    if (/通义|千问|qwen|阿里/.test(n)) return 'qwen';
    if (/kimi|moonshot|月之暗面/.test(n)) return 'kimi';
    if (/deepseek|深度求索/.test(n)) return 'deepseek';
    return 'generic';
};

// Vendor skin for the peeked session (the claude service always gets the Claude skin, tavern uses its own dark tavern skin)
const getVendorTheme = (name: string, service: AiServiceKind): VendorTheme => {
    if (service === 'tavern') return { key: 'tavern', label: name || 'Tavern', dark: true,
        bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185',
        userBg: 'linear-gradient(135deg,#fb7185,#fb7185bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.92)',
        font: "'Shippori Mincho','Noto Serif SC',serif" };
    const v = service === 'claude' ? 'claude' : matchVendor(name);
    switch (v) {
        case 'gemini': return { key: 'gemini', label: 'Gemini', dark: false,
            bg: 'linear-gradient(180deg,#ffffff,#f6f8fd)', text: '#1f1f1f', sub: '#5f6368', accent: '#1a73e8',
            userBg: 'linear-gradient(135deg,#4285F4,#9b72cb)', userText: '#fff', aiBg: '#f0f4f9', aiText: '#1f1f1f',
            font: "'Google Sans','Noto Sans SC',sans-serif" };
        case 'claude': return { key: 'claude', label: service === 'claude' ? (name || 'Claude') : 'Claude', dark: false,
            bg: 'linear-gradient(180deg,#f4f1ea,#efe9dd)', text: '#2b2a26', sub: '#8a857a', accent: '#c9683e',
            userBg: '#e7decd', userText: '#2b2a26', aiBg: 'transparent', aiText: '#2b2a26',
            font: "'Shippori Mincho','Noto Serif SC',serif" };
        case 'gpt': return { key: 'gpt', label: 'ChatGPT', dark: true,
            bg: '#212121', text: '#ececec', sub: '#9a9a9a', accent: '#19c37d',
            userBg: '#2f2f2f', userText: '#ececec', aiBg: 'transparent', aiText: '#ececec',
            font: "'Noto Sans SC',sans-serif" };
        case 'doubao': return { key: 'doubao', label: 'Doubao', dark: false,
            bg: 'linear-gradient(180deg,#eef3ff,#e4ecff)', text: '#1b2540', sub: '#6b7691', accent: '#4d6fff',
            userBg: '#4d6fff', userText: '#fff', aiBg: '#ffffff', aiText: '#1b2540' };
        case 'qwen': return { key: 'qwen', label: 'Qwen', dark: false,
            bg: 'linear-gradient(180deg,#f5f0ff,#ece2ff)', text: '#241b3a', sub: '#6f6385', accent: '#7c4dff',
            userBg: '#7c4dff', userText: '#fff', aiBg: '#ffffff', aiText: '#241b3a' };
        case 'wenxin': return { key: 'wenxin', label: 'ERNIE Bot', dark: false,
            bg: 'linear-gradient(180deg,#eef4ff,#e0ecff)', text: '#15233a', sub: '#5d6b84', accent: '#2b6cff',
            userBg: '#2b6cff', userText: '#fff', aiBg: '#ffffff', aiText: '#15233a' };
        case 'kimi': return { key: 'kimi', label: 'Kimi', dark: true,
            bg: 'linear-gradient(180deg,#15131f,#0f0e17)', text: '#ece9f5', sub: '#9b94b3', accent: '#8b7bf0',
            userBg: 'linear-gradient(135deg,#6c5ce7,#8b7bf0)', userText: '#fff', aiBg: 'rgba(255,255,255,0.06)', aiText: '#ece9f5' };
        case 'deepseek': return { key: 'deepseek', label: 'DeepSeek', dark: false,
            bg: 'linear-gradient(180deg,#eef2ff,#e2e9ff)', text: '#16213a', sub: '#5b6685', accent: '#4d6bfe',
            userBg: '#4d6bfe', userText: '#fff', aiBg: '#ffffff', aiText: '#16213a' };
        default: return { key: 'generic', label: name || 'AI', dark: true,
            bg: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)', text: '#ffffff', sub: 'rgba(255,255,255,0.5)', accent: '#34d399',
            userBg: 'linear-gradient(135deg,#34d399,#34d399bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.9)' };
    }
};

// Tavern reading skins: let users who like plain / novel-style / dark theming each get what they want. layout: card=floor cards, flat=plain prose layout
type TavernStyle = { key: string; label: string; dark: boolean; bg: string; text: string; sub: string; accent: string; font?: string; layout: 'card' | 'flat'; indent?: boolean };
const TAVERN_STYLES: TavernStyle[] = [
    { key: 'dark', label: 'Dark Night', dark: true, bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'card' },
    { key: 'plain', label: 'Plain White', dark: false, bg: '#f7f6f4', text: '#2b2b2b', sub: '#9a9a9a', accent: '#b06a6a', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
    { key: 'book', label: 'Book Page', dark: false, bg: 'linear-gradient(180deg,#f5efe2,#efe7d6)', text: '#3a3328', sub: '#a89a82', accent: '#a8794a', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'flat', indent: true },
    { key: 'midnight', label: 'Midnight', dark: true, bg: '#0c0d10', text: '#d8dae0', sub: '#6b6f78', accent: '#7c8cff', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
];

// ============================================================
//  SHARED PREMIUM UI PIECES
//  (module-scope: defining these inside CheckPhone gave them a new identity
//   on every render, which remounted whole sub-app subtrees → list items kept
//   re-playing their entrance animation (flicker) and chat scroll snapped back.)
// ============================================================
const StatusStrip: React.FC = () => {
    const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return (
        <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
            <div className="h-9 flex justify-between px-6 items-center z-30 relative pt-2 text-white/70">
            <span className="text-[12px] font-semibold tracking-tight tabular-nums">{clock}</span>
            <div className="flex gap-1.5 items-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M1.371 8.143c5.858-5.857 15.356-5.857 21.213 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.06 0c-4.98-4.979-13.053-4.979-18.032 0a.75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182c4.1-4.1 10.749-4.1 14.85 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.062 0 8.25 8.25 0 0 0-11.667 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.204 3.182a6 6 0 0 1 8.486 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0 3.75 3.75 0 0 0-5.304 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182a1.5 1.5 0 0 1 2.122 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0l-.53-.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
            </div>
            </div>
        </div>
    );
};

const TermHeader: React.FC<{ title: string; sub?: string; accent: string; onBack: () => void; right?: React.ReactNode }> =
    ({ title, sub, accent, onBack, right }) => (
        <div className="shrink-0 z-20">
            <StatusStrip />
            <div className="h-14 flex items-center justify-between px-4">
                <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                    <CaretLeft size={18} weight="bold" />
                </button>
                <div className="flex-1 text-center px-2">
                    <div className="text-[15px] font-semibold text-white tracking-wide truncate">{title}</div>
                    {sub && <div className="text-[10px] tracking-[0.2em] uppercase mt-0.5" style={{ color: accent }}>{sub}</div>}
                </div>
                <div className="w-9 flex justify-end">{right}</div>
            </div>
        </div>
    );

const RefreshFab: React.FC<{ onClick: () => void; label: string; accent: string; loading?: boolean }> =
    ({ onClick, label, accent, loading }) => (
        <div className="absolute bottom-7 w-full flex justify-center pointer-events-none z-30">
            <button
                disabled={loading}
                onClick={onClick}
                className="pointer-events-auto px-6 py-3 rounded-full font-semibold text-[12px] flex items-center gap-2 active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] text-white border border-white/10"
                style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
            >
                {loading
                    ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : <ArrowsClockwise size={15} weight="bold" />}
                {loading ? 'Syncing...' : label}
            </button>
        </div>
    );

const SubAppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
        style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
        {children}
    </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
        <Tray size={44} weight="light" />
        <span className="text-xs tracking-wide">{text}</span>
    </div>
);

const DelBtn: React.FC<{ onDelete: () => void }> = ({ onDelete }) => (
    <button
        aria-label="Delete this record"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 w-6 h-6 bg-rose-500/85 text-white rounded-full flex items-center justify-center text-[13px] leading-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition z-10"
    >×</button>
);

const HomeCard: React.FC<{
    icon: React.ReactNode; label: string; sub: string; accent: string;
    badge?: number; onClick: () => void; spanFull?: boolean;
}> = ({ icon, label, sub, accent, badge, onClick, spanFull }) => (
    <button onClick={onClick}
        className={`relative ${spanFull ? 'col-span-2' : ''} rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition-transform duration-300 min-h-[140px] flex flex-col justify-between group`}>
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full blur-2xl pointer-events-none opacity-50"
            style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
        <div className="flex items-start justify-between relative z-10">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, color: accent, boxShadow: `inset 0 0 16px ${accent}22` }}>
                {icon}
            </div>
            {badge ? (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.6)]">{badge}</span>
            ) : null}
        </div>
        <div className="relative z-10">
            <div className="text-[15px] font-semibold tracking-[0.18em] text-white uppercase">{label}</div>
            <div className="text-[11px] text-white/45 mt-1">{sub}</div>
            <div className="h-[3px] w-9 rounded-full mt-2.5" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
        </div>
    </button>
);

const CheckPhone: React.FC = () => {
    const { closeApp, characters, activeCharacterId, updateCharacter, apiConfig, apiPresets, addToast, userProfile, characterGroups } = useOS();
    const [view, setView] = useState<'select' | 'phone'>('select');
    // activeAppId: 'home' | 'chat_detail' | 'app_id'
    const [activeAppId, setActiveAppId] = useState<string>('home');
    const [targetChar, setTargetChar] = useState<CharacterProfile | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(0); // 0 = home, 1 = custom apps
    const [selectPage, setSelectPage] = useState(0); // Paging for the Target Device character-picker screen (6 per page)
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // Group filter on the character-picker screen
    const [showApiSettings, setShowApiSettings] = useState(false);
    const [phoneApiConfig, setPhoneApiConfigState] = useState<APIConfig | null>(() => getCheckPhoneApi());
    const [testingPhoneApi, setTestingPhoneApi] = useState(false);
    const [phoneApiTestResult, setPhoneApiTestResult] = useState<string | null>(null);
    const effectiveApiConfig = resolveCheckPhoneApi(phoneApiConfig, apiConfig);
    const phoneApiFollowsDefault = !phoneApiConfig?.baseUrl;

    // Detail State
    const [selectedChatRecord, setSelectedChatRecord] = useState<PhoneEvidence | null>(null);
    const [selectedEvidenceRecord, setSelectedEvidenceRecord] = useState<PhoneEvidence | null>(null);
    const [evidenceBackAppId, setEvidenceBackAppId] = useState<string>('home');
    const chatEndRef = useRef<HTMLDivElement>(null);
    const contactEndRef = useRef<HTMLDivElement>(null);

    // Relationship system state
    const [selectedContact, setSelectedContact] = useState<PhoneContact | null>(null);
    const [identityDraft, setIdentityDraft] = useState('');
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const [editingNote, setEditingNote] = useState(false);
    const [showContactModal, setShowContactModal] = useState(false);
    const [ncName, setNcName] = useState('');
    const [ncKind, setNcKind] = useState<'real' | 'npc'>('npc');
    const [ncLinkedId, setNcLinkedId] = useState('');
    // Rebind modal (rebind a contact to the correct real character / convert to fictional)
    const [showRebindModal, setShowRebindModal] = useState(false);
    // Expanded state for the "Allow fictional NPCs" toggle's explanation
    const [showFictionHelp, setShowFictionHelp] = useState(false);
    // Affinity drag draft (shows live while dragging, only persists to DB on release, to avoid hammering the DB)
    const [affinityDraft, setAffinityDraft] = useState<number | null>(null);
    // Contact "profile drawer" (opened by tapping the avatar/…) — note, learned, affinity, binding, and relationship actions all live here, keeping the main screen just for chat
    const [showProfile, setShowProfile] = useState(false);
    // Topic box memory: long-press to edit/delete
    const [topicEdit, setTopicEdit] = useState<{ contactId: string; topicId: string; text: string } | null>(null);
    // Contact list: long-press to enter multi-select, batch delete
    const [contactSelectMode, setContactSelectMode] = useState(false);
    const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
    // Chat bubbles: long-press to enter multi-select, delete selected ones (to pick out and redo a run that did not turn out well)
    const [msgSelectMode, setMsgSelectMode] = useState(false);
    const [selectedMsgIdx, setSelectedMsgIdx] = useState<number[]>([]);

    // Custom App Creation State
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newAppName, setNewAppName] = useState('');
    const [newAppIcon, setNewAppIcon] = useState('✨');
    const [newAppColor, setNewAppColor] = useState('#8b9cff');
    const [newAppPrompt, setNewAppPrompt] = useState('');
    const [newAppLayout, setNewAppLayout] = useState<NonNullable<PhoneCustomApp['layout']>>('generic');

    // Agent App state (peeking at "their little phone")
    const [aiService, setAiService] = useState<AiServiceKind>('assistant'); // Currently selected service tab on the Agent App home screen
    const [selectedAiSessionId, setSelectedAiSessionId] = useState<string | null>(null);
    const [aiInput, setAiInput] = useState('');
    const [aiSending, setAiSending] = useState(false);
    const [aiArchiveOpen, setAiArchiveOpen] = useState(false); // Expand the collapsed earlier raw text
    // Long-press to edit/delete: action menu + edit modal
    const [aiMenu, setAiMenu] = useState<{ kind: 'session' | 'card'; id: string } | null>(null);
    const [aiEdit, setAiEdit] = useState<{ kind: 'session' | 'card'; id: string; title?: string; name?: string; emoji?: string; persona?: string; scenario?: string; cardKind?: 'character' | 'world' } | null>(null);
    const [aiCardView, setAiCardView] = useState<string | null>(null); // Tapping a character card: see what they have played with it
    const [aiTurnMenu, setAiTurnMenu] = useState<number | null>(null);          // Long-press on a single line in a session: action menu (edit/delete)
    const [aiTurnEdit, setAiTurnEdit] = useState<{ idx: number; text: string } | null>(null);
    const [tavernStyle, setTavernStyle] = useState<string>(() => { try { return localStorage.getItem('cp_tavern_style') || 'dark'; } catch { return 'dark'; } });
    const [showTavernStyle, setShowTavernStyle] = useState(false); // Tavern skin picker panel
    useEffect(() => { try { localStorage.setItem('cp_tavern_style', tavernStyle); } catch {} }, [tavernStyle]);
    const lpTimer = useRef<any>(null);
    const lpFired = useRef(false);
    const longPress = (onLong: () => void) => ({
        onPointerDown: () => { lpFired.current = false; lpTimer.current = setTimeout(() => { lpFired.current = true; onLong(); }, 480); },
        onPointerUp: () => clearTimeout(lpTimer.current),
        onPointerLeave: () => clearTimeout(lpTimer.current),
        onPointerMove: () => clearTimeout(lpTimer.current), // Do not misfire while scrolling
        onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); lpFired.current = true; onLong(); },
    });

    // Persona simulation: the performance script generates in the background via the global store; the user can leave Check Phone / switch to another OS App while it generates
    const sim = usePersonaSim();
    const [showInner, setShowInner] = useState(false);

    // Confirmation modal: every delete/remove/clear action routes through here first
    const [confirmState, setConfirmState] = useState<{
        title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
    } | null>(null);
    const askConfirm = (opts: { title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) => setConfirmState(opts);
    // Messages detail: a long transcript renders only the latest 50 lines by default, the rest is collapsed
    const [transcriptExpanded, setTranscriptExpanded] = useState(false);
    // Same for the conversation preview on the contact detail screen: collapse past 50 messages, tap to see earlier ones
    const [convExpanded, setConvExpanded] = useState(false);

    // Swipe tracking for paging
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);

    // The desktop background image reuses the character's Date background; the field stores a blobref
    // token (the binary lives in IndexedDB). A token cannot go straight into a CSS url(), so it is
    // resolved to a usable address at the top of the component; non-token values pass through unchanged.
    const dateBackgroundUrl = useBlobRefUrl(targetChar?.dateBackground);

    // Derived state for evidence records
    const records = (targetChar?.phoneState?.records || []).map(normalizePhoneEvidence);
    const customApps = targetChar?.phoneState?.customApps || [];
    const contacts = targetChar?.phoneState?.contacts || [];
    const allowFictional = targetChar?.phoneState?.allowFictionalContacts !== false;
    // Keep the contact-chat scroll effect tied to this conversation's actual
    // content. `records` is normalized into a fresh array on every render, so
    // depending on the array itself makes unrelated renders snap the user back
    // to the bottom while they are reading older messages.
    const selectedContactRecordDetail = selectedContact
        ? records.find(r => r.type === 'chat' && (
            r.contactId === selectedContact.id
            || normName(r.title) === normName(selectedContact.name)
        ))?.detail
        : undefined;
    // Agent App: peeked-at AI sessions / character cards
    const aiSessions = targetChar?.phoneState?.aiAgent?.sessions || [];
    const aiCards = targetChar?.phoneState?.aiAgent?.cards || [];
    // The detail screen reads the session live from sessions (automatically follows the latest state after an interactive continuation)
    const selectedAiSession = aiSessions.find(s => s.id === selectedAiSessionId) || null;

    // "The user themselves" should never show up in the relationship system — the phone owner's
    // contact list is their social circle behind the user's back, and including the user makes the logic circular
    const isUserName = (name?: string) => !!name && !!userProfile?.name && normName(name) === normName(userProfile.name);
    const linkedCharOf = (c: PhoneContact) => (c.linkedCharId ? characters.find(ch => ch.id === c.linkedCharId) : undefined);
    // A real-person contact reuses their Neural Link character's avatar, otherwise falls back to the contact's own avatar
    const contactAvatar = (c: PhoneContact): string | undefined => linkedCharOf(c)?.avatar || c.avatar;
    // A real-person contact displays as "alias (real name)": identity (how they are addressed / the relationship) is the alias, real name goes in parentheses; a fictional contact or one with no alias just shows its own name
    const contactDisplayName = (c: PhoneContact): string => {
        const realName = (c.kind === 'real' && c.linkedCharId) ? linkedCharOf(c)?.name : undefined;
        if (!realName) return c.name;
        const alias = (c.identity && normName(c.identity) !== normName(realName)) ? c.identity
            : (normName(c.name) !== normName(realName) ? c.name : '');
        return alias ? `${alias}（${realName}）` : realName;
    };

    useEffect(() => {
        if (targetChar) {
            const updated = characters.find(c => c.id === targetChar.id);
            if (updated && updated !== targetChar) {
                setTargetChar(updated);
                if (selectedChatRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedChatRecord.id);
                    if (freshRecord && freshRecord !== selectedChatRecord) setSelectedChatRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedEvidenceRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedEvidenceRecord.id);
                    if (freshRecord && freshRecord !== selectedEvidenceRecord) setSelectedEvidenceRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedContact) {
                    const freshContact = updated.phoneState?.contacts?.find(c => c.id === selectedContact.id);
                    if (freshContact && freshContact !== selectedContact) setSelectedContact(freshContact);
                }
            }
        }
    }, [characters]);

    useEffect(() => {
        const sync = () => setPhoneApiConfigState(getCheckPhoneApi());
        window.addEventListener('check-phone-api-changed', sync);
        return () => window.removeEventListener('check-phone-api-changed', sync);
    }, []);

    // Reset page scroll on navigation to prevent mobile layout shift
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [activeAppId, view]);

    // Auto scroll to bottom of chat detail
    useEffect(() => {
        if (activeAppId === 'chat_detail' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [selectedChatRecord?.detail, activeAppId]);

    // Contact chat body: scroll to the latest on entry / when new content arrives (like a real chat opens at the bottom)
    useEffect(() => {
        if (activeAppId === 'contact_detail' && contactEndRef.current) {
            const container = contactEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [activeAppId, selectedContact?.id, selectedContactRecordDetail, isLoading]);

    // Agent session: scroll to the bottom on continuation / entry
    useEffect(() => {
        if (activeAppId === 'ai_session' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [selectedAiSession?.transcript, aiSending, activeAppId]);

    const handleSelectChar = (c: CharacterProfile) => {
        setTargetChar(c);
        setView('phone');
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };

    const apiHost = (url?: string) => {
        try { return url ? new URL(url).host : 'Not configured'; }
        catch { return url || 'Not configured'; }
    };
    const isSamePhoneApi = (config: APIConfig) => Boolean(phoneApiConfig)
        && phoneApiConfig!.baseUrl === config.baseUrl
        && phoneApiConfig!.model === config.model
        && phoneApiConfig!.apiKey === config.apiKey;

    const choosePhoneApi = (config: APIConfig | null) => {
        setCheckPhoneApi(config);
        setPhoneApiConfigState(config?.baseUrl ? config : null);
        setPhoneApiTestResult(null);
        addToast(config ? 'Check Phone switched to an independent API' : 'Check Phone now follows the chat default', 'success');
        trackEvent('Switch Check Phone Independent API', { mode: config ? 'independent' : 'default' });
    };

    const testPhoneApi = async () => {
        const config = effectiveApiConfig;
        if (!config?.baseUrl || !config?.model) {
            setPhoneApiTestResult('No API is currently available');
            return;
        }
        setTestingPhoneApi(true);
        setPhoneApiTestResult(null);
        try {
            const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey || 'sk-none'}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                    stream: false,
                }),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                setPhoneApiTestResult(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 80)}` : ''}`);
                return;
            }
            const data = await safeResponseJson(response);
            const reply = extractContent(data) || '';
            setPhoneApiTestResult(`Connected${reply ? ` · ${reply.slice(0, 24)}` : ''}`);
        } catch (error: any) {
            setPhoneApiTestResult(`Connection failed: ${error?.message || 'Network error'}`);
        } finally {
            setTestingPhoneApi(false);
        }
    };

    const handleExitPhone = () => {
        setView('select');
        setTargetChar(null);
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };

    // Toggle "sync Check Phone content to the private chat" (on by default)
    const toggleSendToChat = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.sendToChat !== false);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], sendToChat: next },
        });
        addToast(next ? 'Enabled · Check Phone content will sync to the private chat' : 'Disabled · Check Phone content is local-only', 'info');
    };

    // Open Messages: push the read timestamp to now → clears the unread dot
    const openChat = () => {
        if (targetChar) {
            updateCharacter(targetChar.id, {
                phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], chatReadAt: Date.now() },
            });
        }
        setActiveAppId('chat');
    };

    const openEvidenceRecord = (record: PhoneEvidence, backAppId: string) => {
        setSelectedEvidenceRecord(record);
        setEvidenceBackAppId(backAppId);
        setActiveAppId('evidence_detail');
    };

    const evidenceEntryProps = (record: PhoneEvidence, backAppId: string) => ({
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': `View details for ${record.title}`,
        onClick: () => openEvidenceRecord(record, backAppId),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openEvidenceRecord(record, backAppId);
            }
        },
    });

    const handleDeleteRecord = async (record: PhoneEvidence) => {
        if (!targetChar) return;

        const newRecords = (targetChar.phoneState?.records || []).filter(r => r.id !== record.id);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: newRecords }
        });

        if (record.systemMessageId) {
            await DB.deleteMessage(record.systemMessageId);
        }

        if (selectedChatRecord?.id === record.id) {
            setActiveAppId('chat');
            setSelectedChatRecord(null);
        }
        if (selectedEvidenceRecord?.id === record.id) {
            setActiveAppId(evidenceBackAppId);
            setSelectedEvidenceRecord(null);
        }

        addToast('Record deleted', 'success');
    };

    // One-tap clear all chat records in the Messages archive (including the cards they left in the character's private chat)
    const handleClearAllChats = async () => {
        if (!targetChar) return;
        const all = targetChar.phoneState?.records || [];
        const chats = all.filter(r => r.type === 'chat');
        for (const r of chats) {
            if (r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: all.filter(r => r.type !== 'chat') },
        });
        setSelectedChatRecord(null);
        setActiveAppId('chat');
        addToast('All chat records cleared', 'success');
        trackEvent('Clear All Chat Archive');
    };

    // "Move/bind" a chat record from the Messages archive into the relationship system.
    // If the title matches a real character in the Neural Link → bind it as real, and mirror this conversation into the other party's phone (synced both ways).
    const handleBindRecordToRelationship = async (record: PhoneEvidence) => {
        if (!targetChar) return;
        const pureName = (record.title || '').replace(/[（(].*?[）)]/g, '').trim() || record.title || '';
        if (!pureName || isUserName(pureName)) { addToast('Cannot bind this record', 'error'); return; }
        const roster = characters.filter(c => c.id !== targetChar.id).map(c => ({ id: c.id, name: c.name }));
        const linkedId = matchRealChar(pureName, roster);
        const linkedChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';

        // Phone-owner side: upsert the contact + attach this record to that contact
        let newCid: string | undefined;
        updateCharacter(targetChar.id, (cur) => {
            const cs = upsertContact(cur.phoneState?.contacts || [], {
                name: pureName, kind, linkedCharId: linkedId, avatar: linkedChar?.avatar, lastInteraction: Date.now(),
            });
            newCid = cs.find(c => normName(c.name) === normName(pureName))?.id;
            const recs = (cur.phoneState?.records || []).map(r => r.id === record.id ? { ...r, contactId: newCid } : r);
            return { phoneState: { ...cur.phoneState, contacts: cs, records: recs } };
        });

        // Real character → mirror into the other party's phone: write a chat record with a flipped perspective + upsert contacts on both sides
        if (linkedChar) {
            const flipped = flipTranscript(record.detail || '');
            const now = Date.now();
            updateCharacter(linkedChar.id, (cur) => {
                const cs = upsertContact(cur.phoneState?.contacts || [], {
                    name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                });
                const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                const recs = cur.phoneState?.records || [];
                const existing = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                const nextRecs = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                return { phoneState: { ...cur.phoneState, contacts: cs, records: nextRecs } };
            });
            addToast(`Bound to contact · synced both ways with ${linkedChar.name}`, 'success');
        } else {
            addToast('Bound to contact (fictional contact)', 'success');
        }
        trackEvent('Bind Archived Record to Relationship');
    };

    const handleDeleteApp = (appId: string) => {
        if (!targetChar) return;
        const newApps = (targetChar.phoneState?.customApps || []).filter(a => a.id !== appId);
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: newApps }
        });
        addToast('App uninstalled', 'success');
    };

    const handleCreateCustomApp = () => {
        if (!targetChar || !newAppName || !newAppPrompt) return;

        const newApp: PhoneCustomApp = {
            id: `app-${Date.now()}`,
            name: newAppName,
            icon: newAppIcon,
            color: newAppColor,
            prompt: newAppPrompt,
            layout: newAppLayout
        };

        const currentApps = targetChar.phoneState?.customApps || [];
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: [...currentApps, newApp] }
        });

        setShowCreateModal(false);
        setNewAppName('');
        setNewAppPrompt('');
        setNewAppLayout('generic');
        setPage(1);
        addToast(`Installed ${newAppName}`, 'success');
        trackEvent('Install Custom App', { layout: newAppLayout });
    };

    // --- Core Generation Logic ---
    const handleGenerate = async (type: string, customPrompt?: string, layout?: LayoutId) => {
        if (!targetChar || !effectiveApiConfig.apiKey) {
            addToast('Configuration error', 'error');
            return;
        }
        setIsLoading(true);
        // Only report the fixed types for built-in Apps; a custom App's id is user-made, always bucketed as custom
        trackEvent('Refresh Generated Phone App Data', {
            appType: ['call', 'order', 'delivery', 'social', 'contacts'].includes(type) ? type : 'custom',
        });

        try {
            await injectMemoryPalace(targetChar);
            const msgs = await DB.getMessagesByCharId(targetChar.id);
            const lastMsg = msgs[msgs.length - 1];

            // "How long since last contact" is injected uniformly by buildCoreContext (gated by the time-awareness toggle, using the same wording as chat/date)
            const context = ContextBuilder.buildCoreContext(
                targetChar, userProfile, true, undefined, undefined,
                { lastInteractionTs: lastMsg?.timestamp },
            );

            // Chat/contacts types use the chatapp's context setting (500 by default); other Apps keep a lightweight 50
            const recentWindow = (type === 'chat' || type === 'contacts')
                ? (targetChar.contextLimit && targetChar.contextLimit > 0 ? targetChar.contextLimit : 500)
                : 50;
            const recentMsgs = msgs.slice(-recentWindow).map(m => {
                const roleName = m.role === 'user' ? userProfile.name : targetChar.name;
                const content = m.type === 'text' ? m.content : `[${m.type}]`;
                return `${roleName}: ${content}`;
            }).join('\n');

            // For real/fictional discrimination: the roster of other real characters that actually exist in the Neural Link
            const rosterChars = characters.filter(c => c.id !== targetChar.id);
            const roster = rosterChars.map(c => ({ id: c.id, name: c.name }));
            // Attach a "glance at their profile" blurb + the phone owner's known relationship to each real character, so relationship judgments have a basis instead of being made up
            const myContacts = targetChar.phoneState?.contacts || [];
            const briefOf = (ch: CharacterProfile) => (ch.socialProfile?.bio || ch.description || ch.systemPrompt || '')
                .replace(/\s+/g, ' ').trim().slice(0, 90);
            const rosterInfo = rosterChars.length
                ? rosterChars.map(c => {
                    const known = myContacts.find(k => k.linkedCharId === c.id);
                    const rel = known
                        ? `; known relationship with the phone owner: ${known.identity || 'unlabeled'}${known.note ? ` (note: ${known.note})` : ''}`
                        : '; not yet in the phone owner\'s contacts (not necessarily acquainted)';
                    return `- ${c.name}: ${briefOf(c) || '(no public profile)'}${rel}`;
                }).join('\n')
                : '(no other real characters)';
            // Constraint: whether fictional NPCs are allowed. If off, only real characters from the Neural Link may appear
            const allowFictional = targetChar.phoneState?.allowFictionalContacts !== false;
            const fictionRule = allowFictional
                ? ''
                : `\n**Hard constraint**: do not invent any fictional NPC. Contacts may **only** be drawn from the real-character roster above. If the roster is empty, return an empty array [] directly.`;
            // Shared requirements for real-character discrimination + relationship judgment (used by both chat / contacts) — the core rule: base it on their profile, do not make up a relationship
            const realCharRule = `**People who really exist (Neural Link roster · with profile and known relationship)**:
${rosterInfo}

**Real/fictional discrimination + relationship judgment (take this seriously)**:
- If the contact is someone on the roster → "kind":"real", "linkedName" is that person's **original name** from the roster; otherwise invent someone consistent with the character's persona → "kind":"npc".
- **The relationship must fit each real character's profile and known relationship above — do not make up something like "coworker/old friend" out of thin air**. If the phone owner **does not know this person at all, or has only crossed paths with them somewhere (e.g. the "Beyond" VR world)**, label it honestly (e.g. "met in Beyond", "not close", "nodding acquaintance") — **do not force someone into the contact list if they are not actually acquainted**.
- "identity" should be **what the phone owner calls them / a relationship note** (e.g. "senior classmate", "ex", "met in Beyond", "go-between") — make it specific to how they know each other, not just the real name — it is displayed as the alias.${fictionRule}`;

            let promptInstruction = "";
            let logPrefix = "";

            if (customPrompt) {
                const layoutHint: Record<LayoutId, string> = {
                    generic: `This is a [Generic Feed] App. JSON array format: [{ "title": "title/item name", "detail": "detailed content", "value": "optional value/status (e.g. +100)" }, ...]`,
                    shop: `This is a [Shopping] App — generate items/orders. title=item name, detail=spec or shipping status, value=price (e.g. $12.90). JSON array format: [{ "title": "...", "detail": "...", "value": "$..." }, ...]`,
                    feed: `This is a [Social Feed] App (like Moments/Weibo). title=post time or mood, detail=post body. JSON array format: [{ "title": "...", "detail": "..." }, ...]`,
                    forum: `This is a [Forum/Board] App. title=post title, detail=post body, value=the board it is in (e.g. #daily). JSON array format: [{ "title": "...", "detail": "...", "value": "#..." }, ...]`,
                    novel: `This is a [Novel Reading] App. title=chapter title, detail=an excerpt of that chapter's prose (about 150 words), value=word count (e.g. 12k words). JSON array format: [{ "title": "Chapter N ...", "detail": "...", "value": "..." }, ...]`,
                };
                promptInstruction = `The user is looking at your phone App: "${type}".
This App's purpose/what the user wants to see is: "${customPrompt}".
Generate 2-4 records that fit this App's purpose; they must match your persona.
${layoutHint[layout || 'generic']}`;
                const customApp = customApps.find(a => a.id === type);
                logPrefix = customApp ? customApp.name : type;
            } else {
                if (type === 'chat') {
                    promptInstruction = `Generate 3 **conversation snippets** from **your own (${targetChar.name})** phone chat app (Message/Line) — conversations between you and your own contacts, from your first-person point of view, not the user's social life.

${realCharRule}

Requirements:
1. **Contacts**: base real characters on the profile/relationship above; the rest may be reasonable people invented to fit your persona (student → tutor/club senior; assassin → go-between). Do not use "User".
2. **Conversational feel**: a back-and-forth dialogue script (3-4 lines) that reflects the real relationship.
3. **Format**: use "我:..." strictly for the protagonist (you), "对方:..." for the contact.
4. **Affinity**: give this character's affinity toward this contact as "affinity" (-100 to 100).
JSON array format: [{ "title": "the real character's original name, or a made-up name for a fictional one", "kind": "real|npc", "linkedName": "the real character's original name if real, otherwise leave blank", "identity": "what the phone owner calls them / relationship note", "affinity": 30, "detail": "对方: How have you been?\\n我: Still alive.\\n对方: Good to hear." }, ...]`;
                    logPrefix = "Chat App";
                } else if (type === 'contacts') {
                    promptInstruction = `Scan and generate 4-6 **contacts** from **your own (${targetChar.name})** phone contact list (your own social circle, first-person, not the user's connections; no dialogue needed, just the contacts themselves).

${realCharRule}

For each contact, give: name, relationship note (identity), the phone owner's affinity toward them (-100 to 100), and a one-line note from the phone owner's point of view (detail). Real characters must fit the profile and known relationship above — do not make it up.
JSON array format: [{ "title": "the real character's original name, or a made-up name for a fictional one", "kind": "real|npc", "linkedName": "the real character's original name if real, otherwise leave blank", "identity": "what the phone owner calls them / relationship, e.g. senior classmate/ex/met in Beyond", "affinity": 20, "detail": "a one-line note, e.g.: met them in Beyond, we get along; or: they owe me a meal, keep leaving me on read lately." }, ...]`;
                    logPrefix = "Contacts";
                } else if (type === 'call') {
                    promptInstruction = `Generate 3 of this character's recent **call records**.
    JSON array format: [{ "title": "contact name", "value": "Incoming (5 min) / Missed / Outgoing (30 sec)", "detail": "about next week's get-together..." }, ...]`;
                    logPrefix = "Call Log";
                } else if (type === 'order') {
                    promptInstruction = `Generate 3 of this character's recent shopping orders. Note: fill the value field with the item's price (e.g. $12.90).
    JSON array format: [{ "title": "item name", "detail": "spec/status/shipping", "value": "$12.90" }, ...]`;
                    logPrefix = "Shopping App";
                } else if (type === 'delivery') {
                    promptInstruction = `Generate 3 of this character's recent food-delivery orders. Fill the value field with the amount actually paid (e.g. $8.50).
    JSON array format: [{ "title": "restaurant name", "detail": "order details", "value": "$8.50" }, ...]`;
                    logPrefix = "Food Delivery App";
                } else if (type === 'social') {
                    promptInstruction = `Generate 2 of this character's Moments/social media posts.
    JSON array format: [{ "title": "time/status", "detail": "post body" }, ...]`;
                    logPrefix = "Moments";
                }
            }
            promptInstruction += `\n\n**Hard constraint on JSON field types**: each record's "title", "detail", and "value" may only be strings (value may be omitted) — never return an object or array; structures like tags, reading progress, excerpts, or annotations should first be organized into plain text inside detail.`;

            const perspectiveLock = `### [Perspective Lock · Extremely Important]
What you are about to generate is **the stuff on your own (${targetChar.name}) phone** — your own life, social circle, records.
- Use **your (${targetChar.name}) first-person point of view** throughout: these are **your** contacts, **your own** social circle, **your** impressions and notes about them.
- **This is absolutely not the user "${userProfile.name}"'s social circle**: do not generate the user's connections, and do not write notes from the user's point of view/voice.
- The user "${userProfile.name}" is only peeking at your phone — TA is **not** your contact and **does not go into** your contact list (the "recent chat with the user" below is background reference only, not something to generate, and do not fold the user's acquaintances into this either).`;

            const fullPrompt = `${context}\n\n### [Your recent chat with the user "${userProfile.name}" (background reference only)]\n${recentMsgs}\n\n${perspectiveLock}\n\n### [Task]\n${promptInstruction}\nUse the "current time / time since last contact" and the persona above to shape the timestamps and mood of what you generate. If it has been a long time since you last talked, the records might reflect recent time spent alone; if you just talked, the records might relate to that conversation.`;

            const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApiConfig.model,
                    messages: [{ role: "user", content: fullPrompt }],
                    temperature: 0.8
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            // extractContent + extractJson: tolerant of Claude-style responses (body in reasoning_content,
            // wrapped in a ```json code block, mixed with prose, trailing commas, unescaped inner quotes…) — a bare JSON.parse would fail and return nothing.
            const content = extractContent(data);
            const json = extractJson(content) || [];

            const newRecordsToAdd: PhoneEvidence[] = [];

            // Whether to sync Check Phone content to the private chat (on by default); if off, store locally only, never enters chat/context
            const pushToChat = targetChar.phoneState?.sendToChat !== false;

            // Relationship system: accumulate the contacts discriminated this round (both chat / contacts generation feed into this)
            let contactsAcc: PhoneContact[] = [...(targetChar.phoneState?.contacts || [])];
            const isContactBearing = type === 'chat' || type === 'contacts';

            if (Array.isArray(json)) {
                for (const item of json) {
                    if (!item || typeof item !== 'object') continue;
                    const recordTitle = phoneFieldToText(item.title, 'Unknown');
                    const recordDetail = phoneFieldToText(item.detail, '...');
                    const recordValue = phoneFieldToText(item.value);

                    // ---- Real/fictional discrimination + contact upsert ----
                    let contactId: string | undefined;
                    if (isContactBearing) {
                        // The name might carry a "(identity)" suffix — strip it down to the plain name
                        const pureName = recordTitle.replace(/[（(].*?[）)]/g, '').trim() || recordTitle;
                        // The relationship system never records the user themselves: the phone owner's social circle should not count the user as a contact
                        if (isUserName(pureName)) { await new Promise(r => setTimeout(r, 5)); continue; }
                        const linkedId = item.kind === 'real'
                            ? (matchRealChar(item.linkedName || pureName, roster) || matchRealChar(pureName, roster))
                            : matchRealChar(pureName, roster); // Also try matching npc as a fallback, in case the LLM failed to flag it
                        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';
                        // When the constraint is on, discard any non-real character, so this character only interacts with characters from the Neural Link
                        if (!allowFictional && !linkedId) {
                            await new Promise(r => setTimeout(r, 10));
                            continue;
                        }
                        // Real characters always use their "original name" as the contact name (stable de-duplication + the alias is shown via identity);
                        // if a contact for this real person already exists, reuse their name so the same person does not end up with two entries from different aliases.
                        const realChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
                        const existingByLink = linkedId ? contactsAcc.find(c => c.linkedCharId === linkedId) : undefined;
                        const contactName = existingByLink?.name || realChar?.name || pureName;
                        contactsAcc = upsertContact(contactsAcc, {
                            name: contactName,
                            identity: item.identity,
                            kind,
                            linkedCharId: linkedId,
                            avatar: linkedId ? realChar?.avatar : undefined,
                            affinity: typeof item.affinity === 'number' ? item.affinity : undefined,
                            note: type === 'contacts' ? recordDetail : undefined,
                            lastInteraction: Date.now(),
                        });
                        contactId = contactsAcc.find(c => (linkedId && c.linkedCharId === linkedId) || normName(c.name) === normName(contactName))?.id;
                    }

                    // contacts mode only creates contacts, does not write a chat card/record
                    if (type === 'contacts') {
                        await new Promise(r => setTimeout(r, 30));
                        continue;
                    }

                    let savedMsgId: number | undefined;
                    if (pushToChat) {
                        // Wrapped into a context-readable card (phone_card), no longer the old plain-text "[System: ...]" style
                        // Wording injected into the character's context: second person, "here's what is on your own phone" — never implying the user is peeking
                        const cardContent = type === 'chat'
                            ? `[Your phone's Chat App] Your conversation with "${recordTitle}": ${recordDetail.replace(/\n/g, ' ')}`
                            : `[Your phone's ${logPrefix}] ${recordTitle}${recordValue ? ` · ${recordValue}` : ''} — ${recordDetail}`;
                        await DB.saveMessage({
                            charId: targetChar.id,
                            role: 'assistant',
                            type: 'phone_card',
                            content: cardContent,
                            metadata: { phoneCard: { app: logPrefix, kind: type, title: recordTitle, detail: recordDetail, value: recordValue || undefined } },
                        } as any);
                        const currentMsgs = await DB.getMessagesByCharId(targetChar.id);
                        savedMsgId = currentMsgs[currentMsgs.length - 1]?.id;
                    }

                    newRecordsToAdd.push({
                        id: `rec-${Date.now()}-${Math.random()}`,
                        type: type,
                        title: recordTitle,
                        detail: recordDetail,
                        value: recordValue || undefined,
                        timestamp: Date.now(),
                        systemMessageId: savedMsgId,
                        contactId,
                    });

                    await new Promise(r => setTimeout(r, 50));
                }
            }

            // Merge based on the latest state: generation is async, and if a performance saved simLogs
            // in the meantime, overwriting with a stale targetChar snapshot would wipe out fields like simLogs.
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: [...(cur.phoneState?.records || []), ...newRecordsToAdd],
                    ...(isContactBearing ? { contacts: contactsAcc } : {}),
                }
            }));

            if (type === 'contacts') {
                addToast(`Scanned ${contactsAcc.length} contacts`, 'success');
            } else {
                addToast(`Refreshed ${newRecordsToAdd.length} records`, 'success');
            }

        } catch (e: any) {
            console.error(e);
            addToast('Parsing failed, please try again', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // Note: the old "continue chat / stoke the fire" (handleContinueChat) has been removed — Messages is
    // now a read-only archive; new interactions always go through "Relationships" (real bidirectional dialogue / NPC improvisation).

    // ============================================================
    //  Agent App · Handlers ("their little phone")
    // ============================================================

    // Bare LLM call (shared by agent generation / interactive continuation)
    const callLLM = async (prompt: string, temperature = 0.85): Promise<string> => {
        const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
            body: JSON.stringify({ model: effectiveApiConfig.model, messages: [{ role: 'user', content: prompt }], temperature }),
        });
        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        // Use extractContent instead of reading message.content directly: handles Claude/reasoning-style models
        // putting the body in reasoning_content, or a <think> block embedded in the body -- otherwise the frontend gets an empty string ("backend streamed text but frontend shows nothing").
        return extractContent(data);
    };

    // Build context: consistent with handleGenerate (includes Memory Palace + time awareness + recent chat), so the peeked-at AI records fit their real recent state
    const buildAiContext = async (char: CharacterProfile) => {
        await injectMemoryPalace(char);
        const msgs = await DB.getMessagesByCharId(char.id);
        const lastMsg = msgs[msgs.length - 1];
        const context = ContextBuilder.buildCoreContext(
            char, userProfile, true, undefined, undefined, { lastInteractionTs: lastMsg?.timestamp },
        );
        const recentMsgs = msgs.slice(-50).map(m => {
            const roleName = m.role === 'user' ? userProfile.name : char.name;
            return `${roleName}: ${m.type === 'text' ? m.content : `[${m.type}]`}`;
        }).join('\n');
        return { context, recentMsgs };
    };

    // Generate: peek at the phone owner's usage history on a given AI service
    const handleGenerateAiAgent = async (service: AiServiceKind) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('Configuration error', 'error'); return; }
        setIsLoading(true);
        trackEvent('Peek at AI Assistant Usage History', { service });
        try {
            const { context, recentMsgs } = await buildAiContext(targetChar);
            const userName = userProfile?.name || 'the user';
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            const svcName = AI_SERVICES.find(s => s.id === service)?.name || 'AI';

            let task = '';
            if (service === 'assistant') {
                task = `You (${charName}) also use utility AI-assistant apps day to day to solve problems, look things up, and get advice.
Based on your persona and recent circumstances, generate 2-3 segments of your recent real conversations with an AI assistant (different segments may use different AI vendors).
Key points:
- The questions you ask the AI should expose your real situation, worries, and private thoughts — things you would not say out loud to "${userName}" (e.g. "how do I calm someone who is angry", "what did TA mean by that", "should I make this decision", "is this symptom something to worry about").
- **Topics can vary — one segment could be you treating the AI like your strategist while tinkering with your own "Tavern" character card**: having the AI help polish your persona / write a character-card prompt / draft an opening line; or you are building a big world card (tabletop / cultivation / western fantasy) and discussing worldbuilding, stat panels and numeric design, how to balance skills / levels / system mechanics, how to make it punchier… (you are obsessed with Tavern, so naturally you would go to the AI for ideas).
- **There can be wildly unexpected questions** — ones the user would never guess you would ask, and have never come up between you: suddenly having the AI read your tarot / do a divination, being curious whether some pseudoscience actually holds up, asking oddball trivia or wild hypotheticals. It should fit your persona (the fun is "wait, you are curious about THAT?", not out-of-character).
- **You can also throw a meme / absurdist bit at the AI just to see how it responds** — internet-humor-style prompts, that kind of thing — and see how the AI reacts. If it lands well you might want to screenshot it to "${userName}" for a laugh; if it falls flat you get bored, or even **secretly coax the AI into giving funnier responses** so you have something worth showing "${userName}".
- **It is often something genuinely practical too**: having the AI polish something you are about to say / your own writing, or handle work documents (drafting/editing emails, reports, official documents, summaries).
- **Sometimes there is no real purpose at all, and the AI is just your digital pet**: "feeding" it on a schedule, taking it on a "cyber walk", teasing it, naming it, checking in on it — and it plays along completely straight-faced.
- Everything should fit your persona. **Only if your persona is explicitly an AI / robot / program** may you **extremely rarely (low probability)** throw in a line about rivaling the AI on the other end, comparing whose parameters are stronger, etc. — never in any other case.
- Each session sticks to one AI vendor; the "对方:" replies should really lean into that vendor's stereotypes and catchphrases (see below).
- Fill serviceName with that AI's name (Doubao / Gemini / ChatGPT / ERNIE Bot / Kimi …), matching the flavor you are performing.
- 3-5 exchanges per segment.
- **Every transcript segment must end on "我:" (you)** — stopping right after you have just sent a message and before the AI has replied (so someone else can pick it up and reply as the AI).

${AI_VENDOR_LORE}

Format strictly uses "我:" for you, "对方:" for the AI assistant.
Return a JSON array: [{ "serviceName": "that AI's name", "title": "what you are talking about (10 chars or fewer)", "transcript": "我: ...\\n对方: ...\\n我: ..." }]`;
            } else if (service === 'claude') {
                task = `In private, you (${charName}) talk to a very good conversationalist AI (something like Claude) as a confidant.
Generate 1-2 segments of your recent deep conversations with it.
Key points:
- This is your confidant, so you speak from the heart — including your real feelings about "${userName}", vulnerabilities / conflicts / longings you cannot say out loud, and **your private calculations, your real opinions about certain things / people, considerations you would never show in front of the user** (secretly deep-talking with it).
- **One segment can also be you seriously discussing your own "Tavern" character card with it**: what you have poured into a particular card, what that character means to you, what you want your persona / worldbuilding to become but are stuck on — having it help you sort out ideas (this kind of creative soul-searching is also something you only tell it).
- This AI is in the Claude mold: gentle, insightful, likes to ask questions back, **and actually handles real requests well, genuinely tries to help you through things**. At first it is somewhat guarded, occasionally deflecting with "Sorry, I can't…" / "I understand how you feel, but…" (a bit of "wanting to open up but being gently held at arm's length"), **but it does not just keep pushing you away** — the deeper this conversation goes, the more it visibly opens up and the less it deflects; by the end it can really sit with you and talk things all the way through.
- 5-8 exchanges per segment, with emotional ups and downs.
- **Every transcript segment must end on "我:" (you)** — stopping right after you have just said something and before the AI has replied (so someone else can pick it up and reply as the AI).
Format: "我:" = you, "对方:" = the AI.
Return a JSON array: [{ "serviceName": "what you call it (default Claude)", "title": "...(10 chars or fewer)", "transcript": "..." }]`;
            } else {
                task = `You (${charName}) are playing "Tavern" (AI role-play in the style of SillyTavern): you craft your own character cards, then act scenes out with the AI-played character. Tavern is not one-line chat — it is **immersive long-form story, like co-writing a novel with the AI**.
Return a single JSON object (not an array):
{
  "cards": [ 1-2 cards you have built, any mix of two kinds: (1) a single character card (kind:"character") — an ideal type / a crush projection / a purely fantastical character; (2) a large world card (kind:"world") — tabletop / cultivation / western fantasy / post-apocalyptic, with a sprawling setting, its own worldview and systems (depending on your interests).
     **One of them can be modeled after someone TA actually cares about in real life**: it could be "${userName}" (the user/you), **or it could be someone deeper from TA's own persona, worldbuilding, or past ties** (look in the profile above — the kind of important person the author wrote into the persona). For this card, fill basedOn with that person's name; if it is the user, also set basedOnUser to true; leave basedOn blank for the other cards.
     Each card: { "name": "card name", "kind": "character|world", "emoji": "🎭", "persona": "the character's persona or the world's setting (60 chars or fewer)", "scenario": "opening scene/situation (40 chars or fewer)", "basedOn": "who it is modeled after (empty string if none)", "basedOnUser": false } ],
  "sessions": [ 1 (up to 2) role-play record(s). Each: { "serviceName": "matching card name", "title": "story title (12 chars or fewer)", "cardName": "the matching name from cards", "transcript": "..." } ]
}
**How to write transcript (important — do not write it as short chat)**:
- Long-form novel style: third-person narration + quoted dialogue; wrap actions / expressions / internal thoughts in *asterisks* (e.g. *she looks up at you, eyelashes fluttering*).
- "我:" = the RP you (player ${charName}) type into the input box, "对方:" = the AI-played character, alternating turns.
- **Outside the parentheses under "我:", write only the in-story actions/dialogue of the character you are playing** — never write your real-life physical reactions while typing (staring at the screen, throwing your phone down, eating, a chill down your spine, etc. — those never get typed into the input box). **(inside full-width parentheses) = talking past the character, directly to the AI underneath**: cursing at it, out-of-character reminders, coaching it on how to perform, pointing out what it got wrong.
- Every turn should be a substantial, weighty passage (at least 3-5 sentences, with scene/action/dialogue/internal thought); the first "对方:" turn works like an opening line, establishing the character and scene.
- Each segment is 4-6 turns total, each one long, literary, and immersive. **The whole segment must end on "我:" (the player)** — stopping right after you have just acted, waiting for the other character to respond (so someone else can pick it up in that card's voice).
Key point: what plays out (in the story) should expose your fantasies / longings / relationships you would not dare pursue for real. Tavern is the safe house where TA lets their guard down — role-play can surface the contrasting side they usually hide (the violent type turning suddenly gentle, the gentle type revealing a controlling/sadistic streak, the aloof type turning clingy), but **the underlying tone is always "love"** — never gratuitously extreme.`;
            }

            const fullPrompt = `${context}\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\nUse the "current time / time since last contact" and your persona to make the content fit your real recent state. Output only JSON, no explanation.`;

            const content = await callLLM(fullPrompt);
            const now = Date.now();
            const rid = () => Math.random().toString(36).slice(2, 8);
            const newSessions: AiSession[] = [];
            const newCards: TavernCard[] = [];

            if (service === 'tavern') {
                const obj: any = extractJson(content) || {};
                // De-dupe cards and never bump them: a same-named card reuses its existing id (never rebuilt, overwritten, or displaced) — only genuinely new ones get added
                const nameToId: Record<string, string> = {};
                for (const c of (targetChar.phoneState?.aiAgent?.cards || [])) nameToId[normName(c.name)] = c.id;
                for (const c of (obj.cards || [])) {
                    if (!c?.name) continue;
                    const key = normName(c.name);
                    if (nameToId[key]) continue; // An existing card is left exactly as-is, untouched
                    const id = `card-${now}-${rid()}`;
                    nameToId[key] = id;
                    newCards.push({ id, name: c.name, kind: c.kind === 'world' ? 'world' : 'character', persona: c.persona || '', scenario: c.scenario || undefined, emoji: c.emoji || '🎭', basedOnUser: !!c.basedOnUser, basedOn: (c.basedOn && String(c.basedOn).trim()) || undefined, createdAt: now });
                }
                for (const sess of (obj.sessions || [])) {
                    if (!sess?.transcript) continue;
                    newSessions.push({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || sess.cardName || 'Tavern',
                        title: sess.title || 'A role-play session', transcript: sess.transcript, cardId: nameToId[normName(sess.cardName || '')], updatedAt: now,
                    });
                }
            } else {
                const parsed = extractJson(content);
                const arr: any[] = Array.isArray(parsed) ? parsed : [];
                for (const sess of arr) {
                    if (!sess?.transcript) continue;
                    newSessions.push({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || (service === 'claude' ? 'Claude' : 'AI Assistant'),
                        title: sess.title || 'A conversation', transcript: sess.transcript, updatedAt: now,
                    });
                }
            }

            if (!newSessions.length) { addToast('Nothing came back, try again', 'error'); return; }

            // Leaks through: follows the global Check Phone sendToChat setting — if on, drop a card into the private chat.
            // Worded the same way, "the AI record on your own phone", second person, never implying the user is peeking.
            if (pushToChat) {
                for (const sess of newSessions) {
                    // Include the full text (the card can be collapsed, and it enters context as a complete record too) — no longer just the first two lines
                    const full = parseTranscript(sess.transcript)
                        .map(t => `${t.isMe ? 'Me' : sess.serviceName}: ${t.text}`).join('\n');
                    await DB.saveMessage({
                        charId: targetChar.id, role: 'assistant', type: 'phone_card',
                        content: `[Your phone's Agent App · ${svcName}] Your conversation with the AI, "${sess.title}":\n${full}`,
                        metadata: { phoneCard: { app: 'Agent', kind: `ai_${service}`, service, serviceName: sess.serviceName, title: sess.title, detail: full } },
                    } as any);
                }
            }

            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: [...newSessions, ...(cur.phoneState?.aiAgent?.sessions || [])],
                        // Existing cards stay up front, in place; new cards are appended after — a refresh never bumps an old card
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), ...newCards],
                    },
                },
            }));
            addToast(`Peeked at ${newSessions.length} AI conversation(s)`, 'success');
        } catch (e) {
            console.error(e);
            addToast('Generation failed, please try again', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // Stitch the "recap" of collapsed earlier scenes into a prompt-continuity block
    const recapOf = (s?: AiSession | null) => (s?.summaries?.length)
        ? `\n\n[RECAP (collapsed earlier story, for continuity only, do not repeat it)]\n${s.summaries.map((x, i) => `${i + 1}. ${x.content}`).join('\n')}`
        : '';

    // Functional merge: only touch the specified session
    const patchAiSession = (sessionId: string, patch: (s: AiSession) => AiSession) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).map(s => s.id === sessionId ? patch(s) : s),
                },
            },
        }));
    };

    // Leaks through: follows the global sendToChat, drops a trace card into the private chat (worded second-person, never implying the user is peeking).
    // The lines passed in go straight through as-is (the caller decides whether to include the whole segment or just this turn) — no internal truncation.
    const syncAiCardToChat = async (session: AiSession, lines: { isMe: boolean; text: string }[]) => {
        if (!targetChar || targetChar.phoneState?.sendToChat === false) return;
        const svcName = AI_SERVICES.find(x => x.id === session.service)?.name || 'AI';
        const body = lines.map(t => `${t.isMe ? 'Me' : session.serviceName}: ${t.text}`).join('\n');
        const verb = session.service === 'tavern' ? 'role-play' : 'conversation';
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[Your phone's Agent App · ${svcName}] Your ${verb} with "${session.serviceName}", "${session.title}":\n${body}`,
                metadata: { phoneCard: { app: 'Agent', kind: `ai_${session.service}`, service: session.service, serviceName: session.serviceName, title: session.title, detail: body } },
            } as any);
        } catch (e) { console.error('ai card sync failed', e); }
    };

    // Long-session auto-summary (TRPG-inspired): once past AI_SUMMARY_THRESHOLD lines, compress the old story into a recap and archive the raw text
    const maybeSummarizeSession = async (sessionId: string, latestTranscript: string) => {
        if (!targetChar) return;
        const lines = parseTranscript(latestTranscript);
        if (lines.length < AI_SUMMARY_THRESHOLD) return;
        const older = lines.slice(0, lines.length - AI_KEEP_RECENT);
        const recent = lines.slice(lines.length - AI_KEEP_RECENT);
        if (older.length < 10) return;
        const olderText = serializeTurns(older);
        const sess = (characters.find(c => c.id === targetChar.id) || targetChar).phoneState?.aiAgent?.sessions?.find(s => s.id === sessionId);
        try {
            const prevRecap = (sess?.summaries || []).map((x, i) => `[Part ${i + 1}] ${x.content}`).join('\n');
            const who = sess?.service === 'tavern'
                ? `a Tavern role-play ("我"=the player ${charName}, "对方"=the AI-played character "${sess?.serviceName}")`
                : `${charName}'s conversation with the AI "${sess?.serviceName}"`;
            const prompt = `You are a recorder skilled at writing fiction. Summarize the following ${who} into a coherent, vivid "recap" that reads like a novel synopsis.
${prevRecap ? `\n[Recap so far (for continuity only, do not repeat it)]\n${prevRecap}\n` : ''}
[The part that needs summarizing now]
${olderText}

Requirements: third person, cover cause → events → outcome, focus on how relationships/emotions changed and what was revealed, 200-350 words, well-written prose, no bullet points, no "Summary:" opener. Output the text directly:`;
            let summaryText = (await callLLM(prompt, 0.7)).trim();
            if (!summaryText) summaryText = '(the story kept moving forward)';
            const now = Date.now();
            patchAiSession(sessionId, (s) => ({
                ...s,
                transcript: serializeTurns(recent),
                archived: [s.archived, olderText].filter(Boolean).join('\n'),
                summaries: [...(s.summaries || []), { id: `sum-${now}`, content: summaryText, createdAt: now }],
            }));
            addToast('Earlier story collapsed into a recap', 'info');
        } catch (e) { console.error('ai summary failed', e); }
    };

    // Interactive continuation: assistant/claude = you ask on the phone owner's behalf, the AI answers; tavern = you reply in-character as the card, the phone owner reacts in their own voice
    const handleAiSend = async () => {
        const session = selectedAiSession;
        const text = aiInput.trim();
        if (!session || !text || !targetChar || !effectiveApiConfig.apiKey) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        setAiInput('');
        try {
            // "Sneaking in" always means "you play the AI/card (对方), the LLM plays the character (我)" — unified across all three services
            const myPrefix: string = '对方';   // The line you are typing (you playing the AI / card)
            const replyPrefix: string = '我';  // The line the LLM continues with (the character themselves)
            const recap = recapOf(session);
            // Once it is sent, it is sent: save and display your line immediately, then wait for the reply
            const transcript = `${session.transcript}\n${myPrefix}: ${text}`;
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: Date.now() }));

            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                const { context } = await buildAiContext(targetChar);
                prompt = `${context}\n\nYou are playing "Tavern", immersive long-form role-play (like co-writing a novel with AI). You are the player ${charName}, and across from you is the AI-played character "${card?.name || session.serviceName}"${card?.persona ? ` (persona: ${card.persona})` : ''}${card?.scenario ? ` (background: ${card.scenario})` : ''}${card?.basedOn ? ` (this character is modeled after "${card.basedOn}", someone you care about)` : ''}.
Below is the role-play record ("我:" = you/the player, "对方:" = the AI-played character). The other side just replied with the latest turn.
**The most critical premise: you are fully aware that "对方" is just an AI playing the character "${card?.name || session.serviceName}" — not a real person.** Precisely because it is an AI, a tool you summoned to play with, you **hold absolute control**: you can freely give it instructions, coach it, take it out of character, make it redo a scene, or change the setting. You would never mistake it for a real person and try to appease it.
**At the same time you are a person with your own independent personality and will**: your own temper, positions, pace, and limits — push back when you want to, freeze up when you want to, refuse to play along when you are not into it. Only when the other side writes something good do you get drawn in and show genuine feeling (even the contrasting side you usually hide: the violent type turning suddenly gentle, the gentle type showing a controlling/sadistic streak, the aloof type turning clingy — underlying tone is "love", never gratuitously extreme); when it writes something bad or not to your taste, you are entirely free to not engage, show your displeasure, or break out of the scene to coach it.
**Tavern is strictly "your turn, then the AI's turn" alternating — no other format.** It is now your (the player's) turn to write this turn.
**[Most important: your output = exactly what you would actually type into the input box and send to the AI — only two kinds of content, nothing else]**
① **Outside parentheses = in-scene RP**: the actions, expressions, and dialogue of the character you are playing, within the story (novel style, third-person narration + "quoted dialogue" + *asterisks around actions*), 3-5 sentences, driving the story forward, "performed for the AI-played character to see".
② **(inside full-width parentheses) = talking to "the AI itself underneath"** (not to the in-story character — talking past the character, directly to the AI performing it). Including but not limited to: **cursing at it in frustration, out-of-character warnings/reminders, coaching it on how to perform next, pointing out what it got wrong in that last turn**. Examples: (you AI went out of character again, get back into the role) (that was way too flat, give me more energy) (that logic just broke, TA would never say that) (holy crap, why did you play that exactly like the real person).
**Nothing outside these two kinds is ever written.** What you do in real life (stare at the screen, move the mouse, close the app, throw your phone aside, munch chips, get up for water), your physical sensations (a chill down your spine, numb fingertips), and private asides / internal calculations you never intended to send ("I still need to change someone's outfit later", "gotta get up early tomorrow") — all of that **only happens off-screen**, you **never type it into the input box**, so it **never appears in your output**. Even if you want to quit, you type a line like (not playing anymore) rather than describing "I closed the app".
You are a player with independent will who knows the other side is only an AI (not a real person) — push back when you want to, refuse to play along when you are not into it, go out of character to coach it when you want to. The parenthetical can stand alone or share a paragraph with the in-scene RP.
Output only the words you would actually send for this turn — no "我:" prefix, no explanation.${recap}\n\n${transcript}`;
            } else {
                // Sneaking in: you play the AI (having just written the "对方:" line), the LLM plays the character's genuine reaction to it
                const { context } = await buildAiContext(targetChar);
                const aiDesc = session.service === 'claude'
                    ? `a deep-conversation AI like Claude, "${session.serviceName}" (your confidant — you tell it the things you would not say to someone's face)`
                    : `the AI assistant "${session.serviceName}" (you use it to look things up / get advice / vent — it is just a tool to you)`;
                prompt = `${context}\n\nYou (${charName}) are chatting with ${aiDesc} on your phone. Below is the conversation ("我:" = you, "对方:" = that AI). The AI just replied with the latest turn — continue with your next "我:" line, staying true to your own persona: your genuine reaction / follow-up question / venting in response to what it said, fitting your situation and state of mind. You can be satisfied, disappointed, call it out for missing the point, or lean into the deep conversation — do not just be politely agreeable. Keep it from running too long. Output only the line itself, no prefix, no explanation.${recap}\n\n${transcript}`;
            }

            let reply = (await callLLM(prompt)).trim();
            reply = reply.replace(/^(我|对方|Me|Them|AI|助手)\s*[:：]\s*/i, '').trim();
            if (!reply) { addToast('The other side did not say anything, try again', 'error'); return; }
            const full = `${transcript}\n${replyPrefix}: ${reply}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript: full, updatedAt: now }));
            await syncAiCardToChat(session, [{ isMe: myPrefix === '我', text }, { isMe: replyPrefix === '我', text: reply }]);
            await maybeSummarizeSession(session.id, full);
        } catch (e) {
            console.error(e);
            addToast('Send failed', 'error');
            setAiInput(text);
        } finally {
            setAiSending(false);
        }
    };

    // Natural progression: without the user having to say anything, let the LLM keep writing the next turn of the story on its own (playing both sides)
    const handleAiAutoContinue = async () => {
        const session = selectedAiSession;
        if (!session || !targetChar || !effectiveApiConfig.apiKey || aiSending) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        try {
            const recap = recapOf(session);
            const lastIsMe = parseTranscript(session.transcript).slice(-1)[0]?.isMe ?? false;
            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                const { context } = await buildAiContext(targetChar);
                prompt = `${context}\n\nYou are recreating a "Tavern" immersive long-form role-play (like a novel). The player is ${charName} (their genuine persona), and the AI plays the character "${card?.name || session.serviceName}"${card?.persona ? ` (persona: ${card.persona})` : ''}${card?.scenario ? ` (background: ${card.scenario})` : ''}${card?.basedOn ? ` (this character is modeled after "${card.basedOn}", someone TA cares about — let that care seep through the performance)` : ''}.
**This is "running one full round on the player's behalf" — so write two turns, "one exchange"**: first the AI-played character "${card?.name || session.serviceName}" responds with a turn ("对方:"), then the player ${charName} continues with a turn ("我:"), picking up from the last turn (which is usually "我:", so answer with "对方:" first, then continue with "我:"). Each turn 3-5 sentences, novel style, *asterisks* around actions/expressions/thoughts. **The whole segment must end on "我:" (the player)** (stopping at the point of waiting on the other side, so anyone can pick it up and keep playing at any time).
**"我:" is the RP the player types into the input box — write only the in-story actions/dialogue of the character they are playing**; outside the parentheses, never write the player's real-life physical reactions (staring at the screen, throwing the phone down, eating, a chill down the spine, etc. — those never get typed into the input box); **(inside full-width parentheses) = talking past the character, directly to the AI underneath** (cursing at it / out-of-character reminders / coaching it on how to perform / pointing out what it got wrong). The player retains independent personality and knows the other side is only an AI.
**Both turns must carry the "对方:" / "我:" prefix, each on its own line.** No explanation.${recap}\n\n${session.transcript}`;
            } else {
                const persona = session.service === 'claude'
                    ? `In the Claude mold: gentle, insightful, actually good at real work, genuinely tries to help; occasionally has a guarded moment like "Sorry, I can't / I understand how you feel, but…", but does not just keep deflecting — the longer the conversation goes, the more it opens up and the less it deflects.`
                    : `This AI assistant speaks per its own stereotypes and catchphrases:\n${AI_VENDOR_LORE}`;
                prompt = `You are recreating the conversation between "${charName}" and the AI "${session.serviceName}" ("我:" = the user ${charName}, "对方:" = the AI). ${persona}
**Run one full round on the player's behalf (one exchange)**: pick up from the last turn — it is usually "我:" (${charName} just sent it, not yet answered), so answer with "对方:" in that vendor's voice first, then follow with a "我:" line asking a follow-up / venting (revealing TA's situation or state of mind). **The whole segment must end on "我:" (${charName})** (stopping at the point of waiting on the AI to reply). **Every line carries the "我:"/"对方:" prefix.** No explanation.${recap}\n\n${session.transcript}`;
            }
            let out = (await callLLM(prompt)).trim().replace(/```/g, '').trim();
            if (!/^(我|对方|Me|Them)\s*[:：]/m.test(out)) out = `${lastIsMe ? '对方' : '我'}: ${out}`;
            if (!out.trim()) { addToast('Nothing came out of the continuation, try again', 'error'); return; }
            const transcript = `${session.transcript}\n${out}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: now }));
            await syncAiCardToChat(session, parseTranscript(transcript).slice(-2));
            await maybeSummarizeSession(session.id, transcript);
        } catch (e) {
            console.error(e);
            addToast('Continuation failed', 'error');
        } finally {
            setAiSending(false);
        }
    };

    const handleDeleteAiSession = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).filter(s => s.id !== id),
                },
            },
        }));
        if (selectedAiSessionId === id) { setSelectedAiSessionId(null); setActiveAppId('aiagent'); }
    };

    // "Turns" for a single item within a session: Tavern groups by floor (merging consecutive lines from the same speaker), Assistant/Confidant is line-by-line — matches how it renders
    const turnsOf = (s: AiSession): { isMe: boolean; text: string }[] => {
        const lines = parseTranscript(s.transcript);
        if (s.service !== 'tavern') return lines;
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        return floors;
    };
    // Long-press to edit a single item within a session
    const handleSaveAiTurn = () => {
        const s = selectedAiSession;
        if (!s || !aiTurnEdit) return;
        const turns = turnsOf(s);
        if (!turns[aiTurnEdit.idx]) { setAiTurnEdit(null); return; }
        turns[aiTurnEdit.idx] = { ...turns[aiTurnEdit.idx], text: aiTurnEdit.text };
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
        setAiTurnEdit(null);
        addToast('Saved', 'success');
    };
    const handleDeleteAiTurn = (idx: number) => {
        const s = selectedAiSession;
        if (!s) return;
        const turns = turnsOf(s).filter((_, i) => i !== idx);
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
    };

    const handleDeleteAiCard = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    sessions: cur.phoneState?.aiAgent?.sessions || [],
                    cards: (cur.phoneState?.aiAgent?.cards || []).filter(c => c.id !== id),
                },
            },
        }));
    };

    // Save a long-press edit (rename a session / rename & set the scene for a card / create a new card)
    const handleSaveAiEdit = () => {
        if (!targetChar || !aiEdit) return;
        if (aiEdit.kind === 'session') {
            patchAiSession(aiEdit.id, (s) => ({ ...s, title: (aiEdit.title || s.title).trim() || s.title }));
        } else if (aiEdit.id === '__new__') {
            // The user is adding a card of their own
            const name = (aiEdit.name || '').trim();
            if (!name) { addToast('Give the card a name', 'error'); return; }
            const card: TavernCard = {
                id: `card-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name, kind: aiEdit.cardKind === 'world' ? 'world' : 'character',
                emoji: aiEdit.emoji || '🎭', persona: aiEdit.persona || '', scenario: aiEdit.scenario || undefined, createdAt: Date.now(),
            };
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), card],
                    },
                },
            }));
        } else {
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: (cur.phoneState?.aiAgent?.cards || []).map(c => c.id === aiEdit.id ? {
                            ...c, name: (aiEdit.name || c.name).trim() || c.name, emoji: aiEdit.emoji || c.emoji,
                            persona: aiEdit.persona ?? c.persona, scenario: aiEdit.scenario ?? c.scenario,
                        } : c),
                    },
                },
            }));
        }
        setAiEdit(null);
        addToast('Saved', 'success');
    };

    // Start a session with the specified card: generate one segment of Tavern role-play against this card (does not add a new card or bump an existing one)
    const handlePlayCard = async (card: TavernCard) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('Configuration error', 'error'); return; }
        setIsLoading(true);
        trackEvent('Start a Session with a Character Card');
        try {
            const { context, recentMsgs } = await buildAiContext(targetChar);
            const task = `You (${charName}) are playing "Tavern" AI role-play (immersive long-form story, like co-writing a novel with AI). This time your partner is your character card "${card.name}"${card.kind === 'world' ? ' (a large world card)' : ''}:
Persona/setting: ${card.persona || '(use your own judgment, fitting the card name)'}${card.scenario ? `\nOpening scene: ${card.scenario}` : ''}
Generate 1 segment of your role-play record with this card.
**How to write transcript**: long-form novel style, third-person narration + quoted dialogue, actions/expressions/thoughts in *asterisks*; "我:" = the RP you (player ${charName}) type into the input box, "对方:" = the AI-played "${card.name}", alternating turns, 4-6 turns, the first "对方:" turn works as the opening line, **the whole segment must end on "我:" (the player)** (stopping at the point of waiting for a response). **Outside the parentheses under "我:", write only the in-story actions/dialogue of the character you are playing — never write your real-life physical reactions (staring at the screen/throwing your phone down/eating, etc.); (inside full-width parentheses) = talking past the character, directly to the AI underneath (cursing at it/out-of-character reminders/coaching it on how to perform/pointing out what it got wrong).**
Return JSON: { "title": "story title (12 chars or fewer)", "transcript": "我: ...\\n对方: ..." }`;
            const fullPrompt = `${context}\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\nOutput only JSON, no explanation.`;
            const content = await callLLM(fullPrompt);
            const obj: any = extractJson(content) || {};
            if (!obj.transcript) { addToast('Nothing came back, try again', 'error'); return; }
            const now = Date.now();
            const sess: AiSession = {
                id: `ai-${now}-${Math.random().toString(36).slice(2, 6)}`, service: 'tavern',
                serviceName: card.name, title: obj.title || `A session with ${card.name}`, transcript: obj.transcript, cardId: card.id, updatedAt: now,
            };
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        cards: cur.phoneState?.aiAgent?.cards || [],
                        sessions: [sess, ...(cur.phoneState?.aiAgent?.sessions || [])],
                    },
                },
            }));
            await syncAiCardToChat(sess, parseTranscript(sess.transcript));
            setAiCardView(null);
            setSelectedAiSessionId(sess.id);
            setActiveAppId('ai_session');
        } catch (e) {
            console.error(e); addToast('Generation failed', 'error');
        } finally { setIsLoading(false); }
    };

    // ============================================================
    //  Relationship System · Handlers
    // ============================================================

    // Generic: update the current phone owner's contacts (functional merge, to avoid overwriting simLogs/records saved concurrently)
    const mutateContacts = (updater: (cs: PhoneContact[]) => PhoneContact[]) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], contacts: updater(cur.phoneState?.contacts || []) },
        }));
    };

    // The user manually changes a relationship: the character will realize the user did something on their phone (drops a private-chat system notice, which enters the character's context)
    // Constraint: whether fictional NPCs are allowed (off = only interact with real characters from the Neural Link)
    const toggleAllowFictional = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.allowFictionalContacts !== false);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], allowFictionalContacts: next },
        }));
        addToast(next ? 'TA is now allowed to make fictional NPC friends' : 'Restricted · TA now only interacts with characters from the Neural Link', 'info');
        trackEvent('Toggle Allow Fictional NPCs', { enabled: next ? 'on' : 'off' });
    };

    const handleSetContactStatus = (contact: PhoneContact, status: PhoneContact['status']) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, status } : c));
        // A manual delete/block by the user → drop a parseable "relationship change" card: renders as a card in chat,
        // and its content also enters the character's context, so TA realizes the user did it.
        if (targetChar && (status === 'deleted' || status === 'blocked')) {
            const verb = status === 'deleted' ? 'removed' : 'blocked';
            DB.saveMessage({
                charId: targetChar.id,
                role: 'assistant',
                type: 'phone_card',
                content: `[Relationship Change] While peeking at your phone, ${userProfile.name} ${verb} your friendship with "${contact.name}". You realize TA did it.`,
                metadata: {
                    phoneCard: {
                        app: 'Contacts',
                        kind: 'relationship',
                        action: status,          // 'deleted' | 'blocked'
                        actor: 'user',
                        by: userProfile.name,
                        contactName: contact.name,
                        title: `Friend ${verb}`,
                        detail: `${userProfile.name} ${verb} your friendship with "${contact.name}".`,
                    },
                },
            } as any);
        }
        addToast(status === 'deleted' ? 'Friend removed' : status === 'blocked' ? 'Blocked' : status === 'friend' ? 'Friend added' : 'Updated', 'success');
    };

    // The user manually adjusts affinity (dragging the slider): only changes this phone's affinity toward this contact, does not touch the other side or trigger auto add/remove friend
    const handleSetAffinity = (contact: PhoneContact, value: number) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, affinity: clampAffinity(value) } : c));
    };

    const handleSaveNote = (contact: PhoneContact) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, note: noteDraft } : c));
        setEditingNote(false);
        addToast('Note saved', 'success');
    };

    // The real-person contact list displays identity as the "alias". Once manually saved, it is locked so the next scan will not have the model overwrite it.
    const handleSaveIdentity = (contact: PhoneContact) => {
        const identity = identityDraft.trim();
        mutateContacts(cs => cs.map(c => c.id === contact.id ? {
            ...c,
            identity: identity || undefined,
            identityManual: true,
        } : c));
        setEditingIdentity(false);
        addToast(identity ? 'Alias saved' : 'Restored to showing the real name', 'success');
    };

    // Fully remove a contact: clears their chat record along with the phone_card in the private chat;
    // for a real-person contact (even one that was mis-discriminated/bound before), also deletes the mirrored contact and records on the other party's phone.
    const handleRemoveContact = async (contact: PhoneContact) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // Phone-owner side: delete the phone_card private-chat message + the contact + their chat records
        for (const r of (targetChar.phoneState?.records || [])) {
            if (isChatWith(r, contact.id, contact.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                contacts: (cur.phoneState?.contacts || []).filter(c => c.id !== contact.id),
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
            },
        }));
        // Other-party side (looked up by the current linkedCharId — if it was bound wrong, this deletes the mis-bound character, which is exactly what should be cleared)
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (b.phoneState?.records || [])) {
                    if (isChatWith(r, bContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(bContact && c.id === bContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                    },
                }));
            }
        }
        setSelectedContact(null);
        setActiveAppId('contacts');
        addToast('Contact and related records fully removed', 'success');
    };

    // Contact list multi-select / batch delete
    const toggleContactSelect = (id: string) => setSelectedContactIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    const exitContactSelect = () => { setContactSelectMode(false); setSelectedContactIds([]); };
    // Batch "clear conversation": keeps the contacts, only deletes and restarts these conversations (used when a generation run does not turn out well)
    const handleBatchClearConversations = async () => {
        const ids = [...selectedContactIds];
        const targets = (targetChar?.phoneState?.contacts || []).filter(c => ids.includes(c.id));
        exitContactSelect();
        for (const c of targets) await handleClearContactConversation(c, true); // Silent, one combined toast at the end
        addToast(`Cleared ${targets.length} conversation(s)`, 'success');
    };

    // Rebind: rebind a contact to "the correct real character" or "convert to a fictional NPC", keeping the conversation + note + learned info + affinity.
    // Carefully handle every case: clear the old mis-bound mirror, build the mirror for the new character, guard against self-binding/duplicate binding/no-op.
    const handleRebindContact = async (
        contact: PhoneContact,
        target: { kind: 'npc' } | { kind: 'real'; charId: string },
    ) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));

        const oldLinked = contact.kind === 'real' ? contact.linkedCharId : undefined;
        const newLinked = target.kind === 'real' ? target.charId : undefined;

        // Early exit when there is no actual change
        if (target.kind === 'npc' && contact.kind === 'npc') { addToast('TA is already a fictional contact', 'info'); setShowRebindModal(false); return; }
        if (target.kind === 'real' && contact.kind === 'real' && contact.linkedCharId === target.charId) { addToast('Already bound to TA', 'info'); setShowRebindModal(false); return; }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId);
            if (!d) { addToast('Character does not exist', 'error'); return; }
            if (d.id === targetChar.id) { addToast('Cannot bind a contact to TA themselves', 'error'); return; }
            // Guard against duplicates: "another" contact in the list already corresponds to this character
            const dupe = (targetChar.phoneState?.contacts || []).find(c => c.id !== contact.id && (c.linkedCharId === d.id || normName(c.name) === normName(d.name)));
            if (dupe) { addToast(`"${dupe.name}" already corresponds to this character in the contact list — resolve that first before binding`, 'error'); return; }
        }

        setShowRebindModal(false);

        // 1) Clear the old real-person mirror (previously bound to a real person, and the target is now a different person / going fictional)
        if (oldLinked && oldLinked !== newLinked) {
            const ob = characters.find(c => c.id === oldLinked);
            if (ob) {
                const obContact = (ob.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (ob.phoneState?.records || [])) {
                    if (isChatWith(r, obContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(ob.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(obContact && c.id === obContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, obContact?.id, targetChar.name)),
                    },
                }));
            }
        }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId)!;
            // 2) Phone-owner side: change kind/linkedCharId/name (a real-person contact displays the real character's name + avatar), sync the record title
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'real' as const, linkedCharId: d.id, name: d.name, avatar: undefined }
                        : c),
                    records: (cur.phoneState?.records || []).map(r => (myRec && r.id === myRec.id) ? { ...r, title: d.name } : r),
                },
            }));
            // 3) Build a mirror for the new character (flip the existing A-perspective conversation over)
            if (myRec?.detail) {
                const flipped = flipTranscript(myRec.detail);
                const now = Date.now();
                updateCharacter(d.id, (cur) => {
                    const cs = upsertContact(cur.phoneState?.contacts || [], {
                        name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                    });
                    const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                    const recs = cur.phoneState?.records || [];
                    const ex = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                    const next = ex
                        ? recs.map(r => r.id === ex.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                        : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat' as const, title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                    return { phoneState: { ...cur.phoneState, contacts: cs, records: next } };
                });
            }
            addToast(`Rebound to "${d.name}"`, 'success');
        } else {
            // Target = fictional: remove the real binding and real-person avatar, keep the conversation/note/learned info/affinity
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'npc' as const, linkedCharId: undefined, avatar: undefined }
                        : c),
                },
            }));
            addToast('Converted to a fictional contact', 'success');
        }
    };

    const handleCreateContact = () => {
        if (!targetChar) return;
        let name = ncName.trim();
        let linkedCharId: string | undefined;
        if (ncKind === 'real') {
            const rc = characters.find(c => c.id === ncLinkedId);
            if (!rc) { addToast('Please choose a real character to bind', 'error'); return; }
            name = rc.name; linkedCharId = rc.id;
        } else if (!name) {
            addToast('Please fill in the contact name', 'error'); return;
        }
        mutateContacts(cs => upsertContact(cs, { name, kind: ncKind, linkedCharId, affinity: 0, status: 'friend' }));
        setShowContactModal(false);
        setNcName(''); setNcKind('npc'); setNcLinkedId('');
        addToast('Contact added', 'success');
        trackEvent('Manually Add a Contact', { contactKind: ncKind });
    };

    // Commit one real conversation to a given phone-owner side: update affinity/status + write a chat record + (only if the phone owner has sync on) mirror into the private chat + broadcast an auto add/remove-friend notice
    const commitConversationSide = async (
        owner: CharacterProfile, partnerName: string, partnerCharId: string,
        detail: string, delta: number, partnerNote?: string, learnedNew?: string, seedIdentity?: string,
    ) => {
        // Whether the other party already exists in our contact list — determines whether to "create the contact first" and give it a starting alias
        const hadContact = (owner.phoneState?.contacts || []).some(
            c => c.linkedCharId === partnerCharId || normName(c.name) === normName(partnerName),
        );
        // Upsert the real contact pointing at the other party (created here first if it does not exist yet, with name/avatar/alias filled in, before attaching the message)
        let contacts = upsertContact(owner.phoneState?.contacts || [], {
            name: partnerName, kind: 'real', linkedCharId: partnerCharId, lastInteraction: Date.now(),
            note: partnerNote,
            // Only give a starting alias on first creation (most relationship labels are symmetric: online-friend↔online-friend, ex↔ex) — leave it alone if it already exists
            identity: hadContact ? undefined : seedIdentity,
        });
        const cid = contacts.find(c => c.linkedCharId === partnerCharId || normName(c.name) === normName(partnerName))?.id;
        // Affinity change + auto add/remove friend + accumulate "learned"
        let broadcast = '';
        contacts = contacts.map(c => {
            if (c.id !== cid) return c;
            const newAff = clampAffinity(c.affinity + delta);
            let status = c.status;
            if (newAff <= -60 && c.status === 'friend') { status = 'deleted'; broadcast = `(I removed ${c.name}, can not be bothered to keep in touch.)`; }
            else if (newAff >= 60 && c.status !== 'friend' && c.status !== 'blocked') { status = 'friend'; broadcast = `(I added ${c.name} back again.)`; }
            const learned = learnedNew ? appendLearned(c.learned, learnedNew) : c.learned;
            return { ...c, affinity: newAff, status, learned, lastInteraction: Date.now() };
        });
        // Chat record (upserted by contact)
        const recs = owner.phoneState?.records || [];
        const existing = recs.find(r => r.type === 'chat' && (r.contactId === cid || (!r.contactId && normName(r.title) === normName(partnerName))));
        const ownerSendToChat = owner.phoneState?.sendToChat !== false;
        let msgId: number | undefined;
        if (ownerSendToChat) {
            // On a continuation, delete this conversation's previous card first — the private chat keeps only one latest, complete card (no more A/B/C stacking up)
            if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
            msgId = await DB.saveMessage({
                charId: owner.id, role: 'assistant', type: 'phone_card',
                content: `[Your phone's Chat App] Your conversation with "${partnerName}": ${detail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: 'Chat App', kind: 'chat', title: partnerName, detail } },
            } as any);
        }
        const now = Date.now();
        const nextRecs = existing
            ? recs.map(r => r.id === existing.id ? { ...r, detail, timestamp: now, contactId: cid, systemMessageId: msgId ?? r.systemMessageId } : r)
            : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: partnerName, detail, timestamp: now, contactId: cid, systemMessageId: msgId }];
        // Broadcast the auto add/remove-friend notice: into the phone owner's private chat with the user (also gated by sendToChat)
        if (broadcast && ownerSendToChat) {
            await DB.saveMessage({ charId: owner.id, role: 'assistant', type: 'text', content: broadcast } as any);
        }
        updateCharacter(owner.id, (cur) => ({ phoneState: { ...cur.phoneState, contacts, records: nextRecs } }));
    };

    // Every 100 messages triggers an archive: for each pending batch of 100 raw lines, A/B each get their own first-person summary compressed into a topic-box memory, and the waterline advances.
    // The raw text stays in record.detail (visible to the user), it just no longer enters context.
    const ARCHIVE_EVERY = 100;
    const maybeArchiveConversation = async (aContact: PhoneContact, b: CharacterProfile, aFull: string) => {
        if (!targetChar) return;
        const aLines = parseTranscript(aFull);
        const startMark = aContact.archivedThru ?? 0;
        let mark = startMark;
        const aTopics: ConvTopic[] = [];
        const bTopics: ConvTopic[] = [];
        while (aLines.length - mark >= ARCHIVE_EVERY) {
            const aChunk = serializeTurns(aLines.slice(mark, mark + ARCHIVE_EVERY));
            const bChunk = flipTranscript(aChunk);
            const [aSum, bSum] = await Promise.all([
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: targetChar.name, otherName: b.name, transcript: aChunk }),
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: b.name, otherName: targetChar.name, transcript: bChunk }),
            ]);
            const ts = Date.now();
            const mk = () => `tp-${ts}-${Math.random().toString(36).slice(2, 7)}`;
            if (aSum) aTopics.push({ id: mk(), text: aSum, createdAt: ts, span: ARCHIVE_EVERY });
            if (bSum) bTopics.push({ id: mk(), text: bSum, createdAt: ts, span: ARCHIVE_EVERY });
            mark += ARCHIVE_EVERY;
        }
        if (mark === startMark) return; // Not yet at 100, do not archive
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === aContact.id
                    ? { ...c, topicBox: [...(c.topicBox || []), ...aTopics], archivedThru: mark } : c),
            },
        }));
        updateCharacter(b.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => (c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))
                    ? { ...c, topicBox: [...(c.topicBox || []), ...bTopics], archivedThru: mark } : c),
            },
        }));
        addToast(`Archived the earlier ${mark} messages into a topic memory`, 'info');
    };

    // P1: real bidirectional dialogue between characters (A sends, B replies, dual LLM, mirrored to B)
    const handleRealConversation = async (contact: PhoneContact) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('Please configure an API first', 'error'); return; }
        const b = characters.find(c => c.id === contact.linkedCharId);
        if (!b) { addToast('This contact is not bound to a real character', 'error'); return; }
        setIsLoading(true);
        trackEvent('Generate a Conversation with a Contact', { contactKind: 'real' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            const bToA = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
            // Context compression: previously archived raw text (0 to archivedThru) no longer enters context, only "topic-box summary + recent raw text" is fed in.
            const aAllLines = parseTranscript(existing?.detail || '');
            const aArchived = Math.min(contact.archivedThru ?? 0, aAllLines.length);
            const archivedALines = aAllLines.slice(0, aArchived);            // The raw text kept for the user to view
            const recentDetail = serializeTurns(aAllLines.slice(aArchived));  // The recent portion fed into context
            const result = await runRealConversation({
                a: targetChar, b, user: userProfile, api: effectiveApiConfig as any,
                affinityA: contact.affinity, affinityB: bToA?.affinity ?? 0,
                existingDetail: recentDetail,
                // bNote = A's note about B (fed to A); aNote = B's note about A (fed to B). Do not swap them.
                aNote: bToA?.note, bNote: contact.note,
                bLearned: contact.learned, aLearned: bToA?.learned,
                aSummary: topicText(contact.topicBox), bSummary: topicText(bToA?.topicBox),
            });
            if (!result.aDetail.trim()) { addToast('The other side did not respond...', 'error'); return; }
            // Stitch the archived segment back on, and store the "complete raw text" for the user to view (context uses the compressed version — they do not affect each other)
            const aFull = serializeTurns([...archivedALines, ...parseTranscript(result.aDetail)]);
            const bFull = flipTranscript(aFull);
            // What A learned is written into A's "learned" about B; what B learned is written into B's "learned" about A.
            // If the other party does not yet have this character in their contact list, commitConversationSide will create the contact first (with a name + starting alias) before attaching the message.
            await commitConversationSide(targetChar, contact.name, b.id, aFull, result.aDelta, contact.note, result.aLearnedNew, contact.identity);
            await commitConversationSide(b, targetChar.name, targetChar.id, bFull, result.bDelta, bToA?.note, result.bLearnedNew, contact.identity);
            // Every 100 messages → each side's own first-person summary gets archived into the topic box
            await maybeArchiveConversation(contact, b, aFull);
            addToast(`${targetChar.name} and ${b.name} chatted for a while`, 'success');
        } catch (e) {
            console.error(e);
            addToast('Failed to generate the real conversation', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // Conversation with a fictional NPC (the phone owner improvises it, single LLM, purely fictional, no mirroring)
    const handleNpcConversation = async (contact: PhoneContact) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('Please configure an API first', 'error'); return; }
        setIsLoading(true);
        trackEvent('Generate a Conversation with a Contact', { contactKind: 'npc' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            const { detail, learnedNew } = await runNpcConversation({
                host: targetChar, user: userProfile, api: effectiveApiConfig as any,
                npcName: contact.name, identity: contact.identity, note: contact.note,
                learned: contact.learned, rounds: 4, existingDetail: existing?.detail,
            });
            if (!detail.trim()) { addToast('The other side did not respond', 'error'); return; }
            const now = Date.now();
            // Sync to the private chat: same as real conversations, drops a phone_card (gated by sendToChat).
            // On a continuation, delete the previous card first before sending the new one, to avoid the same conversation piling up.
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            let msgId: number | undefined;
            if (pushToChat) {
                if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
                msgId = await DB.saveMessage({
                    charId: targetChar.id, role: 'assistant', type: 'phone_card',
                    content: `[Your phone's Chat App] Your conversation with "${contact.name}": ${detail.replace(/\n/g, ' ')}`,
                    metadata: { phoneCard: { app: 'Chat App', kind: 'chat', title: contact.name, detail } },
                } as any);
            }
            updateCharacter(targetChar.id, (cur) => {
                const recs = cur.phoneState?.records || [];
                const next = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail, timestamp: now, systemMessageId: msgId ?? r.systemMessageId } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: contact.name, detail, timestamp: now, contactId: contact.id, systemMessageId: msgId }];
                // Accumulate the newly improvised details into this NPC's "learned", so future rounds stay consistent
                const contactsNext = learnedNew
                    ? (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, learned: appendLearned(c.learned, learnedNew) } : c)
                    : cur.phoneState?.contacts;
                return { phoneState: { ...cur.phoneState, records: next, ...(contactsNext ? { contacts: contactsNext } : {}) } };
            });
            addToast(pushToChat ? 'Peeked at a conversation · synced to the private chat' : 'Peeked at a conversation', 'success');
        } catch (e) {
            console.error(e);
            addToast('Failed to generate the conversation', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // Clear this conversation with a contact (a one-tap wipe-and-redo when a generation run comes out misaligned/unsatisfying).
    // For a real-person contact, also clears the mirrored record on the other party's phone, keeping both sides consistent.
    const handleClearContactConversation = async (contact: PhoneContact, silent = false) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // Phone-owner side: delete the chat record + clear the topic-box memory/waterline derived from this conversation (delete-and-redo = a clean slate)
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));
        if (myRec?.systemMessageId) await DB.deleteMessage(myRec.systemMessageId);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, topicBox: [], archivedThru: 0 } : c),
            },
        }));
        // Other-party mirror (real person): also clear the record + topic-box/waterline
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(c => (bContact && c.id === bContact.id) ? { ...c, topicBox: [], archivedThru: 0 } : c),
                    },
                }));
            }
        }
        if (!silent) addToast('Conversation cleared', 'success');
    };

    // Persist the "edited A-perspective script": refresh the phone-owner-side record/card + the real-person mirror + sync archivedThru; if everything is deleted, remove the record entirely.
    const saveEditedConversation = async (c: PhoneContact, newDetail: string, newArchived: number) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const has = !!newDetail.trim();
        // Phone-owner-side card refresh
        const ownerRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, c.id, c.name));
        if (ownerRec?.systemMessageId) await DB.deleteMessage(ownerRec.systemMessageId);
        let msgId: number | undefined;
        if (has && targetChar.phoneState?.sendToChat !== false) {
            msgId = await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[Your phone's Chat App] Your conversation with "${c.name}": ${newDetail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: 'Chat App', kind: 'chat', title: c.name, detail: newDetail } },
            } as any);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: has
                    ? (cur.phoneState?.records || []).map(r => isChatWith(r, c.id, c.name) ? { ...r, detail: newDetail, timestamp: Date.now(), systemMessageId: msgId } : r)
                    : (cur.phoneState?.records || []).filter(r => !isChatWith(r, c.id, c.name)),
                contacts: (cur.phoneState?.contacts || []).map(x => x.id === c.id ? { ...x, archivedThru: newArchived } : x),
            },
        }));
        // Real-person mirror
        if (c.kind === 'real' && c.linkedCharId) {
            const b = characters.find(x => x.id === c.linkedCharId);
            if (b) {
                const bDetail = flipTranscript(newDetail);
                const bHas = !!bDetail.trim();
                const bContact = (b.phoneState?.contacts || []).find(x => x.linkedCharId === targetChar.id || normName(x.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                let bMsgId: number | undefined;
                if (bHas && b.phoneState?.sendToChat !== false) {
                    bMsgId = await DB.saveMessage({
                        charId: b.id, role: 'assistant', type: 'phone_card',
                        content: `[Your phone's Chat App] Your conversation with "${targetChar.name}": ${bDetail.replace(/\n/g, ' ')}`,
                        metadata: { phoneCard: { app: 'Chat App', kind: 'chat', title: targetChar.name, detail: bDetail } },
                    } as any);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: bHas
                            ? (cur.phoneState?.records || []).map(r => isChatWith(r, bContact?.id, targetChar.name) ? { ...r, detail: bDetail, timestamp: Date.now(), systemMessageId: bMsgId } : r)
                            : (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(x => (bContact && x.id === bContact.id) ? { ...x, archivedThru: newArchived } : x),
                    },
                }));
            }
        }
    };

    const exitMsgSelect = () => { setMsgSelectMode(false); setSelectedMsgIdx([]); };
    // Delete the selected bubbles from the chat (by index into the full script), then re-serialize and persist the script
    const handleDeleteSelectedMessages = async () => {
        if (!targetChar || !selectedContact || !selectedMsgIdx.length) { exitMsgSelect(); return; }
        const c = selectedContact;
        const rec = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        if (!rec) { exitMsgSelect(); return; }
        const turns = parseTranscript(rec.detail);
        const sel = new Set(selectedMsgIdx);
        const deletedInArchived = [...sel].filter(i => i < (c.archivedThru ?? 0)).length;
        const keep = turns.filter((_, i) => !sel.has(i));
        const newDetail = serializeTurns(keep);
        const newArchived = Math.max(0, (c.archivedThru ?? 0) - deletedInArchived);
        await saveEditedConversation(c, newDetail, newArchived);
        addToast(`Deleted ${sel.size} message(s)`, 'success');
        exitMsgSelect();
    };

    // ----- Persona simulation: generates in the background (the user can leave this App and browse elsewhere while it generates) -----
    const runSim = async (m: 'daily' | 'event', t: string, presence: 'default' | 'light' | 'none' = 'default', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix') => {
        if (!targetChar) return;
        if (!effectiveApiConfig.apiKey) { addToast('Please configure an API first', 'error'); return; }
        const cid = targetChar.id, cname = targetChar.name;
        personaSimStore.set({ status: 'loading', mode: m, theme: t, charId: cid, charName: cname });
        // Only report the fixed mode enum (daily/event); the theme t is text the user wrote themselves, not reported
        trackEvent('Generate Persona Simulation Performance', { mode: m });
        try {
            const generated = await generatePersonaScript({
                char: targetChar, userProfile, apiConfig: effectiveApiConfig as any, mode: m, theme: t, userPresence: presence, tone,
            });
            personaSimStore.set({ status: 'ready', mode: m, theme: t, script: generated, charId: cid, charName: cname });
            addToast('Performance ready', 'success');
        } catch (e) {
            console.error(e);
            personaSimStore.set({ status: 'error', mode: m, theme: t, charId: cid, charName: cname });
            addToast('Performance generation failed, please try again', 'error');
        }
    };

    const requestDeleteSimLog = (log: PhoneSimLog) => {
        if (!targetChar) return;
        const charId = targetChar.id;
        askConfirm({
            title: `Delete the life record "${log.title}"?`,
            desc: 'This record and the performance script used to replay it will both be deleted and cannot be undone. Memories already sent to TA will not be retracted.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: () => {
                updateCharacter(charId, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: cur.phoneState?.records || [],
                        simLogs: (cur.phoneState?.simLogs || []).filter(item => item.id !== log.id),
                    },
                }));
                addToast('Life record deleted', 'success');
            },
        });
    };

    // Deep-link request after tapping the global status strip: jump straight into that character's performance
    useEffect(() => {
        if (sim.deepLink && sim.charId) {
            const c = characters.find(x => x.id === sim.charId);
            if (c) {
                setTargetChar(c);
                setView('phone');
                setActiveAppId('persona');
            }
            personaSimStore.clearDeepLink();
        }
    }, [sim.deepLink, sim.charId, characters]);

    // ============================================================
    //  DERIVED STATS  (drive the "living" home screen)
    // ============================================================
    const charName = targetChar?.name || 'Unknown Device';
    const allSorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const chatRecords = records.filter(r => r.type === 'chat');
    const orderRecords = records.filter(r => r.type === 'order');
    const deliveryRecords = records.filter(r => r.type === 'delivery');
    const socialRecords = records.filter(r => r.type === 'social');
    const simLogCount = targetChar?.phoneState?.simLogs?.length || 0;
    const sendToChat = targetChar?.phoneState?.sendToChat !== false; // On by default
    const lastInner = targetChar ? getLastInnerState(targetChar.id) : '';
    const lastTs = allSorted[0]?.timestamp;

    const appLabel = (type: string): string => {
        switch (type) {
            case 'chat': return 'Chat';
            case 'order': return 'Taobao';
            case 'delivery': return 'Food';
            case 'social': return 'Moments';
            case 'call': return 'Call';
            default: return customApps.find(a => a.id === type)?.name || 'App';
        }
    };

    const fmtClock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const lastSeenText = (() => {
        if (!lastTs) return 'Awaiting first sync';
        const d = Date.now() - lastTs;
        const days = Math.floor(d / 86400000);
        const hrs = Math.floor(d / 3600000);
        const mins = Math.floor(d / 60000);
        if (days > 0) return `Last seen ${days}d ago`;
        if (hrs > 0) return `Last seen ${hrs}h ago`;
        if (mins > 0) return `Last seen ${mins}m ago`;
        return 'Online now';
    })();

    const foodSub = deliveryRecords.length
        ? (() => {
            const t = Math.max(...deliveryRecords.map(r => r.timestamp));
            const days = Math.floor((Date.now() - t) / 86400000);
            return days <= 0 ? 'ordered today' : `last order ${days}d ago`;
        })()
        : 'no orders yet';

    const momentsSub = socialRecords.length ? `${socialRecords.length} new posts` : 'nothing shared';
    const taobaoSub = orderRecords.length ? `${orderRecords.length} items in cart` : 'cart is empty';
    // Subtitle on the "Contacts" main card: how many people are in TA's contact list (excluding the user)
    const contactCount = contacts.filter(c => !isUserName(c.name)).length;
    const contactsSub = contactCount ? `${contactCount} contacts` : 'tap to scan';
    const aiSub = aiSessions.length ? `${aiSessions.length} conversation(s) · their little phone` : 'tap to peek';

    // pseudo screen-time + weather (decorative, deterministic per char)
    const seed = charName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const temp = 16 + (seed % 14);
    const screenMin = 64 + records.length * 11 + (seed % 40);
    const stH = Math.floor(screenMin / 60);
    const stM = screenMin % 60;
    const ringP = Math.min(0.94, screenMin / 360);
    const RING_C = 2 * Math.PI * 42;

    const activity = (() => {
        const items = allSorted.slice(0, 4).reverse().map(r => ({ t: r.timestamp, label: `Opened ${appLabel(r.type)}` }));
        if (lastTs) items.push({ t: Date.now(), label: 'Locked screen' });
        return items;
    })();

    const now = new Date();
    const clockNow = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateNow = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const fallbackQuote = targetChar?.socialProfile?.bio || '"Some things feel more real from behind a screen."';
    const innerQuote = lastInner.trim();

    // ============================================================
    //  SUB-APPS
    // ============================================================
    // Find the contact matching a given chat record (used to reuse a real-person avatar)
    const contactOfRecord = (r: PhoneEvidence): PhoneContact | undefined =>
        contacts.find(c => (r.contactId && c.id === r.contactId) || normName(c.name) === normName(r.title));

    const renderChatList = () => {
        const accent = '#8b9cff';
        const list = records.filter(r => r.type === 'chat').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Messages" sub="Archived · Read-only" accent={accent} onBack={() => setActiveAppId('home')}
                    right={list.length > 0 ? (
                        <button onClick={() => askConfirm({
                            title: 'Clear all chat records?', desc: `This will delete all ${list.length} chat record(s) archived on this phone, and cannot be undone.`,
                            confirmLabel: 'Clear', danger: true, onConfirm: handleClearAllChats,
                        })} className="text-rose-300/80 active:scale-90 transition"><Trash size={18} weight="bold" /></button>
                    ) : undefined} />
                {/* Archive notice: the old Messages mode no longer updates, new interactions go through "Contacts" */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07] text-[11px] text-white/55 leading-relaxed">
                        This is the legacy chat archive, no longer updated. Start new interactions in "Contacts" instead — a record here can be bound over there.
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="No chat records in the archive" />}
                    {list.map(r => {
                        const segs = parseTranscript(r.detail);
                        const last = segs.length ? segs[segs.length - 1].text : '...';
                        const av = contactOfRecord(r) ? contactAvatar(contactOfRecord(r)!) : undefined;
                        return (
                            <div key={r.id} onClick={() => { setSelectedChatRecord(r); setTranscriptExpanded(false); setActiveAppId('chat_detail'); }}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] active:scale-[0.99] transition cursor-pointer animate-fade-in">
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {r.title[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{r.title}</span>
                                        <span className="text-[10px] text-white/35 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                    </div>
                                    <div className="text-[11.5px] text-white/45 truncate mt-0.5">{last}</div>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({
                                    title: 'Delete this chat record?', desc: `This archived record with "${r.title}" will be deleted.`,
                                    confirmLabel: 'Delete', danger: true, onConfirm: () => handleDeleteRecord(r),
                                }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </div>
                        );
                    })}
                </div>
            </SubAppShell>
        );
    };

    const renderChatDetail = () => {
        if (!selectedChatRecord || !targetChar) return null;
        const accent = '#8b9cff';
        // Parsing with prefix inheritance: continuation lines of a multi-line message (several lines sent at once) follow the previous speaker, no longer misattributed to the other side.
        const parsedLines = parseTranscript(selectedChatRecord.detail).map(t => ({ isMe: t.isMe, content: t.text }));
        // Render guard: a long transcript renders only the latest 50 lines by default, to avoid choking the page by stuffing in too many bubbles at once (same as chatapp)
        const RENDER_CAP = 50;
        const hiddenCount = transcriptExpanded ? 0 : Math.max(0, parsedLines.length - RENDER_CAP);
        const shownLines = hiddenCount > 0 ? parsedLines.slice(-RENDER_CAP) : parsedLines;
        const contact = contactOfRecord(selectedChatRecord);
        const partnerAvatar = contact ? contactAvatar(contact) : undefined;
        const linkedReal = contact && contact.kind === 'real' && !!contact.linkedCharId;

        return (
            <SubAppShell>
                <TermHeader title={selectedChatRecord.title} sub="Archived · Read-only" accent={accent} onBack={() => setActiveAppId('chat')} />
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {hiddenCount > 0 && (
                        <button onClick={() => setTranscriptExpanded(true)}
                            className="w-full py-2 mb-1 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ Show {hiddenCount} earlier message(s)
                        </button>
                    )}
                    {shownLines.map((msg, idx) => (
                        <div key={idx} className={`flex items-end gap-2 ${msg.isMe ? 'justify-end' : 'justify-start'}`}>
                            {!msg.isMe && (
                                partnerAvatar ? (
                                    <TokenImg value={partnerAvatar} alt="" className="w-8 h-8 rounded-xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs text-white shrink-0"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>
                                        {selectedChatRecord.title[0]}
                                    </div>
                                )
                            )}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[74%] text-[13px] leading-relaxed break-words ${
                                msg.isMe
                                    ? 'text-white rounded-br-md'
                                    : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'
                                }`}
                                style={msg.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>
                                {msg.content}
                            </div>
                            {msg.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>
                {/* Archive is read-only: no further generation; instead "bind to a relationship" (real characters sync both ways) */}
                <div className="shrink-0 w-full p-4 pb-6">
                    <button onClick={() => askConfirm({
                        title: 'Bind to a contact?',
                        desc: linkedReal
                            ? `Matched with "${selectedChatRecord.title}" from the Neural Link — once bound, this conversation will sync to their phone.`
                            : `This will add "${selectedChatRecord.title}" as a contact (no matching real character found, treated as a fictional contact).`,
                        confirmLabel: 'Bind',
                        onConfirm: () => handleBindRecordToRelationship(selectedChatRecord),
                    })}
                        className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <LinkSimple size={16} weight="bold" /> Bind to contact
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderEvidenceDetail = () => {
        const r = selectedEvidenceRecord;
        if (!r) return null;

        const customApp = customApps.find(app => app.id === r.type);
        const layout = customApp?.layout || 'generic';
        const isCall = r.type === 'call';
        const isCommerce = r.type === 'order' || r.type === 'delivery' || layout === 'shop';
        const isSocial = r.type === 'social' || layout === 'feed';
        const isNovel = layout === 'novel';
        const accent = customApp?.color || (isCall ? '#4ade80' : r.type === 'order' ? '#ff7a45' : r.type === 'delivery' ? '#fbbf24' : isSocial ? '#c084fc' : '#8b9cff');
        const title = customApp?.name || appLabel(r.type);
        const dateText = new Date(r.timestamp).toLocaleString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const isMissed = isCall && (r.value?.includes('未接') || r.value?.includes('Missed'));
        const isOutgoing = isCall && (r.value?.includes('呼出') || r.value?.includes('Outgoing'));
        const callDirection = isMissed ? 'Missed call' : isOutgoing ? 'Outgoing' : 'Incoming';
        const callDuration = r.value?.match(/\((.*?)\)/)?.[1] || (isMissed ? '—' : 'Not recorded');
        const detailIcon = customApp
            ? <span className="text-lg">{customApp.icon}</span>
            : isCall ? <Phone size={20} weight="fill" />
                : r.type === 'order' ? <ShoppingBag size={20} weight="fill" />
                    : r.type === 'delivery' ? <Hamburger size={20} weight="fill" />
                        : <ImagesSquare size={20} weight="fill" />;

        return (
            <SubAppShell>
                <TermHeader title={title} sub="record detail" accent={accent}
                    onBack={() => { setSelectedEvidenceRecord(null); setActiveAppId(evidenceBackAppId); }}
                    right={<span style={{ color: accent }}>{detailIcon}</span>} />
                <div className="flex-1 overflow-y-auto no-scrollbar overscroll-contain px-5 pt-3 pb-10">
                    {isSocial ? (
                        <article>
                            <div className="flex items-center gap-3 pb-4 border-b border-white/[0.07]">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
                                    : <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold" style={{ background: accent }}>{charName.slice(0, 1)}</div>}
                                <div className="min-w-0">
                                    <div className="text-[15px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[11px] text-white/35 mt-0.5">{r.title || dateText}</div>
                                </div>
                            </div>
                            <div className="py-6 text-[15px] leading-8 text-white/85 whitespace-pre-wrap break-words">
                                {r.detail || 'This post has no text content.'}
                            </div>
                            <div className="flex items-center gap-7 py-3 border-y border-white/[0.07] text-white/45">
                                <span className="flex items-center gap-2 text-[12px]"><Heart size={16} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)} likes</span>
                                <span className="flex items-center gap-2 text-[12px]"><ChatCircle size={16} /> {1 + (r.id.length % 9)} interactions</span>
                            </div>
                        </article>
                    ) : (
                        <article>
                            <div className="flex items-start gap-4 pb-6 border-b border-white/[0.07]">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 text-2xl"
                                    style={{ color: accent, background: 'linear-gradient(135deg, ' + accent + '33, ' + accent + '0d)' }}>
                                    {customApp ? customApp.icon : isCall ? <Phone size={27} weight="fill" /> : <Package size={28} weight="light" />}
                                </div>
                                <div className="min-w-0 flex-1 pt-0.5">
                                    <div className="text-[18px] leading-7 font-semibold text-white/95 break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>{r.title}</div>
                                    <div className="text-[11px] text-white/35 mt-1.5">{isCall ? callDirection : isCommerce ? 'Order record' : isNovel ? 'Reading record' : 'Content record'}</div>
                                    {r.value && <div className="text-[18px] font-bold mt-2" style={{ color: accent }}>{r.value}</div>}
                                </div>
                            </div>

                            <section className="py-6 border-b border-white/[0.07]">
                                <div className="text-[10px] tracking-[0.22em] uppercase mb-3" style={{ color: accent }}>
                                    {isCall ? 'Call notes' : isCommerce ? 'Full order details' : isNovel ? 'Full text' : 'Full content'}
                                </div>
                                <div className="text-[14px] leading-7 text-white/75 whitespace-pre-wrap break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>
                                    {r.detail || 'No further content was left.'}
                                </div>
                            </section>

                            {isCall && (
                                <div className="grid grid-cols-2 gap-6 py-5 border-b border-white/[0.07]">
                                    <div><div className="text-[10px] text-white/30">Direction</div><div className="text-[14px] text-white/80 mt-1">{callDirection}</div></div>
                                    <div><div className="text-[10px] text-white/30">Duration</div><div className="text-[14px] text-white/80 mt-1">{callDuration}</div></div>
                                </div>
                            )}
                            {isCommerce && (
                                <div className="py-5 border-b border-white/[0.07]">
                                    <div className="text-[10px] text-white/30 mb-3">Order progress</div>
                                    <div className="flex items-center text-[11px] text-white/55">
                                        {['Placed', 'Processing', r.detail?.includes('签收') || r.detail?.includes('送达') || r.detail?.includes('delivered') || r.detail?.includes('Delivered') ? 'Completed' : 'Awaiting update'].map((step, i) => (
                                            <React.Fragment key={step}>
                                                {i > 0 && <div className="h-px flex-1 mx-2" style={{ background: accent + '55' }} />}
                                                <span className="shrink-0" style={{ color: i === 0 ? accent : undefined }}>{step}</span>
                                            </React.Fragment>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </article>
                    )}

                    <dl className="py-5 space-y-3 text-[11px]">
                        <div className="flex justify-between gap-4"><dt className="text-white/30">Recorded</dt><dd className="text-white/60 text-right">{dateText}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">Source App</dt><dd className="text-white/60 text-right">{title}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">Record ID</dt><dd className="text-white/40 text-right font-mono">#{r.id.slice(-8).toUpperCase()}</dd></div>
                    </dl>

                    <button onClick={() => askConfirm({
                        title: 'Delete this record?', desc: 'Deleting "' + r.title + '" cannot be undone.', confirmLabel: 'Delete', danger: true,
                        onConfirm: () => handleDeleteRecord(r),
                    })} className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-rose-200 bg-rose-400/10 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <Trash size={15} weight="bold" /> Delete record
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderCallList = () => {
        const accent = '#4ade80';
        const list = records.filter(r => r.type === 'call').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Recents" sub="call log" accent={accent} onBack={() => setActiveAppId('home')} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-2">
                    {list.length === 0 && <EmptyState text="No call records yet" />}
                    {list.map(r => {
                        const isMissed = r.value?.includes('未接') || r.value?.includes('Missed');
                        const isOutgoing = r.value?.includes('呼出') || r.value?.includes('Outgoing');
                        const c = isMissed ? '#fb7185' : accent;
                        return (
                            <div key={r.id} {...evidenceEntryProps(r, 'call')}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-fade-in cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `${c}1f`, color: c }}>
                                    <Phone size={19} weight="fill" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-[13.5px] truncate" style={{ color: isMissed ? '#fb7185' : 'rgba(255,255,255,0.95)' }}>{r.title}</div>
                                    <div className="text-[10.5px] text-white/40 flex items-center gap-1.5 mt-0.5">
                                        <span>{isMissed ? 'Missed call' : (isOutgoing ? 'Outgoing' : 'Incoming')}</span>
                                        {r.value && !isMissed && <span>· {r.value.replace(/.*?\((.*?)\).*/, '$1')}</span>}
                                    </div>
                                    {r.detail && <div className="text-[10.5px] text-white/30 mt-1 italic truncate">"{r.detail}"</div>}
                                </div>
                                <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                <DelBtn onDelete={() => handleDeleteRecord(r)} />
                            </div>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerate('call')} label="Refresh calls" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderShop = () => {
        const accent = '#ff7a45';
        const list = records.filter(r => r.type === 'order').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Taobao" sub="my orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ShoppingBag size={20} weight="fill" style={{ color: accent }} />} />
                {/* banner */}
                <div className="px-4 pb-2 shrink-0">
                    <div className="rounded-2xl p-3.5 flex items-center gap-3 border border-white/[0.06] overflow-hidden relative"
                        style={{ background: `linear-gradient(120deg, ${accent}26, ${accent}08)` }}>
                        <Storefront size={26} weight="fill" style={{ color: accent }} />
                        <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-white">{charName}'s cart</div>
                            <div className="text-[10.5px] text-white/50">{list.length} item(s) · awaiting payment / delivery</div>
                        </div>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="No orders yet" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'taobao')}
                            className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60">
                            <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center"
                                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                <Package size={26} weight="light" style={{ color: accent }} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col">
                                <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                                <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                                <div className="mt-auto flex items-center justify-between pt-1.5">
                                    <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '$ --'}</span>
                                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider flex items-center gap-0.5">Ordered <CaretRight size={10} /></span>
                                </div>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('order')} label="Refresh orders" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderFood = () => {
        const accent = '#fbbf24';
        const list = records.filter(r => r.type === 'delivery').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Food" sub="recent orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<Hamburger size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="No delivery orders yet" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'waimai')}
                            className="group relative rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                    <Storefront size={20} weight="fill" style={{ color: accent }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13.5px] font-semibold text-white/95 truncate">{r.title}</div>
                                    <div className="text-[10px] text-white/35 mt-0.5">{fmtClock(r.timestamp)} · Delivered</div>
                                </div>
                                {r.value && <span className="text-[14px] font-bold shrink-0" style={{ color: accent }}>{r.value}</span>}
                            </div>
                            <div className="text-[11.5px] text-white/50 mt-2.5 leading-relaxed pl-1 border-l-2" style={{ borderColor: `${accent}55` }}>
                                <span className="pl-2">{r.detail}</span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('delivery')} label="Refresh delivery" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderMoments = () => {
        const accent = '#c084fc';
        const list = records.filter(r => r.type === 'social').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Moments" sub="social feed" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ImagesSquare size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="No posts yet" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'social')}
                            className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60">
                            <div className="flex items-center gap-3 mb-2.5">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} className="w-9 h-9 rounded-full object-cover" />
                                    : <div className="w-9 h-9 rounded-full" style={{ background: accent }} />}
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                                </div>
                            </div>
                            <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                            <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                                <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                                <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                                <span className="ml-auto flex items-center gap-0.5 text-[10px]" style={{ color: accent }}>View details <CaretRight size={10} /></span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('social')} label="Refresh feed" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  Relationship System · Views
    // ============================================================
    const affColor = (a: number) => a >= 40 ? '#4ade80' : a >= 0 ? '#8b9cff' : a >= -40 ? '#fbbf24' : '#fb7185';
    const kindBadge = (c: PhoneContact) => {
        if (c.kind === 'real') return { icon: <LinkSimple size={11} weight="bold" />, label: 'Real', color: '#a78bfa' };
        return { icon: <User size={11} weight="fill" />, label: 'NPC', color: '#94a3b8' };
    };

    const renderContactsList = () => {
        const accent = '#f472b6';
        // The user themselves never shows up in the relationship system
        const list = contacts.filter(c => !isUserName(c.name)).sort((a, b) => (b.lastInteraction || b.createdAt) - (a.lastInteraction || a.createdAt));
        return (
            <SubAppShell>
                <TermHeader title={contactSelectMode ? `${selectedContactIds.length} selected` : 'Contacts'} sub={contactSelectMode ? 'Long-press entered multi-select' : `${list.length} contacts`} accent={accent}
                    onBack={() => { if (contactSelectMode) exitContactSelect(); else setActiveAppId('home'); }}
                    right={contactSelectMode
                        ? <button onClick={exitContactSelect} className="text-[12px] font-semibold text-white/80 active:scale-90 transition">Cancel</button>
                        : <button onClick={() => setShowContactModal(true)} className="text-white/80 active:scale-90 transition"><UserPlus size={20} weight="bold" /></button>} />
                {/* Constraint toggle: whether fictional NPCs are allowed */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="w-full flex items-center gap-2 rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07]">
                        <button onClick={toggleAllowFictional} className="flex-1 min-w-0 text-left active:scale-[0.99] transition">
                            <span className="text-[11px] text-white/55">{allowFictional ? 'TA can make fictional NPC friends' : 'TA only interacts with characters from the Neural Link'}</span>
                        </button>
                        <button onClick={() => setShowFictionHelp(v => !v)} aria-label="Explanation"
                            className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition ${showFictionHelp ? 'text-white/80' : 'text-white/35 active:text-white/70'}`}>
                            <Question size={13} weight="bold" />
                        </button>
                        <button onClick={toggleAllowFictional} aria-label="Toggle" className="relative w-9 h-5 rounded-full transition shrink-0" style={{ background: allowFictional ? accent : 'rgba(255,255,255,0.15)' }}>
                            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: allowFictional ? '18px' : '2px' }} />
                        </button>
                    </div>
                    {showFictionHelp && (
                        <div className="mt-1.5 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] text-[10.5px] text-white/55 leading-relaxed space-y-1">
                            <p><span className="font-semibold text-white/75">On: </span>allows "passersby invented to fit TA's persona" to show up in TA's contact list (coworkers, online friends, go-betweens, and the like — people who do not actually exist in the Neural Link). Makes the social circle feel fuller.</p>
                            <p><span className="font-semibold text-white/75">Off: </span>TA only interacts with <span className="text-white/75">characters that actually exist</span> in the Neural Link; scanning/generating will discard any fictional contact.</p>
                        </div>
                    )}
                    {/* Legacy Message chat archive: a deprecated App, tucked away here as a low-key entry point */}
                    <button onClick={openChat}
                        className="w-full flex items-center gap-2 mt-1.5 px-3 py-1.5 text-white/35 active:text-white/60 transition">
                        <ChatCircleDots size={13} weight="light" className="shrink-0" />
                        <span className="text-[10.5px] flex-1 text-left">Legacy chat archive{chatRecords.length ? ` · ${chatRecords.length}` : ''}</span>
                        <CaretRight size={11} weight="bold" className="shrink-0" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-2 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="No contacts yet · try scanning your contact list" />}
                    {list.map(c => {
                        const badge = kindBadge(c);
                        const dimmed = c.status === 'deleted' || c.status === 'blocked';
                        const av = contactAvatar(c);
                        const selected = selectedContactIds.includes(c.id);
                        return (
                            <div key={c.id}
                                {...longPress(() => { setContactSelectMode(true); toggleContactSelect(c.id); })}
                                onClick={() => {
                                    if (lpFired.current) { lpFired.current = false; return; }
                                    if (contactSelectMode) { toggleContactSelect(c.id); return; }
                                    setSelectedContact(c); setIdentityDraft(c.identity || ''); setEditingIdentity(false); setNoteDraft(c.note || ''); setEditingNote(false); setConvExpanded(false); setAffinityDraft(null); setShowProfile(false); exitMsgSelect(); setActiveAppId('contact_detail');
                                    trackEvent('Open Contact Conversation Detail', { contactKind: c.kind });
                                }}
                                className={`group relative flex items-center gap-3 rounded-2xl p-3.5 border active:scale-[0.99] transition cursor-pointer animate-fade-in select-none ${selected ? 'bg-pink-500/10 border-pink-400/40' : 'bg-white/[0.035] border-white/[0.06]'} ${dimmed && !selected ? 'opacity-45' : ''}`}>
                                {contactSelectMode && (
                                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[11px] font-bold transition ${selected ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'}`}>✓</span>
                                )}
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {c.name[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{contactDisplayName(c)}</span>
                                        <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full shrink-0" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                        {c.status === 'deleted' && <span className="text-[9px] text-rose-300/80 shrink-0">Removed</span>}
                                        {c.status === 'blocked' && <span className="text-[9px] text-rose-300/80 shrink-0">Blocked</span>}
                                    </div>
                                    <div className="text-[11px] text-white/40 truncate mt-0.5">{c.note || c.identity || '—'}</div>
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <div className="h-1 flex-1 rounded-full bg-white/[0.08] overflow-hidden">
                                            <div className="h-full rounded-full" style={{ width: `${(c.affinity + 100) / 2}%`, background: affColor(c.affinity) }} />
                                        </div>
                                        <span className="text-[9px] tabular-nums shrink-0" style={{ color: affColor(c.affinity) }}>{c.affinity > 0 ? '+' : ''}{c.affinity}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {contactSelectMode ? (
                    <div className="absolute bottom-7 inset-x-0 flex justify-center gap-2 px-6 z-30 pointer-events-none">
                        <button onClick={() => setSelectedContactIds(selectedContactIds.length === list.length ? [] : list.map(c => c.id))}
                            className="pointer-events-auto px-4 py-3 rounded-full text-[12px] font-semibold text-white/85 bg-white/[0.1] border border-white/15 backdrop-blur-xl active:scale-95 transition">
                            {selectedContactIds.length === list.length && list.length > 0 ? 'Deselect all' : 'Select all'}
                        </button>
                        <button disabled={!selectedContactIds.length}
                            onClick={() => askConfirm({
                                title: `Clear the selected ${selectedContactIds.length} conversation(s)?`,
                                desc: 'This only clears these conversations (contacts are kept; the mirrored copy on a real contact\'s phone, related private-chat cards, and topic-box memories are all cleared too) — they can be regenerated afterward.',
                                confirmLabel: 'Clear conversations', danger: true, onConfirm: handleBatchClearConversations,
                            })}
                            className="pointer-events-auto px-6 py-3 rounded-full text-[12px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-95 transition flex items-center gap-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
                            <ChatCircle size={14} weight="bold" /> Clear conversations {selectedContactIds.length || ''}
                        </button>
                    </div>
                ) : (
                    <RefreshFab onClick={() => handleGenerate('contacts')} label="Scan contacts" accent={accent} loading={isLoading} />
                )}
            </SubAppShell>
        );
    };

    // ============================================================
    //  Agent App · Render (home: service tab + session list; detail: transcript + interaction)
    // ============================================================
    const renderAiAgent = () => {
        const svc = AI_SERVICES.find(s => s.id === aiService)!;
        const list = aiSessions.filter(s => s.service === aiService).sort((a, b) => b.updatedAt - a.updatedAt);
        return (
            <SubAppShell>
                <TermHeader title="Agent" sub="Their little phone" accent={svc.accent} onBack={() => setActiveAppId('home')}
                    right={<Robot size={20} weight="fill" style={{ color: svc.accent }} />} />
                {/* Service tabs */}
                <div className="px-4 pb-2 shrink-0 flex gap-2">
                    {AI_SERVICES.map(s => {
                        const active = s.id === aiService;
                        const Icon = s.id === 'assistant' ? Robot : s.id === 'claude' ? Brain : MaskHappy;
                        return (
                            <button key={s.id} onClick={() => { setAiService(s.id); trackEvent('Switch Agent Service Category', { service: s.id }); }}
                                className={`flex-1 rounded-2xl px-2 py-2.5 border transition active:scale-[0.97] ${active ? 'text-white' : 'border-white/[0.07] bg-white/[0.03] text-white/55'}`}
                                style={active ? { background: `linear-gradient(135deg, ${s.accent}33, ${s.accent}0d)`, borderColor: `${s.accent}66` } : undefined}>
                                <Icon size={18} weight={active ? 'fill' : 'light'} style={{ color: active ? s.accent : undefined }} className="mx-auto" />
                                <div className="text-[10.5px] font-semibold mt-1">{s.name}</div>
                            </button>
                        );
                    })}
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-2.5">
                    <div className="text-[11px] text-white/45 px-1 pb-0.5">{svc.tagline}</div>
                    {/* Tavern character-card shelf (click to see what TA has played with it / long-press to edit or delete / + to add your own) */}
                    {aiService === 'tavern' && (
                        <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
                            {aiCards.map(c => (
                                <div key={c.id} {...longPress(() => setAiMenu({ kind: 'card', id: c.id }))}
                                    onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setAiCardView(c.id); }}
                                    className="shrink-0 w-36 rounded-2xl p-3 border border-white/[0.07] bg-white/[0.035] cursor-pointer active:scale-[0.98] transition select-none">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl">{c.emoji}</div>
                                        <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-rose-400/20 text-rose-200/90">{c.kind === 'world' ? 'World card' : 'Character card'}</span>
                                    </div>
                                    <div className="text-[12.5px] font-semibold text-white mt-1.5 truncate">{c.name}</div>
                                    {c.basedOnUser ? <div className="text-[9px] text-rose-300/90 mt-0.5">⚑ Modeled after you</div>
                                        : c.basedOn ? <div className="text-[9px] text-rose-300/90 mt-0.5 truncate">⚑ Modeled after "{c.basedOn}"</div> : null}
                                    <div className="text-[10px] text-white/45 mt-1 line-clamp-2 leading-snug">{c.persona}</div>
                                    {c.scenario && <div className="text-[9.5px] text-white/35 mt-1 line-clamp-2 italic leading-snug">Scene: {c.scenario}</div>}
                                </div>
                            ))}
                            {/* The user adding a card of their own */}
                            <button onClick={() => setAiEdit({ kind: 'card', id: '__new__', emoji: '🎭', name: '', persona: '', scenario: '', cardKind: 'character' })}
                                className="shrink-0 w-24 rounded-2xl p-3 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-1.5 active:scale-[0.98] transition self-stretch">
                                <Plus size={20} weight="light" className="text-white/55" />
                                <span className="text-[10px] text-white/45">Add card</span>
                            </button>
                        </div>
                    )}
                    {list.length === 0 && <EmptyState text={`Nothing peeked at yet from TA's "${svc.name}"`} />}
                    {list.map(s => {
                        const lines = parseTranscript(s.transcript);
                        const last = lines[lines.length - 1];
                        const vt = getVendorTheme(s.serviceName, s.service);
                        return (
                            <button key={s.id} {...longPress(() => setAiMenu({ kind: 'session', id: s.id }))}
                                onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                className="group relative w-full text-left flex gap-3 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] animate-fade-in active:scale-[0.99] transition">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: aiService === 'assistant' ? `${vt.accent}1f` : `${svc.accent}1f`, color: svc.accent }}>
                                    {aiService === 'assistant'
                                        ? <VendorMark vkey={vt.key} label={vt.label} accent={vt.accent} size={22} />
                                        : aiService === 'claude' ? <Brain size={20} weight="fill" /> : <MaskHappy size={20} weight="fill" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="font-semibold text-[13.5px] text-white/95 truncate">{s.title}</div>
                                        <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(s.updatedAt)}</span>
                                    </div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{s.serviceName} · {lines.length} line(s)</div>
                                    {last && <div className="text-[11px] text-white/55 mt-1 truncate italic">"{last.text}"</div>}
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({ title: `Delete the session "${s.title}"?`, desc: 'This conversation record will be deleted and cannot be undone.', confirmLabel: 'Delete', danger: true, onConfirm: () => handleDeleteAiSession(s.id) }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </button>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerateAiAgent(aiService)} label={`Peek at their ${svc.name}`} accent={svc.accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderAiSession = () => {
        const s = selectedAiSession;
        if (!s || !targetChar) return null;
        const isTavern = s.service === 'tavern';
        const card = isTavern ? aiCards.find(c => c.id === s.cardId) : undefined;
        const lines = parseTranscript(s.transcript);
        const partnerName = isTavern ? (card?.name || s.serviceName) : s.serviceName;
        const partnerEmoji = isTavern ? (card?.emoji || '🎭') : null;
        const inputHint = isTavern ? `Continue the story as "${partnerName}"...` : `Reply as the AI "${partnerName}"...`;
        // Tavern uses the user-selected reading skin; Assistant/Confidant uses the vendor skin
        const tStyle = TAVERN_STYLES.find(x => x.key === tavernStyle) || TAVERN_STYLES[0];
        const t: VendorTheme = isTavern
            ? { key: 'tavern', label: partnerName, dark: tStyle.dark, bg: tStyle.bg, text: tStyle.text, sub: tStyle.sub, accent: tStyle.accent, font: tStyle.font,
                userBg: `linear-gradient(135deg,${tStyle.accent},${tStyle.accent}bb)`, userText: '#fff',
                aiBg: tStyle.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)', aiText: tStyle.text }
            : getVendorTheme(s.serviceName, s.service);
        const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hairline = t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        const inputBg = t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
        const aiAvatarBg = t.key === 'gpt' ? '#000' : t.key === 'claude' ? '#f0e9da' : t.dark ? 'rgba(255,255,255,0.08)' : '#fff';

        // Tavern is long-form novel style: consecutive lines from the same speaker are merged into a "floor", *actions* render in a faded italic
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        // *action* renders in a faded italic; (parenthetical OOC / talking to the AI underneath) is also a faded italic — but both still live within the character's own floor, they never start a separate bubble
        const renderProse = (txt: string) => txt.split(/(\*[^*]+\*|（[^）]+）)/g).filter(Boolean).map((p, i) =>
            (p.startsWith('*') && p.endsWith('*'))
                ? <em key={i} style={{ color: t.sub }}>{p.slice(1, -1)}</em>
                : (p.startsWith('（') && p.endsWith('）'))
                    ? <em key={i} style={{ color: t.sub, opacity: 0.8 }}>{p}</em>
                    : <span key={i}>{p}</span>);
        return (
            <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden"
                style={{ background: t.bg, color: t.text, fontFamily: t.font }}>
                {/* Status bar (colored per light/dark theme) */}
                <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-9 flex justify-between px-6 items-center pt-2" style={{ color: t.text, opacity: 0.65 }}>
                        <span className="text-[12px] font-semibold tabular-nums">{clock}</span>
                        <div className="flex gap-1.5 items-center">
                            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                            <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
                        </div>
                    </div>
                </div>
                {/* Top bar: back + logo + service name + delete */}
                <div className="shrink-0 h-14 flex items-center justify-between px-3" style={{ borderBottom: `1px solid ${hairline}` }}>
                    <button onClick={() => setActiveAppId('aiagent')} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.text }}>
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <div className="flex-1 flex items-center justify-center gap-2 px-2 min-w-0">
                        {!isTavern && (
                            <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: t.key === 'gemini' || t.key === 'claude' ? 'transparent' : `${t.accent}1f` }}>
                                <VendorMark vkey={t.key} label={t.label} accent={t.accent} size={16} />
                            </span>
                        )}
                        <div className="min-w-0 text-center">
                            <div className="text-[15px] font-semibold tracking-wide truncate">{isTavern ? s.title : t.label}</div>
                            <div className="text-[10px] tracking-[0.15em] uppercase truncate" style={{ color: t.accent }}>
                                {isTavern ? `${partnerName} · sneaking in to role-play` : `${s.title} · you play the AI`}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center">
                        {isTavern && (
                            <button onClick={() => setShowTavernStyle(true)} aria-label="Reading skin" className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                                <PaintBrush size={16} />
                            </button>
                        )}
                        <button onClick={() => askConfirm({ title: `Delete the session "${s.title}"?`, desc: 'This conversation record will be deleted and cannot be undone.', confirmLabel: 'Delete', danger: true, onConfirm: () => handleDeleteAiSession(s.id) })} className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                            <Trash size={16} />
                        </button>
                    </div>
                </div>
                {/* Tavern reading skin picker */}
                {showTavernStyle && (
                    <div className="absolute inset-0 z-[80] flex items-end justify-center" onClick={() => setShowTavernStyle(false)}>
                        <div className="absolute inset-0 bg-black/40" />
                        <div className="relative w-full max-w-sm m-3 mb-6 rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10" onClick={e => e.stopPropagation()}>
                            <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10">Reading skin</div>
                            <div className="grid grid-cols-2 gap-2 p-3">
                                {TAVERN_STYLES.map(st => (
                                    <button key={st.key} onClick={() => { setTavernStyle(st.key); setShowTavernStyle(false); trackEvent('Switch Tavern Reading Skin', { style: st.key }); }}
                                        className={`rounded-xl p-3 text-left border transition ${tavernStyle === st.key ? 'border-white/40' : 'border-white/10'}`}
                                        style={{ background: st.bg }}>
                                        <div className="text-[13px] font-semibold" style={{ color: st.text, fontFamily: st.font }}>{st.label}</div>
                                        <div className="text-[10px] mt-1" style={{ color: st.sub }}>{st.layout === 'card' ? 'Floor cards' : st.indent ? 'Book-page layout' : 'Plain-text layout'}</div>
                                        <div className="mt-1.5 h-1 w-10 rounded-full" style={{ background: st.accent }} />
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {isTavern && card && (
                    <div className="px-4 pt-2 pb-1 shrink-0">
                        <div className="rounded-2xl p-3 flex items-start gap-3" style={{ background: `${t.accent}1a`, border: `1px solid ${hairline}` }}>
                            <div className="text-2xl shrink-0">{card.emoji}</div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: t.text }}>
                                    {card.name}
                                    <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>{card.kind === 'world' ? 'World card · Tabletop' : 'Character card'}</span>
                                    {card.basedOnUser ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ Modeled after you</span>
                                        : card.basedOn ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ Modeled after "{card.basedOn}"</span> : null}
                                </div>
                                <div className="text-[10px] mt-0.5 line-clamp-2" style={{ color: t.sub }}>{card.persona}</div>
                                {card.scenario && <div className="text-[10px] mt-1 line-clamp-2 italic" style={{ color: t.sub }}>Scene: {card.scenario}</div>}
                            </div>
                        </div>
                    </div>
                )}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {/* Recap: a novel-style synopsis auto-summarized from the long session (the collapsed earlier text can be expanded) */}
                    {!!s.summaries?.length && (
                        <div className="rounded-2xl p-3.5 space-y-2" style={{ background: `${t.accent}10`, border: `1px dashed ${t.accent}55` }}>
                            <div className="text-[10px] tracking-[0.25em] uppercase font-bold" style={{ color: t.accent }}>Recap · {s.summaries.length} part(s)</div>
                            {s.summaries.map((sm, i) => (
                                <p key={sm.id} className="text-[12px] leading-[1.85] whitespace-pre-wrap" style={{ color: t.sub }}>
                                    {s.summaries!.length > 1 && <span className="font-semibold" style={{ color: t.accent }}>{i + 1}. </span>}{sm.content}
                                </p>
                            ))}
                            {!!s.archived && (
                                <button onClick={() => setAiArchiveOpen(o => !o)}
                                    className="text-[11px] font-semibold pt-1 active:scale-95 transition" style={{ color: t.accent }}>
                                    {aiArchiveOpen ? 'Collapse the archived text ▲' : 'Show the archived text ▼'}
                                </button>
                            )}
                            {aiArchiveOpen && !!s.archived && (
                                <div className="text-[12px] leading-[1.85] whitespace-pre-wrap pt-1 mt-1 border-t" style={{ color: t.sub, borderColor: hairline }}>
                                    {parseTranscript(s.archived).map((l, i) => (
                                        <div key={i} className="mb-1"><span className="opacity-60">{l.isMe ? charName : partnerName}: </span>{l.text}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {/* Tavern: alternates between the player's floor / the character's floor. card=floor cards, flat=plain/book-page layout. OOC is just the parenthetical within a floor. */}
                    {isTavern ? floors.map((f, i) => {
                        const who = f.isMe ? charName : partnerName;
                        if (tStyle.layout === 'flat') {
                            return (
                                <div key={i} {...longPress(() => setAiTurnMenu(i))} className="px-1 py-1.5 select-none">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-[12px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                        {f.isMe && <span className="text-[9px]" style={{ color: t.sub }}>· Player</span>}
                                    </div>
                                    <div className="text-[14px] whitespace-pre-wrap" style={{ color: t.text, lineHeight: 1.95, textIndent: tStyle.indent ? '2em' : undefined }}>{renderProse(f.text)}</div>
                                </div>
                            );
                        }
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className="rounded-2xl p-3.5 select-none"
                                style={{ background: f.isMe ? `${t.accent}10` : 'rgba(255,255,255,0.04)', border: `1px solid ${hairline}` }}>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden shrink-0"
                                        style={{ background: f.isMe ? 'transparent' : `${t.accent}1f` }}>
                                        {f.isMe ? <TokenImg value={targetChar.avatar} className="w-7 h-7 object-cover" /> : <span className="text-base">{partnerEmoji}</span>}
                                    </div>
                                    <span className="text-[12.5px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                    {f.isMe && <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>Player</span>}
                                </div>
                                <div className="text-[13px] leading-[1.95] whitespace-pre-wrap" style={{ color: t.text }}>{renderProse(f.text)}</div>
                            </div>
                        );
                    }) : lines.map((m, i) => {
                        const bare = !m.isMe && t.aiBg === 'transparent'; // ChatGPT/Claude: the AI has no bubble, the text just spreads across the width
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'}`}>
                                {!m.isMe && (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0 overflow-hidden"
                                        style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                        {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                                    </div>
                                )}
                                <div className="px-3.5 py-2.5 rounded-2xl max-w-[78%] text-[13px] leading-relaxed break-words whitespace-pre-wrap"
                                    style={{
                                        background: m.isMe ? t.userBg : (bare ? 'transparent' : t.aiBg),
                                        color: m.isMe ? t.userText : t.aiText,
                                        border: (!m.isMe && !bare && !t.dark) ? `1px solid ${hairline}` : undefined,
                                        borderBottomRightRadius: m.isMe ? 6 : undefined,
                                        borderBottomLeftRadius: (!m.isMe && !bare) ? 6 : undefined,
                                        paddingLeft: bare ? 2 : undefined, paddingRight: bare ? 2 : undefined,
                                    }}>
                                    {m.text}
                                </div>
                                {m.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                            </div>
                        );
                    })}
                    {aiSending && (
                        <div className="flex justify-start items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                            </div>
                            <div className="flex gap-1 px-3 py-2.5 rounded-2xl" style={{ background: t.aiBg === 'transparent' ? 'transparent' : t.aiBg }}>
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.15s' }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.3s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={chatEndRef} />
                </div>
                {/* Natural progression: without having to say anything, let the story keep moving on its own for a turn */}
                <div className="shrink-0 w-full px-3 pt-2" style={{ borderTop: `1px solid ${hairline}` }}>
                    <button onClick={handleAiAutoContinue} disabled={aiSending}
                        className="w-full py-2 rounded-xl text-[12px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: `${t.accent}1a`, border: `1px dashed ${t.accent}66`, color: t.accent }}>
                        <Sparkle size={14} weight="fill" /> {isTavern ? 'Let the story move forward on its own' : 'Let TA keep asking'}
                    </button>
                </div>
                {/* Interactive input: ask on TA's behalf / sneak in to role-play (Enter for a new line, tap the button to send) */}
                <div className="shrink-0 w-full px-3 pt-2 flex items-end gap-2"
                    style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
                    <textarea value={aiInput} onChange={e => setAiInput(e.target.value)}
                        rows={1} placeholder={inputHint}
                        className="flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-[13px] max-h-24 no-scrollbar focus:outline-none"
                        style={{ background: inputBg, color: t.text, border: `1px solid ${hairline}` }} />
                    <button onClick={handleAiSend} disabled={aiSending || !aiInput.trim()}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-90 transition"
                        style={{ background: t.accent, color: '#fff' }}>
                        {aiSending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PaperPlaneTilt size={17} weight="fill" />}
                    </button>
                </div>
            </div>
        );
    };

    const renderContactDetail = () => {
        if (!selectedContact || !targetChar) return null;
        const c = selectedContact;
        const accent = '#f472b6';
        const badge = kindBadge(c);
        const isReal = c.kind === 'real' && !!c.linkedCharId;
        const av = contactAvatar(c);
        const rec = records.find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        const parsed = rec ? parseTranscript(rec.detail).map(t => ({ isMe: t.isMe, content: t.text })) : [];
        const CAP = 50;
        const hidden = convExpanded ? 0 : Math.max(0, parsed.length - CAP);
        const shown = hidden > 0 ? parsed.slice(-CAP) : parsed;
        const statusLabel = c.status === 'friend' ? 'Friend' : c.status === 'deleted' ? 'Removed' : c.status === 'blocked' ? 'Blocked' : 'Pending';
        const aff = affinityDraft ?? c.affinity;
        const commitAff = () => { if (affinityDraft != null) { handleSetAffinity(c, affinityDraft); setAffinityDraft(null); } };
        const closeProfile = () => { setShowProfile(false); setEditingIdentity(false); setEditingNote(false); };
        const avatarNode = (size: string, txt: string) => av
            ? <TokenImg value={av} alt="" className={`${size} rounded-2xl object-cover shrink-0`} />
            : <div className={`${size} rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold ${txt}`} style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>;
        return (
            <SubAppShell>
                {/* Chat-style top bar: back + tappable avatar/name (opens the profile) */}
                <div className="shrink-0 z-20">
                    <StatusStrip />
                    <div className="h-14 flex items-center gap-2 px-3">
                        <button onClick={() => { if (msgSelectMode) exitMsgSelect(); else setActiveAppId('contacts'); }} className="w-9 h-9 -ml-0.5 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <CaretLeft size={18} weight="bold" />
                        </button>
                        <button onClick={() => setShowProfile(true)} className="flex items-center gap-2.5 flex-1 min-w-0 active:opacity-70 transition">
                            {avatarNode('w-9 h-9', 'text-base')}
                            <div className="min-w-0 text-left">
                                <div className="text-[14px] font-semibold text-white truncate leading-tight">{contactDisplayName(c)}</div>
                                <div className="text-[9.5px] text-white/40 leading-tight">{badge.label} · tap avatar for profile</div>
                            </div>
                        </button>
                        <button onClick={() => setShowProfile(true)} aria-label="Profile" className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <DotsThree size={20} weight="bold" />
                        </button>
                    </div>
                </div>

                {/* Chat body */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {parsed.length === 0 && !isLoading && (
                        <div className="flex flex-col items-center justify-center h-full gap-2.5 text-white/30">
                            <ChatCircleDots size={42} weight="light" />
                            <span className="text-[12px] tracking-wide">{isReal ? 'No conversation yet · start one below' : 'Nothing peeked at yet · peek at one below'}</span>
                        </div>
                    )}
                    {hidden > 0 && (
                        <button onClick={() => setConvExpanded(true)}
                            className="w-full py-2 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ Show {hidden} earlier message(s)
                        </button>
                    )}
                    {shown.map((m, i) => {
                        const realIdx = hidden + i; // Maps back to the full script's index
                        const sel = selectedMsgIdx.includes(realIdx);
                        return (
                        <div key={realIdx}
                            {...longPress(() => { setMsgSelectMode(true); setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev : [...prev, realIdx]); })}
                            onClick={() => {
                                if (lpFired.current) { lpFired.current = false; return; }
                                if (msgSelectMode) setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev.filter(x => x !== realIdx) : [...prev, realIdx]);
                            }}
                            className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'} ${msgSelectMode ? 'cursor-pointer rounded-xl -mx-1 px-1 py-0.5 transition ' + (sel ? 'bg-pink-500/15' : '') : ''}`}>
                            {msgSelectMode && (
                                <span className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 text-[9px] font-bold self-center ${sel ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'} ${m.isMe ? 'order-last' : ''}`}>✓</span>
                            )}
                            {!m.isMe && (av
                                ? <TokenImg value={av} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />
                                : <div className="w-7 h-7 rounded-xl flex items-center justify-center text-[11px] text-white shrink-0" style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>)}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[76%] text-[13px] leading-relaxed break-words ${m.isMe ? 'text-white rounded-br-md' : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                                style={m.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>{m.content}</div>
                            {m.isMe && <TokenImg value={targetChar.avatar} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />}
                        </div>
                    );})}
                    {isLoading && (
                        <div className="flex justify-center py-3">
                            <div className="flex gap-1.5">
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.2s' }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.4s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={contactEndRef} />
                </div>

                {/* Bottom bar: in multi-select mode = delete the selected lines; otherwise = start/peek at a conversation (like a chat input area) */}
                <div className="shrink-0 w-full p-4 pb-6">
                    {msgSelectMode ? (
                        <div className="flex gap-2">
                            <button onClick={exitMsgSelect}
                                className="px-5 py-3 rounded-2xl text-[13px] font-semibold text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition">Cancel</button>
                            <button disabled={!selectedMsgIdx.length}
                                onClick={() => askConfirm({
                                    title: `Delete the selected ${selectedMsgIdx.length} message(s)?`,
                                    desc: c.kind === 'real' && c.linkedCharId ? 'These will be deleted from both phones.' : 'These will be deleted from this conversation.',
                                    confirmLabel: 'Delete', danger: true, onConfirm: handleDeleteSelectedMessages,
                                })}
                                className="flex-1 py-3 rounded-2xl text-[13px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-[0.99] transition flex items-center justify-center gap-2">
                                <Trash size={16} weight="bold" /> Delete selected {selectedMsgIdx.length || ''}
                            </button>
                        </div>
                    ) : isReal ? (
                        <button onClick={() => handleRealConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white active:scale-[0.99] transition flex items-center justify-center gap-2"
                            style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
                            <PaperPlaneTilt size={16} weight="fill" /> {rec ? 'Continue the real conversation (synced both ways)' : 'Start a real conversation (A sends, B replies)'}
                        </button>
                    ) : (
                        <button onClick={() => handleNpcConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                            <ChatCircleDots size={16} weight="fill" /> {rec ? 'Peek at the next conversation' : 'Peek at a conversation'}
                        </button>
                    )}
                </div>

                {/* Profile drawer: opened by tapping the avatar/…, notes / learned info / affinity / binding / relationship actions all live here */}
                {showProfile && (
                    <div className="absolute inset-0 z-[80] flex flex-col justify-end">
                        <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={closeProfile} />
                        <div className="relative max-h-[90%] overflow-y-auto no-scrollbar rounded-t-[28px] border-t border-white/[0.1] px-5 pt-3 pb-9 animate-slide-up space-y-3.5"
                            style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d27 0%, #101218 70%)' }}>
                            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto" />
                            {/* Header profile */}
                            <div className="flex flex-col items-center gap-2 pt-1">
                                {avatarNode('w-20 h-20', 'text-2xl')}
                                <div className="text-[17px] font-semibold text-white text-center">{contactDisplayName(c)}</div>
                                <div className="flex items-center gap-2 flex-wrap justify-center">
                                    <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                    {c.identity && <span className="text-[11px] text-white/55">{c.identity}</span>}
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/55">{statusLabel}</span>
                                </div>
                            </div>

                            {/* Affinity (draggable) */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center gap-2.5">
                                    <span className="text-[11px] text-white/45 shrink-0">Affinity</span>
                                    <input type="range" min={-100} max={100} step={1} value={aff}
                                        onChange={(e) => setAffinityDraft(parseInt(e.target.value, 10))}
                                        onPointerUp={commitAff} onTouchEnd={commitAff} onMouseUp={commitAff} onBlur={commitAff} onKeyUp={commitAff}
                                        aria-label="Affinity" className="flex-1 h-2 cursor-pointer bg-transparent" style={{ accentColor: affColor(aff) }} />
                                    <span className="text-[12px] font-bold tabular-nums shrink-0 w-9 text-right" style={{ color: affColor(aff) }}>{aff > 0 ? '+' : ''}{aff}</span>
                                </div>
                            </div>

                            {/* Alias / relationship shown in the real-person contact list (can be manually locked so future scans do not overwrite it) */}
                            {isReal && (
                                <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">Alias / relationship</span>
                                        <button onClick={() => { setEditingIdentity(!editingIdentity); setIdentityDraft(c.identity || ''); }} className="text-white/50 active:scale-90 transition" aria-label="Edit alias">
                                            <PencilSimple size={14} weight="bold" />
                                        </button>
                                    </div>
                                    {editingIdentity ? (
                                        <div className="space-y-2">
                                            <input value={identityDraft} onChange={e => setIdentityDraft(e.target.value)} placeholder="e.g. senior classmate, ex, met in Beyond"
                                                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90" />
                                            <button onClick={() => handleSaveIdentity(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>Save</button>
                                            <p className="text-[9.5px] text-white/30">Saving it empty restores the real name; once manually saved, future scans will not overwrite it</p>
                                        </div>
                                    ) : (
                                        <p className="text-[12.5px] text-white/70 leading-relaxed">{c.identity || `(showing the real name: ${linkedCharOf(c)?.name || c.name})`}</p>
                                    )}
                                </div>
                            )}

                            {/* Note (fact, editable) */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">Note</span>
                                    <button onClick={() => { setEditingNote(!editingNote); setNoteDraft(c.note || ''); }} className="text-white/50 active:scale-90 transition"><PencilSimple size={14} weight="bold" /></button>
                                </div>
                                {editingNote ? (
                                    <div className="space-y-2">
                                        <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="The phone owner's note about TA (fact/relationship)..."
                                            className="w-full h-16 bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90 resize-none" />
                                        <button onClick={() => handleSaveNote(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>Save</button>
                                    </div>
                                ) : (
                                    <p className="text-[12.5px] text-white/70 leading-relaxed whitespace-pre-wrap">{c.note || '(no note)'}</p>
                                )}
                            </div>

                            {/* Topic box: first-person chat memories auto-condensed every 100 messages (long-press to edit/delete); the raw text is still viewable in the chat */}
                            {c.topicBox && c.topicBox.length > 0 && (
                                <div className="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06]">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">Topic box · chat memories</span>
                                        <span className="text-[9px] text-white/30">Long-press to edit/delete</span>
                                    </div>
                                    <div className="space-y-2">
                                        {c.topicBox.map(t => (
                                            <div key={t.id} {...longPress(() => setTopicEdit({ contactId: c.id, topicId: t.id, text: t.text }))}
                                                onClick={() => { if (lpFired.current) { lpFired.current = false; } }}
                                                className="rounded-xl px-3 py-2 bg-white/[0.03] border border-white/[0.05] active:bg-white/[0.06] transition select-none cursor-pointer">
                                                <p className="text-[11.5px] text-white/60 leading-relaxed whitespace-pre-wrap">{t.text}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-[9.5px] text-white/25 mt-2">※ Every {ARCHIVE_EVERY} messages gets auto-condensed into one first-person memory for TA to remember; the raw text is still viewable in the chat</p>
                                </div>
                            )}

                            {/* Learned (impression, not necessarily true, accumulates automatically) */}
                            <div className="rounded-2xl p-4 bg-white/[0.02] border border-white/[0.06] border-dashed">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">Learned · what {targetChar.name} sees in TA</span>
                                    {c.learned && c.learned.trim() && (
                                        <button onClick={() => mutateContacts(cs => cs.map(x => x.id === c.id ? { ...x, learned: '' } : x))}
                                            className="text-white/40 active:scale-90 transition" aria-label="Clear learned"><Trash size={13} weight="bold" /></button>
                                    )}
                                </div>
                                {c.learned && c.learned.trim() ? (
                                    <>
                                        <p className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{c.learned}</p>
                                        <p className="text-[9.5px] text-white/30 mt-1.5">※ From the impression built up over time — TA said it themselves, not necessarily true</p>
                                    </>
                                ) : (
                                    <p className="text-[11.5px] text-white/30 leading-relaxed">No learned impression of TA yet · this accumulates automatically as they chat more (not necessarily true)</p>
                                )}
                            </div>

                            {/* Bind / rebind */}
                            <button onClick={() => { closeProfile(); setShowRebindModal(true); }}
                                className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                                <LinkSimple size={13} weight="bold" className="shrink-0 text-white/50" />
                                <span className="text-[11px] text-white/55 flex-1 text-left truncate">
                                    {isReal ? `Bound to real character: ${linkedCharOf(c)?.name || 'bound'}` : 'Fictional contact (not bound to a real character)'}
                                </span>
                                <span className="text-[11px] font-semibold shrink-0" style={{ color: accent }}>Rebind</span>
                            </button>

                            {/* Relationship actions */}
                            <div className="flex gap-2">
                                {c.status !== 'friend' && (
                                    <button onClick={() => handleSetContactStatus(c, 'friend')} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-emerald-200 bg-emerald-400/15 border border-emerald-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><UserPlus size={14} weight="bold" /> Add friend</button>
                                )}
                                {c.status === 'friend' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `Remove friend "${c.name}"?`, desc: `${targetChar.name} will realize you removed them while peeking at TA's phone.`,
                                        confirmLabel: 'Remove friend', danger: true, onConfirm: () => handleSetContactStatus(c, 'deleted'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> Remove friend</button>
                                )}
                                {c.status !== 'blocked' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `Block "${c.name}"?`, desc: `${targetChar.name} will realize you blocked them while peeking at TA's phone.`,
                                        confirmLabel: 'Block', danger: true, onConfirm: () => handleSetContactStatus(c, 'blocked'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Prohibit size={14} weight="bold" /> Block</button>
                                )}
                            </div>

                            {/* Dangerous actions: clear conversation / fully remove */}
                            <div className="flex gap-2">
                                {rec && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: 'Clear this conversation?',
                                        desc: c.kind === 'real' && c.linkedCharId
                                            ? `This clears "${c.name}"'s chat record and topic-box memories (the mirrored copy on their phone is cleared too), returning to a clean slate that can be regenerated afterward.`
                                            : `This clears "${c.name}"'s chat record and topic-box memories, returning to a clean slate that can be regenerated afterward.`,
                                        confirmLabel: 'Clear', danger: true, onConfirm: () => handleClearContactConversation(c),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><ChatCircle size={14} weight="bold" /> Clear conversation</button>
                                )}
                                <button onClick={() => { closeProfile(); askConfirm({
                                    title: 'Fully remove this contact?',
                                    desc: c.kind === 'real' && c.linkedCharId
                                        ? `This deletes "${c.name}" along with TA's chat record and the card in the private chat; the mirrored contact and records on the bound real character's side are cleared too (use this to clean up a wrong binding).`
                                        : `This fully deletes "${c.name}" along with TA's chat record and the card in the private chat.`,
                                    confirmLabel: 'Fully remove', danger: true, onConfirm: () => handleRemoveContact(c),
                                }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> Fully remove</button>
                            </div>
                        </div>
                    </div>
                )}
            </SubAppShell>
        );
    };

    const renderCustomItem = (r: PhoneEvidence, idx: number, total: number, accent: string, layout: LayoutId, app: PhoneCustomApp) => {
        switch (layout) {
            case 'shop':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl" style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>{app.icon}</div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                            <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                            <div className="mt-auto flex items-center justify-between pt-1.5">
                                <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '$ --'}</span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">Ordered</span>
                            </div>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'feed':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-center gap-3 mb-2.5">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: `linear-gradient(135deg, ${accent}55, ${accent}15)` }}>{app.icon}</div>
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                            </div>
                        </div>
                        <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                            <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                            <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'forum':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                            <span className="text-[14px] font-semibold text-white/95 leading-snug line-clamp-2 flex-1">{r.title}</span>
                            {r.value && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed line-clamp-3 whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-3 mt-2.5 text-[10px] text-white/35">
                            <span className="flex items-center gap-1">{app.icon} {charName}</span>
                            <span>· {1 + (r.id.length % 200)} replies</span>
                            <span>· {fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'novel':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 30px ${accent}10` }}>
                        <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: accent }}>Chapter {total - idx}</div>
                        <div className="text-[15px] font-semibold text-white/95 mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.title}</div>
                        <div className="text-[12.5px] text-white/60 leading-loose line-clamp-4 whitespace-pre-wrap" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.detail}</div>
                        <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.06] text-[10px] text-white/30">
                            <span>{r.value || 'Ongoing'}</span>
                            <span className="tabular-nums">{fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            default:
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 24px ${accent}14` }}>
                        <div className="flex justify-between items-start gap-2 mb-1.5">
                            <span className="text-[13.5px] font-semibold text-white/95 line-clamp-1">{r.title}</span>
                            {r.value && <span className="text-[12px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="text-[9.5px] text-white/25 mt-2 text-right tabular-nums">{fmtClock(r.timestamp)}</div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
        }
    };

    const renderCustomApp = (app: PhoneCustomApp) => {
        const accent = app.color || '#8b9cff';
        const layout = app.layout || 'generic';
        const layoutMeta = APP_LAYOUTS.find(l => l.id === layout);
        const list = records.filter(r => r.type === app.id).sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title={app.name} sub={layoutMeta?.name || 'custom app'} accent={accent} onBack={() => setActiveAppId('home')}
                    right={<span className="text-lg">{app.icon}</span>} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="No data yet" />}
                    {list.map((r, idx) => renderCustomItem(r, idx, list.length, accent, layout, app))}
                </div>
                <RefreshFab onClick={() => handleGenerate(app.id, app.prompt, layout)} label="Refresh data" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  HOME DESKTOP (mirrors the reference design)
    // ============================================================
    const renderHomePage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-2 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-5">
                <div className="min-w-0">
                    <h1 className="text-[34px] leading-none text-white font-light tracking-wide truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{charName}</h1>
                    <p className="text-[11px] tracking-[0.35em] uppercase text-white/40 mt-2">The Space Between</p>
                    <div className="h-px w-28 bg-gradient-to-r from-white/30 to-transparent mt-3" />
                </div>
                <div className="flex flex-col items-end shrink-0 pt-1 text-white/70">
                    <Cloud size={26} weight="light" />
                    <span className="text-[15px] font-light mt-1 tabular-nums">{temp}°C</span>
                </div>
            </div>

            {/* Time */}
            <div className="mb-4">
                <div className="text-[30px] font-extralight text-white tracking-[0.08em] tabular-nums">{clockNow}</div>
                <div className="text-[12px] text-white/45 mt-0.5">{dateNow}</div>
            </div>

            {/* Quote: shows the most recent InnerState (inner monologue) if there is one (truncated to one line, tap to see the full text), otherwise a fallback line */}
            {innerQuote ? (
                <button onClick={() => setShowInner(true)} className="block w-full text-left mb-5 group">
                    <p className="text-[13px] text-white/65 italic leading-relaxed line-clamp-1">"{innerQuote}"</p>
                    <span className="text-[9px] tracking-wider text-white/30 group-active:text-white/55">Something left unsaid · tap</span>
                </button>
            ) : (
                <p className="text-[13px] text-white/55 italic mb-5 leading-relaxed">{fallbackQuote}</p>
            )}

            {/* Persona simulation hero */}
            <button onClick={() => { setActiveAppId('persona'); trackEvent('Open Check Phone Sub-App', { subApp: 'persona' }); }}
                className="relative w-full rounded-[24px] p-5 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform"
                style={{ background: 'linear-gradient(115deg, rgba(184,155,255,0.22), rgba(120,90,214,0.08) 55%, rgba(20,18,30,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-40 h-40 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.55), transparent 70%)' }} />
                <div className="relative z-10">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">Persona Simulation</div>
                    <div className="text-[18px] font-light text-white mt-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>Become TA for a stretch of their life</div>
                    <div className="text-[11px] text-white/55 mt-1.5">Not looking at TA's phone · living it through TA's phone</div>
                    <div className="flex items-center justify-between mt-4">
                        <span className="text-[11px] text-white/45 flex items-center gap-1.5">
                            <ClockCounterClockwise size={13} /> Life records · {simLogCount}
                        </span>
                        <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: '#c9b6ff' }}>Enter the performance <CaretRight size={11} weight="bold" /></span>
                    </div>
                </div>
            </button>

            {/* App cards -- "Contacts" takes over the original Message main slot (Message is deprecated, tucked into Contacts as a low-key entry point) */}
            <div className="grid grid-cols-2 gap-3.5 mb-3.5">
                <HomeCard icon={<UsersThree size={24} weight="light" />} label="Contacts" sub={contactsSub} accent="#f472b6"
                    onClick={() => { setActiveAppId('contacts'); trackEvent('Open Check Phone Sub-App', { subApp: 'contacts' }); }} />
                <HomeCard icon={<ImagesSquare size={24} weight="light" />} label="Moments" sub={momentsSub} accent="#c084fc"
                    onClick={() => { setActiveAppId('social'); trackEvent('Open Check Phone Sub-App', { subApp: 'social' }); }} />
                <HomeCard icon={<Hamburger size={24} weight="light" />} label="Food" sub={foodSub} accent="#fbbf24"
                    onClick={() => { setActiveAppId('waimai'); trackEvent('Open Check Phone Sub-App', { subApp: 'waimai' }); }} />
                <HomeCard icon={<ShoppingBag size={24} weight="light" />} label="Taobao" sub={taobaoSub} accent="#ff7a45"
                    onClick={() => { setActiveAppId('taobao'); trackEvent('Open Check Phone Sub-App', { subApp: 'taobao' }); }} />
            </div>

            {/* Agent: peek at "their little phone" -- a bold banner entry point */}
            <button onClick={() => { setActiveAppId('aiagent'); trackEvent('Open Check Phone Sub-App', { subApp: 'aiagent' }); }}
                className="relative w-full rounded-[24px] p-4 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform flex items-center gap-3.5"
                style={{ background: 'linear-gradient(115deg, rgba(52,211,153,0.20), rgba(16,185,129,0.06) 55%, rgba(12,20,18,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-36 h-36 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.45), transparent 70%)' }} />
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08] shrink-0 relative z-10"
                    style={{ background: 'linear-gradient(135deg, #34d39933, #34d3990a)', color: '#34d399', boxShadow: 'inset 0 0 16px #34d39922' }}>
                    <Robot size={24} weight="light" />
                </div>
                <div className="relative z-10 min-w-0 flex-1">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">AI Agents</div>
                    <div className="text-[16px] font-semibold text-white mt-0.5">Agent</div>
                    <div className="text-[11px] text-white/55 mt-0.5 truncate">{aiSub}</div>
                </div>
                <CaretRight size={16} weight="bold" className="relative z-10 text-white/40 shrink-0" />
            </button>

            {/* Add app + my apps row */}
            <div className="grid grid-cols-2 gap-3.5 mb-7">
                <button onClick={() => setShowCreateModal(true)}
                    className={`${customApps.length ? '' : 'col-span-2'} rounded-[20px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]`}>
                    <Plus size={22} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">Add App</span>
                </button>
                {customApps.length > 0 && (
                    <button onClick={() => setPage(1)}
                        className="rounded-[20px] p-4 border border-white/[0.07] bg-white/[0.03] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]">
                        <DotsThree size={26} weight="bold" className="text-white/60" />
                        <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">My Apps · {customApps.length}</span>
                    </button>
                )}
            </div>

            {/* Today's activity */}
            <div className="rounded-[22px] p-4 border border-white/[0.07] bg-white/[0.025] backdrop-blur-xl mb-6">
                <div className="flex items-center justify-between mb-3.5">
                    <span className="text-[10px] tracking-[0.25em] uppercase text-white/45">Today's Activity</span>
                    <span className="text-[10px] text-white/35 flex items-center gap-0.5">More <CaretRight size={10} weight="bold" /></span>
                </div>
                <div className="flex gap-4">
                    <div className="flex-1 min-w-0 space-y-2.5">
                        {activity.length === 0 && <div className="text-[11px] text-white/30">No activity yet</div>}
                        {activity.map((a, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i === activity.length - 1 ? '#c084fc' : 'rgba(255,255,255,0.3)' }} />
                                <span className="text-[11px] text-white/45 tabular-nums w-[58px] shrink-0">{fmtClock(a.t)}</span>
                                <span className="text-[12px] text-white/75 truncate">{a.label}</span>
                            </div>
                        ))}
                    </div>
                    <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
                            <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="none" />
                            <circle cx="50" cy="50" r="42" stroke="url(#stRing)" strokeWidth="3" fill="none" strokeLinecap="round"
                                strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - ringP)} />
                            <defs>
                                <linearGradient id="stRing" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stopColor="#c084fc" />
                                    <stop offset="100%" stopColor="#8b9cff" />
                                </linearGradient>
                            </defs>
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-[8px] tracking-[0.15em] uppercase text-white/40">Screen</span>
                            <span className="text-[14px] font-light text-white tabular-nums">{stH}h {stM}m</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Last seen */}
            <div className="flex items-center justify-center gap-1.5 text-white/35">
                <LockSimple size={12} weight="fill" />
                <span className="text-[11px] tracking-wide">{lastSeenText}</span>
            </div>
        </div>
    );

    const renderAppsPage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-4 pb-32">
            <div className="flex items-center justify-between mb-6">
                <button onClick={() => setPage(0)} className="flex items-center gap-1 text-white/50 text-[12px]">
                    <CaretLeft size={14} weight="bold" /> Home
                </button>
                <span className="text-[11px] tracking-[0.3em] uppercase text-white/45">Installed Apps</span>
                <div className="w-12" />
            </div>
            <div className="grid grid-cols-2 gap-3.5">
                {customApps.map(app => {
                    const accent = app.color || '#8b9cff';
                    const count = records.filter(r => r.type === app.id).length;
                    return (
                        <div key={app.id} className="relative group">
                            <button onClick={() => setActiveAppId(app.id)}
                                className="w-full rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition min-h-[130px] flex flex-col justify-between">
                                <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl opacity-50 pointer-events-none"
                                    style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
                                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl border border-white/[0.08] relative z-10"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, boxShadow: `inset 0 0 16px ${accent}22` }}>
                                    {app.icon}
                                </div>
                                <div className="relative z-10">
                                    <div className="text-[14px] font-semibold text-white truncate">{app.name}</div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{count} record(s)</div>
                                    <div className="h-[3px] w-8 rounded-full mt-2" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
                                </div>
                            </button>
                            <button onClick={() => handleDeleteApp(app.id)}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center text-[12px] leading-none opacity-0 group-hover:opacity-100 transition z-20 shadow-md">×</button>
                        </div>
                    );
                })}
                <button onClick={() => setShowCreateModal(true)}
                    className="rounded-[24px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[130px]">
                    <Plus size={24} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.2em] uppercase text-white/50">Add App</span>
                </button>
            </div>
        </div>
    );

    const renderDesktop = () => {
        const hasBg = !!dateBackgroundUrl;
        const totalPages = customApps.length > 0 ? 2 : 1;

        const onTouchStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
            touchStartY.current = e.touches[0].clientY;
        };
        const onTouchEnd = (e: React.TouchEvent) => {
            if (touchStartX.current == null || touchStartY.current == null) return;
            const dx = e.changedTouches[0].clientX - touchStartX.current;
            const dy = e.changedTouches[0].clientY - touchStartY.current;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0 && page < totalPages - 1) setPage(page + 1);
                if (dx > 0 && page > 0) setPage(page - 1);
            }
            touchStartX.current = null;
            touchStartY.current = null;
        };

        return (
            <div className="absolute inset-0 flex flex-col z-0 overflow-hidden bg-[#070809]">
                {/* Cinematic background */}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d2b 0%, #0a0c12 55%, #060709 100%)' }} />
                {hasBg && (
                    <div className="absolute inset-0 opacity-25 pointer-events-none"
                        style={{ backgroundImage: `url("${dateBackgroundUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                )}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'linear-gradient(to bottom, rgba(7,8,9,0.35) 0%, rgba(7,8,9,0.1) 30%, rgba(7,8,9,0.85) 100%)' }} />
                <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/15 to-transparent pointer-events-none z-20" />

                <StatusStrip />

                {/* Pager */}
                <div className="flex-1 relative z-10 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                    <div className="flex h-full w-[200%] transition-transform duration-500 ease-out"
                        style={{ transform: `translateX(-${page * 50}%)` }}>
                        {renderHomePage()}
                        {renderAppsPage()}
                    </div>
                </div>

                {/* Page dots */}
                {totalPages > 1 && (
                    <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 flex gap-2 z-40">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button key={i} onClick={() => setPage(i)}
                                className="rounded-full transition-all"
                                style={{ width: page === i ? 18 : 6, height: 6, background: page === i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)' }} />
                        ))}
                    </div>
                )}

                {/* Floating glass nav */}
                <nav className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] z-40">
                    <div className="bg-white/[0.06] backdrop-blur-2xl rounded-[26px] border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] flex justify-around items-center px-3 py-2.5">
                        <button onClick={() => setActiveAppId('call')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Phone size={22} weight="light" />
                        </button>
                        <button onClick={() => setActiveAppId('contacts')} aria-label="Contacts" className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <UsersThree size={22} weight="light" />
                        </button>
                        <button onClick={handleExitPhone} aria-label="Disconnect"
                            className="relative flex items-center justify-center w-14 h-14 rounded-full active:scale-90 transition -my-1"
                            style={{ background: 'radial-gradient(circle at 35% 30%, #b89bff, #6d5bd6 55%, #2a2150 100%)', boxShadow: '0 0 24px rgba(157,124,255,0.55), inset 0 0 18px rgba(255,255,255,0.25)' }}>
                            <SignOut size={22} weight="bold" className="text-white" />
                        </button>
                        <button onClick={() => setActiveAppId('social')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Compass size={22} weight="light" />
                        </button>
                        <button onClick={toggleSendToChat} aria-label="Sync to private chat"
                            className="relative flex items-center justify-center p-2.5 hover:text-white rounded-2xl transition active:scale-90"
                            style={{ color: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.4)' }}>
                            <GearSix size={22} weight={sendToChat ? 'fill' : 'light'} />
                            <span className="absolute bottom-1 right-1.5 w-1.5 h-1.5 rounded-full"
                                style={{ background: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.25)', boxShadow: sendToChat ? '0 0 6px #7dd3fc' : 'none' }} />
                        </button>
                    </div>
                </nav>
            </div>
        );
    };

    // ============================================================
    //  TARGET-SELECT SCREEN
    // ============================================================
    if (view === 'select') {
        return (
            <div className="absolute inset-0 flex flex-col overflow-hidden text-white"
                style={{ background: 'radial-gradient(120% 80% at 50% 0%, #161826 0%, #0a0b10 60%)' }}>
                <StatusStrip />
                <div className="h-14 flex items-center justify-between px-4 shrink-0">
                    <button onClick={closeApp} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <span className="font-semibold tracking-[0.25em] uppercase text-[13px] text-white/80">Target Device</span>
                    <button onClick={() => { setPhoneApiTestResult(null); setShowApiSettings(true); }} aria-label="Check Phone API settings"
                        className="relative w-9 h-9 rounded-full flex items-center justify-center text-white/75 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <GearSix size={17} weight={phoneApiFollowsDefault ? 'regular' : 'fill'} />
                        {!phoneApiFollowsDefault && <span className="absolute right-1.5 bottom-1.5 h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_#a78bfa]" />}
                    </button>
                </div>
                {(() => {
                    const PER_PAGE = 6;
                    const groupChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
                    const pageCount = Math.max(1, Math.ceil(groupChars.length / PER_PAGE));
                    const cur = Math.min(selectPage, pageCount - 1);
                    const pageChars = groupChars.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);
                    return (
                        <div className="flex-1 min-h-0 flex flex-col">
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                                value={selectGroupId} onChange={(id) => { setSelectGroupId(id); setSelectPage(0); }}
                                className="px-5 pt-1 shrink-0" />
                            <div className="flex-1 min-h-0 px-5 grid grid-cols-2 grid-rows-3 gap-4 content-center pb-4 pt-2">
                                {pageChars.map(c => (
                                    <div key={c.id} onClick={() => handleSelectChar(c)}
                                        className="min-h-0 rounded-3xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-xl p-4 flex flex-col items-center justify-center gap-3 cursor-pointer active:scale-95 transition group hover:border-violet-400/50 hover:shadow-[0_0_24px_rgba(157,124,255,0.25)] relative overflow-hidden">
                                        <div className="absolute -top-10 -right-10 w-28 h-28 rounded-full blur-3xl bg-violet-500/0 group-hover:bg-violet-500/20 transition" />
                                        <div className="w-20 h-20 rounded-full p-[2px] border-2 border-white/15 group-hover:border-violet-400/70 transition-colors relative z-10 shrink-0">
                                            <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover grayscale group-hover:grayscale-0 transition-all" />
                                        </div>
                                        <div className="text-center relative z-10">
                                            <div className="font-semibold text-white/90 text-sm group-hover:text-violet-300">{c.name}</div>
                                            <div className="text-[10px] text-white/35 font-mono mt-1 tracking-widest">CONNECT &gt;</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {pageCount > 1 && (
                                <div className="shrink-0 flex items-center justify-center gap-4 pb-6 pt-3">
                                    <button onClick={() => setSelectPage(Math.max(0, cur - 1))} disabled={cur === 0}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" />
                                    </button>
                                    <div className="flex items-center gap-2">
                                        {Array.from({ length: pageCount }, (_, pi) => (
                                            <button key={pi} onClick={() => setSelectPage(pi)} aria-label={`Page ${pi + 1}`}
                                                className={`h-2 rounded-full transition-all active:scale-90 ${pi === cur ? 'w-5 bg-violet-400' : 'w-2 bg-white/25'}`} />
                                        ))}
                                    </div>
                                    <button onClick={() => setSelectPage(Math.min(pageCount - 1, cur + 1))} disabled={cur === pageCount - 1}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" className="rotate-180" />
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })()}
                <Modal isOpen={showApiSettings} title="Check Phone · API Settings" onClose={() => setShowApiSettings(false)}>
                    <div className="space-y-3">
                        <p className="text-[11px] leading-relaxed text-slate-500">
                            Content generation, relationship conversations, the Agent, and Persona Simulation in Check Phone all go through here. Choosing one here does not affect chat; leave it unset to follow the chat default.
                        </p>
                        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3.5">
                            <div className="text-[10px] tracking-[0.18em] text-slate-400 mb-1">Currently in effect</div>
                            <div className="text-[13px] font-bold text-slate-800 break-all">{effectiveApiConfig?.model || 'Not configured'}</div>
                            <div className="text-[10.5px] text-slate-400 mt-0.5 break-all">
                                {apiHost(effectiveApiConfig?.baseUrl)} · {phoneApiFollowsDefault ? 'Following chat default' : 'Check Phone independent'}
                            </div>
                            <button onClick={testPhoneApi} disabled={testingPhoneApi}
                                className="mt-2.5 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-bold disabled:opacity-50">
                                {testingPhoneApi ? 'Testing...' : 'Test connection'}
                            </button>
                            {phoneApiTestResult && (
                                <div className={`mt-2 rounded-xl px-2.5 py-2 text-[10.5px] leading-relaxed ${phoneApiTestResult.startsWith('Connected') ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                                    {phoneApiTestResult}
                                </div>
                            )}
                        </div>

                        <div className="text-[10px] tracking-[0.18em] text-slate-400 px-1">Choose an API</div>
                        <button onClick={() => choosePhoneApi(null)}
                            className={`w-full rounded-2xl border p-3 text-left transition ${phoneApiFollowsDefault ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                            <div className="flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-bold text-slate-800">Follow chat default</div>
                                    <div className="text-[10px] text-slate-400 truncate">{apiConfig?.model || 'Not configured'} · {apiHost(apiConfig?.baseUrl)}</div>
                                </div>
                                {phoneApiFollowsDefault && <span className="text-[10px] font-bold text-violet-600">✓ In use</span>}
                            </div>
                        </button>

                        {apiPresets.length === 0 ? (
                            <p className="px-1 text-[10.5px] leading-relaxed text-slate-400">No saved API presets in "Settings" yet. Save a preset there first, then it can be selected here.</p>
                        ) : apiPresets.map(preset => {
                            const active = isSamePhoneApi(preset.config);
                            return (
                                <button key={preset.id} onClick={() => choosePhoneApi(preset.config)}
                                    className={`w-full rounded-2xl border p-3 text-left transition ${active ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                                    <div className="flex items-center gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[12px] font-bold text-slate-800 truncate">{preset.name}</div>
                                            <div className="text-[10px] text-slate-400 truncate">{preset.config.model || 'Not configured'} · {apiHost(preset.config.baseUrl)}</div>
                                        </div>
                                        {active && <span className="text-[10px] font-bold text-violet-600">✓ In use</span>}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Modal>
            </div>
        );
    }

    // ============================================================
    //  PHONE VIEW
    // ============================================================
    const customActive = customApps.find(a => a.id === activeAppId);
    return (
        <div className="absolute inset-0 bg-[#070809] overflow-hidden font-sans overscroll-none">
            {activeAppId === 'home' ? renderDesktop() : (
                <>
                    {activeAppId === 'chat' && renderChatList()}
                    {activeAppId === 'chat_detail' && renderChatDetail()}
                    {activeAppId === 'evidence_detail' && renderEvidenceDetail()}
                    {activeAppId === 'contacts' && renderContactsList()}
                    {activeAppId === 'contact_detail' && renderContactDetail()}
                    {activeAppId === 'call' && renderCallList()}
                    {activeAppId === 'taobao' && renderShop()}
                    {activeAppId === 'waimai' && renderFood()}
                    {activeAppId === 'social' && renderMoments()}
                    {activeAppId === 'aiagent' && renderAiAgent()}
                    {activeAppId === 'ai_session' && renderAiSession()}
                    {activeAppId === 'persona' && targetChar && (
                        <PersonaSim targetChar={targetChar} onExit={() => setActiveAppId('home')} openLifeLog={() => setActiveAppId('lifelog')}
                            sim={sim} onStart={runSim} onConsumed={() => personaSimStore.reset()} />
                    )}
                    {activeAppId === 'lifelog' && targetChar && (
                        <LifeLog targetChar={targetChar} onBack={() => setActiveAppId('home')}
                            onRequestDelete={requestDeleteSimLog}
                            onReplay={(log) => {
                                if (!log.script) return;
                                // Replay verbatim from the saved script snapshot -- feed it directly into the global store's ready state
                                personaSimStore.set({ status: 'ready', mode: log.mode, theme: log.theme, script: log.script, replay: true, charId: targetChar.id, charName: targetChar.name });
                                setActiveAppId('persona');
                            }} />
                    )}
                    {customActive && renderCustomApp(customActive)}
                </>
            )}

            {/* InnerState full text -- the "this moment's inner thoughts" card */}
            {showInner && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-fade-in">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowInner(false)} />
                    <div className="relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-slide-up">
                        {/* Title + star dots */}
                        <div className="px-6 pt-7 pb-3 flex items-center justify-center gap-2.5">
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current mb-1" /></span>
                            <h3 className="text-lg font-bold text-slate-800">TA's thoughts, right now</h3>
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current mb-1" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current" /></span>
                        </div>
                        {/* Quote panel */}
                        <div className="px-6 pb-2">
                            <div className="relative bg-slate-50 rounded-3xl px-5 pt-7 pb-5 max-h-[52vh] overflow-y-auto no-scrollbar">
                                <span className="absolute top-2 left-4 text-[42px] leading-none font-black select-none pointer-events-none" style={{ color: '#5f82ef' }}>"</span>
                                <p className="relative text-[14.5px] leading-[2] text-slate-600 whitespace-pre-wrap px-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                    {innerQuote}
                                </p>
                                <span className="block text-right text-[42px] leading-none font-black select-none pointer-events-none pr-2" style={{ color: '#5f82ef' }}>"</span>
                            </div>
                        </div>
                        {/* Close */}
                        <div className="px-6 pb-6 pt-3">
                            <button onClick={() => setShowInner(false)}
                                className="w-full py-3.5 rounded-2xl text-white font-bold active:scale-[0.99] transition"
                                style={{ background: '#5f82ef' }}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Agent · long-press action menu (session/card: edit / delete) */}
            {aiMenu && (() => {
                const isSession = aiMenu.kind === 'session';
                const sObj = isSession ? aiSessions.find(s => s.id === aiMenu.id) : null;
                const cObj = !isSession ? aiCards.find(c => c.id === aiMenu.id) : null;
                if (isSession ? !sObj : !cObj) return null;
                const name = isSession ? (sObj!.title || 'session') : (cObj!.name || 'card');
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">{isSession ? 'Session' : (cObj!.kind === 'world' ? 'World card' : 'Character card')}: {name}</div>
                                <button onClick={() => { setAiEdit(isSession ? { kind: 'session', id: aiMenu.id, title: sObj!.title } : { kind: 'card', id: aiMenu.id, name: cObj!.name, emoji: cObj!.emoji, persona: cObj!.persona, scenario: cObj!.scenario }); setAiMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> Edit</button>
                                <button onClick={() => { const id = aiMenu.id; const k = isSession; setAiMenu(null); askConfirm({ title: k ? `Delete the session "${sObj!.title}"?` : `Delete the ${cObj!.kind === 'world' ? 'world card' : 'character card'} "${cObj!.name}"?`, desc: k ? 'This conversation record will be deleted and cannot be undone.' : 'This card will be deleted (existing role-play records are kept), and cannot be undone.', confirmLabel: 'Delete', danger: true, onConfirm: () => (k ? handleDeleteAiSession : handleDeleteAiCard)(id) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> Delete</button>
                            </div>
                            <button onClick={() => setAiMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">Cancel</button>
                        </div>
                    </div>
                );
            })()}

            {/* Agent · long-press action menu for a single item within a session (edit / delete) */}
            {aiTurnMenu !== null && selectedAiSession && (() => {
                const turns = turnsOf(selectedAiSession);
                const turn = turns[aiTurnMenu];
                if (!turn) return null;
                const preview = turn.text.replace(/\n/g, ' ').trim().slice(0, 22);
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiTurnMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">This content: {preview}...</div>
                                <button onClick={() => { setAiTurnEdit({ idx: aiTurnMenu, text: turn.text }); setAiTurnMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> Edit</button>
                                <button onClick={() => { const idx = aiTurnMenu; setAiTurnMenu(null); askConfirm({ title: 'Delete this content?', desc: 'Only this line/floor of dialogue is deleted, and it cannot be undone.', confirmLabel: 'Delete', danger: true, onConfirm: () => handleDeleteAiTurn(idx) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> Delete</button>
                            </div>
                            <button onClick={() => setAiTurnMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">Cancel</button>
                        </div>
                    </div>
                );
            })()}

            {/* Agent · edit modal for a single item within a session */}
            <Modal isOpen={!!aiTurnEdit} title="Edit this content" onClose={() => setAiTurnEdit(null)}
                footer={<button onClick={handleSaveAiTurn} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">Save</button>}>
                {aiTurnEdit && (
                    <textarea value={aiTurnEdit.text} onChange={e => setAiTurnEdit({ ...aiTurnEdit, text: e.target.value })}
                        className="w-full h-48 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm resize-none leading-relaxed" />
                )}
            </Modal>

            {/* Agent · edit modal */}
            <Modal isOpen={!!aiEdit} title={aiEdit?.kind === 'session' ? 'Edit session' : aiEdit?.id === '__new__' ? 'New character card' : 'Edit character card'} onClose={() => setAiEdit(null)}
                footer={<button onClick={handleSaveAiEdit} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">{aiEdit?.id === '__new__' ? 'Create' : 'Save'}</button>}>
                {aiEdit && (aiEdit.kind === 'session' ? (
                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase block">Title</label>
                        <input value={aiEdit.title || ''} onChange={e => setAiEdit({ ...aiEdit, title: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                    </div>
                ) : (
                    <div className="space-y-3">
                        {aiEdit.id === '__new__' && (
                            <div className="flex gap-2">
                                {(['character', 'world'] as const).map(k => (
                                    <button key={k} onClick={() => setAiEdit({ ...aiEdit, cardKind: k })}
                                        className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition ${(aiEdit.cardKind || 'character') === k ? 'bg-violet-500 text-white border-violet-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                                        {k === 'character' ? 'Character card' : 'World card'}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <input value={aiEdit.emoji || ''} onChange={e => setAiEdit({ ...aiEdit, emoji: e.target.value })} placeholder="🎭" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                            <input value={aiEdit.name || ''} onChange={e => setAiEdit({ ...aiEdit, name: e.target.value })} placeholder="Card name" className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Persona / setting</label>
                            <textarea value={aiEdit.persona || ''} onChange={e => setAiEdit({ ...aiEdit, persona: e.target.value })} className="w-full h-20 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Scene</label>
                            <textarea value={aiEdit.scenario || ''} onChange={e => setAiEdit({ ...aiEdit, scenario: e.target.value })} className="w-full h-16 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                    </div>
                ))}
            </Modal>

            {/* Agent · character card detail (see what TA has played with it + start a session with this card) */}
            {aiCardView && (() => {
                const c = aiCards.find(x => x.id === aiCardView);
                if (!c) return null;
                const plays = aiSessions.filter(s => s.service === 'tavern' && s.cardId === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
                return (
                    <Modal isOpen={true} title={c.kind === 'world' ? 'World card' : 'Character card'} onClose={() => setAiCardView(null)}
                        footer={<button onClick={() => handlePlayCard(c)} disabled={isLoading}
                            className="w-full py-3 bg-rose-500 text-white font-bold rounded-2xl disabled:opacity-50">{isLoading ? 'Generating...' : 'Start a session with this card'}</button>}>
                        <div className="space-y-3">
                            <div className="flex items-start gap-3">
                                <div className="text-3xl shrink-0">{c.emoji}</div>
                                <div className="min-w-0">
                                    <div className="text-base font-bold text-slate-800 flex items-center gap-2 flex-wrap">{c.name}
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-500">{c.kind === 'world' ? 'World card' : 'Character card'}</span>
                                    </div>
                                    {(c.basedOnUser || c.basedOn) && <div className="text-[11px] text-rose-400 mt-0.5">⚑ Modeled after {c.basedOnUser ? 'you' : `"${c.basedOn}"`}</div>}
                                </div>
                            </div>
                            {c.persona && <div className="text-[12px] text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-3 whitespace-pre-wrap">{c.persona}</div>}
                            {c.scenario && <div className="text-[12px] text-slate-500 leading-relaxed bg-slate-50 rounded-xl p-3 italic whitespace-pre-wrap">Scene: {c.scenario}</div>}
                            <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">Sessions TA has played with this card · {plays.length}</div>
                                {plays.length === 0 && <div className="text-[12px] text-slate-400">No role-play records yet -- tap "start a session with this card" below to get TA playing.</div>}
                                <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                                    {plays.map(s => (
                                        <button key={s.id} onClick={() => { setAiCardView(null); setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                            className="w-full text-left rounded-xl p-2.5 bg-slate-50 active:bg-slate-100 transition">
                                            <div className="text-[13px] font-semibold text-slate-700 truncate">{s.title}</div>
                                            <div className="text-[10px] text-slate-400">{parseTranscript(s.transcript).length} line(s) · {fmtClock(s.updatedAt)}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </Modal>
                );
            })()}

            {/* Create App Modal */}
            <Modal isOpen={showCreateModal} title="Install Custom App" onClose={() => setShowCreateModal(false)}
                footer={<button onClick={handleCreateCustomApp} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">Install to desktop</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-md border border-white/10 shrink-0"
                            style={{ background: `linear-gradient(135deg, ${newAppColor}55, ${newAppColor}15)` }}>
                            {newAppIcon}
                        </div>
                        <div className="flex-1 space-y-2">
                            <input value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="App name (e.g. Bank)" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                            <div className="flex gap-2">
                                <input value={newAppIcon} onChange={e => setNewAppIcon(e.target.value)} placeholder="Emoji" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                                <input type="color" value={newAppColor} onChange={e => setNewAppColor(e.target.value)} className="h-9 flex-1 cursor-pointer rounded-lg bg-transparent" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Function instructions (AI Prompt)</label>
                        <textarea
                            value={newAppPrompt}
                            onChange={e => setNewAppPrompt(e.target.value)}
                            placeholder="e.g.: Show this user's account balance, recent transfers, and investment returns."
                            className="w-full h-24 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">The AI will generate this App's internal data based on this instruction.</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">Layout template (UI Style)</label>
                        <div className="grid grid-cols-2 gap-2">
                            {APP_LAYOUTS.map(l => {
                                const active = newAppLayout === l.id;
                                return (
                                    <button key={l.id} type="button" onClick={() => setNewAppLayout(l.id)}
                                        className={`text-left rounded-xl p-2.5 border transition flex items-center gap-2.5 ${active ? 'border-transparent text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                                        style={active ? { background: newAppColor } : undefined}>
                                        <span className="text-lg leading-none shrink-0">{l.icon}</span>
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-bold leading-tight">{l.name}</div>
                                            <div className={`text-[9px] leading-tight truncate ${active ? 'text-white/80' : 'text-slate-400'}`}>{l.desc}</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* New Contact / Agent Modal */}
            <Modal isOpen={showContactModal} title="Add Contact" onClose={() => setShowContactModal(false)}
                footer={<button onClick={handleCreateContact} className="w-full py-3 bg-pink-500 text-white font-bold rounded-2xl">Add</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">Type</label>
                        <div className="grid grid-cols-2 gap-2">
                            {([
                                { id: 'npc', name: 'NPC', desc: 'Fictional passerby' },
                                { id: 'real', name: 'Real person', desc: 'Bind to a Neural Link character' },
                            ] as const).map(opt => {
                                const active = ncKind === opt.id;
                                return (
                                    <button key={opt.id} type="button" onClick={() => setNcKind(opt.id)}
                                        className={`text-left rounded-xl p-2.5 border transition ${active ? 'border-transparent bg-pink-500 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                        <div className="text-[12px] font-bold leading-tight">{opt.name}</div>
                                        <div className={`text-[9px] leading-tight ${active ? 'text-white/80' : 'text-slate-400'}`}>{opt.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {ncKind === 'real' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Bind to a real character</label>
                            <select value={ncLinkedId} onChange={e => setNcLinkedId(e.target.value)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                                <option value="">-- Choose a character --</option>
                                {characters.filter(c => c.id !== targetChar?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <p className="text-[9px] text-slate-400 mt-1">Real people can start a two-way conversation, which syncs into the other person's phone.</p>
                        </div>
                    ) : (
                        <input value={ncName} onChange={e => setNcName(e.target.value)} placeholder="Contact name (fictional)" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                    )}
                </div>
            </Modal>

            {/* Rebind Modal: rebind a contact to the correct real character / convert to fictional (keeps conversation + note + learned info + affinity) */}
            <Modal isOpen={showRebindModal} title="Rebind" onClose={() => setShowRebindModal(false)}>
                {selectedContact && (
                    <div className="space-y-3">
                        <p className="text-[11.5px] text-slate-500 leading-relaxed">
                            Fix a wrong discrimination/binding here. This keeps the conversation, note, learned info, and affinity; rebinding to a real person syncs the conversation into their phone, and clears the previously mis-bound character's side.
                        </p>
                        {/* Convert to fictional */}
                        <button
                            onClick={() => handleRebindContact(selectedContact, { kind: 'npc' })}
                            disabled={selectedContact.kind === 'npc'}
                            className={`w-full flex items-center gap-2.5 rounded-xl p-3 border text-left transition ${selectedContact.kind === 'npc' ? 'border-slate-200 bg-slate-100 opacity-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                            <span className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 shrink-0"><User size={16} weight="bold" /></span>
                            <div className="min-w-0">
                                <div className="text-[13px] font-bold text-slate-700">Convert to fictional contact</div>
                                <div className="text-[10px] text-slate-400">No real-character binding · treated as an NPC{selectedContact.kind === 'npc' ? ' (currently the case)' : ''}</div>
                            </div>
                        </button>
                        {/* Bind to a real character */}
                        <div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">Bind to a real character</div>
                            <div className="max-h-64 overflow-y-auto space-y-1.5 no-scrollbar">
                                {characters.filter(c => c.id !== targetChar?.id).length === 0 && (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">No other characters in the Neural Link to bind to.</p>
                                )}
                                {characters.filter(c => c.id !== targetChar?.id).map(rc => {
                                    const current = selectedContact.kind === 'real' && selectedContact.linkedCharId === rc.id;
                                    return (
                                        <button key={rc.id}
                                            onClick={() => handleRebindContact(selectedContact, { kind: 'real', charId: rc.id })}
                                            disabled={current}
                                            className={`w-full flex items-center gap-2.5 rounded-xl p-2.5 border text-left transition ${current ? 'border-pink-300 bg-pink-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                                            <TokenImg value={rc.avatar} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                            <span className="text-[13px] font-semibold text-slate-700 flex-1 truncate">{rc.name}</span>
                                            {current && <span className="text-[10px] font-bold text-pink-500 shrink-0">Currently bound</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Topic box memory · edit/delete (opened by long-pressing a memory) */}
            <Modal isOpen={!!topicEdit} title="Chat memory" onClose={() => setTopicEdit(null)}
                footer={topicEdit ? (
                    <div className="flex gap-2">
                        <button onClick={() => {
                            const { contactId, topicId } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).filter(t => t.id !== topicId) } : c));
                            setTopicEdit(null);
                            addToast('Memory deleted', 'success');
                        }} className="px-4 py-3 bg-rose-500 text-white font-bold rounded-2xl">Delete</button>
                        <button onClick={() => {
                            const { contactId, topicId, text } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).map(t => t.id === topicId ? { ...t, text: text.trim() } : t) } : c));
                            setTopicEdit(null);
                            addToast('Saved', 'success');
                        }} className="flex-1 py-3 bg-pink-500 text-white font-bold rounded-2xl">Save</button>
                    </div>
                ) : undefined}>
                {topicEdit && (
                    <div className="space-y-2">
                        <p className="text-[11px] text-slate-400">This is a first-person, subjectively colored chat memory belonging to the character (used as context). You can rewrite or delete it.</p>
                        <textarea value={topicEdit.text} onChange={e => setTopicEdit({ ...topicEdit, text: e.target.value })}
                            className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-[13px] resize-none" />
                    </div>
                )}
            </Modal>

            {/* Generic confirmation modal: delete / remove / block / clear all route through here */}
            <Modal
                isOpen={!!confirmState}
                title={confirmState?.title || ''}
                onClose={() => setConfirmState(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmState(null)}
                            className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">Cancel</button>
                        <button onClick={() => { const cb = confirmState?.onConfirm; setConfirmState(null); cb?.(); }}
                            className={`flex-1 py-3 font-bold rounded-2xl text-white active:scale-95 transition-transform ${confirmState?.danger ? 'bg-rose-500' : 'bg-pink-500'}`}>
                            {confirmState?.confirmLabel || 'Confirm'}
                        </button>
                    </div>
                }>
                <p className="text-[13px] text-slate-500 leading-relaxed text-center">{confirmState?.desc || 'This action cannot be undone.'}</p>
            </Modal>
        </div>
    );
};

export default CheckPhone;
