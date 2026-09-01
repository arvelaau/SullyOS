// PWA 应用图标编辑器：上传图片 / 填图床链接，动态注入 apple-touch-icon + manifest。
//
// 见 docs/superpowers/specs/2026-08-09-pwa-custom-icon-design.md

import React, { useState, useRef, useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import { isStandaloneDisplayMode } from '../../utils/iosStandalone';
import { injectPwaIcon, clearPwaIcon, PWA_ICON_APP_ID } from '../../utils/appIcon';

type Mode = 'upload' | 'url';

const AppIconEditor: React.FC = () => {
  const { customIcons, setCustomIcon, addToast } = useOS();
  const currentValue: string | undefined = customIcons[PWA_ICON_APP_ID];

  const [mode, setMode] = useState<Mode>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [processing, setProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isStandalone = isStandaloneDisplayMode();
  const previewUrl = useBlobRefUrl(currentValue);

  // ── 保存 ───────────────────────────────────────────────────

  const saveIcon = useCallback(async (blobRef: string) => {
    await setCustomIcon(PWA_ICON_APP_ID, blobRef);
    try {
      await injectPwaIcon(blobRef);
    } catch (e) {
      console.warn('[AppIconEditor] injectPwaIcon failed', e);
    }
    addToast('PWA icon updated ✨', 'success');
  }, [setCustomIcon, addToast]);

  // ── 上传 ───────────────────────────────────────────────────

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    try {
      const blob = await processImageToBlob(file, { maxWidth: 512, quality: 0.92 });
      const ref = await putImageBlob(blob);
      await saveIcon(ref);
    } catch (err: any) {
      addToast(err.message || 'Image processing failed', 'error');
    } finally {
      setProcessing(false);
      // 清掉 input 以便再次选同一文件时仍触发 onChange
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [saveIcon, addToast]);

  // ── URL 输入 ───────────────────────────────────────────────

  const handleUrlConfirm = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    // 基础校验
    if (!/^https?:\/\//i.test(trimmed)) {
      addToast('Please enter a valid http/https link', 'error');
      return;
    }
    if (trimmed.length > 2048) {
      addToast('Link too long, 2048 characters max', 'error');
      return;
    }

    setProcessing(true);
    try {
      const resp = await fetch(trimmed, { mode: 'cors' });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error('The link does not point to an image (Content-Type: ' + contentType + ')');
      }
      const fetchedBlob = await resp.blob();
      // 通过 processImageToBlob 统一压缩到 512px
      const file = new File([fetchedBlob], 'pwa-icon', { type: fetchedBlob.type || 'image/png' });
      const blob = await processImageToBlob(file, { maxWidth: 512, quality: 0.92 });
      const ref = await putImageBlob(blob);
      await saveIcon(ref);
      setUrlInput('');
    } catch (err: any) {
      addToast(err.message || 'Failed to fetch image', 'error');
    } finally {
      setProcessing(false);
    }
  }, [urlInput, saveIcon, addToast]);

  // ── 重置 ───────────────────────────────────────────────────

  const handleReset = useCallback(async () => {
    await setCustomIcon(PWA_ICON_APP_ID, undefined);
    clearPwaIcon();
    addToast('PWA icon restored to default', 'info');
  }, [setCustomIcon, addToast]);

  // ── 渲染 ───────────────────────────────────────────────────

  return (
    <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100 space-y-4">
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-primary">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
        </svg>
        <span className="text-sm font-medium text-slate-700">PWA app icon</span>
      </div>

      {/* 当前图标预览 */}
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-sm bg-slate-100 shrink-0">
          {previewUrl ? (
            <img src={previewUrl} className="w-full h-full object-cover" alt="Current PWA icon" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="w-8 h-8 text-slate-300">
                <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-slate-500">
            {currentValue ? 'Custom icon set' : 'Using default icon'}
          </div>
          {currentValue && (
            <button
              onClick={handleReset}
              className="text-xs text-red-400 hover:text-red-500 mt-1"
              disabled={processing}
            >
              Reset to default
            </button>
          )}
        </div>
      </div>

      {/* 模式切换 */}
      <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
        <button
          onClick={() => setMode('upload')}
          className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
            mode === 'upload'
              ? 'bg-white text-slate-700 shadow-sm'
              : 'text-slate-400'
          }`}
        >
          Upload image
        </button>
        <button
          onClick={() => setMode('url')}
          className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
            mode === 'url'
              ? 'bg-white text-slate-700 shadow-sm'
              : 'text-slate-400'
          }`}
        >
          Enter link
        </button>
      </div>

      {/* 上传模式 */}
      {mode === 'upload' && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={processing}
            className="w-full py-3 px-4 border-2 border-dashed border-slate-200 rounded-xl text-sm text-slate-400 hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          >
            {processing ? 'Processing…' : 'Tap to select image'}
          </button>
          <div className="text-[10px] text-slate-400 mt-1.5 text-center">
            Supports PNG / JPEG / WebP, auto-scaled to 512px
          </div>
        </div>
      )}

      {/* URL 模式 */}
      {mode === 'url' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/icon.png"
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-xl bg-slate-50 focus:border-primary focus:bg-white transition-colors"
              disabled={processing}
              onKeyDown={(e) => { if (e.key === 'Enter') handleUrlConfirm(); }}
            />
            <button
              onClick={handleUrlConfirm}
              disabled={processing || !urlInput.trim()}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-xl disabled:opacity-40 transition-opacity"
            >
              {processing ? '…' : 'Confirm'}
            </button>
          </div>
          <div className="text-[10px] text-slate-400 text-center">
            Enter a direct image-host link (PNG / JPEG), auto-fetched and compressed
          </div>
        </div>
      )}

      {/* 环境感知提示 */}
      {isStandalone ? (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <div className="text-sm font-bold text-red-600 text-center">
            ⚠️ Deleting and reinstalling loses data ⚠️
          </div>
          <div className="text-xs text-red-500 leading-relaxed space-y-1.5">
            <p>
              The home-screen icon is only read once, at the moment you tap "Add to Home Screen" — it can't be changed after that.
              To see the new icon, <strong>you have to delete the app and "Add to Home Screen" again</strong>.
            </p>
            <p className="text-red-600 font-bold">
              Note: SullyOS installed as an app keeps its own separate data — it isn't shared with the browser tab, and it's isolated from other PWAs too. Deleting the app deletes this data along with it.
            </p>
            <p className="text-red-600 font-bold">
              Back up before deleting: Settings → Backup → Export, then import again after reinstalling.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
          <div className="text-xs text-blue-600 leading-relaxed">
            ✨ The tab icon has been updated. The new icon will be used next time you "Add to Home Screen" ～
            Apps already installed are not affected.
          </div>
        </div>
      )}
    </section>
  );
};

export default AppIconEditor;
