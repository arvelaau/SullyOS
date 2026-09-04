import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneSimLog, CharacterBuff, UserProfile } from '../types';
import type { SimBeat as Beat, SimBeatKind as BeatKind, SimScript } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { safeResponseJson } from '../utils/safeApi';
import { parsePersonaScriptApiResponse } from '../utils/personaSimParser';
import { trackEvent } from '../utils/analytics';
import { useBlobRefUrl } from '../utils/blobRef';
import {
    CaretLeft, Play, Pause, FastForward, Lock, MagnifyingGlass, MusicNotes,
    BellRinging, ImageSquare, NotePencil, Globe, CloudSun, ArrowClockwise,
    HourglassMedium, Sparkle, ClockCounterClockwise, X, CaretRight, ArrowRight,
    PaperPlaneTilt, Check,
} from '@phosphor-icons/react';

// ============================================================
//  TYPES (runtime script model) — Beat / SimScript have been moved to types.ts
//  and shared, so "Life Log" can store the full script snapshot for replay.
// ============================================================
export interface SimApiConfig { apiKey: string; baseUrl: string; model: string; }
export type SimState =
    | { status: 'idle' }
    | { status: 'loading'; mode: 'daily' | 'event'; theme: string }
    | { status: 'ready'; mode: 'daily' | 'event'; theme: string; script: SimScript; replay?: boolean }
    | { status: 'error'; mode: 'daily' | 'event'; theme: string };

interface Props {
    targetChar: CharacterProfile;
    onExit: () => void;
    openLifeLog: () => void;
    sim: SimState;
    onStart: (mode: 'daily' | 'event', theme: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute') => void;
    onConsumed: () => void;
}

const DAILY = ['An Ordinary Tuesday', 'Staying In on the Weekend', 'Sleepless at Night', 'A Day at Work', 'Evening After School'];
const EVENTS = ['Meeting Someone for the First Time', 'The Day of the Confession', 'Exam Results Announced', 'The Day They Quit', 'The Afternoon the Test Results Came In', 'After an Argument'];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ACCENT = '#b89bff';

// ============================================================
//  TYPEWRITER — the soul of screenlife (type → delete → retype)
// ============================================================
const Typewriter: React.FC<{ drafts: string[]; sent?: string | null; className?: string; placeholder?: string }> =
    ({ drafts, sent, className, placeholder }) => {
        const [text, setText] = useState('');
        const [blink, setBlink] = useState(true);
        useEffect(() => {
            let cancelled = false;
            const type = async (s: string) => {
                for (let k = 0; k <= s.length; k++) { if (cancelled) return; setText(s.slice(0, k)); await wait(48); }
            };
            const erase = async (s: string) => {
                for (let k = s.length; k >= 0; k--) { if (cancelled) return; setText(s.slice(0, k)); await wait(26); }
            };
            (async () => {
                for (const d of drafts) {
                    await type(d); if (cancelled) return;
                    await wait(750); if (cancelled) return;
                    await erase(d); if (cancelled) return;
                    await wait(280);
                }
                if (sent != null && sent !== '') { await type(sent); setBlink(false); }
                else setBlink(false);
            })();
            return () => { cancelled = true; };
        }, []);
        return (
            <span className={className}>
                {text || <span className="opacity-30">{placeholder}</span>}
                {blink && <span className="inline-block w-[2px] h-[1em] align-middle ml-0.5 bg-current animate-pulse" />}
            </span>
        );
    };

// ============================================================
//  BACKGROUND GENERATOR (runs at CheckPhone level so it survives navigation)
// ============================================================
export async function generatePersonaScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: SimApiConfig;
    mode: 'daily' | 'event'; theme: string; userPresence?: 'default' | 'light' | 'none';
    tone?: 'mix' | 'depressive' | 'darkhumor' | 'cute';
}): Promise<SimScript> {
    const { char, userProfile, apiConfig, mode, theme, userPresence = 'default', tone = 'mix' } = opts;
    await injectMemoryPalace(char, undefined, theme, userProfile.name);
    const context = ContextBuilder.buildCoreContext(char, userProfile, true, char.memoryPalaceInjection);
    const msgs = await DB.getMessagesByCharId(char.id);
    // Follows the max context the user set for this character (defaults to 500 if unset) -- avoids "you check the storyline right after an argument, and the character doesn't remember what it was about"
    const ctxLimit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');
    const firstTs = msgs.find(m => typeof m.timestamp === 'number')?.timestamp;
    const acquaintance = describeAcquaintance(firstTs, userProfile.name, char.name);
    const prompt = buildDirectorPrompt(context, recent, mode, theme, char.name, acquaintance, userProfile.name, userPresence, tone);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.98, max_tokens: 24000 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    // Truncation errors out directly, no fallback: finish_reason is 'length' when the model's output hit the token cap
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Performance generation was truncated');
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason === 'content_filter' || finishReason === 'safety') {
        throw new Error("Performance generation was stopped by the model's safety policy");
    }
    const { content, script: parsed } = parsePersonaScriptApiResponse(data);
    if (!content) throw new Error('The model did not return a performance script');
    if (!parsed) {
        console.warn('[persona] script parse failed', { finishReason, contentLength: content.length });
        throw new Error(`Performance format could not be parsed (model returned ${content.length} characters)`);
    }
    // No fallback: the ending must be an "end" the model wrapped up itself, otherwise it's treated as incomplete/truncated, and errors out so the user can retry
    if (parsed.beats[parsed.beats.length - 1].kind !== 'end') throw new Error("Performance ending is incomplete");
    return parsed;
}

// ============================================================
//  COMPONENT
// ============================================================
const PersonaSim: React.FC<Props> = ({ targetChar, onExit, openLifeLog, sim, onStart, onConsumed }) => {
    const { updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<'idle' | 'play' | 'end'>('idle');
    const [mode, setMode] = useState<'daily' | 'event'>('daily');
    const [theme, setTheme] = useState('');
    const [presence, setPresence] = useState<'default' | 'light' | 'none'>('default');
    const [tone, setTone] = useState<'mix' | 'depressive' | 'darkhumor' | 'cute'>('mix');
    const [script, setScript] = useState<SimScript | null>(null);
    const [idx, setIdx] = useState(0);
    const [autoplay, setAutoplay] = useState(false);
    const [memorySent, setMemorySent] = useState(false);
    const savedRef = useRef(false);
    const ffTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const beats = script?.beats || [];
    const beat = beats[idx];

    // Layering: find the "currently visible screen" (lock/app/flashback); notifications/
    // thoughts pop up layered on top of it, and the background screen only re-enters when
    // the underlying screen actually changes -- this is the key to avoiding a "slideshow" feel.
    const screenIdx = (() => {
        for (let i = idx; i >= 0; i--) {
            const k = beats[i]?.kind;
            if (k === 'lock' || k === 'app' || k === 'flashback') return i;
        }
        return -1;
    })();
    const screenBeat = screenIdx >= 0 ? beats[screenIdx] : undefined;
    const isOverlay = beat?.kind === 'notification' || beat?.kind === 'thought';

    // ----- kick off background generation (runs in CheckPhone) -----
    const requestStart = (m: 'daily' | 'event', t: string) => {
        const trimmed = t.trim();
        if (!trimmed) { addToast('Please choose or enter what to experience', 'error'); return; }
        setMode(m); setTheme(trimmed);
        onStart(m, trimmed, presence, tone);
    };

    // ----- consume a ready script (generated in background) and start playing -----
    useEffect(() => {
        if (phase === 'idle' && sim.status === 'ready') {
            setMode(sim.mode); setTheme(sim.theme);
            // Replay: the script comes from an already-archived Life Log snapshot, don't persist it again (or it'll show up duplicated in Life Log)
            setScript(sim.script); setIdx(0); savedRef.current = !!sim.replay; setMemorySent(false); setPhase('play');
            onConsumed();
        }
    }, [sim, phase, onConsumed]);

    // ----- persistence on reaching the end -----
    const persist = useCallback(async () => {
        if (savedRef.current || !script) return;
        savedRef.current = true;

        const log: PhoneSimLog = {
            id: `sim-${Date.now()}`,
            mode,
            theme,
            title: script.title || theme,
            summary: script.summary || '',
            ending: script.ending,
            beatsCount: beats.length,
            memoryText: buildMemoryText(script),
            timestamp: Date.now(),
            script,   // Store the full script snapshot -> Life Log can replay it exactly as-is
        };

        // emotion buff — only if the schedule feature is on for this character
        const scheduleOn = isScheduleFeatureOn(targetChar);
        const newBuff: CharacterBuff | null = (scheduleOn && script.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: script.buff.name || `sim_${Date.now()}`,
            label: script.buff.label,
            intensity: (script.buff.intensity && [1, 2, 3].includes(script.buff.intensity) ? script.buff.intensity : 2) as 1 | 2 | 3,
            emoji: script.buff.emoji,
            color: script.buff.color || ACCENT,
            description: script.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        // Key: merges based on the "latest" character state, never overwrites phoneState
        // wholesale with a possibly-stale targetChar snapshot (otherwise a write from
        // elsewhere during the async gap would wipe out the simLogs / other phoneState
        // fields that were just saved).
        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(targetChar.id, (cur) => {
            const phoneState = {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                simLogs: [log, ...(cur.phoneState?.simLogs || [])],
            };
            if (newBuff && script.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    buffInjection: script.buff.description ? `(${newBuff.emoji || ''}${newBuff.label}) ${script.buff.description}` : '',
                    phoneState,
                };
            }
            return { phoneState };
        });
        if (newBuff) {
            // If buffs can't be obtained, fall back to a "pure refresh" signal -- buffSyncHandler will re-read from the DB as a fallback
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: targetChar.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: targetChar.id } }));
        }
        addToast('Saved to Life Log', 'success');
    }, [script, mode, theme, beats.length, targetChar, updateCharacter, addToast]);

    // ----- advance -----
    const advance = useCallback(() => {
        setIdx(i => {
            if (i >= beats.length - 1) return i;
            return i + 1;
        });
    }, [beats.length]);

    useEffect(() => {
        if (phase === 'play' && beat?.kind === 'end') {
            setPhase('end');
            setAutoplay(false);
            persist();
        }
    }, [idx, phase, beat, persist]);

    // ----- autoplay -----
    useEffect(() => {
        if (phase !== 'play' || !autoplay || !beat) return;
        const base = beat.kind === 'flashback' ? 6500 : beat.kind === 'thought' ? 3600 : 3000;
        const delay = base + (beat.pace === 3 ? 3500 : beat.pace === 2 ? 1600 : 0);
        const t = setTimeout(advance, delay);
        return () => clearTimeout(t);
    }, [phase, autoplay, idx, beat, advance]);

    // ----- long-press fast-forward -----
    const startFF = () => {
        if (ffTimer.current) return;
        ffTimer.current = setInterval(advance, 320);
    };
    const stopFF = () => { if (ffTimer.current) { clearInterval(ffTimer.current); ffTimer.current = null; } };
    useEffect(() => () => stopFF(), []);

    const restart = () => {
        // Watching the same performance again doesn't write to Life Log a second time (savedRef stays saved)
        setIdx(0);
        setPhase('play');
    };

    // Send this performance to chat as a "real memory" -- the character will treat it as something they personally lived through (enters context)
    const sendAsMemory = async () => {
        if (!script || memorySent) return;
        const title = script.title || theme;
        const summary = script.summary || '';
        const digest = buildMemoryText(script);
        const content = `[A Lived Memory · ${title}]\n${digest}${summary ? `\n\nLooking back: ${summary}` : ''}`;
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card', content,
                metadata: { simCard: { mode, theme, title, summary, ending: script.ending } },
            } as any);
            setMemorySent(true);
            addToast('Sent to them as a memory', 'success');
        } catch (e) {
            console.error(e);
            addToast('Failed to send, please try again', 'error');
        }
    };

    const wallpaper = targetChar.dateBackground;

    // ========================================================
    //  RENDER: SELECT
    // ========================================================
    if (phase === 'idle' && (sim.status === 'idle' || sim.status === 'error')) {
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} right={
                    <button onClick={() => { openLifeLog(); trackEvent('Open Life Log'); }} className="flex items-center gap-1 text-[11px] text-white/60 active:scale-95 transition">
                        <ClockCounterClockwise size={15} /> Life Log
                    </button>
                } />
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pt-2 pb-10">
                    <div className="mb-5">
                        <div className="text-[10px] tracking-[0.35em] uppercase" style={{ color: ACCENT }}>Persona Simulation</div>
                        <h1 className="text-[26px] font-light text-white mt-2 leading-tight" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                            Become a slice of<br />{targetChar.name}'s life
                        </h1>
                    </div>

                    {/* Experience ticket · dramatic flair: makes it sound impressive while also stating this is just a vignette, not a claim about the character's real situation */}
                    <div className="relative rounded-2xl overflow-hidden mb-6 border border-[#b89bff]/25"
                        style={{ background: 'linear-gradient(135deg, rgba(184,155,255,0.16), rgba(184,155,255,0.03))' }}>
                        <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: ACCENT }} />
                        <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.4), transparent 70%)' }} />
                        <div className="relative p-4 pl-5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[9px] tracking-[0.28em] uppercase font-bold" style={{ color: ACCENT }}>✦ Experience Ticket</span>
                                <span className="text-[8px] tracking-[0.2em] uppercase text-white/45 border border-white/15 rounded px-1.5 py-0.5">Fiction Only</span>
                            </div>
                            <p className="text-[11.5px] text-white/75 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                This is a ticket into their world. Borrowing this phone, we'll stage a slice of a life that <span style={{ color: ACCENT }}>might have happened</span> -- the visuals, the inner monologue, and the traces left behind are all improvised by the AI in this moment.
                            </p>
                            <p className="text-[10px] text-white/45 leading-relaxed mt-2.5 pt-2.5 border-t border-dashed border-white/15">
                                * It's just a small performance staged for you, a kind of "what if." <br />It isn't the same as the character's real experiences or setting -- lose yourself in it, forget it once it's over, no need to take it as fact.
                            </p>
                        </div>
                    </div>

                    {/* mode tabs */}
                    <div className="flex gap-2 mb-4 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
                        {(['daily', 'event'] as const).map(m => (
                            <button key={m} onClick={() => { setMode(m); trackEvent('Switch Persona Simulation Type', { mode: m }); }}
                                className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition"
                                style={mode === m ? { background: ACCENT, color: '#1a1530' } : { color: 'rgba(255,255,255,0.5)' }}>
                                {m === 'daily' ? 'Daily Simulation' : 'Event Simulation'}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-white/35 mb-4 px-1">
                        {mode === 'daily' ? 'Experience their life on an ordinary day · a sense of everyday life and companionship' : 'Experience a special event from their life · emotional tension'}
                    </p>

                    {/* Your presence (how much "you" factor into this day) */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">Your Presence</div>
                    <div className="grid grid-cols-3 gap-2 mb-5">
                        {([
                            { id: 'default', label: 'Default', desc: 'Appears naturally' },
                            { id: 'light', label: 'Light', desc: 'Faint background' },
                            { id: 'none', label: 'None', desc: 'Only them' },
                        ] as const).map(o => {
                            const active = presence === o.id;
                            return (
                                <button key={o.id} onClick={() => { setPresence(o.id); trackEvent('Choose Your Presence', { presence: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Performance tone (which flavor, under the general premise of feeling down) */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">Performance Tone</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {([
                            { id: 'mix', label: 'Freeform', desc: 'Random each time' },
                            { id: 'depressive', label: 'Melancholic', desc: 'Down the whole way' },
                            { id: 'darkhumor', label: 'Dark Humor', desc: 'Absurd and biting' },
                            { id: 'cute', label: 'Light & Cute', desc: 'Playful and lively' },
                        ] as const).map(o => {
                            const active = tone === o.id;
                            return (
                                <button key={o.id} onClick={() => { setTone(o.id); trackEvent('Choose Performance Tone', { tone: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Step 1: pick a direction (tap fills it in below, still editable) */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">1. Pick a general direction</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {(mode === 'daily' ? DAILY : EVENTS).map(s => {
                            const active = theme.trim() === s;
                            return (
                                <button key={s} onClick={() => setTheme(s)}
                                    className="text-left rounded-2xl px-3.5 py-3 border transition active:scale-[0.98]"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}>
                                    <span className="text-[12.5px] font-medium">{s}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Step 2: fill in details (merged with the direction, no longer either/or) */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">2. Add some detail · or just write your own</div>
                    <textarea value={theme} onChange={e => setTheme(e.target.value)}
                        placeholder="Pick a direction, then fill in the specific situation here, or just write whatever you want to see. For example: Evening after school -- it's raining, they forgot an umbrella, waiting outside a convenience store for someone who might not show up."
                        className="w-full h-24 bg-white/[0.05] border border-white/[0.08] rounded-2xl px-3.5 py-3 text-[12.5px] text-white placeholder-white/25 outline-none resize-none leading-relaxed mb-4 no-scrollbar" />

                    <button onClick={() => requestStart(mode, theme)} disabled={!theme.trim()}
                        className="w-full py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: ACCENT, color: '#1a1530' }}>
                        Start the Performance <ArrowRight size={15} weight="bold" />
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: LOADING (background generation in progress / about to play)
    // ========================================================
    if (phase === 'idle') {
        const t = sim.status === 'loading' ? sim.theme : theme;
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-5 px-10 text-center">
                    <div className="relative">
                        <HourglassMedium size={40} weight="light" style={{ color: ACCENT }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: `${ACCENT}55` }} />
                    </div>
                    <div className="text-[13px] text-white/75">Staging "{t}"...</div>
                    <div className="text-[11px] text-white/35 leading-relaxed">Weaving memories, conversation, and emotion into a day of their life,<br />may take a while.</div>
                    <button onClick={onExit} className="mt-3 px-5 py-2.5 rounded-xl text-[12px] text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        Go look around elsewhere · Notify me when it's ready
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell wallpaper={wallpaper}>
                <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
                    <Lock size={26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">Performance Over</div>
                    <h2 className="text-[20px] font-light text-white mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.title}</h2>
                    {script?.ending && <div className="text-[11px] mb-4 px-3 py-1 rounded-full" style={{ color: ACCENT, background: `${ACCENT}1f` }}>{script.ending}</div>}
                    <p className="text-[13.5px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.summary}</p>

                    {script?.buff?.label && isScheduleFeatureOn(targetChar) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || ACCENT}55`, background: `${script.buff.color || ACCENT}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">Emotional state has been written to them</div>
                            </div>
                        </div>
                    )}

                    {/* Send this performance to the character as a real memory */}
                    <button onClick={sendAsMemory} disabled={memorySent}
                        className="mt-8 w-full max-w-[300px] py-3 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-60"
                        style={memorySent
                            ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.1)' }
                            : { background: ACCENT, color: '#1a1530' }}>
                        {memorySent
                            ? <><Check size={15} weight="bold" /> Became one of their memories</>
                            : <><PaperPlaneTilt size={15} weight="fill" /> Send to them as a memory</>}
                    </button>
                    <p className="text-[10px] text-white/30 mt-2 max-w-[280px] leading-relaxed">
                        Sent to chat as a card, and they'll treat this experience as a real memory.
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> Watch again
                        </button>
                        <button onClick={() => { openLifeLog(); }} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold text-[#1a1530] flex items-center gap-1.5 active:scale-95 transition" style={{ background: ACCENT }}>
                            <ClockCounterClockwise size={14} weight="bold" /> Life Log
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">Exit Performance</button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: PLAY
    // ========================================================
    return (
        <Shell wallpaper={wallpaper}>
            {/* phone status time */}
            <div className="h-8 flex justify-between items-center px-6 pt-2 text-white/55 text-[11px] z-30 relative shrink-0">
                <span className="font-semibold tabular-nums">{beat?.time || ''}</span>
                <div className="flex items-center gap-1">
                    <Lock size={11} weight="fill" className="opacity-50" />
                    <span className="opacity-50">{targetChar.name}</span>
                </div>
            </div>

            {/* beat stage + tap to advance */}
            <div
                className="flex-1 relative z-10 overflow-hidden select-none"
                onClick={advance}
                onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const t = setTimeout(startFF, 420); (e.currentTarget as any)._ff = t; }}
                onPointerUp={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
                onPointerLeave={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
            >
                {/* background screen — re-enters ONLY when the underlying screen changes */}
                {screenBeat && (
                    <div key={`s${screenIdx}`} className={`absolute inset-0 ${screenEntrance(screenBeat.kind)}`}>
                        <ScreenContent beat={screenBeat} char={targetChar} showMono={!isOverlay} dimmed={isOverlay} />
                    </div>
                )}
                {/* overlay — notification drops / thought fades, on top of the live screen */}
                {beat && isOverlay && (
                    <div key={`o${idx}`} className="absolute inset-0">
                        <Overlay beat={beat} />
                    </div>
                )}
            </div>

            {/* progress + controls */}
            <div className="shrink-0 z-30 px-5 pb-6 pt-2">
                <div className="h-[3px] rounded-full bg-white/10 overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${((idx + 1) / beats.length) * 100}%`, background: ACCENT }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); onExit(); }} className="text-[11px] text-white/35">Exit</button>
                    <span className="text-[10px] text-white/30">Tap to continue · long-press to fast-forward</span>
                    <button onClick={(e) => { e.stopPropagation(); setAutoplay(a => !a); trackEvent('Toggle Performance Autoplay'); }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.1] text-white/70 active:scale-90 transition"
                        style={autoplay ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' } : undefined}>
                        {autoplay ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                    </button>
                </div>
            </div>
        </Shell>
    );
};

// ============================================================
//  ENTRANCE + MONOLOGUE
// ============================================================
// Entrance animation per screen type -- App pops up from the bottom (like a real launch), lock screen fades in, flashback fades in
const screenEntrance = (kind: BeatKind): string =>
    kind === 'app' ? 'animate-app-open' : 'animate-fade-in';

type Vibe = NonNullable<Beat['vibe']>;
// Deterministic pseudo-random (seeded), guarantees the same beat scatters consistently on every render
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const vibeTint: Record<Vibe, string> = {
    calm: 'rgba(255,255,255,0.9)',
    chaotic: 'rgba(255,255,255,0.85)',
    happy: '#ffb3d9',
    anxious: '#ff9a9a',
    numb: 'rgba(255,255,255,0.45)',
    tender: '#e6c9ff',
};

// Inner monologue bubble (typed out character by character, tone fine-tuned by mood)
const MonoBubble: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <span className="inline-block px-3 py-1 rounded-2xl bg-black/70">
        <Typewriter drafts={[]} sent={text} placeholder=""
            className={`text-[15px] leading-relaxed ${vibe === 'anxious' ? 'tracking-tight' : ''}`} />
    </span>
);

// Inner monologue floating at the bottom of the screen (for scenes without a bottom input box, like lock screen / notifications)
const MonoLine: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <div className="absolute left-0 right-0 bottom-6 px-8 text-center pointer-events-none z-20">
        <MonoBubble text={text} vibe={vibe} />
    </div>
);

// Emotional full-screen "inner monologue" performance: chaotic scattered / happy pink and floaty / numb and cold / anxious and tense
const MoodThought: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => {
    if (vibe === 'chaotic') {
        const frags = text.split(/[，。、！？!?,.\s]+/).filter(Boolean);
        const pool = frags.length >= 4 ? frags : [...frags, ...frags, ...frags].slice(0, Math.max(6, frags.length));
        return (
            <div className="absolute inset-0 overflow-hidden">
                {pool.map((f, i) => (
                    <span key={i} className="absolute animate-fade-in"
                        style={{
                            top: `${6 + rnd(i + 1) * 62}%`, left: `${6 + rnd(i + 7) * 44}%`,
                            maxWidth: '46%', wordBreak: 'break-word', textAlign: 'center', lineHeight: 1.3,
                            transform: `rotate(${(rnd(i + 3) - 0.5) * 30}deg)`,
                            fontSize: `${13 + rnd(i + 5) * 14}px`,
                            opacity: 0.35 + rnd(i + 9) * 0.6,
                            color: 'white',
                            animationDelay: `${i * 90}ms`, animationFillMode: 'backwards',
                            textShadow: '0 1px 8px rgba(0,0,0,0.5)',
                        }}>
                        {f}
                    </span>
                ))}
            </div>
        );
    }
    if (vibe === 'happy') {
        const deco = ['✿', '♡', '❀', '✦', '♥', '✧'];
        return (
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center px-10">
                {deco.map((d, i) => (
                    <span key={i} className="absolute animate-float" style={{
                        bottom: `${10 + rnd(i + 2) * 20}%`, left: `${8 + rnd(i + 4) * 80}%`,
                        fontSize: `${14 + rnd(i + 6) * 14}px`, color: '#ffc2e0',
                        animationDelay: `${i * 350}ms`, opacity: 0.8,
                    }}>{d}</span>
                ))}
                <p className="text-[20px] text-center leading-relaxed animate-fade-in"
                    style={{ background: 'linear-gradient(90deg,#ffd6ec,#ffb3d9,#ffc2e0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'anxious') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-10">
                <p className="text-[18px] text-center leading-relaxed tracking-tight animate-pulse"
                    style={{ color: vibeTint.anxious, textShadow: '0 0 12px rgba(255,80,80,0.3)' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'numb') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-12">
                <p className="text-[14px] text-center leading-loose animate-fade-in" style={{ color: vibeTint.numb, animationDuration: '2s' }}>
                    {text}
                </p>
            </div>
        );
    }
    // calm / tender → typed, soft
    return (
        <div className="absolute inset-0 flex items-center justify-center px-10">
            <Typewriter drafts={[]} sent={text} placeholder=""
                className="text-[19px] text-center leading-relaxed"
                />
            {vibe === 'tender' && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 50%, rgba(230,201,255,0.12), transparent 60%)' }} />}
        </div>
    );
};

// ============================================================
//  SCREEN CONTENT — lock / app / flashback (the persistent layer)
// ============================================================
const ScreenContent: React.FC<{ beat: Beat; char: CharacterProfile; showMono: boolean; dimmed?: boolean }> =
    ({ beat, char, showMono, dimmed }) => {
        const mono = showMono && beat.monologue ? <MonoLine text={beat.monologue} vibe={beat.vibe} /> : null;
        const dim = dimmed ? <div className="absolute inset-0 bg-black/45 z-10 pointer-events-none" /> : null;

        if (beat.kind === 'lock') {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-[64px] font-extralight text-white tracking-tight tabular-nums leading-none animate-fade-in" style={{ textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>{beat.time || ''}</div>
                    {beat.notif && (
                        <div className="mt-10 w-[78%] rounded-2xl px-4 py-3 bg-black/70 border border-white/[0.15] animate-slide-up">
                            <div className="text-[10px] text-white/50 uppercase tracking-wide mb-0.5">{beat.notif.app}</div>
                            <div className="text-[12.5px] text-white/90 font-medium">{beat.notif.title}</div>
                            <div className="text-[11px] text-white/55 mt-0.5">{beat.notif.body}</div>
                        </div>
                    )}
                    {dim}{mono}
                </div>
            );
        }

        if (beat.kind === 'flashback') {
            const f = beat.flashback;
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center"
                    style={{ background: `radial-gradient(circle at 50% 45%, ${f?.tint || '#3a2a4a'} 0%, #07080c 78%)` }}>
                    <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-2.5 bg-black/75 border border-white/[0.15] flex items-center gap-2 animate-slide-down">
                        <ImageSquare size={16} className="text-pink-300" />
                        <span className="text-[12px] text-white/85 font-medium">{f?.label || f?.date || 'Some day in the past'}</span>
                    </div>
                    <div className="w-[68%] aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.1] shadow-2xl relative grayscale-[35%] animate-fade-in"
                        style={{ background: `linear-gradient(160deg, ${f?.tint || '#5a4a6a'}, #1a1520)`, animationDuration: '1.4s' }}>
                        <div className="absolute inset-0 flex items-center justify-center opacity-40">
                            <ImageSquare size={48} weight="thin" className="text-white" />
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                            {f?.date && <div className="text-[9px] text-white/50 tabular-nums">{f.date}</div>}
                            {f?.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                        </div>
                    </div>
                    {beat.monologue
                        ? <div className="mt-6 px-10 text-center"><Typewriter drafts={[]} sent={beat.monologue} placeholder="" className="text-[14px] text-white/80" /></div>
                        : <p className="mt-6 text-[12px] text-white/30 tracking-[0.3em]">· · ·</p>}
                </div>
            );
        }

        // kind === 'app'
        const a = beat.app;
        if (!a) return <>{dim}{mono}</>;
        return (
            <div className="absolute inset-0 flex flex-col">
                <div className="h-11 flex items-center gap-2 px-5 shrink-0 text-white/70 border-b border-white/[0.06]">
                    {appIcon(a.view)}
                    <span className="text-[12.5px] font-medium">{a.name}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden relative">
                    <AppView app={a} char={char} />
                </div>
                {/* In app scenes, the monologue runs as a "footer" rather than an overlay, to avoid covering the chat/search/input box */}
                {showMono && beat.monologue && (
                    <div className="shrink-0 px-8 pb-6 pt-2 text-center">
                        <MonoBubble text={beat.monologue} vibe={beat.vibe} />
                    </div>
                )}
                {dim}
            </div>
        );
    };

// ============================================================
//  OVERLAY — notification (drops) / thought (fades over the live screen)
// ============================================================
const Overlay: React.FC<{ beat: Beat }> = ({ beat }) => {
    if (beat.kind === 'thought') {
        const scrim = beat.vibe === 'happy' ? 'bg-black/55' : beat.vibe === 'chaotic' ? 'bg-black/75' : 'bg-black/70';
        return (
            <div className={`absolute inset-0 ${scrim}`}>
                <MoodThought text={beat.monologue || '……'} vibe={beat.vibe} />
            </div>
        );
    }
    // notification
    const n = beat.notif;
    const toneColor = n?.tone === 'sms' ? '#4ade80' : n?.tone === 'flashback' ? '#ff5fb0' : ACCENT;
    return (
        <div className="absolute inset-0">
            <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-3 bg-[#16131f]/95 border border-white/[0.16] animate-notif-pop shadow-2xl">
                <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: toneColor, boxShadow: `0 0 8px ${toneColor}` }} />
                    <span className="text-[10px] text-white/55 uppercase tracking-wide">{n?.app}</span>
                </div>
                <div className="text-[13px] text-white font-semibold">{n?.title}</div>
                <div className="text-[11.5px] text-white/65 mt-0.5">{n?.body}</div>
            </div>
            {beat.monologue && <MonoLine text={beat.monologue} vibe={beat.vibe} />}
        </div>
    );
};

const appIcon = (v: string) => {
    const p: any = { size: 15, weight: 'fill' as const, style: { color: ACCENT } };
    switch (v) {
        case 'search': return <MagnifyingGlass {...p} />;
        case 'music': return <MusicNotes {...p} />;
        case 'photo': return <ImageSquare {...p} />;
        case 'notes': return <NotePencil {...p} />;
        case 'browser': return <Globe {...p} />;
        case 'weather': return <CloudSun {...p} />;
        case 'chat': return <BellRinging {...p} />;
        default: return <Sparkle {...p} />;
    }
};

// ============================================================
//  APP VIEWS
// ============================================================
const AppView: React.FC<{ app: NonNullable<Beat['app']>; char: CharacterProfile }> = ({ app, char }) => {
    if (app.view === 'chat' && app.chat) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar px-4 py-4 space-y-2.5">
                <div className="text-center text-[10px] text-white/30 mb-2">{app.chat.name}</div>
                {app.chat.lines.map((l, i) => (
                    <div key={i} className={`flex ${l.me ? 'justify-end' : 'justify-start'} animate-fade-in`}
                        style={{ animationDelay: `${i * 320}ms`, animationFillMode: 'backwards' }}>
                        <div className={`px-3.5 py-2 rounded-2xl max-w-[74%] text-[13px] leading-relaxed ${l.me ? 'text-[#1a1530] rounded-br-md' : 'bg-white/[0.08] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                            style={l.me ? { background: ACCENT } : undefined}>
                            {l.text}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'compose' && app.compose) {
        const c = app.compose;
        return (
            <div className="h-full flex flex-col justify-end p-4">
                {c.to && <div className="text-[10px] text-white/30 mb-2 px-1">To: {c.to}</div>}
                <div className="rounded-2xl bg-white/[0.05] border border-white/[0.1] px-4 py-3 min-h-[52px] flex items-center">
                    <Typewriter drafts={c.drafts || []} sent={c.sent} placeholder="Type a message..."
                        className="text-[14px] text-white/90 leading-relaxed" />
                </div>
                <div className="text-[10px] text-white/25 mt-2 px-1">
                    {c.sent ? 'Sent' : 'Draft cleared'}
                </div>
            </div>
        );
    }

    if (app.view === 'search' && app.search) {
        const qs = app.search.queries || [];
        const last = qs[qs.length - 1];
        const sent = last && !last.deleted ? last.q : null;
        const drafts = qs.slice(0, sent != null ? -1 : qs.length).map(x => x.q);
        return (
            <div className="h-full flex flex-col p-4">
                <div className="rounded-full bg-white/[0.06] border border-white/[0.1] px-4 py-2.5 flex items-center gap-2">
                    <MagnifyingGlass size={15} className="text-white/40" />
                    <Typewriter drafts={drafts} sent={sent} placeholder="Search" className="text-[13.5px] text-white/85" />
                </div>
                <div className="text-[10px] text-white/25 mt-3 px-1">{app.search.engine || 'Search'}</div>
                <div className="flex-1 flex items-center justify-center">
                    {sent
                        ? <span className="text-[11px] text-white/30">Found some results for you...</span>
                        : <span className="text-[11px] text-white/25">-- No search --</span>}
                </div>
            </div>
        );
    }

    if (app.view === 'photo' && app.photo) {
        const f = app.photo;
        return (
            <div className="h-full flex items-center justify-center p-6">
                <div className="w-full aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.08] relative"
                    style={{ background: `linear-gradient(155deg, ${f.tint || '#3a4a5a'}, #14161c)` }}>
                    <div className="absolute inset-0 flex items-center justify-center opacity-30"><ImageSquare size={44} weight="thin" className="text-white" /></div>
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/65 to-transparent">
                        {f.date && <div className="text-[9px] text-white/45 tabular-nums">{f.date}</div>}
                        {f.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                    </div>
                </div>
            </div>
        );
    }

    if (app.view === 'music' && app.music) {
        const m = app.music;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-5 px-10">
                <div className="w-36 h-36 rounded-3xl flex items-center justify-center animate-bounce-slow" style={{ background: `linear-gradient(135deg, ${ACCENT}55, ${ACCENT}10)` }}>
                    <MusicNotes size={46} weight="fill" style={{ color: ACCENT }} />
                </div>
                <div className="text-center">
                    <div className="text-[15px] text-white font-medium">{m.song}</div>
                    <div className="text-[12px] text-white/45 mt-1">{m.artist}</div>
                </div>
                <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full w-1/3 rounded-full" style={{ background: ACCENT }} /></div>
                {m.state && <div className="text-[10px] text-white/30">{m.state}</div>}
            </div>
        );
    }

    if (app.view === 'notes' && app.notes) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-5">
                {app.notes.title && <div className="text-[15px] text-white font-medium mb-3">{app.notes.title}</div>}
                <div className="space-y-2.5">
                    {app.notes.items.map((it, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-[13px] text-white/75">
                            <span className="w-4 h-4 rounded border border-white/20 mt-0.5 shrink-0" />
                            <span>{it}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (app.view === 'browser' && app.browser) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-4 space-y-2">
                <div className="text-[10px] text-white/30 px-1 mb-1">{app.browser.tabs.length} tabs open</div>
                {app.browser.tabs.map((t, i) => (
                    <div key={i} className="rounded-xl bg-white/[0.04] border border-white/[0.07] px-3.5 py-3 flex items-center gap-2.5">
                        <Globe size={15} className="text-white/35 shrink-0" />
                        <span className="text-[12.5px] text-white/75 truncate">{t}</span>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'weather' && app.weather) {
        const w = app.weather;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3">
                <CloudSun size={56} weight="thin" className="text-white/70" />
                <div className="text-[52px] font-extralight text-white leading-none tabular-nums">{w.temp}°</div>
                <div className="text-[13px] text-white/55">{w.city} · {w.desc}</div>
            </div>
        );
    }

    return (
        <div className="h-full flex items-center justify-center px-8 text-center">
            <p className="text-[13.5px] text-white/70 leading-relaxed">{app.text || '…'}</p>
        </div>
    );
};

// ============================================================
//  SHARED CHROME
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; wallpaper?: string }> = ({ children, wallpaper }) => {
    // What's passed in is the raw field value of the character's Date background
    // (blobref token / legacy data: URI / external link) -- a token can't be fed
    // directly to CSS url(), so it's resolved once here; non-token values pass through as-is.
    const wallpaperUrl = useBlobRefUrl(wallpaper);
    return (
    <div className="absolute inset-0 z-[80] flex flex-col overflow-hidden text-white" style={{ background: '#07080c' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(130% 80% at 50% 0%, #1a1726 0%, #0a0b12 60%, #07080c 100%)' }} />
        {wallpaperUrl && <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: `url("${wallpaperUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom, rgba(7,8,12,0.4), rgba(7,8,12,0.2) 40%, rgba(7,8,12,0.9))' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
    );
};

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode; title?: string }> = ({ onBack, right, title }) => (
    // Top safe area: the iOS notch/status bar would cover the back button and "Life Log," so provide a safe-area-inset fallback
    <div className="flex items-center justify-between px-4 shrink-0 pb-2"
        style={{ paddingTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        {title && <span className="text-[14px] font-semibold text-white">{title}</span>}
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// ============================================================
//  LIFE LOG — sub-app
// ============================================================
export const LifeLog: React.FC<{
    targetChar: CharacterProfile;
    onBack: () => void;
    onReplay?: (log: PhoneSimLog) => void;
    onRequestDelete?: (log: PhoneSimLog) => void;
}> = ({ targetChar, onBack, onReplay, onRequestDelete }) => {
    const { addToast } = useOS();
    const logs = targetChar.phoneState?.simLogs || [];
    const [sent, setSent] = useState<Record<string, boolean>>({});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fmt = (t: number) => new Date(t).toLocaleString('en-US', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const cancelLongPress = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };
    const startLongPress = (e: React.PointerEvent, log: PhoneSimLog) => {
        if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            onRequestDelete(log);
        }, 520);
    };
    useEffect(() => () => cancelLongPress(), []);

    const sendLog = async (log: PhoneSimLog) => {
        if (sent[log.id]) return;
        try {
            const digest = log.memoryText ? `\n${log.memoryText}` : '';
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card',
                content: `[A Lived Memory · ${log.title}]${digest}${log.summary ? `\n\nLooking back: ${log.summary}` : ''}`,
                metadata: { simCard: { mode: log.mode, theme: log.theme, title: log.title, summary: log.summary, ending: log.ending } },
            } as any);
            setSent(s => ({ ...s, [log.id]: true }));
            addToast('Sent to them as a memory', 'success');
        } catch (e) { console.error(e); addToast('Failed to send, please try again', 'error'); }
    };
    return (
        <Shell wallpaper={targetChar.dateBackground}>
            <TopBar onBack={onBack} title="Life Log" />
            <div className="px-6 pb-3 shrink-0">
                <p className="text-[11px] text-white/40 leading-relaxed">Fragments you lived through as them. They won't remember, but you will.</p>
                {logs.length > 0 && onRequestDelete && <p className="mt-1.5 text-[10px] text-white/25">Long-press a log to delete it</p>}
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10 space-y-3">
                {logs.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
                        <ClockCounterClockwise size={42} weight="light" />
                        <span className="text-xs">No experiences logged yet</span>
                    </div>
                )}
                {logs.map(log => (
                    <div key={log.id}
                        onPointerDown={(e) => startLongPress(e, log)}
                        onPointerUp={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                        onPointerMove={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onContextMenu={(e) => {
                            if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
                            e.preventDefault();
                            cancelLongPress();
                            onRequestDelete(log);
                        }}
                        className="rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up select-none">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: ACCENT, background: `${ACCENT}1f` }}>
                                {log.mode === 'daily' ? 'Daily' : 'Event'} · {log.theme}
                            </span>
                            <span className="text-[9px] text-white/30 tabular-nums">{fmt(log.timestamp)}</span>
                        </div>
                        <div className="text-[15px] font-light text-white mb-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.title}</div>
                        {log.ending && <div className="text-[10px] text-white/40 mb-1.5">Ending · {log.ending}</div>}
                        <p className="text-[12.5px] text-white/60 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.summary}</p>
                        <div className="flex items-center justify-between mt-3 gap-2">
                            {log.buff?.label ? (
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px]" style={{ borderColor: `${log.buff.color || ACCENT}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || ACCENT}14` }}>
                                    <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                </div>
                            ) : <span />}
                            <div className="flex items-center gap-2 shrink-0">
                                {onReplay && log.script?.beats?.length ? (
                                    <button onClick={() => onReplay(log)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition border border-white/[0.12] text-white/80 bg-white/[0.05]">
                                        <ArrowClockwise size={12} weight="bold" /> Replay
                                    </button>
                                ) : null}
                                <button onClick={() => sendLog(log)} disabled={!!sent[log.id]}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition disabled:opacity-60"
                                    style={sent[log.id] ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' } : { background: ACCENT, color: '#1a1530' }}>
                                    {sent[log.id] ? <><Check size={12} weight="bold" /> Sent</> : <><PaperPlaneTilt size={12} weight="fill" /> Send to them</>}
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Shell>
    );
};

// ============================================================
//  DIRECTOR PROMPT + PARSER
// ============================================================
// Translates "how long ago was the earliest message" into an acquaintance-duration description for the director to read (a guardrail for flashback time framing)
function describeAcquaintance(firstTs: number | undefined, userName: string, charName: string): string {
    if (!firstTs) {
        return `${charName} and ${userName} have no verifiable history together yet (this may be their first contact).`;
    }
    const days = Math.floor((Date.now() - firstTs) / 86400000);
    let span: string;
    if (days <= 1) span = 'less than a day';
    else if (days < 30) span = `about ${days} days`;
    else if (days < 365) span = `about ${Math.floor(days / 30)} months`;
    else span = `about ${(days / 365).toFixed(1)} years`;
    return `${charName} and ${userName} have known each other for ${span} (${days} days) since first contact.`;
}

// Compresses the performance script into a "readable summary" -- used when sending it
// to the character as a memory (so the character actually knows what happened, instead
// of just receiving one blank, wrapped-up closing line).
function buildMemoryText(s: SimScript): string {
    const lines: string[] = [];
    for (const b of s.beats) {
        if (b.kind === 'end') continue;
        const t = b.time ? b.time + ' ' : '';
        const mono = b.monologue ? `(${b.monologue})` : '';
        if (b.kind === 'thought') { if (b.monologue) lines.push(`${t}Thought: ${b.monologue}`); continue; }
        if (b.kind === 'notification' && b.notif) { lines.push(`${t}${b.notif.app} notification: ${b.notif.title}${b.notif.body ? ' ' + b.notif.body : ''}${mono}`); continue; }
        if (b.kind === 'flashback') { lines.push(`${t}Photos suddenly surfaced ${b.flashback?.label || 'an old photo'}${b.flashback?.caption ? ': ' + b.flashback.caption : ''}${mono}`); continue; }
        if (b.kind === 'lock') { lines.push(`${t}${b.notif ? `Lock screen, ${b.notif.app}: ${b.notif.title}` : 'Glanced at the lock screen'}${mono}`); continue; }
        if (b.kind === 'app' && b.app) {
            const a = b.app; let act = `Opened ${a.name}`;
            if (a.view === 'search' && a.search) act += `, searched: ${a.search.queries.map(q => q.q).join(' -> ')}`;
            else if (a.view === 'compose' && a.compose) act += a.compose.sent ? `, sent "${a.compose.sent}" to ${a.compose.to || 'them'}` : `, typed something and deleted it (${(a.compose.drafts || []).join('; ')})`;
            else if (a.view === 'chat' && a.chat) act += `, with ${a.chat.name}: ${a.chat.lines.map(l => (l.me ? 'Me:' : 'Them:') + l.text).join(' ')}`;
            else if (a.view === 'photo' && a.photo) act += `, looked at a photo${a.photo.caption ? ': ' + a.photo.caption : ''}`;
            else if (a.view === 'music' && a.music) act += `, listened to "${a.music.song}"${a.music.artist ? ' - ' + a.music.artist : ''}`;
            else if (a.view === 'notes' && a.notes) act += `, notes: ${(a.notes.items || []).join('; ')}`;
            else if (a.view === 'browser' && a.browser) act += `, tabs: ${(a.browser.tabs || []).join('; ')}`;
            else if (a.view === 'weather' && a.weather) act += `, checked the weather (${a.weather.temp}° ${a.weather.desc})`;
            else if (a.text) act += `: ${a.text}`;
            lines.push(`${t}${act}${mono}`);
        }
    }
    let text = lines.join('\n');
    if (text.length > 3200) text = text.slice(0, 3200) + '...';
    return text;
}

// "This performance's variation" -- randomly draws a few axes as hard constraints each
// time, to break the fixed wake-up -> scroll phone -> sleep routine
const vPick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
// The candidate pool of "emotional undertones" for each tone (feeling down is the shared baseline; the difference is in the top-layer brushstrokes)
const MOOD_POOLS: Record<'depressive' | 'darkhumor' | 'cute', string[]> = {
    depressive: [
        'calm and numb, emotions running almost flat', 'a faint irritation, hard to say why',
        'numb, detached, like everything is behind glass', 'missing a specific person or moment',
        'low-grade anxiety, repeatedly double-checking some small thing', 'self-deception, saying one thing while doing another',
    ],
    darkhumor: [
        'turns the situation into a bit, the more absurd the more they want to crack jokes about it', 'does something ridiculous with dead-serious composure, and finds it funny themselves',
        'defuses everything with teasing and self-deprecation, nothing is off-limits for a joke', 'talks about upsetting things like they are no big deal, with a streak of deadpan humor',
        'neurotically funny, head full of strange thoughts', 'schadenfreude toward their own mess, the dark jokes don\'t stop',
    ],
    cute: [
        'a streak of silliness and playfulness in their behavior', 'taking something trivial way too seriously, cute and funny',
        'a childish little stubbornness, like a kid who never grew up', 'entertaining themselves, finding small, pointless, happy little things to do',
        'lighthearted, weirdly fixated on small things', 'jumpy and lively, wearing every emotion on their face',
    ],
};

function buildVariation(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix'): string {
    const entry = vPick([
        'Cut in at an unremarkable in-between moment (never start with "waking up / getting out of bed / turning off the alarm")',
        'Cut in during a sleepy, unfocused afternoon moment',
        'Cut in at dusk, when it is almost dark and the lights are not on yet',
        'Cut in late at night, unable to sleep, lighting up the screen for the umpteenth time',
        'Cut in during a commute / on the go, scrolling one-handed',
        'Cut in at the moment of being suddenly interrupted by a notification',
        'Cut in partway through something already half-done',
    ]);
    const span = vPick([
        'The whole performance covers just one dense, narrow slice of ten-odd minutes',
        'Covers only a few scattered gaps within one half-day',
        'Loops back to the same moment repeatedly (time barely moves, the mind circles in place)',
        'Spans a short stretch from late night to just before dawn',
        'Three or four disconnected fragments from one day, jumping between them',
    ]);
    const structure = vPick([
        'The whole performance revolves almost entirely around "one App," rarely leaving it',
        'The whole performance circles around "one small object / one unread message / one old photo"',
        'Bounces back and forth repeatedly between two unrelated things',
        'Heavy on blank space, almost nothing happens, carried by atmosphere and fragmentary actions',
        'Interrupted by a sudden event (an incoming call / notification / dead battery), and never returns to what came before',
        'Linear but restrained, advanced by detail rather than plot',
    ]);
    const medium = vPick([
        'Mainly expressed through "search then delete, delete then search"',
        'Mainly expressed through "flipping through old photos"',
        'Mainly expressed through the repeated cycle of "type -> delete -> type again"',
        'Mainly expressed through "one song on repeat + zoning out"',
        'Mainly expressed through "half-hearted, on-and-off chatting with one contact"',
        'Mainly expressed through "a pile of environmental fragments unrelated to the main thread (notifications / to-dos / browser tabs / shopping cart)"',
    ]);
    const moodPool = tone === 'mix'
        ? [...MOOD_POOLS.depressive, ...MOOD_POOLS.darkhumor, ...MOOD_POOLS.cute]
        : MOOD_POOLS[tone];
    const mood = vPick(moodPool);
    const anchor = vPick([
        'a cup of coffee/tea that went cold long ago', 'a message that was typed but never sent', 'a screenshot that was forgotten and never deleted',
        'a to-do that has sat there for half a year', 'a song stuck on repeat', 'a group chat no one ever replies in',
        'a package tracking page', 'a page that keeps getting opened and closed again', 'a photo saved long ago and never looked at again',
        'a draft deleted halfway through',
    ]);
    return `### [This Performance's Variation · Must be followed strictly, make this one clearly different from the last]
- Entry point: ${entry}
- Span: ${span}
- Structure: ${structure}
- Dominant medium: ${medium}
- Emotional undertone: ${mood}
- Specific anchor: have this performance repeatedly return to "${anchor}" (can be rewritten into a similar small object that better fits the character)
* Strictly forbidden to fall into cliche: don't open with "waking up / turning off the alarm / checking the weather," don't default to closing with "going to sleep / locking the screen," and definitely don't do a "wake up -> scroll WeChat and Weibo for a bit -> sleep" routine. The field examples below only demonstrate the JSON format -- the actual time and content should always follow this performance's variation.`;
}

// The three tiers of user presence (how much weight "you" carry in this day)
function buildPresenceRule(presence: 'default' | 'light' | 'none', userName: string): string {
    const u = userName || 'the user';
    switch (presence) {
        case 'none':
            return `Today is **entirely their own life**: ${u} does not appear, is not thought of, is not sought out. Even if their memory includes ${u}, ${u} absolutely does not surface today. All messages, thoughts, and traces are made up entirely of their own life and other people -- ${u} must never appear, be hinted at, or be dwelt on.`;
        case 'light':
            return `${u} is only **an extremely faint background presence** -- the whole performance centers on them alone. At most, an old message from ${u} or a fleeting thought about ${u} may pass by briefly and no more -- never becomes a focus, never gets developed, never lets the scene orbit around ${u}.`;
        default:
            return `${u} is **a thread that naturally exists** in their life -- there can be messages from ${u}, thoughts of ${u}, traces of ${u} in the environment, consistent with how they normally talk; but ${u} is not present right now -- do not speak or act on ${u}'s behalf.`;
    }
}

// Performance tone: feeling down is always the baseline, the difference is in the top-layer brushstrokes
function buildToneRule(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    switch (tone) {
        case 'depressive':
            return `[This Performance's Tone: Melancholic] Pure low pressure -- numb, dull, restrained, running flat. No comic relief, no playfulness -- let the emotion steep quietly.`;
        case 'darkhumor':
            return `[This Performance's Tone: Dark Humor] Needs to have a **neurotic funniness** -- self-aware self-deprecation, turning upsetting things into bits, doing something absurd with dead-serious composure, the more ridiculous the funnier. Think of the flavor of "Andy and Lily's Coffin": a cute surface, an absurd core, catching you off guard now and then. The delivery can be biting, jumpy, and unable to stop.`;
        case 'cute':
            return `[This Performance's Tone: Light & Cute] The brushstrokes are **playful, light, with a bit of silliness and cuteness** -- making a big deal out of small things, childish little stubbornness, entertaining themselves, getting weirdly fixated on boring little things. That pixel-cute, lively, adorable feel -- the whole thing light and never oppressive.`;
        default:
            return `[This Performance's Tone: Freeform] The tone flows naturally with the "emotional undertone" -- can be calm, can be dark humor, can be playful and light; allowed to have ups and downs within a single performance, doesn't need to lock into one fixed emotion.`;
    }
}

function buildDirectorPrompt(context: string, recent: string, mode: 'daily' | 'event', theme: string, name: string, acquaintance: string, userName: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    return `${context}

### [Recent Chat Context]
${recent || '(No recent conversation yet)'}

### [Director's Brief: Screenlife Performance]
You are now an immersive narrative director. Please stage a slice of "${name}"'s life as a **first-person performance carried entirely through their phone**.
Experience type: ${mode === 'daily' ? 'Daily Simulation (an ordinary day, emphasizing everyday life and companionship)' : 'Event Simulation (a special event, emphasizing emotional tension)'}
Experience content: "${theme}"
Relationship timeline (important guardrail): ${acquaintance}
Your presence (${userName || 'the user'}'s place in this day · must be strictly followed): ${buildPresenceRule(presence, userName)}
${buildToneRule(tone)}

The audience (the user) will **become ${name}**, personally living through this stretch of time via how they use their phone.

${buildVariation(tone)}

[Iron Rules]
1. Don't narrate the story out loud, don't explain the character, don't analyze emotions, don't sum up the meaning. Everything comes through naturally via **phone behavior / digital traces / inner monologue / environmental fragments**.
2. Inner monologue (monologue) should appear **heavily**, but be **extremely colloquial, short, and real**, like actual human brain activity. Examples: "Don't want to get up." "Whatever." "Why hasn't she texted back yet." "Should be fine, right." "Actually kind of bothered by it." No literary tone, no explaining the plot.
3. **Unreliable narration**: what they say/think is not necessarily the truth -- self-soothing, self-deception, avoidance, romanticized memory, and misreading other people are all allowed. Let the actions expose the monologue (e.g. saying "I really don't care" while repeatedly reopening the same chat window).
4. **Digital behavior first**: express through "typing then deleting (compose)," "searching then deleting and searching again (search)," "scrolling through old photos," "repeatedly reopening the same page," "recalling a sent message" rather than stating emotions directly.
5. **A real-phone feel**: intersperse real phone events unrelated to the main thread -- an incoming call, low battery, a verification code, a delivery notification, spam texts, a weather alert, an auto-renewal, various push notifications. They don't have to drive the plot, but they add realism.
6. **Environmental fragments**: traces unrelated to the main thread can appear -- an unfinished to-do, a screenshot from half a year ago, a forgotten-to-delete photo, a pile of browser tabs, a shopping cart, an old alarm, a bookmarks folder. Together these paint their personality.
7. **Slow the pace at emotional peaks**: at key moments, build tension with a repeating beat sequence like "open -> close -> reopen -> pause -> lock screen -> reopen -> type -> delete -> type -> delete -> finally send (or don't)," and set the pace of these beats to 3.
8. [Memory Flashback · Always judge whether it's plausible first -- better to skip it than go out of character] A flashback is **a fragment of ${name}'s own past suddenly breaking into the present** (Photos auto-surfaces an old picture -> silence -> nothing said -> the day continues -- the impact comes from "the past breaking into the present"). But whether to include one, and what time framing to use, must strictly fit the character and setting:
   - The time label is yours to decide, and must stay consistent with the "relationship timeline" above and the character's own life stage/setting. For example, only use "this day last year" if they've genuinely known each other over a year; use "three months ago today" or "that day" for a few months; if they've just met or the timeline doesn't support it, **never** use "last year."
   - The photo doesn't have to involve the user -- it can be an earlier slice of ${name}'s own life (a place, a person, an object).
   - If the character's setting/worldbuilding has no concept of "taking photos / a modern sense of time / a traceable past," or any flashback would feel jarring and out of character, **don't add a flashback beat at all**.
   - ${mode === 'event' ? 'Under Event Simulation, if it fits, prioritize including one flashback to intensify the emotion; skip it if it does not fit.' : 'Under Daily Simulation, only work one in at some quiet, plausible moment -- optional either way.'}

[Turn It Up · Density / Intensity / Specificity (this section is the highest priority, do not hold back)]
- **Make it long, make it full**: this is a complete performance, not a trailer. Give it a full **40-64 beats** -- varied in density, but err on the side of more, not fewer.
- **Every step has drama**: the vast majority of beats should carry a monologue; monologues can chain together -- pair one action with 2-3 jumpy, conflicting thoughts, so the mind really feels like it's "spinning."
- **Be relentlessly specific**: use real names, store names, song titles, amounts, times, verbatim dialogue, actual search terms. **Reject** vague placeholders like "someone / something / a message / a song" -- every detail should feel like it really happened, enough to add up to a real, living person.
- **Pile on the digital behavior hard**: compose's "typed then deleted" should happen at least 2-3 times with a different draft each time; search's "searched then deleted" should be at least one string of 3-4 escalating queries (getting more revealing the more they search); interweave recalled messages / repeatedly reopening the same page / read-but-no-reply / them "typing..." and then stopping.
- **The climax needs to be long and suffocating enough**: stretch the key moment into **8-12 consecutive beats** (open -> close -> reopen -> pause -> lock screen -> reopen -> type -> delete -> type -> delete -> ... -> finally sent or finally not sent), pace=3 throughout, really grinding out that "finger hovering over the send button" feeling.
- **Pile the environmental fragments on thick**: what's sitting in the shopping cart, what a to-do from half a year ago says, which tabs are open in the browser, what day some photo in the album is from -- specific enough to sting.
- **Dare to be unflattering**: real people zone out, double-check things obsessively, deceive themselves, and suddenly break down over something small. Don't clean them up or restrain them into a blank page for their sake -- let them be a mess when it's called for, let them spiral when it's called for.
- **The ending needs to "land," not "cut to black"**: after the climax there **must** be 3-6 beats of resolution -- the emotion slowly settling, one final small action (putting the phone down / turning off the light / one last look at that message / gently locking the screen), pace dropping back to 1-2; use the second-to-last beat's thought or a lock beat to give the whole performance an emotional landing point, so the audience truly feels "this chapter is over." **Never let it stop mid-action or right at the peak of the climax and call that the end.** end is always the final beat after the resolution, never a slammed brake.

[Output Format] Output strictly **one JSON object** (no extra text, no markdown code block), structured as follows:
{
  "title": "the performance's title (e.g.: An Ordinary Tuesday)",
  "ending": "optional, a label for this particular ending version (e.g.: Never Sent)",
  "summary": "1-2 closing sentences, objective, leaves things unsaid, no explaining",
  "buff": { "name": "English key", "label": "emotion label (short phrase)", "emoji": "1 emoji", "color": "#hex", "intensity": 1|2|3, "description": "one sentence describing the emotional undertone, for the AI to read" },
  "beats": [ ... 40-64 beats, err on the side of more ... ]
}

Each beat is an object that must include "kind," and as needed "time" (HH:MM), "monologue," "pace" (1 normal / 2 slightly slow / 3 climax), and "vibe."
**"vibe" determines the visual performance of this text** -- please tag thought / key monologues based on their emotional state at that moment. Values:
  - "calm" -- calm (default, text types out slowly, centered)
  - "chaotic" -- chaotic breakdown (text scatters across the whole screen -- the messier the emotion, the more fitting)
  - "happy" -- happy (pink text + little decorations floating up)
  - "anxious" -- anxious (text tense, reddened, subtly pulsing)
  - "numb" -- numb and hollow (text cold, shrunken, lots of blank space)
  - "tender" -- tender/wistful (soft glow)
kind values and fields:
- {"kind":"lock","time":"07:12","notif":{"app":"Alarm","title":"...","body":"..."},"monologue":"Don't want to get up."}  // lock screen/screen wakes up
- {"kind":"thought","monologue":"Whatever.","vibe":"numb"}  // pure inner monologue; always give a vibe when the emotion is strong (e.g. breakdown -> "chaotic," elated -> "happy")
- {"kind":"notification","notif":{"app":"WeChat","title":"...","body":"...","tone":"push|sms|system|flashback"},"monologue":"..."}  // banner notification
- {"kind":"app","app":{"name":"WeChat","view":"chat","chat":{"name":"Mom","lines":[{"me":false,"text":"Have you eaten"},{"me":true,"text":"Yeah"}]}}}
- {"kind":"app","app":{"name":"WeChat","view":"compose","compose":{"to":"Her","drafts":["You there","Have you been okay lately"],"sent":null}}}  // typed then deleted; sent=null means it was never sent, a string value means it was sent
- {"kind":"app","app":{"name":"Search","view":"search","search":{"engine":"Baidu","queries":[{"q":"what to do about insomnia","deleted":true},{"q":"can chronic sleep loss kill you","deleted":true},{"q":"why do cats meow at night"}]}}}
- {"kind":"app","app":{"name":"Photos","view":"photo","photo":{"caption":"...","date":"2024-06-19","tint":"#5a6a7a"}}}
- {"kind":"app","app":{"name":"Music","view":"music","music":{"song":"...","artist":"...","state":"On repeat"}}}
- {"kind":"app","app":{"name":"Notes","view":"notes","notes":{"title":"To-do","items":["...","..."]}}}
- {"kind":"app","app":{"name":"Browser","view":"browser","browser":{"tabs":["...","..."]}}}
- {"kind":"app","app":{"name":"Weather","view":"weather","weather":{"city":"...","temp":22,"desc":"Cloudy"}}}
- {"kind":"flashback","time":"15:00","flashback":{"label":"Three months ago today","caption":"...","date":"...","tint":"#4a3a5a"},"monologue":""}  // memory flashback (optional), label = a self-consistent time framing, empty monologue = silence
- {"kind":"end","time":"23:40"}  // the last beat must be end

Please strictly follow the [This Performance's Variation] above, and really absorb the [Turn It Up] section: give it a full 40-64 beats, dense monologue, specific detail, repeated digital behavior, a drawn-out climax, and a properly landed ending. **The JSON must be fully closed and properly wrapped up** -- if space is tight, cut a few beats from the middle rather than skimp on the ending, and close every bracket -- never allow it to be cut off partway through. Output the JSON object directly.`;
}

export default PersonaSim;
