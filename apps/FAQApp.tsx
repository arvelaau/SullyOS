
import React, { useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { Sparkle } from '@phosphor-icons/react';
import {
    FAQ_TARGET_SECTION_KEY,
    CHANGELOG_2026_04,
    CHANGELOG_2026_05,
    CHANGELOG_2026_05_10,
    CHANGELOG_2026_05_17,
    CHANGELOG_2026_05_27,
    CHANGELOG_2026_06_05,
    CHANGELOG_2026_06_14,
    CHANGELOG_2026_06_21,
    CHANGELOG_2026_06_26,
    CHANGELOG_2026_07_10,
    CHANGELOG_2026_08_03,
    CHANGELOG_2026_08_10,
    CHANGELOG_2026_08_30,
} from '../components/UpdateNotificationEvent';
import { trackEvent } from '../utils/analytics';

const FAQ_DATA = [
    {
        q: "1. Can't load pages / white screen / taps don't respond",
        reason: "Your network connection is being a bit temperamental.",
        solution: "You'll need a bit of \"magic\" to connect to the outside internet.\nIf you don't know what a \"ladder/magic\" is, please search for it yourself~ \nThis isn't the software being broken, it's the network being blocked.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa84.png",
        color: "bg-blue-50 text-blue-700"
    },
    {
        q: "2. I sent a message but the character isn't replying?",
        reason: "To help everyone save on quota, characters don't auto-reply instantly — they're waiting for you to poke them.",
        solution: "After sending a message, look for the **lightning bolt button** on the right side of the top title bar.\nTap it to poke them, and they'll think it over and reply!",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a4.png",
        color: "bg-yellow-50 text-yellow-700"
    },
    {
        q: "3. Why can't I fetch the model list?",
        reason: "Often it's because the address (URL) you entered is slightly off.",
        solution: "Please carefully check your link:\n1. Did you forget the `/v1` suffix at the end?\n2. Did you accidentally copy an extra space?\n3. A wrong address just won't open the door.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f50d.png",
        color: "bg-red-50 text-red-700"
    },
    {
        q: "4. A red popup appears (API error)",
        reason: "Case A: if you've recently sent a lot of HD images, or chatted for a long time.\nCase B: getting an error even without sending images? The API provider on the other end may be out of balance or having issues.",
        solution: "**Case A**: go to [Settings] and lower the \"context message count\" a bit (e.g. 20-50).\n**Case B**: please contact the channel you purchased/obtained your API from directly — the simulator itself is innocent.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/26a0.png",
        color: "bg-orange-50 text-orange-700"
    },
    {
        q: "5. Bubble themes / importing characters",
        reason: "Want to personalize? Want to switch characters?",
        solution: "**Change bubble**:\nTap the name at the top → scroll down to find \"Bubble Style\".\n\n**Import character**:\nOnly supports importing .json files exported from this simulator (a dedicated passport), not compatible with tavern image cards or other phone-sim character cards.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3a8.png",
        color: "bg-purple-50 text-purple-700"
    },
    {
        q: "6. A few words about APIs",
        reason: "Free/community APIs unstable? Paid ones erroring out?",
        solution: "Instability is the norm for free/community APIs.\nFor paid ones, please contact the seller for support.\nThe author and community members are also doing this out of passion, but nobody here is a professional.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ac.png",
        color: "bg-slate-50 text-slate-700"
    },
    {
        q: "7. What to do if you hit a weird bug?",
        reason: "You can ask in the group, but a serious bug report needs a \"medical chart\".",
        solution: "Please go to the desktop [Settings] → [Data Backup], export the JSON file and send it to me.\nOnly by reproducing the issue can it be fixed.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f691.png",
        color: "bg-rose-50 text-rose-700"
    },
    {
        q: "8. About asking questions politely",
        reason: "No room for bad vibes.",
        solution: "When you hit a problem, take a breath and just send a screenshot + description of what happened.\nEveryone is welcome to discuss actively, but avoid venting an entire wall of complaints — spreading negativity doesn't solve problems, and it drives away the people who want to help you.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2764.png",
        color: "bg-pink-50 text-pink-700"
    },
    {
        q: "9. How do I change a character's portrait in the Dwelling?",
        reason: "Want to give a character a new look/outfit?",
        solution: "1. Enter the Dwelling, tap the \"Decorate\" button at the top to enter edit mode.\n2. **Directly tap** the character figure in the center of the screen.\n3. Just select and upload an image with a transparent background.\n(Note: this changes the Dwelling-exclusive chibi portrait, not the chat avatar)",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3e0.png",
        color: "bg-indigo-50 text-indigo-700"
    },
    {
        q: "10. Imported stickers don't show up / importing does nothing?",
        reason: "Usually the format is wrong, or the link is invalid.",
        solution: "1. **Check the format strictly**: it must be `name--URL`, with **two hyphens** in the middle!\n   Wrong: `funny http://...`\n   Correct: `funny--http://...`\n2. **Check the link**: it must be a direct image link (ending in .jpg/.png/.gif).\n3. **One per line**: don't write everything on a single line.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f5bc.png",
        color: "bg-cyan-50 text-cyan-700"
    },
    {
        q: "11. Tapping the chat input box does nothing / keyboard won't come up?",
        reason: "Usually it's some styling that came in with a backup causing trouble: Whitebox custom CSS, a bubble theme, or a chat background is covering/disabling the input box. This kind of data travels with the backup, so restarting or re-importing the backup won't help, while a fresh page (no data imported) works fine.",
        solution: "Check in this order:\n1. [Appearance] → [Chat Interface] → **Restore Whitebox Styling** (clears global and all characters' Whitebox CSS in one tap).\n2. Tap the character name at the top → switch \"Bubble Style\" back to default.\n3. Turn off that character's chat background image.\n4. Still not working: try opening the same link in a different browser (e.g. Safari) and import the backup there; if it still happens, send the backup JSON to the author per item 7.",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2328.png",
        color: "bg-teal-50 text-teal-700"
    }
];

interface ChangelogEntry {
    id: string;
    title: string;
    subtitle: string;
    date: string;
    src: string;
    accent: string;
}

const CHANGELOG_ENTRIES: ChangelogEntry[] = [
    {
        id: CHANGELOG_2026_08_30,
        title: 'August 30, 2026 · Collaboration Workspace',
        subtitle: 'Dual-mode character collaboration · Word / PDF and file delivery · Installable styling, character cards, and worldbooks · Dedicated file library and archived memory · Collaboration data included in system backup import/export',
        date: '2026-08-30',
        src: 'changelogs/2026-8-30.html',
        accent: 'from-indigo-100 to-stone-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_08_10,
        title: 'August 10, 2026 · Live2D Companion Upgrade',
        subtitle: 'New VRM / Live2D video calls · New "L2D Companion Desktop" theme for Live2D',
        date: '2026-08-10',
        src: 'changelogs/2026-8-10.html',
        accent: 'from-emerald-100 to-sky-100 border-emerald-200',
    },
    {
        id: CHANGELOG_2026_08_03,
        title: 'August 3, 2026 · Proactive Message 2.0',
        subtitle: 'Characters send messages on their own at the scheduled time, delivered even with the app closed · Three ways to schedule a task (panel / say it in chat / character schedules for themselves) · Fetches live time, weather, holidays, trending topics, and daily routine at fire time · Does not repeat itself back-to-back, skips empty pushes when there is nothing to say · MCP and search still work in the background · "Looking for something to say" tasks yield right of way, alarms and promises still fire · Requires self-deployed Cloudflare Worker + D1',
        date: '2026-08-03',
        src: 'changelogs/2026-8-3.html',
        accent: 'from-violet-100 to-sky-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_07_10,
        title: 'July 10, 2026 · Life Records',
        subtitle: 'Four Life Records modules in Profile + character-logged entries · Server-wide relay poems in Beyond · Character Creator art-style switching + PSD batch import + Figure Studio · Neural Link character grouping · Major Dwelling decoration upgrade + "late night" segment in Homeland · Memory Palace room plates (in testing) · Custom notification sound · Wallpaper/Dwelling images now store as Blobs · A big batch of iOS compatibility fixes and cleanup',
        date: '2026-07-10',
        src: 'changelogs/2026-7-10.html',
        accent: 'from-rose-100 to-violet-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_06_26,
        title: 'June 26, 2026 · Dream Blind Box',
        subtitle: 'Dwelling dream system (refreshes on entry · collect all 13 dream blind boxes) · Check Phone contact mode + agent (a phone belonging to the character) · Date status bar and settings moved up · Finer-grained schedule peeking · Time awareness moved back to Neural Link · New Fish Audio API for TTS',
        date: '2026-06-26',
        src: 'changelogs/2026-6-26.html',
        accent: 'from-indigo-100 to-violet-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_06_21,
        title: 'June 21, 2026 · Check Phone Overhaul',
        subtitle: 'Check Phone UI overhaul + new "Persona Sim" (script a Screenlife performance, with an option in settings for whether to send it to the character) · New mobile-game-style theme in Appearance · Xiaohongshu Lite can now share posts directly with the character',
        date: '2026-06-21',
        src: 'changelogs/2026-6-21.html',
        accent: 'from-violet-100 to-fuchsia-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_14,
        title: 'June 14, 2026 · Homeland Launch',
        subtitle: 'Dwelling overhaul · "Homeland" multi-character shared world (choice of real time / simulated time) · Luckin Coffee ordering',
        date: '2026-06-14',
        src: 'changelogs/2026-6-14.html',
        accent: 'from-violet-100 to-purple-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_05,
        title: 'June 5, 2026 · Beyond Launch',
        subtitle: 'A small VR world characters log into on their own · Post Office drift letters · Guestbook quotes posted to the wall · Hidden figures',
        date: '2026-06-05',
        src: 'changelogs/2026-6-5.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_05_27,
        title: 'May 27, 2026 · Minor Update',
        subtitle: 'Mood buffs now also connect to Instant Push · Send and go, no need to keep the app open for either chat or moods (setup video included)',
        date: '2026-05-27',
        src: 'changelogs/2026-5-27.html',
        accent: 'from-rose-100 to-amber-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_05_17,
        title: 'May 17, 2026 · Minor Update',
        subtitle: 'Instant Push launched · Send your text and lock the screen, the AI reply comes back on its own',
        date: '2026-05-17',
        src: 'changelogs/2026-5-17.html',
        accent: 'from-teal-100 to-sky-100 border-teal-200',
    },
    {
        id: CHANGELOG_2026_05_10,
        title: 'May 10, 2026 · Minor Update',
        subtitle: '"Mindscape" launched · Model thinking-chain visualization + Date mode bug fixes',
        date: '2026-05-10',
        src: 'changelogs/2026-5-10.html',
        accent: 'from-purple-100 to-indigo-100 border-purple-200',
    },
    {
        id: CHANGELOG_2026_05,
        title: 'May 2026 Update',
        subtitle: "GitHub backup · Music app network optimization · McDonald's MCP · SULLY default skin, and more",
        date: '2026-05',
        src: 'changelogs/2026-5.html',
        accent: 'from-amber-100 to-orange-100 border-amber-200',
    },
    {
        id: CHANGELOG_2026_04,
        title: 'April 2026 Update',
        subtitle: 'Vector memory · Release notes and setup guide',
        date: '2026-04',
        src: 'changelogs/2026-4.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
];

type Tab = 'faq' | 'changelog';

const FAQApp: React.FC = () => {
    const { closeApp } = useOS();
    const [tab, setTab] = useState<Tab>('faq');
    const [activeChangelog, setActiveChangelog] = useState<ChangelogEntry | null>(null);

    useEffect(() => {
        try {
            const target = sessionStorage.getItem(FAQ_TARGET_SECTION_KEY);
            if (target) {
                sessionStorage.removeItem(FAQ_TARGET_SECTION_KEY);
                const entry = CHANGELOG_ENTRIES.find(e => e.id === target);
                if (entry) {
                    setTab('changelog');
                    setActiveChangelog(entry);
                }
            }
        } catch { /* ignore */ }
    }, []);

    const handleBack = () => {
        if (activeChangelog) {
            setActiveChangelog(null);
            return;
        }
        closeApp();
    };

    const headerTitle = activeChangelog
        ? activeChangelog.title
        : tab === 'changelog' ? 'Changelog' : 'FAQ';

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-white/40 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3">
                    <div className="flex items-center gap-2 w-full">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-medium text-slate-700 tracking-wide">{headerTitle}</h1>
                    </div>
                </div>
            </div>

            {/* Tab switcher (hidden when viewing a specific changelog) */}
            {!activeChangelog && (
                <div className="shrink-0 bg-white/60 backdrop-blur-md border-b border-slate-200/60 px-4 py-2">
                    <div className="inline-flex bg-slate-100 rounded-full p-1 gap-1">
                        <button
                            onClick={() => { setTab('faq'); trackEvent('Switch FAQ Tab', { tab: 'faq' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'faq'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            FAQ
                        </button>
                        <button
                            onClick={() => { setTab('changelog'); trackEvent('Switch FAQ Tab', { tab: 'changelog' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'changelog'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            Changelog
                        </button>
                    </div>
                </div>
            )}

            {/* Content area */}
            {activeChangelog ? (
                <div className="flex-1 bg-[#faf7f2] overflow-hidden">
                    <iframe
                        key={activeChangelog.id}
                        src={activeChangelog.src}
                        title={activeChangelog.title}
                        className="w-full h-full border-0"
                    />
                </div>
            ) : tab === 'faq' ? (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    {/* Intro Banner */}
                    <div className="bg-gradient-to-r from-pink-100 to-indigo-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" /> Must-Read Tips for Newcomers <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" />
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            Welcome! To make your interactions with characters go more smoothly, please check below for an answer first if you run into a problem~
                            <br/>
                            (If you ask without reading the announcements first, people may not know how to help you, and it also wears down the community's patience)
                        </p>
                    </div>

                    {/* FAQ Cards */}
                    <div className="space-y-4">
                        {FAQ_DATA.map((item, index) => (
                            <div key={index} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 animate-slide-up" style={{ animationDelay: `${index * 50}ms` }}>
                                <div className="flex items-start gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${item.color.split(' ')[0]}`}>
                                        <img src={item.icon} className="w-5 h-5 inline" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className={`text-sm font-bold mb-2 ${item.color.split(' ')[1]}`}>{item.q}</h3>

                                        <div className="space-y-2">
                                            <div className="flex gap-2 items-start">
                                                <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">Reason:</span>
                                                <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{item.reason}</p>
                                            </div>
                                            <div className="flex gap-2 items-start bg-slate-50 p-2 rounded-lg">
                                                <span className="text-xs font-bold text-green-500 shrink-0 mt-0.5 flex items-center gap-0.5"><Sparkle size={12} weight="fill" /> Solution:</span>
                                                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-medium">{item.solution}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        SullyOS Help Center • v1.1
                    </div>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    <div className="bg-gradient-to-r from-indigo-100 to-purple-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png" className="w-5 h-5 inline" alt="" /> Version Update History
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            This is where detailed notes for every major update live. Tap a card to view the full content.
                        </p>
                    </div>

                    <div className="space-y-3">
                        {CHANGELOG_ENTRIES.map((entry) => (
                            <button
                                key={entry.id}
                                onClick={() => setActiveChangelog(entry)}
                                className={`w-full text-left bg-gradient-to-br ${entry.accent} border rounded-2xl p-4 shadow-sm active:scale-[0.98] transition-transform`}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="w-12 h-12 rounded-2xl bg-white/70 flex items-center justify-center shrink-0 shadow-sm">
                                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d6.png" className="w-6 h-6" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <h3 className="text-sm font-bold text-slate-800">{entry.title}</h3>
                                            <span className="text-[10px] text-slate-500 font-mono shrink-0">{entry.date}</span>
                                        </div>
                                        <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{entry.subtitle}</p>
                                        <div className="mt-2 text-[11px] font-bold text-indigo-600 flex items-center gap-1">
                                            View full release notes
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                                        </div>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        SullyOS Changelog • More versions will be archived here over time
                    </div>
                </div>
            )}
        </div>
    );
};

export default FAQApp;
