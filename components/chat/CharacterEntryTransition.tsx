import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBlobRefUrl } from '../../utils/blobRef';

// Character-switch "entrance" transition — not a page/tab change, but "leaving one person, stepping into another's space."
// Design: the avatar of "the person you're about to see" fills the background, blurred (their world of color), with the
// center avatar surfacing through a soft glow + the name rising up -> push through into the chat.
//
// Performance notes (fixing "stutters when there's a lot of data + entering chat before the avatar is even visible"):
//   - Only animate transform / opacity for the whole sequence -- both run on the compositor thread, so no dropped frames
//     even when the main thread is busy (entering chat mounts a lot of image-bearing messages). Never animate filter:blur
//     (repaints every frame, the real culprit behind the old stutter). The blur on the background image is static, rasterized once.
//   - Timeline: the avatar "snaps into focus" quickly first (scale + fade-in, not blur), then holds for a beat once
//     sharp so the face and name are actually visible, then exits.
// Tap to skip; respects prefers-reduced-motion; inline @keyframes (CDN Tailwind can't reliably generate custom animate-* classes).

interface Props {
  name: string;
  avatar?: string;
  /** Callback fired once the transition finishes playing (or is skipped); the parent component unmounts this layer. */
  onDone: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const CharacterEntryTransition: React.FC<Props> = ({ name, avatar, onDone }) => {
  const reduced = useMemo(prefersReducedMotion, []);
  // Avatar comes into focus around 650ms, name settles around 780ms -> hold until REVEAL_AT so it's visible, then exit.
  const REVEAL_AT = reduced ? 220 : 1000; // when the exit begins (end of the hold, once sharp)
  const EXIT = reduced ? 200 : 440;       // duration of the exit (push-through + fade-out)
  const TOTAL = REVEAL_AT + EXIT;

  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const finish = () => { if (!doneRef.current) { doneRef.current = true; onDone(); } };

  useEffect(() => {
    const tExit = setTimeout(() => setExiting(true), REVEAL_AT);
    const tDone = setTimeout(finish, TOTAL);
    return () => { clearTimeout(tExit); clearTimeout(tDone); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap to skip: immediately enters the exit phase (still a smooth push-through, not a hard cut).
  const skip = () => { if (!exiting) { setExiting(true); window.setTimeout(finish, EXIT); } };

  // The avatar field may be a blobref token; splicing the raw token into url() produces an address that
  // never loads. Resolve it to a usable address first, and check emptiness against the resolved value too --
  // otherwise the "fall back to a theme-color light field when there's no avatar" branch would never fire, and
  // the whole transition layer would become a transparent film with the chat underneath showing straight through.
  // Before the token finishes resolving, resolvedAvatar is undefined, so that frame takes the light-field branch
  // anyway, still fully covering the chat.
  const resolvedAvatar = useBlobRefUrl(avatar);
  const avatarBg = resolvedAvatar ? `url(${resolvedAvatar})` : '';

  return (
    <div
      onClick={skip}
      aria-hidden
      className="absolute inset-0 z-[140] overflow-hidden flex items-center justify-center cursor-pointer"
      style={{ opacity: exiting ? 0 : 1, transition: `opacity ${EXIT}ms ease-in`, willChange: 'opacity' }}
    >
      <style>{`
        @keyframes charVeilIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes charAvatarIn { 0% { opacity:0; transform: translateY(12px) scale(.84) } 100% { opacity:1; transform: translateY(0) scale(1) } }
        @keyframes charGlowIn { 0% { opacity:0; transform: translate(-50%,-50%) scale(.6) } 45% { opacity:.85 } 100% { opacity:.6; transform: translate(-50%,-50%) scale(1) } }
        @keyframes charNameIn { from { opacity:0; transform: translateY(12px) } to { opacity:1; transform: translateY(0) } }
        @keyframes charLineIn { from { opacity:0; transform: scaleX(0) } to { opacity:.7; transform: scaleX(1) } }
      `}</style>

      {/* Ambient background: blurred avatar = their world of color (static blur, rasterized once).
          Key point: no fade-in here -- the moment showEntry becomes true it "instantly" covers the chat, otherwise
          the transparent gap would let the chat underneath flash through first, which is backwards (chat flashes,
          then the transition fades in). Falls back to a theme-color light field when there's no avatar. */}
      {avatarBg ? (
        <div className="absolute inset-0 bg-cover bg-center" style={{
          background: avatarBg, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(26px)', transform: 'scale(1.16)',
        }} />
      ) : (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(120% 100% at 50% 40%, hsla(var(--primary-hue),55%,40%,0.9), #0c0b1e 70%)',
        }} />
      )}
      {/* Darken + vignette: makes the center avatar and name stand out clearly (static) */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(115% 95% at 50% 42%, rgba(8,8,18,0.35) 30%, rgba(6,6,16,0.78) 100%)' }} />

      {/* Center content: on exit, only this layer (no filter, scaling is cheap) does the push-through; the blurred background just fades out with the root layer. */}
      <div
        className="relative flex flex-col items-center px-8"
        style={{
          transform: exiting ? 'scale(1.14)' : 'scale(1)',
          transition: `transform ${EXIT}ms cubic-bezier(0.4,0,0.2,1)`,
          willChange: 'transform',
        }}
      >
        <div className="relative" style={{ width: 132, height: 132 }}>
          {/* Soft glow halo (blooms behind the avatar) */}
          <div className="absolute" style={{
            left: '50%', top: '50%', width: 230, height: 230, transform: 'translate(-50%,-50%)',
            borderRadius: '9999px', filter: 'blur(8px)',
            background: 'radial-gradient(circle, rgba(255,255,255,0.5) 0%, hsla(var(--primary-hue),80%,80%,0.32) 40%, transparent 66%)',
            animation: reduced ? 'charVeilIn 240ms ease-out both' : 'charGlowIn 680ms cubic-bezier(0.22,1,0.36,1) 40ms both',
          }} />
          {/* Avatar: scale + fade-in to "focus," no filter:blur (avoids per-frame repaint stutter) */}
          <div
            className="absolute inset-0 rounded-full bg-cover bg-center"
            style={{
              backgroundImage: avatarBg || undefined,
              backgroundColor: avatarBg ? undefined : 'hsla(var(--primary-hue),50%,55%,0.6)',
              boxShadow: '0 8px 40px rgba(0,0,0,0.45), 0 0 0 1.5px rgba(255,255,255,0.5), 0 0 28px hsla(var(--primary-hue),80%,80%,0.45)',
              animation: reduced ? 'charVeilIn 280ms ease-out both' : 'charAvatarIn 560ms cubic-bezier(0.22,1,0.36,1) 90ms both',
              willChange: 'transform, opacity',
            }}
          />
        </div>
        <div
          className="mt-5 text-white text-2xl font-medium tracking-wide"
          style={{
            textShadow: '0 2px 18px rgba(0,0,0,0.5), 0 0 24px hsla(var(--primary-hue),80%,80%,0.3)',
            animation: reduced ? 'charNameIn 300ms ease-out both' : 'charNameIn 480ms cubic-bezier(0.22,1,0.36,1) 320ms both',
          }}
        >
          {name}
        </div>
        <div className="mt-3 h-px w-20" style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)',
          transformOrigin: 'center',
          animation: reduced ? 'charVeilIn 300ms ease-out both' : 'charLineIn 540ms ease-out 420ms both',
        }} />
      </div>
    </div>
  );
};

export default CharacterEntryTransition;
