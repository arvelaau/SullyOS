import React, { useEffect, useRef, useState } from 'react';
import { DB } from '../../utils/db';
import { shareOrDownloadFile } from '../../utils/shareExport';

// Chat "Whitebox" custom CSS editor (shared by Appearance's global default and per-character customization).
// Selector hooks cover the header, input bar, full-screen background, and normal message layout; see the AI_PROMPT below for the full list.

const PRESET_STORE_KEY = 'sully_chrome_css_presets_v1';

// A prompt to hand off to some other AI (so it generates a whole CSS block in the style you want).
const AI_PROMPT = `You are a CSS designer. I'm using a chat app called SullyOS, a "virtual phone in the browser,"
which lets me redesign the chat shell and message layout with a block of custom CSS.
This CSS gets injected into the chat interface and takes effect via the fixed class names below. Please write me
a complete block of CSS that achieves the style I want -- you have a lot of creative freedom, don't just change
colors, feel free to boldly rework the entire visual look of the header.

[Available class names (use ONLY these, no global selectors)]
- .sully-chat-root      the whole chat screen (outermost background)
- .sully-chat-header    the entire header (already position: relative, you can absolutely position children inside it)
- .sully-chat-back      the back-arrow button on the left
- .sully-chat-avatar    the character's avatar (a circular img by default; size/shape/position/mask can be changed)
- .sully-chat-name      the character's name
- .sully-chat-status    the online-status area next to/below the name
- .sully-chat-buffs     the emotion-state row container; each emotion pill inside it is .sully-chat-buffs button
- .sully-chat-token     the small token-usage label in the top-right corner
- .sully-chat-trigger   the small lightning-bolt "Trigger AI" button on the right
- .sully-chat-inputbar  the entire bottom input bar
- .sully-chat-panel     the feature panel (emoji/action menu) opened by tapping "+"; buttons inside it are .sully-chat-panel button
- .sully-chat-message   an entire normal message row; also carries -ai / -user and -group-first / -group-last state classes
- .sully-chat-message-content the bubble column for that message
- .sully-chat-message-avatar  the avatar normally stuck next to the last bubble in a group
- .sully-chat-turn-avatar-slot the avatar slot at the start of each group (display:none by default; already contains the correct avatar for both sides)
- .sully-chat-turn-avatar      the avatar container inside the slot above; the image itself is .sully-chat-message-avatar-img
- .sully-bubble-ai / .sully-bubble-user the character's / the user's bubble
- .sully-schedule-change      the whole receipt card that surfaces after the character changes an upcoming schedule
- .sully-schedule-change-head / -mark / -kicker  the receipt's title row / checkmark / title text
- .sully-schedule-change-list / -row             the list of changes / a single change
- .sully-schedule-change-time / -before / -arrow / -after  time slot / original plan / arrow / new plan
- .sully-schedule-change-shine                    the one-time shine sweep across the receipt

[Rules you must follow]
1. Overriding the default styles requires !important (especially .sully-chat-buffs button, which has inline styles that only !important can beat).
2. You may only use the .sully-chat-* / .sully-bubble-* / .sully-schedule-change* selectors above and their descendants/pseudo-elements -- no global selectors like body, *, div, or html (that would pollute other screens).
3. This is a narrow mobile screen (about 390px wide) -- keep sizes restrained, use relative units or small values.
4. The header already automatically reserves a safe area for the status bar at the top. If a decoration needs to sit flush against the very top, use top: calc(var(--safe-top) + value).
5. Don't display:none the .sully-chat-back button (or the user can't go back), unless I explicitly ask for it.
6. If you want a decoration to spill outside the header (like a hanging charm, or a wave that overflows), add overflow: visible to .sully-chat-header.
7. Performance: static backdrop-filter/blur is fine, but don't continuously animate blur/backdrop.
8. For "avatar above the bubble on every turn": show .sully-chat-turn-avatar-slot, hide .sully-chat-message-avatar,
   leave top space on .sully-chat-message-group-first, and zero out the left/right margin on .sully-chat-message-content.

[Areas you're free to get creative with]
- Background: solid color, gradient, repeating pattern, image (background: url(direct image link)), layered stacks -- anything goes.
- Shape: border-radius, clip-path (irregular cut corners/waves), anything; irregular shapes don't need an extra white backing.
- Texture: box-shadow, inset shadows, glow, outlines.
- Avatar: add a border, halo, change size/shape (even non-circular/banner shapes).
- Text: color, weight, letter-spacing, text shadow/glow.
- Emotion pills / token / panel buttons: background color, text color, border, corner radius.
- Re-layout: use position: absolute to place the avatar/name/lightning-bolt/token anywhere within the header.
- Decorative elements: use ::before / ::after for corner tags, stripes, icons, charms, light bands, etc. (remember to set content and position).
- Animation: @keyframes + animation are fine (keep it subtle, not too flashy).

[Output requirements]
Output one complete, ready-to-use block of CSS directly (a few comments are fine), no need for a long explanation.
The style I want right now is: ______ (fill in your request here, e.g. "cyberpunk neon," "Japanese-style hot spring," "Y2K millennium babe," "minimalist cold")`;

type Preset = { name: string; code: string; swatch?: string };

// Tries its best to pull the .sully-chat-header background value out of a CSS block, to generate a thumbnail swatch for "My Presets" (falls back to neutral gray if it can't be extracted).
const extractSwatch = (code: string): string => {
    const block = code.match(/\.sully-chat-header\s*\{([^}]*)\}/);
    const body = block ? block[1] : code;
    const m = body.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
    const val = m ? m[1].trim() : '';
    return val && !/url\(/i.test(val) ? val : '#e2e8f0';
};

// Built-in full styles (click = replaces the text box, takes effect immediately).
const PRESETS: Preset[] = [
    {
        name: 'Cream Sweetheart',
        swatch: 'linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)',
        code: `/* Cream Sweetheart */
.sully-chat-header{
  background:linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 18px rgba(214,160,180,.18);
  border-radius:0 0 22px 22px;
}
.sully-chat-name{color:#c2587f!important;}
.sully-chat-avatar{border:2px solid #ffb8d4!important;box-shadow:0 0 0 4px rgba(255,184,212,.25)!important;}
.sully-chat-buffs button{background:#fff0f6!important;color:#d6478b!important;border-color:#ffc6df!important;}
.sully-chat-trigger{color:#e86aa6!important;}
.sully-chat-token{background:#fff0f6!important;color:#c76aa0!important;border-color:#ffd4e6!important;}`,
    },
    {
        name: 'Neon Night',
        swatch: 'radial-gradient(circle at 30% 30%,#3b1d63,#0e0b1e 75%)',
        code: `/* Neon Night */
.sully-chat-header{
  background:#0e0b1e!important;
  border-bottom:1px solid rgba(168,85,247,.45)!important;
  box-shadow:0 0 26px rgba(168,85,247,.3);
}
.sully-chat-name{color:#e9d5ff!important;text-shadow:0 0 10px rgba(192,132,252,.9);}
.sully-chat-status{color:#a78bfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#67e8f9!important;}
.sully-chat-avatar{border:2px solid #67e8f9!important;box-shadow:0 0 12px rgba(103,232,249,.6)!important;}
.sully-chat-buffs button{background:rgba(103,232,249,.12)!important;color:#a5f3fc!important;border-color:rgba(103,232,249,.4)!important;}
.sully-chat-token{background:rgba(168,85,247,.15)!important;color:#d8b4fe!important;border-color:rgba(168,85,247,.4)!important;}`,
    },
    {
        name: 'Minty Cream',
        swatch: 'linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)',
        code: `/* Minty Cream */
.sully-chat-header{
  background:linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 16px rgba(120,190,160,.16);
  border-radius:0 0 20px 20px;
}
.sully-chat-name{color:#2f8f6b!important;}
.sully-chat-avatar{border:2px solid #8fe0bf!important;box-shadow:0 0 0 4px rgba(143,224,191,.25)!important;}
.sully-chat-buffs button{background:#e7faf0!important;color:#22936a!important;border-color:#abe6cd!important;}
.sully-chat-trigger{color:#2bb088!important;}
.sully-chat-token{background:#e7faf0!important;color:#3a9b76!important;border-color:#bdebd6!important;}`,
    },
    {
        name: 'Twilight Purple',
        swatch: 'linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)',
        code: `/* Twilight Purple */
.sully-chat-header{
  background:linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)!important;
  border-bottom:none!important;
  box-shadow:0 8px 22px rgba(80,50,130,.3);
  border-radius:0 0 18px 18px;
}
.sully-chat-name{color:#fce7ff!important;}
.sully-chat-status{color:#d6bcfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#f5d0fe!important;}
.sully-chat-avatar{border:2px solid rgba(255,255,255,.7)!important;box-shadow:0 4px 14px rgba(0,0,0,.3)!important;}
.sully-chat-buffs button{background:rgba(255,255,255,.16)!important;color:#fbe8ff!important;border-color:rgba(255,255,255,.3)!important;}
.sully-chat-token{background:rgba(255,255,255,.14)!important;color:#f0e0ff!important;border-color:rgba(255,255,255,.25)!important;}`,
    },
    {
        name: 'Minimal White',
        swatch: 'linear-gradient(135deg,#ffffff,#f3f4f6)',
        code: `/* Minimal White */
.sully-chat-header{background:#ffffff!important;border-bottom:1px solid #eef1f5!important;box-shadow:none!important;}
.sully-chat-name{color:#1f2937!important;}
.sully-chat-avatar{border:1.5px solid #e5e7eb!important;}
.sully-chat-buffs button{background:#f5f6f8!important;color:#6b7280!important;border-color:#e5e7eb!important;}
.sully-chat-trigger{color:#6366f1!important;}
.sully-chat-token{background:#f5f6f8!important;color:#9ca3af!important;border-color:#e5e7eb!important;}`,
    },
    {
        name: 'Lavender Plush',
        swatch: 'radial-gradient(150% 120% at 50% -30%,#ddc9ff,#c9b2f4 45%,#bda0ee)',
        code: `/* ===== Lavender Plush - Tender Style ===== */
.sully-chat-root{
  background:
    radial-gradient(120% 80% at 18% 0%, #f4ecff 0%, transparent 58%),
    radial-gradient(120% 80% at 92% 8%, #ffe9f7 0%, transparent 52%),
    linear-gradient(180deg, #efe6ff 0%, #f6f1ff 48%, #fcf9ff 100%) !important;
}
.sully-chat-header{
  overflow:visible !important;
  background:radial-gradient(150% 120% at 50% -30%, #ddc9ff 0%, #c9b2f4 45%, #bda0ee 100%) !important;
  border:none !important;
  border-radius:0 0 24px 24px !important;
  box-shadow:inset 0 2px 6px rgba(255,255,255,.6), inset 0 -10px 20px rgba(150,108,222,.35), 0 10px 26px rgba(178,142,236,.4) !important;
}
.sully-chat-header::before{
  content:"" !important;position:absolute !important;
  top:calc(var(--safe-top) + 4px) !important;right:14px !important;
  width:60px !important;height:60px !important;border-radius:50% !important;
  background:radial-gradient(circle, rgba(255,255,255,.55) 0%, transparent 70%) !important;
  filter:blur(2px) !important;pointer-events:none !important;
}
.sully-chat-back{
  color:#8a6bc4 !important;background:rgba(255,255,255,.65) !important;border-radius:50% !important;
  box-shadow:inset 0 1px 2px rgba(255,255,255,.9), 0 2px 6px rgba(160,120,220,.35) !important;
}
.sully-chat-avatar{
  width:46px !important;height:46px !important;border-radius:50% !important;border:3px solid #fff !important;
  box-shadow:0 0 0 3px rgba(220,200,255,.75), 0 0 16px 3px rgba(200,160,245,.6), 0 4px 10px rgba(160,120,220,.45) !important;
  animation:sully-float 4.5s ease-in-out infinite !important;
}
@keyframes sully-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-2.5px);}}
.sully-chat-name{color:#fff !important;font-weight:700 !important;letter-spacing:.5px !important;text-shadow:0 1px 4px rgba(135,95,205,.55), 0 0 10px rgba(255,255,255,.4) !important;}
.sully-chat-name::after{content:" ✦" !important;color:#fff3ff !important;font-size:.8em !important;text-shadow:0 0 6px rgba(255,255,255,.8) !important;}
.sully-chat-status{color:#f3ebff !important;font-size:.72rem !important;text-shadow:0 1px 2px rgba(130,90,200,.4) !important;}
.sully-chat-buffs button{
  background:rgba(255,255,255,.62) !important;color:#7a5bb0 !important;border:1.5px solid rgba(255,255,255,.85) !important;
  border-radius:999px !important;font-weight:600 !important;padding:2px 10px !important;
  box-shadow:0 2px 6px rgba(180,140,230,.3), inset 0 1px 2px rgba(255,255,255,.85) !important;backdrop-filter:blur(4px) !important;
}
.sully-chat-token{color:#8a6bc4 !important;background:rgba(255,255,255,.5) !important;border-radius:999px !important;padding:1px 8px !important;font-size:.66rem !important;box-shadow:inset 0 1px 2px rgba(255,255,255,.8) !important;}
.sully-chat-trigger{
  color:#fff !important;background:radial-gradient(circle at 35% 30%, #d9b8ff, #b98cf0) !important;border-radius:50% !important;
  box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 14px 2px rgba(200,150,250,.7), 0 3px 8px rgba(150,100,210,.45) !important;
  animation:sully-breathe 3.2s ease-in-out infinite !important;
}
@keyframes sully-breathe{0%,100%{box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 12px 2px rgba(200,150,250,.55), 0 3px 8px rgba(150,100,210,.45);}50%{box-shadow:0 0 0 2px rgba(255,255,255,.7), 0 0 20px 5px rgba(210,165,255,.85), 0 3px 8px rgba(150,100,210,.45);}}
.sully-chat-inputbar{
  background:linear-gradient(180deg, rgba(255,255,255,.85), rgba(245,238,255,.92)) !important;border:1.5px solid rgba(255,255,255,.9) !important;
  border-radius:22px 22px 0 0 !important;box-shadow:inset 0 2px 5px rgba(255,255,255,.9), 0 -6px 18px rgba(180,140,230,.28) !important;backdrop-filter:blur(8px) !important;
}`,
    },
    {
        name: 'Japanese Hot Spring',
        swatch: 'linear-gradient(165deg,#ffe3c4,#ffd0b0 38%,#ffb9ad 62%,#f7a9b0 84%,#ef9bb0)',
        code: `/* ===== Japanese Hot Spring - Morning Bathhouse ===== */
.sully-chat-root{background:linear-gradient(180deg,#fdf3e7 0%, #fbe9da 45%, #f6e4ea 100%) !important;}
.sully-chat-header{
  overflow:visible !important;border-bottom:none !important;box-shadow:0 .3rem .9rem rgba(180,120,110,.28) !important;
  background:
    radial-gradient(circle at 100% 50%, transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) 0 0 / 1.1rem 1.9rem,
    radial-gradient(circle at 0 50%,   transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) .55rem -.95rem / 1.1rem 1.9rem,
    linear-gradient(165deg,#ffe3c4 0%, #ffd0b0 38%, #ffb9ad 62%, #f7a9b0 84%, #ef9bb0 100%) !important;
}
.sully-chat-header::before{
  content:"";position:absolute;left:.6rem;right:.6rem;top:calc(var(--safe-top) + .1rem);height:2.6rem;pointer-events:none;z-index:0;
  background:
    radial-gradient(42% 60% at 22% 80%, rgba(255,255,255,.55), transparent 70%),
    radial-gradient(36% 55% at 52% 85%, rgba(255,255,255,.48), transparent 70%),
    radial-gradient(34% 50% at 80% 82%, rgba(255,255,255,.42), transparent 70%);
  filter:blur(3px);opacity:0;animation:sully-steam 7s ease-in-out infinite;
}
.sully-chat-header::after{
  content:"";position:absolute;left:0;right:0;bottom:-.55rem;height:1rem;pointer-events:none;z-index:2;
  background-image:
    radial-gradient(circle at .5rem .62rem, rgba(246,178,107,.98) 0 .3rem, rgba(212,96,74,.98) .3rem .34rem, transparent .36rem),
    linear-gradient(rgba(160,100,90,.6), rgba(160,100,90,.6));
  background-size:1.5rem 100%, 100% .07rem;background-position:0 0, 0 .18rem;background-repeat:repeat-x, repeat-x;
  filter:drop-shadow(0 .15rem .25rem rgba(212,96,74,.4));
}
.sully-chat-back{color:#7d4a44 !important;background:rgba(255,255,255,.5) !important;border:.08rem solid rgba(122,74,68,.3) !important;border-radius:50% !important;box-shadow:inset 0 0 .35rem rgba(255,255,255,.6), 0 .1rem .25rem rgba(180,120,110,.25) !important;}
.sully-chat-avatar{width:2.6rem !important;height:2.6rem !important;border-radius:50% !important;border:.12rem solid #fff7ee !important;object-fit:cover !important;box-shadow:0 0 0 .16rem rgba(212,96,74,.55), 0 0 .8rem rgba(246,178,107,.7), inset 0 0 .4rem rgba(0,0,0,.18) !important;}
.sully-chat-name{position:relative;z-index:1;color:#5a3243 !important;font-weight:700 !important;letter-spacing:.06em !important;text-shadow:0 .06rem 0 rgba(255,255,255,.5) !important;}
.sully-chat-status{position:relative;z-index:1;color:#3f8f6a !important;font-size:.66rem !important;letter-spacing:.04em !important;}
.sully-chat-status::before{content:"";display:inline-block;width:.42rem;height:.42rem;margin-right:.3rem;border-radius:50%;vertical-align:middle;background:#5cc486;box-shadow:0 0 .35rem rgba(92,196,134,.85);animation:sully-pulse 2.6s ease-in-out infinite;}
.sully-chat-buffs{gap:.3rem !important;position:relative;z-index:1;}
.sully-chat-buffs button{background:linear-gradient(#ffffff, #fdeede) !important;color:#8a4a44 !important;border:.07rem solid rgba(122,74,68,.4) !important;border-radius:.7rem !important;font-size:.66rem !important;font-weight:600 !important;letter-spacing:.02em !important;padding:.16rem .5rem !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.3), inset 0 .05rem 0 rgba(255,255,255,.8) !important;}
.sully-chat-token{color:#6a3d38 !important;background:linear-gradient(#ffffff, #fbeede) !important;border:.06rem solid rgba(122,74,68,.35) !important;border-radius:.5rem !important;font-size:.62rem !important;letter-spacing:.02em !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.28) !important;}
.sully-chat-trigger{color:#fff5e8 !important;background:radial-gradient(circle at 30% 30%, #f6b26b, #e0664a 72%) !important;border:.1rem solid rgba(255,255,255,.7) !important;border-radius:50% !important;animation:sully-ember 3.2s ease-in-out infinite;}
.sully-chat-inputbar{background:linear-gradient(180deg,#fff6ea,#ffece0) !important;border-top:.12rem solid rgba(212,96,74,.4) !important;border-radius:.9rem .9rem 0 0 !important;box-shadow:0 -.3rem .7rem rgba(180,120,110,.22), inset 0 .08rem 0 rgba(255,255,255,.7) !important;}
@keyframes sully-steam{0%{opacity:0;transform:translateY(.4rem) scaleY(.9);}50%{opacity:.5;}100%{opacity:0;transform:translateY(-.5rem) scaleY(1.12);}}
@keyframes sully-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(.82);}}
@keyframes sully-ember{0%,100%{box-shadow:0 0 .5rem rgba(224,102,74,.6), inset 0 .1rem .2rem rgba(255,255,255,.35);}50%{box-shadow:0 0 .9rem rgba(246,178,107,.95), inset 0 .1rem .2rem rgba(255,255,255,.4);}}`,
    },
];

// Custom presets are stored in IndexedDB (STORE_ASSETS, travels along with app backup/export); old localStorage data is auto-migrated once.
const PRESET_ASSET_KEY = 'chrome_css_presets';

const loadCustom = async (): Promise<Preset[]> => {
    try { const fromDb = await DB.getAssetRaw(PRESET_ASSET_KEY); if (Array.isArray(fromDb)) return fromDb; } catch { /* ignore */ }
    // Migrate old localStorage -> IndexedDB
    try {
        const raw = localStorage.getItem(PRESET_STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr) && arr.length) { await DB.saveAssetRaw(PRESET_ASSET_KEY, arr); localStorage.removeItem(PRESET_STORE_KEY); return arr; }
    } catch { /* ignore */ }
    return [];
};
const persistCustom = async (list: Preset[]) => { try { await DB.saveAssetRaw(PRESET_ASSET_KEY, list); } catch { /* ignore */ } };

// Export code: SULLYCSS1: + base64(utf8(JSON)), so the whole thing can be copied to share/carry over to a new device.
const encodePresets = (list: Preset[]): string => 'SULLYCSS1:' + btoa(unescape(encodeURIComponent(JSON.stringify(list))));
const decodePresets = (code: string): Preset[] => {
    const body = code.trim().replace(/^SULLYCSS1:/, '');
    const json = decodeURIComponent(escape(atob(body)));
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((p: any) => p && typeof p.name === 'string' && typeof p.code === 'string') : [];
};

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

const ChromeCssEditor: React.FC<{ value: string; onChange: (css: string) => void }> = ({ value, onChange }) => {
    const [copied, setCopied] = useState(false);
    const [custom, setCustom] = useState<Preset[]>([]);
    const txtImportRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let alive = true;
        loadCustom().then((list) => { if (alive) setCustom(list); });
        return () => { alive = false; };
    }, []);

    const commitCustom = (next: Preset[]) => { setCustom(next); persistCustom(next); };

    const handleCopyPrompt = async () => {
        if (await copyText(AI_PROMPT)) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    };
    const handleSavePreset = () => {
        if (!value.trim() || typeof window === 'undefined') return;
        const name = window.prompt('Name this Whitebox preset (shared across all characters):', 'My Preset')?.trim();
        if (!name) return;
        commitCustom([...custom.filter((p) => p.name !== name), { name, code: value }]);
    };
    const handleDeletePreset = (name: string) => commitCustom(custom.filter((p) => p.name !== name));

    const handleTxtImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const css = (await file.text()).replace(/^\uFEFF/, '');
            if (!css.trim()) {
                window.alert('The TXT file is empty.');
                return;
            }
            onChange(css);
        } catch {
            window.alert('TXT import failed. Please make sure the file can be read normally.');
        } finally {
            event.target.value = '';
        }
    };

    const handleTxtExport = async () => {
        if (!value.trim()) {
            window.alert('There is no CSS to export right now.');
            return;
        }
        const date = new Date();
        const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const fileName = `sullyos-whitebox-${dateKey}.txt`;
        try {
            await shareOrDownloadFile({
                content: value,
                fileName,
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: 'SullyOS Whitebox Style',
            });
        } catch (error: any) {
            if (error?.name !== 'AbortError') window.alert('TXT export failed. Please try again.');
        }
    };

    const handleExport = async () => {
        if (!custom.length) { window.alert('There are no "My Presets" to export yet.'); return; }
        const ok = await copyText(encodePresets(custom));
        window.alert(ok ? `Copied the export code for ${custom.length} presets to the clipboard -- send it to someone else, or paste it to import on a new device.` : 'Copy failed. Please try again.');
    };
    const handleImport = () => {
        if (typeof window === 'undefined') return;
        const code = window.prompt('Paste a preset export code (SULLYCSS1:...):', '')?.trim();
        if (!code) return;
        let incoming: Preset[] = [];
        try { incoming = decodePresets(code); } catch { window.alert('Could not recognize the export code. Please make sure you pasted the whole thing.'); return; }
        if (!incoming.length) { window.alert('No valid presets were found.'); return; }
        // Same-name entries overwrite, the rest are appended
        const map = new Map(custom.map((p) => [p.name, p] as const));
        incoming.forEach((p) => map.set(p.name, p));
        commitCustom(Array.from(map.values()));
        window.alert(`Imported ${incoming.length} presets.`);
    };

    const cardCls = 'group relative h-14 w-[78px] shrink-0 overflow-hidden rounded-xl border border-black/5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-95';
    const cardLabelCls = 'absolute inset-x-0 bottom-0 truncate px-1.5 py-1 text-[10px] font-bold text-white';

    return (
        <div className="space-y-4">
            {/* Need inspiration: copy the prompt for an AI */}
            <button onClick={handleCopyPrompt}
                className="flex w-full items-center gap-2.5 rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50 px-3.5 py-3 text-left transition-all hover:from-indigo-100 hover:to-violet-100 active:scale-[0.99]">
                <span className="text-lg leading-none">{copied ? '✓' : '🪄'}</span>
                <span className="min-w-0">
                    <span className="block text-[12px] font-bold text-indigo-700">{copied ? 'Copied! Hand it to any AI' : 'Let an AI write one for you'}</span>
                    <span className="block text-[10px] leading-snug text-indigo-400">Copy the prompt then send it to any AI, tell it the style you want, and paste the CSS it gives you back here</span>
                </span>
            </button>

            {/* Built-in styles: thumbnail swatch cards */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">Built-in Styles <span className="font-normal text-slate-400">- tap to apply</span></div>
                <div className="flex flex-wrap gap-2">
                    {PRESETS.map((p) => (
                        <button key={p.name} onClick={() => onChange(p.code)} title={p.name} className={cardCls}>
                            <span className="absolute inset-0" style={{ background: p.swatch }} />
                            <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* My Presets: shared across all characters, stored in IndexedDB (travels with backups), can be imported/exported */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500">My Presets <span className="font-normal text-slate-400">- shared across all characters</span></span>
                    <div className="flex items-center gap-1">
                        <button onClick={handleImport} className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">Import</button>
                        <button onClick={handleExport} disabled={!custom.length} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${custom.length ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>Export</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {custom.map((p) => (
                        <div key={p.name} className={cardCls}>
                            <button onClick={() => onChange(p.code)} title={p.name} className="absolute inset-0">
                                <span className="absolute inset-0" style={{ background: extractSwatch(p.code) }} />
                                <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                            </button>
                            <button onClick={() => handleDeletePreset(p.name)} title="Delete"
                                className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/45 text-[10px] leading-none text-white opacity-80 hover:bg-rose-500">×</button>
                        </div>
                    ))}
                    {/* Save the current CSS as a preset */}
                    <button onClick={handleSavePreset} disabled={!value.trim()} title={value.trim() ? 'Save the current CSS as a preset' : 'Write some CSS first'}
                        className={`flex h-14 w-[78px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed text-[10px] font-bold transition-all active:scale-95 ${value.trim() ? 'border-emerald-300 text-emerald-600 hover:bg-emerald-50' : 'border-slate-200 text-slate-300'}`}>
                        <span className="text-lg leading-none">＋</span>Save Current
                    </button>
                </div>
            </div>

            {/* CSS code area */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-500">CSS Code <span className="font-normal text-slate-400">- can be hand-edited / pasted</span></span>
                    <div className="flex items-center gap-1">
                        <input ref={txtImportRef} type="file" accept=".txt,text/plain" className="hidden" onChange={handleTxtImport} />
                        <button onClick={() => txtImportRef.current?.click()} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-500 hover:bg-indigo-50">Import TXT</button>
                        <button onClick={handleTxtExport} disabled={!value.trim()} className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${value.trim() ? 'text-indigo-500 hover:bg-indigo-50' : 'text-slate-300'}`}>Export TXT</button>
                        {value && <button onClick={() => onChange('')} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">Clear</button>}
                    </div>
                </div>
                <textarea
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={'/* Tap any preset above, or write / paste CSS directly here */\n.sully-chat-header{\n  background: linear-gradient(135deg,#ffe3ef,#f1e7ff) !important;\n  border-bottom: none !important;\n}'}
                    spellCheck={false}
                    rows={8}
                    className="w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200 outline-none focus:border-primary/50 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                />
                <div className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                    Available selectors: <code className="rounded bg-slate-100 px-1 text-slate-500">.sully-chat-header / -avatar / -name / -buffs / -token / -trigger / -back / -status / -inputbar / -panel / -root</code>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    Schedule-change animation: <code className="rounded bg-slate-100 px-1 text-slate-500">.sully-schedule-change / -head / -mark / -kicker / -list / -row / -time / -before / -arrow / -after / -shine</code>
                </div>
            </div>
        </div>
    );
};

export default ChromeCssEditor;
