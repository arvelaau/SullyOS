import React, { useRef, useState } from 'react';
import {
    BUILTIN_SOUNDS,
    WhiteboxSound,
    playWhiteboxSound,
    unlockWhiteboxAudio,
    isCustomAudioSrc,
    encodeSoundShare,
    decodeSoundShare,
} from '../../utils/whiteboxSound';

// Whitebox "notification sound" editor (independent of Whitebox CSS).
//
// Trigger timing (playback logic is in apps/Chat.tsx): plays once only when "a new message they just sent"
// becomes the last message in the conversation; you sending a message yourself, or scrolling back through
// old history, never triggers it.
//
// Storage and sharing:
// - Default is "unbound" -- the sound lives independently in the character's own field, keeping the Whitebox
//   share code lightweight and pure CSS. The sound can be shared separately using the "share code" below.
// - Turning on "Bind to Whitebox" -- the sound gets written into a directive comment inside the Whitebox CSS,
//   and shared together with it (can be unbound again at any time).
// This component doesn't care where it's stored -- it only emits (sound, bound) changes; where they land is up to Chat.tsx.

// Size cap for converting an uploaded audio file to a data URI: when bound-shared it goes into the share code,
// so anything too large would blow it up; a notification sound should be short anyway, 200KB is plenty.
const MAX_UPLOAD_BYTES = 200 * 1024;

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

interface Props {
    sound: WhiteboxSound | null;
    onChangeSound: (sound: WhiteboxSound | null) => void;
    /** The "Bind to Whitebox" toggle; the global default sound doesn't involve binding, pass false to hide it. Shown by default. */
    showBind?: boolean;
    bound?: boolean;
    onChangeBound?: (bound: boolean) => void;
    /** The top hint bar's copy (distinguishes the "per-character version" from the "global default version"). */
    hint?: React.ReactNode;
}

const WhiteboxSoundEditor: React.FC<Props> = ({ sound, onChangeSound, showBind = true, bound = false, onChangeBound, hint }) => {
    const volume = sound?.volume ?? 0.6;
    const src = sound?.src || '';
    const isBuiltin = !!BUILTIN_SOUNDS[src];
    const isCustom = !!src && isCustomAudioSrc(src);
    const isUpload = isCustom && !/^https?:/i.test(src);

    const [urlDraft, setUrlDraft] = useState(isCustom && /^https?:/i.test(src) ? src : '');
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const pickBuiltin = (key: string) => {
        unlockWhiteboxAudio();
        const next = { src: key, volume };
        onChangeSound(next);
        playWhiteboxSound(next); // Preview it with a single tap
    };

    const setVolume = (v: number) => {
        if (!src) return;
        onChangeSound({ src, volume: v });
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('audio/')) { window.alert('Please choose an audio file (mp3 / wav / ogg, etc).'); return; }
        if (file.size > MAX_UPLOAD_BYTES) {
            window.alert(`Audio file too large (${Math.round(file.size / 1024)}KB). It goes into the share code when bound-shared with Whitebox, so please use a short sound of ${MAX_UPLOAD_BYTES / 1024}KB or less, or use an "Audio URL" instead.`);
            return;
        }
        setBusy(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            unlockWhiteboxAudio();
            const next = { src: dataUrl, volume };
            onChangeSound(next);
            playWhiteboxSound(next);
        } catch {
            window.alert('Failed to read the audio file. Please try a different file.');
        } finally {
            setBusy(false);
        }
    };

    const applyUrl = () => {
        const u = urlDraft.trim();
        if (!u) return;
        if (!/^https?:\/\//i.test(u)) { window.alert('Please enter a direct audio link starting with http(s)://.'); return; }
        unlockWhiteboxAudio();
        const next = { src: u, volume };
        onChangeSound(next);
        playWhiteboxSound(next);
    };

    const clearSound = () => { onChangeSound(null); setUrlDraft(''); };

    const handleShareExport = async () => {
        if (!sound) return;
        const ok = await copyText(encodeSoundShare(sound));
        window.alert(ok ? 'Copied the sound share code -- send it to someone else, and they can paste it to import (Whitebox skin not included).' : 'Copy failed. Please try again.');
    };
    const handleShareImport = () => {
        const code = window.prompt('Paste a sound share code (SULLYSND1:...):', '')?.trim();
        if (!code) return;
        const incoming = decodeSoundShare(code);
        if (!incoming) { window.alert('Could not recognize the share code. Please make sure you pasted the whole thing.'); return; }
        unlockWhiteboxAudio();
        onChangeSound(incoming);
        playWhiteboxSound(incoming);
    };

    const chipCls = (active: boolean) =>
        `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-95 ${
            active ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
        }`;

    return (
        <div className="space-y-4">
            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-700">
                {hint ?? <>🔔 The notification sound only plays once when <b>a new message they sent becomes the latest one</b>; sending a message yourself, or scrolling back through old history, never triggers it.</>}
            </div>

            {/* Built-in sounds */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">Built-in Sounds <span className="font-normal text-slate-400">- tap to preview and select</span></div>
                <div className="flex flex-wrap gap-1.5">
                    {Object.entries(BUILTIN_SOUNDS).map(([key, s]) => (
                        <button key={key} onClick={() => pickBuiltin(key)} className={chipCls(isBuiltin && src === key)}>
                            {isBuiltin && src === key ? '✓ ' : ''}{s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Upload / URL */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">Custom <span className="font-normal text-slate-400">- upload audio (≤200KB) or enter a direct link</span></div>
                <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleUpload} />
                    <button
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-100 disabled:opacity-50"
                    >{busy ? 'Loading…' : '⬆ Upload Audio File'}</button>
                    {isUpload && (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-600">Uploaded audio embedded ✓</span>
                    )}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                    <input
                        value={urlDraft}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
                        placeholder="https://…/ding.mp3"
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-600 outline-none focus:border-indigo-300"
                    />
                    <button onClick={applyUrl} className="shrink-0 rounded-xl bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-200">Use This Link</button>
                </div>
            </div>

            {/* Volume + preview + turn off */}
            <div>
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">Volume</span>
                    <span className="text-[10px] text-slate-400">{Math.round(volume * 100)}%</span>
                </div>
                <input
                    type="range" min={0} max={1} step={0.05} value={volume}
                    disabled={!src}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-full accent-indigo-500 disabled:opacity-40"
                />
                <div className="mt-3 flex items-center gap-2">
                    <button
                        onClick={() => { unlockWhiteboxAudio(); playWhiteboxSound(sound); }}
                        disabled={!src}
                        className="rounded-xl bg-indigo-500 px-4 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-600 disabled:opacity-40"
                    >▶ Preview</button>
                    {src && (
                        <button onClick={clearSound} className="rounded-xl px-3 py-1.5 text-[11px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">Turn Off Sound</button>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400">
                        {src ? (isBuiltin ? 'Current: built-in sound' : 'Current: custom audio') : 'Current: none'}
                    </span>
                </div>
            </div>

            {/* Bind to Whitebox toggle (hidden for the global default version) */}
            {showBind && (
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3.5 py-3">
                    <label className="flex cursor-pointer items-start gap-3">
                        <input
                            type="checkbox"
                            checked={bound}
                            onChange={(e) => onChangeBound?.(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
                        />
                        <span className="min-w-0">
                            <span className="block text-[12px] font-bold text-slate-700">Bind to Whitebox and share together</span>
                            <span className="block text-[10px] leading-snug text-slate-400">
                                {bound
                                    ? 'Bound: sharing this Whitebox will include the notification sound (uploaded audio goes into the share code and may make it larger).'
                                    : 'Unbound: the Whitebox share code stays lightweight and skin-only; share the sound separately with the code below.'}
                            </span>
                        </span>
                    </label>
                </div>
            )}

            {/* Standalone share code for the notification sound */}
            <div className="flex items-center gap-2">
                <button onClick={handleShareImport} className="rounded-lg px-2.5 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">Import Share Code</button>
                <button onClick={handleShareExport} disabled={!sound} className={`rounded-lg px-2.5 py-1 text-[10px] font-semibold ${sound ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>Export Share Code</button>
                <span className="ml-auto text-[10px] text-slate-300">SULLYSND1 · share the sound separately</span>
            </div>
        </div>
    );
};

export default WhiteboxSoundEditor;
