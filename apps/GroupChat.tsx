
import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Message, GroupProfile, CharacterProfile, MessageType, ChatTheme, BubbleStyle, EmojiCategory } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { deleteGroupMemoriesByGroupId } from '../utils/memoryPalace/groupPipeline';
import { processImage } from '../utils/file';
import { stickerNameFromUrl } from '../utils/messageFormat';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { resolveChatTheme, scopeBubbleThemeCss } from '../utils/groupChat/theme';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from '../utils/bubbleAppearance';
import { buildChatFineTuneCss } from '../utils/chatFineTuneCss';
import { parseDirectorActions, stripSkipMarker, parseGroupTopicBox } from '../utils/groupChat/parse';
import { GroupPacketMeta, PacketReceiptMeta, ClaimResult, claimPacket, effectivePacketStatus, makePacketMeta } from '../utils/groupChat/redpacket';
import { messageLogText } from '../utils/groupChat/format';
import { trackEvent } from '../utils/analytics';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { buildMemberTimeline, DEFAULT_MEMBER_TIMELINE_CAP } from '../utils/groupChat/timeline';
import { buildEmojiContextStr, buildGroupHistoryBlock, buildDirectorInstruction, buildRoundRobinInstruction, GroupHistoryBlock } from '../utils/groupChat/prompts';
import { dispatchMemberActions } from '../utils/groupChat/dispatch';
import { completeGroupChatWithMcp } from '../utils/groupChat/mcp';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
// Group chat's input area/emoji panel now uses the shared ChatInputArea (its emoji grid has its own
// useIncrementalReveal incremental rendering) — the incremental rendering added for the old inline emoji drawer on master retired along with that old drawer.
import { UsersThree, Money, GearSix, Image as ImageIcon, ArrowsClockwise, PaintBrush, BellSimpleRinging, Code, Question } from '@phosphor-icons/react';
import ChatHeaderShell from '../components/chat/ChatHeaderShell';
import ChatInputArea from '../components/chat/ChatInputArea';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl, isBlobRef, getBlobForRef, migrateDataUrlToRef } from '../utils/blobRef';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import ChromeCssEditor from '../components/chat/ChromeCssEditor';
import WhiteboxSoundEditor from '../components/chat/WhiteboxSoundEditor';
import HtmlCard from '../components/chat/HtmlCard';
import { WhiteboxSound, parseWhiteboxSound, upsertWhiteboxSound, stripWhiteboxSoundDirective, resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio } from '../utils/whiteboxSound';
import { buildHtmlPrompt } from '../utils/htmlPrompt';
import { materializeVisionDescriptions } from '../utils/visionApi';
import {
    buildGroupTopicContext,
    buildGroupTopicPrompt,
    GROUP_TOPIC_BUFFER_THRESHOLD,
    GROUP_TOPIC_HOT_ZONE,
    groupTopicPendingCount,
    makeGroupTopicBox,
    planGroupTopicBatch,
} from '../utils/groupChat/topicBoxes';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

// Reuses Chat.tsx's polished styling logic, tweaked for group chat
const PRESET_THEME_GROUP: ChatTheme = {
    id: 'group_default', name: 'Group', type: 'preset',
    user: { textColor: '#ffffff', backgroundColor: '#8b5cf6', borderRadius: 18, opacity: 1 }, // Violet for User
    ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 18, opacity: 1 }  // White for Others
};

// --- Sub-Component: Red Packet Card (2.0: lucky/exclusive + status badge + receipt settlement bar; legacy simple card for old data) ---
const GroupPacketCard = ({ msg, nameOf, onOpen }: {
    msg: Message;
    nameOf: (id: string) => string;
    onOpen?: (msg: Message) => void;
}) => {
    const meta = msg.metadata as (Partial<GroupPacketMeta> & Partial<PacketReceiptMeta>) | undefined;

    // Receipt: mini settlement bar (matches private chat TransferCard's receipt visuals)
    if (meta?.packetReceipt) {
        const claimed = meta.packetReceipt === 'claimed';
        return (
            <div className={`px-3 py-2 rounded-xl border text-[11px] flex items-center gap-2 ${claimed ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                <span>🧧</span>
                <span>{meta.claimantName} {claimed ? 'claimed' : 'returned'} {meta.senderName}'s red packet{claimed && meta.amount != null ? ` ¥${meta.amount}` : ''}</span>
            </div>
        );
    }

    // Old data (no packet discriminator field): legacy simple card, rendering semantics unchanged
    if (!meta?.packet) {
        return (
            <div className="w-60 bg-[#fb923c] text-white p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden">
                <div className="text-2xl">🧧</div>
                <div className="z-10">
                    <div className="font-bold text-sm tracking-wide">Red Packet / Transfer</div>
                    <div className="text-[10px] opacity-90">Sully Pay</div>
                </div>
            </div>
        );
    }

    const m = meta as GroupPacketMeta;
    const status = effectivePacketStatus(m, Date.now());
    const opened = status !== 'pending';
    const statusText = m.packetType === 'lucky'
        ? (status === 'pending' ? `${m.shares - m.claims.length} left to grab` : status === 'done' ? 'All claimed' : 'Expired')
        : (status === 'pending' ? `Waiting for ${nameOf(m.targetId || '')} to claim` : status === 'done' ? 'Received' : status === 'returned' ? 'Returned' : 'Expired');

    return (
        <div
            onClick={() => onOpen?.(msg)}
            className={`w-60 p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden active:scale-95 transition-transform cursor-pointer text-white ${opened ? 'bg-[#f0b48c]' : 'bg-gradient-to-br from-[#fb923c] to-[#f43f5e]'}`}
        >
            <div className="text-3xl drop-shadow-sm">🧧</div>
            <div className="z-10 min-w-0 flex-1 pb-3">
                <div className="font-bold text-sm tracking-wide truncate">{m.note}</div>
                <div className="text-[10px] opacity-90">{m.packetType === 'lucky' ? `Lucky Red Packet · ${m.shares} shares` : `Exclusive Red Packet · to ${nameOf(m.targetId || '')}`}</div>
            </div>
            <div className="absolute right-2 bottom-1.5 text-[9px] bg-black/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">{statusText}</div>
        </div>
    );
};

// --- Sub-Component: Group Message Bubble ---
const GroupMessageItem = React.memo(({
    msg,
    isUser,
    char,
    userAvatar,
    onImageClick,
    selectionMode,
    isSelected,
    onToggleSelect,
    onLongPress,
    onReply,
    nameOf,
    onPacketClick,
    styleConfig,
    themeScopeClass,
    isFirstInGroup,
    isLastInGroup,
    avatarShape = 'circle',
    avatarSize = 'medium',
    avatarMode = 'grouped',
    bubbleVariant = 'modern',
    messageSpacing = 'default',
    showTimestamp = 'always',
}: {
    msg: Message,
    isUser: boolean,
    char?: CharacterProfile,
    userAvatar: string,
    onImageClick: (url: string) => void,
    selectionMode: boolean,
    isSelected: boolean,
    onToggleSelect: (id: number) => void,
    onLongPress: (id: number) => void,
    onReply: (msg: Message) => void,
    nameOf: (id: string) => string,
    onPacketClick: (msg: Message) => void,
    /** Bubble style (user = the theme selected in group settings, user side; member = shared or each member's own private-chat theme, ai side). Reference must be stable (memo). */
    styleConfig: BubbleStyle,
    /** Scopes the current member's Bubble Workshop CSS to only their own messages, preventing themes from bleeding across group members. */
    themeScopeClass: string,
    isFirstInGroup: boolean,
    isLastInGroup: boolean,
    avatarShape?: 'circle' | 'rounded' | 'square',
    avatarSize?: 'small' | 'medium' | 'large',
    avatarMode?: 'grouped' | 'every_message',
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios',
    messageSpacing?: 'compact' | 'default' | 'spacious',
    showTimestamp?: 'always' | 'hover' | 'never',
}) => {
    const avatar = isUser ? userAvatar : char?.avatar;
    const name = isUser ? 'Me' : char?.name || 'Unknown member';

    const spacingClass = messageSpacing === 'compact'
        ? (isLastInGroup ? 'mb-3' : 'mb-0.5')
        : messageSpacing === 'spacious'
            ? (isLastInGroup ? 'mb-8' : 'mb-2.5')
            : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
    const cornerRadii = resolveBubbleCornerRadii(styleConfig);
    const hideBubbleTail = shouldHideBubbleTail(styleConfig.tailMode, isLastInGroup);
    const bubbleGroupClasses = [
        isFirstInGroup ? 'sully-bubble-group-first' : '',
        isLastInGroup ? 'sully-bubble-group-last' : '',
        hideBubbleTail ? 'sully-bubble-tail-hidden' : 'sully-bubble-tail-visible',
    ].filter(Boolean).join(' ');
    const bubbleStyle: React.CSSProperties = {
        backgroundColor: bubbleVariant === 'outline' ? 'transparent' : styleConfig.backgroundColor,
        opacity: styleConfig.opacity ?? 1,
        borderTopLeftRadius: cornerRadii.topLeft,
        borderTopRightRadius: cornerRadii.topRight,
        borderBottomRightRadius: cornerRadii.bottomRight,
        borderBottomLeftRadius: cornerRadii.bottomLeft,
        ...(bubbleVariant === 'outline' ? { border: `2px solid ${styleConfig.backgroundColor}`, boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'shadow' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } : {}),
        ...(bubbleVariant === 'flat' ? { boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'wechat' ? { boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' } : {}),
        ...(bubbleVariant === 'ios' ? { boxShadow: '0 10px 24px rgba(148,163,184,0.16)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' } : {}),
    };
    // Bubble background texture is painted via CSS background-image, so it doesn't get the automatic
    // resolution from the <img> layer — it has to be resolved unconditionally once at the top level
    // (hooks can't go inside conditional branches). Decorations/avatar decorations go through TokenImg, resolved within their own components.
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);

    // pointer-event gestures (matches private chat MessageItem's approach): 600ms long-press → options menu;
    // touch swipe-left ≤-52px → quote reply (with translation animation); right-click → options menu
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);

    // Time formatting
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setReplyOffset(0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (selectionMode || e.button !== 0) return;
        activePointerId.current = e.pointerId;
        activePointerType.current = e.pointerType;
        startPos.current = { x: e.clientX, y: e.clientY };
        document.getSelection()?.removeAllRanges();

        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(msg.id);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) {
                if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) clearLongPressTimer();
                return;
            }
            clearLongPressTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        replyReadyRef.current = nextOffset <= -52;
        setReplyOffset(nextOffset);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(msg);
    };

    const handlePointerCancel = () => {
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            onToggleSelect(msg.id);
        }
    };

    const renderAvatar = (forceVisible = false) => (
        <div className={`relative ${avatarSizeClass} z-0 sully-chat-message-avatar`}>
            {(forceVisible || shouldShowAvatar) && (
                <>
                    <TokenImg
                        value={avatar}
                        className={`sully-chat-message-avatar-img w-full h-full ${avatarRadiusClass} object-cover shadow-sm ring-1 ring-black/5 relative z-0`}
                        alt="avatar"
                        loading="lazy"
                        decoding="async"
                    />
                    {styleConfig.avatarDecoration && (
                        <TokenImg
                            value={styleConfig.avatarDecoration}
                            className="absolute pointer-events-none z-10 max-w-none"
                            style={{
                                left: `${styleConfig.avatarDecorationX ?? 50}%`,
                                top: `${styleConfig.avatarDecorationY ?? 50}%`,
                                width: `${avatarSizePx * (styleConfig.avatarDecorationScale ?? 1)}px`,
                                height: 'auto',
                                transform: `translate(-50%, -50%) rotate(${styleConfig.avatarDecorationRotate ?? 0}deg)`,
                            }}
                            alt=""
                        />
                    )}
                </>
            )}
        </div>
    );

    // Special Content Renderers
    const renderContent = () => {
        switch (msg.type) {
            case 'image':
                return (
                    <div className="relative group cursor-pointer" onClick={(e) => {
                        if (selectionMode) handleClick(e);
                        else onImageClick(msg.content);
                    }}>
                        <TokenImg value={msg.content} className="max-w-[200px] max-h-[200px] rounded-xl shadow-sm border border-black/5" loading="lazy" />
                    </div>
                );
            case 'emoji':
                // Size follows Appearance → Sticker Size (--sully-emoji-size, 3 tiers, default 96px = original w-24)
                return <TokenImg value={msg.content} className="sully-emoji-msg max-w-[var(--sully-emoji-size,96px)] max-h-[var(--sully-emoji-size,96px)] object-contain drop-shadow-sm hover:scale-110 transition-transform" />;
            case 'transfer':
                return (
                    <div onClick={(e) => { if (selectionMode) handleClick(e); }}>
                        <GroupPacketCard msg={msg} nameOf={nameOf} onOpen={selectionMode ? undefined : onPacketClick} />
                    </div>
                );
            case 'html_card': {
                const html = typeof msg.metadata?.htmlSource === 'string' ? msg.metadata.htmlSource : '';
                if (!html) {
                    return (
                        <div className="px-4 py-3 rounded-2xl bg-fuchsia-50 text-fuchsia-500 text-xs italic border border-fuchsia-100">
                            [HTML Card Data Missing]
                        </div>
                    );
                }
                return <HtmlCard html={html} />;
            }
            default:
                return (
                    <div
                        className={`relative px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-all overflow-visible active:scale-[0.98] transition-transform ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm'} ${bubbleVariant === 'outline' ? '' : 'border border-black/5'} ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'} ${bubbleGroupClasses}`}
                        style={bubbleStyle}
                    >
                        {bubbleBgUrl && (
                            <div
                                className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
                                style={{
                                    backgroundImage: `url(${bubbleBgUrl})`,
                                    opacity: styleConfig.backgroundImageOpacity ?? 0.5,
                                    borderRadius: 'inherit',
                                }}
                            />
                        )}
                        {styleConfig.decoration && (
                            <TokenImg
                                value={styleConfig.decoration}
                                className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                                style={{
                                    left: `${styleConfig.decorationX ?? (isUser ? 90 : 10)}%`,
                                    top: `${styleConfig.decorationY ?? -10}%`,
                                    transform: `translate(-50%, -50%) scale(${styleConfig.decorationScale ?? 1}) rotate(${styleConfig.decorationRotate ?? 0}deg)`,
                                }}
                                alt=""
                            />
                        )}
                        {msg.replyTo && (
                            <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                                <span className="font-bold opacity-90 truncate">{msg.replyTo.name}</span>
                                {/* Historical snapshots may still store a raw token / data: / image-host URL as-is —
                                    truncating to 10 characters would just leave a `blobref:b_` string in the bubble;
                                    hand off to the same write-side snapshot function to swap in a placeholder */}
                                <span className="truncate italic">"{buildReplySnapshotContent({ content: msg.replyTo.content })}"</span>
                            </div>
                        )}
                        <div className="relative z-10 select-text" style={{ color: styleConfig.textColor }}>{msg.content}</div>
                    </div>
                );
        }
    };

    return (
        <div
            className={`${themeScopeClass} sully-chat-message ${isUser ? 'sully-chat-message-user justify-end' : 'sully-chat-message-ai justify-start'} ${isFirstInGroup ? 'sully-chat-message-group-first' : ''} ${isLastInGroup ? 'sully-chat-message-group-last' : ''} flex items-end ${spacingClass} px-3 w-full group relative transition-[padding] duration-300 ${selectionMode ? 'pl-12' : ''}`}
            style={{ '--sully-chat-message-avatar-size': `${avatarSizePx}px` } as React.CSSProperties}
        >
            {selectionMode && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={handleClick}>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-violet-500 border-violet-500' : 'border-slate-300 bg-white'}`}>
                        {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                    </div>
                </div>
            )}

            {isFirstInGroup && (
                <div className={`sully-chat-turn-avatar-slot hidden absolute top-0 z-0 ${isUser ? 'right-3' : (selectionMode ? 'left-14' : 'left-3')}`}>
                    {renderAvatar(true)}
                </div>
            )}

            {!isUser && (
                <div className={`sully-chat-message-avatar-slot absolute bottom-0 z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-[left] duration-300`}>
                    {renderAvatar()}
                </div>
            )}

            <div className={`sully-chat-message-content relative min-w-0 max-w-[72%] ${isUser ? 'mr-12' : 'ml-12'}`}>
                <div
                    className={`relative flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 ${selectionMode ? 'pointer-events-none' : ''}`}
                    style={{
                        transform: `translateX(${replyOffset}px)`,
                        transition: isReplyGestureActive ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                        touchAction: 'pan-y',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                    } as React.CSSProperties}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerCancel}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectionMode || replyGestureActiveRef.current) return;
                        clearLongPressTimer();
                        activePointerId.current = null;
                        activePointerType.current = '';
                        resetReplyGesture();
                        onLongPress(msg.id);
                    }}
                    onDragStart={(e) => e.preventDefault()}
                    onClick={handleClick}
                >
                    {!isUser && isFirstInGroup && (
                        <span className="sully-chat-message-sender text-[10px] text-slate-400 ml-1 mb-1">{name}</span>
                    )}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {renderContent()}
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <span className={`absolute top-full ${isUser ? 'right-0' : 'left-0'} mt-0.5 px-1 text-[9px] text-slate-400/80 font-medium whitespace-nowrap pointer-events-none ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{timeStr}</span>
                    )}
                </div>
            </div>

            {isUser && (
                <div className="sully-chat-message-avatar-slot absolute right-3 bottom-0 z-0">
                    {renderAvatar()}
                </div>
            )}
        </div>
    );
});

// --- Main Component ---

const GroupChat: React.FC = () => {
    const { closeApp, groups, createGroup, updateGroup, deleteGroup, characters, apiConfig, addToast, userProfile, virtualTime, characterGroups, theme: osTheme, customThemes, realtimeConfig } = useOS();
    const [view, setView] = useState<'list' | 'chat'>('list');
    const [activeGroup, setActiveGroup] = useState<GroupProfile | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const MESSAGE_PAGE_SIZE = 50;
    const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);
    const [input, setInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [mcpStatus, setMcpStatus] = useState('');
    /** Public topic box organizing status — shows the top status pill when non-empty */
    const [groupPalaceStatus, setGroupPalaceStatus] = useState<string>('');

    // Use the latest character names and member profiles when the public box archive finishes asynchronously, to avoid stale closure data during a long reply.
    const charactersRef = useRef(characters);
    charactersRef.current = characters;

    // Similarly keep a ref of the latest messages: the dispatch loop refreshes by "current window size" as it
    // saves each message to the DB one at a time — the messages in the closure are the stale value from the
    // moment it was triggered, so its length only ever shrinks
    const messagesRef = useRef<Message[]>([]);
    messagesRef.current = messages;

    // Group activity feeds into the [Group Chat Background] block of every member's private-chat prompt, and
    // when a topic box gets sealed it also writes a card straight into members' private chat history — both
    // are material for Proactive Message 2.0's cloud snapshot (fire_pack). Whenever something happens in the
    // group, mark each member dirty individually, or the character will still be living in a stale group state
    // by the time their private chat comes around. Multiple calls in the same round get merged into a single
    // upload within the microtask; members without Proactive Message enabled get filtered out by the gate
    // inside markAmsgStateDirty.
    const markGroupMembersDirty = useCallback((memberIds: string[]) => {
        for (const memberId of memberIds) {
            const member = charactersRef.current.find(c => c.id === memberId);
            if (member) markAmsgStateDirty({ char: member, userProfile, groups, realtimeConfig });
        }
    }, [userProfile, groups, realtimeConfig]);

    // Token stats — matches private chat ChatHeader's token badge
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    
    // UI State — panel state matches private chat ChatInputArea's showPanel convention
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [activeEmojiCategory, setActiveEmojiCategory] = useState('default');
    const [modalType, setModalType] = useState<'none' | 'create' | 'settings' | 'transfer' | 'member_select' | 'message-options' | 'edit-message' | 'packet-detail' | 'chrome-css' | 'chrome-sound' | 'html-prompt' | 'help'>('none');
    const [tempHtmlPrompt, setTempHtmlPrompt] = useState('');
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');
    const [preserveContext, setPreserveContext] = useState(true);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [summaryProgress, setSummaryProgress] = useState('');
    const [topicPendingCount, setTopicPendingCount] = useState(0);
    const [editingTopicBoxId, setEditingTopicBoxId] = useState<string | null>(null);
    const [topicTitleDraft, setTopicTitleDraft] = useState('');
    const [topicSummaryDraft, setTopicSummaryDraft] = useState('');

    // Context limit (like Chat app's settingsContextLimit)
    const [contextLimit, setContextLimit] = useState<number>(() => {
        // If the localStorage value is corrupted, parseInt yields NaN, and slice(-NaN) would stuff the entire history into the prompt
        try {
            const v = parseInt(localStorage.getItem('groupchat_context_limit') || '30', 10);
            return Number.isFinite(v) && v > 0 ? v : 30;
        } catch { return 30; }
    });
    
    // Selection Mode
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());

    // Data State
    const [emojis, setEmojis] = useState<{name: string, url: string, categoryId?: string}[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]); // New
    
    // Create/Edit Group State
    const [tempGroupName, setTempGroupName] = useState('');
    const [tempPrivateContextCap, setTempPrivateContextCap] = useState<number>(80);
    const [tempMemberTimelineCap, setTempMemberTimelineCap] = useState<number>(DEFAULT_MEMBER_TIMELINE_CAP);
    const [tempReplyMode, setTempReplyMode] = useState<'director' | 'roundRobin'>('director');
    const [tempMemberBubbleIndependent, setTempMemberBubbleIndependent] = useState(false);
    const [tempUserBubbleThemeId, setTempUserBubbleThemeId] = useState<string>('');
    const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
    const [memberGroupId, setMemberGroupId] = useState(GROUP_FILTER_ALL); // Group filter for member selection when creating a group
    const [transferAmount, setTransferAmount] = useState('');
    // Red Packet 2.0: send-dialog tab / share count / exclusive target / greeting message; the red packet message id locked into the detail popup
    const [packetTab, setPacketTab] = useState<'lucky' | 'direct'>('lucky');
    const [packetShares, setPacketShares] = useState('5');
    const [packetTargetId, setPacketTargetId] = useState<string>('');
    const [packetNote, setPacketNote] = useState('');
    const [selectedPacketId, setSelectedPacketId] = useState<number | null>(null);
    
    // Refs
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const groupAvatarInputRef = useRef<HTMLInputElement>(null);
    // Cancel handle while generating: non-null = currently generating, clicking the trigger button again = stop
    const abortRef = useRef<AbortController | null>(null);
    const topicArchiveLockRef = useRef(false);
    // Whitebox notification-sound round timing (matches private chat Chat.tsx's soundSyncRef approach)
    const SOUND_ROUND_GAP_MS = 3000;
    const soundSyncRef = useRef<{ groupId: string | null; maxId: number | null; lastAt: number | null }>({ groupId: null, maxId: null, lastAt: null });

    // Initial Load
    useEffect(() => {
        if (activeGroup) {
            setVisibleCount(MESSAGE_PAGE_SIZE);
            DB.getRecentGroupMessagesWithCount(activeGroup.id, MESSAGE_PAGE_SIZE).then(({ messages: msgs, totalCount }) => {
                setMessages(msgs);
                setTotalMsgCount(totalCount);
            });
            // Fetch emojis AND categories
            Promise.all([DB.getEmojis(), DB.getEmojiCategories()]).then(([es, cats]) => {
                setEmojis(es);
                setCategories(cats);
            });
        }
    }, [activeGroup]);

    // Auto Scroll
    useLayoutEffect(() => {
        if (scrollRef.current && !selectionMode) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages.length, activeGroup, showPanel, isTyping, selectionMode]);

    // Whitebox notification sound: plays once when a member's new message becomes the last one in the group
    // (doesn't play for the user's own messages or when scrolling old messages). Logic matches private chat
    // Chat.tsx — switching groups only records the baseline without playing, multiple bubbles in one round only
    // play on the first one, and the baseline only ever increases.
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        if (sync.groupId !== (activeGroup?.id ?? null)) {
            sync.groupId = activeGroup?.id ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew && last?.role === 'assistant') {
            const now = Date.now();
            if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                playWhiteboxSound(resolveActiveSound(activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
            }
            sync.lastAt = now;
        }
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeGroup?.id, activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound]);

    const displayMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount]);
    const collapsedCount = Math.max(0, totalMsgCount - messages.length);

    const canReroll = useMemo(() => {
        if (isTyping || messages.length === 0) return false;
        const lastMsg = messages[messages.length - 1];
        return lastMsg.role === 'assistant';
    }, [isTyping, messages]);

    // --- Helpers ---

    const getTimeGapHint = (lastMsgTimestamp: number): string => {
        const now = Date.now();
        const diffHours = Math.floor((now - lastMsgTimestamp) / (1000 * 60 * 60));
        const diffMins = Math.floor((now - lastMsgTimestamp) / (1000 * 60));
        const diffDays = Math.floor(diffHours / 24);

        const currentHour = new Date().getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;

        if (diffMins < 10) return '聊天正在火热进行中，大家都很活跃。';
        if (diffMins < 60) return `距离上次发言过了 ${diffMins} 分钟，话题可能有点冷场。`;
        if (diffHours < 12) return `距离上次发言过了 ${diffHours} 小时。${isNight ? '现在是深夜。' : ''}`;
        if (diffHours < 24) return `距离上次发言过了 ${diffHours} 小时，群里安静了大半天。`;
        // 隔天以上：明确"日子已经过去了"，别把上一条当作刚刚发生、无缝续上旧话题。
        return `距离群里上一条消息已经过了 ${diffDays} 天（${diffHours} 小时）。这段时间是真实流逝的——各自都过了好几天的生活，之前那个话题早就不是"刚才"的事了。除非有人明确重新提起，别当无事发生、直接续上几天前那句话；更自然的是有种"好久没聊了"的重启感，或者干脆聊点新的。`;
    };

    // New: Calculate private chat gap
    const getPrivateTimeGap = async (charId: string): Promise<string> => {
        // includeProcessed=true：私聊被记忆宫殿归档（高水位以下）后仍然算"聊过"，
        // 否则全量归档过的角色会被误报成"从未私聊过"
        const [lastMsg] = await DB.getRecentMessagesByCharId(charId, 1, true);
        if (!lastMsg) return '从未私聊过';
        const now = Date.now();
        const diffMins = Math.floor((now - lastMsg.timestamp) / (1000 * 60));
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 60) return '刚刚才私聊过';
        if (diffHours < 24) return `${diffHours}小时前私聊过`;
        return `${diffDays}天前私聊过`;
    };

    // Refresh the message window after sending/dispatching a bubble: only fetch "current window + new" messages
    // and sync the total count. It used to do a full-table getGroupMessages read for every bubble, and
    // totalMsgCount never updated, so the "load history" button's count went stale (or even disappeared) after sending
    const refreshMessages = async (groupId: string) => {
        const { messages: msgs, totalCount } = await DB.getRecentGroupMessagesWithCount(groupId, visibleCount);
        setMessages(msgs);
        setTotalMsgCount(totalCount);
        return msgs;
    };

    // --- Logic: Selection & Deletion ---

    const handleMessageLongPress = useCallback((id: number) => {
        const msg = messagesRef.current.find(m => m.id === id);
        if (msg) {
            setSelectedMessage(msg);
            setModalType('message-options');
        }
        setShowPanel('none');
    }, []);

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('Copied to clipboard', 'success');
        trackEvent('Copy Group Message Text');
    };

    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const handleDeleteSingleMessage = async () => {
        if (!selectedMessage) return;
        await DB.deleteMessage(selectedMessage.id);
        setMessages(prev => prev.filter(m => m.id !== selectedMessage.id));
        setModalType('none');
        setSelectedMessage(null);
        addToast('Message deleted', 'success');
        trackEvent('Delete Group Message');
    };

    const handleStartEditMessage = () => {
        if (!selectedMessage) return;
        setEditContent(selectedMessage.content);
        setModalType('edit-message');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        await DB.updateMessage(selectedMessage.id, editContent);
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('Message updated', 'success');
        trackEvent('Edit Group Message');
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const deleteSelectedMessages = async () => {
        if (selectedMsgIds.size === 0) return;
        await DB.deleteMessages(Array.from(selectedMsgIds));
        setMessages(prev => prev.filter(m => !selectedMsgIds.has(m.id)));
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        addToast(`${selectedMsgIds.size} messages deleted`, 'success');
    };

    const handleReroll = async () => {
        if (!canReroll) return;
        
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        // Find all contiguous assistant messages at the end
        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('Rewinding conversation...', 'info');
        trackEvent('Regenerate Group Chat Reply');

        triggerGroupAI(newHistory);
    };

    // --- Logic: Group Management ---

    const handleCreateGroup = () => {
        if (!tempGroupName.trim() || selectedMembers.size < 2) {
            addToast('Enter a group name and select at least 2 members', 'error');
            return;
        }
        createGroup(tempGroupName, Array.from(selectedMembers));
        setModalType('none');
        setTempGroupName('');
        setSelectedMembers(new Set());
        addToast('Group chat created', 'success');
    };

    const handleUpdateGroupInfo = async () => {
        if (!activeGroup) return;
        const updates = {
            name: tempGroupName || activeGroup.name,
            privateContextCap: tempPrivateContextCap,
            memberTimelineCap: tempMemberTimelineCap,
            replyMode: tempReplyMode,
            memberBubbleIndependent: tempMemberBubbleIndependent,
            // Empty string = default violet, stored as undefined to preserve backward-compat semantics
            userBubbleThemeId: tempUserBubbleThemeId || undefined,
        };
        // Goes through context's updateGroup: syncs in-memory groups + DB, avoiding stale values being read back after exiting
        await updateGroup(activeGroup.id, updates);
        setActiveGroup({ ...activeGroup, ...updates });
        setModalType('none');
        addToast('Group info updated', 'success');
    };

    const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeGroup) return;
        try {
            const base64 = await processImage(file);
            // Group avatar stores a token, with the binary sitting separately in blob_assets; if conversion fails, this data URL is returned as-is so the image isn't lost
            const avatar = await migrateDataUrlToRef(base64);
            // Goes through context's updateGroup: syncs in-memory groups + DB,
            // otherwise only the local activeGroup changes, and exiting to the list/re-entering the group would read back the old avatar (reverting to default)
            await updateGroup(activeGroup.id, { avatar });
            setActiveGroup({ ...activeGroup, avatar });
            addToast('Group avatar updated', 'success');
        } catch (err: any) {
            addToast('Image processing failed', 'error');
        }
    };

    const toggleMemberSelection = (id: string) => {
        const next = new Set(selectedMembers);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedMembers(next);
    };

    const handleDeleteGroup = async (id: string) => {
        // Clean up any group memory copies left over from older versions, and any public topic box cards delivered to members' private chats.
        try {
            const result = await deleteGroupMemoriesByGroupId(id);
            if (result.deleted > 0) {
                console.log(`🗑️ [GroupChat] Cleaned up ${result.deleted} group memories while disbanding group`);
            }
        } catch (err) {
            console.warn('🗑️ [GroupChat] Failed to clean up group memories (does not affect disbanding):', err);
        }
        const targetGroup = groups.find(g => g.id === id);
        if (targetGroup) {
            // Scan all characters rather than just current members: people who already left the group may still have early topic-box cards.
            await Promise.all(characters.map(async ({ id: memberId }) => {
                const msgs = await DB.getMessagesByCharId(memberId, true);
                const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.groupId === id).map(m => m.id);
                if (ids.length) await DB.deleteMessages(ids);
            }));
        }
        await deleteGroup(id);
        if (activeGroup?.id === id) setView('list');
        addToast('Group chat disbanded', 'success');
    };

    const handleClearHistory = async () => {
        if (!activeGroup) return;

        // Fetch ALL messages from DB, not just the loaded subset
        const allGroupMsgs = await DB.getGroupMessages(activeGroup.id);

        let msgsToDelete = allGroupMsgs;
        let keepCount = 0;

        if (preserveContext) {
            msgsToDelete = allGroupMsgs.slice(0, -10);
            keepCount = Math.min(allGroupMsgs.length, 10);
        }

        if (msgsToDelete.length === 0) {
            addToast('Too few messages to clean up', 'info');
            return;
        }

        await DB.deleteMessages(msgsToDelete.map(m => m.id));

        // Refresh local state
        const remaining = preserveContext ? allGroupMsgs.slice(-10) : [];
        setMessages(remaining);
        setTotalMsgCount(remaining.length);

        addToast(`${msgsToDelete.length} records cleared${preserveContext ? ' (kept the most recent 10)' : ''}`, 'success');
        trackEvent('Clear Group Chat History', { preserve: preserveContext ? 'on' : 'off' });
        setModalType('none');
    };

    // --- Logic: Group Summary & Distribution ---

    // --- Logic: Messaging ---

    const handleSendMessage = async (content: string, type: MessageType = 'text', metadata?: any) => {
        if (!activeGroup) return;
        if (type === 'text' && !content.trim()) return;
        // Piggyback on the user's "send" gesture to unlock the audio context (mobile autoplay policy), so the notification sound can actually play when the AI replies later
        unlockWhiteboxAudio();
        
        const newMessage: any = {
            charId: 'user',
            groupId: activeGroup.id,
            role: 'user' as const,
            type,
            content,
            metadata
        };

        // Quote reply: save a snapshot (matches private chat Chat.tsx's approach), clear it after sending.
        // Images/stickers use a placeholder — don't store the raw blobref token in the snapshot.
        if (replyTarget) {
            newMessage.replyTo = {
                id: replyTarget.id,
                content: buildReplySnapshotContent(replyTarget),
                name: replyTarget.role === 'user'
                    ? 'Me'
                    : (characters.find(c => c.id === replyTarget.charId)?.name || 'Member'),
            };
            setReplyTarget(null);
        }

        await DB.saveMessage(newMessage);
        await refreshMessages(activeGroup.id);
        markGroupMembersDirty(activeGroup.members);

        // Close panels
        if (type !== 'text') {
            setShowPanel('none');
        }
        setInput('');

        // NOTE: No auto-trigger. User must click lightning button.
    };

    const handleImageFile = async (file: File) => {
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.7, forceJpeg: true });
            // Group chat image messages store a token, with the binary sitting separately in blob_assets (avoids base64's ~33% bloat).
            // If the same image was stored before, its token gets reused; if conversion fails, this data URL is returned as-is so the image isn't lost.
            handleSendMessage(await migrateDataUrlToRef(base64), 'image');
        } catch (err) {
            addToast('Failed to send image', 'error');
        }
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await handleImageFile(file);
        if (e.target) e.target.value = '';
    };

    // --- Logic: Red Packet 2.0 ---

    const nameOf = useCallback(
        (id: string) => (id === 'user' ? userProfile.name : (characters.find(c => c.id === id)?.name || 'Member')),
        [characters, userProfile.name],
    );

    const handleSendPacket = () => {
        if (!activeGroup) return;
        const total = parseFloat(transferAmount);
        if (!Number.isFinite(total) || total <= 0) { addToast('Enter a valid amount', 'error'); return; }
        let meta: GroupPacketMeta;
        if (packetTab === 'lucky') {
            const shares = parseInt(packetShares, 10);
            if (!Number.isFinite(shares) || shares < 1) { addToast('At least 1 share required', 'error'); return; }
            if (total / shares < 0.01) { addToast('Each share must be at least 0.01, too many shares', 'error'); return; }
            meta = makePacketMeta({ packetType: 'lucky', totalAmount: total, shares, note: packetNote, now: Date.now() });
        } else {
            if (!packetTargetId) { addToast('Choose a member as the exclusive red packet recipient', 'error'); return; }
            meta = makePacketMeta({ packetType: 'direct', totalAmount: total, targetId: packetTargetId, note: packetNote, now: Date.now() });
        }
        handleSendMessage('[Red Packet]', 'transfer', meta);
        setModalType('none');
        setTransferAmount('');
        setPacketNote('');
    };

    const openPacketDetail = useCallback((msg: Message) => {
        setSelectedPacketId(msg.id);
        setModalType('packet-detail');
    }, []);

    // Tap an image to view it full-size: new tabs only understand real URLs, so a blobref token has to be
    // converted to an objectURL first (top-level data: navigation is blocked by browsers, only objectURL works).
    // Don't reclaim it immediately after opening — the new tab is still loading it; revoke after a minute,
    // by which point the image has long finished loading, without keeping the whole image pinned in memory forever.
    const handleGroupImageClick = useCallback(async (url: string) => {
        if (!isBlobRef(url)) { window.open(url, '_blank'); return; }
        const blob = await getBlobForRef(url);
        if (!blob) { addToast('Image data lost', 'error'); return; }
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, '_blank');
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }, [addToast]);
    const handleGroupReply = useCallback((target: Message) => { setReplyTarget(target); trackEvent('Quote Reply to Group Message'); }, []);

    // User grab/receive/return: reruns the state machine inside the updater (dedupes against the latest claims in the DB, to guard against concurrent double-writes with AI dispatch)
    const handleUserPacketAction = async (msg: Message, action: 'claim' | 'return') => {
        if (!activeGroup) return;
        const now = Date.now();
        let outcome = { ok: false, reason: 'not_pending' } as ClaimResult;
        try {
            await DB.updateMessageMetadata(msg.id, prev => {
                outcome = claimPacket(prev as GroupPacketMeta, 'user', now, action);
                return outcome.ok ? outcome.meta : prev;
            });
        } catch { /* Message was deleted — treat as failure */ }
        if (!outcome.ok) {
            const reasonText: Record<string, string> = {
                expired: 'This red packet has expired',
                already_claimed: 'You already claimed this red packet',
                sold_out: 'Too slow, the red packet is all claimed',
                not_target: 'This red packet was not sent to you',
                not_pending: 'This red packet has already been processed',
            };
            addToast(reasonText[outcome.reason] || 'Action failed', 'info');
        } else {
            const senderName = msg.role === 'user' ? userProfile.name : nameOf(msg.charId);
            const receipt: PacketReceiptMeta = {
                packetReceipt: outcome.action,
                ref: msg.id,
                amount: outcome.action === 'claimed' ? outcome.amount : undefined,
                claimantName: userProfile.name,
                senderName,
            };
            await DB.saveMessage({
                charId: 'user',
                groupId: activeGroup.id,
                role: 'user',
                type: 'transfer',
                content: outcome.action === 'claimed' ? '[Claimed Red Packet]' : '[Returned Red Packet]',
                metadata: receipt,
            });
            addToast(outcome.action === 'claimed' ? `You grabbed ¥${outcome.amount}` : 'Red packet returned', 'success');
            trackEvent('Claim or Return Group Red Packet', { action });
        }
        await refreshMessages(activeGroup.id);
        markGroupMembersDirty(activeGroup.members);
    };

    // --- Logic: Bubble System ---
    // Keep the full ChatTheme: group chat no longer just picks out the base color values, it also reuses the Bubble Workshop customCss.
    const userBubbleTheme = useMemo<ChatTheme>(() => (
        activeGroup?.userBubbleThemeId
            ? resolveChatTheme(activeGroup.userBubbleThemeId, customThemes, PRESET_THEMES)
            : PRESET_THEME_GROUP
    ), [activeGroup?.userBubbleThemeId, customThemes]);

    const memberBubbleThemes = useMemo(() => {
        const map = new Map<string, ChatTheme>();
        if (activeGroup?.memberBubbleIndependent) {
            for (const mid of activeGroup.members) {
                const c = characters.find(ch => ch.id === mid);
                map.set(mid, resolveChatTheme(c?.bubbleStyle, customThemes, PRESET_THEMES));
            }
        }
        return map;
    }, [activeGroup?.memberBubbleIndependent, activeGroup?.members, characters, customThemes]);

    const memberThemeScopeClasses = useMemo(() => {
        const map = new Map<string, string>();
        activeGroup?.members.forEach((mid, index) => map.set(mid, `sully-group-member-theme-${index}`));
        return map;
    }, [activeGroup?.members]);

    const groupBubbleCustomCss = useMemo(() => {
        const chunks: string[] = [];
        if (userBubbleTheme.customCss) {
            chunks.push(scopeBubbleThemeCss(userBubbleTheme.customCss, '.sully-group-user-theme'));
        }
        memberBubbleThemes.forEach((theme, mid) => {
            const scopeClass = memberThemeScopeClasses.get(mid);
            if (theme.customCss && scopeClass) {
                chunks.push(scopeBubbleThemeCss(theme.customCss, `.${scopeClass}`));
            }
        });
        return chunks.filter(Boolean).join('\n');
    }, [userBubbleTheme.customCss, memberBubbleThemes, memberThemeScopeClasses]);

    // Emoji panel filtered by category (matches private chat ChatInputArea's behavior)
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        if (activeEmojiCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeEmojiCategory;
    }), [emojis, activeEmojiCategory]);

    const loadTopicBoxStats = async (group: GroupProfile) => {
        try {
            const allMsgs = await DB.getGroupMessages(group.id);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, group.archivedThroughMessageId || 0));
        } catch {
            setTopicPendingCount(0);
        }
    };

    const openGroupSettings = () => {
        setTempGroupName(activeGroup?.name || '');
        setTempPrivateContextCap(activeGroup?.privateContextCap ?? 80);
        setTempMemberTimelineCap(activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP);
        setTempReplyMode(activeGroup?.replyMode ?? 'director');
        setTempMemberBubbleIndependent(activeGroup?.memberBubbleIndependent ?? false);
        setTempUserBubbleThemeId(activeGroup?.userBubbleThemeId ?? '');
        if (activeGroup) void loadTopicBoxStats(activeGroup);
        setModalType('settings');
        setShowPanel('none');
        trackEvent('Open Group Settings Panel');
    };

    // ChatInputArea's panel actions: group chat only handles emoji sending/category switching —
    // sticker management (import/rename/delete/create category) directs users to do it from a private chat, that whole Modal lives in ChatModals
    const handlePanelAction = (type: string, payload?: any) => {
        switch (type) {
            case 'send-emoji':
                handleSendMessage(payload.url, 'emoji');
                break;
            case 'select-category':
                setActiveEmojiCategory(payload);
                break;
            case 'emoji-import':
            case 'emoji-options':
            case 'category-options':
            case 'add-category':
            case 'delete-emoji-req':
                addToast('Manage stickers from the emoji panel in a private chat', 'info');
                break;
            default:
                break;
        }
    };

    // --- Logic: Group AI Generation (Director / Round-Robin) ---

    // Shared by both modes: the system header (group name/time/shared scene).
    // The shared-scene block (user profile + shared worldbook + shared worldview) — the stage that every
    // character "sees" is only described once, avoiding an N-times duplication per member; each character's
    // persona/impressions/memories still stay complete.
    const buildGroupSystemHeader = (currentMsgs: Message[], groupMembers: CharacterProfile[]) => {
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        const timeGapInfo = lastMsg ? getTimeGapHint(lastMsg.timestamp) : "这是群聊的第一条消息。";
        // 带上完整日期（年月日 + 星期），只给 HH:MM 时角色感知不到"过了几天"——
        // 这正是"很久以后还无缝续上旧话题"的一个来源。virtualTime 只有时分，日期取真实当天。
        const nowDate = new Date();
        const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const currentTimeStr = `${nowDate.getFullYear()}年${nowDate.getMonth() + 1}月${nowDate.getDate()}日 ${weekNames[nowDate.getDay()]} ${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;
        const liveMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const sharedScene = ContextBuilder.buildGroupSharedScene(groupMembers, userProfile, liveMsgs);

        const header = `【系统：群聊模拟器配置】
当前群名: "${activeGroup?.name}"
当前系统时间: ${currentTimeStr}
时间流逝感知: ${timeGapInfo}

${sharedScene.text}${activeGroup ? buildGroupTopicContext(activeGroup) : ''}`;
        return { header, sharedScene };
    };

    // Shared by both modes: a single member's character-profile block (memory palace injection + merged private/group timeline)
    const buildMemberBlock = async (
        member: CharacterProfile,
        currentMsgs: Message[],
        sharedScene: ReturnType<typeof ContextBuilder.buildGroupSharedScene>,
    ): Promise<string> => {
        const timelineCap = activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP;
        // Memory palace retrieval source uses the current group thread (media messages filtered out — base64 can't go into the embedding query):
        // the character should recall memories related to "what's being talked about in the group right now," not private-chat recent events (old behavior, recall went off track)
        const liveGroupMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const palaceQueryMsgs = liveGroupMsgs.slice(-30).filter(m => !m.type || m.type === 'text');
        await injectMemoryPalace(member, palaceQueryMsgs, undefined, userProfile.name);
        // Character block: skip the parts already covered by the shared scene (user profile / shared worldview / shared worldbook)
        const coreContext = ContextBuilder.buildCoreContext(member, userProfile, true, undefined, {
            skipUserProfile: true,
            skipWorldview: sharedScene.worldviewIsShared,
            skipWorldbookIds: sharedScene.sharedWorldbookIds,
            headerOverride: `[Group Member Profile: ${member.name}]`,
        // conversational: group chat is likewise an occasion where the user is actively speaking (see buildTimeAwarenessBlock)
        }, { worldbookMessages: liveGroupMsgs, conversational: true });
        // Get private gap string
        const privateGapInfo = await getPrivateTimeGap(member.id);

        // Merged private+group timeline: lets the character see how the two threads relate in sequence, so the emotional continuity holds together.
        // includeProcessed=true — private chats already archived by the memory palace are still part of the "backdrop," they can't be left out
        const privateMsgs = await DB.getRecentMessagesByCharId(member.id, timelineCap, true);
        const memberTimeline = buildMemberTimeline({
            privateMsgs,
            groupMsgs: liveGroupMsgs,
            cap: timelineCap,
            resolveSpeaker: (m) => m.charId === member.id
                ? '我'
                : (characters.find(c => c.id === m.charId)?.name || '未知成员'),
            stickerName: url => stickerNameFromUrl(emojis, url),
        });

        // Construct Detailed Profile Wrapper
        // CRITICAL FIX: Emphasize Private Context logic
        return `
<<< 角色档案 START: ${member.name} (ID: ${member.id}) >>>
${coreContext}

[重点：私聊状态 (Private Context)]:
- **私聊空窗期**: ${privateGapInfo}
- **重要指令**: 如果 [私聊空窗期] 显示 "刚刚" 或 "几小时前"，请【忽略】群聊的时间流逝感知。哪怕群里很久没说话，只要你和用户私底下刚聊过，就【严禁】说 "好久不见" 或表现出疏离感。
- 你的近期互动时间线（按时间排序；[私聊]=你和用户单独聊的，别人看不见；[群聊]=本群公开记录。仅作为你内心状态的底色，不要变成默认反应模板）：
${memberTimeline || '(暂无互动记录)'}
- **先认清 U**：群聊里的用户，就是你一直在私聊、记忆和印象里认识的同一个人。已经建立的关系、承诺和亲密程度继续成立；公开场合可以换一种表达方式，但不能重置关系或突然把 U 当成普通陌生群友。
- **关于私聊状态如何影响群聊表现**：
  · 私聊在吵架 → **可能**有点别扭/冷淡/借题发挥，但**强度由你的性格决定**。情绪稳定的人不会因为私下闹矛盾就在群里失态；脾气大的人才会带情绪到群里。绝大多数情况是"心里有点疙瘩"而不是"摆脸色给所有人看"。
  · 私聊在甜蜜 → **可能**想低调、不好意思声张，或者反而想隐隐显摆一下，看你性格。**不必每次都"支支吾吾"**——这是套路化反应，不真实。
  · 关键原则：你是一个完整的人，不是"私聊状态的应激反应器"。群里此刻的状态由你本身、群聊话题和既有关系共同决定；私聊不必抢占群聊中心，但它建立的关系底色不会消失。
<<< 角色档案 END >>>
`;
    };

    // [[QUOTE: fragment]] resolution: searches from newest to oldest for a text message whose content contains the fragment,
    // returns undefined if not found (dispatch silently strips the marker, without losing the message body)
    const resolveQuote = (snippet: string) => {
        if (!snippet) return undefined;
        const msgs = messagesRef.current;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type && m.type !== 'text') continue;
            const c = typeof m.content === 'string' ? m.content : '';
            if (c && (c.includes(snippet) || snippet.includes(c))) {
                return {
                    id: m.id,
                    content: c,
                    name: m.role === 'user'
                        ? userProfile.name
                        : (characters.find(ch => ch.id === m.charId)?.name || 'Member'),
                };
            }
        }
        return undefined;
    };

    // When an image is attached, the user message uses structured content (text + image_url), otherwise plain text —
    // avoids compatibility issues with endpoints that don't support the multimodal field
    const buildUserMessageContent = (prompt: string, history: GroupHistoryBlock): any =>
        history.attachedImages.length > 0
            ? [
                { type: 'text', text: prompt },
                ...history.attachedImages.map(img => ({ type: 'image_url', image_url: { url: img.url } })),
              ]
            : prompt;

    /** Group public topic box: calls the summary API only once per group, no longer duplicated per member who has the memory palace enabled. */
    const createNextGroupTopicBox = async (force: boolean = false): Promise<boolean> => {
        if (!activeGroup || topicArchiveLockRef.current || !apiConfig.apiKey) return false;
        const groupForArchive = activeGroup;
        topicArchiveLockRef.current = true;
        if (force) setIsSummarizing(true);
        try {
            const allMsgs = await DB.getGroupMessages(groupForArchive.id);
            const batchPlan = planGroupTopicBatch(allMsgs, groupForArchive.archivedThroughMessageId || 0, force);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, groupForArchive.archivedThroughMessageId || 0));
            if (!batchPlan) {
                if (force) addToast(`The most recent ${GROUP_TOPIC_HOT_ZONE} messages are kept as-is; there is nothing to archive before the hot zone yet`, 'info');
                return false;
            }
            setGroupPalaceStatus(`Organizing ${batchPlan.messages.length} old group messages into a public topic box…`);
            setSummaryProgress(`Organizing ${batchPlan.messages.length} old group messages…`);
            const prompt = buildGroupTopicPrompt(groupForArchive, batchPlan.messages, charactersRef.current, userProfile.name);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 }),
            });
            if (!response.ok) throw new Error(`API returned ${response.status}`);
            const data = await safeResponseJson(response);
            const parsed = parseGroupTopicBox(data.choices?.[0]?.message?.content || '');
            if (!parsed) throw new Error('Could not parse summary format');

            const box = makeGroupTopicBox(groupForArchive, batchPlan.messages, parsed.title, parsed.summary);
            const updatedGroup: GroupProfile = {
                ...groupForArchive,
                topicBoxes: [...(groupForArchive.topicBoxes || []), box],
                archivedThroughMessageId: box.sourceEndMessageId,
            };
            await updateGroup(groupForArchive.id, {
                topicBoxes: updatedGroup.topicBoxes,
                archivedThroughMessageId: updatedGroup.archivedThroughMessageId,
            });
            setActiveGroup(updatedGroup);

            // When a box is sealed, give every current member a private-chat card. The message body can be parsed normally
            // by private-chat context/archiving; the metadata keeps a reference so these cards stay in sync when the public box is later edited/deleted.
            await Promise.all(groupForArchive.members.map(memberId => DB.saveMessage({
                charId: memberId,
                role: 'system',
                type: 'group_topic_card',
                content: `[Group Chat Public Topic Box: ${groupForArchive.name} | ${box.title}]\n${box.summary}`,
                metadata: { groupTopicBox: { ...box, groupName: groupForArchive.name } },
            })));
            // Topic box cards are written directly into members' private chat history, making them a direct source material for fire_pack transcription
            markGroupMembersDirty(groupForArchive.members);
            const remaining = groupTopicPendingCount(allMsgs, box.sourceEndMessageId);
            setTopicPendingCount(remaining);
            addToast(`"${box.title}" boxed and delivered to ${groupForArchive.members.length} members' private chats`, 'success');
            return true;
        } catch (err: any) {
            console.warn('[GroupChat] Failed to organize public topic box:', err);
            if (force) addToast(`Failed to organize topic box: ${err.message || err}`, 'error');
            return false;
        } finally {
            topicArchiveLockRef.current = false;
            setGroupPalaceStatus('');
            setSummaryProgress('');
            if (force) setIsSummarizing(false);
        }
    };

    const runGroupTopicArchive = () => {
        if ((activeGroup?.topicArchiveMode || 'auto') !== 'auto') return;
        void createNextGroupTopicBox(false);
    };

    const saveTopicBoxEdit = async (boxId: string) => {
        if (!activeGroup || !topicTitleDraft.trim() || !topicSummaryDraft.trim()) return;
        const now = Date.now();
        const nextBoxes = (activeGroup.topicBoxes || []).map(box => box.id === boxId
            ? { ...box, title: topicTitleDraft.trim(), summary: topicSummaryDraft.trim(), updatedAt: now }
            : box);
        const updated = { ...activeGroup, topicBoxes: nextBoxes };
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup(updated);
        const edited = nextBoxes.find(box => box.id === boxId)!;
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const cards = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId);
            await Promise.all(cards.map(async card => {
                await DB.updateMessage(card.id, `[Group Chat Public Topic Box: ${activeGroup.name} | ${edited.title}]\n${edited.summary}`);
                await DB.updateMessageMetadata(card.id, prev => ({ ...(prev || {}), groupTopicBox: { ...edited, groupName: activeGroup.name } }));
            }));
        }));
        setEditingTopicBoxId(null);
        addToast('Topic box updated, member private chat cards synced', 'success');
    };

    const deleteTopicBox = async (boxId: string) => {
        if (!activeGroup) return;
        const nextBoxes = (activeGroup.topicBoxes || []).filter(box => box.id !== boxId);
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup({ ...activeGroup, topicBoxes: nextBoxes });
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId).map(m => m.id);
            if (ids.length) await DB.deleteMessages(ids);
        }));
        addToast('Topic box and member private chat cards deleted', 'success');
    };

    const triggerDirector = async (currentMsgs: Message[]) => {
        if (!activeGroup) return;
        if (!apiConfig.apiKey) {
            addToast('Please fill in your API settings first', 'error');
            return;
        }
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        try {
            // 1. Prepare Group Context
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id));
            const { header, sharedScene } = buildGroupSystemHeader(currentMsgs, groupMembers);

            let context = header;

            // 2. Inject Member Context (Strict Isolation via ContextBuilder)
            for (const member of groupMembers) {
                context += await buildMemberBlock(member, currentMsgs, sharedScene);
            }

            // 3. Group history + director task instruction (template text copied verbatim into utils/groupChat/prompts.ts)
            const liveHistoryMsgs = currentMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
            const historyWindow = liveHistoryMsgs.slice(-contextLimit);
            const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
            const history = buildGroupHistoryBlock(
                preparedHistory,
                characters,
                emojis,
                userProfile.name,
                3,
                { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
            );
            const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
            // HTML module mode: appends a prompt when the group toggle is on. Director mode outputs a JSON array,
            // so this additionally emphasizes that [html] blocks must be written inside a character's own content string, with HTML attributes using single quotes, to avoid breaking the outer JSON
            const htmlPromptExt = activeGroup.htmlModeEnabled
                ? `\n\n【群聊 HTML 适配】[html]...[/html] 块要写在某个角色自己的 content 字符串内部；HTML 属性一律用单引号（如 <div style='...'>），避免双引号破坏外层 JSON。\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                : '';
            const prompt = `${context}\n\n${buildDirectorInstruction(history, emojiContextStr)}${htmlPromptExt}\n`;

            const data = await completeGroupChatWithMcp({
                url: `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: {
                    model: apiConfig.model,
                    messages: [{ role: "user", content: buildUserMessageContent(prompt, history) }],
                    temperature: 0.9, // High creativity for banter
                    max_tokens: 8000
                },
                groupId: activeGroup.id,
                userName: userProfile.name,
                signal: abort.signal,
                onStatus: setMcpStatus,
            });

            // Token stats: read usage from the director response (compatible with the standard field of OpenAI-compatible endpoints)
            if (data.usage?.total_tokens) {
                setLastTokenUsage(data.usage.total_tokens);
                setTokenBreakdown({
                    prompt: data.usage.prompt_tokens || 0,
                    completion: data.usage.completion_tokens || 0,
                    total: data.usage.total_tokens,
                    msgCount: currentMsgs.length,
                    pass: 'director',
                });
            }

            // Two-tier fault-tolerant parsing (strict JSON → per-object rescue); when both tiers come up empty but
            // the model genuinely output content, explicitly tell the user instead of having "typing…" just
            // vanish with nothing happening
            const rawContent = data.choices?.[0]?.message?.content ?? '';
            const actions = parseDirectorActions(rawContent);
            if (actions.length === 0 && String(rawContent).trim()) {
                console.error('Director Parse Error', rawContent);
                addToast('Could not parse the AI output, please retry', 'error');
            }

            // Execute Actions (PRIVATE side-channel/emoji/bubble segmentation/typing delay live in utils/groupChat/dispatch.ts)
            await dispatchMemberActions(actions, {
                groupId: activeGroup.id,
                memberIds: activeGroup.members,
                characters,
                emojis,
                categories,
                refresh: () => refreshMessages(activeGroup.id),
                addToast,
                signal: abort.signal,
                resolveQuote,
                userName: userProfile.name,
                htmlMode: !!activeGroup.htmlModeEnabled,
            });

        } catch (e: any) {
            if (e?.name === 'AbortError') {
                addToast('Generation stopped', 'info');
            } else {
                console.error(e);
                addToast(`Group chat generation failed: ${e.message || e}`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // Mark dirty even on a mid-run error / when the user clicks stop: the messages already saved to the DB are also part of the members' private-chat background
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
        }
    };

    // Round-robin mode: calls each member one by one in a fixed order, so a later speaker can see what earlier
    // members just said this round (naturally solves what cross-talk between characters would otherwise be
    // unsolvable), and characters can output [[SKIP]] to stay silent this round.
    // If one member fails, only that member is skipped — the whole round isn't killed.
    const triggerRoundRobin = async (currentMsgs: Message[]) => {
        if (!activeGroup) return;
        if (!apiConfig.apiKey) {
            addToast('Please fill in your API settings first', 'error');
            return;
        }
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        const failed: string[] = [];
        let tokenPrompt = 0;
        let tokenCompletion = 0;

        try {
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id));
            let roundMsgs = [...currentMsgs];

            for (const member of groupMembers) {
                if (abort.signal.aborted) break;
                try {
                    // Each member's context is built from the group history as of "right now" — including the new messages from members who spoke earlier this round
                    const { header, sharedScene } = buildGroupSystemHeader(roundMsgs, groupMembers);
                    const memberBlock = await buildMemberBlock(member, roundMsgs, sharedScene);
                    const liveRoundMsgs = roundMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
                    const historyWindow = liveRoundMsgs.slice(-contextLimit);
                    const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
                    const preparedById = new Map(preparedHistory.map(message => [message.id, message]));
                    // Subsequent members in round-robin mode reuse the descriptions just written back this round — no need to re-run image recognition for every single member.
                    roundMsgs = roundMsgs.map(message => preparedById.get(message.id) || message);
                    const history = buildGroupHistoryBlock(
                        preparedHistory,
                        characters,
                        emojis,
                        userProfile.name,
                        3,
                        { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
                    );
                    const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
                    const htmlPromptExt = activeGroup.htmlModeEnabled
                        ? `\n\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                        : '';
                    const prompt = `${header}${memberBlock}\n\n${buildRoundRobinInstruction(member.name, history, emojiContextStr)}${htmlPromptExt}\n`;

                    const data = await completeGroupChatWithMcp({
                        url: `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                        body: {
                            model: apiConfig.model,
                            messages: [{ role: "user", content: buildUserMessageContent(prompt, history) }],
                            temperature: 0.9,
                            max_tokens: 2000
                        },
                        groupId: activeGroup.id,
                        userName: userProfile.name,
                        signal: abort.signal,
                        onStatus: status => setMcpStatus(status ? `${member.name}: ${status}` : ''),
                    });

                    // Token stats: accumulated and shown for the whole round
                    if (data.usage?.total_tokens) {
                        tokenPrompt += data.usage.prompt_tokens || 0;
                        tokenCompletion += data.usage.completion_tokens || 0;
                        setLastTokenUsage(tokenPrompt + tokenCompletion);
                        setTokenBreakdown({
                            prompt: tokenPrompt,
                            completion: tokenCompletion,
                            total: tokenPrompt + tokenCompletion,
                            msgCount: roundMsgs.length,
                            pass: 'round-robin',
                        });
                    }

                    let text = String(data.choices?.[0]?.message?.content ?? '').trim();
                    // Strip a name prefix the model added on its own initiative (the prompt forbids it, but still guard against it)
                    if (text.startsWith(`${member.name}:`) || text.startsWith(`${member.name}：`)) {
                        text = text.slice(member.name.length + 1).trim();
                    }
                    const { skipped, content } = stripSkipMarker(text);
                    if (skipped) continue; // Stays silent this round

                    await dispatchMemberActions([{ charId: member.id, content }], {
                        groupId: activeGroup.id,
                        memberIds: activeGroup.members,
                        characters,
                        emojis,
                        categories,
                        refresh: () => refreshMessages(activeGroup.id),
                        addToast,
                        signal: abort.signal,
                        resolveQuote,
                        userName: userProfile.name,
                        htmlMode: !!activeGroup.htmlModeEnabled,
                    });

                    // Refresh the scroll history for the next member
                    roundMsgs = await DB.getGroupMessages(activeGroup.id);

                    // Randomized interval between members, for a more authentic feel
                    if (!abort.signal.aborted) {
                        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
                    }
                } catch (e: any) {
                    if (e?.name === 'AbortError') break;
                    console.error(`[GroupChat] Round-robin mode ${member.name} reply failed:`, e);
                    failed.push(member.name);
                }
            }

            if (abort.signal.aborted) {
                addToast('Generation stopped', 'info');
            } else if (failed.length > 0) {
                addToast(`${failed.join(', ')} failed to reply this round (skipped)`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // Same as director mode: even if interrupted mid-run, mark dirty — the members who already spoke are already saved to the DB
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
        }
    };

    // Trigger entry point: dispatches to director/round-robin based on group settings; clicking the trigger button again while generating = stop
    const triggerGroupAI = async (_msgs?: Message[]) => {
        unlockWhiteboxAudio();
        if (isTyping) {
            abortRef.current?.abort();
            return;
        }
        if (!activeGroup) return;
        // The UI always renders only 50 messages, but the model should still get the full recent hot zone; read it
        // independently before generating, to avoid coupling "the user didn't click load history → the AI can only see 50 messages" either.
        const promptCap = Math.max(contextLimit, activeGroup.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP, GROUP_TOPIC_HOT_ZONE);
        const { messages: freshMsgs } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, promptCap);
        if (activeGroup?.replyMode === 'roundRobin') {
            triggerRoundRobin(freshMsgs);
        } else {
            triggerDirector(freshMsgs);
        }
    };

    // --- Renderers ---

    if (view === 'list') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light">
                {/* safe-top spacer is transparent + backdrop-blur, so the container/list bubbles below show through with blur (matches the iOS system status bar), avoiding an abrupt white strip from the header's white bg under the notch */}
                <div className="shrink-0 z-10 sticky top-0">
                    <div className="bg-transparent backdrop-blur-xl" style={{ height: 'var(--safe-top)' }} />
                    <div className="bg-white/70 backdrop-blur-md flex items-end pb-3 px-4 border-b border-white/40 h-20">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-medium text-slate-700 text-lg tracking-wide pl-2">Group Chats</span>
                    <div className="flex-1"></div>
                    <button onClick={() => { setModalType('create'); setSelectedMembers(new Set()); setTempGroupName(''); setMemberGroupId(GROUP_FILTER_ALL); trackEvent('Open Create Group Chat Dialog'); }} className="p-2 -mr-2 text-violet-500 bg-violet-50 hover:bg-violet-100 rounded-full transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </button>
                    </div>
                </div>

                <div className="p-4 space-y-3 overflow-y-auto">
                    {groups.map(g => (
                        <div key={g.id} onClick={() => { setActiveGroup(g); setView('chat'); }} className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4 active:scale-[0.98] transition-all cursor-pointer group hover:bg-violet-50/30">
                            {/* Group Avatar Logic */}
                            <div className="w-14 h-14 rounded-2xl bg-slate-100 overflow-hidden border border-slate-200 relative shadow-sm">
                                {g.avatar ? (
                                    <TokenImg value={g.avatar} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="grid grid-cols-2 gap-0.5 p-0.5 w-full h-full bg-slate-200">
                                        {g.members.slice(0, 4).map(mid => {
                                            const c = characters.find(char => char.id === mid);
                                            return <TokenImg key={mid} value={c?.avatar} className="w-full h-full object-cover rounded-sm bg-white" />;
                                        })}
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-slate-700 truncate text-base">{g.name}</div>
                                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" /></svg>
                                    {g.members.length} members
                                </div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        </div>
                    ))}
                    {groups.length === 0 && (
                        <div className="text-center text-slate-400 text-xs py-10 flex flex-col items-center gap-2">
                            <UsersThree size={36} className="opacity-50" />
                            No group chats yet — tap the top-right button to create one
                        </div>
                    )}
                </div>

                <Modal isOpen={modalType === 'create'} title="Create Group Chat" onClose={() => setModalType('none')} footer={<button onClick={handleCreateGroup} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">Create</button>}>
                    <div className="space-y-4">
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} placeholder="Group chat name" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500/20 transition-all" />
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Select Members</label>
                            {/* Group filter (not rendered if no groups have been created): only affects which options are shown, not which members are already checked */}
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} value={memberGroupId} onChange={setMemberGroupId} className="mb-2" />
                            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                                {filterCharactersByGroup(characters, characterGroups, memberGroupId).map(c => (
                                    <div key={c.id} onClick={() => toggleMemberSelection(c.id)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${selectedMembers.has(c.id) ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                        <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                        <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </Modal>
            </div>
        );
    }

    // CHAT VIEW
    // Animal Crossing easter-egg mode (tied to the same toggle as private chat)
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const groupChatRootClass = chatChromeStyle === 'pixel'
        ? 'h-full w-full bg-[#efe1cf] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
        : chatChromeStyle === 'flat'
            ? 'h-full w-full bg-white flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'floating'
                ? 'h-full w-full bg-[#eef2ff] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
                : 'h-full w-full bg-[#f1f5f9] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500';
    const groupChatRootStyle: React.CSSProperties = chatBackgroundStyle === 'grid'
        ? {
            backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
            backgroundImage: 'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
        }
        : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
            }
            : chatBackgroundStyle === 'mesh'
                ? {
                    backgroundColor: '#f8fafc',
                    backgroundImage: 'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
                : { backgroundImage: 'none' };
    const groupFineTuneCss = buildChatFineTuneCss(osTheme);
    const finalGroupRootClass = acnh
        ? 'h-full w-full flex flex-col overflow-hidden font-sans relative transition-[background-color] duration-500'
        : groupChatRootClass;
    const finalGroupRootStyle = acnh
        ? { backgroundColor: '#F6F0D8', backgroundImage: 'none' }
        : groupChatRootStyle;
    return (
        <div className={`sully-chat-root ${finalGroupRootClass}`} style={finalGroupRootStyle}>
            {/* The Appearance App's global chat-detail CSS is shared with private chat, generated from the same source. */}
            {groupFineTuneCss && <style>{groupFineTuneCss}</style>}
            {/* Whitebox custom CSS: global default first, group-specific after (the latter overrides via cascade). Applies to each .sully-chat-* part. */}
            {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
            {activeGroup?.chromeCustomCss && <style>{activeGroup.chromeCustomCss}</style>}
            {/* Bubble Workshop CSS comes after Whitebox, same priority as private chat; each member's theme is scoped to only their own messages. */}
            {groupBubbleCustomCss && <style>{groupBubbleCustomCss}</style>}
            <style>{`
                .sully-bubble-tail-hidden::before,
                .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
            `}</style>
            {/* Guard styles (injected after user CSS): ensures the back button and input area are always visible and clickable. */}
            {(osTheme.chatChromeCustomCss || activeGroup?.chromeCustomCss || groupBubbleCustomCss) && (
                <style>{`
                    .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
                `}</style>
            )}
            {/* Public topic box organizing status — doesn't block interaction */}
            {groupPalaceStatus && (
                <div
                    className="absolute top-[100px] left-1/2 z-[150] animate-fade-in"
                    style={{
                        transform: 'translateX(-50%)',
                        pointerEvents: 'none',
                        willChange: 'transform, opacity',
                    }}
                >
                    <div
                        className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[20rem]"
                        style={{
                            background: 'rgba(255,255,255,0.88)',
                            borderRadius: 999,
                            border: '1px solid rgba(139,92,246,0.22)',
                            boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                        }}
                    >
                        <span
                            className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                            style={{ borderTopColor: '#8b5cf6', animationDuration: '0.9s' }}
                        />
                        <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                            Boxing up public topics
                        </span>
                        <span className="text-[10px] text-slate-400 truncate">{groupPalaceStatus}</span>
                    </div>
                </div>
            )}

            {/* Header — reuses private chat's ChatHeaderShell (7 header styles follow the OS appearance settings) */}
            <ChatHeaderShell
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); }}
                activeCharacter={{
                    id: activeGroup?.id || 'group',
                    name: activeGroup?.name || 'Group Chat',
                    avatar: activeGroup?.avatar || characters.find(c => c.id === activeGroup?.members[0])?.avatar || '',
                    activeBuffs: [],
                }}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isMemoryPalaceProcessing={!!groupPalaceStatus}
                memoryPalaceStatusText={groupPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                statusText={`${activeGroup?.members.length ?? 0} members`}
                extraAction={{
                    label: 'Group Chat Memory Rules',
                    icon: <Question className="w-5 h-5" weight="bold" />,
                    onClick: () => setModalType('help'),
                }}
                triggerIcon={isTyping ? 'stop' : 'lightning'}
                onClose={() => setView('list')}
                onTriggerAI={() => triggerGroupAI(messages)}
                onShowCharsPanel={openGroupSettings}
                hideBuffs
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
            />

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" ref={scrollRef}>
                {collapsedCount > 0 && activeGroup && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + MESSAGE_PAGE_SIZE;
                            setVisibleCount(nextVisibleCount);
                            const { messages: moreMsgs, totalCount } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, nextVisibleCount);
                            setMessages(moreMsgs);
                            setTotalMsgCount(totalCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">
                            Load History ({collapsedCount})
                        </button>
                    </div>
                )}
                {displayMessages.map((m, i) => {
                    const isUser = m.role === 'user';
                    const char = characters.find(c => c.id === m.charId);
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const sameSpeaker = (other: Message | null) => !!other
                        && other.role === m.role
                        && other.charId === m.charId;
                    const isFirstInGroup = !sameSpeaker(prevMessage)
                        || Math.abs(m.timestamp - prevMessage!.timestamp) > messageGroupGapMs;
                    const isLastInGroup = !sameSpeaker(nextMessage)
                        || Math.abs(nextMessage!.timestamp - m.timestamp) > messageGroupGapMs;
                    const memberTheme = memberBubbleThemes.get(m.charId);

                    return (
                        <GroupMessageItem
                            key={m.id || i}
                            msg={m}
                            isUser={isUser}
                            char={char}
                            userAvatar={userProfile.avatar}
                            onImageClick={handleGroupImageClick}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            onLongPress={handleMessageLongPress}
                            onReply={handleGroupReply}
                            nameOf={nameOf}
                            onPacketClick={openPacketDetail}
                            styleConfig={isUser ? userBubbleTheme.user : (memberTheme?.ai || PRESET_THEME_GROUP.ai)}
                            themeScopeClass={isUser ? 'sully-group-user-theme' : (memberThemeScopeClasses.get(m.charId) || 'sully-group-default-theme')}
                            isFirstInGroup={isFirstInGroup}
                            isLastInGroup={isLastInGroup}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                        />
                    );
                })}
                {isTyping && (
                    <div className="flex items-center gap-2 pl-4 py-2 animate-pulse opacity-70">
                        <div className="flex -space-x-1">
                            <div className="w-6 h-6 rounded-full bg-slate-300 border-2 border-white"></div>
                            <div className="w-6 h-6 rounded-full bg-slate-200 border-2 border-white"></div>
                        </div>
                        <span className="text-xs text-slate-400 font-medium">{mcpStatus || 'Member is typing...'}</span>
                    </div>
                )}
            </div>

            {/* Redesigned Input Area (WeChat/iOS Style) */}
            {/* Reply preview bar (matches private chat Chat.tsx's style and position) */}
            {replyTarget && !selectionMode && (
                <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 shrink-0 z-40">
                    {/* When quoting an image/sticker, a placeholder is shown here, matching the saved snapshot's convention */}
                    <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">Replying to:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                    <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                </div>
            )}

            {/* Input area — reuses private chat's ChatInputArea (input/emoji panel/multi-select delete follow the OS appearance settings),
                the actions panel is entirely replaced with group chat's own 4-tile grid */}
            <ChatInputArea
                input={input}
                setInput={setInput}
                isTyping={isTyping}
                selectionMode={selectionMode}
                showPanel={showPanel}
                setShowPanel={setShowPanel}
                onSend={() => handleSendMessage(input)}
                onDeleteSelected={deleteSelectedMessages}
                selectedCount={selectedMsgIds.size}
                emojis={filteredEmojis}
                categories={categories}
                activeCategory={activeEmojiCategory}
                onPanelAction={handlePanelAction}
                onImageSelect={handleImageFile}
                isSummarizing={isSummarizing}
                onReroll={handleReroll}
                canReroll={canReroll}
                inputStyle={osTheme.chatInputStyle}
                sendButtonStyle={osTheme.chatSendButtonStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
                actionsContent={
                    <div className="p-6 grid grid-cols-4 gap-8">
                        <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-pink-50 text-pink-400 border-pink-100">
                                <ImageIcon className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Album</span>
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />

                        <button onClick={() => { setModalType('transfer'); setShowPanel('none'); trackEvent('Open Send Red Packet Panel'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-orange-50 text-orange-400 border-orange-100">
                                <Money className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Red Packet</span>
                        </button>

                        <button onClick={openGroupSettings} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-violet-50 text-violet-500 border-violet-100">
                                <GearSix className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Group Settings</span>
                        </button>

                        <button
                            onClick={() => { if (canReroll) { setShowPanel('none'); handleReroll(); } }}
                            disabled={!canReroll}
                            className={`flex flex-col items-center gap-2 active:scale-95 transition-transform ${canReroll ? 'text-slate-600' : 'text-slate-300 opacity-50'}`}
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border ${canReroll ? 'bg-emerald-50 text-emerald-400 border-emerald-100' : 'bg-slate-50 text-slate-300 border-slate-100'}`}>
                                <ArrowsClockwise className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Regenerate</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-css'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-sky-50 text-sky-500 border-sky-100">
                                <PaintBrush className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Whitebox</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-sound'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-amber-50 text-amber-500 border-amber-100">
                                <BellSimpleRinging className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">Notification Sound</span>
                        </button>

                        {/* HTML mode: tap to toggle; right-click/long-press to open custom prompt (interaction matches private chat) */}
                        <button
                            onClick={() => {
                                if (!activeGroup) return;
                                const next = !activeGroup.htmlModeEnabled;
                                updateGroup(activeGroup.id, { htmlModeEnabled: next });
                                setActiveGroup({ ...activeGroup, htmlModeEnabled: next });
                                addToast(next ? 'HTML mode enabled' : 'HTML mode disabled', 'info');
                                trackEvent('Toggle Group Chat HTML Mode', { state: next ? 'on' : 'off' });
                            }}
                            onContextMenu={(e) => { e.preventDefault(); setTempHtmlPrompt(activeGroup?.htmlModeCustomPrompt || ''); setModalType('html-prompt'); setShowPanel('none'); }}
                            className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600 relative"
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border relative ${activeGroup?.htmlModeEnabled ? 'bg-fuchsia-100 text-fuchsia-600 border-fuchsia-200' : 'bg-fuchsia-50 text-fuchsia-500 border-fuchsia-100'}`}>
                                <Code className="w-6 h-6" weight="bold" />
                                {activeGroup?.htmlModeEnabled && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-fuchsia-500 border-2 border-white" />}
                            </div>
                            <span className="text-xs font-bold">{activeGroup?.htmlModeEnabled ? 'HTML On' : 'HTML Mode'}</span>
                        </button>
                    </div>

                }
            />

            {/* --- Modals --- */}

            {/* Group Settings Modal */}
            <Modal isOpen={modalType === 'settings'} title="Group Settings" onClose={() => setModalType('none')} footer={<button onClick={handleUpdateGroupInfo} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">Save Changes</button>}>
                <div className="space-y-6">
                    {/* Header Info */}
                    <div className="flex justify-center">
                        <div onClick={() => groupAvatarInputRef.current?.click()} className="w-24 h-24 rounded-3xl bg-slate-100 border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer overflow-hidden relative group hover:border-violet-400">
                            {activeGroup?.avatar ? <TokenImg value={activeGroup.avatar} className="w-full h-full object-cover opacity-90 group-hover:opacity-100" /> : <span className="text-xs text-slate-400 font-bold">Change avatar</span>}
                            <div className="absolute inset-0 bg-black/20 hidden group-hover:flex items-center justify-center text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" /></svg></div>
                        </div>
                        <input type="file" ref={groupAvatarInputRef} className="hidden" accept="image/*" onChange={handleGroupAvatarUpload} />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Group Name</label>
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:bg-white focus:border-violet-300 transition-all" />
                    </div>

                    {/* Reply Mode */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Reply Generation Mode</label>
                        <div className="flex flex-col gap-2">
                            <div
                                onClick={() => { setTempReplyMode('director'); trackEvent('Switch Group Chat Reply Generation Mode', { mode: 'director' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'director' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">Director Mode (Default)</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">One API call generates the entire round of group chat. Fast and token-efficient, but characters may occasionally cross-talk.</p>
                            </div>
                            <div
                                onClick={() => { setTempReplyMode('roundRobin'); trackEvent('Switch Group Chat Reply Generation Mode', { mode: 'roundRobin' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'roundRobin' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">Round-Robin Mode</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">Calls the API once per member, each speaking in turn (everyone speaks). More authentic and fully avoids cross-talk, but slower — token usage is roughly Director Mode times the member count.</p>
                            </div>
                        </div>
                    </div>

                    {/* Bubble Appearance */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Bubble Appearance</label>
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-slate-700">Independent Member Bubbles</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-tight">When enabled, each member fully follows their own private-chat bubble theme (AI side, including custom CSS and decorations); when disabled, everyone shares one unified theme.</p>
                            </div>
                            <div
                                onClick={() => setTempMemberBubbleIndependent(v => !v)}
                                className={`w-11 h-6 rounded-full cursor-pointer transition-colors relative shrink-0 ${tempMemberBubbleIndependent ? 'bg-violet-500' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${tempMemberBubbleIndependent ? 'left-[22px]' : 'left-0.5'}`} />
                            </div>
                        </div>
                        <div className="text-xs font-bold text-slate-700 mb-2">My Bubble</div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                            {[{ id: '', name: 'Default · Violet', color: PRESET_THEME_GROUP.user.backgroundColor },
                              ...Object.values(PRESET_THEMES).map(t => ({ id: t.id, name: t.name, color: t.user.backgroundColor })),
                              ...customThemes.map(t => ({ id: t.id, name: `${t.name} (DIY)`, color: t.user.backgroundColor }))].map(opt => (
                                <button
                                    key={opt.id || '_default'}
                                    onClick={() => setTempUserBubbleThemeId(opt.id)}
                                    className={`shrink-0 px-3 py-2 rounded-xl border text-[10px] font-bold flex items-center gap-1.5 transition-all ${tempUserBubbleThemeId === opt.id ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500 text-violet-700' : 'border-slate-200 bg-white text-slate-500'}`}
                                >
                                    <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ backgroundColor: opt.color }} />
                                    {opt.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Context Limit */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">AI Context Message Count ({contextLimit})</label>
                        <input type="range" min="20" max="5000" step="10" value={contextLimit} onChange={e => { const v = parseInt(e.target.value); setContextLimit(v); localStorage.setItem('groupchat_context_limit', String(v)); }} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (light)</span><span>5000 (extra-long memory)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">How many messages of group history each character references when speaking. More is more coherent, but slower and costs more tokens.</p>
                    </div>

                    {/* Private Chat Group Context Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">"Recent Group Activity" Count in Private Chat ({tempPrivateContextCap})</label>
                        <input type="range" min="20" max="500" step="10" value={tempPrivateContextCap} onChange={e => setTempPrivateContextCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (light)</span><span>500 (full)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">In their own private chat, how many of this group's most recent messages a member can see at most as "recent group activity" context.</p>
                    </div>

                    {/* Member Timeline Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Member Interaction Timeline Count ({tempMemberTimelineCap})</label>
                        <input type="range" min="20" max="200" step="10" value={tempMemberTimelineCap} onChange={e => setTempMemberTimelineCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (light)</span><span>200 (full)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">When speaking in the group, the number of entries each member references from the "merged private + group timeline." This timeline lets a character's feelings connect between the group and private chat.</p>
                    </div>

                    {/* Public topic box: summarized once, shared by the whole group, and delivered to every member's private chat when a box is sealed. */}
                    <div className="pt-2 border-t border-slate-100 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Group Chat Summary · Public Topic Box</label>
                            <span className="text-[10px] text-violet-500 font-bold">{activeGroup?.topicBoxes?.length || 0} boxes</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">
                            {([
                                { id: 'auto' as const, title: 'Auto-organize', desc: 'Boxes automatically every 100 messages' },
                                { id: 'manual' as const, title: 'Manual organize', desc: 'Only boxes when you click' },
                            ]).map(option => {
                                const active = (activeGroup?.topicArchiveMode || 'auto') === option.id;
                                return (
                                    <button key={option.id} onClick={async () => {
                                        if (!activeGroup) return;
                                        await updateGroup(activeGroup.id, { topicArchiveMode: option.id });
                                        setActiveGroup({ ...activeGroup, topicArchiveMode: option.id });
                                        trackEvent('Switch Group Chat Summary Organizing Mode', { mode: option.id });
                                    }} className={`rounded-xl px-3 py-2.5 text-left transition-all ${active ? 'bg-white shadow-sm ring-1 ring-violet-100' : 'text-slate-400'}`}>
                                        <div className={`text-[11px] font-bold ${active ? 'text-violet-600' : 'text-slate-500'}`}>{option.title}</div>
                                        <div className="text-[9px] mt-0.5">{option.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-3.5 space-y-2">
                            <p className="text-[11px] font-bold text-violet-700">One summary, remembered by the whole group</p>
                            <p className="text-[10px] leading-5 text-violet-600/80">
                                The most recent {GROUP_TOPIC_HOT_ZONE} messages are always kept as-is; once older records accumulate past {GROUP_TOPIC_BUFFER_THRESHOLD}, they get {(activeGroup?.topicArchiveMode || 'auto') === 'auto' ? 'automatically organized' : 'organized whenever you do it manually'} into a public topic box.
                                Boxes belong only to this group, and are also delivered as cards to every member's private chat, where they can be understood normally by each member's private-chat context and archiving.
                            </p>
                            <div className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 text-[10px]">
                                <span className="text-slate-500">Pending before hot zone</span>
                                <span className={`font-bold ${topicPendingCount >= GROUP_TOPIC_BUFFER_THRESHOLD ? 'text-amber-500' : 'text-slate-500'}`}>{topicPendingCount} / {GROUP_TOPIC_BUFFER_THRESHOLD} messages</span>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-100 rounded-2xl p-3 flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-violet-50 flex items-center justify-center">✦</div>
                            <div>
                                <div className="text-[10px] font-bold text-slate-600">Built-in · Group Chat Shared Memory Summary</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-4">The summarization pass reads every member's profile, core traits, worldview, writing persona, and core memories — it no longer reuses the private-chat archiving style.</p>
                            </div>
                        </div>

                        <button onClick={() => { void createNextGroupTopicBox(true); trackEvent('Manually Organize Group Topic Box'); }} disabled={isSummarizing || topicPendingCount === 0} className={`w-full py-3 rounded-2xl border font-bold text-xs flex items-center justify-center gap-2 ${topicPendingCount === 0 ? 'bg-slate-50 border-slate-100 text-slate-300' : 'bg-violet-500 border-violet-500 text-white shadow-lg shadow-violet-200'}`}>
                            {isSummarizing ? <><span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />{summaryProgress || 'Boxing up…'}</> : 'Organize what can be archived right now'}
                        </button>

                        <div className="space-y-2">
                            {(activeGroup?.topicBoxes || []).slice().reverse().map(box => {
                                const editing = editingTopicBoxId === box.id;
                                return (
                                    <div key={box.id} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
                                        {editing ? (
                                            <div className="space-y-2">
                                                <input value={topicTitleDraft} onChange={e => setTopicTitleDraft(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold" placeholder="Topic box title" />
                                                <textarea value={topicSummaryDraft} onChange={e => setTopicSummaryDraft(e.target.value)} className="w-full min-h-28 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs leading-5 resize-y" placeholder="Shared memory summary" />
                                                <div className="flex gap-2">
                                                    <button onClick={() => setEditingTopicBoxId(null)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-500 text-[11px] font-bold">Cancel</button>
                                                    <button onClick={() => void saveTopicBoxEdit(box.id)} className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-[11px] font-bold">Save & Sync Cards</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="flex items-start gap-2">
                                                    <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">💬</div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs font-bold text-slate-700">{box.title}</div>
                                                        <div className="text-[9px] text-slate-400 mt-0.5">Archived {box.messageCount} messages · {new Date(box.createdAt).toLocaleDateString('en-US')}</div>
                                                    </div>
                                                </div>
                                                <p className="mt-2.5 text-[11px] leading-5 text-slate-600 whitespace-pre-wrap">{box.summary}</p>
                                                <div className="mt-3 flex gap-2 justify-end">
                                                    <button onClick={() => { setEditingTopicBoxId(box.id); setTopicTitleDraft(box.title); setTopicSummaryDraft(box.summary); }} className="px-3 py-1.5 rounded-lg bg-violet-50 text-violet-600 text-[10px] font-bold">Edit</button>
                                                    <button onClick={() => void deleteTopicBox(box.id)} className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-500 text-[10px] font-bold">Delete</button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                            {(activeGroup?.topicBoxes?.length || 0) === 0 && (
                                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-5 text-center text-[10px] text-slate-400">The chat is still within the recent hot zone. Once there's enough content, the first public topic box will appear automatically.</div>
                            )}
                        </div>
                    </div>

                    {/* Danger Zone */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-3 block">Danger Zone</label>

                        <div className="flex items-center gap-2 mb-3 cursor-pointer" onClick={() => setPreserveContext(!preserveContext)}>
                             <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${preserveContext ? 'bg-violet-500 border-violet-500' : 'bg-slate-100 border-slate-300'}`}>
                                 {preserveContext && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                             </div>
                             <span className="text-xs text-slate-600">Keep the last 10 messages when clearing (preserves context)</span>
                        </div>

                        <div className="flex gap-2">
                            <button onClick={handleClearHistory} className="flex-1 py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 active:scale-95 transition-transform flex items-center justify-center gap-2 text-xs">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                Clear Chat
                            </button>
                            <button onClick={() => { if(activeGroup) handleDeleteGroup(activeGroup.id); }} className="flex-1 py-3 text-white bg-red-500 hover:bg-red-600 rounded-2xl text-xs font-bold transition-colors shadow-lg shadow-red-200">Disband Group</button>
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Message Options Modal */}
            <Modal isOpen={modalType === 'message-options'} title="Message Options" onClose={() => { setModalType('none'); setSelectedMessage(null); }}>
                <div className="space-y-3">
                    <button
                        onClick={() => {
                            if (selectedMessage) setReplyTarget(selectedMessage);
                            setModalType('none');
                            setSelectedMessage(null);
                        }}
                        className="w-full py-3 bg-violet-50 text-violet-600 font-medium rounded-2xl active:bg-violet-100 transition-colors flex items-center justify-center gap-2"
                    >
                        Quote / Reply
                    </button>
                    <button onClick={handleEnterSelectionMode} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        Multi-select / Batch Delete
                    </button>
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleCopyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            Copy Text
                        </button>
                    )}
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleStartEditMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            Edit Content
                        </button>
                    )}
                    <button onClick={handleDeleteSingleMessage} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                        Delete Message
                    </button>
                </div>
            </Modal>

            {/* Edit Message Modal */}
            <Modal
                isOpen={modalType === 'edit-message'} title="Edit Content" onClose={() => { setModalType('none'); setSelectedMessage(null); }}
                footer={<><button onClick={() => { setModalType('none'); setSelectedMessage(null); }} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">Save</button></>}
            >
                <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed"
                />
            </Modal>

            {/* Transfer Modal — Red Packet 2.0: lucky / exclusive */}
            <Modal isOpen={modalType === 'transfer'} title="Send Red Packet" onClose={() => setModalType('none')} footer={<button onClick={handleSendPacket} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200">Stuff the Red Packet</button>}>
                <div className="space-y-4">
                    {/* Tab switch */}
                    <div className="flex gap-2">
                        {([['lucky', 'Lucky'], ['direct', 'Exclusive']] as const).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setPacketTab(key)}
                                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${packetTab === key ? 'bg-orange-500 text-white shadow-md' : 'bg-slate-100 text-slate-500'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="text-center py-2 animate-bounce"><img src={twemojiUrl('1f9e7')} alt="red envelope" className="w-12 h-12 mx-auto" /></div>

                    <input type="number" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder={packetTab === 'lucky' ? 'Total amount' : 'Amount'} className="w-full px-4 py-4 bg-slate-100 rounded-2xl text-center text-2xl font-bold outline-none text-slate-800 placeholder:text-slate-300" autoFocus />

                    {packetTab === 'lucky' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Number of shares (everyone grabs, random amounts)</label>
                            <input type="number" value={packetShares} onChange={e => setPacketShares(e.target.value)} min={1} className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-center text-lg font-bold outline-none text-slate-800" />
                        </div>
                    ) : (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Send to whom (only they can receive it)</label>
                            <div className="grid grid-cols-4 gap-2 max-h-36 overflow-y-auto pr-1">
                                {(activeGroup?.members || []).map(mid => {
                                    const c = characters.find(ch => ch.id === mid);
                                    if (!c) return null;
                                    return (
                                        <div key={mid} onClick={() => setPacketTargetId(mid)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${packetTargetId === mid ? 'border-orange-500 bg-orange-50 ring-1 ring-orange-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                            <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                            <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <input value={packetNote} onChange={e => setPacketNote(e.target.value)} placeholder="Wishing you fortune (optional greeting)" className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-sm outline-none text-slate-700 placeholder:text-slate-300" />
                </div>
            </Modal>

            {/* Packet Detail Modal — claim breakdown + user grab/receive/return */}
            <Modal isOpen={modalType === 'packet-detail'} title="Red Packet Details" onClose={() => { setModalType('none'); setSelectedPacketId(null); }}>
                {(() => {
                    const pMsg = messages.find(m => m.id === selectedPacketId);
                    const meta = pMsg?.metadata as GroupPacketMeta | undefined;
                    if (!pMsg || !meta?.packet) return <div className="text-center text-xs text-slate-400 py-6">This red packet's data is gone</div>;
                    const status = effectivePacketStatus(meta, Date.now());
                    const senderName = pMsg.role === 'user' ? userProfile.name : nameOf(pMsg.charId);
                    const userClaimed = meta.claims.some(c => c.claimantId === 'user');
                    const canGrabLucky = meta.packetType === 'lucky' && status === 'pending' && !userClaimed;
                    const canResolveDirect = meta.packetType === 'direct' && status === 'pending' && meta.targetId === 'user';
                    return (
                        <div className="space-y-4">
                            <div className="text-center">
                                <div className="text-4xl mb-1">🧧</div>
                                <div className="font-bold text-slate-800">{senderName}'s {meta.packetType === 'lucky' ? 'lucky' : 'exclusive'} red packet</div>
                                <div className="text-xs text-slate-400 mt-1">"{meta.note}"</div>
                                <div className="text-2xl font-black text-orange-500 mt-2">¥{meta.totalAmount}</div>
                                {meta.packetType === 'lucky' && (
                                    <div className="text-[10px] text-slate-400 mt-1">{meta.shares} shares total · {meta.claims.length} claimed{status === 'expired' ? ' · Expired' : ''}</div>
                                )}
                                {meta.packetType === 'direct' && (
                                    <div className="text-[10px] text-slate-400 mt-1">Sent to {nameOf(meta.targetId || '')} · {status === 'pending' ? 'Awaiting claim' : status === 'done' ? 'Received' : status === 'returned' ? 'Returned' : 'Expired'}</div>
                                )}
                            </div>

                            {meta.claims.length > 0 && (
                                <div className="space-y-2 max-h-44 overflow-y-auto">
                                    {meta.claims.map((c, i) => {
                                        const avatar = c.claimantId === 'user' ? userProfile.avatar : characters.find(ch => ch.id === c.claimantId)?.avatar;
                                        return (
                                            <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-xl px-3 py-2">
                                                <TokenImg value={avatar} className="w-8 h-8 rounded-full object-cover" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-slate-700 truncate">{nameOf(c.claimantId)}</div>
                                                    <div className="text-[9px] text-slate-400">{new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                                </div>
                                                <div className="text-sm font-black text-orange-500">¥{c.amount}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {canGrabLucky && (
                                <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="w-full py-3 bg-gradient-to-r from-orange-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">
                                    Grab Red Packet
                                </button>
                            )}
                            {canResolveDirect && (
                                <div className="flex gap-2">
                                    <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="flex-1 py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">Accept</button>
                                    <button onClick={() => handleUserPacketAction(pMsg, 'return')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform">Return</button>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </Modal>

            {/* Group "Whitebox Customization" bottom sheet — writes to group.chromeCustomCss, layered on top of the global default (matches private chat's approach) */}
            {activeGroup && modalType === 'chrome-css' && (
                <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                    <div
                        className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-2 flex items-start justify-between">
                            <div>
                                <div className="text-sm font-bold text-slate-800">Whitebox Customization · {activeGroup.name}</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">↑ The group chat above is a live preview; only applies to this group, layered on top of the global setting.</div>
                            </div>
                            <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                        </div>
                        <ChromeCssEditor
                            value={activeGroup.chromeCustomCss || ''}
                            onChange={(css) => { updateGroup(activeGroup.id, { chromeCustomCss: css }); setActiveGroup({ ...activeGroup, chromeCustomCss: css }); }}
                        />
                    </div>
                    {/* A rescue button that escapes CSS control: portal'd to body + id guard, still clickable even with broken CSS (reuses private chat's approach verbatim) */}
                    {createPortal(
                        <>
                            <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
                            <button
                                id="sully-safe-reset"
                                onClick={() => { updateGroup(activeGroup.id, { chromeCustomCss: '' }); setActiveGroup({ ...activeGroup, chromeCustomCss: '' }); addToast("This group's Whitebox has been reset", 'success'); }}
                                style={{
                                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', left: '50%', transform: 'translateX(-50%)',
                                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '5px 12px', borderRadius: '999px',
                                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                                }}
                            >⟲ Reset This Group's Whitebox</button>
                        </>,
                        document.body,
                    )}
                </div>
            )}

            {/* Group "Notification Sound" bottom sheet — stored independently in group.chatSound by default; once bound, writes into chromeCustomCss's @sully-sound directive */}
            {activeGroup && modalType === 'chrome-sound' && (() => {
                const boundSound = parseWhiteboxSound(activeGroup.chromeCustomCss);
                const isBound = !!activeGroup.chatSoundBound || !!boundSound;
                const curSound: WhiteboxSound | null = isBound ? boundSound : (activeGroup.chatSound || null);
                const applyGroup = (patch: Partial<GroupProfile>) => { updateGroup(activeGroup.id, patch); setActiveGroup({ ...activeGroup, ...patch }); };
                const changeSound = (s: WhiteboxSound | null) => {
                    if (isBound) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', s), chatSound: undefined });
                    } else {
                        applyGroup({ chatSound: s || undefined });
                    }
                };
                const changeBound = (b: boolean) => {
                    if (b) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true });
                    } else {
                        applyGroup({ chromeCustomCss: stripWhiteboxSoundDirective(activeGroup.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false });
                    }
                };
                return (
                    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                        <div
                            className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                            style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-3 flex items-start justify-between">
                                <div>
                                    <div className="text-sm font-bold text-slate-800">Notification Sound · {activeGroup.name}</div>
                                    <div className="mt-0.5 text-[10px] text-slate-400">Plays once when a member's new message becomes the latest one. Independent from Whitebox by default, but can optionally be bound to share settings together.</div>
                                </div>
                                <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                            </div>
                            <WhiteboxSoundEditor
                                sound={curSound}
                                bound={isBound}
                                onChangeSound={changeSound}
                                onChangeBound={changeBound}
                                hint={<>🔔 Only plays once when <b>a member's new message becomes the latest one</b>. This is <b>specific to this group</b>; if unset, it falls back to the global default notification sound in "Appearance → Chat Interface."</>}
                            />
                        </div>
                    </div>
                );
            })()}

            {/* Group Chat Memory Rules */}
            <Modal isOpen={modalType === 'help'} title="Group Chat Memory Rules" onClose={() => setModalType('none')}>
                <div className="space-y-4 text-sm text-slate-600 leading-relaxed">
                    <div className="rounded-2xl bg-violet-50 border border-violet-100 p-4 text-violet-800">
                        Group chat content is not sent with a delayed queue. When a character "brings something up a day later" in private chat, it is usually because recent group chat, a topic box, or a personal group-chat memory got selected as this round's topic.
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">Recent Group Chat</div>
                        <p>When a character generates a private-chat reply, they see the most recent stretch of messages from the group chats they participate in. Records carry both a specific date and an "about N days ago" tag, to avoid mistaking an old message for something that just happened.</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">Public Topic Box</div>
                        <p>Once a group chat accumulates enough messages, older content gets compressed into a topic box shared by group members, which then enters each member's private-chat background. This is why an old topic may get brought up again later.</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">Personal Group Chat Memory</div>
                        <p>With the group chat memory palace enabled, older group chats get organized in third person into the memory palace of each participating character. It doesn't require the character to respond right away — it's just material for future recall.</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-500">
                        The model seeing a record doesn't mean it has to respond right away; whether it brings something up on its own is still shaped by the current topic and the character's personality.
                    </div>
                </div>
            </Modal>

            {/* HTML Mode Custom Prompt Modal (accessed via right-click/long-press on the tile) */}
            <Modal
                isOpen={modalType === 'html-prompt'} title="HTML Mode · Custom Prompt" onClose={() => setModalType('none')}
                footer={<button onClick={() => { if (activeGroup) { updateGroup(activeGroup.id, { htmlModeCustomPrompt: tempHtmlPrompt }); setActiveGroup({ ...activeGroup, htmlModeCustomPrompt: tempHtmlPrompt }); } setModalType('none'); addToast('Saved', 'success'); }} className="w-full py-3 bg-fuchsia-500 text-white font-bold rounded-2xl shadow-lg shadow-fuchsia-200">Save</button>}
            >
                <div className="space-y-3">
                    <p className="text-[10px] text-slate-400 leading-relaxed">Appended after the built-in HTML prompt (does not overwrite it). You can write card style preferences, common color schemes, desired card types, etc.</p>
                    <textarea
                        value={tempHtmlPrompt}
                        onChange={e => setTempHtmlPrompt(e.target.value)}
                        placeholder="For example: use warm tones for all cards, 16px rounded corners; make heavy use of progress bars and tag groups..."
                        className="w-full h-36 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-fuchsia-300 transition-all text-sm leading-relaxed"
                    />
                </div>
            </Modal>

        </div>
    );
};

export default GroupChat;
