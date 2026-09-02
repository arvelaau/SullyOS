import React from 'react';
import {
  Broadcast,
  ChatCircleDots,
  HandTap,
  Heart,
  Sparkle,
  TShirt,
  VideoCamera,
} from '@phosphor-icons/react';
import { Icons } from '../../constants';
import TokenImg from './TokenImg';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './IdolCompanionChrome.css';

type IdolCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  dayProgress: number;
  hours: number;
  minutes: number;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
};

const IdolCompanionChrome: React.FC<IdolCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  dayProgress,
  hours,
  minutes,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
}) => {
  const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const stageTools = [
    { id: 'touch', label: 'Interact', eyebrow: 'TOUCH', Icon: HandTap, action: openTouchSettings },
    { id: 'wardrobe', label: 'Outfit', eyebrow: 'STYLE', Icon: TShirt, action: openWardrobe, testId: 'companion-idol-wardrobe-button' },
    { id: 'appearance', label: 'Staging', eyebrow: 'SCENE', Icon: Sparkle, action: () => openApp(AppID.Appearance) },
  ];
  const dock = [
    { id: AppID.Chat, label: 'Chat', Icon: ChatCircleDots, action: () => openApp(AppID.Chat) },
    { id: AppID.Call, label: 'Call', Icon: VideoCamera, action: () => openApp(AppID.Call) },
    { id: 'live', label: 'Stage', Icon: Broadcast, action: openAllApps, primary: true },
    { id: AppID.SpecialMoments, label: 'Moments', Icon: Heart, action: () => openApp(AppID.SpecialMoments) },
    { id: AppID.Music, label: 'Music', Icon: Icons.Music, action: () => openApp(AppID.Music) },
  ];

  return (
    <div className="companion-idol-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-idol-chrome">
      <header className="idol-live-header pointer-events-auto">
        <button type="button" className="idol-live-identity" onClick={() => openApp(AppID.Character)}>
          <span className="idol-live-avatar"><TokenImg value={character.avatar} alt="" /></span>
          <span className="idol-live-copy"><small>NOW ON STAGE</small><strong>{character.name}</strong></span>
        </button>
        <div className="idol-live-status" aria-label="Live now">
          <i aria-hidden /><strong>LIVE</strong><span>{time}</span>
        </div>
      </header>

      <div className="idol-stage-title" aria-hidden>
        <span>PRIVATE LIVE SESSION</span>
        <strong>{character.name}</strong>
        <small>STAGE · 08</small>
      </div>

      <aside className="idol-stage-tools pointer-events-auto" aria-label="Live stage tools">
        {stageTools.map(({ id, label, eyebrow, Icon, action, testId }, index) => (
          <button key={id} type="button" onClick={action} data-testid={testId} data-companion-wardrobe-trigger={id === 'wardrobe' ? 'true' : undefined}>
            <span>0{index + 1}</span><Icon weight="bold" />
            <small>{eyebrow}</small><strong>{label}</strong>
          </button>
        ))}
      </aside>

      <button type="button" className="idol-live-route pointer-events-auto" onClick={openCharacterSchedule}>
        <span><i aria-hidden /> CURRENT SET</span>
        <strong>{currentScheduleSlot?.activity || 'Free interaction time'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : "Open today's stage schedule"}</small>
        <em>{dayProgress}%</em>
      </button>

      <div className="idol-live-caption" aria-hidden><span>YOUR FRONT ROW</span><i /><small>Vision and heartbeat, in sync</small></div>

      <nav className="idol-live-dock pointer-events-auto" aria-label="Idol live nav">
        {dock.map(({ id, label, Icon, action, primary }) => (
          <button key={id} type="button" onClick={action} className={primary ? 'is-live' : ''} aria-label={primary ? 'Open all features' : label}>
            <span><Icon weight={primary ? 'fill' : 'regular'} /></span><small>{label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
};

export default IdolCompanionChrome;
