import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../../context/OSContext';
import { CaretLeft, FileArrowUp, Trash, Warning } from '@phosphor-icons/react';
import { DB } from '../../utils/db';
import { CC_CATEGORIES, labelOfCategory } from '../../utils/creatorCategories';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from '../../utils/creatorPartsBlob';
import type { CustomCreatorPart } from '../../types';
import type { ParsedPsdPart } from '../../utils/psdCreatorImport';

/**
 * 用户侧「自定义素材工坊」——挂在手办柜（ChibiStudio）里，让正式站用户也能 PSD 批量导入
 * 自定义部件（dev 面板 CharCreatorDevApp 只在本地测试版可见，用户够不着）。
 * 部件存进 cc_custom_parts（Blob 令牌，省配额）；再进捏人器时经 loadCreatorPartsForRender 注入。
 */
const CreatorPartsUploader: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { addToast } = useOS();
    const [parts, setParts] = useState<CustomCreatorPart[]>([]);
    const [showRules, setShowRules] = useState(false);
    const [psdParsing, setPsdParsing] = useState(false);
    const [psdParts, setPsdParts] = useState<ParsedPsdPart[]>([]);
    const [psdWarnings, setPsdWarnings] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const psdRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        try { setParts(await loadCreatorPartsForRender()); } catch { /* ignore */ }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const onPsdFile = async (f: File | undefined) => {
        if (!f) return;
        setPsdParsing(true);
        setPsdParts([]); setPsdWarnings([]);
        try {
            const { parseCreatorPsd } = await import('../../utils/psdCreatorImport');
            const result = await parseCreatorPsd(await f.arrayBuffer());
            setPsdParts(result.parts);
            setPsdWarnings(result.warnings);
            if (!result.parts.length) addToast('No parts found — check the structure requirements in "Naming Rules"', 'error');
        } catch (err) {
            addToast('PSD parsing failed: ' + String((err as Error)?.message || err), 'error');
        } finally {
            setPsdParsing(false);
            if (psdRef.current) psdRef.current.value = '';
        }
    };

    const updatePsdPart = (idx: number, patch: Partial<ParsedPsdPart>) =>
        setPsdParts(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

    const savePsdParts = async () => {
        const ready = psdParts.filter(p => p.categoryKey);
        if (!ready.length) { addToast('Choose a category for every part first', 'error'); return; }
        if (ready.length < psdParts.length) { addToast('Some parts still have no category selected', 'error'); return; }
        setBusy(true);
        try {
            for (const p of ready) {
                const part: CustomCreatorPart = {
                    id: `${p.categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    categoryKey: p.categoryKey!,
                    name: p.name || `Custom ${labelOfCategory(p.categoryKey!)}`,
                    src: p.src,
                    tintable: p.tintable,
                    shadowSrc: p.shadowSrc,
                    createdAt: Date.now(),
                };
                await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
            }
            setPsdParts([]); setPsdWarnings([]);
            await load();
            addToast(`Added ${ready.length} part(s) — ready to use in the Character Creator`, 'success');
        } catch (e) {
            addToast('Save failed: ' + String((e as Error)?.message || e), 'error');
        } finally {
            setBusy(false);
        }
    };

    const removePart = async (id: string) => {
        try { await DB.deleteCustomCreatorPart(id); await load(); addToast('Deleted', 'success'); }
        catch (e) { addToast('Delete failed: ' + String((e as Error)?.message || e), 'error'); }
    };

    // 按类目分组展示已有部件
    const grouped: Record<string, CustomCreatorPart[]> = {};
    parts.forEach(p => { (grouped[p.categoryKey] = grouped[p.categoryKey] || []).push(p); });

    return (
        <div className="fixed inset-0 z-[65] flex flex-col" style={{ background: 'linear-gradient(180deg, #241b3f 0%, #171130 55%, #120d24 100%)' }}>
            {/* 顶栏：全屏浮层统一用 --chrome-top（安全区 + SullyOS 状态栏；状态栏隐藏时自动塌回 --safe-top），
                与 ChibiStudio / 彼方 ChibiEditor 同一套约定，避免怼进状态栏时钟/电量条 */}
            <div className="shrink-0 px-4 pb-3 flex items-center gap-2 text-white" style={{ paddingTop: 'var(--chrome-top)' }}>
                <button onClick={onClose} className="p-2 -ml-2 rounded-full text-indigo-100 active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                <div>
                    <h2 className="font-serif text-lg font-bold tracking-wide leading-tight">Custom Parts Workshop</h2>
                    <p className="text-[10px] tracking-[3px] text-indigo-300/60">CUSTOM PARTS</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 space-y-4" style={{ paddingBottom: 'calc(2rem + var(--safe-bottom))' }}>
                {/* PSD 导入卡 */}
                <div className="rounded-2xl p-3.5 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[13px] font-bold text-white flex items-center gap-1.5">
                        <FileArrowUp size={15} weight="bold" className="text-amber-300" />
                        Upload a PSD to bulk-add custom parts
                    </div>

                    <button onClick={() => setShowRules(v => !v)} className="text-[11px] font-bold text-amber-200/90 flex items-center gap-1 active:opacity-70">
                        {showRules ? '▾' : '▸'} How to prepare a PSD (naming rules)
                    </button>
                    {showRules && (
                        <div className="text-[10.5px] text-indigo-100/60 leading-relaxed space-y-2 rounded-xl bg-black/25 p-2.5 border border-white/10">
                            <div><b className="text-white/85">① Structure</b>: each top-level <b>layer group = one category</b>, and <b>each layer inside a group = one part</b>. Example: put "Almond Eyes" and "Round Eyes" as two layers in the <code>Eyes</code> group → two parts.</div>
                            <div>
                                <b className="text-white/85">② Group name = category</b> (Chinese or English both work):
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {CC_CATEGORIES.map(c => (
                                        <span key={c.key} className="px-1.5 py-0.5 rounded bg-white/8 text-white/75">{c.label}<span className="text-white/35"> / {c.key}</span></span>
                                    ))}
                                </div>
                            </div>
                            <div><b className="text-white/85">③ Layer name = part name</b>; recolor markers <code>#tint</code> / <code>#notint</code> (hair + eyes are recolorable by default).</div>
                            <div><b className="text-white/85">④ Show / Hide</b>: keep the layers you want imported <b>visible</b> — hidden layers are skipped; opacity should be full.</div>
                            <div><b className="text-white/85">⑤ Canvas</b> 472×472 square. If the category can't be auto-detected, no problem — pick it manually below.</div>
                        </div>
                    )}

                    <input ref={psdRef} type="file" accept=".psd" className="hidden" onChange={e => void onPsdFile(e.target.files?.[0])} />
                    <button onClick={() => psdRef.current?.click()} disabled={psdParsing || busy}
                        className="w-full rounded-xl border border-dashed border-white/30 py-3 text-[12px] text-indigo-100/70 active:bg-white/5 disabled:opacity-50">
                        {psdParsing ? 'Parsing…' : 'Choose .psd file'}
                    </button>

                    {psdWarnings.map((w, i) => (
                        <div key={i} className="text-[10px] text-amber-200/80 flex gap-1"><Warning size={12} className="shrink-0 mt-0.5" />{w}</div>
                    ))}

                    {psdParts.length > 0 && (
                        <div className="space-y-2">
                            {psdParts.map((p, idx) => (
                                <div key={idx} className="rounded-xl border border-white/10 p-2 flex gap-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                    <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden" style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 12px 12px' }}>
                                        <img src={p.src} alt={p.name} className="w-full h-full object-contain" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-1.5">
                                        <div className="flex gap-1.5">
                                            <select value={p.categoryKey || ''} onChange={e => updatePsdPart(idx, { categoryKey: e.target.value || null })}
                                                className={`text-[10.5px] rounded px-1.5 py-1 bg-white/10 outline-none ${p.categoryKey ? 'text-white' : 'text-red-300 border border-red-400/50'}`}>
                                                <option value="">Category?</option>
                                                {CC_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                                            </select>
                                            <input value={p.name} onChange={e => updatePsdPart(idx, { name: e.target.value })}
                                                className="flex-1 min-w-0 text-[10.5px] rounded px-1.5 py-1 bg-white/10 text-white outline-none" />
                                        </div>
                                        <div className="flex items-center gap-2.5 text-[10px] text-indigo-100/70">
                                            <label className="flex items-center gap-1">
                                                <input type="checkbox" checked={p.tintable} onChange={e => updatePsdPart(idx, { tintable: e.target.checked })} className="accent-amber-400 w-3 h-3" />
                                                Recolorable
                                            </label>
                                            <button onClick={() => setPsdParts(prev => prev.filter((_, i) => i !== idx))} className="ml-auto text-red-300/80 active:text-red-300">Remove</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => void savePsdParts()} disabled={busy}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                                {busy ? 'Saving…' : `Add All (${psdParts.length})`}
                            </button>
                        </div>
                    )}
                </div>

                {/* 已有自定义部件 */}
                <div className="space-y-2">
                    <div className="text-[12px] font-bold text-indigo-100/85 px-0.5">My Custom Parts{parts.length > 0 ? ` · ${parts.length}` : ''}</div>
                    {parts.length === 0 ? (
                        <p className="text-[11px] text-indigo-300/45 py-3 text-center">No custom parts yet. Try uploading a PSD~</p>
                    ) : (
                        Object.keys(grouped).map(key => (
                            <div key={key}>
                                <div className="text-[10.5px] font-bold text-indigo-300/70 mb-1.5">{labelOfCategory(key)} · {grouped[key].length}</div>
                                <div className="grid grid-cols-4 gap-2">
                                    {grouped[key].map(p => (
                                        <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10 aspect-square flex items-center justify-center"
                                            style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 14px 14px' }}>
                                            <img src={p.src} alt={p.name} className="max-h-full max-w-full object-contain" />
                                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-white/90 px-1 py-0.5 truncate">{p.name}{p.tintable ? ' ·tint' : ''}</span>
                                            <button onClick={() => void removePart(p.id)} className="absolute top-1 right-1 bg-red-500/90 rounded-full p-1 active:scale-90 text-white"><Trash size={10} weight="bold" /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                    <p className="text-[10px] text-indigo-300/45 leading-relaxed px-0.5 pt-1">
                        Custom parts will show up in the <b className="text-indigo-200/70">Character Creator</b> under the matching category (visible only to you). Re-open the Character Creator after adding/removing to see the changes.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default CreatorPartsUploader;
