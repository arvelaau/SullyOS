import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, CopySimple } from '@phosphor-icons/react';

/**
 * HTML card renderer (shared by private-chat MessageItem and group-chat GroupMessageItem).
 * Sandboxed iframe: scripts / form submission / popups are disabled, so arbitrary HTML can't
 * reach beyond its privileges into the parent page.
 * srcDoc uses a full-width, centered wrapper so the 270px card sits centered inside the iframe
 * with a transparent background.
 * body>* forcibly strips box-shadow/filter off the outermost element: the model often adds a soft
 * shadow to the card's outer edge, but since the iframe is only slightly wider than the card and
 * has overflow-hidden on the outside, the shadow gets clipped into a ring that reads as a "faint
 * fake border" stuck around the card -- the convention in chat is that cards sit flush against the
 * chat background with no background/border of their own, so this is a rendering-side backstop
 * (also applies to old cards already saved to the DB); the prompt side has been updated in lockstep
 * to stop teaching the model to add an outer shadow.
 */
const HtmlCard: React.FC<{ html: string }> = ({ html }) => {
    const [sourceExpanded, setSourceExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;}body{display:flex;justify-content:center;padding:0;}*{box-sizing:border-box;}img{max-width:100%;}body>*{box-shadow:none!important;filter:none!important;}</style></head><body>${html}</body></html>`;

    useEffect(() => () => {
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    }, []);

    const copyHtmlSource = async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        let copied = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            // Copy the exact source stored on the message, not the renderer's
            // srcDoc wrapper, so users can archive or edit the original card.
            await navigator.clipboard.writeText(html);
            copied = true;
        } catch {
            // iOS PWA / non-secure contexts can reject Clipboard API. Keep a
            // user-gesture fallback without touching interactions in the iframe.
            let textarea: HTMLTextAreaElement | null = null;
            try {
                textarea = document.createElement('textarea');
                textarea.value = html;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                copied = document.execCommand('copy');
            } catch {
                copied = false;
            } finally {
                textarea?.remove();
            }
        }

        setCopyState(copied ? 'ok' : 'error');
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
    };

    return (
        <div className="w-[280px] max-w-full rounded-[18px] overflow-hidden bg-transparent">
            <iframe
                title="html-card"
                srcDoc={srcDoc}
                // allow-same-origin: lets the parent page read contentDocument to auto-adjust height
                // Deliberately not granting allow-scripts / allow-forms / allow-popups --
                // any <script> in the AI's output won't execute, and forms / popups / top-level navigation are all blocked too.
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                className="block w-full min-h-[120px] border-0 bg-transparent"
                style={{ height: 200 }}
                onLoad={(e) => {
                    try {
                        const f = e.currentTarget as HTMLIFrameElement & { __htmlCardRO?: ResizeObserver };
                        const doc = f.contentDocument;
                        if (!doc || !doc.body) return;
                        // Measures the content's real height and matches the iframe's height to it, avoiding inner scrolling.
                        // The cap is relaxed to 2400 -- enough for long cards to fully expand; only truly oversized ones fall back to scrolling.
                        const fit = () => {
                            try {
                                const root = doc.documentElement;
                                const body = doc.body;
                                const natural = Math.max(
                                    body.scrollHeight, body.offsetHeight,
                                    root ? root.scrollHeight : 0,
                                );
                                const h = Math.min(2400, Math.max(60, natural + 4));
                                f.style.height = h + 'px';
                            } catch { /* fail silently when same-origin read is unavailable */ }
                        };
                        fit();
                        // Interactive cards (:checked expand/collapse), animations, and late-loading fonts can all change the height,
                        // so a ResizeObserver keeps tracking it continuously, keeping the height always adaptive instead of measured once.
                        f.__htmlCardRO?.disconnect();
                        if (typeof ResizeObserver !== 'undefined') {
                            const ro = new ResizeObserver(() => fit());
                            ro.observe(doc.body);
                            if (doc.documentElement) ro.observe(doc.documentElement);
                            f.__htmlCardRO = ro;
                        }
                    } catch { /* fail silently when same-origin read is unavailable here too */ }
                }}
            />
            {/* The source action deliberately lives outside the iframe. Card
                labels, checkboxes, text selection and other embedded gestures
                therefore keep their native long-press behavior. */}
            <div
                className="sully-html-source-bar flex h-8 select-none items-center justify-between overflow-hidden border-t border-slate-300/20 bg-white/25 px-2 text-[10px] text-slate-400 transition-all duration-200 ease-out"
                style={sourceExpanded ? undefined : {
                    height: 20,
                    justifyContent: 'center',
                    borderTopColor: 'transparent',
                    backgroundColor: 'transparent',
                    paddingLeft: 0,
                    paddingRight: 0,
                }}
                onPointerDown={event => event.stopPropagation()}
                onPointerUp={event => event.stopPropagation()}
                onContextMenu={event => event.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSourceExpanded(expanded => !expanded);
                    }}
                    aria-expanded={sourceExpanded}
                    aria-label={sourceExpanded ? 'Collapse HTML source actions' : 'Expand HTML source actions'}
                    title={sourceExpanded ? 'Collapse source actions' : 'Expand source actions'}
                    className="sully-html-source-toggle inline-flex h-5 items-center gap-1 rounded-full font-medium text-slate-400/80 transition-all duration-200 hover:bg-slate-500/[0.04] hover:text-slate-400 focus:outline-none focus-visible:bg-slate-500/10 focus-visible:text-slate-500"
                    style={sourceExpanded ? undefined : {
                        gap: 2,
                        paddingLeft: 8,
                        paddingRight: 8,
                        color: 'rgba(148, 163, 184, 0.35)',
                    }}
                >
                    <span
                        className="rounded border border-slate-300/50 px-1 py-px font-mono text-[7px] tracking-[0.14em] text-slate-400/80 transition-all duration-200"
                        style={sourceExpanded ? undefined : { borderWidth: 0, paddingLeft: 0, paddingRight: 0, color: 'inherit' }}
                    >HTML</span>
                    <span
                        className="ml-0.5 max-w-16 overflow-hidden whitespace-nowrap tracking-[0.08em] opacity-100 transition-all duration-200"
                        style={sourceExpanded ? undefined : { marginLeft: 0, maxWidth: 0, opacity: 0 }}
                    >Full Source</span>
                    <CaretDown
                        size={8}
                        weight="bold"
                        className="shrink-0 transition-transform duration-200"
                        style={{ transform: sourceExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                </button>
                <button
                    type="button"
                    onClick={copyHtmlSource}
                    aria-label="Copy full HTML source"
                    title="Copy full HTML source"
                    aria-hidden={!sourceExpanded}
                    tabIndex={sourceExpanded ? 0 : -1}
                    className={`sully-html-copy-button inline-flex h-6 max-w-24 items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-2 font-medium opacity-100 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/70 focus-visible:ring-offset-1 active:scale-95 ${
                        copyState === 'ok'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : copyState === 'error'
                                ? 'bg-rose-500/10 text-rose-500'
                                : 'bg-slate-500/[0.06] text-slate-500/80 hover:bg-slate-500/10 hover:text-slate-600'
                    }`}
                    style={sourceExpanded ? undefined : {
                        maxWidth: 0,
                        paddingLeft: 0,
                        paddingRight: 0,
                        opacity: 0,
                        pointerEvents: 'none',
                    }}
                >
                    {copyState === 'ok' ? <Check size={11} weight="bold" /> : <CopySimple size={11} />}
                    {copyState === 'ok' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy source'}
                </button>
            </div>
        </div>
    );
};

export default HtmlCard;
