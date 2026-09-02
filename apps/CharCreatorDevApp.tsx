import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, UploadSimple, Trash, Wrench, Warning, FileArrowUp, MoonStars } from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from '../utils/creatorPartsBlob';
import { buildBuiltinPartsPackZip, type BuiltinPackItem } from '../utils/builtinPartsPack';
import { trackEvent } from '../utils/analytics';
import type { CustomCreatorPart } from '../types';
import type { ParsedPsdPart } from '../utils/psdCreatorImport';
import { shareOrDownloadBlob } from '../utils/shareExport';

// 与捏人器 character_creator.html 里 PARTS 的 key 一一对应
const CC_CATEGORIES: { key: string; label: string; multi?: boolean }[] = [
    { key: 'skin', label: 'Skin' },
    { key: 'eyes', label: 'Eyes' },
    { key: 'mouth', label: 'Mouth' },
    { key: 'fronthair', label: 'Front Hair' },
    { key: 'earhair', label: 'Sideburns' },
    { key: 'back1', label: 'Back Hair 1' },
    { key: 'back2', label: 'Back Hair 2' },
    { key: 'outfit', label: 'Outfit' },
    { key: 'outer', label: 'Outerwear' },
    { key: 'facemark', label: 'Face Marks', multi: true },
    { key: 'decor', label: 'Accessories', multi: true },
];
const labelOf = (key: string) => CC_CATEGORIES.find(c => c.key === key)?.label || key;

const CharCreatorDevApp: React.FC = () => {
    const { closeApp, addToast } = useOS();
    const [parts, setParts] = useState<CustomCreatorPart[]>([]);
    const [categoryKey, setCategoryKey] = useState('fronthair');
    const [name, setName] = useState('');
    const [tintable, setTintable] = useState(false);
    const [src, setSrc] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    // PSD 整批导入
    const psdRef = useRef<HTMLInputElement>(null);
    const [psdParsing, setPsdParsing] = useState(false);
    const [psdParts, setPsdParts] = useState<ParsedPsdPart[]>([]);
    const [psdWarnings, setPsdWarnings] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true); // PSD 命名规则说明，默认展开给创作者看

    // 加载：解析成 base64 供 <img> 显示，并把存量 base64 惰性迁移成 Blob 令牌落库。
    const load = useCallback(async () => setParts(await loadCreatorPartsForRender()), []);
    useEffect(() => { void load(); }, [load]);

    const onFile = (f: File | undefined) => {
        if (!f) return;
        if (!/png|webp|image/.test(f.type)) { addToast?.('A transparent PNG is recommended', 'info'); }
        const reader = new FileReader();
        reader.onload = () => setSrc(String(reader.result || ''));
        reader.readAsDataURL(f);
    };

    const save = async () => {
        if (!src) { addToast?.('Select an image first', 'error'); return; }
        const part: CustomCreatorPart = {
            id: `${categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            categoryKey,
            name: name.trim() || `Custom ${labelOf(categoryKey)}`,
            src,
            tintable,
            createdAt: Date.now(),
        };
        // 落库前把 base64 src 转成 Blob 令牌（省配额）
        await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
        setName(''); setSrc(''); setTintable(false);
        if (fileRef.current) fileRef.current.value = '';
        await load();
        trackEvent('Add Single Part', { category: categoryKey });
        addToast?.(`Added to "${labelOf(categoryKey)}"`, 'success');
    };

    const remove = async (id: string) => {
        await DB.deleteCustomCreatorPart(id);
        await load();
        addToast?.('Deleted', 'success');
    };

    // 导出「内置素材包」ZIP（parts/*.png 二进制 + parts.json 清单）——供管理员把部件作为
    // 内置素材随包发给所有用户，而不是每台设备各存 base64 / 把 base64 塞进 HTML 撑大体积。
    const [exporting, setExporting] = useState(false);
    const downloadPack = async (items: BuiltinPackItem[], hint: string) => {
        if (!items.length) { addToast?.('No parts available to export', 'error'); return; }
        setExporting(true);
        try {
            const { blob, plan } = await buildBuiltinPartsPackZip(items);
            if (!plan.manifest.length) { addToast?.('No parts available to export (all missing a category)', 'error'); return; }
            const result = await shareOrDownloadBlob({
                blob,
                fileName: `creator_builtin_parts_${hint}_${Date.now()}.zip`,
                shareTitle: 'Character Creator Built-in Parts Pack',
            });
            if (result === 'cancelled') return;
            addToast?.(plan.skipped
                ? `Exported ${plan.manifest.length} built-in parts (skipped ${plan.skipped} missing a category)`
                : `Exported ${plan.manifest.length} built-in parts`, 'success');
            trackEvent('Export Built-in Parts Pack', { source: hint });
        } catch (e) {
            console.error('[CharCreatorDev] Export built-in parts pack failed', e);
            addToast?.('Export failed: ' + String((e as Error)?.message || e), 'error');
        } finally {
            setExporting(false);
        }
    };
    const toPackItem = (p: { categoryKey: string | null; name: string; src: string; shadowSrc?: string; tintable?: boolean }): BuiltinPackItem =>
        ({ categoryKey: p.categoryKey, name: p.name, src: p.src, shadowSrc: p.shadowSrc, tintable: p.tintable });

    const onPsdFile = async (f: File | undefined) => {
        if (!f) return;
        setPsdParsing(true);
        setPsdParts([]); setPsdWarnings([]);
        try {
            const { parseCreatorPsd } = await import('../utils/psdCreatorImport');
            const result = await parseCreatorPsd(await f.arrayBuffer());
            setPsdParts(result.parts);
            setPsdWarnings(result.warnings);
            if (!result.parts.length) addToast?.('No parts parsed, check the layer group structure', 'error');
        } catch (err) {
            console.error('[CharCreatorDev] PSD parsing failed', err);
            addToast?.('PSD parsing failed: ' + String((err as Error)?.message || err), 'error');
        } finally {
            setPsdParsing(false);
            if (psdRef.current) psdRef.current.value = '';
        }
    };

    const updatePsdPart = (idx: number, patch: Partial<ParsedPsdPart>) => {
        setPsdParts(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    };

    const savePsdParts = async () => {
        const ready = psdParts.filter(p => p.categoryKey);
        if (ready.length < psdParts.length) { addToast?.('Some parts still have no category selected', 'error'); return; }
        for (const p of ready) {
            const part: CustomCreatorPart = {
                id: `${p.categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                categoryKey: p.categoryKey!,
                name: p.name || `Custom ${labelOf(p.categoryKey!)}`,
                src: p.src,
                tintable: p.tintable,
                shadowSrc: p.shadowSrc,
                createdAt: Date.now(),
            };
            // PSD 批量导入：src / shadowSrc 的 base64 落库前转成 Blob 令牌
            await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
        }
        setPsdParts([]); setPsdWarnings([]);
        await load();
        trackEvent('Batch Add PSD Parts to Character Creator');
        addToast?.(`Added ${ready.length} parts in batch`, 'success');
    };

    const grouped = useMemo(() => {
        const m: Record<string, CustomCreatorPart[]> = {};
        for (const p of parts) (m[p.categoryKey] ||= []).push(p);
        return m;
    }, [parts]);

    return (
        <div className="h-full w-full flex flex-col text-white" style={{ background: 'linear-gradient(180deg,#1a1f2e 0%,#10131c 100%)' }}>
            <div className="flex items-center gap-2 px-4 pb-2 shrink-0" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <button onClick={closeApp} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><ArrowLeft size={22} weight="bold" /></button>
                <Wrench size={18} weight="fill" className="text-amber-300" />
                <span className="text-lg font-bold">Character Parts · Dev</span>
                <span className="ml-auto text-[10px] text-white/40">{parts.length} custom</span>
            </div>

            {/* CharCreatorDev 在 SELF_SAFE_AREA_APPS 名单里（外壳不兜底），底部自己让位 home 条 */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                {/* 提示 */}
                <div className="rounded-xl p-3 border border-amber-400/30 bg-amber-400/10 flex gap-2">
                    <Warning size={16} weight="fill" className="text-amber-300 mt-0.5 shrink-0" />
                    <div className="text-[10.5px] text-amber-100/90 leading-relaxed">
                        Parts must be <b>transparent-background PNGs</b> and <b>the same size and anchor point</b> as the character creator canvas (the whole image is layered by position), otherwise it'll be misaligned.
                        New parts are injected into the character creator in "Special Moments" and "Beyond" — takes effect <b>next time the character creator is opened</b>.
                    </div>
                </div>

                {/* PSD 整批导入 */}
                <div className="rounded-xl p-3 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[12px] font-bold text-white/90 flex items-center gap-1.5">
                        <FileArrowUp size={14} weight="bold" className="text-amber-300" />
                        PSD Batch Import
                    </div>
                    <button onClick={() => setShowRules(v => !v)}
                        className="text-[10.5px] font-bold text-amber-200/90 flex items-center gap-1 active:opacity-70">
                        {showRules ? '▾' : '▸'} PSD Naming Rules (for creators)
                    </button>
                    {showRules && (
                        <div className="text-[10px] text-white/55 leading-relaxed space-y-2 rounded-lg bg-black/25 p-2.5 border border-white/10">
                            <div>
                                <b className="text-white/85">① Structure</b>: each top-level <b>layer group = one category</b>, <b>each layer inside a group = one part</b>.<br />
                                Example: put <code>Almond Eyes</code> / <code>Round Eyes</code> / <code>Fox Eyes</code> each on one layer inside the <code>Eyes</code> group → splits into three eye parts.
                            </div>
                            <div>
                                <b className="text-white/85">② Group name = category</b> (any of the names below are recognized):
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {CC_CATEGORIES.map(c => (
                                        <span key={c.key} className="px-1.5 py-0.5 rounded bg-white/8 text-white/75">
                                            {c.label}<span className="text-white/35"> / {c.key}</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div><b className="text-white/85">③ Layer name = part display name</b>, name it however you like (Almond Eyes, Cloud Bangs…).</div>
                            <div><b className="text-white/85">④ Recoloring</b>: add <code>#tint</code> to a name to force it recolorable, <code>#notint</code> to force it not; if omitted, <b>the four hair categories + eyes default to recolorable</b>, everything else defaults to not.</div>
                            <div><b className="text-white/85">⑤ Show / Hide</b>: layers to import must <b>stay visible</b> (eye icon on); <b>hidden layers are skipped</b> — handy for hiding drafts/reference layers. Make sure layer opacity is at 100%.</div>
                            <div><b className="text-white/85">⑥ Canvas</b>: <b>472×472</b> square (oversized ones auto-scale down, just keep the anchor point/composition aligned).</div>
                            <div className="text-white/40">It's fine if the category isn't recognized — you can manually pick a category for each part after importing.</div>
                        </div>
                    )}
                    <input ref={psdRef} type="file" accept=".psd" className="hidden" onChange={e => void onPsdFile(e.target.files?.[0])} />
                    <button onClick={() => { trackEvent('Select PSD File for Batch Import'); psdRef.current?.click(); }} disabled={psdParsing}
                        className="w-full rounded-lg border border-dashed border-white/30 py-3 text-[11px] text-white/60 active:bg-white/5 disabled:opacity-50">
                        {psdParsing ? 'Parsing…' : 'Select .psd file'}
                    </button>
                    {psdWarnings.map((w, i) => (
                        <div key={i} className="text-[10px] text-amber-200/80 flex gap-1"><Warning size={12} className="shrink-0 mt-0.5" />{w}</div>
                    ))}
                    {psdParts.length > 0 && (
                        <div className="space-y-2">
                            {psdParts.map((p, idx) => (
                                <div key={idx} className="rounded-lg border border-white/10 p-2 flex gap-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                    <div className="w-16 h-16 shrink-0 relative rounded overflow-hidden"
                                        style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 12px 12px' }}>
                                        {p.shadowSrc && <img src={p.shadowSrc} alt="" className="absolute inset-0 w-full h-full object-contain" />}
                                        <img src={p.src} alt={p.name} className="absolute inset-0 w-full h-full object-contain" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-1">
                                        <div className="flex gap-1.5">
                                            <select value={p.categoryKey || ''} onChange={e => updatePsdPart(idx, { categoryKey: e.target.value || null })}
                                                className={`text-[10.5px] rounded px-1.5 py-1 bg-white/10 outline-none ${p.categoryKey ? 'text-white' : 'text-red-300 border border-red-400/50'}`}>
                                                <option value="">Category?</option>
                                                {CC_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                                            </select>
                                            <input value={p.name} onChange={e => updatePsdPart(idx, { name: e.target.value })}
                                                className="flex-1 min-w-0 text-[10.5px] rounded px-1.5 py-1 bg-white/10 text-white outline-none" />
                                        </div>
                                        <div className="flex items-center gap-2.5 text-[10px] text-white/70">
                                            <label className="flex items-center gap-1">
                                                <input type="checkbox" checked={p.tintable} onChange={e => updatePsdPart(idx, { tintable: e.target.checked })} className="accent-amber-400 w-3 h-3" />
                                                Recolorable
                                            </label>
                                            {p.shadowSrc && <span className="flex items-center gap-0.5 text-indigo-300"><MoonStars size={11} weight="fill" />Shadow</span>}
                                            <button onClick={() => setPsdParts(prev => prev.filter((_, i) => i !== idx))} className="ml-auto text-red-300/80 active:text-red-300">Remove</button>
                                        </div>
                                        {p.warnings.map((w, i) => <div key={i} className="text-[9.5px] text-amber-200/70">{w}</div>)}
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => void savePsdParts()}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                                Add All to Character Creator ({psdParts.length})
                            </button>
                            {/* 管理员：把这批 PSD 部件导出成「内置素材包」（PNG 文件 + 清单），可提交进仓库当全员内置 */}
                            <button onClick={() => void downloadPack(psdParts.map(toPackItem), 'psd')} disabled={exporting}
                                className="w-full rounded-xl py-2.5 text-[12.5px] font-bold text-white/90 border border-white/20 active:bg-white/5 disabled:opacity-50 flex items-center justify-center gap-1.5">
                                <FileArrowUp size={15} weight="bold" />{exporting ? 'Packing…' : 'Export as Built-in Parts Pack (PNG+Manifest)'}
                            </button>
                        </div>
                    )}
                </div>

                {/* 新增表单 */}
                <div className="rounded-xl p-3 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[12px] font-bold text-white/90">Add Part</div>
                    {/* 类目 */}
                    <div>
                        <div className="text-[10px] text-white/50 mb-1">Category</div>
                        <div className="flex flex-wrap gap-1.5">
                            {CC_CATEGORIES.map(c => (
                                <button key={c.key} onClick={() => setCategoryKey(c.key)}
                                    className={`text-[11px] rounded-full px-2.5 py-1 font-semibold ${categoryKey === c.key ? 'bg-amber-400 text-black' : 'bg-white/10 text-white/70'}`}>
                                    {c.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {/* 图片 */}
                    <input ref={fileRef} type="file" accept="image/png,image/webp,image/*" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-lg border border-dashed border-white/30 py-6 flex flex-col items-center justify-center gap-1 active:bg-white/5">
                        {src ? (
                            <img src={src} alt="" className="max-h-28 object-contain" style={{ background: 'repeating-conic-gradient(#0003 0% 25%, transparent 0% 50%) 50% / 16px 16px' }} />
                        ) : (
                            <><UploadSimple size={20} weight="bold" className="text-white/60" /><span className="text-[11px] text-white/50">Select part image (transparent PNG)</span></>
                        )}
                    </button>
                    {/* 名称 + tintable */}
                    <input value={name} onChange={e => setName(e.target.value)} placeholder={`Name (defaults to "Custom ${labelOf(categoryKey)}")`}
                        className="w-full rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white placeholder-white/40 outline-none" />
                    <label className="flex items-center gap-2 text-[12px] text-white/80">
                        <input type="checkbox" checked={tintable} onChange={e => setTintable(e.target.checked)} className="accent-amber-400 w-4 h-4" />
                        Recolorable (tintable) — only check this if the image is a monochrome line art / colorable layer
                    </label>
                    <button onClick={save} disabled={!src}
                        className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black disabled:opacity-40" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                        Add to Character Creator
                    </button>
                </div>

                {/* 已有列表 */}
                {parts.length > 0 && (
                    <button onClick={() => void downloadPack(parts.map(toPackItem), 'saved')} disabled={exporting}
                        className="w-full mb-2 rounded-xl py-2 text-[12px] font-bold text-white/90 border border-white/20 active:bg-white/5 disabled:opacity-50 flex items-center justify-center gap-1.5">
                        <FileArrowUp size={14} weight="bold" />{exporting ? 'Packing…' : `Export the ${parts.length} existing parts as a built-in parts pack`}
                    </button>
                )}
                {parts.length === 0 ? (
                    <p className="text-[11px] text-white/40 py-4 text-center">No custom parts yet.</p>
                ) : (
                    <div className="space-y-3">
                        {Object.keys(grouped).map(key => (
                            <div key={key}>
                                <div className="text-[11px] font-bold text-white/60 mb-1.5">{labelOf(key)} · {grouped[key].length}</div>
                                <div className="grid grid-cols-3 gap-2">
                                    {grouped[key].map(p => (
                                        <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10 aspect-square flex items-center justify-center"
                                            style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 14px 14px' }}>
                                            <img src={p.src} alt={p.name} className="max-h-full max-w-full object-contain" />
                                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[8.5px] text-white/90 px-1 py-0.5 truncate">{p.name}{p.tintable ? ' ·tint' : ''}{p.shadowSrc ? ' ·shadow' : ''}</span>
                                            <button onClick={() => remove(p.id)} className="absolute top-1 right-1 bg-red-500/90 rounded-full p-1 active:scale-90"><Trash size={11} weight="bold" /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CharCreatorDevApp;
