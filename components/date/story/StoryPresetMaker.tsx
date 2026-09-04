import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, DownloadSimple, FloppyDisk, LockSimple, Plus, Trash } from '@phosphor-icons/react';
import type { StoryTheaterPreset, StoryTheaterPresetDocument, StoryTheaterPresetPrompt } from '../../../types';
import {
    applyStoryPresetChoice,
    downloadStoryPreset,
    duplicateStoryPreset,
    getStoryPresetPromptGroups,
    isProtectedStoryPrompt,
    isStoryPresetSectionMarker,
    makeStoryTheaterId,
} from '../../../utils/storyTheater';

interface Props {
    preset: StoryTheaterPreset;
    onBack: () => void;
    onSave: (preset: StoryTheaterPreset) => Promise<void> | void;
    onOpenCopy: (preset: StoryTheaterPreset) => Promise<void> | void;
    onDelete?: (preset: StoryTheaterPreset) => Promise<void> | void;
}

export interface StoryPresetSimpleChoice {
    label: string;
    hint: string;
    ids: readonly string[];
    options: Array<{ id?: string; label: string }>;
}

export const STORY_PRESET_SIMPLE_CHOICES: StoryPresetSimpleChoice[] = [
    {
        label: 'Writing style', hint: 'Determines the overall feel of the writing',
        ids: ['nmj-v3-style-custom', 'nmj-v3-style-soda', 'nmj-v3-style-corridor', 'nmj-v3-style-comedy', 'nmj-v3-style-darkcomedy', 'nmj-v3-style-syrup', 'nmj-v3-style-dullknife', 'nmj-v3-style-drama', 'romcom-style-contemporary'],
        options: [{ label: 'Default feel' }, { id: 'nmj-v3-style-soda', label: 'Soda-pop everyday' }, { id: 'nmj-v3-style-corridor', label: 'Rainy corridor' }, { id: 'nmj-v3-style-comedy', label: 'Absurdist comedy' }, { id: 'nmj-v3-style-darkcomedy', label: 'Dark comedy' }, { id: 'nmj-v3-style-syrup', label: 'Straightforward sweet' }, { id: 'nmj-v3-style-dullknife', label: 'Dull-blade angst' }, { id: 'nmj-v3-style-drama', label: 'Somber drama' }, { id: 'romcom-style-contemporary', label: 'Contemporary rom-com' }],
    },
    {
        label: 'Point of view', hint: 'Determines how the narration addresses the identity you are currently writing as',
        ids: ['nmj-v3-pov-second', 'nmj-v3-pov-third'],
        options: [{ id: 'nmj-v3-pov-second', label: 'Second person' }, { id: 'nmj-v3-pov-third', label: 'Third person' }],
    },
    {
        label: 'Input retelling', hint: 'Whether your idea gets played out first, or is treated as already having happened',
        ids: ['nmj-v62-retelling-replay', 'nmj-v62-retelling-direct'],
        options: [{ id: 'nmj-v62-retelling-replay', label: 'Replay & expand' }, { id: 'nmj-v62-retelling-direct', label: 'Jump straight in' }],
    },
    {
        label: 'Your writing authority', hint: 'How much the story can write on behalf of the identity you are currently controlling',
        ids: ['nmj-v63-user-agency-locked', 'nmj-v63-user-agency-assist', 'nmj-v63-user-agency-auto'],
        options: [{ id: 'nmj-v63-user-agency-locked', label: 'Never write for you' }, { id: 'nmj-v63-user-agency-assist', label: 'Limited co-acting' }, { id: 'nmj-v63-user-agency-auto', label: 'Fully automatic' }],
    },
    {
        label: 'Scene tension', hint: 'Adjusts only the emotional pressure of the current story',
        ids: ['nmj-v64-tension-lowfever-1', 'nmj-v64-tension-lowfever-2', 'nmj-v64-tension-lowfever-3'],
        options: [{ label: 'Natural' }, { id: 'nmj-v64-tension-lowfever-1', label: 'Low Fever I' }, { id: 'nmj-v64-tension-lowfever-2', label: 'Low Fever II' }, { id: 'nmj-v64-tension-lowfever-3', label: 'Low Fever III' }],
    },
    {
        label: 'Theater', hint: 'Appends a separate side-channel segment after the main text',
        ids: ['nmj-v3-theater-ai', 'nmj-v3-theater-user-sim', 'nmj-v3-theater-group', 'nmj-v3-theater-random', 'nmj-v6-side-channel-terminal', 'nmj-v6-side-channel-evidence', 'nmj-v6-side-channel-public', 'nmj-v6-side-channel-wrong-reel', 'nmj-v3-theater-custom'],
        options: [{ label: 'Off' }, { id: 'nmj-v3-theater-ai', label: 'Character & you' }, { id: 'nmj-v3-theater-user-sim', label: 'Your reflection' }, { id: 'nmj-v3-theater-group', label: 'You and the characters' }, { id: 'nmj-v3-theater-random', label: 'Random channel' }, { id: 'nmj-v6-side-channel-terminal', label: 'Terminal echoes' }, { id: 'nmj-v6-side-channel-evidence', label: 'Lost items & evidence' }, { id: 'nmj-v6-side-channel-public', label: 'Public frequency' }, { id: 'nmj-v6-side-channel-wrong-reel', label: 'Wrong-reel screening' }],
    },
    {
        label: 'Language', hint: 'Which language/variant the story text uses',
        ids: ['nmj-v3-language-cn', 'nmj-v3-language-tw', 'romcom-language-en'],
        options: [{ id: 'nmj-v3-language-cn', label: 'Simplified Chinese' }, { id: 'nmj-v3-language-tw', label: 'Traditional Chinese' }, { id: 'romcom-language-en', label: 'English' }],
    },
    {
        label: 'Length', hint: 'Roughly how long each continuation is',
        ids: ['nmj-v3-length-short', 'nmj-v3-length-medium', 'nmj-v3-length-long', 'romcom-length-proportional'],
        options: [{ id: 'nmj-v3-length-short', label: 'Short' }, { id: 'nmj-v3-length-medium', label: 'Medium' }, { id: 'nmj-v3-length-long', label: 'Long' }, { id: 'romcom-length-proportional', label: "Proportional to your message" }],
    },
];

const STORY_ROLE_LABELS: Record<StoryTheaterPresetPrompt['role'], string> = {
    system: 'Rules',
    user: 'You',
    assistant: 'Story',
};

const STORY_GENERATION_FIELDS = [
    ['temperature', 'Temperature', 'Temperature', 0, 2, 0.05, 'Lower is more stable, higher is more freeform. Claude only accepts 0–1; if the preset is above 1, Claude requests will automatically be sent as 1.'],
    ['topP', 'Candidate range', 'Top P', 0, 1, 0.01, 'Another randomness control. Usually fine to leave at the preset value — not recommended to adjust drastically alongside Temperature.'],
    ['frequencyPenalty', 'Repetition penalty', 'Frequency penalty', -2, 2, 0.05, 'Positive values reduce repeated phrasing, negative values allow more repetition. Some Claude relays ignore this field.'],
    ['presencePenalty', 'Topic penalty', 'Presence penalty', -2, 2, 0.05, 'Positive values favor introducing new content, negative values favor continuing existing content. Some Claude relays ignore this field.'],
    ['maxTokens', 'Max output', 'Max tokens', 256, 32000, 256, 'Only limits how much can be generated this turn at most — it does not mean every turn will be filled. Length is still mainly determined by the "Length" option above.'],
] as const;

const StoryPresetMaker: React.FC<Props> = ({ preset, onBack, onSave, onOpenCopy, onDelete }) => {
    const [draft, setDraft] = useState<StoryTheaterPreset>(() => ({
        ...preset,
        document: { ...preset.document, generation: { ...preset.document.generation }, prompts: preset.document.prompts.map(item => ({ ...item })) },
    }));
    const [mode, setMode] = useState<'simple' | 'pro'>('simple');
    const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState('');
    const [saving, setSaving] = useState(false);
    const readOnly = preset.builtIn === true;
    const groups = useMemo(() => getStoryPresetPromptGroups(draft.document), [draft.document]);
    const activeGroup = groups.find(group => group.key === activeGroupKey) || null;
    const activePrompts = useMemo(() => {
        if (!activeGroup) return [];
        const ids = new Set(activeGroup.promptIds);
        return draft.document.prompts.filter(prompt => ids.has(prompt.id) && !isStoryPresetSectionMarker(prompt));
    }, [activeGroup, draft.document.prompts]);
    const selected = activePrompts.find(prompt => prompt.id === selectedId) || null;

    const replaceDocument = (document: StoryTheaterPresetDocument) => setDraft(current => ({ ...current, name: document.name, document, updatedAt: Date.now() }));
    const patchDocument = (patch: Partial<StoryTheaterPresetDocument>) => replaceDocument({ ...draft.document, ...patch });
    const patchPrompt = (id: string, patch: Partial<StoryTheaterPresetPrompt>) => patchDocument({
        prompts: draft.document.prompts.map(prompt => prompt.id === id ? { ...prompt, ...patch } : prompt),
    });
    const selectSimpleChoice = (choice: StoryPresetSimpleChoice, id?: string) => {
        if (readOnly) return;
        replaceDocument(applyStoryPresetChoice(draft.document, choice.ids, id));
    };
    const moveGroup = (key: string, direction: -1 | 1) => {
        if (readOnly) return;
        const ordered = [...groups];
        const index = ordered.findIndex(group => group.key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ordered.length) return;
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        const byId = new Map(draft.document.prompts.map(prompt => [prompt.id, prompt]));
        patchDocument({ prompts: ordered.flatMap(group => group.promptIds.map(id => byId.get(id)).filter((prompt): prompt is StoryTheaterPresetPrompt => Boolean(prompt))) });
    };
    const movePrompt = (id: string, direction: -1 | 1) => {
        const index = activePrompts.findIndex(prompt => prompt.id === id);
        const target = index + direction;
        if (readOnly || index < 0 || target < 0 || target >= activePrompts.length) return;
        const prompts = [...draft.document.prompts];
        const fromIndex = prompts.findIndex(prompt => prompt.id === id);
        const toIndex = prompts.findIndex(prompt => prompt.id === activePrompts[target].id);
        [prompts[fromIndex], prompts[toIndex]] = [prompts[toIndex], prompts[fromIndex]];
        patchDocument({ prompts });
    };
    const addPrompt = () => {
        if (!activeGroup || activeGroup.protected || readOnly) return;
        const next: StoryTheaterPresetPrompt = { id: makeStoryTheaterId(), name: 'New prompt', enabled: true, role: 'system', content: '' };
        const prompts = [...draft.document.prompts];
        const last = prompts[activeGroup.endIndex];
        const insertAt = last && isStoryPresetSectionMarker(last) ? activeGroup.endIndex : activeGroup.endIndex + 1;
        prompts.splice(insertAt, 0, next);
        patchDocument({ prompts });
        setSelectedId(next.id);
    };
    const removePrompt = (id: string) => {
        const prompt = draft.document.prompts.find(item => item.id === id);
        if (!prompt || readOnly || isProtectedStoryPrompt(prompt)) return;
        patchDocument({ prompts: draft.document.prompts.filter(item => item.id !== id) });
        if (selectedId === id) setSelectedId('');
    };
    const save = async () => {
        if (readOnly) { await onOpenCopy(duplicateStoryPreset(draft)); return; }
        setSaving(true);
        try { await onSave({ ...draft, name: draft.document.name.trim() || 'Untitled story preset', updatedAt: Date.now() }); }
        finally { setSaving(false); }
    };

    const renderGenerationFields = () => <>
        <div className='mt-5 divide-y divide-slate-200 border-y border-slate-200'>
            {STORY_GENERATION_FIELDS.map(([key, label, technicalLabel, min, max, step, help]) => <label key={key} className='block py-4'>
                <span className='flex items-center gap-4'><span className='min-w-0 flex-1'><strong className='block text-xs text-slate-700'>{label}</strong><span className='mt-0.5 block text-[8px] uppercase tracking-wide text-slate-400'>{technicalLabel}</span></span><input disabled={readOnly} type='number' min={min} max={max} step={step} value={draft.document.generation[key]} onChange={event => patchDocument({ generation: { ...draft.document.generation, [key]: Number(event.target.value) } })} className='w-24 shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right text-sm font-semibold outline-none disabled:opacity-50' /></span>
                <span className='mt-2 block text-[9px] leading-4 text-slate-400'>{help}</span>
            </label>)}
        </div>
        {draft.document.generation.temperature > 1 && <p className='mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-5 text-amber-800'>Current temperature is above 1: OpenAI-style models will keep this value; when using Claude, it will automatically be sent as 1.0 to avoid third-party relays returning a 400 error.</p>}
    </>;

    const renderGeneration = () => <section>
        <button onClick={() => setActiveGroupKey(null)} className='mb-5 text-[10px] font-bold text-violet-600'>← Back to categories</button>
        <div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h2 className='mt-1 text-2xl font-serif font-semibold'>Continuation parameters</h2>
        <p className='mt-2 text-[10px] leading-5 text-slate-500'>These values are saved with the preset. Generally keep the default values; adjust only if the API reports a parameter error, following the hint.</p>
        {renderGenerationFields()}
        <label className='block mt-4'><span className='text-[10px] text-slate-500'>Opening line</span><textarea disabled={readOnly} value={draft.document.assistantPrefill || ''} onChange={event => patchDocument({ assistantPrefill: event.target.value })} className='mt-1 w-full min-h-24 p-3 rounded-xl bg-white border border-slate-200 font-mono text-[11px] disabled:opacity-50' /></label>
    </section>;

    const renderGroupDetails = () => {
        if (!activeGroup) return null;
        return <section>
            <button onClick={() => { setActiveGroupKey(null); setSelectedId(''); }} className='mb-5 text-[10px] font-bold text-violet-600'>← Back to categories</button>
            <div className='flex items-start justify-between gap-4'><div><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h2 className='mt-1 text-2xl font-serif font-semibold'>{activeGroup.label}</h2><p className='mt-2 text-[10px] leading-5 text-slate-500'>{activeGroup.description}</p></div>{activeGroup.protected && <span className='shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-[9px] font-bold text-amber-700'><LockSimple size={12} />Protected</span>}</div>
            {activeGroup.protected && <div className='mt-5 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-[11px] leading-6 text-amber-800'>This is the Mochi Machine's skeleton connecting the character, your identity, the worldbook, and history. You can reorder these up or down, but can't change their content, toggle, message position, or type, and can't delete them.</div>}
            <div className='mt-5 border-y border-slate-200 divide-y divide-slate-200'>
                {activePrompts.map((prompt, index) => { const locked = activeGroup.protected || isProtectedStoryPrompt(prompt); return <div key={prompt.id} className={`flex items-center gap-2 py-3 ${selectedId === prompt.id ? 'text-violet-700' : ''}`}>
                    <button disabled={readOnly || locked} onClick={() => patchPrompt(prompt.id, { enabled: !prompt.enabled })} className={`w-9 shrink-0 text-[9px] font-bold disabled:opacity-50 ${prompt.enabled ? 'text-emerald-600' : 'text-slate-300'}`}>{prompt.enabled ? 'ON' : 'OFF'}</button>
                    <button onClick={() => setSelectedId(prompt.id)} className='min-w-0 flex-1 text-left'><span className='block text-xs font-semibold truncate'>{index + 1}. {prompt.name}</span><span className='block mt-1 text-[9px] text-slate-400'>{locked ? 'System connection slot · Content locked' : STORY_ROLE_LABELS[prompt.role]}</span></button>
                    {!readOnly && <span className='flex shrink-0'><button disabled={index === 0} onClick={() => movePrompt(prompt.id, -1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowUp size={14} /></button><button disabled={index === activePrompts.length - 1} onClick={() => movePrompt(prompt.id, 1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowDown size={14} /></button>{!locked && <button onClick={() => removePrompt(prompt.id)} className='p-1.5 text-rose-400'><Trash size={14} /></button>}</span>}
                </div>; })}
            </div>
            {!activeGroup.protected && !readOnly && <button onClick={addPrompt} className='mt-4 h-10 px-4 rounded-xl bg-white border border-slate-200 text-xs font-bold flex items-center gap-1'><Plus size={14} />Add a prompt in this section</button>}
            {selected && <div className='mt-7 pt-6 border-t border-slate-200'>
                {activeGroup.protected || isProtectedStoryPrompt(selected) ? <div className='py-8 text-center'><LockSimple size={28} className='mx-auto text-amber-400' /><div className='mt-2 text-xs font-bold'>System connection content is locked</div><p className='mt-1 text-[10px] text-slate-400'>You can still reorder it relative to other connection slots above.</p></div> : <>
                    <div className='grid grid-cols-2 gap-3'><label><span className='text-[10px] text-slate-500'>Name</span><input disabled={readOnly} value={selected.name} onChange={event => patchPrompt(selected.id, { name: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs' /></label><label><span className='text-[10px] text-slate-500'>Message position</span><select disabled={readOnly} value={selected.role} onChange={event => patchPrompt(selected.id, { role: event.target.value as StoryTheaterPresetPrompt['role'] })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-xs'><option value='system'>Rules</option><option value='user'>You</option><option value='assistant'>Story</option></select></label></div>
                    <textarea disabled={readOnly} value={selected.content} onChange={event => patchPrompt(selected.id, { content: event.target.value })} className='mt-3 w-full min-h-64 p-4 rounded-2xl bg-white border border-slate-200 font-mono text-[11px] leading-6 resize-y' placeholder='Supports {{user}} / {{char}} / {{group}}' />
                </>}
            </div>}
        </section>;
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'><div className='text-[9px] uppercase tracking-[.24em] font-bold text-violet-500'>Preset maker</div><div className='font-semibold truncate'>Preset Maker</div></div>
                {readOnly && <span className='hidden sm:inline-flex text-[9px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-bold'>Built-in · Read-only</span>}
                <button onClick={() => { void downloadStoryPreset(draft); }} className='w-9 h-9 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center' title='Export native Mochi Machine preset'><DownloadSimple size={16} /></button>
                <button onClick={save} className='h-9 px-3 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center gap-1.5'>{readOnly ? <Copy size={14} /> : <FloppyDisk size={14} />}{readOnly ? 'Copy & adjust' : saving ? 'Saving' : 'Save'}</button>
            </div>
            <div className='mx-5 mb-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'>
                <button onClick={() => { setMode('simple'); setActiveGroupKey(null); }} className={`py-2 rounded-lg text-xs font-bold ${mode === 'simple' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>Simple</button>
                <button onClick={() => setMode('pro')} className={`py-2 rounded-lg text-xs font-bold ${mode === 'pro' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>Pro</button>
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                {mode === 'simple' ? <>
                    <section className='pb-5 border-b border-slate-200'><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Easy controls</div><h1 className='mt-1 text-3xl font-serif font-semibold'>Adjust only what you understand</h1><p className='mt-3 text-[11px] leading-6 text-slate-500'>Character, worldbook, history injection, and the underlying send structure are all handled by the Mochi Machine. Choices here won't modify your character profile.</p>{readOnly && <p className='mt-3 text-[10px] text-amber-700'>This is the built-in original. Tap "Copy & adjust" in the top right to save your own choices.</p>}</section>
                    <div className='divide-y divide-slate-200'>{STORY_PRESET_SIMPLE_CHOICES.filter(choice => choice.ids.some(id => draft.document.prompts.some(prompt => prompt.id === id))).map(choice => {
                        const active = choice.ids.find(id => draft.document.prompts.find(prompt => prompt.id === id)?.enabled);
                        return <section key={choice.label} className='py-6'><h2 className='text-sm font-bold'>{choice.label}</h2><p className='mt-1 text-[10px] text-slate-400'>{choice.hint}</p><div className='mt-3 flex flex-wrap gap-2'>{choice.options.map(option => { const selectedOption = option.id ? active === option.id : !active; return <button key={option.id || 'default'} disabled={readOnly} onClick={() => selectSimpleChoice(choice, option.id)} className={`px-3 py-2 rounded-full border text-[11px] font-semibold disabled:opacity-60 ${selectedOption ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600'}`}>{option.label}</button>; })}</div></section>;
                    })}</div>
                    <section className='py-6 border-t border-slate-200'><h2 className='text-sm font-bold'>Continuation parameters</h2><p className='mt-1 text-[10px] leading-5 text-slate-400'>Saved along with this preset; if unsure, just keep the default value.</p>{renderGenerationFields()}</section>
                    {!readOnly && <section className='pt-5 border-t border-slate-200'><label><span className='text-[10px] font-bold text-slate-500'>Preset name</span><input value={draft.document.name} onChange={event => patchDocument({ name: event.target.value })} className='mt-2 w-full px-3 py-3 rounded-xl bg-white border border-slate-200 text-sm' /></label></section>}
                </> : activeGroupKey === '__generation__' ? renderGeneration() : activeGroup ? renderGroupDetails() : <>
                    <section className='pb-5 border-b border-slate-200'><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Professional</div><h1 className='mt-1 text-3xl font-serif font-semibold'>Pick a category first, then view details</h1><p className='mt-3 text-[11px] leading-6 text-slate-500'>Only one section can be expanded at a time on mobile. Use the up/down arrows to reorder whole sections; entries only appear once you're inside a section.</p></section>
                    <div className='divide-y divide-slate-200'>{groups.map((group, index) => {
                        const groupPrompts = draft.document.prompts.filter(prompt => group.promptIds.includes(prompt.id) && !isStoryPresetSectionMarker(prompt));
                        const enabled = groupPrompts.filter(prompt => prompt.enabled).length;
                        return <div key={group.key} className='py-4 flex items-center gap-3'><button onClick={() => { setActiveGroupKey(group.key); setSelectedId(''); }} className='min-w-0 flex-1 text-left'><span className='flex items-center gap-2'><strong className='text-sm'>{group.label}</strong>{group.protected && <LockSimple size={13} className='text-amber-500' />}</span><span className='block mt-1 text-[10px] text-slate-400 truncate'>{group.description}</span><span className='block mt-1 text-[9px] text-violet-500'>{enabled}/{groupPrompts.length} enabled</span></button>{!readOnly && <span className='flex shrink-0'><button disabled={index === 0} onClick={() => moveGroup(group.key, -1)} className='p-2 text-slate-400 disabled:opacity-20'><ArrowUp size={15} /></button><button disabled={index === groups.length - 1} onClick={() => moveGroup(group.key, 1)} className='p-2 text-slate-400 disabled:opacity-20'><ArrowDown size={15} /></button></span>}</div>;
                    })}<button onClick={() => setActiveGroupKey('__generation__')} className='w-full py-5 text-left'><strong className='text-sm'>Continuation Parameters</strong><span className='block mt-1 text-[10px] text-slate-400'>Temperature, Top P, penalties, and max output</span></button></div>
                    {!readOnly && <section className='pt-6 border-t border-slate-200 grid gap-3 sm:grid-cols-2'><label><span className='text-[10px] font-bold text-slate-500'>Preset name</span><input value={draft.document.name} onChange={event => patchDocument({ name: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label><label><span className='text-[10px] font-bold text-slate-500'>Description</span><input value={draft.document.description || ''} onChange={event => patchDocument({ description: event.target.value })} className='mt-1 w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label></section>}
                    {!readOnly && onDelete && <button onClick={() => onDelete(draft)} className='mt-8 w-full py-3 text-xs font-bold text-rose-500'>Delete this preset</button>}
                </>}
            </div>
        </main>
    </div>;
};

export default StoryPresetMaker;
