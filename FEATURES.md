# SullyOS — Feature & Architecture Map

> Companion document to `CLAUDE.md`. **CLAUDE.md tracks the Chinese→English UI translation effort specifically** (progress log, glossary, protocol-safety rules). **This file maps the product/architecture**: what each feature does, which files build it, and what else breaks if you touch it. Useful with or without the translation context.
>
> Indonesian version: [`FEATURES.id.md`](./FEATURES.id.md). Keep both in sync when this file changes.
>
> **Verification key** used throughout: 🟢 **VERIFIED** = read in detail (during the translation pass or while writing this doc). 🟡 **INFERRED** = based on a grep-level scouting pass, not a full read — treat specifics as probably-right, not certain. 🔴 **NOT YET LOOKED AT** = named/known to exist, content unconfirmed.
>
> This file should be updated whenever a new system or cross-feature link is discovered — same discipline as CLAUDE.md's Progress log.

---

## 1. Overview

SullyOS is a **simulated phone OS** — the whole app is a lock screen + home screen + a grid of "apps," each app being one feature of an AI-companion/character-simulation product. There is no backend-required server component for the core experience; state lives in **IndexedDB** (`utils/db.ts`) and the app is designed **local-first** (per `docs/code-organization-review.md`, though that same doc flags that the styling layer currently *isn't* truly local-first — it pulls Tailwind from a CDN at runtime).

**App registry — `constants.tsx`.** `INSTALLED_APPS: AppConfig[]` is the single source of truth for which apps show icons on the home-screen grid, their display name, icon, and accent color. `AppID` (an enum in `types.ts`) is the stable identifier used everywhere else. A few apps exist but are intentionally not in `INSTALLED_APPS` (commented out / hidden) yet are still reachable and still tracked for analytics via `HIDDEN_APP_NAMES` — e.g. **Homeland** (`AppID.WorldHome`) has no desktop icon of its own anymore; you reach it through **Dwelling** (`AppID.Room`). `DOCK_APPS` is a small fixed list (Chat, Group Chat, Spark, Settings) pinned to the bottom dock regardless of the grid.

**Shell rendering — `components/PhoneShell.tsx` + `context/OSContext.tsx`.** `OSContext.tsx` (🟢 VERIFIED at a structural level — see `docs/code-organization-review.md`'s hub-file analysis) is one enormous Context Provider (~4,259 lines at last measurement) holding almost all cross-cutting app state: `activeApp`, `characters`, `theme`, toasts, virtual clock, backup/restore, API config, and more — exposed via a single `useOS()` hook consumed by ~70 files. `PhoneShell.tsx` reads `activeApp` from `useOS()` and renders the matching screen through one large `switch (activeApp)` statement (one `case` per `AppID`, e.g. `case AppID.Chat: return <Chat />`). Opening an app = calling `openApp(AppID.X)` from anywhere, which just updates `activeApp` in the shared context.

**"Character" as the central entity.** Almost every feature revolves around a `CharacterProfile` (defined in `types.ts`, a large type — see below). A character has: identity (`name`, `systemPrompt`, `worldview`), a message history, Memory Palace state, relationship/affinity numbers, per-feature toggles (Observe protocol, time-awareness, Life Record injection, etc.), and appearance data (portraits per emotion, voice config). Most apps either **display/edit** a character, or **generate a message as** a character by assembling a system prompt from character fields + injected context (memories, schedule, relationships, real-world time/weather) and calling an LLM `chat/completions` endpoint.

**Multi-character home-screen "skins."** The home screen isn't fixed — `theme.skin` (part of the theme state in `OSContext`, set via **Appearance**/**Bubble Workshop**) picks between the default app-grid Launcher and several alternate full-screen home experiences: `'companion'` (renders `components/os/CompanionHome.tsx`, itself with 5 sub-variants — Cardbook/Cat/Idol/Magazine/Otome chrome), `'animalcrossing'`, `'mobilegame'`, `'tamagotchi'`. See §2.6.

---

## 2. Core systems shared across features

These are the systems that many independent-looking apps all secretly depend on. Read this section before changing any of them — the blast radius is usually much bigger than the one file you're editing.

### 2.1 Chat protocol — bracket/tag wire format 🟢 VERIFIED (extensively, across the whole translation pass)

**What it is.** The LLM is taught, via prompt text in producer files, to emit specific bracket-tagged or XML-style-tagged substrings in its replies. Consumer files then regex-parse those tags back out to drive UI behavior (render a card, strip a marker, trigger an action). **This is the single riskiest system in the codebase from a translation/refactor standpoint** — many of these tag *names* are literal Chinese words, not just Chinese content inside English tags, so translating the word breaks the regex that matches it.

**Producer:** `utils/chatPrompts.ts` (~659 CJK lines, still not fully translated — teaches the AI most of these tags) and several feature-specific prompt files (`utils/groupChat/prompts.ts`, `utils/like520/prompts.ts`, `utils/vrWorld/prompts.ts`, `utils/worldHome/prompts.ts`, `utils/datePrompts.ts`, `utils/songPrompts.ts`, `utils/lifeSimPrompts.ts`, `utils/guidebookPrompts.ts`, `utils/htmlPrompt.ts`, `utils/thinkingChainPrompt.ts`).

**Consumer:** `utils/chatParser.ts`, `components/chat/MessageItem.tsx` (the message-bubble renderer — its `stripJunk` function alone strips/parses ~10 distinct tag families), `utils/applyAssistantPostProcessing.ts`, `utils/promptMessageCleanup.ts`, `utils/sanitize.ts`.

**Confirmed tag families** (see CLAUDE.md's "Two categories of Chinese text" section for the full authoritative list, kept current there):
- `[[MUSIC_ACTION:add|...]]` — music action tag.
- `[引用:...]` / `[QUOTE:...]` (bilingual) and the `「」`-quoted imitated-history variant — quote/reply tags.
- `[回复"..."]` — reply tag (Chinese word + curly quotes).
- `<语音>...</语音>` / `<字幕>...</字幕>` — voice/subtitle tags. **The tag *names* are Chinese words.**
- `[系统: ...]` / `[System Log]` / `[系统记录]` / `[小屋动态]` — system-notice prefix tags (bilingual-safe: the parsing regex already accepts either "System" or "系统").
- `ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|SEND_EMOJI|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END` — a family of `[[TAG:...]]` action tags.
- `schedule_message`, `%%TRANS%%`, `%%BILINGUAL%%` — misc markers.
- `[[XHS_SEARCH:...]]` / `[[XHS_DETAIL:...]]` / `[[XHS_BROWSE]]` / `[[READ_NOTE:...]]` / `[[SEARCH:...]]` — Xiaohongshu / notes / web-search action tags (`utils/chatPrompts.ts`, `utils/xhsFreeRoam.ts`, `utils/applyAssistantPostProcessing.ts`).
- `⟦OBSERVE⟧...⟦/OBSERVE⟧` — see §2.5, its own subsystem.
- `<续>`/`<标题>`/`<主题>`/`<起笔>`/`<动态>` — VRWorld's "Signal Fall" relay-poem tags (`utils/vrWorld/prompts.ts`).
- `[[LIFE:PERIOD_START]]` / `[[LIFE:PERIOD_END]]` — Life Record period-tracking tags (`utils/lifeRecords.ts`).
- A colon-delimited `label：value` line format (distinct system) used by Story Theater's `StoryOutput` parser — see §3's Date entry.

**"Placeholder" pattern, easy to mistake for protocol risk but usually safe:** several message types (`novel_card`, `trpg_card`, `score_card`, `vr_card`, `group_topic_card`) persist a short human-readable Chinese placeholder string as `message.content` (e.g. `[分享帖子]`), but the *actual* AI-facing text is rebuilt from `message.metadata` by a producer function (`utils/chatPrompts.ts`, `utils/messageFormat.ts`) that ignores the raw `content` field entirely. These placeholders were safe to translate. Always verify which pattern applies per-file — don't assume.

**Depends on this system:** `apps/Chat.tsx` (primary 1:1 chat), `apps/GroupChat.tsx`, `apps/CallApp.tsx` (its own `通话`/`聊天`/`约会` source-tag sub-family, see §3), `apps/CheckPhone.tsx`, `apps/SocialApp.tsx`, `apps/NovelApp.tsx`, `apps/GameApp.tsx`, `apps/GuidebookApp.tsx`, `apps/LifeSimApp.tsx`, `apps/WorldHomeApp.tsx`, `apps/VRWorldApp.tsx`, `components/lifeRecord/LifeRecordPanel.tsx`, `components/date/story/` (Story Theater).

### 2.2 Memory Palace — `utils/memoryPalace/` 🟢 VERIFIED (structurally; see `docs/memory-system-overview.md` for full detail)

**What it is.** A vector-based long-term memory system modeled loosely on brain anatomy — the authoritative doc is **`docs/memory-system-overview.md`**, read that for the full pipeline. Short version: character message history flows through a buffered pipeline into **7 "rooms"** (`living_room`/hippocampus, `bedroom`/neocortex, `study`/prefrontal cortex, `user_room`, `self_room`/never decays, `attic`/never decays — unprocessed trauma, `windowsill`/never decays — hopes & goals), each with different capacity and decay rates. There is also an older, parallel, non-vector system (`memories: MemoryFragment[]` + `refinedMemories` monthly summaries) still in use — see `docs/memory-system-overview.md`'s "System 1" section and `components/chat/ChatConstants.ts`'s `DEFAULT_REFINE_PROMPTS`/`DEFAULT_ARCHIVE_PROMPTS`.

**Key files:** `utils/memoryPalace/pipeline.ts`, `digestion.ts` (both PARTIALLY protected — see CLAUDE.md), `extraction.ts`, `groupExtraction.ts`, `externalMemory.ts`, `bm25.ts` (keyword-match fallback for vector search), `recallRouter.ts`, `memoryRepair.ts`, `autoArchive.ts`, `types.ts` (`PLATE_TITLES`, `MemoryNode` — 20 files import this domain `types.ts`).

**Depends on this system:** `apps/MemoryPalaceApp.tsx` (the management UI itself), `apps/CheckPhone.tsx` (`injectMemoryPalace` — query-hinted by the contact's name), `apps/Character.tsx` (`handleRefineMonth`, the monthly-summary flow), `components/date/story/StoryTheaterSession.tsx` (`processNewMessagesWithAutoArchive`, `runCognitiveDigestion`), `components/ValentineEvent.tsx`/`WhiteDayEvent.tsx` (memory-palace query hints — **left un-translated on purpose**, translating the query string risks degrading embedding-search recall quality, a documented tier-3 risk in CLAUDE.md), `components/character/RoomPlatePanel.tsx` (room-plate UI, `TAG_ICONS` match arrays permanently protected).

### 2.3 Analytics / `trackEvent` — `docs/analytics.md` 🟢 VERIFIED

**What it is.** Self-hosted [umami](https://umami.is/) analytics, opt-out-by-config, no cookies/IP/conversation content ever collected — read `docs/analytics.md` for the full disclosure (what's collected, why, how to verify/disable). The document's own stated design rule was: **event names are deliberately in Chinese, matching the UI text exactly**, so anyone opening devtools can read what an event means without a translation table.

**Translation-era decision (documented in CLAUDE.md):** this rule was explicitly overridden for this project — as each file gets translated, its `trackEvent()` calls are translated too (event name **and** any Chinese property keys/enum values), in lockstep with the UI. This permanently splits analytics continuity in the umami backend at the point each file is translated — a deliberate, accepted, one-way cost. ~710 call sites across 77 files were identified at the start of the effort; by the most recent count, `apps/Settings.tsx` alone has 83.

**Depends on this system:** literally every app and most components — `trackEvent(name, properties?)` is called ad hoc throughout the codebase, no central registry.

### 2.4 Character/persona core — storage & prompt assembly 🟡 INFERRED for the assembly path, 🟢 VERIFIED for storage shape

**What it is.** `CharacterProfile` (`types.ts:2619`, a very large interface — dozens of fields spanning identity, appearance, memory config, relationship state, per-feature toggles) is the core data shape. Characters are created/edited in **`apps/Character.tsx`** 🔴 (not yet translated — HIGH risk per the scouting pass; builds a full inline monthly-memory-refinement prompt in `handleRefineMonth`, and is the file that owns the "Life Record Injection" toggle and the still-Chinese "心象/Psyche" feature reference). Prompt assembly for a chat turn is centralized through **`utils/context.ts`**'s `ContextBuilder` (`buildCoreContext`, `buildRoleSettingsContext`) — this is what injects memories, real-world time/weather, schedule, and relationship state into what the LLM actually sees. `utils/db.ts` (~3,309 lines, 108 importers per `docs/code-organization-review.md`) is the IndexedDB storage layer for characters and everything else.

**Depends on this system:** every app that talks to an LLM as a character (Chat, Call, GroupChat, CheckPhone, Date, Room, Bank, Schedule, Songwriting, Game, Journal, Guidebook, LifeSim, VRWorld, WorldHome, Study — i.e. almost everything).

### 2.5 Observe protocol — `utils/datePrompts.ts` 🟢 VERIFIED (this session renamed its wire-format fields)

**What it is.** A structured "holographic HUD" feature for the **Date** app — read **`docs/date-observe.md`** for the full spec. When enabled (per-character), the LLM is asked to prefix each reply with a structured `⟦OBSERVE⟧...⟦/OBSERVE⟧` block covering up to 4 dimensions (time/location/status/detail, renamed from Chinese to English field names in an earlier translation batch — `utils/datePrompts.ts`'s `OBSERVE_DIMENSIONS`) plus up to 6 user-defined custom dimensions. The frontend strips the block out of the display text and renders it as a separate floating HUD panel with 5 visual styles (Hologram/Ink Wash/Neon/Crystal/Terminal — also just translated).

**Key files:** `utils/datePrompts.ts` (`OBSERVE_DIMENSIONS`, single source of truth for the field names actually injected into the prompt), `components/date/ObserveHUD.tsx` (rendering + style presets), `components/date/ObserveSettings.tsx` (per-character config UI), `components/date/DateSession.tsx` (parses the block out of LLM output).

**Depends on this system:** only `apps/DateApp.tsx` and its `components/date/` subtree. Self-contained — doesn't leak into other apps.

### 2.6 "OS skin" alternate launcher themes — `components/os/` 🟢 VERIFIED

**What it is.** An entirely separate, parallel home-screen renderer system, selected by `theme.skin` (see §1). Instead of the app-grid Launcher, the user can pick a fully different home-screen experience built around one companion character: `CompanionHome.tsx` (with 5 chrome variants — Cardbook/Cat/Idol/Magazine/Otome), or the `animalcrossing`/`mobilegame`/`tamagotchi` skins (`apps/Launcher.tsx` branches on `theme.skin` early and renders these instead of the grid).

**Important gotcha (documented in CLAUDE.md, found during translation):** these alternate skins maintain their **own separate, independently-hardcoded copies** of concepts that also exist in the default UI — e.g. app display names are NOT reused from `constants.tsx`'s `INSTALLED_APPS`, they're a second, parallel label system inside `components/os/`. If you rename something in one place, it does not propagate to the other. Also has its own scheme/currency system (`gotchiScheme.ts`'s `SCHEMES[].name`, still Chinese — a documented "producer not yet translated" gap in CLAUDE.md's "Still open" section).

**Depends on this system:** nothing depends on it (it's a leaf renderer), but it depends on **most other systems being character-aware** (it shows portraits, unread counts, current activity, etc. pulled from `OSContext`).

### 2.7 Worker backend (optional, self-deployed) — `worker/*` 🟢 VERIFIED (deploy story) / 🟡 INFERRED (internal implementation)

**What it is.** SullyOS's core experience needs **no backend at all** (local-first, IndexedDB). A small number of features optionally connect to user-self-deployed Cloudflare Workers for capabilities a pure static frontend can't do alone (server-side push delivery, cross-user shared state, MCP tool proxying). The authoritative deploy doc is **`docs/self-deploy-workers.md`** — read that before touching deploy config.

| Worker dir | Feature it powers | Needs Cloudflare D1? | Notes |
|---|---|---|---|
| `worker/amsg/` | **Proactive Message 2.0** — character messages you proactively, on a schedule, even with the app closed | **Yes** | Biggest bundle (~617 KB). Settings UI: `components/settings/ActiveMsgGlobalSettingsModal.tsx` ("Real-time Perception" feature name lives here). Diagnostics: `utils/amsgDiagnostics.ts` 🔴 (still Chinese, documented gap in CLAUDE.md). |
| `worker/instant-push/` | **Instant Push** — chat replies delivered via background push even with the tab closed | No (optional) | |
| `worker/mcp-proxy/` | Lets a character connect to a user-configured MCP tool server | No | UI: `components/settings/McpConnectionConsole.tsx`. |
| `worker/post-office/` | VR World's cross-user features — the "Signal Fall" relay-poem event (see `docs/signal-poetry.md`) and guestbook/letter delivery | 🟡 not confirmed here, check the doc | Backend counterpart to `utils/vrWorld/prompts.ts`'s tag protocol. |
| `worker/proactive-push/` | 🔴 **Per `docs/code-organization-review.md`: dead code, force-disabled on the frontend (`FORCE_DISABLED=true`), but still documented as if live in some places.** Don't deploy this one without checking current status first. | — | |
| `worker/xhs-lite/` | 🔴 Per the same doc, this directory now only contains docs/tests — the actual code was merged into a monolithic `worker/index.js` (~3,771 lines, undocumented in `README`/`docs/`, deployed by pasting into the Cloudflare panel rather than through the `worker/*` workspace). | — | Treat `worker/index.js` as a 🔴 mostly-unmapped "main proxy" handling search/WebDAV/GitHub/Notion/Feishu/MCP/XHS-lite and more. |

**Depends on this system:** Proactive Message/Instant Chat features surfaced in `components/settings/ActiveMsgGlobalSettingsModal.tsx` + `apps/Settings.tsx`; VRWorld's Signal Fall event and guestbook/post-office features in `apps/VRWorldApp.tsx`; any character's MCP tool access (Luckin/McDonald's ordering simulations, user-added MCP servers) via `components/settings/McpConnectionConsole.tsx`.

---

## 3. Per-app breakdown

One entry per `AppID`. 🟢/🟡/🔴 marks reflect how deeply that specific app's file(s) have been read (during translation or while writing this doc), not the correctness of the description — even 🔴 entries below are believed accurate at a high level, just not verified line-by-line.

**Character (Neural Link)** 🔴 — `apps/Character.tsx`. Create/edit characters: identity, system prompt, worldview, portraits per emotion, voice config, worldbook attachment, memory/archive prompt presets, and toggles for most per-character systems (Observe, time-awareness, Life Record Injection). Depends on §2.4 (owns it, really), §2.1 (system prompt teaches all the tag protocols), §2.2 (monthly memory refinement lives here). Connects to almost everything, since it's where a character's config for every other feature gets set.

**Memory Palace** 🟢 — `apps/MemoryPalaceApp.tsx` (translated). The management UI for §2.2 — room browsing, digest/archive controls, manual memory linking, backup/restore, cognitive-parameter tuning. Doesn't feed other apps directly; other apps call into `utils/memoryPalace/` functions, not this UI.

**Message (Chat)** 🔴 — `apps/Chat.tsx` (~3,720 lines, the single largest app component per `docs/code-organization-review.md`; not yet translated, HIGH risk). The primary 1:1 chat screen. Renders via `components/chat/MessageItem.tsx` (the tag-parsing/card-rendering engine, §2.1) and `components/chat/ChatModals.tsx`/`ChatInputArea.tsx` (already translated). Owns the daily-archive flow (`DEFAULT_ARCHIVE_PROMPTS`, §2.2's "System 1"), bilingual message translation (a literal `'把以下内容翻译成中文...'` AI directive at line ~624, flagged for explicit sign-off before translating), and the transfer/poke/forward placeholder patterns (§2.1). Connects to nearly every other system.

**Call** 🔴 — `apps/CallApp.tsx` (HIGH risk — **the single riskiest untranslated file**, per the scouting pass: it contains both the *producer* teaching-instructions AND the *consumer* regex for the `通话`/`聊天`/`约会` chat-protocol source tags, co-located in one file, unlike every other tag finding which splits across files). Voice/video call simulation with live2D/VRM avatar stage, static-shot fallback, "who speaks first" preferences. Depends on §2.1, §2.4.

**Group Chat** 🟡 — `apps/GroupChat.tsx` (MEDIUM risk, scouted not fully read). Multi-character group chat simulation. Has its own red-packet feature (`utils/groupChat/redpacket.ts`), a "group topic box" running-summary card, and imports `utils/groupChat/prompts.ts` (🔴 protected, not yet read). Depends on §2.1, §2.4.

**Dwelling (Room)** 🟡 — `apps/RoomApp.tsx` (MEDIUM risk, scouted). The "小小窝" pixel-home/room-decoration feature — place furniture, character "lives" in the room, room-observation system-notice messages. Launches **Dream Theater** (`apps/DreamTheater.tsx` 🔴, HIGH risk — full inline "director" prompt, same shape as `songPrompts.ts`) as a sub-feature (character dreams while idle/sleeping). Also the entry point to **Homeland** (see next).

**Homeland (WorldHome)** 🟢 — `apps/WorldHomeApp.tsx` (translated). No desktop icon of its own — reached via Dwelling. A narrative "world-building" feature (`NARRATIVE_STYLES` picker — 🔴 still Chinese, imported from `utils/worldHome/prompts.ts`, a documented "producer not yet translated" gap). Its `shareToChat()` embeds a `【家园 · X】...发了条动态：` bracket-tag prefix directly into persisted LLM-visible chat content — left protected on purpose.

**Check Phone** 🟡 — `apps/CheckPhone.tsx` (MEDIUM risk, scouted, but see **`docs/relationship-system.md`** for a thorough existing writeup — 🟢 that doc is authoritative). Lets a character "check" another character's (or a fictional NPC's) phone — contacts, affinity, real two-character-to-character conversations that stay in sync across both characters' histories, or single-LLM fictional NPC conversations. Depends heavily on §2.2 (`injectMemoryPalace` query-hinted by contact name), §2.4. Also launches **Persona Sim** (`apps/PersonaSim.tsx` 🔴, HIGH risk — a "screenlife director" prompt simulating what the character's own phone screen looks like) as a sub-feature.

**Date** 🟢 — `apps/DateApp.tsx` (translated, LOW risk — prompt-building centralized in `utils/datePrompts.ts`). A "meetup" simulation screen. Owns the Observe protocol (§2.5) and contains **Story Theater** as a subsystem (`components/date/story/`, 8 files, all translated) — a separate collaborative-fiction "theater mode" with its own colon-delimited `label：value` AI-output parser (`StoryTheaterSession.tsx`'s `StoryOutput`, protecting `AFFINITY_DIMENSIONS`, temperature labels, and several other literal-match label strings — see CLAUDE.md batch 6 notes). Depends on §2.2 (`processNewMessagesWithAutoArchive`, `runCognitiveDigestion`), §2.4.

**Profile (User)** 🟢 — `apps/UserApp.tsx` (translated). The user's own profile (name, bio, avatar) — simple, low cross-feature impact, but `userProfile.name` is read everywhere as the "other party" in prompts.

**Piggy Bank (Bank)** 🟡 — `apps/BankApp.tsx` (MEDIUM risk, scouted). A virtual finance/savings simulation — unusually, its main prompt is already mostly in English. Uses a `[系统: ...]` system-notice tag (§2.1) for visit/deposit narration.

**Exchange Diary (Journal)** 🔴 — `apps/JournalApp.tsx` (HIGH risk despite being a small file — `generateProseSummary` builds a full inline `### [系统指令: 交换日记归档]` prompt, confirmed not to collide with the `[系统: ...]` family's regex since "系统指令" doesn't match that pattern). A diary shared between user and character, each writing entries the other can read. Appearance/styling: `components/journal/JournalAppearanceEditor.tsx` (translated — settled the "Exchange Diary" glossary term used everywhere else this app is referenced).

**Spark (Social)** 🟢 — `apps/SocialApp.tsx` (translated). A social-media-feed simulation. Has 3 full protected AI-prompt templates (feed refresh/comments/replies) plus a `[分享帖子]`→`[Shared Post]` placeholder pattern (§2.1, confirmed safe).

**Study Room (Study)** 🟢 — `apps/StudyApp.tsx` (translated, LOW risk — most of its 7 `chat/completions` calls were already English).

**TRPG (Game)** 🔴 — `apps/GameApp.tsx` (HIGH risk — `buildSyncContext` is a large, entirely inline "GM"/tabletop-RPG director prompt fed to `chat/completions`). Also has confirmed-safe placeholder patterns (`trpg_card`, rebuilt from `metadata.trpg` by `utils/messageFormat.ts`, ignoring raw `content`).

**Pen Pal Society (Novel)** 🟢 — `apps/NovelApp.tsx` (translated). Collaborative novel-writing with characters. Uses a `novel_card` placeholder pattern (§2.1, confirmed safe, same trace precedent used for `[分享帖子]` above).

**Songwriting** 🟡 — `apps/SongwritingApp.tsx` (MEDIUM risk, scouted, 3 `role:'system'` sites not individually confirmed yet). Uses `[系统: ...]` for collaboration completion narration. Imports `utils/songPrompts.ts` (🟢 confirmed, entirely protected AI-prompt file).

**Beyond (VRWorld)** 🟢 — `apps/VRWorldApp.tsx` (translated, 778 CJK lines). A persistent shared virtual world with multiple rooms (Library, Rec Room, Guestbook, Post Office, and the special "Signal Fall" relay-poem event room — see `docs/signal-poetry.md`). Protected: user-broadcast message content built for real LLM chat history, and the `IDLE_QUIPS` ambient chibi-status array (confirmed safe, positionally indexed only). Depends on §2.7's `worker/post-office/` for cross-user features, imports `utils/vrWorld/prompts.ts` (🔴 protected, not yet read in full).

**Time Pact (Schedule)** 🔴 — `apps/ScheduleApp.tsx` (HIGH risk despite being a small file — two full inline prompt templates for task-completion and anniversary-reminder reactions). Character daily schedule/reminders. Uses `[系统: ...]` for task-completion narration (confirmed bilingual-safe).

**Worldbook** 🟢 — `apps/WorldbookApp.tsx` (translated). SillyTavern-style lorebook/worldbook entry editor, attachable to a character (§2.4). **Producer gap**: `utils/worldbook.ts`'s `WORLDBOOK_POSITION_LABELS`/`WORLDBOOK_ROLE_LABELS`/`WORLDBOOK_POSITION_DESCRIPTIONS` still render Chinese inside this now-English screen (documented in CLAUDE.md's "Still open" section) — also imported by `apps/Character.tsx`.

**Hot News (HotNews)** 🟢 — `apps/HotNewsApp.tsx` (translated). Simulated trending-topics/news feed for characters to reference or react to.

**Help (FAQ)** 🟢 — `apps/FAQApp.tsx` (translated). Static help/FAQ content, reads changelog data from `public/changelogs/`.

**Gallery** 🟢 — `apps/Gallery.tsx` (translated). Photo/image gallery, likely fed by chat-generated images and manual uploads.

**Free Roam (XhsFreeRoam)** 🟢 — `apps/XhsFreeRoamApp.tsx` (translated). A Xiaohongshu-("Little Red Book")-style free-browsing simulation for characters. Has its own AI-prompt file `utils/xhsFreeRoam.ts` (used the `[[XHS_SEARCH:...]]` family, §2.1).

**Xiaohongshu Gallery (XhsStock)** 🟢 — `apps/XhsStockApp.tsx` (translated). A stock-content browsing/gallery variant of the same Xiaohongshu simulation concept.

**Bubble Workshop (ThemeMaker)** 🟢 — `apps/ThemeMaker.tsx` (translated). Chat bubble color/shape theme customization, feeds `components/chat/ChatConstants.ts`'s `PRESET_THEMES` and per-character overrides.

**Appearance** 🟢 — `apps/Appearance.tsx` (translated). Controls `theme.skin` (§2.6) and other visual settings — the entry point for switching to an alternate OS skin.

**Settings** 🟢 — `apps/Settings.tsx` (translated, 949 CJK lines, the single largest translation job in the project — 83 `trackEvent` calls). Central hub for: API config (multiple providers), voice engine setup (MiniMax/Fish Audio/ElevenLabs), backup & restore (local ZIP/WebDAV/GitHub), §2.7's Proactive Message/Instant Push/MCP config, and the McDonald's/Luckin MCP tool integrations (whose activation trigger phrases, `麦请求`/`瑞一杯`, must stay literally Chinese — a near-miss caught during translation, see CLAUDE.md batch 7).

**Guidebook** 🟡 — `apps/GuidebookApp.tsx` (MEDIUM-LOW risk, scouted). A scored gameplay/quiz-style feature. Imports `utils/guidebookPrompts.ts` (🟢 confirmed, entirely protected). Uses a `score_card` placeholder pattern (confirmed safe — `utils/chatPrompts.ts` reduces it to a generic `[评分卡]` placeholder for live chat; `utils/messageFormat.ts` separately rebuilds the full summary for memory).

**City Life (LifeSim)** 🟡 — `apps/LifeSimApp.tsx` (MEDIUM-LOW risk, scouted). A life-simulation feature backed by `utils/lifeSimEngine.ts` (🔴 not read, described in `docs/code-organization-review.md` as "an entire game engine" at 1,486 lines) and `utils/lifeSimPrompts.ts` (🟢 confirmed, entirely protected). Shares the `score_card` placeholder pattern with Guidebook.

**Special Moments (SpecialMoments)** 🟡 — `apps/SpecialMomentsApp.tsx` (not individually scouted this session, but its sub-features are well known). A hub for seasonal/holiday event content: Valentine's Day (`components/ValentineEvent.tsx` 🟢 translated), White Day (`components/WhiteDayEvent.tsx` 🟢 translated), Qixi/Chinese Valentine's (`components/events/qixi/` 🟢 translated). All three import Memory Palace query hints (§2.2) and share a documented pattern of copy-pasted inline API-config panels between events (`docs/code-organization-review.md`'s D1 finding — a fix in one event's copy doesn't propagate to the others).

**Music** 🟢 — `apps/MusicApp.tsx` (translated). A music feature with a real NetEase Cloud Music API integration for search/playback, plus a "未来音楽" (deliberately Japanese-kanji branded, not Chinese) title screen. Backed by `context/MusicContext.tsx`.

**Character Creator (Dev)** 🟢 — `apps/CharCreatorDevApp.tsx` (translated). A dev-only PSD-import character-creation tool, filtered out of the Launcher in production builds.

**QQ Bridge (QQBridge, hidden)** 🟢 — `apps/QQBridge.tsx` (translated, lowest-risk file in the project — plain UI, no AI-prompt content, 1 `trackEvent`). A message-relay/bridge feature.

**Browser (hidden)** 🟢 — `apps/BrowserApp.tsx` (translated). An in-app fake web browser for characters to "browse." Matches literal Chinese site names (`小红书`/`哔哩哔哩`) against a user-typed address-bar string — a documented, deliberately-untouched risk category (matching something outside the codebase's control, same principle as a bracket-tag protocol even though it isn't one).

**Handbook (hidden, temporarily disabled in the Launcher)** 🟢 — `apps/HandbookApp.tsx` + `components/handbook/` (19 files, translated). The "手账" journal/planner/scrapbook feature — stickers, mood tracking, trackers (`utils/trackerSeeds.ts` 🔴, a documented producer-not-yet-translated gap). Some deliberately-Japanese design flourishes (font, season labels) left un-translated — not a translation gap, a design choice.

**Voice Designer (not in `INSTALLED_APPS`, reachable elsewhere)** 🟢 — `apps/VoiceDesignerApp.tsx` (translated). A TTS voice-mixing/design tool for MiniMax voices — its `PREVIEW_SAMPLES` (demo text in zh/yue/ja) are deliberately left in their native scripts, since translating would make a "preview this language" button speak the wrong language.

**Dream Theater (not in `INSTALLED_APPS`, launched from Dwelling)** — see the Dwelling entry above.

**Persona Sim (not in `INSTALLED_APPS`, launched from Check Phone)** — see the Check Phone entry above.

---

## 4. Dependency map — "if I touch X, what else might break"

Compiled from cross-file findings recorded during the translation pass (CLAUDE.md has the blow-by-blow; this is the architectural summary).

- **Change the chat-protocol tag names or regex (§2.1)** → breaks whichever of Chat/Call/GroupChat/CheckPhone/Social/Novel/Game/Guidebook/LifeSim/WorldHome/VRWorld/Handbook/lifeRecord actually uses that specific tag. The tag families are mostly independent of each other (changing the voice/subtitle tags doesn't affect the quote tags), but `MessageItem.tsx` is the single chokepoint that parses almost all of them — a bug there has the widest blast radius of any file in the app.
- **Change `utils/memoryPalace/` internals (§2.2)** → directly affects Memory Palace app, Check Phone, Character (monthly refine), Story Theater (Date app), and — more subtly — Valentine/WhiteDay/Qixi events' memory-query-hint behavior (quality regression, not a crash, if query phrasing changes).
- **Change `CharacterProfile` shape in `types.ts` (§2.4)** → per `docs/code-organization-review.md`, ~244 files (44.7% of the repo) import `types.ts` at all; `CharacterProfile` itself is ~137 fields. Realistically touches every app that renders or edits a character.
- **Change `OSContext.tsx`'s shared state shape** → ~70 files consume `useOS()`. Because the context value object is not memoized (a known issue per `docs/code-organization-review.md`), even *unrelated* context field changes can cause wide re-renders, not just direct dependents.
- **Change `utils/db.ts` (storage layer)** → 108 importers per the same doc; also self-referentially in a circular-dependency ring with `desktopSkinBackup`/`blobRef`.
- **Disable or change the Observe protocol (§2.5)** → self-contained, only affects Date app + Story Theater's separate parser (they use different mechanisms — don't assume a fix to one covers the other).
- **Change an "OS skin" (§2.6)** → self-contained rendering, but if you rename an app or feature, remember these skins keep their *own* separate copies of names/labels — a rename in `constants.tsx` does not propagate here.
- **Take down or reconfigure a `worker/*` backend (§2.7)** → `amsg` outage breaks Proactive Message/Instant Chat only; `post-office` outage breaks VRWorld's Signal Fall event and guestbook/mail only; `mcp-proxy` outage breaks user-configured MCP tool access only. These are independently deployed, so one going down doesn't cascade to the others — but each one going down silently degrades its feature rather than erroring loudly (per `docs/self-deploy-workers.md`'s troubleshooting section, `/debug`/`/config-check` endpoints exist specifically because failures are otherwise invisible).
- **Change `docs/analytics.md`'s event-naming convention (§2.3)** → no functional breakage (analytics failures are silent by design), but breaks continuity of historical umami data and violates the doc's own stated transparency promise if not updated in lockstep with the UI.
- **Change `utils/context.ts`'s `ContextBuilder` (§2.4)** → affects what every character-driven feature actually sees as its prompt context — memories, time/weather, schedule, relationships. A bug here is a "the AI got dumber everywhere" class of regression, hard to localize to one app.
- **Rename/restructure `apps/Chat.tsx`, `MessageItem.tsx`, or `ChatModals.tsx`** → these three pass ~78-101 props between each other per `docs/code-organization-review.md` — treat as a tightly-coupled unit, not three independent files.

---

## 5. What's still unverified

Everything marked 🔴 above. Concretely, the apps whose *content* (not just existence) is still scouting-level knowledge, not a full read: **`apps/Chat.tsx`, `apps/CallApp.tsx`, `apps/GameApp.tsx`, `apps/DreamTheater.tsx`, `apps/PersonaSim.tsx`, `apps/JournalApp.tsx`, `apps/ScheduleApp.tsx`, `apps/Character.tsx`** (all HIGH risk per the translation-batch scouting pass) and **`apps/CheckPhone.tsx`, `apps/GroupChat.tsx`, `apps/RoomApp.tsx`, `apps/BankApp.tsx`, `apps/SongwritingApp.tsx`, `apps/GuidebookApp.tsx`, `apps/LifeSimApp.tsx`** (MEDIUM risk). Also: `worker/index.js` (the ~3,771-line undocumented "main proxy"), `worker/mcp-proxy/` and `worker/post-office/` internals, `utils/lifeSimEngine.ts`, and most of `utils/memoryPalace/`'s individual files beyond `pipeline.ts`/`digestion.ts`/`types.ts`.

As each of these gets a real read (translation pass or otherwise), update its entry above from 🔴/🟡 to 🟢 and correct anything this document guessed wrong.
