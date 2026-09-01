import React, { useState } from 'react';
import {
  downloadAndVerifyAndroidUpdate,
  fetchAndroidUpdateManifest,
  getInstalledAndroidAppInfo,
  installVerifiedAndroidUpdate,
  isAndroidAppUpdateEnabled,
  type AndroidUpdateManifest,
} from '../../utils/androidAppUpdate';
import { trackEvent } from '../../utils/analytics';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'permission' | 'installing' | 'latest' | 'error';

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (/Failed to fetch|NetworkError|timeout/i.test(message)) return 'Network connection failed, please try again later';
  return message || 'Failed to check for updates, please try again later';
};

const AndroidUpdateControl: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [manifest, setManifest] = useState<AndroidUpdateManifest | null>(null);
  const [downloadedPath, setDownloadedPath] = useState('');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  if (!isAndroidAppUpdateEnabled()) return null;

  const check = async () => {
    setPhase('checking');
    setMessage('');
    try {
      const [installed, latest] = await Promise.all([
        getInstalledAndroidAppInfo(),
        fetchAndroidUpdateManifest(),
      ]);
      if (latest.versionCode <= installed.versionCode) {
        setManifest(null);
        setPhase('latest');
        setMessage(`Current ${installed.versionName || installed.versionCode} is already the latest version`);
        trackEvent('Android Check Update', { result: 'latest', versionCode: installed.versionCode });
        return;
      }
      setManifest(latest);
      setPhase('available');
      setMessage(`New version found: ${latest.versionName}`);
      trackEvent('Android Check Update', { result: 'available', versionCode: latest.versionCode });
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
      trackEvent('Android Check Update', { result: 'failed' });
    }
  };

  const install = async (path: string, target: AndroidUpdateManifest) => {
    setPhase('installing');
    const result = await installVerifiedAndroidUpdate(path, target);
    if (result.status === 'permission_required') {
      setPhase('permission');
      setMessage('Please allow "Install unknown apps", then go back and tap "Continue Install"');
      return;
    }
    setMessage('Opened the Android system installer');
  };

  const download = async () => {
    if (!manifest) return;
    setPhase('downloading');
    setProgress(0);
    setMessage('Downloading and verifying the official installer package');
    try {
      const path = await downloadAndVerifyAndroidUpdate(manifest, setProgress);
      setDownloadedPath(path);
      await install(path, manifest);
      trackEvent('Android Download Update', { result: 'installer-opened', versionCode: manifest.versionCode });
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
      trackEvent('Android Download Update', { result: 'failed', versionCode: manifest.versionCode });
    }
  };

  const continueInstall = async () => {
    if (!manifest || !downloadedPath) return;
    try {
      await install(downloadedPath, manifest);
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
    }
  };

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const label = phase === 'checking'
    ? 'Checking…'
    : phase === 'downloading'
      ? `Downloading ${Math.round(progress * 100)}%`
      : phase === 'installing'
        ? 'Opening installer…'
        : phase === 'available'
          ? `Download and install ${manifest?.versionName || 'new version'}`
          : phase === 'permission'
            ? 'Continue Install'
            : 'Check for Updates';
  const onClick = phase === 'available' ? download : phase === 'permission' ? continueInstall : check;

  return (
    <div className="mt-2 flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded-full bg-violet-100 px-4 py-2 text-[11px] font-bold text-violet-700 transition-transform active:scale-95 disabled:opacity-60"
      >
        {label}
      </button>
      {phase === 'downloading' && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-violet-400 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {message && (
        <p className={`max-w-[280px] text-center text-[10px] leading-relaxed ${phase === 'error' ? 'text-rose-500' : 'text-slate-400'}`}>
          {message}
        </p>
      )}
      {phase === 'available' && manifest?.releaseNotes.length ? (
        <ul className="max-w-[300px] list-disc space-y-0.5 pl-5 text-left text-[9px] leading-relaxed text-slate-400">
          {manifest.releaseNotes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
};

export default AndroidUpdateControl;
