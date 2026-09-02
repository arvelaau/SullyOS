import React, { useState, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, DateObservation, DateObserveConfig, DateObserveStyleId } from '../../types';
import { OBSERVE_DIMENSIONS } from '../../utils/datePrompts';
import ObserveHUD, { OBSERVE_STYLES } from './ObserveHUD';

/**
 * The "Observation Protocol OBSERVE" config block in Date settings (collapsed by default):
 *   - Master toggle
 *   - HUD style picker (hologram / ink wash / neon / crystal / terminal), with live preview
 *   - The four default dimensions (time/location/status/detail): enable toggle, HUD display label, generation hint
 *   - Add custom dimensions (up to 6): label + generation hint + enable + delete
 *   - One-click reset (style + all field customization + custom dimensions back to default)
 *
 * All changes are written back to char.dateObserve immediately, taking effect on the next reply / next render.
 */

interface ObserveSettingsProps {
    char: CharacterProfile;
}

// Sample observation for preview only (no request sent, pure style display)
const SAMPLE: DateObservation = {
    time: 'Just past six in the evening, the sky is starting to dim',
    place: 'On a plastic stool outside the convenience store',
    state: 'A little tired, but their eyes brighten a bit at the sight of you',
    detail: 'Fingertips tapping absently on the oden paper cup',
};

const MAX_CUSTOM = 6;
const genId = () => 'obs_' + Math.random().toString(36).slice(2, 9);

type FieldDraft = Record<string, { label: string; hint: string }>;

const buildFieldDraft = (char: CharacterProfile): FieldDraft => {
    const f = char.dateObserve?.fields || {};
    const d: FieldDraft = {};
    for (const dim of OBSERVE_DIMENSIONS) d[dim.key] = { label: f[dim.key]?.label || '', hint: f[dim.key]?.hint || '' };
    return d;
};
const buildCustomDraft = (char: CharacterProfile): FieldDraft => {
    const d: FieldDraft = {};
    for (const c of char.dateObserve?.custom || []) d[c.id] = { label: c.label || '', hint: c.hint || '' };
    return d;
};

const ObserveSettings: React.FC<ObserveSettingsProps> = ({ char }) => {
    const { updateCharacter, addToast } = useOS();
    const enabled = !!char.dateObserve?.enabled;
    const style = char.dateObserve?.style || 'hologram';
    const fields = char.dateObserve?.fields || {};
    const customs = char.dateObserve?.custom || [];

    const [open, setOpen] = useState(false); // collapsed by default
    const [draft, setDraft] = useState<FieldDraft>(() => buildFieldDraft(char));
    const [customDraft, setCustomDraft] = useState<FieldDraft>(() => buildCustomDraft(char));
    useEffect(() => { setDraft(buildFieldDraft(char)); setCustomDraft(buildCustomDraft(char)); }, [char.id]);

    const patchObserve = (patch: Partial<DateObserveConfig>) =>
        updateCharacter(char.id, { dateObserve: { ...char.dateObserve, ...patch } });

    // —— Default dimensions ——
    const patchField = (key: keyof DateObservation, partial: Record<string, unknown>) =>
        patchObserve({ fields: { ...fields, [key]: { ...(fields[key] || {}), ...partial } } });
    const commitField = (key: keyof DateObservation, which: 'label' | 'hint') => {
        const v = (draft[key]?.[which] || '').trim();
        if (v === (fields[key]?.[which] || '')) return;
        patchField(key, { [which]: v || undefined });
    };

    // —— Custom dimensions ——
    const addCustom = () => {
        if (customs.length >= MAX_CUSTOM) { addToast(`Up to ${MAX_CUSTOM} custom dimensions`, 'info'); return; }
        const id = genId();
        patchObserve({ custom: [...customs, { id, label: '', hint: '', enabled: true }] });
        setCustomDraft(d => ({ ...d, [id]: { label: '', hint: '' } }));
    };
    const delCustom = (id: string) => patchObserve({ custom: customs.filter(c => c.id !== id) });
    const toggleCustom = (id: string, on: boolean) => patchObserve({ custom: customs.map(c => c.id === id ? { ...c, enabled: on } : c) });
    const commitCustom = (id: string, which: 'label' | 'hint') => {
        const cur = customs.find(c => c.id === id);
        if (!cur) return;
        const v = (customDraft[id]?.[which] || '').trim();
        if (v === (cur[which] || '')) return;
        patchObserve({ custom: customs.map(c => c.id === id ? { ...c, [which]: which === 'label' ? v : (v || undefined) } : c) });
    };

    const resetAll = () => {
        updateCharacter(char.id, { dateObserve: { enabled: char.dateObserve?.enabled, style: undefined, fields: undefined, custom: undefined } });
        setDraft(buildFieldDraft({ ...char, dateObserve: { enabled } }));
        setCustomDraft({});
        addToast('Observation style and prompts reset to default', 'success');
    };

    // Preview: the default four dimensions use sample copy, custom dimensions get placeholder content,
    // so the style preview also shows the added slots
    const previewObs: DateObservation = {
        ...SAMPLE,
        extra: Object.fromEntries(
            customs.filter(c => c.enabled !== false && (c.label || '').trim()).map(c => [c.id, 'Generated content shown here']),
        ),
    };

    return (
        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 min-w-0 text-left active:opacity-70">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3.5 h-3.5 text-slate-300 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
                    <div className="min-w-0">
                        <h3 className="text-xs font-bold text-slate-400 uppercase">Observation Protocol · OBSERVE</h3>
                        <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed truncate">Attaches {char.name}'s current status to every reply, rendered as an independently viewable observation panel. {enabled ? 'Currently on.' : 'Currently off.'}</p>
                    </div>
                </button>
                <button
                    onClick={() => patchObserve({ enabled: !enabled })}
                    className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${enabled ? 'bg-primary' : 'bg-slate-200'}`}
                >
                    <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                </button>
            </div>

            {open && (
                !enabled ? (
                    <p className="px-4 pb-4 -mt-1 text-[11px] text-slate-400">Turn on the switch in the top-right first, then you can pick the panel style, customize what each slot generates, and add observation dimensions.</p>
                ) : (
                <div className="px-4 pb-4 space-y-4">
                    {/* ── Style picker ── */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <h4 className="text-[11px] font-bold text-slate-500">Panel Style</h4>
                            <button onClick={resetAll} className="text-[10px] font-bold text-primary/80 hover:text-primary px-2 py-0.5 rounded-full bg-primary/5 active:scale-95 transition-transform">Reset</button>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5">
                            {OBSERVE_STYLES.map(s => (
                                <button
                                    key={s.id}
                                    onClick={() => patchObserve({ style: s.id as DateObserveStyleId })}
                                    title={s.desc}
                                    className={`flex flex-col items-center gap-1 py-2 rounded-xl border transition-all active:scale-95 ${style === s.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-slate-200 hover:border-slate-300'}`}
                                >
                                    <span className="w-7 h-7 rounded-lg shadow-inner" style={{ background: s.swatch }} />
                                    <span className={`text-[10px] font-bold ${style === s.id ? 'text-primary' : 'text-slate-500'}`}>{s.name}</span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">{OBSERVE_STYLES.find(s => s.id === style)?.desc}</p>
                    </div>

                    {/* ── Live preview ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-2">Preview</h4>
                        <div className="rounded-xl p-4 flex justify-center" style={{ background: style === 'ink' ? '#e9e0cd' : 'radial-gradient(circle at 30% 20%, #1e2433, #0a0d16)' }}>
                            <div className="w-full max-w-[260px]">
                                <ObserveHUD observation={previewObs} variant="card" charName={char.name} config={char.dateObserve} />
                            </div>
                        </div>
                    </div>

                    {/* ── Per-dimension prompt & label customization ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-1">What Each Slot Generates (Custom Prompts)</h4>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">"Display label" only changes the wording on the panel; "generation hint" decides what the AI writes for that slot. Leave blank to use the default. Disabled dimensions won't be generated or shown on the panel.</p>
                        <div className="space-y-2.5">
                            {OBSERVE_DIMENSIONS.map(dim => {
                                const on = fields[dim.key]?.enabled !== false;
                                const defHint = dim.hint.replace(/\{name\}/g, char.name);
                                return (
                                    <div key={dim.key} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5"><span className="text-slate-400">{dim.glyph}</span>{dim.label}</span>
                                            <button
                                                onClick={() => patchField(dim.key, { enabled: !on })}
                                                className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-primary' : 'bg-slate-300'}`}
                                            >
                                                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}></div>
                                            </button>
                                        </div>
                                        {on && (
                                            <div className="space-y-1.5">
                                                <input
                                                    value={draft[dim.key]?.label || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], label: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'label')}
                                                    placeholder={`Display label (default "${dim.label}")`}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white"
                                                />
                                                <textarea
                                                    value={draft[dim.key]?.hint || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], hint: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'hint')}
                                                    placeholder={`Generation hint (default: ${defHint})`}
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white leading-relaxed resize-none"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Add custom dimensions ── */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <h4 className="text-[11px] font-bold text-slate-500">Additional Dimensions</h4>
                            <button
                                onClick={addCustom}
                                disabled={customs.length >= MAX_CUSTOM}
                                className="text-[10px] font-bold text-primary px-2.5 py-1 rounded-full bg-primary/5 hover:bg-primary/10 disabled:opacity-40 active:scale-95 transition-all"
                            >+ Add ({customs.length}/{MAX_CUSTOM})</button>
                        </div>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">Open your own observation slots beyond the four default dimensions (e.g. "Outfit", "Weather", "Distance from you"). The label is used for both AI output and panel display.</p>
                        {customs.length === 0 ? (
                            <div className="text-[11px] text-slate-300 text-center py-3 border border-dashed border-slate-200 rounded-xl">No custom dimensions yet, tap "+ Add" to open one</div>
                        ) : (
                            <div className="space-y-2.5">
                                {customs.map(c => {
                                    const on = c.enabled !== false;
                                    return (
                                        <div key={c.id} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <input
                                                    value={customDraft[c.id]?.label || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], label: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'label')}
                                                    placeholder="Dimension name (e.g. Outfit / Weather)"
                                                    className="flex-1 min-w-0 text-[12px] font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white"
                                                />
                                                <button
                                                    onClick={() => toggleCustom(c.id, !on)}
                                                    className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-primary' : 'bg-slate-300'}`}
                                                >
                                                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}></div>
                                                </button>
                                                <button onClick={() => delCustom(c.id)} title="Delete" className="text-slate-300 hover:text-red-400 transition-colors shrink-0 p-0.5">
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                            {on && (
                                                <textarea
                                                    value={customDraft[c.id]?.hint || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], hint: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'hint')}
                                                    placeholder="Generation hint: what the AI writes for this slot (leave blank for a generic default)"
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white leading-relaxed resize-none"
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                )
            )}
        </section>
    );
};

export default ObserveSettings;
