import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, CharacterBuff, UserProfile } from '../types';
import type { DreamArchetype, DreamFragment, DreamScript, DreamLog } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { isDevDebugAvailable } from '../utils/devDebug';
import { useDreamSim, dreamSimStore } from '../utils/dreamSimStore';
import { safeResponseJson } from '../utils/safeApi';
import CdnImg from '../components/os/CdnImg';
import { trackEvent } from '../utils/analytics';
import {
    CaretLeft, MoonStars, ArrowClockwise, X, Eye, Sparkle, Lock, Question, Trash,
} from '@phosphor-icons/react';

// ============================================================
//  Dream Theater · Dream sequence system
//  Sneak a peek in the Dwelling at a dream the character has already forgotten.
//  Dreams aren't realistic or coherent, and moderate hallucination is allowed —
//  presented as collage poetry / film subtitles / memory fragments — the blank
//  space and silence themselves are the performance.
//  Input: ContextBuilder(false) + Memory Palace (if enabled) + recent context (default 500 / per-character setting)
//  Output: a dream sequence + an emotion buff (mirrors the Check Phone PersonaSim performance)
// ============================================================

export interface DreamApiConfig { apiKey: string; baseUrl: string; model: string; }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Deterministic pseudo-random (seeded) — the same fragment scatters consistently on every render
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const SERIF = "'Shippori Mincho','Noto Sans SC',serif";
const MONO = "'SF Mono','Roboto Mono',ui-monospace,monospace";

// ============================================================
//  ARCHETYPE THEMES — each dream type sets the base color, decoration, and font mood
// ============================================================
type Ambient = 'stars' | 'petals' | 'bubbles' | 'feathers' | 'dust' | 'sparkle' | 'none';
interface DreamTheme { label: string; sub: string; accent: string; bg: string; ambient: Ambient; serif?: boolean; }

const THEMES: Record<DreamArchetype, DreamTheme> = {
    sweet:     { label: 'Sweet Dream',     sub: 'Sweet Dream',     accent: '#ffc2e0', bg: 'radial-gradient(130% 90% at 50% 20%, #3a2436 0%, #1c1620 60%, #120e16 100%)', ambient: 'sparkle', serif: true },
    nightmare: { label: 'Nightmare',       sub: 'Nightmare',       accent: '#ff5f6d', bg: 'radial-gradient(120% 100% at 50% 0%, #2a0f12 0%, #100608 55%, #050304 100%)', ambient: 'dust' },
    flower:    { label: 'Flower Dream',    sub: 'Flower Dream',    accent: '#a8e6a0', bg: 'radial-gradient(130% 90% at 50% 25%, #1f3326 0%, #15211a 60%, #0d130f 100%)', ambient: 'petals', serif: true },
    flying:    { label: 'Flying Dream',    sub: 'Flying Dream',    accent: '#9fd8ff', bg: 'radial-gradient(140% 100% at 50% 10%, #1d2c40 0%, #14202f 55%, #0b1018 100%)', ambient: 'feathers', serif: true },
    falling:   { label: 'Falling Dream',   sub: 'Falling Dream',   accent: '#9a8cff', bg: 'linear-gradient(180deg, #221c3a 0%, #15102a 45%, #0a0712 100%)', ambient: 'dust' },
    starry:    { label: 'Starry Dream',    sub: 'Starry Dream',    accent: '#cdd6ff', bg: 'radial-gradient(130% 110% at 50% 0%, #161a3a 0%, #0c0e22 55%, #05060f 100%)', ambient: 'stars', serif: true },
    ocean:     { label: 'Ocean Dream',     sub: 'Ocean Dream',     accent: '#6fd3e0', bg: 'radial-gradient(130% 110% at 50% 80%, #103040 0%, #0a1d2a 55%, #060f16 100%)', ambient: 'bubbles', serif: true },
    childhood: { label: 'Childhood Dream', sub: 'Childhood Dream', accent: '#ffd98a', bg: 'radial-gradient(130% 95% at 50% 25%, #34281a 0%, #211a12 60%, #14100b 100%)', ambient: 'dust', serif: true },
    anxiety:   { label: 'Anxiety Dream',   sub: 'Anxiety Dream',   accent: '#ff9a9a', bg: 'radial-gradient(120% 100% at 50% 50%, #2a1f22 0%, #181214 60%, #0d0a0b 100%)', ambient: 'none' },
    forgotten: { label: 'Forgotten Dream', sub: 'Forgotten Dream', accent: '#c9cdd6', bg: 'radial-gradient(130% 100% at 50% 40%, #232529 0%, #16171a 60%, #0c0d0f 100%)', ambient: 'dust', serif: true },
    prophetic: { label: 'Prophetic Dream', sub: 'Prophetic Dream', accent: '#c9a8ff', bg: 'radial-gradient(130% 100% at 50% 15%, #271a3a 0%, #181029 60%, #0d0816 100%)', ambient: 'sparkle', serif: true },
    lucid:     { label: 'Lucid Dream',     sub: 'Lucid Dream',     accent: '#7ef0d0', bg: 'radial-gradient(140% 110% at 50% 30%, #15302e 0%, #0e201f 55%, #081413 100%)', ambient: 'sparkle' },
    deepsleep: { label: 'Deep Sleep',      sub: 'Deep Sleep',      accent: 'rgba(255,255,255,0.35)', bg: 'radial-gradient(120% 120% at 50% 50%, #0a0b10 0%, #050608 70%, #000 100%)', ambient: 'none', serif: true },
};

// Fixed order for the selector/debug tool, with a "corrected sequential numbering."
// (The original spec's numbering had a gap: after 10 Forgotten it jumped straight to
//  12 Prophetic, 13 Lucid, skipping 11; here they're numbered sequentially in the
//  correct order instead: Prophetic=11, Lucid=12, with Deep Sleep as a hidden entry not counted.)
const ALL_ARCHETYPES: DreamArchetype[] = [
    'sweet', 'nightmare', 'flower', 'flying', 'falling', 'starry',
    'ocean', 'childhood', 'anxiety', 'forgotten', 'prophetic', 'lucid', 'deepsleep',
];
// The number shown on the test-selector tile (Deep Sleep is the hidden entry → shows "Hidden" instead of a number)
const archetypeNo = (a: DreamArchetype): string =>
    a === 'deepsleep' ? 'Hidden' : String(ALL_ARCHETYPES.indexOf(a) + 1).padStart(2, '0');

// Hidden-entry (Deep Sleep) drop rate: roughly 1 in every 12 dreams.
const DEEPSLEEP_RATE = 1 / 12;
/**
 * The app picks the archetype (no longer letting the model choose for itself — it
 * likes to roll the same one over and over, and almost never lands on the hidden entry).
 * Rule: first roll for the hidden entry per DEEPSLEEP_RATE; otherwise draw evenly from
 * the 12 regular archetypes while **avoiding the last 3 that appeared**, so the same
 * dream type doesn't repeat back-to-back. dreamLogs is newest-first.
 */
const rollArchetype = (logs: { archetype: DreamArchetype }[] = []): DreamArchetype => {
    if (Math.random() < DEEPSLEEP_RATE) return 'deepsleep';
    const pool = ALL_ARCHETYPES.filter(a => a !== 'deepsleep');
    const recent = logs.slice(0, 3).map(l => l.archetype);
    const fresh = pool.filter(a => !recent.includes(a));
    const candidates = fresh.length > 0 ? fresh : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
};

// ============================================================
//  Blind Box Collection (Dream Blind Box) — finishing a dream draws the matching
//  archetype's cat, collect them all into the album.
//  Image hosting follows the project's usual convention (jsDelivr, same as seasonal
//  events), filenames with spaces need encoding.
// ============================================================
// Repo-relative path prefix (filenames contain spaces, encodeURIComponent'd then handed
// to CdnImg for multi-CDN mirror fallback).
const DREAM_BOX_DIR = 'img/DREAMS/';
const DREAM_BOX_FILE: Record<DreamArchetype, string> = {
    sweet: '01 Sweet Dream .png',
    nightmare: '02 Nightmare .png',
    flower: '03 Flower Dream.png',
    flying: '04 Flying Dream.png',
    falling: '05 Falling Dream .png',
    starry: '06 Starry Dream.png',
    ocean: '07 Ocean Dream.png',
    childhood: '08 Childhood Dream.png',
    anxiety: '09 Anxiety Dream.png',
    forgotten: '10 Forgotten Dream .png',
    prophetic: '11 Prophetic Dream .png',
    lucid: '12 Lucid Dream.png',
    deepsleep: 'Deep Sleep .png',
};
const boxPath = (a: DreamArchetype): string => DREAM_BOX_DIR + encodeURIComponent(DREAM_BOX_FILE[a]);

// Blind box series (just this one for now; structure kept so it's easy to expand into multiple sets later)
const DREAM_BOX_SERIES = { id: 'dreamcats-01', title: 'Little Dreams · Meow Dream Blind Box', sub: 'Dream Cats' };

// Collection album: account-level, localStorage. Records each archetype's first-unlock time and total draw count (including repeats).
const DREAM_COLLECTION_KEY = 'os_dream_collection';
type DreamCollection = Record<string, { firstAt: number; count: number }>;
function loadCollection(): DreamCollection {
    try { return JSON.parse(localStorage.getItem(DREAM_COLLECTION_KEY) || '{}') || {}; } catch { return {}; }
}
function unlockCollectible(a: DreamArchetype): { collection: DreamCollection; isNew: boolean; count: number } {
    const cur = loadCollection();
    const prev = cur[a];
    const count = (prev?.count || 0) + 1;
    const next: DreamCollection = { ...cur, [a]: { firstAt: prev?.firstAt || Date.now(), count } };
    try { localStorage.setItem(DREAM_COLLECTION_KEY, JSON.stringify(next)); } catch { }
    return { collection: next, isNew: !prev, count };
}

// Blind box cat image (with a fallback background so it doesn't look broken while loading)
const BoxCat: React.FC<{ archetype: DreamArchetype; size?: number; className?: string }> = ({ archetype, size = 128, className }) => (
    <div className={`relative flex items-center justify-center ${className || ''}`} style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-2xl" style={{ background: `radial-gradient(circle at 50% 40%, ${THEMES[archetype].accent}22, transparent 70%)` }} />
        <CdnImg path={boxPath(archetype)} alt={THEMES[archetype].label} loading="lazy"
            className="relative w-full h-full object-contain"
            style={{ filter: 'drop-shadow(0 8px 22px rgba(0,0,0,0.45))' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
    </div>
);

// ============================================================
//  GENERATION — build the director prompt, call the model, parse the result
// ============================================================
export async function generateDreamScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: DreamApiConfig;
    forcedArchetype?: DreamArchetype; // Local testing only: force a specific archetype (admin debug directive)
}): Promise<DreamScript> {
    const { char, userProfile, apiConfig, forcedArchetype } = opts;
    // Memory Palace: gates itself internally via memoryPalaceEnabled, a no-op when disabled
    await injectMemoryPalace(char, undefined, undefined, userProfile.name);
    // Explicit requirement: contextBuilder(false) — no detailed memory for the current month, just the character's core profile
    const context = ContextBuilder.buildCoreContext(char, userProfile, false, char.memoryPalaceInjection);
    const msgs = await DB.getMessagesByCharId(char.id);
    // Recent context: 500 by default, follows the character's contextLimit setting from the chat app
    const ctxLimit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');

    const prompt = buildDreamPrompt(context, recent, char.name, userProfile.name, forcedArchetype);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        // Dreams encourage heavy hallucination → temperature pushed to the safe ceiling. Note
        // temperature caps at 1.0: the Anthropic/Claude relay's valid range is 0~1, anything
        // above 1 errors outright (OpenAI allows up to 2, but 1.0 is already divergent enough).
        // max_tokens uses 8192: a dream is a pile of short fragments, plenty; 16000 would 400
        // on models like claude-3.5 whose output cap is 8192. Still has a
        // "finish_reason === 'length' → truncated" fallback.
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 1.0, max_tokens: 8192 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Dream generation was truncated');
    const parsed = parseDream(data.choices[0].message.content);
    if (!parsed || !parsed.archetype) throw new Error('parse');
    // Deep Sleep (hidden) is allowed to have no fragments — silence itself is the performance; other dreams must have fragments
    if (parsed.archetype !== 'deepsleep' && !(parsed.fragments?.length)) throw new Error('Dream came back empty');
    if (!parsed.fragments) parsed.fragments = [];
    return parsed;
}

function buildDreamPrompt(context: string, recent: string, name: string, userName: string, forcedArchetype?: DreamArchetype): string {
    // The archetype is drawn and force-specified by the app side (guarantees variety and the hidden-entry drop rate, doesn't let the model self-select).
    const adminOverride = forcedArchetype ? `

### [Tonight's Dream Archetype · Set by the system · Highest priority]
**Mandatory**: the archetype field must be "${forcedArchetype}" (${THEMES[forcedArchetype].label}).
Ignore every constraint below about automatic selection and appearance probability in "Dream Archetypes" and "Hidden Archetype" — tonight's dream is a "${THEMES[forcedArchetype].label}", written in that archetype's mood. Every other writing requirement still applies as normal.
` : '';
    return `${context}${adminOverride}

### [Recent Events · The main trigger for this dream (day residue becomes night dreams) · Never copy the source text verbatim]
${recent || '(No recent conversation yet)'}

### [Director's Brief: Dream Theater]
You are not writing a story. The audience is **secretly watching a dream that "${name}" already had, and has since forgotten upon waking**.
Because ${name} doesn't remember this dream at all, it's free to expose subconscious longings, fears, people long gone, impossible places, things that will never happen.

[This is "${name}"'s own subconscious as an individual · Very important]
- This dream is **${name}'s own private inner universe alone**: their background, childhood, core personality, private obsessions and fears, who they want to become, the people and things they can't let go of, everything that belongs to them within the setting/worldbuilding — the dream should grow out of **these things**.
- **Do not turn the dream into "a dream about ${userName}."** ${userName} is not the protagonist of the dream, not its center, not its theme. In the vast majority of fragments, **${userName} shouldn't appear at all**.
- ${userName} may appear at most as a **fleeting, faint afterimage** once or twice (an echo of a name, a half-remembered line spoken by someone) — and must be fragmented and symbolized, never allowed to become the focus or subject of any single fragment.
- Prioritize digging into their own subconscious: family of origin, the past, unfinished business, identity, loneliness, desire, their private view of the world. Someone reading it should come away feeling "this is a dream that belongs to ${name}," not "this is a dream about ${name} wanting ${userName}."

[Day Residue · This dream is heavily shaped by "Recent Events" · Equally important]
- Day residue becomes night dreams: "Recent Events" above is the **main trigger** for this dream. Events from the last few days, things said, unresolved feelings, things dwelt on repeatedly, images still on their mind before falling asleep — all of it **strongly** seeps into tonight's dream, transformed and replayed.
- But what you want is the **emotion, theme, and unresolved tension** of those events, not the events themselves: **fragment, exaggerate, transplant, and symbolize** them, letting some small daytime thing grow into an absurd, oversized dream scene, or a fragment that keeps flashing back.
- Reconcile this with "don't orbit around ${userName}": even if recent events are mostly about ${userName}, pull only the **emotion and underlying issue** out of them and feed it into their own inner universe — **don't** put ${userName} onstage as the protagonist. Example: felt down during the day over something → dream of a staircase that never ends, not a dream of ${userName} in person.

[Highest Principle · Heavy hallucination and collage poetry]
- This is a dream — **the less logic, the better**. Don't be afraid of disorder — **chaos, disarray, jump cuts, and self-contradiction are the beauty of dreams**; making too much sense is boring instead. Images don't need causality, transitions, or explanations between them — cut hard, juxtapose, and collide directly.
- The dream **need not conform to reality, timelines, or established setting at all**. Objects can talk, colors can have weight, time can run backward, one place can nest inside another, the same person can be different ages at once, the moon can fit in a pocket, a cat can become a staircase, a sentence can turn into another sentence halfway through. **Never explain** these impossibilities — treat them as self-evident.
- Boldly create **ruptures in meaning**: one fragment and the next can be completely unrelated, letting the audience fill the gap themselves. Better baffling than bland, better broken than smooth.
- Use **collage poetry** as the primary language: juxtapose unrelated emotional images and let meaning surface on its own, rather than narrating what happened. Beauty comes from juxtaposition, blank space, and negative space — not explanation.
- Draw from two sources: "${name}'s own setting / memories / inner self" and "recent events (day residue)" — the latter is tonight's trigger and should be drawn on heavily; use both **fragmented, transformed, and symbolized** — never restate facts directly or turn it into a coherent narrative.

[Writing Style · Must follow]
- **Fragments, not paragraphs.** Like film subtitles, drifting thoughts, found lines of poetry. Give only one or two images at a time.
  Good examples: "Ocean." "Cold shoes." "A bird flying backward." "Your voice." "The door is smiling."
  Bad example (forbidden): "I dreamed I was walking on a beach, and then..."
- Use single words, broken sentences, repetition, and blank space heavily. **Silence is part of the dream** — arrange silence fragments (roughly 1/5 of the total, scattered throughout is recommended).
- Emotion over logic: let the audience feel first, understand (maybe never) second. Confusion is fine; beauty outranks explanation, mystery outranks certainty.
- **The ending must never resolve, summarize, or spell out a moral.** Dreams have no ending — it's fine for it to cut off mid-scene at its most absurd, vanish in a half-finished word, or sink into blank space. The last fragment or two are **strictly forbidden** from containing lines like "And so..." "I finally understood..." "It all came together as..." "So that's what it was..." — anything that explains or elevates the whole dream. It should stop like **a power cut**, which is more right than a neat, tidy ending.
- **The best form for an ending: a word-salad collage.** Throw together a string of words that are **completely random yet vaguely related to this dream** — no sentence, no grammar, no logic, no explanation, like the last flicker of words before consciousness cuts out. Carry it with a \`line\` (or a few \`word\`s), separating words with spaces / slashes / middle dots. Example: "keys sea salt mother's silhouette Tuesday battery died stairs／stairs／stairs" or "red late whale summer in a drawer mm." These words should be randomly pulled and recombined from images that appeared earlier and from the day residue, making it feel both familiar and deranged. Then (optionally) cap it off with one more silence fragment.
- **These fragments get collaged and accumulated one by one on the same canvas, seen together (not one line per screen like a slideshow)**. So think of it like making a collage or a scrapbook: let neighboring fragments juxtapose and collide with meaning; alternate freely between different kinds (line/word/silence/repeat/dialogue/stage/list/screenplay/diary/message/image in rotation — don't use the same one back to back).
- **The essence of collage poetry lives "within a single line"**: make the words in one sentence feel like they were cut from different places — juxtapose words from different contexts, different emotional temperatures, in the same sentence, yet have it read as if it just works. Example: "Your voice is a damp staircase." "I folded Sunday into a drawer." There should be slight misalignment and surprise between words, not smooth, flat prose. (Visually, each character gets rendered in a different font/size/angle — you just need to write the "heterogeneous juxtaposition" into the text itself.)
- Make good use of emphasis (whisper / loud / fade) and align (left/center/right) to create layers of size and left-right scatter — this is exactly the visual skeleton of collage poetry.
- image fragments **exist purely as text-conjured imagery**: it's just a collage-poem-style caption (like "a bird flying backward" or "a clock halfway melted"), **conjured entirely through language**. Don't describe a concrete picture that would need to be drawn — the frontend won't render any image placeholder — so the caption itself must be beautiful and stand on its own. If there's no caption, don't use the image kind.

[Dream Archetypes · Must pick exactly 1] (archetype field)
sweet — Sweet Dream (warmth / desserts / a soft smile) · nightmare — Nightmare (being chased / monsters / a dark hallway / an unfinished scream) · flower — Flower Dream (a sea of flowers / rain / gentle healing / growth) · flying — Flying Dream (floating / sky / weightlessness / freedom) · falling — Falling Dream (endless falling / losing control / a landing that never comes) · starry — Starry Dream (galaxies / moonlight / infinite distance / loneliness) · ocean — Ocean Dream (tides / whales / deep water / the unknown beneath the surface) · childhood — Childhood Dream (the old house / parents / summer afternoons / things that no longer exist / nostalgia) · anxiety — Anxiety Dream (exams / being late / a lost phone / missing the bus / everything about to go wrong) · forgotten — Forgotten Dream (blurred / incomplete / names disappearing / a sentence stopping halfway / dissolving even as you remember it) · prophetic — Prophetic Dream (déjà vu / doors / keys / mirrors / premonitions / heavy with meaning yet never explained) · lucid — Lucid Dream (the dreamer realizes it's a dream / reality can be edited / the dream talks back / the world can be reshaped / playful and self-aware)
The chosen archetype must shape the content, pacing, word choice, and presentation.

[Hidden Archetype · Deep Sleep (deepsleep)] (use it **rarely** — roughly 1 in every 10~12 times; don't give it every time)
If ${name} falls into a dreamless deep sleep tonight: set archetype to "deepsleep", **fragments to an empty array []**, and afterglow to one very faint line like "slept deeply, dreamed of nothing." No narrative, no imagery, only peaceful rest. The silence itself is the reward.

[Emotion Buff] (buff field)
After waking, ${name} doesn't remember the dream's content, but a layer of hard-to-name emotional residue lingers. Give an emotion buff that matches this dream's mood.

### [Output Format]
Output strictly **one JSON object** (no extra text, no markdown code block):
{
  "archetype": "one of the 13 English keys above",
  "title": "the dream's title (can be obscure and poetic, 4-12 characters)",
  "afterglow": "a lingering, hard-to-name physical sensation/feeling upon waking (e.g. \\"throat tight\\" \\"like something was lost\\"), **must never summarize or explain the dream**, no moral, no plot recap (1 sentence, leave it spare)",
  "buff": { "name": "English key", "label": "emotion label (short phrase)", "emoji": "1 emoji", "color": "#hex", "intensity": 1|2|3, "description": "one sentence describing the emotional undertone, for the AI to read" },
  "fragments": [ ... 18-40 fragments, varied in density, be sure to include enough silence for blank space ... ]
}

Each fragment has a "kind" plus its matching fields, and optionally "emphasis" ("whisper"|"normal"|"loud"|"fade"), "align" ("left"|"center"|"right"), "pace" (1 normal | 2 slightly slow | 3 long):
- {"kind":"line","text":"The door is smiling.","emphasis":"normal"}   // a subtitle line drifting past (can include line breaks)
- {"kind":"word","text":"Ocean","emphasis":"loud"}                     // a single word, huge and isolated
- {"kind":"silence","pace":3}                                         // blank space · silence (a long empty pause, must be interspersed)
- {"kind":"repeat","text":"Don't go","count":4}                       // the same word repeated
- {"kind":"dialogue","lines":["Are you still there","--","(No one answers)"]} // a very short dialogue fragment
- {"kind":"stage","text":"The lights come on one by one, then forget one by one that they were ever lit"} // a stage direction (bracketed feel)
- {"kind":"list","lines":["Lost: the keys","Lost: the name","Lost: you"]} // a list
- {"kind":"screenplay","lines":["INT. A ROOM THAT DOESN'T EXIST -- NIGHT","HER (back turned): You're late.","THE DOOR: It's fine."]} // a screenplay snippet
- {"kind":"diary","text":"Dreamed of that ocean again today. Or was that yesterday.","date":"some Sunday"} // a diary page fragment
- {"kind":"message","text":"I put the moon in my pocket, I'll show you when I'm back","date":"sent to --"} // a message sent to no one
- {"kind":"image","caption":"a bird flying backward","tint":"#5a6a7a"} // a purely text-conjured symbolic image (the caption is the poem, no image placeholder)

Required: 18-40 fragments, plenty of silence for blank space, varied kinds, images juxtaposed rather than narrated, be bold with contradiction and impossibility, **the ending cuts off abruptly, no resolution, no moral**. **Keep the JSON fully closed** — if space is tight, cut fragments from the middle, but still close every bracket. Output the JSON object directly.`;
}

function parseDream(raw: string): DreamScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && ch === '\n') { out += '\\n'; continue; }
            if (inStr && ch === '\r') { out += '\\r'; continue; }
            if (inStr && ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return out;
    };
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('dream parse failed', e); return null; }
}

// ============================================================
//  AMBIENT — floating decoration (varies by archetype)
// ============================================================
const Ambient: React.FC<{ kind: Ambient; accent: string }> = ({ kind, accent }) => {
    if (kind === 'none') return null;
    const n = kind === 'stars' ? 26 : kind === 'dust' ? 18 : 13;
    const glyph = (i: number): string => {
        switch (kind) {
            case 'petals': return ['✿', '❀', '✾', '❁'][i % 4];
            case 'feathers': return ['❟', '☁', '✦'][i % 3];
            case 'sparkle': return ['✦', '✧', '·', '⋆'][i % 4];
            case 'bubbles': return '○';
            case 'stars': return i % 7 === 0 ? '✦' : '·';
            default: return '·'; // dust
        }
    };
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: n }).map((_, i) => {
                const size = kind === 'stars' ? 6 + rnd(i + 1) * 8 : 9 + rnd(i + 1) * 16;
                const dur = 4 + rnd(i + 5) * 6;
                const drift = kind === 'bubbles' || kind === 'feathers';
                return (
                    <span key={i}
                        className={drift ? 'absolute animate-float' : 'absolute'}
                        style={{
                            top: `${rnd(i + 2) * 100}%`, left: `${rnd(i + 9) * 100}%`,
                            fontSize: `${size}px`, color: accent,
                            opacity: 0.12 + rnd(i + 3) * 0.4,
                            animation: drift ? undefined : `glowPulse ${dur}s ease-in-out infinite`,
                            animationDelay: `${rnd(i + 7) * 4}s`,
                            textShadow: `0 0 ${size}px ${accent}`,
                        }}>
                        {glyph(i)}
                    </span>
                );
            })}
        </div>
    );
};

// ============================================================
//  CUT-UP — the essence of collage poetry: every character/word in a sentence
//  looks like it was cut from somewhere different — font / size / weight / angle /
//  baseline / opacity / occasional little paper-scrap background color all vary,
//  yet they piece together into one complete sentence.
// ============================================================
const CUT_FONTS = [
    "'Shippori Mincho','Noto Serif SC',serif",
    "'Noto Sans SC','PingFang SC',sans-serif",
    "'ZCOOL KuaiLe','Noto Sans SC',cursive",
    "'SF Mono','Roboto Mono',ui-monospace,monospace",
    "'Songti SC','Shippori Mincho',serif",
];
// Split into independently-styleable pieces: CJK by character, Latin by word, newlines on their own, punctuation/spaces kept
const cutTokens = (text: string): string[] =>
    text.match(/[一-鿿]|[A-Za-z0-9'’]+|\n|[^\s]|[ \t]+/g) || [text];

const Cut: React.FC<{ text: string; theme: DreamTheme; seed?: number; base?: number; intensity?: number }> =
    ({ text, theme, seed = 0, base = 19, intensity = 1 }) => (
        <span>
            {cutTokens(text).map((t, k) => {
                if (t === '\n') return <br key={k} />;
                if (t.trim() === '') return <span key={k}>{t}</span>;
                const r = (n: number) => rnd(seed * 17.3 + k * 2.71 + n);
                const font = CUT_FONTS[Math.floor(r(1) * CUT_FONTS.length)];
                const size = base + (r(2) - 0.5) * base * 0.42 * intensity;
                const weight = [300, 400, 400, 600, 700][Math.floor(r(3) * 5)];
                const rot = (r(4) - 0.5) * 11 * intensity;
                const dy = (r(5) - 0.5) * base * 0.32 * intensity;
                const tone = r(6);
                const boxed = r(7) > 0.9;
                return (
                    <span key={k} style={{
                        display: 'inline-block',
                        fontFamily: font,
                        fontSize: `${size}px`,
                        fontWeight: weight as React.CSSProperties['fontWeight'],
                        transform: `rotate(${rot}deg) translateY(${dy}px)`,
                        color: tone > 0.85 ? theme.accent : tone < 0.16 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.92)',
                        margin: '0 0.02em',
                        padding: boxed ? '0.02em 0.18em' : undefined,
                        background: boxed ? `${theme.accent}1f` : undefined,
                        borderRadius: boxed ? 3 : undefined,
                        lineHeight: 1.55,
                    }}>{t}</span>
                );
            })}
        </span>
    );

// ============================================================
//  COLLAGE — fragments each get their own alignment / angle / size / opacity,
//  appearing one by one and "accumulating" on the same scrollable canvas,
//  producing meaning through juxtaposition and blank space.
// ============================================================
const emphOpacity = (e?: DreamFragment['emphasis']): number =>
    e === 'whisper' ? 0.52 : e === 'fade' ? 0.32 : e === 'loud' ? 1 : 0.85;

const CollageItem: React.FC<{ frag: DreamFragment; theme: DreamTheme; index: number }> = ({ frag, theme, index }) => {
    const i = index;
    const ff = SERIF;                  // Dreams are mostly serif poetic type; screenplay uses monospace
    const tint = theme.accent;

    // silence = pure blank space (negative space), occasionally leaving a very faint trace — rather than a whole screen of "nothing at all"
    if (frag.kind === 'silence') {
        const h = 52 + Math.floor(rnd(i + 1) * 78);
        return (
            <div style={{ height: h }} className="w-full flex items-center justify-center" aria-hidden>
                {rnd(i + 5) > 0.62 && <span className="text-white/10 tracking-[0.7em] text-xs select-none">·</span>}
            </div>
        );
    }

    // Collage placement: left/center/right scatter + slight rotation + uneven top spacing (negative space)
    const kindForcesLeft = frag.kind === 'list' || frag.kind === 'screenplay' || frag.kind === 'dialogue' || frag.kind === 'diary';
    const align: 'left' | 'center' | 'right' =
        frag.kind === 'message' ? 'right'
            : kindForcesLeft ? 'left'
                : (frag.align || (['left', 'center', 'right', 'center', 'right', 'left'][i % 6] as 'left' | 'center' | 'right'));
    const alignSelf = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
    const rot = (rnd(i * 3.1 + 1) - 0.5) * 5;
    const gapTop = i === 0 ? 4 : 22 + Math.floor(rnd(i + 2) * 46);
    const wrapStyle: React.CSSProperties = {
        alignSelf, marginTop: gapTop, transform: `rotate(${rot}deg)`,
        opacity: emphOpacity(frag.emphasis), maxWidth: '86%', textAlign: align,
    };
    const colItems = align === 'right' ? 'items-end' : align === 'center' ? 'items-center' : 'items-start';

    let inner: React.ReactNode = null;

    if (frag.kind === 'line') {
        const sz = frag.emphasis === 'loud' ? 25 : frag.emphasis === 'whisper' ? 15 : 19;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1} />;
    } else if (frag.kind === 'word') {
        const sz = frag.emphasis === 'whisper' ? 30 : frag.emphasis === 'loud' ? 50 : 40;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1.2} />;
    } else if (frag.kind === 'repeat') {
        const word = frag.text || '…';
        const count = Math.max(2, Math.min(6, frag.count || 3));
        inner = <span className={`inline-flex flex-col ${colItems}`}>
            {Array.from({ length: count }).map((_, k) => (
                <span key={k} className="font-light text-white leading-tight"
                    style={{ fontFamily: ff, fontSize: 22 - k * 1.4, opacity: Math.max(0.18, 1 - k * 0.2), letterSpacing: `${k * 0.05}em` }}>{word}</span>
            ))}
        </span>;
    } else if (frag.kind === 'dialogue') {
        inner = <span className="inline-flex flex-col gap-1.5 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed"><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.75} /></span>
            ))}
        </span>;
    } else if (frag.kind === 'stage') {
        inner = <span className="text-[14px] text-white/55 italic leading-relaxed" style={{ fontFamily: ff }}>
            <span className="text-white/25">[ </span>{frag.text}<span className="text-white/25"> ]</span>
        </span>;
    } else if (frag.kind === 'list') {
        inner = <span className="inline-flex flex-col gap-2 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed flex items-baseline gap-2">
                    <span style={{ color: tint }}>·</span><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.65} />
                </span>
            ))}
        </span>;
    } else if (frag.kind === 'screenplay') {
        // Rendered as a "screenplay scene card": film sprocket holes + slug scene header + character name centered/dialogue below, action lines as narration
        const ls = frag.lines || [];
        const slug = ls[0] || '';
        const body = ls.slice(1);
        inner = (
            <span className="inline-block w-full text-left" style={{ maxWidth: 300 }}>
                <span className="block relative rounded-2xl overflow-hidden border pt-4 pb-4 px-4"
                    style={{ borderColor: `${tint}33`, background: 'linear-gradient(165deg, rgba(255,255,255,0.05), rgba(255,255,255,0.012))', boxShadow: `0 10px 34px ${tint}16` }}>
                    {/* A streak of light along the top + film sprocket holes */}
                    <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${tint}66, transparent)` }} />
                    <span className="absolute inset-x-0 top-1.5 flex justify-between px-3 pointer-events-none" aria-hidden>
                        {Array.from({ length: 9 }).map((_, d) => (
                            <span key={d} className="block rounded-[1px]" style={{ width: 5, height: 3, background: `${tint}2e` }} />
                        ))}
                    </span>
                    {/* slug: INT/EXT · location — time */}
                    <span className="block text-[9.5px] tracking-[0.28em] uppercase mt-2 mb-2.5 pb-1.5 border-b"
                        style={{ color: tint, borderColor: `${tint}24`, fontFamily: MONO }}>▸ {slug}</span>
                    <span className="flex flex-col gap-2.5 items-stretch">
                        {body.map((l, k) => {
                            const m = l.match(/^\s*(.+?)\s*[:：]\s*(.+)$/);
                            if (m) {
                                const cue = m[1];
                                const speech = m[2];
                                const pm = cue.match(/^(.*?)\s*[（(](.+?)[）)]\s*$/);
                                const nm = pm ? pm[1] : cue;
                                const paren = pm ? pm[2] : '';
                                return (
                                    <span key={k} className="flex flex-col items-center gap-0.5 text-center">
                                        <span className="text-[9px] tracking-[0.22em] uppercase" style={{ color: `${tint}cc` }}>
                                            {nm}{paren && <span className="text-white/35 tracking-normal lowercase">（{paren}）</span>}
                                        </span>
                                        <span className="text-[14px] text-white/85 leading-relaxed" style={{ fontFamily: ff }}>{speech}</span>
                                    </span>
                                );
                            }
                            // Action / stage direction line
                            return <span key={k} className="text-[12px] text-white/45 italic text-center leading-relaxed" style={{ fontFamily: ff }}>— {l} —</span>;
                        })}
                    </span>
                </span>
            </span>
        );
    } else if (frag.kind === 'diary') {
        inner = <span className="inline-block rounded-lg px-4 py-3 text-left bg-white/[0.035] border border-white/[0.08]"
            style={{ boxShadow: `0 6px 28px ${tint}10`, maxWidth: 244 }}>
            {frag.date && <span className="block text-[9.5px] text-white/30 mb-1.5 tracking-wide" style={{ fontFamily: ff }}>{frag.date}</span>}
            <span className="block text-[13.5px] text-white/80 leading-loose whitespace-pre-wrap" style={{ fontFamily: ff }}>{frag.text}</span>
        </span>;
    } else if (frag.kind === 'message') {
        inner = <span className="inline-flex flex-col items-end gap-1">
            {frag.date && <span className="text-[9.5px] text-white/30 pr-1">{frag.date}</span>}
            <span className="px-3.5 py-2 rounded-2xl rounded-br-md text-[13.5px] leading-relaxed text-[#15121c]" style={{ background: tint, maxWidth: 230 }}>{frag.text}</span>
            <span className="text-[8.5px] text-white/25 pr-1">· Undelivered ·</span>
        </span>;
    } else { // image — no image placeholder drawn; the caption itself is the poem: renders only the collage poetry, with a hint of tint
        const it = frag.tint || tint;
        const cap = frag.caption || frag.text || '';
        inner = cap ? (
            <span className="inline-flex flex-col items-center gap-1.5">
                {/* A very thin tinted line, hinting "this is a frame of a picture" rather than a blank placeholder box */}
                <span className="block rounded-full" style={{ width: 26, height: 2, background: `${it}`, boxShadow: `0 0 10px ${it}aa` }} />
                <span className="leading-relaxed text-center" style={{ maxWidth: 232 }}>
                    <Cut text={cap} theme={theme} seed={i + 99} base={15} intensity={0.95} />
                </span>
            </span>
        ) : null;
    }

    if (!inner) return null;
    return <div className="animate-fade-in" style={wrapStyle}>{inner}</div>;
};

// ============================================================
//  SHELL
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; bg: string }> = ({ children, bg }) => (
    <div className="absolute inset-0 z-[400] flex flex-col overflow-hidden text-white" style={{ background: bg }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(120% 90% at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode }> = ({ onBack, right }) => (
    // The top bar handles the safe area itself: uses the global --chrome-top uniformly
    // (= --safe-top + SullyOS status bar height, automatically falling back to --safe-top
    // when the status bar is hidden), matching full-screen panels like Beyond / Exchange
    // Diary / Theater. Previously used bare env(safe-area-inset-top), which didn't account
    // for the status bar and pushed the back button too high.
    <div className="flex items-center justify-between px-4 shrink-0 pb-2 z-30"
        style={{ paddingTop: 'calc(var(--chrome-top) + 0.25rem)' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// The dream system's own unified small popup (not the browser's native confirm/alert) — dark glass, floats centered.
const DreamPopup: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }> =
    ({ title, onClose, children, actions }) => (
    <div className="absolute inset-0 z-[60] flex items-center justify-center p-7" onClick={onClose}>
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
        <div className="relative w-full max-w-[300px] rounded-3xl border border-white/[0.12] p-5 animate-slide-up"
            style={{ background: 'linear-gradient(160deg, #1c1a28, #121019)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-white text-center mb-2.5" style={{ fontFamily: SERIF }}>{title}</h3>
            <div className="text-[12px] text-white/65 leading-relaxed text-center">{children}</div>
            {actions && <div className="mt-4 flex gap-2.5">{actions}</div>}
        </div>
    </div>
);

// ============================================================
//  COMPONENT
// ============================================================
type Phase = 'idle' | 'loading' | 'play' | 'end' | 'error' | 'archive' | 'collection';

/** Same calendar day check (used for the daily dream limit) */
const isSameDay = (a: number, b: number): boolean => {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};
/** Max number of distinct dream "types" any one character can show per day */
const DREAM_DAILY_TYPE_CAP = 3;

const DreamTheater: React.FC<{ char: CharacterProfile; onExit: () => void }> = ({ char, onExit }) => {
    const { apiConfig, userProfile, updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<Phase>('idle');
    const [script, setScript] = useState<DreamScript | null>(null);
    const [revealed, setRevealed] = useState(1);   // Number of fragments revealed so far (collage accumulation, pure tap-to-advance)
    // Local testing only: force a specific archetype (null = let the model choose automatically)
    const [forcedArchetype, setForcedArchetype] = useState<DreamArchetype | null>(null);
    const devAvailable = isDevDebugAvailable();
    // Blind box collection (account-level) + this session's blind box result
    const [collection, setCollection] = useState<DreamCollection>(() => loadCollection());
    const [boxReveal, setBoxReveal] = useState<{ archetype: DreamArchetype; isNew: boolean; count: number } | null>(null);
    const savedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // Long-press detection (deleting a dream page): timer + a "fired" flag (prevents releasing from also triggering replay)
    const lpTimerRef = useRef<number | null>(null);
    const lpFiredRef = useRef(false);
    const clearLp = () => { if (lpTimerRef.current) { window.clearTimeout(lpTimerRef.current); lpTimerRef.current = null; } };
    // Popups: rules explainer (?) / daily limit reminder / delete-page confirmation
    const [showHelp, setShowHelp] = useState(false);
    const [dayPrompt, setDayPrompt] = useState<'seen' | 'limit' | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<DreamLog | null>(null);

    const frags = script?.fragments || [];
    const theme = THEMES[script?.archetype || 'starry'];
    const isDeepSleep = script?.archetype === 'deepsleep';

    const dreamSim = useDreamSim();

    // ----- generate (runs in the background: the user can leave the Dwelling while it generates, a global toast + deep link brings them back) -----
    const start = useCallback(async (opts?: { override?: boolean }) => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
            addToast('Please configure the API in Settings first', 'error'); return;
        }
        // Daily limit: in principle only one dream per day; generating again triggers a
        // reminder, which can be overridden with "Leave me alone!"; but the same character
        // can show at most DREAM_DAILY_TYPE_CAP distinct dream types per day.
        // (Skipped when a dev forces a specific archetype, for easier local testing.)
        if (!forcedArchetype) {
            const today = (char.dreamLogs || []).filter(l => isSameDay(l.timestamp, Date.now()));
            const distinctTypes = new Set(today.map(l => l.archetype)).size;
            if (today.length >= DREAM_DAILY_TYPE_CAP || distinctTypes >= DREAM_DAILY_TYPE_CAP) {
                setDayPrompt('limit'); return;   // Hit the cap, hard block, no override
            }
            if (today.length >= 1 && !opts?.override) {
                setDayPrompt('seen'); return;    // Already seen one, soft reminder, can override
            }
        }
        setDayPrompt(null);
        const cid = char.id, cname = char.name;
        savedRef.current = false; setRevealed(1); setBoxReveal(null);
        setPhase('loading');
        trackEvent('Generate a Dream');
        dreamSimStore.set({ status: 'loading', charId: cid, charName: cname });
        // Archetype is drawn by the app side (dev-forced value takes priority): guarantees variety, avoids repeatedly rolling the same one, hidden entry appears at its drop rate
        const chosenArchetype = forcedArchetype || rollArchetype(char.dreamLogs);
        try {
            // Note: doesn't setState to play right after await — that's handled uniformly by
            // the consume effect below (so generation still completes even if the user has
            // left and the component unmounted, and the global indicator bar takes over)
            const s = await generateDreamScript({ char, userProfile, apiConfig, forcedArchetype: chosenArchetype });
            dreamSimStore.set({ status: 'ready', charId: cid, charName: cname, script: s });
            addToast('The dream has taken shape', 'success');
        } catch (e) {
            console.error('dream gen failed', e);
            dreamSimStore.set({ status: 'error', charId: cid, charName: cname });
            addToast('The dream failed to take shape, please try again', 'error');
        }
    }, [apiConfig, char, userProfile, addToast, forcedArchetype]);

    // ----- consume: lands the globally generated result into local playback (including first consumption after returning via deep link) -----
    useEffect(() => {
        if (dreamSim.status === 'ready' && dreamSim.charId === char.id && dreamSim.script) {
            savedRef.current = false; setBoxReveal(null);
            setScript(dreamSim.script); setRevealed(1); setPhase('play');
            dreamSimStore.reset();
        } else if (dreamSim.status === 'error' && dreamSim.charId === char.id) {
            setPhase('error'); dreamSimStore.reset();
        } else if (dreamSim.status === 'loading' && dreamSim.charId === char.id) {
            setPhase(p => (p === 'idle' || p === 'error') ? 'loading' : p);
        }
    }, [dreamSim, char.id]);

    // ----- persist + buff when reaching the end -----
    const persist = useCallback((s: DreamScript) => {
        if (savedRef.current) return;
        savedRef.current = true;

        const log: DreamLog = {
            id: `dream-${Date.now()}`,
            archetype: s.archetype,
            title: s.title,
            afterglow: s.afterglow,
            fragmentsCount: s.fragments?.length || 0,
            timestamp: Date.now(),
            script: s,
        };

        // Emotion buff — consistent with PersonaSim, only written when this character has the schedule/emotion system enabled
        const scheduleOn = isScheduleFeatureOn(char);
        const newBuff: CharacterBuff | null = (scheduleOn && s.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: s.buff.name || `dream_${Date.now()}`,
            label: s.buff.label,
            intensity: (s.buff.intensity && [1, 2, 3].includes(s.buff.intensity) ? s.buff.intensity : 2) as 1 | 2 | 3,
            emoji: s.buff.emoji,
            color: s.buff.color || theme.accent,
            description: s.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(char.id, (cur) => {
            const dreamLogs = [log, ...(cur.dreamLogs || [])].slice(0, 30);
            if (newBuff && s.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    // The character doesn't remember the dream, but a layer of emotional residue lingers — spell out "can't say where it came from" when injecting
                    buffInjection: s.buff.description ? `(${newBuff.emoji || ''}${newBuff.label} · left behind by a dream that's already faded) ${s.buff.description}` : '',
                    dreamLogs,
                };
            }
            return { dreamLogs };
        });
        if (newBuff) {
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: char.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: char.id } }));
        }
    }, [char, updateCharacter, theme.accent]);

    // ----- wrap-up: save to DB + buff + open blind box → end (double-trigger safe: guarded by savedRef, no re-draw / no overwriting the reveal) -----
    const finishDream = useCallback(() => {
        if (!script) return;
        if (savedRef.current) { setPhase('end'); return; } // Already wrapped up (including replay) → just go to the end page
        persist(script);                                   // Sets savedRef=true internally
        const r = unlockCollectible(script.archetype);
        setCollection(r.collection);
        setBoxReveal({ archetype: script.archetype, isNew: r.isNew, count: r.count });
        setPhase('end');
    }, [script, persist]);

    // Pure tap-to-advance: no more auto-play, no auto wrap-up either — the user taps
    // "Wake up" or taps to finish once they're done reading, letting them linger on
    // that last collage-poem page for as long as they want.

    // ----- smooth-scroll to the bottom whenever a new fragment appears, so the latest one enters view -----
    useEffect(() => {
        if (phase !== 'play' || !scrollRef.current) return;
        const el = scrollRef.current;
        requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
    }, [revealed, phase]);

    // Tap: reveal the next fragment; wrap up once all are revealed
    const revealNextOrFinish = () => {
        if (revealed < frags.length) setRevealed(r => Math.min(frags.length, r + 1));
        else finishDream();
    };

    const restart = () => { savedRef.current = true; setRevealed(1); setPhase('play'); trackEvent('Replay Just-Finished Dream'); };

    // ----- replay a saved dream -----
    const replay = (s: DreamScript) => {
        savedRef.current = true; // Replaying doesn't write to DB again / doesn't stack another buff / doesn't draw another blind box
        setBoxReveal(null);
        setScript(s); setRevealed(1); setPhase('play');
    };

    // ----- delete a "dream page" (triggered by long-press, uses a custom confirm popup, not the native confirm) -----
    const handleDeleteLog = (log: DreamLog) => {
        updateCharacter(char.id, (cur) => ({ dreamLogs: (cur.dreamLogs || []).filter(l => l.id !== log.id) }));
        setConfirmDelete(null);
        addToast('This dream page has been torn out', 'success');
        trackEvent('Tear Out a Dream Page');
    };

    const dreamLogs = char.dreamLogs || [];
    const collectedCount = ALL_ARCHETYPES.filter(a => collection[a]).length;

    // Daily limit reminder popup (both idle and end can trigger "generate again," shared across both)
    const dayPromptPopups = (<>
        {dayPrompt === 'seen' && (
            <DreamPopup title={`Already saw ${char.name}'s dream today`} onClose={() => setDayPrompt(null)}
                actions={<>
                    <button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">OK</button>
                    <button onClick={() => { setDayPrompt(null); trackEvent('Dismiss Daily Reminder and Watch Another Dream'); start({ override: true }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>Leave me alone!</button>
                </>}>
                Watching too many dreams in one day dulls the magic.<br />Really want to see another? (Up to {DREAM_DAILY_TYPE_CAP} kinds today)
            </DreamPopup>
        )}
        {dayPrompt === 'limit' && (
            <DreamPopup title={`Hit today's dream limit for ${char.name}`} onClose={() => setDayPrompt(null)}
                actions={<button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>OK, see you tomorrow</button>}>
                You can only peek at {DREAM_DAILY_TYPE_CAP} different dreams in one day.<br />The rest are saved for tomorrow night. 🌙
            </DreamPopup>
        )}
    </>);

    // ========================================================
    //  IDLE — entry screen
    // ========================================================
    if (phase === 'idle' || phase === 'error') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} right={
                    <div className="flex items-center gap-2.5">
                        <button onClick={() => { setPhase('collection'); trackEvent('Open Dream Blind Box Collection'); }} className="flex items-center gap-1 text-[11px] text-white/55 active:scale-95 transition">
                            🐾 Collection <span className="tabular-nums opacity-70">{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        <button onClick={() => { setShowHelp(true); trackEvent('Open Dream Rules'); }} aria-label="Dream Rules"
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white/55 bg-white/[0.05] border border-white/[0.1] active:scale-90 transition">
                            <Question size={15} weight="bold" />
                        </button>
                    </div>
                } />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center">
                    <div className="relative mb-7">
                        <MoonStars size={52} weight="light" style={{ color: '#cdd6ff' }} />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff44' }} />
                    </div>
                    <div className="text-[10px] tracking-[0.4em] uppercase mb-3" style={{ color: '#cdd6ff' }}>Dream Theater</div>
                    <h1 className="text-[24px] font-light text-white leading-snug mb-4" style={{ fontFamily: SERIF }}>
                        Sneak a peek at<br />a dream {char.name} has already forgotten
                    </h1>
                    <p className="text-[12px] text-white/45 leading-relaxed max-w-[270px] mb-1" style={{ fontFamily: SERIF }}>
                        they're asleep.<br />
                        Dreams don't have to make sense, or be taken seriously --<br />
                        scattered images, contradictory timelines, impossible people.<br />
                        When it's over, they won't remember, but you will.
                    </p>

                    {phase === 'error' && (
                        <div className="mt-5 text-[12px] text-rose-300/80">The dream failed to take shape... try again?</div>
                    )}

                    <button onClick={() => start()}
                        className="mt-9 w-full max-w-[280px] py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition"
                        style={{ background: '#cdd6ff', color: '#15121c' }}>
                        <Eye size={16} weight="fill" /> {forcedArchetype ? `Test: ${THEMES[forcedArchetype].label}` : "Step into their dream"}
                    </button>
                    <p className="text-[10px] text-white/25 mt-3 max-w-[250px] leading-relaxed">
                        Reads their profile, memories, and recent conversation, and weaves them into a dream. May take a moment.
                    </p>

                    {/* Entry points: blind box collection / dream pages */}
                    <div className="flex items-center gap-2.5 mt-7">
                        <button onClick={() => { setPhase('collection'); trackEvent('Open Dream Blind Box Collection'); }}
                            className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                            🐾 Blind Box Collection <span className="tabular-nums" style={{ color: '#cdd6ff' }}>{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        {dreamLogs.length > 0 && (
                            <button onClick={() => { setPhase('archive'); trackEvent('Open Dream Page Archive'); }}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                                <MoonStars size={13} /> Dream Pages <span className="tabular-nums opacity-70">{dreamLogs.length}</span>
                            </button>
                        )}
                    </div>

                    {/* Local testing only: force a dream archetype (admin debug directive, hidden in production) */}
                    {devAvailable && (
                        <div className="mt-8 w-full max-w-[300px] rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-3.5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[10px] tracking-wider text-amber-200/80 font-semibold">🛠 Force Dream Archetype · Local Testing Only</span>
                                {forcedArchetype && (
                                    <button onClick={() => setForcedArchetype(null)} className="text-[9px] text-white/40 underline active:scale-95">Clear · Back to Auto</button>
                                )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                                {ALL_ARCHETYPES.map(a => {
                                    const active = forcedArchetype === a;
                                    return (
                                        <button key={a} onClick={() => setForcedArchetype(active ? null : a)}
                                            className="py-1.5 rounded-lg text-[10.5px] border transition active:scale-95 flex items-center justify-center gap-1"
                                            style={active
                                                ? { background: THEMES[a].accent, color: '#15121c', borderColor: 'transparent', fontWeight: 700 }
                                                : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            <span className="tabular-nums opacity-50 text-[8.5px]">{archetypeNo(a)}</span>{THEMES[a].label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[9px] text-white/30 mt-2.5 leading-relaxed">
                                Checking one injects an "admin debug directive," forcing this generation to use that archetype (including the hidden Deep Sleep); leave unchecked = the model chooses automatically.
                            </p>
                        </div>
                    )}
                </div>

                {/* Rules explainer (top-right ? button) */}
                {showHelp && (
                    <DreamPopup title="🌙 Dream Rules" onClose={() => setShowHelp(false)}
                        actions={<button onClick={() => setShowHelp(false)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>Got it</button>}>
                        <div className="text-left space-y-2">
                            <p>· In principle you only get <b className="text-white/80">one</b> {char.name} dream per day. Generating again triggers a reminder, but you can still pick "Leave me alone!" to continue.</p>
                            <p>· But for the same person on the same day, you can see at most <b className="text-white/80">{DREAM_DAILY_TYPE_CAP} kinds</b> of dreams -- once you hit the cap, come back tomorrow.</p>
                            <p>· There are <b className="text-white/80">{ALL_ARCHETYPES.length}</b> dream types in total, including <b style={{ color: '#ffe08a' }}>1 hidden entry · Deep Sleep</b>, which only shows up rarely.</p>
                            <p>· Finishing a dream draws the matching dream cat, added to the collection.</p>
                            <p>· they won't remember these dreams, but a hard-to-name feeling lingers after waking. You can long-press a page in "Dream Pages" to delete it.</p>
                        </div>
                    </DreamPopup>
                )}

                {/* Daily limit reminder */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  ARCHIVE — dream pages
    // ========================================================
    if (phase === 'archive') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase('idle')} />
                <div className="px-7 pb-3 shrink-0">
                    <h2 className="text-[18px] font-light text-white" style={{ fontFamily: SERIF }}>Dream Pages</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">Dreams you peeked at, that they have long since forgotten. <span className="text-white/30">Long-press a page to tear it out.</span></p>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-10 space-y-3">
                    {dreamLogs.map(log => {
                        const lt = THEMES[log.archetype] || THEMES.starry;
                        return (
                            <button key={log.id}
                                onClick={() => { if (lpFiredRef.current) { lpFiredRef.current = false; return; } trackEvent('Replay a Saved Dream'); log.script && replay(log.script); }}
                                disabled={!log.script}
                                onContextMenu={(e) => { e.preventDefault(); setConfirmDelete(log); }}
                                onTouchStart={() => { lpFiredRef.current = false; clearLp(); lpTimerRef.current = window.setTimeout(() => { lpFiredRef.current = true; setConfirmDelete(log); }, 500); }}
                                onTouchMove={clearLp}
                                onTouchEnd={clearLp}
                                className="w-full text-left rounded-2xl p-4 border border-white/[0.07] bg-white/[0.03] active:scale-[0.99] transition disabled:opacity-60"
                                style={{ boxShadow: `0 6px 30px ${lt.accent}10` }}>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: lt.accent, background: `${lt.accent}1f` }}>
                                        {lt.label}
                                    </span>
                                    <span className="text-[9px] text-white/30 tabular-nums">
                                        {new Date(log.timestamp).toLocaleString('en-US', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                <div className="text-[15px] font-light text-white mb-1" style={{ fontFamily: SERIF }}>{log.title || 'Untitled Dream'}</div>
                                {log.afterglow && <p className="text-[12px] text-white/55 leading-relaxed" style={{ fontFamily: SERIF }}>{log.afterglow}</p>}
                                {log.buff?.label && (
                                    <div className="inline-flex items-center gap-1.5 mt-2.5 px-2.5 py-1 rounded-full border text-[10px]"
                                        style={{ borderColor: `${log.buff.color || lt.accent}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || lt.accent}14` }}>
                                        <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Tear out a page · custom confirm popup (not the browser's native confirm) */}
                {confirmDelete && (
                    <DreamPopup title="Tear out this dream page?" onClose={() => setConfirmDelete(null)}
                        actions={<>
                            <button onClick={() => setConfirmDelete(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">Keep it</button>
                            <button onClick={() => handleDeleteLog(confirmDelete)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: '#e5566b' }}><Trash size={13} weight="bold" /> Tear out</button>
                        </>}>
                        "{confirmDelete.title || 'Untitled Dream'}"<br />Once torn out, this dream page is gone for good.
                    </DreamPopup>
                )}
            </Shell>
        );
    }

    // ========================================================
    //  COLLECTION — blind box collection (album)
    // ========================================================
    if (phase === 'collection') {
        const total = ALL_ARCHETYPES.length;
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase(boxReveal ? 'end' : 'idle')} right={
                    <span className="text-[11px] text-white/55 tabular-nums">{collectedCount}/{total}</span>
                } />
                <div className="px-7 pb-3 shrink-0">
                    <div className="text-[9px] tracking-[0.3em] uppercase" style={{ color: '#cdd6ff' }}>{DREAM_BOX_SERIES.sub} · Blind Box</div>
                    <h2 className="text-[19px] font-light text-white mt-1" style={{ fontFamily: SERIF }}>{DREAM_BOX_SERIES.title}</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">Finish a dream and draw that dream's cat. Collect them all.</p>
                    <div className="h-[3px] rounded-full bg-white/[0.07] overflow-hidden mt-3">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(collectedCount / total) * 100}%`, background: '#cdd6ff' }} />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10">
                    <div className="grid grid-cols-3 gap-3">
                        {ALL_ARCHETYPES.map(a => {
                            const owned = collection[a];
                            const t = THEMES[a];
                            const isSecret = a === 'deepsleep';   // Hidden entry · Deep Sleep -- should read as "this tile is different" at a glance
                            const GOLD = '#ffe08a';
                            return (
                                <div key={a} className={`relative rounded-2xl border overflow-hidden flex flex-col ${isSecret ? 'col-span-3 mx-auto' : ''}`}
                                    style={isSecret
                                        ? { width: 'calc((100% - 1.5rem) / 3)', borderColor: owned ? `${GOLD}aa` : `${GOLD}55`, background: `linear-gradient(160deg, ${GOLD}1c, rgba(120,90,160,0.10) 60%, rgba(255,255,255,0.02))`, boxShadow: `0 0 22px ${GOLD}2e, inset 0 0 18px ${GOLD}14` }
                                        : owned
                                            ? { borderColor: `${t.accent}40`, background: `linear-gradient(160deg, ${t.accent}14, rgba(255,255,255,0.02))` }
                                            : { borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                                    {/* Hidden-entry badge: shown whether unlocked or not, to establish a "special edition" presence */}
                                    {isSecret && (
                                        <span className="absolute top-0 left-0 z-10 px-1.5 py-0.5 text-[7.5px] font-bold tracking-wider rounded-br-lg"
                                            style={{ background: GOLD, color: '#15121c' }}>✦ Hidden</span>
                                    )}
                                    {owned ? (
                                        <>
                                            <div className="relative aspect-square flex items-center justify-center p-1.5">
                                                <BoxCat archetype={a} size={92} />
                                                {owned.count > 1 && (
                                                    <span className="absolute top-1 right-1 text-[8.5px] px-1.5 py-0.5 rounded-full font-bold tabular-nums"
                                                        style={{ background: isSecret ? GOLD : t.accent, color: '#15121c' }}>×{owned.count}</span>
                                                )}
                                            </div>
                                            <div className="text-center pb-2 px-1">
                                                <div className="text-[10.5px] leading-tight" style={{ fontFamily: SERIF, color: isSecret ? GOLD : 'rgba(255,255,255,0.85)' }}>{t.label}</div>
                                                <div className="text-[7.5px] tracking-wider uppercase mt-0.5" style={{ color: isSecret ? `${GOLD}cc` : `${t.accent}cc` }}>{t.sub}</div>
                                            </div>
                                        </>
                                    ) : isSecret ? (
                                        // Not-yet-unlocked hidden entry: gold question mark + mysterious hint, clearly distinct from a normal lock
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2"
                                            style={{ background: `radial-gradient(circle at 50% 42%, ${GOLD}1f, transparent 70%)` }}>
                                            <Sparkle size={22} weight="fill" style={{ color: GOLD }} />
                                            <span className="text-[8px] tracking-wider" style={{ color: `${GOLD}aa` }}>Some very rare dream</span>
                                        </div>
                                    ) : (
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2 text-white/20"
                                            style={{ background: 'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.04), transparent 70%)' }}>
                                            <Lock size={20} weight="light" />
                                            <span className="text-[18px] font-light tracking-[0.2em]">？</span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-[10px] text-white/25 mt-6 text-center leading-relaxed px-4">
                        🐾 {DREAM_BOX_SERIES.title}<br />Locked dream cats are hiding inside dream types you haven't had yet.
                    </p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  LOADING
    // ========================================================
    if (phase === 'loading') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-6 px-10 text-center">
                    <div className="relative">
                        <MoonStars size={42} weight="light" style={{ color: '#cdd6ff' }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff55' }} />
                    </div>
                    <div className="text-[13px] text-white/70" style={{ fontFamily: SERIF }}>they're drifting into a dream...</div>
                    <div className="text-[11px] text-white/35 leading-relaxed" style={{ fontFamily: SERIF }}>
                        Kneading memories, conversation, and emotion into<br />a dream that's hard to put into words. May take a moment.
                    </div>
                    <button onClick={onExit} className="mt-2 px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        Leave for now · Notify me when it's ready
                    </button>
                    <p className="text-[10px] text-white/30 leading-relaxed">The dream keeps weaving in the background,<br />a prompt will appear at the top once it's ready -- tap it to come back.</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell bg={theme.bg}>
                <Ambient kind={theme.ambient} accent={theme.accent} />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center animate-fade-in">
                    <MoonStars size={isDeepSleep ? 28 : 26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">{isDeepSleep ? 'A Night Without Dreams' : 'The Dream Has Ended'}</div>
                    <h2 className="text-[21px] font-light text-white mb-3" style={{ fontFamily: SERIF }}>{script?.title || (isDeepSleep ? 'Deep Sleep' : 'Untitled Dream')}</h2>
                    <div className="text-[10px] mb-4 px-3 py-1 rounded-full" style={{ color: theme.accent, background: `${theme.accent}1f` }}>{theme.label}</div>
                    {script?.afterglow && (
                        <p className="text-[14px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: SERIF }}>{script.afterglow}</p>
                    )}

                    {script?.buff?.label && isScheduleFeatureOn(char) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || theme.accent}55`, background: `${script.buff.color || theme.accent}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">A feeling they can't quite place has stayed with them</div>
                            </div>
                        </div>
                    )}

                    {/* Blind box reveal -- the cat drawn from this dream */}
                    {boxReveal && (
                        <div className="mt-7 flex flex-col items-center animate-pop-in">
                            <div className="relative">
                                {/* sparkle ring */}
                                <Sparkle size={16} weight="fill" className="absolute -top-1 -left-2 animate-pulse" style={{ color: theme.accent }} />
                                <Sparkle size={12} weight="fill" className="absolute top-3 -right-3 animate-pulse" style={{ color: theme.accent, animationDelay: '300ms' }} />
                                <BoxCat archetype={boxReveal.archetype} size={128} />
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                                {boxReveal.isNew
                                    ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider" style={{ background: theme.accent, color: '#15121c' }}>NEW ✦</span>
                                    : <span className="px-2 py-0.5 rounded-full text-[10px] text-white/60 border border-white/15">Already have it · drawn again ×{boxReveal.count}</span>}
                                <span className="text-[12px] text-white/80" style={{ fontFamily: SERIF }}>{THEMES[boxReveal.archetype].label} kitty</span>
                            </div>
                            <button onClick={() => { setPhase('collection'); trackEvent('Open Dream Blind Box Collection'); }} className="mt-2 text-[11px] text-white/45 underline active:scale-95">
                                {boxReveal.isNew ? 'Added to collection · Take a look' : 'View collection'}
                            </button>
                        </div>
                    )}

                    <p className="text-[10px] text-white/30 mt-6 max-w-[260px] leading-relaxed">
                        they won't remember this dream after waking,<br />but you've quietly kept both the dream and the cat.
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> Watch again
                        </button>
                        <button onClick={() => start()} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 transition" style={{ background: theme.accent, color: '#15121c' }}>
                            <MoonStars size={14} weight="fill" /> Dream again
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">Leave</button>
                </div>
                {/* "Dream again" also triggers the daily limit reminder */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — deep sleep (silent) special scene
    // ========================================================
    if (isDeepSleep) {
        return (
            <Shell bg={theme.bg}>
                <div className="flex-1 flex flex-col items-center justify-center px-12 text-center select-none" onClick={finishDream}>
                    <div className="w-3 h-3 rounded-full bg-white/40 animate-dot-pulse" style={{ boxShadow: '0 0 30px rgba(255,255,255,0.3)' }} />
                    <p className="text-[12px] text-white/20 mt-12 tracking-[0.3em]" style={{ fontFamily: SERIF }}>......</p>
                    <p className="absolute bottom-12 text-[10px] text-white/20">Tap to wake up</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — collage canvas (fragments accumulate, scroll back to reread the whole collage poem)
    // ========================================================
    return (
        <Shell bg={theme.bg}>
            <Ambient kind={theme.ambient} accent={theme.accent} />

            {/* exit (abandon, don't wrap up) */}
            <button onClick={onExit} className="absolute top-0 left-0 m-3 w-9 h-9 rounded-full flex items-center justify-center text-white/40 bg-white/[0.04] border border-white/[0.06] active:scale-90 transition z-30"
                style={{ marginTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
                <X size={16} />
            </button>

            {/* Collage canvas: tap to reveal the next fragment; scroll up/down to reread */}
            <div ref={scrollRef} onClick={revealNextOrFinish}
                className="flex-1 relative z-10 overflow-y-auto no-scrollbar select-none">
                <div className="min-h-full flex flex-col px-7 pt-20 pb-44">
                    {frags.slice(0, revealed).map((f, i) => (
                        <CollageItem key={i} frag={f} theme={theme} index={i} />
                    ))}
                    {revealed >= frags.length && (
                        <div className="self-center mt-14 mb-4 flex flex-col items-center gap-3 animate-fade-in">
                            <span className="text-white/25 tracking-[0.45em] text-[11px]" style={{ fontFamily: SERIF }}>The dream scatters here</span>
                            <button onClick={(e) => { e.stopPropagation(); finishDream(); }}
                                className="px-6 py-2.5 rounded-full text-[12px] font-semibold active:scale-95 transition"
                                style={{ background: theme.accent, color: '#15121c' }}>Wake up</button>
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom: progress + hint + wake up (pure tap-to-advance, no auto-play) */}
            <div className="shrink-0 z-30 px-6 pb-7 pt-2 bg-gradient-to-t from-black/40 to-transparent">
                <div className="h-[2px] rounded-full bg-white/[0.06] overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(revealed / Math.max(1, frags.length)) * 100}%`, background: `${theme.accent}88` }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); finishDream(); }} className="text-[11px] text-white/45 active:scale-95">Wake up</button>
                    <span className={`text-[10px] text-white/25 transition-opacity duration-1000 ${revealed > 2 ? 'opacity-0' : 'opacity-100'}`}>Tap to let the dream unfold, one fragment at a time</span>
                    <span className="text-[10px] text-white/25 tabular-nums">{Math.min(revealed, frags.length)}/{frags.length}</span>
                </div>
            </div>
        </Shell>
    );
};

export default DreamTheater;
