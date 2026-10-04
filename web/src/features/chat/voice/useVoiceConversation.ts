'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@/shared/types';
import { resolveAppWebSocketUrl } from '@/features/realtime';
import { MIC_SAMPLE_RATE, startMicCapture, type MicCapture } from './mic-capture';
import { PcmStreamPlayer } from './pcm-player';
import { isSpeakableReply, toSpeakableText } from './speakable-text';
import { TtsPrefetch } from './tts-prefetch';

/**
 * Tap-to-talk voice conversation for a task chat:
 * tap → record (Doubao streaming ASR, live text) → tap → send →
 * read each AI reply aloud (Doubao TTS) → idle until the next tap.
 * The end of a message is always the user's tap; pauses never send.
 * (Doubao still flags pauses as `endpoint`; hands-free clients such as
 * glasses can use that later.)
 */
export type VoicePhase = 'off' | 'starting' | 'recording' | 'recognizing' | 'waiting' | 'speaking' | 'idle';

const TTS_SAMPLE_RATE = 24_000;
const MAX_RECORDING_CHUNKS = 3_000; // 100 ms chunks: 5 minutes
const RECOGNIZE_TIMEOUT_MS = 15_000;
const TURN_START_TIMEOUT_MS = 30_000;
/** Replies synthesized ahead of playback (beyond the one playing). */
const PREFETCH_AHEAD = 2;

type TtsPrefetchItem = { text: string; stream: TtsPrefetch | null };

type Recording = {
  ws: WebSocket;
  pending: ArrayBuffer[];
  open: boolean;
  chunks: number;
  finishing: boolean;
  done: boolean;
  mic: MicCapture | null;
};

const speechSocketUrl = (userToken: string) => {
  const url = new URL(resolveAppWebSocketUrl(userToken));
  url.pathname = url.pathname.replace(/\/ws\/app$/, '/ws/speech');
  return url.toString();
};

export function useVoiceConversation(args: {
  taskId: string;
  messages: Message[];
  replyInProgress: boolean;
  userToken: string | null | undefined;
  /** Resolve `false` when the message was not sent (task not ready, etc.): voice mode then turns off. */
  onSend: (text: string) => Promise<boolean | void> | boolean | void;
  /** Recognition failed part-way: put what was heard into the composer so it is not lost. */
  onKeepText?: (text: string) => void;
}) {
  const { taskId, messages, replyInProgress, userToken } = args;
  const [phase, setPhaseState] = useState<VoicePhase>('off');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [recordingSince, setRecordingSince] = useState<number | null>(null);

  const phaseRef = useRef<VoicePhase>('off');
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const recRef = useRef<Recording | null>(null);
  const seenRef = useRef(new Set<string>());
  // Replies waiting to be spoken; the first PREFETCH_AHEAD are already synthesizing.
  const speakQueueRef = useRef<TtsPrefetchItem[]>([]);
  const drainingRef = useRef(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const turnStartedRef = useRef(false);
  const mutedRef = useRef(false);
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef(messages);
  const replyInProgressRef = useRef(replyInProgress);
  const onSendRef = useRef(args.onSend);
  const onKeepTextRef = useRef(args.onKeepText);
  const stopRef = useRef<() => void>(() => {});
  // Mic level goes straight to subscribers (the level meter), not React state,
  // so 10 updates a second do not re-render the whole chat view.
  const levelListenersRef = useRef(new Set<(level: number) => void>());
  const emitLevel = useCallback((level: number) => {
    for (const listener of levelListenersRef.current) listener(level);
  }, []);
  messagesRef.current = messages;
  replyInProgressRef.current = replyInProgress;
  onSendRef.current = args.onSend;
  onKeepTextRef.current = args.onKeepText;

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearTurnTimer = () => {
    if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
    turnTimerRef.current = null;
  };

  const closeRecording = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    rec.done = true;
    rec.mic?.stop();
    rec.mic = null;
    if (rec.ws.readyState <= WebSocket.OPEN) rec.ws.close();
    setRecordingSince(null);
    emitLevel(0);
  }, [emitLevel]);

  /** Recording failed or was discarded: back to "tap to talk". */
  const toIdle = useCallback((message = '') => {
    closeRecording();
    if (message) setError(message);
    setPhase('idle');
  }, [closeRecording, setPhase]);

  /** Once the turn is over and everything has been read aloud, wait for the next tap. */
  const maybeFinishTurn = useCallback(() => {
    const current = phaseRef.current;
    if (current !== 'waiting' && current !== 'speaking') return;
    const player = playerRef.current;
    const quiet = speakQueueRef.current.length === 0 && !drainingRef.current && (!player || player.idle);
    if (!quiet) return;
    if (turnStartedRef.current && !replyInProgressRef.current) {
      clearTurnTimer();
      setPhase('idle');
    } else if (current === 'speaking') {
      setPhase('waiting');
    }
  }, [setPhase]);

  const prefetchQueue = useCallback(() => {
    const queue = speakQueueRef.current;
    for (let i = 0; i < Math.min(queue.length, PREFETCH_AHEAD); i += 1) {
      queue[i].stream ??= new TtsPrefetch(queue[i].text);
    }
  }, []);

  const clearSpeakQueue = useCallback(() => {
    for (const item of speakQueueRef.current) item.stream?.abort();
    speakQueueRef.current = [];
    ttsAbortRef.current?.abort();
  }, []);

  const speak = useCallback(async (item: TtsPrefetchItem) => {
    const stream = item.stream ?? new TtsPrefetch(item.text);
    ttsAbortRef.current = stream.controller;
    for await (const chunk of stream.read()) {
      if (phaseRef.current === 'off' || stream.controller.signal.aborted) break;
      playerRef.current?.push(chunk);
    }
  }, []);

  const drainSpeakQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      // Never talk over the user: replies arriving while recording wait until it is sent.
      while (speakQueueRef.current.length > 0 && (phaseRef.current === 'waiting' || phaseRef.current === 'speaking')) {
        const item = speakQueueRef.current.shift()!;
        item.stream ??= new TtsPrefetch(item.text);
        prefetchQueue(); // synthesize the next reply while this one plays
        setPhase('speaking');
        try {
          await speak(item);
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') setError((err as Error).message);
        }
      }
    } finally {
      drainingRef.current = false;
      maybeFinishTurn();
    }
  }, [maybeFinishTurn, prefetchQueue, setPhase, speak]);

  const handleTranscript = useCallback(async (rec: Recording, text: string) => {
    if (recRef.current !== rec) return;
    closeRecording();
    if (phaseRef.current === 'off') return;
    if (!text.trim()) {
      toIdle("Didn't catch anything — tap the mic and try again");
      return;
    }
    setPartial(text);
    setPhase('waiting');
    turnStartedRef.current = false;
    mutedRef.current = false;
    clearTurnTimer();
    turnTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'waiting' && !turnStartedRef.current) setPhase('idle');
    }, TURN_START_TIMEOUT_MS);
    try {
      const sent = await onSendRef.current(text.trim());
      if (sent === false) {
        // Blocked before reaching the server (stopped task, restart in
        // progress…). ChatView already shows why; waiting for a reply that
        // will never come would leave voice mode stuck.
        stopRef.current();
        setError('Not sent — the text is back in the input box');
        return;
      }
    } catch (err) {
      clearTurnTimer();
      toIdle(err instanceof Error ? err.message : 'Failed to send the message');
      return;
    }
    void drainSpeakQueue();
  }, [closeRecording, drainSpeakQueue, setPhase, toIdle]);

  /** Second tap: stop the mic and ask for the final transcript. */
  const finishRecording = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.finishing) return;
    rec.finishing = true;
    rec.mic?.stop();
    rec.mic = null;
    emitLevel(0);
    setPhase('recognizing');
    if (rec.open) rec.ws.send(JSON.stringify({ type: 'finish' }));
    setTimeout(() => {
      if (recRef.current === rec) toIdle('Speech recognition timed out');
    }, RECOGNIZE_TIMEOUT_MS);
  }, [emitLevel, setPhase, toIdle]);

  const startRecording = useCallback(async () => {
    if (!userToken) {
      setError('Sign in again to use voice mode');
      return;
    }
    closeRecording();
    setError('');
    setPartial('');
    setPhase('starting');
    const ws = new WebSocket(speechSocketUrl(userToken));
    ws.binaryType = 'arraybuffer';
    const rec: Recording = { ws, pending: [], open: false, chunks: 0, finishing: false, done: false, mic: null };
    recRef.current = rec;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', payload: { sample_rate: MIC_SAMPLE_RATE, tts_prewarm: true } }));
      rec.open = true;
      for (const chunk of rec.pending.splice(0)) ws.send(chunk);
      if (rec.finishing) ws.send(JSON.stringify({ type: 'finish' }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string' || recRef.current !== rec) return;
      let envelope: { type?: string; payload?: { text?: string; message?: string; detail?: string } };
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      const payload = envelope.payload ?? {};
      // `partial.endpoint` (a pause) is deliberately ignored: only the tap ends the message.
      if (envelope.type === 'partial' && typeof payload.text === 'string') setPartial(payload.text);
      else if (envelope.type === 'result') void handleTranscript(rec, payload.text ?? '');
      else if (envelope.type === 'error') {
        const heard = payload.text?.trim();
        if (heard && onKeepTextRef.current) {
          // Never send a message that was cut off; let the user finish or fix it.
          onKeepTextRef.current(heard);
          toIdle('Speech recognition failed — what was heard is in the input box');
        } else {
          toIdle(payload.detail || payload.message || 'Speech recognition failed');
        }
      }
    };
    ws.onclose = () => {
      if (recRef.current === rec && !rec.done) toIdle('Speech connection closed');
    };

    let mic: MicCapture;
    try {
      // Opened per message and closed on send, so the mic is off while replies play.
      mic = await startMicCapture((pcm, rms) => {
        if (recRef.current !== rec || rec.finishing) return;
        emitLevel(Math.min(1, Math.sqrt(rms / 0.3)));
        if (rec.open) rec.ws.send(pcm);
        else rec.pending.push(pcm);
        rec.chunks += 1;
        if (rec.chunks >= MAX_RECORDING_CHUNKS) finishRecording();
      });
    } catch (err) {
      if (recRef.current === rec) toIdle(err instanceof Error ? err.message : 'Microphone unavailable');
      return;
    }
    if (recRef.current !== rec || rec.finishing) {
      mic.stop();
      return;
    }
    rec.mic = mic;
    setRecordingSince(Date.now());
    setPhase('recording');
  }, [closeRecording, emitLevel, finishRecording, handleTranscript, setPhase, toIdle, userToken]);

  const stop = useCallback(() => {
    clearTurnTimer();
    closeRecording();
    clearSpeakQueue();
    playerRef.current?.close();
    playerRef.current = null;
    setPartial('');
    setPhase('off');
  }, [clearSpeakQueue, closeRecording, setPhase]);
  stopRef.current = stop;

  /** ✕ while recording: discard what was said, send nothing. */
  const cancel = useCallback(() => {
    const rec = recRef.current;
    if (!rec || phaseRef.current === 'recognizing') return;
    if (rec.open) rec.ws.send(JSON.stringify({ type: 'cancel' }));
    setPartial('');
    toIdle();
  }, [toIdle]);

  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    levelListenersRef.current.add(listener);
    return () => {
      levelListenersRef.current.delete(listener);
    };
  }, []);

  /**
   * Mic button: off → enter voice mode and record; recording → send;
   * speaking → interrupt and record; idle/waiting → record.
   */
  const toggle = useCallback(() => {
    const current = phaseRef.current;
    if (current === 'starting' || current === 'recognizing') return;
    if (current === 'recording') {
      finishRecording();
      return;
    }
    if (current === 'off') {
      if (!userToken) {
        setError('Sign in again to use voice mode');
        return;
      }
      // Created inside the click so browsers allow playback later.
      const player = new PcmStreamPlayer(TTS_SAMPLE_RATE);
      player.unlock();
      player.onIdle = () => maybeFinishTurn();
      playerRef.current = player;
      seenRef.current = new Set(messagesRef.current.map((message) => message.id));
      clearSpeakQueue();
      turnStartedRef.current = false;
      mutedRef.current = false;
    } else if (current === 'speaking') {
      mutedRef.current = true; // skip the rest of this turn's replies
      clearSpeakQueue();
      playerRef.current?.stop();
    }
    clearTurnTimer();
    void startRecording();
  }, [clearSpeakQueue, finishRecording, maybeFinishTurn, startRecording, userToken]);

  // Queue new AI replies for reading aloud.
  useEffect(() => {
    if (phaseRef.current === 'off') return;
    let queued = false;
    for (const message of messages) {
      if (seenRef.current.has(message.id)) continue;
      seenRef.current.add(message.id);
      // A new user message (typed or spoken) starts a new turn: un-mute after a ■ interrupt.
      if (message.role === 'user') mutedRef.current = false;
      if (mutedRef.current || !isSpeakableReply(message)) continue;
      const text = toSpeakableText(message.content);
      if (!text) continue;
      speakQueueRef.current.push({ text, stream: null });
      turnStartedRef.current = true;
      queued = true;
    }
    if (!queued) return;
    prefetchQueue();
    if (phaseRef.current === 'idle') setPhase('waiting');
    void drainSpeakQueue();
  }, [drainSpeakQueue, messages, prefetchQueue, setPhase]);

  useEffect(() => {
    if (replyInProgress) turnStartedRef.current = true;
    else maybeFinishTurn();
  }, [maybeFinishTurn, replyInProgress]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stop(), [taskId]);

  return { phase, partial, error, toggle, stop, cancel, subscribeLevel, recordingSince };
}
