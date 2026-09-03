# SullyOS — Peta Fitur & Arsitektur

> Dokumen pendamping `CLAUDE.md`. **CLAUDE.md khusus melacak progres translate UI Mandarin→Inggris** (progress log, glossary, aturan keamanan protokol). **File ini memetakan produk/arsitekturnya**: apa fungsi tiap fitur, file mana yang membangunnya, dan apa lagi yang bisa ikut rusak kalau disentuh. Berguna dengan atau tanpa konteks translate.
>
> Versi Inggris: [`FEATURES.md`](./FEATURES.md). Jaga agar keduanya tetap sinkron tiap kali file ini diubah.
>
> **Kunci verifikasi** yang dipakai di seluruh dokumen ini: 🟢 **TERVERIFIKASI** = sudah dibaca detail (saat proses translate atau saat menulis dokumen ini). 🟡 **DUGAAN** = berdasarkan scouting level grep, bukan baca penuh — anggap detailnya kemungkinan besar benar, bukan pasti. 🔴 **BELUM DILIHAT** = diketahui namanya/keberadaannya, isinya belum dikonfirmasi.
>
> File ini harus diupdate tiap kali menemukan sistem atau keterkaitan lintas-fitur baru — disiplin yang sama dengan Progress log di CLAUDE.md.

---

## 1. Overview

SullyOS adalah **simulasi phone OS** — seluruh app adalah lock screen + home screen + grid "app," di mana tiap app adalah satu fitur dari produk simulasi AI-companion/karakter. Tidak ada komponen server yang wajib untuk pengalaman inti; state hidup di **IndexedDB** (`utils/db.ts`) dan app didesain **local-first** (menurut `docs/code-organization-review.md` — meski dokumen yang sama juga menandai bahwa lapisan styling saat ini *belum* benar-benar local-first, karena Tailwind masih ditarik dari CDN saat runtime).

**Registry app — `constants.tsx`.** `INSTALLED_APPS: AppConfig[]` adalah single source of truth untuk app mana yang tampil sebagai ikon di grid home-screen, nama tampilannya, ikon, dan warna aksennya. `AppID` (enum di `types.ts`) adalah identifier stabil yang dipakai di mana-mana. Ada beberapa app yang ada tapi sengaja tidak dimasukkan ke `INSTALLED_APPS` (dikomentari/disembunyikan) namun tetap bisa diakses dan tetap dilacak untuk analytics lewat `HIDDEN_APP_NAMES` — contohnya **Homeland** (`AppID.WorldHome`) sudah tidak punya ikon desktop sendiri lagi; diakses lewat **Dwelling** (`AppID.Room`). `DOCK_APPS` adalah daftar tetap kecil (Chat, Group Chat, Spark, Settings) yang selalu nempel di dock bawah terlepas dari grid.

**Rendering shell — `components/PhoneShell.tsx` + `context/OSContext.tsx`.** `OSContext.tsx` (🟢 TERVERIFIKASI secara struktural — lihat analisis hub-file di `docs/code-organization-review.md`) adalah satu Context Provider raksasa (~4.259 baris pada pengukuran terakhir) yang menampung hampir semua state lintas-app: `activeApp`, `characters`, `theme`, toast, jam virtual, backup/restore, konfigurasi API, dan banyak lagi — semuanya diekspos lewat satu hook `useOS()` yang dipakai ~70 file. `PhoneShell.tsx` membaca `activeApp` dari `useOS()` lalu merender layar yang sesuai lewat satu `switch (activeApp)` besar (satu `case` per `AppID`, misalnya `case AppID.Chat: return <Chat />`). Membuka app = memanggil `openApp(AppID.X)` dari mana saja, yang cuma meng-update `activeApp` di context bersama.

**"Character" sebagai entitas inti.** Hampir semua fitur berputar di sekitar `CharacterProfile` (didefinisikan di `types.ts`, interface besar — lihat di bawah). Sebuah karakter punya: identitas (`name`, `systemPrompt`, `worldview`), riwayat pesan, state Memory Palace, angka relationship/affinity, toggle per-fitur (protokol Observe, kesadaran waktu, injeksi Life Record, dst), dan data tampilan (potret per emosi, konfigurasi suara). Sebagian besar app itu **menampilkan/mengedit** karakter, atau **menghasilkan pesan sebagai** karakter dengan merakit system prompt dari field karakter + konteks yang diinjeksikan (memori, jadwal, relationship, waktu/cuaca dunia nyata) lalu memanggil endpoint LLM `chat/completions`.

**"Skin" home-screen multi-karakter.** Home screen tidak tetap — `theme.skin` (bagian dari state theme di `OSContext`, diset lewat **Appearance**/**Bubble Workshop**) memilih antara Launcher grid-app default dan beberapa pengalaman home-screen full-screen alternatif: `'companion'` (merender `components/os/CompanionHome.tsx`, sendiri punya 5 sub-varian — chrome Cardbook/Cat/Idol/Magazine/Otome), `'animalcrossing'`, `'mobilegame'`, `'tamagotchi'`. Lihat §2.6.

---

## 2. Sistem inti yang dipakai bersama lintas fitur

Ini sistem-sistem yang diam-diam dipakai bersama oleh banyak app yang kelihatannya independen. Baca bagian ini sebelum mengubah salah satunya — blast radius-nya biasanya jauh lebih besar dari satu file yang sedang diedit.

### 2.1 Chat protocol — bracket/tag wire format 🟢 TERVERIFIKASI (ekstensif, sepanjang sesi translate)

**Apa itu.** LLM diajari, lewat teks prompt di file producer, untuk menghasilkan substring bertag bracket atau XML-style tertentu di balasannya. File consumer kemudian meng-regex-parse tag itu kembali untuk menggerakkan perilaku UI (render kartu, strip marker, trigger aksi). **Ini sistem paling berisiko satu-satunya di codebase dari sudut pandang translate/refactor** — banyak *nama* tag ini adalah kata Mandarin literal, bukan cuma konten Mandarin di dalam tag Inggris, jadi menerjemahkan katanya akan merusak regex yang mencocokkannya.

**Producer:** `utils/chatPrompts.ts` (~659 baris CJK, masih belum sepenuhnya diterjemahkan — mengajari AI kebanyakan tag ini) dan beberapa file prompt khusus-fitur (`utils/groupChat/prompts.ts`, `utils/like520/prompts.ts`, `utils/vrWorld/prompts.ts`, `utils/worldHome/prompts.ts`, `utils/datePrompts.ts`, `utils/songPrompts.ts`, `utils/lifeSimPrompts.ts`, `utils/guidebookPrompts.ts`, `utils/htmlPrompt.ts`, `utils/thinkingChainPrompt.ts`).

**Consumer:** `utils/chatParser.ts`, `components/chat/MessageItem.tsx` (renderer bubble pesan — fungsi `stripJunk`-nya sendiri men-strip/parse ~10 keluarga tag berbeda), `utils/applyAssistantPostProcessing.ts`, `utils/promptMessageCleanup.ts`, `utils/sanitize.ts`.

**Keluarga tag yang terkonfirmasi** (lihat bagian "Two categories of Chinese text" di CLAUDE.md untuk daftar otoritatif lengkap, selalu diupdate di sana):
- `[[MUSIC_ACTION:add|...]]` — tag aksi musik.
- `[引用:...]` / `[QUOTE:...]` (bilingual) dan varian imitated-history berkutip `「」` — tag quote/reply.
- `[回复"..."]` — tag reply (kata Mandarin + tanda kutip lengkung).
- `<语音>...</语音>` / `<字幕>...</字幕>` — tag voice/subtitle. **Nama tag-nya sendiri adalah kata Mandarin.**
- `[系统: ...]` / `[System Log]` / `[系统记录]` / `[小屋动态]` — tag prefix system-notice (bilingual-safe: regex parsing-nya sudah menerima baik "System" maupun "系统").
- `ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|SEND_EMOJI|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END` — keluarga tag aksi `[[TAG:...]]`.
- `schedule_message`, `%%TRANS%%`, `%%BILINGUAL%%` — marker lain-lain.
- `[[XHS_SEARCH:...]]` / `[[XHS_DETAIL:...]]` / `[[XHS_BROWSE]]` / `[[READ_NOTE:...]]` / `[[SEARCH:...]]` — tag aksi Xiaohongshu / catatan / web-search (`utils/chatPrompts.ts`, `utils/xhsFreeRoam.ts`, `utils/applyAssistantPostProcessing.ts`).
- `⟦OBSERVE⟧...⟦/OBSERVE⟧` — lihat §2.5, subsistem tersendiri.
- `<续>`/`<标题>`/`<主题>`/`<起笔>`/`<动态>` — tag relay-poem "Signal Fall" milik VRWorld (`utils/vrWorld/prompts.ts`).
- `[[LIFE:PERIOD_START]]` / `[[LIFE:PERIOD_END]]` — tag pelacakan periode Life Record (`utils/lifeRecords.ts`).
- Format baris `label：value` dipisah titik dua (sistem terpisah) dipakai parser `StoryOutput` milik Story Theater — lihat entri Date di §3.

**Pola "placeholder", gampang salah dikira risiko protokol padahal biasanya aman:** beberapa tipe pesan (`novel_card`, `trpg_card`, `score_card`, `vr_card`, `group_topic_card`) menyimpan string placeholder Mandarin pendek yang manusiawi sebagai `message.content` (misalnya `[分享帖子]`), tapi teks yang *sungguhan* dibaca AI dibangun ulang dari `message.metadata` oleh fungsi producer (`utils/chatPrompts.ts`, `utils/messageFormat.ts`) yang sepenuhnya mengabaikan field `content` mentah. Placeholder-placeholder ini aman diterjemahkan. Selalu verifikasi pola mana yang berlaku per file — jangan asumsi.

**Bergantung pada sistem ini:** `apps/Chat.tsx` (chat 1:1 utama), `apps/GroupChat.tsx`, `apps/CallApp.tsx` (punya sub-keluarga source-tag `通话`/`聊天`/`约会` sendiri, lihat §3), `apps/CheckPhone.tsx`, `apps/SocialApp.tsx`, `apps/NovelApp.tsx`, `apps/GameApp.tsx`, `apps/GuidebookApp.tsx`, `apps/LifeSimApp.tsx`, `apps/WorldHomeApp.tsx`, `apps/VRWorldApp.tsx`, `components/lifeRecord/LifeRecordPanel.tsx`, `components/date/story/` (Story Theater).

### 2.2 Memory Palace — `utils/memoryPalace/` 🟢 TERVERIFIKASI (secara struktural; lihat `docs/memory-system-overview.md` untuk detail lengkap)

**Apa itu.** Sistem memori jangka panjang berbasis vektor yang modelnya longgar mengikuti anatomi otak — dokumen otoritatifnya adalah **`docs/memory-system-overview.md`**, baca itu untuk pipeline lengkap. Versi singkat: riwayat pesan karakter mengalir lewat pipeline buffer ke **7 "ruangan"** (`living_room`/hippocampus, `bedroom`/neocortex, `study`/prefrontal cortex, `user_room`, `self_room`/tidak pernah decay, `attic`/tidak pernah decay — trauma yang belum tercerna, `windowsill`/tidak pernah decay — harapan & tujuan), masing-masing dengan kapasitas dan laju decay berbeda. Ada juga sistem lama paralel non-vektor (`memories: MemoryFragment[]` + ringkasan bulanan `refinedMemories`) yang masih dipakai — lihat bagian "System 1" di `docs/memory-system-overview.md` dan `DEFAULT_REFINE_PROMPTS`/`DEFAULT_ARCHIVE_PROMPTS` milik `components/chat/ChatConstants.ts`.

**File kunci:** `utils/memoryPalace/pipeline.ts`, `digestion.ts` (keduanya SEBAGIAN protected — lihat CLAUDE.md), `extraction.ts`, `groupExtraction.ts`, `externalMemory.ts`, `bm25.ts` (fallback keyword-match untuk vector search), `recallRouter.ts`, `memoryRepair.ts`, `autoArchive.ts`, `types.ts` (`PLATE_TITLES`, `MemoryNode` — 20 file mengimpor `types.ts` domain ini).

**Bergantung pada sistem ini:** `apps/MemoryPalaceApp.tsx` (UI manajemennya sendiri), `apps/CheckPhone.tsx` (`injectMemoryPalace` — query-hint dari nama kontak), `apps/Character.tsx` (`handleRefineMonth`, alur ringkasan bulanan), `components/date/story/StoryTheaterSession.tsx` (`processNewMessagesWithAutoArchive`, `runCognitiveDigestion`), `components/ValentineEvent.tsx`/`WhiteDayEvent.tsx` (query hint memory-palace — **sengaja dibiarkan tidak diterjemahkan**, menerjemahkan string query berisiko menurunkan kualitas recall embedding-search, risiko tier-3 yang sudah didokumentasikan di CLAUDE.md), `components/character/RoomPlatePanel.tsx` (UI room-plate, array match `TAG_ICONS` protected permanen).

### 2.3 Analytics / `trackEvent` — `docs/analytics.md` 🟢 TERVERIFIKASI

**Apa itu.** Analytics [umami](https://umami.is/) self-hosted, opt-out lewat config, tidak pernah mengumpulkan cookie/IP/konten percakapan — baca `docs/analytics.md` untuk disclosure lengkap (apa yang dikumpulkan, kenapa, cara verifikasi/nonaktifkan). Aturan desain yang dinyatakan dokumen itu sendiri: **nama event sengaja dalam bahasa Mandarin, persis sama dengan teks UI**, supaya siapapun yang buka devtools bisa langsung paham arti event tanpa tabel terjemahan.

**Keputusan era-translate (didokumentasikan di CLAUDE.md):** aturan ini secara eksplisit di-override untuk proyek ini — begitu satu file diterjemahkan, panggilan `trackEvent()`-nya ikut diterjemahkan juga (nama event **dan** semua key/nilai enum properti Mandarin), selaras dengan UI-nya. Ini memecah kontinuitas data analytics historis di backend umami secara permanen di titik tiap file diterjemahkan — biaya satu-arah yang sengaja dan sudah diterima. ~710 titik panggil di 77 file teridentifikasi di awal upaya ini; per hitungan terakhir, `apps/Settings.tsx` saja punya 83.

**Bergantung pada sistem ini:** benar-benar setiap app dan sebagian besar komponen — `trackEvent(name, properties?)` dipanggil ad hoc di seluruh codebase, tidak ada registry terpusat.

### 2.4 Sistem karakter/persona inti — storage & perakitan prompt 🟡 DUGAAN untuk jalur perakitan, 🟢 TERVERIFIKASI untuk bentuk storage

**Apa itu.** `CharacterProfile` (`types.ts:2619`, interface sangat besar — puluhan field mencakup identitas, tampilan, konfigurasi memori, state relationship, toggle per-fitur) adalah bentuk data inti. Karakter dibuat/diedit di **`apps/Character.tsx`** 🔴 (belum diterjemahkan — risiko TINGGI menurut scouting pass; membangun prompt inline penuh untuk penyempurnaan-memori-bulanan di `handleRefineMonth`, dan file inilah yang memiliki toggle "Life Record Injection" serta referensi fitur "心象/Psyche" yang masih Mandarin). Perakitan prompt untuk satu giliran chat dipusatkan lewat `ContextBuilder`-nya **`utils/context.ts`** (`buildCoreContext`, `buildRoleSettingsContext`) — inilah yang menginjeksikan memori, waktu/cuaca dunia nyata, jadwal, dan state relationship ke apa yang benar-benar dilihat LLM. `utils/db.ts` (~3.309 baris, 108 pengimpor menurut `docs/code-organization-review.md`) adalah lapisan storage IndexedDB untuk karakter dan semuanya.

**Bergantung pada sistem ini:** setiap app yang bicara ke LLM sebagai karakter (Chat, Call, GroupChat, CheckPhone, Date, Room, Bank, Schedule, Songwriting, Game, Journal, Guidebook, LifeSim, VRWorld, WorldHome, Study — nyaris semuanya).

### 2.5 Protokol Observe — `utils/datePrompts.ts` 🟢 TERVERIFIKASI (sesi ini yang mengganti nama field wire-format-nya)

**Apa itu.** Fitur "HUD holografik" terstruktur untuk app **Date** — baca **`docs/date-observe.md`** untuk spek lengkapnya. Saat diaktifkan (per-karakter), LLM diminta memberi prefix tiap balasannya dengan blok `⟦OBSERVE⟧...⟦/OBSERVE⟧` terstruktur mencakup hingga 4 dimensi (time/location/status/detail, sudah diganti dari nama field Mandarin ke Inggris di batch translate sebelumnya — `OBSERVE_DIMENSIONS` milik `utils/datePrompts.ts`) plus hingga 6 dimensi custom buatan user. Frontend men-strip blok ini dari teks yang ditampilkan dan merendernya sebagai panel HUD mengambang terpisah dengan 5 gaya visual (Hologram/Ink Wash/Neon/Crystal/Terminal — juga baru diterjemahkan).

**File kunci:** `utils/datePrompts.ts` (`OBSERVE_DIMENSIONS`, single source of truth untuk nama field yang benar-benar diinjeksikan ke prompt), `components/date/ObserveHUD.tsx` (rendering + preset gaya), `components/date/ObserveSettings.tsx` (UI konfigurasi per-karakter), `components/date/DateSession.tsx` (mem-parsing blok itu dari output LLM).

**Bergantung pada sistem ini:** cuma `apps/DateApp.tsx` dan subtree `components/date/`-nya. Self-contained — tidak merembes ke app lain.

### 2.6 Tema launcher alternatif "OS skin" — `components/os/` 🟢 TERVERIFIKASI

**Apa itu.** Sistem renderer home-screen paralel yang sepenuhnya terpisah, dipilih lewat `theme.skin` (lihat §1). Alih-alih Launcher grid-app, user bisa memilih pengalaman home-screen yang sama sekali berbeda yang dibangun di sekitar satu karakter companion: `CompanionHome.tsx` (dengan 5 varian chrome — Cardbook/Cat/Idol/Magazine/Otome), atau skin `animalcrossing`/`mobilegame`/`tamagotchi` (`apps/Launcher.tsx` bercabang di `theme.skin` lebih dulu lalu merender ini alih-alih grid).

**Jebakan penting (didokumentasikan di CLAUDE.md, ditemukan saat translate):** skin-skin alternatif ini memelihara **salinan terpisah, di-hardcode sendiri-sendiri** dari konsep yang juga ada di UI default — misalnya nama tampilan app TIDAK dipakai-ulang dari `INSTALLED_APPS` di `constants.tsx`, melainkan sistem label kedua yang paralel di dalam `components/os/`. Kalau kamu ganti nama sesuatu di satu tempat, itu tidak otomatis merambat ke tempat lain. Juga punya sistem skema/mata-uang sendiri (`SCHEMES[].name` milik `gotchiScheme.ts`, masih Mandarin — gap "producer belum diterjemahkan" yang sudah didokumentasikan di bagian "Still open" CLAUDE.md).

**Bergantung pada sistem ini:** tidak ada yang bergantung padanya (dia leaf renderer), tapi dia bergantung pada **sebagian besar sistem lain yang character-aware** (dia menampilkan potret, hitungan belum-dibaca, aktivitas saat ini, dll yang ditarik dari `OSContext`).

### 2.7 Backend worker (opsional, self-deploy) — `worker/*` 🟢 TERVERIFIKASI (alur deploy) / 🟡 DUGAAN (implementasi internal)

**Apa itu.** Pengalaman inti SullyOS **tidak butuh backend sama sekali** (local-first, IndexedDB). Sejumlah kecil fitur opsional terhubung ke Cloudflare Worker yang di-deploy sendiri oleh user, untuk kapabilitas yang tidak bisa dilakukan frontend statis murni sendirian (pengiriman push sisi-server, state bersama lintas-user, proxying tool MCP). Dokumen deploy otoritatifnya adalah **`docs/self-deploy-workers.md`** — baca itu sebelum mengutak-atik konfigurasi deploy.

| Direktori worker | Fitur yang ditenagai | Butuh Cloudflare D1? | Catatan |
|---|---|---|---|
| `worker/amsg/` | **Proactive Message 2.0** — karakter mengirim pesan ke kamu secara proaktif, terjadwal, bahkan saat app tertutup | **Ya** | Bundle terbesar (~617 KB). UI setting: `components/settings/ActiveMsgGlobalSettingsModal.tsx` (nama fitur "Real-time Perception" tinggal di sini). Diagnostik: `utils/amsgDiagnostics.ts` 🔴 (masih Mandarin, gap yang sudah didokumentasikan di CLAUDE.md). |
| `worker/instant-push/` | **Instant Push** — balasan chat dikirim lewat push background bahkan saat tab tertutup | Tidak (opsional) | |
| `worker/mcp-proxy/` | Memungkinkan karakter terhubung ke server tool MCP yang dikonfigurasi user | Tidak | UI: `components/settings/McpConnectionConsole.tsx`. |
| `worker/post-office/` | Fitur lintas-user milik VR World — event relay-poem "Signal Fall" (lihat `docs/signal-poetry.md`) dan pengiriman guestbook/surat | 🟡 belum dikonfirmasi di sini, cek dokumennya | Rekan backend untuk protokol tag milik `utils/vrWorld/prompts.ts`. |
| `worker/proactive-push/` | 🔴 **Menurut `docs/code-organization-review.md`: kode mati, dinonaktifkan paksa di frontend (`FORCE_DISABLED=true`), tapi masih didokumentasikan seolah hidup di beberapa tempat.** Jangan deploy yang ini tanpa cek status terkini dulu. | — | |
| `worker/xhs-lite/` | 🔴 Menurut dokumen yang sama, direktori ini sekarang cuma berisi docs/test — kodenya sudah digabung ke `worker/index.js` yang monolitik (~3.771 baris, tidak terdokumentasi di `README`/`docs/`, di-deploy dengan paste ke panel Cloudflare, bukan lewat workspace `worker/*`). | — | Anggap `worker/index.js` sebagai "main proxy" 🔴 yang sebagian besar belum terpetakan, menangani search/WebDAV/GitHub/Notion/Feishu/MCP/XHS-lite dan lainnya. |

**Bergantung pada sistem ini:** fitur Proactive Message/Instant Chat yang muncul di `components/settings/ActiveMsgGlobalSettingsModal.tsx` + `apps/Settings.tsx`; event Signal Fall milik VRWorld dan fitur guestbook/post-office di `apps/VRWorldApp.tsx`; akses tool MCP karakter mana pun (simulasi pemesanan Luckin/McDonald's, server MCP tambahan user) lewat `components/settings/McpConnectionConsole.tsx`.

---

## 3. Per-app breakdown

Satu entri per `AppID`. Tanda 🟢/🟡/🔴 mencerminkan seberapa dalam file app spesifik itu sudah dibaca (saat translate atau saat menulis dokumen ini), bukan kebenaran deskripsinya — bahkan entri 🔴 di bawah diyakini akurat di level tinggi, cuma belum diverifikasi baris-per-baris.

**Character (Neural Link)** 🔴 — `apps/Character.tsx`. Buat/edit karakter: identitas, system prompt, worldview, potret per emosi, konfigurasi suara, attachment worldbook, preset prompt memori/archive, dan toggle untuk sebagian besar sistem per-karakter (Observe, kesadaran waktu, Life Record Injection). Bergantung pada §2.4 (sebenarnya inilah pemiliknya), §2.1 (system prompt mengajari semua protokol tag), §2.2 (penyempurnaan memori bulanan ada di sini). Terhubung ke hampir semuanya, karena di sinilah konfigurasi karakter untuk setiap fitur lain diset.

**Memory Palace** 🟢 — `apps/MemoryPalaceApp.tsx` (sudah diterjemahkan). UI manajemen untuk §2.2 — browsing ruangan, kontrol digest/archive, penautan memori manual, backup/restore, tuning parameter kognitif. Tidak langsung memberi makan app lain; app lain memanggil fungsi `utils/memoryPalace/`, bukan UI ini.

**Message (Chat)** 🔴 — `apps/Chat.tsx` (~3.720 baris, komponen app tunggal terbesar menurut `docs/code-organization-review.md`; belum diterjemahkan, risiko TINGGI). Layar chat 1:1 utama. Merender lewat `components/chat/MessageItem.tsx` (mesin parsing-tag/render-kartu, §2.1) dan `components/chat/ChatModals.tsx`/`ChatInputArea.tsx` (sudah diterjemahkan). Memiliki alur archive harian (`DEFAULT_ARCHIVE_PROMPTS`, "System 1" §2.2), terjemahan pesan bilingual (satu instruksi AI literal `'把以下内容翻译成中文...'` di baris ~624, ditandai untuk butuh sign-off eksplisit sebelum diterjemahkan), dan pola placeholder transfer/poke/forward (§2.1). Terhubung ke hampir semua sistem lain.

**Call** 🔴 — `apps/CallApp.tsx` (risiko TINGGI — **file belum-diterjemahkan paling berisiko satu-satunya**, menurut scouting pass: dia berisi baik instruksi-pengajaran *producer* MAUPUN regex *consumer* untuk tag source-tag chat-protocol `通话`/`聊天`/`约会`, berada di satu file yang sama, tidak seperti temuan tag lainnya yang selalu terpecah lintas file). Simulasi panggilan suara/video dengan stage avatar live2D/VRM, fallback static-shot, preferensi "siapa bicara duluan". Bergantung pada §2.1, §2.4.

**Group Chat** 🟡 — `apps/GroupChat.tsx` (risiko SEDANG, sudah di-scout belum dibaca penuh). Simulasi group chat multi-karakter. Punya fitur red-packet sendiri (`utils/groupChat/redpacket.ts`), kartu ringkasan-berjalan "group topic box", dan mengimpor `utils/groupChat/prompts.ts` (🔴 protected, belum dibaca). Bergantung pada §2.1, §2.4.

**Dwelling (Room)** 🟡 — `apps/RoomApp.tsx` (risiko SEDANG, sudah di-scout). Fitur dekorasi rumah-piksel "小小窝" — taruh furnitur, karakter "tinggal" di ruangan, pesan system-notice observasi ruangan. Meluncurkan **Dream Theater** (`apps/DreamTheater.tsx` 🔴, risiko TINGGI — prompt "sutradara" inline penuh, bentuknya sama dengan `songPrompts.ts`) sebagai sub-fitur (karakter bermimpi saat idle/tidur). Juga jadi pintu masuk ke **Homeland** (lihat berikutnya).

**Homeland (WorldHome)** 🟢 — `apps/WorldHomeApp.tsx` (sudah diterjemahkan). Tidak punya ikon desktop sendiri — diakses lewat Dwelling. Fitur "world-building" naratif (picker `NARRATIVE_STYLES` — 🔴 masih Mandarin, diimpor dari `utils/worldHome/prompts.ts`, gap "producer belum diterjemahkan" yang sudah didokumentasikan). `shareToChat()`-nya menempelkan prefix bracket-tag `【家园 · X】...发了条动态：` langsung ke konten chat yang persisten dan terlihat LLM — sengaja dibiarkan protected.

**Check Phone** 🟡 — `apps/CheckPhone.tsx` (risiko SEDANG, sudah di-scout, tapi lihat **`docs/relationship-system.md`** untuk tulisan yang sudah menyeluruh — 🟢 dokumen itu otoritatif). Memungkinkan satu karakter "mengecek" HP karakter lain (atau NPC fiktif) — kontak, affinity, percakapan dua-karakter-sungguhan yang tetap sinkron lintas riwayat kedua karakter, atau percakapan NPC fiktif satu-LLM. Sangat bergantung pada §2.2 (`injectMemoryPalace` query-hint dari nama kontak), §2.4. Juga meluncurkan **Persona Sim** (`apps/PersonaSim.tsx` 🔴, risiko TINGGI — prompt "sutradara screenlife" yang mensimulasikan tampilan layar HP karakter itu sendiri) sebagai sub-fitur.

**Date** 🟢 — `apps/DateApp.tsx` (sudah diterjemahkan, risiko RENDAH — pembangunan prompt terpusat di `utils/datePrompts.ts`). Layar simulasi "ketemuan". Memiliki protokol Observe (§2.5) dan berisi **Story Theater** sebagai subsistem (`components/date/story/`, 8 file, semua sudah diterjemahkan) — mode "teater" fiksi kolaboratif terpisah dengan parser output-AI `label：value` dipisah titik dua sendiri (`StoryOutput` milik `StoryTheaterSession.tsx`, melindungi `AFFINITY_DIMENSIONS`, label temperature, dan beberapa string label match-literal lain — lihat catatan batch 6 di CLAUDE.md). Bergantung pada §2.2 (`processNewMessagesWithAutoArchive`, `runCognitiveDigestion`), §2.4.

**Profile (User)** 🟢 — `apps/UserApp.tsx` (sudah diterjemahkan). Profil user sendiri (nama, bio, avatar) — sederhana, dampak lintas-fitur rendah, tapi `userProfile.name` dibaca di mana-mana sebagai "pihak lain" di prompt.

**Piggy Bank (Bank)** 🟡 — `apps/BankApp.tsx` (risiko SEDANG, sudah di-scout). Simulasi finansial/tabungan virtual — uniknya, prompt utamanya sudah kebanyakan berbahasa Inggris. Memakai tag system-notice `[系统: ...]` (§2.1) untuk narasi kunjungan/deposit.

**Exchange Diary (Journal)** 🔴 — `apps/JournalApp.tsx` (risiko TINGGI meski file kecil — `generateProseSummary` membangun prompt inline penuh `### [系统指令: 交换日记归档]`, terkonfirmasi tidak bentrok dengan regex keluarga `[系统: ...]` karena "系统指令" tidak cocok dengan pola itu). Diary yang dibagi antara user dan karakter, masing-masing menulis entri yang bisa dibaca yang lain. Tampilan/styling: `components/journal/JournalAppearanceEditor.tsx` (sudah diterjemahkan — menetapkan istilah glossary "Exchange Diary" yang dipakai di mana-mana app ini dirujuk).

**Spark (Social)** 🟢 — `apps/SocialApp.tsx` (sudah diterjemahkan). Simulasi feed media-sosial. Punya 3 template prompt AI protected penuh (refresh feed/komentar/balasan) plus pola placeholder `[分享帖子]`→`[Shared Post]` (§2.1, terkonfirmasi aman).

**Study Room (Study)** 🟢 — `apps/StudyApp.tsx` (sudah diterjemahkan, risiko RENDAH — sebagian besar dari 7 panggilan `chat/completions`-nya sudah berbahasa Inggris).

**TRPG (Game)** 🔴 — `apps/GameApp.tsx` (risiko TINGGI — `buildSyncContext` adalah prompt "GM"/sutradara tabletop-RPG inline besar yang diumpankan ke `chat/completions`). Juga punya pola placeholder yang terkonfirmasi aman (`trpg_card`, dibangun ulang dari `metadata.trpg` oleh `utils/messageFormat.ts`, mengabaikan `content` mentah).

**Pen Pal Society (Novel)** 🟢 — `apps/NovelApp.tsx` (sudah diterjemahkan). Menulis novel kolaboratif dengan karakter. Memakai pola placeholder `novel_card` (§2.1, terkonfirmasi aman, preseden trace yang sama dengan `[分享帖子]` di atas).

**Songwriting** 🟡 — `apps/SongwritingApp.tsx` (risiko SEDANG, sudah di-scout, 3 titik `role:'system'` belum terkonfirmasi satu-satu). Memakai `[系统: ...]` untuk narasi penyelesaian kolaborasi. Mengimpor `utils/songPrompts.ts` (🟢 terkonfirmasi, file prompt-AI protected sepenuhnya).

**Beyond (VRWorld)** 🟢 — `apps/VRWorldApp.tsx` (sudah diterjemahkan, 778 baris CJK). Dunia virtual bersama yang persisten dengan beberapa ruangan (Library, Rec Room, Guestbook, Post Office, dan ruang event relay-poem spesial "Signal Fall" — lihat `docs/signal-poetry.md`). Protected: konten pesan broadcast-user yang dibangun untuk riwayat chat LLM sungguhan, dan array status-chibi ambient `IDLE_QUIPS` (terkonfirmasi aman, cuma diindeks posisional). Bergantung pada `worker/post-office/` milik §2.7 untuk fitur lintas-user, mengimpor `utils/vrWorld/prompts.ts` (🔴 protected, belum dibaca penuh).

**Time Pact (Schedule)** 🔴 — `apps/ScheduleApp.tsx` (risiko TINGGI meski file kecil — dua template prompt inline penuh untuk reaksi penyelesaian-tugas dan pengingat-ulang tahun). Jadwal/pengingat harian karakter. Memakai `[系统: ...]` untuk narasi penyelesaian tugas (terkonfirmasi bilingual-safe).

**Worldbook** 🟢 — `apps/WorldbookApp.tsx` (sudah diterjemahkan). Editor entri lorebook/worldbook gaya SillyTavern, bisa di-attach ke karakter (§2.4). **Gap producer**: `WORLDBOOK_POSITION_LABELS`/`WORLDBOOK_ROLE_LABELS`/`WORLDBOOK_POSITION_DESCRIPTIONS` milik `utils/worldbook.ts` masih merender Mandarin di dalam layar yang sekarang berbahasa Inggris ini (didokumentasikan di bagian "Still open" CLAUDE.md) — juga diimpor oleh `apps/Character.tsx`.

**Hot News (HotNews)** 🟢 — `apps/HotNewsApp.tsx` (sudah diterjemahkan). Feed topik-trending/berita simulasi untuk direferensikan atau direaksikan karakter.

**Help (FAQ)** 🟢 — `apps/FAQApp.tsx` (sudah diterjemahkan). Konten help/FAQ statis, membaca data changelog dari `public/changelogs/`.

**Gallery** 🟢 — `apps/Gallery.tsx` (sudah diterjemahkan). Galeri foto/gambar, kemungkinan diisi gambar hasil chat dan upload manual.

**Free Roam (XhsFreeRoam)** 🟢 — `apps/XhsFreeRoamApp.tsx` (sudah diterjemahkan). Simulasi free-browsing gaya Xiaohongshu ("Little Red Book") untuk karakter. Punya file prompt-AI sendiri `utils/xhsFreeRoam.ts` (memakai keluarga `[[XHS_SEARCH:...]]`, §2.1).

**Xiaohongshu Gallery (XhsStock)** 🟢 — `apps/XhsStockApp.tsx` (sudah diterjemahkan). Varian browsing-konten-stok/galeri dari konsep simulasi Xiaohongshu yang sama.

**Bubble Workshop (ThemeMaker)** 🟢 — `apps/ThemeMaker.tsx` (sudah diterjemahkan). Kustomisasi tema warna/bentuk bubble chat, memberi makan `PRESET_THEMES` milik `components/chat/ChatConstants.ts` dan override per-karakter.

**Appearance** 🟢 — `apps/Appearance.tsx` (sudah diterjemahkan). Mengontrol `theme.skin` (§2.6) dan setting visual lain — titik masuk untuk berganti ke OS skin alternatif.

**Settings** 🟢 — `apps/Settings.tsx` (sudah diterjemahkan, 949 baris CJK, pekerjaan translate tunggal terbesar di proyek ini — 83 panggilan `trackEvent`). Hub sentral untuk: konfigurasi API (banyak provider), setup mesin suara (MiniMax/Fish Audio/ElevenLabs), backup & restore (ZIP lokal/WebDAV/GitHub), konfigurasi Proactive Message/Instant Push/MCP milik §2.7, dan integrasi tool MCP McDonald's/Luckin (frase trigger aktivasinya, `麦请求`/`瑞一杯`, harus tetap Mandarin literal — sebuah near-miss yang tertangkap saat translate, lihat batch 7 di CLAUDE.md).

**Guidebook** 🟡 — `apps/GuidebookApp.tsx` (risiko SEDANG-RENDAH, sudah di-scout). Fitur gameplay/kuis bernilai skor. Mengimpor `utils/guidebookPrompts.ts` (🟢 terkonfirmasi, protected sepenuhnya). Memakai pola placeholder `score_card` (terkonfirmasi aman — `utils/chatPrompts.ts` mereduksinya jadi placeholder generik `[评分卡]` untuk live chat; `utils/messageFormat.ts` secara terpisah membangun ulang ringkasan lengkap untuk memori).

**City Life (LifeSim)** 🟡 — `apps/LifeSimApp.tsx` (risiko SEDANG-RENDAH, sudah di-scout). Fitur simulasi kehidupan ditenagai `utils/lifeSimEngine.ts` (🔴 belum dibaca, dideskripsikan di `docs/code-organization-review.md` sebagai "seluruh game engine" dengan 1.486 baris) dan `utils/lifeSimPrompts.ts` (🟢 terkonfirmasi, protected sepenuhnya). Berbagi pola placeholder `score_card` dengan Guidebook.

**Special Moments (SpecialMoments)** 🟡 — `apps/SpecialMomentsApp.tsx` (belum di-scout individual di sesi ini, tapi sub-fiturnya sudah dikenal baik). Hub untuk konten event musiman/liburan: Valentine's Day (`components/ValentineEvent.tsx` 🟢 sudah diterjemahkan), White Day (`components/WhiteDayEvent.tsx` 🟢 sudah diterjemahkan), Qixi/Valentine Tiongkok (`components/events/qixi/` 🟢 sudah diterjemahkan). Ketiganya mengimpor query hint Memory Palace (§2.2) dan berbagi pola panel konfigurasi-API inline yang di-copy-paste antar event (temuan D1 di `docs/code-organization-review.md` — perbaikan di satu salinan event tidak merambat ke yang lain).

**Music** 🟢 — `apps/MusicApp.tsx` (sudah diterjemahkan). Fitur musik dengan integrasi API NetEase Cloud Music sungguhan untuk search/playback, plus title screen "未来音楽" (sengaja bermerek kanji Jepang, bukan Mandarin). Ditenagai `context/MusicContext.tsx`.

**Character Creator (Dev)** 🟢 — `apps/CharCreatorDevApp.tsx` (sudah diterjemahkan). Tool pembuatan-karakter import-PSD khusus dev, difilter keluar dari Launcher di build produksi.

**QQ Bridge (QQBridge, tersembunyi)** 🟢 — `apps/QQBridge.tsx` (sudah diterjemahkan, file berisiko-terendah di proyek — UI polos, tanpa konten prompt-AI, 1 `trackEvent`). Fitur relay/jembatan pesan.

**Browser (tersembunyi)** 🟢 — `apps/BrowserApp.tsx` (sudah diterjemahkan). Browser web palsu di-dalam-app untuk karakter "browsing." Mencocokkan nama situs Mandarin literal (`小红书`/`哔哩哔哩`) terhadap string address-bar yang diketik user — kategori risiko yang sudah didokumentasikan, sengaja tidak disentuh (mencocokkan sesuatu di luar kendali codebase, prinsip sama seperti protokol bracket-tag meski bukan itu).

**Handbook (tersembunyi, sementara dinonaktifkan di Launcher)** 🟢 — `apps/HandbookApp.tsx` + `components/handbook/` (19 file, sudah diterjemahkan). Fitur journal/planner/scrapbook "手账" — stiker, pelacakan mood, tracker (`utils/trackerSeeds.ts` 🔴, gap producer-belum-diterjemahkan yang sudah didokumentasikan). Beberapa flourish desain sengaja Jepang (font, label musim) dibiarkan tidak diterjemahkan — bukan gap translate, tapi pilihan desain.

**Voice Designer (tidak ada di `INSTALLED_APPS`, bisa diakses dari tempat lain)** 🟢 — `apps/VoiceDesignerApp.tsx` (sudah diterjemahkan). Tool desain/mixing suara TTS untuk suara MiniMax — `PREVIEW_SAMPLES`-nya (teks demo dalam zh/yue/ja) sengaja dibiarkan dalam skrip aslinya, karena menerjemahkannya akan membuat tombol "preview bahasa ini" bicara dalam bahasa yang salah.

**Dream Theater (tidak ada di `INSTALLED_APPS`, diluncurkan dari Dwelling)** — lihat entri Dwelling di atas.

**Persona Sim (tidak ada di `INSTALLED_APPS`, diluncurkan dari Check Phone)** — lihat entri Check Phone di atas.

---

## 4. Peta ketergantungan — "kalau X diubah, apa lagi yang berpotensi rusak"

Dikompilasi dari temuan lintas-file yang dicatat sepanjang sesi translate (CLAUDE.md punya detail blow-by-blow-nya; ini ringkasan dari sudut pandang arsitektur).

- **Ubah nama tag atau regex chat-protocol (§2.1)** → merusak mana pun dari Chat/Call/GroupChat/CheckPhone/Social/Novel/Game/Guidebook/LifeSim/WorldHome/VRWorld/Handbook/lifeRecord yang benar-benar memakai tag spesifik itu. Keluarga tag sebagian besar independen satu sama lain (mengubah tag voice/subtitle tidak mempengaruhi tag quote), tapi `MessageItem.tsx` adalah satu-satunya titik-sempit yang mem-parsing hampir semuanya — bug di situ punya blast radius terluas dari file mana pun di app ini.
- **Ubah internal `utils/memoryPalace/` (§2.2)** → langsung mempengaruhi app Memory Palace, Check Phone, Character (refine bulanan), Story Theater (app Date), dan — lebih halus — perilaku query-hint-memori event Valentine/WhiteDay/Qixi (regresi kualitas, bukan crash, kalau frasa query berubah).
- **Ubah bentuk `CharacterProfile` di `types.ts` (§2.4)** → menurut `docs/code-organization-review.md`, ~244 file (44,7% dari repo) mengimpor `types.ts` sama sekali; `CharacterProfile` sendiri ~137 field. Realistisnya menyentuh setiap app yang merender atau mengedit karakter.
- **Ubah bentuk state bersama `OSContext.tsx`** → ~70 file mengonsumsi `useOS()`. Karena objek value context-nya tidak di-memoize (isu yang sudah diketahui menurut `docs/code-organization-review.md`), bahkan perubahan field context yang *tidak terkait* pun bisa memicu re-render luas, bukan cuma dependent langsung.
- **Ubah `utils/db.ts` (lapisan storage)** → 108 pengimpor menurut dokumen yang sama; juga secara mandiri berada dalam lingkaran circular-dependency dengan `desktopSkinBackup`/`blobRef`.
- **Nonaktifkan atau ubah protokol Observe (§2.5)** → self-contained, cuma mempengaruhi app Date + parser terpisah Story Theater (mereka pakai mekanisme berbeda — jangan asumsi perbaikan di satu tempat mencakup yang lain).
- **Ubah "OS skin" (§2.6)** → rendering self-contained, tapi kalau kamu mengganti nama app atau fitur, ingat skin-skin ini memelihara salinan nama/label *sendiri* yang terpisah — penggantian nama di `constants.tsx` tidak merambat ke sini.
- **Matikan atau konfigurasi ulang backend `worker/*` (§2.7)** → gangguan `amsg` cuma merusak Proactive Message/Instant Chat; gangguan `post-office` cuma merusak event Signal Fall milik VRWorld dan guestbook/mail; gangguan `mcp-proxy` cuma merusak akses tool MCP yang dikonfigurasi user. Ini di-deploy independen, jadi satu mati tidak menjalar ke yang lain — tapi masing-masing yang mati secara diam-diam mendegradasi fiturnya alih-alih error keras (menurut bagian troubleshooting `docs/self-deploy-workers.md`, endpoint `/debug`/`/config-check` ada justru karena kegagalan biasanya tidak terlihat).
- **Ubah konvensi penamaan-event `docs/analytics.md` (§2.3)** → tidak ada kerusakan fungsional (kegagalan analytics memang sengaja diam), tapi merusak kontinuitas data umami historis dan melanggar janji transparansi yang dinyatakan dokumen itu sendiri kalau tidak diupdate selaras dengan UI.
- **Ubah `ContextBuilder`-nya `utils/context.ts` (§2.4)** → mempengaruhi apa yang benar-benar dilihat setiap fitur berbasis-karakter sebagai konteks prompt-nya — memori, waktu/cuaca, jadwal, relationship. Bug di sini adalah kelas regresi "AI jadi lebih bodoh di mana-mana", susah dilokalisir ke satu app.
- **Ganti nama/restrukturisasi `apps/Chat.tsx`, `MessageItem.tsx`, atau `ChatModals.tsx`** → ketiganya saling mengoper ~78-101 prop menurut `docs/code-organization-review.md` — anggap sebagai satu unit yang terkopel erat, bukan tiga file independen.

---

## 5. Bagian yang masih belum diverifikasi

Semua yang ditandai 🔴 di atas. Konkretnya, app yang *isinya* (bukan cuma keberadaannya) masih pengetahuan level-scouting, belum dibaca penuh: **`apps/Chat.tsx`, `apps/CallApp.tsx`, `apps/GameApp.tsx`, `apps/DreamTheater.tsx`, `apps/PersonaSim.tsx`, `apps/JournalApp.tsx`, `apps/ScheduleApp.tsx`, `apps/Character.tsx`** (semuanya risiko TINGGI menurut scouting pass batch translate) dan **`apps/CheckPhone.tsx`, `apps/GroupChat.tsx`, `apps/RoomApp.tsx`, `apps/BankApp.tsx`, `apps/SongwritingApp.tsx`, `apps/GuidebookApp.tsx`, `apps/LifeSimApp.tsx`** (risiko SEDANG). Juga: `worker/index.js` (main proxy ~3.771 baris yang tidak terdokumentasi), internal `worker/mcp-proxy/` dan `worker/post-office/`, `utils/lifeSimEngine.ts`, dan sebagian besar file individual `utils/memoryPalace/` di luar `pipeline.ts`/`digestion.ts`/`types.ts`.

Begitu masing-masing ini dibaca sungguhan (lewat sesi translate atau cara lain), update entrinya di atas dari 🔴/🟡 ke 🟢 dan perbaiki apa pun yang salah ditebak dokumen ini.
