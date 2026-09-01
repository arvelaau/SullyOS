import React from 'react';

/**
 * 瑞一杯 使用说明 (首次启动自动弹一次, 之后收在 banner 的 ? 里随时看)
 *
 * 瑞幸 MCP 跟麦当劳逻辑不同: 拉不到整本菜单, 是"告诉角色哪家店的哪杯"由角色去点。
 */
const LuckinHelpModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-gradient-to-b from-[#FAF7F0] to-[#F3EFE6] w-full sm:max-w-sm rounded-2xl overflow-hidden shadow-2xl flex flex-col" style={{ maxHeight: 'calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 2rem)' }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C] rounded-t-2xl shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xl">🦌</span>
                        <div>
                            <div className="text-[13px] font-bold text-white">瑞一杯 · How it works</div>
                            <div className="text-[9px] text-white/70">A bit different from McDonald's — take 30 seconds to check it out</div>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white active:scale-90">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3 text-[12px] text-slate-700 leading-relaxed">
                    {/* 核心 */}
                    <div className="bg-white rounded-xl border border-[#E6DFCF] p-3">
                        <div className="text-[12px] font-bold text-[#0B1F3A] mb-1">☕ Just tell them "which drink at which store"</div>
                        <div>Luckin works differently from McDonald's — <b>it can't pull the full menu</b>. Just tell the character what you want to drink and roughly where you are, and they'll automatically find the best-matching store, place the order, and bring up a WeChat QR code to pay.</div>
                        <div className="mt-2 bg-[#0B1F3A]/5 rounded-lg px-2.5 py-2 text-[11px] text-[#0B1F3A]">
                            Example:<br />"Order me a <b>sugar-free iced Americano</b> from the store near <b>Huaxi Park</b>"
                        </div>
                    </div>

                    {/* 门店 */}
                    <div className="flex gap-2">
                        <span className="text-[15px] shrink-0">📍</span>
                        <div>If you <b>don't specify a store</b>, the character picks the nearest one based on your <b>current location</b>. <span className="text-amber-700">Location may be inaccurate if you're on a VPN</span> (you can check the accuracy in the location popup that appears on launch — pick a city manually if it's off).</div>
                    </div>

                    {/* 自动选 */}
                    <div className="flex gap-2">
                        <span className="text-[15px] shrink-0">🎯</span>
                        <div>If you <b>don't specify the drink / size / hot-or-iced</b>, the character will <b>use their own judgment</b> based on how well they know you (the better they know you, the more accurate the order — if you don't like it, just say "switch it up / make it hot / large size").</div>
                    </div>

                    {/* 测试版优惠 */}
                    <div className="flex gap-2">
                        <span className="text-[15px] shrink-0">🧪</span>
                        <div><b>This is currently a beta</b>: official Luckin store promotions can't be used — <b>only coupons on your own account</b> get auto-applied.</div>
                    </div>

                    <div className="text-[10px] text-slate-400 text-center pt-1">Ordering / payment both happen on the final "checkout card" — the item cards are just for the character to show you</div>
                </div>

                <div className="border-t border-[#DDD3BC] bg-gradient-to-r from-[#EFE9DC] to-[#E7DFC9] px-3 py-2.5 shrink-0">
                    <button onClick={onClose} className="w-full px-3 py-2.5 bg-[#0B1F3A] text-white text-[13px] font-bold rounded-xl active:scale-95">Got it, let's order</button>
                </div>
            </div>
        </div>
    );
};

export default LuckinHelpModal;
