/**
 * BackupReminderEvent.tsx
 * 「该备份啦」提醒弹窗。
 *
 * 糯米机是 local-first：所有数据只躺在你这台设备的浏览器里，没有云端副本。
 * 隔一段时间（默认 7 天，可在设置里改 1~30 天）没导出，就温柔弹一次提醒。
 *
 * 显隐判定在 utils/backupReminder.ts；这里只管长得好看 + 两个出口：
 *  - 去备份：跳到「设置 → 备份与恢复」
 *  - 知道了：记一次提醒时间，进入冷却，下个间隔到了才会再弹
 */

import React from 'react';
import { daysSinceLastBackup, getBackupReminderState } from '../utils/backupReminder';

interface BackupReminderPopupProps {
    /** 「知道了 / 稍后」——外层会 markBackupReminderShown 并关闭 */
    onDismiss: () => void;
    /** 「去备份」——外层跳设置备份区并关闭 */
    onGoBackup: () => void;
}

export const BackupReminderPopup: React.FC<BackupReminderPopupProps> = ({ onDismiss, onGoBackup }) => {
    const days = daysSinceLastBackup();
    const interval = getBackupReminderState().intervalDays;
    // 顶部那句"多久没备份了"——从未备份 vs 已过 N 天，说人话。
    const gapLine = days == null
        ? "You haven't exported a backup yet"
        : `${days} days since your last backup`;

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onDismiss} />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
                {/* 顶部渐变头图 + 盾牌图标 */}
                <div className="relative pt-8 pb-5 px-6 text-center bg-gradient-to-br from-rose-400 via-orange-300 to-amber-300">
                    <div className="w-16 h-16 mx-auto mb-3 rounded-3xl bg-white/25 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/40 shadow-lg">
                        <svg viewBox="0 0 24 24" fill="none" className="w-9 h-9 text-white" aria-hidden="true">
                            <path d="M12 2.5 5 5.2v5.3c0 4.2 2.9 8.1 7 9.2 4.1-1.1 7-5 7-9.2V5.2L12 2.5Z"
                                stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                            <path d="m9.2 12 2 2 3.6-3.8" stroke="currentColor" strokeWidth="1.7"
                                strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-extrabold text-white drop-shadow-sm">Time to back up!</h2>
                    <p className="text-[12px] text-white/90 mt-1 font-medium">{gapLine}</p>
                </div>

                {/* 正文 */}
                <div className="px-6 pt-5 pb-2 space-y-3">
                    <div className="bg-gradient-to-br from-rose-50 to-orange-50 border border-rose-100 rounded-2xl p-4 space-y-2.5">
                        <p className="text-[13px] text-slate-700 leading-relaxed">
                            <strong>You haven't backed up this week — please take note.</strong>
                        </p>
                        <p className="text-[12.5px] text-slate-600 leading-relaxed">
                            Mochi Machine's data is entirely in <strong className="text-rose-500">your own hands</strong> —
                            characters, chat history, memories, and settings all live only in this device's browser. We can't see it, and we can't help you get it back.
                        </p>
                        <p className="text-[12.5px] text-slate-600 leading-relaxed">
                            If you clear your browser cache, uninstall and reinstall, switch phones, or run into a system hiccup,
                            <strong className="text-rose-500"> no backup means all of it is gone for good, unrecoverable</strong>.
                        </p>
                        <p className="text-[12px] text-slate-500 leading-relaxed">
                            Make a habit of exporting regularly — save the ZIP to cloud storage, your computer, or a cloud backup, and give yourself a safety net 💛
                        </p>
                    </div>
                    <p className="text-[10.5px] text-slate-400 text-center leading-relaxed">
                        Currently reminding every {interval} days — adjust the frequency in 「Settings → Backup & Restore」
                    </p>
                </div>

                {/* 按钮 */}
                <div className="px-6 pb-7 pt-3 space-y-2">
                    <button
                        onClick={onGoBackup}
                        className="w-full py-3.5 font-bold rounded-2xl text-sm text-white bg-gradient-to-r from-rose-500 to-orange-500 shadow-lg shadow-rose-200 active:scale-95 transition-transform"
                    >
                        Back Up Now
                    </button>
                    <button
                        onClick={onDismiss}
                        className="w-full py-2.5 text-slate-400 font-medium text-[12px] active:scale-95 transition-transform"
                    >
                        Got it, maybe later
                    </button>
                </div>
            </div>
        </div>
    );
};

interface BackupReminderControllerProps {
    onDismiss: () => void;
    onGoBackup: () => void;
}

export const BackupReminderController: React.FC<BackupReminderControllerProps> = (props) => {
    return <BackupReminderPopup {...props} />;
};
