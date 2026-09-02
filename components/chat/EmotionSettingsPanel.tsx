
import React, { useState, useEffect } from 'react';
import { CharacterProfile, ApiPreset, APIConfig, CharacterBuff } from '../../types';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';

interface EmotionSettingsPanelProps {
    char: CharacterProfile;
    apiPresets: ApiPreset[];
    addApiPreset: (name: string, config: APIConfig) => void;
    onSave: (config: NonNullable<CharacterProfile['emotionConfig']>) => void;
    onClearBuffs: () => void;
}

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const INTENSITY_DOTS = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

const EmotionSettingsPanel: React.FC<EmotionSettingsPanelProps> = ({
    char, apiPresets, addApiPreset, onSave, onClearBuffs
}) => {
    const [url, setUrl] = useState('');
    const [key, setKey] = useState('');
    const [model, setModel] = useState('');
    const [showSavePreset, setShowSavePreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [dirty, setDirty] = useState(false);

    // Sync form state from character
    useEffect(() => {
        const s = char.emotionConfig;
        setUrl(s?.api?.baseUrl ?? '');
        setKey(s?.api?.apiKey ?? '');
        setModel(s?.api?.model ?? '');
        setShowSavePreset(false);
        setNewPresetName('');
        setDirty(false);
    }, [char.id]);

    const loadPreset = (preset: ApiPreset) => {
        setUrl(preset.config.baseUrl);
        setKey(preset.config.apiKey);
        setModel(preset.config.model);
        setDirty(true);
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;
        addApiPreset(newPresetName.trim(), { baseUrl: url, apiKey: key, model });
        setNewPresetName('');
        setShowSavePreset(false);
    };

    const handleSave = () => {
        const api = url ? { baseUrl: url, apiKey: key, model } : undefined;
        // Forcibly synced with schedule: emotion must run whenever the schedule/emotion master switch is on.
        // Note: when scheduleFeatureEnabled=true, emotion should stay on even if scheduleStyle hasn't been picked yet.
        onSave({ enabled: isScheduleFeatureOn(char), api });
        setDirty(false);
    };

    const buffs: CharacterBuff[] = char.activeBuffs || [];
    const scheduleOn = isScheduleFeatureOn(char);

    return (
        <div className="space-y-4 pt-4 border-t border-slate-100">
            <div>
                <div className="text-xs font-bold text-slate-700 mb-1">🎭 Emotion / Stream of Consciousness API</div>
                <div className="text-[11px] text-slate-500 leading-relaxed space-y-1">
                    <p>
                        The original emotion buffs live here. <b>Forcibly synced</b> with schedule: schedule on → auto-enabled; schedule off → stops together.
                    </p>
                    <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        ⚙️ Leave the fields below empty = automatically use the main API. For something more nuanced, fill in a <b>Claude-family</b> model.
                    </p>
                </div>
            </div>

            {!scheduleOn && (
                <div className="text-[11px] text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    No schedule style has been chosen yet. Emotion / stream of consciousness will auto-enable once you pick "Lifestyle" or "Mindful."
                </div>
            )}

            {/* Preset chips */}
            {apiPresets.length > 0 && (
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">My Presets</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <button
                                key={preset.id}
                                onClick={() => loadPreset(preset)}
                                className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-pink-500 hover:border-pink-200 active:scale-95 transition-all"
                            >
                                {preset.name}
                                <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* API fields */}
            <div className="space-y-3">
                <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Secondary API Config</label>
                    <button
                        onClick={() => setShowSavePreset(!showSavePreset)}
                        className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                    >
                        Save as Preset
                    </button>
                </div>

                {showSavePreset && (
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newPresetName}
                            onChange={e => setNewPresetName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSavePreset()}
                            placeholder="Preset name..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2 text-sm focus:bg-white transition-all"
                            autoFocus
                        />
                        <button
                            onClick={handleSavePreset}
                            className="px-4 py-2 bg-pink-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-transform"
                        >
                            Save
                        </button>
                    </div>
                )}

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input
                        type="text"
                        value={url}
                        onChange={e => { setUrl(e.target.value); setDirty(true); }}
                        placeholder="Leave empty = use the main API"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input
                        type="password"
                        value={key}
                        onChange={e => { setKey(e.target.value); setDirty(true); }}
                        placeholder="sk-..."
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Model</label>
                    <input
                        type="text"
                        value={model}
                        onChange={e => { setModel(e.target.value); setDirty(true); }}
                        placeholder="claude-haiku-4-5 / gpt-4o-mini / ..."
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>

                <button
                    onClick={handleSave}
                    disabled={!dirty}
                    className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${
                        dirty
                            ? 'bg-pink-500 text-white shadow-md active:scale-95'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    }`}
                >
                    {dirty ? 'Save Secondary API Config' : '✓ Saved'}
                </button>
            </div>

            {/* Current buffs */}
            {buffs.length > 0 ? (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Current Emotion States</label>
                        <button onClick={onClearBuffs} className="text-xs text-slate-400 hover:text-red-400 transition-colors">Clear</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {buffs.map(buff => (
                            <div
                                key={buff.id}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold"
                                style={{
                                    backgroundColor: buff.color ? buff.color + '22' : '#fdf2f8',
                                    color: buff.color || '#db2777',
                                    border: `1px solid ${buff.color ? buff.color + '55' : '#fbcfe8'}`
                                }}
                            >
                                {buff.emoji && <span>{buff.emoji}</span>}
                                <span>{buff.label}</span>
                                <span className="opacity-60">{INTENSITY_DOTS(buff.intensity)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : scheduleOn ? (
                <div className="text-xs text-slate-400 text-center py-2">
                    No emotion state yet -- it will be generated automatically after a few messages
                </div>
            ) : null}
        </div>
    );
};

export default React.memo(EmotionSettingsPanel);
