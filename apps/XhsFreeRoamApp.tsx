
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { XhsActivityRecord, XhsOwnedPost } from '../types';
import { XhsFreeRoamEngine, FreeRoamCallbacks } from '../utils/xhsFreeRoam';
import { XhsMcpClient, extractNotesFromMcpData, normalizeNote } from '../utils/xhsMcpClient';
import { collectOwnedPostsFromActivities } from '../utils/xhsFreeRoamOwnership';
import ConfirmDialog from '../components/os/ConfirmDialog';
import { trackEvent } from '../utils/analytics';
import { Book, PencilSimple, MagnifyingGlass, DeviceMobileCamera, ChatCircleDots, PushPin, Moon, House } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import TokenImg from '../components/os/TokenImg';

const TwemojiImg: React.FC<{ code: string; alt?: string; className?: string }> = ({ code, alt, className = 'w-4 h-4 inline-block' }) => (
  <img src={`https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${code}.png`} alt={alt || ''} className={className} draggable={false} />
);

const ACTION_LABELS: Record<string, string> = {
    post: 'Post',
    browse: 'Browse Feed',
    search: 'Search',
    comment: 'Comment',
    save_topic: 'Save Topic',
    idle: 'Idle',
};

const ACTION_ICON_CODES: Record<string, string> = {
    post: '270d',
    browse: '1f4f1',
    search: '1f50d',
    comment: '1f4ac',
    save_topic: '1f4cc',
    idle: '1f634',
};

const ActionIcon: React.FC<{ type: string; className?: string }> = ({ type, className = 'w-5 h-5 inline-block' }) => {
    const code = ACTION_ICON_CODES[type] || '1f4dd';
    return <TwemojiImg code={code} className={className} />;
};

const RESULT_COLORS: Record<string, string> = {
    success: 'text-emerald-600 bg-emerald-50',
    failed: 'text-red-500 bg-red-50',
    skipped: 'text-slate-400 bg-slate-50',
};

const XhsFreeRoamApp: React.FC = () => {
    const { closeApp, addToast, characters, activeCharacterId, apiConfig, realtimeConfig, userProfile, characterGroups } = useOS();

    // Character selector — default to activeCharacterId, but user can switch
    const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacterId || characters[0]?.id || '');
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [pickerGroupId, setPickerGroupId] = useState<string>(GROUP_FILTER_ALL); // 角色下拉选择器的分组筛选（须在组件顶层，勿移入 renderCharPicker）

    const char = characters.find(c => c.id === selectedCharId) || null;

    // State
    const [activities, setActivities] = useState<XhsActivityRecord[]>([]);
    const [ownedPosts, setOwnedPosts] = useState<XhsOwnedPost[]>([]);
    const [viewMode, setViewMode] = useState<'profile' | 'activity'>('profile');
    const [isRunning, setIsRunning] = useState(false);
    const [status, setStatus] = useState('');
    const [thinking, setThinking] = useState('');
    const [liveActivities, setLiveActivities] = useState<XhsActivityRecord[]>([]);
    const [mcpStatus, setMcpStatus] = useState<'unknown' | 'connected' | 'error'>('unknown');
    const [showDetail, setShowDetail] = useState<XhsActivityRecord | null>(null);
    const [showOwnedPost, setShowOwnedPost] = useState<XhsOwnedPost | null>(null);
    const [claimCandidates, setClaimCandidates] = useState<ReturnType<typeof normalizeNote>[]>([]);
    const [showClaimPicker, setShowClaimPicker] = useState(false);
    const [claimLoading, setClaimLoading] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; message: string;
        variant: 'danger' | 'warning' | 'info'; onConfirm: () => void;
    } | null>(null);

    const scrollRef = useRef<HTMLDivElement>(null);

    const mcpUrl = realtimeConfig?.xhsMcpConfig?.serverUrl || '';
    const mcpEnabled = realtimeConfig?.xhsMcpConfig?.enabled || false;

    // Load history for selected character
    const loadActivities = useCallback(async () => {
        if (!char) { setActivities([]); setOwnedPosts([]); return; }
        const [allActivities, storedPosts] = await Promise.all([
            DB.getXhsActivities(char.id),
            DB.getXhsOwnedPosts(char.id),
        ]);
        const knownIds = new Set(storedPosts.map(post => post.noteId));
        const migrated = collectOwnedPostsFromActivities(allActivities)
            .filter(post => !knownIds.has(post.noteId));
        if (migrated.length > 0) {
            await Promise.all(migrated.map(post => DB.saveXhsOwnedPost(post)));
        }
        setActivities(allActivities.slice(0, 50));
        setOwnedPosts([...storedPosts, ...migrated].sort((a, b) => b.publishedAt - a.publishedAt));
    }, [char]);

    useEffect(() => { loadActivities(); }, [loadActivities]);

    // Auto-scroll during activity
    useEffect(() => {
        if (scrollRef.current && isRunning) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [liveActivities, thinking, status, isRunning]);

    // Test MCP connection on mount
    useEffect(() => {
        if (!mcpEnabled || !mcpUrl) { setMcpStatus('unknown'); return; }
        XhsMcpClient.testConnection(mcpUrl).then(r => {
            setMcpStatus(r.connected ? 'connected' : 'error');
        }).catch(() => setMcpStatus('error'));
    }, [mcpEnabled, mcpUrl]);

    // Start free roam
    const handleStart = async () => {
        if (!char || isRunning) return;
        if (!mcpEnabled || !mcpUrl) {
            addToast('Please configure the Xiaohongshu MCP Server in Settings first', 'error');
            return;
        }
        if (!apiConfig.baseUrl) {
            addToast('Please configure the API in Settings first', 'error');
            return;
        }

        setIsRunning(true);
        setStatus('Starting...');
        setThinking('');
        setLiveActivities([]);
        trackEvent('Start Character Free Roam');

        const callbacks: FreeRoamCallbacks = {
            onStatus: (s) => setStatus(s),
            onThinking: (t) => setThinking(t),
            onActivity: (a) => setLiveActivities(prev => [...prev, a]),
            onComplete: (session) => {
                setStatus(`Activity ended: ${session.summary || 'Complete'}`);
                setIsRunning(false);
                loadActivities();
                addToast(`${char.name}'s free roam has ended`, 'success');
            },
            onError: (err) => {
                setStatus(`Error: ${err}`);
                setIsRunning(false);
                addToast(`Free roam error: ${err}`, 'error');
            },
        };

        try {
            await XhsFreeRoamEngine.run(
                char,
                userProfile,
                apiConfig,
                realtimeConfig || {} as any,
                callbacks,
            );
        } catch (e: any) {
            setStatus(`Exception: ${e.message}`);
            setIsRunning(false);
        }
    };

    const handleClearHistory = () => {
        if (!char) return;
        setConfirmDialog({
            isOpen: true,
            title: 'Clear Activity Records',
            message: `Are you sure you want to clear all of ${char.name}'s Xiaohongshu activity records?`,
            variant: 'danger',
            onConfirm: async () => {
                await DB.clearXhsActivities(char.id);
                setActivities([]);
                setConfirmDialog(null);
                addToast('Records cleared', 'success');
            }
        });
    };

    const handleLoadClaimCandidates = async () => {
        if (!char || claimLoading) return;
        const userId = realtimeConfig?.xhsMcpConfig?.loggedInUserId;
        if (!mcpEnabled || !mcpUrl || !userId) {
            addToast('Please connect Xiaohongshu and obtain a logged-in user ID in Settings first', 'error');
            return;
        }
        setClaimLoading(true);
        try {
            XhsMcpClient.setCookie(realtimeConfig?.xhsMcpConfig?.cookie);
            const result = await XhsMcpClient.getUserProfile(
                mcpUrl,
                userId,
                realtimeConfig?.xhsMcpConfig?.userXsecToken,
            );
            if (!result.success) throw new Error(result.error || 'Failed to read the real account homepage');
            const accountNotes = extractNotesFromMcpData(result.data).map(normalizeNote).filter(note => note.noteId);
            const claimedIds = new Set((await DB.getAllXhsOwnedPosts()).map(post => post.noteId));
            setClaimCandidates(accountNotes.filter(note => !claimedIds.has(note.noteId)));
            setShowClaimPicker(true);
        } catch (error: any) {
            addToast(error?.message || 'Failed to read real account posts', 'error');
        } finally {
            setClaimLoading(false);
        }
    };

    const handleClaimPost = async (note: ReturnType<typeof normalizeNote>) => {
        if (!char || !note.noteId) return;
        const now = Date.now();
        await DB.saveXhsOwnedPost({
            id: `${char.id}:${note.noteId}`,
            characterId: char.id,
            noteId: note.noteId,
            title: note.title || 'Untitled',
            body: note.desc || '',
            publishedAt: now,
            updatedAt: now,
            xsecToken: note.xsecToken,
            likes: note.likes,
            collects: note.collects,
            commentCount: note.commentCount,
            shareCount: note.shareCount,
        });
        setClaimCandidates(previous => previous.filter(candidate => candidate.noteId !== note.noteId));
        await loadActivities();
        addToast(`Assigned to ${char.name}'s homepage`, 'success');
    };

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        if (isToday) return time;
        return `${d.getMonth()+1}/${d.getDate()} ${time}`;
    };

    // Character picker dropdown
    const renderCharPicker = () => {
        if (!showCharPicker) return null;
        return (
            <div className="fixed inset-0 z-50 bg-black/30" onClick={() => setShowCharPicker(false)}>
                <div className="absolute top-14 left-4 right-4 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden animate-fade-in" onClick={e => e.stopPropagation()}>
                    <div className="p-3 border-b border-slate-50">
                        <p className="text-xs font-bold text-slate-400">Select Character</p>
                        {/* 分组筛选（没建分组时不渲染），白底下拉走浅色 */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={pickerGroupId} onChange={setPickerGroupId} className="mt-2" />
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                        {filterCharactersByGroup(characters, characterGroups, pickerGroupId).map(c => (
                            <button
                                key={c.id}
                                onClick={() => { setSelectedCharId(c.id); setShowCharPicker(false); }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                                    ${c.id === selectedCharId ? 'bg-rose-50' : 'active:bg-slate-50'}`}
                            >
                                {c.avatar ? (
                                    <TokenImg value={c.avatar} className="w-8 h-8 rounded-full object-cover" alt="" />
                                ) : (
                                    <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold text-slate-500">{c.name[0]}</div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-800 truncate">{c.name}</p>
                                    {c.description && <p className="text-[10px] text-slate-400 truncate">{c.description}</p>}
                                </div>
                                {c.id === selectedCharId && (
                                    <div className="w-2 h-2 rounded-full bg-rose-400" />
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    // No characters at all
    if (characters.length === 0) {
        return (
            <div className="h-full flex flex-col bg-gradient-to-b from-rose-50 to-white">
                <div className="flex items-center px-4 py-3 border-b border-slate-100" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                    <button onClick={closeApp} className="w-8 h-8 flex items-center justify-center text-slate-400 active:scale-90">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <h1 className="text-base font-bold text-slate-800 ml-1">Free Roam</h1>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <p className="text-sm text-slate-400">No characters yet, please create one first</p>
                </div>
            </div>
        );
    }

    // Activity detail modal
    const renderDetailModal = () => {
        if (!showDetail) return null;
        const a = showDetail;
        return (
            <div
                className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
                style={{ paddingBottom: 'var(--safe-bottom)', paddingTop: 'var(--safe-top)' }}
                onClick={() => setShowDetail(null)}
            >
                <div className="w-full max-w-lg bg-white rounded-t-3xl p-5 space-y-3 max-h-[75vh] overflow-y-auto animate-slide-up" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <ActionIcon type={a.actionType} className="w-5 h-5 inline-block" />
                            <span className="font-bold text-slate-800">{ACTION_LABELS[a.actionType] || a.actionType}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${RESULT_COLORS[a.result]}`}>{a.result}</span>
                        </div>
                        <span className="text-xs text-slate-400">{formatTime(a.timestamp)}</span>
                    </div>

                    {/* Thinking */}
                    <div className="bg-violet-50 rounded-2xl p-3">
                        <p className="text-[10px] font-bold text-violet-400 mb-1">Inner Thoughts</p>
                        <p className="text-xs text-violet-700 leading-relaxed">{a.thinking}</p>
                    </div>

                    {/* Content details */}
                    {a.content.title && (
                        <div className="bg-slate-50 rounded-2xl p-3">
                            <p className="text-[10px] font-bold text-slate-400 mb-1">Title</p>
                            <p className="text-sm text-slate-800 font-medium">{a.content.title}</p>
                        </div>
                    )}
                    {a.content.body && (
                        <div className="bg-slate-50 rounded-2xl p-3">
                            <p className="text-[10px] font-bold text-slate-400 mb-1">Body</p>
                            <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{a.content.body}</p>
                        </div>
                    )}
                    {a.content.tags && a.content.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {a.content.tags.map((t, i) => (
                                <span key={i} className="px-2 py-0.5 bg-red-50 text-red-500 text-[10px] rounded-full">#{t}</span>
                            ))}
                        </div>
                    )}
                    {a.content.keyword && (
                        <div className="bg-blue-50 rounded-2xl p-3">
                            <p className="text-[10px] font-bold text-blue-400 mb-1">Search Keyword</p>
                            <p className="text-sm text-blue-700">{a.content.keyword}</p>
                        </div>
                    )}

                    {/* Viewed notes */}
                    {a.content.notesViewed && a.content.notesViewed.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-[10px] font-bold text-slate-400">Posts Viewed</p>
                            {a.content.notesViewed.map((n, i) => (
                                <div key={i} className="bg-white border border-slate-100 rounded-xl p-2.5">
                                    <p className="text-xs font-medium text-slate-700">{n.title}</p>
                                    <p className="text-[10px] text-slate-400 mt-0.5">by {n.author} · {n.likes} likes</p>
                                    {n.desc && <p className="text-[10px] text-slate-500 mt-1 line-clamp-2">{n.desc}</p>}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Saved topics */}
                    {a.content.savedTopics && a.content.savedTopics.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-[10px] font-bold text-amber-500">Saved Topics</p>
                            {a.content.savedTopics.map((t, i) => (
                                <div key={i} className="bg-amber-50 border border-amber-100 rounded-xl p-2.5">
                                    <p className="text-xs font-medium text-amber-800">{t.title}</p>
                                    <p className="text-[10px] text-amber-600 mt-0.5">{t.desc}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Comment */}
                    {a.content.commentText && (
                        <div className="bg-green-50 rounded-2xl p-3">
                            <p className="text-[10px] font-bold text-green-500 mb-1">Comment Content</p>
                            <p className="text-xs text-green-700">{a.content.commentText}</p>
                            {a.content.commentTarget && (
                                <p className="text-[10px] text-green-500 mt-1">Comment on "{a.content.commentTarget.title}"</p>
                            )}
                        </div>
                    )}

                    {a.resultMessage && (
                        <p className="text-[10px] text-slate-400 text-center">{a.resultMessage}</p>
                    )}

                    {/* Delete single activity */}
                    <button
                        onClick={() => {
                            setConfirmDialog({
                                isOpen: true,
                                title: 'Delete This Record',
                                message: `Are you sure you want to delete this ${ACTION_LABELS[a.actionType] || 'activity'} record?`,
                                variant: 'danger',
                                onConfirm: async () => {
                                    await DB.deleteXhsActivity(a.id);
                                    setShowDetail(null);
                                    setConfirmDialog(null);
                                    await loadActivities();
                                    addToast('Deleted', 'success');
                                }
                            });
                        }}
                        className="w-full py-2.5 rounded-xl text-xs font-medium text-red-400 bg-red-50 active:bg-red-100 transition-colors"
                    >
                        Delete This Record
                    </button>
                </div>
            </div>
        );
    };

    const renderOwnedPostModal = () => {
        if (!showOwnedPost) return null;
        const post = showOwnedPost;
        return (
            <div
                className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
                style={{ paddingBottom: 'var(--safe-bottom)', paddingTop: 'var(--safe-top)' }}
                onClick={() => setShowOwnedPost(null)}
            >
                <div className="w-full max-w-lg bg-white rounded-t-3xl px-5 pt-5 pb-6 max-h-[78vh] overflow-y-auto animate-slide-up" onClick={e => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p className="text-[10px] font-bold tracking-[0.16em] text-rose-400 uppercase">{char?.name}'s Post</p>
                            <h2 className="text-lg font-bold text-slate-900 mt-1 leading-snug">{post.title || 'Untitled'}</h2>
                        </div>
                        <button onClick={() => setShowOwnedPost(null)} className="text-xs text-slate-400 px-2 py-1 active:text-slate-700">Close</button>
                    </div>

                    <p className="text-sm text-slate-600 leading-7 whitespace-pre-wrap mt-5">{post.body || '(No body text)'}</p>

                    {post.tags && post.tags.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-4">
                            {post.tags.map(tag => <span key={tag} className="text-xs text-rose-500">#{tag}</span>)}
                        </div>
                    )}

                    <div className="grid grid-cols-3 gap-4 border-y border-slate-100 py-4 mt-6 text-center">
                        <div><p className="text-base font-bold text-slate-800">{post.likes || 0}</p><p className="text-[10px] text-slate-400">Likes</p></div>
                        <div><p className="text-base font-bold text-slate-800">{post.collects || 0}</p><p className="text-[10px] text-slate-400">Saves</p></div>
                        <div><p className="text-base font-bold text-slate-800">{post.commentCount || 0}</p><p className="text-[10px] text-slate-400">Comments</p></div>
                    </div>

                    <div className="mt-4 space-y-1 text-[10px] text-slate-400">
                        <p>Published {new Date(post.publishedAt).toLocaleString()}</p>
                        <p className="font-mono break-all">note_id: {post.noteId}</p>
                    </div>
                </div>
            </div>
        );
    };

    const renderClaimPicker = () => {
        if (!showClaimPicker) return null;
        return (
            <div
                className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
                style={{ paddingBottom: 'var(--safe-bottom)', paddingTop: 'var(--safe-top)' }}
                onClick={() => setShowClaimPicker(false)}
            >
                <div className="w-full max-w-lg bg-white rounded-t-3xl max-h-[82vh] flex flex-col animate-slide-up" onClick={e => e.stopPropagation()}>
                    <div className="px-5 pt-5 pb-4 border-b border-slate-100">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 className="text-base font-bold text-slate-900">Claim Old Posts</h2>
                                <p className="text-[11px] text-slate-500 mt-1">From the shared real account, pick posts published by {char?.name || 'this character'}.</p>
                            </div>
                            <button onClick={() => setShowClaimPicker(false)} className="text-xs text-slate-400 px-2 py-1 active:text-slate-700">Close</button>
                        </div>
                    </div>

                    <div className="overflow-y-auto min-h-0">
                        {claimCandidates.length === 0 ? (
                            <div className="px-6 py-14 text-center">
                                <p className="text-sm font-medium text-slate-500">No posts available to claim</p>
                                <p className="text-[11px] text-slate-400 mt-1">The account's posts may already belong to other characters, or the homepage currently has no posts.</p>
                            </div>
                        ) : claimCandidates.map(note => (
                            <div key={note.noteId} className="px-5 py-4 border-b border-slate-100 flex items-start gap-4">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-slate-800 line-clamp-2">{note.title || 'Untitled'}</p>
                                    {note.desc && <p className="text-[11px] text-slate-500 mt-1 leading-relaxed line-clamp-2">{note.desc}</p>}
                                    <p className="text-[9px] text-slate-300 font-mono mt-2 truncate">{note.noteId}</p>
                                </div>
                                <button
                                    onClick={() => handleClaimPost(note)}
                                    className="shrink-0 px-3 py-2 rounded-full bg-rose-500 text-white text-[11px] font-bold active:scale-95 transition-transform"
                                >
                                    Assign to Homepage
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    // Live activity panel (during run)
    const renderLivePanel = () => (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {/* Status */}
            <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-slate-600 font-medium">{status}</span>
            </div>

            {/* Thinking bubble */}
            {thinking && char && (
                <div className="bg-violet-50 rounded-2xl p-3 animate-fade-in">
                    <div className="flex items-center gap-1.5 mb-1">
                        {char.avatar && <TokenImg value={char.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />}
                        <span className="text-[10px] font-bold text-violet-400">{char.name} is thinking...</span>
                    </div>
                    <p className="text-xs text-violet-700 leading-relaxed italic">"{thinking}"</p>
                </div>
            )}

            {/* Live activities */}
            {liveActivities.map((a, i) => (
                <div key={a.id || i} className="bg-white rounded-2xl border border-slate-100 p-3 space-y-1.5 animate-fade-in">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <ActionIcon type={a.actionType} className="w-4 h-4 inline-block" />
                            <span className="text-xs font-bold text-slate-700">{ACTION_LABELS[a.actionType]}</span>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${RESULT_COLORS[a.result]}`}>{a.result === 'success' ? 'Done' : a.result === 'failed' ? 'Failed' : 'Skipped'}</span>
                    </div>
                    {a.content.title && <p className="text-xs text-slate-600">{a.content.title}</p>}
                    {a.content.keyword && <p className="text-xs text-slate-500">Search: {a.content.keyword}</p>}
                    {a.resultMessage && <p className="text-[10px] text-slate-400">{a.resultMessage}</p>}
                </div>
            ))}

            {isRunning && liveActivities.length === 0 && !thinking && (
                <div className="flex flex-col items-center justify-center py-12 opacity-50">
                    <div className="w-8 h-8 border-2 border-rose-300 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs text-slate-400 mt-3">{char?.name || 'The character'} is out and about...</p>
                </div>
            )}
        </div>
    );

    const renderProfile = () => {
        const ownedNoteIds = new Set(ownedPosts.map(post => post.noteId));
        const successfulReplies = activities.filter(activity =>
            activity.actionType === 'comment'
            && activity.result === 'success'
            && !!activity.content.commentTarget?.noteId
            && ownedNoteIds.has(activity.content.commentTarget.noteId)
        ).length;

        return (
            <div className="flex-1 overflow-y-auto min-h-0 bg-white">
                <section className="px-5 pt-6 pb-5">
                    <div className="flex items-center gap-4">
                        {char?.avatar ? (
                            <TokenImg value={char.avatar} className="w-16 h-16 rounded-full object-cover ring-2 ring-rose-100" alt="" />
                        ) : (
                            <div className="w-16 h-16 rounded-full bg-rose-50 flex items-center justify-center text-xl font-bold text-rose-500 ring-2 ring-rose-100">
                                {char?.name?.[0] || '?'}
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <h2 className="text-xl font-bold text-slate-900 truncate">{char?.name || 'Character'}</h2>
                            <p className="text-xs text-slate-400 mt-1">Character's own Xiaohongshu homepage</p>
                        </div>
                    </div>

                    <div className="flex items-end gap-8 mt-5">
                        <div><p className="text-lg font-bold text-slate-900">{ownedPosts.length}</p><p className="text-[10px] text-slate-400">Posts</p></div>
                        <div><p className="text-lg font-bold text-slate-900">{successfulReplies}</p><p className="text-[10px] text-slate-400">Replied</p></div>
                    </div>

                    <p className="text-[11px] text-slate-500 leading-relaxed mt-4 border-l-2 border-rose-200 pl-3">
                        The real account can be shared with other characters; only the note_id of posts published by {char?.name || 'this character'} themselves is saved here. Clearing activity records will not remove homepage ownership.
                    </p>
                    <button
                        onClick={handleLoadClaimCandidates}
                        disabled={claimLoading || !mcpEnabled}
                        className="mt-4 text-xs font-medium text-rose-500 disabled:text-slate-300 active:opacity-60"
                    >
                        {claimLoading ? 'Reading real account...' : 'Claim old posts from the real account →'}
                    </button>
                </section>

                <div className="h-px bg-slate-100" />
                <div className="px-5 py-3 flex items-center justify-between">
                    <h3 className="text-xs font-bold text-slate-700">Posts</h3>
                    <span className="text-[10px] text-slate-400">Sorted by publish time</span>
                </div>

                {ownedPosts.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                        <PencilSimple size={36} weight="thin" className="text-slate-300 mx-auto" />
                        <p className="text-sm font-medium text-slate-500 mt-3">No posts published yet</p>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">After the next successful post, it will automatically appear here with a unique note_id.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-px bg-slate-100 border-y border-slate-100">
                        {ownedPosts.map(post => (
                            <button
                                key={post.id}
                                onClick={() => { setShowOwnedPost(post); trackEvent('Open Character Xiaohongshu Homepage Post'); }}
                                className="bg-white min-h-44 p-4 text-left flex flex-col active:bg-rose-50 transition-colors"
                            >
                                <div className="flex-1">
                                    <p className="text-sm font-bold text-slate-800 leading-snug line-clamp-3">{post.title || 'Untitled'}</p>
                                    {post.body && <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-4 mt-2">{post.body}</p>}
                                </div>
                                <div className="pt-3 mt-3 border-t border-slate-50 flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-slate-400">{formatTime(post.publishedAt)}</span>
                                    <span className="text-[10px] text-slate-400">♡ {post.likes || 0} · ◯ {post.commentCount || 0}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    // History list
    const renderHistory = () => (
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
            {activities.length === 0 ? (
                <div className="flex flex-col items-center px-2 py-8 space-y-4">
                    <div className="text-center opacity-60">
                        <Book size={48} weight="fill" className="text-rose-400" />
                        <p className="text-sm text-slate-500 font-medium mt-2">{char?.name || 'The character'} has no free roam records yet</p>
                    </div>

                    <div className="w-full bg-white/80 rounded-2xl border border-slate-100 p-4 space-y-3">
                        <p className="text-xs font-bold text-slate-600">What is Free Roam?</p>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                            Let {char?.name || 'the character'} use Xiaohongshu on their own — just like a real person browsing on their phone.
                            They decide what to do based on their own personality and recent chat content.
                        </p>
                        <div className="space-y-1.5">
                            <p className="text-[10px] font-bold text-slate-400">They might:</p>
                            <div className="grid grid-cols-2 gap-1.5">
                                {[
                                    { code: '270d', text: 'Publish a post' },
                                    { code: '1f50d', text: 'Search a topic of interest' },
                                    { code: '1f4f1', text: 'Browse the feed for trends' },
                                    { code: '1f3e0', text: 'Check their own homepage' },
                                    { code: '1f4ac', text: 'Reply to comments on their posts' },
                                    { code: '1f634', text: 'Or do nothing at all' },
                                ].map((item, i) => (
                                    <div key={i} className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-2 py-1.5">
                                        <TwemojiImg code={item.code} className="w-3.5 h-3.5 inline-block" />
                                        <span className="text-[10px] text-slate-500">{item.text}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="bg-rose-50 rounded-xl p-2.5">
                            <p className="text-[10px] text-rose-400 leading-relaxed">
                                After the activity ends, {char?.name || 'the character'} will remember what they saw. Next time you chat, they might bring up something interesting they saw on Xiaohongshu.
                            </p>
                        </div>
                    </div>

                    <p className="text-[10px] text-slate-300">Tap the button below to start the first free roam</p>
                </div>
            ) : (
                activities.map(a => (
                    <button
                        key={a.id}
                        onClick={() => { setShowDetail(a); trackEvent('Open Free Roam Record Detail'); }}
                        className="w-full bg-white rounded-2xl border border-slate-100 p-3 text-left active:scale-[0.98] transition-transform"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                                <ActionIcon type={a.actionType} className="w-4 h-4 inline-block" />
                                <span className="text-xs font-bold text-slate-700">{ACTION_LABELS[a.actionType]}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${RESULT_COLORS[a.result]}`}>{a.result}</span>
                            </div>
                            <span className="text-[10px] text-slate-300">{formatTime(a.timestamp)}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 line-clamp-1">
                            {a.thinking.slice(0, 80)}
                        </p>
                        {a.content.title && (
                            <p className="text-[10px] text-rose-400 mt-0.5 line-clamp-1">{a.content.title}</p>
                        )}
                        {a.content.savedTopics && a.content.savedTopics.length > 0 && (
                            <div className="flex gap-1 mt-1">
                                {a.content.savedTopics.map((t, i) => (
                                    <span key={i} className="text-[9px] bg-amber-50 text-amber-500 px-1.5 py-0.5 rounded-full">{t.title.slice(0, 10)}</span>
                                ))}
                            </div>
                        )}
                    </button>
                ))
            )}
        </div>
    );

    return (
        <div className="h-full flex flex-col bg-gradient-to-b from-rose-50 to-white">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <div className="flex items-center gap-2">
                    <button onClick={closeApp} className="w-8 h-8 flex items-center justify-center text-slate-400 active:scale-90">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    {/* Character selector */}
                    <button
                        onClick={() => !isRunning && setShowCharPicker(true)}
                        className="flex items-center gap-2 active:opacity-70 transition-opacity"
                        disabled={isRunning}
                    >
                        {char?.avatar ? (
                            <TokenImg value={char.avatar} className="w-7 h-7 rounded-full object-cover border-2 border-rose-200" alt="" />
                        ) : (
                            <div className="w-7 h-7 rounded-full bg-rose-100 flex items-center justify-center text-xs font-bold text-rose-500 border-2 border-rose-200">
                                {char?.name?.[0] || '?'}
                            </div>
                        )}
                        <div>
                            <div className="flex items-center gap-1">
                                <h1 className="text-sm font-bold text-slate-800">{char?.name || 'Select Character'}</h1>
                                {!isRunning && (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3 text-slate-400"><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                                )}
                            </div>
                            <p className="text-[10px] text-slate-400">{viewMode === 'profile' ? "Character's Homepage" : 'Activity Records'}</p>
                        </div>
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    {/* MCP status indicator */}
                    <div className={`w-2 h-2 rounded-full ${mcpStatus === 'connected' ? 'bg-emerald-400' : mcpStatus === 'error' ? 'bg-red-400' : 'bg-slate-300'}`} title={mcpStatus === 'connected' ? 'MCP Connected' : mcpStatus === 'error' ? 'MCP Not Connected' : 'Not Checked'} />

                    {activities.length > 0 && !isRunning && viewMode === 'activity' && (
                        <button onClick={handleClearHistory} className="text-[10px] text-slate-400 active:text-red-400">
                            Clear Records
                        </button>
                    )}
                </div>
            </div>

            {/* MCP not configured warning */}
            {!mcpEnabled && (
                <div className="mx-4 mt-3 bg-amber-50 border border-amber-200 rounded-2xl p-3">
                    <p className="text-xs text-amber-700 font-medium">Xiaohongshu MCP is not enabled</p>
                    <p className="text-[10px] text-amber-500 mt-1">
                        Please go to Settings → Real-time Perception → Xiaohongshu MCP, enable it, and configure the Server URL.
                    </p>
                </div>
            )}

            {!isRunning && (
                <div className="shrink-0 flex border-b border-slate-100 bg-white px-4">
                    <button
                        onClick={() => setViewMode('profile')}
                        className={`flex-1 py-3 flex items-center justify-center gap-1.5 text-xs font-medium border-b-2 transition-colors ${viewMode === 'profile' ? 'text-rose-500 border-rose-400' : 'text-slate-400 border-transparent'}`}
                    >
                        <House size={15} weight={viewMode === 'profile' ? 'fill' : 'regular'} />
                        Homepage
                    </button>
                    <button
                        onClick={() => setViewMode('activity')}
                        className={`flex-1 py-3 flex items-center justify-center gap-1.5 text-xs font-medium border-b-2 transition-colors ${viewMode === 'activity' ? 'text-rose-500 border-rose-400' : 'text-slate-400 border-transparent'}`}
                    >
                        <Book size={15} weight={viewMode === 'activity' ? 'fill' : 'regular'} />
                        Activity
                    </button>
                </div>
            )}

            {/* Main content */}
            {isRunning ? renderLivePanel() : viewMode === 'profile' ? renderProfile() : renderHistory()}

            {/* Bottom action area */}
            <div className="shrink-0 px-4 pb-5 pt-3 border-t border-slate-100 bg-white/80 backdrop-blur-sm">
                <button
                    onClick={handleStart}
                    disabled={isRunning || !mcpEnabled || !char}
                    className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-lg transition-all active:scale-[0.97]
                        ${isRunning
                            ? 'bg-slate-100 text-slate-400 shadow-none cursor-wait'
                            : (!mcpEnabled || !char)
                                ? 'bg-slate-100 text-slate-300 shadow-none cursor-not-allowed'
                                : 'bg-gradient-to-r from-rose-400 to-red-500 text-white shadow-rose-200'
                        }`}
                >
                    {isRunning ? (
                        <span className="flex items-center justify-center gap-2">
                            <div className="w-4 h-4 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                            Active...
                        </span>
                    ) : (
                        <span className="flex items-center justify-center gap-2">
                            <Book size={18} weight="fill" />
                            {char ? `${char.name}, go free roam!` : 'Please select a character first'}
                        </span>
                    )}
                </button>
                <p className="text-[9px] text-amber-400/80 text-center mt-2 leading-relaxed">
                    The character may comment on unrelated users, causing trouble for real people — please check and clean up inappropriate comments promptly
                </p>
            </div>

            {/* Modals */}
            {renderCharPicker()}
            {renderDetailModal()}
            {renderOwnedPostModal()}
            {renderClaimPicker()}
            {confirmDialog && (
                <ConfirmDialog
                    isOpen={confirmDialog.isOpen}
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    variant={confirmDialog.variant}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </div>
    );
};

export default XhsFreeRoamApp;
