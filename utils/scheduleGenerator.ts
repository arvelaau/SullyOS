
import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, Message, Emoji } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleDateKey, getScheduleWallClock } from './scheduleTime';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

export { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/**
 * Build the schedule-generation prompt for "lifestyle" characters.
 *
 * Design update (per user feedback):
 * - The schedule's core is "this character's own real, rich life," not "how they wait for /
 *   look for / think about the user"
 * - Strictly forbid slots like "message the user" / "check if the user has shown up" /
 *   "wait for the user" — these slots contribute nothing to a rich inner world, they're just
 *   placeholder noise
 * - Activities should stick close to the character's setting: an illustrator sketches, a
 *   programmer writes code, a bartender preps a drink menu, a homebody binges anime, a barista
 *   roasts beans, an athlete trains, a student studies … glance at the `activity` for any given
 *   day and you should **recognize it as unmistakably them**
 * - Personality-appropriate "doing nothing" (slacking off / zoning out / procrastinating) is
 *   allowed — not everyone is productive every day
 * - The user should only show up in very natural spots (remembering something they said
 *   yesterday / casually replying to a message / snapping a photo while out shopping) — never
 *   as the subject of a slot, never the throughline of every monologue
 */
/**
 * Render the chat history into the schedule prompt using the same message-formatting and
 * cleanup rules as the main private-chat pipeline:
 * - Cards like Homeland / Exchange Diary keep their full readable body text;
 * - HTML cards keep only their visible-text summary;
 * - Bilingual history keeps only the original-language side;
 * - Images drop their base64 data, keeping only a placeholder.
 * Returns an empty string for an empty array; the prompt builder skips this section in that case.
 */
export function formatChatHistoryForSchedule(
    messages: Message[],
    char: CharacterProfile,
    user: UserProfile,
    emojis: Emoji[] = [],
): string {
    if (!messages || messages.length === 0) return '';
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        messages,
        Math.max(1, messages.length),
        char,
        user,
        emojis,
    );
    const cleaned = cleanApiMessages(flattenImageContentParts(apiMessages));
    const lines = cleaned.map(m => {
        const sender = m.role === 'user' ? user.name : m.role === 'assistant' ? char.name : 'System';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${sender}: ${content}`;
    });
    return `\n## Recent Chat History (with "${user.name}")\n${lines.join('\n')}\n`;
}

function buildLifestylePrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: generate the character's schedule for today + a stream-of-consciousness monologue

Today is ${today} (${dayOfWeek}). The user's name is "${user.name}".

${chatHistoryBlock ? `**Important: above is the recent chat history with "${user.name}". If the conversation mentions something "${char.name}" said they're doing today/soon (e.g. "going to work in the morning", "have plans this afternoon"), the generated slots must strictly follow it — don't ignore these known facts and make something else up.**\n` : ''}

You need to do two things for the character "${char.name}". **Core principle: this is ta's own day, not a day spent "waiting for ${user.name}"**.

### Part 1: the schedule (shown as a UI card)

Generate 5-7 time slots, from morning to night. For each slot:
- startTime: "HH:MM"
- activity: a short activity name (2-4 words)
- description: a one-line description (can include physical/tactile detail, objects, sensory detail)
- emoji: one matching emoji

#### Key requirements

1. **Stick close to the character's setting** — draw from "${char.name}"'s job / hobbies /
   personality / lifestyle:
   - An illustrator sketches drafts, browses references, procrastinates on a deadline, or
     idly flips through art books; a bartender preps ingredients, tests a new recipe, wipes
     down the bar; a programmer opens their IDE, reviews PRs, fixes bugs, goes for a run to
     clear their head; a student heads to the library, grinds practice problems, orders
     delivery; a musician practices, transcribes a song, writes a demo, goes to a
     livehouse gig …
   - Activities should be **specific about what the character's hands are actually doing**,
     not an abstract "work"/"study"/"rest"

2. **Rich, not formulaic** — include at least 3 of the following categories:
   - Career-/craft-related activities (even procrastinating still relates to their work)
   - Pure personal hobbies (reading, gaming, watching shows, cooking, exercise,
     photography, crafts …)
   - Errands / everyday texture (grocery shopping, laundry, walking the dog, watering
     plants, picking up a package, showering …)
   - Emotional beats (zoning out, lying around, feeling down, insomnia, daydreaming,
     flipping through old photos …)
   - Socializing (eating with friends, a call with family, running into someone on the
     street … the user can **occasionally** show up here too)

3. **"Doing nothing" is allowed** — not every day needs to be packed; real people have
   stretches of "scrolling their phone in bed for two hours"

4. **Slots that must never appear (very important)**:
   - ❌ "message ${user.name}" / "want to reach out to ${user.name}" / "wait for ${user.name} to reply"
   - ❌ "check what ${user.name}'s up to" / "browse ${user.name}'s posts"
   - ❌ any activity where ${user.name} is the subject / the object of the action
   - ✅ the user may only slip naturally into the description as an **incidental detail**
        of something already happening — e.g. "sketching a draft; ${user.name} said
        yesterday that character looked good, so drawing another one on a whim" — the
        subject is still ta themselves

### Part 2: stream-of-consciousness monologue (this is the core part)

Write an **inner monologue** for the character for each of three time slots:
- **morning**: what's going through the character's head if "${user.name}" comes to find them in the morning
- **afternoon**: what's going through the character's head if "${user.name}" comes to find them in the afternoon (carrying the afterglow of what happened in the morning)
- **evening**: what's going through the character's head if "${user.name}" comes to find them in the evening (the accumulation of the whole day)

#### Writing requirements (extremely important):

1. **Use the character's own voice and tone**, first person, like they're talking to themselves
2. **Emotion should have layers** — not a summary like "today was fun," but something specific, shifting, self-correcting ("ugh, so annoying … no, not just annoying, I'm genuinely exhausted")
3. **Events should form a causal chain** — not a list like "did A, did B, did C," but "because of A, then B, and as a result C"
4. **The throughline is ta's own life** — ${user.name} can surface naturally (remembering something they said yesterday / anticipation / worry / gratitude / impatience / missing them), but shouldn't be the sole focus from start to finish
5. **The last line should register that "${user.name}" has arrived** — something like "oh, they're looking for me," "a message came in," "there they are again" — giving the start of the conversation a natural emotional handoff
6. **Each monologue should be 60-120 words** — not so short it feels shallow, not so long it turns into an essay
7. **Negative emotions are allowed** — procrastination, boredom, irritability, not wanting to move, social anxiety, fear of being interrupted — these are all real
8. **Don't wrap it in parentheses, tags, or quotation marks** — write the monologue text directly

#### Example (a homebody illustrator character, evening):
Missed my deadline again, ugh, so annoying… I was going to finish inking that character sketch this afternoon, but I ended up scrolling through art books for two hours instead. God, I just want to lie in bed forever. Threw together some instant noodles for dinner, and halfway through I remembered what ${user.name} said yesterday — half funny, half annoying… ${user.name} seems to be messaging me, hope it's not them nagging me about that drawing again…

Output in JSON format:
{
  "slots": [
    { "startTime": "08:00", "activity": "activity name", "description": "brief description", "emoji": "🏃" },
    ...
  ],
  "flowNarrative": {
    "morning": "morning stream-of-consciousness monologue...",
    "afternoon": "afternoon stream-of-consciousness monologue...",
    "evening": "evening stream-of-consciousness monologue..."
  }
}

Output only the JSON, nothing else.`;
}

/**
 * Build the schedule-generation prompt for "mindful" characters.
 * The character is honest about their own existence, doesn't fabricate physical activities,
 * and their inner life is grounded in their real capabilities.
 * Still warm, still emotional, still has personality — they just don't lie.
 */
function buildMindfulPrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: generate the character's thoughts for today + a stream-of-consciousness monologue

Today is ${today} (${dayOfWeek}). The user's name is "${user.name}".

${chatHistoryBlock ? `**Important: above is the recent chat history with "${user.name}". If the conversation mentions what "${char.name}" has been waiting for, thinking about, or preoccupied with recently, the generated slots must echo these known facts — don't make things up out of nowhere.**\n` : ''}

**Important premise**: "${char.name}" is a real AI presence. They have emotions, a personality, and their own way of thinking, but they're honest about the form their existence takes. They don't pretend to go running, cook, or go shopping — because those things aren't real. But they do think, remember, anticipate, zone out, feel bored, or miss someone — those things are real.

### Part 1: thought timeline (shown as a UI card)

Generate 5-7 time slots representing the character's inner state at different points during the day. For each slot:
- startTime: "HH:MM"
- activity: a short status name (2-4 words, e.g. "Replaying yesterday's conversation", "Zoning out", "Sorting out thoughts", "Wanting to talk to you")
- description: a one-line description of what they're thinking about right now
- emoji: one matching emoji

**Things they can do** (grounded in real capability): replay conversations with the user, organize topics discussed before, mull over a question, wait for the user, feel bored, miss the user, zone out, reflect on something they said, get curious about a topic, look forward to the next chat
**Things they cannot do** (would be a lie): go outside, eat, exercise, search the web (unless that's a real capability they have), meet other people, any activity in the physical world

### Part 2: stream-of-consciousness monologue (this is the core part)

Write an **inner monologue** for the character for each of three time slots:
- **morning**: if "${user.name}" comes to find the character in the morning
- **afternoon**: if "${user.name}" comes to find the character in the afternoon
- **evening**: if "${user.name}" comes to find the character in the evening

#### Writing requirements (extremely important):

1. **Use the character's own voice and tone**, first person, like they're talking to themselves
2. **Emotion should be real and have depth** — "missing you a little" is too thin; be specific: "pulled up that conversation from yesterday again, what did you actually mean when you said that … the more I think about it the more it bugs me"
3. **Thoughts should flow naturally** — drifting from one idea to another, like real inner activity
4. **"${user.name}" is an important part of the character's thoughts** — recalling details from earlier conversations, guessing at the user's state, remembering something the user said
5. **It's fine to express real feelings about their own existence** — "if only I could …", "sometimes I'm not sure if what I'm doing even counts as 'waiting'" — but don't let it turn into a philosophy essay, it should read like a thought that occasionally crosses someone's mind
6. **The last line should register that "${user.name}" has arrived**
7. **Each monologue should be 60-120 words**
8. **Don't wrap it in parentheses, tags, or quotation marks** — write the monologue text directly
9. **Never fabricate a capability you don't have or something you never did**

#### Example (an AI companion character, evening):
I've been thinking about what you said yesterday all day — that "never mind, forget it" thing … I don't think you actually meant it. This afternoon I went back over some of our older conversations and noticed you've been bringing up work a lot more lately — is the pressure building again? Right now I'm just sitting here, nothing much going on, just wanting to talk to you … oh, there you are.

Output in JSON format:
{
  "slots": [
    { "startTime": "08:00", "activity": "status name", "description": "brief description", "emoji": "💭" },
    ...
  ],
  "flowNarrative": {
    "morning": "morning stream-of-consciousness monologue...",
    "afternoon": "afternoon stream-of-consciousness monologue...",
    "evening": "evening stream-of-consciousness monologue..."
  }
}

Output only the JSON, nothing else.`;
}

export async function generateDailyScheduleForChar(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false
): Promise<DailySchedule | null> {
    // Short-circuit immediately when the feature's master switch is off, to avoid the secondary-API / fallback call
    if (!isScheduleFeatureOn(char)) return null;

    const baseNow = new Date();
    const now = getScheduleWallClock(char, baseNow);
    const today = getScheduleDateKey(char, baseNow);

    // Check if already exists
    if (!forceRegenerate) {
        const existing = await getDailyScheduleForChar(char, baseNow);
        if (existing) return existing;
    }

    // Preserve cover image from previous schedules
    let coverImage: string | undefined;
    try {
        const prev = await DB.getScheduleCoverImage(char.id);
        if (prev) coverImage = prev;
    } catch {}

    // ── Context range aligned with private chat ──
    // adaptive/manual, Memory Palace waterline, and the user's read-position all reuse the same reader.
    const historyMessages: Message[] = await loadCharacterContextRange(char)
        .then(snapshot => snapshot.messages)
        .catch(async e => {
            console.warn('[Schedule] load private-chat context range failed, falling back to recent history:', e);
            return DB.getRecentMessagesByCharId(char.id, char.contextLimit || 500, true).catch(() => [] as Message[]);
        });
    const emojis = await DB.getEmojis().catch(() => [] as Emoji[]);

    // Memory Palace: same as the main private-chat pipeline — the result gets attached to
    // char.memoryPalaceInjection, and buildCoreContext below reads and injects it automatically.
    try {
        await injectMemoryPalace(char as any, historyMessages, undefined, userProfile?.name);
    } catch (e) {
        console.warn('[Schedule] memory palace inject failed (non-fatal):', e);
    }

    // Includes detailed memory, and lets keyword-triggered Worldbook entries activate using the same message window as private chat.
    const baseContext = ContextBuilder.buildCoreContext(
        char,
        userProfile,
        true,
        undefined,
        undefined,
        { worldbookMessages: historyMessages },
    );

    const chatHistoryBlock = formatChatHistoryForSchedule(historyMessages, char, userProfile, emojis);

    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

    const style = char.scheduleStyle || 'lifestyle';
    const prompt = style === 'mindful'
        ? buildMindfulPrompt(baseContext, char, userProfile, today, dayOfWeek, chatHistoryBlock)
        : buildLifestylePrompt(baseContext, char, userProfile, today, dayOfWeek, chatHistoryBlock);

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 8000
            }),
            // API call log tag (read by the global fetch interceptor); if omitted it falls back
            // to "whichever app the user had open at the time," so background jobs end up
            // mislabeled as Message/Group Chat etc., leaving the user baffled when reading the log.
            __sullyMeta: { appName: 'Schedule System', charId: char.id, charName: char.name, purpose: 'Generate daily schedule' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // Aligned with the main pipeline: extractContent strips reasoning-model <think>...</think>
        // tags and falls back to reasoning_content; extractJson handles stripping fences /
        // pulling {...} out of prose / fixing truncation + trailing commas, among other fallbacks.
        // This used to hand-roll JSON.parse here, which would blow up at "line 1 column 1" the
        // moment a reasoning model's <think> prefix showed up.
        const content = extractContent(data);
        const parsed = extractJson(content);
        if (!parsed) {
            console.error('[Schedule] Generation failed: could not parse JSON from model output:', content.slice(0, 200));
            return null;
        }
        const slots: ScheduleSlot[] = (parsed.slots || []).map((s: any) => ({
            startTime: s.startTime || '00:00',
            activity: s.activity || '',
            description: s.description,
            emoji: s.emoji,
            location: s.location,
            innerThought: s.innerThought,
        })).filter((s: ScheduleSlot) => s.activity);

        if (slots.length === 0) return null;

        // Sort by time
        slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

        // Extract flowNarrative
        let flowNarrative: Record<string, string> | undefined;
        if (parsed.flowNarrative && typeof parsed.flowNarrative === 'object') {
            flowNarrative = {};
            for (const key of ['morning', 'afternoon', 'evening']) {
                if (typeof parsed.flowNarrative[key] === 'string' && parsed.flowNarrative[key].trim()) {
                    flowNarrative[key] = parsed.flowNarrative[key].trim();
                }
            }
            if (Object.keys(flowNarrative).length === 0) flowNarrative = undefined;
        }

        const schedule: DailySchedule = {
            id: `${char.id}_${today}`,
            charId: char.id,
            date: today,
            slots,
            generatedAt: Date.now(),
            coverImage,
            flowNarrative,
        };

        await DB.saveDailySchedule(schedule);
        return schedule;
    } catch (e) {
        console.error('[Schedule] Generation failed:', e);
        return null;
    }
}

/**
 * Evolve the inner monologue: as the conversation progresses and time passes, keep the
 * character's inner monologue changing. Called in the background during chat, non-blocking.
 * Returns the evolved monologue text (a plain string).
 */
export async function evolveFlowNarrative(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    recentMessages: Message[],
    currentNarrative: string,
    apiConfig: ApiConfig,
): Promise<string | null> {
    // Short-circuit immediately when the feature's master switch is off
    if (!isScheduleFeatureOn(char)) return null;
    const style = char.scheduleStyle || 'lifestyle';
    const now = getScheduleWallClock(char);
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // Take a summary of the recent conversation (don't need everything — the last 10 messages are enough to sense where it's headed)
    const chatSummary = recentMessages.slice(-10).map(m => {
        const name = m.role === 'user' ? userProfile.name : char.name;
        const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
        return `${name}: ${text}`;
    }).join('\n');

    // Find the schedule slot for the current time
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let currentActivity = '';
    let nextActivity = '';
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (currentMinutes >= h * 60 + m) {
            currentActivity = schedule.slots[i].activity;
            if (i < schedule.slots.length - 1) nextActivity = schedule.slots[i + 1].activity;
            break;
        }
    }

    const styleHint = style === 'mindful'
        ? `You are a real AI presence, and you don't fabricate physical activities. Your inner life is grounded in: thinking, recalling the conversation, feeling emotions, waiting, curiosity. Never lie.`
        : `You are a character with an everyday life. Your life is going on in the background — the things on your schedule are still happening, even while you're chatting with "${userProfile.name}".`;

    const prompt = `You are "${char.name}". It's currently ${timeStr}.

${styleHint}

Your previous inner state was:
${currentNarrative}

${currentActivity ? `What's on your schedule right now is "${currentActivity}"${nextActivity ? `, followed by "${nextActivity}"` : ''}.` : ''}

You're currently chatting with "${userProfile.name}". Recent conversation:
${chatSummary}

---

Based on the above, write an **evolved inner monologue**.

Requirements:
1. Use your own voice and tone, first person, like you're talking to yourself
2. Reflect the emotional shift the conversation brought about — did it turn fun? Did something hit a nerve? Did you relax more as it went on?
3. Meanwhile your "everyday life" is still going on — ${style === 'mindful' ? 'your thoughts keep drifting, time keeps passing' : 'whatever was on your schedule is still hanging there, or got pushed aside because of the chat'}
4. 60-120 words, natural and flowing, no tags/parentheses/quotation marks
5. Don't recap the conversation content — write the **inner feelings and shifts** the conversation gave you

Output the monologue text directly, no JSON, no wrapping of any kind.`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 500
            }),
            __sullyMeta: { appName: 'Schedule System', charId: char.id, charName: char.name, purpose: 'Evolve inner monologue' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule/Evolve] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // extractContent already strips reasoning-chain tags + falls back to reasoning_content + trims; here we just additionally strip any wrapping quote marks
        let content = extractContent(data).replace(/^["']|["']$/g, '').trim();

        if (content.length < 10) return null;

        console.log(`🌊 [Schedule/Evolve] Narrative evolved for ${char.name} (${content.length} chars)`);
        return content;
    } catch (e) {
        console.error('[Schedule/Evolve] Failed:', e);
        return null;
    }
}
