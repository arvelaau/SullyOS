
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { RoomItem, CharacterProfile, RoomTodo, RoomNote, DailySchedule, AppID } from '../types';
import ScheduleCard from '../components/schedule/ScheduleCard';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { processImageToBlob } from '../utils/file';
import { putImageBlob, useBlobRefUrl, isBlobRef, migrateDataUrlToRef, resolveBlobRefsDeep } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';
import Modal from '../components/os/Modal';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { Door, Sparkle, Image, GearSix, Camera, MoonStars, ArrowUUpLeft, ArrowUUpRight, CopySimple, Images, Eye, EyeSlash } from '@phosphor-icons/react';
import { FURNITURE_ICONS } from '../utils/furnitureIcons';
import PixelHomeView from './pixelHome/PixelHomeView';
import WorldHomeApp from './WorldHomeApp';
import DreamTheater from './DreamTheater';
import { useDreamSim, dreamSimStore } from '../utils/dreamSimStore';
import { roomLaunch } from '../utils/roomLaunch';
import { characterLaunch } from '../utils/characterLaunch';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getVirtualDayKey } from '../utils/localDate';
import { resolveCharTimeZone, nowInTimeZone, tzLabel } from '../utils/timezone';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { trackEvent } from '../utils/analytics';
import { normalizeBuiltInRoomTemplateAssetsInPlace, toPortableBuiltinRoomAsset } from '../utils/roomTemplateAssets';
import { shareOrDownloadFile } from '../utils/shareExport';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

/** Soft-color backdrops for "visit room" cards (cycled in order, giving each room its own fantastical tint). */
const ROOM_CARD_TINTS = [
    'linear-gradient(180deg,rgba(120,92,170,.42),rgba(34,26,62,.6))',
    'linear-gradient(180deg,rgba(70,80,135,.42),rgba(26,28,56,.62))',
    'linear-gradient(180deg,rgba(150,132,192,.4),rgba(52,42,86,.6))',
    'linear-gradient(180deg,rgba(110,150,200,.4),rgba(34,52,86,.6))',
    'linear-gradient(180deg,rgba(132,96,176,.42),rgba(46,30,78,.6))',
    'linear-gradient(180deg,rgba(70,64,92,.46),rgba(24,22,40,.64))',
];
/** Light (Dwelling/Homeland section) card soft-color backdrop -- pink/lavender/light-blue gradients. */
const ROOM_CARD_TINTS_LIGHT = [
    'linear-gradient(180deg,rgba(250,212,228,.85),rgba(242,228,246,.8))',
    'linear-gradient(180deg,rgba(232,228,248,.85),rgba(242,238,250,.8))',
    'linear-gradient(180deg,rgba(226,216,246,.85),rgba(238,230,249,.8))',
    'linear-gradient(180deg,rgba(212,230,247,.85),rgba(234,240,250,.8))',
    'linear-gradient(180deg,rgba(226,212,245,.85),rgba(238,228,249,.8))',
    'linear-gradient(180deg,rgba(234,231,242,.88),rgba(242,240,247,.82))',
];

// --- 1. Royalty-free sticker asset library (Sticker Library) ---
// Uses hand-drawn SVG icons instead of Twemoji, for a more refined visual experience
const ASSET_LIBRARY = {
    // Sully-exclusive furniture (default sizes already tuned to your layout)
    sully_special: [
        { name: "Sully's Bed", image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png', defaultScale: 2.4 },
        { name: "Sully's Computer Desk", image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png', defaultScale: 2.4 },
        { name: "Sully's Bookcase", image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png', defaultScale: 2.0 },
        { name: "Sully's Pegboard", image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png', defaultScale: 2.6 },
        { name: "Sully's Trash Can", image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png', defaultScale: 0.9 },
    ],
    furniture: [
        { name: 'Bed', image: FURNITURE_ICONS.bed, defaultScale: 1.5 },
        { name: 'Sofa', image: FURNITURE_ICONS.sofa, defaultScale: 1.4 },
        { name: 'Chair', image: FURNITURE_ICONS.chair, defaultScale: 1.0 },
        { name: 'Toilet', image: FURNITURE_ICONS.toilet, defaultScale: 1.0 },
        { name: 'Bathtub', image: FURNITURE_ICONS.bathtub, defaultScale: 1.5 },
    ],
    rug: [
        { name: 'Striped Rug', image: FURNITURE_ICONS.rug, defaultScale: 1.6 },
        { name: 'Round Rug', image: FURNITURE_ICONS.roundRug, defaultScale: 1.6 },
    ],
    decor: [
        { name: 'Potted Plant', image: FURNITURE_ICONS.plant, defaultScale: 0.8 },
        { name: 'Computer', image: FURNITURE_ICONS.computer, defaultScale: 0.8 },
        { name: 'Game Console', image: FURNITURE_ICONS.gamepad, defaultScale: 0.6 },
        { name: 'Guitar', image: FURNITURE_ICONS.guitar, defaultScale: 1.0 },
        { name: 'Painting', image: FURNITURE_ICONS.painting, defaultScale: 1.2 },
        { name: 'Book Stack', image: FURNITURE_ICONS.books, defaultScale: 0.8 },
        { name: 'Table Lamp', image: FURNITURE_ICONS.lamp, defaultScale: 0.8 },
        { name: 'Trash Can', image: FURNITURE_ICONS.trash, defaultScale: 0.7 },
    ],
    food: [
        { name: 'Coffee', image: FURNITURE_ICONS.coffee, defaultScale: 0.5 },
        { name: 'Cake', image: FURNITURE_ICONS.cake, defaultScale: 0.6 },
        { name: 'Pizza', image: FURNITURE_ICONS.pizza, defaultScale: 0.8 },
    ]
};

// Preset background images
const WALLPAPER_PRESETS = [
    { name: 'Warm White', value: 'radial-gradient(circle at 50% 50%, #fdfbf7 0%, #e2e8f0 100%)' },
    { name: 'Midnight Blue', value: 'linear-gradient(to bottom, #1e293b 0%, #0f172a 100%)' },
    { name: 'Girlish Pink', value: 'radial-gradient(circle at 50% 50%, #fff1f2 0%, #ffe4e6 100%)' },
    { name: 'Minimal Gray', value: 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)' },
    { name: 'Wood Grain', value: 'repeating-linear-gradient(45deg, #f7fee7 0px, #f7fee7 10px, #ecfccb 10px, #ecfccb 20px)' },
];

const FLOOR_PRESETS = [
    { name: 'Light Wood Boards', value: 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)' },
    { name: 'Dark Wood Boards', value: 'repeating-linear-gradient(90deg, #78350f 0px, #78350f 20px, #451a03 21px)' },
    { name: 'Checkered Tile', value: 'conic-gradient(from 90deg at 2px 2px, #0000 90deg, #cbd5e1 0) 0 0/30px 30px' },
    { name: 'Plain Carpet', value: '#d1d5db' },
];

const DEFAULT_FURNITURE: RoomItem[] = [
    { id: 'desk', name: 'Desk', type: 'furniture', image: ASSET_LIBRARY.furniture[1].image, x: 20, y: 55, scale: 1.2, rotation: 0, isInteractive: true, descriptionPrompt: 'This is a desk, which may be messy or may be perfectly tidy.' },
    { id: 'plant', name: 'Potted Plant', type: 'decor', image: ASSET_LIBRARY.decor[0].image, x: 85, y: 40, scale: 0.8, rotation: 0, isInteractive: true, descriptionPrompt: 'A plant in the corner.' },
];

// User-provided layout (Perfectly aligned!)
const SULLY_FURNITURE: RoomItem[] = [
  {
    id: "item-1768927221380",
    name: "Sully's Bed",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png",
    x: 78.45852578067732,
    y: 97.38889754570907,
    scale: 2.4,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "A cat bed that looks (allegedly) very comfy to sleep in."
  },
  {
    id: "item-1768927255102",
    name: "Sully's Computer Desk",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png",
    x: 28.853756791175588,
    y: 69.9444485439727,
    scale: 2.4,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "A hardcore computer desk, probably running some world-ending program."
  },
  {
    id: "item-1768927271632",
    name: "Sully's Trash Can",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png",
    x: 10.276680026943646,
    y: 80.49999880981437,
    scale: 0.9,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "Don't go rummaging through the trash!"
  },
  {
    id: "item-1768927286526",
    name: "Sully's Pegboard",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png",
    x: 32.608697687684455,
    y: 48.72222587415929,
    scale: 2.6,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "A pegboard holding all sorts of strange hacking tools and cat-themed knickknacks."
  },
  {
    id: "item-1768927303472",
    name: "Sully's Bookcase",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png",
    x: 79.84189945375853,
    y: 68.94444543117953,
    scale: 2,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "A shelf crammed with technical books and comics."
  }
];

const FLOOR_HORIZON = 65; // Floor starts at 65% from top

type BuiltInRoomTemplate = {
    id: string;
    label: 'A' | 'B';
    name: string;
    description: string;
    templateUrl: string;
    thumbnail: string;
};

// public assets must carry the BASE_URL prefix, to stay compatible with GitHub Pages'
// repo sub-path deployment (see vite.config.ts's base config).
// Hardcoding a root-absolute path (/room-templates/...) would hit the domain root and 404.
const PUBLIC_BASE = (import.meta as any).env?.BASE_URL ?? '/';
const publicAsset = (p: string) => `${PUBLIC_BASE}${p}`.replace(/\/+/g, '/');

const BUILTIN_ROOM_TEMPLATES: BuiltInRoomTemplate[] = [
    {
        id: 'forest-cottage',
        label: 'A',
        name: 'Forest Cottage',
        description: 'Greenery, wood grain, and a soft, homey feel.',
        templateUrl: publicAsset('room-templates/forest-cottage/template.json'),
        thumbnail: publicAsset('room-templates/forest-cottage/preview.png'),
    },
    {
        id: 'blue-minimal',
        label: 'B',
        name: 'Blue Minimalist',
        description: 'Crisp blue tones with a clean, tidy layout.',
        templateUrl: publicAsset('room-templates/blue-minimal/template.json'),
        thumbnail: publicAsset('room-templates/blue-minimal/preview.png'),
    },
];

const SAMPLE_ROOM_DISMISS_PREFIX = 'room_sample_offer_dismissed_';

interface ItemInteraction {
    description: string;
    reaction: string;
}

// --- Helper: Enhanced Markdown Renderer for Notebook ---
const renderInlineStyle = (text: string) => {
    // Regular Expression to match:
    // 1. **bold**
    // 2. ~~strikethrough~~
    // 3. *italic*
    // 4. `code`
    const parts = text.split(/(\*\*.*?\*\*|~~.*?~~|\*.*?\*|`.*?`)/g);
    
    return parts.map((part, i) => {
        // Bold
        if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={i} className="font-bold text-slate-800 bg-yellow-100/50 px-0.5 rounded">{part.slice(2, -2)}</strong>;
        }
        // Strikethrough
        if (part.startsWith('~~') && part.endsWith('~~')) {
            return <span key={i} className="line-through text-slate-400 opacity-80">{part.slice(2, -2)}</span>;
        }
        // Italic (single asterisk)
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
            return <em key={i} className="italic text-slate-600">{part.slice(1, -1)}</em>;
        }
        // Inline Code
        if (part.startsWith('`') && part.endsWith('`')) {
             return <code key={i} className="bg-slate-200 text-slate-600 px-1 rounded text-xs font-mono break-all">{part.slice(1, -1)}</code>;
        }
        return part;
    });
};

const renderNotebookContent = (text: string) => {
    // Simple Markdown-ish parser
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
            // Remove code block markers
            const firstLineBreak = part.indexOf('\n');
            let codeContent = part;
            if (firstLineBreak > -1 && firstLineBreak < 10) {
                 codeContent = part.substring(firstLineBreak + 1, part.length - 3);
            } else {
                 codeContent = part.substring(3, part.length - 3);
            }
            
            return (
                <div key={index} className="my-3 w-full max-w-full">
                    {/* Keep horizontal scroll for code blocks, don't wrap */}
                    <pre className="bg-slate-800 text-green-400 p-3 rounded-xl text-[10px] font-mono overflow-x-auto border-l-4 border-green-600 shadow-sm whitespace-pre">
                        {codeContent}
                    </pre>
                </div>
            );
        }
        return (
            <div key={index} className="w-full">
                {part.split('\n').map((line, lineIdx) => {
                    const key = `${index}-${lineIdx}`;
                    const trimLine = line.trim();
                    
                    if (!trimLine) return <div key={key} className="h-2"></div>;

                    if (trimLine.startsWith('# ')) {
                        return <h3 key={key} className="text-lg font-bold text-slate-800 mt-4 mb-2 pb-1 border-b-2 border-slate-200 break-words">{trimLine.substring(2)}</h3>;
                    }
                    if (trimLine.startsWith('## ')) {
                        return <h4 key={key} className="text-sm font-bold text-slate-700 mt-3 mb-1 border-l-4 border-slate-300 pl-2 break-words">{trimLine.substring(3)}</h4>;
                    }
                    if (trimLine.startsWith('> ')) {
                        return <div key={key} className="pl-3 border-l-4 border-slate-300 text-slate-500 italic my-2 py-1 bg-slate-100 rounded-r-lg text-xs break-words">{trimLine.substring(2)}</div>;
                    }
                    if (trimLine.startsWith('- ') || trimLine.startsWith('• ')) {
                        return <div key={key} className="flex gap-2 my-1 pl-1 items-start"><span className="text-slate-400 mt-1 shrink-0">•</span><span className="flex-1 break-words">{renderInlineStyle(trimLine.substring(2))}</span></div>;
                    }
                    
                    if (trimLine.match(/^\[[ x]\]/)) {
                         const isChecked = trimLine.includes('[x]');
                         return (
                             <div key={key} className="flex gap-2 my-1 pl-1 items-center">
                                 <div className={`w-3 h-3 border rounded-sm flex items-center justify-center shrink-0 ${isChecked ? 'bg-slate-600 border-slate-600' : 'border-slate-400'}`}>
                                     {isChecked && <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
                                 </div>
                                 <span className={`flex-1 break-words ${isChecked ? 'line-through text-slate-400' : 'text-slate-700'}`}>{renderInlineStyle(trimLine.substring(3))}</span>
                             </div>
                         );
                    }

                    return <div key={key} className="min-h-[1.5em] my-0.5 leading-relaxed break-words text-justify">{renderInlineStyle(line)}</div>;
                })}
            </div>
        );
    });
};

const RoomApp: React.FC = () => {
    const { closeApp, openApp, characters, characterGroups, activeCharacterId, setActiveCharacterId, updateCharacter, apiConfig, addToast, userProfile } = useOS();

    // The desktop theme's "enter room intent": read lazily (not cleared, consumed in the
    // effect below), so the first frame already lands on the target view, avoiding a flash
    // of the select page. The actual application (enter room / open dream / switch character)
    // happens in the effect.
    const launchIntent = roomLaunch.peek();
    // Flag for arriving with intent from the desktop theme: on exit, go straight back to the
    // desktop (closeApp) instead of back to the select page.
    const launchedFromDesktopRef = useRef(!!launchIntent);

    // Core State
    const [viewState, setViewState] = useState<'select' | 'room' | 'pixelHome'>(() => {
        if (launchIntent?.tab === 'pixelHome' && launchIntent.charId) return 'pixelHome';
        if (launchIntent?.charId) return 'room'; // Room / Dream
        return 'select';
    });
    // Three independent sections within Dwelling: Room / Pixel Home / Homeland (Homeland is a
    // separate system, its own section)
    const [homeTab, setHomeTab] = useState<'room' | 'pixelHome' | 'worldHome'>(() => launchIntent?.tab || 'room');
    // Homeland goes fullscreen when "actually starting to play" (entering the world / editing), hiding the top three-tab bar
    const [worldHomeFull, setWorldHomeFull] = useState(false);
    // Group filter for the character-select page (whose room to visit)
    const [visitGroupId, setVisitGroupId] = useState<string>(GROUP_FILTER_ALL);
    // Group filter for the multi-select "assign character" control in the edit-furniture modal
    // (only affects which options are shown, doesn't touch what's already checked)
    const [assignGroupId, setAssignGroupId] = useState<string>(GROUP_FILTER_ALL);
    const [mode, setMode] = useState<'view' | 'edit'>('view');
    const [items, setItems] = useState<RoomItem[]>([]);
    
    // Extended State
    const [todaysTodo, setTodaysTodo] = useState<RoomTodo | null>(null);
    const [notebookEntries, setNotebookEntries] = useState<RoomNote[]>([]);
    const [showSidebar, setShowSidebar] = useState(false);
    const [activePanel, setActivePanel] = useState<'todo' | 'notebook' | 'schedule'>('todo');
    const [roomSchedule, setRoomSchedule] = useState<DailySchedule | null>(null);
    const [notebookPage, setNotebookPage] = useState(0);

    // UI State
    const [isInitializing, setIsInitializing] = useState(false);
    const [initStatusText, setInitStatusText] = useState('Pushing the door open...');
    const [showLibrary, setShowLibrary] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [showDevModal, setShowDevModal] = useState(false); // Developer Mode
    const [showSettingsModal, setShowSettingsModal] = useState(false); // New: Room Settings
    const [showDream, setShowDream] = useState(false); // View Dream · Dream Theater overlay
    const [lastPrompt, setLastPrompt] = useState<string>(''); // Debug: Store last sent prompt
    const [showSampleRoomOffer, setShowSampleRoomOffer] = useState(false);
    const [sampleRoomLoadingId, setSampleRoomLoadingId] = useState<string | null>(null);
    const [showActorArtModal, setShowActorArtModal] = useState(false);
    
    // Actor & Room State
    const [actorState, setActorState] = useState({ x: 50, y: 75, action: 'idle' });
    const [aiBubble, setAiBubble] = useState<{text: string, visible: boolean}>({ text: '', visible: false });
    const [observationText, setObservationText] = useState('');
    const [roomDescriptions, setRoomDescriptions] = useState<Record<string, ItemInteraction>>({});
    
    // Edit Mode State
    const [draggingId, setDraggingId] = useState<string | null>(null);
    // Use Ref to store drag offset context
    const dragStartRef = useRef<{ startX: number, startY: number, initialItemX: number, initialItemY: number, width: number, height: number } | null>(null);
    const draggingIdRef = useRef<string | null>(null); // Non-reactive drag ID for perf
    const dragElementRef = useRef<HTMLElement | null>(null); // Direct DOM ref for dragged element
    const rafRef = useRef<number | null>(null); // requestAnimationFrame handle
    const pendingDragPos = useRef<{ x: number, y: number } | null>(null); // Pending drag position
    const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Debounce DB writes
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);
    const [hideActorInEdit, setHideActorInEdit] = useState(false);
    const roomRef = useRef<HTMLDivElement>(null);

    // Renovation-feel upgrade: undo/redo stack (items are always updated immutably, so we can
    // just store array references directly)
    const [history, setHistory] = useState<RoomItem[][]>([]);
    const [future, setFuture] = useState<RoomItem[][]>([]);
    // Continuous gestures (slider drag / nudge / wheel) within 1.2s get merged into one history
    // entry, so dragging a slider once doesn't flood the undo stack
    const lastHistoryKeyRef = useRef<{ key: string; t: number }>({ key: '', t: 0 });

    // Two-finger pinch (scale + rotate + move with midpoint): the first finger uses the normal
    // drag path, and pinch mode kicks in once a second finger touches down
    const dragPointerIdRef = useRef<number | null>(null);
    const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{
        id1: number; id2: number;
        startDist: number; startAngle: number;
        startMidX: number; startMidY: number;
        baseScale: number; baseRotation: number;
        baseX: number; baseY: number;
        width: number; height: number;
    } | null>(null);
    const pendingPinchRef = useRef<{ scale: number; rotation: number } | null>(null);
    // Right after a pinch ends, the browser still fires one extra click (landing on the stage
    // would falsely trigger "deselect") -- record a timestamp to block it
    const lastPinchEndRef = useRef(0);

    // Batch-import assets / import a room template
    const [isBatchImporting, setIsBatchImporting] = useState(false);
    const [isImportingRoom, setIsImportingRoom] = useState(false);
    const [pendingImport, setPendingImport] = useState<any | null>(null);
    const batchAssetInputRef = useRef<HTMLInputElement>(null);
    const importRoomInputRef = useRef<HTMLInputElement>(null);
    
    // File Inputs
    const wallInputRef = useRef<HTMLInputElement>(null);
    const floorInputRef = useRef<HTMLInputElement>(null);
    const actorInputRef = useRef<HTMLInputElement>(null); 
    const customItemInputRef = useRef<HTMLInputElement>(null);

    const char = characters.find(c => c.id === activeCharacterId);

    // The chibi portrait / wall / floor could each be a blobref token -- resolve them into
    // directly renderable urls (objectURL / http / data) first.
    // Warning: these three are hooks, and must be called unconditionally **before** the
    // select/pixelHome early-return -- calling them after the early-return would change the
    // hook count during the "select page -> enter room" transition instant, triggering a
    // "Rendered more hooks than during the previous render" crash.
    // When char is empty, undefined is passed in, and the hook returns undefined as-is -- safe.
    const actorImage = useBlobRefUrl(char?.sprites?.['chibi'] || char?.avatar);
    const wallImg = useBlobRefUrl(char?.roomConfig?.wallImage);
    const floorImg = useBlobRefUrl(char?.roomConfig?.floorImage);

    // Custom Item Library State (new: unified with visibility)
    type CustomAsset = { id: string; name: string; image: string; defaultScale: number; description?: string; visibility: 'public' | 'character'; assignedCharIds?: string[]; itemType?: 'furniture' | 'rug' };
    const [allCustomAssets, setAllCustomAssets] = useState<CustomAsset[]>([]);
    const customAssets = useMemo(() => {
        if (!char) return allCustomAssets.filter(a => a.visibility === 'public');
        return allCustomAssets.filter(a => a.visibility === 'public' || (a.assignedCharIds && a.assignedCharIds.includes(char.id)));
    }, [allCustomAssets, char?.id]);
    const [showCustomModal, setShowCustomModal] = useState(false);
    const [customItemName, setCustomItemName] = useState('');
    const [customItemImage, setCustomItemImage] = useState('');
    const [customItemUrl, setCustomItemUrl] = useState('');
    const [customItemDescription, setCustomItemDescription] = useState('');
    const [customItemType, setCustomItemType] = useState<'furniture' | 'rug'>('furniture');

    // Export Room Template State (in edit mode, exports the "current room" as a room-template JSON)
    const [showExportModal, setShowExportModal] = useState(false);
    const [exportName, setExportName] = useState('');
    const [exportDescription, setExportDescription] = useState('');
    const [isExporting, setIsExporting] = useState(false);

    // Asset Edit Modal State
    const [editingAsset, setEditingAsset] = useState<CustomAsset | null>(null);
    const [editName, setEditName] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editImage, setEditImage] = useState('');
    const [editVisibility, setEditVisibility] = useState<'public' | 'character'>('public');
    const [editAssignedCharIds, setEditAssignedCharIds] = useState<string[]>([]);
    const [editItemType, setEditItemType] = useState<'furniture' | 'rug'>('furniture');
    const assetLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // PERF: Cleanup rAF and debounce timers on unmount
    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        };
    }, []);

    // Clear the undo/redo stack whenever the room changes (history belongs to the previous room)
    useEffect(() => {
        setHistory([]);
        setFuture([]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
    }, [activeCharacterId]);

    // Load custom assets from global DB (with migration from old format)
    useEffect(() => {
        const loadAssets = async () => {
            const dbData = await DB.getAsset('room_custom_assets_list');
            const lsData = localStorage.getItem('room_custom_assets');
            let assets: any[] = [];
            if (dbData) {
                try { assets = JSON.parse(dbData); } catch {}
            } else if (lsData) {
                try { assets = JSON.parse(lsData); localStorage.removeItem('room_custom_assets'); } catch {}
            }
            // Migrate old format: old assets without an id/visibility get marked as public
            let needsSave = false;
            const migrated = assets.map((a: any) => {
                if (!a.id || !a.visibility) {
                    needsSave = true;
                    return { ...a, id: a.id || `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, visibility: a.visibility || 'public' };
                }
                return a;
            });
            // Lazy migration: convert the existing stock of old base64 images into Blobs, and
            // swap the field for a blobref token (saves space, gets it off the JS heap).
            // Single JSON record, no concurrent writers -- safe. If conversion fails, keep the
            // original as-is so no image is lost.
            for (const a of migrated) {
                if (typeof a.image === 'string' && a.image.startsWith('data:')) {
                    const ref = await migrateDataUrlToRef(a.image);
                    if (isBlobRef(ref)) { a.image = ref; needsSave = true; }
                }
            }
            if (needsSave && migrated.length > 0) {
                await DB.saveAsset('room_custom_assets_list', JSON.stringify(migrated));
            }
            setAllCustomAssets(migrated);
        };
        loadAssets();
    }, []);

    // Helper: Get Virtual "Day" (Reset at 6 AM)
    // If the character has "custom timezone" turned on, figure out "today" using their own
    // time -- it's their room, so the day boundary (and which day today's schedule/todo/tasks
    // belong to) should follow their routine, not my phone's.
    const getVirtualDay = (c?: CharacterProfile | null): string =>
        getVirtualDayKey(nowInTimeZone(resolveCharTimeZone(c)));

    // Calculate Time Gap - Duplicated logic from other apps for self-containment
    const getTimeGapHint = (lastMsgTimestamp: number | undefined): string => {
        if (!lastMsgTimestamp) return "This is your first meeting.";
        const now = Date.now();
        const diffMs = now - lastMsgTimestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 5) return "You two were just chatting.";
        if (diffMins < 60) return `It's only been ${diffMins} minutes since your last interaction.`;
        if (diffHours < 24) return `It's been ${diffHours} hours since your last interaction.`;
        return `It's been ${diffDays} days since your last interaction.`;
    };

    // --- 1. Selection & Initialization ---

    const handleEnterRoom = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setViewState('room');
        
        // Load Items: Priority -> Character Config > Sully Defaults > Generic Defaults
        let loadedItems = c.roomConfig?.items;
        
        if (!loadedItems || loadedItems.length === 0) {
            // Check if it's Sully (Preset ID or Name fallback)
            if (c.id === 'preset-sully-v2' || c.name === 'Sully') {
                loadedItems = SULLY_FURNITURE; 
                // Auto-save Sully's furniture to persist it
                updateCharacter(c.id, { roomConfig: { ...c.roomConfig, items: SULLY_FURNITURE } });
                setShowSampleRoomOffer(false);
            } else {
                loadedItems = [];
                const dismissed = localStorage.getItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${c.id}`) === '1';
                setShowSampleRoomOffer(!dismissed);
            }
        } else {
            setShowSampleRoomOffer(false);
        }
        
        setItems(loadedItems || []);
        
        const today = getVirtualDay(c);
        const hasCache = c.lastRoomDate === today && c.savedRoomState;

        if (hasCache && c.savedRoomState) {
            setRoomDescriptions(c.savedRoomState.items || {});
            setAiBubble({ text: c.savedRoomState.welcomeMessage || "...", visible: true });

            const existingTodo = await DB.getRoomTodo(c.id, today);
            const existingNotes = await DB.getRoomNotes(c.id);
            // The schedule and the room's "today" both follow the character's timezone; old
            // phone-local date keys get safely migrated by the read layer.
            const existingSchedule = await getDailyScheduleForChar(c);
            setTodaysTodo(existingTodo);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);

            addToast("Today's room state has been restored", 'info');
        } else {
            // Don't block on generation when entering the room -- go straight in (otherwise the
            // user would have to wait a long time just to get in).
            // Today's room content is left for the user to generate by tapping "Update Today"
            // after entering; here we only load the todo / notes / schedule that may have
            // already been generated during chat.
            const existingTodo = await DB.getRoomTodo(c.id, today);
            const existingNotes = await DB.getRoomNotes(c.id);
            const existingSchedule = await getDailyScheduleForChar(c);
            setTodaysTodo(existingTodo);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);
            setRoomDescriptions({});
            setAiBubble({ text: '', visible: false });
        }
    };

    const handleForceRefresh = () => {
        setShowRefreshConfirm(false);
        if (char) {
            initializeRoomState(char, items, true);
        }
    };

    // "Update Today": after entering the room, the user manually triggers today's room
    // generation (no confirmation needed for the first generation)
    const handleGenerateToday = () => {
        if (char) initializeRoomState(char, items, true);
        trackEvent("Generate Today's Room");
    };

    // Dream global indicator bar deep link: tap it -> go straight into the corresponding
    // character's room and open the dream playback
    const dreamSim = useDreamSim();
    const dreamSimCharId = dreamSim.status === 'idle' ? undefined : dreamSim.charId;
    useEffect(() => {
        if (!dreamSim.deepLink || !dreamSimCharId) return;
        const c = characters.find(x => x.id === dreamSimCharId);
        if (c) {
            setHomeTab('room');
            handleEnterRoom(c);   // Set active character + enter room + load furniture (non-blocking generation)
            setShowDream(true);
        }
        dreamSimStore.clearDeepLink();
    }, [dreamSim.deepLink, dreamSimCharId, characters]);

    // World-ified entry point for the desktop theme (TamagotchiHome): on mount, consume the
    // "enter room intent" once, landing on the specified tab / specified character / opening
    // the dream directly. viewState/homeTab have already been set via lazy initialization;
    // this only handles the part that needs a side effect (setting the active character,
    // loading furniture, opening the dream), and clears the intent.
    // Uses useLayoutEffect to finish before the browser paints, avoiding any intermediate flash.
    useLayoutEffect(() => {
        const intent = roomLaunch.consume();
        if (!intent) return;
        const c = intent.charId ? characters.find(x => x.id === intent.charId) : null;
        if (!c) return;
        setActiveCharacterId(c.id);
        if (intent.tab === 'pixelHome') return; // viewState is already pixelHome, PixelHomeView renders itself
        // Room / Dream: load furniture (handleEnterRoom sets viewState to room, already consistent)
        handleEnterRoom(c);
        if (intent.openDream) setShowDream(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fallback Initialization: Used when main generation fails due to Safety Block
    const initializeFallback = async (c: CharacterProfile) => {
        try {
            console.warn("Triggering Room Fallback Initialization");
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, false);
            const fallbackPrompt = `${baseContext}\n\nTask: User entered your room. Just say hello. JSON: { "welcomeMessage": "..." }`;
            
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ 
                    model: apiConfig.model, 
                    messages: [{ role: "user", content: fallbackPrompt }], 
                    temperature: 0.5,
                    max_tokens: 8000 // Keep it tiny
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                const rawContent = data.choices?.[0]?.message?.content || '';

                // The simplified version only needs one welcome line. Robustly extract JSON
                // first; if that fails, just treat the plain text as the welcome message --
                // the model often replies with something like "Hey there~" without wrapping it
                // in JSON, which is itself a perfectly good welcome message, so there's no need
                // to fail the whole thing down to "(...)" just because it "isn't valid JSON".
                const parsed = extractJson(rawContent);
                const cleanText = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
                const welcomeMessage =
                    (parsed && typeof parsed.welcomeMessage === 'string' && parsed.welcomeMessage.trim())
                        ? parsed.welcomeMessage.trim()
                        : (cleanText.slice(0, 200) || "...");

                const todayStr = getVirtualDay(c);
                setAiBubble({ text: welcomeMessage, visible: true });
                // Use generic descriptions for items in fallback mode
                const fallbackItems: Record<string, any> = {};
                items.forEach(i => { fallbackItems[i.id] = { description: `This is a ${i.name}.`, reaction: "..." }; });
                setRoomDescriptions(fallbackItems);

                updateCharacter(c.id, {
                    lastRoomDate: todayStr,
                    savedRoomState: {
                        actorStatus: "Idling...",
                        welcomeMessage,
                        items: fallbackItems,
                        actorAction: 'idle'
                    }
                });
                addToast("The room didn't fully generate this time, so a simplified version was used -- try again later.", "info");
            } else {
                throw new Error(`Fallback API Error ${response.status}`);
            }
        } catch (e) {
            console.error("Fallback Failed", e);
            // Even the simplified version failed completely (network/API error): show a gentle
            // fallback bubble instead of just a cold "(...)"
            setAiBubble({ text: "(Seems a bit distracted... check back in a little while)", visible: true });
        } finally {
            setIsInitializing(false);
        }
    };

    const initializeRoomState = async (c: CharacterProfile, currentItems: RoomItem[], force: boolean = false) => {
        // Can't silently return: if the API config is missing, "Update Today" would become a
        // dead button that does nothing when tapped (real user report: localStorage got
        // cleared -> os_api_config was lost -> this used to silently bail out here).
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
            addToast('Please configure the API in Settings first (generating the room for today needs to call the model)', 'error');
            return;
        }

        setIsInitializing(true);
        const loadingTexts = [`Tidying up ${c.name}'s room...`, "Sorting out thoughts...", "Dusting the furniture...", "Generating memories for every item..."];
        let textIdx = 0;
        const textInterval = setInterval(() => {
            setInitStatusText(loadingTexts[textIdx % loadingTexts.length]);
            textIdx++;
        }, 1200);

        try {
            const todayStr = getVirtualDay(c);
            // Time is always read in the character's own timezone (or the local machine's, if
            // custom timezone isn't turned on). This must share the same source as the "current
            // time" injected by buildCoreContext -- that side already converts to the
            // character's timezone, so stuffing in another local-machine time here would just
            // hand the model two contradictory clocks within the same prompt.
            const charTz = resolveCharTimeZone(c);
            const now = nowInTimeZone(charTz);
            const nowTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const nowDateStr = now.toLocaleDateString();
            const tzSuffix = charTz ? ` (Your timezone: ${tzLabel(charTz)}, this is your local time)` : '';
            
            let existingTodo = await DB.getRoomTodo(c.id, todayStr);
            const existingNotes = await DB.getRoomNotes(c.id);
            const existingSchedule = await getDailyScheduleForChar(c);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);
            
            const shouldGenerateTodo = !existingTodo;
            if (existingTodo) {
                setTodaysTodo(existingTodo);
            }

            const recentMsgs = await DB.getMessagesByCharId(c.id);
            // Increased context from 20 to 50
            const chatContext = recentMsgs.slice(-50).map(m => {
                const role = m.role === 'user' ? 'User' : c.name;
                return `${role}: ${m.content.substring(0, 50)}`;
            }).join('\n');

            // Time Gap Calculation
            const lastMsg = recentMsgs[recentMsgs.length - 1];
            const timeGapHint = getTimeGapHint(lastMsg?.timestamp);

            await injectMemoryPalace(c, recentMsgs);
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, true); // Keep Full Context

            // DEBUG FIX: Sanitize and truncate interactables context to prevent huge Base64 leakage
            const interactables = currentItems.filter(i => i.isInteractive).map(i => ({
                id: i.id,
                name: i.name,
                context: (i.descriptionPrompt || '').substring(0, 200)
            }));

            let prompt = `${baseContext}

### [Environment Context - Critical]
**Current real-world time**: ${nowDateStr} ${nowTimeStr}${tzSuffix}
**Time since your last interaction with the user**: ${timeGapHint}
**Recent interaction log (Latest 50)**:
${chatContext}

### [Room Initialization - Batch Generation]
The user has entered **your** room. Please generate, in one pass, the room's state, item-interaction text, and (if needed) your plan and journal entry for today.

### 1. Room Status (Status)
- **ActorStatus**: What are you doing in the room right now? (Base this strictly on the current time ${nowTimeStr} and the time gap ${timeGapHint} -- late at night you might be sleeping, or if it's been a long time you might be zoning out.)
- **Welcome**: Seeing the user come in, what's the first thing you say? (Factor in the time gap: if it's been a long while, are you surprised, wistful, or annoyed?)

### 2. Item Interactions (Items)
The room contains the following items:
${JSON.stringify(interactables)}

For **every single** item, please generate:
- **Description**: A narrator's-eye description of the item's appearance/state.
- **Reaction**: Your (the character's) remark or reaction when the user looks at this item.

### 3. [OPTIONAL] Today's To-Do List (Daily To-Do)
${!shouldGenerateTodo ? `(System: today's to-do list already exists, no need to generate one, please ignore this section)` : `(System: please generate 3-5 things you plan to do today.)`}

### 4. Notebook Entry
Please write something in your private notebook.
**Requirements**:
1. **Vary the style**: it could be lyrics you just wrote, a personal reflection, a mood log, a short poem, or a shopping list.
2. **No code, ever**: **Do not** generate code blocks or pseudocode, unless your core persona is explicitly a programmer. Write it as naturally as a normal person keeping a diary.
3. **Rich formatting**: actively use **Markdown** formatting to make the layout more interesting.
4. **Fresh content**: it must be new content, showing your thinking as an independent individual.

### Output Format (Strict JSON)
{
  "actorStatus": "...",
  "welcomeMessage": "...",
  "items": {
    "item_id": { "description": "...", "reaction": "..." }
  },
  ${shouldGenerateTodo ? `"todoList": ["task 1", "task 2"],` : ''}
  "notebookEntry": { "content": "markdown string...", "type": "thought" }
}
`;
            // DEBUG: Save prompt for inspection
            setLastPrompt(prompt);
            // CONSOLE LOG REMOVED FOR PRODUCTION CLEANUP

            // FIX: Add Safety Settings & Lower Temperature
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ 
                    model: apiConfig.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.5, // Lower temp for stability
                    max_tokens: 8000,
                    // Safety Settings injection for Gemini-based proxies
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                let content = data.choices?.[0]?.message?.content || "";
                
                // CRITICAL FIX: Empty content check triggers fallback
                if (!content) {
                    throw new Error("AI returned empty response (Safety Block suspected).");
                }

                // Fall back to the robust extractJson: it handles markdown fences, extraneous
                // leading/trailing text, trailing commas, single quotes, unescaped inner
                // quotes, truncated JSON, {"result":{...}} wrapping, and other common
                // formatting slip-ups.
                const result = extractJson(content);
                if (!result) throw new Error("JSON Parse Failed");
                
                setAiBubble({ text: result.welcomeMessage || "Welcome!", visible: true });
                if (result.items) setRoomDescriptions(result.items);

                updateCharacter(c.id, {
                    lastRoomDate: todayStr,
                    savedRoomState: {
                        actorStatus: result.actorStatus,
                        welcomeMessage: result.welcomeMessage,
                        items: result.items || {},
                        actorAction: 'idle'
                    }
                });

                // 2. Handle To-Do (Only if we requested it)
                if (shouldGenerateTodo && result.todoList && Array.isArray(result.todoList)) {
                    const newTodo: RoomTodo = {
                        id: `${c.id}_${todayStr}`,
                        charId: c.id,
                        date: todayStr,
                        items: result.todoList.map((t: string) => ({ text: t, done: false })),
                        generatedAt: Date.now()
                    };
                    await DB.saveRoomTodo(newTodo);
                    setTodaysTodo(newTodo);
                    
                    await DB.saveMessage({
                        charId: c.id,
                        role: 'system',
                        type: 'text',
                        content: `[System: ${c.name} made today's plan: ${result.todoList.join(', ')}]`
                    });
                }

                // 3. Handle Notebook
                if (result.notebookEntry) {
                    // Create message first to get ID
                    const msgContent = `[System: ${c.name} wrote in their notebook: \n"${result.notebookEntry.content}"]`;
                    
                    const msgId = await DB.saveMessage({
                        charId: c.id,
                        role: 'system',
                        type: 'text',
                        content: msgContent
                    });

                    const newNote: RoomNote = {
                        id: `note-${Date.now()}`,
                        charId: c.id,
                        timestamp: Date.now(),
                        content: result.notebookEntry.content,
                        type: result.notebookEntry.type || 'thought',
                        relatedMessageId: msgId
                    };
                    await DB.saveRoomNote(newNote);
                    setNotebookEntries(prev => [newNote, ...prev]);
                }

            } else { throw new Error(`API Error ${response.status}`); }

        } catch (e: any) { 
            console.error("Room Init Failed, switching to Fallback", e); 
            // Trigger Fallback
            await initializeFallback(c);
        } finally { 
            clearInterval(textInterval); 
            setIsInitializing(false); 
        }
    };

    const handleLookAt = async (item: RoomItem, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        if (mode === 'edit') { setSelectedItemId(item.id); return; }
        if (!char) return;
        
        // Character Movement Constraint: Keep feet below horizon line
        // FIX: Place actor visually "In Front" of furniture (lower Y = closer to camera in 2.5D top-down)
        const targetY = Math.max(FLOOR_HORIZON, item.y + 5);

        setActorState({ x: item.x, y: targetY, action: 'walk' });
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'interact' })), 600);
        trackEvent('Observe Furniture in Room');

        const cached = roomDescriptions[item.id] || roomDescriptions[item.name];
        if (cached) {
            setObservationText(cached.description);
            setAiBubble({ text: cached.reaction, visible: true });

            const contentToCheck = `[${userProfile.name}] saw on [${char.name}]'s ${item.name}: ${cached.description}. [${char.name}] said: ${cached.reaction}`;
            const recentMsgs = await DB.getMessagesByCharId(char.id);
            const isDuplicate = recentMsgs.slice(-50).some(m => m.role === 'system' && m.content === contentToCheck);

            if (!isDuplicate) {
                try {
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: contentToCheck });
                } catch (err) {}
            }
        } else {
            setObservationText(`The ${item.name} sits quietly in place.`);
            setAiBubble({ text: "(staring...)", visible: true });
        }
    };

    const handlePokeActor = () => {
        if (mode === 'edit') { setShowActorArtModal(true); return; }
        setActorState(prev => ({ ...prev, action: 'bounce' }));
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'idle' })), 500);
        const thoughts = ["Hm?", "Cut it out...", "I'm here.", "Why are you staring at me...", "(spacing out)"];
        setAiBubble({ text: thoughts[Math.floor(Math.random() * thoughts.length)], visible: true });
        trackEvent('Poke Character');
    };

    const handleToggleTodo = async (index: number) => {
        if (!todaysTodo) return;
        const newItems = [...todaysTodo.items];
        newItems[index].done = !newItems[index].done;
        const newTodo = { ...todaysTodo, items: newItems };
        setTodaysTodo(newTodo);
        await DB.saveRoomTodo(newTodo);
    };

    // --- Deletion Handlers (Point 5) ---
    const handleDeleteTodo = async (index: number) => {
        if (!todaysTodo) return;
        const newItems = todaysTodo.items.filter((_, i) => i !== index);
        const newTodo = { ...todaysTodo, items: newItems };
        setTodaysTodo(newTodo);
        await DB.saveRoomTodo(newTodo);
        addToast('Entry deleted', 'success');
    };

    const handleDeleteNote = async (id: string) => {
        const note = notebookEntries.find(n => n.id === id);
        if (note && note.relatedMessageId) {
            await DB.deleteMessage(note.relatedMessageId);
        }
        await DB.deleteRoomNote(id);
        setNotebookEntries(prev => prev.filter(n => n.id !== id));
        addToast('Note shredded for good (related record cleared)', 'success');
    };

    const handleStageClick = (e: React.MouseEvent) => {
        if (mode === 'edit') {
            // A click the browser re-fires right after a pinch ends doesn't count as
            // "tapped blank space to deselect"
            if (Date.now() - lastPinchEndRef.current < 400) return;
            setSelectedItemId(null);
            return;
        }
        // View mode: Move actor
        if (!roomRef.current) return;
        const rect = roomRef.current.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        
        // Constrain to floor: allow climbing a bit, but mostly keep below horizon
        const targetY = Math.max(FLOOR_HORIZON - 5, y);
        
        setActorState({
            x,
            y: targetY,
            action: 'walk'
        });
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'idle' })), 600);
        
        // Clear bubbles
        setAiBubble({ text: '', visible: false });
        setObservationText('');
    };

    // --- Edit Logic ---
    // Commit a new set of items: update the screen immediately + persist to DB (and cancel any
    // pending debounced slider write, so an old value doesn't overwrite the new one)
    const commitItems = (newItems: RoomItem[]) => {
        if (saveDebounceRef.current) { clearTimeout(saveDebounceRef.current); saveDebounceRef.current = null; }
        setItems(newItems);
        if (char) { updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } }); }
    };

    // Push the "current items" onto the undo stack. Continuous gestures whose key starts with
    // cont: (slider/wheel/nudge) only record one entry within 1.2s; discrete operations
    // (add/delete/drop position/import) always record. Stack depth is 40.
    const recordHistory = (key: string = 'op') => {
        const now = Date.now();
        const last = lastHistoryKeyRef.current;
        lastHistoryKeyRef.current = { key, t: now };
        if (key.startsWith('cont:') && key === last.key && now - last.t < 1200) return;
        setHistory(h => [...h.slice(-39), items]);
        setFuture([]);
    };

    const saveRoom = (newItems: RoomItem[]) => { recordHistory('op'); commitItems(newItems); };

    const undo = () => {
        if (!history.length) return;
        const prev = history[history.length - 1];
        setHistory(h => h.slice(0, -1));
        setFuture(f => [...f.slice(-39), items]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
        setSelectedItemId(null);
        commitItems(prev);
    };
    const redo = () => {
        if (!future.length) return;
        const next = future[future.length - 1];
        setFuture(f => f.slice(0, -1));
        setHistory(h => [...h.slice(-39), items]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
        setSelectedItemId(null);
        commitItems(next);
    };

    // Updated addItem to accept description
    // No longer closes the furniture-library modal: lets you tap repeatedly to place items in
    // batch; each drop point gets a bit of random jitter so items don't stack exactly on top of each other
    const addItem = (asset: {name: string, image: string, defaultScale: number, description?: string}, type: 'furniture' | 'decor' | 'rug') => {
        const newItem: RoomItem = {
            // Rapid batch-adding could land in the same millisecond, so add a random suffix to prevent id collisions
            id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: asset.name,
            type: type,
            image: asset.image,
            x: 44 + Math.random() * 12,
            y: 46 + Math.random() * 12,
            scale: asset.defaultScale,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: asset.description // New Field
        };
        saveRoom([...items, newItem]);
        addToast(`Added: ${asset.name}`, 'success');
        // Only report these three fixed categories -- everything else is lumped into
        // "furniture"; don't leak the raw asset category name
        trackEvent('Place a Furniture Item', { type: type === 'rug' ? 'rug' : (type === 'decor' ? 'decor' : 'furniture') });
    };

    // PERF: Update items in state immediately (visual), but debounce DB persistence
    const updateSelectedItem = (updates: Partial<RoomItem>, gestureKey: string = 'cont:adjust') => {
        if (!selectedItemId) return;
        recordHistory(gestureKey);
        const newItems = items.map(i => i.id === selectedItemId ? { ...i, ...updates } : i);
        setItems(newItems); // Instant visual update
        // Debounce the DB write (300ms) - prevents IndexedDB thrashing from sliders
        if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = setTimeout(() => {
            if (char) {
                updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } });
            }
        }, 300);
    };
    const deleteSelectedItem = () => { if (!selectedItemId) return; saveRoom(items.filter(i => i.id !== selectedItemId)); setSelectedItemId(null); };

    const duplicateSelectedItem = () => {
        const src = items.find(i => i.id === selectedItemId);
        if (!src) return;
        const copy: RoomItem = { ...src, id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, x: Math.min(96, src.x + 4), y: Math.min(100, src.y + 4) };
        saveRoom([...items, copy]);
        setSelectedItemId(copy.id);
        addToast(`Duplicated: ${src.name}`, 'success');
        trackEvent('Duplicate Selected Furniture');
    };

    // D-pad nudge: when dragging isn't precise enough, move one grid cell at a time (1% per step)
    const nudgeSelectedItem = (dx: number, dy: number) => {
        const sel = items.find(i => i.id === selectedItemId);
        if (!sel) return;
        updateSelectedItem({
            x: Math.max(0, Math.min(100, sel.x + dx)),
            y: Math.max(0, Math.min(100, sel.y + dy)),
        }, 'cont:nudge');
    };
    const handleWallChange = (bg: string) => { if (char) updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items, wallImage: bg } }); };
    const handleFloorChange = (bg: string) => { if (char) updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items, floorImage: bg } }); };
    const openActorStudio = () => {
        if (!char) return;
        characterLaunch.request({ charId: char.id, openChibiStudio: true });
        setActiveCharacterId(char.id);
        setShowActorArtModal(false);
        openApp(AppID.Character);
    };
    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'wall' | 'floor' | 'actor' | 'custom_item') => { 
        const file = e.target.files?.[0]; 
        if (file) { 
            try {
                // Force high quality for custom item uploads
                const processOptions = target === 'custom_item' ? { quality: 1.0, maxWidth: 2048 } : undefined;
                // Switched to storing as Blob: the compressed binary goes into blob_assets, and
                // the field only stores a blobref token (saves ~33% space, keeps it off the JS heap).
                const blob = await processImageToBlob(file, processOptions);
                const ref = await putImageBlob(blob);

                if (target === 'wall') handleWallChange(ref);
                if (target === 'floor') handleFloorChange(ref);
                if (target === 'actor') {
                    if (char) {
                        const newSprites = { ...(char.sprites || {}), 'chibi': ref };
                        updateCharacter(char.id, { sprites: newSprites });
                        addToast('Character room portrait updated', 'success');
                    }
                }
                if (target === 'custom_item') {
                    setCustomItemImage(ref);
                }
            } catch (err: any) {
                addToast(err.message, 'error'); 
            } 
        } 
    };
    
    // Custom Item Save
    // Helper: persist allCustomAssets to DB
    const persistAssets = async (assets: CustomAsset[]) => {
        setAllCustomAssets(assets);
        await DB.saveAsset('room_custom_assets_list', JSON.stringify(assets));
    };

    const saveCustomItem = async () => {
        const imageToUse = customItemUrl || customItemImage;
        if(!customItemName.trim() || !imageToUse) { addToast('Please fill in all the fields', 'error'); return; }

        addItem({
            name: customItemName,
            image: imageToUse,
            defaultScale: 1.0,
            description: customItemDescription || undefined
        }, customItemType);

        const newAsset: CustomAsset = {
            id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: customItemName,
            image: imageToUse,
            defaultScale: 1.0,
            description: customItemDescription || undefined,
            visibility: 'public',
            itemType: customItemType,
        };
        await persistAssets([...allCustomAssets, newAsset]);

        setShowCustomModal(false);
        setCustomItemName('');
        setCustomItemImage('');
        setCustomItemUrl('');
        setCustomItemDescription('');
        setCustomItemType('furniture');
    };

    // Long-press on custom asset → open edit modal
    const handleAssetTouchStart = (asset: CustomAsset) => {
        assetLongPressTimer.current = setTimeout(() => {
            setEditingAsset(asset);
            setEditName(asset.name);
            setEditDescription(asset.description || '');
            setEditImage(asset.image);
            setEditVisibility(asset.visibility);
            setEditAssignedCharIds(asset.assignedCharIds || []);
            setEditItemType(asset.itemType || 'furniture');
        }, 600);
    };

    const handleAssetTouchEnd = () => {
        if (assetLongPressTimer.current) {
            clearTimeout(assetLongPressTimer.current);
            assetLongPressTimer.current = null;
        }
    };

    const saveEditingAsset = async () => {
        if (!editingAsset) return;
        const updated = allCustomAssets.map(a => a.id === editingAsset.id ? {
            ...a,
            name: editName.trim() || a.name,
            description: editDescription || undefined,
            image: editImage || a.image,
            visibility: editVisibility,
            assignedCharIds: editVisibility === 'character' ? editAssignedCharIds : undefined,
            itemType: editItemType,
        } : a);
        await persistAssets(updated);
        setEditingAsset(null);
        addToast('Asset updated', 'success');
    };

    const deleteEditingAsset = async () => {
        if (!editingAsset) return;
        const filtered = allCustomAssets.filter(a => a.id !== editingAsset.id);
        await persistAssets(filtered);
        setEditingAsset(null);
        addToast('Asset deleted', 'success');
    };

    // New: Handle Background Config Update
    const updateBgConfig = (updates: Partial<CharacterProfile['roomConfig']>) => {
        if (!char) return;
        updateCharacter(char.id, {
            roomConfig: { ...char.roomConfig, ...updates, items } // Ensure items are preserved
        });
    };

    // New: Reset Sully
    const resetSullyRoom = () => {
        if (!char) return;
        saveRoom(SULLY_FURNITURE);
        setShowSettingsModal(false);
        addToast("Sully's room has been restored", 'success');
    };

    // --- Export Room Template (in edit mode, exports the "current room" as a room template) ---
    // Position x/y are percentages relative to the room (0-100), so they can be restored
    // identically on any screen size.
    // Images: image-host/http links are kept as-is; uploaded images (blobref/base64) are all
    // resolved and embedded as data URLs -- the exported file is self-contained and doesn't
    // depend on local IndexedDB.
    const buildRoomTemplate = async () => {
        const template = {
            schema: 'sullyos.room-template.v1',
            name: exportName.trim() || `${char?.name || 'Unnamed'}'s Room`,
            description: exportDescription.trim(),
            exportedAt: new Date().toISOString(),
            room: {
                wallImage: char?.roomConfig?.wallImage || '',
                wallScale: char?.roomConfig?.wallScale,
                wallRepeat: char?.roomConfig?.wallRepeat,
                floorImage: char?.roomConfig?.floorImage || '',
                floorScale: char?.roomConfig?.floorScale,
                floorRepeat: char?.roomConfig?.floorRepeat,
            },
            items: items.map(i => ({
                name: i.name,
                type: i.type,
                image: i.image,
                x: i.x,
                y: i.y,
                scale: i.scale,
                rotation: i.rotation,
                isInteractive: i.isInteractive,
                description: i.descriptionPrompt || '',
            })),
        };
        // Older builds persisted built-in assets as deployment-specific absolute URLs.
        // Canonicalize them before exporting a standalone room template as well.
        if (template.room) {
            template.room.wallImage = toPortableBuiltinRoomAsset(template.room.wallImage) as string;
            template.room.floorImage = toPortableBuiltinRoomAsset(template.room.floorImage) as string;
        }
        for (const item of template.items) item.image = toPortableBuiltinRoomAsset(item.image) as string;
        await resolveBlobRefsDeep(template);
        return template;
    };

    const handleExportRoom = async (action: 'download' | 'copy') => {
        setIsExporting(true);
        try {
            const template = await buildRoomTemplate();
            const json = JSON.stringify(template, null, 2);
            if (action === 'copy') {
                await navigator.clipboard.writeText(json);
                addToast('Room JSON copied to clipboard', 'success');
            } else {
                const result = await shareOrDownloadFile({
                    content: json,
                    fileName: `${template.name.replace(/[\\/:*?"<>|]/g, '_')}.room.json`,
                    mimeType: 'application/json;charset=utf-8',
                    shareTitle: `Room Template: ${template.name}`,
                });
                addToast(result === 'shared' ? 'Room template share panel opened' : 'Room template exported', 'success');
            }
            trackEvent('Export Room Template', { action });
        } catch (e: any) {
            addToast(`Export failed: ${e?.message || e}`, 'error');
        } finally {
            setIsExporting(false);
        }
    };

    // --- Batch-import custom assets (select multiple images at once, all stored as public assets, named from the filename) ---
    const handleBatchAssetImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        setIsBatchImporting(true);
        const imported: CustomAsset[] = [];
        let failed = 0;
        for (const file of files) {
            try {
                const blob = await processImageToBlob(file, { quality: 1.0, maxWidth: 2048 });
                const ref = await putImageBlob(blob);
                imported.push({
                    id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Unnamed',
                    image: ref,
                    defaultScale: 1.0,
                    visibility: 'public',
                    itemType: 'furniture',
                });
            } catch { failed++; }
        }
        if (imported.length) await persistAssets([...allCustomAssets, ...imported]);
        addToast(
            failed
                ? `Imported ${imported.length} assets, ${failed} failed`
                : `Batch-imported ${imported.length} assets -- place them from "Furniture Store · Custom"`,
            failed ? 'info' : 'success'
        );
        trackEvent('Batch Import Furniture Assets');
        setIsBatchImporting(false);
        if (imported.length) setShowLibrary(true);
    };

    // --- Import Room Template (the other half of export): read a .room.json file, then replace or merge after confirming ---
    const handleImportRoomFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!data || !Array.isArray(data.items)) throw new Error('Missing items -- not a valid room template file');
            setPendingImport(data);
        } catch (err: any) {
            addToast(`Could not read room file: ${err?.message || err}`, 'error');
        }
    };

    const loadBuiltInRoomTemplate = async (template: BuiltInRoomTemplate) => {
        const res = await fetch(template.templateUrl);
        if (!res.ok) throw new Error(`Could not read room template ${template.name}`);
        const data = await res.json();
        if (!data || !Array.isArray(data.items)) throw new Error('Invalid room template data');
        // Store built-in assets as deployment-independent references. TokenImg/useBlobRefUrl
        // resolves them against the *current* BASE_URL when rendering, so full backups can
        // move between web origins, GitHub Pages sub-paths, and the desktop shell.
        normalizeBuiltInRoomTemplateAssetsInPlace(data, template.id);
        return data;
    };

    const openBuiltInRoomTemplate = async (template: BuiltInRoomTemplate) => {
        setSampleRoomLoadingId(template.id);
        try {
            setPendingImport(await loadBuiltInRoomTemplate(template));
            setShowLibrary(false);
        } catch (err: any) {
            addToast(`Could not open room template: ${err?.message || err}`, 'error');
        } finally {
            setSampleRoomLoadingId(null);
        }
    };

    const applyRoomTemplateData = async (templateData: any, importMode: 'replace' | 'merge') => {
        if (!templateData || !char) return;
        setIsImportingRoom(true);
        try {
            // Embedded base64 images are all converted back to blobref and persisted; image-host/http links are kept as-is
            const toRef = async (img: any): Promise<string> => {
                if (typeof img !== 'string' || !img) return '';
                return img.startsWith('data:') ? await migrateDataUrlToRef(img) : img;
            };
            const clampNum = (v: any, def: number, min: number, max: number) => {
                const n = Number(v);
                return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
            };
            const stamp = Date.now();
            const importedItems: RoomItem[] = [];
            for (let i = 0; i < templateData.items.length; i++) {
                const it = templateData.items[i] || {};
                const image = await toRef(toPortableBuiltinRoomAsset(it.image));
                if (!image) continue;
                const desc = typeof it.description === 'string' && it.description
                    ? it.description
                    : (typeof it.descriptionPrompt === 'string' && it.descriptionPrompt ? it.descriptionPrompt : undefined);
                importedItems.push({
                    id: `item-${stamp}-${i}`,
                    name: typeof it.name === 'string' && it.name ? it.name : `Item ${i + 1}`,
                    type: it.type === 'rug' ? 'rug' : (it.type === 'decor' ? 'decor' : 'furniture'),
                    image,
                    x: clampNum(it.x, 50, 0, 100),
                    y: clampNum(it.y, 60, 0, 100),
                    scale: clampNum(it.scale, 1, 0.2, 6),
                    rotation: clampNum(it.rotation, 0, -180, 180),
                    isInteractive: it.isInteractive !== false,
                    descriptionPrompt: desc,
                });
            }
            recordHistory('op');
            const newItems = importMode === 'merge' ? [...items, ...importedItems] : importedItems;
            if (saveDebounceRef.current) { clearTimeout(saveDebounceRef.current); saveDebounceRef.current = null; }
            setItems(newItems);
            if (importMode === 'replace' && templateData.room) {
                // Replace mode applies the wall/floor too (merge mode only appends items, leaving the background untouched)
                const r = templateData.room;
                const wallImage = await toRef(toPortableBuiltinRoomAsset(r.wallImage));
                const floorImage = await toRef(toPortableBuiltinRoomAsset(r.floorImage));
                updateCharacter(char.id, {
                    roomConfig: {
                        ...char.roomConfig,
                        items: newItems,
                        ...(wallImage ? { wallImage, wallScale: Number(r.wallScale) || undefined, wallRepeat: !!r.wallRepeat } : {}),
                        ...(floorImage ? { floorImage, floorScale: Number(r.floorScale) || undefined, floorRepeat: !!r.floorRepeat } : {}),
                    },
                });
            } else {
                updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } });
            }
            addToast(`Imported ${importedItems.length} items${importMode === 'replace' ? ' (replaced the previous layout)' : ''}`, 'success');
            return true;
        } catch (err: any) {
            addToast(`Import failed: ${err?.message || err}`, 'error');
            return false;
        } finally {
            setIsImportingRoom(false);
        }
    };

    const applyRoomImport = async (importMode: 'replace' | 'merge') => {
        if (!pendingImport) return;
        const ok = await applyRoomTemplateData(pendingImport, importMode);
        if (ok) {
            setPendingImport(null);
            trackEvent('Import Room Template', { mode: importMode });
        }
    };

    const chooseSampleRoom = async (template: BuiltInRoomTemplate) => {
        if (!char) return;
        trackEvent('Apply Built-in Room Template', { template: template.id });
        setSampleRoomLoadingId(template.id);
        try {
            const data = await loadBuiltInRoomTemplate(template);
            const ok = await applyRoomTemplateData(data, 'replace');
            if (ok) {
                localStorage.setItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${char.id}`, '1');
                setShowSampleRoomOffer(false);
            }
        } catch (err: any) {
            addToast(`Room template import failed: ${err?.message || err}`, 'error');
        } finally {
            setSampleRoomLoadingId(null);
        }
    };

    const dismissSampleRoomOffer = () => {
        if (char) localStorage.setItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${char.id}`, '1');
        setShowSampleRoomOffer(false);
    };

    // --- PERF FIX: Direct DOM Dragging (bypasses React re-renders) ---
    // During drag: manipulate DOM directly via element.style
    // On drop: sync final position to React state once
    // Two-finger pinch: if a first finger is already dragging a piece of furniture, a second
    // finger touching down anywhere upgrades it to pinch mode.
    // Both fingers' coordinates plus the drag context (room dimensions) must be available before it actually starts.
    const tryStartPinch = () => {
        if (pinchRef.current || !draggingIdRef.current || !dragStartRef.current) return;
        if (activePointersRef.current.size !== 2) return;
        const item = items.find(i => i.id === draggingIdRef.current);
        if (!item) return;
        const ids = [...activePointersRef.current.keys()];
        const [p1, p2] = [...activePointersRef.current.values()];
        pinchRef.current = {
            id1: ids[0], id2: ids[1],
            startDist: Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
            startAngle: Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI,
            startMidX: (p1.x + p2.x) / 2,
            startMidY: (p1.y + p2.y) / 2,
            baseScale: item.scale,
            baseRotation: item.rotation,
            // The position baseline uses the live position during the drag (it may already have moved some before the pinch started)
            baseX: pendingDragPos.current?.x ?? item.x,
            baseY: pendingDragPos.current?.y ?? item.y,
            width: dragStartRef.current.width,
            height: dragStartRef.current.height,
        };
    };

    // Normalize rotation angle to [-180, 180]
    const normRot = (r: number) => {
        let v = ((r + 180) % 360 + 360) % 360 - 180;
        return Math.round(v);
    };

    // Stage-layer pointerdown: only responsible for capturing "a second finger touching down mid-drag" (when the second finger lands on blank space)
    const handleStagePointerDown = (e: React.PointerEvent) => {
        if (mode !== 'edit' || !draggingIdRef.current) return;
        activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        tryStartPinch();
    };

    const handlePointerDown = (e: React.PointerEvent, id: string) => {
        if (mode !== 'edit') return;
        e.preventDefault();
        e.stopPropagation();
        activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // A finger is already dragging: this new finger upgrades to a pinch instead of starting a new drag
        if (draggingIdRef.current && dragPointerIdRef.current !== null && e.pointerId !== dragPointerIdRef.current) {
            tryStartPinch();
            return;
        }

        e.currentTarget.setPointerCapture(e.pointerId);
        dragPointerIdRef.current = e.pointerId;

        const item = items.find(i => i.id === id);
        if (!item || !roomRef.current) return;

        const rect = roomRef.current.getBoundingClientRect();

        dragStartRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            initialItemX: item.x,
            initialItemY: item.y,
            width: rect.width,
            height: rect.height
        };

        // Store refs for direct DOM access (no React re-renders during drag)
        draggingIdRef.current = id;
        dragElementRef.current = e.currentTarget as HTMLElement;
        if (dragElementRef.current) {
            dragElementRef.current.style.transition = 'none';
            dragElementRef.current.style.zIndex = '100';
            dragElementRef.current.style.willChange = 'left, top';
        }

        setDraggingId(id);
        setSelectedItemId(id);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // Fast-path: skip entirely if not dragging (avoids any work on passive touch)
        if (!draggingIdRef.current || !dragStartRef.current) return;

        e.preventDefault();
        if (activePointersRef.current.has(e.pointerId)) {
            activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        // While pinching: two-finger distance -> scale, angle of the line between fingers -> rotate (snaps near 0deg/+-90deg/180deg), midpoint movement -> move
        const pinch = pinchRef.current;
        if (pinch) {
            const p1 = activePointersRef.current.get(pinch.id1);
            const p2 = activePointersRef.current.get(pinch.id2);
            if (!p1 || !p2) return;
            const d = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
            const a = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
            const scale = Math.min(6, Math.max(0.2, pinch.baseScale * (d / pinch.startDist)));
            let rotation = normRot(pinch.baseRotation + (a - pinch.startAngle));
            const snapTo = [-180, -90, 0, 90, 180].find(s => Math.abs(rotation - s) <= 5);
            if (snapTo !== undefined) rotation = normRot(snapTo);
            const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
            pendingDragPos.current = {
                x: Math.max(0, Math.min(100, pinch.baseX + ((midX - pinch.startMidX) / pinch.width) * 100)),
                y: Math.max(0, Math.min(100, pinch.baseY + ((midY - pinch.startMidY) / pinch.height) * 100)),
            };
            pendingPinchRef.current = { scale, rotation };
            if (!rafRef.current) {
                rafRef.current = requestAnimationFrame(() => {
                    const el = dragElementRef.current;
                    if (el && pendingDragPos.current && pendingPinchRef.current) {
                        el.style.left = `${pendingDragPos.current.x}%`;
                        el.style.top = `${pendingDragPos.current.y}%`;
                        el.style.width = `${80 * pendingPinchRef.current.scale}px`;
                        el.style.transform = `translate(-50%, -100%) rotate(${pendingPinchRef.current.rotation}deg)`;
                    }
                    rafRef.current = null;
                });
            }
            return;
        }

        // Single-finger dragging only tracks the primary finger, ignoring other touch points that sweep by along the way
        if (dragPointerIdRef.current !== null && e.pointerId !== dragPointerIdRef.current) return;

        const { startX, startY, initialItemX, initialItemY, width, height } = dragStartRef.current;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const nextX = Math.max(0, Math.min(100, initialItemX + (deltaX / width) * 100));
        const nextY = Math.max(0, Math.min(100, initialItemY + (deltaY / height) * 100));

        // Store pending position
        pendingDragPos.current = { x: nextX, y: nextY };

        // Throttle DOM updates via requestAnimationFrame (once per frame, ~16ms)
        if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
                if (dragElementRef.current && pendingDragPos.current) {
                    // Direct DOM manipulation - NO React re-render
                    dragElementRef.current.style.left = `${pendingDragPos.current.x}%`;
                    dragElementRef.current.style.top = `${pendingDragPos.current.y}%`;
                }
                rafRef.current = null;
            });
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        activePointersRef.current.delete(e.pointerId);
        if (!draggingIdRef.current) return;

        // Cancel any pending rAF
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        // Restore element styles
        if (dragElementRef.current) {
            dragElementRef.current.style.willChange = '';
            dragElementRef.current.style.transition = '';
            dragElementRef.current.style.zIndex = '';
        }

        const wasPinch = !!pinchRef.current;
        const finalPinch = pendingPinchRef.current;

        // Sync final position (and pinch scale/rotation) to React state (only if moved)
        if (pendingDragPos.current || finalPinch) {
            const finalPos = pendingDragPos.current;
            const dragId = draggingIdRef.current;

            recordHistory('op');
            const newItems = items.map(item => item.id === dragId ? {
                ...item,
                ...(finalPos ? { x: finalPos.x, y: finalPos.y } : {}),
                ...(finalPinch ? { scale: finalPinch.scale, rotation: finalPinch.rotation } : {}),
            } : item);
            commitItems(newItems);
        }

        // Cleanup all refs (lifting either finger ends the whole gesture -- the remaining finger no longer drags)
        draggingIdRef.current = null;
        dragElementRef.current = null;
        dragPointerIdRef.current = null;
        pendingDragPos.current = null;
        pendingPinchRef.current = null;
        pinchRef.current = null;
        dragStartRef.current = null;
        activePointersRef.current.clear();
        if (wasPinch) lastPinchEndRef.current = Date.now();
        setDraggingId(null);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch(_) {}
    };

    // --- Renderers ---

    // PIXEL HOME SCREEN
    if (viewState === 'pixelHome' && char) {
        return (
            <PixelHomeView
                charId={char.id}
                charName={char.name}
                charAvatar={char.avatar}
                userName={userProfile?.name || 'User'}
                onBack={() => { if (launchedFromDesktopRef.current) closeApp(); else setViewState('select'); }}
            />
        );
    }

    // SELECT SCREEN
    if (viewState === 'select') {
        // Pixel Home = dark, Dwelling/Homeland = light (per reference design)
        const dark = homeTab === 'pixelHome';
        const th = dark ? {
            pageBg: 'linear-gradient(180deg,#0c1024 0%,#141031 45%,#1a1330 100%)',
            stars: 'radial-gradient(1px 1px at 12% 18%,rgba(255,255,255,.5),transparent),radial-gradient(1px 1px at 78% 12%,rgba(255,230,180,.5),transparent),radial-gradient(1.5px 1.5px at 40% 30%,rgba(207,226,255,.4),transparent),radial-gradient(1px 1px at 88% 40%,rgba(255,255,255,.4),transparent),radial-gradient(1px 1px at 24% 64%,rgba(255,255,255,.35),transparent),radial-gradient(1px 1px at 64% 78%,rgba(255,230,180,.35),transparent)',
            back: 'text-amber-100/70 hover:text-amber-100',
            title: '#fdf6ee', titleShadow: 'rgba(180,160,255,.45)',
            line: 'rgba(212,185,120,.55)', sub: 'text-amber-200/70',
            tabWrapBg: 'rgba(255,255,255,.04)', tabWrapBorder: 'rgba(212,185,120,.25)',
            tabActive: { background: 'linear-gradient(180deg,rgba(124,92,180,.5),rgba(80,60,140,.35))', color: '#f4ecff', border: '1px solid rgba(190,160,255,.4)', boxShadow: '0 0 18px rgba(150,110,220,.4)' } as React.CSSProperties,
            tabIdle: 'rgba(220,215,240,.55)', diamond: '#b89cff',
            desc: 'text-amber-100/45', empty: 'text-amber-100/40',
            tints: ROOM_CARD_TINTS, cardBorder: 'rgba(212,185,120,.28)', cardShadow: '0 10px 26px rgba(0,0,0,.4)',
            inner: 'rgba(212,185,120,.22)', gem: 'rgba(226,200,130,.7)',
            tick: 'rgba(212,185,120,.16)', halo: 'rgba(190,160,235,.22)', ring1: 'rgba(212,185,120,.4)', ring2: 'rgba(212,185,120,.18)', avGlow: 'rgba(160,130,225,.5)',
            badgeBg: 'rgba(246,241,231,.95)', badgeIcon: 'text-amber-700', badgeShadow: '0 1px 5px rgba(0,0,0,.45)',
            name: 'text-amber-50', cardSub: 'text-amber-100/45', footer: 'text-amber-200/35', dot: 'text-amber-200/20',
        } : {
            pageBg: 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)',
            stars: 'radial-gradient(1.5px 1.5px at 14% 16%,rgba(190,160,225,.45),transparent),radial-gradient(1px 1px at 80% 12%,rgba(220,190,235,.5),transparent),radial-gradient(1.5px 1.5px at 42% 28%,rgba(180,200,240,.4),transparent),radial-gradient(1px 1px at 86% 42%,rgba(200,175,230,.4),transparent),radial-gradient(1px 1px at 22% 66%,rgba(210,185,235,.35),transparent),radial-gradient(1px 1px at 66% 80%,rgba(200,210,240,.35),transparent)',
            back: 'text-purple-300 hover:text-purple-500',
            title: '#6a5790', titleShadow: 'rgba(170,150,220,.4)',
            line: 'rgba(150,120,190,.5)', sub: 'text-purple-400/70',
            tabWrapBg: 'rgba(255,255,255,.55)', tabWrapBorder: 'rgba(160,130,200,.22)',
            tabActive: { background: 'linear-gradient(180deg,#ffffff,#f0e9fa)', color: '#5b4b7a', border: '1px solid rgba(170,140,210,.5)', boxShadow: '0 2px 12px rgba(160,120,210,.25)' } as React.CSSProperties,
            tabIdle: 'rgba(110,90,140,.6)', diamond: '#a78bd6',
            desc: 'text-purple-400/70', empty: 'text-purple-300/70',
            tints: ROOM_CARD_TINTS_LIGHT, cardBorder: 'rgba(170,140,210,.3)', cardShadow: '0 8px 22px rgba(150,120,200,.18)',
            inner: 'rgba(170,140,210,.22)', gem: 'rgba(190,160,220,.85)',
            tick: 'rgba(170,140,210,.16)', halo: 'rgba(200,175,235,.3)', ring1: 'rgba(180,150,215,.5)', ring2: 'rgba(180,150,215,.25)', avGlow: 'rgba(190,160,235,.4)',
            badgeBg: '#ffffff', badgeIcon: 'text-purple-500', badgeShadow: '0 1px 5px rgba(120,90,170,.3)',
            name: 'text-purple-900', cardSub: 'text-purple-400/70', footer: 'text-purple-300/70', dot: 'text-purple-300/40',
        };
        // Filter which characters to show by group (the original list when the filter is "All")
        const visitChars = filterCharactersByGroup(characters, characterGroups, visitGroupId);
        return (
            <div className="h-full w-full flex flex-col font-light relative overflow-hidden" style={{ background: th.pageBg }}>
                {/* Starlit ambience */}
                <div className="absolute inset-0 pointer-events-none opacity-70" style={{ backgroundImage: th.stars }} />

                {/* Top: title + tabs (hidden entirely for a fullscreen immersive view once Homeland "actually starts playing" -- entering the world/editing) */}
                <div className={`relative z-10 px-6 shrink-0 ${homeTab === 'worldHome' && worldHomeFull ? 'hidden' : ''}`} style={{ paddingTop: 'max(3rem, var(--safe-top, 0px))' }}>
                    <button onClick={closeApp} className={`absolute left-4 p-2 rounded-full active:scale-90 transition-all ${th.back}`} style={{ top: 'max(3rem, var(--safe-top, 0px))' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="text-center">
                        <h1 className="text-[26px] tracking-[0.15em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: th.title, textShadow: `0 2px 18px ${th.titleShadow}` }}>Whose room to visit?</h1>
                        <div className="flex items-center justify-center gap-2 mt-1.5">
                            <span className="h-px w-10" style={{ background: `linear-gradient(90deg,transparent,${th.line})` }} />
                            <span className={`text-[9px] tracking-[0.45em] font-bold ${th.sub}`}>✦ VISIT ROOM ✦</span>
                            <span className="h-px w-10" style={{ background: `linear-gradient(270deg,transparent,${th.line})` }} />
                        </div>
                    </div>

                    {/* Tab bar: all three sections switch within this one page, no navigation away */}
                    <div className="mt-5 rounded-2xl p-1.5 flex gap-1" style={{ background: th.tabWrapBg, border: `1px solid ${th.tabWrapBorder}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)' }}>
                        {([
                            { id: 'room', label: '🏠 Dwelling' },
                            { id: 'worldHome', label: '🌍 Homeland' },
                            { id: 'pixelHome', label: '🎮 Pixel Home' },
                        ] as const).map(tab => {
                            const active = homeTab === tab.id;
                            return (
                                <button key={tab.id}
                                    onClick={() => { setHomeTab(tab.id); trackEvent('Switch Dwelling Section', { tab: tab.id }); }}
                                    className="relative flex-1 py-2.5 rounded-xl text-[12px] font-bold tracking-wide transition-all"
                                    style={active ? th.tabActive : { color: th.tabIdle }}>
                                    {tab.label}
                                    {active && <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 w-2 h-2 rotate-45" style={{ background: th.diamond, boxShadow: `0 0 8px ${th.diamond}` }} />}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {homeTab === 'worldHome' ? (
                    /* Homeland section: embeds the big-world feature directly, keeping the top three-tab bar (no navigation away, no extra cover layer) */
                    <div className={`relative z-10 flex-1 min-h-0 overflow-hidden ${worldHomeFull ? '' : 'mt-3'}`}>
                        <WorldHomeApp embedded onFullscreen={setWorldHomeFull} />
                    </div>
                ) : (
                    <>
                        {/* Description */}
                        <p className={`relative z-10 text-center text-[11px] mt-4 px-8 leading-relaxed ${th.desc}`}>
                            {homeTab === 'pixelHome' ? 'A pixel-art home -- freely renovate, decorate the room, and dive into memories.' : "Step into someone's room, see what they're up to right now, and poke around their little belongings."}
                        </p>

                        {/* Group filter (not rendered if no groups exist): Pixel Home = dark background, otherwise light */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark={dark}
                            value={visitGroupId} onChange={setVisitGroupId} className="relative z-10 px-5 mt-3 shrink-0" />

                        {/* Character grid */}
                        <div className="relative z-10 flex-1 overflow-y-auto no-scrollbar px-5 pt-4 pb-4">
                            {characters.length === 0 ? (
                                <div className={`text-center text-[12px] py-16 ${th.empty}`}>No characters yet -- go create one in "Neural Link" first.</div>
                            ) : visitChars.length === 0 ? (
                                <div className={`text-center text-[12px] py-16 ${th.empty}`}>No characters in this group</div>
                            ) : (
                                <div className="grid grid-cols-2 gap-4">
                                    {visitChars.map((c, i) => {
                                        const pixel = homeTab === 'pixelHome';
                                        const tint = th.tints[i % th.tints.length];
                                        return (
                                            <button key={c.id} onClick={() => { if (pixel) { setActiveCharacterId(c.id); setViewState('pixelHome'); } else handleEnterRoom(c); }}
                                                className="group relative rounded-2xl px-3 pt-8 pb-5 flex flex-col items-center active:scale-95 transition-all overflow-hidden"
                                                style={{ background: tint, border: `1px solid ${th.cardBorder}`, boxShadow: th.cardShadow }}>
                                                {/* Inner gilded border + gems on all four corners */}
                                                <div className="absolute inset-[7px] rounded-xl pointer-events-none" style={{ border: `1px solid ${th.inner}` }} />
                                                <span className="absolute top-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute top-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute bottom-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute bottom-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                {/* Avatar + compass-rose pattern + double ring */}
                                                <div className="relative w-[92px] h-[92px] flex items-center justify-center">
                                                    <div className="absolute w-[124px] h-[124px] rounded-full" style={{ background: `repeating-conic-gradient(from 0deg, ${th.tick} 0deg 2.4deg, transparent 2.4deg 9deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)', maskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)' }} />
                                                    <div className="absolute w-[110px] h-[110px] rounded-full" style={{ background: `radial-gradient(circle, ${th.halo}, transparent 62%)` }} />
                                                    <div className="absolute inset-[8px] rounded-full" style={{ border: `1px solid ${th.ring1}` }} />
                                                    <div className="absolute inset-[12px] rounded-full" style={{ border: `1px solid ${th.ring2}` }} />
                                                    <div className="w-[70px] h-[70px] rounded-full overflow-hidden" style={{ boxShadow: `0 0 18px ${th.avGlow}` }}>
                                                        <TokenImg value={c.avatar} className="w-full h-full object-cover" alt={c.name} />
                                                    </div>
                                                    <div className="absolute bottom-0 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ background: th.badgeBg, boxShadow: th.badgeShadow }}>
                                                        {pixel ? <span className="text-[10px]">🎮</span> : (
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`w-3.5 h-3.5 ${th.badgeIcon}`}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" /></svg>
                                                        )}
                                                    </div>
                                                </div>
                                                <span className={`mt-3 text-[14px] font-semibold tracking-wide ${th.name}`} style={{ fontFamily: `'Noto Serif SC',serif` }}>{c.name}</span>
                                                <span className={`mt-0.5 text-[10px] ${th.cardSub}`}>{pixel ? "Enter their Pixel Home" : "Visit their room"}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Bottom decoration */}
                        <div
                            className={`relative z-10 shrink-0 flex items-center justify-center gap-2.5 text-[8.5px] tracking-[0.35em] font-bold ${th.footer}`}
                            style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }}
                        >
                            <span>EXPLORE</span><span className={th.dot}>◆</span><span>CONNECT</span><span className={th.dot}>◆</span><span>DISCOVER</span>
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ROOM SCREEN
    // PERF: Reduced from 3 drop-shadows to 1 simple shadow -- massive mobile GPU savings
    const stickerClass = "filter drop-shadow-[0_2px_4px_rgba(0,0,0,0.15)]";

    // Background Style Construction (Logic 1: Legacy String vs New Config)
    const getBgStyle = (img: string | undefined, scale: number | undefined, repeat: boolean | undefined) => {
        if (!img) return '';
        // blob: is an objectURL resolved from a token -- it also needs to be treated as an image (url()), or it'll be mistaken for a CSS gradient.
        const isUrl = img.startsWith('http') || img.startsWith('data') || img.startsWith('blob:') || img.startsWith('/');
        const url = isUrl ? `url(${img})` : img; // If it's a CSS gradient, use it directly
        
        // If it's a gradient string (not URL), ignore scale params as they apply to background-size which works on gradients too, but repeat usually doesn't apply the same way.
        // Let's assume adjustments are mostly for Images.
        if (!isUrl) return url;

        // Apply Config
        const size = scale && scale > 0 ? `${scale}%` : 'cover'; // 0 = Cover
        const rep = repeat ? 'repeat' : 'no-repeat';
        const pos = 'center center';
        
        return `${url} ${pos} / ${size} ${rep}`;
    };

    const wallStyle = getBgStyle(wallImg, char?.roomConfig?.wallScale, char?.roomConfig?.wallRepeat) || WALLPAPER_PRESETS[0].value;
    const floorStyle = getBgStyle(floorImg, char?.roomConfig?.floorScale, char?.roomConfig?.floorRepeat) || FLOOR_PRESETS[0].value;

    // Merge Asset Libraries for Modal
    const displayLibrary: Record<string, any[]> = {
        ...ASSET_LIBRARY,
        custom: customAssets
    };

    // Sully Check
    const isSully = char?.id === 'preset-sully-v2' || char?.name === 'Sully';

    // Whether today's room has already been generated (a lastRoomDate match for today counts as generated) -- determines whether to show the "Update Today" prompt
    const todayGenerated = !!char && char.lastRoomDate === getVirtualDay(char);

    const renderTemplateButton = (template: BuiltInRoomTemplate, onSelect: (template: BuiltInRoomTemplate) => void, actionLabel: string) => (
        <button
            key={template.id}
            onClick={() => onSelect(template)}
            disabled={sampleRoomLoadingId === template.id}
            className="min-w-0 text-left rounded-lg border border-slate-200 bg-white overflow-hidden active:scale-[0.98] transition-transform disabled:opacity-60"
        >
            <div className="relative h-28 bg-slate-100 overflow-hidden">
                <div className="absolute inset-0 bg-center bg-cover" style={{ backgroundImage: `url(${template.thumbnail})` }} />
                <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/45 to-transparent" />
                <div className="absolute left-2 top-2 w-6 h-6 rounded-full bg-white/90 text-slate-700 text-xs font-black flex items-center justify-center shadow-sm">
                    {template.label}
                </div>
                <div className="absolute left-2 right-2 bottom-2 text-white">
                    <p className="text-xs font-black leading-tight truncate">{template.name}</p>
                    <p className="text-[9px] leading-tight opacity-85 truncate">{actionLabel}</p>
                </div>
            </div>
            <div className="p-2">
                <p className="text-[10px] text-slate-500 leading-snug">{template.description}</p>
            </div>
        </button>
    );

    return (
        <div className="h-full w-full bg-[#f8fafc] flex flex-col relative overflow-hidden font-sans select-none">

            {/* "Update Today" generates the whole room in one pass (billed per call, so it reads
                everything in one go and doesn't make you wait again while browsing the room
                afterward). It's inherently slow, so small print here explains why to the user.
                Entering the room itself no longer triggers it. */}
            {isInitializing && (
                <div className="absolute inset-0 z-[500] bg-white flex flex-col items-center justify-center animate-fade-in px-10 text-center">
                    <div className="text-4xl mb-4 animate-bounce"><Door size={48} className="text-slate-400" /></div>
                    <p className="text-sm font-bold text-slate-500">{initStatusText}</p>
                    <p className="text-[11px] text-slate-400/90 leading-[1.7] mt-3 max-w-[268px]">
                        "Reading" the entire room in one pass -- their current state, the look and reaction for <b className="text-slate-500">every single item</b> in the room, and today's plan and journal entry, all generated in this one call.
                        <br />More items take longer, but it only generates once -- after that you can browse everything right away, and tapping any item won't make you wait again.
                    </p>
                </div>
            )}

            <Modal
                isOpen={showSampleRoomOffer && !!char}
                title="Sully's Room Template Pitch"
                onClose={dismissSampleRoomOffer}
                footer={
                    <button onClick={dismissSampleRoomOffer} className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl text-xs">
                        No thanks, I'm good
                    </button>
                }
            >
                <div className="space-y-4">
                    <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2.5">
                        <p className="text-sm font-bold text-slate-700">This place looks pretty empty -- Sully's here to pitch you two room templates:</p>
                        <p className="text-[10px] text-slate-400 leading-relaxed mt-1">Room templates are kept in "Furniture Store · Room Templates" -- you can pick one again later and adjust it further.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        {BUILTIN_ROOM_TEMPLATES.map(template => renderTemplateButton(template, chooseSampleRoom, sampleRoomLoadingId === template.id ? 'Importing...' : 'Tap to Apply'))}
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={showActorArtModal && !!char}
                title="Change Character Portrait"
                onClose={() => setShowActorArtModal(false)}
            >
                <div className="grid grid-cols-2 gap-3">
                    <button
                        onClick={() => { setShowActorArtModal(false); actorInputRef.current?.click(); }}
                        className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-4 text-left active:scale-[0.98] transition-transform"
                    >
                        <Image size={26} className="text-blue-500 mb-3" />
                        <p className="text-sm font-bold text-slate-700">Upload a custom image</p>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">Choose a new room portrait from your device.</p>
                    </button>
                    <button
                        onClick={openActorStudio}
                        className="min-w-0 rounded-lg border border-purple-200 bg-purple-50 p-4 text-left active:scale-[0.98] transition-transform"
                    >
                        <Sparkle size={26} className="text-purple-500 mb-3" />
                        <p className="text-sm font-bold text-slate-700">Open Character Creator</p>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">Go to the figure showcase inside Neural Link.</p>
                    </button>
                </div>
            </Modal>

            {/* Room Stage */}
            <div ref={roomRef} className="flex-1 relative overflow-hidden transition-all duration-500 touch-none" onPointerDown={handleStagePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onClick={handleStageClick}>
                <div className="absolute top-0 left-0 w-full h-[65%] bg-center transition-all duration-500 z-0" style={{ background: wallStyle }}></div>
                <div className="absolute bottom-0 left-0 w-full h-[35%] bg-center transition-all duration-500 z-0" style={{ background: floorStyle }}></div>
                <div className="absolute top-[65%] w-full h-8 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0"></div>
                {items.map(item => {
                    const isDragging = draggingId === item.id;
                    return (
                        <div
                            key={item.id}
                            onPointerDown={(e) => handlePointerDown(e, item.id)}
                            onClick={(e) => handleLookAt(item, e)}
                            onWheel={(e) => {
                                // Desktop: once selected, the wheel scales directly (mobile uses two-finger pinch)
                                if (mode !== 'edit' || selectedItemId !== item.id) return;
                                const next = Math.min(6, Math.max(0.2, item.scale + (e.deltaY < 0 ? 0.08 : -0.08)));
                                updateSelectedItem({ scale: Math.round(next * 100) / 100 }, 'cont:wheel');
                            }}
                            className={`absolute origin-bottom-center ${stickerClass} ${mode === 'edit' ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : (item.isInteractive ? 'cursor-pointer active:scale-95' : '')} ${selectedItemId === item.id ? 'ring-2 ring-blue-400 rounded-lg ring-offset-4' : ''} touch-none select-none`}
                            style={{
                                left: `${item.x}%`,
                                top: `${item.y}%`,
                                width: `${80 * item.scale}px`,
                                transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
                                // Rugs are compressed into the bottom [1,11] z-index range: the character's zIndex is >= 80
                                // (y is clamped below the horizon, then +20), and regular furniture is ordered by y --
                                // both always end up layered above rugs.
                                zIndex: isDragging ? 100 : (item.type === 'rug' ? 1 + Math.floor(item.y / 10) : Math.floor(item.y)),
                                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
                                willChange: isDragging ? 'left, top' : 'auto' // GPU layer only when needed
                            }}
                        >
                            <TokenImg value={item.image} className="w-full h-auto object-contain pointer-events-none select-none" draggable={false} loading="lazy" />
                            {mode === 'edit' && selectedItemId === item.id && <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[9px] px-2 py-0.5 rounded-full whitespace-nowrap">Selected</div>}
                        </div>
                    );
                })}
                
                {/* Character Actor - Z Index Boosted to simulate standing in front */}
                {!(mode === 'edit' && hideActorInEdit) && <div onClick={(e) => { e.stopPropagation(); handlePokeActor(); }} className={`absolute transition-[left,top] duration-[1000ms] ease-in-out origin-bottom-center ${stickerClass} cursor-pointer active:scale-95 group`} style={{ left: `${actorState.x}%`, top: `${actorState.y}%`, width: '120px', transform: `translate(-50%, -100%) scale(${actorState.action === 'walk' ? 1.05 : (actorState.action === 'bounce' ? 1.1 : 1)})`, zIndex: Math.floor(actorState.y) + 20 }}>
                    <img src={actorImage} className={`w-full h-full object-contain ${actorState.action === 'walk' ? 'animate-bounce' : ''}`} alt="" />
                    {mode === 'edit' && <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[9px] px-2 py-1 rounded backdrop-blur-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"><Camera size={12} /> Change Outfit</div>}
                    {/* Fixed: Wider bubble width */}
                    {aiBubble.visible && <div className="absolute bottom-[105%] left-1/2 -translate-x-1/2 bg-white px-4 py-3 rounded-[20px] rounded-bl-none shadow-lg border-2 border-black/5 min-w-[120px] max-w-[300px] animate-pop-in z-50"><p className="text-xs font-bold text-slate-700 leading-tight text-center break-words">{aiBubble.text}</p><button onClick={(e) => { e.stopPropagation(); setAiBubble({ ...aiBubble, visible: false }); }} className="absolute -top-2 -right-2 bg-slate-200 text-slate-500 rounded-full w-4 h-4 flex items-center justify-center text-[8px]">×</button></div>}
                </div>}
            </div>

            {/* View Dream entry · the "moon" button on the left-center edge (only shown in view mode, symmetric with "Life Fragments" on the right) */}
            {mode === 'view' && (
                <button onClick={() => { setShowDream(true); trackEvent('Open Dream Theater'); }} title="View Dream"
                    className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 px-2.5 py-3 rounded-r-2xl shadow-lg border border-l-0 z-[300] active:scale-95 transition-transform"
                    style={{ background: 'linear-gradient(135deg, #2a2440, #1a1730)', borderColor: 'rgba(205,214,255,0.25)' }}>
                    <MoonStars size={20} weight="fill" style={{ color: '#cdd6ff' }} />
                    <span className="text-[8px] font-bold tracking-wider text-[#cdd6ff]/80 [writing-mode:vertical-rl]">Dream</span>
                </button>
            )}

            {/* Dream playback · fullscreen overlay (the character doesn't remember the dream, but the user got a peek) */}
            {showDream && char && <DreamTheater char={char} onExit={() => { setShowDream(false); if (launchedFromDesktopRef.current) closeApp(); }} />}

            {/* Sidebar Toggle Button */}
            <button onClick={() => setShowSidebar(true)} className={`absolute right-0 top-1/2 -translate-y-1/2 bg-white/90 p-3 rounded-l-2xl shadow-lg border border-r-0 border-slate-200 transition-transform duration-300 z-[300] ${showSidebar ? 'translate-x-full' : 'translate-x-0'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </button>
            {showSidebar && <div className="absolute inset-0 z-[290] bg-black/20" onClick={() => setShowSidebar(false)}></div>}
            <div className={`absolute right-0 top-0 bottom-0 w-3/4 max-w-sm bg-white shadow-2xl z-[300] transition-transform duration-300 ease-out flex flex-col ${showSidebar ? 'translate-x-0' : 'translate-x-full'}`}>
                <div className="p-6 pb-2 border-b border-slate-100 flex justify-between items-center bg-slate-50" style={{ paddingTop: 'max(1.5rem, var(--safe-top, 0px))' }}>
                    <h3 className="text-lg font-bold text-slate-700 tracking-tight">Life Fragments</h3>
                    <button onClick={() => setShowSidebar(false)} className="p-2 -mr-2 text-slate-400 hover:text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
                </div>
                <div className="flex p-2 bg-slate-50 border-b border-slate-100">
                    <button onClick={() => { setActivePanel('todo'); trackEvent('Switch Life Fragments Panel', { panel: 'todo' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'todo' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>Today's Plan</button>
                    <button onClick={() => { setActivePanel('schedule'); trackEvent('Switch Life Fragments Panel', { panel: 'schedule' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'schedule' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>Schedule</button>
                    <button onClick={() => { setActivePanel('notebook'); trackEvent('Switch Life Fragments Panel', { panel: 'notebook' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'notebook' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>Private Notes</button>
                </div>

                {/* Fixed: Add no-scrollbar class to hide scrollbar */}
                <div className="flex-1 overflow-y-auto p-6 bg-[#fcfcfc] no-scrollbar" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}>
                    {activePanel === 'todo' && (
                        <div className="space-y-6">
                            <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{todaysTodo?.date || 'Today'}</span><span className="text-[10px] bg-slate-100 px-2 py-1 rounded text-slate-500">Completion: {todaysTodo ? Math.round((todaysTodo.items.filter(i=>i.done).length / todaysTodo.items.length)*100) : 0}%</span></div>
                            {todaysTodo ? <ul className="space-y-3">{todaysTodo.items.map((item, idx) => (
                                <li key={idx} className="flex items-start gap-3 group">
                                    <div onClick={() => handleToggleTodo(idx)} className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors cursor-pointer ${item.done ? 'bg-green-400 border-green-400' : 'border-slate-300 group-hover:border-primary'}`}>
                                        {item.done && <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor"><path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"/></svg>}
                                    </div>
                                    <span onClick={() => handleToggleTodo(idx)} className={`text-sm leading-relaxed transition-all flex-1 cursor-pointer ${item.done ? 'text-slate-300 line-through decoration-slate-300' : 'text-slate-700 font-medium'}`}>{item.text}</span>
                                    <button onClick={() => handleDeleteTodo(idx)} className="text-slate-300 hover:text-red-400 px-1 opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                                </li>
                            ))}</ul> : <div className="text-center py-10 text-slate-400 text-xs">Generating...</div>}
                            <div className="mt-8 p-4 bg-yellow-50 rounded-xl border border-yellow-100 text-xs text-yellow-800 leading-relaxed italic relative"><span className="absolute -top-3 left-4"><img src={twemojiUrl('1f4cc')} alt="pin" className="w-6 h-6" /></span>This is {char?.name}'s automatic schedule for today. You can't do it for them, but you can keep an eye on them.</div>
                        </div>
                    )}
                    {activePanel === 'schedule' && (
                        <div className="space-y-4">
                            <ScheduleCard
                                schedule={roomSchedule}
                                character={char || null}
                                compact={true}
                            />
                            {!roomSchedule && (
                                <p className="text-center text-xs text-slate-400 py-4">The schedule will be generated automatically the first time you chat</p>
                            )}
                        </div>
                    )}
                    {activePanel === 'notebook' && (
                        <div className="flex flex-col pb-4">
                            {notebookEntries.length > 0 ? (
                                <div
                                    className="relative bg-white shadow-md border border-slate-200 p-6 min-h-[400px] flex flex-col rounded-xl"
                                    style={{ backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', backgroundSize: '20px 20px' }}
                                >
                                    {/* Spiral Binding Visual - Adaptive Height */}
                                    <div className="absolute left-4 top-4 bottom-4 w-px border-l-2 border-dotted border-slate-300 pointer-events-none"></div>

                                    <div className="mb-4 ml-6 flex justify-between items-center text-[10px] text-slate-400 font-mono border-b border-slate-100 pb-2">
                                        <span>#{notebookEntries.length - notebookPage}</span>
                                        <div className="flex gap-2 items-center">
                                            <span>{new Date(notebookEntries[notebookPage].timestamp).toLocaleString('en-US')}</span>
                                            <button onClick={() => handleDeleteNote(notebookEntries[notebookPage].id)} className="text-red-300 hover:text-red-500 font-bold px-1" title="Delete this page">×</button>
                                        </div>
                                    </div>
                                    <div className="flex-1 ml-6 text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">{renderNotebookContent(notebookEntries[notebookPage].content)}</div>
                                    <div className="mt-6 ml-6 flex justify-between items-center pt-4 border-t border-slate-100"><button disabled={notebookPage >= notebookEntries.length - 1} onClick={() => setNotebookPage(p => p + 1)} className="text-slate-400 hover:text-primary disabled:opacity-30">&larr; Older</button><span className="text-[10px] text-slate-300">{notebookPage + 1} / {notebookEntries.length}</span><button disabled={notebookPage <= 0} onClick={() => setNotebookPage(p => p - 1)} className="text-slate-400 hover:text-primary disabled:opacity-30">Newer &rarr;</button></div>
                                </div>
                            ) : <div className="text-center py-10 text-slate-400 text-xs">The notebook is empty...</div>}
                        </div>
                    )}
                </div>
            </div>

            {/* UI Overlay */}
            <div className="absolute top-0 w-full px-4 pb-2 flex justify-between z-30 pointer-events-none" style={{ paddingTop: 'max(3rem, var(--safe-top, 0px))' }}>
                <button onClick={() => { if (launchedFromDesktopRef.current) closeApp(); else setViewState('select'); }} className="bg-white/90 p-2 rounded-full shadow-md pointer-events-auto active:scale-90 transition-transform text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                <div className="flex gap-2 pointer-events-auto">
                    {/* Edit mode: Undo / Redo */}
                    {mode === 'edit' && (
                        <>
                            <button onClick={() => setHideActorInEdit(v => !v)} className={`p-2 rounded-full shadow-md active:scale-90 transition-all ${hideActorInEdit ? 'bg-blue-500 text-white' : 'bg-white/90 text-slate-500'}`} title={hideActorInEdit ? 'Show Character' : 'Hide Character'} aria-label={hideActorInEdit ? 'Show Character' : 'Hide Character'}>
                                {hideActorInEdit ? <EyeSlash size={22} weight="bold" /> : <Eye size={22} weight="bold" />}
                            </button>
                            <button onClick={undo} disabled={!history.length} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 disabled:opacity-40 active:scale-90 transition-transform" title="Undo">
                                <ArrowUUpLeft size={22} weight="bold" />
                            </button>
                            <button onClick={redo} disabled={!future.length} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 disabled:opacity-40 active:scale-90 transition-transform" title="Redo">
                                <ArrowUUpRight size={22} weight="bold" />
                            </button>
                        </>
                    )}
                    {/* REFRESH BUTTON — only shown once today has been generated (before that, the "Update Today" banner below handles it) */}
                    {mode === 'view' && todayGenerated && (
                        <button onClick={() => setShowRefreshConfirm(true)} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 hover:text-primary active:scale-90 transition-transform" title="Force refresh today">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    )}
                    <button onClick={() => { setMode(mode === 'view' ? 'edit' : 'view'); setSelectedItemId(null); trackEvent('Toggle Room Edit Mode', { mode: mode === 'view' ? 'edit' : 'view' }); }} className={`px-4 py-2 rounded-full font-bold text-xs shadow-md transition-all ${mode === 'edit' ? 'bg-blue-500 text-white' : 'bg-white text-slate-600'}`}>{mode === 'edit' ? 'Done' : 'Edit'}</button>
                </div>
            </div>

            {/* Observation Card (Bottom) */}
            {observationText && mode === 'view' && <div className="absolute left-4 right-4 bg-white p-5 rounded-2xl shadow-2xl border border-slate-100 z-[150] animate-slide-up" style={{ bottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}><div className="flex justify-between items-start mb-2"><span className="text-xs font-bold text-blue-500 uppercase tracking-widest">OBSERVATION</span><button onClick={() => setObservationText('')} className="text-slate-400 hover:text-slate-600">×</button></div><p className="text-sm text-slate-700 leading-relaxed font-medium text-justify">{observationText}</p></div>}

            {/* "Update Today" banner -- shown while today hasn't been generated yet (entering the room no longer blocks on it; the user triggers it manually) */}
            {mode === 'view' && !todayGenerated && !isInitializing && !observationText && (
                <div className="absolute left-4 right-4 bg-white p-4 rounded-2xl shadow-2xl border border-slate-100 z-[150] animate-slide-up flex items-center gap-3" style={{ bottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}>
                    <div className="w-10 h-10 rounded-xl bg-primary-light flex items-center justify-center shrink-0">
                        <Door size={22} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-700 leading-tight">You haven't stepped into {char?.name}'s day yet today</p>
                        <p className="text-[11px] text-slate-400 leading-snug mt-0.5">Item reactions, today's plan, and the journal entry will all be generated in this one call, which takes a bit of time.</p>
                    </div>
                    <button onClick={handleGenerateToday} className="shrink-0 px-4 py-2.5 rounded-xl bg-primary text-white text-xs font-bold shadow-md active:scale-95 transition-transform">
                        Update Today
                    </button>
                </div>
            )}

            {/* Edit Mode Toolbar - Collapsible */}
            {mode === 'edit' && (
                <div
                    className="absolute bottom-0 w-full bg-white border-t border-slate-200 z-[150] transition-transform duration-300 flex flex-col"
                    style={{
                        paddingBottom: 'var(--safe-bottom, 0px)',
                        maxHeight: isToolbarCollapsed ? 'auto' : '45vh',
                        transform: isToolbarCollapsed ? 'translateY(calc(100% - 2.5rem - var(--safe-bottom, 0px)))' : undefined,
                        boxSizing: 'border-box',
                    }}
                >
                    <div
                        className="w-full flex items-center justify-center cursor-pointer bg-white active:bg-slate-50 border-b border-slate-100"
                        style={{
                            height: isToolbarCollapsed ? 'calc(2.5rem + var(--safe-bottom, 0px))' : '2.5rem',
                            paddingBottom: isToolbarCollapsed ? 'var(--safe-bottom, 0px)' : undefined,
                            boxSizing: 'border-box',
                        }}
                        onClick={() => setIsToolbarCollapsed(!isToolbarCollapsed)}
                    ><div className="w-10 h-1 bg-slate-200 rounded-full"></div></div>
                    <div className="p-4 overflow-y-auto flex-1">
                        {selectedItemId ? (() => {
                            const sel = items.find(i => i.id === selectedItemId);
                            if (!sel) return null;
                            const isRug = sel.type === 'rug';
                            const nudgeBtn = "w-9 h-9 bg-slate-100 rounded-lg text-slate-500 font-bold text-sm active:bg-blue-100 active:text-blue-500 active:scale-95 transition-all";
                            return (
                            <div className="flex flex-col gap-3">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-xs font-bold text-slate-500 truncate">Adjust · {sel.name}</span>
                                    <div className="flex gap-2 shrink-0">
                                        <button onClick={duplicateSelectedItem} className="text-xs text-blue-500 font-bold bg-blue-50 px-3 py-1 rounded-full flex items-center gap-1"><CopySimple size={13} weight="bold" /> Duplicate</button>
                                        <button onClick={deleteSelectedItem} className="text-xs text-red-500 font-bold bg-red-50 px-3 py-1 rounded-full">Delete</button>
                                    </div>
                                </div>
                                <div className="flex gap-4 items-stretch">
                                    <div className="flex-1 flex flex-col justify-center gap-3 min-w-0">
                                        <div>
                                            <label className="text-[10px] text-slate-400 block mb-1">Scale <span className="text-slate-600 font-bold">{Math.round(sel.scale * 100)}%</span></label>
                                            <input type="range" min="0.2" max="6" step="0.05" value={sel.scale} onChange={(e) => updateSelectedItem({ scale: parseFloat(e.target.value) }, 'cont:scale')} className="w-full h-1 bg-slate-200 rounded-full accent-blue-500" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-slate-400 block mb-1">
                                                Rotation <span className="text-slate-600 font-bold">{Math.round(sel.rotation)}°</span>
                                                {sel.rotation !== 0 && <button onClick={() => updateSelectedItem({ rotation: 0 }, 'op')} className="ml-2 text-[9px] text-blue-500 font-bold bg-blue-50 px-1.5 py-0.5 rounded-full">Reset</button>}
                                            </label>
                                            <input type="range" min="-180" max="180" step="1" value={sel.rotation} onChange={(e) => updateSelectedItem({ rotation: parseInt(e.target.value) }, 'cont:rotate')} className="w-full h-1 bg-slate-200 rounded-full accent-blue-500" />
                                        </div>
                                    </div>
                                    {/* D-pad nudge: move one grid cell at a time when dragging isn't precise enough */}
                                    <div className="grid grid-cols-3 gap-1 shrink-0 self-center">
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(0, -1)} className={nudgeBtn}>↑</button>
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(-1, 0)} className={nudgeBtn}>←</button>
                                        <span className="w-9 h-9 flex items-center justify-center text-[8px] text-slate-300 font-bold">1%</span>
                                        <button onClick={() => nudgeSelectedItem(1, 0)} className={nudgeBtn}>→</button>
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(0, 1)} className={nudgeBtn}>↓</button>
                                        <span />
                                    </div>
                                </div>
                                {/* Type toggle: turn an already-placed item into a rug (sinks to the bottom layer) or back into furniture */}
                                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                                    <span className="text-[10px] text-slate-400">Layer type{isRug ? ': Rug (bottom layer, character stands on top)' : ''}</span>
                                    <button onClick={() => updateSelectedItem({ type: isRug ? 'furniture' : 'rug' }, 'op')} className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${isRug ? 'bg-purple-100 text-purple-600' : 'bg-slate-200 text-slate-500'}`}>
                                        {isRug ? 'Change back to furniture' : 'Set as rug'}
                                    </button>
                                </div>
                                {/* Interactive toggle: when off, the character no longer generates a description/reaction for it */}
                                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                                    <span className="text-[10px] text-slate-400">Interactive (the character will generate a description and reaction for it)</span>
                                    <button onClick={() => updateSelectedItem({ isInteractive: !sel.isInteractive }, 'op')} className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${sel.isInteractive ? 'bg-green-100 text-green-600' : 'bg-slate-200 text-slate-500'}`}>
                                        {sel.isInteractive ? 'On' : 'Off'}
                                    </button>
                                </div>
                                <p className="text-[9px] text-slate-300 text-center">Tip: while dragging with one finger, touch down a second finger to pinch-scale / rotate directly; on desktop, the wheel can also scale once an item is selected</p>
                            </div>
                            );
                        })() : (
                            <div className="space-y-4">
                                <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                                    <button onClick={() => { setShowLibrary(true); trackEvent('Open Furniture Store'); }} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center text-white shadow-md text-xl">+</div><span className="text-[10px] font-bold text-slate-500">Furniture Library</span></button>
                                    <button onClick={() => setShowCustomModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-purple-500 rounded-xl flex items-center justify-center text-white shadow-md"><Sparkle size={24} /></div><span className="text-[10px] font-bold text-slate-500">Custom</span></button>
                                    <button onClick={() => setShowActorArtModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-pink-500 rounded-xl flex items-center justify-center text-white shadow-md"><Camera size={24} /></div><span className="text-[10px] font-bold text-slate-500">Character Portrait</span></button>
                                    {/* Batch import: select multiple images at once, all stored as custom assets */}
                                    <button onClick={() => batchAssetInputRef.current?.click()} disabled={isBatchImporting} className="flex flex-col items-center gap-1 shrink-0 disabled:opacity-50"><div className="w-12 h-12 bg-fuchsia-500 rounded-xl flex items-center justify-center text-white shadow-md"><Images size={24} /></div><span className="text-[10px] font-bold text-slate-500">{isBatchImporting ? 'Importing…' : 'Batch Import'}</span></button>
                                    <button onClick={() => wallInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center text-slate-500 shadow-sm border border-slate-300"><Image size={24} /></div><span className="text-[10px] font-bold text-slate-500">Change Wallpaper</span></button>
                                    <button onClick={() => floorInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center shadow-sm border border-slate-300"><img src={twemojiUrl('1f9f1')} alt="brick" className="w-6 h-6" /></div><span className="text-[10px] font-bold text-slate-500">Change Floor</span></button>
                                    {/* Export Room Template Button */}
                                    <button onClick={() => { setExportName(prev => prev || `${char?.name || ''}'s Room`); setShowExportModal(true); }} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-md"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 7.5 12 3m0 0 4.5 4.5M12 3v13.5" /></svg></div><span className="text-[10px] font-bold text-slate-500">Export Room</span></button>
                                    {/* Import Room Template Button (the other half of export: reads a .room.json room template) */}
                                    <button onClick={() => importRoomInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-sky-500 rounded-xl flex items-center justify-center text-white shadow-md"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div><span className="text-[10px] font-bold text-slate-500">Import Room</span></button>
                                    {/* Settings Button */}
                                    <button onClick={() => setShowSettingsModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center text-slate-600 shadow-sm border border-slate-300"><GearSix size={24} /></div><span className="text-[10px] font-bold text-slate-500">Settings</span></button>
                                    {/* Developer Export Button */}
                                    <button onClick={() => setShowDevModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-800 rounded-xl flex items-center justify-center text-white shadow-sm border border-slate-600">{'{}'}</div><span className="text-[10px] font-bold text-slate-500">Dev</span></button>

                                    <input type="file" ref={wallInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'wall')} />
                                    <input type="file" ref={floorInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'floor')} />
                                    <input type="file" ref={actorInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'actor')} />
                                </div>
                                <div><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase">Wallpaper Presets</h4><div className="flex gap-2 overflow-x-auto no-scrollbar">{WALLPAPER_PRESETS.map((wp, i) => <button key={i} onClick={() => handleWallChange(wp.value)} className="w-10 h-10 rounded-lg shadow-sm border border-slate-200 shrink-0" style={{ background: wp.value }}></button>)}</div></div>
                                <div><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase">Floor Presets</h4><div className="flex gap-2 overflow-x-auto no-scrollbar">{FLOOR_PRESETS.map((fp, i) => <button key={i} onClick={() => handleFloorChange(fp.value)} className="w-10 h-10 rounded-lg shadow-sm border border-slate-200 shrink-0" style={{ background: fp.value }}></button>)}</div></div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Hidden file pickers for batch asset import / room template import (kept at the top level: used by both the toolbar and the Furniture Store modal) */}
            <input type="file" ref={batchAssetInputRef} className="hidden" accept="image/*" multiple onChange={handleBatchAssetImport} />
            <input type="file" ref={importRoomInputRef} className="hidden" accept=".json,application/json" onChange={handleImportRoomFile} />

            {/* Asset Library Modal (tapping no longer auto-closes it, so you can tap repeatedly to place items in batch) */}
            <Modal isOpen={showLibrary} title="Furniture Store" onClose={() => setShowLibrary(false)}
                footer={<button onClick={() => setShowLibrary(false)} className="w-full py-3 bg-blue-500 text-white font-bold rounded-2xl text-xs">All set, close</button>}
            >
                <div className="h-96 overflow-y-auto no-scrollbar">
                    <div className="flex items-center justify-between gap-3 mb-4 bg-purple-50 border border-purple-100 rounded-xl px-3 py-2.5">
                        <p className="text-[10px] text-purple-500 leading-relaxed flex-1">Tap to place it in the room -- tap repeatedly to place items in batch; your own images can be selected multiple at once and imported in bulk.</p>
                        <button onClick={() => batchAssetInputRef.current?.click()} disabled={isBatchImporting} className="shrink-0 px-3 py-2 bg-purple-500 text-white text-[10px] font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform">{isBatchImporting ? 'Importing…' : '+ Batch Import'}</button>
                    </div>
                    <div className="mb-6">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 sticky top-0 bg-white py-2 z-10 flex justify-between">
                            Room Templates
                            <span className="text-[9px] bg-slate-100 px-2 rounded-full">{BUILTIN_ROOM_TEMPLATES.length}</span>
                        </h4>
                        <div className="grid grid-cols-2 gap-3">
                            {BUILTIN_ROOM_TEMPLATES.map(template => renderTemplateButton(template, openBuiltInRoomTemplate, sampleRoomLoadingId === template.id ? 'Loading...' : 'Open & Import'))}
                        </div>
                        <p className="text-[9px] text-slate-400 leading-relaxed mt-2">After opening, choose to replace your current room, or just merge in the room template's items.</p>
                    </div>
                    {Object.entries(displayLibrary).map(([category, assets]) => (
                        assets && assets.length > 0 && (
                            <div key={category} className="mb-6">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 sticky top-0 bg-white py-2 z-10 flex justify-between">
                                    {category === 'sully_special' ? 'Sully Exclusive (Special)' : (category === 'custom' ? 'Custom' : (category === 'rug' ? 'Rug' : category))}
                                    <span className="text-[9px] bg-slate-100 px-2 rounded-full">{assets.length}</span>
                                </h4>
                                <div className="grid grid-cols-4 gap-4">
                                    {assets.map((asset: any, i: number) => {
                                        const isCustom = category === 'custom';
                                        const handlers = isCustom ? {
                                            onTouchStart: () => handleAssetTouchStart(asset),
                                            onTouchEnd: handleAssetTouchEnd,
                                            onMouseDown: () => handleAssetTouchStart(asset),
                                            onMouseUp: handleAssetTouchEnd,
                                            onMouseLeave: handleAssetTouchEnd,
                                            onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); handleAssetTouchStart(asset); assetLongPressTimer.current && clearTimeout(assetLongPressTimer.current); setEditingAsset(asset); setEditName(asset.name); setEditDescription(asset.description || ''); setEditImage(asset.image); setEditVisibility(asset.visibility || 'public'); setEditAssignedCharIds(asset.assignedCharIds || []); setEditItemType(asset.itemType || 'furniture'); }
                                        } : {};

                                        return (
                                            <button
                                                key={asset.id || i}
                                                onClick={() => addItem(asset, category === 'custom' ? (asset.itemType || 'furniture') : (category === 'sully_special' ? 'furniture' : category as any))}
                                                className="flex flex-col items-center gap-2 group relative active:scale-95 transition-transform"
                                                {...handlers}
                                            >
                                                <div className="w-14 h-14 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 group-hover:border-blue-300 transition-colors overflow-hidden relative">
                                                    <TokenImg value={asset.image} className="w-full h-full object-contain" />
                                                    {isCustom && asset.visibility === 'character' && <div className="absolute top-0 right-0 w-3 h-3 bg-blue-400 rounded-bl-lg" title="Character exclusive"></div>}
                                                </div>
                                                <span className="text-[10px] text-slate-500 truncate w-full text-center">{asset.name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )
                    ))}
                </div>
            </Modal>

            {/* Custom Asset Edit Modal */}
            <Modal isOpen={!!editingAsset} title="Edit Furniture" onClose={() => setEditingAsset(null)}
                footer={<div className="flex gap-2 w-full"><button onClick={deleteEditingAsset} className="px-4 py-3 bg-red-50 text-red-500 rounded-2xl font-bold text-xs">Delete</button><button onClick={saveEditingAsset} className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-bold text-xs">Save</button></div>}
            >
                {editingAsset && (
                    <div className="space-y-3">
                        <div className="flex gap-3 items-start">
                            <TokenImg value={editImage} className="w-14 h-14 object-contain rounded-lg bg-slate-100 border shrink-0" />
                            <div className="flex-1 space-y-2">
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 block mb-1">Name</label>
                                    <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold focus:outline-blue-500" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 block mb-1">Image URL</label>
                                    {/* Uploaded images are stored as a blobref token / data: URI, and this blob isn't
                                        shown in the URL field (to avoid it looking like a broken link);
                                        leaving it blank keeps the original image, and only a new URL overrides it. */}
                                    <input value={(isBlobRef(editImage) || editImage.startsWith('data:')) ? '' : editImage} onChange={e => setEditImage(e.target.value)} placeholder={(isBlobRef(editImage) || editImage.startsWith('data:')) ? 'Image uploaded (leave blank to keep)' : 'https://...'} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-blue-500" />
                                </div>
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">Description</label>
                            <input value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Item description..." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-blue-500" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">Item Type</label>
                            <div className="flex gap-2">
                                <button onClick={() => setEditItemType('furniture')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editItemType === 'furniture' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Furniture</button>
                                <button onClick={() => setEditItemType('rug')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editItemType === 'rug' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Rug</button>
                            </div>
                            <p className="text-[9px] text-slate-400 mt-1">Changing the type only affects items placed after this -- items already placed are unaffected.</p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">Category</label>
                            <div className="flex gap-2">
                                <button onClick={() => setEditVisibility('public')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editVisibility === 'public' ? 'bg-green-50 border-green-300 text-green-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Public</button>
                                <button onClick={() => setEditVisibility('character')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editVisibility === 'character' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Character exclusive</button>
                            </div>
                        </div>
                        {editVisibility === 'character' && (
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 block mb-1">Assign characters (multi-select)</label>
                                {/* The group filter only affects which options are shown below -- already-checked characters aren't removed by switching groups */}
                                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                                    value={assignGroupId} onChange={setAssignGroupId} className="mb-2" />
                                <div className="flex flex-wrap gap-2">
                                    {filterCharactersByGroup(characters, characterGroups, assignGroupId).map(c => (
                                        <button key={c.id} onClick={() => setEditAssignedCharIds(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${editAssignedCharIds.includes(c.id) ? 'bg-blue-100 border-blue-300 text-blue-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                                {editAssignedCharIds.length === 0 && <p className="text-[9px] text-amber-500 mt-1">Please select at least one character</p>}
                            </div>
                        )}
                    </div>
                )}
            </Modal>

            {/* Custom Item Modal */}
            <Modal isOpen={showCustomModal} title="Custom Furniture" onClose={() => setShowCustomModal(false)} footer={<button onClick={saveCustomItem} className="w-full py-3 bg-purple-500 text-white font-bold rounded-2xl">Add to Room</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div onClick={() => customItemInputRef.current?.click()} className="aspect-square w-24 bg-slate-100 rounded-2xl border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer hover:border-purple-400 relative overflow-hidden shrink-0">
                            {customItemImage ? <TokenImg value={customItemImage} className="w-full h-full object-contain" /> : <span className="text-slate-400 text-xs">+ Upload</span>}
                            <input type="file" ref={customItemInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'custom_item')} />
                        </div>
                        <div className="flex-1 space-y-2">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Image URL (image host recommended)</label>
                                <input value={customItemUrl} onChange={e => setCustomItemUrl(e.target.value)} placeholder="https://..." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-purple-500" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Item Name</label>
                                <input value={customItemName} onChange={e => setCustomItemName(e.target.value)} placeholder="e.g. Bean Bag Chair" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-purple-500 font-bold" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Item Type</label>
                        <div className="flex gap-2">
                            <button onClick={() => setCustomItemType('furniture')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${customItemType === 'furniture' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Furniture</button>
                            <button onClick={() => setCustomItemType('rug')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${customItemType === 'rug' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>Rug</button>
                        </div>
                        <p className="text-[9px] text-slate-400 mt-1">Rugs always stay on the bottom layer -- the character and other furniture will sit on top of it.</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Item Description</label>
                        <input value={customItemDescription} onChange={e => setCustomItemDescription(e.target.value)} placeholder="e.g. A very soft sofa -- you sink right into it." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-purple-500" />
                        <p className="text-[9px] text-slate-400 mt-1">This description tells the AI what it is and how to interact with it.</p>
                    </div>
                </div>
            </Modal>

            {/* Room Settings Modal */}
            <Modal isOpen={showSettingsModal} title="Room Settings" onClose={() => setShowSettingsModal(false)}>
                <div className="space-y-6">
                    <div className="space-y-4">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-2">Background Adjustment</h4>
                        <div>
                            <div className="flex justify-between mb-1"><label className="text-xs font-bold text-slate-600">Wallpaper Scale ({char?.roomConfig?.wallScale || 0}%)</label><span className="text-[10px] text-slate-400">{char?.roomConfig?.wallScale ? `${char.roomConfig.wallScale}%` : 'Cover (Default)'}</span></div>
                            <input type="range" min="0" max="200" step="10" value={char?.roomConfig?.wallScale || 0} onChange={e => updateBgConfig({ wallScale: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                            <div className="flex items-center gap-2 mt-2">
                                <input type="checkbox" id="wallRepeat" checked={char?.roomConfig?.wallRepeat || false} onChange={e => updateBgConfig({ wallRepeat: e.target.checked })} className="accent-blue-500" />
                                <label htmlFor="wallRepeat" className="text-xs text-slate-600">Tile Mode (Tile)</label>
                            </div>
                        </div>
                        <div>
                            <div className="flex justify-between mb-1"><label className="text-xs font-bold text-slate-600">Floor Scale ({char?.roomConfig?.floorScale || 0}%)</label><span className="text-[10px] text-slate-400">{char?.roomConfig?.floorScale ? `${char.roomConfig.floorScale}%` : 'Cover (Default)'}</span></div>
                            <input type="range" min="0" max="200" step="10" value={char?.roomConfig?.floorScale || 0} onChange={e => updateBgConfig({ floorScale: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                            <div className="flex items-center gap-2 mt-2">
                                <input type="checkbox" id="floorRepeat" checked={char?.roomConfig?.floorRepeat || false} onChange={e => updateBgConfig({ floorRepeat: e.target.checked })} className="accent-blue-500" />
                                <label htmlFor="floorRepeat" className="text-xs text-slate-600">Tile Mode (Tile)</label>
                            </div>
                        </div>
                    </div>

                    {isSully && (
                        <div className="pt-4 border-t border-slate-100">
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Sully-exclusive Maintenance</h4>
                            <button onClick={resetSullyRoom} className="w-full py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 flex items-center justify-center gap-2 active:scale-95 transition-transform">
                                <img src={twemojiUrl('1f9f9')} alt="broom" className="w-5 h-5" /> Restore Original Room Template
                            </button>
                            <p className="text-[9px] text-slate-400 mt-2 text-center">If you accidentally messed up the room, tap here to restore the default layout in one tap.</p>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Refresh Confirmation Modal */}
            <Modal isOpen={showRefreshConfirm} title="Force Refresh?" onClose={() => setShowRefreshConfirm(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => setShowRefreshConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">Cancel</button><button onClick={handleForceRefresh} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">Leave Me Alone!</button></div>}>
                <div className="text-center py-4 space-y-2">
                    <div><img src={twemojiUrl('1f570-fe0f')} alt="clock" className="w-10 h-10 mx-auto" /></div>
                    <p className="text-sm text-slate-600 font-bold">Refreshes automatically every day at 6:00 AM</p>
                    <p className="text-xs text-slate-400">It's not time yet -- are you sure you want to spend compute to force-regenerate today's room state?</p>
                </div>
            </Modal>

            {/* Export Room Template Modal (exports the current room as a room template) */}
            <Modal
                isOpen={showExportModal}
                title="Export Current Room"
                onClose={() => !isExporting && setShowExportModal(false)}
                footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => handleExportRoom('copy')} disabled={isExporting} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-xs disabled:opacity-50">Copy JSON</button>
                        <button onClick={() => handleExportRoom('download')} disabled={isExporting} className="flex-1 py-3 bg-emerald-500 text-white font-bold rounded-2xl text-xs disabled:opacity-50">{isExporting ? 'Packaging...' : 'Download File'}</button>
                    </div>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Room Name</label>
                        <input value={exportName} onChange={e => setExportName(e.target.value)} placeholder={`${char?.name || ''}'s Room`} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold focus:outline-emerald-500" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Room Description</label>
                        <textarea value={exportDescription} onChange={e => setExportDescription(e.target.value)} rows={3} placeholder="Describe this room template: style, highlights, who it suits…" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-emerald-500 resize-none" />
                    </div>
                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5 text-[10px] text-emerald-700 leading-relaxed">
                        Export includes: name, description, wall/floor configuration, and the image plus relative position for each of {items.length} items (x/y are room-relative percentage coordinates, so any screen size can restore it identically).
                        <br />Image-host links are kept as-is; locally uploaded images are converted to base64 and embedded in the JSON, so the file is self-contained and can be shared directly.
                    </div>
                </div>
            </Modal>

            {/* Import Room Template Modal (import a room template: replace or merge) */}
            <Modal
                isOpen={!!pendingImport}
                title="Import Room Template"
                onClose={() => !isImportingRoom && setPendingImport(null)}
                footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => applyRoomImport('merge')} disabled={isImportingRoom} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-xs disabled:opacity-50">Merge into current room</button>
                        <button onClick={() => applyRoomImport('replace')} disabled={isImportingRoom} className="flex-1 py-3 bg-sky-500 text-white font-bold rounded-2xl text-xs disabled:opacity-50">{isImportingRoom ? 'Importing...' : 'Replace current room'}</button>
                    </div>
                }
            >
                {pendingImport && (
                    <div className="space-y-3">
                        <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
                            <p className="text-sm font-bold text-slate-700">{typeof pendingImport.name === 'string' && pendingImport.name ? pendingImport.name : 'Unnamed Room'}</p>
                            {typeof pendingImport.description === 'string' && pendingImport.description && (
                                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{pendingImport.description}</p>
                            )}
                            <p className="text-[10px] text-slate-400 mt-1.5">{pendingImport.items.length} items in total{pendingImport.room?.wallImage || pendingImport.room?.floorImage ? ' · includes wall/floor' : ''}</p>
                        </div>
                        <div className="bg-sky-50 border border-sky-100 rounded-xl px-3 py-2.5 text-[10px] text-sky-700 leading-relaxed">
                            <b>Replace</b>: clears the existing furniture and restores it exactly as the room template (including wall/floor).
                            <br /><b>Merge</b>: keeps the existing layout and appends the room template's items (leaves the background untouched).
                            <br />Item changes can be undone with "Undo" in the top-left corner of edit mode.
                        </div>
                    </div>
                )}
            </Modal>

            {/* Dev Export Modal */}
            <Modal
                isOpen={showDevModal}
                title="Dev Tools"
                onClose={() => setShowDevModal(false)}
                footer={<button onClick={() => setShowDevModal(false)} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Close</button>}
            >
                <div className="space-y-4">
                    <div>
                        <h4 className="text-[10px] font-bold text-slate-400 uppercase mb-2">Layout Data (Layout JSON)</h4>
                        <div className="bg-slate-100 rounded-xl p-3 border border-slate-200 mb-2">
                            <pre className="text-[10px] text-slate-600 font-mono h-20 overflow-y-auto whitespace-pre-wrap select-all">
                                {JSON.stringify(items, null, 2)}
                            </pre>
                        </div>
                        <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(items, null, 2)); addToast('Layout Copied', 'success'); }} className="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-xl">Copy Layout JSON</button>
                    </div>

                    <div>
                        <h4 className="text-[10px] font-bold text-red-400 uppercase mb-2">Prompt Debugger</h4>
                        <div className="bg-slate-100 rounded-xl p-3 border border-slate-200 mb-2">
                            <pre className="text-[10px] text-slate-600 font-mono h-20 overflow-y-auto whitespace-pre-wrap select-all">
                                {lastPrompt || "(No data yet -- try entering the room first)"}
                            </pre>
                        </div>
                        <button onClick={() => { if(lastPrompt) { navigator.clipboard.writeText(lastPrompt); addToast('Prompt Copied', 'success'); } else addToast('No prompt yet', 'error'); }} className="w-full py-2 bg-red-500 text-white text-xs font-bold rounded-xl">Copy Prompt to Clipboard</button>
                        <p className="text-[9px] text-slate-400 mt-2 text-center">If the AI's reply comes back empty, copy this prompt and check for garbled text/Base64 leaking into it.</p>
                    </div>
                </div>
            </Modal>

        </div>
    );
};

export default RoomApp;
