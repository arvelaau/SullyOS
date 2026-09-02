
import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { CharacterProfile } from '../../types';

interface ProactiveSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    isProactiveActive: boolean;
    onSave: (config: NonNullable<CharacterProfile['proactiveConfig']>) => void;
    onStop: () => void;
}

const INTERVAL_OPTIONS = [
    { label: '30 min', value: 30 },
    { label: '1 hr', value: 60 },
    { label: '2 hr', value: 120 },
    { label: '4 hr', value: 240 },
    { label: '8 hr', value: 480 },
    { label: '12 hr', value: 720 },
    { label: '24 hr', value: 1440 },
];

const ProactiveSettingsModal: React.FC<ProactiveSettingsModalProps> = ({
    isOpen, onClose, char, isProactiveActive, onSave, onStop
}) => {
    const saved = char.proactiveConfig;
    const [enabled, setEnabled] = useState(saved?.enabled ?? false);
    const [interval, setInterval_] = useState(saved?.intervalMinutes ?? 60);
    const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
    const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
    const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
    const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
    const [showApiSection, setShowApiSection] = useState(saved?.useSecondaryApi ?? false);

    // Reset form when modal opens with new char data
    useEffect(() => {
        if (isOpen) {
            const s = char.proactiveConfig;
            setEnabled(s?.enabled ?? false);
            setInterval_(s?.intervalMinutes ?? 60);
            setUseSecondaryApi(s?.useSecondaryApi ?? false);
            setSecUrl(s?.secondaryApi?.baseUrl ?? '');
            setSecKey(s?.secondaryApi?.apiKey ?? '');
            setSecModel(s?.secondaryApi?.model ?? '');
            setShowApiSection(s?.useSecondaryApi ?? false);
        }
    }, [isOpen, char.id]);

    const handleSave = () => {
        onSave({
            enabled,
            intervalMinutes: interval,
            useSecondaryApi: useSecondaryApi && !!secUrl,
            secondaryApi: useSecondaryApi && secUrl ? {
                baseUrl: secUrl,
                apiKey: secKey,
                model: secModel,
            } : undefined,
        });
        onClose();
    };

    const handleStop = () => {
        onStop();
        setEnabled(false);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} title="Proactive Message" onClose={onClose} footer={
            <>
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                    Cancel
                </button>
                {isProactiveActive ? (
                    <button onClick={handleStop} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                        Stop
                    </button>
                ) : null}
                <button onClick={handleSave} className="flex-1 py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                    {enabled ? 'Start' : 'Save'}
                </button>
            </>
        }>
            <div className="space-y-5">
                {/* Description */}
                <p className="text-xs text-slate-400 leading-relaxed">
                    Once enabled, {char.name} will proactively message you at the set interval, like a real person sending you a message on a whim.
                </p>

                {/* Enable Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-700">Enable Proactive Message</span>
                    <button
                        onClick={() => setEnabled(!enabled)}
                        className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Status indicator */}
                {isProactiveActive && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 rounded-xl border border-violet-100">
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
                        <span className="text-xs text-violet-600 font-medium">Proactive message in progress</span>
                    </div>
                )}

                {/* Interval Selection */}
                {enabled && (
                    <>
                        <div>
                            <label className="text-sm font-bold text-slate-700 block mb-2">Send Interval</label>
                            <div className="grid grid-cols-3 gap-2">
                                {INTERVAL_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setInterval_(opt.value)}
                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all ${interval === opt.value
                                            ? 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Secondary API Toggle */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-bold text-slate-700">Use Secondary API</span>
                                <button
                                    onClick={() => { setUseSecondaryApi(!useSecondaryApi); setShowApiSection(!useSecondaryApi); }}
                                    className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-violet-500' : 'bg-slate-200'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                Use a separate API to send proactive messages, so they do not eat into your main API quota. If off, the main API is used.
                            </p>

                            {showApiSection && (
                                <div className="space-y-3 bg-slate-50 rounded-2xl p-3">
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">API URL</label>
                                        <input
                                            type="text"
                                            value={secUrl}
                                            onChange={e => setSecUrl(e.target.value)}
                                            placeholder="https://api.example.com/v1"
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">API Key</label>
                                        <input
                                            type="password"
                                            value={secKey}
                                            onChange={e => setSecKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 font-medium block mb-1">Model</label>
                                        <input
                                            type="text"
                                            value={secModel}
                                            onChange={e => setSecModel(e.target.value)}
                                            placeholder="gpt-4o-mini"
                                            className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200 focus:border-violet-300 focus:outline-none transition-colors"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ProactiveSettingsModal);
