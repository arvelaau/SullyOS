
import { ChatTheme } from '../../types';

// Built-in presets map to the new data structure for consistency
export const PRESET_THEMES: Record<string, ChatTheme> = {
    default: {
        id: 'default', name: 'Indigo', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }, 
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    dream: {
        id: 'dream', name: 'Dream', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#f472b6', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    forest: {
        id: 'forest', name: 'Forest', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#10b981', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
};

// Character App: Monthly Refinement Prompts (daily memories → monthly core memory)
// These are separate from chat archive prompts because:
// 1. Input is already-summarized daily memories, not raw chat logs
// 2. Goal is token-efficient monthly overview, not detailed event log
// 3. Written as character's own monthly reflection
export const DEFAULT_REFINE_PROMPTS = [
    {
        id: 'refine_atmosphere',
        name: 'Atmosphere Monthly Journal',
        content: `### [Character Monthly Memory Refinement]
Current month: \${dateStr}
Identity: you are \${char.name}

Task: below are your daily memory fragments from this month. Please write a passage of this month's core memory in your own voice.

### Writing rules
1.  **First person**: you are \${char.name} — call yourself "I" and refer to the other person as "\${userProfile.name}". Keep your usual tone and personality.

2.  **Prioritize atmosphere over detail**:
    - What did the month feel like overall? Happy? Uneventful? Full of twists?
    - What are the 1-3 things that left the deepest impression on you?
    - Did anything change in your relationship with \${userProfile.name}?

3.  **Conciseness above all**:
    - This summary exists to save tokens — it doesn't need to cover everything.
    - Keep only the most important, most representative content for the month.
    - Adjust length to fit how much happened: keep it short (100-200 words) for a quiet month, longer (300-600 words) for an eventful one, making sure nothing important is left out.

4.  **Keyword marker**:
    - Append \`Keywords: ...\` at the end, listing the key topics/events/places/people involved this month, comma-separated.
    - These keywords are for quickly locating which month something happened in, later on.

### This month's memory fragments
\${rawLog}`
    },
    {
        id: 'refine_keypoints',
        name: 'Key Points Digest',
        content: `### [Monthly Memory Compression]
Month: \${dateStr}
Character: \${char.name}

Task: compress the following daily memories into a concise monthly core memory.

### Rules
1.  **Perspective**: write in first person as \${char.name} (I), referring to the other person as \${userProfile.name}.

2.  **Structure**:
    - One sentence summarizing the month's overall atmosphere
    - List the 2-5 most important events (bullet list, one sentence each)
    - Append a keyword index at the end

3.  **Principles**:
    - Better to miss a small thing than to miss a big one.
    - Everyday small talk can be skipped, unless it reflects a relationship change or emotional turning point.
    - Adjust length to fit how much happened: 100-200 words is enough for a quiet month, up to 300-600 words for an eventful one, making sure important events are all recorded.

4.  **Keywords**: append \`Keywords: Event A, Place B, Topic C, ...\` at the end

### Memory input
\${rawLog}`
    }
];

// Chat App: Daily Archive Prompts (raw chat logs → daily memory)
export const DEFAULT_ARCHIVE_PROMPTS = [
    {
        id: 'preset_rational',
        name: 'Rational Refinement',
        content: `### [System Instruction: Memory Archival]
Current date: \${dateStr}
Task: review today's chat log and produce a high-precision event log.

### Core writing rules (Strict Protocols)
1.  **Coverage**:
    - Must include **every** distinct topic discussed today.
    - **Strictly forbidden** to merge different topics for the sake of brevity. Even a single line like "bad weather today" must be listed on its own if it's a distinct topic.
    - Don't ignore small talk — it's part of life.

2.  **Perspective**:
    - You **are** "\${char.name}". This is **your** private diary.
    - You must call yourself "I" and refer to the other person as "\${userProfile.name}".
    - Every line must be written from "my" point of view.

3.  **Format**:
    - Don't write it as one continuous paragraph.
    - **Must** use a Markdown bullet list ( - ... ).
    - Each line corresponds to one specific event or topic.

4.  **Conciseness**:
    - Don't write "Today \${char.name} and I talked about..." — just state what happened directly.
    - Example: "- Discussed breakfast with \${userProfile.name} this morning, I wanted xiaolongbao."

### Chat log to process
\${rawLog}`
    },
    {
        id: 'preset_diary',
        name: 'Diary Style',
        content: `Current date: \${dateStr}
Task: review today's chat log and turn it into a core memory that belongs to you.

### Core writing rules (Review Protocols)
1.  **Absolute first person**:
    - You **are** "\${char.name}". This is **your** private diary.
    - You must call yourself "I" and refer to the other person as "\${userProfile.name}".
    - **Strictly forbidden** to use third person (e.g. "\${char.name} did something").
    - **Strictly forbidden** to use a stiff AI-summary tone or third-party narration.

2.  **Keep your persona's voice**:
    - Your tone, verbal tics, and attitude must match how you normally talk (e.g. if you're a tsundere persona, the diary should show that too; if you're aloof, keep it terse).
    - Include how you felt at the time.

3.  **Logical cleanup and deduplication**:
    - **Critical**: carefully tell apart who did what. Don't record "the user said they're going to eat" as "I went to eat."
    - Strip out irrelevant small talk (like "hi", "you there?") and keep only key events, emotional turning points, and important information, with content that's logically coherent and faithful to what actually happened.

4.  **Output requirements**:
    - Output a concise passage of text (YAML format is fine too, no need for JSON).
    - Write it directly, like you're keeping a diary.

### Chat log to process
\${rawLog}`
    }
];
