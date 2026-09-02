


import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { ChatTheme, BubbleStyle } from '../types';
import { processImage } from '../utils/file';
import { validateScopedCss, runCssRenderabilityCheck, CssValidationResult } from '../utils/scopedCss';
import { trackEvent } from '../utils/analytics';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from '../utils/bubbleAppearance';
import { shareOrDownloadFile } from '../utils/shareExport';
import { migrateDataUrlToRef, resolveBlobRefsDeep, useBlobRefUrl } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';

const cloneTheme = (theme: ChatTheme): ChatTheme => {
    if (typeof structuredClone === 'function') {
        return structuredClone(theme);
    }
    return JSON.parse(JSON.stringify(theme));
};

/**
 * 一侧气泡里的图片改存令牌：底纹 / 贴纸 / 头像挂件三个字段，还是 base64 的换成
 * `blobref:<id>`（二进制进 blob_assets，见 utils/blobRef.ts），其余值原样。
 * 转不动时 migrateDataUrlToRef 会把原串还回来，图不会丢。
 */
async function bubbleStyleToBlobRefs(style: BubbleStyle): Promise<BubbleStyle> {
    const toRef = async (value: string | undefined): Promise<string | undefined> => (
        typeof value === 'string' && value.startsWith('data:image/') ? await migrateDataUrlToRef(value) : value
    );
    const next = { ...style };
    next.backgroundImage = await toRef(next.backgroundImage);
    next.decoration = await toRef(next.decoration);
    next.avatarDecoration = await toRef(next.avatarDecoration);
    return next;
}

/**
 * 气泡底纹层。底纹画在 CSS background-image 上，享受不到 <img>（TokenImg）那层的
 * 自动解析，得自己调 hook 把令牌解成 objectURL；而预览气泡是在一个普通函数里渲染的
 * （hook 不能写在那儿），所以单独包成组件，解析放在它自己内部。
 */
const BubbleBgLayer: React.FC<{ value?: string; opacity?: number }> = ({ value, opacity }) => {
    const url = useBlobRefUrl(value);
    if (!url) return null;
    return (
        <div
            className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
            style={{ backgroundImage: `url(${url})`, opacity: opacity ?? 0.5, borderRadius: 'inherit' }}
        />
    );
};

const DEFAULT_STYLE: BubbleStyle = {
    textColor: '#334155',
    backgroundColor: '#ffffff',
    borderRadius: 20,
    tailMode: 'last',
    opacity: 1,
    backgroundImageOpacity: 0.5,
    decorationX: 90,
    decorationY: -10,
    decorationScale: 1,
    decorationRotate: 0,
    avatarDecorationX: 50,
    avatarDecorationY: 50,
    avatarDecorationScale: 1,
    avatarDecorationRotate: 0
};

const DEFAULT_THEME: ChatTheme = {
    id: '',
    name: 'New Theme',
    type: 'custom',
    user: { ...DEFAULT_STYLE, textColor: '#ffffff', backgroundColor: '#6366f1' },
    ai: { ...DEFAULT_STYLE },
    customCss: ''
};

const VOICE_PREVIEW_DURATION_MS = 8000;
const VOICE_PREVIEW_WAVE = [4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 5, 9];

// --- CSS Examples ---
const CSS_EXAMPLES = [
    {
        name: 'Glass',
        code: `/* Glassmorphism for bubbles */
.sully-bubble-user, .sully-bubble-ai {
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.4);
  box-shadow: 0 4px 6px rgba(0,0,0,0.05);
}
.sully-bubble-user { background: rgba(99, 102, 241, 0.7) !important; }
.sully-bubble-ai { background: rgba(255, 255, 255, 0.7) !important; }`
    },
    {
        name: 'Neon',
        code: `/* Glowing Neon Borders */
.sully-bubble-user {
  border: 2px solid #a855f7;
  box-shadow: 0 0 10px #a855f7;
  background: #2e1065 !important;
  color: #fff !important;
}
.sully-bubble-ai {
  border: 2px solid #3b82f6;
  box-shadow: 0 0 10px #3b82f6;
  background: #172554 !important;
  color: #fff !important;
}`
    },
    {
        name: 'Pixel',
        code: `/* Pixel Art Style — Refined */
.sully-bubble-user, .sully-bubble-ai {
  border-radius: 0px !important;
  border: 3px solid #2d2d2d;
  box-shadow: 4px 4px 0px #2d2d2d, inset -2px -2px 0px rgba(0,0,0,0.12), inset 2px 2px 0px rgba(255,255,255,0.25);
  font-family: 'Courier New', monospace;
  image-rendering: pixelated;
  letter-spacing: 0.02em;
}
.sully-bubble-user {
  background: linear-gradient(135deg, #6366f1 0%, #818cf8 100%) !important;
  border-color: #4338ca;
  box-shadow: 4px 4px 0px #4338ca, inset -2px -2px 0px rgba(0,0,0,0.15), inset 2px 2px 0px rgba(255,255,255,0.2);
}
.sully-bubble-ai {
  background: linear-gradient(135deg, #f8f8f8 0%, #e8e8e8 100%) !important;
  border-color: #bbb;
  box-shadow: 4px 4px 0px #bbb, inset -2px -2px 0px rgba(0,0,0,0.06), inset 2px 2px 0px rgba(255,255,255,0.8);
}`
    }
];

// --- Helpers for Color & CSS ---

// Parse Hex/RGBA to { hex: "#RRGGBB", alpha: 0-1 }
const parseColorValue = (color: string) => {
    // Default
    let hex = '#ffffff';
    let alpha = 1;

    if (!color) return { hex, alpha };

    if (color.startsWith('#')) {
        hex = color.substring(0, 7);
        // Handle #RRGGBBAA? Assuming standard 6 char for now or simple
        return { hex, alpha: 1 };
    }

    if (color.startsWith('rgba')) {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (match) {
            const r = parseInt(match[1]);
            const g = parseInt(match[2]);
            const b = parseInt(match[3]);
            const a = match[4] ? parseFloat(match[4]) : 1;
            const toHex = (n: number) => n.toString(16).padStart(2, '0');
            hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            alpha = a;
        }
    }
    return { hex, alpha };
};

const toRgbaString = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

type RGB = { r: number; g: number; b: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const hexToRgb = (hex: string): RGB => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
});

const mixColors = (fg: RGB, bg: RGB, alpha: number): RGB => {
    const a = clamp(alpha, 0, 1);
    return {
        r: Math.round(fg.r * a + bg.r * (1 - a)),
        g: Math.round(fg.g * a + bg.g * (1 - a)),
        b: Math.round(fg.b * a + bg.b * (1 - a))
    };
};

const relativeLuminance = ({ r, g, b }: RGB) => {
    const toLinear = (channel: number) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
};

const getContrastRatio = (textHex: string, backgroundColor: string, previewBgHex: string) => {
    const parsedBg = parseColorValue(backgroundColor);
    const text = hexToRgb(parseColorValue(textHex).hex);
    const bubbleBg = hexToRgb(parsedBg.hex);
    const previewBg = hexToRgb(previewBgHex);
    const effectiveBg = mixColors(bubbleBg, previewBg, parsedBg.alpha);
    const l1 = relativeLuminance(text);
    const l2 = relativeLuminance(effectiveBg);
    const bright = Math.max(l1, l2);
    const dark = Math.min(l1, l2);
    return (bright + 0.05) / (dark + 0.05);
};

const getContrastGrade = (ratio: number) => {
    if (ratio >= 7) return 'A';
    if (ratio >= 4.5) return 'B';
    return 'C';
};

const getReadableTextColor = (backgroundColor: string, previewBgHex: string) => {
    const whiteContrast = getContrastRatio('#ffffff', backgroundColor, previewBgHex);
    const blackContrast = getContrastRatio('#000000', backgroundColor, previewBgHex);
    return whiteContrast >= blackContrast ? '#ffffff' : '#000000';
};

// Padding CSS Injection Helper
const PADDING_MARKER_START = '/* PADDING_AUTO_START */';
const PADDING_MARKER_END = '/* PADDING_AUTO_END */';

const injectPaddingCss = (css: string, verticalPadding: number) => {
    const horizontalPadding = Math.round(verticalPadding * 1.6); // Aspect ratio for bubble
    const rule = `
${PADDING_MARKER_START}
.sully-bubble-user, .sully-bubble-ai {
  padding: ${verticalPadding}px ${horizontalPadding}px !important;
}
${PADDING_MARKER_END}`;

    const regex = new RegExp(`${PADDING_MARKER_START.replace(/\*/g, '\\*')}[\\s\\S]*?${PADDING_MARKER_END.replace(/\*/g, '\\*')}`);
    
    if (css && css.match(regex)) {
        return css.replace(regex, rule);
    }
    return (css || '') + rule;
};

const extractPaddingFromCss = (css: string) => {
    const match = css?.match(/padding:\s*(\d+)px/);
    return match ? parseInt(match[1]) : 12; // Default 12px (py-3)
};

const SHADOW_MARKER_START = '/* SHADOW_AUTO_START */';
const SHADOW_MARKER_END = '/* SHADOW_AUTO_END */';

const injectShadowCss = (css: string, userShadow: string, aiShadow: string) => {
    const rule = `
${SHADOW_MARKER_START}
.sully-bubble-user { box-shadow: ${userShadow} !important; }
.sully-bubble-ai { box-shadow: ${aiShadow} !important; }
${SHADOW_MARKER_END}`;

    const regex = new RegExp(`${SHADOW_MARKER_START.replace(/\*/g, '\\*')}[\\s\\S]*?${SHADOW_MARKER_END.replace(/\*/g, '\\*')}`);
    if (css && css.match(regex)) {
        return css.replace(regex, rule);
    }
    return (css || '') + rule;
};

const hslToHex = (h: number, s: number, l: number) => {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = light - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;

    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    const toHex = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

type StyleTemplate = {
    id: string;
    name: string;
    description: string;
    user: Partial<BubbleStyle>;
    ai: Partial<BubbleStyle>;
    userShadow: string;
    aiShadow: string;
};

type CssSnippet = {
    id: string;
    name: string;
    description: string;
    code: string;
};

const TARGET_SELECTOR_REGEX = /^(?:\.sully-bubble-(?:user|ai)\b|\.sully-voice-bar\b)/;

const isValidHttpImageUrl = (value: string) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
};

// 校验实现挪去 utils/scopedCss.ts（心象卡片的自定义 CSS 复用同一套），这里只绑定气泡作用域
const validateCustomCss = (css: string): CssValidationResult =>
    validateScopedCss(css, TARGET_SELECTOR_REGEX, '.sully-bubble-user / .sully-bubble-ai / .sully-voice-bar');

const CSS_SCOPE_SNIPPETS: CssSnippet[] = [
    {
        id: 'scope-shadow',
        name: 'Shadow',
        description: 'Add a soft drop shadow to both sides of bubbles',
        code: `.sully-bubble-user, .sully-bubble-ai {\n  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.14);\n}`
    },
    {
        id: 'scope-stroke',
        name: 'Stroke',
        description: 'Add a consistent border outline',
        code: `.sully-bubble-user, .sully-bubble-ai {\n  border: 1px solid rgba(148, 163, 184, 0.45);\n}`
    },
    {
        id: 'scope-gradient',
        name: 'Gradient',
        description: 'Give user and character bubbles distinct layers',
        code: `.sully-bubble-user {\n  background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;\n}\n.sully-bubble-ai {\n  background: linear-gradient(135deg, #ffffff, #e2e8f0) !important;\n}`
    },
    {
        id: 'scope-glass',
        name: 'Glass',
        description: 'Frosted glass + highlighted border',
        code: `.sully-bubble-user, .sully-bubble-ai {\n  backdrop-filter: blur(10px);\n  border: 1px solid rgba(255, 255, 255, 0.45);\n}\n.sully-bubble-user {\n  background: rgba(99, 102, 241, 0.62) !important;\n}\n.sully-bubble-ai {\n  background: rgba(255, 255, 255, 0.62) !important;\n}`
    },
    {
        id: 'scope-voice-bar',
        name: 'Voice Bar',
        description: 'Customize the voice bar, play button and waveform separately',
        code: `.sully-voice-bar {\n  min-width: 220px;\n  border-radius: 10px !important;\n  background: rgba(255,255,255,.72) !important;\n}\n.sully-voice-bar-button {\n  transform: rotate(-4deg);\n}\n.sully-voice-bar-wave-segment {\n  border-radius: 0 !important;\n}`
    }
];

const STYLE_TEMPLATES: StyleTemplate[] = [
    {
        id: 'cream',
        name: 'Cream',
        description: 'Warm, low saturation, soft shadow',
        user: { textColor: '#7c2d12', backgroundColor: 'rgba(254, 243, 199, 0.92)', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.45, decorationX: 88, decorationY: -12, avatarDecorationX: 52, avatarDecorationY: 50 },
        ai: { textColor: '#78350f', backgroundColor: 'rgba(255, 251, 235, 0.9)', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.4, decorationX: 12, decorationY: -10, avatarDecorationX: 48, avatarDecorationY: 50 },
        userShadow: '0 8px 24px rgba(217, 119, 6, 0.18)',
        aiShadow: '0 6px 20px rgba(180, 83, 9, 0.14)'
    },
    {
        id: 'glass',
        name: 'Glass',
        description: 'Translucent frosted look, thin edges',
        user: { textColor: '#0f172a', backgroundColor: 'rgba(191, 219, 254, 0.78)', borderRadius: 18, opacity: 0.98, backgroundImageOpacity: 0.6, decorationX: 90, decorationY: -14, avatarDecorationX: 50, avatarDecorationY: 48 },
        ai: { textColor: '#0f172a', backgroundColor: 'rgba(255, 255, 255, 0.72)', borderRadius: 18, opacity: 0.98, backgroundImageOpacity: 0.55, decorationX: 10, decorationY: -14, avatarDecorationX: 50, avatarDecorationY: 48 },
        userShadow: '0 10px 28px rgba(30, 41, 59, 0.16)',
        aiShadow: '0 8px 22px rgba(30, 41, 59, 0.13)'
    },
    {
        id: 'neon',
        name: 'Neon',
        description: 'High-contrast fluorescent, glowing outline',
        user: { textColor: '#faf5ff', backgroundColor: 'rgba(88, 28, 135, 0.9)', borderRadius: 16, opacity: 1, backgroundImageOpacity: 0.32, decorationX: 94, decorationY: -8, avatarDecorationX: 50, avatarDecorationY: 46 },
        ai: { textColor: '#e0f2fe', backgroundColor: 'rgba(12, 74, 110, 0.9)', borderRadius: 16, opacity: 1, backgroundImageOpacity: 0.32, decorationX: 8, decorationY: -8, avatarDecorationX: 50, avatarDecorationY: 46 },
        userShadow: '0 0 18px rgba(217, 70, 239, 0.55)',
        aiShadow: '0 0 18px rgba(14, 165, 233, 0.55)'
    },
    {
        id: 'paper',
        name: 'Paper',
        description: 'Slightly yellowed paper, subtle grain',
        user: { textColor: '#3f3f46', backgroundColor: 'rgba(254, 249, 195, 0.93)', borderRadius: 14, opacity: 1, backgroundImageOpacity: 0.7, decorationX: 90, decorationY: -6, avatarDecorationX: 54, avatarDecorationY: 52 },
        ai: { textColor: '#44403c', backgroundColor: 'rgba(254, 252, 232, 0.93)', borderRadius: 14, opacity: 1, backgroundImageOpacity: 0.68, decorationX: 10, decorationY: -6, avatarDecorationX: 46, avatarDecorationY: 52 },
        userShadow: '2px 2px 0 rgba(120, 113, 108, 0.32)',
        aiShadow: '2px 2px 0 rgba(113, 113, 122, 0.26)'
    },
    {
        id: 'minimal',
        name: 'Minimal',
        description: 'Low shadow, clean whitespace',
        user: { textColor: '#0f172a', backgroundColor: 'rgba(226, 232, 240, 0.86)', borderRadius: 20, opacity: 0.97, backgroundImageOpacity: 0.25, decorationX: 92, decorationY: -10, avatarDecorationX: 50, avatarDecorationY: 50 },
        ai: { textColor: '#1e293b', backgroundColor: 'rgba(248, 250, 252, 0.85)', borderRadius: 20, opacity: 0.97, backgroundImageOpacity: 0.22, decorationX: 8, decorationY: -10, avatarDecorationX: 50, avatarDecorationY: 50 },
        userShadow: '0 2px 8px rgba(15, 23, 42, 0.08)',
        aiShadow: '0 2px 8px rgba(15, 23, 42, 0.06)'
    }
];

type PreviewMockMessage = {
    id: string;
    role: 'user' | 'ai';
    kind: 'text' | 'image' | 'emoji' | 'voice';
    content: string;
    replyTo?: {
        name: string;
        content: string;
    };
};

type PreviewScene = {
    id: string;
    name: string;
    wallpaper?: string;
    darkMode?: boolean;
    messages: PreviewMockMessage[];
};

const PREVIEW_SCENES: PreviewScene[] = [
    {
        id: 'daily',
        name: 'Everyday Chat',
        messages: [
            { id: 'd1', role: 'ai', kind: 'text', content: "How's it going today? Want to go over the plan together?" },
            { id: 'd2', role: 'ai', kind: 'voice', content: '00:08' },
            { id: 'd3', role: 'user', kind: 'text', content: "Good! Let's go through the tasks together later." }
        ]
    },
    {
        id: 'long',
        name: 'Long Text',
        messages: [
            {
                id: 'l1',
                role: 'ai',
                kind: 'text',
                content: 'This is a long text sample for checking readability with large blocks of content, automatic line wrapping, and paragraph reading.\n\nThe second paragraph keeps some whitespace so you can focus on line spacing, background image overlay opacity, and whether the text contrast feels comfortable.'
            },
            {
                id: 'l2',
                role: 'user',
                kind: 'text',
                content: "Got it, I'll focus on the corners, paragraph spacing, and readability against light/dark backgrounds."
            }
        ]
    },
    {
        id: 'reply',
        name: 'Reply Chain',
        messages: [
            { id: 'r1', role: 'ai', kind: 'text', content: 'I highlighted the key points — take a look at this version.' },
            {
                id: 'r2',
                role: 'user',
                kind: 'text',
                content: "I'd like to adjust the border highlight effect a bit more here.",
                replyTo: { name: 'AI', content: 'I highlighted the key points — take a look at this version.' }
            }
        ]
    },
    {
        id: 'mix',
        name: 'Mixed Images',
        messages: [
            { id: 'm1', role: 'ai', kind: 'image', content: 'Preview image' },
            { id: 'm2', role: 'user', kind: 'emoji', content: '😆' },
            { id: 'm3', role: 'ai', kind: 'text', content: 'Keep the visual hierarchy clear when mixing images, text, and emoji.' }
        ]
    },
    {
        id: 'dark-wallpaper',
        name: 'Dark Wallpaper',
        darkMode: true,
        wallpaper: 'linear-gradient(135deg,#020617 0%,#1e293b 35%,#0f172a 100%)',
        messages: [
            { id: 'dw1', role: 'ai', kind: 'text', content: 'With a dark wallpaper, be sure to double-check the contrast of light-colored text.' },
            { id: 'dw2', role: 'user', kind: 'text', content: "OK, I'll also check that the transparent background image and shadow look clean." }
        ]
    }
];

const ThemeMaker: React.FC = () => {
    const { closeApp, addCustomTheme, removeCustomTheme, addToast, characters, updateCharacter, customThemes } = useOS();
    const [initialThemeId] = useState(() => `theme-${Date.now()}`);
    const [editingTheme, setEditingTheme] = useState<ChatTheme>({ ...DEFAULT_THEME, id: initialThemeId });
    const [activeTab, setActiveTab] = useState<'user' | 'ai' | 'css'>('user');
    const [toolSection, setToolSection] = useState<'base' | 'sticker' | 'avatar'>('base'); 
    const [previewSceneId, setPreviewSceneId] = useState(PREVIEW_SCENES[0].id);
    const [showPreviewBgImage, setShowPreviewBgImage] = useState(true);
    const [isPreviewDark, setIsPreviewDark] = useState(false);
    const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
    const [userFollowAi, setUserFollowAi] = useState(false);
    const [lastSavedTheme, setLastSavedTheme] = useState<ChatTheme>(() => cloneTheme({ ...DEFAULT_THEME, id: initialThemeId }));
    const [isDirty, setIsDirty] = useState(false);
    const [pendingDiscardAction, setPendingDiscardAction] = useState<(() => void) | null>(null);
    const [pendingDeleteTheme, setPendingDeleteTheme] = useState<ChatTheme | null>(null);
    const [showLowContrastConfirm, setShowLowContrastConfirm] = useState(false);
    const [pendingSaveExit, setPendingSaveExit] = useState(false);
    const [isAppliedToPreview, setIsAppliedToPreview] = useState(false);
    const [undoStack, setUndoStack] = useState<ChatTheme[]>([]);
    const [redoStack, setRedoStack] = useState<ChatTheme[]>([]);
    const [previewCompareMode, setPreviewCompareMode] = useState<'single' | 'split' | 'toggle'>('single');
    const [previewToggleTarget, setPreviewToggleTarget] = useState<'A' | 'B'>('A');
    const [lastUsableCss, setLastUsableCss] = useState('');
    const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
    const [editorPanelOpen, setEditorPanelOpen] = useState(true);
    const [editorBubblePos, setEditorBubblePos] = useState<{ x: number; y: number } | null>(null);
    const [playingVoicePreviewKey, setPlayingVoicePreviewKey] = useState<string | null>(null);
    const [voicePreviewProgress, setVoicePreviewProgress] = useState(0);
    // 保存后的「应用到角色」弹层：勾选 = 该角色 bubbleStyle 指向本主题，取消勾选 = 回落默认气泡
    const [showApplySheet, setShowApplySheet] = useState(false);
    const [applySelection, setApplySelection] = useState<Set<string>>(new Set());
    const [assetUrlDraft, setAssetUrlDraft] = useState<Record<'bg' | 'deco' | 'avatarDeco', string>>({ bg: '', deco: '', avatarDeco: '' });
    const [isThemeLibraryOpen, setIsThemeLibraryOpen] = useState(false);
    const [themeLibrarySearch, setThemeLibrarySearch] = useState('');
    
    // Local state for sliders
    const [paddingVal, setPaddingVal] = useState(12);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const themeImportInputRef = useRef<HTMLInputElement>(null);
    const decorationInputRef = useRef<HTMLInputElement>(null);
    const avatarDecoInputRef = useRef<HTMLInputElement>(null);
    const cssTextareaRef = useRef<HTMLTextAreaElement>(null);
    const editorBubbleDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

    const activeStyle = editingTheme[activeTab === 'css' ? 'user' : activeTab];
    // 语音消息只出现在角色侧；无论当前在编辑哪个 tab，语音条控件都写到 ai，
    // 避免旧版在“用户气泡”页改了颜色却永远不生效的假设置。
    const voiceBarStyle = editingTheme.ai;
    const CONTRAST_LOW_THRESHOLD = 4.5;
    const CONTRAST_CRITICAL_THRESHOLD = 3;
    const HIGH_BG_IMAGE_OPACITY = 0.75;
    const cssValidation = useMemo(() => validateCustomCss(editingTheme.customCss || ''), [editingTheme.customCss]);

    // 与「外观 → 聊天界面」保持同一套交互：圆形设置钮可拖动，轻点收起/展开悬浮编辑面板。
    const EDITOR_BUBBLE_SIZE = 48;
    const clampEditorBubble = (x: number, y: number) => ({
        x: Math.max(8, Math.min(window.innerWidth - EDITOR_BUBBLE_SIZE - 8, x)),
        y: Math.max(56, Math.min(window.innerHeight - EDITOR_BUBBLE_SIZE - 24, y)),
    });
    const onEditorBubblePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        editorBubbleDragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: rect.left,
            originY: rect.top,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onEditorBubblePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = editorBubbleDragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        setEditorBubblePos(clampEditorBubble(drag.originX + dx, drag.originY + dy));
    };
    const onEditorBubblePointerUp = () => {
        const drag = editorBubbleDragRef.current;
        editorBubbleDragRef.current = null;
        if (drag && !drag.moved) {
            setEditorPanelOpen(open => !open);
            trackEvent('Toggle Bubble Workshop Floating Settings');
        }
    };

    // 预览不播放真实音频，只复刻真实语音条的 8 秒播放态，便于检查播放背景、按钮和波形颜色。
    const toggleVoicePreview = (key: string) => {
        setPlayingVoicePreviewKey(current => current === key ? null : key);
        setVoicePreviewProgress(0);
    };

    useEffect(() => {
        if (!playingVoicePreviewKey) {
            setVoicePreviewProgress(0);
            return;
        }
        const startedAt = Date.now();
        const tick = () => {
            const progress = Math.min(1, (Date.now() - startedAt) / VOICE_PREVIEW_DURATION_MS);
            setVoicePreviewProgress(progress);
            if (progress >= 1) setPlayingVoicePreviewKey(null);
        };
        tick();
        const timer = window.setInterval(tick, 80);
        return () => window.clearInterval(timer);
    }, [playingVoicePreviewKey]);

    useEffect(() => {
        if (cssValidation.isValid) {
            setLastUsableCss(editingTheme.customCss || '');
        }
    }, [cssValidation.isValid, editingTheme.customCss]);

    const updateTheme = (
        updater: (prev: ChatTheme) => ChatTheme,
        options?: { trackHistory?: boolean; markDirty?: boolean }
    ) => {
        const trackHistory = options?.trackHistory ?? true;
        const markDirty = options?.markDirty ?? true;
        setEditingTheme(prev => {
            const next = updater(prev);
            if (next === prev) return prev;
            if (trackHistory) {
                setUndoStack(history => [...history, cloneTheme(prev)]);
                setRedoStack([]);
            }
            if (markDirty) {
                setIsDirty(true);
                setIsAppliedToPreview(false);
            }
            return next;
        });
    };

    const withDiscardGuard = (action: () => void) => {
        if (!isDirty) { action(); return; }
        setPendingDiscardAction(() => action);
    };

    const requestTabSwitch = (target: 'user' | 'ai' | 'css') => {
        if (target === activeTab) return;
        setActiveTab(target);
        trackEvent('Switch Bubble Edit Target', { tab: target });
    };

    const requestToolSectionSwitch = (target: 'base' | 'sticker' | 'avatar') => {
        if (target === toolSection) return;
        setToolSection(target);
        trackEvent('Switch Editor Tool Section', { section: target });
    };

    const requestClose = () => withDiscardGuard(() => closeApp());

    const editSavedTheme = (theme: ChatTheme) => withDiscardGuard(() => {
        const copy = cloneTheme(theme);
        setEditingTheme(copy);
        setLastSavedTheme(cloneTheme(copy));
        setIsDirty(false);
        setIsAppliedToPreview(true);
        setUndoStack([]);
        setRedoStack([]);
        setPaddingVal(extractPaddingFromCss(copy.customCss || ''));
        addToast(`Now editing "${theme.name}"`, 'info');
    });

    // 导入别人分享的 .sully-bubble.json（exportSavedTheme 的逆操作，此前只有导出没有入口）。
    // 兼容两种形态：完整导出包 {kind:'sullyos-chat-theme', theme} 或直接一个 ChatTheme 对象。
    // 永远发新 id（防覆盖自己已有作品）；CSS 走与保存一致的可渲染性校验，坏 CSS 不入库。
    const importThemeFile = async (file: File) => {
        try {
            const parsed = JSON.parse(await file.text());
            const raw = (parsed && typeof parsed === 'object' && parsed.kind === 'sullyos-chat-theme') ? parsed.theme : parsed;
            if (!raw || typeof raw !== 'object' || !raw.user || !raw.ai) {
                addToast('Import failed: not a valid bubble theme file', 'error');
                return;
            }
            const css = typeof raw.customCss === 'string' ? raw.customCss : '';
            if (css) {
                const renderability = runCssRenderabilityCheck(css, validateCustomCss(css));
                if (!renderability.ok) {
                    addToast(`Import failed: ${renderability.message}`, 'error');
                    return;
                }
            }
            const baseName = String(raw.name || 'Imported Bubble').slice(0, 30);
            const name = customThemes.some(t => t.name === baseName) ? `${baseName} (Imported)` : baseName;
            const imported: ChatTheme = { ...raw, id: `custom-${Date.now()}-${Math.floor(Math.random() * 1e4)}`, type: 'custom', name };
            // 别人分享的文件里图是内嵌 base64，入库前顺手转成令牌：省掉 ~33% 的膨胀，
            // 内容一样的图还会跟库里已有的那份共用，不用等下次「优化资源存储」来收。
            imported.user = await bubbleStyleToBlobRefs(imported.user);
            imported.ai = await bubbleStyleToBlobRefs(imported.ai);
            addCustomTheme(imported);
            addToast(`Imported "${name}" — available in your saved themes`, 'success');
        } catch {
            addToast('Import failed: unable to parse file', 'error');
        }
    };

    // 导出成分享文件：主题里的图存的是令牌，令牌只有本机认得，原样导出对方只会拿到
    // 一串死字符串、图全空。所以先在一份深拷贝上把令牌换回内嵌的 data URL
    // （resolveBlobRefsDeep 是原地改的，绝不能拿库里那套主题去喂）。
    const exportSavedTheme = async (theme: ChatTheme) => {
        const portable = cloneTheme(theme);
        try {
            await resolveBlobRefsDeep(portable);
        } catch {
            addToast('Export failed: unable to read image', 'error');
            return;
        }

        try {
            const result = await shareOrDownloadFile({
                content: JSON.stringify({ kind: 'sullyos-chat-theme', version: 1, theme: portable }, null, 2),
                fileName: `${(theme.name || 'Custom Bubble').replace(/[\\/:*?\"<>|]/g, '_')}.sully-bubble.json`,
                mimeType: 'application/json;charset=utf-8',
                shareTitle: `Bubble Theme: ${theme.name || 'Custom Bubble'}`,
            });
            addToast(result === 'shared' ? `Share panel opened for "${theme.name}"` : `Exported "${theme.name}"`, 'success');
        } catch {
            addToast('Export failed: unable to share or download the file', 'error');
        }
    };

    // 删除只移除气泡库里的存档；若正在编辑这套气泡，工坊内容保留为未保存状态，避免用户手滑丢稿。
    const confirmDeleteTheme = () => {
        const theme = pendingDeleteTheme;
        if (!theme) return;
        setPendingDeleteTheme(null);
        removeCustomTheme(theme.id);
        if (editingTheme.id === theme.id) {
            setIsAppliedToPreview(false);
        }
        addToast(`Deleted "${theme.name}"`, 'success');
    };

    // Initialize padding state from CSS on load
    useEffect(() => {
        if (editingTheme.customCss) {
            setPaddingVal(extractPaddingFromCss(editingTheme.customCss));
        }
    }, []);

    const updateStyle = (key: keyof BubbleStyle, value: any) => {
        if (activeTab === 'css') return;
        updateTheme(prev => ({
            ...prev,
            [activeTab]: {
                ...prev[activeTab as 'user' | 'ai'],
                [key]: value
            },
            ...(userFollowAi && activeTab === 'ai'
                ? {
                    user: {
                        ...prev.user,
                        [key]: value
                    }
                }
                : {})
        }));
    };

    const updateVoiceBarStyle = (key: keyof BubbleStyle, value: any) => {
        updateTheme(prev => ({
            ...prev,
            ai: { ...prev.ai, [key]: value },
        }));
    };

    const updateAllCornerRadii = (value: number) => {
        if (activeTab === 'css') return;
        updateTheme(prev => ({
            ...prev,
            [activeTab]: {
                ...prev[activeTab],
                borderRadius: value,
                borderTopLeftRadius: undefined,
                borderTopRightRadius: undefined,
                borderBottomRightRadius: undefined,
                borderBottomLeftRadius: undefined,
            },
        }));
    };

    const updateColorWithAlpha = (newHex: string, newAlpha: number) => {
        const val = newAlpha === 1 ? newHex : toRgbaString(newHex, newAlpha);
        updateStyle('backgroundColor', val);
    };

    const updatePadding = (val: number) => {
        setPaddingVal(val);
        const newCss = injectPaddingCss(editingTheme.customCss || '', val);
        updateTheme(prev => ({ ...prev, customCss: newCss }));
    };

    const handleImageUpload = async (file: File, type: 'bg' | 'deco' | 'avatarDeco') => {
        try {
            const result = await processImage(file);
            // 主题里存的是令牌，不是几 MB 的 base64（二进制进 blob_assets，见 utils/blobRef.ts）
            const stored = await migrateDataUrlToRef(result);
            if (type === 'bg') updateStyle('backgroundImage', stored);
            else if (type === 'deco') updateStyle('decoration', stored);
            else if (type === 'avatarDeco') updateStyle('avatarDecoration', stored);
            addToast('Image uploaded successfully', 'success');
        } catch (e: any) {
            addToast(e.message, 'error');
        }
    };

    const handleUrlApply = (type: 'bg' | 'deco' | 'avatarDeco') => {
        const url = assetUrlDraft[type].trim();
        if (!url) {
            addToast('Please enter an image host URL', 'error');
            return;
        }
        if (!isValidHttpImageUrl(url)) {
            addToast('Invalid URL — please enter an http(s) image host address', 'error');
            return;
        }

        if (type === 'bg') updateStyle('backgroundImage', url);
        else if (type === 'deco') updateStyle('decoration', url);
        else updateStyle('avatarDecoration', url);

        setAssetUrlDraft(prev => ({ ...prev, [type]: '' }));
        addToast('Hosted image applied', 'success');
    };

    const doSaveTheme = (exitAfterSave: boolean) => {
        addCustomTheme(editingTheme);
        setLastSavedTheme(cloneTheme(editingTheme));
        setIsDirty(false);
        setIsAppliedToPreview(true);
        addToast('Saved to bubble library', 'success');
        if (exitAfterSave) { closeApp(); return; }
        // 保存 ≠ 生效：气泡要指派给角色才会在聊天里出现。保存完直接弹「应用到角色」，
        // 预勾选已经在用这套气泡的角色（再次保存同名主题时不打乱现状）。
        if (characters.length > 0) {
            setApplySelection(new Set(characters.filter(c => (c as any).bubbleStyle === editingTheme.id).map(c => c.id)));
            setShowApplySheet(true);
        }
    };

    const applyThemeToCharacters = () => {
        let applied = 0;
        let removed = 0;
        characters.forEach(c => {
            const usingThis = (c as any).bubbleStyle === editingTheme.id;
            if (applySelection.has(c.id) && !usingThis) {
                updateCharacter(c.id, { bubbleStyle: editingTheme.id } as any);
                applied += 1;
            } else if (!applySelection.has(c.id) && usingThis) {
                updateCharacter(c.id, { bubbleStyle: 'default' } as any);
                removed += 1;
            }
        });
        setShowApplySheet(false);
        if (applied || removed) {
            addToast(`Applied to ${applySelection.size} character(s)${removed ? `, ${removed} character(s) reverted to the default bubble` : ''}`, 'success');
        } else {
            addToast('No change to character bubbles', 'info');
        }
    };

    const saveTheme = ({ exitAfterSave }: { exitAfterSave: boolean }) => {
        if (!editingTheme.name.trim()) return;
        const renderability = runCssRenderabilityCheck(editingTheme.customCss || '', cssValidation);
        if (!renderability.ok) {
            addToast(renderability.message, 'error');
            return;
        }
        if (overallContrastScore.ratio < CONTRAST_CRITICAL_THRESHOLD) {
            setPendingSaveExit(exitAfterSave);
            setShowLowContrastConfirm(true);
            return;
        }
        doSaveTheme(exitAfterSave);
    };

    const insertCssSnippet = (snippet: CssSnippet) => {
        trackEvent('Insert Scoped CSS Snippet', { snippet: snippet.id });
        const textarea = cssTextareaRef.current;
        const currentCss = editingTheme.customCss || '';
        if (!textarea) {
            updateTheme(prev => ({ ...prev, customCss: `${currentCss}${currentCss.endsWith('\n') || !currentCss ? '' : '\n'}${snippet.code}\n` }));
            return;
        }

        const start = textarea.selectionStart ?? currentCss.length;
        const end = textarea.selectionEnd ?? currentCss.length;
        const insertContent = `${start === 0 ? '' : '\n'}${snippet.code}\n`;
        const nextCss = `${currentCss.slice(0, start)}${insertContent}${currentCss.slice(end)}`;
        updateTheme(prev => ({ ...prev, customCss: nextCss }));
        requestAnimationFrame(() => {
            const cursor = start + insertContent.length;
            textarea.focus();
            textarea.setSelectionRange(cursor, cursor);
        });
    };

    const restoreLastUsableCss = () => {
        if ((editingTheme.customCss || '') === lastUsableCss) {
            addToast('Already showing the last usable CSS', 'success');
            return;
        }
        updateTheme(prev => ({ ...prev, customCss: lastUsableCss }));
        addToast('Restored the last usable CSS', 'success');
    };

    const applyTemplate = (template: StyleTemplate) => {
        updateTheme(prev => ({
            ...prev,
            user: { ...prev.user, ...template.user },
            ai: { ...prev.ai, ...template.ai },
            customCss: injectShadowCss(prev.customCss || '', template.userShadow, template.aiShadow)
        }));
        addToast(`Applied the ${template.name} template`, 'success');
        trackEvent('Apply Bubble Style Template', { template: template.id });
    };

    const randomizeMonochrome = () => {
        const baseHue = Math.floor(Math.random() * 360);
        const hueShift = Math.floor(Math.random() * 18) - 9;
        const aiHue = (baseHue + hueShift + 360) % 360;
        const userBg = hslToHex(baseHue, 68, 48);
        const aiBg = hslToHex(aiHue, 54, 84);
        const userAlpha = 0.88;
        const aiAlpha = 0.85;
        const userText = '#f8fafc';
        const aiText = '#0f172a';
        updateTheme(prev => ({
            ...prev,
            user: {
                ...prev.user,
                backgroundColor: toRgbaString(userBg, userAlpha),
                textColor: userText,
                borderRadius: 20,
                backgroundImageOpacity: 0.4
            },
            ai: {
                ...prev.ai,
                backgroundColor: toRgbaString(aiBg, aiAlpha),
                textColor: aiText,
                borderRadius: 16,
                backgroundImageOpacity: 0.35
            }
        }));
        addToast('Monochrome color scheme generated', 'success');
    };

    const mirrorToOtherBubble = () => {
        if (activeTab === 'css') return;
        const sourceKey = activeTab;
        const targetKey = activeTab === 'user' ? 'ai' : 'user';
        updateTheme(prev => ({
            ...prev,
            [targetKey]: {
                ...prev[targetKey],
                ...prev[sourceKey]
            }
        }));
        addToast('Mirrored the current bubble settings', 'success');
    };

    const currentScene = useMemo(
        () => PREVIEW_SCENES.find(scene => scene.id === previewSceneId) || PREVIEW_SCENES[0],
        [previewSceneId]
    );

    const previewBgHex = useMemo(() => {
        if (currentScene.darkMode || isPreviewDark) return '#0f172a';
        return '#f1f5f9';
    }, [currentScene.darkMode, isPreviewDark]);

    const contrastScores = useMemo(() => {
        const userRatio = getContrastRatio(editingTheme.user.textColor, editingTheme.user.backgroundColor, previewBgHex);
        const aiRatio = getContrastRatio(editingTheme.ai.textColor, editingTheme.ai.backgroundColor, previewBgHex);
        return {
            user: { ratio: userRatio, grade: getContrastGrade(userRatio) },
            ai: { ratio: aiRatio, grade: getContrastGrade(aiRatio) }
        };
    }, [editingTheme.user.textColor, editingTheme.user.backgroundColor, editingTheme.ai.textColor, editingTheme.ai.backgroundColor, previewBgHex]);

    const overallContrastScore = useMemo(() => {
        return contrastScores.user.ratio <= contrastScores.ai.ratio
            ? { ...contrastScores.user, role: 'user' as const }
            : { ...contrastScores.ai, role: 'ai' as const };
    }, [contrastScores]);

    const activeContrastScore = activeTab === 'ai' ? contrastScores.ai : contrastScores.user;
    const showLowContrastWarning = activeTab !== 'css' && activeContrastScore.ratio < CONTRAST_LOW_THRESHOLD;
    const showCombinedRisk = activeTab !== 'css'
        && (activeStyle.backgroundImageOpacity ?? 0) >= HIGH_BG_IMAGE_OPACITY
        && activeContrastScore.ratio < CONTRAST_LOW_THRESHOLD;

    const oneClickFixContrast = () => {
        if (activeTab === 'css') return;
        const betterTextColor = getReadableTextColor(activeStyle.backgroundColor, previewBgHex);
        updateTheme(prev => ({
            ...prev,
            [activeTab]: {
                ...prev[activeTab],
                textColor: betterTextColor,
                backgroundImageOpacity: Math.min(prev[activeTab].backgroundImageOpacity ?? 0.5, 0.55)
            }
        }));
        addToast('Text contrast auto-optimized', 'success');
    };

    useEffect(() => {
        setIsPreviewDark(!!currentScene.darkMode);
    }, [currentScene.id]);

    const handleUndo = () => {
        if (undoStack.length === 0) return;
        const previous = undoStack[undoStack.length - 1];
        const nextUndo = undoStack.slice(0, -1);
        setUndoStack(nextUndo);
        setRedoStack(stack => [...stack, cloneTheme(editingTheme)]);
        setEditingTheme(cloneTheme(previous));
        setIsDirty(true);
        setIsAppliedToPreview(false);
    };

    const handleRedo = () => {
        if (redoStack.length === 0) return;
        const next = redoStack[redoStack.length - 1];
        const nextRedo = redoStack.slice(0, -1);
        setRedoStack(nextRedo);
        setUndoStack(stack => [...stack, cloneTheme(editingTheme)]);
        setEditingTheme(cloneTheme(next));
        setIsDirty(true);
        setIsAppliedToPreview(false);
    };

    const renderPreviewBubble = (mock: PreviewMockMessage, theme: ChatTheme, panel: 'A' | 'B', isLastInGroup: boolean) => {
        const role = mock.role;
        const style = role === 'user' ? theme.user : theme.ai;
        const isUser = role === 'user';
        const isVoice = mock.kind === 'voice';
        const isActive = panel === 'A' && (activeTab === role || activeTab === 'css');
        const voicePreviewKey = `${panel}:${mock.id}`;
        const isVoicePreviewPlaying = isVoice && playingVoicePreviewKey === voicePreviewKey;
        
        // Match core bubble corner/tail strategy in MessageItem.tsx.
        const corners = resolveBubbleCornerRadii(style);
        const hideTail = shouldHideBubbleTail(style.tailMode, isLastInGroup);
        const containerStyle = {
            backgroundColor: style.backgroundColor,
            opacity: style.opacity,
            borderTopLeftRadius: `${corners.topLeft}px`,
            borderTopRightRadius: `${corners.topRight}px`,
            borderBottomRightRadius: `${corners.bottomRight}px`,
            borderBottomLeftRadius: `${corners.bottomLeft}px`,
        };

        return (
            <div 
                className={`relative w-full flex items-end transition-all duration-300 cursor-pointer opacity-100 scale-100 ${isUser ? 'justify-end' : 'justify-start'}`}
                onClick={() => panel === 'A' && requestTabSwitch(role)}
                title={panel === 'A' ? `Click to edit the ${isUser ? 'user' : 'character'} bubble` : 'Last saved version'}
            >
                {/* Avatar + decoration: align with MessageItem layering */}
                <div className={`absolute bottom-0 ${isUser ? 'right-0' : 'left-0'} w-9 h-9 z-10`}>
                    <div className="w-full h-full rounded-full bg-slate-300 overflow-hidden relative z-0 shadow-sm ring-1 ring-black/5">
                         <div className="absolute inset-0 flex items-center justify-center text-white/50 font-bold text-[10px]">{isUser ? 'ME' : 'AI'}</div>
                    </div>
                    {style.avatarDecoration && (
                        <TokenImg
                            value={style.avatarDecoration}
                            className="absolute pointer-events-none z-10 max-w-none"
                            style={{
                                left: `${style.avatarDecorationX ?? 50}%`,
                                top: `${style.avatarDecorationY ?? 50}%`,
                                width: `${36 * (style.avatarDecorationScale ?? 1)}px`, 
                                height: 'auto',
                                transform: `translate(-50%, -50%) rotate(${style.avatarDecorationRotate ?? 0}deg)`,
                            }}
                        />
                    )}
                </div>

                <div className={`relative group max-w-[78%] ${isUser ? 'mr-12' : 'ml-12'}`}>
                    {style.decoration && (
                        <TokenImg
                            value={style.decoration}
                            className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                            style={{
                                left: `${style.decorationX ?? (isUser ? 90 : 10)}%`,
                                top: `${style.decorationY ?? -10}%`,
                                transform: `translate(-50%, -50%) scale(${style.decorationScale ?? 1}) rotate(${style.decorationRotate ?? 0}deg)`
                            }}
                        />
                    )}

                    <div
                        className={isVoice
                            ? `sully-voice-bar-shell relative py-1 text-sm overflow-visible ${isActive ? 'ring-2 ring-primary/70 rounded-2xl' : ''}`
                            : `relative px-5 py-3 shadow-sm border border-black/5 text-sm overflow-visible ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'} ${isLastInGroup ? 'sully-bubble-group-last' : ''} ${hideTail ? 'sully-bubble-tail-hidden' : 'sully-bubble-tail-visible'} ${isActive ? 'ring-2 ring-primary/70' : ''}`}
                        style={isVoice ? undefined : containerStyle}
                    >
                        {!isVoice && showPreviewBgImage && (
                            <BubbleBgLayer value={style.backgroundImage} opacity={style.backgroundImageOpacity} />
                        )}
                        {mock.replyTo && (
                            <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                                <span className="font-bold opacity-90 truncate">{mock.replyTo.name}</span>
                                <span className="truncate italic">"{mock.replyTo.content}"</span>
                            </div>
                        )}

                        {mock.kind === 'voice' ? (
                            <button
                                type="button"
                                className="sully-voice-bar relative z-10 flex min-w-[210px] items-center gap-2.5 overflow-hidden rounded-2xl border px-3 py-2 text-left transition-all duration-300 active:scale-[0.98]"
                                style={{
                                    background: isVoicePreviewPlaying
                                        ? (style.voiceBarActiveBg || 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(52,211,153,0.08))')
                                        : (style.voiceBarBg || 'linear-gradient(135deg, rgba(0,0,0,0.03), rgba(0,0,0,0.06))'),
                                    borderColor: isVoicePreviewPlaying
                                        ? (style.voiceBarBtnColor ? `${style.voiceBarBtnColor}33` : 'rgba(16,185,129,0.2)')
                                        : 'rgba(0,0,0,0.05)',
                                }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    toggleVoicePreview(voicePreviewKey);
                                    if (!isVoicePreviewPlaying) trackEvent('Play Bubble Workshop Voice Preview');
                                }}
                                aria-pressed={isVoicePreviewPlaying}
                                aria-label={isVoicePreviewPlaying ? 'Pause voice bar playback preview' : 'Play voice bar style preview'}
                            >
                                <span
                                    className="sully-voice-bar-button flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] transition-all duration-300"
                                    style={{
                                        color: isVoicePreviewPlaying ? '#fff' : (style.voiceBarBtnColor || '#64748b'),
                                        background: isVoicePreviewPlaying
                                            ? (style.voiceBarBtnColor || '#10b981')
                                            : (style.voiceBarBg ? 'rgba(255,255,255,.3)' : 'rgba(148,163,184,.18)'),
                                        boxShadow: isVoicePreviewPlaying
                                            ? `0 2px 8px ${style.voiceBarBtnColor ? `${style.voiceBarBtnColor}4D` : 'rgba(16,185,129,.3)'}`
                                            : 'none',
                                    }}
                                >{isVoicePreviewPlaying ? 'Ⅱ' : '▶'}</span>
                                <span className="sully-voice-bar-wave flex h-5 flex-1 items-center gap-[3px] overflow-hidden">
                                    {VOICE_PREVIEW_WAVE.map((height, index) => {
                                        const hasPlayed = index / VOICE_PREVIEW_WAVE.length <= voicePreviewProgress;
                                        return (
                                            <i
                                                key={index}
                                                className={`sully-voice-bar-wave-segment block w-[2.5px] rounded-full transition-all duration-150 ${isVoicePreviewPlaying ? 'animate-pulse' : ''}`}
                                                style={{
                                                    height: isVoicePreviewPlaying ? Math.max(3, height) : Math.max(2, height * 0.4),
                                                    background: isVoicePreviewPlaying && hasPlayed
                                                        ? (style.voiceBarWaveColor || '#10b981')
                                                        : (style.voiceBarWaveColor ? `${style.voiceBarWaveColor}66` : 'rgba(148,163,184,.55)'),
                                                    animationDelay: `${index * 60}ms`,
                                                }}
                                            />
                                        );
                                    })}
                                </span>
                                <span className="sully-voice-bar-toggle rounded-lg bg-black/5 px-1.5 py-0.5 text-[9px] font-medium" style={{ color: style.voiceBarTextColor || '#64748b' }}>To Text</span>
                            </button>
                        ) : mock.kind === 'image' ? (
                            <div className="relative z-10 w-40 h-28 rounded-xl bg-black/10 border border-black/10 flex items-center justify-center text-xs" style={{ color: style.textColor }}>
                                🖼️ Image placeholder
                            </div>
                        ) : mock.kind === 'emoji' ? (
                            <div className="relative z-10 text-3xl leading-none">{mock.content}</div>
                        ) : (
                            <div className="relative z-10 text-[15px] leading-relaxed whitespace-pre-wrap break-all" style={{ color: style.textColor }}>
                                {mock.content}
                            </div>
                        )}

                        {isActive && (
                            <div className="absolute -top-2.5 left-3 px-2 py-0.5 rounded-full bg-primary text-white text-[9px] font-bold tracking-wider z-20">
                                Editing {isUser ? 'User' : 'Character'}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const parsedBgColor = parseColorValue(activeStyle.backgroundColor);
    const visibleSavedThemes = useMemo(() => {
        const query = themeLibrarySearch.trim().toLowerCase();
        return query ? customThemes.filter(theme => (theme.name || '').toLowerCase().includes(query)) : customThemes;
    }, [customThemes, themeLibrarySearch]);

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light relative">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-white/40 shrink-0 z-20 sticky top-0" style={{ paddingTop: 'max(var(--safe-top, 0px), env(safe-area-inset-top, 0px))' }}>
            <div className="flex items-center px-4 py-3 justify-between">
                <div className="flex items-center gap-2">
                    <button onClick={requestClose} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="flex flex-col">
                        <h1 className="text-xl font-medium text-slate-700">Bubble Workshop</h1>
                        <div className="text-[10px] flex items-center gap-1.5 text-slate-500">
                            <span className={`inline-flex w-2 h-2 rounded-full ${isAppliedToPreview && !isDirty ? 'bg-emerald-500' : 'bg-amber-400'}`}></span>
                            {isAppliedToPreview && !isDirty ? 'Saved to bubble library' : 'You have unsaved changes'}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => saveTheme({ exitAfterSave: false })} className="px-4 py-1.5 bg-primary text-white rounded-full text-xs font-bold shadow-lg shadow-primary/30 active:scale-95 transition-all">
                        Save
                    </button>
                </div>
            </div>
            </div>

            {/* 用户作品区：保存后的气泡可回到工坊继续编辑，也可单独导出分享。 */}
            <section className="shrink-0 bg-white/80 border-b border-slate-100 px-4 py-3">
                <button type="button" onClick={() => { setIsThemeLibraryOpen(prev => !prev); if (!isThemeLibraryOpen) trackEvent('Expand My Bubble Library'); }} aria-expanded={isThemeLibraryOpen} className="w-full flex items-center justify-between text-left">
                    <div>
                        <h2 className="text-xs font-bold text-slate-600">My Custom Bubbles</h2>
                        <p className="text-[10px] text-slate-400 mt-0.5">Tap to {isThemeLibraryOpen ? 'collapse' : 'expand and select'} · search, import, edit or export</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400">{customThemes.length}</span>
                        <span className={`text-slate-400 transition-transform ${isThemeLibraryOpen ? 'rotate-180' : ''}`} aria-hidden>⌄</span>
                    </div>
                </button>
                {isThemeLibraryOpen && (
                    <div className="mt-2 flex justify-end">
                        <input
                            type="file"
                            ref={themeImportInputRef}
                            className="hidden"
                            accept=".json,application/json"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) importThemeFile(f); e.target.value = ''; }}
                        />
                        <button
                            onClick={() => themeImportInputRef.current?.click()}
                            className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-[11px] font-bold active:scale-95 transition-transform"
                        >
                            ⬆ Import Bubble File
                        </button>
                    </div>
                )}
                {isThemeLibraryOpen && (customThemes.length > 0 ? (
                    <div className="mt-3">
                        {customThemes.length > 6 && (
                            <input value={themeLibrarySearch} onChange={e => setThemeLibrarySearch(e.target.value)} placeholder="Search my bubbles…" className="w-full mb-2.5 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs outline-none focus:border-indigo-300" />
                        )}
                        <div className="grid grid-cols-2 gap-2 max-h-[42vh] overflow-y-auto no-scrollbar pb-1">
                        {visibleSavedThemes.map((theme: ChatTheme) => (
                            <div key={theme.id} className={`min-w-0 rounded-2xl border p-2.5 ${editingTheme.id === theme.id ? 'border-indigo-300 bg-indigo-50/70' : 'border-slate-200 bg-white'}`}>
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="flex -space-x-1 shrink-0">
                                        <span className="w-5 h-5 rounded-full border-2 border-white shadow-sm" style={{ background: theme.user?.backgroundColor || '#6366f1' }} />
                                        <span className="w-5 h-5 rounded-full border-2 border-white shadow-sm" style={{ background: theme.ai?.backgroundColor || '#fff' }} />
                                    </span>
                                    <span className="text-xs font-bold text-slate-700 truncate">{theme.name}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5 mt-2.5">
                                    <button onClick={() => editSavedTheme(theme)} className="py-1.5 rounded-xl bg-indigo-50 text-indigo-600 text-[11px] font-bold">Load</button>
                                    <button onClick={() => void exportSavedTheme(theme)} className="py-1.5 rounded-xl bg-slate-100 text-slate-600 text-[11px] font-bold">Export</button>
                                    <button onClick={() => setPendingDeleteTheme(theme)} className="py-1.5 rounded-xl bg-red-50 text-red-500 text-[11px] font-bold">Delete</button>
                                </div>
                            </div>
                        ))}
                        </div>
                        {visibleSavedThemes.length === 0 && <div className="py-4 text-center text-[10px] text-slate-400">No results for "{themeLibrarySearch.trim()}"</div>}
                    </div>
                ) : (
                    <div className="mt-3 rounded-2xl border border-dashed border-slate-200 px-3 py-2.5 text-[11px] text-slate-400">
                        No bubbles yet. Finish a design and save it — it'll show up here.
                    </div>
                ))}
            </section>

            {/* Preview Area (Realistic Chat Row) */}
            <div className={`${isPreviewFullscreen ? 'fixed inset-0 z-[120]' : 'flex-1 min-h-0'} relative overflow-y-auto flex flex-col p-4 pb-20 justify-start sm:justify-center items-center gap-4 no-scrollbar ${isPreviewDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
                <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
                {currentScene.wallpaper && (
                    <div className="absolute inset-0" style={{ background: currentScene.wallpaper, opacity: isPreviewDark ? 0.9 : 0.45 }} />
                )}
                
                {/* Live CSS Injection for Preview */}
                {editingTheme.customCss && <style>{editingTheme.customCss}</style>}
                <style>{`
                    .sully-bubble-tail-hidden::before,
                    .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
                `}</style>

                <div className="w-full max-w-sm relative z-10 bg-white/70 dark:bg-black/20 backdrop-blur-sm rounded-2xl p-3 border border-white/30 shadow-sm">
                    <div className={`absolute right-3 top-3 px-2.5 py-1 rounded-full text-[11px] font-bold shadow-sm ${overallContrastScore.grade === 'A' ? 'bg-emerald-100 text-emerald-700' : overallContrastScore.grade === 'B' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                        Readability {overallContrastScore.grade}
                    </div>
                    <div className="flex flex-wrap gap-2 mb-3">
                        {PREVIEW_SCENES.map(scene => (
                            <button
                                key={scene.id}
                                onClick={() => { setPreviewSceneId(scene.id); trackEvent('Switch Preview Scene', { scene: scene.id }); }}
                                className={`px-2.5 py-1 rounded-full text-[11px] transition-all ${previewSceneId === scene.id ? 'bg-primary text-white shadow' : 'bg-white/80 text-slate-500 hover:bg-white'}`}
                            >
                                {scene.name}
                            </button>
                        ))}
                    </div>

                    <div className="flex flex-wrap gap-3 text-[11px] text-slate-500 mb-2">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={showPreviewBgImage} onChange={(e) => setShowPreviewBgImage(e.target.checked)} className="accent-primary" />
                            Show background layer
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={isPreviewDark} onChange={(e) => setIsPreviewDark(e.target.checked)} className="accent-primary" />
                            Dark chat background
                        </label>
                    </div>

                    <div className="flex items-center justify-end">
                        <button
                            onClick={() => setIsPreviewFullscreen(prev => !prev)}
                            className="px-2.5 py-1 rounded-full text-[11px] bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                        >
                            {isPreviewFullscreen ? 'Exit Fullscreen Preview' : 'Fullscreen Preview'}
                        </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="text-slate-500">A/B Compare:</span>
                        <button onClick={() => setPreviewCompareMode('single')} className={`px-2 py-1 rounded-full ${previewCompareMode === 'single' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>Single Preview</button>
                        <button onClick={() => setPreviewCompareMode('split')} className={`px-2 py-1 rounded-full ${previewCompareMode === 'split' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>Split View</button>
                        <button onClick={() => setPreviewCompareMode('toggle')} className={`px-2 py-1 rounded-full ${previewCompareMode === 'toggle' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>Quick Toggle</button>
                        {previewCompareMode === 'toggle' && (
                            <div className="flex items-center gap-1">
                                <button onClick={() => setPreviewToggleTarget('A')} className={`px-2 py-1 rounded ${previewToggleTarget === 'A' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>A Currently Editing</button>
                                <button onClick={() => setPreviewToggleTarget('B')} className={`px-2 py-1 rounded ${previewToggleTarget === 'B' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>B Last Saved</button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Simulated Chat Conversation */}
                {previewCompareMode === 'split' ? (
                    <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-3 relative z-10">
                        {[{ label: 'A Currently Editing', theme: editingTheme, panel: 'A' as const }, { label: 'B Last Saved', theme: lastSavedTheme, panel: 'B' as const }].map(item => (
                            <div key={item.label} className={`space-y-4 p-4 rounded-2xl ${isPreviewDark ? 'bg-slate-950/60 border border-white/10' : 'bg-white/70 border border-white/60'}`}>
                                <div className="text-[10px] text-slate-500">{item.label}</div>
                                {currentScene.messages.map((msg, index) => {
                                    const next = currentScene.messages[index + 1];
                                    const isLastInGroup = !next || next.role !== msg.role;
                                    return <div key={`${item.panel}-${msg.id}`}>{renderPreviewBubble(msg, item.theme, item.panel, isLastInGroup)}</div>;
                                })}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className={`w-full max-w-sm space-y-4 p-4 rounded-2xl relative z-10 ${isPreviewDark ? 'bg-slate-950/60 border border-white/10' : 'bg-white/70 border border-white/60'}`}>
                        {currentScene.messages.map((msg, index) => {
                            const next = currentScene.messages[index + 1];
                            const isLastInGroup = !next || next.role !== msg.role;
                            return <div key={msg.id}>{renderPreviewBubble(msg, previewCompareMode === 'toggle' && previewToggleTarget === 'B' ? lastSavedTheme : editingTheme, previewCompareMode === 'toggle' && previewToggleTarget === 'B' ? 'B' : 'A', isLastInGroup)}</div>;
                        })}
                    </div>
                )}
                
                <div className={`text-[10px] absolute bottom-2 ${isPreviewDark ? 'text-slate-400' : 'text-slate-500'}`}>A is the current edit, B is the last saved version</div>
            </div>

            {/* 与外观 App 相同的悬浮设置钮：点按开关面板，拖动避开想观察的气泡。 */}
            {!isPreviewFullscreen && (
                <button
                    type="button"
                    onPointerDown={onEditorBubblePointerDown}
                    onPointerMove={onEditorBubblePointerMove}
                    onPointerUp={onEditorBubblePointerUp}
                    onPointerCancel={() => { editorBubbleDragRef.current = null; }}
                    className={`fixed z-[136] flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all active:scale-90 ${editorPanelOpen ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-white/95 text-primary ring-1 ring-primary/30 backdrop-blur'}`}
                    style={editorBubblePos
                        ? { left: editorBubblePos.x, top: editorBubblePos.y, touchAction: 'none' }
                        : { right: 12, top: 'calc(var(--safe-top, 0px) + 35vh)', touchAction: 'none' }}
                    aria-label={editorPanelOpen ? 'Collapse bubble editor panel' : 'Expand bubble editor panel'}
                    title="Tap to toggle settings · hold to drag"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6" aria-hidden="true">
                        <path strokeLinecap="round" d="M4 7h10M18 7h2M4 17h2M10 17h10M8 4v6M8 14v6M16 4v6M16 14v6" />
                    </svg>
                </button>
            )}

            {/* Editor Controls：悬浮在完整预览上方，不再挤占一半预览高度。 */}
            {!isPreviewFullscreen && editorPanelOpen && (
            <div
                className="fixed left-1/2 z-[135] flex w-[94%] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-[2rem] border border-white/70 bg-white/95 shadow-[0_14px_50px_rgba(15,23,42,0.24)] ring-1 ring-slate-100 backdrop-blur-xl"
                style={{
                    bottom: 'calc(14px + var(--safe-bottom, 0px))',
                    height: 'min(62vh, 620px)',
                    maxHeight: 'calc(100dvh - 96px - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
                }}
            >
                {/* Main Tabs (User / AI / CSS) */}
                <div className="flex items-center gap-3 px-5 pt-4 pb-2">
                    <div className="flex min-w-0 flex-1 gap-5 overflow-x-auto no-scrollbar">
                        <button onClick={() => requestTabSwitch('user')} className={`text-sm font-bold transition-colors whitespace-nowrap ${activeTab === 'user' ? 'text-slate-800' : 'text-slate-300'}`}>User Bubble</button>
                        <button onClick={() => requestTabSwitch('ai')} className={`text-sm font-bold transition-colors whitespace-nowrap ${activeTab === 'ai' ? 'text-slate-800' : 'text-slate-300'}`}>Character Bubble</button>
                        <button onClick={() => requestTabSwitch('css')} className={`text-sm font-bold transition-colors whitespace-nowrap flex items-center gap-1 ${activeTab === 'css' ? 'text-indigo-600' : 'text-slate-300'}`}>
                            <span>⚡</span> Custom CSS
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => setEditorPanelOpen(false)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg leading-none text-slate-400 transition active:scale-90"
                        aria-label="Collapse bubble editor panel"
                    >×</button>
                </div>

                <div className="px-8 pb-2 flex items-center gap-2">
                    <button onClick={handleUndo} disabled={undoStack.length === 0} className="text-[11px] px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 disabled:opacity-40">Undo</button>
                    <button onClick={handleRedo} disabled={redoStack.length === 0} className="text-[11px] px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 disabled:opacity-40">Redo</button>
                </div>

                {/* Conditional Sub-Tool Tabs */}
                {activeTab !== 'css' && (
                    <div className="flex px-6 border-b border-slate-100 mb-2 overflow-x-auto no-scrollbar">
                        <button onClick={() => requestToolSectionSwitch('base')} className={`px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all shrink-0 ${toolSection === 'base' ? 'border-primary text-primary' : 'border-transparent text-slate-400'}`}>Base Style</button>
                        <button onClick={() => requestToolSectionSwitch('sticker')} className={`px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all shrink-0 ${toolSection === 'sticker' ? 'border-primary text-primary' : 'border-transparent text-slate-400'}`}>Bubble Stickers</button>
                        <button onClick={() => requestToolSectionSwitch('avatar')} className={`px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all shrink-0 ${toolSection === 'avatar' ? 'border-primary text-primary' : 'border-transparent text-slate-400'}`}>Avatar Charm</button>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar pb-20">
                    
                    {/* --- CSS EDITOR --- */}
                    {activeTab === 'css' && (
                        <div className="space-y-6 animate-fade-in h-full flex flex-col">
                            <div className="text-[10px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-100 leading-relaxed space-y-2">
                                <span className="font-bold block mb-1 text-slate-500">CSS Enhanced Mode</span>
                                Use <code className="bg-slate-200 px-1 rounded">.sully-bubble-user</code> and <code className="bg-slate-200 px-1 rounded">.sully-bubble-ai</code> to customize bubbles, and <code className="bg-slate-200 px-1 rounded">.sully-voice-bar</code>, <code className="bg-slate-200 px-1 rounded">.sully-voice-bar-button</code>, <code className="bg-slate-200 px-1 rounded">.sully-voice-bar-wave-segment</code> to customize the voice bar separately.
                                <br/>For consecutive messages, use <code className="bg-slate-200 px-1 rounded">.sully-bubble-group-last</code> to target the last bubble in a group; the "tail position" setting in the base style also auto-hides the pseudo-element tail on middle bubbles.
                                <br/>You can use <code className="text-red-400">!important</code> to override the visual editor's settings.
                                <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-2.5 py-2 text-[10px] text-indigo-700">
                                    <div className="font-semibold">Priority: visual settings vs. CSS overrides</div>
                                    <div>1) The visual sliders/color panels generate the base style first; 2) custom CSS is applied after; 3) <code>!important</code> only force-applies to the properties it targets, overriding the visual setting for that same property.</div>
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                                    <div>
                                        <div className={`text-[10px] font-semibold ${cssValidation.isValid ? 'text-emerald-600' : 'text-rose-600'}`}>
                                            {cssValidation.isValid ? 'Syntax check passed' : 'Syntax check failed'}
                                        </div>
                                        <div className="text-[10px] text-slate-500">Detected <code className="text-red-500">!important</code> {cssValidation.importantCount} time(s)</div>
                                    </div>
                                    <button
                                        onClick={restoreLastUsableCss}
                                        disabled={(editingTheme.customCss || '') === lastUsableCss}
                                        className="text-[10px] px-2.5 py-1 rounded-full bg-slate-100 border border-slate-200 text-slate-600 disabled:opacity-50"
                                    >
                                        Reset to Last Usable CSS
                                    </button>
                                </div>
                            </div>

                            <textarea
                                ref={cssTextareaRef}
                                value={editingTheme.customCss || ''}
                                onChange={(e) => updateTheme(prev => ({ ...prev, customCss: e.target.value }))}
                                placeholder="/* Enter CSS code here */"
                                className="flex-1 w-full bg-slate-800 text-slate-300 font-mono text-xs p-4 rounded-xl resize-none shadow-inner focus:ring-2 focus:ring-indigo-500 outline-none leading-relaxed"
                                spellCheck={false}
                            />

                            {!cssValidation.isValid && (
                                <div className="text-[11px] rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                                    <div className="font-semibold mb-1">CSS Error (live)</div>
                                    <ul className="space-y-1 list-disc pl-4">
                                        {cssValidation.errors.map((error, idx) => (
                                            <li key={`${error}-${idx}`}>
                                                {cssValidation.errorLines[idx] ? `Line ${cssValidation.errorLines[idx]}: ` : ''}{error}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Scoped Snippet Inserter (bubble / voice bar)</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {CSS_SCOPE_SNIPPETS.map(snippet => (
                                        <button
                                            key={snippet.id}
                                            onClick={() => insertCssSnippet(snippet)}
                                            className="text-left p-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:border-indigo-300 hover:bg-indigo-50 transition-all"
                                        >
                                            <div className="text-xs font-semibold text-slate-700">{snippet.name}</div>
                                            <div className="text-[10px] text-slate-500 mt-1">{snippet.description}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Quick Templates</label>
                                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
                                    {CSS_EXAMPLES.map((ex, i) => (
                                        <button 
                                            key={i}
                                            onClick={() => updateTheme(prev => ({ ...prev, customCss: ex.code }))}
                                            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-mono text-slate-600 border border-slate-200 whitespace-nowrap transition-colors"
                                        >
                                            {ex.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* --- BASE STYLE TOOLS --- */}
                    {activeTab !== 'css' && toolSection === 'base' && (
                        <div className="space-y-6 animate-fade-in"> 
                            {/* Name Input (Only on Base) */}
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Theme Name</label>
                                <input value={editingTheme.name} onChange={(e) => updateTheme(prev => ({ ...prev, name: e.target.value }), { trackHistory: false })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:border-primary/50 transition-all outline-none" placeholder="My Custom Theme" />
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Style Template Cards</label>
                                    <button onClick={randomizeMonochrome} className="text-[10px] px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 hover:bg-indigo-100">Randomize (Monochrome)</button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    {STYLE_TEMPLATES.map(template => (
                                        <button
                                            key={template.id}
                                            onClick={() => applyTemplate(template)}
                                            className="text-left p-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:border-primary/30 hover:bg-primary/5 transition-all"
                                        >
                                            <div className="text-xs font-semibold text-slate-700">{template.name}</div>
                                            <div className="text-[10px] text-slate-500 mt-1">{template.description}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <div className="text-[10px] font-bold text-slate-400 uppercase mb-2">Quick Linking</div>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <label className="text-xs text-slate-600 flex items-center gap-2">
                                        <input type="checkbox" checked={userFollowAi} onChange={(e) => setUserFollowAi(e.target.checked)} className="accent-primary" />
                                        User bubble follows character bubble
                                    </label>
                                    <button onClick={mirrorToOtherBubble} className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-primary/30">Mirror settings to the other bubble</button>
                                </div>
                            </div>

                            <>
                                <div className={`rounded-xl border p-3 ${showLowContrastWarning ? 'border-amber-200 bg-amber-50/80' : 'border-emerald-200 bg-emerald-50/70'}`}>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <div className="text-[11px] font-semibold text-slate-700">Live readability score: {activeContrastScore.grade} ({activeContrastScore.ratio.toFixed(2)}:1)</div>
                                            <div className={`text-[10px] mt-1 ${showLowContrastWarning ? 'text-amber-700' : 'text-emerald-700'}`}>
                                                {showLowContrastWarning ? 'Text readability is low — consider increasing the contrast between text and background.' : 'Current text-to-background contrast is good.'}
                                            </div>
                                        </div>
                                        {showLowContrastWarning && (
                                            <button onClick={oneClickFixContrast} className="text-[10px] px-2.5 py-1 rounded-full bg-amber-500 text-white font-semibold hover:bg-amber-600 transition-colors">
                                                One-Click Fix
                                            </button>
                                        )}
                                    </div>
                                    {showCombinedRisk && (
                                        <div className="mt-2 text-[10px] text-rose-600 font-medium">
                                            Combined risk: background image opacity is high + contrast is low, which may be hard to read over busy wallpapers.
                                        </div>
                                    )}
                                </div>
                            </>

                            {/* Colors & Opacity */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="flex items-center justify-between mb-2"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Text Color</label><span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Recommended: Auto Contrast</span></div>
                                    <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-xl border border-slate-100"><input type="color" value={activeStyle.textColor} onChange={(e) => updateStyle('textColor', e.target.value)} className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent" /></div>
                                </div>
                                <div>
                                    <div className="flex items-center justify-between mb-2"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Bubble Color (Base)</label><span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Recommended: Monochrome</span></div>
                                    <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-xl border border-slate-100">
                                        <input 
                                            type="color" 
                                            value={parsedBgColor.hex} 
                                            onChange={(e) => updateColorWithAlpha(e.target.value, parsedBgColor.alpha)} 
                                            className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent" 
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Background Alpha (Transparency) */}
                            <div>
                                <div className="flex justify-between mb-2">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Background Alpha</label>
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Recommended: 85%</span>
                                </div>
                                <input 
                                    type="range" min="0" max="1" step="0.05" 
                                    value={parsedBgColor.alpha} 
                                    onChange={(e) => updateColorWithAlpha(parsedBgColor.hex, parseFloat(e.target.value))} 
                                    className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" 
                                />
                            </div>

                            {/* Padding (Compactness) */}
                            <div>
                                <div className="flex justify-between mb-2">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Bubble Size/Padding</label>
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Recommended: 12</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-400">Compact</span>
                                    <input
                                        type="range" min="4" max="24" step="1"
                                        value={paddingVal}
                                        onChange={(e) => updatePadding(parseInt(e.target.value))}
                                        className="flex-1 h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary"
                                    />
                                    <span className="text-[10px] text-slate-400">Spacious</span>
                                </div>
                            </div>

                            {/* Border Radius */}
                            <div className="space-y-3">
                                <div>
                                    <div className="flex justify-between mb-2"><label className="text-[10px] font-bold text-slate-400 uppercase">Adjust All Corners</label><span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{activeStyle.borderRadius}px</span></div>
                                    <input type="range" min="0" max="36" value={activeStyle.borderRadius} onChange={(e) => updateAllCornerRadii(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                                </div>
                                <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                    <summary className="cursor-pointer text-xs font-semibold text-slate-600">Adjust Corners Individually</summary>
                                    <div className="mt-3 grid grid-cols-2 gap-3">
                                        {([
                                            ['borderTopLeftRadius', 'Top Left'],
                                            ['borderTopRightRadius', 'Top Right'],
                                            ['borderBottomLeftRadius', 'Bottom Left'],
                                            ['borderBottomRightRadius', 'Bottom Right'],
                                        ] as const).map(([key, label]) => {
                                            const corners = resolveBubbleCornerRadii(activeStyle);
                                            const value = key === 'borderTopLeftRadius' ? corners.topLeft
                                                : key === 'borderTopRightRadius' ? corners.topRight
                                                : key === 'borderBottomLeftRadius' ? corners.bottomLeft
                                                : corners.bottomRight;
                                            return (
                                                <label key={key} className="rounded-lg bg-white p-2 text-[10px] text-slate-500">
                                                    <span className="mb-1 flex justify-between"><span>{label}</span><b>{value}px</b></span>
                                                    <input type="range" min="0" max="36" value={value} onChange={(e) => updateStyle(key, parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                                                </label>
                                            );
                                        })}
                                    </div>
                                    <button type="button" onClick={() => updateAllCornerRadii(activeStyle.borderRadius)} className="mt-3 w-full rounded-lg bg-white py-2 text-[10px] font-semibold text-slate-500">Reunify All Corners</button>
                                </details>
                                <div>
                                    <div className="mb-2 text-[10px] font-bold uppercase text-slate-400">Tail Position</div>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([
                                            ['last', 'Group end only'],
                                            ['every', 'Every message'],
                                            ['none', 'Hidden'],
                                        ] as const).map(([mode, label]) => {
                                            const selected = (activeStyle.tailMode || 'every') === mode;
                                            return <button key={mode} type="button" onClick={() => updateStyle('tailMode', mode)} className={`rounded-xl border py-2 text-[10px] font-semibold transition ${selected ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 bg-white text-slate-500'}`}>{label}</button>;
                                        })}
                                    </div>
                                    <p className="mt-1.5 text-[9px] leading-relaxed text-slate-400">Applies to the CSS tail drawn with ::before / ::after; "Group end only" is the iMessage-style behavior where only the last message in a run keeps its tail.</p>
                                </div>
                            </div>

                            {/* Background Image Logic */}
                            <div onClick={() => fileInputRef.current?.click()} className="cursor-pointer group relative h-24 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 overflow-hidden hover:border-primary/50 hover:text-primary transition-all">
                                {activeStyle.backgroundImage ? (
                                    <>
                                        <TokenImg value={activeStyle.backgroundImage} className="absolute inset-0 w-full h-full object-cover opacity-50" />
                                        <span className="relative z-10 text-[10px] bg-white/80 px-2 py-1 rounded shadow-sm font-bold">Change Texture</span>
                                    </>
                                ) : <span className="text-xs font-bold">+ Upload Texture Image</span>}
                                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleImageUpload(e.target.files[0], 'bg')} />
                                {activeStyle.backgroundImage && <button onClick={(e) => { e.stopPropagation(); updateStyle('backgroundImage', undefined); }} className="absolute top-2 right-2 text-[10px] bg-red-100 text-red-500 px-2 py-0.5 rounded-full z-20">Remove</button>}
                            </div>
                            <div className="flex gap-2">
                                <input
                                    type="url"
                                    value={assetUrlDraft.bg}
                                    onChange={(e) => setAssetUrlDraft(prev => ({ ...prev, bg: e.target.value }))}
                                    onClick={(e) => e.stopPropagation()}
                                    placeholder="Or paste an image host URL"
                                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button onClick={() => handleUrlApply('bg')} className="px-3 py-2 rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 hover:bg-slate-200">Apply</button>
                            </div>

                            {/* Background Image Opacity */}
                            {activeStyle.backgroundImage && (
                                <div>
                                    <div className="flex justify-between mb-2"><label className="text-[10px] font-bold text-slate-400 uppercase">Texture Opacity</label><span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Recommended: 35%~55%</span></div>
                                    <input type="range" min="0" max="1" step="0.05" value={activeStyle.backgroundImageOpacity ?? 0.5} onChange={(e) => updateStyle('backgroundImageOpacity', parseFloat(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                                </div>
                            )}
                            {/* Voice Bar Style */}
                            <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
                                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" /><path d="M5.5 9.643a.75.75 0 0 0-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.546A6.001 6.001 0 0 0 16 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-9 0v-.357Z" /></svg>
                                    Voice Bar Style
                                </h3>
                                <p className="mb-3 text-[9px] leading-relaxed text-slate-400">Voice messages only appear on the character side, so this always writes to the character bubble config; editing it from the "User Bubble" tab still takes effect for real. To change size, corner radius, or layout, use .sully-voice-bar under "Custom CSS".</p>
                                <div className="sully-bubble-ai mb-4 rounded-2xl bg-slate-50 p-2">
                                    <button
                                        type="button"
                                        className="sully-voice-bar flex w-full items-center gap-2.5 overflow-hidden rounded-2xl border px-3 py-2 text-left transition-all duration-300 active:scale-[0.98]"
                                        style={{
                                            background: playingVoicePreviewKey === 'editor-inline'
                                                ? (voiceBarStyle.voiceBarActiveBg || 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(52,211,153,0.08))')
                                                : (voiceBarStyle.voiceBarBg || 'linear-gradient(135deg, rgba(0,0,0,0.03), rgba(0,0,0,0.06))'),
                                            borderColor: playingVoicePreviewKey === 'editor-inline'
                                                ? (voiceBarStyle.voiceBarBtnColor ? `${voiceBarStyle.voiceBarBtnColor}33` : 'rgba(16,185,129,0.2)')
                                                : 'rgba(0,0,0,0.05)',
                                        }}
                                        onClick={() => toggleVoicePreview('editor-inline')}
                                        aria-pressed={playingVoicePreviewKey === 'editor-inline'}
                                    >
                                        <span
                                            className="sully-voice-bar-button flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-300"
                                            style={{
                                                color: playingVoicePreviewKey === 'editor-inline' ? '#fff' : (voiceBarStyle.voiceBarBtnColor || '#64748b'),
                                                background: playingVoicePreviewKey === 'editor-inline'
                                                    ? (voiceBarStyle.voiceBarBtnColor || '#10b981')
                                                    : 'rgba(255,255,255,.55)',
                                            }}
                                        >{playingVoicePreviewKey === 'editor-inline' ? 'Ⅱ' : '▶'}</span>
                                        <span className="sully-voice-bar-wave flex h-5 flex-1 items-center gap-[3px] overflow-hidden">
                                            {VOICE_PREVIEW_WAVE.map((height, index) => {
                                                const playing = playingVoicePreviewKey === 'editor-inline';
                                                const hasPlayed = index / VOICE_PREVIEW_WAVE.length <= voicePreviewProgress;
                                                return <i
                                                    key={index}
                                                    className={`sully-voice-bar-wave-segment block w-[2.5px] rounded-full transition-all duration-150 ${playing ? 'animate-pulse' : ''}`}
                                                    style={{
                                                        height: playing ? height : Math.max(2, height * 0.45),
                                                        background: playing && hasPlayed
                                                            ? (voiceBarStyle.voiceBarWaveColor || '#10b981')
                                                            : (voiceBarStyle.voiceBarWaveColor ? `${voiceBarStyle.voiceBarWaveColor}66` : '#94a3b8'),
                                                        animationDelay: `${index * 60}ms`,
                                                    }}
                                                />;
                                            })}
                                        </span>
                                        <span className="sully-voice-bar-toggle text-[9px]" style={{ color: voiceBarStyle.voiceBarTextColor || '#475569' }}>
                                            {playingVoicePreviewKey === 'editor-inline' ? 'Playing' : 'Play Preview'}
                                        </span>
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Background Color</label>
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={voiceBarStyle.voiceBarBg || '#f1f5f9'} onChange={(e) => updateVoiceBarStyle('voiceBarBg', e.target.value)} className="w-7 h-7 rounded-lg border-0 cursor-pointer" />
                                            <span className="text-[10px] text-slate-400 font-mono">{voiceBarStyle.voiceBarBg || 'Default'}</span>
                                            {voiceBarStyle.voiceBarBg && <button onClick={() => updateVoiceBarStyle('voiceBarBg', undefined)} className="text-[9px] text-red-400">Reset</button>}
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Background While Playing</label>
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={voiceBarStyle.voiceBarActiveBg || '#d1fae5'} onChange={(e) => updateVoiceBarStyle('voiceBarActiveBg', e.target.value)} className="w-7 h-7 rounded-lg border-0 cursor-pointer" />
                                            <span className="text-[10px] text-slate-400 font-mono">{voiceBarStyle.voiceBarActiveBg || 'Default'}</span>
                                            {voiceBarStyle.voiceBarActiveBg && <button onClick={() => updateVoiceBarStyle('voiceBarActiveBg', undefined)} className="text-[9px] text-red-400">Reset</button>}
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Button Color</label>
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={voiceBarStyle.voiceBarBtnColor || '#10b981'} onChange={(e) => updateVoiceBarStyle('voiceBarBtnColor', e.target.value)} className="w-7 h-7 rounded-lg border-0 cursor-pointer" />
                                            <span className="text-[10px] text-slate-400 font-mono">{voiceBarStyle.voiceBarBtnColor || 'Default'}</span>
                                            {voiceBarStyle.voiceBarBtnColor && <button onClick={() => updateVoiceBarStyle('voiceBarBtnColor', undefined)} className="text-[9px] text-red-400">Reset</button>}
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400 block mb-1">Waveform Color</label>
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={voiceBarStyle.voiceBarWaveColor || '#10b981'} onChange={(e) => updateVoiceBarStyle('voiceBarWaveColor', e.target.value)} className="w-7 h-7 rounded-lg border-0 cursor-pointer" />
                                            <span className="text-[10px] text-slate-400 font-mono">{voiceBarStyle.voiceBarWaveColor || 'Default'}</span>
                                            {voiceBarStyle.voiceBarWaveColor && <button onClick={() => updateVoiceBarStyle('voiceBarWaveColor', undefined)} className="text-[9px] text-red-400">Reset</button>}
                                        </div>
                                    </div>
                                    <div className="col-span-2">
                                        <label className="text-[10px] text-slate-400 block mb-1">Text Color</label>
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={voiceBarStyle.voiceBarTextColor || '#475569'} onChange={(e) => updateVoiceBarStyle('voiceBarTextColor', e.target.value)} className="w-7 h-7 rounded-lg border-0 cursor-pointer" />
                                            <span className="text-[10px] text-slate-400 font-mono">{voiceBarStyle.voiceBarTextColor || 'Default'}</span>
                                            {voiceBarStyle.voiceBarTextColor && <button onClick={() => updateVoiceBarStyle('voiceBarTextColor', undefined)} className="text-[9px] text-red-400">Reset</button>}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* --- STICKER TOOLS --- */}
                    {activeTab !== 'css' && toolSection === 'sticker' && (
                        <div className="space-y-6 animate-fade-in">
                            <div onClick={() => decorationInputRef.current?.click()} className="cursor-pointer group relative h-20 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-400 hover:border-primary/50 hover:text-primary transition-all">
                                 {activeStyle.decoration ? <TokenImg value={activeStyle.decoration} className="h-10 w-10 object-contain" /> : <span className="text-xs font-bold">+ Upload Bubble Badge/Sticker</span>}
                                 <input type="file" ref={decorationInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleImageUpload(e.target.files[0], 'deco')} />
                                 {activeStyle.decoration && <button onClick={(e) => { e.stopPropagation(); updateStyle('decoration', undefined); }} className="absolute top-2 right-2 text-[10px] bg-red-100 text-red-500 px-2 py-0.5 rounded-full">Remove</button>}
                            </div>
                            <div className="flex gap-2 -mt-4">
                                <input
                                    type="url"
                                    value={assetUrlDraft.deco}
                                    onChange={(e) => setAssetUrlDraft(prev => ({ ...prev, deco: e.target.value }))}
                                    placeholder="Or paste a sticker image host URL"
                                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button onClick={() => handleUrlApply('deco')} className="px-3 py-2 rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 hover:bg-slate-200">Apply</button>
                            </div>

                            {activeStyle.decoration && (
                                <details className="rounded-xl border border-slate-200 bg-slate-50 p-3" open={showAdvancedSettings}>
                                    <summary onClick={(e) => { e.preventDefault(); setShowAdvancedSettings(prev => !prev); }} className="text-xs font-semibold text-slate-600 cursor-pointer">Advanced Settings · Sticker position &amp; rotation</summary>
                                    {showAdvancedSettings && (
                                        <div className="grid grid-cols-2 gap-x-6 gap-y-6 pt-4">
                                            <div className="col-span-2"><label className="text-[10px] text-slate-400 uppercase block mb-2">Position (X / Y)</label>
                                                <div className="flex gap-3">
                                                    <input type="range" min="-50" max="150" value={activeStyle.decorationX ?? 90} onChange={(e) => updateStyle('decorationX', parseInt(e.target.value))} className="flex-1 h-1.5 bg-slate-200 rounded-full accent-primary" />
                                                    <input type="range" min="-50" max="150" value={activeStyle.decorationY ?? -10} onChange={(e) => updateStyle('decorationY', parseInt(e.target.value))} className="flex-1 h-1.5 bg-slate-200 rounded-full accent-primary" />
                                                </div>
                                            </div>
                                            <div><label className="text-[10px] text-slate-400 uppercase block mb-2">Scale ({activeStyle.decorationScale ?? 1}x)</label>
                                                <input type="range" min="0.2" max="3" step="0.1" value={activeStyle.decorationScale ?? 1} onChange={(e) => updateStyle('decorationScale', parseFloat(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full accent-primary" />
                                            </div>
                                            <div><label className="text-[10px] text-slate-400 uppercase block mb-2">Rotation ({activeStyle.decorationRotate ?? 0}°)</label>
                                                <input type="range" min="-180" max="180" value={activeStyle.decorationRotate ?? 0} onChange={(e) => updateStyle('decorationRotate', parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full accent-primary" />
                                            </div>
                                        </div>
                                    )}
                                </details>
                            )}
                        </div>
                    )}

                    {/* --- AVATAR TOOLS --- */}
                    {activeTab !== 'css' && toolSection === 'avatar' && (
                        <div className="space-y-6 animate-fade-in">
                            <div onClick={() => avatarDecoInputRef.current?.click()} className="cursor-pointer group relative h-20 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-400 hover:border-primary/50 hover:text-primary transition-all">
                                 {activeStyle.avatarDecoration ? <TokenImg value={activeStyle.avatarDecoration} className="h-10 w-10 object-contain" /> : <span className="text-xs font-bold">+ Upload Avatar Frame/Charm</span>}
                                 <input type="file" ref={avatarDecoInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleImageUpload(e.target.files[0], 'avatarDeco')} />
                                 {activeStyle.avatarDecoration && <button onClick={(e) => { e.stopPropagation(); updateStyle('avatarDecoration', undefined); }} className="absolute top-2 right-2 text-[10px] bg-red-100 text-red-500 px-2 py-0.5 rounded-full">Remove</button>}
                            </div>
                            <div className="flex gap-2 -mt-4">
                                <input
                                    type="url"
                                    value={assetUrlDraft.avatarDeco}
                                    onChange={(e) => setAssetUrlDraft(prev => ({ ...prev, avatarDeco: e.target.value }))}
                                    placeholder="Or paste a charm image host URL"
                                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                                <button onClick={() => handleUrlApply('avatarDeco')} className="px-3 py-2 rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 hover:bg-slate-200">Apply</button>
                            </div>

                            {activeStyle.avatarDecoration && (
                                <details className="rounded-xl border border-slate-200 bg-slate-50 p-3" open={showAdvancedSettings}>
                                    <summary onClick={(e) => { e.preventDefault(); setShowAdvancedSettings(prev => !prev); }} className="text-xs font-semibold text-slate-600 cursor-pointer">Advanced Settings · Charm offset &amp; rotation</summary>
                                    {showAdvancedSettings && (
                                        <div className="grid grid-cols-2 gap-x-6 gap-y-6 pt-4">
                                            <div className="col-span-2"><label className="text-[10px] text-slate-400 uppercase block mb-2">Center Offset (X / Y)</label>
                                                <div className="flex gap-3">
                                                    <input type="range" min="-50" max="150" value={activeStyle.avatarDecorationX ?? 50} onChange={(e) => updateStyle('avatarDecorationX', parseInt(e.target.value))} className="flex-1 h-1.5 bg-slate-200 rounded-full accent-primary" />
                                                    <input type="range" min="-50" max="150" value={activeStyle.avatarDecorationY ?? 50} onChange={(e) => updateStyle('avatarDecorationY', parseInt(e.target.value))} className="flex-1 h-1.5 bg-slate-200 rounded-full accent-primary" />
                                                </div>
                                            </div>
                                            <div><label className="text-[10px] text-slate-400 uppercase block mb-2">Scale ({activeStyle.avatarDecorationScale ?? 1}x)</label>
                                                <input type="range" min="0.5" max="3" step="0.1" value={activeStyle.avatarDecorationScale ?? 1} onChange={(e) => updateStyle('avatarDecorationScale', parseFloat(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full accent-primary" />
                                            </div>
                                            <div><label className="text-[10px] text-slate-400 uppercase block mb-2">Rotation ({activeStyle.avatarDecorationRotate ?? 0}°)</label>
                                                <input type="range" min="-180" max="180" value={activeStyle.avatarDecorationRotate ?? 0} onChange={(e) => updateStyle('avatarDecorationRotate', parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-full accent-primary" />
                                            </div>
                                        </div>
                                    )}
                                </details>
                            )}
                        </div>
                    )}

                </div>
            </div>
            )}

            {/* Discard unsaved changes confirm */}
            {pendingDiscardAction && (
                <div className="absolute inset-0 z-[999] bg-black/40 backdrop-blur-sm flex items-center justify-center px-6">
                    <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl">
                        <div className="text-base font-bold text-slate-700">Unsaved Changes</div>
                        <p className="mt-2 text-sm text-slate-500">Continuing will discard your current unsaved changes.</p>
                        <div className="mt-5 flex gap-3">
                            <button onClick={() => setPendingDiscardAction(null)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold">Cancel</button>
                            <button onClick={() => { const action = pendingDiscardAction; setPendingDiscardAction(null); action(); }} className="flex-1 py-2.5 rounded-2xl bg-red-500 text-white font-bold">Discard Changes</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete saved theme confirm */}
            {pendingDeleteTheme && (
                <div className="absolute inset-0 z-[999] bg-black/40 backdrop-blur-sm flex items-center justify-center px-6">
                    <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl">
                        <div className="text-base font-bold text-slate-700">Delete this bubble?</div>
                        <p className="mt-2 text-sm text-slate-500">"{pendingDeleteTheme.name}" will be removed from the bubble library, and any characters using it will fall back to the default bubble. This can't be undone — export a backup first if you want one.</p>
                        <div className="mt-5 flex gap-3">
                            <button onClick={() => setPendingDeleteTheme(null)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold">Cancel</button>
                            <button onClick={confirmDeleteTheme} className="flex-1 py-2.5 rounded-2xl bg-red-500 text-white font-bold">Delete</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Low contrast confirm */}
            {showLowContrastConfirm && (
                <div className="absolute inset-0 z-[999] bg-black/40 backdrop-blur-sm flex items-center justify-center px-6">
                    <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl">
                        <div className="text-base font-bold text-slate-700">Readability Score Very Low</div>
                        <p className="mt-2 text-sm text-slate-500">The contrast between the current text and background is too low and may make chat content hard to read. Save this style anyway?</p>
                        <div className="mt-5 flex gap-3">
                            <button onClick={() => setShowLowContrastConfirm(false)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold">Adjust More</button>
                            <button onClick={() => { setShowLowContrastConfirm(false); doSaveTheme(pendingSaveExit); }} className="flex-1 py-2.5 rounded-2xl bg-amber-500 text-white font-bold">Save Anyway</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 保存后的「应用到角色」弹层：保存只是进气泡库，指派给角色才会真正在聊天里生效 */}
            {showApplySheet && (
                <div className="absolute inset-0 z-[999] bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={() => setShowApplySheet(false)}>
                    <div
                        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[80%] flex flex-col"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="px-5 pt-5 pb-3 border-b border-slate-100 shrink-0">
                            <div className="text-base font-bold text-slate-700">✅ Saved to bubble library · Apply to whom?</div>
                            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                                Check a character and "{editingTheme.name}" will be used in their chats; uncheck to switch them back to the default bubble.
                                Tap "Select All" to apply it everywhere. You can also switch it anytime under <b>Chat → top bar session panel → Bubble Style</b>.
                            </p>
                            <p className="mt-1 text-[10px] text-slate-400 leading-relaxed">
                                A bubble theme overrides the visual settings in "Appearance → Chat Interface"; but a character's own hand-written "Whitebox" custom CSS takes priority when the two conflict.
                            </p>
                            <div className="mt-2.5 flex items-center gap-2">
                                <button
                                    onClick={() => setApplySelection(new Set(characters.map(c => c.id)))}
                                    className="text-[10px] px-2.5 py-1 rounded-lg bg-slate-100 text-slate-500 font-bold active:scale-95 transition"
                                >
                                    Select All
                                </button>
                                <button
                                    onClick={() => setApplySelection(new Set())}
                                    className="text-[10px] px-2.5 py-1 rounded-lg bg-slate-100 text-slate-500 font-bold active:scale-95 transition"
                                >
                                    Select None
                                </button>
                                <span className="text-[10px] text-slate-400 ml-auto">{applySelection.size}/{characters.length} selected</span>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-3 space-y-2">
                            {characters.map(c => {
                                const checked = applySelection.has(c.id);
                                const currentBubble = (c as any).bubbleStyle;
                                const usingThis = currentBubble === editingTheme.id;
                                return (
                                    <div
                                        key={c.id}
                                        onClick={() => setApplySelection(prev => {
                                            const next = new Set(prev);
                                            if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                            return next;
                                        })}
                                        className={`flex items-center gap-3 p-2.5 rounded-2xl border cursor-pointer transition-all ${checked ? 'bg-indigo-50/80 border-indigo-200' : 'bg-white border-slate-100'}`}
                                    >
                                        <TokenImg value={c.avatar} className="w-10 h-10 rounded-xl object-cover shrink-0" alt="" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[13px] font-bold text-slate-700 truncate">{c.name}</div>
                                            <div className="text-[10px] text-slate-400 truncate">
                                                {usingThis ? 'Currently using this bubble' : (currentBubble && currentBubble !== 'default' ? 'Using another bubble' : 'Default bubble')}
                                            </div>
                                        </div>
                                        <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${checked ? 'bg-indigo-500 border-indigo-500' : 'border-slate-300'}`}>
                                            {checked && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="px-5 py-4 border-t border-slate-100 flex gap-3 shrink-0" style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }}>
                            <button onClick={() => setShowApplySheet(false)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold text-sm">Maybe Later</button>
                            <button onClick={applyThemeToCharacters} className="flex-1 py-2.5 rounded-2xl bg-primary text-white font-bold text-sm shadow-lg shadow-primary/30">Apply</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ThemeMaker;
