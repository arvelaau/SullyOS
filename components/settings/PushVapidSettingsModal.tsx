import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateVapidKeyPair } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid, clearPushVapid } from '../../utils/pushVapid';
import { trackEvent } from '../../utils/analytics';

interface PushVapidSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 推送凭据 (VAPID) 配置面板.
 *
 * 抽出来单独管理是因为 Proactive Push 和 Instant Push 共用一份 VAPID — 两边
 * 用不同的 key 时会反复 unsubscribe 抢同一个 pushManager 订阅. 把 UI 提到
 * 顶层后, 用户一眼看到这是全局推送凭据, 不会再以为它属于 Instant Push.
 *
 * 私钥也存 localStorage 方便复制到 CF Worker env, 这里不当成一次性密钥处理.
 */
export const PushVapidSettingsModal: React.FC<PushVapidSettingsModalProps> = ({ open, onClose }) => {
  const { addToast } = useOS();

  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const v = loadPushVapid();
    setPublicKey(v.vapidPublicKey);
    setPrivateKey(v.vapidPrivateKey);
    setShowPrivateKey(false);
  }, [open]);

  const persist = (pub: string, priv: string) => {
    savePushVapid({ vapidPublicKey: pub, vapidPrivateKey: priv });
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const kp = await generateVapidKeyPair();
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      persist(kp.publicKey, kp.privateKey);
      setShowPrivateKey(true);
      addToast('New VAPID key pair generated', 'success');
      // 只报「这次生成成没成」。不带「之前配没配过」——那等于上报凭据配置状态。
      trackEvent('Generate VAPID Key Pair', { result: 'success' });
    } catch (e) {
      const err = e as { message?: string } | null;
      addToast(err?.message ?? 'Generation failed', 'error');
      // 只报「失败了」这一件事：报错原文可能带路径，留在 toast / console 里就够。
      trackEvent('Generate VAPID Key Pair', { result: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleClear = () => {
    if (!confirm('Clear the VAPID key pair? Proactive / Instant Push will both stop working immediately, and the next subscription will need to be rebuilt.')) {
      trackEvent('Clear VAPID Key Pair', { confirmed: false });
      return;
    }
    trackEvent('Clear VAPID Key Pair', { confirmed: true });
    clearPushVapid();
    setPublicKey('');
    setPrivateKey('');
    addToast('VAPID cleared', 'success');
  };

  const handleCopyPublicKey = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    addToast('Public key copied', 'success');
    trackEvent('Copy VAPID Public Key');
  };

  const handleCopyPrivateKey = async () => {
    if (!privateKey) {
      addToast('Private key not generated yet', 'error');
      return;
    }
    await navigator.clipboard.writeText(privateKey);
    addToast('Private key copied', 'success');
    trackEvent('Copy VAPID Private Key');
  };

  const handleCopyEnv = async () => {
    let pub = publicKey.trim();
    let priv = privateKey.trim();
    if (!pub || !priv) {
      await handleGenerate();
      const v = loadPushVapid();
      pub = v.vapidPublicKey;
      priv = v.vapidPrivateKey;
      if (!pub || !priv) return;
    }
    const lines = [
      `VAPID_PUBLIC_KEY=${pub}`,
      `VAPID_PRIVATE_KEY=${priv}`,
      `# Optional:`,
      `# VAPID_EMAIL=mailto:you@example.com`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    addToast('env copied (includes real keys)', 'success');
    trackEvent('Copy Worker env List');
  };

  const handleSave = () => {
    persist(publicKey.trim(), privateKey.trim());
    addToast('Push credentials saved', 'success');
    onClose();
  };

  const maskedPrivateKey = privateKey
    ? privateKey.slice(0, 4) + '•'.repeat(Math.max(8, privateKey.length - 8)) + privateKey.slice(-4)
    : '';

  return (
    <Modal
      isOpen={open}
      title="Push Credentials (VAPID)"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            Save
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[11px] text-amber-800 leading-relaxed">
          <p className="font-bold mb-1">⚠ One VAPID, two uses</p>
          <p>
            The browser uses the <b>public key</b> to subscribe to push; the Worker uses the <b>private key</b> to sign pushes.
            Proactive Push and Instant Push <b>both read the public key from here</b> —
            mismatched public keys cause repeated unsubscribe fights over the same subscription, a common cause of
            "push quota isn't dropping but notifications aren't arriving."
          </p>
          <p className="mt-1">
            After generating / changing it, your CF Worker env (<code>VAPID_PUBLIC_KEY</code> + <code>VAPID_PRIVATE_KEY</code>) needs to be updated too, or signature verification will fail.
          </p>
        </div>

        {/* 公钥 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID Public Key</label>
            {publicKey && (
              <button
                type="button"
                onClick={() => void handleCopyPublicKey()}
                className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
              >
                Copy
              </button>
            )}
          </div>
          <input
            type="text"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="BA… (click &quot;Generate New Key Pair&quot; below to auto-generate)"
            className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
          />
        </div>

        {/* 私钥 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID Private Key</label>
            <div className="flex items-center gap-3">
              {privateKey && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowPrivateKey((s) => !s)}
                    className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
                  >
                    {showPrivateKey ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyPrivateKey()}
                    className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                  >
                    Copy
                  </button>
                </>
              )}
            </div>
          </div>
          {showPrivateKey ? (
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              rows={3}
              placeholder="Click &quot;Generate New Key Pair&quot; below to auto-generate"
              className="w-full font-mono text-[11px] bg-white border border-slate-200 rounded-xl p-2 resize-none leading-relaxed focus:outline-none focus:border-indigo-400"
            />
          ) : (
            <div className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-500 select-none break-all">
              {maskedPrivateKey || 'Not generated yet'}
            </div>
          )}
          <p className="text-[10px] text-slate-400 leading-relaxed">
            The private key lives in localStorage for easy copying to the Worker env. Local data already holds plenty of secrets — one more doesn't change the threat model.
          </p>
        </div>

        {/* 操作 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold ${generating ? 'bg-slate-200 text-slate-400' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}
          >
            {generating ? 'Generating…' : (publicKey ? '🔄 Regenerate Key Pair' : 'Generate New Key Pair')}
          </button>
          <button
            type="button"
            onClick={() => void handleCopyEnv()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold border border-slate-200 ${generating ? 'bg-slate-100 text-slate-400' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            Copy env List
          </button>
        </div>

        {(publicKey || privateKey) && (
          <div className="text-center">
            <button
              type="button"
              onClick={handleClear}
              className="text-[11px] text-rose-500 hover:text-rose-600 font-medium underline-offset-2 hover:underline"
            >
              Clear VAPID (Proactive / Instant will both stop working)
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};
