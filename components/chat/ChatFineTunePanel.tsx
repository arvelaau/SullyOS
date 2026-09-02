import React from 'react';
import { ChatFineTuneFields } from '../../types';

/**
 * Chat detail fine-tuning control group (avatar show/hide / position / edge-snap / alignment /
 * vertical offset, font size, line height, bubble indent, etc.).
 * Reused in two places, with consistent interaction (bucket buttons + slider):
 *  - The Appearance App's "Chat Detail Fine-Tuning" section (global, value = osTheme)
 *  - The in-chat "Chat Styling" modal (per-character override, value = the merged effective value,
 *    onChange writes into char.chatFineTune)
 * Only renders the controls themselves — the surrounding section shell / toggle / copy is up to the caller.
 */
type Props = {
    value: ChatFineTuneFields;
    onChange: (patch: Partial<ChatFineTuneFields>) => void;
};

const OptionButton: React.FC<{ active: boolean; label: string; desc?: string; onClick: () => void }> = ({ active, label, desc, onClick }) => (
    <button onClick={onClick}
        className={`px-3 py-2 text-[11px] font-bold rounded-xl border transition-all active:scale-95 ${active ? 'bg-primary/10 text-primary border-primary/30 ring-1 ring-primary/20' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
        <div>{label}</div>
        {desc && <div className="text-[9px] font-normal mt-0.5 opacity-70">{desc}</div>}
    </button>
);

export const ChatFineTunePanel: React.FC<Props> = ({ value, onChange }) => {
    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">Avatar Display</h3>
                <div className="flex gap-2 flex-wrap">
                    {([['both', 'Show all'], ['hide_ai', 'Hide character side'], ['hide_user', 'Hide mine'], ['hide_both', 'Hide all']] as const).map(([v, label]) => (
                        <OptionButton key={v} active={(value.chatAvatarVisibility || 'both') === v} label={label} onClick={() => onChange({ chatAvatarVisibility: v })} />
                    ))}
                </div>
                {(value.chatAvatarVisibility || 'both') !== 'both' && (
                    <label className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                        <input type="checkbox" checked={!!value.chatSnapToEdge} onChange={(e) => onChange({ chatSnapToEdge: e.target.checked })} className="accent-current" />
                        Snap the hidden side's bubbles to the edge (close the empty avatar gap)
                    </label>
                )}
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">Avatar Position</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={(value.chatAvatarPlacement || 'beside') === 'beside'} label="Beside bubble (default)" desc="Follows how often the avatar appears" onClick={() => onChange({ chatAvatarPlacement: 'beside' })} />
                    <OptionButton active={value.chatAvatarPlacement === 'above_group'} label="Above each round" desc="Consecutive bubbles share one avatar" onClick={() => onChange({ chatAvatarPlacement: 'above_group' })} />
                </div>
            </div>
            {(value.chatAvatarPlacement || 'beside') === 'beside' && (
                <div>
                    <h3 className="text-[11px] font-bold text-slate-500 mb-2">Avatar Alignment to Bubble</h3>
                    <div className="flex gap-2 flex-wrap">
                        {([['bottom', 'Bottom (default)'], ['top', 'Top'], ['center', 'Center']] as const).map(([v, label]) => (
                            <OptionButton key={v} active={(value.chatAvatarAlign || 'bottom') === v} label={label} onClick={() => onChange({ chatAvatarAlign: v })} />
                        ))}
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                        <span className="text-[11px] text-slate-500 shrink-0">Vertical offset</span>
                        <input type="range" min={-16} max={16} step={2} value={value.chatAvatarOffsetY || 0}
                            onChange={(e) => onChange({ chatAvatarOffsetY: Number(e.target.value) })} className="flex-1 accent-current" />
                        <span className="text-[11px] font-mono text-slate-500 w-10 text-right">{value.chatAvatarOffsetY || 0}px</span>
                    </div>
                </div>
            )}
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">Bubble Text Size</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleFontSize} label="Default" onClick={() => onChange({ chatBubbleFontSize: 0 })} />
                    {[12, 13, 14, 15, 16].map(v => (
                        <OptionButton key={v} active={value.chatBubbleFontSize === v} label={`${v}px`} onClick={() => onChange({ chatBubbleFontSize: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">Bubble Line Height</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleLineHeight} label="Default" onClick={() => onChange({ chatBubbleLineHeight: 0 })} />
                    {[1.2, 1.35, 1.5, 1.7].map(v => (
                        <OptionButton key={v} active={value.chatBubbleLineHeight === v} label={String(v)} onClick={() => onChange({ chatBubbleLineHeight: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">Bubble-to-Avatar Spacing</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleIndent} label="Default (48px)" onClick={() => onChange({ chatBubbleIndent: 0 })} />
                    {[28, 60, 72].map(v => (
                        <OptionButton key={v} active={value.chatBubbleIndent === v} label={`${v}px`} onClick={() => onChange({ chatBubbleIndent: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">HTML / Psyche / Music Card Position</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={(value.chatModuleAlign || 'center') === 'center'} label="Horizontally centered (default)" desc="Card-type content shown centered" onClick={() => onChange({ chatModuleAlign: 'center' })} />
                    <OptionButton active={value.chatModuleAlign === 'anchor'} label="Snap to bubble column" desc="Same side as the bubble, legacy look" onClick={() => onChange({ chatModuleAlign: 'anchor' })} />
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">Horizontal position of HTML cards, Psyche (thinking chain) cards, and Music (listen together) cards sent by the character. Cards aren't visible in the preview — check the effect in chat.</p>
            </div>
        </div>
    );
};

export default ChatFineTunePanel;
