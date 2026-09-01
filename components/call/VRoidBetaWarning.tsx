import React, { useEffect, useRef } from 'react';
import { Flask, WarningCircle } from '@phosphor-icons/react';

interface VRoidBetaWarningProps {
  fileName: string;
  projectFile?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onContinue?: () => void;
}

const VRoidBetaWarning: React.FC<VRoidBetaWarningProps> = ({
  fileName,
  projectFile = false,
  busy = false,
  onCancel,
  onContinue,
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[260] flex items-end justify-center bg-[#05030b]/76 px-4 pb-[max(1rem,var(--safe-bottom))] pt-[max(1rem,var(--safe-top))] backdrop-blur-sm sm:items-center">
      <button
        type="button"
        aria-label="Close VRoid beta notice"
        className="absolute inset-0 cursor-default"
        disabled={busy}
        onClick={onCancel}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vroid-beta-title"
        tabIndex={-1}
        className="relative w-full max-w-sm overflow-hidden rounded-[28px] border border-violet-200/20 bg-[#100c1b] text-white shadow-[0_28px_90px_rgba(0,0,0,.58)] outline-none"
      >
        <div className="h-1 bg-gradient-to-r from-violet-400 via-fuchsia-300 to-amber-200" />
        <div className="px-5 pb-5 pt-5">
          <div className="flex items-start gap-3.5">
            <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-violet-200/20 bg-violet-300/10 text-violet-200">
              {projectFile ? <WarningCircle size={23} weight="fill" /> : <Flask size={22} weight="fill" />}
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-[10px] font-semibold tracking-[0.24em] text-violet-200/65">VRoid / VRM · TEST BUILD</span>
              <h2 id="vroid-beta-title" className="mt-1.5 text-[19px] font-semibold leading-tight text-white">
                {projectFile ? 'This is a VRoid project file' : 'Import feature is still in testing'}
              </h2>
              <p className="mt-2 break-all text-[11px] leading-relaxed text-white/42">{fileName}</p>
            </div>
          </div>

          <div className="mt-5 border-y border-white/10 py-4 text-[13px] leading-6 text-white/70">
            {projectFile ? (
              <>
                SullyOS can't directly read a <strong className="font-semibold text-white">.vroid project</strong> yet. Please export a VRM from VRoid Studio first, then come back and select the exported file.
              </>
            ) : (
              <>
                VRoid / VRM isn't the focus of this release — it's currently available only as a test feature, and <strong className="font-semibold text-amber-100">may have various bugs</strong>.
              </>
            )}
          </div>

          {!projectFile && (
            <p className="mt-3 text-[11px] leading-5 text-white/42">
              Different models vary a lot in bones, expressions, materials, and mobile VRAM usage; a failed import won't overwrite the character's currently bound model.
            </p>
          )}

          <div className={`mt-5 grid gap-2.5 ${projectFile ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="min-h-11 rounded-2xl border border-white/12 bg-white/[0.035] px-4 text-[13px] font-medium text-white/64 transition active:scale-[0.98] disabled:opacity-45"
            >
              {projectFile ? 'Got it' : 'Not now'}
            </button>
            {!projectFile && onContinue && (
              <button
                type="button"
                disabled={busy}
                onClick={onContinue}
                className="min-h-11 rounded-2xl border border-violet-200/25 bg-violet-400/18 px-4 text-[13px] font-semibold text-violet-50 transition active:scale-[0.98] disabled:opacity-55"
              >
                {busy ? 'Importing…' : 'Test anyway'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VRoidBetaWarning;
