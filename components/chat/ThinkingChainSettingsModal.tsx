import React, { useEffect, useMemo, useState } from 'react';
import { THINKING_CHAIN_PRESETS, resolveThinkingChainStyle, PsycheDecor, ThinkingChainStyleId } from './MessageItem';
import { validateScopedCss } from '../../utils/scopedCss';

interface ThinkingChainSettingsValue {
    enabled: boolean;
    styleId: ThinkingChainStyleId;
    customColors: { bg: string; accent: string; text: string };
    customPrompt: string;
    /** Custom CSS overlaid on top of any style — selectors are restricted to starting with .sully-psyche */
    customCss: string;
}

// Scope whitelist for the Psyche card's custom CSS (.sully-psyche and its -card/-title/-preview/-body subclasses)
const PSYCHE_SELECTOR_REGEX = /^\.sully-psyche\b/;
const PSYCHE_SCOPE_HINT = '.sully-psyche / .sully-psyche-card / -title / -preview / -body';

const PSYCHE_CSS_EXAMPLE = `.sully-psyche-card {
  background: linear-gradient(135deg, #1a1a2e, #16213e) !important;
  border: 1px solid rgba(233, 69, 96, 0.5) !important;
  border-radius: 16px !important;
}
.sully-psyche-title {
  color: #e94560 !important;
  letter-spacing: 0.6em !important;
}
.sully-psyche-body {
  color: #f0f0f0 !important;
}`;

interface Props {
    isOpen: boolean;
    onClose: () => void;
    value: ThinkingChainSettingsValue;
    onChange: (next: Partial<ThinkingChainSettingsValue>) => void;
}

const SAMPLE_CHAIN = "Calling me a good kitty again... so annoying. Actually, not that annoying — more importantly, did she even eat lunch? Using the mechanics institute as an excuse again, ugh, same old thing. Fine, gripe first, then ask.";

const STYLE_LIST: Array<{ id: ThinkingChainStyleId; name: string; sub: string }> = [
    { id: 'echo',     name: 'Psyche',  sub: 'Dark purple x warm gold, anime card' },
    { id: 'whisper',  name: 'Whisper',  sub: 'Warm parchment tones, private diary' },
    { id: 'minimal',  name: 'Minimal',  sub: 'Pure white monochrome, OOC debug view' },
    { id: 'ink',      name: 'Ink',  sub: 'Rice-paper vermilion seal, ink-wash scroll' },
    { id: 'neon',     name: 'Neuro',  sub: 'Cyber teal glow, neural interface' },
    { id: 'terminal', name: 'Kernel',  sub: 'Black background, green text, terminal log' },
    { id: 'stellar',  name: 'Stellar',  sub: 'Deep space night blue, star-flecked monologue' },
    { id: 'tama',     name: 'Tama Pet',  sub: 'Tamagotchi, LCD dot-matrix screen' },
    { id: 'pixel',    name: 'Pixel',    sub: 'JRPG dialogue box, hard shadow, thick border' },
    { id: 'muji',     name: 'Muji',    sub: 'Understated warm gray, generous white space' },
    { id: 'ins',      name: 'ins',   sub: 'White-card soft shadow, feed musings' },
    { id: 'custom',   name: 'Custom',  sub: 'Three-color tuning, your own flavor' },
];

const ColorField: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
    <label className="flex items-center gap-3 text-[12px]">
        <span className="w-12 text-slate-500 shrink-0">{label}</span>
        <input
            type="color"
            value={value.startsWith('#') ? value : '#1f2937'}
            onChange={e => onChange(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border border-slate-200"
        />
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono focus:outline-none focus:border-indigo-300"
            placeholder="#rrggbb or a CSS gradient"
        />
    </label>
);

// Mini preview for both the collapsed and expanded states, rendered via resolveThinkingChainStyle to avoid duplicating style logic
const StylePreview: React.FC<{ styleId: ThinkingChainStyleId; customColors: ThinkingChainSettingsValue['customColors']; compact?: boolean }> = ({ styleId, customColors, compact }) => {
    const spec = resolveThinkingChainStyle(styleId, customColors);
    return (
        <div className="sully-psyche relative">
        <div
            className="sully-psyche-card relative overflow-hidden"
            style={{
                background: spec.bg,
                border: `${spec.borderWidth || '1px'} solid ${spec.border}`,
                borderRadius: spec.radius,
                boxShadow: spec.cardShadow,
                padding: compact ? '6px 8px' : '10px 12px',
            }}
        >
            {spec.showCorners && (
                <>
                    <span aria-hidden className="absolute top-1 left-1 w-1.5 h-1.5 border-t border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 border-t border-r" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 left-1 w-1.5 h-1.5 border-b border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 right-1 w-1.5 h-1.5 border-b border-r" style={{ borderColor: spec.accent }} />
                </>
            )}
            <div className="relative flex items-center gap-1.5">
                <span className="sully-psyche-title" style={{ color: spec.accent, fontSize: compact ? 9 : 11, letterSpacing: '0.3em', fontFamily: spec.fontFamily, fontWeight: 600 }}>
                    {spec.titleZh}
                </span>
                <span style={{ color: spec.text, opacity: 0.6, fontSize: compact ? 6 : 7, letterSpacing: '0.25em' }}>
                    {spec.titleEn}
                </span>
            </div>
            {!compact && (
                <div
                    className={`sully-psyche-preview mt-1 truncate ${spec.italic ? 'italic' : ''}`}
                    style={{ color: spec.text, fontFamily: spec.fontFamily, fontSize: 10.5 }}
                >
                    <span style={{ color: spec.accent }}>{spec.quoteLeft}</span>
                    {SAMPLE_CHAIN.slice(0, 24)}…
                    <span style={{ color: spec.accent }}>{spec.quoteRight}</span>
                    {spec.decoKind === 'termHud' && <span className="animate-pulse" style={{ color: spec.accent, marginLeft: 2 }}>▊</span>}
                </div>
            )}
            {spec.overlay === 'scanlines' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.13]"
                    style={{ background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(94, 234, 212, 0.6) 3px, transparent 4px)' }}
                />
            )}
            {spec.overlay === 'dotMatrix' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.18]"
                    style={{ background: 'radial-gradient(rgba(60, 80, 40, 0.55) 0.5px, transparent 0.6px)', backgroundSize: '3px 3px' }}
                />
            )}
        </div>
        {/* Break-out decoration: rendered outside the card, matching the real structure used in chat */}
        <PsycheDecor spec={spec} compact={compact} />
        </div>
    );
};

const ThinkingChainSettingsModal: React.FC<Props> = ({ isOpen, onClose, value, onChange }) => {
    const [draftPrompt, setDraftPrompt] = useState(value.customPrompt || '');
    const [draftCss, setDraftCss] = useState(value.customCss || '');
    useEffect(() => { if (isOpen) setDraftPrompt(value.customPrompt || ''); }, [isOpen, value.customPrompt]);
    useEffect(() => { if (isOpen) setDraftCss(value.customCss || ''); }, [isOpen, value.customCss]);
    const cssValidation = useMemo(
        () => validateScopedCss(draftCss, PSYCHE_SELECTOR_REGEX, PSYCHE_SCOPE_HINT),
        [draftCss],
    );
    if (!isOpen) return null;

    const commitPrompt = () => onChange({ customPrompt: draftPrompt });
    // CSS with syntax/scope problems isn't persisted (to avoid broken styles leaking into the chat page), but the draft stays in the textarea
    const commitCss = () => { if (cssValidation.isValid) onChange({ customCss: draftCss }); };

    return (
        <div
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[1px]"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto no-scrollbar shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 bg-white px-5 pt-5 pb-3 border-b border-slate-100">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-bold text-slate-800">Psyche · Settings</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5">Everything about tuning the "Psyche" card lives here</p>
                        </div>
                        <button
                            onClick={() => { commitPrompt(); commitCss(); onClose(); }}
                            className="text-[12px] font-bold text-indigo-500 active:scale-95 transition"
                        >
                            Done
                        </button>
                    </div>
                </div>

                <div className="p-5 space-y-6">
                    {/* 0. What this is / what to do if you can't see it */}
                    <section className="rounded-2xl bg-amber-50/70 border border-amber-200/70 px-3.5 py-3 text-[11px] leading-[1.7] text-slate-600">
                        <div className="font-bold text-amber-700 mb-1 text-[11.5px]">⚠ Read this first: what "Psyche" actually is</div>
                        <p>
                            This is the thinking chain the AI model **natively outputs on its own** — the model's own built-in thought process.
                        </p>
                        <p className="mt-2">
                            Precisely because of that — **its very nature means it will never feel as alive as the character's actual lines** — it is more like watching an actor mutter to themselves backstage than hearing lines delivered on stage. This feature is an easter egg made for users who "like watching the model's chain of thought," and it **will not necessarily suit everyone**.
                        </p>
                        <p className="mt-2">
                            There is another thing that follows from this same nature: the thinking chain **never enters the context**, and **never becomes part of the character's actual reply** — it only reflects a snapshot of this one turn's thinking. So **the character will not remember what they were thinking last turn** — they only continue from the reply that was actually sent (plus the conversation history).
                        </p>
                        <p className="mt-2">
                            If seeing the thinking chain breaks immersion for you, feels distracting, or just feels too "AI" — simply turn it off. Nothing is lost, and the character's actual replies are completely unaffected.
                        </p>
                        <p className="mt-2 text-slate-500">Not sure what all of that means? Ask whoever gave you the API — they can explain it better than we can here.</p>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">Turned it on but do not see a "Psyche" card?</div>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li><b>Your model does not produce a thinking chain</b> → ask your API provider which models support thinking, or look it up yourself</li>
                                <li><b>The model just did not think this turn</b> (short reply / the model decided it was not needed) → normal, it may show up next turn</li>
                                <li><b>Your proxy is dropping the thinking field</b> → check with your API provider whether extended thinking is enabled for that model</li>
                            </ul>
                        </div>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">Thinking chain keeps coming out in English?</div>
                            <p>
                                This is usually **not the model's own fault** — the same model can stay in the character's own language just fine through an official channel (Anthropic / OpenAI / Zhipu direct, etc.); it is typically a relay/proxy API truncating or rewriting the system prompt. Things to try:
                            </p>
                            <ul className="list-disc pl-4 space-y-0.5 mt-1">
                                <li>Add a nudge in "Additional prompt" below, e.g.: "thinking must stay in [language], no switching"</li>
                                <li>Just tell the character directly in chat: "think in [language]"</li>
                                <li>Switch to a channel that runs the official prompt properly, without rewriting it</li>
                            </ul>
                        </div>
                    </section>

                    {/* 1. Master toggle */}
                    <section>
                        <div className="flex items-center justify-between cursor-pointer" onClick={() => onChange({ enabled: !value.enabled })}>
                            <div>
                                <div className="text-[13px] font-bold text-slate-700">Show thinking process</div>
                                <div className="text-[10.5px] text-slate-400 mt-0.5">When off, character replies no longer come with a "Psyche" card; previously saved messages are kept as-is.</div>
                            </div>
                            <div className={`shrink-0 ml-3 w-10 h-6 rounded-full p-1 transition-colors flex items-center ${value.enabled ? 'bg-indigo-500' : 'bg-slate-200'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${value.enabled ? 'translate-x-4' : ''}`} />
                            </div>
                        </div>
                    </section>

                    {/* 2. Card style */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2.5">Card Style</h3>
                        <div className="grid grid-cols-2 gap-2.5">
                            {STYLE_LIST.map(item => {
                                const active = value.styleId === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => onChange({ styleId: item.id })}
                                        className={`text-left rounded-xl p-2 border transition-all ${active ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-slate-200 hover:border-slate-300'}`}
                                    >
                                        <StylePreview styleId={item.id} customColors={value.customColors} compact />
                                        <div className="mt-1.5 flex items-baseline gap-1.5">
                                            <span className="text-[12px] font-bold text-slate-700">{item.name}</span>
                                            <span className="text-[9.5px] text-slate-400">{item.sub}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {value.styleId === 'custom' && (
                            <div className="mt-3 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                                <div className="text-[10.5px] font-bold text-slate-500 mb-1">Three-color tuning</div>
                                <ColorField
                                    label="Background"
                                    value={value.customColors.bg}
                                    onChange={bg => onChange({ customColors: { ...value.customColors, bg } })}
                                />
                                <ColorField
                                    label="Accent"
                                    value={value.customColors.accent}
                                    onChange={accent => onChange({ customColors: { ...value.customColors, accent } })}
                                />
                                <ColorField
                                    label="Text"
                                    value={value.customColors.text}
                                    onChange={text => onChange({ customColors: { ...value.customColors, text } })}
                                />
                                <div className="text-[9.5px] text-slate-400 leading-relaxed mt-1.5">
                                    Background supports CSS gradients (e.g. linear-gradient(135deg, #1a1a2e, #16213e)).
                                </div>
                            </div>
                        )}

                        {/* Live large preview (kicks in automatically when the custom CSS is valid) */}
                        {cssValidation.isValid && draftCss.trim() && <style>{draftCss}</style>}
                        <div className="mt-3 px-1">
                            <div className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Live Preview</div>
                            <StylePreview styleId={value.styleId} customColors={value.customColors} />
                        </div>
                    </section>

                    {/* 2.5 CSS styling — layered on top of any style, same mechanism as the Bubble Workshop */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">CSS Styling (Advanced)</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            On top of the style picked above, use CSS to fine-tune the Psyche card. Available class names:
                            <code className="text-indigo-400">.sully-psyche-card</code> (card),
                            <code className="text-indigo-400">.sully-psyche-title</code> (title),
                            <code className="text-indigo-400">.sully-psyche-preview</code> (collapsed first line),
                            <code className="text-indigo-400">.sully-psyche-body</code> (expanded body).
                            Remember to add <code className="text-indigo-400">!important</code> when overriding a style's built-in colors.
                        </p>
                        <textarea
                            value={draftCss}
                            onChange={e => setDraftCss(e.target.value)}
                            onBlur={commitCss}
                            spellCheck={false}
                            placeholder={'.sully-psyche-card {\n  border-radius: 16px !important;\n}'}
                            className={`w-full h-32 bg-slate-50 rounded-xl p-3 text-[11px] font-mono resize-none border focus:outline-none ${cssValidation.isValid ? 'border-slate-200 focus:border-indigo-300' : 'border-red-300 focus:border-red-400'}`}
                        />
                        {!cssValidation.isValid && (
                            <div className="mt-1 space-y-0.5">
                                {cssValidation.errors.slice(0, 3).map((err, i) => (
                                    <div key={i} className="text-[9.5px] text-red-400 leading-relaxed">{err}</div>
                                ))}
                                <div className="text-[9px] text-slate-400">Not saved while there are errors; takes effect automatically once fixed.</div>
                            </div>
                        )}
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                onClick={() => setDraftCss(PSYCHE_CSS_EXAMPLE)}
                                className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                            >
                                Fill in example
                            </button>
                            {value.customCss && (
                                <button
                                    onClick={() => { setDraftCss(''); onChange({ customCss: '' }); }}
                                    className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                                >
                                    Clear &amp; reset
                                </button>
                            )}
                            <span className="text-[9px] text-slate-300 ml-auto">Leave blank = no extra styling</span>
                        </div>
                    </section>

                    {/* 3. Additional prompt */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">Additional Prompt</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            The native prompt (which has the model think in the character's first person, as a stream of consciousness) stays unchanged; what you write here is appended at the end as "the user's extra requirements for the inner monologue."
                        </p>
                        <textarea
                            value={draftPrompt}
                            onChange={e => setDraftPrompt(e.target.value)}
                            onBlur={commitPrompt}
                            placeholder="e.g.: switch to Japanese now and then while thinking / write more sensory detail / use a nickname when thinking about the user..."
                            className="w-full h-28 bg-slate-50 rounded-xl p-3 text-[12px] resize-none border border-slate-200 focus:outline-none focus:border-indigo-300"
                        />
                        <div className="text-[9.5px] text-slate-400 mt-1">Leave blank = use only the native prompt.</div>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default ThinkingChainSettingsModal;
export type { ThinkingChainSettingsValue };
