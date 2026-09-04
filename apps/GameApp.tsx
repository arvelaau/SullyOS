
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { GameSession, GameTheme, CharacterProfile, GameLog, GameActionOption, GameSummary } from '../types';
import { ContextBuilder } from '../utils/context';
import { extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { trackEvent } from '../utils/analytics';
import Modal from '../components/os/Modal';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { Planet, RocketLaunch, Lightning, LockSimple, DiceFive, Toolbox, FloppyDisk, ArrowsClockwise, DoorOpen } from '@phosphor-icons/react';
import TokenImg from '../components/os/TokenImg';

// --- Themes Configuration (Enhanced) ---
const GAME_THEMES: Record<GameTheme, { bg: string, text: string, accent: string, font: string, border: string, cardBg: string, gradient: string, optionNormal: string, optionChaotic: string, optionEvil: string }> = {
    fantasy: {
        bg: 'bg-[#1a120b]',
        text: 'text-[#e5e5e5]',
        accent: 'text-[#fbbf24]',
        font: 'font-serif',
        border: 'border-[#78350f]',
        cardBg: 'bg-[#2a2018]',
        gradient: 'from-[#451a03] to-[#1a120b]',
        optionNormal: 'bg-[#451a03] border-[#78350f] text-[#fbbf24]',
        optionChaotic: 'bg-[#78350f] border-[#b45309] text-[#fcd34d]',
        optionEvil: 'bg-[#3f0f0f] border-[#7f1d1d] text-[#fca5a5]'
    },
    cyber: {
        bg: 'bg-[#020617]',
        text: 'text-[#94a3b8]',
        accent: 'text-[#22d3ee]',
        font: 'font-mono',
        border: 'border-[#1e293b]',
        cardBg: 'bg-[#0f172a]/80',
        gradient: 'from-[#0f172a] to-[#020617]',
        optionNormal: 'bg-[#0f172a] border-[#1e293b] text-[#22d3ee]',
        optionChaotic: 'bg-[#1e1b4b] border-[#4338ca] text-[#a78bfa]',
        optionEvil: 'bg-[#450a0a] border-[#7f1d1d] text-[#fca5a5]'
    },
    horror: {
        bg: 'bg-[#0f0000]',
        text: 'text-[#d4d4d8]',
        accent: 'text-[#ef4444]',
        font: 'font-serif',
        border: 'border-[#450a0a]',
        cardBg: 'bg-[#2b0e0e]',
        gradient: 'from-[#450a0a] to-[#000000]',
        optionNormal: 'bg-[#2b0e0e] border-[#450a0a] text-[#d4d4d8]',
        optionChaotic: 'bg-[#3f1d1d] border-[#7f1d1d] text-[#fda4af]',
        optionEvil: 'bg-[#450a0a] border-[#991b1b] text-[#ef4444]'
    },
    modern: {
        bg: 'bg-slate-50',
        text: 'text-slate-700',
        accent: 'text-blue-600',
        font: 'font-sans',
        border: 'border-slate-200',
        cardBg: 'bg-white',
        gradient: 'from-slate-100 to-white',
        optionNormal: 'bg-white border-slate-200 text-slate-600',
        optionChaotic: 'bg-yellow-50 border-yellow-200 text-yellow-700',
        optionEvil: 'bg-red-50 border-red-200 text-red-700'
    }
};

// Trigger an auto-summary every time this many "unarchived logs" accumulate
const AUTO_SUMMARY_THRESHOLD = 20;
// After an auto-summary, keep this many recent logs unfolded, so reading stays coherent with the story
const KEEP_RECENT_AFTER_SUMMARY = 4;
// Selectable styles for AI world-setting generation
const WORLD_STYLES = ['High Fantasy', 'Cyberpunk', 'Cosmic Horror', 'Wuxia', 'Post-Apocalyptic Wasteland', 'Slice-of-Life School', 'Mystery', 'Steampunk', 'Western Frontier', 'Court Intrigue'];

// Robustly parses the AI world-setting generation result.
// Handles three cases: (1) the expected "Title: xxx === body" delimiter format; (2) the model
// disobeying and still spitting out JSON (possibly truncated/malformed); (3) fully unstructured
// plain text. In every case, no raw markup leaks through to the user.
const parseWorldGen = (raw: string): { title: string; worldSetting: string } => {
    let text = raw.trim();
    // Strip any code-fence wrapper
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

    let title = '';
    let worldSetting = '';

    // Case (2): looks like JSON (even if truncated) — pick fields out via regex, don't rely on JSON.parse
    if (/"?worldSetting"?\s*:/.test(text) || /^\s*\{/.test(text)) {
        const tMatch = text.match(/"?title"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
        // worldSetting may be unterminated (truncated), so allow matching to the end of the string.
        // Fallback on failure: slice everything after `worldSetting": "` and strip any trailing closing punctuation.
        const wMatch = text.match(/"?worldSetting"?\s*:\s*"((?:[^"\\]|\\.)*?)(?:"\s*[},]|"\s*$|$)/);
        if (tMatch) title = tMatch[1];
        if (wMatch) {
            worldSetting = wMatch[1];
        } else {
            // Extreme edge case (e.g. a trailing stray backslash makes the whole wMatch null):
            // brute-force slice everything after `worldSetting": "` as the raw text, to avoid the
            // regression where title is picked up but the body comes back empty.
            const tailIdx = text.search(/"?worldSetting"?\s*:\s*"/);
            if (tailIdx >= 0) {
                worldSetting = text.slice(tailIdx).replace(/^"?worldSetting"?\s*:\s*"/, '').replace(/\\?"?\s*\}?\s*$/, '');
            }
        }
        // Unescape characters in a single pass, so `\\n` (an escaped backslash followed by a literal
        // "n") doesn't get mistakenly turned into `\` + newline by an earlier replace. `\\uXXXX` gets decoded too.
        const unescape = (s: string) => s
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\(["\\nt])/g, (_, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
        title = unescape(title);
        worldSetting = unescape(worldSetting);
        // Only return early once worldSetting was actually extracted — otherwise fall through to the
        // plain-text parser below, to avoid returning a half-empty result when only title was found.
        if (worldSetting) return { title: title.trim(), worldSetting: worldSetting.trim() };
    }

    // Case (1): delimiter format
    const titleMatch = text.match(/^\s*(?:标题|title)\s*[:：]\s*(.+)$/im);
    if (titleMatch) {
        title = titleMatch[1].trim().replace(/^[《"']|[》"']$/g, '');
        text = text.replace(titleMatch[0], '').trim();
    }
    // Strip the separator line and any leftover "World Setting/Lore" label
    text = text.replace(/^\s*[=\-—]{2,}\s*$/m, '').trim();
    text = text.replace(/^\s*(?:世界观设定|世界观|正文|lore)\s*[:：]?\s*/i, '').trim();

    worldSetting = text;
    return { title: title.trim(), worldSetting: worldSetting.trim() };
};

// Roll a single D20
const rollD20 = () => Math.floor(Math.random() * 20) + 1;
// Translate a die roll into a success-degree description, for the GM's ruling
const rollFlavor = (n: number) => {
    if (n === 20) return 'Critical Success';
    if (n === 1) return 'Critical Failure';
    if (n >= 15) return 'Success';
    if (n >= 8) return 'Partial';
    return 'Failure';
};

// --- Markdown Renderer Component ---
const GameMarkdown: React.FC<{ content: string, theme: any, customStyle?: { fontSize: number, color: string } }> = ({ content, theme, customStyle }) => {
    // Helper: Parse Inline Styles (**bold**, *italic*, `code`)
    const parseInline = (text: string) => {
        const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
        return parts.map((part, i) => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={i} className={`font-bold ${theme.accent}`}>{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return <em key={i} className="italic opacity-70 text-[95%] mx-0.5">{part.slice(1, -1)}</em>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return <code key={i} className="bg-black/20 px-1 py-0.5 rounded font-mono text-[0.9em] opacity-90 mx-0.5">{part.slice(1, -1)}</code>;
            }
            return <span key={i}>{part}</span>;
        });
    };

    // Split by newlines to handle blocks
    const lines = content.split('\n');
    
    // Dynamic Style Object
    const styleObj = {
        fontSize: customStyle ? `${customStyle.fontSize}px` : undefined,
        color: customStyle?.color || undefined
    };

    return (
        <div className="space-y-[0.5em] text-justify leading-relaxed" style={styleObj}>
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-[0.5em]"></div>;
                
                // Headers (Relative sizing)
                if (trimmed.startsWith('### ')) return <h3 key={i} className={`text-[1.1em] font-bold uppercase tracking-wider mt-[0.5em] mb-[0.2em] opacity-90 ${theme.accent}`}>{trimmed.slice(4)}</h3>;
                if (trimmed.startsWith('## ')) return <h3 key={i} className="text-[1.25em] font-bold mt-[0.6em] mb-[0.3em] opacity-95">{trimmed.slice(3)}</h3>;
                if (trimmed.startsWith('# ')) return <h3 key={i} className="text-[1.5em] font-black mt-[0.8em] mb-[0.5em] text-center border-b border-current pb-2 opacity-90">{trimmed.slice(2)}</h3>;
                
                // Blockquotes
                if (trimmed.startsWith('> ')) return <div key={i} className="border-l-2 border-current pl-3 py-1 my-2 italic opacity-70 text-[0.9em] bg-black/5 rounded-r">{parseInline(trimmed.slice(2))}</div>;
                
                // Lists
                if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`opacity-50 ${theme.accent}`}>•</span><span>{parseInline(trimmed.slice(2))}</span></div>;
                }

                // Numbered list
                const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                if (numMatch) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`font-mono opacity-60 ${theme.accent}`}>{numMatch[1]}.</span><span>{parseInline(numMatch[2])}</span></div>;
                }

                // Separator
                if (trimmed === '---' || trimmed === '***') {
                    return <div key={i} className="h-px bg-current opacity-20 my-[1em]"></div>;
                }

                // Standard Paragraph
                return <div key={i}>{parseInline(trimmed)}</div>;
            })}
        </div>
    );
};

const GameApp: React.FC = () => {
    const { closeApp, characters, userProfile, apiConfig, addToast, updateCharacter, characterGroups } = useOS();
    const [view, setView] = useState<'lobby' | 'create' | 'play'>('lobby');
    const [games, setGames] = useState<GameSession[]>([]);
    const [activeGame, setActiveGame] = useState<GameSession | null>(null);
    const [lobbyPage, setLobbyPage] = useState(0); // Save-lobby pagination (5 per page)

    // Creation State
    const [newTitle, setNewTitle] = useState('');
    const [newWorld, setNewWorld] = useState('');
    const [newTheme, setNewTheme] = useState<GameTheme>('fantasy');
    const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
    const [playerGroupId, setPlayerGroupId] = useState(GROUP_FILTER_ALL); // Group filter for inviting teammates
    const [isCreating, setIsCreating] = useState(false);
    // AI-assisted world-setting generation
    const [worldStyle, setWorldStyle] = useState<string>('High Fantasy');
    const [worldIdea, setWorldIdea] = useState('');        // Extra inspiration/idea from the user (optional)
    const [isGeneratingWorld, setIsGeneratingWorld] = useState(false);
    // New-game gameplay settings
    const [newDiceDisabled, setNewDiceDisabled] = useState(false);            // Disable dice (defaults to automatic success every time)
    const [newArchiveMode, setNewArchiveMode] = useState<'auto' | 'manual'>('auto');
    const [showArchiveHelp, setShowArchiveHelp] = useState(false);            // "?" explainer for archive mode

    // Play State
    const [userInput, setUserInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [isSummarizing, setIsSummarizing] = useState(false); // Full-screen feedback during auto-summary
    const [showArchived, setShowArchived] = useState(false);    // Whether archived story is expanded/collapsed
    const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set()); // Expanded-state per summary's original text
    // Long-press multi-select → forward to chat
    const [selectMode, setSelectMode] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
    const [isForwarding, setIsForwarding] = useState(false);
    const [lastRoll, setLastRoll] = useState<number | null>(null); // Most recent auto-roll result (shown briefly)
    const [lastTokenUsage, setLastTokenUsage] = useState<{prompt?: number, completion?: number, total: number} | null>(null);
    const [totalTokensUsed, setTotalTokensUsed] = useState(0);
    
    // [FIX] Use Container Ref instead of Element Ref for safer scrolling
    const logsContainerRef = useRef<HTMLDivElement>(null);

    // Long-press a save card to delete it
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressFired = useRef(false);
    // Long-press a log entry to enter multi-select
    const logPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // UI Toggles
    const [showSystemMenu, setShowSystemMenu] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [isArchiving, setIsArchiving] = useState(false);
    const [showTools, setShowTools] = useState(false); // Default hidden
    const [showParty, setShowParty] = useState(true);  // Default visible
    const [uiSettings, setUiSettings] = useState<{fontSize: number, color: string}>({ fontSize: 14, color: '' });

    // SAN Lock: Sync from activeGame on load
    const [sanityLocked, setSanityLocked] = useState(false);
    useEffect(() => {
        if (activeGame) setSanityLocked(!!activeGame.sanityLocked);
    }, [activeGame?.id]);

    useEffect(() => {
        loadGames();
    }, []);

    // Clamp the page number to a valid range after saves are deleted/added
    const LOBBY_PAGE_SIZE = 5;
    useEffect(() => {
        const maxPage = Math.max(0, Math.ceil(games.length / LOBBY_PAGE_SIZE) - 1);
        if (lobbyPage > maxPage) setLobbyPage(maxPage);
    }, [games.length, lobbyPage]);

    // [FIX] Updated Auto-scroll logic: Use scrollTop on container
    useEffect(() => {
        if (view === 'play' && logsContainerRef.current) {
            // Use setTimeout to ensure render is complete, allowing smooth scroll to new bottom
            setTimeout(() => {
                if (logsContainerRef.current) {
                    logsContainerRef.current.scrollTo({
                        top: logsContainerRef.current.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            }, 100);
        }
    }, [activeGame?.logs, view, isTyping]);

    const loadGames = async () => {
        const list = await DB.getAllGames();
        setGames(list.sort((a,b) => b.lastPlayedAt - a.lastPlayedAt));
    };

    // --- Helper: Robust API Call ---
    const fetchGameAPI = async (prompt: string, maxTokens: number = 8000) => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.9, 
                max_tokens: maxTokens,
                stream: false
            })
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        const text = await response.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            // Try stripping "data: " prefix (common in proxy misconfigurations)
            const cleaned = text.replace(/^data: /, '').trim();
            try {
                json = JSON.parse(cleaned);
            } catch {
                // Detect HTML responses
                if (text.trimStart().startsWith('<')) {
                    throw new Error('The API returned HTML instead of JSON — please check that the API address is correct');
                }
                throw new Error(`The API returned an unparseable format: ${text.slice(0, 100)}`);
            }
        }

        if (json.usage?.total_tokens) {
            const usage = {
                prompt: json.usage.prompt_tokens || undefined,
                completion: json.usage.completion_tokens || undefined,
                total: json.usage.total_tokens
            };
            setLastTokenUsage(usage);
            setTotalTokensUsed(prev => prev + json.usage.total_tokens);
        }

        return json;
    };

    // --- Helper: Build Synchronized Context (Neural Link) ---
    const buildSyncContext = async (players: CharacterProfile[]) => {
        let fullContext = "";

        // [Optimization] When multiple characters share a scene, pull the "user profile / shared
        // worldview / worldbook attached to multiple characters" out to the top and lay it down
        // once, instead of repeating the same worldbook inside every character block (dedupes,
        // saves tokens, and also guards against cross-talk).
        const sharedScene = ContextBuilder.buildGroupSharedScene(players, userProfile);
        if (sharedScene.text) {
            fullContext += `${sharedScene.text}\n`;
        }

        for (const p of players) {
            // 1. Base Context (Identity & Worldview)
            // [Optimization] Memory retrieval: with multiple characters sharing a TRPG session, we no
            //   longer dump each character's day-by-day detailed diary (that makes it very easy for the
            //   LLM to pin A's memory onto B = cross-talk). Switched to includeDetailedMemories=false
            //   (long-term core memory only) + the on-demand Memory Palace vector recall injected below
            //   (only pulls the fragments relevant to the current situation). Also skips the user
            //   profile / worldbook / worldview already laid down in the shared scene, for full dedup.
            await injectMemoryPalace(p);
            const core = ContextBuilder.buildCoreContext(p, userProfile, false, undefined, {
                skipUserProfile: true,
                skipWorldview: sharedScene.worldviewIsShared,
                skipWorldbookIds: sharedScene.sharedWorldbookIds,
            });
            fullContext += `\n<<< Character Sheet: ${p.name} (ID: ${p.id}) >>>\n${core}\n`;

            // Memory Palace recall (buildCoreContext doesn't auto-include this when
            // includeDetailedMemories=false, so it's added back in on demand here)
            // [Anti-cross-talk] The recall text's own heading is the generic "a memory surfaces in your
            //   mind...", which gets ambiguous once multiple characters share a scene ("your" whose?).
            //   So it's explicitly attributed and locked to the current character's name here, with a
            //   reminder to the LLM that it must never be repurposed for anyone else.
            if (p.memoryPalaceEnabled && p.memoryPalaceInjection && p.memoryPalaceInjection.trim()) {
                fullContext += `\n[Note: the following Memory Palace recall belongs ONLY to ${p.name} — it is their private memory alone, and must never be treated as another character's experience or repurposed for anyone else]\n`;
                fullContext += `${p.memoryPalaceInjection}\n`;
                fullContext += `[End of ${p.name}'s private memory]\n`;
            }

            // 2. Neural Link: Private Chat Sync
            try {
                const msgs = await DB.getMessagesByCharId(p.id, true);
                const privateMsgs = msgs.filter(m => !m.groupId); // Only private chats (Neural Link needs full history)

                const lastMsg = privateMsgs[privateMsgs.length - 1];
                const now = Date.now();
                let status = "Normal";
                let gapDesc = "Unknown";

                if (lastMsg) {
                    const diffMins = (now - lastMsg.timestamp) / 1000 / 60;
                    if (diffMins < 60) {
                        gapDesc = `Just now (${Math.floor(diffMins)} min ago)`;
                        status = "Close/Familiar (Hot)";
                    } else if (diffMins < 24 * 60) {
                        gapDesc = `Today (${Math.floor(diffMins/60)} hr ago)`;
                        status = "Normal";
                    } else {
                        const days = Math.floor(diffMins / (24 * 60));
                        gapDesc = `${days} day(s) ago`;
                        status = "Distant (Cold)";
                    }

                    // Get last 8 messages for context
                    const recentLog = privateMsgs.slice(-8).map(m =>
                        `[${m.role === 'user' ? 'Me' : p.name}]: ${m.content.substring(0, 40).replace(/\n/g, ' ')}`
                    ).join('\n');

                    fullContext += `
=== Neural Link: Private Chat Memory Sync ===
This character's [private chat status] with the player: ${gapDesc}
Relationship warmth: ${status}
Recent private chat topics (background memory — don't quote it verbatim, but let it color your attitude):
${recentLog}

[GM Mandatory Directive (Meta Instruction)]:
1. **Break the fourth wall**: the character may show awareness of "currently playing a game together with the user."
2. **Relationship carries over**:
   - If the status is "Hot", be more in sync during the session — feel free to tease "that's not what you said when we were chatting earlier."
   - If the status is "Cold", it's fine to act distant, standoffish, or grumble "haven't talked in a while, why am I suddenly dragged into an adventure?"
   - It is **absolutely forbidden** to treat the player like a stranger. You are old acquaintances.
=====================================\n`;
                } else {
                    fullContext += `[Neural Link: no private chat history] (treat as a first meeting)\n`;
                }
            } catch (e) {
                console.error("Sync failed for", p.name, e);
            }
            fullContext += `<<< End of Character Sheet >>>\n`;
        }
        return fullContext;
    };

    // --- AI World-Setting Generation (gives a starting point to players who can't think of a scenario) ---
    const handleGenerateWorld = async () => {
        if (!apiConfig.apiKey) {
            addToast('Please configure an API Key first', 'error');
            return;
        }
        setIsGeneratingWorld(true);
        // Only report the fixed styles on the whitelist; the user's free-text inspiration is never sent
        trackEvent('Generate World Setting with AI', { style: WORLD_STYLES.includes(worldStyle) ? worldStyle : 'Other' });
        try {
            // [Robustness] Uses a delimiter-based plain-text format instead of JSON — parses cleanly
            // even if truncated. No word-count cap either, to give it enough tokens to avoid getting cut off.
            const prompt = `You are a seasoned TRPG (tabletop role-playing game) scenario designer. Please create an original world setting suited to running a session, in the given style.
**Style/tone**: ${worldStyle}
${worldIdea.trim() ? `**The player's inspiration/idea (please build around it)**: ${worldIdea.trim()}` : ''}

Please output strictly in the following plain-text format — **no JSON, no code blocks, no extra commentary**:

Title: <a compelling scenario title>
===
<World setting body. Please write it richly and vividly, with no length cap, covering: the era/location backdrop and overall tone, the current world's core conflict or crisis, the player party's situation and initial goal hook, one or two exploreable mysteries or factions. Leave plenty of room for player agency — don't lock in a fixed ending.>`;

            const data = await fetchGameAPI(prompt, 6000);
            const raw = (extractContent(data) || '').trim();
            if (!raw) throw new Error('The AI returned an empty response');

            const parsed = parseWorldGen(raw);
            if (parsed.worldSetting) setNewWorld(parsed.worldSetting);
            if (parsed.title && !newTitle.trim()) setNewTitle(parsed.title);
            addToast('World setting generated — feel free to keep editing', 'success');
        } catch (e: any) {
            addToast(`Generation failed: ${e.message}`, 'error');
        } finally {
            setIsGeneratingWorld(false);
        }
    };

    // --- Creation Logic ---
    const handleCreateGame = async () => {
        if (!newTitle.trim() || !newWorld.trim() || selectedPlayers.size === 0) {
            addToast('Please fill in all fields and select at least one character', 'error');
            return;
        }

        if (!apiConfig.apiKey) {
            addToast('Please configure an API Key first to generate the prologue', 'error');
            return;
        }

        setIsCreating(true);

        try {
            const tempId = `game-${Date.now()}`;
            const players = characters.filter(c => selectedPlayers.has(c.id));
            
            // Build Context with Sync
            const playerContext = await buildSyncContext(players);

            // Generate Prologue Prompt
            const prompt = `### TRPG Prologue Generation (Game Start)
**Scenario Title**: ${newTitle}
**World Setting**: ${newWorld}
**Player**: ${userProfile.name}
**Teammates**: ${players.map(p => p.name).join(', ')}

### Character Data (includes private chat memory)
${playerContext}

### Task
You are now the **Game Master (GM)**. Please generate a **compelling opening (Prologue)** for this adventure story.
1. **Story Description**: describe what's happening in this world right now, the party's surroundings, and the events closing in. **World first, characters second** — the opening shouldn't revolve around the player; lay out the stage and the looming crisis instead.
2. **Character Reactions**: briefly describe each teammate's initial state or first line of dialogue. You **must** reference the private-chat status in [Neural Link] to decide their attitude; also let each character show off **their own personality and agenda**, rather than immediately fawning over the player.
3. **Initial Options**: give three action options the player can take${newDiceDisabled ? " (dice aren't enabled this session, so the player's action defaults to succeeding smoothly — options can go in any interesting direction)" : ' (each option automatically rolls a D20 check when the player takes it, so options should be "attempts with a real chance of success or failure", not guaranteed-success actions)'}.

### Consistency Check
Before outputting, mentally verify: does each character's dialogue/behavior come **only** from their own "character sheet" (personality, memories, impressions)? It is strictly forbidden to pin one character's memory, verbal tic, or persona onto another character (prevents "cross-talk").

### Output Format (Strict JSON)
{
  "gm_narrative": "Prologue story description...",
  "characters": [
    { "charId": "character ID", "action": "initial action", "dialogue": "first line of dialogue" }
  ],
  "startLocation": "starting location name",
  "suggested_actions": [
    { "label": "Option 1 (neutral/upright/advances the story)", "type": "neutral" },
    { "label": "Option 2 (troll/goofy/unexpected)", "type": "chaotic" },
    { "label": "Option 3 (evil/aggressive/greedy)", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('The AI returned an empty response');

            // Robust JSON extraction: handles code fences, trailing commas, extra prose
            const res = extractJson(rawContent);

            const initialLogs: GameLog[] = [];

            if (res) {
                // Structured response - use parsed JSON
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### Prologue · ${newTitle}\n\n${res.gm_narrative || 'The adventure begins...'}`,
                    timestamp: Date.now()
                });

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            initialLogs.push({
                                id: `init-char-${char.id}`,
                                role: 'character',
                                speakerName: char.name,
                                content: `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`,
                                timestamp: Date.now()
                            });
                        }
                    }
                }
            } else {
                // JSON parse completely failed - use raw text as GM narrative anyway
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### Prologue · ${newTitle}\n\n${rawContent}`,
                    timestamp: Date.now()
                });
            }

            const newGame: GameSession = {
                id: tempId,
                title: newTitle,
                theme: newTheme,
                worldSetting: newWorld,
                playerCharIds: Array.from(selectedPlayers),
                logs: initialLogs,
                status: {
                    location: res?.startLocation || 'Unknown',
                    health: 100,
                    sanity: 100,
                    gold: 0,
                    inventory: []
                },
                suggestedActions: res?.suggested_actions || [],
                diceDisabled: newDiceDisabled,
                archiveMode: newArchiveMode,
                createdAt: Date.now(),
                lastPlayedAt: Date.now()
            };

            await DB.saveGame(newGame);
            setGames(prev => [newGame, ...prev]);
            setActiveGame(newGame);
            setView('play');
            trackEvent('Create Adventure Session', {
                theme: newTheme,
                dice: newDiceDisabled ? 'Off' : 'On',
                archiveMode: newArchiveMode,
            });

            // Reset form
            setNewTitle('');
            setNewWorld('');
            setWorldIdea('');
            setNewDiceDisabled(false);
            setNewArchiveMode('auto');
            setSelectedPlayers(new Set());

        } catch (e: any) {
            addToast(`Creation failed: ${e.message}`, 'error');
        } finally {
            setIsCreating(false);
        }
    };

    // --- SAN Lock Toggle ---
    const toggleSanityLock = async () => {
        const newVal = !sanityLocked;
        setSanityLocked(newVal);
        if (activeGame) {
            const updated = { ...activeGame, sanityLocked: newVal };
            setActiveGame(updated);
            await DB.saveGame(updated);
            addToast(newVal ? 'SAN is now locked' : 'SAN is now unlocked', 'info');
        }
        trackEvent('Toggle SAN Lock', { state: newVal ? 'Locked' : 'Unlocked' });
    };

    // --- Dice Toggle (once disabled, actions no longer auto-roll a D20) ---
    const toggleDice = async () => {
        if (!activeGame) return;
        const newDisabled = !activeGame.diceDisabled;
        const updated = { ...activeGame, diceDisabled: newDisabled };
        setActiveGame(updated);
        await DB.saveGame(updated);
        addToast(newDisabled ? 'Dice disabled — actions no longer roll' : 'Dice enabled', 'info');
        trackEvent('Toggle Dice Rolls', { state: newDisabled ? 'Off' : 'On' });
    };

    // --- Gameplay Logic ---
    const handleAction = async (actionText: string, isReroll: boolean = false) => {
        if (!activeGame || !apiConfig.apiKey) return;

        let contextLogs = activeGame.logs;
        let updatedGame = activeGame;
        let currentRoll: number | null = null;

        if (!isReroll) {
            const isSystemAction = actionText.startsWith('[System');
            // [Optimization] Every player action now auto-rolls a D20 by default (no longer requires
            // manually tapping a dice button). System messages don't roll; neither does anything when
            // the user has disabled dice in settings.
            if (!isSystemAction && actionText.trim() && !activeGame.diceDisabled) {
                currentRoll = rollD20();
                setLastRoll(currentRoll);
                addToast(`D20 = ${currentRoll} · ${rollFlavor(currentRoll)}`, 'info');
            }

            // Standard Action: Append user log
            const userLog: GameLog = {
                id: `log-${Date.now()}`,
                role: isSystemAction ? 'system' : 'player',
                speakerName: userProfile.name,
                content: actionText,
                timestamp: Date.now(),
                diceRoll: currentRoll ? { result: currentRoll, max: 20 } : undefined
            };

            const updatedLogs = [...activeGame.logs, userLog];
            updatedGame = { ...activeGame, logs: updatedLogs, lastPlayedAt: Date.now(), suggestedActions: [] }; // Clear options while thinking
            setActiveGame(updatedGame);
            await DB.saveGame(updatedGame);
            contextLogs = updatedLogs;
        }

        setUserInput('');
        setIsTyping(true);
        setLastTokenUsage(null);
        addToast('The GM is deliberating...', 'info'); // Feedback for Sync

        try {
            // 2. Build Context WITH RELATIONSHIP SYNC
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerContext = await buildSyncContext(players);

            // 3. Build Status Warning
            let statusWarning = "";
            if (activeGame.status.health <= 30) statusWarning += "\n[WARNING: LOW HP] The player is near death — please describe extreme weakness, pain, blurred vision, or a near-death experience.\n";
            if (activeGame.status.sanity <= 30) statusWarning += "\n[WARNING: LOW SAN] The player's sanity is breaking down — please describe madness, auditory/visual hallucinations, or indescribable dread.\n";

            let gameOverTrigger = "";
            if (activeGame.status.health <= 0 || activeGame.status.sanity <= 0) {
                gameOverTrigger = "\n[GAME OVER TRIGGER] The player's HP or SAN has hit zero. Please generate a tragic or mad ending (Bad Ending) and conclude this adventure.\n";
            }

            // [Optimization] History: old archived story is replaced with its "Story So Far" summary,
            //   unarchived logs keep the raw text, and each player action's dice-roll result is fed to
            //   the GM for ruling too (previously the GM couldn't see the roll at all).
            const serializeLog = (l: GameLog) => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                const dice = l.diceRoll ? ` 〔D20=${l.diceRoll.result}/${rollFlavor(l.diceRoll.result)}〕` : '';
                return `[${who}]${dice}: ${l.content}`;
            };
            const summaries = activeGame.summaries || [];
            const recapBlock = summaries.length > 0
                ? `### Story So Far\n${summaries.map((s, i) => `[Part ${i + 1}] ${s.content}`).join('\n\n')}\n\n`
                : '';
            const activeLogText = contextLogs.filter(l => !l.archived).map(serializeLog).join('\n');

            // Ruling hint for this action: with dice on, rule by the D20; with dice off, default to success
            const rollInstruction = currentRoll
                ? `\n### This Turn's Ruling\nThe player's action this turn rolled **D20 = ${currentRoll} (${rollFlavor(currentRoll)})**. Please rule the success/failure and cost of the action accordingly: 20 = an unexpected critical success, 1 = a disastrous critical failure, high rolls go smoothly, low rolls meet setbacks. Let the result flow naturally into the narrative — don't just restate the number.\n`
                : (activeGame.diceDisabled
                    ? `\n### Ruling Mode\nDice are not enabled for this adventure — the player's action defaults to succeeding smoothly (unless clearly impossible given the story logic). Please move the story forward positively and don't interrupt the pacing with random failure.\n`
                    : '');

            const prompt = `### TRPG Session Mode: ${activeGame.title}
**Current Scenario**: ${activeGame.worldSetting}
**Current Scene**: ${activeGame.status.location}
**Party Resources**:
- HP: ${activeGame.status.health}%
- SAN: ${activeGame.status.sanity || 100}%
- GOLD: ${activeGame.status.gold || 0}
- Items: ${activeGame.status.inventory.join(', ') || 'none'}

${statusWarning}
${gameOverTrigger}

### The Party
1. **${userProfile.name}** (Player/User)
${players.map(p => `2. **${p.name}** (ID: ${p.id}) - your teammate`).join('\n')}

### Character Sheets & Neural Links
${playerContext}

${recapBlock}### Recent Log
${activeLogText}
${rollInstruction}
### GM Instructions (Game Master Instructions)
You are now the **host (GM)** of this TRPG session.
**Current state**: this is a group of real friends (based on the private-chat relationships in the Neural Link) playing a tabletop game together.

**Please follow these rules**:
1. **Everyone stays "in character" (Roleplay First)**:
   - The teammates are living, breathing adventurers, but they also carry the memories and emotions from private chat.
   - **Reject mechanical behavior**: they should actively observe their surroundings, comment on the situation, and joke with each other.
   - **Private chat influence (key)**: please adjust each character's reaction based on the "relationship warmth" and "recent topics" in [Neural Link].
   - **Party interaction**: teammates can also interact with each other (e.g. A teasing B about their plan).

2. **De-center the player · let the world turn on its own (key)**:
   - **Reject a harem dynamic**: teammates aren't NPCs here to flatter or compete for the player. Don't have everyone fixate on the player and rush to please them.
   - **Everyone has their own agenda**: each character acts with **their own goals, stances, and emotions** — they can disagree, do their own thing, or temporarily ignore the player.
   - **Context-appropriate behavior**: the same character should show **different facets** in combat, social situations, alone, or in a crisis, rather than one fixed reaction across the board.
   - **Self-driven story**: the world has its own pace — even if the player does nothing, events happen, factions advance, and NPCs act. Actively push the main plot forward.

3. **Hardcore GM style**:
   - **Create conflict**: don't let the journey go smoothly. Throw in traps, sudden combat, awkward social situations, or moral dilemmas.
   - **Environmental description**: describe light, smell, and sound to build immersion.
   - **Dice rulings**: strictly follow the D20 result in [This Turn's Ruling] to decide success/failure — a low roll must carry a real cost.
   - **Markdown formatting**: please **actively use Markdown** in \`gm_narrative\` and \`dialogue\`. For example: use **bold** to emphasize key points, use *italics* to describe actions.

4. **Generate Options (Action Options)**:
   - Based on the current situation, offer the player 3 possible action suggestions (each automatically rolls a D20 once chosen, so options should carry a real chance of success or failure).

### Consistency Check
Before finishing, do one last check: does each character's dialogue, memories, verbal tics, and personality come **strictly from their own "character sheet"**? A character's memory/persona/experience must never be pinned onto another character (prevents "cross-talk"). If cross-talk is found, correct it before outputting.

### Output Format (Strict JSON)
Output JSON only, with no Markdown code block.
{
  "gm_narrative": "GM's story description (Markdown supported)...",
  "characters": [
    {
      "charId": "character ID (must match the list above)",
      "action": "action description",
      "dialogue": "line of dialogue"
    }
  ],
  "newLocation": "new location (optional)",
  "hpChange": 0,
  "sanityChange": 0,
  "goldChange": 0,
  "newItem": "item gained (optional)",
  "suggested_actions": [
    { "label": "Option 1 text", "type": "neutral" },
    { "label": "Option 2 text", "type": "chaotic" },
    { "label": "Option 3 text", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('The AI returned an empty response');

            // Robust JSON extraction
            const res = extractJson(rawContent);

            const newLogs: GameLog[] = [];
            const newStatus = { ...updatedGame.status };

            if (res) {
                // Structured response - use parsed JSON
                if (res.gm_narrative) {
                    newLogs.push({
                        id: `gm-${Date.now()}`,
                        role: 'gm',
                        content: res.gm_narrative,
                        timestamp: Date.now()
                    });
                }

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            const combinedContent = `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`;
                            newLogs.push({
                                id: `char-${Date.now()}-${Math.random()}`,
                                role: 'character',
                                speakerName: char.name,
                                content: combinedContent,
                                timestamp: Date.now()
                            });
                        }
                    }
                }

                // Update State (Stats)
                if (res.newLocation) newStatus.location = res.newLocation;
                if (res.hpChange) newStatus.health = Math.max(0, Math.min(100, (newStatus.health || 100) + res.hpChange));
                if (res.sanityChange && !sanityLocked) newStatus.sanity = Math.max(0, Math.min(100, (newStatus.sanity || 100) + res.sanityChange));
                if (res.goldChange) newStatus.gold = Math.max(0, (newStatus.gold || 0) + res.goldChange);
                if (res.newItem) newStatus.inventory = [...newStatus.inventory, res.newItem];
            } else {
                // JSON parse completely failed - still show the raw text as GM narrative
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                newLogs.push({
                    id: `gm-${Date.now()}`,
                    role: 'gm',
                    content: rawContent,
                    timestamp: Date.now()
                });
            }

            const finalGame = {
                ...updatedGame,
                logs: [...contextLogs, ...newLogs],
                status: newStatus,
                suggestedActions: res?.suggested_actions || []
            };
            
            setActiveGame(finalGame);
            await DB.saveGame(finalGame);

            // After the turn ends, check whether an auto-summary/archive is needed
            setIsTyping(false);
            await runAutoSummaryIfNeeded(finalGame);

        } catch (e: any) {
            addToast(`The GM lost connection: ${e.message}`, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    // --- Auto-summary (triggers every time AUTO_SUMMARY_THRESHOLD unarchived logs accumulate) ---
    // Compresses old story into a novel-style "Story So Far," archives and folds the raw text
    // (without deleting it), and sends a summary card into participating characters' memory and chat context.
    const runAutoSummaryIfNeeded = async (game: GameSession) => {
        const nonArchived = game.logs.filter(l => !l.archived);
        if (nonArchived.length < AUTO_SUMMARY_THRESHOLD) return;

        // Keep the most recent KEEP_RECENT_AFTER_SUMMARY entries unfolded, to preserve coherence
        const toArchive = nonArchived.slice(0, nonArchived.length - KEEP_RECENT_AFTER_SUMMARY);
        if (toArchive.length < 6) return; // Too few to be worth summarizing

        setIsSummarizing(true);
        try {
            const players = characters.filter(c => game.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join(', ');
            const prevRecap = (game.summaries || []).map((s, i) => `[Part ${i + 1}] ${s.content}`).join('\n');

            const logText = toArchive.map(l => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                return `[${who}]: ${l.content}`;
            }).join('\n');

            const prompt = `You are a chronicler skilled at writing fiction. Please summarize the following TRPG session story into a **coherent, vivid, novel-synopsis-style** "Story So Far."
${prevRecap ? `\n[Existing prior recap (for continuity only — don't repeat it)]\n${prevRecap}\n` : ''}
[Story log to summarize for this part]
${logText}

Requirements:
1. Narrate in third person, covering the full arc of [cause → development → outcome].
2. Focus on clearly describing **the changes in relationships between characters and each one's situation/emotional state** (who grew closer to whom, who clashed, what got exposed).
3. Keep it to roughly 150-250 words, flowing prose, no bullet points, and no opening line like "Summary as follows."

Output the summary text directly:`;

            const data = await fetchGameAPI(prompt, 1500);
            let summaryText = (extractContent(data) || '').trim();
            if (!summaryText) summaryText = '(The adventure continued to unfold)';

            const newSummary: GameSummary = {
                id: `sum-${Date.now()}`,
                content: summaryText,
                logCount: toArchive.length,
                logIds: toArchive.map(l => l.id),
                createdAt: Date.now(),
            };

            // Fold and archive the raw text (mark as archived, don't delete)
            const archiveIds = new Set(toArchive.map(l => l.id));
            const archivedLogs = game.logs.map(l => archiveIds.has(l.id) ? { ...l, archived: true } : l);

            const updated: GameSession = {
                ...game,
                logs: archivedLogs,
                summaries: [...(game.summaries || []), newSummary],
            };
            setActiveGame(updated);
            await DB.saveGame(updated);

            // Archive mode decides whether the summary gets pushed to the character's chat app.
            // 'auto' pushes it; 'manual' (including old saves missing this field) doesn't — only pushed on manual archive.
            if (game.archiveMode === 'auto') {
                const now = new Date();
                const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                const cardLine = `Played a TRPG session of "${game.title}" with ${playerNames}. ${summaryText}`;
                for (const p of players) {
                    const mem = {
                        id: `mem-${Date.now()}-${Math.random()}`,
                        date: dateStr,
                        summary: cardLine,
                        mood: 'fun'
                    };
                    updateCharacter(p.id, { memories: [...(p.memories || []), mem] });
                    await DB.saveMessage({
                        charId: p.id,
                        role: 'system',
                        type: 'text',
                        content: `[TRPG Progress Card: You're playing "${game.title}" with ${playerNames}. ${summaryText}]`
                    });
                }
                addToast('Auto-summarized and archived (synced to character chat)', 'success');
            } else {
                addToast('Auto-summarized and archived the earlier story', 'success');
            }
        } catch (e) {
            console.error('[GameApp] auto summary failed', e);
            // Summary failure shouldn't block the game — fail silently
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleReroll = async () => {
        if (!activeGame || isTyping) return;
        
        // Find index of last user/system action
        const logs = activeGame.logs;
        let lastUserIndex = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].role === 'player' || logs[i].role === 'system') {
                lastUserIndex = i;
                break;
            }
        }

        if (lastUserIndex === -1) {
            addToast('Nothing available to redo.', 'info');
            return;
        }

        // Keep logs up to and including the last user input
        const contextLogs = logs.slice(0, lastUserIndex + 1);

        // Optimistic Update
        const rolledBackGame = { ...activeGame, logs: contextLogs };
        setActiveGame(rolledBackGame);

        await handleAction("", true); // isReroll = true
        addToast('Re-rolling fate...', 'info');
        trackEvent('Reroll Previous Story Beat');
    };

    const handleRollbackLog = async (index: number) => {
        if (!activeGame) return;
        if (!confirm("Roll back to this entry?\n(Note: this will delete everything after this entry, but won't automatically reset HP/item status — adjust manually if needed)")) return;

        const newLogs = activeGame.logs.slice(0, index + 1);
        const updated = { ...activeGame, logs: newLogs };
        await DB.saveGame(updated);
        setActiveGame(updated);
        addToast('Time rollback successful', 'success');
        trackEvent('Rollback Story to a Log Entry');
    };

    const handleRestart = async () => {
        if (!activeGame) return;
        if (!confirm('Reset the current game? All progress will be lost.')) return;

        const initialLog: GameLog = {
            id: 'init',
            role: 'gm',
            content: `Welcome to "${activeGame.title}".\nLoading world setting...\n${activeGame.worldSetting}`,
            timestamp: Date.now()
        };

        const resetGame: GameSession = {
            ...activeGame,
            logs: [initialLog],
            // Forgetting to clear summaries would let the old "Story So Far" keep showing in "Archived
            // Story" and get injected into the next GM prompt → contaminating the new run. Clear the UI
            // expanded state at the same time.
            summaries: [],
            status: {
                location: 'Start Point',
                health: 100,
                sanity: 100,
                gold: 0,
                inventory: []
            },
            suggestedActions: [],
            lastPlayedAt: Date.now()
        };

        await DB.saveGame(resetGame);
        setActiveGame(resetGame);
        setShowArchived(false);
        setExpandedSummaries(new Set());
        setShowSystemMenu(false);
        addToast('Game has been reset', 'success');
        trackEvent('Reset Current Adventure');
    };

    // "Leave" just goes back to lobby (Auto-save is handled by DB calls in handleAction)
    const handleLeave = () => {
        setActiveGame(null);
        setView('lobby');
        setShowSystemMenu(false);
    };

    const handleArchiveAndQuit = async () => {
        if (!activeGame) return;
        setIsArchiving(true);
        setShowSystemMenu(false);
        
        try {
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join(', ');
            // Increase log context for summary
            const logText = activeGame.logs.slice(-30).map(l => `${l.role}: ${l.content}`).join('\n');

            const prompt = `Task: Summarize the key events of this TRPG session into a short clause (what happened).
Game: ${activeGame.title}
Logs:
${logText}
Output: A concise summary in English (e.g. "explored the dungeon and defeated the slime"). No preamble.`;

            const data = await fetchGameAPI(prompt);
            let summary = extractContent(data) || 'went on an adventure';
            summary = summary.replace(/[。\.]$/, ''); // Remove trailing dot

            // Format: [Character names] and [Username] played xxx together, and yyyy happened
            const memoryContent = `${playerNames} and ${userProfile.name} played "${activeGame.title}" together, and ${summary}`;

            // Format: YYYY-MM-DD
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

            for (const p of players) {
                // 1. Inject into Memory
                const mem = {
                    id: `mem-${Date.now()}-${Math.random()}`,
                    date: dateStr,
                    summary: memoryContent,
                    mood: 'fun'
                };
                updateCharacter(p.id, { memories: [...(p.memories || []), mem] });

                // 2. Inject into Context via System Message
                await DB.saveMessage({
                    charId: p.id,
                    role: 'system',
                    type: 'text',
                    content: `[TRPG Archive Reminder: You just played "${activeGame.title}" together. ${summary}.]`
                });
            }
            addToast('Memory transfer complete (Chat & Memory)', 'success');
            trackEvent('Archive Adventure and Write to Character Memory');
        } catch (e) {
            console.error(e);
            addToast('Archive failed', 'error');
        } finally {
            setIsArchiving(false);
            setView('lobby'); 
            setActiveGame(null);
        }
    };

    // --- Long-press to multi-select logs → forward to chat ---
    const startLogPress = (logId: string) => {
        if (selectMode) return;
        cancelLogPress();
        logPressTimer.current = setTimeout(() => {
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
            setSelectMode(true);
            setSelectedLogIds(new Set([logId]));
        }, 500);
    };
    const cancelLogPress = () => {
        if (logPressTimer.current) { clearTimeout(logPressTimer.current); logPressTimer.current = null; }
    };
    const toggleSelectLog = (logId: string) => {
        setSelectedLogIds(prev => {
            const n = new Set(prev);
            n.has(logId) ? n.delete(logId) : n.add(logId);
            return n;
        });
    };
    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedLogIds(new Set());
    };

    // Packages the selected story beats into a trpg_card and forwards them into each participating character's chat context
    const handleForwardToChat = async () => {
        if (!activeGame || selectedLogIds.size === 0) return;
        setIsForwarding(true);
        try {
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            // Take the selected logs in original story order (excluding pure system placeholders)
            const selected = activeGame.logs.filter(l => selectedLogIds.has(l.id) && l.role !== 'system');
            const excerpt = selected.map(l => ({
                role: l.role,
                speaker: l.role === 'gm' ? 'GM' : (l.speakerName || (l.role === 'player' ? userProfile.name : '')),
                text: l.content,
            }));
            const trpg = {
                gameTitle: activeGame.title,
                theme: activeGame.theme,
                userName: userProfile.name,
                partyNames: players.map(p => p.name),
                excerpt,
                count: excerpt.length,
            };
            for (const p of players) {
                await DB.saveMessage({
                    charId: p.id,
                    role: 'user',
                    type: 'trpg_card',
                    content: `[TRPG Game Excerpt] "${activeGame.title}"`,
                    metadata: { trpg },
                });
            }
            addToast(`Forwarded to ${players.length} character(s)' chat`, 'success');
            trackEvent('Forward Story Excerpt to Chat');
            exitSelectMode();
        } catch (e: any) {
            addToast(`Forward failed: ${e.message}`, 'error');
        } finally {
            setIsForwarding(false);
        }
    };

    const handleDeleteGame = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeleteConfirmId(id);
    };

    // Long-press a card to delete: holding for ~550ms triggers the delete confirmation, and suppresses the click that follows
    const startLongPress = (id: string) => {
        longPressFired.current = false;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressFired.current = true;
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
            setDeleteConfirmId(id);
        }, 550);
    };
    const cancelLongPress = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const handleCardOpen = (g: GameSession) => {
        if (longPressFired.current) { longPressFired.current = false; return; } // Long-press already triggered delete — ignore the click
        setActiveGame(g);
        setView('play');
        trackEvent('Open Save to Continue Adventure');
    };

    const confirmDeleteGame = async () => {
        if (!deleteConfirmId) return;
        await DB.deleteGame(deleteConfirmId);
        setGames(prev => prev.filter(g => g.id !== deleteConfirmId));
        setDeleteConfirmId(null);
        addToast('Save deleted', 'success');
        trackEvent('Delete TRPG Save');
    };

    // --- Renderers ---

    // 1. Lobby View (Redesigned)
    if (view === 'lobby') {
        return (
            <div className="h-full w-full bg-[#0a0a0a] flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-900/50 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="shrink-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center justify-between px-6 py-3">
                        <button onClick={closeApp} className="p-2 -ml-2 hover:bg-white/10 rounded-full text-white/70 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="font-black tracking-[0.2em] text-xl text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600">TRPG ADVENTURE</span>
                        <button onClick={() => setView('create')} className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white border border-white/10 shadow-lg active:scale-95 transition-all hover:bg-white/20">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                        </button>
                    </div>
                </div>

                {/* Games Grid */}
                <div className="px-6 pt-6 pb-2 flex-1 overflow-y-auto no-scrollbar z-10 space-y-4">
                    {games.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-500 gap-4">
                            <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center border border-white/5 animate-pulse"><Planet size={48} className="text-indigo-400" /></div>
                            <p className="text-xs tracking-widest uppercase">No Active Adventures</p>
                        </div>
                    )}
                    {games.length > 0 && (
                        <p className="text-[10px] text-white/30 tracking-widest uppercase text-center -mt-2">Long-press a card to delete</p>
                    )}
                    {games.slice(lobbyPage * LOBBY_PAGE_SIZE, lobbyPage * LOBBY_PAGE_SIZE + LOBBY_PAGE_SIZE).map(g => {
                        const themeStyle = GAME_THEMES[g.theme] || GAME_THEMES.fantasy;
                        return (
                            <div
                                key={g.id}
                                onClick={() => handleCardOpen(g)}
                                onPointerDown={() => startLongPress(g.id)}
                                onPointerUp={cancelLongPress}
                                onPointerLeave={cancelLongPress}
                                onPointerCancel={cancelLongPress}
                                onContextMenu={(e) => e.preventDefault()}
                                className={`relative overflow-hidden rounded-2xl p-5 cursor-pointer group active:scale-[0.98] transition-all border border-white/5 hover:border-white/20 shadow-lg select-none`}
                            >
                                {/* Card Background */}
                                <div className={`absolute inset-0 bg-gradient-to-br ${themeStyle.gradient} opacity-80 group-hover:opacity-100 transition-opacity`}></div>
                                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
                                
                                <div className="relative z-10 flex flex-col gap-2">
                                    <div className="flex justify-between items-start">
                                        <h3 className={`font-bold text-lg text-white leading-tight drop-shadow-md font-serif`}>{g.title}</h3>
                                        <span className={`text-[10px] px-2 py-0.5 rounded border border-white/20 text-white/80 uppercase font-mono tracking-wider bg-black/20`}>{g.theme}</span>
                                    </div>
                                    
                                    <p className="text-xs text-white/60 line-clamp-2 leading-relaxed italic font-serif border-l-2 border-white/20 pl-2">
                                        "{g.worldSetting}"
                                    </p>
                                    
                                    <div className="flex justify-between items-end mt-2 pt-2 border-t border-white/10">
                                        <div className="flex -space-x-2">
                                            {characters.filter(c => g.playerCharIds.includes(c.id)).map(c => (
                                                <TokenImg key={c.id} value={c.avatar} className="w-8 h-8 rounded-full border-2 border-black/50 object-cover shadow-sm" />
                                            ))}
                                        </div>
                                        <div className="text-[10px] text-white/40 font-mono">
                                            {new Date(g.lastPlayedAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                </div>

                                {/* Delete Button */}
                                <button onClick={(e) => handleDeleteGame(e, g.id)} className="absolute top-2 right-2 p-2 text-white/20 hover:text-red-400 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        );
                    })}
                </div>

                {/* Pager (5 per page) */}
                {games.length > LOBBY_PAGE_SIZE && (() => {
                    const totalPages = Math.ceil(games.length / LOBBY_PAGE_SIZE);
                    return (
                        <div className="flex items-center justify-center gap-4 px-6 pb-[calc(1rem+var(--safe-bottom,0px))] pt-2 shrink-0 z-10">
                            <button
                                onClick={() => setLobbyPage(p => Math.max(0, p - 1))}
                                disabled={lobbyPage === 0}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: totalPages }).map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setLobbyPage(i)}
                                        className={`rounded-full transition-all ${i === lobbyPage ? 'w-5 h-1.5 bg-purple-400' : 'w-1.5 h-1.5 bg-white/25 hover:bg-white/40'}`}
                                    />
                                ))}
                            </div>
                            <button
                                onClick={() => setLobbyPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={lobbyPage >= totalPages - 1}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                            </button>
                        </div>
                    );
                })()}

                {/* Delete Save Confirm Modal (lobby) */}
                <Modal isOpen={!!deleteConfirmId} title="Delete Save" onClose={() => setDeleteConfirmId(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Cancel</button>
                        <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">Delete</button>
                    </div>
                }>
                    <p className="text-sm text-slate-600 text-center py-4">Are you sure you want to delete this save?<br/><span className="text-xs text-red-400 mt-1 block">This action cannot be undone.</span></p>
                </Modal>
            </div>
        );
    }

    // 2. Create View
    if (view === 'create') {
        const THEME_META: Record<GameTheme, { label: string; en: string; gradient: string }> = {
            fantasy: { label: 'Fantasy', en: 'FANTASY', gradient: 'from-amber-700 to-orange-900' },
            cyber: { label: 'Cyber', en: 'CYBER', gradient: 'from-cyan-600 to-indigo-900' },
            horror: { label: 'Horror', en: 'HORROR', gradient: 'from-red-800 to-black' },
            modern: { label: 'Modern', en: 'MODERN', gradient: 'from-sky-500 to-slate-700' },
        };
        const canStart = newTitle.trim() && newWorld.trim() && selectedPlayers.size > 0;
        const playerChars = filterCharactersByGroup(characters, characterGroups, playerGroupId); // Invite teammates: candidates after group filtering
        return (
            <div className="h-full w-full bg-[#0a0a0a] text-white flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-900/40 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="shrink-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-5 py-3">
                        <button onClick={() => setView('lobby')} className="p-2 -ml-2 rounded-full text-white/70 hover:bg-white/10 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                        <span className="font-black tracking-[0.15em] text-base ml-1 mb-1 text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-pink-500">Create New World</span>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-5 z-10 no-scrollbar">
                    {/* Scenario Title */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">Scenario Title</label>
                        <input value={newTitle} onChange={e => setNewTitle(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none transition-all" placeholder="e.g. Dragon Quest" />
                    </div>

                    {/* World Setting */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">World Setting (Lore)</label>
                        <textarea value={newWorld} onChange={e => setNewWorld(e.target.value)} className="w-full h-36 bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm leading-relaxed text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none resize-none transition-all" placeholder="Describe your world... no ideas? Use AI to generate one below" />

                        {/* AI World-Setting Generation Panel */}
                        <div className="mt-3 rounded-2xl p-4 bg-gradient-to-br from-purple-500/10 to-pink-500/5 border border-purple-400/20 backdrop-blur-sm">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="w-1 h-3.5 rounded-full bg-gradient-to-b from-purple-400 to-pink-400"></span>
                                <span className="text-xs font-bold text-purple-200">No ideas? Let AI write it for you</span>
                            </div>

                            {/* Style Selection */}
                            <div className="grid grid-cols-5 gap-1.5 mb-3">
                                {WORLD_STYLES.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setWorldStyle(s)}
                                        className={`px-1 py-1.5 rounded-lg text-[10px] font-medium border transition-all active:scale-95 ${worldStyle === s ? 'bg-purple-500 text-white border-purple-400 shadow-lg shadow-purple-500/30' : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10'}`}
                                    >{s}</button>
                                ))}
                            </div>

                            {/* Extra Inspiration Input (optional) */}
                            <input
                                value={worldIdea}
                                onChange={e => setWorldIdea(e.target.value)}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-white/25 focus:border-purple-400/60 outline-none transition-all mb-3"
                                placeholder="Any more ideas to add? (optional, e.g. the protagonist is an amnesiac bounty hunter)"
                            />

                            <button
                                onClick={handleGenerateWorld}
                                disabled={isGeneratingWorld}
                                className="w-full text-xs font-bold py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-60 shadow-lg shadow-purple-500/20"
                            >
                                {isGeneratingWorld ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Generating a "{worldStyle}" world...</> : <>Generate World Setting</>}
                            </button>
                        </div>
                    </div>

                    {/* Art Style Theme */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">Art Style Theme</label>
                        <div className="grid grid-cols-4 gap-2">
                            {(['fantasy', 'cyber', 'horror', 'modern'] as GameTheme[]).map(t => {
                                const meta = THEME_META[t];
                                const active = newTheme === t;
                                return (
                                    <button key={t} onClick={() => setNewTheme(t)} className={`relative overflow-hidden rounded-xl py-4 flex flex-col items-center gap-0.5 border transition-all active:scale-95 ${active ? 'border-white/60 ring-1 ring-white/40' : 'border-white/10'}`}>
                                        <div className={`absolute inset-0 bg-gradient-to-br ${meta.gradient} ${active ? 'opacity-90' : 'opacity-40'} transition-opacity`}></div>
                                        <span className="relative text-sm font-bold tracking-wide">{meta.label}</span>
                                        <span className="relative text-[8px] font-mono tracking-[0.2em] opacity-70">{meta.en}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Gameplay Settings */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">Gameplay Settings</label>
                        <div className="rounded-2xl border border-white/10 bg-white/5 divide-y divide-white/10">
                            {/* Dice Toggle */}
                            <div className="flex items-center justify-between p-4">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium flex items-center gap-1.5"><DiceFive size={16} weight="fill" /> Dice Rolls (D20)</span>
                                    <span className="text-[10px] text-white/40 mt-0.5">{newDiceDisabled ? 'Off: actions default to success' : 'On: every action auto-rolls to decide success/failure'}</span>
                                </div>
                                <button
                                    onClick={() => setNewDiceDisabled(v => !v)}
                                    role="switch"
                                    aria-checked={!newDiceDisabled}
                                    className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${newDiceDisabled ? 'bg-white/15' : 'bg-emerald-500'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${newDiceDisabled ? '' : 'translate-x-6'}`}></span>
                                </button>
                            </div>

                            {/* Archive Mode */}
                            <div className="p-4">
                                <div className="flex items-center gap-1.5 mb-2.5">
                                    <span className="text-sm font-medium">Archive Mode</span>
                                    <button onClick={() => setShowArchiveHelp(v => !v)} className="w-4 h-4 rounded-full border border-white/30 text-white/50 text-[10px] leading-none flex items-center justify-center hover:bg-white/10 transition-colors">?</button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => setNewArchiveMode('auto')}
                                        className={`rounded-xl p-2.5 text-left border transition-all active:scale-95 ${newArchiveMode === 'auto' ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-white/5'}`}
                                    >
                                        <div className="text-xs font-bold">Auto Archive</div>
                                        <div className="text-[9px] text-white/40 mt-0.5 leading-snug">Summarizes every 20 entries, and syncs to character chat</div>
                                    </button>
                                    <button
                                        onClick={() => setNewArchiveMode('manual')}
                                        className={`rounded-xl p-2.5 text-left border transition-all active:scale-95 ${newArchiveMode === 'manual' ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-white/5'}`}
                                    >
                                        <div className="text-xs font-bold">Manual Archive</div>
                                        <div className="text-[9px] text-white/40 mt-0.5 leading-snug">Summarizes every 20 entries, but doesn't sync to character chat</div>
                                    </button>
                                </div>
                                {showArchiveHelp && (
                                    <div className="mt-2.5 text-[10px] text-white/50 leading-relaxed bg-black/30 rounded-xl p-3 space-y-1.5 border border-white/10">
                                        <p>Both modes <b className="text-white/70">auto-summarize every 20 story entries</b>, and the summary stays in the game's "Story So Far" — the GM will always remember it. The only difference is:</p>
                                        <p><b className="text-purple-300">Auto Archive</b>: each summary is <b className="text-white/70">immediately synced to the participating characters' chat app</b> (the character will "remember" running the session with you).</p>
                                        <p><b className="text-purple-300">Manual Archive</b>: auto-summaries <b className="text-white/70">won't</b> touch character chat — only when you tap "Archive Memory & Exit" in the menu does the whole experience get sent into character chat.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Invite Players */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2 flex items-center justify-between">
                            <span>Invite Teammates</span>
                            {selectedPlayers.size > 0 && <span className="text-purple-300 normal-case font-mono">{selectedPlayers.size} selected</span>}
                        </label>
                        {characters.length === 0 ? (
                            <p className="text-xs text-white/30 py-4 text-center bg-white/5 rounded-xl border border-white/10">No characters yet — go create one first</p>
                        ) : (
                            <>
                            {/* Group filter (not rendered if no groups exist): only affects which candidates are shown, not already-checked teammates */}
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark value={playerGroupId} onChange={setPlayerGroupId} className="mb-2.5" />
                            {playerChars.length === 0 ? (
                                <p className="text-xs text-white/30 py-4 text-center bg-white/5 rounded-xl border border-white/10">No characters in this group</p>
                            ) : (
                            <div className="grid grid-cols-4 gap-3">
                                {playerChars.map(c => {
                                    const sel = selectedPlayers.has(c.id);
                                    return (
                                        <div key={c.id} onClick={() => { const s = new Set(selectedPlayers); if(s.has(c.id)) s.delete(c.id); else s.add(c.id); setSelectedPlayers(s); }} className={`flex flex-col items-center p-2 rounded-2xl border cursor-pointer transition-all active:scale-95 ${sel ? 'border-purple-400 bg-purple-500/15' : 'border-white/5 hover:bg-white/5'}`}>
                                            <div className="relative">
                                                <TokenImg value={c.avatar} className={`w-12 h-12 rounded-full object-cover transition-all ${sel ? 'ring-2 ring-purple-400 ring-offset-2 ring-offset-[#0a0a0a]' : 'opacity-80'}`} />
                                                {sel && <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center border-2 border-[#0a0a0a]"><svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 text-white"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" /></svg></div>}
                                            </div>
                                            <span className={`text-[9px] mt-2 truncate w-full text-center font-medium ${sel ? 'text-purple-200' : 'text-white/50'}`}>{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                            )}
                            </>
                        )}
                    </div>
                </div>

                {/* Bottom Start Button */}
                <div className="p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t border-white/5 bg-black/40 backdrop-blur-md z-10">
                    <button
                        onClick={handleCreateGame}
                        disabled={isCreating || !canStart}
                        className={`w-full py-3.5 font-bold rounded-2xl shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 ${canStart ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-purple-500/30' : 'bg-white/10 text-white/30'}`}
                    >
                        {isCreating ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Generating prologue...</> : <><RocketLaunch size={18} /> Start Adventure</>}
                    </button>
                </div>
            </div>
        );
    }

    // 3. Play View
    if (!activeGame) return null;
    const theme = GAME_THEMES[activeGame.theme];
    const activePlayers = characters.filter(c => activeGame.playerCharIds.includes(c.id));

    // [FIX] Changed from absolute inset-0 to h-full relative to fix overscroll and height layout issues
    return (
        <div className={`h-full w-full relative flex flex-col ${theme.bg} ${theme.text} ${theme.font} transition-colors duration-500 overflow-hidden`}>
            
            {/* Header */}
            <div className={`border-b ${theme.border} shrink-0 bg-opacity-90 backdrop-blur z-20 relative`} style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                        <button onClick={handleLeave} className={`p-2 -ml-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="flex flex-col mb-0.5">
                            <span className="font-bold text-sm tracking-wide line-clamp-1 max-w-[150px]">{activeGame.title}</span>
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] opacity-60 flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                    {activeGame.status.location}
                                </span>
                                {lastTokenUsage && <span className="text-[8px] opacity-40 font-mono inline-flex items-center gap-0.5" title={`Prompt: ${lastTokenUsage.prompt || '?'} | Completion: ${lastTokenUsage.completion || '?'} | Total session: ${totalTokensUsed}`}><Lightning size={10} weight="fill" />{lastTokenUsage.prompt || '?'}/{lastTokenUsage.completion || '?'} (∑{totalTokensUsed})</span>}
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-1 mb-1">
                        {/* Toggle Party HUD */}
                        <button onClick={() => setShowParty(!showParty)} className={`p-2 rounded hover:bg-white/10 active:scale-95 transition-transform ${showParty ? theme.accent : 'opacity-50'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                        </button>
                        <button onClick={() => { setShowSystemMenu(true); trackEvent('Open TRPG System Menu'); }} className={`p-2 -mr-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* --- NEW: Party HUD (Collapsible) --- */}
            {showParty && (
                <div className={`flex gap-4 p-3 overflow-x-auto no-scrollbar border-b ${theme.border} bg-black/20 backdrop-blur-sm z-10 shrink-0 animate-slide-down`}>
                    {/* User Avatar */}
                    <div className="relative group shrink-0">
                        <TokenImg value={userProfile.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm" />
                        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[8px] px-1.5 rounded-full backdrop-blur-sm whitespace-nowrap">YOU</div>
                    </div>
                    {/* Teammates */}
                    {activePlayers.map(p => (
                        <div key={p.id} className="relative group shrink-0 cursor-pointer active:scale-95 transition-transform">
                            <TokenImg value={p.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm group-hover:border-white/50 transition-colors" />
                            <div className="absolute inset-0 rounded-full ring-2 ring-transparent group-hover:ring-green-400/50 transition-all"></div>
                            {/* Simple Status Indicator (Green Dot) */}
                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-black/50 shadow-sm animate-pulse"></div>
                        </div>
                    ))}
                </div>
            )}

            {/* Stats HUD */}
            <div className={`px-4 py-2 border-b ${theme.border} bg-black/10 backdrop-blur-sm z-10 shrink-0`}>
                <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col items-center bg-red-500/20 rounded p-1 border border-red-500/30">
                        <span className="text-[8px] text-red-300 font-bold uppercase">HP</span>
                        <span className="text-xs font-mono font-bold text-red-100">{activeGame.status.health || 100}</span>
                    </div>
                    <div
                        onClick={toggleSanityLock}
                        className={`flex flex-col items-center bg-blue-500/20 rounded p-1 border cursor-pointer active:scale-95 transition-all ${sanityLocked ? 'border-blue-400 ring-1 ring-blue-400/50' : 'border-blue-500/30'}`}
                    >
                        <span className="text-[8px] text-blue-300 font-bold uppercase flex items-center gap-1">
                            SAN {sanityLocked && <LockSimple size={10} weight="fill" className="text-blue-400 inline" />}
                        </span>
                        <span className="text-xs font-mono font-bold text-blue-100">{activeGame.status.sanity || 100}</span>
                    </div>
                    <div className="flex flex-col items-center bg-yellow-500/20 rounded p-1 border border-yellow-500/30">
                        <span className="text-[8px] text-yellow-300 font-bold uppercase">GOLD</span>
                        <span className="text-xs font-mono font-bold text-yellow-100">{activeGame.status.gold || 0}</span>
                    </div>
                </div>
                {/* Token Statistics */}
                {lastTokenUsage && (
                    <div className="mt-1.5 flex items-center justify-between bg-white/5 rounded px-2 py-1 border border-white/10">
                        <span className="text-[8px] text-white/40 font-mono inline-flex items-center gap-0.5"><Lightning size={10} weight="fill" /> Prompt: {lastTokenUsage.prompt ?? '?'} | Completion: {lastTokenUsage.completion ?? '?'} | This turn: {lastTokenUsage.total}</span>
                        <span className="text-[8px] text-white/40 font-mono">∑ {totalTokensUsed}</span>
                    </div>
                )}
            </div>

            {/* Stage / Log Area */}
            <div
                ref={logsContainerRef} // [FIX] Attach Ref to scrollable container
                className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar relative animate-fade-in"
            >
                {/* Archived story (folded and greyed out after auto-summary, never deleted) */}
                {(activeGame.logs.some(l => l.archived) || (activeGame.summaries && activeGame.summaries.length > 0)) && (() => {
                    const archivedLogs = activeGame.logs.filter(l => l.archived);
                    const summaries = activeGame.summaries || [];
                    // Match each summary to the raw text it covers: prefer logIds; fall back to slicing old summaries in logCount order
                    let cursor = 0;
                    const groups = summaries.map((s, si) => {
                        let logs: GameLog[];
                        if (s.logIds && s.logIds.length) {
                            const idset = new Set(s.logIds);
                            logs = archivedLogs.filter(l => idset.has(l.id));
                        } else {
                            logs = archivedLogs.slice(cursor, cursor + s.logCount);
                        }
                        cursor += logs.length;
                        return { summary: s, logs, index: si };
                    });
                    const covered = new Set(groups.flatMap(g => g.logs.map(l => l.id)));
                    const orphanLogs = archivedLogs.filter(l => !covered.has(l.id));

                    const renderLogs = (logs: GameLog[]) => (
                        <div className={`pl-3 border-l-2 ${theme.border} space-y-1.5 mt-2`}>
                            {logs.map((log, li) => (
                                <div key={log.id || li} className="text-[11px] leading-snug">
                                    <span className="font-bold opacity-70">{log.role === 'gm' ? 'GM' : (log.speakerName || 'System')}: </span>
                                    <span className="opacity-70">{log.content.replace(/\n+/g, ' ').slice(0, 140)}{log.content.length > 140 ? '…' : ''}</span>
                                </div>
                            ))}
                        </div>
                    );

                    return (
                        <div className="my-2">
                            <button
                                onClick={() => setShowArchived(v => !v)}
                                className={`w-full text-[11px] py-2 px-3 rounded-lg border border-dashed ${theme.border} opacity-60 hover:opacity-100 transition-opacity flex items-center justify-center gap-2 font-mono`}
                            >
                                {archivedLogs.length} entries archived · {summaries.length} recap(s) {showArchived ? '(click to collapse)' : '(click to expand)'}
                            </button>
                            {showArchived && (
                                <div className="mt-3 space-y-4">
                                    {groups.map(g => {
                                        const open = expandedSummaries.has(g.summary.id);
                                        return (
                                            <div key={g.summary.id} className="space-y-2">
                                                {/* Raw text for this part (collapsed by default, expandable) */}
                                                <button
                                                    onClick={() => setExpandedSummaries(prev => { const n = new Set(prev); n.has(g.summary.id) ? n.delete(g.summary.id) : n.add(g.summary.id); return n; })}
                                                    className={`w-full text-left text-[10px] font-mono opacity-50 hover:opacity-90 transition-opacity flex items-center gap-1.5`}
                                                >
                                                    <span>{open ? '▾' : '▸'}</span>
                                                    <span>Part {g.index + 1} · {g.logs.length} raw entries {open ? '' : '(click to view)'}</span>
                                                </button>
                                                {open && <div className="opacity-50">{renderLogs(g.logs)}</div>}
                                                {/* The summary for this part follows the raw text */}
                                                <div className={`p-4 rounded-lg border ${theme.border} ${theme.cardBg} text-xs italic leading-relaxed opacity-80`}>
                                                    <div className="text-[10px] font-bold uppercase tracking-widest mb-1 not-italic opacity-70">Story So Far · Part {g.index + 1}</div>
                                                    <GameMarkdown content={g.summary.content} theme={theme} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {/* Archived raw text not yet covered by a summary (rare, just a fallback) */}
                                    {orphanLogs.length > 0 && (
                                        <div className="opacity-50">{renderLogs(orphanLogs)}</div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {activeGame.logs.map((log, i) => {
                    if (log.archived) return null; // Archived logs render in the collapsed block above
                    const isGM = log.role === 'gm';
                    const isSystem = log.role === 'system';
                    const isCharacter = log.role === 'character';
                    const charInfo = isCharacter ? activePlayers.find(p => p.name === log.speakerName) : null;

                    let inner: React.ReactNode;
                    if (isSystem) {
                        inner = (
                            <div className="flex flex-col items-center my-4 animate-fade-in gap-1 group">
                                <span className="text-[10px] opacity-50 border-b border-dashed border-current pb-0.5 font-mono">{log.content}</span>
                                <button onClick={() => handleRollbackLog(i)} className="text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">Rollback to here</button>
                            </div>
                        );
                    } else if (isGM) {
                        inner = (
                            <div className="animate-fade-in my-4 group relative">
                                <div className={`p-5 rounded-lg border-2 ${theme.border} ${theme.cardBg} shadow-sm relative mx-auto w-full text-sm`}>
                                    <div className="absolute -top-3 left-4 bg-inherit px-2 text-[10px] font-bold uppercase tracking-widest opacity-80 border border-inherit rounded">Game Master</div>
                                    <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                </div>
                                <button onClick={() => handleRollbackLog(i)} className="absolute top-2 right-2 text-[9px] bg-red-900/50 text-red-200 px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-800">Rollback</button>
                            </div>
                        );
                    } else if (isCharacter && charInfo) {
                        inner = (
                            <div className="flex gap-3 animate-slide-up group relative">
                                <TokenImg value={charInfo.avatar} className={`w-10 h-10 rounded-full object-cover border ${theme.border} shrink-0 mt-1`} />
                                <div className="flex flex-col max-w-[85%]">
                                    <span className="text-[10px] font-bold opacity-60 mb-1 ml-1">{charInfo.name}</span>
                                    <div className={`px-4 py-2 rounded-2xl rounded-tl-none text-sm ${theme.cardBg} border ${theme.border} shadow-sm relative`}>
                                        <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                    </div>
                                    <button onClick={() => handleRollbackLog(i)} className="self-start mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">Rollback</button>
                                </div>
                            </div>
                        );
                    } else {
                        // Player (User) Log
                        inner = (
                            <div className="flex flex-col items-end animate-slide-up group relative">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-[10px] font-bold opacity-60`}>{log.speakerName}</span>
                                    {log.diceRoll && (
                                        <span className="text-[10px] bg-white/20 px-1.5 rounded text-yellow-500 font-mono">
                                            <DiceFive size={12} weight="fill" className="inline" /> {log.diceRoll.result}
                                        </span>
                                    )}
                                </div>
                                <div className={`px-4 py-2 rounded-2xl rounded-tr-none text-sm bg-orange-600 text-white shadow-md max-w-[85%]`}>
                                    {log.content}
                                </div>
                                <button onClick={() => handleRollbackLog(i)} className="mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">Rollback</button>
                            </div>
                        );
                    }

                    const selected = selectedLogIds.has(log.id);
                    return (
                        <div
                            key={log.id || i}
                            onPointerDown={() => startLogPress(log.id)}
                            onPointerUp={cancelLogPress}
                            onPointerLeave={cancelLogPress}
                            onPointerCancel={cancelLogPress}
                            onClick={() => { if (selectMode) toggleSelectLog(log.id); }}
                            onContextMenu={(e) => { if (selectMode) e.preventDefault(); }}
                            className={`relative ${selectMode ? `cursor-pointer rounded-xl px-1 transition-all ${selected ? 'ring-2 ring-purple-400 bg-purple-500/10' : 'hover:bg-white/[0.03]'}` : ''}`}
                        >
                            {selectMode && (
                                <div className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-purple-500 border-purple-400' : 'border-white/40 bg-black/40'}`}>
                                    {selected && <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z" clipRule="evenodd"/></svg>}
                                </div>
                            )}
                            <div className={selectMode ? 'pointer-events-none select-none pl-5' : ''}>
                                {inner}
                            </div>
                        </div>
                    );
                })}
                {isTyping && <div className="text-xs opacity-50 animate-pulse pl-2 font-mono">The GM is calculating the outcome...</div>}

                {/* [FIX] Removed logsEndRef usage */}
            </div>

            {/* Multi-select forward action bar */}
            {selectMode && (
                <div className={`p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t ${theme.border} bg-black/50 backdrop-blur shrink-0 z-20 flex items-center gap-3 animate-slide-down`}>
                    <button onClick={exitSelectMode} className="px-4 h-11 rounded-xl border border-white/15 text-sm font-bold text-white/70 active:scale-95 transition-transform">Cancel</button>
                    <span className="text-xs text-white/50 flex-1 text-center">{selectedLogIds.size} selected · long-press to multi-select story entries</span>
                    <button
                        onClick={handleForwardToChat}
                        disabled={selectedLogIds.size === 0 || isForwarding}
                        className="px-5 h-11 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-bold active:scale-95 transition-transform disabled:opacity-40 flex items-center gap-2 shadow-lg shadow-purple-500/20"
                    >
                        {isForwarding ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Forwarding...</> : 'Forward to Chat'}
                    </button>
                </div>
            )}

            {/* Controls */}
            {/* Bottom pb-[calc(1rem+var(--safe-bottom,0px))] keeps content clear of the home indicator (--safe-bottom, see index.html — has a JS probe fallback under iOS PWA) */}
            <div className={`p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t ${theme.border} bg-opacity-90 backdrop-blur shrink-0 z-20 transition-colors duration-500 ${selectMode ? 'hidden' : ''}`}>

                {/* AI Suggested Options Area */}
                {activeGame.suggestedActions && activeGame.suggestedActions.length > 0 && !isTyping && (
                    <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar pb-1">
                        {activeGame.suggestedActions.map((opt, idx) => {
                            let styleClass = theme.optionNormal;
                            if (opt.type === 'chaotic') styleClass = theme.optionChaotic;
                            if (opt.type === 'evil') styleClass = theme.optionEvil;
                            
                            return (
                                <button 
                                    key={idx} 
                                    onClick={() => handleAction(opt.label)}
                                    className={`flex-1 min-w-[100px] text-[10px] p-2 rounded-lg border ${styleClass} hover:opacity-80 active:scale-95 transition-all text-left leading-tight shadow-sm`}
                                >
                                    <span className="block font-bold opacity-70 uppercase text-[8px] mb-0.5 tracking-wider">{opt.type}</span>
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Collapsible Action Toolbar — quick actions (auto-rolls a D20 when used) */}
                {showTools && (
                    <div className="flex gap-2 mb-3 animate-fade-in items-center">
                        <span className={`text-[10px] opacity-50 flex items-center gap-1 shrink-0 ${activeGame.diceDisabled ? 'opacity-30 line-through' : theme.accent}`}>
                            <DiceFive size={16} weight="fill" /> {activeGame.diceDisabled ? 'Dice off' : 'Auto-roll'}
                            {!activeGame.diceDisabled && lastRoll !== null && <span className="font-mono font-bold no-underline">Last: {lastRoll}</span>}
                        </span>
                        {['Investigate', 'Attack', 'Negotiate', 'Sneak', 'Flee'].map(action => (
                            <button key={action} disabled={isTyping} onClick={() => handleAction(action)} className={`flex-1 px-3 py-2 rounded border ${theme.border} hover:bg-white/10 text-xs font-bold transition-colors active:scale-95 disabled:opacity-40`}>{action}</button>
                        ))}
                    </div>
                )}

                <div className="flex gap-2 items-end">
                    {/* Toggle Tools Button */}
                    <button 
                        onClick={() => setShowTools(!showTools)}
                        className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center ${showTools ? 'bg-white/20' : ''}`}
                    >
                        <Toolbox size={22} />
                    </button>

                    {/* Reroll Button (Context Sensitive) */}
                    {!isTyping && activeGame.logs.length > 0 && (
                        <button 
                            onClick={handleReroll}
                            className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center`}
                            title="Regenerate last turn"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 opacity-70"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    )}

                    <textarea 
                        value={userInput} 
                        onChange={e => setUserInput(e.target.value)} 
                        // Removed onKeyDown Enter submission
                        placeholder="What do you want to do..."
                        className={`flex-1 bg-black/20 border ${theme.border} rounded-xl px-3 py-3 outline-none text-sm placeholder-opacity-30 placeholder-current resize-none h-12 leading-tight focus:bg-black/40 transition-colors`}
                    />
                    <button onClick={() => handleAction(userInput)} className={`${theme.accent} font-bold text-sm px-4 h-12 bg-white/10 rounded-xl hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>
                    </button>
                </div>
            </div>

            {/* System Menu Modal */}
            <Modal isOpen={showSystemMenu} title="System Menu" onClose={() => setShowSystemMenu(false)}>
                <div className="space-y-4">
                    {/* UI Settings */}
                    <div className="bg-slate-100 p-3 rounded-xl">
                        <label className="text-xs text-slate-500 font-bold mb-3 block border-b border-slate-200 pb-1">Reading Settings (Display)</label>
                        <div className="space-y-3">
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">Size</span>
                                <input
                                    type="range"
                                    min="12"
                                    max="24"
                                    step="1"
                                    value={uiSettings.fontSize}
                                    onChange={e => setUiSettings({...uiSettings, fontSize: parseInt(e.target.value)})}
                                    className="flex-1 h-1.5 bg-slate-300 rounded-lg appearance-none cursor-pointer accent-orange-500"
                                />
                                <span className="text-xs font-mono text-slate-600 w-6 text-right">{uiSettings.fontSize}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">Color</span>
                                <input
                                    type="color"
                                    value={uiSettings.color || '#e5e5e5'}
                                    onChange={e => setUiSettings({...uiSettings, color: e.target.value})}
                                    className="w-full h-8 rounded cursor-pointer bg-white border border-slate-200 p-0.5"
                                />
                            </div>
                            <button onClick={() => { setUiSettings({ fontSize: 14, color: '' }); trackEvent('Restore Default Reading Appearance'); }} className="w-full py-1.5 bg-white border border-slate-200 text-slate-500 text-xs rounded-lg active:scale-95 transition-transform">Restore Default</button>
                        </div>
                    </div>

                    {/* Gameplay Settings */}
                    <div className="bg-slate-100 p-3 rounded-xl">
                        <label className="text-xs text-slate-500 font-bold mb-3 block border-b border-slate-200 pb-1">Gameplay Settings (Gameplay)</label>
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                                <span className="text-sm text-slate-700 font-medium flex items-center gap-1.5"><DiceFive size={16} weight="fill" /> Dice Rolls (D20)</span>
                                <span className="text-[10px] text-slate-400 mt-0.5">Once off, actions no longer auto-roll</span>
                            </div>
                            <button
                                onClick={toggleDice}
                                role="switch"
                                aria-checked={!activeGame.diceDisabled}
                                className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${activeGame.diceDisabled ? 'bg-slate-300' : 'bg-emerald-500'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${activeGame.diceDisabled ? '' : 'translate-x-6'}`}></span>
                            </button>
                        </div>
                    </div>

                    <button onClick={handleArchiveAndQuit} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <FloppyDisk size={18} /> Archive Memory & Exit
                    </button>
                    <button onClick={handleRestart} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <ArrowsClockwise size={18} /> Reset Current Game
                    </button>
                    <button onClick={handleLeave} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl flex items-center justify-center gap-2">
                        <DoorOpen size={18} /> Leave for Now (no archive)
                    </button>
                </div>
            </Modal>

            {/* Delete Save Confirm Modal */}
            <Modal isOpen={!!deleteConfirmId} title="Delete Save" onClose={() => setDeleteConfirmId(null)} footer={
                <div className="flex gap-3 w-full">
                    <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">Cancel</button>
                    <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">Delete</button>
                </div>
            }>
                <p className="text-sm text-slate-600 text-center py-4">Are you sure you want to delete this save?<br/><span className="text-xs text-red-400 mt-1 block">This action cannot be undone.</span></p>
            </Modal>

            {/* Archive Overlay */}
            {isArchiving && (
                <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center text-white flex-col gap-4 animate-fade-in">
                    <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs tracking-widest font-mono">Transferring memory...</span>
                </div>
            )}

            {/* Auto-Summary Overlay (full-screen feedback for the every-20-entries auto-summary) */}
            {isSummarizing && (
                <div className="absolute inset-0 bg-black/85 z-50 flex items-center justify-center text-white flex-col gap-5 animate-fade-in px-8 text-center">
                    <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-sm tracking-widest font-bold">Summarizing the story so far…</span>
                    <span className="text-[11px] opacity-50 font-mono leading-relaxed">Archiving story · distilling cause, development & outcome · recording relationship changes</span>
                </div>
            )}
        </div>
    );
};

export default GameApp;
