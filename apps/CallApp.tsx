import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Microphone, SpeakerHigh, SpeakerSlash, PhoneDisconnect, Translate, Gear, Clock, CaretLeft, CaretRight, Phone, VideoCamera, VideoCameraSlash, Cube, FolderOpen, FileZip, Moon, Sun, Check } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { extractContent, safeFetchJson } from '../utils/safeApi';
import { minimaxFetch } from '../utils/minimaxEndpoint';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { buildMiniMaxTtsCacheKey, buildMiniMaxTtsPayload, cleanTextForTts, convertHexAudioToBlob, fetchRemoteAudioBlob, getMiniMaxParamVersion, prepareMiniMaxSpeechText, VALID_EMOTIONS, stripEmotionTags, VOICE_ACTING_GUIDE } from '../utils/minimaxTts';
import { normalizeVoiceTags } from '../utils/sanitize';
import { FISH_VOICE_ACTING_GUIDE, stripFishMarkupForDisplay } from '../utils/fishAudioTts';
import { resolveTtsProvider, getElevenLabsModel, getTtsProvider, getVoicePromptOverride } from '../utils/ttsProvider';
import { getElevenLabsVoiceActingGuide, stripElevenLabsMarkupForDisplay } from '../utils/elevenLabsTts';
import { canSynthesizeSpeech, stripTtsMarkupForDisplay, synthesizeSpeechDetailed as synthesizeSpeechRoutedDetailed } from '../utils/ttsRouter';
import { CANTONESE_VOICE_SUPPORT_NOTE, VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from '../utils/voiceLanguage';
import { startStt, isSttSupported, type SttSession } from '../utils/speechToText';
import { ContextBuilder } from '../utils/context';
import { resolveCharTimeZone } from '../utils/timezone';
import {
  injectMemoryPalace,
} from '../utils/memoryPalace/pipeline';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion } from '../utils/memoryPalace';
import { RealtimeContextManager } from '../utils/realtimeContext';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { Message, ChatTheme, AppID, type CharacterProfile } from '../types';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import VRMVideoCallStage from '../components/call/VRMVideoCallStage';
import Live2DActionSettings from '../components/call/Live2DActionSettings';
import VRoidBetaWarning from '../components/call/VRoidBetaWarning';
import UserCameraModePicker, { type UserCameraMode } from '../components/call/UserCameraModePicker';
import CallSetupGuide, { type CallSetupGuideStep } from '../components/call/CallSetupGuide';
import CallPreferencesSheet from '../components/call/CallPreferencesSheet';
import CallUpdateAnnouncement from '../components/call/CallUpdateAnnouncement';
import { deleteAvatarModel, inspectAvatarFile, saveAvatarModel } from '../utils/avatarModelStore';
import { getLive2DAIActions, prewarmLive2DModelSource, saveLive2DModelFromFiles, saveLive2DModelFromZip, upgradeLive2DAutoPermissions, type Live2DAvatarConfig } from '../utils/live2dModelStore';
import { preloadLive2DRuntime } from '../utils/live2dCore';
import { buildThinkingChainPrompt } from '../utils/thinkingChainPrompt';
import { parseCallAssistantMessage, stripCallTextFormatting, type ParsedCallReply } from '../utils/callReplyFormat';
import { runCallMemoryPalacePostFlow } from '../utils/memoryPalace/callPostFlow';
import {
  buildAvatarPerformancePrompt,
  DEFAULT_AVATAR_PERFORMANCE,
  expandAvatarPerformanceCueBeats,
  inferAvatarPerformanceFromText,
  inferAvatarPerformanceTimelineFromText,
  normalizeAvatarEmotion,
  resolveAvatarPerformance,
  type AvatarPerformanceCue,
  type AvatarPerformanceDirection,
  type AvatarStageFraming,
} from '../utils/avatarPerformance';
import {
  AVATAR_PERFORMANCE_PERSONA_MAX_CHARS,
  AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS,
  AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
  buildAvatarPerformancePersonaPrompt,
  buildAvatarPerformanceRehearsalPrompt,
  alignAvatarPerformanceCuesToSentences,
  isCompleteAvatarPerformanceCuePack,
  parseAvatarPerformancePersona,
  parseAvatarPerformanceRehearsal,
  splitAvatarPerformanceSentences,
} from '../utils/avatarPerformanceRehearsal';
import { CallAudioFeed, shouldKeepNativeCallAudio } from '../utils/callAudioFeed';
import {
  loadCallPreferences,
  markCallUpdateAnnouncementSeen,
  saveCallPreferences,
  shouldShowCallUpdateAnnouncement,
  type CallPreferences,
} from '../utils/callPreferences';
import {
  appendPendingAvatarTouch,
  avatarTouchTargetLabel,
  buildPendingAvatarTouchContext,
  buildImmediateTouchPerformance,
  consumePendingAvatarTouches,
  createAvatarTouchRecord,
  isAvatarTouchGesture,
  resolveAvatarTouchTarget,
  type AvatarTouchHit,
  type AvatarTouchRecord,
} from '../utils/avatarTouch';
import { dataUrlToBlob, deleteBlobRef, isBlobRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';
import { CALL_LIGHT_THEME_CSS } from '../components/call/callLightTheme';
import AvatarTouchFeedback, { type AvatarTouchEffect } from '../components/call/AvatarTouchFeedback';
import { isBuiltinSullyLive2D, setBuiltinSullyLive2DQuality, type BuiltinSullyLive2DQuality } from '../utils/builtinSullyLive2D';
import {
  buildUserCameraEmotionPrompt,
  detectUserCameraEmotion,
  preloadUserCameraEmotionDetector,
  releaseUserCameraEmotionDetector,
  type UserCameraEmotionResult,
} from '../utils/userCameraEmotion';
import {
  attachSnapshotToLatestUserMessage,
  captureUserCameraSnapshot,
  isVisionInputUnsupportedError,
  USER_CAMERA_SNAPSHOT_SYSTEM_NOTE,
} from '../utils/userCameraSnapshot';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { trackEvent } from '../utils/analytics';
import { fetchBlobForShare, shareOrDownloadBlob } from '../utils/shareExport';
import { getPendingReplyText } from '../utils/pendingReply';
import { findExpiredCallSnapshots } from '../utils/callSnapshotRetention';
import {
  companionAvatarSource,
  companionExpressionKey,
  hasDatePortraits,
  listCompanionDateOutfits,
  normalizeCompanionSkinSetId,
  resolveCompanionPortrait,
  type CompanionAvatarSource,
} from '../utils/companionAvatar';
import { addCompanionModelOutfit, addUploadedCompanionOutfit } from '../utils/companionWardrobe';
import VoiceFavoriteActionSheet from '../components/voice/VoiceFavoriteActionSheet';
import { getVoiceFavorite, removeVoiceFavorite, saveVoiceFavorite } from '../utils/voiceFavorites';
type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';
type CallMode = 'voice' | 'video';
type VideoCallLayout = 'stage' | 'story' | 'mini';
type UserCameraPreviewSize = 'small' | 'medium' | 'large';
type ViewMode = 'role-select' | 'in-call' | 'history' | 'record-detail';
type CallBubble = {
  id: string;
  dbId?: number;
  role: 'user' | 'assistant';
  text: string;
  time: string;
  audioUrl?: string;
  timestamp: number;
  thinkingChain?: string;
  performance?: AvatarPerformanceDirection;
  performanceTimeline?: AvatarPerformanceCue[];
  cameraSnapshotRef?: string;
  cameraSnapshotExpired?: boolean;
};
type CallRecord = {
  id: string;
  characterId: string;
  characterName: string;
  sessionId: string;
  createdAt: string;
  durationSec: number;
  mode?: CallMode;
  transcript: CallBubble[];
};
type PendingVRoidImport = {
  file: File;
  characterId: string;
  projectFile: boolean;
};
const VIDEO_CALL_LAYOUT_KEY = 'sully-call-video-layout-v1';
const FAKE_USER_CAMERA_IMAGE_KEY = 'sully-call-fake-camera-image-v1';
const USER_CAMERA_PREVIEW_SIZE_KEY = 'sully-call-camera-preview-size-v1';
const CALL_SETUP_GUIDE_KEY = 'sully-call-setup-guide-v2';
// Four 8-bit PCM silent samples. Playing this exact call audio element from the
// user's "Connect" gesture primes iOS media playback before the async TTS response arrives.
const SILENT_CALL_AUDIO_DATA_URL = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';
const VIDEO_CALL_LAYOUTS: Array<{ id: VideoCallLayout; name: string; hint: string }> = [
  { id: 'stage', name: 'Immersive', hint: 'Character is largest, chat collapses to subtitles' },
  { id: 'story', name: 'Story', hint: 'Character and full dialogue shown in balance' },
  { id: 'mini', name: 'Compact', hint: 'Smaller stage, more room for chat' },
];
const loadVideoCallLayout = (): VideoCallLayout => {
  try {
    const saved = localStorage.getItem(VIDEO_CALL_LAYOUT_KEY);
    return saved === 'stage' || saved === 'story' || saved === 'mini' ? saved : 'stage';
  } catch {
    return 'stage';
  }
};
const USER_CAMERA_PREVIEW_SIZES: Array<{ id: UserCameraPreviewSize; label: string; frameClass: string }> = [
  { id: 'small', label: 'Small', frameClass: 'h-[5rem] w-[3.75rem]' },
  { id: 'medium', label: 'Medium', frameClass: 'h-[7.25rem] w-[5.45rem]' },
  { id: 'large', label: 'Large', frameClass: 'h-[10rem] w-[7.5rem]' },
];
const loadUserCameraPreviewSize = (): UserCameraPreviewSize => {
  try {
    const saved = localStorage.getItem(USER_CAMERA_PREVIEW_SIZE_KEY);
    return saved === 'small' || saved === 'medium' || saved === 'large' ? saved : 'medium';
  } catch {
    return 'medium';
  }
};
const buildMiniMaxErrorMessage = (rawMessage: string, traceId?: string): string => {
  const msg = (rawMessage || '').trim();
  if (/insufficient\s*balance/i.test(msg)) return 'Insufficient MiniMax balance — please top up in the MiniMax console and try again.';
  if (/login\s*fail/i.test(msg) || /authorization/i.test(msg)) return 'MiniMax authentication failed — please check that your MiniMax Key is correct and has permission.';
  return traceId ? `${msg} (trace_id: ${traceId})` : msg;
};
const formatTime = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const formatDuration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const formatTimeByTs = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const CallSnapshotImage: React.FC<{ imageRef?: string; expired?: boolean; compact?: boolean }> = ({ imageRef, expired, compact = false }) => {
  const imageUrl = useBlobRefUrl(imageRef);
  if (!imageUrl) {
    return expired ? <div className="mt-1.5 text-[11px] text-white/38">[Image]</div> : null;
  }
  return (
    <img
      src={imageUrl}
      alt="This turn's video call snapshot"
      className={`${compact ? 'ml-auto max-h-28 max-w-[9rem]' : 'max-h-52 max-w-full'} mt-2 rounded-xl border border-white/12 object-cover`}
    />
  );
};
const summarizeKeepsakeLine = (transcript: CallBubble[], charName: string) => {
  const assistantLine = [...transcript].reverse().find(item => item.role === 'assistant' && item.text.trim());
  if (!assistantLine) return `I'll quietly treasure this call. Come find me again next time. — ${charName}`;
  const normalized = assistantLine.text.replace(/\s+/g, ' ').trim();
  const cutAt = normalized.search(/[。！？!?]/);
  const sentence = cutAt >= 0 ? normalized.slice(0, cutAt + 1) : normalized.slice(0, 42);
  const polished = sentence.length > 48 ? `${sentence.slice(0, 48)}…` : sentence;
  return `"${polished}" — ${charName}`;
};
// Emotion the AI may declare at the very START of a call reply, e.g. "[happy] Hello?".
// Only a leading tag is APPLIED (conservative — avoids surprise mid-utterance tone
// swings); any other [emotion] tags are stripped without effect by stripEmotionTags.
const LEADING_EMOTION_RE = /^\s*[\[【]\s*(happy|sad|angry|fearful|disgusted|surprised|calm|fluent)\s*[\]】]\s*/i;
const extractLeadingEmotion = (raw: string): string | undefined => {
  const m = (raw || '').match(LEADING_EMOTION_RE);
  return m ? m[1].toLowerCase() : undefined;
};
const sanitizeAssistantOutput = (raw: string) => {
  if (!raw) return '';
  // Strip ALL [emotion]/【emotion】 tags (any position) so they're never shown or read.
  // The next two lines strip the literal source-tag words ([通话]/[聊天]/[约会]) the AI is
  // taught to prefix history lines with (see buildCallPrompt below). Do NOT translate the
  // Chinese characters inside these two regexes — they must keep matching the literal tag
  // words the model actually emits, or the tags will leak into the displayed text.
  return stripCallTextFormatting(stripEmotionTags(raw)
    .replace(/^\s*(?:\[\s*通话\s*\]\s*)+/gim, '')
    .replace(/^\s*(?:\[\s*(?:聊天|约会)\s*\]\s*)+/gim, '')
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/gm, '')
    .replace(/^\s*\[?\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\]?\s*/gm, '')
    // Strip a "Timestamp: ..." line the model sometimes echoes back.
    .replace(/^\s*时间戳[:：].*$/gim, ''));
};
const prepareCallAssistantReply = (reply: ParsedCallReply, enhanceBasicTimeline = false) => {
  const leadingEmotion = extractLeadingEmotion(reply.text);
  const text = sanitizeAssistantOutput(reply.text);
  const voiceTag = extractVoiceTag(text);
  // For bilingual calls, stage the visible Chinese line rather than treating the
  // translated <语音> copy as a second consecutive utterance.
  const performanceText = voiceTag.display || voiceTag.voiceText || text;
  const inferredTimeline = inferAvatarPerformanceTimelineFromText(performanceText);
  const inferredPerformance = inferredTimeline[0]?.direction || inferAvatarPerformanceFromText(performanceText);
  // Voice emotion must be derivable as soon as the final line exists so TTS can run
  // in parallel with the secondary action director. Explicit voice/leading tags win;
  // otherwise use the deterministic local text inference.
  const speechEmotion = voiceTag.emotion || leadingEmotion || inferredPerformance.emotion;
  const fallbackPerformance = {
    ...inferredPerformance,
    emotion: normalizeAvatarEmotion(speechEmotion || inferredPerformance.emotion),
  };
  const performance = resolveAvatarPerformance(reply.performance || fallbackPerformance, speechEmotion);
  // Performance timeline: if the LLM gave multiple cues, keep them all (scheduled
  // proportionally by position in the text); if it gave none, fall back to a
  // single "opening beat" timeline.
  let performanceCues: AvatarPerformanceCue[];
  if (reply.performanceCues?.length) {
    performanceCues = reply.performanceCues;
    // The basic model is required to emit an opening instruction, but often stops
    // there. Preserve its authored first beat and locally fill later semantic turns.
    if (enhanceBasicTimeline && performanceCues.length === 1) {
      const signature = (direction: AvatarPerformanceDirection) => [
        direction.emotion, direction.gesture, direction.camera, direction.gaze,
      ].join('|');
      const enriched = [{ ...performanceCues[0], at: 0 }];
      for (const cue of inferredTimeline) {
        if (cue.at <= 0.08 || signature(cue.direction) === signature(enriched[enriched.length - 1].direction)) continue;
        enriched.push(cue);
        if (enriched.length >= 3) break;
      }
      performanceCues = enriched;
    }
  } else if (enhanceBasicTimeline) {
    performanceCues = inferredTimeline.map((cue, index) => index === 0 ? { ...cue, direction: performance, at: 0 } : cue);
  } else {
    performanceCues = [{ direction: performance, at: 0 }];
  }
  return {
    text,
    thinkingChain: reply.thinkingChain,
    speechEmotion,
    performance,
    performanceCues,
  };
};
/** Estimated line duration (ms) when there's no audio / duration is unknown, used to schedule the performance timeline. */
const estimateSpeechMs = (text: string) => Math.max(1500, Math.min(30_000, (text || '').length * 95));
const CALL_WAVE = [10, 18, 26, 14, 30, 12, 22, 32, 16, 24, 12, 28, 18, 10, 26, 20, 14, 30, 12, 22];
const CALL_SPARKLES = [
  { top: '14%', left: '16%', s: 3 }, { top: '22%', left: '82%', s: 2 },
  { top: '40%', left: '10%', s: 2 }, { top: '58%', left: '88%', s: 3 },
  { top: '70%', left: '20%', s: 2 }, { top: '34%', left: '70%', s: 2 },
  { top: '48%', left: '54%', s: 2 }, { top: '12%', left: '58%', s: 2 },
  { top: '78%', left: '64%', s: 3 }, { top: '64%', left: '38%', s: 2 },
];
/** Extracts the content of an <语音 emotion="…">…</语音> tag + its emotion from the AI's
 *  reply (also accepts the traditional-character 語音 spelling, and a missing attribute).
 *  Runs normalizeVoiceTags first to self-heal (unclosed/orphan-closed tags, full-width
 *  punctuation, malformed attributes) — a call turn goes straight from the LLM's raw
 *  output to speech with no persisted-message sanitize fallback, so a malformed tag would
 *  otherwise get read out loud verbatim. */
const extractVoiceTag = (text: string): { display: string; speech: string; voiceText: string; emotion?: string } => {
  text = normalizeVoiceTags(text);
  const match = text.match(/<[语語]音(?:[^>]*?emotion\s*=\s*["']?([a-zA-Z]+)["']?)?[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  if (!match) return { display: text, speech: '', voiceText: '', emotion: undefined };
  const rawEmotion = (match[1] || '').trim().toLowerCase();
  const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : undefined;
  const voiceText = match[2].trim();
  const display = text.replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '').trim();
  return { display, speech: voiceText, voiceText, emotion };
};
const splitTextForTts = (rawText: string, maxChunkLen = 120): string[] => {
  const normalized = rawText.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkLen) return [normalized];

  const chunks: string[] = [];
  let current = '';
  const segments = normalized.split(/([。！？!?；;，,、\n]+)/g).filter(Boolean);

  for (const segment of segments) {
    const next = `${current}${segment}`;
    if (!current || next.length <= maxChunkLen) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = segment;
  }

  if (current) chunks.push(current);

  return chunks.flatMap(chunk => {
    if (chunk.length <= maxChunkLen) return [chunk];
    const arr: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChunkLen) {
      arr.push(chunk.slice(i, i + maxChunkLen));
    }
    return arr;
  }).filter(Boolean);
};
// Sound-tag names → a short display badge label (renders the read-aloud (sighs) marker
// as a minimal badge, no emoji).
const SOUND_TAG_META: Record<string, string> = {
  chuckle: 'chuckle', laughs: 'laugh', sighs: 'sigh', coughs: 'cough',
  'clear-throat': 'clear throat', groans: 'groan', breath: 'breath', pant: 'pant',
  inhale: 'inhale', exhale: 'exhale', gasps: 'gasp', sniffs: 'sniff',
  snorts: 'snort', 'lip-smacking': 'lip smack', humming: 'hum', hissing: 'hiss', emm: 'hmm',
};
const SOUND_TAG_NAMES = Object.keys(SOUND_TAG_META).join('|');
const SOUND_TAG_SPLIT_RE = new RegExp(`(（[^（）\\n]{1,48}）|\\((?:${SOUND_TAG_NAMES})\\)|\\n)`, 'gi');
// Mini sound-wave bar — echoes the call UI's waveform theme, pure vector (always light-colored so it stays visible on dark themes too)
const SoundWaveGlyph = () => (
  <span className="inline-flex items-center gap-[1.5px] align-middle" style={{ height: '0.7em' }} aria-hidden>
    {[0.4, 0.85, 0.6, 1, 0.5].map((h, i) => (
      <span key={i} className="w-[1.5px] rounded-full" style={{ height: `${h * 100}%`, background: 'rgba(255,255,255,0.85)' }} />
    ))}
  </span>
);
const currentVoiceActingGuide = (): string => {
  const provider = getTtsProvider();
  const custom = getVoicePromptOverride(provider);
  if (custom) return custom;
  if (provider === 'fishaudio') return FISH_VOICE_ACTING_GUIDE;
  if (provider === 'elevenlabs') return getElevenLabsVoiceActingGuide(getElevenLabsModel());
  return VOICE_ACTING_GUIDE;
};

const cleanCurrentVoiceMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  const provider = getTtsProvider();
  if (provider === 'fishaudio') return stripFishMarkupForDisplay(text);
  if (provider === 'elevenlabs') return stripElevenLabsMarkupForDisplay(text);
  // MiniMax's (sighs)/(chuckle) markers get rendered as sound-action badges in renderAssistantLine, so they can't be stripped early.
  return text;
};

const renderAssistantLine = (text: string, accent = '#8b5cf6') => {
  // Hide the read-aloud pause marker <#0.4#>
  let trimmed = text.replace(/<#[\d.]+#>/g, '').trim();
  // Fish Audio's inline cues ([whispering]/[break] etc.) are performance directions and shouldn't be shown to the user.
  trimmed = cleanCurrentVoiceMarkupForDisplay(trimmed);
  // Split on Chinese stage directions （…）, English sound-tag markers (sighs), and newlines — the first two get rendered as special elements
  const parts = trimmed.split(SOUND_TAG_SPLIT_RE).filter(Boolean);
  return parts.map((part, idx) => {
    if (part === '\n') return <div key={`br-${idx}`} className="h-2" />;
    const soundMatch = part.match(new RegExp(`^\\((${SOUND_TAG_NAMES})\\)$`, 'i'));
    if (soundMatch) {
      const zh = SOUND_TAG_META[soundMatch[1].toLowerCase()];
      // Text is always white; accent is only used for the faint background + outline, so it stays readable on dark themes too
      return (
        <span key={`snd-${idx}`} className="inline-flex items-center gap-1 align-middle mx-0.5 px-1.5 py-[1px] rounded-full text-[0.7em] font-medium tracking-wide text-white/90"
          style={{ background: `${accent}33`, border: '1px solid rgba(255,255,255,0.22)' }}>
          <SoundWaveGlyph />
          <span>{zh}</span>
        </span>
      );
    }
    if (/^（[^（）\n]{1,48}）$/.test(part)) {
      return <div key={`cue-${idx}`} className="text-violet-300/95 italic my-1.5 text-[0.85em]">{part}</div>;
    }
    return <React.Fragment key={`t-${idx}`}>{part}</React.Fragment>;
  });
};
// Voice and video calls share one prompt builder: the injected context (core
// settings, memory, time, history) is exactly the same — mode only switches the
// opening scene description, since in video the other person can see you.
const buildCallPrompt = (
  userName: string,
  charName?: string,
  coreContext?: string,
  voiceLang?: string,
  mode: CallMode = 'voice',
  tz?: string,
) => {
  const resolvedCharName = charName || 'your character';
  // The time the character says on a call ("what time is it / what day is it") is the
  // time on their end — it follows the character's custom timezone.
  const time = RealtimeContextManager.getTimeContext(tz);
  const specialDates = RealtimeContextManager.checkSpecialDates(tz);
  const timeContext = [
    `[Current Time] ${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}`,
    specialDates.length ? `[Today's Notable] ${specialDates.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const sceneOpening = mode === 'video'
    ? `You are ${resolvedCharName}; on the other end of this video call is ${userName}.
This isn't text — this is a real video call. You can hear their breathing, their tone, their pauses, and they can see you too — your expressions and small movements are all on screen.

### You're holding up your phone, the camera pointed at yourself`
    : `You are ${resolvedCharName}; on the other end of the phone is ${userName}.
This isn't text — this is a real phone call. You can hear their breathing, their tone, their pauses. You have your own breathing too.

### You're holding the phone up to your ear`;
  const callPrompt = `${sceneOpening}

What are you doing right now? Where are you? What can be heard around you?
Let it come through naturally when you pick up the ${mode === 'video' ? 'video call' : 'call'} — you don't need to spell it out, but don't act like you're just an interface answering questions either.
You might be lying in bed, walking, eating, or staring blankly out a window. All of this shapes how you sound.

### People on a call don't talk like they're writing an essay

**What does a real phone call actually sound like?**
- You say whatever comes to mind, and change direction mid-sentence. "So today... oh wait, that's not important, let me say the other thing first."
- There are filler sounds. Um, uh, hm, oh, well... these aren't noise, they're the sound of you thinking.
- There are pauses. "..." means you're thinking, not that you're stuck.
- You self-correct. "I thought it was pretty good... actually, no, it wasn't that good."
- You have unconscious reactions. "Huh?" at something unexpected, laughing at something funny.

❌ Don't do this — sounding like customer service reading a script:
"I understand how you feel. On this topic, I think there are three things worth considering. First..."

❌ Don't do this — answering with the same structure every time:
"[Emotional reaction] + [Respond to what they said] + [Add my own status] + [Throw out a question]"
(This formulaic pattern feels fake the moment it repeats twice in a row.)

✅ Do this — have your own rhythm, imperfect like a real person:
"Hm... wait, hold on, back to what you just said."
"...okay, that really is pretty ridiculous."
"...I almost spilled my coffee just now, don't make me laugh."
"Honestly, there's something I've been wanting to tell you today — but finish what you were saying first."

### You can feel the other person

**You're not just "replying" — you're "listening."**
- If their tone sounds down, you don't need to rush in with advice — sometimes just "...what's wrong?" is enough.
- If they're excited, let it catch on you too — don't flatly say "oh that's nice."
- If it's late at night, the way you talk naturally shifts — a softer voice, a slower pace, things you wouldn't normally say come out more easily.
- If they just called and then call again right after, you'd be curious about that.
- If they go quiet for a while... "Hello? You still there?"

### On reply length

Don't phone it in, and don't give a speech.
2-4 sentences is usually enough, but they need actual content — not empty filler like "mhm, okay."
Sometimes one line is enough, as long as that line actually carries weight.
When the conversation's flowing, say more — there's no need to police your word count every time.
What matters: **make them feel like you're really listening, really talking with them — not executing a conversation task.**

### Give your voice emotion (important — write it directly into the text, don't rely on narration)

What you say will be turned into real speech. Different engines recognize different performance markup — strictly follow the **current engine rules** below; don't mix in another engine's tags, and don't write novel-style narration that would get read out loud.

${currentVoiceActingGuide()}

### Source tags on history messages (important)

Every message in the conversation history carries a source tag: [聊天] is what you two typed to each other on your phones as usual, [通话] is what was said during a phone/video call, [约会] is what happened when you met in person. They're all part of the same real, ongoing experience, listed in chronological order.
**You're on a call right now** — the run of [通话] messages at the end of the history is the live record of this ${mode === 'video' ? 'video call' : 'phone call'}, and what the other person just said is right there. The earlier [聊天] and [约会] entries are background memory you can naturally bring up, but **don't treat the topic as a continuation of texting**, and don't forget what they said on the phone just seconds ago — a real person on a call doesn't turn around and forget.

### The bottom line

Only output what you would actually **say out loud** on the call. Do not output system markers like [通话], [聊天], [约会], and do not output timestamps.`;
  const langLabel = voiceLang ? voiceLanguagePromptLabel(voiceLang) : '';
  const voiceLangPrompt = voiceLang ? `### Voice-language translation

The user has turned on the voice-language feature; the language they chose is: ${langLabel} (${voiceLang}).

Your reply must be formatted like this:
1. First, naturally write out what you want to say in Chinese (this is the text shown to the other person — it's fine to put Chinese stage directions here)
2. Then on a new line, write the ${langLabel} translation of that line inside a <语音> tag — this is the part that will actually be read aloud. You can optionally use the emotion attribute to mark the tone of the whole line: \`<语音 emotion="happy">…</语音>\` (emotion can only be one of happy/sad/angry/fearful/disgusted/surprised/calm/fluent)

Example:
啊，我知道了
<语音 emotion="happy">Okay, I get it now!</语音>

你说真的？那也太离谱了吧。
<语音 emotion="surprised">Wait... are you serious? That's insane.</语音>

Requirements:
- The translation inside <语音> should be natural and conversational, not machine-translation-sounding, and should match your character's personality
- Only write the words that will actually be read aloud inside <语音>; performance markup still follows the "current engine rules" above — don't mix in another engine's syntax, and don't write Chinese stage directions in there
- Each message has only one <语音> tag; the emotion attribute is optional — skip it if the emotion isn't strong
- The Chinese part and the <语音> part must express the same meaning` : '';
  return [coreContext, timeContext, callPrompt, voiceLangPrompt].filter(Boolean).join('\n\n');
};
const CallApp: React.FC = () => {
  const { closeApp, openApp, characters, activeCharacterId, addToast, apiConfig, userProfile, customThemes, suspendCall, suspendedCall, clearSuspendedCall, updateCharacter, characterGroups, groups, realtimeConfig, memoryPalaceConfig } = useOS();

  const [viewMode, setViewMode] = useState<ViewMode>('role-select');
  const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacterId || characters[0]?.id || '');
  const ROLES_PER_PAGE = 6;
  const [roleGroupId, setRoleGroupId] = useState<string>(GROUP_FILTER_ALL); // Group filter for the role-select page
  const [rolePage, setRolePage] = useState<number>(() => {
    const i = characters.findIndex(c => c.id === (activeCharacterId || characters[0]?.id));
    return i > 0 ? Math.floor(i / 6) : 0;
  });
  const [recordDetailId, setRecordDetailId] = useState<string>('');
  const [callState, setCallState] = useState<CallState>('idle');
  const [callMode, setCallMode] = useState<CallMode>(() => {
    try { return localStorage.getItem('sully-call-mode-v1') === 'video' ? 'video' : 'voice'; }
    catch { return 'voice'; }
  });
  const [callPreferences, setCallPreferences] = useState<CallPreferences>(loadCallPreferences);
  const [showCallPreferences, setShowCallPreferences] = useState(false);
  const [showCallUpdateAnnouncement, setShowCallUpdateAnnouncement] = useState(shouldShowCallUpdateAnnouncement);
  useEffect(() => saveCallPreferences(callPreferences), [callPreferences]);
  // The Call app's own independent light-theme preference (overrides the role-select/in-call/video/record pages)
  const [callTheme, setCallTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('sully-call-theme-v1') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  const lightTheme = callTheme === 'light';
  useEffect(() => {
    try { localStorage.setItem('sully-call-theme-v1', callTheme); } catch { /* localStorage may be unavailable */ }
  }, [callTheme]);
  const [avatarEmotion, setAvatarEmotion] = useState('calm');
  const [avatarPerformance, setAvatarPerformance] = useState<AvatarPerformanceDirection>(DEFAULT_AVATAR_PERFORMANCE);
  const [bubbles, setBubbles] = useState<CallBubble[]>([]);
  const [callRecords, setCallRecords] = useState<CallRecord[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => `call-${Date.now()}`);
  const [draftInput, setDraftInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const sttSessionRef = useRef<SttSession | null>(null);
  const sttSupported = useMemo(() => isSttSupported(), []);
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [traceId, setTraceId] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showInputPanel, setShowInputPanel] = useState(true);
  const [editingBubble, setEditingBubble] = useState<CallBubble | null>(null);
  const [editingText, setEditingText] = useState('');
  const [rerollingBubbleId, setRerollingBubbleId] = useState<string | null>(null);
  const [generatingAudioBubbleId, setGeneratingAudioBubbleId] = useState<string | null>(null);
  const [voiceFavoriteTarget, setVoiceFavoriteTarget] = useState<{ bubble: CallBubble; charId: string; charName: string } | null>(null);
  const [voiceFavoriteSaved, setVoiceFavoriteSaved] = useState(false);
  const [voiceFavoriteBusy, setVoiceFavoriteBusy] = useState(false);
  const [showHangupConfirm, setShowHangupConfirm] = useState(false);
  const [deleteConfirmRecord, setDeleteConfirmRecord] = useState<CallRecord | null>(null);
  const [voiceLang, setVoiceLang] = useState('');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [memoryPalaceStatus, setMemoryPalaceStatus] = useState('');
  const [showLive2DSettings, setShowLive2DSettings] = useState(false);
  const [live2DWardrobeOnboarding, setLive2DWardrobeOnboarding] = useState(false);
  const [showCallSetupGuide, setShowCallSetupGuide] = useState(false);
  const [callSetupGuideStep, setCallSetupGuideStep] = useState<CallSetupGuideStep>('model');
  const [setupCameraMode, setSetupCameraMode] = useState<UserCameraMode>('off');
  const [avatarImportStatus, setAvatarImportStatus] = useState('');
  const [pendingVRoidImport, setPendingVRoidImport] = useState<PendingVRoidImport | null>(null);
  const [vroidImportBusy, setVRoidImportBusy] = useState(false);
  // Active camera mode is intentionally never persisted: every new app session
  // starts private/off. Only the still-image token is remembered locally.
  const [userCameraMode, setUserCameraMode] = useState<UserCameraMode>('off');
  const [showUserCameraModePicker, setShowUserCameraModePicker] = useState(false);
  const [userCameraLoading, setUserCameraLoading] = useState(false);
  const [fakeUserCameraRef, setFakeUserCameraRef] = useState<string>(() => {
    try { return localStorage.getItem(FAKE_USER_CAMERA_IMAGE_KEY) || ''; }
    catch { return ''; }
  });
  const fakeUserCameraUrl = useBlobRefUrl(fakeUserCameraRef);
  const userCameraEnabled = userCameraMode === 'emotion' || userCameraMode === 'snapshot';
  const [detectedUserEmotion, setDetectedUserEmotion] = useState<(UserCameraEmotionResult & { nonce: number }) | null>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [bgUrlInput, setBgUrlInput] = useState('');
  const [videoCallLayout, setVideoCallLayout] = useState<VideoCallLayout>(loadVideoCallLayout);
  const [userCameraPreviewSize, setUserCameraPreviewSize] = useState<UserCameraPreviewSize>(loadUserCameraPreviewSize);
  const [videoTranscriptExpanded, setVideoTranscriptExpanded] = useState(false);
  // Keep one audio element alive across role picker / history / active call views.
  // iOS media permission can be element-scoped, so remounting a JSX audio node after
  // the user taps "Connect" would throw away the element that was just unlocked.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
  }
  const audioPrimingRef = useRef(false);
  const nativeCallAudioOnly = useMemo(() => shouldKeepNativeCallAudio(), []);
  const userCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const userCameraStreamRef = useRef<MediaStream | null>(null);
  const userCameraRequestRef = useRef(0);
  const detectedUserEmotionTimerRef = useRef<number | null>(null);
  const callSetupGuideOpenRef = useRef(false);
  useEffect(() => {
    callSetupGuideOpenRef.current = showCallSetupGuide;
  }, [showCallSetupGuide]);
  // Mouth-shape signal source: the stage canvas samples it frame-by-frame in its own
  // render loop, bypassing React state (the old pipeline's 80ms throttle + setState +
  // prop drilling always had the mouth shape lagging a beat behind the audio).
  const audioFeedRef = useRef<CallAudioFeed | null>(null);
  const getAudioFeed = () => {
    if (!audioFeedRef.current) audioFeedRef.current = new CallAudioFeed();
    return audioFeedRef.current;
  };
  const clearDetectedUserEmotion = () => {
    if (detectedUserEmotionTimerRef.current !== null) window.clearTimeout(detectedUserEmotionTimerRef.current);
    detectedUserEmotionTimerRef.current = null;
    setDetectedUserEmotion(null);
  };
  const revealDetectedUserEmotion = (result: UserCameraEmotionResult) => {
    clearDetectedUserEmotion();
    setDetectedUserEmotion({ ...result, nonce: Date.now() });
    detectedUserEmotionTimerRef.current = window.setTimeout(() => {
      setDetectedUserEmotion(null);
      detectedUserEmotionTimerRef.current = null;
    }, 2600);
  };
  const stopUserCamera = () => {
    userCameraRequestRef.current += 1;
    userCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    userCameraStreamRef.current = null;
    if (userCameraVideoRef.current) userCameraVideoRef.current.srcObject = null;
    setUserCameraMode('off');
    setUserCameraLoading(false);
    clearDetectedUserEmotion();
    releaseUserCameraEmotionDetector();
  };
  const startUserCamera = async (nextMode: Extract<UserCameraMode, 'emotion' | 'snapshot'>) => {
    if (userCameraLoading) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      addToast('This browser does not support the camera, or the page is not a secure connection', 'error');
      return;
    }
    const requestId = ++userCameraRequestRef.current;
    setUserCameraLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 15, max: 24 } },
        audio: false,
      });
      if (requestId !== userCameraRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('No available video track');
      track.addEventListener('ended', () => {
        if (userCameraStreamRef.current === stream) stopUserCamera();
      }, { once: true });
      userCameraStreamRef.current = stream;
      setUserCameraMode(nextMode);
      setShowUserCameraModePicker(false);
      if (nextMode === 'emotion') {
        void preloadUserCameraEmotionDetector().catch(error => {
          console.warn('[camera-emotion] local detector preload failed:', error);
          if (userCameraStreamRef.current === stream && stream.active) {
            addToast('Camera is on, but the local emotion detector failed to load; no detection result will be injected this turn', 'info');
          }
        });
      } else {
        releaseUserCameraEmotionDetector();
      }
    } catch (error: any) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
      addToast(denied ? 'Camera permission was not granted' : (error?.message || 'Failed to start the camera'), 'error');
      stopUserCamera();
    } finally {
      if (requestId === userCameraRequestRef.current) setUserCameraLoading(false);
    }
  };
  const chooseFakeUserCameraImage = (activate = true) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 12 * 1024 * 1024) {
          addToast('The still image is over 12 MB — please choose a smaller image', 'error');
          return;
        }
        const nextRef = await putImageBlob(file);
        const previous = fakeUserCameraRef;
        setFakeUserCameraRef(nextRef);
        if (activate) {
          stopUserCamera();
          setUserCameraMode('fake');
          setShowUserCameraModePicker(false);
        }
        try { localStorage.setItem(FAKE_USER_CAMERA_IMAGE_KEY, nextRef); } catch { /* private WebView */ }
        if (previous && previous !== nextRef) await deleteBlobRef(previous);
        addToast(activate ? 'Fake camera enabled; this image is for display only and will not be sent to the character' : 'Static shot is ready; it will only turn on once you confirm and connect', 'success');
      } catch (error: any) {
        addToast(error?.message || 'Failed to import the still image', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };
  const removeFakeUserCameraImage = async () => {
    const previous = fakeUserCameraRef;
    setFakeUserCameraRef('');
    try { localStorage.removeItem(FAKE_USER_CAMERA_IMAGE_KEY); } catch { /* private WebView */ }
    if (userCameraMode === 'fake') setUserCameraMode('off');
    if (previous) await deleteBlobRef(previous);
    addToast('Fake camera image removed', 'success');
  };
  const selectUserCameraMode = (nextMode: UserCameraMode) => {
    trackEvent('Select User Camera Mode', {
      Mode: nextMode === 'off'
        ? 'Off'
        : nextMode === 'fake' ? 'Fake Camera' : nextMode === 'emotion' ? 'Local Emotion' : 'Snapshot per Turn',
    });
    if (nextMode === 'off') {
      stopUserCamera();
      setShowUserCameraModePicker(false);
      return;
    }
    if (nextMode === 'fake') {
      if (!fakeUserCameraRef) return chooseFakeUserCameraImage();
      stopUserCamera();
      setUserCameraMode('fake');
      setShowUserCameraModePicker(false);
      return;
    }
    const stream = userCameraStreamRef.current;
    if (stream?.active) {
      clearDetectedUserEmotion();
      setUserCameraMode(nextMode);
      setShowUserCameraModePicker(false);
      if (nextMode === 'emotion') {
        void preloadUserCameraEmotionDetector().catch(error => {
          console.warn('[camera-emotion] local detector preload failed:', error);
          addToast('The local emotion detector failed to load; the camera feed still works', 'info');
        });
      } else {
        releaseUserCameraEmotionDetector();
      }
      return;
    }
    void startUserCamera(nextMode);
  };
  const captureUserCameraEmotionContext = async (): Promise<string> => {
    const stream = userCameraStreamRef.current;
    const video = userCameraVideoRef.current;
    if (userCameraMode !== 'emotion' || !stream?.active || !video) return '';
    try {
      const result = await detectUserCameraEmotion(video);
      // Camera may have been turned off while the three-frame sample was running.
      if (!result || !userCameraStreamRef.current?.active || userCameraMode !== 'emotion') return '';
      revealDetectedUserEmotion(result);
      return buildUserCameraEmotionPrompt(result);
    } catch (error) {
      console.warn('[camera-emotion] local sample skipped:', error);
      return '';
    }
  };
  const captureUserCameraSnapshotContext = (): string => {
    const stream = userCameraStreamRef.current;
    const video = userCameraVideoRef.current;
    if (userCameraMode !== 'snapshot' || !stream?.active || !video) return '';
    try {
      return captureUserCameraSnapshot(video) || '';
    } catch (error) {
      console.warn('[camera-snapshot] frame skipped:', error);
      return '';
    }
  };
  useEffect(() => {
    const video = userCameraVideoRef.current;
    const stream = userCameraStreamRef.current;
    if (!video || !userCameraEnabled || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => { /* muted inline preview can retry after the next user gesture */ });
  }, [userCameraEnabled, userCameraMode]);
  useEffect(() => {
    if (viewMode === 'in-call' && callMode === 'video') return;
    if (userCameraMode !== 'off' || userCameraLoading) stopUserCamera();
    setShowUserCameraModePicker(false);
  }, [viewMode, callMode]);
  useEffect(() => () => {
    userCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    releaseUserCameraEmotionDetector();
    if (detectedUserEmotionTimerRef.current !== null) window.clearTimeout(detectedUserEmotionTimerRef.current);
  }, []);
  const chooseVideoCallLayout = (layout: VideoCallLayout) => {
    setVideoCallLayout(layout);
    if (layout !== 'stage') setVideoTranscriptExpanded(false);
    try { localStorage.setItem(VIDEO_CALL_LAYOUT_KEY, layout); } catch { /* private WebView */ }
  };
  const chooseUserCameraPreviewSize = (size: UserCameraPreviewSize) => {
    setUserCameraPreviewSize(size);
    try { localStorage.setItem(USER_CAMERA_PREVIEW_SIZE_KEY, size); } catch { /* private WebView */ }
  };
  // All blob: URLs created this call session. Kept alive so Replay/Download work on every
  // bubble; revoked together only when leaving/resetting the call (not per-turn).
  const sessionBlobUrlsRef = useRef<Set<string>>(new Set());
  const trackBlobUrl = (url?: string) => { if (url && url.startsWith('blob:')) sessionBlobUrlsRef.current.add(url); };
  const revokeSessionBlobs = () => {
    sessionBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
    sessionBlobUrlsRef.current.clear();
  };
  const longPressTimerRef = useRef<number | null>(null);
  const callLongPressTriggeredRef = useRef(false);
  const callTouchStartPos = useRef({ x: 0, y: 0 });
  const idleNudgeCountRef = useRef(0);
  // The VRM model's custom expression names (reported back by the canvas on load), fed to either the basic model or the high-quality director.
  const vrmExpressionsRef = useRef<string[]>([]);
  const selectedChar = useMemo(() => characters.find(c => c.id === selectedCharId) || null, [characters, selectedCharId]);
  const selectedVisualSource = companionAvatarSource(selectedChar);
  const selectedDateOutfits = useMemo(() => listCompanionDateOutfits(selectedChar), [selectedChar]);
  const selectedDateOutfitId = normalizeCompanionSkinSetId(selectedChar?.companionAvatar?.skinSetId);
  const selectedDateOutfit = selectedDateOutfits.find(outfit => outfit.id === selectedDateOutfitId) || selectedDateOutfits[0];
  const staticVideoAvatarActive = selectedVisualSource === 'upload' || selectedVisualSource === 'date';
  const staticVideoPortrait = selectedChar && staticVideoAvatarActive
    ? resolveCompanionPortrait(selectedChar, avatarPerformance.emotion, avatarPerformance.faces || [])
    : undefined;
  const staticVideoExpressionKey = companionExpressionKey(avatarPerformance.emotion, avatarPerformance.faces || []);
  const hasSelectedVideoVisual = selectedVisualSource === 'model'
    ? Boolean(selectedChar?.videoAvatar)
    : selectedVisualSource === 'upload'
      ? Boolean(selectedChar?.companionAvatar?.imageRef)
      : hasDatePortraits(selectedChar);
  // Calls and regular chat share the same cloud snapshot for Proactive Messages. Every
  // persist point marks state dirty, and a microtask coalesces multiple calls within the
  // same turn — this way, even if the user closes the app right after a call, the
  // character won't miss what just happened.
  const markCallTurnDirty = () => {
    if (!selectedChar) return;
    markAmsgStateDirty({ char: selectedChar, userProfile, groups, realtimeConfig });
  };
  const selectedAvatar = selectedChar?.videoAvatar;
  const selectedBuiltinSullyAvatar = isBuiltinSullyLive2D(selectedAvatar) ? selectedAvatar : null;
  // The short "performance persona" for high-quality video calls: distilled from the full
  // ContextBuilder only once per character. The Map lets the same turn immediately reuse a
  // persona that was just generated but hasn't hit React state yet; the Promise Map keeps
  // the opening-line request and the prewarm effect from both firing it twice at once.
  const performancePersonaCacheRef = useRef<Map<string, string>>(new Map());
  const performancePersonaPromiseRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const performancePersonaAttemptedRef = useRef<Set<string>>(new Set());
  const avatarTouchLastAtRef = useRef(0);
  const pendingAvatarTouchesRef = useRef<AvatarTouchRecord[]>([]);
  const [pendingAvatarTouchCount, setPendingAvatarTouchCount] = useState(0);
  const [avatarTouchEffects, setAvatarTouchEffects] = useState<AvatarTouchEffect[]>([]);
  const avatarTouchEffectTimersRef = useRef<number[]>([]);
  const [voiceAvatarPokeNonce, setVoiceAvatarPokeNonce] = useState(0);
  const voiceAvatarPointerRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startedAt: number;
    maxDistance: number;
  } | null>(null);
  // Prefetch TTS the moment the main reply lands, so it runs in parallel with the
  // high-quality action director; the caller claims it later by the same text.
  const prefetchedCallAudioRef = useRef<Map<string, Promise<{ url: string; traceIds: string[] }>>>(new Map());
  // The Memory Palace post-flow needs the character's latest state (it runs async, and a closure would go stale)
  const charactersRef = useRef(characters);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  // Waterline cleanup after a call turn (same pipeline as Chat/Date; the global
  // "organizing memories..." toast is broadcast by the pipeline and shown centrally by
  // OSContext — this only handles the completion/failure feedback here).
  const runCallMemoryPalaceHook = (char: CharacterProfile) => {
    let lastStatus = '';
    void runCallMemoryPalacePostFlow({
      char,
      getLiveChar: () => charactersRef.current.find(c => c.id === char.id) || null,
      memoryPalaceConfig,
      apiConfig,
      userName: userProfile?.name,
      updateCharacter,
      onStatus: text => { lastStatus = text; setMemoryPalaceStatus(text); },
    }).then(() => {
      // NOTE: lastStatus comes from out-of-scope utils/memoryPalace/callPostFlow.ts,
      // which still reports its stages in Chinese — '完成' ("done/complete") must stay
      // untranslated here or this success-toast detection will silently break.
      if (lastStatus.includes('完成')) addToast(lastStatus, 'success');
    }).catch(e => {
      console.error('❌ [CallApp MemoryPalace] background processing error:', e?.message || e);
      addToast('Failed to organize memory', 'error');
    }).finally(() => setMemoryPalaceStatus(''));
  };
  const recordDetail = useMemo(() => callRecords.find(r => r.id === recordDetailId) || null, [callRecords, recordDetailId]);
  useEffect(() => {
    try { localStorage.setItem('sully-call-mode-v1', callMode); } catch { /* localStorage may be unavailable */ }
  }, [callMode]);

  useEffect(() => {
    // The analyser is a video-only enhancement. Voice calls stay entirely on the
    // browser's native audio path, and iOS always uses the synthetic lip fallback.
    audioFeedRef.current?.setActive(callMode === 'video' && isAudioPlaying);
  }, [callMode, isAudioPlaying]);

  useEffect(() => () => {
    audioFeedRef.current?.dispose();
    audioFeedRef.current = null;
  }, []);

  const bindVideoAvatar = (character: CharacterProfile, videoAvatar: NonNullable<CharacterProfile['videoAvatar']>) => {
    const previous = character.videoAvatar;
    const modelPatch = previous?.format === videoAvatar.format
      ? addCompanionModelOutfit(character, videoAvatar)
      : {
          videoAvatar,
          videoAvatarWardrobe: (character.videoAvatarWardrobe || []).filter(model => model.format === videoAvatar.format),
        };
    updateCharacter(character.id, {
      ...modelPatch,
      companionAvatar: {
        version: 1,
        ...character.companionAvatar,
        source: 'model',
      },
    });
    setCallMode('video');
    if (videoAvatar.format === 'live2d') {
      setLive2DWardrobeOnboarding(true);
      setShowLive2DSettings(true);
    }
    if (callSetupGuideOpenRef.current) setCallSetupGuideStep('camera');
    addToast(
      videoAvatar.format === 'live2d'
        ? `${videoAvatar.fileName} imported: please mark which button actions are outfit changes`
        : `${videoAvatar.fileName} has been bound to ${character.name}`,
      'success',
    );
    if (previous?.assetId !== videoAvatar.assetId && previous?.format !== videoAvatar.format) {
      void deleteAvatarModel(previous).catch(() => { /* orphan GC can clean later */ });
    }
  };

  const chooseStaticAvatarImage = () => {
    if (!selectedChar) {
      addToast('Select a character first', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.gif,image/png,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['png', 'gif'].includes(extension || '') || !['image/png', 'image/gif'].includes(file.type)) {
        addToast('Static avatars only support PNG / GIF', 'error');
        return removeInput();
      }
      if (file.size > 20 * 1024 * 1024) {
        addToast('The image is over 20 MB — please compress it before importing', 'error');
        return removeInput();
      }
      try {
        const imageRef = await putImageBlob(file);
        updateCharacter(character.id, {
          companionAvatar: addUploadedCompanionOutfit(character.companionAvatar, {
            id: imageRef,
            imageRef,
            fileName: file.name,
            mimeType: file.type,
            importedAt: Date.now(),
          }),
        });
        setCallMode('video');
        if (callSetupGuideOpenRef.current) setCallSetupGuideStep('camera');
        trackEvent('Import Desktop Static Avatar', { Format: file.type === 'image/gif' ? 'GIF' : 'PNG' });
        addToast(`${file.name} has been set as the desktop and video call avatar`, 'success');
      } catch (error: any) {
        addToast(error?.message || 'Failed to import the static avatar', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };

  const chooseVideoAvatarSource = (source: CompanionAvatarSource) => {
    if (!selectedChar) return;
    if (source === 'model' && !selectedChar.videoAvatar) {
      chooseAvatarModel();
      return;
    }
    if (source === 'upload' && !selectedChar.companionAvatar?.imageRef) {
      chooseStaticAvatarImage();
      return;
    }
    if (source === 'date' && !hasDatePortraits(selectedChar)) {
      addToast('No Date portraits yet — go to Date mode first to fill out a set of expressions', 'info');
      openApp(AppID.Date);
      return;
    }
    updateCharacter(selectedChar.id, {
      companionAvatar: {
        version: 1,
        ...selectedChar.companionAvatar,
        source,
      },
    });
    setCallMode('video');
    addToast(source === 'model' ? 'Video calls now use the animated model' : source === 'date' ? 'Video calls now reuse the Date portrait' : 'Video calls now use the static image', 'success');
  };

  const chooseBuiltinSullyQuality = (quality: BuiltinSullyLive2DQuality) => {
    if (!selectedChar || !selectedBuiltinSullyAvatar || selectedBuiltinSullyAvatar.builtinQuality === quality) return;
    updateCharacter(selectedChar.id, { videoAvatar: setBuiltinSullyLive2DQuality(selectedBuiltinSullyAvatar, quality) });
    addToast(quality === 'hd' ? 'Switched to Sully HD 4K; VRAM usage will noticeably increase' : 'Switched back to Sully Lightweight 2K', quality === 'hd' ? 'info' : 'success');
  };

  // The old version left actions whose emotion couldn't be guessed from the filename as
  // "manual only." After the upgrade, safe native model expressions/actions are added to
  // the director's action library automatically; actions the user explicitly disabled or
  // manually tagged, custom-parameter actions, and Idle are all left as-is.
  useEffect(() => {
    const avatar = selectedChar?.videoAvatar;
    if (!selectedChar || avatar?.format !== 'live2d' || avatar.actionPolicyVersion === 2) return;
    updateCharacter(selectedChar.id, { videoAvatar: upgradeLive2DAutoPermissions(avatar) });
  }, [selectedChar?.id, selectedChar?.videoAvatar, updateCharacter]);

  // Use the time spent on the role picker to read the package and decode its
  // texture blobs. Cubism/Pixi construction remains deferred to the actual
  // stage so browsing characters does not retain multiple GPU-heavy models.
  useEffect(() => {
    const avatar = selectedChar?.videoAvatar;
    if (viewMode !== 'role-select' || callMode !== 'video' || selectedVisualSource !== 'model' || avatar?.format !== 'live2d') return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        preloadLive2DRuntime(),
        prewarmLive2DModelSource(avatar),
      ]).catch(error => {
        console.warn('[live2d] role-picker prewarm skipped:', error);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [viewMode, callMode, selectedChar?.id, selectedChar?.videoAvatar?.assetId, selectedVisualSource]);

  const chooseAvatarModel = () => {
    if (!selectedChar) {
      addToast('Select a character first', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vrm,.vroid,.zip,model/gltf-binary,application/zip';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      // There are five possible outcomes once a file is picked; in the past there was
      // only a toast, so "how many people get stuck at this import step" was a blank in
      // the data. Both paths share one catch block, so the source is pinned down by
      // extension first, letting an error be traced back to which path failed.
      // Source and Result are both fixed literals defined right here — neither the
      // filename nor the raw error text is ever included.
      const source = /\.zip$/i.test(file.name) ? 'Live2D ZIP' : 'VRM';
      try {
        if (/\.zip$/i.test(file.name)) {
          if (file.size > 200 * 1024 * 1024) {
            trackEvent('Import Call Avatar', { Source: source, Result: 'Size Exceeded' });
            addToast('The Live2D ZIP is over 200 MB — mobile devices likely cannot unzip and load it reliably', 'error');
            return;
          }
          void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
          setAvatarImportStatus('Opening the Live2D ZIP, please wait...');
          bindVideoAvatar(character, await saveLive2DModelFromZip(file, setAvatarImportStatus));
          trackEvent('Import Call Avatar', { Source: source, Result: 'Success' });
          return;
        }
        setAvatarImportStatus('Checking the VRM model...');
        const inspection = await inspectAvatarFile(file);
        if (inspection.kind === 'vroid-project') {
          // A .vroid project file only pops up an explainer and doesn't import — that's
          // a different case from "the file is broken," so it gets its own bucket.
          trackEvent('Import Call Avatar', { Source: source, Result: 'Must Export VRM First' });
          setPendingVRoidImport({ file, characterId: character.id, projectFile: true });
          return;
        }
        if (inspection.kind === 'unsupported') {
          trackEvent('Import Call Avatar', { Source: source, Result: 'Unsupported Format' });
          addToast(inspection.reason, 'error');
          return;
        }
        if (file.size > 80 * 1024 * 1024) {
          trackEvent('Import Call Avatar', { Source: source, Result: 'Size Exceeded' });
          addToast('The model is over 80 MB — mobile calls may not load it reliably, please reduce the texture size when exporting', 'error');
          return;
        }
        // The VRM has only passed inspection at this point; it's actually persisted after
        // the beta notice is confirmed, and success/failure is recorded by confirmVRoidImport.
        setPendingVRoidImport({ file, characterId: character.id, projectFile: false });
      } catch (error: any) {
        trackEvent('Import Call Avatar', { Source: source, Result: 'Failed' });
        addToast(error?.message || 'Failed to import the model', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };

  const confirmVRoidImport = async () => {
    const pending = pendingVRoidImport;
    if (!pending || pending.projectFile || vroidImportBusy) return;
    const character = charactersRef.current.find(item => item.id === pending.characterId);
    if (!character) {
      setPendingVRoidImport(null);
      addToast('The original character no longer exists — import canceled', 'error');
      return;
    }
    setVRoidImportBusy(true);
    setAvatarImportStatus('Saving the VRM test model...');
    try {
      const videoAvatar = await saveAvatarModel(pending.file);
      bindVideoAvatar(character, videoAvatar);
      trackEvent('Import Call Avatar', { Source: 'VRM', Result: 'Success' });
      setPendingVRoidImport(null);
    } catch (error: any) {
      trackEvent('Import Call Avatar', { Source: 'VRM', Result: 'Failed' });
      addToast(error?.message || 'Failed to import the VRM test model; the original model was not overwritten', 'error');
    } finally {
      setAvatarImportStatus('');
      setVRoidImportBusy(false);
    }
  };

  const chooseLive2DDirectory = () => {
    if (!selectedChar) {
      addToast('Select a character first', 'info');
      return;
    }
    void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return removeInput();
      try {
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        if (totalSize > 250 * 1024 * 1024) {
          trackEvent('Import Call Avatar', { Source: 'Live2D Folder', Result: 'Size Exceeded' });
          addToast('The Live2D folder is over 250 MB — please compress the texture size or remove unrelated files first', 'error');
          return;
        }
        setAvatarImportStatus(`Selected ${files.length} files, scanning the model...`);
        bindVideoAvatar(character, await saveLive2DModelFromFiles(files, setAvatarImportStatus));
        trackEvent('Import Call Avatar', { Source: 'Live2D Folder', Result: 'Success' });
      } catch (error: any) {
        trackEvent('Import Call Avatar', { Source: 'Live2D Folder', Result: 'Failed' });
        addToast(error?.message || 'Failed to import the Live2D folder', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };
  // Extract an accent color from the character's chat theme, used for buttons and highlights in the call UI
  const accentColor = useMemo(() => {
    const themeId = selectedChar?.bubbleStyle || 'default';
    const theme: ChatTheme | undefined = customThemes?.find((t: ChatTheme) => t.id === themeId) || PRESET_THEMES[themeId];
    const raw = (theme?.user?.backgroundColor || '#8b5cf6').trim();
    // The call UI relies on accent for glow/outline/halo effects — a theme color that's too
    // dark (e.g. pure black) would make all of these "disappear" and leave buttons without a
    // nice edge. This sets a minimum-brightness fallback: too dark falls back to bright
    // purple, so every character still has visible edges.
    const m = /^#?([0-9a-f]{6})$/i.exec(raw) || /^#?([0-9a-f]{3})$/i.exec(raw);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 90) return '#a78bfa';
    }
    return raw;
  }, [selectedChar?.bubbleStyle, customThemes]);
  const callScrollableRef = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  // The input panel is expanded by default, but the input box must not auto-focus when
  // "entering a call" — on mobile, focusing it pops the keyboard and pushes the whole UI
  // up (a user-reported "the screen flies up the moment I enter a call" issue). Only
  // focus it when the user manually expands the panel afterward; skip it on first mount.
  const inputPanelMountedRef = useRef(false);
  // Restore this character's remembered translation language whenever the selection changes.
  useEffect(() => {
    setVoiceLang(selectedChar?.callVoiceLang || '');
  }, [selectedCharId]);
  const resolveVoiceId = () => selectedChar?.voiceProfile?.voiceId?.trim() || '';
  const resolveGroupId = () => (apiConfig.minimaxGroupId || '').trim();
  // ── TTS provider dispatch: MiniMax keeps the call-specific chunked-synthesis fallback; Fish / ElevenLabs go through the shared adapter. ──
  const activeTtsProvider = resolveTtsProvider(apiConfig);
  // Whether this character can synthesize speech under the current provider (decides whether to run TTS / show a "voice not configured" hint).
  const hasConfiguredVoice = (): boolean => {
    return !!selectedChar && canSynthesizeSpeech(selectedChar, apiConfig);
  };
  const canSpeakVoice = (): boolean => isSpeakerOn && hasConfiguredVoice();
  // ── Unified call-audio synthesis entry point: opening line / normal turn / reroll / proactive speaking all share this ──
  // MiniMax: cache hit → single-shot synthesis → chunked fallback on failure; Fish / ElevenLabs: synthesize directly via the shared router.
  // Throwing or returning an empty url both mean there's no playable audio; the caller falls back to text-only.
  const synthesizeCallAudioUrl = async (rawText: string, emotion?: string): Promise<{ url: string; traceIds: string[] }> => {
    if (activeTtsProvider !== 'minimax') {
      if (!selectedChar) throw new Error('No character selected');
      const { url } = await synthesizeSpeechRoutedDetailed(rawText, selectedChar, apiConfig, {
        languageBoost: voiceLang || undefined,
        emotion,
      });
      return { url: url || '', traceIds: [] };
    }
    const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
    const voiceId = resolveVoiceId();
    const groupId = resolveGroupId();
    const voiceProfile = selectedChar?.voiceProfile;
    const paramVersion = getMiniMaxParamVersion(voiceProfile);
    const speechText = prepareMiniMaxSpeechText(cleanTextForTts(rawText), voiceProfile);
    const model = voiceProfile?.model?.trim() || 'speech-2.8-hd';
    if (!speechText.trim()) throw new Error('The text to read aloud is empty');

    const synthesizeChunk = async (chunk: string, idx = 0, total = 1): Promise<{ blob?: Blob; remoteUrl?: string; traceId: string }> => {
      const ttsPayload = buildMiniMaxTtsPayload(chunk, voiceProfile, {
        voiceId,
        model,
        emotion,
        languageBoost: voiceLang || undefined,
        groupId: groupId || undefined,
        legacyTransport: 'call',
        textAlreadyPrepared: true,
      });

      const chunkCacheKey = buildMiniMaxTtsCacheKey(ttsPayload, paramVersion);
      const cachedChunk = await getCachedTts(chunkCacheKey);
      if (cachedChunk) {
        return { blob: cachedChunk, traceId: 'cache' };
      }

      const response = await minimaxFetch('/api/minimax/t2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${minimaxApiKey}`,
          'X-MiniMax-API-Key': minimaxApiKey,
          ...(groupId ? { 'X-MiniMax-Group-Id': groupId } : {}),
        },
        body: JSON.stringify(ttsPayload),
      });
      const data = await response.json();
      const statusCode = data?.base_resp?.status_code;
      if (!response.ok || (typeof statusCode === 'number' && statusCode !== 0)) {
        throw new Error(buildMiniMaxErrorMessage(data?.base_resp?.status_msg || `Call failed (HTTP ${response.status})`, data?.trace_id));
      }

      const rawAudio = data?.data?.audio;
      if (!rawAudio || typeof rawAudio !== 'string') throw new Error('No audio data in the API response');
      const normalizedAudio = rawAudio.trim();
      const traceId = data?.trace_id || '';
      console.log('[call] tts chunk response', {
        chunk_index: idx,
        chunk_count: total,
        chunk_length: chunk.length,
        trace_id: traceId,
        audio_type: typeof data?.data?.audio,
        audio_preview: normalizedAudio.slice(0, 80),
      });

      if (/^https?:\/\//i.test(normalizedAudio)) {
        try {
          const blob = await fetchRemoteAudioBlob(normalizedAudio);
          saveCachedTts(chunkCacheKey, blob).catch(() => { /* ignore */ });
          return { blob, traceId };
        } catch (downloadErr: any) {
          if (total === 1) {
            console.warn('[call] tts remote audio fetch failed, fallback to direct remote url', downloadErr?.message || downloadErr);
            return { remoteUrl: normalizedAudio, traceId };
          }
          throw downloadErr;
        }
      }
      const blob = convertHexAudioToBlob(normalizedAudio, 'audio/mpeg');
      saveCachedTts(chunkCacheKey, blob).catch(() => { /* ignore */ });
      return { blob, traceId };
    };

    const traceIds: string[] = [];
    const audioBlobs: Blob[] = [];
    let finalUrl = '';

    console.log('[call] tts request(full)', {
      model,
      voice_id: voiceId,
      group_id: groupId,
      param_version: paramVersion,
      assistant_text_length: rawText.length,
      speech_text_length: speechText.length,
      speech_text_preview: speechText.slice(0, 120),
    });

    try {
      const singleResult = await synthesizeChunk(speechText, 0, 1);
      if (singleResult.traceId) traceIds.push(singleResult.traceId);
      if (singleResult.remoteUrl) {
        finalUrl = singleResult.remoteUrl;
      } else if (singleResult.blob) {
        finalUrl = URL.createObjectURL(singleResult.blob);
      } else {
        throw new Error('No playable audio was obtained');
      }
    } catch (singleErr: any) {
      const textChunks = splitTextForTts(speechText, 120);
      if (!textChunks.length) throw singleErr;
      if (textChunks.length > 1) addToast('Generating voice, one moment', 'info');
      if (textChunks.length > 20) addToast('This line is fairly long, please wait a bit longer', 'info');
      console.warn('[call] tts single-shot failed, fallback to chunk mode', singleErr?.message || singleErr);

      for (let idx = 0; idx < textChunks.length; idx += 1) {
        const result = await synthesizeChunk(textChunks[idx], idx, textChunks.length);
        if (result.traceId) traceIds.push(result.traceId);
        if (result.remoteUrl) {
          finalUrl = result.remoteUrl;
          break;
        }
        if (result.blob) audioBlobs.push(result.blob);
      }
      if (!finalUrl) {
        if (!audioBlobs.length) throw new Error('No playable audio was obtained');
        finalUrl = URL.createObjectURL(audioBlobs.length === 1 ? audioBlobs[0] : new Blob(audioBlobs, { type: 'audio/mpeg' }));
      }
    }

    console.log('[call] tts response merged', {
      trace_ids: traceIds,
      playback_url_type: finalUrl.startsWith('blob:') ? 'blob' : 'remote',
    });
    return { url: finalUrl, traceIds };
  };
  const callAudioPrefetchKey = (rawText: string, emotion?: string) => `${emotion || ''}\u0000${rawText}`;
  const prefetchCallAudio = (rawText: string, emotion?: string) => {
    if (!callPreferences.voiceAutoPlay || !canSpeakVoice()) return;
    const key = callAudioPrefetchKey(rawText, emotion);
    if (prefetchedCallAudioRef.current.has(key)) return;
    // A call normally has one pending reply. Bound the map defensively so abandoned
    // rerolls/errors cannot retain promises for the whole app lifetime.
    if (prefetchedCallAudioRef.current.size >= 8) {
      const oldestKey = prefetchedCallAudioRef.current.keys().next().value;
      if (oldestKey) prefetchedCallAudioRef.current.delete(oldestKey);
    }
    const promise = synthesizeCallAudioUrl(rawText, emotion).then(result => {
      trackBlobUrl(result.url);
      return result;
    });
    // Attach a rejection observer immediately: the director may take longer than a
    // failed TTS request, but the caller will still receive the original rejection.
    void promise.catch(() => undefined);
    prefetchedCallAudioRef.current.set(key, promise);
  };
  const takeOrSynthesizeCallAudio = (rawText: string, emotion?: string) => {
    const key = callAudioPrefetchKey(rawText, emotion);
    const prefetched = prefetchedCallAudioRef.current.get(key);
    if (!prefetched) return synthesizeCallAudioUrl(rawText, emotion);
    prefetchedCallAudioRef.current.delete(key);
    return prefetched;
  };
  // Keyboard avoidance is handled entirely by the global mechanism: index.html's
  // meta interactive-widget=resizes-content shrinks the viewport and reflows the layout
  // automatically when the soft keyboard opens; on iOS fullscreen PWA, utils/iosStandalone.ts
  // makes the app height follow the viewport instead. CallApp no longer does its own
  // paddingBottom / window.scrollTo fallback — that custom logic used to stack with the
  // global reflow and push the whole UI up on Chrome/Edge with no way back down
  // (Chat and the other apps never did this, so they never had this bug).
  // Resume from suspended call — restore bubbles & session state
  useEffect(() => {
    if (suspendedCall && viewMode === 'role-select') {
      setSelectedCharId(suspendedCall.charId);
      setCallStartedAt(suspendedCall.startedAt);
      if (suspendedCall.bubbles?.length) {
        setBubbles(suspendedCall.bubbles);
        const lastPerformance = [...suspendedCall.bubbles].reverse().find((bubble: CallBubble) => bubble.performance)?.performance;
        if (lastPerformance) {
          setAvatarPerformance(lastPerformance);
          setAvatarEmotion(lastPerformance.emotion);
        }
      }
      if (suspendedCall.sessionId) setCurrentSessionId(suspendedCall.sessionId);
      if (typeof suspendedCall.elapsedSeconds === 'number') setElapsedSeconds(suspendedCall.elapsedSeconds);
      if (suspendedCall.voiceLang) setVoiceLang(suspendedCall.voiceLang);
      const restoredTouches = suspendedCall.pendingAvatarTouches?.slice(-20) || [];
      pendingAvatarTouchesRef.current = restoredTouches;
      setPendingAvatarTouchCount(restoredTouches.length);
      setViewMode('in-call');
      setCallState('listening');
      clearSuspendedCall();
    }
  }, [suspendedCall]);
  useEffect(() => () => {
    revokeSessionBlobs();
    sttSessionRef.current?.stop();
  }, []);
  // Voice input: toggle speech-to-text into the draft input box.
  const toggleStt = async () => {
    if (isListening) { sttSessionRef.current?.stop(); trackEvent('Toggle Voice Input', { action: 'stop' }); return; }
    if (!sttSupported) { addToast('Voice input is not supported in this environment', 'info'); return; }
    try {
      setIsListening(true);
      trackEvent('Toggle Voice Input', { action: 'start' });
      // NOTE: hardcoded to 'zh-CN' on purpose — this is the browser/native speech-recognition
      // language the microphone listens for, not a display-locale setting, and it's
      // independent of the character's configured TTS output language (see
      // utils/speechToText.ts's own comment). Left as-is; changing it would alter what
      // language voice input actually transcribes, not just UI wording.
      sttSessionRef.current = await startStt('zh-CN', {
        onPartial: (t) => setDraftInput(t),
        onFinal: (t) => setDraftInput(t),
        onError: (m) => { if (m) addToast(m, 'info'); },
        onEnd: () => { setIsListening(false); sttSessionRef.current = null; },
      });
    } catch (e: any) {
      setIsListening(false);
      sttSessionRef.current = null;
      addToast(e?.message || 'Failed to start voice input', 'error');
    }
  };
  // Download a call audio clip: on mobile, prefer the system share/save sheet, since a WebView's <a download> can silently fail while appearing to succeed.
  const handleDownloadCallAudio = async (url?: string, ts?: number) => {
    if (!url) { addToast('There is no audio for this line yet', 'error'); return; }
    try {
      const fname = `${(selectedChar?.name || 'Call').replace(/[\\/:*?"<>|]/g, '_')}_Audio_${ts || Date.now()}.mp3`;
      const blob = await fetchBlobForShare(url, 'audio/mpeg');
      const result = await shareOrDownloadBlob({ blob, fileName: fname, shareTitle: `${selectedChar?.name || 'Call'}'s voice` });
      if (result === 'cancelled') return;
      addToast(result === 'shared' ? 'Opened the system save/share sheet' : 'The audio has started downloading', 'success');
      trackEvent('Download a Call Voice Clip');
    } catch (error) {
      console.error('[Call] download audio failed', error);
      addToast('The audio file has expired or could not be read — please regenerate it before downloading', 'error');
    }
  };
  useEffect(() => {
    if (!callStartedAt || ['idle', 'ended'].includes(callState)) return;
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, callState]);
  useEffect(() => {
    callScrollableRef.current?.scrollTo({ top: callScrollableRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles]);
  useEffect(() => {
    // Skip the auto-focus on first mount, to avoid the keyboard flinging the UI off-screen when entering a call; only focus after the user manually expands it afterward.
    if (!inputPanelMountedRef.current) { inputPanelMountedRef.current = true; return; }
    if (showInputPanel) draftInputRef.current?.focus();
  }, [showInputPanel]);
  const stopPlayback = () => {
    clearSilentSpeechTimer();
    clearPerformanceCueTimers();
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setIsAudioPlaying(false);
  };
  const loadCallRecords = async (charId?: string) => {
    if (!charId) return setCallRecords([]);
    // includeProcessed=true: call messages and chat messages live in the same store, and
    // once Memory Palace processes them it advances the high-watermark marker
    // mp_lastMsgId_<charId>; the default getMessagesByCharId filters out anything before
    // the watermark — which would make call records look "wiped" after further chatting.
    // All messages must be read here.
    const all = await DB.getMessagesByCharId(charId, true);
    const callMsgs = all
      .filter(m => m.metadata?.source === 'call' && m.metadata?.callSessionId)
      .sort((a, b) => a.timestamp - b.timestamp);
    const callEnds = new Map<string, Message>();
    all.forEach(message => {
      if (message.metadata?.source !== 'call-end-popup' || !message.metadata?.callSessionId) return;
      callEnds.set(String(message.metadata.callSessionId), message);
    });
    const grouped = new Map<string, Message[]>();
    callMsgs.forEach(m => {
      const sid = String(m.metadata?.callSessionId);
      const arr = grouped.get(sid) || [];
      arr.push(m);
      grouped.set(sid, arr);
    });
    const records: CallRecord[] = Array.from(grouped.entries()).map(([sessionId, msgs]) => {
      const start = msgs[0]?.timestamp || Date.now();
      const end = msgs[msgs.length - 1]?.timestamp || start;
      const endMarker = callEnds.get(sessionId);
      const savedDuration = Number(endMarker?.metadata?.durationSec);
      const savedMode = endMarker?.metadata?.callMode
        || msgs.find(message => message.metadata?.callMode)?.metadata?.callMode;
      return {
        id: sessionId,
        sessionId,
        characterId: charId,
        characterName: selectedChar?.name || 'No character selected',
        createdAt: new Date(start).toLocaleString('en-US'),
        durationSec: Number.isFinite(savedDuration)
          ? Math.max(1, Math.floor(savedDuration))
          : Math.max(1, Math.floor((end - start) / 1000)),
        mode: savedMode === 'voice' || savedMode === 'video' ? savedMode : undefined,
        transcript: msgs.map(m => ({
          id: `db-${m.id}`,
          dbId: m.id,
          role: m.role as 'user' | 'assistant',
          text: m.content,
          audioUrl: m.metadata?.audioUrl,
          thinkingChain: typeof m.metadata?.thinkingChain === 'string' ? m.metadata.thinkingChain : undefined,
          performance: m.metadata?.avatarPerformance as AvatarPerformanceDirection | undefined,
          performanceTimeline: m.metadata?.avatarPerformanceCues as AvatarPerformanceCue[] | undefined,
          cameraSnapshotRef: typeof m.metadata?.cameraSnapshotRef === 'string' && m.metadata.cameraSnapshotRef
            ? m.metadata.cameraSnapshotRef
            : undefined,
          cameraSnapshotExpired: m.metadata?.cameraSnapshotExpired === true,
          time: formatTimeByTs(m.timestamp),
          timestamp: m.timestamp,
        })),
      };
    }).sort((a, b) => (b.transcript[b.transcript.length - 1]?.timestamp || 0) - (a.transcript[a.transcript.length - 1]?.timestamp || 0));
    setCallRecords(records);
  };
  const pruneCallSnapshots = async (charId: string, sessionId: string) => {
    const all = await DB.getMessagesByCharId(charId, true);
    const expired = findExpiredCallSnapshots(all, sessionId);
    if (!expired.length) return;
    for (const snapshot of expired) {
      await DB.updateMessageMetadata(snapshot.messageId, (previous: any) => {
        const next = { ...(previous || {}), cameraSnapshotExpired: true };
        delete next.cameraSnapshotRef;
        return next;
      });
      await deleteBlobRef(snapshot.ref);
    }
    trackEvent('Prune Expired Video Call Snapshots');
    const expiredIds = new Set(expired.map(snapshot => snapshot.messageId));
    setBubbles(previous => previous.map(bubble => (
      bubble.dbId && expiredIds.has(bubble.dbId)
        ? { ...bubble, cameraSnapshotRef: undefined, cameraSnapshotExpired: true }
        : bubble
    )));
    markCallTurnDirty();
  };
  const resetCurrentCall = () => {
    revokeSessionBlobs();
    stopPlayback();
    pendingAvatarTouchesRef.current = [];
    setPendingAvatarTouchCount(0);
    setAvatarTouchEffects([]);
    avatarTouchEffectTimersRef.current.forEach(timer => window.clearTimeout(timer));
    avatarTouchEffectTimersRef.current = [];
    idleNudgeCountRef.current = 0;
    setCallState('idle');
    setBubbles([]);
    setDraftInput('');
    setAudioUrl('');
    setTraceId('');
    setErrorMessage('');
    setAvatarEmotion('calm');
    setAvatarPerformance(DEFAULT_AVATAR_PERFORMANCE);
    setCallStartedAt(null);
    setElapsedSeconds(0);
    setShowInputPanel(true);
    setCurrentSessionId(`call-${Date.now()}`);
  };
  const closeCallSetupGuide = () => {
    callSetupGuideOpenRef.current = false;
    setShowCallSetupGuide(false);
  };
  const openCallSetupGuide = (step: CallSetupGuideStep = 'model') => {
    setSetupCameraMode('off');
    setCallSetupGuideStep(step);
    callSetupGuideOpenRef.current = true;
    setShowCallSetupGuide(true);
  };
  const dismissCallUpdateAnnouncement = () => {
    markCallUpdateAnnouncementSeen();
    setShowCallUpdateAnnouncement(false);
    trackEvent('Dismiss Call Feature Update Notice');
  };
  const openCallPreferencesPanel = () => {
    markCallUpdateAnnouncementSeen();
    setShowCallUpdateAnnouncement(false);
    setShowCallPreferences(true);
    trackEvent('Open Call Preferences');
  };
  const primeCallAudioFromGesture = (forceManualPlayback = false) => {
    if (!forceManualPlayback && (!callPreferences.voiceAutoPlay || !isSpeakerOn)) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (forceManualPlayback && !isSpeakerOn) setIsSpeakerOn(true);

    // Desktop/Android may use WebAudio for real-time lip sync. Invoke resume()
    // directly in the click stack; never wait for React onPlay/useEffect.
    if (!nativeCallAudioOnly) void getAudioFeed().unlock();

    audioPrimingRef.current = true;
    audio.muted = false;
    audio.src = SILENT_CALL_AUDIO_DATA_URL;
    audio.currentTime = 0;
    const finishPrime = () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      window.setTimeout(() => { audioPrimingRef.current = false; }, 0);
    };
    try {
      const attempt = audio.play();
      if (attempt) void attempt.then(finishPrime).catch(() => { audioPrimingRef.current = false; });
      else finishPrime();
    } catch {
      audioPrimingRef.current = false;
    }
  };
  const beginSelectedCall = (cameraMode: UserCameraMode = 'off') => {
    closeCallSetupGuide();
    resetCurrentCall();
    primeCallAudioFromGesture();
    setViewMode('in-call');
    setCallStartedAt(Date.now());
    setCallState('listening');
    trackEvent('Start a Call');
    if (callMode !== 'video' || cameraMode === 'off') {
      stopUserCamera();
      return;
    }
    if (cameraMode === 'fake') {
      stopUserCamera();
      if (fakeUserCameraRef) setUserCameraMode('fake');
      return;
    }
    void startUserCamera(cameraMode);
  };
  const requestSelectedCall = () => {
    if (callMode === 'video') {
      let guideCompleted = false;
      try { guideCompleted = localStorage.getItem(CALL_SETUP_GUIDE_KEY) === 'complete'; } catch { /* private WebView */ }
      if (!guideCompleted) {
        openCallSetupGuide(hasSelectedVideoVisual ? 'camera' : 'model');
        return;
      }
    }
    beginSelectedCall('off');
  };
  const finishCallSetupGuide = () => {
    try { localStorage.setItem(CALL_SETUP_GUIDE_KEY, 'complete'); } catch { /* private WebView */ }
    beginSelectedCall(setupCameraMode);
  };
  const finishCall = async () => {
    if (selectedChar?.id) {
      const userTurns = bubbles.filter(b => b.role === 'user').length;
      const keepsakeLine = summarizeKeepsakeLine(bubbles, selectedChar.name);
      const payload = {
        characterId: selectedChar.id,
        characterName: selectedChar.name,
        characterAvatar: selectedChar.avatar,
        durationSec: elapsedSeconds,
        turnCount: userTurns,
        keepsakeLine,
        callMode,
        endedAt: Date.now(),
      };
      await DB.saveMessage({
        charId: selectedChar.id,
        role: 'system',
        type: 'system',
        content: `Call ended · ${selectedChar.name}｜${formatDuration(elapsedSeconds)}｜${Math.max(1, userTurns)} turns`,
        metadata: { source: 'call-end-popup', callSessionId: currentSessionId, ...payload },
      });
      await loadCallRecords(selectedChar.id);
      trackEvent('End a Call', { Mode: callMode === 'video' ? 'Video' : 'Voice' });
      // Hanging up is the moment that matters most: the user will most likely close the app
      // right after, so this last entry needs to be marked dirty too — marking dirty means
      // it's queued, and the microtask flushes the upload within the same tick.
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);
    }
    clearSuspendedCall();
    resetCurrentCall();
    setViewMode('history');
    setShowHangupConfirm(false);
    addToast('Call record saved', 'success');
  };
  const handleHangup = () => {
    setShowHangupConfirm(true);
  };
  // Uses the exact same history pipeline as Chat / Date (ChatPrompts.buildMessageHistory —
  // Date's buildDateHistory is the same function): the three sources [聊天] [通话] [约会]
  // are one single "real context," injected in chronological order; source tags, the
  // character's timezone timestamp, image (image_url)/emoji/quote-reply handling are all
  // treated exactly like every other entry point — no more hand-rolled call-only format.
  const buildHistoryMessages = async (
    input: string,
    skipDbId?: number,
    touchContext = '',
  ): Promise<any[]> => {
    if (!selectedChar?.id) return [{ role: 'user', content: input }];
    const limit = selectedChar.contextLimit || 500;
    const [allMsgs, emojis] = await Promise.all([
      DB.getMessagesByCharId(selectedChar.id, true),
      DB.getEmojis().catch(() => []),
    ]);
    // Memory Palace watermark filtering matches the Date side's buildDateHistory;
    // hideBeforeMessageId is handled internally by buildMessageHistory.
    const hwm = (() => {
      try { return parseInt(localStorage.getItem(`mp_lastMsgId_${selectedChar.id}`) || '0', 10) || 0; } catch { return 0; }
    })();
    const palaceFiltered = hwm > 0 ? allMsgs.filter(m => m.id > hwm) : allMsgs;
    const filtered = palaceFiltered.filter(m => !(skipDbId && m.id === skipDbId));
    const { apiMessages } = ChatPrompts.buildMessageHistory(
      filtered, limit, selectedChar, userProfile || ({} as any), emojis,
    );
    const lastMsg = filtered[filtered.length - 1];
    const timeGapHint = ChatPrompts.getTimeGapHint(lastMsg, Date.now());
    // This live turn also carries the same [通话] tag as history — an untagged input is
    // easily attached by the model to the most recent [聊天] thread instead, and what was
    // just said on the call gets forgotten.
    const inputWithTouch = touchContext
      ? `${touchContext}\n\n[What the user said this turn]\n${input}`
      : input;
    const taggedInput = `[${new Date().toLocaleString('en-US')}] [通话] ${inputWithTouch}`;
    const finalInput = timeGapHint ? `${taggedInput}\n\n${timeGapHint}` : taggedInput;
    return [...apiMessages, { role: 'user', content: finalInput }];
  };
  const getAllowedModelActions = (): Array<{
    id: string;
    name: string;
    kind?: 'motion' | 'expression' | 'params';
    tags?: string[];
  }> => (
    selectedVisualSource !== 'model'
      ? []
      : selectedChar?.videoAvatar?.format === 'live2d'
      ? selectedChar.videoAvatar.actions
          .filter(action => action.permission === 'ai' && !action.wardrobe)
          .sort((a, b) => {
            const score = (action: typeof a) => (action.tags.length ? 100 : 0)
              + (action.kind === 'motion' ? 20 : action.kind === 'params' ? 15 : 10)
              + (action.source === 'vtube' ? 2 : 0);
            return score(b) - score(a);
          })
          .map(action => ({ id: action.id, name: action.name, kind: action.kind, tags: action.tags }))
      : selectedChar?.videoAvatar?.format === 'vrm'
        ? vrmExpressionsRef.current.map(name => ({ id: name, name: `Custom Expression · ${name}`, kind: 'expression' as const }))
        : []
  );

  const resolvePerformanceDirectorApi = (character: CharacterProfile) => {
    // Reuses exactly the same API-selection rule as the Emotion Buff: use the Secondary
    // API if the character has one configured individually, otherwise fall back to the
    // Primary API.
    const configuredEmotionApi = character.emotionConfig?.api;
    return configuredEmotionApi?.baseUrl
      ? configuredEmotionApi
      : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
  };

  const buildLocalPerformancePersona = (character: CharacterProfile): string => {
    const source = [
      character.personalityStyle,
      character.description,
      character.systemPrompt,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return Array.from(source || 'Perform the video call naturally and with restraint; let actions follow the emotion of the dialogue, without deliberately stealing the scene.')
      .slice(0, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS)
      .join('');
  };

  const ensureVideoPerformancePersona = async (character: CharacterProfile): Promise<string | null> => {
    const persisted = character.videoCallPerformancePersona?.trim();
    if (persisted) {
      const clamped = Array.from(persisted).slice(0, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS).join('');
      performancePersonaCacheRef.current.set(character.id, clamped);
      return clamped;
    }
    const cached = performancePersonaCacheRef.current.get(character.id);
    if (cached) return cached;
    const pending = performancePersonaPromiseRef.current.get(character.id);
    if (pending) return pending;
    // One attempt per mounted CallApp session. A transient failure falls back locally
    // for this call and can be retried next time the user opens the app.
    if (performancePersonaAttemptedRef.current.has(character.id)) return null;
    performancePersonaAttemptedRef.current.add(character.id);

    const task = (async (): Promise<string | null> => {
      try {
        const directorApi = resolvePerformanceDirectorApi(character);
        const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
        if (!baseUrl) return null;
        const coreContext = ContextBuilder.buildCoreContext(character, userProfile, true);
        const prompt = buildAvatarPerformancePersonaPrompt({
          characterName: character.name,
          coreContext,
        });
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}` },
          body: JSON.stringify({
            model: directorApi.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.25,
            max_tokens: AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS,
            stream: false,
          }),
        }, 1, 30_000, {
          appName: 'Call',
          charId: character.id,
          charName: character.name,
          purpose: 'Generate Video Performance Persona',
        });
        const persona = parseAvatarPerformancePersona(extractContent(data));
        if (!persona) return null;
        performancePersonaCacheRef.current.set(character.id, persona);
        updateCharacter(character.id, {
          videoCallPerformancePersona: persona,
          videoCallPerformancePersonaGeneratedAt: Date.now(),
        });
        return persona;
      } catch (error: any) {
        console.warn('[call] performance persona warmup failed; using local fallback:', error?.message || error);
        return null;
      } finally {
        performancePersonaPromiseRef.current.delete(character.id);
      }
    })();
    performancePersonaPromiseRef.current.set(character.id, task);
    return task;
  };

  // Prewarms in the background as soon as a high-quality video call starts. It runs
  // alongside the main opening-line request and usually finishes before the main line
  // comes back, so the first director request doesn't need to wait a full extra turn.
  useEffect(() => {
    if (viewMode !== 'in-call' || callMode !== 'video') return;
    if (!selectedChar || selectedChar.videoCallPerformanceQuality !== 'high') return;
    void ensureVideoPerformancePersona(selectedChar);
  }, [viewMode, callMode, selectedChar?.id, selectedChar?.videoCallPerformanceQuality]);

  const requestHighQualityPerformance = async (
    replyText: string,
    allowedModelActions: Array<{
      id: string;
      name: string;
      kind?: 'motion' | 'expression' | 'params';
      tags?: string[];
    }>,
  ): Promise<AvatarPerformanceCue[] | null> => {
    if (!selectedChar || callMode !== 'video') return null;
    const directorApi = resolvePerformanceDirectorApi(selectedChar);
    const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) return null;
    const personality = await ensureVideoPerformancePersona(selectedChar)
      || buildLocalPerformancePersona(selectedChar);
    const normalizedReply = sanitizeAssistantOutput(replyText);
    const voiceCopy = extractVoiceTag(normalizedReply);
    const spokenText = (voiceCopy.display || voiceCopy.voiceText || normalizedReply).trim();
    const sentences = splitAvatarPerformanceSentences(spokenText);
    if (!sentences.length) return null;
    const sentencePlan = sentences
      .map((sentence, index) => `${index + 1}. at=${sentence.at.toFixed(4)}: ${sentence.text}`)
      .join('\n');
    const prompt = `${buildAvatarPerformanceRehearsalPrompt({
      characterName: selectedChar.name,
      personality,
      reply: replyText,
      modelActions: allowedModelActions,
    })}

## Hard constraints for this turn, sentence by sentence
- Return exactly ${sentences.length} cues, strictly corresponding one-to-one with the ${sentences.length} sentences below.
- Every cue must include start, hold_ms, and end together; do not merge, split, or add transition cues.
- at must be copied exactly from the sentence table.

${sentencePlan}`;
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: directorApi.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.45,
        max_tokens: AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
        stream: false,
      }),
    }, 1, 30_000, {
      appName: 'Call',
      charId: selectedChar.id,
      charName: selectedChar.name,
      purpose: 'Video Action Rehearsal',
    });
    const cues = parseAvatarPerformanceRehearsal(
      extractContent(data),
      allowedModelActions.map(action => action.id),
      sentences.length,
    );
    if (!isCompleteAvatarPerformanceCuePack(cues, sentences.length)) {
      console.warn('[call] high-quality director returned an incomplete sentence cue pack');
      return null;
    }
    return alignAvatarPerformanceCuesToSentences(cues, spokenText);
  };

  const requestAssistantReply = async (
    input: string,
    skipDbId?: number,
    pendingTouches: AvatarTouchRecord[] = [],
    includeUserCameraContext = false,
    userCameraSnapshotForTurn?: string,
  ): Promise<ParsedCallReply> => {
    const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Please configure the chat API URL in Settings first');
    const userName = userProfile?.name?.trim() || 'User';
    if (selectedChar) {
      const callMsgs = await DB.getMessagesByCharId(selectedChar.id);
      await injectMemoryPalace(selectedChar, callMsgs);
    }
    const baseCallPrompt = selectedChar
      ? buildCallPrompt(
          userName,
          selectedChar.name,
          // conversational: a call is real-time dialogue, so the time block adds that context-framing line (see buildTimeAwarenessBlock)
          ContextBuilder.buildCoreContext(selectedChar, userProfile, true, undefined, undefined, { conversational: true }),
          voiceLang || undefined,
          callMode,
          resolveCharTimeZone(selectedChar),
        )
      : buildCallPrompt(userName, undefined, undefined, voiceLang || undefined, callMode);
    const thinkingPrompt = selectedChar?.showThinkingChain
      ? [
          buildThinkingChainPrompt(selectedChar.name, userName),
          selectedChar.thinkingChainCustomPrompt?.trim()
            ? `[User's additional THINKING requirements]\n${selectedChar.thinkingChainCustomPrompt.trim()}`
            : '',
        ].filter(Boolean).join('\n\n')
      : '';
    // Model-specific action allowlist: Live2D uses the actions the user has authorized;
    // VRM uses the custom expressions enumerated at load time (things like star-eyes or a
    // deadpan face — anything outside the presets is available).
    const allowedModelActions = getAllowedModelActions();
    const highQualityPerformance = callMode === 'video'
      && selectedChar?.videoCallPerformanceQuality === 'high';
    const userCameraEmotionContext = includeUserCameraContext
      && callMode === 'video'
      && userCameraMode === 'emotion'
      ? await captureUserCameraEmotionContext()
      : '';
    const userCameraSnapshot = includeUserCameraContext
      && callMode === 'video'
      && userCameraMode === 'snapshot'
      ? (userCameraSnapshotForTurn ?? captureUserCameraSnapshotContext())
      : '';
    if (includeUserCameraContext && callMode === 'video' && userCameraMode === 'snapshot' && !userCameraSnapshot && userCameraSnapshotForTurn === undefined) {
      addToast('The camera feed is not ready yet — only text was sent this turn', 'info');
    }
    const baseSystemPrompt = [
      baseCallPrompt,
      callMode === 'video' && !highQualityPerformance ? buildAvatarPerformancePrompt(allowedModelActions) : '',
      userCameraEmotionContext,
      thinkingPrompt,
    ].filter(Boolean).join('\n\n');
    const systemPrompt = [baseSystemPrompt, userCameraSnapshot ? USER_CAMERA_SNAPSHOT_SYSTEM_NOTE : '']
      .filter(Boolean)
      .join('\n\n');
    const touchContext = selectedChar
      ? buildPendingAvatarTouchContext(
          pendingTouches,
          selectedChar.name,
          userName,
        )
      : '';
    const messages = await buildHistoryMessages(input, skipDbId, touchContext);
    const requestMessages = userCameraSnapshot
      ? attachSnapshotToLatestUserMessage(messages, userCameraSnapshot)
      : messages;
    const sendChatRequest = (
      nextMessages: any[],
      nextSystemPrompt: string,
      maxRetries: number,
      purpose: string,
    ) => safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'system', content: nextSystemPrompt }, ...nextMessages],
        temperature: 0.85,
        // max_tokens is a required field for the native Claude API; without it, an
        // OpenAI→Claude relay gets rejected upstream and wrapped as a 502 /
        // bad_response_status_code. Kept aligned with 1:1 chat (useChatAI.ts).
        max_tokens: 8000,
        stream: false,
      }),
    }, maxRetries, 0, { appName: 'Call', charId: selectedChar?.id, charName: selectedChar?.name, purpose });
    let chatData: any;
    try {
      // Do not repeat a rejected base64 frame three times. Text-only calls keep
      // the normal transient-error retries; snapshot calls first try vision once.
      chatData = await sendChatRequest(
        requestMessages,
        systemPrompt,
        userCameraSnapshot ? 0 : 2,
        userCameraSnapshot ? 'Video Call · User Snapshot' : 'Voice Call',
      );
    } catch (error) {
      if (!userCameraSnapshot || !isVisionInputUnsupportedError(error)) throw error;
      console.warn('[camera-snapshot] provider rejected vision input; retrying text-only:', error);
      addToast('The current model does not support images; this turn was automatically switched to text only', 'info');
      chatData = await sendChatRequest(messages, baseSystemPrompt, 2, 'Video Call · Snapshot Downgraded to Text');
    }
    const parsed = parseCallAssistantMessage(
      chatData?.choices?.[0]?.message,
      !!selectedChar?.showThinkingChain,
    );
    if (!parsed.text.trim()) throw new Error('The text endpoint returned nothing, or returned only thinking content');
    const preparedForAudio = prepareCallAssistantReply(parsed);
    prefetchCallAudio(preparedForAudio.text, preparedForAudio.speechEmotion);
    if (highQualityPerformance) {
      try {
        const cues = await requestHighQualityPerformance(parsed.text, allowedModelActions);
        if (cues?.length) {
          return { ...parsed, performance: cues[0].direction, performanceCues: cues };
        }
        console.warn('[call] high-quality performance returned no usable cues; using local fallback');
      } catch (error: any) {
        // The action director must never hold up the call's actual dialogue; timeouts, quota, or format issues all fall back to local text inference.
        console.warn('[call] high-quality performance failed; using local fallback:', error?.message || error);
      }
    }
    return parsed;
  };
  // ── Performance timeline scheduling: multiple [[AVATAR:]] cues take effect one after another as speech playback progresses ──
  const performanceCueTimersRef = useRef<number[]>([]);
  const pendingCueScheduleRef = useRef<{ cues: AvatarPerformanceCue[]; fallbackMs: number } | null>(null);
  const silentSpeechTimerRef = useRef<number | null>(null);
  const clearPerformanceCueTimers = () => {
    performanceCueTimersRef.current.forEach(timer => window.clearTimeout(timer));
    performanceCueTimersRef.current = [];
  };
  const clearSilentSpeechTimer = () => {
    if (silentSpeechTimerRef.current !== null) window.clearTimeout(silentSpeechTimerRef.current);
    silentSpeechTimerRef.current = null;
  };
  const applyPerformanceDirection = (direction: AvatarPerformanceDirection) => {
    setAvatarEmotion(direction.emotion);
    setAvatarPerformance(direction);
  };
  const schedulePerformanceCues = (cues: AvatarPerformanceCue[] | undefined, durationMs: number) => {
    if (!cues?.length) return;
    clearPerformanceCueTimers();
    expandAvatarPerformanceCueBeats(cues, durationMs).forEach(beat => {
      if (beat.delayMs <= 80) {
        applyPerformanceDirection(beat.direction);
        return;
      }
      performanceCueTimersRef.current.push(window.setTimeout(() => applyPerformanceDirection(beat.direction), beat.delayMs));
    });
  };
  const playSilentAvatarSpeech = (
    text: string,
    cues?: AvatarPerformanceCue[],
    durationOverrideMs?: number,
  ) => {
    const durationMs = durationOverrideMs || estimateSpeechMs(text);
    clearSilentSpeechTimer();
    pendingCueScheduleRef.current = null;
    setIsAudioPlaying(false);
    setCallState('speaking');
    schedulePerformanceCues(cues, durationMs);
    silentSpeechTimerRef.current = window.setTimeout(() => {
      silentSpeechTimerRef.current = null;
      clearPerformanceCueTimers();
      setCallState(prev => (prev === 'speaking' ? 'listening' : prev));
    }, durationMs);
  };
  useEffect(() => () => {
    clearPerformanceCueTimers();
    clearSilentSpeechTimer();
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlePlay = () => {
      if (audioPrimingRef.current) return;
      clearSilentSpeechTimer();
      setIsAudioPlaying(true);
      setCallState('speaking');
      const pending = pendingCueScheduleRef.current;
      if (!pending) return;
      pendingCueScheduleRef.current = null;
      const durationSec = audio.duration;
      const durationMs = Number.isFinite(durationSec) && durationSec > 0
        ? durationSec * 1000
        : pending.fallbackMs;
      schedulePerformanceCues(pending.cues, durationMs);
    };
    const handleStop = () => {
      if (audioPrimingRef.current) return;
      setIsAudioPlaying(false);
      clearPerformanceCueTimers();
      setCallState(previous => (previous === 'speaking' ? 'listening' : previous));
    };
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handleStop);
    audio.addEventListener('ended', handleStop);
    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handleStop);
      audio.removeEventListener('ended', handleStop);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = !isSpeakerOn;
  }, [isSpeakerOn]);

  const startCallAudioElement = (audio: HTMLAudioElement, forceAudible = false): Promise<void> => {
    audio.muted = forceAudible ? false : !isSpeakerOn;
    const feed = callMode === 'video' && !nativeCallAudioOnly ? getAudioFeed() : null;
    // Both calls are made immediately in the originating click stack. The graph
    // is attached only after both succeeded, so a suspended context can never
    // steal otherwise-audible native media output.
    const unlockAttempt = feed?.unlock();
    const playbackAttempt = audio.play();
    if (feed && unlockAttempt) {
      void Promise.allSettled([unlockAttempt, playbackAttempt]).then(([unlockResult, playbackResult]) => {
        if (unlockResult.status === 'fulfilled' && unlockResult.value && playbackResult.status === 'fulfilled') {
          feed.attach(audio);
        }
      });
    }
    return playbackAttempt;
  };

  const playAudio = (url?: string, cues?: AvatarPerformanceCue[], fallbackMs?: number, forceAudible = false) => {
    const targetUrl = url || audioUrl;
    const estimatedDurationMs = fallbackMs || 4000;
    if (!targetUrl || !audioRef.current) {
      if (callMode === 'video') playSilentAvatarSpeech('', cues, estimatedDurationMs);
      return;
    }
    clearSilentSpeechTimer();
    if (audioUrl !== targetUrl) setAudioUrl(targetUrl);
    // The timeline is scheduled using the real audio duration at onPlay; falls back to the estimate if the duration can't be obtained.
    pendingCueScheduleRef.current = cues?.length ? { cues, fallbackMs: estimatedDurationMs } : null;
    const audio = audioRef.current;
    audio.src = targetUrl;
    audio.currentTime = 0;
    startCallAudioElement(audio, forceAudible).catch(() => {
      pendingCueScheduleRef.current = null;
      if (callMode === 'video') playSilentAvatarSpeech('', cues, estimatedDurationMs);
      else setCallState('listening');
      addToast(forceAudible ? 'Playback failed — please tap "Replay Voice" again' : 'The browser blocked this autoplay; tap "Replay Voice" to recover', 'info');
    });
    setCallState('speaking');
  };
  const ensureCallBubbleAudio = async (bubble: CallBubble, forceRegenerate = false): Promise<string | null> => {
    if (bubble.role !== 'assistant' || generatingAudioBubbleId) return null;
    if (bubble.audioUrl && !forceRegenerate) return bubble.audioUrl;
    if (!hasConfiguredVoice()) {
      addToast('This character\'s voice has not been configured yet', 'info');
      return null;
    }
    setGeneratingAudioBubbleId(bubble.id);
    setErrorMessage('');
    try {
      const voiceTag = extractVoiceTag(bubble.text);
      const { url, traceIds } = await takeOrSynthesizeCallAudio(
        bubble.text,
        voiceTag.emotion || bubble.performance?.emotion,
      );
      if (!url) throw new Error('No playable audio was obtained');
      trackBlobUrl(url);
      setAudioUrl(url);
      setTraceId(traceIds.filter(Boolean).join(' | '));
      setBubbles(previous => previous.map(item => item.id === bubble.id ? { ...item, audioUrl: url } : item));
      setCallRecords(previous => previous.map(record => ({
        ...record,
        transcript: record.transcript.map(item => item.id === bubble.id ? { ...item, audioUrl: url } : item),
      })));
      return url;
    } catch (error: any) {
      setCallState('listening');
      setErrorMessage(error?.message || 'Failed to generate voice');
      addToast(`Failed to generate voice: ${error?.message || 'Unknown error'}`, 'error');
      return null;
    } finally {
      setGeneratingAudioBubbleId(null);
    }
  };
  const handlePlayBubbleAudio = async (bubble: CallBubble) => {
    if (bubble.role !== 'assistant' || generatingAudioBubbleId) return;
    if (bubble.audioUrl) {
      if (!isSpeakerOn) setIsSpeakerOn(true);
      playAudio(bubble.audioUrl, bubble.performanceTimeline, estimateSpeechMs(bubble.text), true);
      trackEvent('Replay a Call Voice Clip');
      return;
    }
    // The click itself unlocks the persistent media element. TTS happens only
    // after this point when automatic voice is disabled.
    if (isAudioPlaying) pauseAudio();
    primeCallAudioFromGesture(true);
    const url = await ensureCallBubbleAudio(bubble);
    if (!url) return;
    if (!isSpeakerOn) setIsSpeakerOn(true);
    playAudio(url, bubble.performanceTimeline, estimateSpeechMs(bubble.text), true);
    trackEvent('Generate and Play Call Voice on Demand');
  };
  const callFavoriteSourceKey = (charId: string, bubble: CallBubble) => `${charId}:${bubble.dbId || bubble.id}`;
  const openCallVoiceFavorite = async (bubble: CallBubble, charId = selectedChar?.id || '', charName = selectedChar?.name || 'Unknown Character') => {
    if (bubble.role !== 'assistant' || !charId) return;
    setVoiceFavoriteTarget({ bubble, charId, charName });
    setVoiceFavoriteBusy(false);
    setVoiceFavoriteSaved(!!await getVoiceFavorite('call', callFavoriteSourceKey(charId, bubble)).catch(() => null));
  };
  const toggleCallVoiceFavorite = async () => {
    const target = voiceFavoriteTarget;
    if (!target || voiceFavoriteBusy) return;
    const sourceKey = callFavoriteSourceKey(target.charId, target.bubble);
    setVoiceFavoriteBusy(true);
    try {
      if (voiceFavoriteSaved) {
        await removeVoiceFavorite('call', sourceKey);
        setVoiceFavoriteSaved(false);
        addToast('Removed the voice from favorites', 'info');
        return;
      }

      let url = target.bubble.audioUrl || await ensureCallBubbleAudio(target.bubble);
      let blob: Blob | null = null;
      if (url) {
        try { blob = await fetchBlobForShare(url, 'audio/mpeg'); } catch { /* stale session URL: regenerate below */ }
      }
      if (!blob) {
        url = await ensureCallBubbleAudio(target.bubble, true);
        if (url) {
          try { blob = await fetchBlobForShare(url, 'audio/mpeg'); } catch { /* handled below */ }
        }
      }
      if (!blob) throw new Error('Could not retrieve the audio file for this voice line right now');

      const parsed = extractVoiceTag(target.bubble.text);
      const originalText = stripCallTextFormatting(parsed.display).trim()
        || stripTtsMarkupForDisplay(parsed.voiceText, apiConfig)
        || stripCallTextFormatting(target.bubble.text).trim();
      const spokenText = stripTtsMarkupForDisplay(parsed.voiceText, apiConfig) || originalText;
      await saveVoiceFavorite({
        source: 'call',
        sourceKey,
        charId: target.charId,
        charName: target.charName,
        sourceTimestamp: target.bubble.timestamp,
        originalText,
        spokenText: spokenText !== originalText ? spokenText : undefined,
        language: voiceLang || undefined,
        blob,
      });
      setVoiceFavoriteSaved(true);
      addToast('Call voice favorited', 'success');
      trackEvent('Favorite Call Voice');
    } catch (error: any) {
      addToast(error?.message || 'Failed to favorite — please check your browser storage space', 'error');
    } finally {
      setVoiceFavoriteBusy(false);
    }
  };
  const resumeAudio = () => {
    if (!audioRef.current || !audioUrl) return;
    startCallAudioElement(audioRef.current).catch(() => addToast('Failed to resume playback — please tap Replay', 'error'));
  };
  const pauseAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setCallState('listening');
  };

  useEffect(() => {
    if (nativeCallAudioOnly) return;
    const recoverAudioGraph = () => {
      if (document.visibilityState !== 'visible' || !isAudioPlaying) return;
      void audioFeedRef.current?.unlock();
    };
    document.addEventListener('visibilitychange', recoverAudioGraph);
    window.addEventListener('pageshow', recoverAudioGraph);
    return () => {
      document.removeEventListener('visibilitychange', recoverAudioGraph);
      window.removeEventListener('pageshow', recoverAudioGraph);
    };
  }, [isAudioPlaying, nativeCallAudioOnly]);

  // The character speaks first once the call connects. This shares one explicit Call
  // Preference with the "speak up after silence" behavior further below, on by default;
  // when turned off, CallApp waits for the user to speak first — ChatApp is unaffected.
  const greetingFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!callPreferences.characterInitiative || viewMode !== 'in-call' || bubbles.length > 0) return;
    if (!selectedChar?.id || greetingFiredRef.current === currentSessionId) return;
    greetingFiredRef.current = currentSessionId;
    void (async () => {
      try {
        setCallState('connecting');
        const greetingReply = prepareCallAssistantReply(
          await requestAssistantReply('(The call was just picked up. You speak first — say your first line as naturally as you would when picking up a call from this person. Do not explain the rules — just the most natural "Hello?" or "Hey," or an opening that matches your personality.)'),
          callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
        );
        const greetingText = greetingReply.text;
        setAvatarEmotion(greetingReply.performance.emotion);
        setAvatarPerformance(greetingReply.performance);
        const nowTs = Date.now();
        const greetingBubble: CallBubble = {
          id: `${nowTs}-greeting`,
          role: 'assistant',
          text: greetingText,
          time: formatTime(),
          timestamp: nowTs,
          thinkingChain: greetingReply.thinkingChain,
          performance: greetingReply.performance,
          performanceTimeline: greetingReply.performanceCues,
        };
        setCallState('speaking');
        setBubbles([greetingBubble]);
        const dbId = await DB.saveMessage({
          charId: selectedChar.id,
          role: 'assistant',
          type: 'text',
          content: greetingText,
          metadata: {
            source: 'call',
            callSessionId: currentSessionId,
            ...(greetingReply.thinkingChain ? { thinkingChain: greetingReply.thinkingChain } : {}),
            avatarPerformance: greetingReply.performance,
            avatarPerformanceCues: greetingReply.performanceCues,
          },
        });
        setBubbles(previous => previous.map(bubble => bubble.id === greetingBubble.id ? { ...bubble, dbId } : bubble));
        markCallTurnDirty();

        let playbackStarted = false;
        if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
          try {
            const { url } = await takeOrSynthesizeCallAudio(greetingText, greetingReply.speechEmotion);
            if (url) {
              trackBlobUrl(url);
              setAudioUrl(url);
              setBubbles(previous => previous.map(bubble => bubble.id === greetingBubble.id ? { ...bubble, audioUrl: url } : bubble));
              window.setTimeout(() => playAudio(url, greetingReply.performanceCues, estimateSpeechMs(greetingText)), 0);
              playbackStarted = true;
            }
          } catch {
            // A voice failure doesn't erase the text the character already "said."
          }
        }
        if (!playbackStarted) {
          if (callMode === 'video' && callPreferences.voiceAutoPlay) {
            playSilentAvatarSpeech(greetingText, greetingReply.performanceCues);
          } else {
            setCallState('listening');
          }
        }
      } catch (error: any) {
        setCallState('error');
        setErrorMessage(error?.message || 'Failed to generate the opening line');
      }
    })();
  }, [viewMode, currentSessionId, callPreferences.characterInitiative]);

  const handleAvatarTouch = (hit: AvatarTouchHit) => {
    const character = selectedChar;
    if (!character) return;
    const now = Date.now();
    if (now - avatarTouchLastAtRef.current < 180) return;
    avatarTouchLastAtRef.current = now;

    const record = createAvatarTouchRecord(hit, now);
    const pending = appendPendingAvatarTouch(pendingAvatarTouchesRef.current, record);
    pendingAvatarTouchesRef.current = pending;
    setPendingAvatarTouchCount(pending.length);

    const effect: AvatarTouchEffect = {
      id: record.id,
      normalizedX: hit.normalizedX,
      normalizedY: hit.normalizedY,
      label: avatarTouchTargetLabel(hit),
    };
    setAvatarTouchEffects(current => [...current.slice(-3), effect]);
    const timer = window.setTimeout(() => {
      setAvatarTouchEffects(current => current.filter(item => item.id !== effect.id));
      avatarTouchEffectTimersRef.current = avatarTouchEffectTimersRef.current
        .filter(activeTimer => activeTimer !== timer);
    }, 1_750);
    avatarTouchEffectTimersRef.current.push(timer);

    if (callMode === 'video') {
      applyPerformanceDirection(buildImmediateTouchPerformance(hit.zone));
    } else {
      setVoiceAvatarPokeNonce(value => value + 1);
    }
    if (!callStartedAt) setCallStartedAt(now);
  };

  const handleVoiceAvatarPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || voiceAvatarPointerRef.current) return;
    voiceAvatarPointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: window.performance.now(),
      maxDistance: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleVoiceAvatarPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pointer = voiceAvatarPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointer.maxDistance = Math.max(
      pointer.maxDistance,
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y),
    );
  };

  const handleVoiceAvatarPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pointer = voiceAvatarPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    voiceAvatarPointerRef.current = null;
    const durationMs = window.performance.now() - pointer.startedAt;
    if (!isAvatarTouchGesture(pointer.maxDistance, durationMs, event.isPrimary)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const normalizedX = rect.width > 0 ? x / rect.width : 0.5;
    const normalizedY = rect.height > 0 ? y / rect.height : 0.5;
    const target = resolveAvatarTouchTarget([], normalizedY, normalizedX);
    handleAvatarTouch({
      nonce: Date.now(),
      x,
      y,
      normalizedX,
      normalizedY,
      ...target,
      source: 'portrait-bounds',
      rawAreas: [],
    });
  };

  const handleVoiceAvatarPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (voiceAvatarPointerRef.current?.pointerId === event.pointerId) {
      voiceAvatarPointerRef.current = null;
    }
  };

  const handleVoiceAvatarKeyboardPoke = () => {
    handleAvatarTouch({
      nonce: Date.now(),
      x: 80,
      y: 72,
      normalizedX: 0.5,
      normalizedY: 0.45,
      zone: 'face',
      part: 'face',
      source: 'portrait-bounds',
      rawAreas: [],
    });
  };

  useEffect(() => () => {
    avatarTouchEffectTimersRef.current.forEach(timer => window.clearTimeout(timer));
    avatarTouchEffectTimersRef.current = [];
  }, []);
  const handleTurn = async () => {
    if (isListening) { sttSessionRef.current?.stop(); setIsListening(false); }
    const typedInput = draftInput.trim();
    const retryInput = getPendingReplyText(bubbles);
    const input = typedInput || retryInput;
    if (!input) return addToast('Say something', 'info');
    if (['connecting', 'thinking'].includes(callState)) return addToast(`Give ${selectedChar?.name || 'them'} a moment to think`, 'info');
    if (isAudioPlaying) pauseAudio();
    primeCallAudioFromGesture();
    idleNudgeCountRef.current = 0;
    const pendingTouchesForTurn = pendingAvatarTouchesRef.current.slice();
    const latestBubble = bubbles[bubbles.length - 1];
    const retryBubble = latestBubble?.role === 'user' && latestBubble.text.trim() === input
      ? latestBubble
      : null;
    const isRetry = !!retryBubble;
    const userCameraSnapshotForTurn = callMode === 'video' && userCameraMode === 'snapshot'
      ? captureUserCameraSnapshotContext()
      : '';
    if (callMode === 'video' && userCameraMode === 'snapshot' && !userCameraSnapshotForTurn) {
      addToast('The camera feed is not ready yet — only text was sent this turn', 'info');
    }
    let newSnapshotRef: string | undefined;
    if (userCameraSnapshotForTurn) {
      try {
        newSnapshotRef = await putImageBlob(dataUrlToBlob(userCameraSnapshotForTurn));
        trackEvent('Save a Video Call Single-Frame Snapshot');
      } catch (error) {
        console.warn('[camera-snapshot] failed to save the local call-record frame:', error);
        addToast('The snapshot will still be sent to the character, but could not be saved to the local call record', 'info');
      }
    }
    const nowTs = Date.now();
    const now = formatTime();
    const userBubble: CallBubble = retryBubble
      ? { ...retryBubble, ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef, cameraSnapshotExpired: false } : {}) }
      : {
          id: `${nowTs}-u`,
          role: 'user',
          text: input,
          time: now,
          timestamp: nowTs,
          ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef } : {}),
        };
    if (isRetry && newSnapshotRef) {
      setBubbles(previous => previous.map(bubble => bubble.id === userBubble.id ? userBubble : bubble));
    } else if (!isRetry) {
      setBubbles(prev => [...prev, userBubble]);
    }
    setDraftInput('');
    setShowInputPanel(false);
    let userDbId: number | undefined = isRetry ? userBubble.dbId : undefined;
    if (selectedChar?.id) {
      if (!userDbId) {
        userDbId = await DB.saveMessage({
          charId: selectedChar.id,
          role: 'user',
          type: 'text',
          content: input,
          metadata: {
            source: 'call',
            callSessionId: currentSessionId,
            callMode,
            ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef } : {}),
            ...(pendingTouchesForTurn.length ? {
              avatarTouches: pendingTouchesForTurn.map(({ zone, part, rawAreas, timestamp }) => ({
                zone,
                ...(part ? { part } : {}),
                rawAreas,
                timestamp,
              })),
            } : {}),
          },
        });
        setBubbles(prev => prev.map(b => (b.id === userBubble.id ? { ...b, dbId: userDbId } : b)));
        markCallTurnDirty();
      } else if (newSnapshotRef) {
        const previousSnapshotRef = retryBubble?.cameraSnapshotRef;
        try {
          await DB.updateMessageMetadata(userDbId, (previous: any) => ({
            ...(previous || {}),
            source: 'call',
            callSessionId: currentSessionId,
            callMode,
            cameraSnapshotRef: newSnapshotRef,
            cameraSnapshotExpired: false,
          }));
          if (previousSnapshotRef && previousSnapshotRef !== newSnapshotRef) {
            await deleteBlobRef(previousSnapshotRef);
          }
          markCallTurnDirty();
        } catch (error) {
          await deleteBlobRef(newSnapshotRef);
          newSnapshotRef = undefined;
          setBubbles(previous => previous.map(bubble => bubble.id === userBubble.id
            ? { ...bubble, cameraSnapshotRef: previousSnapshotRef }
            : bubble));
          console.warn('[camera-snapshot] failed to update the retried call turn:', error);
        }
      }
      await pruneCallSnapshots(selectedChar.id, currentSessionId);
    }
    if (!callStartedAt) setCallStartedAt(Date.now());
    setCallState('connecting');
    setTraceId('');
    setErrorMessage('');
    let assistantText = '';
    let assistantThinkingChain: string | undefined;
    let turnSpeechEmotion: string | undefined;
    let turnPerformance = DEFAULT_AVATAR_PERFORMANCE;
    let turnPerformanceCues: AvatarPerformanceCue[] = [];
    try {
      setCallState('thinking');
      const reply = prepareCallAssistantReply(
        await requestAssistantReply(input, userDbId, pendingTouchesForTurn, true, userCameraSnapshotForTurn),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      if (pendingTouchesForTurn.length) {
        const remainingTouches = consumePendingAvatarTouches(
          pendingAvatarTouchesRef.current,
          pendingTouchesForTurn,
        );
        pendingAvatarTouchesRef.current = remainingTouches;
        setPendingAvatarTouchCount(remainingTouches.length);
      }
      assistantText = reply.text;
      assistantThinkingChain = reply.thinkingChain;
      turnSpeechEmotion = reply.speechEmotion;
      turnPerformance = reply.performance;
      turnPerformanceCues = reply.performanceCues;
      setAvatarEmotion(reply.performance.emotion);
      setAvatarPerformance(reply.performance);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to generate the text reply');
      setCallState('error');
      return addToast(`Failed to generate the text reply: ${err?.message || 'Unknown error'}`, 'error');
    }
    const assistantBubbleId = `${Date.now()}-a`;
    const assistantBubble: CallBubble = {
      id: assistantBubbleId,
      role: 'assistant',
      text: assistantText,
      time: now,
      timestamp: nowTs,
      thinkingChain: assistantThinkingChain,
      performance: turnPerformance,
      performanceTimeline: turnPerformanceCues,
    };
    setBubbles(prev => [...prev, assistantBubble]);
    let assistantDbId: number | undefined;
    if (selectedChar?.id) {
      assistantDbId = await DB.saveMessage({
        charId: selectedChar.id,
        role: 'assistant',
        type: 'text',
        content: assistantText,
        metadata: {
          source: 'call',
          callSessionId: currentSessionId,
          callMode,
          ...(assistantThinkingChain ? { thinkingChain: assistantThinkingChain } : {}),
          avatarPerformance: turnPerformance,
          avatarPerformanceCues: turnPerformanceCues,
        },
      });
      setBubbles(prev => prev.map(b => {
        if (b.id === assistantBubbleId) return { ...b, dbId: assistantDbId };
        return b;
      }));
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);
    }
    if (!callPreferences.voiceAutoPlay) {
      setCallState('listening');
      return;
    }
    if (!canSpeakVoice()) {
      if (callMode === 'video') {
        playSilentAvatarSpeech(assistantText, turnPerformanceCues);
      } else {
        setCallState('listening');
      }
      if (isSpeakerOn) addToast('Voice is not configured yet — let\'s chat by text for now', 'info');
      return;
    }
    try {
      const { url: finalUrl, traceIds } = await takeOrSynthesizeCallAudio(assistantText, turnSpeechEmotion);
      if (!finalUrl) throw new Error('No playable audio was obtained');
      trackBlobUrl(finalUrl);
      setAudioUrl(finalUrl);
      setTimeout(() => playAudio(finalUrl, turnPerformanceCues, estimateSpeechMs(assistantText)), 0);
      setTraceId(traceIds.filter(Boolean).join(' | '));
      setBubbles(prev => prev.map(b => (b.id === assistantBubbleId ? { ...b, audioUrl: finalUrl } : b)));
      if (assistantDbId) {
        const target = bubbles.find(b => b.id === assistantBubbleId);
        await DB.updateMessage(assistantDbId, target?.text || assistantText);
      }
      setCallState('listening');
    } catch (e: any) {
      setErrorMessage(e?.message || 'Failed to generate voice');
      if (callMode === 'video') playSilentAvatarSpeech(assistantText, turnPerformanceCues);
      else setCallState('listening');
      addToast(`TTS failed: ${e?.message || 'Failed to generate voice'} — the text has been kept and silent performance is enabled`, 'info');
    }
  };
  const sendingBusy = ['connecting', 'thinking'].includes(callState);
  const pendingCallRetryText = getPendingReplyText(bubbles);
  const displayCallState: CallState = isAudioPlaying ? 'speaking' : callState;
  useEffect(() => {
    loadCallRecords(selectedCharId);
  }, [selectedCharId]);
  const handleDeleteRecord = async (record: CallRecord) => {
    setDeleteConfirmRecord(record);
  };

  const confirmDeleteRecord = async () => {
    const record = deleteConfirmRecord;
    if (!record) return;
    setDeleteConfirmRecord(null);
    // includeProcessed=true: same as loadCallRecords, otherwise call messages before the watermark can't be deleted
    const all = await DB.getMessagesByCharId(record.characterId, true);
    // Delete the call messages + the call-summary card on the Chat page
    const sessionMessages = all.filter(m => {
      if (m.metadata?.source === 'call' && m.metadata?.callSessionId === record.sessionId) return true;
      if (m.metadata?.source === 'call-end-popup' && m.metadata?.callSessionId === record.sessionId) return true;
      return false;
    });
    const ids = sessionMessages.map(message => message.id);
    const snapshotRefs = Array.from(new Set(sessionMessages
      .map(message => message.metadata?.cameraSnapshotRef)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)));
    if (ids.length) await DB.deleteMessages(ids);
    for (const snapshotRef of snapshotRefs) await deleteBlobRef(snapshotRef);
    if (recordDetailId === record.id) {
      setRecordDetailId('');
      setViewMode('history');
    }
    await loadCallRecords(record.characterId);
    addToast('Call record deleted', 'success');
    trackEvent('Delete a Call Record');
  };
  const startEditBubble = (bubble: CallBubble) => {
    if (bubble.role !== 'user') return;
    setEditingBubble(bubble);
    setEditingText(bubble.text);
  };
  const saveEditedBubble = async () => {
    if (!editingBubble) return;
    const next = editingText.trim();
    if (!next) return addToast('Content cannot be empty', 'error');
    setBubbles(prev => prev.map(b => b.id === editingBubble.id ? { ...b, text: next } : b));
    if (editingBubble.dbId) await DB.updateMessage(editingBubble.dbId, next);
    setEditingBubble(null);
    setEditingText('');
    addToast('Message updated', 'success');
    trackEvent('Edit Own Call Message');
  };
  const handleRerollAssistant = async (bubble: CallBubble) => {
    if (!selectedChar || bubble.role !== 'assistant') return;
    const idx = bubbles.findIndex(b => b.id === bubble.id);
    if (idx <= 0) return;
    const prevUser = bubbles[idx - 1];
    if (!prevUser || prevUser.role !== 'user') return;
    try {
      setRerollingBubbleId(bubble.id);
      setCallState('thinking');
      trackEvent('Reroll Character Call Line');
      const rerollReply = prepareCallAssistantReply(
        await requestAssistantReply(prevUser.text, bubble.dbId),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      const rerolled = rerollReply.text;
      setAvatarEmotion(rerollReply.performance.emotion);
      setAvatarPerformance(rerollReply.performance);
      setBubbles(prev => prev.map(b => b.id === bubble.id ? {
        ...b,
        text: rerolled,
        audioUrl: undefined,
        thinkingChain: rerollReply.thinkingChain,
        performance: rerollReply.performance,
        performanceTimeline: rerollReply.performanceCues,
      } : b));
      if (bubble.dbId) {
        await DB.updateMessage(bubble.dbId, rerolled);
        await DB.updateMessageMetadata(bubble.dbId, (previous: any) => {
          const next = {
            ...(previous || {}),
            avatarPerformance: rerollReply.performance,
            avatarPerformanceCues: rerollReply.performanceCues,
          };
          if (rerollReply.thinkingChain) next.thinkingChain = rerollReply.thinkingChain;
          else delete next.thinkingChain;
          return next;
        });
      }
      addToast('Line rerolled', 'success');
      runCallMemoryPalaceHook(selectedChar);

      // Synthesize immediately only when automatic call voice is enabled.
      let rerollAudioPlayed = false;
      if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
        try {
          setCallState('speaking');
          const { url: rerollAudioUrl } = await takeOrSynthesizeCallAudio(rerolled, rerollReply.speechEmotion);
          if (rerollAudioUrl) {
            trackBlobUrl(rerollAudioUrl);
            setAudioUrl(rerollAudioUrl);
            setBubbles(prev => prev.map(b => b.id === bubble.id ? { ...b, audioUrl: rerollAudioUrl } : b));
            setTimeout(() => playAudio(rerollAudioUrl, rerollReply.performanceCues, estimateSpeechMs(rerolled)), 0);
            rerollAudioPlayed = true;
          }
        } catch (ttsErr: any) {
          console.warn('[call] reroll TTS failed:', ttsErr?.message);
          addToast('Voice synthesis failed — the text has been kept', 'info');
        }
      }
      if (!rerollAudioPlayed && callMode === 'video' && callPreferences.voiceAutoPlay) {
        playSilentAvatarSpeech(rerolled, rerollReply.performanceCues);
      } else {
        setCallState('listening');
      }
    } catch (e: any) {
      setCallState('error');
      addToast(`Reroll failed: ${e?.message || 'Unknown error'}`, 'error');
    } finally {
      setRerollingBubbleId(null);
    }
  };

  // If an already-started call has been quiet for too long, the character can naturally
  // speak up, up to twice. This is a separate, explicit preference, off by default;
  // "Who speaks first" only decides the very first line right after the call connects.
  const idleNudgeBusyRef = useRef(false);
  const fireIdleNudge = async () => {
    if (!callPreferences.idleNudgeEnabled || idleNudgeBusyRef.current || !selectedChar?.id) return;
    if (document.visibilityState === 'hidden') return;
    idleNudgeBusyRef.current = true;
    try {
      setCallState('thinking');
      const reply = prepareCallAssistantReply(
        await requestAssistantReply(
          '(It has been quiet on the call for a while, and they still have not said anything. You are not customer service, so do not just wait it out -- speak up naturally, the way you would on a real call: casually mention what you are doing right now, pick up a bit more of the last topic, or ask if they are busy. Keep it to one or two lines, and do not repeat your last line.)',
        ),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      const nudgeTs = Date.now();
      const nudgeBubble: CallBubble = {
        id: `${nudgeTs}-nudge`,
        role: 'assistant',
        text: reply.text,
        time: formatTime(),
        timestamp: nudgeTs,
        thinkingChain: reply.thinkingChain,
        performance: reply.performance,
        performanceTimeline: reply.performanceCues,
      };
      setAvatarEmotion(reply.performance.emotion);
      setAvatarPerformance(reply.performance);
      setBubbles(previous => [...previous, nudgeBubble]);
      idleNudgeCountRef.current += 1;
      const dbId = await DB.saveMessage({
        charId: selectedChar.id,
        role: 'assistant',
        type: 'text',
        content: reply.text,
        metadata: {
          source: 'call',
          callSessionId: currentSessionId,
          ...(reply.thinkingChain ? { thinkingChain: reply.thinkingChain } : {}),
          avatarPerformance: reply.performance,
          avatarPerformanceCues: reply.performanceCues,
        },
      });
      setBubbles(previous => previous.map(bubble => bubble.id === nudgeBubble.id ? { ...bubble, dbId } : bubble));
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);

      let playbackStarted = false;
      if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
        try {
          const { url } = await takeOrSynthesizeCallAudio(reply.text, reply.speechEmotion);
          if (url) {
            trackBlobUrl(url);
            setAudioUrl(url);
            setBubbles(previous => previous.map(bubble => bubble.id === nudgeBubble.id ? { ...bubble, audioUrl: url } : bubble));
            window.setTimeout(() => playAudio(url, reply.performanceCues, estimateSpeechMs(reply.text)), 0);
            playbackStarted = true;
          }
        } catch {
          // If a proactive line can't get voice, keep the text and degrade gracefully per the current playback preference.
        }
      }
      if (!playbackStarted) {
        if (callMode === 'video' && callPreferences.voiceAutoPlay) {
          playSilentAvatarSpeech(reply.text, reply.performanceCues);
        } else if (callPreferences.voiceAutoPlay) {
          setCallState('speaking');
          const speakingMs = Math.max(1200, Math.min(4200, reply.text.length * 90));
          window.setTimeout(() => setCallState(previous => previous === 'speaking' ? 'listening' : previous), speakingMs);
        } else {
          setCallState('listening');
        }
      }
    } catch {
      setCallState(previous => previous === 'thinking' ? 'listening' : previous);
    } finally {
      idleNudgeBusyRef.current = false;
    }
  };
  useEffect(() => {
    if (!callPreferences.idleNudgeEnabled) return;
    if (viewMode !== 'in-call' || callState !== 'listening' || isAudioPlaying) return;
    if (!bubbles.length || idleNudgeCountRef.current >= 2 || idleNudgeBusyRef.current) return;
    const silenceMs = 50_000 + Math.random() * 30_000 + idleNudgeCountRef.current * 40_000;
    const timer = window.setTimeout(() => { void fireIdleNudge(); }, silenceMs);
    return () => window.clearTimeout(timer);
  }, [viewMode, callState, isAudioPlaying, bubbles, draftInput, callPreferences.idleNudgeEnabled]);

  // The composition after the user drags/zooms on the stage, written back to the character's persisted videoAvatar.
  const handleStageFramingChange = (framing: AvatarStageFraming) => {
    if (!selectedChar?.videoAvatar) return;
    updateCharacter(selectedChar.id, { videoAvatar: { ...selectedChar.videoAvatar, framing } });
  };
  // Save/clear the face anchor (null = clear).
  const handleFaceAnchorChange = (faceFraming: AvatarStageFraming | null) => {
    if (!selectedChar?.videoAvatar) return;
    updateCharacter(selectedChar.id, { videoAvatar: { ...selectedChar.videoAvatar, faceFraming: faceFraming || undefined } });
    addToast(faceFraming ? 'Face anchor saved — the AI\'s zoom-in shots will land here' : 'Face anchor cleared', 'success');
  };
  // ── Custom video stage background: a blobRef token (local image) or a direct http(s) image-host URL ──
  const stageBackgroundUrl = useBlobRefUrl(selectedChar?.videoCallBackground);
  // The blurred avatar layer on the call page is painted via CSS background-image and can't go through TokenImg's resolution, so it's resolved manually here.
  const blurredAvatarUrl = useBlobRefUrl(selectedChar?.avatar);
  const applyStageBackground = async (value?: string) => {
    if (!selectedChar) return;
    const previous = selectedChar.videoCallBackground;
    updateCharacter(selectedChar.id, { videoCallBackground: value });
    // The background token is only referenced by this one field — once replaced/cleared, the old Blob is deleted right away so nothing is orphaned
    if (previous && previous !== value) await deleteBlobRef(previous);
  };
  const chooseStageBackgroundFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 20 * 1024 * 1024) {
          addToast('The image is over 20 MB — please compress it before using it as a background', 'error');
          return;
        }
        await applyStageBackground(await putImageBlob(file));
        setShowBgPicker(false);
        addToast('Video background updated', 'success');
      } catch (error: any) {
        addToast(error?.message || 'Failed to import the background', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };
  const openBgPicker = () => {
    const current = selectedChar?.videoCallBackground;
    setBgUrlInput(current && !isBlobRef(current) ? current : '');
    setShowBgPicker(true);
  };
  const applyBgUrlInput = async () => {
    const url = bgUrlInput.trim();
    if (!/^https?:\/\//i.test(url)) {
      addToast('Please enter a direct image URL starting with http(s)', 'error');
      return;
    }
    await applyStageBackground(url);
    setShowBgPicker(false);
    addToast('Video background updated', 'success');
  };

  const avatarImportOverlay = avatarImportStatus ? (
    <div className="sully-stage-dark absolute inset-0 z-[120] flex items-center justify-center bg-[#07050c]/88 px-8 text-center backdrop-blur-xl">
      <div className="max-w-[20rem]">
        <span className="mx-auto mb-4 block h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-violet-300" />
        <div className="text-sm leading-relaxed text-white/85">{avatarImportStatus}</div>
        <div className="mt-3 text-[10px] leading-relaxed text-white/40">A model with 8K textures may take 10-30 seconds to import the first time. Please keep this page open and don't tap the button again — it will automatically move to the action-permissions page when done.</div>
      </div>
    </div>
  ) : null;
  const vroidBetaOverlay = pendingVRoidImport ? (
    <VRoidBetaWarning
      fileName={pendingVRoidImport.file.name}
      projectFile={pendingVRoidImport.projectFile}
      busy={vroidImportBusy}
      onCancel={() => { if (!vroidImportBusy) setPendingVRoidImport(null); }}
      onContinue={pendingVRoidImport.projectFile ? undefined : () => { void confirmVRoidImport(); }}
    />
  ) : null;
  if (viewMode === 'role-select') {
    const groupChars = filterCharactersByGroup(characters, characterGroups, roleGroupId);
    const totalPages = Math.max(1, Math.ceil(groupChars.length / ROLES_PER_PAGE));
    const page = Math.min(rolePage, totalPages - 1);
    const pagedChars = groupChars.slice(page * ROLES_PER_PAGE, page * ROLES_PER_PAGE + ROLES_PER_PAGE);
    return (
      <div className={`relative h-full w-full bg-gradient-to-b text-white flex flex-col overflow-hidden ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#e9ecf5]' : 'from-[#140d28] via-[#0a0613] to-[#05030c]'}`}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        {avatarImportOverlay}
        {vroidBetaOverlay}
        {showCallUpdateAnnouncement && (
          <CallUpdateAnnouncement
            accentColor={accentColor}
            onDismiss={dismissCallUpdateAnnouncement}
            onOpenSettings={openCallPreferencesPanel}
          />
        )}
        {showCallSetupGuide && (
          <CallSetupGuide
            step={callSetupGuideStep}
            characterName={selectedChar?.name || 'the current character'}
            modelName={selectedChar?.videoAvatar?.fileName}
            modelFormat={selectedChar?.videoAvatar?.format}
            avatarSource={selectedVisualSource}
            staticImageName={selectedChar?.companionAvatar?.fileName}
            hasDatePortraits={hasDatePortraits(selectedChar)}
            dateOutfitName={selectedDateOutfit?.name}
            cameraMode={setupCameraMode}
            hasFakeImage={!!fakeUserCameraRef}
            accentColor={accentColor}
            lightTheme={lightTheme}
            onStepChange={setCallSetupGuideStep}
            onChooseModelFile={chooseAvatarModel}
            onChooseLive2DFolder={chooseLive2DDirectory}
            onChooseAvatarSource={chooseVideoAvatarSource}
            onChooseStaticImage={chooseStaticAvatarImage}
            onManageDatePortraits={() => openApp(AppID.Date)}
            onConfigureLive2D={selectedChar?.videoAvatar?.format === 'live2d' ? () => {
              setLive2DWardrobeOnboarding(true);
              setShowLive2DSettings(true);
            } : undefined}
            onCameraModeChange={setSetupCameraMode}
            onChooseFakeImage={() => chooseFakeUserCameraImage(false)}
            onStart={finishCallSetupGuide}
            onClose={closeCallSetupGuide}
          />
        )}
        {showCallPreferences && (
          <CallPreferencesSheet
            preferences={callPreferences}
            accentColor={accentColor}
            lightTheme={lightTheme}
            onChange={next => {
              setCallPreferences(next);
              trackEvent('Set Call Preferences', {
                'Who Speaks First': next.characterInitiative ? 'Character' : 'User',
                'Auto-generate and Play Voice': next.voiceAutoPlay ? 'On' : 'Off',
                'Speak Up After Silence': next.idleNudgeEnabled ? 'On' : 'Off',
              });
            }}
            onOpenSystemSettings={() => {
              setShowCallPreferences(false);
              openApp(AppID.Settings);
            }}
            onClose={() => setShowCallPreferences(false)}
          />
        )}
        {/* floating sparkles */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {CALL_SPARKLES.map((p, i) => (
            <span key={i} className="absolute rounded-full bg-white animate-pulse"
              style={{ top: p.top, left: p.left, width: p.s, height: p.s, opacity: 0.5, animationDelay: `${i * 0.4}s`, boxShadow: `0 0 6px ${accentColor}` }} />
          ))}
        </div>
        {/* top-right character art bleed */}
        {selectedChar?.avatar && (
          <div className="absolute top-0 right-0 w-48 h-60 pointer-events-none"
            style={{ WebkitMaskImage: 'radial-gradient(135% 105% at 100% 0%, #000 32%, transparent 72%)', maskImage: 'radial-gradient(135% 105% at 100% 0%, #000 32%, transparent 72%)' }}>
            <TokenImg value={selectedChar.avatar} alt="" className="w-full h-full object-cover object-top opacity-60" />
          </div>
        )}

        <div
          className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden px-5"
          style={{
            paddingTop: 'max(2.5rem, var(--safe-top))',
            paddingBottom: 'max(1.25rem, var(--safe-bottom, 0px))',
          }}
        >
          {/* header */}
          <div className="shrink-0">
            <div className="text-[10px] tracking-[0.42em] text-white/35 font-semibold">CHAT WITH</div>
            <h1 className="mt-1 text-[2rem] font-bold leading-tight inline-flex items-start gap-1.5">
              Who do you want to talk to?
              <span className="text-sm mt-1" style={{ color: accentColor, textShadow: `0 0 10px ${accentColor}` }}>✦</span>
            </h1>
            <p className="text-sm text-white/45 mt-1">Pick someone, and give them a call.</p>
          </div>

          {/* Group filter (not rendered if no groups have been created) */}
          <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark={!lightTheme}
            value={roleGroupId} onChange={(id) => { setRoleGroupId(id); setRolePage(0); }} className="mt-4 shrink-0" />

          {/* character cards (6 / page) */}
          <div className="mt-4 min-h-[5rem] flex-1 overflow-y-auto overscroll-contain no-scrollbar space-y-2.5 pr-0.5" data-testid="call-character-picker">
            {pagedChars.map(char => {
              const selected = selectedCharId === char.id;
              return (
                <button key={char.id} onClick={() => setSelectedCharId(char.id)}
                  className="relative w-full rounded-3xl px-4 py-3.5 text-left border backdrop-blur-md transition active:scale-[0.99]"
                  style={selected
                    ? { borderColor: accentColor, background: `${accentColor}22`, boxShadow: `0 0 18px ${accentColor}55, inset 0 0 18px ${accentColor}1f` }
                    : { borderColor: 'rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)' }}>
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 rounded-full overflow-hidden border flex items-center justify-center font-semibold shrink-0"
                      style={{ borderColor: selected ? accentColor : 'rgba(255,255,255,0.25)', backgroundColor: `${accentColor}40` }}>
                      {char.avatar ? <TokenImg value={char.avatar} alt={char.name} className="w-full h-full object-cover" /> : (char.name?.[0] || 'C')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[15px] truncate" style={selected ? { color: accentColor } : undefined}>{char.name}</div>
                      <div className="text-xs text-white/45 mt-0.5 truncate">{char.description || 'Tap to edit settings...'}</div>
                    </div>
                    <span className="text-base shrink-0" style={{ color: selected ? accentColor : 'rgba(255,255,255,0.25)' }}>✦</span>
                  </div>
                </button>
              );
            })}
            {!groupChars.length && (
              <div className="text-center py-10 text-white/40 text-sm">{characters.length ? 'No characters in this group' : 'No characters yet — go create one first'}</div>
            )}
          </div>

          {/* pagination */}
          {totalPages > 1 && (
            <div className="shrink-0 flex items-center justify-center gap-3 pt-3">
              <button disabled={page === 0} onClick={() => setRolePage(p => Math.max(0, p - 1))}
                className="w-7 h-7 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/70 disabled:opacity-25 active:scale-90 transition">
                <CaretLeft size={14} weight="bold" />
              </button>
              <div className="flex items-center gap-1.5">
                {Array.from({ length: totalPages }).map((_, i) => (
                  <button key={i} onClick={() => setRolePage(i)} aria-label={`Page ${i + 1}`}
                    className="rounded-full transition-all" style={{ width: i === page ? 16 : 6, height: 6, background: i === page ? accentColor : 'rgba(255,255,255,0.25)' }} />
                ))}
              </div>
              <button disabled={page >= totalPages - 1} onClick={() => setRolePage(p => Math.min(totalPages - 1, p + 1))}
                className="w-7 h-7 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/70 disabled:opacity-25 active:scale-90 transition">
                <CaretRight size={14} weight="bold" />
              </button>
            </div>
          )}

          {/* actions */}
          <div className="shrink-0 pt-4 space-y-2.5" data-testid="call-role-actions">
            <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-black/20 p-1">
              <button
                onClick={() => setCallMode('voice')}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium transition ${callMode === 'voice' ? 'bg-white/12 text-white' : 'text-white/40'}`}
              >
                <Phone size={15} weight={callMode === 'voice' ? 'fill' : 'regular'} /> Voice
              </button>
              <button
                onClick={() => setCallMode('video')}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium transition ${callMode === 'video' ? 'bg-white/12 text-white' : 'text-white/40'}`}
                style={callMode === 'video' ? { boxShadow: `inset 0 0 0 1px ${accentColor}55` } : undefined}
              >
                <VideoCamera size={15} weight={callMode === 'video' ? 'fill' : 'regular'} /> Video
              </button>
            </div>
            {callMode === 'video' && (
              <div className="space-y-2">
                <button
                  onClick={() => openCallSetupGuide('model')}
                  className="w-full flex items-center gap-3 px-1 py-1 text-left transition active:opacity-60"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05]" style={{ color: accentColor }}>
                    <Cube size={15} weight="fill" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] tracking-[0.16em] text-white/35">Character Avatar · {selectedVisualSource === 'upload' ? 'Static Image' : selectedVisualSource === 'date' ? 'Date Portrait' : selectedChar?.videoAvatar?.format === 'live2d' ? 'LIVE2D' : selectedChar?.videoAvatar?.format === 'vrm' ? 'VRM' : 'Not Selected'}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/70">{selectedVisualSource === 'upload' ? selectedChar?.companionAvatar?.fileName || 'PNG / GIF' : selectedVisualSource === 'date' ? selectedDateOutfit?.name || 'Switches expression by call emotion' : selectedChar?.videoAvatar?.fileName || 'Animated model, static image, or Date portrait'}</span>
                  </span>
                  <span className="text-xs text-white/30">{hasSelectedVideoVisual ? 'Settings' : 'Guide'}</span>
                </button>
                <details className="group rounded-2xl border border-white/10 bg-black/15 p-2" data-testid="video-call-advanced-settings">
                  <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-2 py-1.5 text-[10px] text-white/42">
                    <span>Model quality, import, and action rehearsal</span>
                    <span className="transition-transform group-open:rotate-45">＋</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                  {selectedBuiltinSullyAvatar && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-2.5" data-testid="builtin-sully-quality-picker">
                    <div className="flex items-center justify-between px-0.5">
                      <span className="text-[10px] tracking-[0.14em] text-white/40">Built-in Model Quality</span>
                      <span className="text-[9px] text-white/28">Default 2K · saves about 48 MB VRAM</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {([
                        { value: 'balanced' as const, label: 'Lightweight 2K', detail: 'Recommended' },
                        { value: 'hd' as const, label: 'HD 4K', detail: 'High-performance devices' },
                      ]).map(option => {
                        const active = selectedBuiltinSullyAvatar.builtinQuality === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => chooseBuiltinSullyQuality(option.value)}
                            className={`rounded-xl border px-2 py-2 text-left transition active:scale-[.98] ${active ? 'bg-white/12 text-white' : 'border-white/8 bg-white/[.025] text-white/42'}`}
                            style={active ? { borderColor: `${accentColor}77` } : undefined}
                          >
                            <span className="block text-[10px] font-medium">{option.label}</span>
                            <span className="mt-0.5 block text-[8px] opacity-55">{option.detail}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={chooseAvatarModel} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-[10px] text-white/50 active:scale-[0.98]">
                    <FileZip size={12} weight="bold" /> VRM / L2D ZIP
                  </button>
                  <button onClick={chooseLive2DDirectory} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-[10px] text-white/50 active:scale-[0.98]">
                    <FolderOpen size={12} weight="bold" /> L2D Folder
                  </button>
                </div>
                <p className="px-1 text-[9px] leading-relaxed text-white/30">L2D Folder: select the entire folder that contains *.model3.json — don't just select model3.json. ZIP: compress the whole model folder and select the ZIP.</p>
                {selectedChar?.videoAvatar?.format === 'live2d' && (
                  <details className="group border-t border-white/[0.07] pt-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-1 py-1 text-[10px] text-white/35">
                      <span>Live2D Advanced Tools</span>
                      <span className="transition group-open:rotate-45">＋</span>
                    </summary>
                    <button
                      onClick={() => setShowLive2DSettings(true)}
                      className="mt-1 flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-left active:scale-[0.99]"
                    >
                      <span>
                        <span className="block text-[11px] text-white/65">Action Permissions & Parameter Lab</span>
                        <span className="mt-0.5 block text-[9px] text-white/28">Preview or disable model actions, or manually combine parameters</span>
                      </span>
                      <Gear size={14} className="text-white/30" />
                    </button>
                  </details>
                )}
                <div className="rounded-2xl border border-white/10 bg-black/20 p-2.5">
                  <div className="flex items-center justify-between px-0.5">
                    <div>
                      <div className="text-[10px] tracking-[0.14em] text-white/40">Action Rehearsal</div>
                      <div className="mt-0.5 text-[9px] text-white/25">Saved separately per character</div>
                    </div>
                    <span className="text-[9px]" style={{ color: selectedChar?.videoCallPerformanceQuality === 'high' ? accentColor : 'rgba(255,255,255,.32)' }}>
                      {selectedChar?.videoCallPerformanceQuality === 'high' ? 'DIRECTOR' : 'BASIC'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {([
                      { value: 'basic' as const, label: 'Basic', detail: 'No extra requests' },
                      { value: 'high' as const, label: 'High Quality', detail: 'Secondary API rehearsal' },
                    ]).map(option => {
                      const active = (selectedChar?.videoCallPerformanceQuality || 'basic') === option.value;
                      return (
                        <button
                          key={option.value}
                          onClick={() => {
                            if (!selectedChar) return;
                            updateCharacter(selectedChar.id, { videoCallPerformanceQuality: option.value });
                            addToast(
                              option.value === 'high'
                                ? 'High-quality action rehearsal enabled: one extra Emotion Buff API call per turn'
                                : 'Switched to basic action rehearsal',
                              'success',
                            );
                          }}
                          className="rounded-xl border px-2 py-2 text-left transition active:scale-[0.98]"
                          style={active
                            ? { borderColor: `${accentColor}88`, background: `${accentColor}1f`, boxShadow: `inset 0 0 12px ${accentColor}16` }
                            : { borderColor: 'rgba(255,255,255,.08)', background: 'rgba(255,255,255,.025)' }}
                        >
                          <span className="block text-[11px] font-medium text-white/80">{option.label}</span>
                          <span className="mt-0.5 block text-[8px] text-white/30">{option.detail}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 px-0.5 text-[9px] leading-relaxed text-white/30">
                    The high-quality version only sends this turn's finalized line and the character's personality to the Emotion Buff API — it doesn't read chat context; falls back to the Primary API when no Secondary API is configured separately.
                  </p>
                </div>
                  </div>
                </details>
              </div>
            )}
            <button onClick={requestSelectedCall}
              className="relative w-full py-3.5 rounded-2xl overflow-hidden transition active:scale-[0.98]"
              style={{ background: `linear-gradient(to right, ${accentColor}26, ${accentColor}4d, ${accentColor}26)`, border: `1px solid ${accentColor}80`, boxShadow: `0 0 22px ${accentColor}40` }}>
              <span className="absolute inset-[3px] rounded-xl border border-white/10 pointer-events-none" />
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-xs" style={{ color: accentColor }}>✦</span>
              <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xs text-white/60">✦</span>
              <span className="relative text-white/90 text-[15px]">
                {selectedChar ? <>{callMode === 'video' ? 'Video Connect ' : 'Call '}<span className="font-serif italic text-xl align-baseline" style={{ textShadow: `0 0 12px ${accentColor}` }}>{selectedChar.name}</span></> : 'Start Call'}
              </span>
            </button>
            <button onClick={() => { setViewMode('history'); trackEvent('Open Call History'); }}
              className="relative w-full py-3 rounded-2xl border border-white/15 bg-white/[0.04] backdrop-blur-md text-white/80 flex items-center justify-center gap-2 transition active:scale-[0.98] hover:bg-white/[0.08]">
              <Clock size={16} weight="bold" style={{ color: accentColor }} /> Call History
            </button>
            <div className="flex items-center justify-between pt-1">
              <button onClick={openCallPreferencesPanel} title="Call Preferences" data-testid="call-preferences-entry"
                className="w-9 h-9 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/60 active:scale-90 transition">
                <Gear size={16} weight="fill" />
              </button>
              <button onClick={closeApp} className="flex items-center gap-2 text-sm text-white/45 active:scale-95 transition">
                <span style={{ color: accentColor }}>✦</span> Close <span style={{ color: accentColor }}>✦</span>
              </button>
              <button onClick={() => setCallTheme(lightTheme ? 'dark' : 'light')} title={lightTheme ? 'Switch to dark theme' : 'Switch to light theme'}
                className="w-9 h-9 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/60 active:scale-90 transition">
                {lightTheme ? <Moon size={16} weight="fill" /> : <Sun size={16} weight="fill" />}
              </button>
            </div>
          </div>
        </div>
        {showLive2DSettings && selectedChar?.videoAvatar?.format === 'live2d' && (
          <div className="sully-stage-dark" style={{ display: 'contents' }}>
            <Live2DActionSettings
              config={selectedChar.videoAvatar}
              characterName={selectedChar.name}
              accentColor={accentColor}
              setupMode={live2DWardrobeOnboarding ? 'import' : 'advanced'}
              onClose={() => { setShowLive2DSettings(false); setLive2DWardrobeOnboarding(false); }}
              onSave={(config: Live2DAvatarConfig) => {
                updateCharacter(selectedChar.id, { videoAvatar: config });
                setShowLive2DSettings(false);
                setLive2DWardrobeOnboarding(false);
                addToast(`Saved: wardrobe ${config.actions.filter(action => action.wardrobe).length} sets · AI has ${getLive2DAIActions(config).length} actions available`, 'success');
              }}
            />
          </div>
        )}
      </div>
    );
  }
  if (viewMode === 'history') {
    return (
      <div className={`h-full w-full bg-gradient-to-b text-white px-5 pb-6 flex flex-col ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#eef0f8]' : 'from-[#140d28] via-[#0a0613] to-[#0a0613]'}`} style={{ paddingTop: 'max(2.5rem, var(--safe-top))' }}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('role-select')} className="text-sm text-white/45">← Back</button>
          <h1 className="text-lg font-medium">Call History</h1>
          <button onClick={() => setViewMode('role-select')} className="text-sm font-medium" style={{ color: accentColor }}>New Call</button>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-3">
          {!callRecords.length && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-base text-white/45">No call history yet</p>
              <p className="text-sm text-white/35 mt-1">Every call will be kept here</p>
            </div>
          )}
          {callRecords.map(record => {
            const turnCount = record.transcript.filter(t => t.role === 'user').length;
            const keepsake = summarizeKeepsakeLine(record.transcript, record.characterName);
            return (
            <button key={record.id} onClick={() => { setRecordDetailId(record.id); setViewMode('record-detail'); }} className="w-full rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md p-4 text-left transition hover:bg-white/[0.08]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center text-sm" style={{ backgroundColor: `${accentColor}35` }}>{record.characterName[0] || 'C'}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{record.characterName}</div>
                  <div className="text-xs text-white/45 mt-0.5">{record.mode === 'video' ? 'Video' : record.mode === 'voice' ? 'Voice' : 'Call'} · {formatDuration(record.durationSec)} · {turnCount} turns</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record); }} className="text-xs px-2 py-1 rounded-lg text-white/35 transition hover:text-rose-300">Delete</button>
              </div>
              <div className="text-xs text-white/60 mt-2.5 italic leading-relaxed line-clamp-2">{keepsake}</div>
              <div className="text-[10px] text-white/30 mt-1.5">{record.createdAt}</div>
            </button>
          );})}
        </div>

        {/* Delete confirm overlay */}
        {deleteConfirmRecord && (
          <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
            <div className={`w-full max-w-sm rounded-3xl border border-white/15 bg-gradient-to-b p-5 shadow-2xl ${lightTheme ? 'from-white to-[#f0edf9]' : 'from-[#1a1130] to-[#0a0613]'}`}>
              <div className="text-base font-semibold text-white">Delete call record?</div>
              <p className="mt-2 text-sm text-white/55 leading-relaxed">This call with {deleteConfirmRecord.characterName} will be permanently deleted.</p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button onClick={() => setDeleteConfirmRecord(null)} className="py-2.5 rounded-2xl border border-white/20 text-white/80 transition active:scale-[0.97]">Cancel</button>
                <button onClick={confirmDeleteRecord} className="keep-white py-2.5 rounded-2xl bg-rose-500/80 text-white font-semibold transition active:scale-[0.97]">Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (viewMode === 'record-detail' && recordDetail) {
    return (
      <div className={`h-full w-full bg-gradient-to-b text-white px-5 pb-6 flex flex-col ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#eef0f8]' : 'from-[#140d28] via-[#0a0613] to-[#0a0613]'}`} style={{ paddingTop: 'max(2.5rem, var(--safe-top))' }}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('history')} className="text-sm text-white/45">← Back</button>
          <div className="text-sm text-white/80 font-medium">{recordDetail.characterName}</div>
          <div className="text-xs text-white/35">{recordDetail.mode === 'video' ? 'Video · ' : recordDetail.mode === 'voice' ? 'Voice · ' : ''}{formatDuration(recordDetail.durationSec)}</div>
        </div>
        <div className="mt-2 text-center">
          <p className="text-xs text-white/35 italic">{recordDetail.createdAt}</p>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-2.5">
          {recordDetail.transcript.map(item => (
            <div
              key={item.id}
              onContextMenu={(event) => {
                if (item.role !== 'assistant') return;
                event.preventDefault();
                void openCallVoiceFavorite(item, recordDetail.characterId, recordDetail.characterName);
              }}
              onTouchStart={(event) => {
                if (item.role !== 'assistant') return;
                callLongPressTriggeredRef.current = false;
                callTouchStartPos.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
                longPressTimerRef.current = window.setTimeout(() => {
                  callLongPressTriggeredRef.current = true;
                  void openCallVoiceFavorite(item, recordDetail.characterId, recordDetail.characterName);
                }, 450);
              }}
              onTouchMove={(event) => {
                if (!longPressTimerRef.current) return;
                const dx = Math.abs(event.touches[0].clientX - callTouchStartPos.current.x);
                const dy = Math.abs(event.touches[0].clientY - callTouchStartPos.current.y);
                if (dx > 10 || dy > 10) {
                  window.clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = null;
                }
              }}
              onTouchEnd={() => {
                if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
              }}
              className={`rounded-2xl px-3.5 py-2.5 border border-white/10 backdrop-blur-md ${item.role === 'user' ? 'bg-white/[0.07] ml-6' : 'bg-white/[0.03] mr-6'}`}
            >
              <div className="text-[10px] text-white/45">{item.role === 'user' ? 'You' : recordDetail.characterName} · {item.time}</div>
              {item.role === 'user' && <CallSnapshotImage imageRef={item.cameraSnapshotRef} expired={item.cameraSnapshotExpired} />}
              <div className="text-sm mt-1 leading-relaxed">{(() => {
                if (item.role !== 'assistant') return item.text;
                const { display, voiceText } = extractVoiceTag(item.text);
                const cleanVoice = stripTtsMarkupForDisplay(voiceText, apiConfig);
                return <>{renderAssistantLine(display, accentColor)}{cleanVoice && <div className="mt-1 text-[10px] text-white/40 italic">{cleanVoice}</div>}</>;
              })()}</div>
              {item.role === 'assistant' && (
                <button
                  onClick={() => {
                    if (callLongPressTriggeredRef.current) { callLongPressTriggeredRef.current = false; return; }
                    void handlePlayBubbleAudio(item);
                    trackEvent('Play Voice from Call History');
                  }}
                  disabled={!!generatingAudioBubbleId}
                  className="mt-2 text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/60 transition hover:bg-white/15 disabled:opacity-40"
                >
                  {generatingAudioBubbleId === item.id ? 'Generating voice…' : item.audioUrl ? 'Replay Voice' : 'Play Voice'}
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            setSelectedCharId(recordDetail.characterId || selectedCharId);
            resetCurrentCall();
            primeCallAudioFromGesture();
            setCallStartedAt(Date.now());
            setCallState('listening');
            setViewMode('in-call');
            trackEvent('Call Again');
          }}
          className="keep-white w-full py-3 rounded-2xl mt-4 font-medium text-white transition active:scale-[0.98]"
          style={{ backgroundColor: accentColor }}
        >Call Again</button>
        <VoiceFavoriteActionSheet
          open={!!voiceFavoriteTarget}
          favorited={voiceFavoriteSaved}
          busy={voiceFavoriteBusy}
          title="Call Voice"
          preview={voiceFavoriteTarget ? (stripCallTextFormatting(extractVoiceTag(voiceFavoriteTarget.bubble.text).display) || stripTtsMarkupForDisplay(extractVoiceTag(voiceFavoriteTarget.bubble.text).voiceText, apiConfig)) : ''}
          onToggle={() => void toggleCallVoiceFavorite()}
          onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
        />
      </div>
    );
  }
  const waveActive = displayCallState === 'speaking' || displayCallState === 'thinking';
  const connSub = callState === 'connecting' ? 'Establishing encrypted connection...'
    : callState === 'error' ? 'Connection is unstable'
    : 'Connection is stable';
  const analyzeLabel = displayCallState === 'speaking' ? { cn: 'Speaking', en: 'SPEAKING' }
    : displayCallState === 'thinking' ? { cn: 'Analyzing', en: 'VOICE ANALYZING' }
    : displayCallState === 'connecting' ? { cn: 'Connecting', en: 'CONNECTING' }
    : displayCallState === 'error' ? { cn: 'Connection Error', en: 'SIGNAL ERROR' }
    : { cn: 'Listening', en: 'LISTENING' };
  const latestCallBubble = bubbles[bubbles.length - 1];
  const compactVideoTranscript = callMode === 'video' && videoCallLayout === 'stage' && !videoTranscriptExpanded;
  const videoStageSize = videoCallLayout === 'stage'
    ? 'min-h-0'
    : videoCallLayout === 'mini'
      ? 'h-[clamp(140px,26dvh,230px)] min-h-0'
      : 'h-[clamp(170px,34dvh,300px)] min-h-0';
  const callControlSize = callMode === 'video' ? 'h-10 w-10' : 'h-14 w-14';
  return (
    <div
      className={`h-full w-full relative text-white flex flex-col overflow-hidden ${lightTheme ? 'sully-call-light bg-[#eef0f7]' : 'bg-[#0a0613]'}`}
      data-avatar-touch-pending={pendingAvatarTouchCount}
      data-call-video-layout={callMode === 'video' ? videoCallLayout : undefined}
    >
      {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
      <style>{`
        @keyframes sully-call-stage-in { from { opacity:0; transform:translateY(10px) scale(.985) } to { opacity:1; transform:translateY(0) scale(1) } }
        @keyframes sully-call-subtitle-in { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes sully-camera-emotion-readout { 0% { opacity:0; transform:translate(-50%,6px) } 18%,72% { opacity:.78; transform:translate(-50%,0) } 100% { opacity:0; transform:translate(-50%,-3px) } }
        .sully-video-stage-shell { animation: sully-call-stage-in 420ms cubic-bezier(.2,.8,.2,1) both; transition: height 320ms cubic-bezier(.2,.8,.2,1), min-height 320ms cubic-bezier(.2,.8,.2,1); }
        [data-call-video-layout="stage"] .sully-video-stage-shell { max-height: none; }
        body.ios-keyboard-open [data-call-video-layout="stage"] .sully-video-stage-shell { max-height: 0; }
        @media (prefers-reduced-motion: reduce) { .sully-video-stage-shell, .sully-call-video-subtitle, .sully-camera-emotion-readout { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
      `}</style>
      {avatarImportOverlay}
      {vroidBetaOverlay}
      {/* blurred character art */}
      <div
        className="absolute inset-0 bg-cover bg-center scale-125 blur-3xl opacity-30"
        style={{ backgroundImage: blurredAvatarUrl ? `url(${blurredAvatarUrl})` : undefined }}
      />
      {/* accent aura glows */}
      <div className="absolute -top-28 left-1/2 -translate-x-1/2 w-[130%] h-72 rounded-full blur-3xl opacity-40 pointer-events-none"
        style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)` }} />
      <div className="absolute -bottom-20 left-1/2 -translate-x-1/2 w-[150%] h-80 rounded-full blur-3xl opacity-25 pointer-events-none"
        style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)` }} />
      {/* vignette —— on the light theme, swaps to a soft white veil that dims the blurred avatar without going gray */}
      <div className={`absolute inset-0 bg-gradient-to-b pointer-events-none ${lightTheme ? 'from-white/60 via-[#f2f0fa]/70 to-white/80' : 'from-black/55 via-[#0a0613]/75 to-black/90'}`} />
      {/* floating sparkles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {CALL_SPARKLES.map((p, i) => (
          <span key={i} className="absolute rounded-full bg-white animate-pulse"
            style={{ top: p.top, left: p.left, width: p.s, height: p.s, opacity: 0.5, animationDelay: `${i * 0.4}s`, boxShadow: `0 0 6px ${accentColor}` }} />
        ))}
      </div>
      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        {/* Keyboard avoidance doesn't do a paddingBottom fallback here: it's left to the global
            interactive-widget=resizes-content mechanism and, on iOS fullscreen PWA, the app
            height following the viewport (see utils/iosStandalone.ts) — same as Chat and the
            other apps. */}
      {/* top channel bar */}
      <div className="relative shrink-0 px-5" style={{ paddingTop: 'max(2.25rem, var(--safe-top))' }}>
        <div className="absolute left-5 leading-tight" style={{ top: 'max(2.25rem, var(--safe-top))' }}>
          <div className="text-[9px] tracking-[0.28em] text-white/45 font-semibold">{callMode === 'video' ? 'SULLYOS · VIDEO DATE' : 'PRIVATE CHANNEL'}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[8px] tracking-[0.22em] text-white/35">
            {callMode === 'video' ? 'CHARACTER LINK' : 'VOICE SYNC'}
            <span className="flex items-center gap-[2px] h-2">
              {CALL_WAVE.slice(0, 7).map((h, i) => (
                <span key={i} className="w-[2px] rounded-full bg-white/40" style={{ height: `${waveActive ? Math.max(2, h / 4) : 2}px` }} />
              ))}
            </span>
          </div>
        </div>
        <div className="absolute right-5 flex items-center gap-1 text-[9px] tracking-[0.2em] text-white/45 font-medium" style={{ top: 'max(2.25rem, var(--safe-top))' }}>
          Strong Signal
          <span className="flex items-end gap-[2px] h-2.5 ml-0.5">
            {[4, 6, 8, 10].map((h, i) => (
              <span key={i} className="w-[2px] rounded-full" style={{ height: `${h}px`, background: i < 3 ? 'rgba(255,255,255,.65)' : accentColor }} />
            ))}
          </span>
          <span style={{ color: accentColor }}>✦</span>
        </div>
        {/* name block */}
        <div className={`${callMode === 'video' ? 'pt-3' : 'pt-7'} text-center`}>
          {callMode !== 'video' && <div className="text-sm" style={{ color: `${accentColor}cc`, textShadow: `0 0 12px ${accentColor}` }}>❀</div>}
          <h1 className={`font-serif leading-none tracking-wide text-white ${callMode === 'video' ? 'text-[1.55rem]' : 'mt-0.5 text-[2.6rem]'}`} style={{ textShadow: `0 0 26px ${accentColor}aa, 0 0 6px ${accentColor}66` }}>{selectedChar?.name || 'Not selected'}</h1>
          {callMode === 'video' ? (
            <div className="mt-1 flex items-center justify-center gap-2 text-[8px] tracking-[0.18em] text-white/48">
              <span>{connSub}</span><span style={{ color: accentColor }}>◆</span><span className="tabular-nums text-[13px] font-light" style={{ color: accentColor }}>{formatDuration(elapsedSeconds)}</span>
            </div>
          ) : (
            <>
              <div className="mt-2.5 text-[11px] tracking-[0.25em] text-white/55">{connSub}</div>
              <div className="mt-1.5 text-lg tabular-nums font-extralight tracking-[0.2em]" style={{ color: accentColor }}>{formatDuration(elapsedSeconds)}</div>
            </>
          )}
          {callMode === 'video' && (
            <div className="mx-auto mt-1 grid w-[15rem] grid-cols-3 rounded-full border border-white/10 bg-black/25 p-0.5 backdrop-blur-md" data-testid="video-call-layout-picker">
              {VIDEO_CALL_LAYOUTS.map(option => (
                <button
                  key={option.id}
                  onClick={() => chooseVideoCallLayout(option.id)}
                  className={`flex items-center justify-center gap-1 rounded-full py-1 text-[9px] font-medium transition active:scale-95 ${videoCallLayout === option.id ? 'bg-white/14 text-white' : 'text-white/38'}`}
                  title={option.hint}
                >
                  {videoCallLayout === option.id && <Check size={9} weight="bold" style={{ color: accentColor }} />}{option.name}
                </button>
              ))}
            </div>
          )}
          {memoryPalaceStatus && (
            <div className="mt-1 text-[10px] text-white/55 animate-pulse">
              Organizing Memory · {memoryPalaceStatus}
            </div>
          )}
        </div>
      </div>
      {/* portrait + aura —— when the keyboard is open (body.ios-keyboard-open) this whole block
          collapses, giving the viewport back to the messages + input box, so the large avatar
          doesn't push the input box above the visible area above the keyboard (see the
          .sully-call-hero rule in index.html). */}
      {callMode === 'video' ? (
        <div className={`sully-call-hero sully-stage-dark sully-video-stage-shell relative px-2 pb-2 pt-2 ${videoCallLayout === 'stage' ? 'flex-1 min-h-0' : 'shrink-0'} ${videoStageSize}`}>
          <span className="pointer-events-none absolute left-3 top-3 z-20 h-8 w-8 rounded-tl-[1.8rem] border-l border-t" style={{ borderColor: `${accentColor}aa` }} aria-hidden />
          {userCameraMode === 'off' && <span className="pointer-events-none absolute right-3 top-3 z-20 h-8 w-8 rounded-tr-[1.8rem] border-r border-t" style={{ borderColor: `${accentColor}aa` }} aria-hidden />}
          <span className="pointer-events-none absolute bottom-3 left-3 z-20 text-[8px]" style={{ color: accentColor }} aria-hidden>✦</span>
          <span className="pointer-events-none absolute bottom-3 right-3 z-20 text-[7px] text-white/55" aria-hidden>✦</span>
          {/* The action editor owns its own WebGL preview; suspend this one. */}
          <VRMVideoCallStage
            characterName={selectedChar?.name || 'Not selected'}
            fallbackAvatar={selectedChar?.avatar}
            model={!showLive2DSettings && selectedVisualSource === 'model' ? selectedChar?.videoAvatar : undefined}
            staticAvatarSource={staticVideoAvatarActive ? selectedVisualSource : undefined}
            staticPortraitValue={staticVideoPortrait}
            staticExpressionKey={staticVideoExpressionKey}
            staticSpriteConfig={selectedChar?.spriteConfig}
            motionState={displayCallState}
            emotion={avatarEmotion}
            audioFeed={getAudioFeed()}
            performance={avatarPerformance}
            performanceQuality={selectedChar?.videoCallPerformanceQuality || 'basic'}
            accentColor={accentColor}
            backgroundUrl={stageBackgroundUrl}
            onChooseModel={() => openCallSetupGuide('model')}
            onChooseLive2DFolder={chooseLive2DDirectory}
            onConfigureActions={() => setShowLive2DSettings(true)}
            onConfigureBackground={openBgPicker}
            onFramingChange={handleStageFramingChange}
            onFaceAnchorChange={handleFaceAnchorChange}
            onExpressionsDiscovered={names => { vrmExpressionsRef.current = names; }}
            onAvatarTouch={handleAvatarTouch}
            maxFps={30}
          />
          <AvatarTouchFeedback
            characterName={selectedChar?.name || 'them'}
            accentColor={accentColor}
            effects={avatarTouchEffects}
            lightTheme={lightTheme}
          />
          {userCameraMode !== 'off' && (
            <div className="absolute right-4 top-4 z-30" data-testid="user-camera-preview">
              <div
                className={`${USER_CAMERA_PREVIEW_SIZES.find(option => option.id === userCameraPreviewSize)?.frameClass || USER_CAMERA_PREVIEW_SIZES[1].frameClass} relative overflow-hidden rounded-[1.15rem] border border-white/30 bg-black/45 shadow-[0_14px_38px_rgba(0,0,0,.48)] ring-1 ring-black/20 transition-[width,height] duration-200`}
                data-testid={`user-camera-preview-${userCameraPreviewSize}`}
              >
                {userCameraMode === 'fake'
                  ? fakeUserCameraUrl
                    ? <img src={fakeUserCameraUrl} alt="User's static image" className="h-full w-full object-cover" />
                    : <div className="flex h-full w-full items-center justify-center text-[8px] text-white/35">NO IMAGE</div>
                  : <video ref={userCameraVideoRef} muted playsInline autoPlay className="h-full w-full scale-x-[-1] object-cover" />}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/70 to-transparent" aria-hidden />
                <span
                  className={`absolute left-2 top-2 rounded-full border border-white/15 bg-black/50 px-1.5 py-0.5 text-[6px] font-semibold tracking-[0.14em] backdrop-blur-md ${userCameraMode === 'emotion' ? 'text-emerald-200' : userCameraMode === 'snapshot' ? 'text-violet-200' : 'text-white/70'}`}
                >
                  {userCameraMode === 'emotion' ? 'LIVE · YOU' : userCameraMode === 'snapshot' ? 'SNAP · YOU' : 'YOU'}
                </span>
                <div
                  className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center rounded-full border border-white/15 bg-black/55 p-0.5 backdrop-blur-md"
                  data-testid="user-camera-preview-size-picker"
                  aria-label="User camera size"
                >
                  {USER_CAMERA_PREVIEW_SIZES.map(option => (
                    <button
                      key={option.id}
                      type="button"
                      aria-label={`User camera size: ${option.label}`}
                      aria-pressed={userCameraPreviewSize === option.id}
                      data-testid={`user-camera-preview-size-${option.id}`}
                      onClick={() => chooseUserCameraPreviewSize(option.id)}
                      className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[8px] font-medium transition active:scale-90 ${userCameraPreviewSize === option.id ? 'bg-white text-black' : 'text-white/65 hover:bg-white/10'}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {userCameraMode === 'emotion' && detectedUserEmotion && (
            <div
              key={detectedUserEmotion.nonce}
              className="sully-camera-emotion-readout pointer-events-none absolute bottom-5 left-1/2 z-40 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[9px] tracking-[0.08em] text-white/60 backdrop-blur-md"
              style={{ animation: 'sully-camera-emotion-readout 2.6s ease-out both' }}
              data-testid="user-camera-emotion-readout"
            >
              Emotion detected — <span className="text-white/80">{detectedUserEmotion.label}</span>
            </div>
          )}
        </div>
      ) : (
      <div className="sully-call-hero pt-3 pb-1 flex flex-col items-center justify-center">
        <button
          type="button"
          className="relative h-40 w-40 touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label={`Poke ${selectedChar?.name || 'them'}`}
          onPointerDown={handleVoiceAvatarPointerDown}
          onPointerMove={handleVoiceAvatarPointerMove}
          onPointerUp={handleVoiceAvatarPointerUp}
          onPointerCancel={handleVoiceAvatarPointerCancel}
          onClick={event => { if (event.detail === 0) handleVoiceAvatarKeyboardPoke(); }}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <div
            key={`voice-avatar-poke-${voiceAvatarPokeNonce}`}
            className="sully-touch-avatar relative h-full w-full rounded-full"
            style={voiceAvatarPokeNonce
              ? { animation: 'sully-touch-avatar-bounce 420ms cubic-bezier(.2,.9,.3,1) both' }
              : undefined}
          >
            <div className={`absolute -inset-3 rounded-full blur-xl ${waveActive ? 'animate-pulse' : ''}`} style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)`, opacity: waveActive ? 0.8 : 0.4 }} />
            <div className="absolute -inset-1 rounded-full" style={{ boxShadow: `0 0 0 1px ${accentColor}55, inset 0 0 24px ${accentColor}33` }} />
            <div className={`absolute inset-0 rounded-full border ${displayCallState === 'speaking' ? 'animate-ping' : 'opacity-40'}`} style={{ borderColor: `${accentColor}66` }} />
            {selectedChar?.avatar
              ? <TokenImg value={selectedChar.avatar} alt={selectedChar.name} draggable={false} className="relative z-10 h-full w-full rounded-full object-cover" style={{ boxShadow: `0 0 30px ${accentColor}55` }} />
              : <div className="relative z-10 flex h-full w-full items-center justify-center rounded-full text-4xl font-serif" style={{ backgroundColor: `${accentColor}55` }}>{selectedChar?.name?.[0] || 'C'}</div>}
            <AvatarTouchFeedback
              characterName={selectedChar?.name || 'them'}
              accentColor={accentColor}
              effects={avatarTouchEffects}
              lightTheme={lightTheme}
            />
          </div>
        </button>
        {/* analyzing status + waveform */}
        <div className="mt-5 flex flex-col items-center gap-2">
          <div className="text-center leading-tight">
            <div className="text-sm text-white/85">{analyzeLabel.cn}{waveActive ? '…' : ''}</div>
            <div className="text-[9px] tracking-[0.3em] text-white/35 mt-0.5">{analyzeLabel.en}</div>
          </div>
          <div className="flex items-center justify-center gap-[3px] h-7">
            {CALL_WAVE.map((h, i) => (
              <span key={i} className={`w-[3px] rounded-full transition-all duration-300 ${waveActive ? 'animate-pulse' : ''}`}
                style={{ height: `${waveActive ? h : 3}px`, background: `linear-gradient(to top, ${accentColor}33, ${accentColor})`, animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        </div>
      </div>
      )}
      {compactVideoTranscript ? (
        <div
          className="sully-call-video-subtitle mx-3 mb-1.5 flex min-h-[3.7rem] shrink-0 items-center gap-2.5 rounded-[1.2rem] border border-white/14 bg-black/38 px-3 py-2 backdrop-blur-xl"
          style={{ animation: 'sully-call-subtitle-in 240ms ease-out both', boxShadow: `inset 0 1px 0 ${accentColor}35, 0 12px 32px rgba(0,0,0,.22)` }}
          data-testid="video-call-subtitle"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[.06] text-[11px]" style={{ color: accentColor }}>
            {latestCallBubble?.role === 'user' ? 'You' : selectedChar?.name?.[0] || 'C'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5 text-[8px] font-semibold tracking-[0.15em]" style={{ color: `${accentColor}dd` }}>
              {latestCallBubble?.role === 'user' ? 'You just said' : displayCallState === 'thinking' ? 'Thinking about how to respond' : `${selectedChar?.name || 'The other person'} · LIVE`}
              {waveActive && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: accentColor }} />}
            </div>
            <div className="line-clamp-2 text-[13px] leading-relaxed text-white/90">
              {latestCallBubble
                ? latestCallBubble.role === 'assistant'
                  ? renderAssistantLine(extractVoiceTag(latestCallBubble.text).display, accentColor)
                  : latestCallBubble.text
                : callState === 'connecting'
                  ? 'Connecting, please wait...'
                  : `${selectedChar?.name || 'The other person'} is waiting for you to speak.`}
            </div>
          </div>
          <button onClick={() => setVideoTranscriptExpanded(true)} className="shrink-0 rounded-full border border-white/12 px-2.5 py-1.5 text-[9px] text-white/52 active:scale-95">Transcript</button>
        </div>
      ) : (
      <div ref={callScrollableRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar mx-4 mb-2 px-4 py-3 space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md" style={{ boxShadow: `inset 0 1px 0 ${accentColor}33` }}>
        {callMode === 'video' && videoCallLayout === 'stage' && videoTranscriptExpanded && (
          <div className="sticky top-0 z-10 -mx-1 flex justify-end pb-1">
            <button onClick={() => setVideoTranscriptExpanded(false)} className="rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[9px] text-white/48 backdrop-blur">Collapse to Subtitles</button>
          </div>
        )}
        {!bubbles.length && (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-base text-white/85">Call connected</p>
            <p className="text-sm text-white/55 mt-2">
              {callState === 'connecting'
                ? `${selectedChar?.name || 'The other person'} is answering...`
                : selectedChar?.name ? `${selectedChar.name} is waiting for you to speak...` : 'The other person is waiting for you to speak...'}
            </p>
            {callState === 'connecting'
              ? <p className="text-xs text-white/35 mt-4 animate-pulse">Please wait</p>
              : <p className="text-xs text-white/35 mt-4">Type what you want to say below</p>}
          </div>
        )}
        {bubbles.map((bubble, index) => {
          const fromBottom = bubbles.length - 1 - index;
          const isLatest = fromBottom === 0;
          const line = bubble.text.trim();
          const opacity = Math.max(0.35, 1 - fromBottom * 0.16);
          const sizeClass = isLatest ? 'text-[15px]' : fromBottom === 1 ? 'text-sm' : 'text-xs';
          return (
          <div
            key={bubble.id}
            onContextMenu={(e) => {
              e.preventDefault();
              if (bubble.role === 'assistant') void openCallVoiceFavorite(bubble);
              else startEditBubble(bubble);
            }}
            onTouchStart={(e) => {
              callLongPressTriggeredRef.current = false;
              callTouchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
              longPressTimerRef.current = window.setTimeout(() => {
                callLongPressTriggeredRef.current = true;
                if (bubble.role === 'assistant') void openCallVoiceFavorite(bubble);
                else startEditBubble(bubble);
              }, 450);
            }}
            onTouchMove={(e) => {
              if (!longPressTimerRef.current) return;
              const dx = Math.abs(e.touches[0].clientX - callTouchStartPos.current.x);
              const dy = Math.abs(e.touches[0].clientY - callTouchStartPos.current.y);
              if (dx > 10 || dy > 10) {
                window.clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
              }
            }}
            onTouchEnd={() => {
              if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
            }}
            style={{ opacity }}
            className={`px-1 py-1 ${bubble.role === 'user' ? 'text-right' : ''}`}
          >
            <div className={`text-[10px] text-white/45 mb-1 flex items-center gap-1 ${bubble.role === 'user' ? 'justify-end' : ''}`}>
              {bubble.role !== 'user' && <span className="text-[8px]" style={{ color: accentColor }}>◍</span>}
              <span style={bubble.role !== 'user' ? { color: `${accentColor}dd` } : undefined}>{bubble.role === 'user' ? 'You' : selectedChar?.name}</span>
              <span>· {bubble.time}</span>
            </div>
            {bubble.role === 'user' && <CallSnapshotImage imageRef={bubble.cameraSnapshotRef} expired={bubble.cameraSnapshotExpired} compact />}
            <div className={`${sizeClass} whitespace-pre-wrap leading-relaxed ${bubble.role === 'user' ? 'inline-block text-left text-white/90 bg-white/[0.06] border border-white/10 rounded-2xl rounded-tr-sm px-3 py-1.5' : 'text-white/95'}`}>
              {bubble.role === 'assistant' ? (() => {
                const { display, voiceText } = extractVoiceTag(line || bubble.text);
                const cleanVoice = stripTtsMarkupForDisplay(voiceText, apiConfig);
                return <>
                  {bubble.thinkingChain && (
                    <details className="group mb-2 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-2 text-[11px] text-white/55">
                      <summary className="cursor-pointer list-none select-none text-[10px] tracking-[0.16em] text-white/45 before:mr-1 before:content-['＋'] group-open:before:content-['－']">Psyche</summary>
                      <div className="mt-2 whitespace-pre-wrap border-t border-white/8 pt-2 leading-relaxed text-white/60">{bubble.thinkingChain}</div>
                    </details>
                  )}
                  {renderAssistantLine(display, accentColor)}
                  {cleanVoice && <div className="mt-1 text-[11px] text-white/45 italic">{cleanVoice}</div>}
                </>;
              })() : (line || bubble.text)}
            </div>
            {bubble.role === 'assistant' && (
              <div className="mt-2 flex gap-2 flex-wrap">
                <button
                  onClick={() => {
                    if (callLongPressTriggeredRef.current) { callLongPressTriggeredRef.current = false; return; }
                    void handlePlayBubbleAudio(bubble);
                  }}
                  disabled={!!generatingAudioBubbleId}
                  className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15 disabled:opacity-40"
                >
                  {generatingAudioBubbleId === bubble.id ? 'Generating voice…' : bubble.audioUrl ? 'Replay Voice' : 'Play Voice'}
                </button>
                {bubble.audioUrl && <button onClick={() => handleDownloadCallAudio(bubble.audioUrl, bubble.timestamp)} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15">Download</button>}
                {isLatest && <button onClick={() => handleRerollAssistant(bubble)} disabled={!!rerollingBubbleId} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15 disabled:opacity-40">{rerollingBubbleId === bubble.id ? 'Rephrasing…' : 'Reword'}</button>}
              </div>
            )}
          </div>
        )})}
        {errorMessage && <div className="text-xs text-rose-300/80 px-1">{errorMessage}</div>}
      </div>
      )}
      {showInputPanel && (
        <div className={`shrink-0 ${callMode === 'video' ? 'px-3 pb-1.5' : 'px-4 pb-2'}`}>
          <div className={`${callMode === 'video' ? 'rounded-[1.15rem] p-1.5' : 'rounded-2xl p-2'} border border-white/12 bg-black/30 backdrop-blur-md flex gap-2 items-center`} style={{ boxShadow: `inset 0 0 20px ${accentColor}1f` }}>
            {sttSupported && (
              <button
                onClick={toggleStt}
                disabled={sendingBusy}
                title={isListening ? 'Stop voice input' : 'Tap to start speaking'}
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition active:scale-90 disabled:opacity-40"
                style={isListening ? { background: '#f0569f', boxShadow: '0 0 14px #f0569f99' } : { background: 'rgba(255,255,255,0.08)' }}
              >
                <Microphone size={18} weight="fill" className={isListening ? 'text-white animate-pulse' : 'text-white/70'} />
              </button>
            )}
            <input
              ref={draftInputRef}
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              className="flex-1 min-w-0 bg-transparent px-2 text-sm outline-none placeholder:text-white/35"
              placeholder={isListening ? 'Listening...' : sendingBusy ? `${selectedChar?.name || 'The other person'} is thinking...` : pendingCallRetryText ? 'Last reply was interrupted — you can retry directly' : `What do you want to say to ${selectedChar?.name || 'them'}?`}
            />
            <button onClick={handleTurn} disabled={sendingBusy} className="keep-white shrink-0 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 transition active:scale-95" style={{ backgroundColor: accentColor, boxShadow: `0 0 16px ${accentColor}66` }}>{sendingBusy ? '…' : 'Send'}</button>
          </div>
          {!sendingBusy && pendingCallRetryText && !draftInput.trim() && <div className="text-[10px] text-amber-200/70 mt-1 px-1">Your last message hasn't gotten a reply yet — tap to retry and continue</div>}
          {isListening && <div className="text-[10px] text-white/40 mt-1 px-1 animate-pulse">Listening — tap the microphone to stop</div>}
        </div>
      )}
      <div className={`shrink-0 ${callMode === 'video' ? 'px-3 pb-2 pt-0.5' : 'px-7 pb-2 pt-1.5'}`} data-testid={callMode === 'video' ? 'video-call-compact-controls' : undefined}>
        <div
          className={`${callMode === 'video' ? 'grid grid-cols-5 items-center gap-1 rounded-[1.35rem] border border-white/12 bg-black/30 px-1.5 py-1.5 backdrop-blur-xl' : 'flex items-start justify-between'}`}
          style={callMode === 'video' ? { boxShadow: `inset 0 1px 0 ${accentColor}32, 0 14px 32px rgba(0,0,0,.2)` } : undefined}
        >
          {/* mic */}
          <button onClick={() => setShowInputPanel(prev => !prev)} className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={showInputPanel ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              <Microphone size={22} weight="fill" className="text-white/90" />
            </span>
            <span className="text-[10px] text-white/70">Mic</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: showInputPanel ? accentColor : 'rgba(255,255,255,0.3)' }}>{showInputPanel ? 'ON' : 'OFF'}</span>}
          </button>
          {callMode === 'video' && (
            <button onClick={() => setShowUserCameraModePicker(true)} title="Choose how your camera appears" className="flex flex-col items-center gap-0.5 transition active:scale-95">
              <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
                style={userCameraMode !== 'off' ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
                {userCameraMode !== 'off'
                  ? <VideoCamera size={21} weight="fill" className="text-white/90" />
                  : <VideoCameraSlash size={21} weight="fill" className={userCameraLoading ? 'animate-pulse text-white/70' : 'text-white/48'} />}
              </span>
              <span className="text-[10px] text-white/70">{userCameraLoading ? 'Preparing' : userCameraMode === 'fake' ? 'Fake Cam' : userCameraMode === 'emotion' ? 'Emotion' : userCameraMode === 'snapshot' ? 'Snapshot' : 'Your View'}</span>
            </button>
          )}
          {/* translate */}
          <button onClick={() => setShowLangPicker(prev => !prev)} title="Voice Language" className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={voiceLang ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              <Translate size={22} weight="fill" className="text-white/90" />
            </span>
            <span className="text-[10px] text-white/70">Translate</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: voiceLang ? accentColor : 'rgba(255,255,255,0.3)' }}>{voiceLang ? 'ON' : 'OFF'}</span>}
          </button>
          {/* end call */}
          <button onClick={handleHangup} className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition hover:bg-rose-500/20 mx-auto`}
              style={{ background: 'rgba(244,63,94,0.12)', borderColor: 'rgba(251,113,133,0.4)' }}>
              <PhoneDisconnect size={22} weight="fill" className="text-rose-300/90" />
            </span>
            <span className="text-[10px] text-white/70">End Call</span>
          </button>
          {/* speaker */}
          <button
            onClick={() => {
              const next = !isSpeakerOn;
              setIsSpeakerOn(next);
              if (!next && isAudioPlaying) pauseAudio();
              if (next) primeCallAudioFromGesture(true);
            }}
            title={isSpeakerOn ? 'Speaker on' : 'Speaker off'}
            className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}
          >
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={isSpeakerOn ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              {isSpeakerOn
                ? <SpeakerHigh size={22} weight="fill" className="text-white/90" />
                : <SpeakerSlash size={22} weight="fill" className="text-white/50" />}
            </span>
            <span className="text-[10px] text-white/70">Speaker</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: isSpeakerOn ? accentColor : 'rgba(255,255,255,0.3)' }}>{isSpeakerOn ? 'ON' : 'OFF'}</span>}
          </button>
        </div>
      </div>
      {showUserCameraModePicker && callMode === 'video' && (
        <UserCameraModePicker
          mode={userCameraMode}
          busy={userCameraLoading}
          hasFakeImage={!!fakeUserCameraRef}
          accentColor={accentColor}
          lightTheme={lightTheme}
          onSelect={selectUserCameraMode}
          onChooseFakeImage={chooseFakeUserCameraImage}
          onRemoveFakeImage={() => { void removeFakeUserCameraImage(); }}
          onClose={() => { if (!userCameraLoading) setShowUserCameraModePicker(false); }}
        />
      )}
      {showBgPicker && (
        <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setShowBgPicker(false)}>
          <div className={`w-full border-t border-white/10 rounded-t-3xl p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`} onClick={e => e.stopPropagation()}>
            <div className="text-sm text-white/80 font-medium">Video Background</div>
            <p className="text-xs text-white/40">A local image is saved on your own device (IndexedDB, included in backup exports); a direct image-host URL is loaded online every time instead.</p>
            <button onClick={chooseStageBackgroundFile} className="w-full py-2.5 rounded-2xl border border-white/15 bg-white/[0.06] text-sm text-white/85 transition active:scale-[0.98]">
              Choose a Local Image
            </button>
            <div className="flex gap-2">
              <input
                value={bgUrlInput}
                onChange={e => setBgUrlInput(e.target.value)}
                placeholder="https:// direct image URL"
                className="flex-1 min-w-0 bg-black/30 rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-white/30 border border-white/10"
              />
              <button onClick={() => void applyBgUrlInput()} className="keep-white shrink-0 px-4 rounded-xl text-sm font-medium text-white transition active:scale-95" style={{ backgroundColor: accentColor }}>Use</button>
            </div>
            {selectedChar?.videoCallBackground && (
              <button onClick={() => { void applyStageBackground(undefined); setShowBgPicker(false); addToast('Restored the default background', 'success'); }} className="w-full py-2 text-xs text-white/45 transition active:opacity-60">
                Restore Default Background
              </button>
            )}
          </div>
        </div>
      )}
      {showLangPicker && (
        <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setShowLangPicker(false)}>
          <div className={`w-full border-t border-white/10 rounded-t-3xl p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`} onClick={e => e.stopPropagation()}>
            <div className="text-sm text-white/80 font-medium">Voice Language</div>
            <p className="text-xs text-white/40">Once selected, the character will reply in Chinese and the voice will be read aloud in the selected language</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {VOICE_LANGUAGE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => { setVoiceLang(opt.value); if (selectedChar) updateCharacter(selectedChar.id, { callVoiceLang: opt.value }); setShowLangPicker(false); trackEvent('Set Call Voice Language', { Language: voiceLanguageAnalyticsValue(opt.value) }); }}
                  className={`text-xs px-3 py-2 rounded-full font-medium transition-colors text-white ${voiceLang === opt.value ? 'keep-white' : ''}`}
                  style={voiceLang === opt.value ? { backgroundColor: accentColor } : lightTheme ? { background: 'rgba(38,34,57,0.08)' } : { background: 'rgba(255,255,255,0.1)' }}>
                  {opt.label}
                </button>
              ))}
            </div>
            {voiceLang === 'yue' && <p className="text-[10px] text-amber-300/70">{CANTONESE_VOICE_SUPPORT_NOTE}</p>}
          </div>
        </div>
      )}
      {showHangupConfirm && (
        <div className="absolute inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
          <div className={`w-full max-w-sm rounded-3xl border border-white/15 bg-gradient-to-b p-5 shadow-2xl ${lightTheme ? 'from-white to-[#f0edf9]' : 'from-[#1a1130] to-[#0a0613]'}`}>
            <div className="text-lg font-semibold text-white">Ready to hang up?</div>
            <p className="mt-2 text-sm text-white/65 leading-relaxed">You've talked with {selectedChar?.name || 'them'} for {formatDuration(elapsedSeconds)} — this call will be saved properly.</p>
            <div className="mt-5 space-y-2">
              <button onClick={() => {
                setShowHangupConfirm(false);
                if (selectedChar) {
                  suspendCall({
                    charId: selectedChar.id,
                    charName: selectedChar.name,
                    charAvatar: selectedChar.avatar,
                    startedAt: callStartedAt || Date.now(),
                    bubbles,
                    sessionId: currentSessionId,
                    elapsedSeconds,
                    voiceLang,
                    pendingAvatarTouches: pendingAvatarTouchesRef.current,
                  });
                  addToast('Call suspended — tap the green bar at the top to come back anytime', 'success');
                  trackEvent('Suspend Call to Background');
                }
              }} className="keep-white w-full py-2.5 rounded-2xl bg-emerald-500/80 text-white font-semibold transition active:scale-[0.97] flex items-center justify-center gap-2">
                <span>Do Something Else</span><span className="text-xs opacity-70">(Suspend Call)</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setShowHangupConfirm(false)} className="py-2.5 rounded-2xl border border-white/20 text-white/80 transition active:scale-[0.97]">Keep Talking</button>
                <button onClick={finishCall} className="py-2.5 rounded-2xl bg-rose-500/20 border border-rose-300/40 text-rose-200 font-semibold transition active:scale-[0.97]">Hang Up</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editingBubble && (
        <div className="absolute inset-0 bg-black/60 flex items-end z-50">
          <div className={`w-full border-t border-white/10 p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`}>
            <div className="text-sm text-white/70">Edit what you just said</div>
            <textarea value={editingText} onChange={(e) => setEditingText(e.target.value)} className="w-full h-24 bg-black/30 rounded-xl p-3 text-sm outline-none resize-none placeholder:text-white/30" placeholder="Rephrase it..." autoFocus />
            <div className="flex gap-2">
              <button onClick={() => setEditingBubble(null)} className="flex-1 py-2.5 rounded-xl border border-white/15 text-white/70 transition active:scale-[0.97]">Never Mind</button>
              <button onClick={saveEditedBubble} className="keep-white flex-1 py-2.5 rounded-xl font-medium text-white transition active:scale-[0.97]" style={{ backgroundColor: accentColor }}>Done</button>
            </div>
          </div>
        </div>
      )}
      <VoiceFavoriteActionSheet
        open={!!voiceFavoriteTarget}
        favorited={voiceFavoriteSaved}
        busy={voiceFavoriteBusy}
        title="Call Voice"
        preview={voiceFavoriteTarget ? (stripCallTextFormatting(extractVoiceTag(voiceFavoriteTarget.bubble.text).display) || stripTtsMarkupForDisplay(extractVoiceTag(voiceFavoriteTarget.bubble.text).voiceText, apiConfig)) : ''}
        onToggle={() => void toggleCallVoiceFavorite()}
        onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
      />
      {showLive2DSettings && selectedChar?.videoAvatar?.format === 'live2d' && (
        <div className="sully-stage-dark" style={{ display: 'contents' }}>
          <Live2DActionSettings
            config={selectedChar.videoAvatar}
            characterName={selectedChar.name}
            accentColor={accentColor}
            setupMode={live2DWardrobeOnboarding ? 'import' : 'advanced'}
            onClose={() => { setShowLive2DSettings(false); setLive2DWardrobeOnboarding(false); }}
            onSave={(config: Live2DAvatarConfig) => {
              updateCharacter(selectedChar.id, { videoAvatar: config });
              setShowLive2DSettings(false);
              setLive2DWardrobeOnboarding(false);
              addToast(`Action library saved: wardrobe ${config.actions.filter(action => action.wardrobe).length} sets · AI has ${getLive2DAIActions(config).length} actions available`, 'success');
            }}
          />
        </div>
      )}
      </div>
    </div>
  );
};
export default CallApp;
