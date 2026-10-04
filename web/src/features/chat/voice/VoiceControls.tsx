'use client';

import { useEffect, useState } from 'react';
import type { VoicePhase } from './useVoiceConversation';

const BUTTON_TITLE: Record<VoicePhase, string> = {
  off: 'Voice conversation',
  starting: 'Starting microphone…',
  recording: 'Send',
  recognizing: 'Recognizing…',
  waiting: 'Talk',
  speaking: 'Stop speaking',
  idle: 'Talk',
};

function MicIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/**
 * One button drives the whole conversation; its icon says what a tap does:
 * mic = start talking, ↑ = send what you said, ■ = stop the AI speaking.
 */
export function VoiceModeButton({ phase, onClick, disabled }: { phase: VoicePhase; onClick: () => void; disabled?: boolean }) {
  const active = phase !== 'off';
  const busy = phase === 'starting' || phase === 'recognizing';
  const filled = phase === 'recording' || phase === 'speaking' || busy;
  const title = BUTTON_TITLE[phase];
  let icon = <MicIcon />;
  if (busy) icon = <Spinner />;
  else if (phase === 'recording') {
    icon = (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19V5M6 11l6-6 6 6" />
      </svg>
    );
  } else if (phase === 'speaking') {
    icon = (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
        <rect x="5" y="5" width="14" height="14" rx="2" />
      </svg>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={(disabled && !active) || busy}
      data-testid="message-input-voice-button"
      data-voice-phase={phase}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-60 ${filled
        ? 'bg-accent text-white hover:brightness-105'
        : active
          ? 'text-accent hover:bg-border/50'
          : 'text-muted hover:bg-border/50 hover:text-ink'
      }`}
    >
      {icon}
    </button>
  );
}

const BAR_SHAPE = [0.55, 0.85, 1, 0.75, 0.5];

/** Bars that move with the microphone level, so you can see you are being heard. */
function LevelMeter({ subscribe }: { subscribe: (listener: (level: number) => void) => () => void }) {
  const [level, setLevel] = useState(0);
  useEffect(() => subscribe(setLevel), [subscribe]);
  return (
    <div className="flex h-5 shrink-0 items-center gap-[3px]" data-testid="voice-level-meter" data-level={level.toFixed(2)} aria-hidden="true">
      {BAR_SHAPE.map((shape, index) => (
        <span
          key={index}
          className="w-[3px] rounded-full bg-red-500 transition-[height] duration-100"
          style={{ height: `${Math.max(3, Math.round(20 * shape * level))}px` }}
        />
      ))}
    </div>
  );
}

function RecordingTimer({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [since]);
  const seconds = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="tabular-nums" data-testid="voice-recording-timer">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

/**
 * Replaces the text area while recording: red dot + timer, live level bars,
 * the live transcript in the input box itself, and ✕ to discard.
 */
export function VoiceRecordingBar({ phase, partial, since, subscribeLevel, onCancel }: {
  phase: VoicePhase;
  partial: string;
  since: number | null;
  subscribeLevel: (listener: (level: number) => void) => () => void;
  onCancel: () => void;
}) {
  const recording = phase === 'recording';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid="voice-recording-bar" data-voice-phase={phase}>
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-red-600">
        <span className={`size-2 rounded-full bg-red-500 ${recording ? 'animate-pulse' : 'opacity-40'}`} />
        <RecordingTimer since={since} />
      </div>
      <LevelMeter subscribe={subscribeLevel} />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink" data-testid="voice-transcript">
        {partial || (
          <span className="text-muted">{phase === 'starting' ? 'Starting microphone…' : phase === 'recognizing' ? 'Recognizing…' : 'Listening… start talking'}</span>
        )}
      </p>
      {phase !== 'recognizing' ? (
        <button
          type="button"
          onClick={onCancel}
          data-testid="voice-cancel-button"
          title="Discard recording"
          aria-label="Discard recording"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-border/50 hover:text-ink"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<Exclude<VoicePhase, 'off'>, string> = {
  starting: 'Starting microphone…',
  recording: 'Recording · tap ↑ to send',
  recognizing: 'Recognizing…',
  waiting: 'Waiting for the reply…',
  speaking: 'AI is speaking · tap ■ to stop',
  idle: 'Tap the mic to keep talking',
};

function SpeakingWave() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden="true" data-testid="voice-speaking-wave">
      {[[0, 60], [200, 100], [400, 45], [100, 80]].map(([delay, height]) => (
        <span
          key={delay}
          className="w-[2px] animate-pulse rounded-full bg-accent"
          style={{ height: `${height}%`, animationDelay: `${delay}ms`, animationDuration: '700ms' }}
        />
      ))}
    </span>
  );
}

/** One quiet line above the composer: what voice mode is doing, errors, and the way out. */
export function VoiceStatus({ phase, error, onExit }: {
  phase: VoicePhase;
  error: string;
  onExit?: () => void;
}) {
  if (phase === 'off' && !error) return null;
  return (
    <div data-testid="voice-status" className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted">
      {phase === 'speaking' ? <SpeakingWave /> : null}
      {phase !== 'off' ? <span className="shrink-0 font-medium text-ink">{STATUS_LABEL[phase]}</span> : null}
      {error ? <span className="truncate text-red-600">{error}</span> : null}
      {phase !== 'off' && onExit ? (
        <button
          type="button"
          onClick={onExit}
          data-testid="voice-exit-button"
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-border/50 hover:text-ink"
        >
          Exit voice
        </button>
      ) : null}
    </div>
  );
}
