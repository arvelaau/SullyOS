# CLAUDE.md

给 Claude Code 的项目导航。SullyOS 是装在浏览器里的虚拟手机系统（React + TS + Vite，local-first，IndexedDB 存储）。详细介绍见 [`README.md`](./README.md)。

这份文件只做一件事：**告诉你遇到某类问题该去翻哪份文档**，别在代码里瞎逛。

> 包管理器统一用 **pnpm**：装依赖 `pnpm install`、跑测试 `pnpm vitest run`、跑脚本 `pnpm <script>`。别用 npm / yarn（仓库里是 `pnpm-lock.yaml`）。

## 文档地图

| 主题 | 文档 | 什么时候看 |
|------|------|-----------|
| **开发调试面板 / 开关** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 开关、加调试日志、排查"角色怎么又不说话了"。含逐步指南 |
| **记忆系统** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及长期记忆、月度总结、向量化记忆宫殿、情感空间。改记忆相关逻辑前必读 |
| **查手机 · 人际关系系统** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手机」聊天/通讯录、角色联系人/好感、真假甄别、真角色双向对话、虚构 NPC 约束前必读 |
| **见面 · 观测协议 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改见面（DateApp）的角色观测面板：提示词注入、掉格式解析容错（两层）、全息 HUD 渲染前必读 |
| **彼方 · 信号坠落处（跨用户接龙诗）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信号坠落处」房间：跨实例合写现代诗、复用漂流瓶后端、`po_poems`/`po_poem_lines` 表与 `/poem/*` 端点、两层容错解析、并发安全前必读 |
| **捏人器 PSD 导入 / 部件投影层** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管线、部件阴影（正片叠底预转）、PSD 图层组约定前必读 |
| **QQ捏人工坊（神经链接手办柜）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窝/彼方/520 三处 Q 版形象、捏人器 savedState 还原、`chibiStudio` 字段前必读 |
| **角色自定义时区** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **写任何跟时间有关的代码前先扫一眼**：prompt 里的「现在是」、角色作息/夜间判断、日期 key、界面上的钟。分清「角色那边几点」和「用户自己的时间」，别自己手搓时差。文末列了还没接时区的几处（主动消息 + 几块界面上的钟），**正式发版前记得过一遍** |
| **通用 MCP 工具服务器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（开发者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用户教程，设置「?」弹窗跳转的就是它，改接入行为要同步） | 改用户自配 MCP 接入（设置板块、握手/session、工具循环、`?target=` 代理约定、worker/mcp-proxy）或排查「工具连不上/角色不调工具」前必读；主动消息 2.0 的后台 MCP 路径（配置上云 / fire 时注入 / worker 直连执行）也在这份 |
| **主动消息 2.0 · 即时对话** | [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)（设计与取舍）、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)(端点/信封/fire_pack v7 契约) | 改「聊天在用户自己的 CF Worker 上生成」这条路（`POST /instant-chat`、`utils/amsgInstantChat.ts`、fire_pack 的 `chat` 段、chat_outbox 补收、「正在输入」超时）前必读 |
| **主动消息 2.0 · 后台任务（不说话的活儿）** | [`plans/amsg2-expansion.md`](./plans/amsg2-expansion.md) | 改「页面关着也能跑完」的后台活儿前必读：`metadata.amsgKind` → handler 注册表（`worker/amsg/src/fireKinds.ts`）、一次性输入的 `amsg:job` 命名空间与 TTL、`ctx.emitResult` 的结果回程与客户端分发（`utils/amsgResults.ts`）。文首「现状」是实况，正文是「还有哪些调用点值得搬、哪些不该搬」的取舍 |
| **主动消息 2.0 · API 凭据引用 credRefs** | [`plans/amsg2-llm-credentials-contract.md`](./plans/amsg2-llm-credentials-contract.md) | 改凭据上云（`llm_credentials` 表、任务 `credRefs`、`utils/amsgLlmCredentials.ts` 的每角色三行）或排查「换 Key 后主动消息 401 / 不来了」前必读；文末「SullyOS 侧落地」是实况 |
| **Instant Push SSE↔Push 契约** | [`docs/instant-push-dual-channel.md`](./docs/instant-push-dual-channel.md) | **改 instant push 路径或排查「报错但收到消息」类 bug 前必读**。SSE ≠ 送达判定通道、catch 不能直接判 send-failed |
| **Instant Push 通道** | [`docs/instant-push-branch-notes.md`](./docs/instant-push-branch-notes.md)、[`worker/instant-push/README.md`](./worker/instant-push/README.md) | LLM-driven Web Push、worker 端 agentic loop / reasoning / 副作用 directive |
| **使用统计** | [`docs/analytics.md`](./docs/analytics.md) | **加任何埋点前必读**。收什么/不收什么的边界、事件名与属性的规矩（属性只能是固定枚举）、构建时门禁与开关、完整事件清单。想加「某功能有多少人开了」看「加新埋点的规矩」第 5 条，别在配置页现场发 |
| **二改 / 加 App / 数据流 / 后端 Worker** | [`README.md`](./README.md) 「给想二改的人」一节 | 新增 App、build badge、sfworker 代理替换、开源协议 |

> README 的「给想二改的人」区域信息量很大（数据流、ContextBuilder、Instant Push Phase 2、sfworker 清单），动后端 / 加功能前先扫一遍。

## 发版前改一下版本号

[`utils/buildInfo.ts`](./utils/buildInfo.ts) 里的 `APP_VERSION`（形如 `v3.0 (Ambient Presence)`）是手工维护的，**做完一轮大功能或者性能优化就改一下**。若只是小修复则不用提起。

它有两个用处：设置页底部显示的就是它；统计还拿版本号那半截当标签，面板按它切分数据。不改的话新旧版本的数字堆在同一个标签下，「这次优化有没有让首屏变快」「新版铺开多少了」就都答不出来。括号里的代号只在界面上显示，不进标签。构建 hash（`BUILD_LABEL`）是自动生成的，不用管。

---

# Translation Tracking — Chinese → English UI (added by this session, not part of upstream docs above)

## Project

SullyOS ("aetheros-simulator") — a browser-based "virtual phone OS" for AI-companion simulation. Stack: React + TypeScript + Vite, local-first with IndexedDB storage, pnpm workspace, optional Cloudflare Workers backend (`worker/`) and Capacitor mobile build. Fork of `qegj567-cloud/SullyOS`, now at the user's own `https://github.com/arvelaau/SullyOS` (this working copy is a **shallow clone**, `--depth 1`, of that fork — no older history available locally).

Baseline commit: `c1461dbf09459ab3e2c1cd4dfdff6030d9e43d0b` (`c1461db`), branch `master`, working tree clean at clone time — this is the reference point for all `git diff` going forward.

Repo layout (top-level, relevant to translation):
- `apps/` — top-level screen/app components (`Chat.tsx`, `Settings.tsx`, `VRWorldApp.tsx`, `MemoryPalaceApp.tsx`, `CallApp.tsx`, `DateApp.tsx`, `GroupChat.tsx`, `GameApp.tsx`, etc.) — the actual phone "apps."
- `components/` — shared UI + per-feature subfolders (`appearance/`, `bank/`, `call/`, `character/`, `chat/`, `date/`, `handbook/`, `journal/`, `lifeRecord/`, `mcd/`, `novel/`, `os/`, `schedule/`, `settings/`, `song/`, `user/`, `voice/`, ...).
- `utils/` — **not just helpers**: this is where nearly all AI prompt-construction and protocol-parsing logic lives, flat (no `prompts/`/`ai/`/`llm/` subfolder convention), plus per-feature prompt files nested under `utils/groupChat/`, `utils/like520/`, `utils/memoryPalace/`, `utils/vrWorld/`, `utils/worldHome/`.
- `docs/` — upstream's own dev-doc map (see doc table above this section) — several entries describe AI-prompt/protocol systems directly and were used for this scouting pass.
- `plans/` — design docs for the "proactive message 2.0" (主动消息 2.0 / amsg2) subsystem.
- `worker/` — Cloudflare Workers backend (post-office, instant-push, mcp-proxy, amsg job runner) — server-side counterpart to some client-side protocols (e.g. `worker/post-office/src/index.ts` implements `/poem/*` matching `utils/vrWorld/prompts.ts`'s `parseSignalOutput`). Out of scope question, see Scope note.
- `更新日志/` — literally "changelog" as a folder name; not code, not part of this pass unless asked.

## Two categories of Chinese text

1. **UI TEXT** — labels, titles, placeholders, alt/aria-label, toasts, settings copy. Translate freely once a file's batch comes up. Confirmed the large majority of `components/` (152 files / ~8055 CJK lines) and `apps/*.tsx` (76 files / ~11011 CJK lines) is this category, but **every file in these folders still needs a pass for embedded protocol literals** (see below) — this app renders protocol-adjacent content (card summaries, quoted-message previews, tag-stripped display strings) inline inside otherwise-ordinary UI components, it's not cleanly separated like a naive split would assume.

2. **AI PROMPT / PROTOCOL TEXT** — do **NOT** touch without asking first. Confirmed protocol shapes found so far (this app has *more* distinct tag systems than the prior similar project, not fewer — do not assume prior project's shapes apply here):
   - **Bracket/XML-style wire-format tags taught to the LLM and parsed back**, found in `utils/chatParser.ts` (consumer) paired with `utils/chatPrompts.ts` and friends (producer):
     - `[[MUSIC_ACTION:add|...]]` — music action tag.
     - `[引用:...]` / `\[(?:QU[OA]TE|引用)[：:]...\]` — quote tag, **bilingual**: accepts both `QUOTE`/`QUATE` (English) and `引用` (Chinese) as the tag keyword. Also a "X引用了Y「quoted text」" variant using `「」` corner brackets.
     - `[回复"..."]` — reply tag using Chinese `回复` + curly/corner quote chars.
     - `<语音>...</语音>` and `<字幕>...</字幕>` — **the tag names themselves are Chinese words** (语音 = voice, 字幕 = subtitle), not just Chinese content inside English tags. Translating the words "语音"/"字幕" anywhere near this system risks breaking the regex that matches the literal tag name.
     - `[Transfer]`, `[协同文件：...]`, `[系统: ... 新增了日程 "..."]` — transfer/collab-file/schedule system-notice tags, mixed English/Chinese.
   - **`⟦OBSERVE⟧...⟦/OBSERVE⟧` block protocol** — **RESOLVED (2026-09-01)**: wire-format field names renamed 时间/地点/状态/细节 → `time`/`location`/`status`/`detail` in `utils/datePrompts.ts`'s `OBSERVE_DIMENSIONS`, doc updated, tests updated, build+tests pass. See Progress log for full detail. `docs/date-observe.md`, `components/date/ObserveHUD.tsx`, `components/date/ObserveSettings.tsx` confirmed to have no separate hardcoded copy of the label (single source of truth via `dim.label`).
   - **`<续>`/`<标题>`/`<主题>`/`<起笔>`/`<动态>` tags** (legacy-compat `<续句>`/`<第一句>`) in `utils/vrWorld/prompts.ts`'s `parseSignalOutput` (docs/signal-poetry.md) — another Chinese-tag-name wire format, cross-user "relay poem" feature, backend counterpart in `worker/post-office/src/index.ts`. Not yet individually read/confirmed.
   - **Memory summarization prompts — CONFIRMED (2026-09-01)**: `utils/memoryPalace/pipeline.ts` and `digestion.ts` read in full, both PARTIALLY protected. See Progress log for exact line ranges of the protected subset vs. confirmed-safe UI/dev-log text.
   - **CONFIRMED PROTECTED, entire file (2026-09-01, read in full)**: `utils/songPrompts.ts`, `utils/lifeSimPrompts.ts`, `utils/guidebookPrompts.ts`, `utils/htmlPrompt.ts`, `utils/thinkingChainPrompt.ts`. New tag instance found: `songPrompts.ts:401` rejects LLM output lines starting with literal `json|歌词|示范|建议|解释|原因|说明` + colon (self-contained producer+consumer, same file).
   - `chatPrompts.ts` (659 CJK lines), `datePrompts.ts`'s non-OBSERVE parts (writing-style preset blocks etc.), `promptMessageCleanup.ts`, `applyAssistantPostProcessing.ts` (581 CJK lines — likely output post-processing, i.e. also consumer-side), `sanitize.ts` (274), plus per-feature `utils/groupChat/prompts.ts`, `utils/like520/prompts.ts`, `utils/vrWorld/prompts.ts`, `utils/worldHome/prompts.ts` — **still not yet individually read/confirmed**, treat as protected until read.
   - `utils/personaSimParser.ts` — **CONFIRMED CLEAN (2026-09-01)**: zero Chinese content, no action needed, can be dropped from the watch list.
   - `utils/videoParser.ts` — **CONFIRMED PARTIALLY protected (2026-09-01)**: line 124's `d.type === '图片'` matches a third-party API's (apizero) own response field — different risk category (external API contract), still do-not-touch. `ERROR_MESSAGES` (67-74) and inline `throw new Error(...)` user-facing strings are safe to translate normally.
   - `utils/chatParser.ts` — parser/consumer-side file by name, not yet individually confirmed (distinct from the already-read files above).

   **Rule of thumb (same as prior project, still holds here)**: if a Chinese string is wrapped in a bracket/angle-bracket tag, assigned to a `content:`-like field of a message/session object, passed to a message-adding function, or matched/compared against LLM output or message content — leave it and report it. Static UI labels for the same feature (buttons/menus/settings copy) are usually safe, **except** where the label is proven to double as protocol data (see OBSERVE case above) — check before assuming.

## Scope note (open questions — ask, don't assume)

- **`worker/` (Cloudflare Workers backend, 37 files / ~5168 CJK lines)**: **user decision (2026-09-01): out of scope for this pass**, same as the prior project's `app/api/**/route.ts` — will be a separate pass later. Checked for strings that reach the UI verbatim (error responses shown via toast/alert) before fully setting it aside:
  - `post-office/`, `instant-push/`, `xhs-lite/`, `proactive-push/`, `mcp-proxy/` — **zero** CJK `error`/`message`/`msg`/`reason` field literals found. Nothing here to flag.
  - `amsg/` (the proactive-message background-job worker) is the only subfolder with CJK in error/message-shaped fields — but all found instances read as **tool-call feedback returned to the LLM** (natural-language guidance the AI reads to decide its next action), not literal user-facing UI toasts:
    - `amsg/src/index.ts:1189,1196,1204,1358,1365,1405,1418,1428,1474` — `message:` fields on MCP tool-call results for `schedule_active_message`/cancel/reschedule (e.g. `"对方还没回复，这期间你已经发了/排了 N 条...这次别排了"` = "they haven't replied yet, you've already sent/queued N, don't schedule this time") — addressed to the AI, mirrors `utils/agenticToolFeedback.ts`'s pattern client-side.
    - `amsg/src/plateFire.ts:75,101` — `reason:` fields, same tool-feedback shape (memory "门牌" room-plate organizing job).
    - `amsg/src/selfUpdate.ts:163,173,201,203,208`, `amsg/deno-proxy.ts:166` — operational/diagnostic messages (Worker self-update mechanism, deno proxy health check) — read as ops/log text, not app UI.
    - `amsg/src/index.ts:2026`, `amsg/src/nativeFcm.ts:76,122`, `amsg/src/plateFire.ts:64` — bare `throw new Error(...)` with CJK, all internal diagnostic codes (`AMSG2_KIND_HANDLER_MISSING`, FCM OAuth/payload errors) — read as server-side exceptions, not user-facing.
  - **Not 100% verified these never surface in UI** (didn't trace every fetch call-site in `utils/activeMsgClient.ts`/`activeMsgRuntime.ts` back to a toast) — logged here so it isn't forgotten; re-check call sites before assuming when `worker/` scope is picked up.
- **`utils/` test files** (`*.test.ts`, huge CJK counts — e.g. `activeMsgRuntime.test.ts` 793 lines, `activeMsgClient.test.ts` 429 lines): not UI, likely realistic chat-scenario fixtures in Chinese. Assumed out of scope (mirrors prior project's "not `.tsx`" rule) but flagging since the volume is unusually large — confirm this assumption holds before skipping silently.
- **`docs/*.md` and `plans/*.md`** (upstream dev documentation, mostly Chinese): dev docs, not UI, out of scope for a UI translation pass — but note some of these docs are exactly what should be *read* (not translated) during the protocol-mapping phase, e.g. `docs/date-observe.md`, `docs/signal-poetry.md`, `docs/memory-system-overview.md`, `docs/relationship-system.md`, `docs/mcp-client.md`, `plans/amsg2-*.md`. Read-only reference material for us, not a translation target unless asked.
- **`utils/` non-prompt logic files with heavy CJK** (e.g. `db.ts` 398 lines, `storageOptimize.ts`/`.test.ts`, `realtimeContext.ts`, `apiCallLog.ts`, `analyticsSnapshot.ts`, `context.ts`): not yet individually triaged — could be dev-facing comments (out of scope, like the prior project's rule 1) or could be user-facing error/log strings that reach the UI. Needs a per-file check when its turn comes up, don't blanket-assume either way.
- **This CLAUDE.md file itself and other `.md` docs**: dev documentation, `.md` not `.tsx`, out of scope for the UI pass per the original instruction — not touching unless asked.

## Progress so far

Scouting pass complete (2026-09-01): CJK distribution mapped per top-level directory, protocol file candidates identified by name + spot-checked. User reviewed the risk map and gave scope decisions (see Scope note above); translation phase started.

**OBSERVE wire-format field rename — done (2026-09-01).** User decision: since no real character/save data exists yet, renamed the OBSERVE block's default wire-format field names from Chinese to English in one commit, no data migration needed:
- `utils/datePrompts.ts`: `OBSERVE_DIMENSIONS[].label` changed 时间→`time`, 地点→`location`, 状态→`status`, 细节→`detail` (single source of truth — this is the exact string injected into the LLM system prompt as the field name, e.g. `time｜（hint...）`). Updated one now-stale dev comment describing "固定中文" labels to reflect the change (comment-only fix, not a translation pass on comments generally). Deliberately did **not** touch `OBSERVE_FIELD_RE`/`mapObserveKey` — the parsing regex already accepted both Chinese and English field-name variants as tolerance for model drift, so it now doubles as backward-compat support for the old Chinese wire format (harmless to keep, costs nothing, matches "no migration needed" instead of a hard cutover).
- `docs/date-observe.md`: updated the wire-format example block's field-name prefixes to match (`时间｜`→`time｜` etc.), added a dated changelog note explaining the rename and that consumer files needed no code change. Rest of the doc (prose, everything else) intentionally left in Chinese — it's dev documentation, out of scope for this pass per Scope note.
- `components/date/ObserveHUD.tsx`, `components/date/ObserveSettings.tsx`, `components/date/DateSession.tsx`: **read in full, confirmed no hardcoded duplicate of the Chinese labels exists** — both HUD and Settings reference the field name dynamically via `dim.label`/`resolveObserveFields(...).display`, so the `datePrompts.ts` change alone was sufficient for wire-format consistency. No code edits needed in these three files for the protocol change itself; their surrounding pure-UI text (theme names, buttons, hint prose) is left as-is for the normal `components/date/` batch later, not folded into this focused commit.
- `utils/datePrompts.test.ts`: 4 assertions were checking the *produced* prompt output against the old Chinese labels (`'状态｜'`, `'时间｜'`, `.toBe('地点')`) — updated to the new English values; one test's Chinese title updated for accuracy (中文→英文 key). Left all other OBSERVE tests untouched — they test the *parser's* tolerance for Chinese-labeled input, which still passes since the fallback regex is unchanged.
- Verified: `pnpm vitest run utils/datePrompts.test.ts` → 28/28 pass. `pnpm run build` → succeeds (`vite build`, 1m17s). `pnpm exec tsc --noEmit` shows pre-existing errors in unrelated files (CompanionHome.tsx, vite.config.ts, etc., not touched by this change) — confirmed via `git status` that only the 4 files above were modified; none of the tsc errors are in them.
- Grepped the 4 touched files for stray smart quotes / `\uXXXX` escapes — clean.

**Deep-read triage of protected files — done (2026-09-01, background agent, Explore subagent_type).** Read in full: `utils/songPrompts.ts`, `utils/lifeSimPrompts.ts`, `utils/guidebookPrompts.ts`, `utils/htmlPrompt.ts`, `utils/thinkingChainPrompt.ts`, `utils/personaSimParser.ts`, `utils/videoParser.ts`, `utils/memoryPalace/pipeline.ts`, `utils/memoryPalace/digestion.ts`. Findings:
- **Fully PROTECTED (entire file, do not translate any of it)**: `songPrompts.ts`, `lifeSimPrompts.ts`, `guidebookPrompts.ts`, `htmlPrompt.ts`, `thinkingChainPrompt.ts`. All are AI system/user-prompt builders; several also have style/label constants that *look* like UI data but are directly interpolated into the prompt (e.g. `songPrompts.ts`'s `SECTION_LABELS[...].label`), so nothing in them is safely separable.
- **New protocol instance found, add to watch list**: `songPrompts.ts:401` — `/^(?:json|歌词|示范|建议|解释|原因|说明)\s*[:：]/i` rejects LLM output lines starting with these literal Chinese words (a lyric-line sanity filter). Producer and consumer are both in this one file.
- **`utils/personaSimParser.ts`** — confirmed **zero Chinese content**, nothing to do here, can be dropped from the watch list entirely.
- **`utils/videoParser.ts`** — PARTIALLY protected: `videoParser.ts:124`'s `d.type === '图片'` compares against a **third-party API's** (apizero) own response field value — a different risk category (external API contract, not our AI/UI text) but equally do-not-touch. `ERROR_MESSAGES` (67-74) and a few inline `throw new Error('...')` calls are ordinary user-facing error text, safe to translate normally.
- **`utils/memoryPalace/pipeline.ts`** — PARTIALLY protected: most of the file (console.log/warn dev diagnostics, `onProgress?.()` UI progress-indicator strings) is safe UI/dev text. Protected subset: `charContext`/diary-ingestion string construction (lines ~1517-1536, ~1743-1757, labels like `[角色档案]`/`【交换日记】`) that gets sent directly as LLM message content, plus a "correction tag" pattern (~line 2007) written for the LLM to re-read on next recall.
- **`utils/memoryPalace/digestion.ts`** — PARTIALLY protected: two full `systemPrompt` blocks (lines 280-358, 998-1022) are protected in full. `DigestReportSection` labels (lines 791-819, e.g. '阁楼困惑'/'窗台期盼') are confirmed UI-only (rendered in the Memory Palace app) and safe to translate — but check against `PLATE_TITLES` in `./types` (not yet read) for consistency first. Borderline: a couple of `tags:` string literals (644, 679) get fed back into a *future* prompt call via `.join(', ')`, recommend leaving them alone even though nothing parses them via regex.
- Full per-file detail (exact line numbers, quoted regex/strings) is preserved in this session's agent transcript — re-derive by re-reading these 9 files if this summary isn't enough detail when their turn comes up.

CJK file/line counts per top-level directory (`.ts`/`.tsx`/`.js`/`.jsx` only, via `grep -rlP`/`grep -rP` with GNU grep `-P` PCRE unicode range `[\x{4e00}-\x{9fff}]` — no ripgrep available in this environment, see Environment notes):

| Dir | Files w/ CJK | CJK lines | Notes |
|---|---|---|---|
| `utils/` | 642 | 36453 | Bulk of protocol/prompt code lives here flat, not in a dedicated folder |
| `apps/` | 76 | 11011 | Top-level screen components, mostly UI but several embed protocol rendering inline |
| `components/` | 152 | 8055 | Mostly UI, per-feature subfolders |
| `worker/` | 37 | 5168 | Backend, scope TBD |
| `context/` | 2 | 824 | Not yet triaged |
| `hooks/` | 2 | 685 | Not yet triaged |
| `features/` | 11 | 429 | Not yet triaged |
| `public/` | 2 | 103 | Not yet triaged |
| `scripts/` | 3 | 76 | Likely dev tooling, out of scope |
| `api/` | 3 | 7 | Not yet triaged |
| `test/` | 1 | 8 | Out of scope (test) |
| `server/` | 1 | 2 | Not yet triaged |
| `netlify/` | 1 | 1 | Not yet triaged |
| root (`.ts`/`.tsx` directly in repo root) | 8 files present (`types.ts`, `constants.tsx`, `App.tsx`, `index.tsx`, etc.) | not yet counted individually | `types.ts` is 179KB — likely has Chinese doc-comments on types, not UI strings |
| `docs/`, `notes/`, `plans/`, `pixelroom/`, `cloudflare/`, `infra/`, `icons/`, `assets/`, `tools/`, `更新日志/` | 0 code files w/ CJK (docs are `.md`, out of scope) | — | — |

`utils/` subfolder breakdown: `memoryPalace/` 84 files/4615 lines, `vrWorld/` 15 files/1174 lines, `worldHome/` 8 files/837 lines, `groupChat/` 17 files/530 lines, `like520/` 1 file/521 lines. The remaining ~28776 CJK lines in `utils/` are in flat top-level `utils/*.ts` files (see file list in "Two categories" above).

## Glossary

Empty so far — populate as translation batches happen, keep terms consistent (e.g. how 角色/character, 见面/date-meetup app, 彼方/VRWorld, 信号坠落处/Signal(-poetry) room, 小小窝/dwelling(?), get rendered in English UI — confirm naming with user on first occurrence of each, don't invent independently per file).

## Environment notes

- Working directory: `D:\Documents\Claude\SullyOS`, Windows, git bash (the Bash tool in this session maps to Git Bash / POSIX sh, not PowerShell).
- Package manager is **pnpm**, not npm/yarn (`pnpm-lock.yaml` present) — per upstream CLAUDE.md above: `pnpm install`, `pnpm vitest run` / `pnpm test:run`, `pnpm <script>`.
- Build: `pnpm run build` (runs `build:workers` via `scripts/build-workers.mjs` then `vite build`). Dev: `pnpm dev` (vite).
- **No `rg` (ripgrep) available in this environment's PATH** — the built-in Grep/Glob tools also failed in this session with an unrelated infra error (`Executable not found in $PATH: ...claude.exe`, unclear if transient). Fallback used: GNU `grep` (v3.0, git-bash-provided) with `-P` (PCRE) flag, which **does** support `\x{4e00}-\x{9fff}` Unicode-range escapes — confirmed working. Re-test whether the Grep/Glob tools work again before assuming this workaround is still needed in future sessions.
- Repo was cloned **shallow** (`--depth 1`) because a full clone kept stalling/timing out on this network (very slow, bursty download speed to GitHub, retried twice before switching to shallow). If full history is ever needed later, `git fetch --unshallow` (may hit the same slow-network issue).
- This working copy has no `node_modules/` yet (never ran `pnpm install`) — `pnpm run build`/tests won't work until dependencies are installed; do that before the first translate-and-build-verify cycle.