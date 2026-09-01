import React, { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Check, Cube, FileZip, FolderOpen, Gear, ImageSquare, X } from '@phosphor-icons/react';
import type { UserCameraMode } from './UserCameraModePicker';
import type { CompanionAvatarSource } from '../../utils/companionAvatar';

export type CallSetupGuideStep = 'model' | 'camera';

interface CallSetupGuideProps {
  step: CallSetupGuideStep;
  characterName: string;
  modelName?: string;
  modelFormat?: 'live2d' | 'vrm';
  avatarSource: CompanionAvatarSource;
  staticImageName?: string;
  hasDatePortraits: boolean;
  dateOutfitName?: string;
  cameraMode: UserCameraMode;
  hasFakeImage: boolean;
  accentColor: string;
  lightTheme?: boolean;
  onStepChange: (step: CallSetupGuideStep) => void;
  onChooseModelFile: () => void;
  onChooseLive2DFolder: () => void;
  onChooseAvatarSource: (source: CompanionAvatarSource) => void;
  onChooseStaticImage: () => void;
  onManageDatePortraits: () => void;
  onConfigureLive2D?: () => void;
  onCameraModeChange: (mode: UserCameraMode) => void;
  onChooseFakeImage: () => void;
  onStart: () => void;
  onClose: () => void;
}

const CAMERA_OPTIONS: Array<{
  id: UserCameraMode;
  index: string;
  title: string;
  detail: string;
  data: string;
}> = [
  { id: 'off', index: '0', title: 'Off', detail: 'Default, most private option', data: 'Not captured · Not injected' },
  { id: 'fake', index: '1', title: 'Static shot', detail: 'Use a photo, just for the call view and screenshots', data: 'Photo not sent' },
  { id: 'emotion', index: '2', title: 'Local emotion', detail: 'Recognizes expressions locally, lightly nudges replies with text', data: 'Only emotion text injected' },
  { id: 'snapshot', index: '3', title: 'Snapshot per turn', detail: 'Captures a frame when you send; local history keeps only the last 3 turns', data: 'Old images show [Image]' },
];

const CallSetupGuide: React.FC<CallSetupGuideProps> = ({
  step,
  characterName,
  modelName,
  modelFormat,
  avatarSource,
  staticImageName,
  hasDatePortraits,
  dateOutfitName,
  cameraMode,
  hasFakeImage,
  accentColor,
  lightTheme = false,
  onStepChange,
  onChooseModelFile,
  onChooseLive2DFolder,
  onChooseAvatarSource,
  onChooseStaticImage,
  onManageDatePortraits,
  onConfigureLive2D,
  onCameraModeChange,
  onChooseFakeImage,
  onStart,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const ink = lightTheme ? '#292638' : '#f8f6ff';
  const muted = lightTheme ? 'rgba(41,38,56,.5)' : 'rgba(248,246,255,.48)';
  const line = lightTheme ? 'rgba(62,55,82,.13)' : 'rgba(255,255,255,.11)';
  const panel = lightTheme ? '#f7f4fb' : '#100b19';

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const fakeImageMissing = cameraMode === 'fake' && !hasFakeImage;
  const visualAvailable = avatarSource === 'model' ? Boolean(modelName) : avatarSource === 'upload' ? Boolean(staticImageName) : hasDatePortraits;
  const visualName = avatarSource === 'upload'
    ? staticImageName || 'No static image imported yet'
    : avatarSource === 'date'
      ? dateOutfitName || 'No Date portrait set up yet'
      : modelName || 'No animated model linked yet';
  const visualDetail = avatarSource === 'upload'
    ? 'PNG / GIF · single image stays as-is'
    : avatarSource === 'date'
      ? 'Date portrait · switches expressions from the same set based on call emotion'
      : modelFormat === 'live2d'
        ? 'Live2D · framing, actions and wardrobe can be calibrated'
        : modelFormat === 'vrm' ? 'VRM · experimental support' : 'Supports Live2D ZIP / folder and VRM';

  return (
    <div className="absolute inset-0 z-[80] flex items-end bg-[#08050f]/72 backdrop-blur-sm" data-testid="call-setup-guide">
      <button type="button" aria-label="Close call setup guide" className="absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-setup-guide-title"
        tabIndex={-1}
        className="relative max-h-[88%] w-full overflow-hidden rounded-t-[2.25rem] border-t outline-none"
        style={{ color: ink, background: panel, borderColor: line, paddingBottom: 'max(1rem, var(--safe-bottom))' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-current opacity-15" />

        <header className="px-5 pb-4 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[9px] font-semibold tracking-[0.28em]" style={{ color: muted }}>VIDEO LINK / PREPARATION</div>
              <h2 id="call-setup-guide-title" className="mt-1.5 text-[23px] font-semibold leading-none">
                {step === 'model' ? 'Choose their video look.' : 'How do you want to appear on camera?'}
              </h2>
              <p className="mt-2 text-[11px] leading-5" style={{ color: muted }}>
                {step === 'model'
                  ? `Switch between animated model, static image, and Date portrait here — the desktop and video call share the same choice.`
                  : 'This choice only applies to this call; it starts off again next time.'}
              </p>
            </div>
            <button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border active:scale-90" style={{ borderColor: line }} aria-label="Close">
              <X size={15} weight="bold" />
            </button>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[9px] font-medium tracking-[0.12em]" style={{ color: muted }}>
            <button type="button" onClick={() => onStepChange('model')} className="flex items-center gap-2 text-left" style={{ color: step === 'model' ? accentColor : undefined }}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full border" style={{ borderColor: step === 'model' ? accentColor : line }}>01</span> Their look
            </button>
            <span className="h-px w-10" style={{ background: line }} />
            <button type="button" onClick={() => onStepChange('camera')} className="flex items-center justify-end gap-2 text-right" style={{ color: step === 'camera' ? accentColor : undefined }}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full border" style={{ borderColor: step === 'camera' ? accentColor : line }}>02</span> My camera
            </button>
          </div>
        </header>

        <div className="max-h-[56vh] overflow-y-auto border-y no-scrollbar" style={{ borderColor: line }}>
          {step === 'model' ? (
            <>
              <section className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: `${accentColor}66`, color: accentColor, background: `${accentColor}12` }}>
                    <Cube size={20} weight="fill" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] font-semibold tracking-[0.2em]" style={{ color: muted }}>CURRENT CAST</div>
                    <div className="mt-1 truncate text-[14px] font-medium">{visualName}</div>
                    <div className="mt-0.5 text-[10px]" style={{ color: muted }}>{visualDetail}</div>
                  </div>
                  {visualAvailable && <Check size={17} weight="bold" style={{ color: accentColor }} />}
                </div>
              </section>

              <section className="border-t" style={{ borderColor: line }}>
                <div className="grid grid-cols-3 gap-1.5 border-b p-2" style={{ borderColor: line }}>
                  {([
                    ['model', 'Animated model'],
                    ['upload', 'Static image'],
                    ['date', 'Date portrait'],
                  ] as const).map(([source, label]) => {
                    const active = avatarSource === source;
                    return (
                      <button
                        key={source}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChooseAvatarSource(source)}
                        className="rounded-xl border px-2 py-2 text-[10px] font-medium transition active:scale-[.98]"
                        style={{ borderColor: active ? `${accentColor}88` : line, color: active ? accentColor : muted, background: active ? `${accentColor}12` : undefined }}
                      >
                        {active && <Check size={10} weight="bold" className="mr-1 inline" />}{label}
                      </button>
                    );
                  })}
                </div>

                {avatarSource === 'model' ? (
                  <>
                    <button type="button" onClick={onChooseModelFile} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left active:bg-current/[.035]" style={{ borderColor: line }}>
                      <FileZip size={18} style={{ color: accentColor }} />
                      <span><span className="block text-[13px] font-medium">Model file</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>Live2D ZIP or VRM; .vroid prompts you to export first</span></span>
                      <ArrowRight size={14} style={{ color: muted }} />
                    </button>
                    <button type="button" onClick={onChooseLive2DFolder} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left active:bg-current/[.035]" style={{ borderColor: line }}>
                      <FolderOpen size={18} style={{ color: accentColor }} />
                      <span><span className="block text-[13px] font-medium">Full Live2D folder</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>Select the whole directory containing model3.json</span></span>
                      <ArrowRight size={14} style={{ color: muted }} />
                    </button>
                    {modelFormat === 'live2d' && onConfigureLive2D && (
                      <button type="button" onClick={onConfigureLive2D} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-3.5 text-left active:bg-current/[.035]">
                        <Gear size={18} style={{ color: accentColor }} />
                        <span><span className="block text-[13px] font-medium">Calibrate framing, actions and the real wardrobe</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>Preview stays live; actions and parameters are adjusted in the floating settings window</span></span>
                        <ArrowRight size={14} style={{ color: muted }} />
                      </button>
                    )}
                  </>
                ) : avatarSource === 'upload' ? (
                  <button type="button" onClick={onChooseStaticImage} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-4 text-left active:bg-current/[.035]">
                    <ImageSquare size={18} style={{ color: accentColor }} />
                    <span><span className="block text-[13px] font-medium">{staticImageName ? 'Replace PNG / GIF' : 'Import PNG / GIF'}</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>This same image is used for both the companion desktop and video calls</span></span>
                    <ArrowRight size={14} style={{ color: muted }} />
                  </button>
                ) : (
                  <button type="button" onClick={onManageDatePortraits} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-4 text-left active:bg-current/[.035]">
                    <ImageSquare size={18} style={{ color: accentColor }} />
                    <span><span className="block text-[13px] font-medium">{hasDatePortraits ? 'Manage Date portrait expressions' : 'Add Date portrait'}</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>Reuses Date mode's outfit and expressions; AI only switches expressions within that same set based on call emotion</span></span>
                    <ArrowRight size={14} style={{ color: muted }} />
                  </button>
                )}
              </section>

              <p className="border-t px-5 py-3 text-[10px] leading-5" style={{ borderColor: line, color: muted }}>
                {avatarSource === 'model'
                  ? 'After importing Live2D, you will automatically move into action and wardrobe setup. Wardrobe actions are forced to manual only; VRM is still an experimental feature.'
                  : avatarSource === 'date'
                    ? 'Date portraits use the static-expression pipeline and do not call Live2D actions; you still choose the outfit manually.'
                    : 'A single PNG / GIF does not switch expressions; choose a Date portrait if you need emotional expressions.'}
              </p>
            </>
          ) : (
            <section>
              {CAMERA_OPTIONS.map(option => {
                const active = cameraMode === option.id;
                const needsImage = option.id === 'fake' && !hasFakeImage;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      onCameraModeChange(option.id);
                      if (needsImage) onChooseFakeImage();
                    }}
                    className="grid w-full grid-cols-[2.7rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left transition last:border-b-0 active:bg-current/[.035]"
                    style={{ borderColor: line, background: active ? `${accentColor}0e` : undefined }}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full border text-[12px] font-semibold" style={{ borderColor: active ? accentColor : line, color: active ? accentColor : muted }}>{option.index}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{option.title}</span>
                      <span className="mt-0.5 block text-[10px] leading-4" style={{ color: muted }}>{option.detail}</span>
                    </span>
                    <span className="text-right text-[9px] font-medium tracking-[.08em]" style={{ color: active ? accentColor : muted }}>{needsImage ? 'Choose image' : option.data}</span>
                  </button>
                );
              })}
              <p className="border-t px-5 py-3 text-[10px] leading-5" style={{ borderColor: line, color: muted }}>
                Local emotion only injects the "recognized emotion" text and never uploads camera footage; snapshot-per-turn captures one frame when you tap send, keeping only the last 3 turns in local history. Static shot is never sent with messages.
              </p>
            </section>
          )}
        </div>

        <footer className="grid grid-cols-[auto_1fr] gap-2.5 px-5 pt-4">
          {step === 'camera' ? (
            <button type="button" onClick={() => onStepChange('model')} className="flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border px-4 text-[12px] font-medium active:scale-[.98]" style={{ borderColor: line, color: muted }}>
              <ArrowLeft size={14} /> Model
            </button>
          ) : (
            <button type="button" onClick={onClose} className="min-h-12 rounded-2xl border px-4 text-[12px] font-medium active:scale-[.98]" style={{ borderColor: line, color: muted }}>Later</button>
          )}
          <button
            type="button"
            disabled={fakeImageMissing}
            onClick={() => step === 'model' ? onStepChange('camera') : onStart()}
            className="flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-[13px] font-semibold text-white transition active:scale-[.98] disabled:opacity-40"
            style={{ background: `linear-gradient(100deg, ${accentColor}c8, ${accentColor})`, boxShadow: `0 10px 28px ${accentColor}2f` }}
          >
            {step === 'model' ? 'Next: Set up my camera' : fakeImageMissing ? 'Choose a static image first' : 'Connect with this setup'} <ArrowRight size={15} weight="bold" />
          </button>
        </footer>
      </div>
    </div>
  );
};

export default CallSetupGuide;
