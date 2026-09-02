/**
 * The "this turn didn't go to the cloud, generated locally instead" notice bar (the one directly above the input box).
 *
 * Why it exists: the Instant Chat toggle says "enabled," yet the message still generated locally -- that gap used to
 * live only in the console and the observation panel, somewhere the user could never check. All they could see was
 * an unreadable network error when the local direct connection failed, so they assumed their own network was broken.
 * In a real production incident, someone got stuck like this for four hours.
 *
 * Only reports two cases, both being "the user wanted the cloud, but it didn't actually go there":
 *   worker-outdated     checked in, and that Worker genuinely can't handle this path -> points them to update it
 *   worker-unreachable  the cloud just wasn't reachable at this moment -> don't tell them to update, it's probably
 *                       just the network and will fix itself
 *
 * Cases the user turned off themselves (disabled / char-disabled), or flows like ordering that are meant to stay
 * local anyway, stay silent across the board -- those are normal behavior, and reporting them would just be noise.
 */
import React, { useEffect, useState } from 'react';
import { AMSG_INSTANT_CHAT_ROUTE_EVENT, type InstantChatRouteDetail } from '../../utils/amsgInstantChat';

const NOTICES: Record<string, { title: string; hint: string }> = {
    'worker-outdated': {
        title: 'This turn generated locally',
        hint: 'Your cloud Worker cannot handle this path -- go update it in Settings',
    },
    'worker-unreachable': {
        title: 'This turn generated locally',
        hint: 'Could not reach the cloud right now -- it will switch back once the network recovers',
    },
};

const InstantChatRouteNotice: React.FC<{ charId: string }> = ({ charId }) => {
    const [reason, setReason] = useState<string | null>(null);

    useEffect(() => {
        // Clear out first when switching conversations: the previous character's conclusion for that turn has nothing to do with this character.
        setReason(null);
        const onRoute = (event: Event) => {
            const detail = (event as CustomEvent<InstantChatRouteDetail>).detail;
            if (!detail || detail.charId !== charId) return;
            // A null reason (this turn successfully went to the cloud) or a reason not on the list both count as "nothing worth mentioning" and get hidden.
            setReason(detail.reason && NOTICES[detail.reason] ? detail.reason : null);
        };
        window.addEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
    }, [charId]);

    const notice = reason ? NOTICES[reason] : null;
    if (!notice) return null;

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-b border-amber-200/70 text-[11px] text-amber-800">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            <span className="font-bold shrink-0">{notice.title}</span>
            <span className="opacity-70 truncate">· {notice.hint}</span>
        </div>
    );
};

export default InstantChatRouteNotice;
