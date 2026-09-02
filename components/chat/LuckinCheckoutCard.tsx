import React, { useEffect, useMemo, useState } from 'react';
import { callLuckinTool } from '../../utils/luckinMcpClient';
import { luckinItemEmoji } from '../../utils/luckinEmoji';
import PayQr from '../luckin/PayQr';

/**
 * Luckin checkout card (the endpoint of the chat ordering flow)
 *
 * After the character calls previewOrder, this card renders in chat:
 *  - Lists the items the character picked out (including the spec, additionDesc); the user can adjust quantity again
 *  - Adjusting quantity automatically re-runs previewOrder to refresh price/discounts
 *  - "Place order & pay" -> the frontend calls createOrder -> shows a WeChat Pay QR code directly (scan to pay)
 *
 * Ordering/paying only happens when the user taps this card themself; the character never calls createOrder on their own.
 */

interface Line {
    productId: number | string;
    skuCode: string;
    name: string;
    spec?: string;        // additionDesc, e.g. "Hot / Large"
    image?: string;
    unitPrice?: number;   // estimatePrice
    qty: number;
}

const fmtMoney = (v: any): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return String(v);
    return `¥${n.toFixed(2)}`;
};

const buildLines = (args: any, preview: any): Line[] => {
    // Prefer the productInfoList echoed back by previewOrder (includes name/spec/final price)
    const info = Array.isArray(preview?.productInfoList) ? preview.productInfoList : null;
    if (info && info.length) {
        return info.map((p: any) => ({
            productId: p.productId,
            skuCode: p.skuCode,
            name: p.name || 'Luckin Item',
            spec: p.additionDesc || undefined,
            image: p.breviaryPicUrl || p.bigPicUrl || undefined,
            unitPrice: typeof p.estimatePrice === 'number' ? p.estimatePrice : (typeof p.estimatePrice === 'string' ? parseFloat(p.estimatePrice) : undefined),
            qty: typeof p.amount === 'number' ? p.amount : 1,
        }));
    }
    // Fallback: use the productList passed into previewOrder
    const pl = Array.isArray(args?.productList) ? args.productList : [];
    return pl.map((p: any) => ({
        productId: p.productId,
        skuCode: p.skuCode,
        name: p.skuCode || 'Luckin Item',
        qty: typeof p.amount === 'number' ? p.amount : 1,
    }));
};

const LuckinCheckoutCard: React.FC<{
    deptId: number | string;
    args: any;            // previewOrder's input, {deptId, productList}
    preview: any;         // previewOrder's return value
    loc?: { longitude?: number; latitude?: number };
}> = ({ deptId, args, preview: initialPreview, loc }) => {
    const [lines, setLines] = useState<Line[]>(() => buildLines(args, initialPreview));
    const [preview, setPreview] = useState<any>(initialPreview);
    const [calcing, setCalcing] = useState(false);
    const [paying, setPaying] = useState(false);
    const [payErr, setPayErr] = useState<string | null>(null);
    const [order, setOrder] = useState<any>(null);

    const productList = () => lines.filter(l => l.qty > 0).map(l => ({ amount: l.qty, productId: l.productId, skuCode: l.skuCode }));
    const hash = useMemo(() => lines.map(l => `${l.skuCode}x${l.qty}`).sort().join('|'), [lines]);
    const firstHash = useMemo(() => buildLines(args, initialPreview).map(l => `${l.skuCode}x${l.qty}`).sort().join('|'), []);

    // Quantity changed -> recalculate price (skip the initial pass, no need to recompute it)
    useEffect(() => {
        if (order) return;                 // Order already placed, locked
        if (hash === firstHash) return;    // Unchanged, use the initial preview
        if (!productList().length) { setPreview(null); return; }
        let cancelled = false;
        setCalcing(true);
        callLuckinTool('previewOrder', { deptId, productList: productList() }).then((r: any) => {
            if (cancelled) return;
            if (r.success) setPreview(r.data);
            setCalcing(false);
        }).catch(() => { if (!cancelled) setCalcing(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hash]);

    const changeQty = (sku: string, d: number) => {
        if (order) return;
        setLines(prev => prev.map(l => l.skuCode === sku ? { ...l, qty: Math.max(0, Math.min(20, l.qty + d)) } : l).filter(l => l.qty > 0 || d > 0));
    };

    const pay = async () => {
        if (paying || order) return;
        if (!productList().length) { setPayErr('The cart is empty'); return; }
        setPaying(true); setPayErr(null);
        try {
            const a: any = { deptId, productList: productList() };
            if (loc?.longitude != null) a.longitude = loc.longitude;
            if (loc?.latitude != null) a.latitude = loc.latitude;
            const coupons = preview?.couponCodeList;
            if (Array.isArray(coupons) && coupons.length) a.couponCodeList = coupons;
            const r = await callLuckinTool('createOrder', a);
            if (!r.success) throw new Error(r.error || 'Order failed');
            setOrder(r.data);
        } catch (e: any) {
            setPayErr(e?.message || String(e));
        } finally {
            setPaying(false);
        }
    };

    const finalPrice = preview?.discountPrice;
    const original = preview?.totalInitialPrice;
    const privilege = preview?.privilegeMoney;
    const localTotal = lines.reduce((s, l) => s + (l.unitPrice || 0) * l.qty, 0);
    const payUrl = order?.payOrderUrl;
    const qrUrl = order?.payOrderQrCodeUrl;
    const orderId = order?.orderIdStr || order?.orderId;

    return (
        <div className="w-72 rounded-2xl overflow-hidden border border-[#E6DFCF] shadow-sm bg-gradient-to-br from-[#FAF7F0] to-[#F3EFE6]">
            <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C]">
                <span className="text-lg">🦌</span>
                <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-white">Luckin · Checkout</div>
                    <div className="text-[9px] text-white/70">{order ? 'Order placed, scan to pay' : 'Confirm the order, quantity can still be changed'}</div>
                </div>
            </div>

            <div className="p-3 space-y-2">
                {/* Pickup store (from previewOrder.shopInfo) */}
                {(() => {
                    const shop = preview?.shopInfo;
                    const shopName = shop?.deptName || (deptId != null ? `Store ${deptId}` : undefined);
                    if (!shopName) return null;
                    return (
                        <div className="bg-white/80 rounded-lg border border-[#EFE9DC] p-2 flex items-start gap-1.5">
                            <span className="text-[13px] shrink-0">🏪</span>
                            <div className="min-w-0">
                                <div className="text-[12px] font-bold text-[#0B1F3A] truncate">{shopName} <span className="text-[9px] font-normal text-slate-400">In-store pickup</span></div>
                                {shop?.address && <div className="text-[10px] text-slate-500 line-clamp-2 leading-snug">{shop.address}</div>}
                            </div>
                        </div>
                    );
                })()}

                {/* Item rows */}
                <div className="bg-white/80 rounded-lg overflow-hidden border border-[#EFE9DC]">
                    {lines.map((l) => (
                        <div key={l.skuCode} className="flex items-center gap-2 p-2 border-b border-[#F4EFE4] last:border-b-0">
                            <div className="w-10 h-10 rounded-md bg-[#FAF7F0] overflow-hidden shrink-0 flex items-center justify-center">
                                {l.image ? <img src={l.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} /> : <span className="text-lg">{luckinItemEmoji(l.name)}</span>}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-[12px] text-slate-800 truncate">{l.name}</div>
                                {l.spec && <div className="text-[9px] text-slate-400 truncate">{l.spec}</div>}
                                {l.unitPrice != null && <div className="text-[10px] text-[#16386F]">{fmtMoney(l.unitPrice)}</div>}
                            </div>
                            {order ? (
                                <div className="text-[12px] font-bold text-[#16386F] shrink-0">×{l.qty}</div>
                            ) : (
                                <div className="flex items-center bg-white border border-[#DDD3BC] rounded-md overflow-hidden shrink-0">
                                    <button onClick={() => changeQty(l.skuCode, -1)} className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-[#16386F] active:bg-[#F2ECDD]">−</button>
                                    <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{l.qty}</span>
                                    <button onClick={() => changeQty(l.skuCode, 1)} className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-[#16386F] active:bg-[#F2ECDD]">+</button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* Cost breakdown */}
                <div className="space-y-1 text-[12px] text-slate-700">
                    {original != null && <div className="flex justify-between text-[10px] text-slate-400"><span>Item subtotal (list price)</span><span>{fmtMoney(original)}</span></div>}
                    {privilege != null && Number(privilege) > 0 && <div className="flex justify-between text-emerald-600"><span>Discount applied</span><span>-{fmtMoney(privilege)}</span></div>}
                    {Array.isArray(preview?.couponCodeList) && preview.couponCodeList.length > 0 && <div className="flex justify-between text-[11px] text-[#16386F]"><span>Coupons auto-applied</span><span>{preview.couponCodeList.length}</span></div>}
                    <div className="flex justify-between border-t border-[#EFE9DC] pt-1">
                        <span className="text-slate-500">{calcing ? 'Calculating…' : 'Total due'}</span>
                        <span className="font-bold text-[15px] text-[#0B1F3A]">{calcing ? '…' : fmtMoney(finalPrice != null ? finalPrice : localTotal)}</span>
                    </div>
                </div>

                {payErr && <div className="text-[11px] text-red-600 bg-red-50 rounded-lg p-2 leading-relaxed whitespace-pre-wrap break-all">{payErr}</div>}

                {/* Payment / QR code */}
                {order ? (
                    <div className="flex flex-col items-center gap-1.5 pt-1">
                        {(payUrl || qrUrl) ? <PayQr payUrl={payUrl} qrImageUrl={qrUrl} size={150} /> : <div className="text-[12px] text-emerald-600 font-bold">Order placed 🎉</div>}
                        {orderId && <div className="text-[9px] text-slate-400 font-mono">#{orderId}</div>}
                    </div>
                ) : (
                    <button
                        onClick={pay}
                        disabled={paying || calcing || !productList().length}
                        className="w-full px-3 py-2.5 bg-[#0B1F3A] text-white text-[13px] font-bold rounded-xl active:scale-95 disabled:opacity-50">
                        {paying ? 'Placing order…' : 'Place Order & Pay →'}
                    </button>
                )}
            </div>
        </div>
    );
};

export default LuckinCheckoutCard;
