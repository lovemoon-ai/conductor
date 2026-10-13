'use client';

import { create } from 'zustand';
import { PcmStreamPlayer } from './pcm-player';
import { toSpeakableText } from './speakable-text';
import { TtsPrefetch } from './tts-prefetch';

const TTS_SAMPLE_RATE = 24_000;
/** Below the synthesize route's 2 000-character limit. */
export const MAX_SEGMENT_CHARS = 1_500;
/** A whole message is read up to here (cut at a sentence), so a huge report doesn't run into the rate limit. */
export const MAX_MESSAGE_SPEECH_CHARS = 10_000;

export type MessageSpeakerState = {
  /** Message being read aloud (or being prepared), null when quiet. */
  messageId: string | null;
  status: 'idle' | 'loading' | 'playing';
  error: string;
};

export const useMessageSpeakerStore = create<MessageSpeakerState>(() => ({
  messageId: null,
  status: 'idle',
  error: '',
}));

const SENTENCE_END = /[。！？!?；;\n]|\.(?=\s)/g;

/** Split speakable text into request-sized pieces, cutting at sentence ends where possible. */
export const splitForSpeech = (text: string, maxChars = MAX_SEGMENT_CHARS): string[] => {
  const segments: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars);
    let cut = -1;
    for (const match of head.matchAll(SENTENCE_END)) cut = (match.index ?? 0) + match[0].length;
    if (cut < maxChars / 2) {
      const space = head.lastIndexOf(' ');
      cut = space > maxChars / 2 ? space + 1 : maxChars;
    }
    segments.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) segments.push(rest);
  return segments.filter(Boolean);
};

type Session = {
  messageId: string;
  player: PcmStreamPlayer;
  streams: TtsPrefetch[];
  cancelled: boolean;
};

let current: Session | null = null;
const startListeners = new Set<() => void>();

/**
 * Called when a message starts being read aloud, so voice mode can stop its
 * own playback instead of talking over it.
 */
export const onMessageSpeechStart = (listener: () => void) => {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
};
let errorTimer: ReturnType<typeof setTimeout> | null = null;

/** Errors show briefly in the voice status line, then clear. */
const showError = (error: string) => {
  if (errorTimer) clearTimeout(errorTimer);
  useMessageSpeakerStore.setState({ error });
  errorTimer = setTimeout(() => useMessageSpeakerStore.setState({ error: '' }), 5_000);
};

/** Stop whatever message is being read aloud. */
export const stopMessageSpeech = () => {
  const session = current;
  current = null;
  if (session) {
    session.cancelled = true;
    for (const stream of session.streams) stream?.abort();
    session.player.onIdle = null;
    session.player.close();
  }
  useMessageSpeakerStore.setState({ messageId: null, status: 'idle' });
};

/**
 * Read one chat message aloud, independent of voice-conversation mode.
 * Call from a click handler (browsers only allow audio started by a gesture).
 * Starting a new message stops the previous one.
 */
export const speakMessage = async (messageId: string, markdown: string): Promise<void> => {
  stopMessageSpeech();
  const segments = splitForSpeech(toSpeakableText(markdown, MAX_MESSAGE_SPEECH_CHARS));
  if (segments.length === 0) {
    showError('Nothing to read aloud in this message');
    return;
  }
  for (const listener of startListeners) listener();
  const player = new PcmStreamPlayer(TTS_SAMPLE_RATE);
  player.unlock();
  const session: Session = { messageId, player, streams: [], cancelled: false };
  current = session;
  useMessageSpeakerStore.setState({ messageId, status: 'loading', error: '' });

  const streamAt = (index: number) => {
    session.streams[index] ??= new TtsPrefetch(segments[index]);
    return session.streams[index];
  };

  try {
    for (let index = 0; index < segments.length; index += 1) {
      const stream = streamAt(index);
      if (index + 1 < segments.length) streamAt(index + 1); // synthesize ahead
      for await (const chunk of stream.read()) {
        if (session.cancelled) return;
        player.push(chunk);
        if (useMessageSpeakerStore.getState().status !== 'playing') {
          useMessageSpeakerStore.setState({ status: 'playing' });
        }
      }
      if (session.cancelled) return;
    }
  } catch (error) {
    if (session.cancelled || (error as Error)?.name === 'AbortError') return;
    stopMessageSpeech();
    showError(error instanceof Error ? error.message : 'Speech synthesis failed');
    return;
  }

  // Everything is scheduled; finish once the last chunk has played.
  const finish = () => {
    if (current === session) stopMessageSpeech();
  };
  if (player.idle) finish();
  else player.onIdle = finish;
};

/** Play `messageId`, or stop it when it is already the one being read. */
export const toggleMessageSpeech = (messageId: string, markdown: string) => {
  if (useMessageSpeakerStore.getState().messageId === messageId) {
    stopMessageSpeech();
    return;
  }
  void speakMessage(messageId, markdown);
};
