import React from 'react';
import { HandTap, TShirt } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './OtomeCompanionChrome.css';

type OtomeCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  dayProgress: number;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
  onHome: () => void;
};

const OtomeCompanionChrome: React.FC<OtomeCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  dayProgress,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
  onHome,
}) => {
  const dateLabel = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit' })
    .format(new Date())
    .replace('/', '.');
  const rightBookmarks = [
    { key: AppID.CheckPhone, label: 'Voice', eyebrow: 'NOTE', Icon: Icons.CheckPhone, action: () => openApp(AppID.CheckPhone) },
    { key: 'wardrobe', label: 'Wardrobe', eyebrow: 'LOOK', Icon: TShirt, action: openWardrobe, testId: 'companion-otome-wardrobe-button' },
    { key: AppID.Date, label: 'Date', eyebrow: 'MEET', Icon: Icons.Date, action: () => openApp(AppID.Date), testId: 'companion-otome-date-button' },
    { key: AppID.Call, label: 'Call', eyebrow: 'CALL', Icon: Icons.Call, action: () => openApp(AppID.Call) },
  ];
  const bottomActions = [
    { key: 'home', label: 'Home', Icon: Icons.Room, action: onHome, active: true },
    { key: AppID.Chat, label: 'Chat', Icon: Icons.Chat, action: () => openApp(AppID.Chat) },
    { key: AppID.Date, label: 'Chapter', Icon: Icons.Date, action: () => openApp(AppID.Date) },
    { key: AppID.SpecialMoments, label: 'Moments', Icon: Icons.SpecialMoments, action: () => openApp(AppID.SpecialMoments) },
  ];

  return (
    <div className="companion-otome-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-otome-chrome">
      <header className="otome-daybook-header pointer-events-auto">
        <button type="button" className="otome-daybook-title" onClick={() => openApp(AppID.Character)}>
          <span>DAYBOOK · {dateLabel}</span>
          <strong>{character.name}</strong>
          <small className="otome-day-progress">
            <span>Today's events</span>
            <i aria-hidden><b style={{ width: `${dayProgress}%` }} /></i>
            <em>{dayProgress}%</em>
          </small>
        </button>
        <button type="button" className="otome-keepsake-balance" onClick={() => openApp(AppID.Bank)} aria-label="Open account">
          <span>Petal Notes</span><strong>12,860</strong><i aria-hidden />
        </button>
      </header>

      <button type="button" className="otome-season-letter pointer-events-auto" onClick={() => openApp(AppID.VRWorld)}>
        <span className="otome-letter-seal" aria-hidden><Icons.SpecialMoments /></span>
        <span className="otome-letter-copy">
          <small>SEASON LETTER</small>
          <strong>A Letter from Sunlit Court</strong>
          <em>A new memory has arrived</em>
        </span>
      </button>

      <div className="otome-stage-toolbar pointer-events-auto" aria-label="Desktop tools">
        <button type="button" onClick={() => openApp(AppID.Appearance)}><Icons.Appearance /><span>Appearance</span></button>
        <i aria-hidden />
        <button type="button" onClick={openTouchSettings} className="relative">
          <HandTap weight="bold" /><span>Touch</span>
        </button>
      </div>

      <aside className="otome-bookmark-rail pointer-events-auto" aria-label="Sunlit Court quick bookmarks">
        {rightBookmarks.map(({ key, label, eyebrow, Icon, action, testId }, index) => (
          <button key={key} type="button" onClick={action} data-testid={testId} data-companion-wardrobe-trigger={key === 'wardrobe' ? 'true' : undefined}>
            <span className="otome-bookmark-index">0{index + 1}</span>
            <Icon />
            <span className="otome-bookmark-copy"><small>{eyebrow}</small><strong>{label}</strong></span>
          </button>
        ))}
      </aside>

      <button type="button" className="otome-episode-ribbon pointer-events-auto" onClick={openCharacterSchedule} data-testid="companion-otome-current-trip">
        <span>CURRENT ROUTE</span>
        <strong>Current itinerary · {currentScheduleSlot?.activity || 'Not yet scheduled'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : 'Open character schedule'}</small>
        <Icons.Journal />
      </button>

      <nav className="otome-book-dock pointer-events-auto" aria-label="Sunlit Court handbook nav">
        <div className="otome-book-dock-items">
          {bottomActions.map(({ key, label, Icon, action, active }) => (
            <button key={key} type="button" onClick={action} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="otome-menu-pearl" onClick={openAllApps} aria-label="Open all features">
          <Icons.Settings />
          <span>Menu</span>
        </button>
      </nav>
    </div>
  );
};

export default OtomeCompanionChrome;
