import React, { useState } from 'react';
import { DateObservation, DateObserveConfig, DateObserveStyleId } from '../../types';
import { resolveObserveFields } from '../../utils/datePrompts';

/**
 * The "Observation Protocol OBSERVE" readout panel. Lays out char's current
 * time / location / status / detail for the user to see.
 *
 * Five visual styles (dateObserve.style, default hologram):
 *   hologram (default) · ink - hand-scroll ink wash · neon - cyber neon · crystal - crystal dreamscape · terminal - terminal readout
 * A field's display label can be customized via dateObserve.fields[key].label (does not affect parsing).
 *
 * variant:
 *   - 'hud'  : floats in the top-left corner in portrait mode, collapsible; the "expand" button in the
 *              top-right opens an independent full-screen view
 *   - 'card' : embedded above each reply's body text in reading (novel) mode
 */

interface ObserveHUDProps {
    observation: DateObservation;
    variant?: 'hud' | 'card';
    charName?: string;
    config?: DateObserveConfig;
}

// ── Style themes ─────────────────────────────────────────────────────────
// Each theme provides a set of class names/inline styles; rendering follows the same path,
// so adding a new style only requires a new entry here.

export interface ObserveStyleMeta {
    id: DateObserveStyleId;
    name: string;   // Name shown to the user in the settings panel
    desc: string;   // One-line description
    swatch: string; // Preview color swatch in the settings panel (CSS background)
}

export const OBSERVE_STYLES: ObserveStyleMeta[] = [
    { id: 'hologram', name: 'Hologram', desc: 'Default. Dark glass + cyan-violet trim + scanlines, chuunibyou hologram feel.', swatch: 'linear-gradient(135deg,#7dd3fc,#a78bfa 50%,#f472b6)' },
    { id: 'ink',      name: 'Ink Wash', desc: 'Warm rice-paper backdrop + ink strokes + a red seal, restrained and literary.', swatch: 'linear-gradient(135deg,#efe6d4,#cdbfa3 60%,#b04a3a)' },
    { id: 'neon',     name: 'Neon', desc: 'Near-black backdrop + strong magenta/cyan neon glow, cyber nightclub feel.', swatch: 'linear-gradient(135deg,#ff2bd6,#22d3ee)' },
    { id: 'crystal',  name: 'Crystal', desc: 'Soft pink-violet frosted glass, dreamy and light.', swatch: 'linear-gradient(135deg,#fbcfe8,#c4b5fd 60%,#a5f3fc)' },
    { id: 'terminal', name: 'Terminal', desc: 'Solid black with monospace green text, retro console readout.', swatch: 'linear-gradient(135deg,#022c22,#34d399)' },
];

interface Theme {
    container: React.CSSProperties;
    containerClass: string;
    fontClass: string;
    topLineClass: string | null;
    corners: boolean;
    scanline: boolean;
    pulse: boolean;             // whether the header status dot pulses (otherwise static)
    headerLabel: string;
    headerLabelClass: string;
    headerSubClass: string;
    headerBorderClass: string;
    dotClass: string;
    glyphClass: string;
    enClass: string;
    cnClass: string;
    valueClass: string;
    btnClass: string;
    cornerClasses: [string, string, string, string]; // tl tr bl br
}

const HOLO_BORDER: React.CSSProperties = {
    border: '1px solid transparent',
    backgroundImage:
        'linear-gradient(rgba(8,12,20,0.72),rgba(8,12,20,0.72)),linear-gradient(135deg,#7dd3fc55,#a78bfa66 45%,#f472b655)',
    backgroundOrigin: 'border-box',
    backgroundClip: 'padding-box, border-box',
    boxShadow: '0 0 18px rgba(125,211,252,0.10), inset 0 0 24px rgba(167,139,250,0.06)',
};

const THEMES: Record<DateObserveStyleId, Theme> = {
    hologram: {
        container: HOLO_BORDER,
        containerClass: 'rounded-xl',
        fontClass: '',
        topLineClass: 'bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent',
        corners: true, scanline: true, pulse: true,
        headerLabel: 'OBSERVE',
        headerLabelClass: 'text-cyan-100/90',
        headerSubClass: 'text-violet-200/40',
        headerBorderClass: 'border-white/5',
        dotClass: 'bg-cyan-300',
        glyphClass: 'text-cyan-300/90 drop-shadow-[0_0_4px_rgba(125,211,252,0.5)]',
        enClass: 'text-cyan-200/60',
        cnClass: 'text-violet-200/40',
        valueClass: 'text-slate-100/90',
        btnClass: 'text-cyan-200/70 hover:text-cyan-100 hover:bg-white/10',
        cornerClasses: ['border-cyan-300/60', 'border-fuchsia-300/50', 'border-violet-300/50', 'border-cyan-300/60'],
    },
    ink: {
        container: {
            background: 'linear-gradient(180deg,#f6efe1,#efe5d2)',
            border: '1px solid #cdbfa3',
            boxShadow: '0 6px 18px rgba(120,90,50,0.12), inset 0 0 0 1px rgba(255,255,255,0.4)',
        },
        containerClass: 'rounded-lg',
        fontClass: 'font-serif',
        topLineClass: null,
        corners: false, scanline: false, pulse: false,
        headerLabel: 'OBSERVE · RECORD',
        headerLabelClass: 'text-[#7a2e22] tracking-[0.3em]',
        headerSubClass: 'text-[#9c8a6a]',
        headerBorderClass: 'border-[#d8cab0]',
        dotClass: 'bg-[#b04a3a]',
        glyphClass: 'text-[#b04a3a]/80',
        enClass: 'text-[#a8946f]',
        cnClass: 'text-[#8a7553]',
        valueClass: 'text-[#3a3027]',
        btnClass: 'text-[#9c8a6a] hover:text-[#5a4a30] hover:bg-black/5',
        cornerClasses: ['border-[#b04a3a]/40', 'border-[#b04a3a]/40', 'border-[#b04a3a]/40', 'border-[#b04a3a]/40'],
    },
    neon: {
        container: {
            background: 'rgba(10,6,18,0.92)',
            border: '1.5px solid rgba(255,43,214,0.55)',
            boxShadow: '0 0 22px rgba(255,43,214,0.35), 0 0 8px rgba(34,211,238,0.4), inset 0 0 18px rgba(34,211,238,0.08)',
        },
        containerClass: 'rounded-lg',
        fontClass: 'font-mono',
        topLineClass: 'bg-gradient-to-r from-transparent via-fuchsia-400/70 to-transparent',
        corners: true, scanline: true, pulse: true,
        headerLabel: 'OBSERVE',
        headerLabelClass: 'text-fuchsia-300 [text-shadow:0_0_8px_rgba(255,43,214,0.8)]',
        headerSubClass: 'text-cyan-300/60',
        headerBorderClass: 'border-fuchsia-400/20',
        dotClass: 'bg-fuchsia-400',
        glyphClass: 'text-cyan-300 drop-shadow-[0_0_6px_rgba(34,211,238,0.9)]',
        enClass: 'text-fuchsia-300/80',
        cnClass: 'text-cyan-300/50',
        valueClass: 'text-cyan-50',
        btnClass: 'text-fuchsia-300/80 hover:text-fuchsia-200 hover:bg-fuchsia-500/15',
        cornerClasses: ['border-fuchsia-400/70', 'border-cyan-300/70', 'border-cyan-300/70', 'border-fuchsia-400/70'],
    },
    crystal: {
        container: {
            background: 'linear-gradient(135deg,rgba(255,255,255,0.22),rgba(244,214,255,0.16) 55%,rgba(199,231,255,0.18))',
            border: '1px solid rgba(255,255,255,0.5)',
            boxShadow: '0 8px 30px rgba(196,181,253,0.30), inset 0 1px 0 rgba(255,255,255,0.6)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
        },
        containerClass: 'rounded-2xl',
        fontClass: '',
        topLineClass: 'bg-gradient-to-r from-transparent via-white/70 to-transparent',
        corners: false, scanline: false, pulse: true,
        headerLabel: 'OBSERVE',
        headerLabelClass: 'text-fuchsia-50/90 tracking-[0.3em]',
        headerSubClass: 'text-white/50',
        headerBorderClass: 'border-white/25',
        dotClass: 'bg-fuchsia-200',
        glyphClass: 'text-fuchsia-100 drop-shadow-[0_0_6px_rgba(251,207,232,0.8)]',
        enClass: 'text-white/70',
        cnClass: 'text-white/45',
        valueClass: 'text-white drop-shadow-[0_1px_2px_rgba(120,80,160,0.4)]',
        btnClass: 'text-white/70 hover:text-white hover:bg-white/20',
        cornerClasses: ['border-white/60', 'border-white/60', 'border-white/60', 'border-white/60'],
    },
    terminal: {
        container: {
            background: '#02070a',
            border: '1px solid rgba(52,211,153,0.5)',
            boxShadow: '0 0 0 1px rgba(52,211,153,0.08), 0 6px 18px rgba(0,0,0,0.5)',
        },
        containerClass: 'rounded-sm',
        fontClass: 'font-mono',
        topLineClass: null,
        corners: false, scanline: false, pulse: false,
        headerLabel: 'OBSERVE://READOUT',
        headerLabelClass: 'text-emerald-400 tracking-[0.15em]',
        headerSubClass: 'text-emerald-600/70',
        headerBorderClass: 'border-emerald-500/20',
        dotClass: 'bg-emerald-400',
        glyphClass: 'text-emerald-500',
        enClass: 'text-emerald-500/70',
        cnClass: 'text-emerald-700/70',
        valueClass: 'text-emerald-300',
        btnClass: 'text-emerald-500/80 hover:text-emerald-300 hover:bg-emerald-500/10',
        cornerClasses: ['border-emerald-500/50', 'border-emerald-500/50', 'border-emerald-500/50', 'border-emerald-500/50'],
    },
};

const getTheme = (id?: DateObserveStyleId): Theme => THEMES[id || 'hologram'] || THEMES.hologram;

/** Merges default dimensions + custom dimensions, producing render rows in field order (keeps only rows with a value) */
const buildRows = (observation: DateObservation, config?: DateObserveConfig, charName = '') =>
    resolveObserveFields(config, charName)
        .map(f => ({
            key: f.key,
            glyph: f.glyph,
            en: f.en,
            cn: f.display,
            value: (f.isCustom
                ? (observation.extra?.[f.key] || '')
                : ((observation[f.key as keyof DateObservation] as string) || '')).trim(),
        }))
        .filter(r => r.value);

const CornerBrackets: React.FC<{ theme: Theme }> = ({ theme }) => (
    <>
        <span className={`absolute top-0 left-0 w-3 h-3 border-t border-l rounded-tl-sm ${theme.cornerClasses[0]}`} />
        <span className={`absolute top-0 right-0 w-3 h-3 border-t border-r rounded-tr-sm ${theme.cornerClasses[1]}`} />
        <span className={`absolute bottom-0 left-0 w-3 h-3 border-b border-l rounded-bl-sm ${theme.cornerClasses[2]}`} />
        <span className={`absolute bottom-0 right-0 w-3 h-3 border-b border-r rounded-br-sm ${theme.cornerClasses[3]}`} />
    </>
);

const ObserveRow: React.FC<{ theme: Theme; glyph: string; en: string; cn: string; value: string }> = ({ theme, glyph, en, cn, value }) => (
    <div className="flex items-start gap-2.5 py-1.5">
        <span className={`mt-0.5 text-sm leading-none w-4 text-center shrink-0 ${theme.glyphClass}`}>{glyph}</span>
        <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
                <span className={`text-[8px] font-bold tracking-[0.25em] ${theme.enClass}`}>{en}</span>
                <span className={`text-[9px] ${theme.cnClass}`}>{cn}</span>
            </div>
            <p className={`text-[12px] leading-snug tracking-wide whitespace-pre-wrap break-words ${theme.valueClass}`}>{value}</p>
        </div>
    </div>
);

const PanelHeader: React.FC<{ theme: Theme; charName?: string; right?: React.ReactNode }> = ({ theme, charName, right }) => (
    <div className={`flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b ${theme.headerBorderClass}`}>
        <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
                {theme.pulse && <span className={`absolute inline-flex h-full w-full rounded-full opacity-70 animate-ping ${theme.dotClass}`} />}
                <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${theme.dotClass}`} />
            </span>
            <span className={`text-[10px] font-bold tracking-[0.34em] ${theme.headerLabelClass}`}>{theme.headerLabel}</span>
            <span className={`text-[9px] tracking-[0.2em] truncate ${theme.headerSubClass}`}>Observation Protocol{charName ? ` · ${charName}` : ''}</span>
        </div>
        {right}
    </div>
);

const ObserveHUD: React.FC<ObserveHUDProps> = ({ observation, variant = 'hud', charName, config }) => {
    // Hooks must be called unconditionally, before any early return (React Rules of Hooks).
    const [collapsed, setCollapsed] = useState(false);
    const [expanded, setExpanded] = useState(false); // independent full-screen view

    const theme = getTheme(config?.style);
    const rows = buildRows(observation, config, charName);
    if (rows.length === 0) return null;

    const stop = (e: React.MouseEvent) => e.stopPropagation();

    const body = (dense: boolean) => (
        <div className={`${dense ? 'px-3 py-1' : 'px-4 py-2'} ${theme.fontClass}`}>
            {rows.map(r => (
                <ObserveRow key={r.key} theme={theme} glyph={r.glyph} en={r.en} cn={r.cn} value={r.value} />
            ))}
        </div>
    );

    // ── Inline card for reading mode ──
    if (variant === 'card') {
        return (
            <div onClick={stop} className={`relative overflow-hidden mb-3 animate-fade-in ${theme.containerClass} ${theme.fontClass}`} style={theme.container}>
                {theme.corners && <CornerBrackets theme={theme} />}
                {theme.topLineClass && <div className={`absolute inset-x-0 top-0 h-px ${theme.topLineClass}`} />}
                <PanelHeader theme={theme} charName={charName} />
                {body(false)}
            </div>
        );
    }

    // ── Floating HUD for portrait mode ──
    return (
        <>
            <div
                onClick={stop}
                className={`control-panel relative w-[208px] overflow-hidden animate-fade-in ${theme.containerClass}`}
                style={theme.container}
            >
                {theme.corners && <CornerBrackets theme={theme} />}
                {theme.topLineClass && <div className={`absolute inset-x-0 top-0 h-px ${theme.topLineClass}`} />}
                <PanelHeader
                    theme={theme}
                    charName={charName}
                    right={
                        <div className="flex items-center gap-1 shrink-0">
                            <button
                                onClick={() => setExpanded(true)}
                                aria-label="Expand view"
                                className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors active:scale-90 ${theme.btnClass}`}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M20.25 20.25v-4.5m0 4.5h-4.5m4.5 0L15 15M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75v4.5m0-4.5h-4.5m4.5 0L15 9" /></svg>
                            </button>
                            <button
                                onClick={() => setCollapsed(c => !c)}
                                aria-label={collapsed ? 'Expand' : 'Collapse'}
                                className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors active:scale-90 ${theme.btnClass}`}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-180'}`}><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                            </button>
                        </div>
                    }
                />
                {!collapsed && (
                    <>
                        {body(true)}
                        {theme.scanline && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-cyan-300/5 to-transparent" />}
                    </>
                )}
            </div>

            {/* Independent full-screen viewing space */}
            {expanded && (
                <div
                    onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                    className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm animate-fade-in"
                >
                    <div onClick={stop} className={`relative w-full max-w-sm overflow-hidden ${theme.containerClass} ${theme.fontClass}`} style={theme.container}>
                        {theme.corners && <CornerBrackets theme={theme} />}
                        {theme.topLineClass && <div className={`absolute inset-x-0 top-0 h-px ${theme.topLineClass}`} />}
                        <PanelHeader
                            theme={theme}
                            charName={charName}
                            right={
                                <button
                                    onClick={() => setExpanded(false)}
                                    aria-label="Close"
                                    className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors active:scale-90 ${theme.btnClass}`}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                </button>
                            }
                        />
                        <div className="px-5 py-3">
                            {rows.map(r => (
                                <div key={r.key} className={`py-2.5 border-b last:border-0 ${theme.headerBorderClass}`}>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`text-base leading-none ${theme.glyphClass}`}>{r.glyph}</span>
                                        <span className={`text-[9px] font-bold tracking-[0.3em] ${theme.enClass}`}>{r.en}</span>
                                        <span className={`text-[10px] ${theme.cnClass}`}>{r.cn}</span>
                                    </div>
                                    <p className={`text-[14px] leading-relaxed tracking-wide whitespace-pre-wrap break-words pl-6 ${theme.valueClass}`}>{r.value}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default ObserveHUD;
