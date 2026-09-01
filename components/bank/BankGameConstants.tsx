
import React from 'react';
import { ShopRecipe, ShopStaff, RoomLayout, DollhouseRoom, DollhouseState } from '../../types';

// Pixel Art Assets (Twemoji CDN for consistent cross-platform rendering)
export const BANK_ASSETS = {
    // Backgrounds (Patterns)
    floors: {
        wood: 'repeating-linear-gradient(0deg, #c19a6b 0px, #c19a6b 4px, #a67c52 5px)',
        tile: 'conic-gradient(from 90deg at 2px 2px, #fdf6e3 90deg, #eee8d5 0) 0 0/20px 20px',
        check: 'conic-gradient(#eee8d5 90deg, #fdf6e3 90deg 180deg, #eee8d5 180deg 270deg, #fdf6e3 270deg) 0 0 / 40px 40px'
    },
    // Furniture Icons (Twemoji CDN)
    furniture: {
        table: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa91.png',
        counter: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f371.png',
        plant: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fab4.png',
        window: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa9f.png',
        rug: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9f6.png'
    }
};

export const SHOP_RECIPES: ShopRecipe[] = [
    { id: 'recipe-coffee-001', name: 'Pour-Over Coffee', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png', cost: 0, appeal: 10, isUnlocked: true },
    { id: 'recipe-cake-001', name: 'Strawberry Cake', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f370.png', cost: 50, appeal: 20, isUnlocked: false },
    { id: 'recipe-tea-001', name: 'Earl Grey Tea', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f375.png', cost: 80, appeal: 25, isUnlocked: false },
    { id: 'recipe-donut-001', name: 'Donut', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f369.png', cost: 120, appeal: 30, isUnlocked: false },
    { id: 'recipe-icecream-001', name: 'Matcha Ice Cream', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f366.png', cost: 200, appeal: 40, isUnlocked: false },
    { id: 'recipe-pudding-001', name: 'Caramel Pudding', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f36e.png', cost: 300, appeal: 50, isUnlocked: false },
    { id: 'recipe-cocktail-001', name: 'Signature Sparkling Water', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f379.png', cost: 500, appeal: 80, isUnlocked: false },
];

export const AVAILABLE_STAFF: Omit<ShopStaff, 'hireDate' | 'fatigue'>[] = [
    { id: 'staff-dog-01', name: 'Shiba Waiter', avatar: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f436.png', role: 'waiter', maxFatigue: 120 },
    { id: 'staff-bear-01', name: 'Bear Chef', avatar: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f43b.png', role: 'chef', maxFatigue: 150 },
    { id: 'staff-rabbit-01', name: 'Bunny Host', avatar: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f430.png', role: 'waiter', maxFatigue: 80 },
    { id: 'staff-penguin-01', name: 'Penguin Buyer', avatar: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f427.png', role: 'manager', maxFatigue: 110 },
];

// --- DOLLHOUSE ROOM LAYOUTS ---
export const ROOM_LAYOUTS: RoomLayout[] = [
    {
        id: 'layout-cafe',
        name: 'Coffee Bar',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png',
        description: 'Classic cafe layout, with a counter and window',
        apCost: 0,
        floorWidthRatio: 1,
        floorDepthRatio: 1,
        hasCounter: true,
        hasWindow: true,
    },
    {
        id: 'layout-kitchen',
        name: 'Kitchen',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f373.png',
        description: 'Spacious kitchen area',
        apCost: 100,
        floorWidthRatio: 1,
        floorDepthRatio: 0.8,
        hasCounter: true,
        hasWindow: false,
    },
    {
        id: 'layout-lounge',
        name: 'Lounge',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6cb.png',
        description: 'Cozy lounge area, great for a sofa',
        apCost: 150,
        floorWidthRatio: 1,
        floorDepthRatio: 1,
        hasCounter: false,
        hasWindow: true,
    },
    {
        id: 'layout-storage',
        name: 'Storage Room',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4e6.png',
        description: 'A small storage room',
        apCost: 80,
        floorWidthRatio: 0.7,
        floorDepthRatio: 0.7,
        hasCounter: false,
        hasWindow: false,
    },
    {
        id: 'layout-vip',
        name: 'VIP Room',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png',
        description: 'A premium private room, great for high-end decor',
        apCost: 300,
        floorWidthRatio: 1,
        floorDepthRatio: 1,
        hasCounter: false,
        hasWindow: true,
    },
    {
        id: 'layout-garden',
        name: 'Sky Garden',
        icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f33f.png',
        description: 'A second-floor open-air terrace style',
        apCost: 250,
        floorWidthRatio: 1,
        floorDepthRatio: 1,
        hasCounter: false,
        hasWindow: true,
    },
];

// --- WALLPAPER / FLOOR PRESETS ---
export const WALLPAPER_PRESETS = [
    { id: 'wp-cream', name: 'Cream White', style: 'linear-gradient(180deg, #FEF9F0, #F5EBD8)' },
    { id: 'wp-blush', name: 'Peach Blush', style: 'linear-gradient(180deg, #FFF0F0, #FFE0E0)' },
    { id: 'wp-mint', name: 'Mint Green', style: 'linear-gradient(180deg, #F0FFF4, #C6F6D5)' },
    { id: 'wp-sky', name: 'Sky Blue', style: 'linear-gradient(180deg, #EBF8FF, #BEE3F8)' },
    { id: 'wp-lavender', name: 'Lavender', style: 'linear-gradient(180deg, #FAF5FF, #E9D8FD)' },
    { id: 'wp-warm', name: 'Warm Sunset', style: 'linear-gradient(180deg, #FFFAF0, #FEEBC8)' },
    { id: 'wp-brick', name: 'Vintage Brick', style: 'repeating-linear-gradient(0deg, #D4A574 0px, #D4A574 8px, #C4956A 8px, #C4956A 10px, #DEB587 10px, #DEB587 18px, #C4956A 18px, #C4956A 20px)' },
    { id: 'wp-stripe', name: 'Stripes', style: 'repeating-linear-gradient(90deg, #FFF8E1 0px, #FFF8E1 12px, #FFE0B2 12px, #FFE0B2 14px)' },
];

export const FLOOR_PRESETS = [
    { id: 'fl-wood', name: 'Wood Floor', style: 'linear-gradient(135deg, #C4A77D, #B8956E)' },
    { id: 'fl-tile', name: 'White Tile', style: 'conic-gradient(from 90deg at 2px 2px, #fdf6e3 90deg, #eee8d5 0) 0 0/20px 20px' },
    { id: 'fl-check', name: 'Checkerboard', style: 'conic-gradient(#eee8d5 90deg, #fdf6e3 90deg 180deg, #eee8d5 180deg 270deg, #fdf6e3 270deg) 0 0 / 20px 20px' },
    { id: 'fl-dark', name: 'Dark Wood Grain', style: 'linear-gradient(135deg, #8B7355, #6D5A3F)' },
    { id: 'fl-marble', name: 'Marble', style: 'linear-gradient(135deg, #F5F5F5 0%, #E0E0E0 25%, #F5F5F5 50%, #EEEEEE 75%, #F5F5F5 100%)' },
    { id: 'fl-tatami', name: 'Tatami', style: 'repeating-linear-gradient(0deg, #C8B88A 0px, #C8B88A 3px, #D4C89A 3px, #D4C89A 6px)' },
];

// --- DEFAULT STICKER LIBRARY ---
export const STICKER_LIBRARY = [
    { id: 'stk-plant1', name: 'Potted Plant', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fab4.png', category: 'decor' },
    { id: 'stk-plant2', name: 'Cactus', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f335.png', category: 'decor' },
    { id: 'stk-flower', name: 'Bouquet', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f490.png', category: 'decor' },
    { id: 'stk-frame', name: 'Photo Frame', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f5bc.png', category: 'wall' },
    { id: 'stk-clock', name: 'Wall Clock', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f550.png', category: 'wall' },
    { id: 'stk-lamp', name: 'Desk Lamp', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa94.png', category: 'decor' },
    { id: 'stk-sofa', name: 'Sofa', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6cb.png', category: 'furniture' },
    { id: 'stk-table', name: 'Table', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa91.png', category: 'furniture' },
    { id: 'stk-book', name: 'Bookshelf', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4da.png', category: 'furniture' },
    { id: 'stk-coffee', name: 'Coffee', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png', category: 'food' },
    { id: 'stk-cake', name: 'Cake', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f370.png', category: 'food' },
    { id: 'stk-candle', name: 'Candle', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f56f.png', category: 'decor' },
    { id: 'stk-rug', name: 'Rug', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9f6.png', category: 'floor' },
    { id: 'stk-cat', name: 'Cat', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f431.png', category: 'pet' },
    { id: 'stk-star', name: 'Star', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2b50.png', category: 'decor' },
    { id: 'stk-heart', name: 'Heart', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2764.png', category: 'decor' },
    { id: 'stk-window', name: 'Window', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa9f.png', category: 'wall' },
    { id: 'stk-sign', name: 'Signboard', url: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1faa7.png', category: 'wall' },
];

// --- INITIAL DOLLHOUSE STATE ---
export const INITIAL_DOLLHOUSE: DollhouseState = {
    rooms: [
        {
            id: 'room-1f-left',
            name: 'Coffee Shop',
            floor: 0,
            position: 'left',
            isUnlocked: true,
            layoutId: 'layout-cafe',
            wallpaperLeft: 'linear-gradient(180deg, #FEF9F0, #F5EBD8)',
            wallpaperRight: 'linear-gradient(180deg, #FEF9F0, #F5EBD8)',
            floorStyle: 'linear-gradient(135deg, #C4A77D, #B8956E)',
            roomTextureUrl: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/CAFE.png',
            stickers: [],
            staffIds: [],
        },
        {
            id: 'room-1f-right',
            name: 'Kitchen',
            floor: 0,
            position: 'right',
            isUnlocked: false,
            layoutId: 'layout-kitchen',
            stickers: [],
            staffIds: [],
        },
        {
            id: 'room-2f-left',
            name: 'Lounge',
            floor: 1,
            position: 'left',
            isUnlocked: false,
            layoutId: 'layout-lounge',
            stickers: [],
            staffIds: [],
        },
        {
            id: 'room-2f-right',
            name: 'VIP Room',
            floor: 1,
            position: 'right',
            isUnlocked: false,
            layoutId: 'layout-vip',
            stickers: [],
            staffIds: [],
        },
    ],
    activeRoomId: null,
};
