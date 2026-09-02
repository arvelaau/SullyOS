import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, DownloadSimple, LockSimple, UploadSimple, UserCircle } from '@phosphor-icons/react';
import TokenImg from '../../os/TokenImg';
import type { CharacterProfile, StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset, UserProfile } from '../../../types';
import { dedupeTheaterWorldbooks, downloadStoryPreset, estimateStoryTokens, getPresetPromptStats, resolveStoryPresetDocument, resolveStoryTheaterMask } from '../../../utils/storyTheater';

interface Props {
    initial: StoryTheaterEntry;
    characters: CharacterProfile[];
    user: UserProfile;
    masks: StoryTheaterMask[];
    maskLocked: boolean;
    presets: StoryTheaterPreset[];
    onCancel: () => void;
    onSave: (entry: StoryTheaterEntry) => Promise<void> | void;
    onImportPreset: (file: File) => Promise<StoryTheaterPreset | null>;
    onEditPreset: (preset: StoryTheaterPreset, draft: StoryTheaterEntry) => void;
    onOpenMaskBox: (draft: StoryTheaterEntry) => void;
}

const localDateTime = (timestamp = Date.now()): string => {
    const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
};

const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void; label?: string }> = ({ value, onChange, label }) => <button type='button' aria-label={label} aria-pressed={value} onClick={() => onChange(!value)} className={`w-11 h-6 shrink-0 rounded-full p-1 transition-colors ${value ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} /></button>;

const StoryTheaterEditor: React.FC<Props> = ({ initial, characters, user, masks, maskLocked, presets, onCancel, onSave, onImportPreset, onEditPreset, onOpenMaskBox }) => {
    const [draft, setDraft] = useState<StoryTheaterEntry>({ ...initial });
    const [saving, setSaving] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const actors = useMemo(() => characters.filter(char => draft.characterIds.includes(char.id)), [characters, draft.characterIds]);
    const resolvedMask = useMemo(() => resolveStoryTheaterMask(draft.mask, user, characters, masks), [characters, draft.mask, masks, user]);
    const memoryParticipants = useMemo(() => {
        const participantIds = new Set(draft.characterIds);
        if (draft.mask?.type === 'character') participantIds.add(draft.mask.id);
        return characters.filter(char => participantIds.has(char.id));
    }, [characters, draft.characterIds, draft.mask]);
    const books = useMemo(() => dedupeTheaterWorldbooks(actors), [actors]);
    const preset = presets.find(item => item.id === draft.presetId) || presets[0] || null;
    const effectivePreset = preset ? { ...preset, document: resolveStoryPresetDocument(preset, draft.presetOverride) } : null;
    const presetStats = getPresetPromptStats(effectivePreset);

    const update = <K extends keyof StoryTheaterEntry>(key: K, value: StoryTheaterEntry[K]) => setDraft(current => ({ ...current, [key]: value, updatedAt: Date.now() }));
    const toggleCharacter = (char: CharacterProfile) => setDraft(current => {
        const adding = !current.characterIds.includes(char.id);
        const characterIds = adding ? [...current.characterIds, char.id] : current.characterIds.filter(id => id !== char.id);
        const remaining = characters.filter(item => characterIds.includes(item.id));
        const validBooks = new Set(dedupeTheaterWorldbooks(remaining).map(book => book.id));
        return {
            ...current,
            characterIds,
            selectedWorldbookIds: adding ? Array.from(new Set([...current.selectedWorldbookIds, ...(char.mountedWorldbooks || []).map(book => book.id)])) : current.selectedWorldbookIds.filter(id => validBooks.has(id)),
            characterMemoryDates: { ...current.characterMemoryDates, ...(adding && !current.characterMemoryDates[char.id] ? { [char.id]: localDateTime() } : {}) },
            characterContextLimits: { ...current.characterContextLimits, ...(adding && !current.characterContextLimits[char.id] ? { [char.id]: 100 } : {}) },
            updatedAt: Date.now(),
        };
    });
    const tokenPreview = useMemo(() => {
        const actorText = [resolvedMask.name, resolvedMask.description, resolvedMask.coreInstruction, resolvedMask.worldview, ...actors.map(char => [char.name, char.systemPrompt, char.worldview, draft.carryCharacterMemory ? JSON.stringify(char.memories || []) : ''].join('\n'))].join('\n');
        const bookText = books.filter(book => draft.selectedWorldbookIds.includes(book.id)).map(book => book.content).join('\n');
        const presetText = effectivePreset ? effectivePreset.document.prompts.filter(prompt => prompt.enabled).map(prompt => prompt.content).join('\n') : '';
        const archiveText = draft.archives.map(archive => archive.summary || '').join('\n');
        return { actor: estimateStoryTokens(actorText), book: estimateStoryTokens(bookText), preset: estimateStoryTokens(presetText), archive: estimateStoryTokens(archiveText) };
    }, [actors, books, draft, effectivePreset, resolvedMask]);
    const save = async () => {
        if (!draft.title.trim() || draft.characterIds.length === 0) return;
        setSaving(true);
        const archiveAfter = Math.max(2, Math.min(200, Number(draft.archiveAfter) || 40));
        const archiveKeepRecent = Math.max(1, Math.min(archiveAfter - 1, Number(draft.archiveKeepRecent) || 5));
        try { await onSave({ ...draft, title: draft.title.trim(), premise: draft.premise.trim(), carryCharacterMemory: draft.writesToCharacterMemory || draft.carryCharacterMemory, archiveAfter, archiveKeepRecent, presetId: preset?.id || presets[0]?.id, updatedAt: Date.now() }); }
        finally { setSaving(false); }
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onCancel} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Story setup</div><div className='font-semibold'>{initial.title ? 'Adjust story sandbox' : 'New story'}</div></div>
                <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='ml-auto h-9 px-4 rounded-full bg-slate-900 text-white text-xs font-bold disabled:opacity-30'>{saving ? 'Saving' : 'Save & enter'}</button>
            </div>
        </header>
        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-28'><div className='max-w-2xl mx-auto space-y-8'>
            <section>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>01 / Story</div>
                <label className='block mt-2'><span className='text-[10px] font-bold text-slate-500'>Title · Required</span><input value={draft.title} onChange={event => update('title', event.target.value)} placeholder='Story name' className='mt-1 w-full bg-transparent text-3xl font-serif font-semibold outline-none placeholder:text-slate-300' /></label>
                <label className='block mt-5'><span className='text-[10px] font-bold text-slate-500'>Story premise · Optional</span><textarea value={draft.premise} onChange={event => update('premise', event.target.value)} placeholder='You can start right away without filling this in — or write the setting, conflicts, or rules that must be kept…' className='mt-2 w-full min-h-28 p-4 rounded-2xl bg-white border border-slate-200 text-sm leading-7 resize-y outline-none' /></label>
                <div className='mt-5'><div className='text-[10px] font-bold text-slate-500'>Who writes first</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => update('openingMode', 'user')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${(draft.openingMode || 'user') === 'user' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>I write first</button><button disabled={maskLocked} onClick={() => update('openingMode', 'assistant')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${draft.openingMode === 'assistant' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>Story writes first</button></div><p className='mt-2 text-[10px] text-slate-400'>{draft.openingMode === 'assistant' ? 'Once inside, you can let the story write the first act directly from the title and premise.' : 'Once inside, you write the first line yourself as your current identity.'}</p></div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>02 / Cast</div><h2 className='mt-1 text-lg font-semibold'>Who's involved</h2>
                <p className='text-[11px] text-slate-500'>Decide who you are first, then choose the characters in this story all at once. The identity you choose is controlled only by you — it won't act on its own.</p>
                <button disabled={maskLocked || draft.writesToCharacterMemory} onClick={() => onOpenMaskBox(draft)} className='mt-4 w-full p-4 rounded-2xl bg-slate-900 text-white flex items-center gap-3 text-left disabled:cursor-not-allowed'>
                    {resolvedMask.avatar ? <TokenImg value={resolvedMask.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <span className='w-11 h-11 rounded-full bg-white/10 grid place-items-center'><UserCircle size={24} /></span>}
                    <span className='min-w-0 flex-1'><span className='block text-[9px] uppercase tracking-[.18em] text-violet-200'>You</span><strong className='block mt-1 text-sm truncate'>{resolvedMask.selection.type === 'user' ? 'Yourself' : resolvedMask.name}</strong><span className='block mt-1 text-[9px] text-slate-300 truncate'>{resolvedMask.selection.type === 'user' ? 'Enter the theater as your real self' : resolvedMask.selection.type === 'character' ? 'Play an existing character' : 'Play an original character'}</span></span>
                    <span className='text-[10px] font-bold text-violet-200'>{draft.writesToCharacterMemory ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />Real identity</span> : maskLocked ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />Locked for this story</span> : 'Mask box'}</span>
                </button>
                {(maskLocked || draft.writesToCharacterMemory) && <p className='mt-2 text-[10px] leading-5 text-slate-500'>{draft.writesToCharacterMemory ? 'Real-time companionship can only use your real self — you cannot play an existing character or an original character.' : 'After the first message is sent, the current identity locks in place, to avoid switching mid-story and misaligning character memory and narrative perspective.'}</p>}
                <div className='mt-4 grid grid-cols-2 gap-2.5'>{characters.map(char => { const selected = draft.characterIds.includes(char.id); const isMask = draft.mask?.type === 'character' && draft.mask.id === char.id; return <button key={char.id} disabled={isMask} onClick={() => toggleCharacter(char)} className={`flex items-center gap-3 p-3 rounded-2xl border text-left disabled:opacity-45 ${selected ? 'bg-violet-50 border-violet-300' : 'bg-white border-slate-200'}`}><TokenImg value={char.avatar} alt='' className='w-10 h-10 rounded-full object-cover' /><span className='min-w-0 flex-1'><span className='block text-sm font-semibold truncate'>{char.name}</span>{isMask && <span className='block text-[9px] text-violet-500'>Currently played by you</span>}</span><span className={`w-4 h-4 rounded-full border-2 ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`} /></button>; })}</div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>03 / Memory</div><h2 className='mt-1 text-lg font-semibold'>Is this story real?</h2>
                <div className='mt-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, mask: { type: 'user' }, writesToCharacterMemory: true, carryCharacterMemory: true, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>Real-time companionship</button><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, writesToCharacterMemory: false, carryCharacterMemory: false, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${!draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>Fictional theater</button></div>
                {maskLocked && <p className='mt-2 text-[10px] text-slate-400'>Once the story starts, the real/fictional mode is also fixed; memory input for fictional theater can still be adjusted individually.</p>}
                {draft.writesToCharacterMemory ? <div className='mt-5 p-4 rounded-2xl bg-amber-50 border border-amber-200'>
                    <div className='text-xs font-bold text-amber-800'>Both memory input and output will be enabled</div>
                    <p className='mt-1 text-[10px] leading-5 text-amber-700'>The character's existing memory will be read; what you write and the story text will also enter each character's normal memory separately, following the companion mode's watermark and summarization timing.</p>
                    <p className='mt-2 pt-2 border-t border-amber-200 text-[10px] leading-5 font-semibold text-amber-800'>Built-in authenticity protection: characters can't fabricate shared memories with you, and can't embellish existing memories.</p>
                    <div className='mt-3 space-y-3'>{memoryParticipants.map(char => <label key={char.id} className='flex items-center gap-3'><span className='w-20 text-xs font-semibold truncate'>{char.name}</span><input type='datetime-local' value={draft.characterMemoryDates[char.id] || localDateTime()} onChange={event => update('characterMemoryDates', { ...draft.characterMemoryDates, [char.id]: event.target.value })} className='min-w-0 flex-1 px-3 py-2 rounded-xl bg-white border border-amber-200 text-xs' /></label>)}</div>
                </div> : <div className='mt-5 space-y-5'>
                    <div className='py-3 border-y border-slate-200 flex items-center justify-between'><div><div className='text-sm font-semibold'>Memory output</div><p className='mt-1 text-[10px] text-slate-500'>Fictional content will never be written into any character's memory.</p></div><span className='px-2 py-1 rounded-full bg-slate-200 text-[9px] font-bold text-slate-500'>Permanently off</span></div>
                    <div className='flex items-start justify-between gap-5'><div><div className='text-sm font-semibold'>Memory input</div><p className='mt-1 text-[10px] text-slate-500'>Off by default; when enabled, the character enters the fictional story carrying their existing memory. When off, only name, core instructions, and worldview are read.</p></div><Toggle value={draft.carryCharacterMemory} onChange={value => update('carryCharacterMemory', value)} /></div>
                    {draft.carryCharacterMemory && <div className='space-y-2'>{memoryParticipants.map(char => <label key={char.id} className='flex items-center gap-3 text-xs'><span className='flex-1 truncate'>{char.name}{draft.mask?.type === 'character' && draft.mask.id === char.id ? ' (current identity)' : ''} recent raw entries</span><input type='number' min={0} max={500} value={draft.characterContextLimits[char.id] ?? 100} onChange={event => update('characterContextLimits', { ...draft.characterContextLimits, [char.id]: Math.max(0, Math.min(500, Number(event.target.value) || 0)) })} className='w-20 px-3 py-2 rounded-xl bg-white border border-slate-200 text-right' /><span className='text-slate-400'>entries</span></label>)}</div>}
                    <div><div className='text-sm font-semibold'>Archive method</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button onClick={() => update('archiveStrategy', 'summary')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'summary' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Event box</button><button onClick={() => update('archiveStrategy', 'vector')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'vector' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Independent vector</button></div></div>
                    <div className='grid grid-cols-2 gap-3'>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>Archive after this many floors</span><input type='number' min={2} max={200} value={draft.archiveAfter} onChange={event => update('archiveAfter', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>Keep at least this many recent floors</span><input type='number' min={1} max={Math.max(1, Number(draft.archiveAfter) - 1)} value={draft.archiveKeepRecent ?? 5} onChange={event => update('archiveKeepRecent', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                    </div>
                    <p className='text-[10px] leading-5 text-slate-500'>The current reply is finished and shown first, then the oldest part is archived; keeps the most recent 5 floors by default. The strategy can be changed later — old event boxes and old vectors are never lost.</p>
                </div>}
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>04 / Lore</div><h2 className='mt-1 text-lg font-semibold'>Worldbook sandbox</h2><p className='text-[10px] text-slate-500'>Synced and deduplicated from the characters' mounted items; checked items belong only to this story.</p>
                <div className='mt-3 divide-y divide-slate-100 border-y border-slate-200'>{books.length === 0 ? <div className='py-6 text-center text-xs text-slate-400'>Selected characters have no mounted worldbook</div> : books.map(book => { const selected = draft.selectedWorldbookIds.includes(book.id); return <button key={book.id} onClick={() => update('selectedWorldbookIds', selected ? draft.selectedWorldbookIds.filter(id => id !== book.id) : [...draft.selectedWorldbookIds, book.id])} className='w-full py-3 flex items-center gap-3 text-left'><span className={`w-4 h-4 rounded border text-[10px] text-center text-white ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`}>{selected ? '✓' : ''}</span><span className='min-w-0'><span className='block text-xs font-semibold truncate'>{book.title}</span><span className='block text-[9px] text-slate-400'>{book.category || 'Uncategorized'}</span></span></button>; })}</div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>05 / Preset</div><h2 className='mt-1 text-lg font-semibold'>Load a story preset</h2><p className='text-[10px] text-slate-500'>Only accepts native Mochi Machine sullyos.story-preset; built-in presets can be edited after copying.</p>
                <div className='mt-3 flex gap-2'><select value={preset?.id || ''} onChange={event => setDraft(current => ({ ...current, presetId: event.target.value, presetOverride: undefined, updatedAt: Date.now() }))} className='min-w-0 flex-1 px-3 py-3 rounded-xl bg-white border border-slate-200 text-xs'>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => fileInput.current?.click()} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center'><UploadSimple size={18} /></button><button disabled={!preset} onClick={() => { if (preset) void downloadStoryPreset(preset); }} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center disabled:opacity-30'><DownloadSimple size={18} /></button></div>
                <input ref={fileInput} type='file' accept='.json,application/json' className='hidden' onChange={async event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const imported = await onImportPreset(file); if (imported) setDraft(current => ({ ...current, presetId: imported.id, presetOverride: undefined, updatedAt: Date.now() })); }} />
                {preset && <div className='mt-3 flex items-center justify-between'><span className='text-[10px] text-slate-500'>{presetStats.enabled}/{presetStats.total} enabled · sent in current order and insertion position</span><button onClick={() => onEditPreset(preset, draft)} className='text-[10px] font-bold text-violet-600'>Open maker</button></div>}
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>Don't send advanced sampling parameters</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>Off by default. Enable only when the API doesn't accept these fields; when on, top_p, frequency_penalty, and presence_penalty are not sent.</p></div>
                        <Toggle label='Skip advanced sampling parameters' value={draft.omitSamplingParams === true} onChange={value => update('omitSamplingParams', value)} />
                    </div>
                    {draft.omitSamplingParams && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>This ignores all three parameters in the current preset, including non-default values. Keep this off for APIs that normally support tavern-style parameters.</p>}
                </div>
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>400 compatibility mode</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>Enable only when the API says "the last message must be user."</p></div>
                        <Toggle label='400 compatibility mode' value={draft.forceUserLastMessage === true} onChange={value => update('forceUserLastMessage', value)} />
                    </div>
                    {draft.forceUserLastMessage && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>When enabled, a system instruction replaces the native assistant prefill, which may weaken formatting and style effects. Switching to a model that supports this preset is recommended first.</p>}
                </div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>06 / Budget</div>
                <div className='mt-2 flex items-end justify-between gap-4'><div><h2 className='text-lg font-semibold'>Static configuration budget</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>This only compares character, worldbook, preset, and archive; the theater itself tallies history, recall, and this turn's input based on the full context actually used for the continuation.</p></div><strong className='text-2xl font-serif'>{Object.values(tokenPreview).reduce((sum, value) => sum + value, 0).toLocaleString()}</strong></div>
                <div className='mt-4 grid grid-cols-4 gap-2'>{Object.entries({ 'Character': tokenPreview.actor, 'Worldbook': tokenPreview.book, 'Preset': tokenPreview.preset, 'Archive': tokenPreview.archive }).map(([label, value]) => <div key={label} className='py-3 rounded-xl bg-white border border-slate-200 text-center'><div className='text-[9px] text-slate-400'>{label}</div><div className='mt-1 text-xs font-bold'>{value.toLocaleString()}</div></div>)}</div>
            </section>
            <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='w-full py-4 rounded-2xl bg-slate-900 text-white text-sm font-bold disabled:opacity-30'>{saving ? 'Saving…' : 'Save & enter the story'}</button>
        </div></main>
    </div>;
};

export default StoryTheaterEditor;
