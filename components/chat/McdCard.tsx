import React, { useMemo, useState } from 'react';
import { trackEvent } from '../../utils/analytics';

/**
 * McDonald's MCP tool result card
 *
 * Rendering strategy: since we don't know exactly which fields each tool returns, this uses a
 * "heuristic + generic display" approach:
 *  - Probe for common fields: items / products / stores / coupons / orderId / total ...
 *  - A known shape is matched -> a nice specialized card
 *  - No match -> collapsed JSON details (click to expand)
 *
 * Product images load directly from McDonald's CDN (the user has already consented to this).
 */

export interface McdCartItem {
    code?: string;
    name: string;
    price?: number | string;
    image?: string;
    qty: number;
}

interface McdCardProps {
    toolName: string;
    args?: Record<string, any>;
    result?: any;
    error?: string | null;
    rawText?: string;
    kind?: 'menu' | 'order' | 'store' | 'coupon' | 'activity' | 'address' | 'generic' | 'cart' | 'candidate';
    /** After the user picks items on the menu and taps "Send to character," sends the cart out as a new message */
    onSendCart?: (items: McdCartItem[]) => void;
    /** Single-item candidate: user taps 💭 -> immediately hands this one item to the character for them to weigh in on (doesn't affect the cart) */
    onCandidate?: (item: McdCartItem) => void;
    /** Used when kind='cart' (historical message): the item list picked previously */
    cartItems?: McdCartItem[];
    /** Used when kind='candidate' (historical message): the single candidate item */
    candidateItem?: McdCartItem;
}

// ========== General helpers ==========

const fmtMoney = (v: any): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return String(v);
    return `¥${n.toFixed(2)}`;
};

const pickFirst = <T,>(obj: any, keys: string[]): T | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) if (obj[k] != null) return obj[k];
    return undefined;
};

const findArray = (obj: any, keys: string[]): any[] | null => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
        const v = obj[k];
        if (Array.isArray(v) && v.length) return v;
    }
    // Fallback: find the first non-empty array field
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    return null;
};

// Looks like a displayable item: a name/price/title field is present
const looksLikeNamedItem = (v: any): boolean => {
    if (!v || typeof v !== 'object') return false;
    return [
        'name', 'title', 'productName', 'goodsName', 'mealName', 'displayName',
        'currentPrice', 'price', 'salePrice', 'sellPrice',
        'fullAddress', 'address', 'storeName', 'shopName',
    ].some(k => v[k] != null);
};

/**
 * Broader than findArray: also accepts a "dict-of-objects keyed by SKU/ID" (common in McDonald's
 * menu responses), automatically flattening it into an array via Object.values.
 */
const extractItems = (data: any, prefKeys: string[] = ['items', 'products', 'goods', 'list', 'data', 'meals', 'addresses', 'stores']): any[] | null => {
    if (!data) return null;
    if (Array.isArray(data) && data.length) return data;
    if (typeof data !== 'object') return null;
    // 1) Prefer prefKeys
    for (const k of prefKeys) {
        const v = data[k];
        if (Array.isArray(v) && v.length) return v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const vals = Object.values(v).filter(x => x && typeof x === 'object');
            if (vals.length) return vals as any[];
        }
    }
    // 2) data itself is a dict-of-objects (keys like SKU codes)
    const vals = Object.values(data).filter(x => x && typeof x === 'object');
    if (vals.length >= 2 && vals.every(x => !Array.isArray(x)) && vals.some(looksLikeNamedItem)) {
        return vals as any[];
    }
    // 3) One level deeper: look inside data's object fields for a "dict or array containing many named items"
    //    Handles shapes like {categories: [...], meals: {SKU: {...}}} that prefKeys doesn't cover
    let bestArr: any[] | null = null;
    for (const k of Object.keys(data)) {
        const v = data[k];
        if (Array.isArray(v) && v.length && v.some(looksLikeNamedItem)) {
            if (!bestArr || v.length > bestArr.length) bestArr = v;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            const inner = Object.values(v).filter(x => x && typeof x === 'object');
            if (inner.length >= 2 && inner.some(looksLikeNamedItem)) {
                if (!bestArr || inner.length > bestArr.length) bestArr = inner as any[];
            }
        }
    }
    return bestArr;
};

// ========== Sub-card: product/menu ==========

interface MenuItemRowProps {
    item: any;
    qty?: number;
    /** Adds to this card's internal cart (accumulates selections, sent together later) */
    onAdd?: () => void;
    onSub?: () => void;
    /** Immediately hands this single item to the character as a "candidate," for them to weigh in on/recommend, without adding it to the cart */
    onCandidate?: () => void;
}

const MenuItemRow: React.FC<MenuItemRowProps> = ({ item, qty, onAdd, onSub, onCandidate }) => {
    const name = pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'mealName', 'displayName']) || "McDonald's Item";
    const desc = pickFirst<string>(item, ['description', 'desc', 'subtitle', 'shortDesc', 'remark']);
    const price = pickFirst<any>(item, ['currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'amount', 'sellPrice']);
    const image = pickFirst<string>(item, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']);
    const showStepper = !!onAdd || !!onSub;
    const q = qty || 0;
    return (
        <div className="flex gap-2 p-2 border-b border-yellow-50 last:border-b-0">
            <div className="w-14 h-14 rounded-lg bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                {image ? (
                    <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                ) : (
                    <span className="text-2xl">🍔</span>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                {desc && <div className="text-[10px] text-slate-500 line-clamp-2 leading-snug mt-0.5">{desc}</div>}
                <div className="flex items-center justify-between mt-1 gap-2">
                    {price != null
                        ? <div className="text-[12px] font-bold text-yellow-700">{fmtMoney(price)}</div>
                        : <div className="flex-1" />}
                    <div className="flex items-center gap-1 shrink-0">
                        {onCandidate && (
                            <button
                                type="button"
                                onClick={onCandidate}
                                title="Ask the character what they think of this"
                                className="px-1.5 py-0.5 rounded-md bg-white border border-yellow-300 text-yellow-700 text-[10px] font-bold active:scale-95 transition-transform"
                            >💭 Ask them</button>
                        )}
                        {showStepper && (
                            <div className="flex items-center bg-white border border-yellow-300 rounded-md overflow-hidden">
                                <button
                                    type="button"
                                    onClick={onSub}
                                    disabled={q <= 0}
                                    className={`w-6 h-6 flex items-center justify-center text-[14px] font-bold ${q <= 0 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-100'}`}
                                >−</button>
                                <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{q}</span>
                                <button
                                    type="button"
                                    onClick={onAdd}
                                    className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-yellow-700 active:bg-yellow-100"
                                >+</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ========== Sub-card: order ==========

const OrderSummary: React.FC<{ data: any }> = ({ data }) => {
    const orderId = pickFirst<string>(data, ['orderId', 'orderNo', 'id', 'orderSn', 'tradeNo']);
    const total = pickFirst<any>(data, ['totalAmount', 'total', 'amount', 'payAmount', 'realPayAmount']);
    const status = pickFirst<string>(data, ['status', 'statusText', 'orderStatus', 'state']);
    const deliveryType = pickFirst<string>(data, ['deliveryType', 'orderType', 'channel']);
    const address = pickFirst<string>(data, ['address', 'deliveryAddress', 'consigneeAddress']);
    const items = findArray(data, ['items', 'goods', 'products', 'orderItems', 'goodsList']);
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-yellow-700/70 font-bold uppercase">Order</span>
                {status && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-bold">{status}</span>}
            </div>
            {orderId && <div className="text-[11px] text-slate-500 font-mono">#{orderId}</div>}
            {deliveryType && <div className="text-[10px] text-slate-500">{deliveryType}</div>}
            {address && <div className="text-[10px] text-slate-500 line-clamp-2">📍 {address}</div>}
            {items && items.length > 0 && (
                <div className="bg-white/70 rounded-lg overflow-hidden border border-yellow-100">
                    {items.slice(0, 5).map((it, i) => <MenuItemRow key={i} item={it} />)}
                    {items.length > 5 && <div className="text-[10px] text-slate-400 text-center py-1.5">{items.length - 5} more…</div>}
                </div>
            )}
            {total != null && (
                <div className="flex items-center justify-between border-t border-yellow-200/60 pt-1.5">
                    <span className="text-[11px] text-slate-600">Total</span>
                    <span className="text-[14px] font-bold text-yellow-700">{fmtMoney(total)}</span>
                </div>
            )}
        </div>
    );
};

// ========== Sub-card: stores ==========

const StoreList: React.FC<{ data: any }> = ({ data }) => {
    const stores = extractItems(data, ['stores', 'shops', 'restaurants', 'storeList', 'list', 'data', 'items']) || [];
    if (!stores.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">Nearby Stores</div>
            {stores.slice(0, 5).map((s, i) => {
                const name = pickFirst<string>(s, ['name', 'storeName', 'shopName', 'restaurantName']) || "McDonald's Store";
                const addr = pickFirst<string>(s, ['address', 'storeAddress', 'shopAddress']);
                const distance = pickFirst<any>(s, ['distance', 'distanceM']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                            {distance != null && <div className="text-[10px] text-yellow-700 shrink-0 ml-2">📍 {typeof distance === 'number' ? (distance > 1000 ? (distance / 1000).toFixed(1) + 'km' : distance + 'm') : distance}</div>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {stores.length > 5 && <div className="text-[10px] text-slate-400 text-center">{stores.length - 5} more stores…</div>}
        </div>
    );
};

// ========== Sub-card: menu list (expandable + selectable) ==========

const itemKey = (item: any, idx: number): string => {
    return String(item?.code || item?.productCode || item?.skuCode || item?.id || `idx-${idx}`);
};

const itemToCart = (item: any): McdCartItem => ({
    code: pickFirst<string>(item, ['code', 'productCode', 'skuCode', 'mealCode', 'goodsCode']),
    name: pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'mealName', 'displayName']) || "McDonald's Item",
    price: pickFirst<any>(item, ['currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'sellPrice']),
    image: pickFirst<string>(item, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']),
    qty: 1,
});

const MenuList: React.FC<{ items: any[]; pageSize?: number; onSendCart?: (items: McdCartItem[]) => void; onCandidate?: (item: McdCartItem) => void }> = ({ items, pageSize = 6, onSendCart, onCandidate }) => {
    const [page, setPage] = useState(0);
    // selected: key -> quantity (persists across pages)
    const [selected, setSelected] = useState<Record<string, number>>({});

    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * pageSize;
    const shown = items.slice(start, start + pageSize);

    const change = (k: string, delta: number) => {
        setSelected(s => {
            const cur = s[k] || 0;
            const next = Math.max(0, Math.min(20, cur + delta));
            const out = { ...s };
            if (next === 0) delete out[k]; else out[k] = next;
            return out;
        });
    };

    const cart = useMemo(() => {
        const out: McdCartItem[] = [];
        items.forEach((it, i) => {
            const k = itemKey(it, i);
            const q = selected[k];
            if (q && q > 0) out.push({ ...itemToCart(it), qty: q });
        });
        return out;
    }, [selected, items]);

    const totalCount = cart.reduce((sum, c) => sum + c.qty, 0);
    const totalPrice = cart.reduce((sum, c) => {
        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
        return sum + (isFinite(p) ? p * c.qty : 0);
    }, 0);

    const handleSend = () => {
        if (!cart.length || !onSendCart) return;
        onSendCart(cart);
        setSelected({});
        trackEvent("Send McDonald's Cart to Character");
    };

    return (
        <div>
            <div className="bg-white/70 rounded-lg overflow-hidden border border-yellow-100">
                {shown.map((it, idx) => {
                    const globalIdx = start + idx;
                    const k = itemKey(it, globalIdx);
                    const q = selected[k] || 0;
                    return <MenuItemRow
                        key={k}
                        item={it}
                        qty={q}
                        onAdd={onSendCart ? () => change(k, 1) : undefined}
                        onSub={onSendCart ? () => change(k, -1) : undefined}
                        onCandidate={onCandidate ? () => onCandidate({ ...itemToCart(it), qty: 1 }) : undefined}
                    />;
                })}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-yellow-100 bg-yellow-50/40">
                        <button
                            type="button"
                            disabled={safePage === 0}
                            onClick={() => setPage(p => Math.max(0, p - 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage === 0 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-200/60 active:scale-90'}`}
                        >‹</button>
                        <div className="text-[11px] text-yellow-800 font-bold">
                            Page {safePage + 1} / {totalPages}
                            <span className="text-[9px] text-yellow-700/60 font-normal ml-1.5">({items.length} items total)</span>
                        </div>
                        <button
                            type="button"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage >= totalPages - 1 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-200/60 active:scale-90'}`}
                        >›</button>
                    </div>
                )}
            </div>
            {onSendCart && totalCount > 0 && (
                <div className="mt-2 flex items-center gap-2 bg-yellow-100/80 rounded-lg p-2 border border-yellow-300">
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-yellow-800/80">{totalCount} selected</div>
                        {totalPrice > 0 && <div className="text-[14px] font-bold text-yellow-800">{fmtMoney(totalPrice)}</div>}
                    </div>
                    <button
                        type="button"
                        onClick={() => { setSelected({}); trackEvent("Clear McDonald's Cart"); }}
                        className="text-[10px] text-yellow-700 px-2 py-1.5 active:scale-95"
                    >Clear</button>
                    <button
                        type="button"
                        onClick={handleSend}
                        className="px-3 py-1.5 bg-yellow-500 text-white text-[11px] font-bold rounded-lg shadow active:scale-95 transition-transform"
                    >Send to Character →</button>
                </div>
            )}
        </div>
    );
};

// ========== Sub-card: user's cart (produced after the user finishes picking on the menu and taps "Send to character") ==========

const CartCard: React.FC<{ items: McdCartItem[] }> = ({ items }) => {
    const total = items.reduce((sum, c) => {
        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
        return sum + (isFinite(p) ? p * c.qty : 0);
    }, 0);
    const totalCount = items.reduce((s, c) => s + c.qty, 0);
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-yellow-700/80 font-bold uppercase">🛒 Wants to order</div>
            <div className="bg-white/80 rounded-lg overflow-hidden border border-yellow-200">
                {items.map((it, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 border-b border-yellow-50 last:border-b-0">
                        <div className="w-10 h-10 rounded-md bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                            {it.image ? <img src={it.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} /> : <span className="text-lg">🍔</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{it.name}</div>
                            {it.price != null && <div className="text-[10px] text-yellow-700">{fmtMoney(it.price)}</div>}
                        </div>
                        <div className="text-[12px] font-bold text-yellow-700 shrink-0">×{it.qty}</div>
                    </div>
                ))}
            </div>
            <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-600">{totalCount} items total</span>
                {total > 0 && <span className="text-[15px] font-bold text-yellow-700">{fmtMoney(total)}</span>}
            </div>
        </div>
    );
};

// ========== Sub-card: shipping addresses ==========

const AddressList: React.FC<{ data: any }> = ({ data }) => {
    const list = extractItems(data, ['addresses', 'addressList', 'list', 'data', 'items']) || [];
    if (!list.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">📍 Shipping Address</div>
            {list.slice(0, 5).map((a, i) => {
                const name = pickFirst<string>(a, ['contactName', 'name', 'consignee', 'consigneeName']) || 'Recipient';
                const phone = pickFirst<string>(a, ['phone', 'mobile', 'tel', 'contactPhone', 'consigneePhone']);
                const addr = pickFirst<string>(a, ['fullAddress', 'address', 'detailAddress', 'consigneeAddress']);
                const tag = pickFirst<string>(a, ['tag', 'label', 'addressTag', 'addressType']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">
                                {name}{phone && <span className="text-[10px] text-slate-500 font-normal ml-1.5">{phone}</span>}
                            </div>
                            {tag && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 shrink-0 ml-1">{tag}</span>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {list.length > 5 && <div className="text-[10px] text-slate-400 text-center">{list.length - 5} more…</div>}
        </div>
    );
};

// ========== Sub-card: coupons/vouchers ==========

const CouponList: React.FC<{ data: any }> = ({ data }) => {
    const coupons = extractItems(data, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'storeCoupons', 'list', 'data', 'items']) || [];
    if (!coupons.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">Coupons</div>
            {coupons.slice(0, 6).map((c, i) => {
                const title = pickFirst<string>(c, ['title', 'name', 'couponName', 'goodsName']) || "McDonald's Coupon";
                const value = pickFirst<any>(c, ['value', 'amount', 'discountAmount', 'price', 'points']);
                const expire = pickFirst<string>(c, ['expireDate', 'endTime', 'validTo', 'expireTime']);
                return (
                    <div key={i} className="flex items-center justify-between bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">🎟️ {title}</div>
                            {expire && <div className="text-[10px] text-slate-400">Valid until {expire}</div>}
                        </div>
                        {value != null && <div className="text-[12px] font-bold text-yellow-700 shrink-0 ml-2">{typeof value === 'number' ? fmtMoney(value) : String(value)}</div>}
                    </div>
                );
            })}
        </div>
    );
};

// ========== Sub-card: meal set detail (returned by query-meal-detail) ==========

const MealDetailCard: React.FC<{ data: any }> = ({ data }) => {
    const code = data?.code;
    const price = data?.price;
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">Meal Set Contents</div>
            <div className="bg-white/70 rounded-lg p-2 border border-yellow-100 flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-mono truncate">code: {code || '?'}</span>
                {price != null && <span className="text-[13px] font-bold text-yellow-700 shrink-0 ml-2">{fmtMoney(price)}</span>}
            </div>
            {rounds.length === 0 ? (
                <div className="text-[10px] text-slate-500 bg-slate-50/80 rounded-lg p-2 leading-relaxed">
                    Upstream did not return a round structure for this code (it may just be a single item, or the code might not match an expected meal set). If the code is confirmed correct at order time, the top-level code can be placed directly into calculate-price.items.
                </div>
            ) : (
                rounds.map((r: any, i: number) => (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="text-[11px] font-bold text-slate-700">
                            {r.name || `Item ${r.id || i + 1}`}
                            <span className="text-[10px] text-slate-400 font-normal ml-1.5">×{r.quantity ?? 1}</span>
                        </div>
                        {Array.isArray(r.choices) && r.choices.length > 0 && (
                            <div className="mt-1 pl-2 space-y-0.5">
                                {r.choices.map((c: any, j: number) => (
                                    <div key={j} className="text-[10px] text-slate-500">
                                        • {c.name || c.code} <span className="text-slate-400">×{c.quantity ?? 1}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))
            )}
            <div className="text-[9px] text-slate-400 italic leading-snug">
                v1.0.3 does not support swapping individual items within a meal set -- just use the top-level code directly when ordering.
            </div>
        </div>
    );
};

// ========== Text/long content (returned by tools like list-nutrition-foods / campaign-calendar) ==========

const TextResultCard: React.FC<{ text: string; toolName: string }> = ({ text, toolName }) => {
    const [expanded, setExpanded] = useState(false);
    const preview = text.length > 240 ? text.slice(0, 240) + '…' : text;
    const isLong = text.length > 240;
    const label = /nutrition/i.test(toolName) ? 'Nutrition Info Table'
        : /campaign|calendar/i.test(toolName) ? 'Campaign Calendar'
        : /coupon/i.test(toolName) ? 'Coupon Text'
        : 'Text Result';
    return (
        <div className="bg-white/80 rounded-lg border border-yellow-100 p-2.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase mb-1">{label}</div>
            <pre className={`text-[10px] text-slate-700 leading-snug font-mono whitespace-pre-wrap break-all ${expanded ? '' : 'max-h-40 overflow-hidden'}`}>{expanded ? text : preview}</pre>
            {isLong && (
                <button onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] text-yellow-700 active:scale-95">
                    {expanded ? '▲ Collapse' : '▼ Expand All'}
                </button>
            )}
        </div>
    );
};

// ========== Empty/failed envelope notice ==========

const isMcdEnvelope = (v: any): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
    const hits = envKeys.filter(k => k in v).length;
    return hits >= 2; // Requires at least 2 envelope fields to count
};

const EnvelopeNotice: React.FC<{ data: any }> = ({ data }) => {
    const ok = data?.success === true || data?.code === 200 || data?.code === '200' || data?.code === 0;
    const msg = data?.message || data?.msg || data?.errMsg || (ok ? 'Request succeeded, but no data was returned' : 'Request failed');
    const code = data?.code ?? data?.errorCode;
    const traceId = data?.traceId;
    return (
        <div className={`rounded-lg border p-3 ${ok ? 'bg-blue-50/60 border-blue-200' : 'bg-red-50/60 border-red-200'}`}>
            <div className="flex items-start gap-2">
                <span className="text-xl shrink-0 leading-none mt-0.5">{ok ? 'ℹ️' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                    <div className={`font-bold text-[12px] ${ok ? 'text-blue-700' : 'text-red-600'}`}>{msg}</div>
                    {ok && (
                        <div className="text-[10px] text-blue-600/80 mt-1 leading-relaxed">
                            McDonald's returned nothing. Common causes: this store is closed for this time slot / the current mode is not supported / the parameters are off / a temporary service hiccup. Try a different store, or have the character retry.
                        </div>
                    )}
                    {code != null && <div className="text-[9px] text-slate-400 font-mono mt-1">code: {String(code)}{traceId && ` · trace: ${traceId.slice(0, 8)}…`}</div>}
                </div>
            </div>
        </div>
    );
};

const EmptyResultNotice: React.FC<{ toolName: string }> = ({ toolName }) => (
    <div className="rounded-lg border p-3 bg-slate-50/70 border-slate-200">
        <div className="text-[12px] font-bold text-slate-600">This tool did not return any displayable data this time</div>
        <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">
            {toolName} returned an empty list. Common causes: the store/time slot is unsupported, the parameter combination does not match, or the server had no results available at the moment. Try a different store or adjust the parameters and retry.
        </div>
    </div>
);

const UnrecognizedDiag: React.FC<{ data: any; rawText?: string; toolName: string }> = ({ data, rawText, toolName }) => {
    const [expanded, setExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
    const diag = useMemo(() => {
        if (data == null) return { kind: 'empty', keys: '', sample: '', count: 0 };
        if (typeof data === 'string') return { kind: 'string', keys: '', sample: data.slice(0, 100), count: data.length };
        if (Array.isArray(data)) {
            const first = data[0];
            const sample = first && typeof first === 'object' ? Object.keys(first).slice(0, 8).join(', ') : String(first).slice(0, 80);
            return { kind: `array[${data.length}]`, keys: '', sample, count: data.length };
        }
        if (typeof data === 'object') {
            const keys = Object.keys(data);
            const firstObjKey = keys.find(k => data[k] && typeof data[k] === 'object');
            const firstObj = firstObjKey ? data[firstObjKey] : null;
            const sample = firstObj
                ? `${firstObjKey}: { ${Object.keys(firstObj).slice(0, 6).join(', ')} }`
                : '';
            return { kind: 'object', keys: keys.slice(0, 10).join(', '), sample, count: keys.length };
        }
        return { kind: typeof data, keys: '', sample: String(data).slice(0, 80), count: 0 };
    }, [data]);

    const fullJson = useMemo(() => {
        if (typeof data === 'string') return data;
        try { return JSON.stringify(data, null, 2); } catch { return rawText || ''; }
    }, [data, rawText]);

    const handleCopy = async () => {
        const text = fullJson || rawText || '';
        if (!text) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback: for old webviews / iOS Capacitor cases that don't support the clipboard API
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopyState('ok');
        } catch {
            setCopyState('err');
        }
        setTimeout(() => setCopyState('idle'), 1500);
    };

    return (
        <div className="bg-white/70 rounded-lg border-2 border-dashed border-orange-300">
            <div className="px-2 pt-2 pb-1.5 flex items-center gap-1.5">
                <span className="text-[9px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-bold">⚠️ Failed to read this order info</span>
                <span className="text-[10px] text-slate-400 font-mono truncate">{toolName}</span>
            </div>
            <div className="px-2 pb-1.5 space-y-0.5 text-[10px] text-slate-600 font-mono leading-snug">
                <div><span className="text-slate-400">type:</span> {diag.kind}</div>
                {diag.keys && <div className="break-all"><span className="text-slate-400">keys:</span> {diag.keys}</div>}
                {diag.sample && <div className="break-all"><span className="text-slate-400">sample:</span> {diag.sample}</div>}
            </div>
            {fullJson && (
                <div className="flex items-center border-t border-orange-200/60">
                    <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left px-2 py-1 text-[10px] text-orange-600 active:scale-[0.99]">
                        {expanded ? '▼ Collapse Raw' : '▶ Expand Raw JSON'}
                    </button>
                    <button
                        onClick={handleCopy}
                        className={`px-2.5 py-1 text-[10px] font-bold border-l border-orange-200/60 active:scale-95 transition ${
                            copyState === 'ok' ? 'text-emerald-600' : copyState === 'err' ? 'text-red-500' : 'text-orange-600'
                        }`}
                    >
                        {copyState === 'ok' ? '✓ Copied' : copyState === 'err' ? '× Failed' : '📋 Copy'}
                    </button>
                </div>
            )}
            {expanded && fullJson && (
                <pre className="text-[10px] text-slate-600 px-2 pb-2 overflow-auto max-h-64 leading-tight whitespace-pre-wrap break-all">{fullJson}</pre>
            )}
        </div>
    );
};

// ========== Main entry point ==========

const McdCard: React.FC<McdCardProps> = ({ toolName, args, result, error, rawText, kind = 'generic', onSendCart, onCandidate, cartItems, candidateItem }) => {
    // Cart type (the "wants to order" mini-card already sent from the user side)
    if (kind === 'cart' && cartItems && cartItems.length) {
        return (
            <div className="w-72 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-400 to-amber-400">
                    <span className="text-lg">🛒</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-yellow-900">McDonald's</div>
                        <div className="text-[9px] text-yellow-900/70">Wants to order</div>
                    </div>
                </div>
                <div className="p-3"><CartCard items={cartItems} /></div>
            </div>
        );
    }
    // Candidate type (a single item thrown over via the user-side "ask them about this")
    if (kind === 'candidate' && candidateItem) {
        return (
            <div className="w-64 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-300 to-amber-300">
                    <span className="text-lg">💭</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-yellow-900">McDonald's</div>
                        <div className="text-[9px] text-yellow-900/70">Wants your opinion</div>
                    </div>
                </div>
                <div className="p-3 flex items-center gap-2">
                    <div className="w-12 h-12 rounded-md bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                        {candidateItem.image
                            ? <img src={candidateItem.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                            : <span className="text-xl">🍔</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-bold text-[12px] text-slate-800 truncate">{candidateItem.name}</div>
                        {candidateItem.price != null && <div className="text-[11px] text-yellow-700">{fmtMoney(candidateItem.price)}</div>}
                    </div>
                </div>
            </div>
        );
    }
    const isError = !!error;

    // Try to extract items for each kind; only take the specialized rendering path if extraction succeeds, otherwise fall back to generic JSON
    const specializedItems = useMemo(() => {
        if (!result) return null;
        if (kind === 'address') return extractItems(result, ['addresses', 'addressList', 'list', 'data', 'items']);
        if (kind === 'store') return extractItems(result, ['stores', 'shops', 'restaurants', 'storeList', 'list', 'data', 'items']);
        if (kind === 'coupon') return extractItems(result, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'storeCoupons', 'list', 'data', 'items']);
        if (kind === 'menu') return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'meals']);
        return null;
    }, [kind, result]);
    const specializedHasItems = !!(specializedItems && specializedItems.length && specializedItems.some(looksLikeNamedItem));

    // Generic menu detection (kind wasn't recognized, but a product list could still be dug out of result)
    const fallbackMenuItems = useMemo(() => {
        if (kind !== 'generic' || !result) return null;
        return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'meals', 'addresses', 'stores']);
    }, [kind, result]);
    const fallbackMenuHasItems = !!(fallbackMenuItems && fallbackMenuItems.length && fallbackMenuItems.some(looksLikeNamedItem));

    const effectiveKind: McdCardProps['kind'] = useMemo(() => {
        if (kind === 'order') return 'order'; // Orders always take the specialized path (shows at least the status, even for simple content)
        if (kind && kind !== 'generic' && specializedHasItems) return kind;
        if (fallbackMenuHasItems) return 'menu';
        return 'generic';
    }, [kind, specializedHasItems, fallbackMenuHasItems]);

    const menuItems = kind === 'menu' ? specializedItems : fallbackMenuItems;
    const itemsHaveDisplayFields = effectiveKind === 'menu' && (specializedHasItems || fallbackMenuHasItems);

    return (
        <div className="w-72 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
            {/* Header: McDonald's red-and-yellow bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-400 to-amber-400">
                <span className="text-lg">🍟</span>
                <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-yellow-900">McDonald's</div>
                    <div className="text-[9px] text-yellow-900/70 font-mono truncate">{toolName}</div>
                </div>
                {isError ? (
                    <span className="text-[9px] px-1.5 py-0.5 bg-red-100 text-red-600 rounded-full font-bold">Failed</span>
                ) : (
                    <span className="text-[9px] px-1.5 py-0.5 bg-white/70 text-yellow-900 rounded-full font-bold">Returned</span>
                )}
            </div>

            <div className="p-3 space-y-2">
                {isError ? (
                    <>
                        <div className="text-[11px] text-red-600 leading-relaxed whitespace-pre-wrap">{error}</div>
                        {args && Object.keys(args).length > 0 && (
                            <details className="bg-red-50/60 border border-red-200 rounded-lg">
                                <summary className="text-[10px] text-red-700 px-2 py-1 cursor-pointer font-bold">▶ Parameters the model passed this time</summary>
                                <pre className="text-[10px] text-slate-700 px-2 pb-2 overflow-auto max-h-48 leading-tight whitespace-pre-wrap break-all font-mono">{(() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })()}</pre>
                            </details>
                        )}
                    </>
                ) : (
                    <>
                        {/^query[-_]?meal[-_]?detail$/i.test(toolName) && result && typeof result === 'object' && !Array.isArray(result) && ('rounds' in result || 'code' in result) ? (
                            <MealDetailCard data={result} />
                        ) : effectiveKind === 'menu' && menuItems && menuItems.length > 0 && itemsHaveDisplayFields ? (
                            <MenuList items={menuItems} onSendCart={onSendCart} onCandidate={onCandidate} />
                        ) : effectiveKind === 'address' && result ? (
                            <AddressList data={result} />
                        ) : effectiveKind === 'order' && result ? (
                            <OrderSummary data={result} />
                        ) : effectiveKind === 'store' && result ? (
                            <StoreList data={result} />
                        ) : effectiveKind === 'coupon' && result ? (
                            <CouponList data={result} />
                        ) : Array.isArray(result) && result.length === 0 ? (
                            <EmptyResultNotice toolName={toolName} />
                        ) : typeof result === 'string' && result.trim().length > 0 ? (
                            <TextResultCard text={result} toolName={toolName} />
                        ) : isMcdEnvelope(result) ? (
                            <EnvelopeNotice data={result} />
                        ) : (
                            <UnrecognizedDiag data={result} rawText={rawText} toolName={toolName} />
                        )}
                    </>
                )}
                {!isError && args && Object.keys(args).length > 0 && (
                    <details className="text-[9px] text-slate-400 font-mono">
                        <summary className="cursor-pointer truncate select-none active:text-yellow-700">
                            Parameters: {Object.keys(args).join(', ')}
                        </summary>
                        <pre className="text-[10px] text-slate-600 mt-1 px-1 py-1 bg-slate-50/80 rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">{(() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })()}</pre>
                    </details>
                )}
            </div>
        </div>
    );
};

export default McdCard;
