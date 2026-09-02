import React, { useEffect, useRef, useState } from 'react';
import { Check, Crop, Gear, Play, Sparkle, Trash, TShirt, UploadSimple, X } from '@phosphor-icons/react';
import type { Live2DAction } from '../../utils/live2dModelStore';
import type { CompanionFrameStyleId } from './companionFrameStyles';
import { useBlobRefUrl } from '../../utils/blobRef';
import './CompanionWardrobeDrawer.css';

type StaticOutfit = {
  id: string;
  name: string;
  preview?: string;
  expressionCount: number;
};

const StaticOutfitPreview: React.FC<{ value?: string }> = ({ value }) => {
  const url = useBlobRefUrl(value);
  return url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <TShirt weight="duotone" />;
};

type CompanionWardrobeDrawerProps = {
  open: boolean;
  styleId: CompanionFrameStyleId;
  characterName: string;
  wardrobeActions: Live2DAction[];
  activeActionId?: string;
  onSelect: (action: Live2DAction) => void;
  modelOutfits?: Array<{ assetId: string; fileName: string; format: 'vrm' | 'live2d'; builtIn?: true }>;
  activeModelAssetId?: string;
  onSelectModel?: (assetId: string) => void;
  staticOutfits?: StaticOutfit[];
  activeStaticOutfitId?: string;
  onSelectStaticOutfit?: (outfitId: string) => void;
  onDeleteModel?: (assetId: string) => void | Promise<void>;
  onDeleteStaticOutfit?: (outfitId: string) => void | Promise<void>;
  onDeleteWardrobeAction?: (actionId: string) => void | Promise<void>;
  staticMode?: boolean;
  staticSource?: 'upload' | 'date';
  discoveryHint?: boolean;
  onOpenComposition: () => void;
  onManageActions: () => void;
  onImportOutfit?: () => void;
  importBusy?: boolean;
  onClose: () => void;
};

type WardrobeItemButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onLongPress?: () => void;
};

/** iOS/Capacitor-friendly long press that cancels as soon as a list scroll starts. */
const WardrobeItemButton: React.FC<WardrobeItemButtonProps> = ({ onLongPress, onClick, ...props }) => {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const cancel = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  };
  useEffect(() => cancel, []);
  const begin = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!onLongPress || event.button > 0) return;
    cancel();
    firedRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      navigator.vibrate?.(28);
      onLongPress();
    }, 560);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = startRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
  };
  return (
    <button
      {...props}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={event => {
        if (!onLongPress) return;
        event.preventDefault();
        cancel();
        firedRef.current = true;
        onLongPress();
      }}
      onClick={event => {
        if (firedRef.current) {
          firedRef.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    />
  );
};

type PendingDelete = {
  kind: 'model' | 'static' | 'action';
  id: string;
  name: string;
  detail: string;
};

const CompanionWardrobeDrawer: React.FC<CompanionWardrobeDrawerProps> = ({
  open,
  styleId,
  characterName,
  wardrobeActions,
  activeActionId,
  onSelect,
  modelOutfits = [],
  activeModelAssetId,
  onSelectModel,
  staticOutfits = [],
  activeStaticOutfitId,
  onSelectStaticOutfit,
  onDeleteModel,
  onDeleteStaticOutfit,
  onDeleteWardrobeAction,
  staticMode = false,
  staticSource,
  discoveryHint = false,
  onOpenComposition,
  onManageActions,
  onImportOutfit,
  importBusy = false,
  onClose,
}) => {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setPendingDelete(null);
      setDeleteBusy(false);
    }
  }, [open]);
  if (!open) return null;
  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.kind === 'model') await onDeleteModel?.(pendingDelete.id);
      else if (pendingDelete.kind === 'static') await onDeleteStaticOutfit?.(pendingDelete.id);
      else await onDeleteWardrobeAction?.(pendingDelete.id);
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  };
  return (
    <div className="companion-wardrobe-layer absolute inset-0 z-[70]" data-wardrobe-style={styleId} data-testid="companion-real-wardrobe">
      <button type="button" className="companion-wardrobe-scrim absolute inset-0" onClick={onClose} aria-label="Close wardrobe" />
      <section className="companion-wardrobe-drawer absolute inset-y-0 right-0 flex w-[78%] max-w-[31rem] flex-col">
        <header className="companion-wardrobe-header">
          <div><small>MANUAL WARDROBE</small><h2><TShirt weight="fill" /> {characterName}'s Wardrobe</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><X weight="bold" /></button>
        </header>

        <div className="companion-wardrobe-tabs">
          <span className="is-active"><TShirt weight="fill" /> Outfits</span>
          <button type="button" onClick={onOpenComposition}><Crop weight="bold" /> Scene & Composition</button>
        </div>

        {discoveryHint && (
          <div className="companion-wardrobe-discovery" data-testid="companion-wardrobe-discovery-tip">
            <Sparkle weight="fill" />
            <p><strong>Come back here anytime you want to change the scene or outfit.</strong><span>Tap "Scene & Composition" to change the desktop style, background, and character position.</span></p>
          </div>
        )}

        <p className="companion-wardrobe-note">{staticSource === 'date' ? 'This outfit comes from Date-mode portraits. The desktop has its own separate selection — the AI only switches expressions within the same outfit based on the dialogue mood.' : staticSource === 'upload' ? 'You can keep importing PNG / GIF files; the wardrobe only accepts the same type, and the selected image is shared between the home screen and video calls.' : 'Store outfit-swap buttons for the same model, or import more full models of the same type. The current selection is locked by you — neither the AI nor tap feedback can override it.'}</p>

        <div className="companion-wardrobe-list">
          {staticMode && staticOutfits.map(outfit => {
            const active = activeStaticOutfitId === outfit.id;
            return (
              <WardrobeItemButton
                key={outfit.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelectStaticOutfit?.(outfit.id)}
                onLongPress={staticSource === 'upload' && onDeleteStaticOutfit ? () => setPendingDelete({
                  kind: 'static', id: outfit.id, name: outfit.name, detail: 'The image file will also be removed from the local wardrobe.',
                }) : undefined}
                data-static-outfit={outfit.id}
              >
                <span className="companion-wardrobe-thumb"><StaticOutfitPreview value={outfit.preview} /></span>
                <span className="companion-wardrobe-copy"><strong>{outfit.name}</strong><small>{staticSource === 'upload' ? 'Static image' : `${outfit.expressionCount}/5 base expressions`}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {!staticMode && modelOutfits.map((model, index) => {
            const active = activeModelAssetId === model.assetId;
            return (
              <WardrobeItemButton
                key={model.assetId}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelectModel?.(model.assetId)}
                onLongPress={!model.builtIn && onDeleteModel ? () => setPendingDelete({
                  kind: 'model', id: model.assetId, name: model.fileName,
                  detail: active ? 'This is the current model; deleting it will switch to the next available model.' : 'The model package and runtime cache will both be deleted locally.',
                }) : undefined}
                data-model-outfit={model.assetId}
              >
                <span className="companion-wardrobe-index">M{String(index + 1).padStart(2, '0')}</span>
                <span className="companion-wardrobe-copy"><strong>{model.fileName}</strong><small>{model.format === 'live2d' ? 'Live2D full model' : 'VRM full model'}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {!staticMode && wardrobeActions.map((action, index) => {
            const active = activeActionId === action.id;
            return (
              <WardrobeItemButton
                key={action.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelect(action)}
                onLongPress={onDeleteWardrobeAction ? () => setPendingDelete({
                  kind: 'action', id: action.id, name: action.name,
                  detail: 'Only removed from the wardrobe; the original action stays in the action library and remains manual-only.',
                }) : undefined}
                data-wardrobe-action={action.id}
              >
                <span className="companion-wardrobe-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="companion-wardrobe-copy"><strong>{action.name}</strong><small>{action.hotkey ? `Original key ${action.hotkey}` : action.kind === 'motion' ? 'Outfit motion' : action.kind === 'params' ? 'Outfit param group' : 'Outfit expression'}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {((staticMode && staticOutfits.length === 0) || (!staticMode && modelOutfits.length === 0 && wardrobeActions.length === 0)) && (
            <div className="companion-wardrobe-empty">
              <TShirt weight="duotone" />
              <strong>{staticSource === 'date' ? 'No Date outfits yet' : staticMode ? 'No extra outfits for a single image' : 'No outfit motions tagged yet'}</strong>
              <span>{staticSource === 'date' ? 'Add a default portrait or new skin in Date mode — each outfit can have up to five base expressions.' : staticMode ? 'You can keep using the current image, or go to Scene & Composition to adjust the desktop.' : 'Preview model buttons in the Action Library and add outfit-swap actions to the wardrobe.'}</span>
            </div>
          )}
        </div>

        <footer className="companion-wardrobe-footer">
          {staticSource !== 'date' && onImportOutfit && (
            <button type="button" onClick={onImportOutfit} disabled={importBusy}><UploadSimple weight="bold" /> {importBusy ? 'Importing…' : `Import more${staticSource === 'upload' ? ' images' : modelOutfits[0]?.format === 'vrm' ? ' VRM' : ' Live2D'}`}</button>
          )}
          <button type="button" onClick={onManageActions}><Gear weight="bold" /> {staticSource === 'date' ? 'Manage Date portraits' : staticMode ? 'Change static image' : 'Manage outfit motions'}</button>
          <small>{staticSource === 'date' ? 'DATE SPRITES · 5 EXPRESSIONS' : staticMode ? 'STATIC IMAGE · PNG / GIF · long-press to delete' : 'WARDROBE ACTIONS · USER ONLY · long-press to delete'}</small>
        </footer>
      </section>

      {pendingDelete && (
        <div className="companion-wardrobe-confirm absolute inset-0 z-20 flex items-end justify-center p-4" data-testid="companion-wardrobe-delete-confirm">
          <button type="button" className="absolute inset-0 bg-black/55" onClick={() => { if (!deleteBusy) setPendingDelete(null); }} aria-label="Cancel deletion" />
          <div className="relative w-full max-w-[22rem] border p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-[12px] font-semibold"><Trash size={16} weight="bold" /> Delete from wardrobe?</div>
            <div className="mt-2 break-all text-[13px] font-medium">{pendingDelete.name}</div>
            <div className="mt-1 text-[9px] leading-relaxed opacity-60">{pendingDelete.detail}</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" disabled={deleteBusy} onClick={() => setPendingDelete(null)} className="border px-3 py-2 text-[10px]">Cancel</button>
              <button type="button" disabled={deleteBusy} onClick={() => { void confirmDelete(); }} className="border border-rose-300/45 bg-rose-500/18 px-3 py-2 text-[10px] text-rose-100">{deleteBusy ? 'Deleting…' : 'Confirm delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompanionWardrobeDrawer;
