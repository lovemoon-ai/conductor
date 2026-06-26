'use client';

import { useEffect, useRef } from 'react';
import type { Message, SendMessageInput } from '@/shared/types';
import {
  glasses,
  isGlassesShell,
  registerGlassesEvents,
  isGlassesWorthyReply,
} from './native-bridge';

interface GlassesSessionParams {
  taskId: string;
  messages: Message[];
  sendMessage: (taskId: string, input: SendMessageInput) => Promise<Message>;
}

const LISTEN_PROMPT = '🎤 请说话…（说完停顿一下，自动发送）';

// Module-level so it survives ChatView remounts (frequent in dev with StrictMode/HMR). Keyed by
// taskId so each task's last-shown reply is tracked independently; this prevents a remount from
// re-pushing/clobbering the lens (e.g. overwriting "思考中" with a stale reply).
const lastPushedReplyByTask = new Map<string, string>();

/**
 * Drives the on-glasses display + hands-free voice loop for the open chat, inside the Rokid
 * Android shell. No-op in a normal browser.
 *
 * Auto-casting: whenever the glasses are connected, the open task's conversation is mirrored to
 * the lens and the voice loop runs — speak, pause, and a silence-VAD auto-sends; each AI reply is
 * shown and read aloud (TTS), then listening resumes. No manual "cast" action is needed; on
 * disconnect the loop stops.
 */
export function useGlassesSession({ taskId, messages, sendMessage }: GlassesSessionParams): void {
  const messagesRef = useRef(messages);
  const sendRef = useRef(sendMessage);
  const taskIdRef = useRef(taskId);
  const connectedRef = useRef(false);

  messagesRef.current = messages;
  sendRef.current = sendMessage;
  taskIdRef.current = taskId;

  useEffect(() => {
    if (!isGlassesShell()) return;

    let stopped = false;
    let connected = glasses.isConnected();
    let listening = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    connectedRef.current = connected;

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const startListening = () => {
      if (stopped || !connected || listening) return;
      clearRetry();
      listening = true;
      glasses.showAiReply(LISTEN_PROMPT);
      glasses.startVoice();
    };

    const scheduleListen = (delayMs: number) => {
      if (stopped || !connected) return;
      clearRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        startListening();
      }, delayMs);
    };

    const sendUserText = (text: string) => {
      listening = false;
      const content = text.trim();
      if (!content) {
        scheduleListen(500);
        return;
      }
      glasses.showUserText(content);
      glasses.notifyThinking();
      void sendRef.current(taskIdRef.current, { content, role: 'user' }).catch(() => {
        glasses.notifyError();
        scheduleListen(1500);
      });
      // Do not auto-listen here: wait for the reply to be spoken (onSpeakDone).
    };

    const pushLatestReply = () => {
      const replies = messagesRef.current.filter((m) => isGlassesWorthyReply(m.role, m.content));
      const latest = replies[replies.length - 1];
      if (latest) {
        lastPushedReplyByTask.set(taskIdRef.current, latest.id);
        glasses.showAiReply(latest.content);
      }
    };

    const activate = () => {
      glasses.openAiChat();
      pushLatestReply();
      scheduleListen(1200); // let the CustomView open before prompting
    };

    const deactivate = () => {
      clearRetry();
      listening = false;
      glasses.stopVoice();
      glasses.stopSpeak();
    };

    // A long-press of the glasses AI-key (when it fires) sends the current utterance, or starts.
    const voiceTap = () => {
      if (stopped || !connected) return;
      if (listening) {
        listening = false;
        glasses.stopVoice();
      } else {
        startListening();
      }
    };

    const unregister = registerGlassesEvents({
      onGlassStatus: (isConnected) => {
        connected = isConnected;
        connectedRef.current = isConnected;
        if (isConnected) activate();
        else deactivate();
      },
      onAiKeyDown: () => voiceTap(),
      onAiKeyUp: () => {},
      // onAiExit fires spuriously in CustomView mode — ignore it (VAD handles endpointing).
      onAiExit: () => {},
      onSttPartial: (text) => {
        if (connected && text.trim()) glasses.showUserText(`🎤 ${text}`);
      },
      onSttFinal: (text) => sendUserText(text),
      onSttError: () => {
        // Empty/failed transcription (incl. VAD "no speech" after 8s). Keep listening — the VAD's
        // silence/no-speech windows throttle this naturally, so there is no tight-loop risk.
        listening = false;
        if (connected) scheduleListen(1000);
      },
      onSpeakDone: () => {
        listening = false;
        scheduleListen(600);
      },
    });

    if (connected) activate();

    return () => {
      stopped = true;
      clearRetry();
      unregister();
      glasses.stopVoice();
      glasses.stopSpeak();
      glasses.closeScene();
    };
  }, [taskId]);

  // Mirror each new AI reply to the lens (and speak it) while the glasses are connected.
  useEffect(() => {
    if (!isGlassesShell() || !connectedRef.current) return;

    const replies = messages.filter((m) => isGlassesWorthyReply(m.role, m.content));
    const latest = replies[replies.length - 1];
    if (!latest || lastPushedReplyByTask.get(taskId) === latest.id) return;

    lastPushedReplyByTask.set(taskId, latest.id);
    glasses.showAiReply(latest.content);
    glasses.speak(latest.content);
  }, [messages, taskId]);
}
