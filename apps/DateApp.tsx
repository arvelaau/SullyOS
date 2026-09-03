
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, Message, DateState, AppID } from '../types';
import { DatePrompts, ApiMessage } from '../utils/datePrompts';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import type { PipelineResult } from '../utils/memoryPalace/pipeline';
import { incrementDigestRound, runCognitiveDigestion } from '../utils/memoryPalace';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import DateSession from '../components/date/DateSession';
import DateSettings from '../components/date/DateSettings';
import { armDateResumeAttempt, clearDateResumeAttempt, takeCrashedDateResume } from '../utils/dateSessionRecovery';
import { BookOpen, Sparkle, CaretLeft, GearSix } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trimHistoryThrough } from '../utils/dateSessionHistory';
import { trackEvent } from '../utils/analytics';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import StoryTheater from '../components/date/story/StoryTheater';
import { dateLaunch } from '../utils/dateLaunch';
import { materializeVisionDescriptions } from '../utils/visionApi';
import { shareOrDownloadFile } from '../utils/shareExport';
import { buildInPersonContinueInstruction } from '../utils/meetingContinue';
import {
    buildDateHistoryGroups,
    formatDateHistoryDate,
    formatDateHistoryExport,
    formatDateHistoryTime,
    makeDateHistoryFileName,
    type DateHistoryGroup,
    type DateHistorySortOrder,
    type DateHistoryView,
} from '../utils/dateHistory';

const DateApp: React.FC = () => {
    const { closeApp, openApp, characters, activeCharacterId, setActiveCharacterId, apiConfig, addToast, updateCharacter, virtualTime, userProfile, memoryPalaceConfig, dateAutoStartCharId, consumeDateAutoStart, characterGroups, groups, realtimeConfig } = useOS();

    // Whether we entered via the chat "Date" button: when true, exiting the date flow returns to
    // chat instead of the date select page/desktop. Carried in local state (not context) because
    // DateApp unmounts on switch, so the flag disappears with it and won't leak into a later date
    // session opened directly from the desktop.
    const [cameFromChat, setCameFromChat] = useState(false);
    const [meetSurface, setMeetSurface] = useState<'companion' | 'story'>(() => dateLaunch.peek()?.surface ?? 'companion');

    // Memory Palace (shares the same context setup as the chat side: same charId, same high-water mark)
    // The date flow also needs to run a buffer check + auto-archive pass after AI replies, otherwise it only "reads" and never "writes".
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // characters ref: by the time the date hook finishes, the user may have already turned off
    // Memory Palace in MemoryPalaceApp — charForHook, captured in the closure when the reply
    // started, would still read the stale memoryPalaceEnabled=true.
    const charactersRef = useRef(characters);
    charactersRef.current = characters;
    
    // Modes: 'select' -> 'peek' -> 'session' | 'settings' | 'history'
    const [mode, setMode] = useState<'select' | 'peek' | 'session' | 'settings' | 'history'>('select');
    // Track previous mode for Settings back navigation
    const [previousMode, setPreviousMode] = useState<'select' | 'peek'>('select');

    // Entry points like the global update popup can land directly on "Story". peek lets the
    // target page show on the very first render; subscribe covers the case where DateApp is
    // already open. Consumed immediately after applying — never leaks into the next normal open.
    useEffect(() => {
        const applyLaunchIntent = (intent: { surface: 'companion' | 'story' }) => {
            setCameFromChat(false);
            setMode('select');
            setMeetSurface(intent.surface);
            dateLaunch.consume();
        };

        const initialIntent = dateLaunch.peek();
        if (initialIntent) applyLaunchIntent(initialIntent);
        return dateLaunch.subscribe(applyLaunchIntent);
    }, []);

    // Select-page pagination (6 characters per page, horizontal paging)
    const SELECT_PAGE_SIZE = 6;
    const DATE_SESSION_MESSAGE_LIMIT = 220;
    const DATE_HISTORY_MESSAGE_LIMIT = 500;
    const pagerRef = useRef<HTMLDivElement>(null);
    const [selectPage, setSelectPage] = useState(0);
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // group filter for the select page
    const onPagerScroll = () => {
        const el = pagerRef.current;
        if (!el || el.clientWidth === 0) return;
        const p = Math.round(el.scrollLeft / el.clientWidth);
        setSelectPage(prev => (prev === p ? prev : p));
    };
    const goSelectPage = (pi: number) => {
        const el = pagerRef.current;
        if (!el) return;
        el.scrollTo({ left: pi * el.clientWidth, behavior: 'smooth' });
    };

    const [peekStatus, setPeekStatus] = useState<string>('');
    const [peekLoading, setPeekLoading] = useState(false);
    
    // History State
    const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
    const [historyView, setHistoryView] = useState<DateHistoryView>('encounter');
    const [historySortOrder, setHistorySortOrder] = useState<DateHistorySortOrder>('newest');
    const [historyLoadLimit, setHistoryLoadLimit] = useState(DATE_HISTORY_MESSAGE_LIMIT);
    const [historyReachedEnd, setHistoryReachedEnd] = useState(false);
    const [historyBusy, setHistoryBusy] = useState(false);
    // History long-press context menu
    const [historyMenuMsg, setHistoryMenuMsg] = useState<Message | null>(null);
    const [historyMenuPos, setHistoryMenuPos] = useState<{x: number, y: number}>({x: 0, y: 0});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // History edit modal
    const [historyEditMsg, setHistoryEditMsg] = useState<Message | null>(null);
    const [historyEditContent, setHistoryEditContent] = useState('');
    
    // Resume Logic State
    const [pendingSessionChar, setPendingSessionChar] = useState<CharacterProfile | null>(null);

    // --- NEW: Editing State lifted to here for DB sync ---
    const [dateMessages, setDateMessages] = useState<Message[]>([]);
    // For Reading Mode's "load earlier": the current query limit, and whether the DB has no earlier records left.
    const [dateLoadLimit, setDateLoadLimit] = useState(DATE_SESSION_MESSAGE_LIMIT);
    const [dateHistoryReachedEnd, setDateHistoryReachedEnd] = useState(false);
    const [hasSavedOpening, setHasSavedOpening] = useState(false);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editTargetMsg, setEditTargetMsg] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');

    const char = characters.find(c => c.id === activeCharacterId);
    const historyGroups = useMemo(
        () => buildDateHistoryGroups(historyMessages, historyView, historySortOrder),
        [historyMessages, historyView, historySortOrder],
    );

    // Date messages share the same history as regular chat — this is also the material for
    // Proactive Message 2.0's cloud snapshot (fire_pack). Marking dirty after every save/edit/delete
    // means killing the app mid-date won't lose this whole date from the cloud, and deleted/edited
    // content won't get brought up again by the character later. Snapshot messages are re-read
    // from the DB at upload time, so marking dirty itself is cheap.
    const markDateTurnDirty = (target = char) => {
        if (!target) return;
        markAmsgStateDirty({ char: target, userProfile, groups, realtimeConfig });
    };

    const getDateContextFetchLimit = (c: CharacterProfile) => Math.max(c.contextLimit || 500, DATE_SESSION_MESSAGE_LIMIT) + 32;
    const loadRecentDateMessages = async (charId: string, limit = DATE_SESSION_MESSAGE_LIMIT) => {
        return (await DB.getRecentMessagesByCharIdAndSource(charId, 'date', limit))
            .sort((a, b) => a.timestamp - b.timestamp);
    };

    // --- Data Loading ---
    const loadDateMessages = async (limit = dateLoadLimit) => {
        if (char) {
            // Date history only fetches the recent window now, instead of getAll-ing this
            // character's entire chat history into memory.
            // TODO(date-assets): once character portraits/backgrounds move to the assets store, this limit can be relaxed further.
            const filtered = await loadRecentDateMessages(char.id, limit);
            setDateMessages(filtered);
            // Got back fewer than requested = the DB's date history is exhausted, no need to page further back in Reading Mode.
            setDateHistoryReachedEnd(filtered.length < limit);

            // Check whether the DB already contains the current peekStatus (by content comparison), to avoid saving it twice
            if (peekStatus && filtered.some(m => m.content === peekStatus && m.role === 'assistant')) {
                setHasSavedOpening(true);
            }
        }
    };

    useEffect(() => {
        if (char && mode === 'session') {
            // Entering a session / switching characters both restart from the initial window.
            // limit must be passed explicitly: setState is async, so relying on the dateLoadLimit
            // closure would read the previous character's paged-in depth, out of sync with the reset state.
            setDateLoadLimit(DATE_SESSION_MESSAGE_LIMIT);
            setDateHistoryReachedEnd(false);
            loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
        }
    }, [char, mode]);


    /** Reading Mode requesting earlier records: re-fetch with an incremented limit (reverse cursor — the bigger the limit, the further back it reaches). */
    const handleLoadMoreDateHistory = async (nextLimit: number) => {
        setDateLoadLimit(nextLimit);
        await loadDateMessages(nextLimit);
    };

    // Date "resume last session" crash self-heal: if resuming a session last time crashed the
    // iOS WebKit content process (shows up as repeated gray/white screens, "This webpage keeps
    // reappearing," not a catchable JS exception), the sentinel from that heavy snapshot can
    // linger into this date session. Detected here, the toxic savedDateState is discarded (only
    // the resume snapshot is cleared, message history is untouched), so the user doesn't get
    // permanently stuck in a crash loop. Runs once, only when DateApp mounts.
    useEffect(() => {
        const crashedCharId = takeCrashedDateResume();
        if (!crashedCharId) return;
        const crashed = characters.find(c => c.id === crashedCharId);
        trackEvent('Detected and Cleaned Up Crashed Date Save', { Result: crashed?.savedDateState ? 'Save cleared' : 'No save to clear' });
        if (crashed?.savedDateState) {
            updateCharacter(crashedCharId, { savedDateState: undefined });
            addToast('Last date session exited abnormally — its save has been cleared, you can start again', 'info');
        }
    }, []); // Check only once, on mount

    // --- Navigation Helpers ---
    const handleBack = () => {
        if (mode === 'peek') {
            // From chat: exiting the perception page goes straight back to chat, not to the date select page
            if (cameFromChat) { returnToChat(); return; }
            setMode('select');
            setPeekStatus('');
        } else if (mode === 'history') {
            setMode('select');
        } else closeApp();
    };

    const formatTime = () => `${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;

    // LLM call shared by peek / send / reroll (prompt building is centralized in utils/datePrompts.ts)
    const callLLM = async (messages: ApiMessage[], temperature: number): Promise<string> => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages,
                temperature,
                // max_tokens is a required field for Claude's native API; without it, OpenAI→Claude
                // relays like Mochi Machine/Csy get bounced by the upstream and wrapped into a
                // 502 / bad_response_status_code. Aligned with private chat (useChatAI.ts), always send 8000.
                max_tokens: 8000,
                stream: apiConfig.stream ?? false,
            })
        });
        if (!response.ok) throw new Error(`API Error ${response.status}`);
        const data = await safeResponseJson(response);
        // Reasoning-style channels stuff the body into reasoning_content and leave content empty —
        // taking content directly gets an empty string with no error: a frozen black screen on
        // the peek page (no button to exit), or an empty message saved to the DB in a session.
        const content = extractContent(data);
        if (!content) throw new Error('The model returned an empty reply — please retry or check your channel/model settings');
        return content;
    };

    // --- Resume / Start Logic ---
    const handleCharClick = (c: CharacterProfile) => {
        if (c.savedDateState) {
            setPendingSessionChar(c);
        } else {
            startPeek(c);
        }
    };

    // Jumped in from chat's "Date" button: equivalent to clicking this character on the select
    // page (pops a resume/start-new prompt if a save exists, otherwise goes straight to perception),
    // and remembers "came from chat" so exiting the date returns to chat.
    useEffect(() => {
        if (!dateAutoStartCharId) return;
        const target = characters.find(c => c.id === dateAutoStartCharId);
        consumeDateAutoStart();
        setCameFromChat(true);
        setMeetSurface('companion');
        if (target) handleCharClick(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateAutoStartCharId]);

    // Exiting the date flow: back to chat if it came from chat, otherwise back to the date select page/desktop (decided by the caller)
    const returnToChat = () => {
        setCameFromChat(false);
        openApp(AppID.Chat);
    };

    const handleResumeSession = () => {
        if (!pendingSessionChar) return;
        // Arm the crash sentinel before attempting to resume: if this heavy snapshot crashes the
        // content process on iOS, the sentinel lingers and gets detected/cleaned up on the next
        // date entry (see the self-heal effect on mount).
        armDateResumeAttempt(pendingSessionChar.id);
        setActiveCharacterId(pendingSessionChar.id);
        setMode('session');
        setPendingSessionChar(null);
        addToast('Last progress restored', 'success');
        trackEvent('Choose How to Handle Date Save', { choice: 'resume' });
        trackEvent('Resume Last Date Progress');
    };

    const handleStartNewSession = () => {
        if (!pendingSessionChar) return;
        // A new session has no resume snapshot to replay — clear out any lingering sentinel.
        clearDateResumeAttempt();
        updateCharacter(pendingSessionChar.id, { savedDateState: undefined });
        trackEvent('Choose How to Handle Date Save', { choice: 'new' });
        trackEvent('Choose Start Over from Date Save');
        startPeek(pendingSessionChar);
        setPendingSessionChar(null);
    };

    // --- Key fix: archive the opening line immediately on entering the Session ---
    const handleEnterSession = async () => {
        if (!char) return;

        // 1. If there's an opening line and it hasn't been saved yet, save it to the DB right away
        // This ensures that when the user sends their first message, the AI can read this opening in the history
        // UPDATE: added the isOpening flag to distinguish new sessions
        if (peekStatus && !hasSavedOpening) {
            try {
                await DB.saveMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'text',
                    content: peekStatus,
                    metadata: { source: 'date', isOpening: true } // Added Flag
                });
                setHasSavedOpening(true);
            } catch (e) {
                console.error("Failed to save opening", e);
                // A save failure can't be silent: if the opening line never makes it into the DB,
                // Reading Mode/date history will be missing this opening — same symptom as "Reading
                // Mode plays stale content" — so let the user know something went wrong.
                addToast('Failed to save the opening line — it may not appear in Reading Mode', 'error');
            }
        }

        // 2. Switch mode and refresh data
        setMode('session');
        trackEvent('Walk Over to Start Date Session');
        await loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
    };

    // --- Peek (Generation) Logic ---
    const startPeek = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setMode('peek');
        setPeekLoading(true);
        setPeekStatus('');
        setHasSavedOpening(false);
        trackEvent('Enter Date Perception Page');

        try {
            const msgs = await DB.getRecentMessagesByCharId(c.id, getDateContextFetchLimit(c), true);
            const preparedMsgs = await materializeVisionDescriptions(msgs, apiConfig.visionApi);
            const emojis = await DB.getEmojis();
            const { messages } = DatePrompts.buildPeekPayload({
                char: c,
                userProfile,
                allMsgs: preparedMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, apiConfig.temperature ?? 0.85);
            setPeekStatus(content);

        } catch (e: any) {
            setPeekStatus(`(Failed to perceive state: ${e.message})`);
        } finally {
            setPeekLoading(false);
        }
    };

    // Memory Palace background flow, identical to the chat side's useChatAI:
    // triggers buffer processing + auto-archive (if enabled) + a 50-round cognitive digestion.
    const runMemoryPalacePostHook = useCallback(async (charForHook: CharacterProfile) => {
        // Read the latest state via charactersRef, to avoid still triggering an LLM summary here
        // off the stale enabled value in the charForHook closure after the user turns off Memory
        // Palace in MemoryPalaceApp mid-date-flow
        const liveBefore = charactersRef.current.find(c => c.id === charForHook.id) || null;
        if (!liveBefore?.memoryPalaceEnabled) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
        const mpLLM = (mpLLMConfigured?.baseUrl)
            ? mpLLMConfigured
            : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM.baseUrl) return;

        const recentMsgs = await DB.getRecentMessagesByCharId(charForHook.id, 50);
        try {
            const pipelineResult = await processNewMessagesWithAutoArchive(
                recentMsgs,
                charForHook.id,
                charForHook.name,
                mpEmb,
                mpLLM,
                userProfile?.name || '',
                false,
                (stage) => setMemoryPalaceStatus(stage),
            );

            // The user may have turned Memory Palace off again while the pipeline was running — check once more
            const liveAfter = charactersRef.current.find(c => c.id === charForHook.id) || null;
            if (!liveAfter?.memoryPalaceEnabled) return;

            if (pipelineResult && pipelineResult.stored > 0) {
                setMemoryPalaceResult(pipelineResult);
            }

            // 50-round auto cognitive digestion (shares the counter with the chat side, persisted per charId)
            const shouldAutoDigest = incrementDigestRound(charForHook.id);
            if (shouldAutoDigest) {
                setMemoryPalaceStatus(`${charForHook.name} closes their eyes and starts sorting through their feelings…`);
                const persona = [liveAfter.systemPrompt || '', liveAfter.worldview || ''].filter(Boolean).join('\n');
                await runCognitiveDigestion(charForHook.id, charForHook.name, persona, mpLLM, false, userProfile?.name, mpEmb);
            }
        } catch (e: any) {
            console.error('[DateApp MemoryPalace] Background processing error:', e?.message || e);
            addToast('Memory processing failed', 'error');
        } finally {
            const current = memoryPalaceStatusRef.current;
            // NOTE: '完成' ("done") is a literal substring match against status text emitted by the
            // out-of-scope utils/memoryPalace/pipeline.ts, which still returns Chinese stage strings.
            // Left untranslated on purpose — translating it would break this success-toast check
            // until pipeline.ts gets its own translation pass. See CLAUDE.md "Still open" section.
            if (current && current.includes('完成')) {
                addToast(current, 'success');
            }
            setMemoryPalaceStatus('');
        }
    }, [memoryPalaceConfig, apiConfig, userProfile?.name, updateCharacter, addToast]);

    // --- Session API Logic ---
    const handleSendMessage = async (text: string, kind?: 'continue'): Promise<string> => {
        if (!char) throw new Error("No char");

        // Resend scenario: if the last message in the DB is already this exact user message
        // (e.g. the API failed after the previous send / network hiccup), skip re-saving it and
        // go straight to the API. Aligned with chat app behavior, so the user can just hit send to retrigger the LLM.
        const recentCheck = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', 1);
        const isRetry = recentCheck.length > 0
            && recentCheck[0].role === 'user'
            && recentCheck[0].content === text
            && recentCheck[0].metadata?.source === 'date';
        // A retry after an API interruption only carries back the display text; restore the full
        // "continue" semantics from the already-saved flag.
        const isContinueTurn = kind === 'continue'
            || (isRetry && recentCheck[0].metadata?.meetingContinue === true);

        if (!isRetry) {
            // 1. Save User Msg
            await DB.saveMessage({
                charId: char.id,
                role: 'user',
                type: 'text',
                content: text,
                metadata: { source: 'date', ...(isContinueTurn ? { meetingContinue: true } : {}) },
            });
            markDateTurnDirty(char);
        }

        // 2. Prepare Context
        // Re-fetch messages. Since we saved the opening in handleEnterSession,
        // 'allMsgs' will now correctly contain: [History..., Opening, UserMsg]
        const allMsgs = await DB.getRecentMessagesByCharId(char.id, getDateContextFetchLimit(char), true);
        const preparedAllMsgs = await materializeVisionDescriptions(allMsgs, apiConfig.visionApi);

        // Update local state for display
        setDateMessages(await loadRecentDateMessages(char.id));

        const emojis = await DB.getEmojis();
        const modelText = isContinueTurn
            ? buildInPersonContinueInstruction(userProfile?.name, char.name)
            : text;
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile,
            allMsgs: preparedAllMsgs,
            emojis,
            userText: modelText,
            variant: 'send',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        const content = await callLLM(messages, apiConfig.temperature ?? 0.85);

        // 3. Save AI Response
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: content, metadata: { source: 'date' } });
        markDateTurnDirty(char);

        // Refresh local state
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace background flow (doesn't block the return, consistent with the chat side)
        runMemoryPalacePostHook(char);

        return content;
    };

    const handleReroll = async (): Promise<string> => {
        if (!char || dateMessages.length === 0) throw new Error("No context");

        const lastMsg = dateMessages[dateMessages.length - 1];
        if (lastMsg.role !== 'assistant') throw new Error("Cannot reroll user message");

        // Keep the old reply until the replacement request succeeds.
        const allMsgs = await DB.getRecentMessagesByCharId(char.id, getDateContextFetchLimit(char), true);
        const validMsgs = allMsgs.filter(m => m.id !== lastMsg.id);
        const preparedValidMsgs = await materializeVisionDescriptions(validMsgs, apiConfig.visionApi);
        const emojis = await DB.getEmojis();

        // Rerolling the opening line (the isOpening anchor message): use the same payload as
        // perception to regenerate the opening. Can't take the regular reroll path below — the
        // opening has no triggering user message before it. The old logic would delete the message
        // first and then throw "Context lost" (swallowing the opening); even if the previous message
        // happened to be a user message it could luckily continue on, the new message still wouldn't
        // carry isOpening, and Reading Mode would slice starting from the previous date's opening —
        // showing up as "the new date's Visual Mode has new content, but Reading Mode is all old content."
        if (lastMsg.metadata?.isOpening === true) {
            const { messages } = DatePrompts.buildPeekPayload({
                char,
                userProfile,
                allMsgs: preparedValidMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));
            // Only touch the DB after generation succeeds: delete the old opening, then save the
            // new one with isOpening — if the request fails, the original content isn't lost
            await DB.deleteMessage(lastMsg.id);
            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content, metadata: { source: 'date', isOpening: true } });
            markDateTurnDirty(char);
            trackEvent('Reroll Date Reply', { Target: 'Opening line' });
            // Sync the opening rendered at the top of an empty Reading Mode session, and the
            // peekStatus in the exit snapshot, to the new opening
            setPeekStatus(content);

            const freshMsgs = await DB.getMessagesByCharId(char.id, true);
            setDateMessages(freshMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp));
            return content;
        }

        const validDateMsgs = preparedValidMsgs.filter(m => m.metadata?.source === 'date');
        const lastUserMsg = validDateMsgs[validDateMsgs.length - 1];
        if (!lastUserMsg || lastUserMsg.role !== 'user') throw new Error("Context lost");

        // Call API logic (shares buildSessionPayload with handleSendMessage, only the variant differs)
        // History is trimmed up through the turn being rerolled: if the user sent a message in
        // regular chat after this date reply, validMsgs' (all-source) tail isn't this date user
        // message — passing it in directly would treat that chat message as "the last one pending
        // resend" and cut it, while the date user message gets appended again (one lost, one duplicated).
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile,
            allMsgs: trimHistoryThrough(preparedValidMsgs, lastUserMsg.id),
            emojis,
            userText: lastUserMsg.content,
            variant: 'reroll',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        // Reroll bumps the temperature slightly for variety, but never below the user's configured baseline.
        const content = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));

        // Only delete the old reply after generation succeeds: previously it deleted first then
        // called the API, so a failed request would permanently lose the previous content
        await DB.deleteMessage(lastMsg.id);
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: content, metadata: { source: 'date' } });
        markDateTurnDirty(char);
        trackEvent('Reroll Date Reply', { Target: 'Reply' });

        // Sync
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace background flow (a reroll also counts as a new round of output)
        runMemoryPalacePostHook(char);

        return content;
    };

    // --- Editing & Deletion ---
    // Edits/deletes need to mark dirty too (same handling as Chat.tsx's counterpart): the cloud
    // snapshot carries the raw text of recent messages — without refreshing it, the character
    // could still bring up a message that's already been deleted/edited when their turn comes.
    const handleDeleteMessage = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setDateMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        trackEvent('Delete a Date Message');
    };

    const handleDeleteMessages = async (ids: number[]) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map(id => DB.deleteMessage(id)));
        setDateMessages(prev => prev.filter(m => !ids.includes(m.id)));
        markDateTurnDirty();
        addToast(`${ids.length} record(s) deleted`, 'success');
        trackEvent('Bulk Delete Date Messages');
    };

    const confirmEditMessage = async () => {
        if (!editTargetMsg) return;
        await DB.updateMessage(editTargetMsg.id, editContent);
        setDateMessages(prev => prev.map(m => m.id === editTargetMsg.id ? { ...m, content: editContent } : m));
        markDateTurnDirty();
        setIsEditModalOpen(false);
        setEditTargetMsg(null);
        addToast('Edited', 'success');
        trackEvent('Edit a Date Message');
    };

    // --- History Long Press ---
    const handleHistoryLongPressStart = useCallback((msg: Message, e: React.TouchEvent | React.MouseEvent) => {
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        longPressTimer.current = setTimeout(() => {
            setHistoryMenuMsg(msg);
            setHistoryMenuPos({ x: clientX, y: clientY });
        }, 500);
    }, []);

    const handleHistoryLongPressEnd = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    const handleHistoryDelete = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setHistoryMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        setHistoryMenuMsg(null);
        addToast('Deleted', 'success');
        trackEvent('Delete a Message in Date History');
    };

    const handleHistoryEditOpen = (msg: Message) => {
        setHistoryEditMsg(msg);
        setHistoryEditContent(msg.content);
        setHistoryMenuMsg(null);
    };

    const handleHistoryEditConfirm = async () => {
        if (!historyEditMsg) return;
        await DB.updateMessage(historyEditMsg.id, historyEditContent);
        setHistoryMessages(prev => prev.map(m => (
            m.id === historyEditMsg.id ? { ...m, content: historyEditContent } : m
        )));
        markDateTurnDirty();
        setHistoryEditMsg(null);
        addToast('Edited', 'success');
        trackEvent('Edit a Message in Date History');
    };

    const onExitSession = (finalState: DateState) => {
        // The user actively saved and exited = a clean exit, cancel the resume sentinel.
        clearDateResumeAttempt();
        if (char) {
            updateCharacter(char.id, { savedDateState: finalState });
            addToast('Progress saved', 'success');
        }
        // From chat: exiting the date returns to chat
        if (cameFromChat) { returnToChat(); return; }
        setMode('select');
        setPeekStatus('');
        setHasSavedOpening(false);
    };

    // Go straight into settings from the select page (no need to enter a date first and tap the
    // menu) — portrait/observe changes etc. take effect immediately
    const openSettings = (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setPreviousMode('select');
        setMode('settings');
        trackEvent('Open Date Settings Panel', { from: 'select' });
    };

    const openHistory = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        // Date history is read independently by source=date, unaffected by the chat side's Memory Palace high-water mark.
        const msgs = await DB.getRecentMessagesByCharIdAndSource(c.id, 'date', DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryMessages(msgs);
        setHistoryView('encounter');
        setHistorySortOrder('newest');
        setHistoryLoadLimit(DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryReachedEnd(msgs.length < DATE_HISTORY_MESSAGE_LIMIT);
        setMode('history');
        trackEvent('Open Date History');
    };

    const handleLoadMoreHistory = async () => {
        if (!char || historyBusy || historyReachedEnd) return;
        const nextLimit = historyLoadLimit + DATE_HISTORY_MESSAGE_LIMIT;
        setHistoryBusy(true);
        try {
            const msgs = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', nextLimit);
            setHistoryMessages(msgs);
            setHistoryLoadLimit(nextLimit);
            setHistoryReachedEnd(msgs.length < nextLimit);
        } catch (error) {
            console.error('Load Earlier Date History Error', error);
            addToast('Failed to load earlier date history', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const exportHistoryGroups = async (groups: DateHistoryGroup[], scope: string) => {
        if (!char || groups.length === 0 || historyBusy) return;
        setHistoryBusy(true);
        try {
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, groups, historyView),
                fileName: makeDateHistoryFileName(char.name, scope),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}'s Date History`,
            });
            addToast(result === 'shared' ? 'Share panel opened' : 'Date history exported', 'success');
            trackEvent('Export Date History', { Scope: scope, 'Grouped By': historyView === 'encounter' ? 'By encounter' : 'By date' });
        } catch (error) {
            console.error('Export Date History Error', error);
            addToast('Failed to export date history', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const handleExportAllHistory = async () => {
        if (!char || historyBusy) return;
        setHistoryBusy(true);
        try {
            // Exporting is a deliberate user action, so it's fine to fully scan this character's
            // message index; only source=date is collected, to avoid reading image chats into memory.
            const allDateMessages = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', Number.MAX_SAFE_INTEGER);
            const allGroups = buildDateHistoryGroups(allDateMessages, historyView, historySortOrder);
            if (allGroups.length === 0) {
                addToast('No date history to export', 'info');
                return;
            }
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, allGroups, historyView),
                fileName: makeDateHistoryFileName(char.name, `All_${historyView === 'encounter' ? 'ByEncounter' : 'ByDate'}`),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}'s Full Date History`,
            });
            addToast(result === 'shared' ? 'Share panel opened' : 'Full date history exported', 'success');
            trackEvent('Export All Date History', { 'Grouped By': historyView === 'encounter' ? 'By encounter' : 'By date' });
        } catch (error) {
            console.error('Export All Date History Error', error);
            addToast('Failed to export full date history', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    // --- Render ---

    if (meetSurface === 'story' && mode === 'select' && !cameFromChat) {
        return <StoryTheater onSwitchCompanion={() => setMeetSurface('companion')} onClose={closeApp} />;
    }

    if (mode === 'select' || !char) {
        // 6 characters per page, horizontal paging (filter by group first, then page)
        const selectChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
        const pages: CharacterProfile[][] = [];
        for (let i = 0; i < selectChars.length; i += SELECT_PAGE_SIZE) pages.push(selectChars.slice(i, i + SELECT_PAGE_SIZE));
        if (pages.length === 0) pages.push([]);
        // Light theme (based on the "Dwelling" room): pale lavender background + soft stars + serif title + compass-ring character cards
        const th = {
            pageBg: 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)',
            stars: 'radial-gradient(1.5px 1.5px at 14% 16%,rgba(190,160,225,.45),transparent),radial-gradient(1px 1px at 80% 12%,rgba(220,190,235,.5),transparent),radial-gradient(1.5px 1.5px at 42% 28%,rgba(180,200,240,.4),transparent),radial-gradient(1px 1px at 86% 42%,rgba(200,175,230,.4),transparent),radial-gradient(1px 1px at 22% 66%,rgba(210,185,235,.35),transparent),radial-gradient(1px 1px at 66% 80%,rgba(200,210,240,.35),transparent)',
            title: '#6a5790', titleShadow: 'rgba(170,150,220,.4)', line: 'rgba(150,120,190,.5)',
            cardBorder: 'rgba(170,140,210,.3)', cardShadow: '0 8px 22px rgba(150,120,200,.18)',
            inner: 'rgba(170,140,210,.22)', gem: 'rgba(190,160,220,.85)',
            tick: 'rgba(170,140,210,.16)', halo: 'rgba(200,175,235,.3)',
            ring1: 'rgba(180,150,215,.5)', ring2: 'rgba(180,150,215,.25)', avGlow: 'rgba(190,160,235,.4)',
        };
        // Soft background cycling per card, in order — pink/lavender/pale-blue gradients (same as the Dwelling's light cards)
        const CARD_TINTS = [
            'linear-gradient(180deg,rgba(250,212,228,.85),rgba(242,228,246,.8))',
            'linear-gradient(180deg,rgba(232,228,248,.85),rgba(242,238,250,.8))',
            'linear-gradient(180deg,rgba(226,216,246,.85),rgba(238,230,249,.8))',
            'linear-gradient(180deg,rgba(212,230,247,.85),rgba(234,240,250,.8))',
            'linear-gradient(180deg,rgba(226,212,245,.85),rgba(238,228,249,.8))',
            'linear-gradient(180deg,rgba(234,231,242,.88),rgba(242,240,247,.82))',
        ];
        return (
            <div className="h-full w-full relative overflow-hidden flex flex-col font-light" style={{ background: th.pageBg }}>
                {/* Soft starlight ambiance */}
                <div className="absolute inset-0 pointer-events-none opacity-70" style={{ backgroundImage: th.stars }} />

                {/* Top bar + title */}
                <div className="relative z-10 shrink-0" style={{ paddingTop: 'max(1.25rem, var(--safe-top))' }}>
                    <div className="relative flex items-center justify-center px-5 pt-2">
                        <button onClick={() => { if (cameFromChat) { returnToChat(); } else { closeApp(); } }}
                                className="absolute left-4 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
                                style={{ color: '#8f7bb5', background: 'rgba(255,255,255,0.6)', boxShadow: '0 2px 8px rgba(150,120,200,0.15)' }}>
                            <CaretLeft size={19} weight="bold" />
                        </button>
                        <div className="text-center">
                            <h1 className="text-[26px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: th.title, textShadow: `0 2px 18px ${th.titleShadow}` }}>Choose Someone to Meet</h1>
                            <div className="flex items-center justify-center gap-2 mt-1.5">
                                <span className="h-px w-10" style={{ background: `linear-gradient(90deg,transparent,${th.line})` }} />
                                <span className="text-[9px] tracking-[0.4em] font-bold" style={{ color: 'rgba(150,120,190,0.75)' }}>✦ CHOOSE CHARACTER ✦</span>
                                <span className="h-px w-10" style={{ background: `linear-gradient(270deg,transparent,${th.line})` }} />
                            </div>
                        </div>
                    </div>
                    <div className='mx-auto mt-4 mb-3 grid w-[min(18rem,calc(100%-2.5rem))] grid-cols-2 rounded-xl bg-white/45 p-1 shadow-sm'>
                        <button className='rounded-lg bg-white py-2 text-xs font-bold text-[#715d99] shadow-sm'>Companion</button>
                        <button onClick={() => setMeetSurface('story')} className='rounded-lg py-2 text-xs font-bold text-[#8f7bb5]'>Story</button>
                    </div>
                    {/* Group filter (not rendered when no groups exist). Switching groups resets to the first page */}
                    <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                        value={selectGroupId}
                        onChange={(id) => { setSelectGroupId(id); setSelectPage(0); pagerRef.current?.scrollTo({ left: 0 }); }}
                        className="px-4 mb-3" />
                </div>

                {/* Paged card area */}
                {selectChars.length === 0 ? (
                    <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(150,120,190,0.7)' }}>
                        <Sparkle size={40} weight="light" />
                        <span className="text-xs tracking-wider">{characters.length ? 'No characters in this group' : 'No characters to meet yet'}</span>
                    </div>
                ) : (
                    <div ref={pagerRef} onScroll={onPagerScroll}
                         className="relative z-10 flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
                         style={{ scrollSnapType: 'x mandatory' }}>
                        {pages.map((page, pi) => (
                            <div key={pi} className="w-full shrink-0 snap-start h-full overflow-y-auto no-scrollbar px-5 pt-4">
                                <div className="grid grid-cols-2 gap-4 pb-6">
                                    {page.map((c, idx) => {
                                        const tint = CARD_TINTS[(pi * SELECT_PAGE_SIZE + idx) % CARD_TINTS.length];
                                        return (
                                        <div key={c.id} onClick={() => handleCharClick(c)}
                                             className="group relative rounded-2xl px-3 pt-8 pb-5 flex flex-col items-center active:scale-95 transition-all overflow-hidden"
                                             style={{ background: tint, border: `1px solid ${th.cardBorder}`, boxShadow: th.cardShadow }}>
                                            {/* Inner border + corner gems */}
                                            <div className="absolute inset-[7px] rounded-xl pointer-events-none" style={{ border: `1px solid ${th.inner}` }} />
                                            <span className="absolute top-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute top-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            {/* Online badge */}
                                            <div className="absolute top-2.5 left-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full z-10"
                                                 style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(120,200,160,0.4)', boxShadow: '0 1px 4px rgba(120,90,170,0.12)' }}>
                                                <span className="relative flex h-1.5 w-1.5">
                                                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                                </span>
                                                <span className="text-[8px] font-bold text-emerald-600 tracking-wider">Online</span>
                                            </div>
                                            {/* Settings / History (stacked vertically) */}
                                            <div className="absolute top-2 right-2 flex flex-col gap-1 z-20">
                                                <button onClick={(e) => { e.stopPropagation(); openSettings(c); }} title="Scene Settings / Set Portrait / Observe"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <GearSix size={15} weight="fill" />
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); openHistory(c); }} title="Date History"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <BookOpen size={15} weight="fill" />
                                                </button>
                                            </div>
                                            {/* Avatar + compass ring + double ring + glow */}
                                            <div className="relative w-[92px] h-[92px] flex items-center justify-center mt-1">
                                                <div className="absolute w-[124px] h-[124px] rounded-full" style={{ background: `repeating-conic-gradient(from 0deg, ${th.tick} 0deg 2.4deg, transparent 2.4deg 9deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)', maskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)' }} />
                                                <div className="absolute w-[110px] h-[110px] rounded-full" style={{ background: `radial-gradient(circle, ${th.halo}, transparent 62%)` }} />
                                                <div className="absolute inset-[8px] rounded-full" style={{ border: `1px solid ${th.ring1}` }} />
                                                <div className="absolute inset-[12px] rounded-full" style={{ border: `1px solid ${th.ring2}` }} />
                                                <div className="w-[70px] h-[70px] rounded-full overflow-hidden" style={{ boxShadow: `0 0 18px ${th.avGlow}` }}>
                                                    <TokenImg value={c.avatar} className="w-full h-full object-cover" alt={c.name} />
                                                </div>
                                                {c.savedDateState && (
                                                    <div title="Has a save" className="absolute bottom-0 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ background: '#fbbf24', boxShadow: '0 1px 5px rgba(180,120,20,0.4)' }}>
                                                        <Sparkle size={12} weight="fill" className="text-white" />
                                                    </div>
                                                )}
                                            </div>
                                            {/* Name + description */}
                                            <span className="mt-3 text-[14px] font-semibold tracking-wide truncate max-w-full" style={{ color: '#4b3b6b', fontFamily: `'Noto Serif SC',serif` }}>{c.name}</span>
                                            <span className="mt-0.5 text-[10px] truncate max-w-full" style={{ color: c.description ? 'rgba(120,95,160,0.78)' : 'rgba(150,130,185,0.6)' }}>{c.description || 'Go meet them'}</span>
                                        </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Page dots */}
                {pages.length > 1 && (
                    <div className="relative z-10 shrink-0 flex justify-center items-center gap-2 py-3">
                        {pages.map((_, pi) => (
                            <button key={pi} onClick={() => goSelectPage(pi)} aria-label={`Page ${pi + 1}`}
                                    className="h-2 rounded-full transition-all"
                                    style={{ width: pi === selectPage ? 24 : 8, background: pi === selectPage ? '#a78bd6' : 'rgba(170,140,210,0.35)' }} />
                        ))}
                    </div>
                )}

                <Modal isOpen={!!pendingSessionChar} title="Progress Found" onClose={() => { setPendingSessionChar(null); if (cameFromChat) returnToChat(); }} footer={<div className="flex gap-3 w-full"><button onClick={handleStartNewSession} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">New Date</button><button onClick={handleResumeSession} className="flex-1 py-3 bg-green-500 text-white rounded-2xl font-bold shadow-lg shadow-green-200">Resume Last Time</button></div>}>
                    <div className="text-center text-slate-500 text-sm py-4">Detected an unfinished date with {pendingSessionChar?.name}.<br/><span className="text-xs text-slate-400 mt-2 block">(Saved at: {pendingSessionChar?.savedDateState?.timestamp ? new Date(pendingSessionChar.savedDateState.timestamp).toLocaleString() : 'Unknown'})</span></div>
                </Modal>
            </div>
        );
    }

    if (mode === 'history') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light" onClick={() => historyMenuMsg && setHistoryMenuMsg(null)}>
                <div className="border-b border-slate-200 bg-white sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-16 flex items-center justify-between px-4">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-slate-100"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                        <div className="text-center min-w-0">
                            <div className="font-bold text-slate-700">Date History</div>
                            <div className="text-[10px] text-slate-400 truncate max-w-36">{char.name}</div>
                        </div>
                        <button
                            onClick={(event) => { event.stopPropagation(); handleExportAllHistory(); }}
                            disabled={historyBusy || historyMessages.length === 0}
                            className="text-xs font-bold text-blue-500 px-2 py-2 -mr-2 rounded-lg hover:bg-blue-50 disabled:opacity-40"
                        >
                            Export All
                        </button>
                    </div>
                    <div className="px-4 pb-3 flex items-center gap-2">
                        <div className="flex-1 p-1 rounded-xl bg-slate-100 flex">
                            <button
                                onClick={() => setHistoryView('encounter')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'encounter' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >By Encounter</button>
                            <button
                                onClick={() => setHistoryView('date')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'date' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >By Date</button>
                        </div>
                        <button
                            onClick={() => setHistorySortOrder(order => order === 'newest' ? 'oldest' : 'newest')}
                            className="h-9 px-3 rounded-xl border border-slate-200 bg-white text-[11px] font-bold text-slate-500 whitespace-nowrap"
                            title="Toggle sort order"
                        >
                            {historySortOrder === 'newest' ? 'New → Old' : 'Old → New'}
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-20">
                    {historyGroups.length === 0 ? <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2"><BookOpen size={48} className="opacity-50" /><span className="text-xs">No date history yet</span></div> : historyGroups.map((group) => (
                        <div key={group.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 flex gap-3 justify-between items-center">
                                <div className="min-w-0">
                                    <div className="text-xs font-bold text-slate-600 tracking-wide truncate">
                                        {historyView === 'encounter' ? formatDateHistoryTime(group.startAt, true) : formatDateHistoryDate(group.startAt)}
                                    </div>
                                    <div className="text-[10px] text-slate-400 mt-1">
                                        {historyView === 'encounter'
                                            ? (group.hasOpeningAnchor ? 'One complete date' : 'Legacy record · grouped by date for compatibility')
                                            : (group.encounterCount > 0 ? `${group.encounterCount} opening(s)` : 'Legacy record')}
                                        {' · '}{group.messages.length} lines
                                    </div>
                                </div>
                                <button
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        exportHistoryGroups([group], `${historyView === 'encounter' ? 'ThisEncounter' : 'ThisDay'}_${group.dateKey}`);
                                    }}
                                    disabled={historyBusy}
                                    className="shrink-0 text-[11px] font-bold text-blue-500 bg-blue-50 px-3 py-1.5 rounded-full disabled:opacity-40"
                                >Export {historyView === 'encounter' ? 'This Encounter' : 'This Day'}</button>
                            </div>
                            <div className="p-4 space-y-4">
                                {group.messages.map(m => {
                                    const text = (m.content || '').replace(/\[.*?\]/g, '').trim();
                                    return (
                                        <div
                                            key={m.id}
                                            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} select-none`}
                                            onTouchStart={(e) => handleHistoryLongPressStart(m, e)}
                                            onTouchEnd={handleHistoryLongPressEnd}
                                            onTouchMove={handleHistoryLongPressEnd}
                                            onMouseDown={(e) => handleHistoryLongPressStart(m, e)}
                                            onMouseUp={handleHistoryLongPressEnd}
                                            onMouseLeave={handleHistoryLongPressEnd}
                                            onContextMenu={(e) => { e.preventDefault(); setHistoryMenuMsg(m); setHistoryMenuPos({ x: e.clientX, y: e.clientY }); }}
                                        >
                                            <div className={`max-w-[90%] text-sm leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'text-slate-500 text-right italic' : 'text-slate-800'}`}>
                                                {m.role === 'user' ? <span className="bg-slate-100 px-3 py-2 rounded-xl rounded-tr-none inline-block">{text}</span> : <span>{text || '(No content)'}</span>}
                                            </div>
                                            <div className="text-[9px] text-slate-300 mt-1 px-1">{formatDateHistoryTime(m.timestamp)}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                    {!historyReachedEnd && historyMessages.length > 0 && (
                        <button
                            onClick={handleLoadMoreHistory}
                            disabled={historyBusy}
                            className="w-full py-3 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-500 disabled:opacity-50"
                        >
                            {historyBusy ? 'Loading…' : 'Load Earlier Date History'}
                        </button>
                    )}
                </div>

                {/* Long-press context menu */}
                {historyMenuMsg && (
                    <div
                        className="fixed z-50 bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden animate-fade-in"
                        style={{ top: Math.min(historyMenuPos.y, window.innerHeight - 120), left: Math.min(historyMenuPos.x, window.innerWidth - 140) }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => handleHistoryEditOpen(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-slate-700 hover:bg-slate-50 active:bg-slate-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg>
                            Edit
                        </button>
                        <div className="border-t border-slate-100" />
                        <button
                            onClick={() => handleHistoryDelete(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-red-500 hover:bg-red-50 active:bg-red-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                            Delete
                        </button>
                    </div>
                )}

                {/* History edit modal */}
                <Modal isOpen={!!historyEditMsg} title="Edit Message" onClose={() => setHistoryEditMsg(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setHistoryEditMsg(null)} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">Cancel</button>
                        <button onClick={handleHistoryEditConfirm} className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-bold shadow-lg shadow-blue-200">Save</button>
                    </div>
                }>
                    <textarea
                        value={historyEditContent}
                        onChange={(e) => setHistoryEditContent(e.target.value)}
                        className="w-full h-48 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                </Modal>
            </div>
        );
    }

    if (mode === 'peek') {
        return (
            <div className="h-full w-full bg-black relative flex flex-col font-sans overflow-hidden">
                <div className="pt-24 flex flex-col items-center z-10 shrink-0">
                     <div className="text-xs font-mono text-neutral-500 mb-2 tracking-[0.2em] font-medium">{virtualTime.day.toUpperCase()} {formatTime()}</div>
                     <h2 className="text-4xl font-light text-white tracking-[0.3em] uppercase">{char.name}</h2>
                </div>
                {peekLoading && (
                    <div className="flex-1 flex flex-col items-center justify-center -mt-20 z-10"><div className="w-12 h-[1px] bg-neutral-800 mb-12"></div><div className="w-[1px] h-12 bg-gradient-to-b from-transparent via-white to-transparent animate-pulse mb-6"></div><p className="text-sm font-light text-neutral-500 italic tracking-widest">Perceiving...</p></div>
                )}
                {!peekLoading && peekStatus && (
                    <div className="flex-1 min-h-0 flex flex-col px-8 pb-10 z-10 animate-fade-in">
                        <div className="flex-1 overflow-y-auto no-scrollbar mb-8 mask-image-gradient pt-8"><div className="min-h-full flex flex-col justify-center"><p className="text-neutral-300 text-[15px] leading-8 tracking-wide text-justify font-light select-none whitespace-pre-wrap">{peekStatus}</p></div></div>
                        <div className="shrink-0 flex flex-col items-center gap-6">
                             <div className="w-full flex gap-3">
                                 {/* Changed here: calls handleEnterSession to make sure the opening line gets saved */}
                                 <button onClick={handleEnterSession} className="flex-1 h-14 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm shadow-[0_0_20px_rgba(255,255,255,0.1)] active:scale-95 transition-transform hover:bg-neutral-200">Approach</button>
                                 <button onClick={() => { trackEvent('Re-perceive Character State'); startPeek(char); }} className="w-14 h-14 bg-neutral-800 text-white rounded-full flex items-center justify-center border border-neutral-700 shadow-lg active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></button>
                             </div>
                             <div className="flex flex-col items-center gap-3 text-[10px] text-neutral-600 font-medium tracking-wider"><button onClick={() => { setPreviousMode('peek'); setMode('settings'); trackEvent('Open Date Settings Panel', { from: 'peek' }); }} className="hover:text-neutral-400 transition-colors">Scene Settings / Set Portrait</button><button onClick={handleBack} className="hover:text-neutral-400 transition-colors">Slip Away Quietly</button></div>
                        </div>
                    </div>
                )}
                {/* Fallback: perception finished but peekStatus is empty (historically an empty
                    model reply would land here) — previously this rendered nothing, leaving a pure
                    black screen with just the character's name, not even an exit button */}
                {!peekLoading && !peekStatus && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-8 -mt-20 z-10 animate-fade-in">
                        <p className="text-sm font-light text-neutral-500 italic tracking-widest">Couldn't perceive {char.name}'s state</p>
                        <button onClick={() => { trackEvent('Re-perceive Character State'); startPeek(char); }} className="h-12 px-10 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm active:scale-95 transition-transform hover:bg-neutral-200">Re-perceive</button>
                        <button onClick={handleBack} className="text-[10px] text-neutral-600 font-medium tracking-wider hover:text-neutral-400 transition-colors">Slip Away Quietly</button>
                    </div>
                )}
            </div>
        );
    }

    if (mode === 'settings') {
        return <DateSettings char={char} onBack={() => setMode(previousMode)} />;
    }

    if (mode === 'session') {
        return (
            <>
                <DateSession
                    char={char}
                    userProfile={userProfile}
                    messages={dateMessages}
                    peekStatus={peekStatus}
                    initialState={char.savedDateState}
                    onSendMessage={handleSendMessage}
                    onReroll={handleReroll}
                    onExit={onExitSession}
                    onEditMessage={(msg) => { setEditTargetMsg(msg); setEditContent(msg.content); setIsEditModalOpen(true); }}
                    onDeleteMessage={handleDeleteMessage}
                    onDeleteMessages={handleDeleteMessages}
                    onSettings={() => {}} // Removed parent state change, DateSession handles it internally now
                    onLoadMoreHistory={handleLoadMoreDateHistory}
                    historyLoadLimit={dateLoadLimit}
                    historyReachedEnd={dateHistoryReachedEnd}
                />

                {/* Organizing memories — floating capsule at the top (matches the chat side's appearance) */}
                {memoryPalaceStatus && (
                    <div
                        className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                        style={{ transform: 'translateX(-50%)', pointerEvents: 'none', willChange: 'transform, opacity' }}
                    >
                        <div
                            className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[18rem]"
                            style={{
                                background: 'rgba(255,255,255,0.88)',
                                borderRadius: 999,
                                border: '1px solid rgba(99,102,241,0.18)',
                                boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                            }}
                        >
                            <span
                                className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                                style={{ borderTopColor: '#6366f1', animationDuration: '0.9s' }}
                            />
                            <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                                {char.name} is lost in thought
                            </span>
                            <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                        </div>
                    </div>
                )}

                {/* Memory processing result — modal */}
                {memoryPalaceResult && (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{ pointerEvents: 'all', background: 'rgba(15,23,42,0.55)' }}
                        onClick={() => setMemoryPalaceResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[82vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(148,163,184,0.18)',
                                boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div
                                className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)' }}
                            />
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(129,140,248,0.06))',
                                        border: '1px solid rgba(99,102,241,0.15)',
                                    }}
                                >
                                    <span style={{ fontSize: 26 }}>🗂️</span>
                                </div>
                                <div className="text-[10px] tracking-[0.25em] uppercase font-semibold" style={{ color: '#6366f1' }}>Memory Palace</div>
                                <p className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>Memory Processing Complete</p>
                                <p className="text-[11px] text-slate-400 mt-1">
                                    {memoryPalaceResult.stored} new · {memoryPalaceResult.skipped} skipped as duplicates
                                    {memoryPalaceResult.batches.length > 1 && ` · ${memoryPalaceResult.batches.length} batch(es)`}
                                </p>
                                {memoryPalaceResult.batches.some(b => !b.ok) && (
                                    <p className="text-[10px] text-red-500 mt-1">
                                        {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `Batch ${b.index} failed`).join(', ')}
                                    </p>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2 no-scrollbar">
                                {memoryPalaceResult.memories.map((m, i) => {
                                    const roomMeta: Record<string, { label: string; color: string }> = {
                                        living_room: { label: 'Living Room', color: '#f59e0b' },
                                        bedroom: { label: 'Bedroom', color: '#8b5cf6' },
                                        study: { label: 'Study', color: '#0ea5e9' },
                                        user_room: { label: "User's Room", color: '#ec4899' },
                                        self_room: { label: 'Self Room', color: '#10b981' },
                                        attic: { label: 'Attic', color: '#6366f1' },
                                        windowsill: { label: 'Windowsill', color: '#14b8a6' },
                                    };
                                    const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                    const roomLabel = getRoomLabel(m.room as any, userProfile?.name) || meta.label;
                                    return (
                                        <div
                                            key={i}
                                            className="p-3 rounded-2xl"
                                            style={{
                                                background: 'rgba(255,255,255,0.75)',
                                                border: `1px solid ${meta.color}22`,
                                                boxShadow: `0 2px 8px ${meta.color}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                            }}
                                        >
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                                                    style={{ background: `${meta.color}18`, color: meta.color }}
                                                >
                                                    {roomLabel}
                                                </span>
                                                <span className="text-[10px] text-slate-400">{m.mood}</span>
                                                <span className="text-[10px] font-bold ml-auto" style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                            </div>
                                            <p className="text-[12px] text-slate-700 leading-relaxed">{m.content}</p>
                                            {m.tags.length > 0 && (
                                                <div className="flex gap-1 mt-2 flex-wrap">
                                                    {m.tags.map((t, j) => (
                                                        <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full"
                                                            style={{ background: 'rgba(148,163,184,0.15)', color: '#64748b' }}
                                                        >{t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {memoryPalaceResult.memories.length === 0 && (
                                    <p className="text-center text-xs text-slate-400 py-4">No new memories extracted this time</p>
                                )}
                            </div>
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setMemoryPalaceResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                        boxShadow: '0 6px 18px -6px rgba(79,70,229,0.5)',
                                    }}
                                >
                                    Confirm
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Global Message Edit Modal for Session Mode */}
                <Modal isOpen={isEditModalOpen} title="Edit Content" onClose={() => setIsEditModalOpen(false)} footer={<><button onClick={() => setIsEditModalOpen(false)} className="flex-1 py-3 bg-slate-100 rounded-2xl">Cancel</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">Save</button></>}>
                    <textarea value={editContent} onChange={e => setEditContent(e.target.value)} className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed" />
                </Modal>
            </>
        );
    }

    return null;
};

export default DateApp;
