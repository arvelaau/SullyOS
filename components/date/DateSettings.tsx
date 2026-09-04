
import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, SpriteConfig, SkinSet, DateStyleConfig } from '../../types';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import { pickDateFallbackSprite } from '../../utils/dateSprites';
import TokenImg from '../os/TokenImg';
import { DATE_STYLE_PRESETS } from '../../utils/datePrompts';
import ObserveSettings from './ObserveSettings';

// Standard emotion list
const REQUIRED_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];
const DEFAULT_SPRITE_CONFIG: SpriteConfig = { scale: 1, x: 0, y: 0 };

interface DateSettingsProps {
    char: CharacterProfile;
    onBack: () => void;
}

/** Collapsible section card: the title stays put, content is collapsed by default, tap the title to expand. Uses the native <details> element to avoid extra state. */
const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ title, defaultOpen, children }) => (
    <details open={defaultOpen} className="group bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-2 px-4 py-3.5 active:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase">{title}</h3>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-slate-300 transition-transform group-open:rotate-180 shrink-0"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
        </summary>
        <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
);

const DateSettings: React.FC<DateSettingsProps> = ({ char, onBack }) => {
    const { updateCharacter, addToast, userProfile } = useOS();
    const fileInputRef = useRef<HTMLInputElement>(null);
    // The background field stores a blobref token (the binary lives in IndexedDB);
    // CSS url() can't consume a token, so resolve it into a usable address here.
    // Non-token values (legacy data: URIs / external links) pass through unchanged.
    const dateBackgroundUrl = useBlobRefUrl(char.dateBackground);

    // Writing style & narrative (takes effect immediately: the system prompt is rebuilt on every request, so saving affects the next reply)
    const styleConfig = char.dateStyleConfig || {};
    const [extraDraft, setExtraDraft] = useState(styleConfig.extra || '');
    useEffect(() => { setExtraDraft(char.dateStyleConfig?.extra || ''); }, [char.id]);
    const patchStyleConfig = (patch: Partial<DateStyleConfig>) => {
        updateCharacter(char.id, { dateStyleConfig: { ...(char.dateStyleConfig || {}), ...patch } });
    };
    const saveExtraDraft = () => {
        const trimmed = extraDraft.trim();
        if (trimmed === (char.dateStyleConfig?.extra || '')) return;
        patchStyleConfig({ extra: trimmed || undefined });
        addToast(trimmed ? 'Extra instructions saved' : 'Extra instructions cleared', 'success');
    };
    const userName = userProfile?.name || 'User';
    const POV_OPTIONS: { id: DateStyleConfig['pov']; label: string; example: string }[] = [
        { id: undefined, label: 'Default', example: 'No extra instruction, let the model decide' },
        { id: 'third-name', label: 'Third person · by name', example: `${char.name} looks at ${userName}` },
        { id: 'third-you', label: 'Third person · as "you"', example: `${char.name} looks at you` },
        { id: 'first-you', label: 'First person', example: 'I look at you' },
        { id: 'first-heshe', label: 'First person · other as "he/she"', example: 'I look at him/her' },
    ];

    const [uploadTarget, setUploadTarget] = useState<'bg' | 'sprite' | 'skin-sprite'>('bg');
    const [targetEmotionKey, setTargetEmotionKey] = useState<string>('');
    const [tempSpriteConfig, setTempSpriteConfig] = useState<SpriteConfig>(DEFAULT_SPRITE_CONFIG);
    const [newEmotionName, setNewEmotionName] = useState<string>('');

    // Skin system state
    const [newSkinName, setNewSkinName] = useState('');
    const [editingSkinId, setEditingSkinId] = useState<string | null>(null);
    const [skinUrlInput, setSkinUrlInput] = useState('');
    const [skinUrlEmotionKey, setSkinUrlEmotionKey] = useState('');
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlTargetSkinId, setUrlTargetSkinId] = useState<string | null>(null); // null = default sprites
    const skinSets = char.dateSkinSets || [];
    const activeSkinId = char.activeSkinSetId || null;

    // Sync config on mount
    useEffect(() => {
        if (char.spriteConfig) {
            setTempSpriteConfig(char.spriteConfig);
        }
    }, [char.id]);

    const sprites = char.sprites || {};
    // Preview shows active skin set's sprites if one is selected
    const previewSprites = React.useMemo(() => {
        if (activeSkinId) {
            const skin = skinSets.find(s => s.id === activeSkinId);
            if (skin && Object.keys(skin.sprites).length > 0) return skin.sprites;
        }
        return sprites;
    }, [activeSkinId, skinSets, sprites]);
    const currentSpriteImg = pickDateFallbackSprite(
        previewSprites,
        [...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])],
        char.avatar,
    );

    const triggerUpload = (target: 'bg' | 'sprite', emotionKey?: string) => {
        setUploadTarget(target);
        if (emotionKey) setTargetEmotionKey(emotionKey);
        fileInputRef.current?.click();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            if (uploadTarget === 'bg') {
                // Background is stored as a Blob too: original quality, no re-encoding, binary goes into
                // blob_assets, the field only stores a blobref token (saves ~33% space, no JS heap cost).
                // See apps/Appearance.tsx's wallpaper upload for the same pattern.
                const blob = await processImageToBlob(file, { skipCompression: true });
                const ref = await putImageBlob(blob);
                updateCharacter(char.id, { dateBackground: ref });
                addToast('Background updated', 'success');
                return;
            }

            // Portraits are also stored as Blobs, the field only keeps the blobref token. Compression
            // settings are identical to before: no args = long edge 1200 / quality 0.85 / PNG·WebP keep
            // the alpha channel, only the output moved from base64 to binary. Don't copy skipCompression
            // from the background path above — that one needs original quality.
            const blob = await processImageToBlob(file);
            const ref = await putImageBlob(blob);
            if (uploadTarget === 'skin-sprite') {
                // Upload to a specific skin set
                const key = targetEmotionKey.trim().toLowerCase();
                const skinId = editingSkinId;
                if (!key || !skinId) { addToast('Missing parameters', 'error'); return; }
                const updatedSets = (char.dateSkinSets || []).map(s =>
                    s.id === skinId ? { ...s, sprites: { ...s.sprites, [key]: ref } } : s
                );
                updateCharacter(char.id, { dateSkinSets: updatedSets });
                addToast(`Skin portrait [${key}] saved`, 'success');
                setTargetEmotionKey('');
            } else {
                const key = targetEmotionKey.trim().toLowerCase();
                if (!key) { addToast('Missing emotion key', 'error'); return; }
                const newSprites = { ...(char.sprites || {}), [key]: ref };
                updateCharacter(char.id, { sprites: newSprites });
                addToast(`Portrait [${key}] saved`, 'success');
                setTargetEmotionKey('');
            }
        } catch (e: any) {
            addToast(e.message, 'error');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    // --- Skin Set Management ---
    const handleCreateSkinSet = () => {
        const name = newSkinName.trim();
        if (!name) { addToast('Please enter a skin name', 'error'); return; }
        if (skinSets.some(s => s.name === name)) { addToast('That name already exists', 'error'); return; }
        const newSkin: SkinSet = { id: `skin_${Date.now()}`, name, sprites: {} };
        updateCharacter(char.id, { dateSkinSets: [...skinSets, newSkin] });
        setNewSkinName('');
        addToast(`Skin [${name}] created`, 'success');
    };

    const handleDeleteSkinSet = (skinId: string) => {
        const updated = skinSets.filter(s => s.id !== skinId);
        const patch: Partial<CharacterProfile> = { dateSkinSets: updated };
        if (activeSkinId === skinId) patch.activeSkinSetId = undefined;
        updateCharacter(char.id, patch);
        if (editingSkinId === skinId) setEditingSkinId(null);
        addToast('Skin deleted', 'success');
    };

    const handleActivateSkin = (skinId: string | null) => {
        updateCharacter(char.id, { activeSkinSetId: skinId || undefined });
        addToast(skinId ? 'Skin switched' : 'Switched back to default portrait', 'success');
    };

    const triggerSkinSpriteUpload = (skinId: string, emotionKey: string) => {
        setUploadTarget('skin-sprite');
        setEditingSkinId(skinId);
        setTargetEmotionKey(emotionKey);
        fileInputRef.current?.click();
    };

    const handleUrlSubmit = () => {
        const url = skinUrlInput.trim();
        const key = skinUrlEmotionKey.trim().toLowerCase();
        if (!url || !key) { addToast('Please fill in all fields', 'error'); return; }
        // Basic URL validation
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            addToast('Please enter a valid URL (http/https)', 'error'); return;
        }

        if (urlTargetSkinId) {
            // Save to skin set
            const updatedSets = (char.dateSkinSets || []).map(s =>
                s.id === urlTargetSkinId ? { ...s, sprites: { ...s.sprites, [key]: url } } : s
            );
            updateCharacter(char.id, { dateSkinSets: updatedSets });
        } else {
            // Save to default sprites
            const newSprites = { ...(char.sprites || {}), [key]: url };
            updateCharacter(char.id, { sprites: newSprites });
        }
        addToast(`Portrait [${key}] URL saved`, 'success');
        setSkinUrlInput('');
        setSkinUrlEmotionKey('');
        setShowUrlModal(false);
    };

    const handleSaveSettings = () => {
        updateCharacter(char.id, { spriteConfig: tempSpriteConfig });
        addToast('Settings saved', 'success');
        onBack();
    };

    const customEmotions = char.customDateSprites || [];

    const handleAddCustomEmotion = () => {
        const key = newEmotionName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!key) { addToast('Please enter an emotion name', 'error'); return; }
        if (REQUIRED_EMOTIONS.includes(key)) { addToast('That name duplicates a default emotion', 'error'); return; }
        if (customEmotions.includes(key)) { addToast('That custom emotion already exists', 'error'); return; }
        if (key === 'chibi') { addToast('"chibi" cannot be used as an emotion name', 'error'); return; }
        const updated = [...customEmotions, key];
        updateCharacter(char.id, { customDateSprites: updated });
        setNewEmotionName('');
        addToast(`Custom emotion [${key}] added`, 'success');
    };

    const handleDeleteCustomEmotion = (key: string) => {
        const updated = customEmotions.filter(e => e !== key);
        updateCharacter(char.id, { customDateSprites: updated });
        // Also remove the sprite image for this emotion
        const newSprites = { ...(char.sprites || {}) };
        delete newSprites[key];
        updateCharacter(char.id, { sprites: newSprites, customDateSprites: updated });
        addToast(`Custom emotion [${key}] deleted`, 'success');
    };

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col">
            <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200 bg-white shrink-0 z-20">
                <button onClick={onBack} className="p-2 -ml-2 text-slate-600 active:scale-95 transition-transform">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <span className="font-bold text-slate-700">Scene Setup</span>
                <div className="w-8"></div>
            </div>
            
            {/* Live Preview Area */}
            <div className="h-64 bg-black relative overflow-hidden shrink-0 border-b border-slate-200">
                    <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: dateBackgroundUrl ? `url("${dateBackgroundUrl}")` : 'none' }}></div>
                    <div className="absolute inset-0 flex items-end justify-center pointer-events-none">
                        <TokenImg
                        value={currentSpriteImg}
                        className="max-h-[90%] object-contain transition-transform"
                        style={{ 
                            transform: `translate(${tempSpriteConfig.x}%, ${tempSpriteConfig.y}%) scale(${tempSpriteConfig.scale})`
                        }}
                        />
                    </div>
                    <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] px-2 py-1 rounded backdrop-blur-sm">Preview</div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-8 pb-20">
                <Section title="Portrait Position">
                    <div className="space-y-6">
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>Scale</span><span>{tempSpriteConfig.scale.toFixed(1)}x</span></div>
                            <input type="range" min="0.5" max="2.0" step="0.1" value={tempSpriteConfig.scale} onChange={e => setTempSpriteConfig({...tempSpriteConfig, scale: parseFloat(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>Horizontal Offset (X)</span><span>{tempSpriteConfig.x}%</span></div>
                            <input type="range" min="-100" max="100" step="5" value={tempSpriteConfig.x} onChange={e => setTempSpriteConfig({...tempSpriteConfig, x: parseInt(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                            <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>Vertical Offset (Y)</span><span>{tempSpriteConfig.y}%</span></div>
                            <input type="range" min="-50" max="50" step="5" value={tempSpriteConfig.y} onChange={e => setTempSpriteConfig({...tempSpriteConfig, y: parseInt(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                    </div>
                </Section>

                <section className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">Light Reading Mode</h3>
                            <p className="text-[11px] text-slate-400 mt-1">Uses a light background in novel view to reduce eye strain</p>
                        </div>
                        <button
                            onClick={() => updateCharacter(char.id, { dateLightReading: !char.dateLightReading })}
                            type="button"
                            role="switch"
                            aria-checked={!!char.dateLightReading}
                            aria-label="Toggle light reading mode"
                            className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateLightReading ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateLightReading ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">Show Avatars in Reading Mode</h3>
                            <p className="text-[11px] text-slate-400 mt-1">Shows each side's avatar next to their Date log entries</p>
                        </div>
                        <button
                            onClick={() => updateCharacter(char.id, { dateReadingShowAvatars: !char.dateReadingShowAvatars })}
                            type="button"
                            role="switch"
                            aria-checked={!!char.dateReadingShowAvatars}
                            aria-label="Toggle reading mode avatars"
                            className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateReadingShowAvatars ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateReadingShowAvatars ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>
                </section>

                <ObserveSettings char={char} />

                <Section title="Writing Style & Narrative">
                    <p className="text-[11px] text-slate-400 mt-1 mb-4">Adjusts the AI's writing style and narrative person during Date. Changes take effect starting with the next reply.</p>

                    {/* Writing style */}
                    <div className="mb-5">
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">Writing Style</label>
                        <div className="flex flex-wrap gap-2">
                            {DATE_STYLE_PRESETS.map(p => {
                                const active = (styleConfig.style || 'cinematic') === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => patchStyleConfig({ style: p.id })}
                                        className={`px-3.5 py-2 rounded-full text-xs font-bold transition-all active:scale-95 ${active ? 'bg-primary text-white shadow-md shadow-primary/20' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                    >
                                        {p.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                            {DATE_STYLE_PRESETS.find(p => p.id === (styleConfig.style || 'cinematic'))?.hint}
                        </p>
                    </div>

                    {/* Narrative person */}
                    <div className="mb-5">
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">Narrative Person</label>
                        <div className="space-y-2">
                            {POV_OPTIONS.map(opt => {
                                const active = styleConfig.pov === opt.id;
                                return (
                                    <button
                                        key={opt.id || 'default'}
                                        onClick={() => patchStyleConfig({ pov: opt.id })}
                                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-all active:scale-[0.98] ${active ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-slate-100 bg-slate-50 hover:bg-slate-100'}`}
                                    >
                                        <span className={`text-xs font-bold ${active ? 'text-primary' : 'text-slate-600'}`}>{opt.label}</span>
                                        <span className="text-[11px] text-slate-400 italic">{opt.example}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Detail digging guidance */}
                    <div className="mb-5 flex items-center justify-between">
                        <div className="pr-4">
                            <label className="text-[11px] text-slate-500 font-bold block">Detail Digging Guidance</label>
                            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">Teaches the AI to dig writable detail out of any line, and gives a different focus cue each turn, cutting down on empty filler and model tics.</p>
                        </div>
                        <button
                            onClick={() => patchStyleConfig({ digDeeper: styleConfig.digDeeper === false ? undefined : false })}
                            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${styleConfig.digDeeper !== false ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${styleConfig.digDeeper !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>

                    {/* Custom addition */}
                    <div>
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">Custom Addition (Optional)</label>
                        <textarea
                            value={extraDraft}
                            onChange={e => setExtraDraft(e.target.value)}
                            onBlur={saveExtraDraft}
                            placeholder="e.g. write more environment interaction; skip inner monologue; more dialogue..."
                            className="w-full h-20 px-4 py-3 bg-slate-100 rounded-xl text-sm resize-none focus:ring-1 focus:ring-primary/30 outline-none transition-all leading-relaxed"
                        />
                        <p className="text-[10px] text-slate-300 mt-1">Tapping elsewhere saves it automatically; this text is used verbatim and takes priority over the style above.</p>
                    </div>
                </Section>

                <Section title="Background">
                    <div
                        onClick={() => triggerUpload('bg')}
                        className="aspect-video bg-slate-200 rounded-xl overflow-hidden relative border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer hover:border-primary group"
                    >
                        {char.dateBackground ? (
                            <>
                                <TokenImg value={char.dateBackground} className="w-full h-full object-cover" />
                                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-xs font-bold">Change Background</span></div>
                            </>
                        ) : <span className="text-slate-400 text-xs">+ Upload Background Image</span>}
                    </div>
                </Section>

                <Section title="Base Emotion Portraits">
                    <div className="grid grid-cols-3 gap-3">
                        {REQUIRED_EMOTIONS.map(key => (
                            <div key={key} onClick={() => triggerUpload('sprite', key)} className="flex flex-col gap-2 group cursor-pointer">
                                <div className={`aspect-[3/4] rounded-xl overflow-hidden relative border ${sprites[key] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-100'} shadow-sm flex items-center justify-center transition-all group-hover:border-primary`}>
                                    {sprites[key] ? (
                                        <>
                                            <TokenImg value={sprites[key]} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[10px]">Change</span></div>
                                        </>
                                    ) : <span className="text-slate-300 text-2xl">+</span>}
                                </div>
                                <div className="text-center">
                                    <div className="text-xs font-bold text-slate-600 capitalize">{key}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>

                <Section title="Custom Emotions">
                    <p className="text-[11px] text-slate-400 mb-4">Add emotions unique to this character; the AI uses them during Date. Custom emotions are independent per character.</p>

                    {/* Existing custom emotions grid */}
                    {customEmotions.length > 0 && (
                        <div className="grid grid-cols-3 gap-3 mb-4">
                            {customEmotions.map(key => (
                                <div key={key} className="flex flex-col gap-2 group relative">
                                    <div
                                        onClick={() => triggerUpload('sprite', key)}
                                        className={`aspect-[3/4] rounded-xl overflow-hidden relative border ${sprites[key] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-100'} shadow-sm flex items-center justify-center transition-all group-hover:border-primary cursor-pointer`}
                                    >
                                        {sprites[key] ? (
                                            <>
                                                <TokenImg value={sprites[key]} className="w-full h-full object-cover" />
                                                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[10px]">Change</span></div>
                                            </>
                                        ) : <span className="text-slate-300 text-2xl">+</span>}
                                    </div>
                                    <div className="text-center flex items-center justify-center gap-1">
                                        <div className="text-xs font-bold text-slate-600 capitalize truncate">{key}</div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteCustomEmotion(key); }}
                                            className="text-slate-300 hover:text-red-400 transition-colors shrink-0"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Add new custom emotion */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newEmotionName}
                            onChange={e => setNewEmotionName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleAddCustomEmotion(); }}
                            placeholder="Enter emotion name (e.g. scared, excited...)"
                            className="flex-1 px-4 py-3 bg-slate-100 rounded-xl text-sm focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                        />
                        <button
                            onClick={handleAddCustomEmotion}
                            disabled={!newEmotionName.trim()}
                            className="px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-all"
                        >
                            Add
                        </button>
                    </div>
                </Section>

                {/* URL Upload for Default Sprites */}
                <Section title="Image Host URL Upload">
                    <p className="text-[11px] text-slate-400 mb-3">Paste an image URL directly to use as the default portrait</p>
                    <button
                        onClick={() => { setUrlTargetSkinId(null); setShowUrlModal(true); }}
                        className="w-full py-2.5 bg-slate-100 text-slate-600 text-sm font-medium rounded-xl hover:bg-slate-200 transition-colors active:scale-95"
                    >
                        + Add Portrait via URL
                    </button>
                </Section>

                {/* Skin Sets System */}
                <Section title="Skin Sets">
                    <p className="text-[11px] text-slate-400 mb-4">Create multiple portrait skins for this character. After switching skins, the AI uses that skin's emotion portraits.</p>

                    {/* Active skin indicator */}
                    <div className="mb-4 flex items-center gap-2 text-xs">
                        <span className="text-slate-400">Currently active:</span>
                        <span className="font-bold text-slate-700">{activeSkinId ? (skinSets.find(s => s.id === activeSkinId)?.name || 'Unknown') : 'Default Portrait'}</span>
                        {activeSkinId && (
                            <button onClick={() => handleActivateSkin(null)} className="text-[10px] text-primary underline">Switch back to default</button>
                        )}
                    </div>

                    {/* Existing skin sets */}
                    <div className="space-y-3 mb-4">
                        {skinSets.map(skin => (
                            <div key={skin.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden ${activeSkinId === skin.id ? 'border-primary ring-1 ring-primary/20' : 'border-slate-100'}`}>
                                <div className="p-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold text-sm text-slate-700">{skin.name}</span>
                                        <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{Object.keys(skin.sprites).length} emotions</span>
                                        {activeSkinId === skin.id && <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold">In Use</span>}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {activeSkinId !== skin.id && (
                                            <button onClick={() => handleActivateSkin(skin.id)} className="text-[10px] text-primary font-bold px-2 py-1 rounded-lg hover:bg-primary/5 transition-colors">Activate</button>
                                        )}
                                        <button onClick={() => setEditingSkinId(editingSkinId === skin.id ? null : skin.id)} className="text-[10px] text-slate-500 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors">
                                            {editingSkinId === skin.id ? 'Collapse' : 'Edit'}
                                        </button>
                                        <button onClick={() => handleDeleteSkinSet(skin.id)} className="text-slate-300 hover:text-red-400 transition-colors p-1">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>

                                {/* Expanded edit view */}
                                {editingSkinId === skin.id && (
                                    <div className="border-t border-slate-100 p-3">
                                        <div className="grid grid-cols-3 gap-2 mb-3">
                                            {[...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])].map(emoKey => (
                                                <div key={emoKey} onClick={() => triggerSkinSpriteUpload(skin.id, emoKey)} className="flex flex-col gap-1 group cursor-pointer">
                                                    <div className={`aspect-[3/4] rounded-lg overflow-hidden relative border ${skin.sprites[emoKey] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50'} flex items-center justify-center transition-all group-hover:border-primary`}>
                                                        {skin.sprites[emoKey] ? (
                                                            <>
                                                                <TokenImg value={skin.sprites[emoKey]} className="w-full h-full object-cover" />
                                                                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[9px]">Change</span></div>
                                                            </>
                                                        ) : <span className="text-slate-300 text-lg">+</span>}
                                                    </div>
                                                    <div className="text-[10px] font-bold text-slate-500 capitalize text-center truncate">{emoKey}</div>
                                                </div>
                                            ))}
                                        </div>
                                        <button
                                            onClick={() => { setUrlTargetSkinId(skin.id); setShowUrlModal(true); }}
                                            className="w-full py-2 bg-slate-50 text-slate-500 text-[11px] font-medium rounded-lg hover:bg-slate-100 transition-colors"
                                        >
                                            + Add Portrait to This Skin via URL
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Create new skin set */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newSkinName}
                            onChange={e => setNewSkinName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleCreateSkinSet(); }}
                            placeholder="Skin name (e.g. Winter Outfit, Swimsuit...)"
                            className="flex-1 px-4 py-3 bg-slate-100 rounded-xl text-sm focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                        />
                        <button
                            onClick={handleCreateSkinSet}
                            disabled={!newSkinName.trim()}
                            className="px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-all"
                        >
                            Create
                        </button>
                    </div>
                </Section>

                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
            </div>

            {/* URL Input Modal */}
            {showUrlModal && (
                <div className="fixed inset-0 z-[300] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setShowUrlModal(false)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-slate-100">
                            <h3 className="font-bold text-slate-700 text-sm">Add Portrait via URL</h3>
                            <p className="text-[11px] text-slate-400 mt-1">{urlTargetSkinId ? `Target: ${skinSets.find(s => s.id === urlTargetSkinId)?.name}` : 'Target: Default Portrait'}</p>
                        </div>
                        <div className="p-4 space-y-3">
                            <div>
                                <label className="text-[11px] text-slate-500 font-bold mb-1 block">Emotion</label>
                                <select
                                    value={skinUrlEmotionKey}
                                    onChange={e => setSkinUrlEmotionKey(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-slate-100 rounded-xl text-sm outline-none"
                                >
                                    <option value="">Select emotion...</option>
                                    {[...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])].map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-[11px] text-slate-500 font-bold mb-1 block">Image URL</label>
                                <input
                                    type="text"
                                    value={skinUrlInput}
                                    onChange={e => setSkinUrlInput(e.target.value)}
                                    placeholder="https://example.com/sprite.png"
                                    className="w-full px-3 py-2.5 bg-slate-100 rounded-xl text-sm outline-none focus:ring-1 focus:ring-primary/30"
                                />
                            </div>
                            {skinUrlInput && skinUrlInput.startsWith('http') && (
                                <div className="bg-slate-50 rounded-xl p-2 flex items-center justify-center h-24">
                                    <img src={skinUrlInput} className="max-h-full max-w-full object-contain rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                </div>
                            )}
                        </div>
                        <div className="p-4 border-t border-slate-100 flex gap-2">
                            <button onClick={() => setShowUrlModal(false)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 font-bold text-sm rounded-xl">Cancel</button>
                            <button onClick={handleUrlSubmit} disabled={!skinUrlInput.trim() || !skinUrlEmotionKey} className="flex-1 py-2.5 bg-primary text-white font-bold text-sm rounded-xl disabled:opacity-40 active:scale-95 transition-all">Confirm Add</button>
                        </div>
                    </div>
                </div>
            )}

            <div className="p-4 border-t border-slate-200 bg-white/90 backdrop-blur-sm sticky bottom-0 z-20">
                <button onClick={handleSaveSettings} className="w-full py-3 bg-primary text-white font-bold rounded-2xl shadow-lg active:scale-95 transition-transform">
                    Save Current Setup
                </button>
            </div>
        </div>
    );
};

export default DateSettings;
