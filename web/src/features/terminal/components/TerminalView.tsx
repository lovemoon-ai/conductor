'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Task } from '@/shared/types';
import type { TerminalLatencySample, TerminalOutputEvent, TerminalTransportState } from '../store';
import {
  getTerminalOutputSnapshot,
  subscribeTerminalOutput,
  subscribeTerminalTransportSignal,
  useTerminalStore,
} from '../store';
import { useTasksStore } from '@/features/tasks';
import { useWebSocketStore } from '@/features/realtime';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { InlineNotice } from '@/components/common/InlineNotice';
import { loadXtermModules } from './xterm-loader';

interface TerminalViewProps {
  task: Task;
}

type XtermTerminal = {
  cols: number;
  rows: number;
  open: (element: HTMLElement) => void;
  write: (data: string) => void;
  clear: () => void;
  focus: () => void;
  dispose: () => void;
  loadAddon: (addon: any) => void;
  onData: (listener: (data: string) => void) => { dispose: () => void };
};

type XtermFitAddon = {
  fit: () => void;
};

const TERMINAL_DETACH_DELAY_MS = 200;
const pendingTerminalDetachTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TERMINAL_AUTO_ATTACH_RETRY_MS = 1000;
const TERMINAL_DIRECT_NEGOTIATION_TIMEOUT_MS = 1500;
const pendingTerminalAutoAttach = new Map<string, { key: string; sentAt: number }>();
const TERMINAL_SHORTCUTS = [
  { id: 'ctrl_c', label: 'Ctrl+C', data: '\u0003' },
  { id: 'ctrl_d', label: 'Ctrl+D', data: '\u0004' },
  { id: 'esc', label: 'Esc', data: '\u001b' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'enter', label: 'Enter', data: '\r' },
  { id: 'ctrl_l', label: 'Ctrl+L', data: '\u000c' },
  { id: 'tmux_next_window', label: 'Ctrl+B, n', data: '\u0002n' },
  { id: 'tmux_up', label: 'Ctrl+B, ↑', data: '\u0002\u001b[A' },
  { id: 'tmux_down', label: 'Ctrl+B, ↓', data: '\u0002\u001b[B' },
  { id: 'tmux_left', label: 'Ctrl+B, ←', data: '\u0002\u001b[D' },
  { id: 'tmux_right', label: 'Ctrl+B, →', data: '\u0002\u001b[C' },
  { id: 'up', label: '↑ Up', data: '\u001b[A' },
  { id: 'down', label: '↓ Down', data: '\u001b[B' },
] as const;

const formatLatencyMs = (value: number | null | undefined): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)}ms` : null;

const buildLatencyBadge = (
  sample: TerminalLatencySample | null | undefined,
): { label: string; detail: string; tone: 'good' | 'warn' | 'bad' } | null => {
  if (!sample) {
    return null;
  }

  const total = formatLatencyMs(sample.clientInputToRenderMs);
  const exec = formatLatencyMs(sample.daemonInputToFirstOutputMs);
  if (!total && !exec) {
    return null;
  }

  const totalMs =
    typeof sample.clientInputToRenderMs === 'number' && Number.isFinite(sample.clientInputToRenderMs)
      ? sample.clientInputToRenderMs
      : null;
  const tone: 'good' | 'warn' | 'bad' =
    totalMs !== null && totalMs >= 300 ? 'bad' : totalMs !== null && totalMs >= 150 ? 'warn' : 'good';

  return {
    label: total ? `Latency ${total}` : `Exec ${exec}`,
    detail: exec ? `daemon ${exec}` : 'waiting for sample',
    tone,
  };
};

const buildTransportBadge = (
  transportState: TerminalTransportState | null | undefined,
): { label: string; tone: 'neutral' | 'good' | 'warn' } | null => {
  switch (transportState) {
    case 'direct':
      return { label: 'Direct', tone: 'good' };
    case 'negotiating':
      return { label: 'Negotiating', tone: 'warn' };
    case 'fallback_relay':
      return { label: 'Fallback Relay', tone: 'warn' };
    case 'relay':
      return { label: 'Relay', tone: 'neutral' };
    default:
      return null;
  }
};

const clearPendingTerminalDetach = (taskId: string) => {
  const timer = pendingTerminalDetachTimers.get(taskId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  pendingTerminalDetachTimers.delete(taskId);
};

const RefreshIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const CloseIcon = () => (
  <svg className="h-2 w-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const FullscreenIcon = () => (
  <svg className="h-2 w-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M8 4H4v4M16 4h4v4M8 20H4v-4M20 20h-4v-4" />
  </svg>
);

export function TerminalView({ task }: TerminalViewProps) {
  const websocketStatus = useWebSocketStore((state) => state.status);
  const send = useWebSocketStore((state) => state.send);
  const deleteTask = useTasksStore((state) => state.deleteTask);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const connectionState = useTerminalStore((state) => state.byTask[task.id]?.connectionState ?? 'idle');
  const hasWriteAccess = useTerminalStore((state) => state.byTask[task.id]?.hasWriteAccess ?? false);
  const sessionBanner = useTerminalStore((state) => state.byTask[task.id]?.banner ?? null);
  const lastLatencySample = useTerminalStore((state) => state.byTask[task.id]?.lastLatencySample ?? null);
  const transportState = useTerminalStore((state) => state.byTask[task.id]?.transportState ?? 'relay');
  const transportSessionId = useTerminalStore((state) => state.byTask[task.id]?.transportSession?.sessionId ?? null);
  const transportPolicy = useTerminalStore(
    (state) => state.byTask[task.id]?.transportSession?.transportPolicy ?? 'relay_only',
  );
  const directCandidate = useTerminalStore(
    (state) => state.byTask[task.id]?.transportSession?.directCandidate ?? false,
  );
  const beginFreshResumeAttach = useTerminalStore((state) => state.beginFreshResumeAttach);
  const markAttaching = useTerminalStore((state) => state.markAttaching);
  const markDetached = useTerminalStore((state) => state.markDetached);
  const updateTransportSession = useTerminalStore((state) => state.updateTransportSession);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const dataSubscriptionRef = useRef<{ dispose: () => void } | null>(null);
  const outputSubscriptionRef = useRef<(() => void) | null>(null);
  const transportSignalSubscriptionRef = useRef<(() => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const renderedSeqRef = useRef(0);
  const inputSeqRef = useRef(0);
  const latestConnectionStateRef = useRef<string>('idle');
  const latestSocketStatusRef = useRef(websocketStatus);
  const latestWriteAccessRef = useRef(false);
  const latestTransportStateRef = useRef<TerminalTransportState>('relay');
  const latestTransportSessionIdRef = useRef<string | null>(null);
  const directNegotiationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptedDirectSessionIdRef = useRef<string | null>(null);
  const rtcPeerRef = useRef<RTCPeerConnection | null>(null);
  const rtcChannelRef = useRef<RTCDataChannel | null>(null);
  const syncSizeRef = useRef<() => void>(() => {});
  const sizeRef = useRef({ cols: task.ptySession?.cols ?? 120, rows: task.ptySession?.rows ?? 40 });
  const shellRef = useRef<HTMLDivElement>(null);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDeletingTask, setIsDeletingTask] = useState(false);
  const [shortcutValue, setShortcutValue] = useState('');

  const shouldAutoAttach = task.status === 'running' || task.status === 'unknown';
  const canSendInput =
    websocketStatus === 'connected' && isTerminalReady && connectionState === 'open' && hasWriteAccess;
  const canRefreshTerminal = shouldAutoAttach && websocketStatus === 'connected' && isTerminalReady;
  const latencyBadge = buildLatencyBadge(lastLatencySample);
  const transportBadge = buildTransportBadge(transportState);

  latestConnectionStateRef.current = connectionState;
  latestSocketStatusRef.current = websocketStatus;
  latestWriteAccessRef.current = hasWriteAccess;
  latestTransportStateRef.current = transportState;
  latestTransportSessionIdRef.current = transportSessionId;

  const sendDirectPayload = (payload: Record<string, unknown>): boolean => {
    const channel = rtcChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const cleanupDirectTransport = () => {
    if (directNegotiationTimerRef.current) {
      clearTimeout(directNegotiationTimerRef.current);
      directNegotiationTimerRef.current = null;
    }
    try {
      rtcChannelRef.current?.close();
    } catch {}
    rtcChannelRef.current = null;
    try {
      rtcPeerRef.current?.close();
    } catch {}
    rtcPeerRef.current = null;
  };

  const sendAttach = (reason: 'initial' | 'reconnect' | 'manual') => {
    clearPendingTerminalDetach(task.id);
    if (!isTerminalReady || websocketStatus !== 'connected') {
      return;
    }
    markAttaching(task.id, {
      preferredMode: 'write',
      reason,
    });
    const snapshot = getTerminalOutputSnapshot(task.id);
    const shouldRequestResumeSnapshot = snapshot.lastSeq === 0 && snapshot.chunks.length === 0;
    if (shouldRequestResumeSnapshot) {
      beginFreshResumeAttach(task.id);
    }
    send({
      type: 'terminal_attach',
      payload: {
        task_id: task.id,
        last_seq: snapshot.lastSeq,
        cols: sizeRef.current.cols,
        rows: sizeRef.current.rows,
        mode: 'write',
        force: true,
        ...(shouldRequestResumeSnapshot ? { resume_strategy: 'snapshot' } : {}),
      },
    });
  };

  const handleRefresh = useCallback(() => {
    if (!canRefreshTerminal) {
      return;
    }
    sendAttach('manual');
    syncSizeRef.current();
    terminalRef.current?.focus();
  }, [canRefreshTerminal, sendAttach]);

  const handleToggleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell || typeof document === 'undefined') {
      return;
    }

    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen?.();
      } else {
        await shell.requestFullscreen?.();
      }
    } catch {
    }
  }, []);

  const handleDeleteTask = useCallback(async () => {
    if (isDeletingTask) {
      return;
    }

    const accepted = await confirm({
      title: 'Delete this task?',
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) {
      return;
    }

    setIsDeletingTask(true);
    try {
      await deleteTask(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete task';
      pushToast({
        title: 'Failed to delete task',
        description: message,
        variant: 'error',
      });
    } finally {
      setIsDeletingTask(false);
    }
  }, [confirm, deleteTask, isDeletingTask, pushToast, task.id]);

  const sendTerminalInput = (data: string): boolean => {
    if (!data || latestSocketStatusRef.current !== 'connected' || latestConnectionStateRef.current !== 'open' || !latestWriteAccessRef.current) {
      return false;
    }
    inputSeqRef.current += 1;
    const payload = {
      task_id: task.id,
      data,
      client_input_seq: inputSeqRef.current,
      client_sent_at: new Date().toISOString(),
    };
    if (latestTransportStateRef.current === 'direct' && sendDirectPayload({ type: 'terminal_input', payload })) {
      return true;
    }
    send({
      type: 'terminal_input',
      payload,
    });
    return true;
  };

  useEffect(() => {
    clearPendingTerminalDetach(task.id);
    return () => {
      clearPendingTerminalDetach(task.id);
    };
  }, [task.id]);

  useEffect(() => {
    if (websocketStatus !== 'connected') {
      pendingTerminalAutoAttach.delete(task.id);
    }
  }, [task.id, websocketStatus]);

  useEffect(() => {
    if (connectionState !== 'connecting') {
      pendingTerminalAutoAttach.delete(task.id);
    }
  }, [connectionState, task.id]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleFullscreenChange = () => {
      const isShellFullscreen = document.fullscreenElement === shellRef.current;
      setIsFullscreen(isShellFullscreen);
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          syncSizeRef.current();
          terminalRef.current?.focus();
        });
      }
    };

    handleFullscreenChange();
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    transportSignalSubscriptionRef.current = subscribeTerminalTransportSignal(task.id, (signal) => {
      if (!transportSessionId || signal.sessionId !== transportSessionId) {
        return;
      }

      if (signal.signalType === 'answer') {
        const description = signal.description;
        if (
          description?.type === 'answer' &&
          typeof description.sdp === 'string' &&
          rtcPeerRef.current
        ) {
          void rtcPeerRef.current
            .setRemoteDescription({
              type: 'answer',
              sdp: description.sdp,
            })
            .then(() => undefined)
            .catch(() => {
              updateTransportSession({
                task_id: task.id,
                session_id: transportSessionId,
                transport_state: 'fallback_relay',
                transport_policy: transportPolicy,
                direct_candidate: false,
                reason: 'invalid_answer',
              });
              cleanupDirectTransport();
            });
        }
        return;
      }

      if (signal.signalType === 'ice_candidate') {
        if (rtcPeerRef.current && signal.candidate) {
          void rtcPeerRef.current.addIceCandidate(signal.candidate as RTCIceCandidateInit).catch(() => {});
        }
        return;
      }

      if (signal.signalType === 'answer_placeholder' || signal.signalType === 'unsupported') {
        updateTransportSession({
          task_id: task.id,
          session_id: transportSessionId,
          transport_state: 'fallback_relay',
          transport_policy: transportPolicy,
          direct_candidate: false,
          reason:
            typeof signal.description?.reason === 'string'
              ? signal.description.reason
              : 'direct_transport_not_supported',
        });
        cleanupDirectTransport();
      }
    });

    return () => {
      transportSignalSubscriptionRef.current?.();
      transportSignalSubscriptionRef.current = null;
      cleanupDirectTransport();
      if (directNegotiationTimerRef.current) {
        clearTimeout(directNegotiationTimerRef.current);
        directNegotiationTimerRef.current = null;
      }
    };
  }, [task.id, transportPolicy, transportSessionId, updateTransportSession]);

  useEffect(() => {
    let disposed = false;

    const setupTerminal = async () => {
      if (!containerRef.current) {
        return;
      }

      const { Terminal, FitAddon } = await loadXtermModules();
      if (disposed || !containerRef.current) {
        return;
      }

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: '"SFMono-Regular", "JetBrains Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.3,
        scrollback: 2000,
        theme: {
          background: '#10151c',
          foreground: '#f5f3ef',
          cursor: '#f06543',
          selectionBackground: 'rgba(240, 101, 67, 0.28)',
          black: '#0d0f12',
          red: '#f87171',
          green: '#34d399',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#f472b6',
          cyan: '#22d3ee',
          white: '#f5f3ef',
          brightBlack: '#6b7280',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#f9a8d4',
          brightCyan: '#67e8f9',
          brightWhite: '#ffffff',
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      sizeRef.current = { cols: terminal.cols, rows: terminal.rows };

      const pendingOutputEvents: TerminalOutputEvent[] = [];
      let outputReady = false;
      outputSubscriptionRef.current = subscribeTerminalOutput(task.id, (event) => {
        if (!outputReady) {
          pendingOutputEvents.push(event);
          return;
        }
        if (event.replace) {
          terminal.clear();
          if (event.data) {
            terminal.write(event.data);
          }
          renderedSeqRef.current = event.seq;
          return;
        }
        if (event.seq <= renderedSeqRef.current) {
          return;
        }
        terminal.write(event.data);
        renderedSeqRef.current = event.seq;
      });

      const snapshot = getTerminalOutputSnapshot(task.id);
      if (snapshot.chunks.length > 0) {
        terminal.write(snapshot.chunks.join(''));
      }
      renderedSeqRef.current = snapshot.lastSeq;
      outputReady = true;
      for (const event of pendingOutputEvents) {
        if (event.replace) {
          terminal.clear();
          if (event.data) {
            terminal.write(event.data);
          }
          renderedSeqRef.current = event.seq;
          continue;
        }
        if (event.seq <= renderedSeqRef.current) {
          continue;
        }
        terminal.write(event.data);
        renderedSeqRef.current = event.seq;
      }

      dataSubscriptionRef.current = terminal.onData((data) => {
        sendTerminalInput(data);
      });

      const syncSize = () => {
        if (!fitAddonRef.current || !terminalRef.current) {
          return;
        }
        fitAddonRef.current.fit();
        const nextSize = { cols: terminalRef.current.cols, rows: terminalRef.current.rows };
        if (nextSize.cols === sizeRef.current.cols && nextSize.rows === sizeRef.current.rows) {
          return;
        }
        sizeRef.current = nextSize;
        if (
          latestSocketStatusRef.current === 'connected' &&
          latestConnectionStateRef.current === 'open' &&
          latestWriteAccessRef.current
        ) {
          if (
            latestTransportStateRef.current === 'direct' &&
            sendDirectPayload({
              type: 'terminal_resize',
              payload: {
                task_id: task.id,
                cols: nextSize.cols,
                rows: nextSize.rows,
              },
            })
          ) {
            return;
          }
          send({
            type: 'terminal_resize',
            payload: {
              task_id: task.id,
              cols: nextSize.cols,
              rows: nextSize.rows,
            },
          });
        }
      };
      syncSizeRef.current = syncSize;

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          syncSize();
        });
        observer.observe(containerRef.current);
        resizeObserverRef.current = observer;
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      setIsTerminalReady(true);
      syncSize();
      terminal.focus();
    };

    void setupTerminal();

    return () => {
      disposed = true;
      setIsTerminalReady(false);
      clearPendingTerminalDetach(task.id);
      const detachTimer = setTimeout(() => {
        pendingTerminalDetachTimers.delete(task.id);
        if (latestSocketStatusRef.current === 'connected') {
          send({
            type: 'terminal_detach',
            payload: {
              task_id: task.id,
            },
          });
        }
        pendingTerminalAutoAttach.delete(task.id);
        markDetached(task.id);
      }, TERMINAL_DETACH_DELAY_MS);
      pendingTerminalDetachTimers.set(task.id, detachTimer);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      outputSubscriptionRef.current?.();
      outputSubscriptionRef.current = null;
      dataSubscriptionRef.current?.dispose();
      dataSubscriptionRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      syncSizeRef.current = () => {};
      renderedSeqRef.current = 0;
    };
  }, [markDetached, send, task.id]);

  useEffect(() => {
    if (
      !isTerminalReady ||
      websocketStatus !== 'connected' ||
      !shouldAutoAttach ||
      connectionState === 'open' ||
      connectionState === 'error' ||
      connectionState === 'exited'
    ) {
      return;
    }

    const snapshot = getTerminalOutputSnapshot(task.id);
    const autoAttachKey = [
      task.id,
      connectionState,
      snapshot.lastSeq,
      sizeRef.current.cols,
      sizeRef.current.rows,
    ].join(':');
    const lastAutoAttach = pendingTerminalAutoAttach.get(task.id);
    if (
      connectionState === 'connecting' &&
      lastAutoAttach?.key === autoAttachKey &&
      Date.now() - lastAutoAttach.sentAt < TERMINAL_AUTO_ATTACH_RETRY_MS
    ) {
      return;
    }

    pendingTerminalAutoAttach.set(task.id, {
      key: autoAttachKey,
      sentAt: Date.now(),
    });
    sendAttach(connectionState === 'connecting' ? 'reconnect' : 'initial');
  }, [connectionState, isTerminalReady, shouldAutoAttach, task.id, websocketStatus]);

  useEffect(() => {
    if (transportState === 'direct' || transportState === 'fallback_relay' || transportState === 'relay') {
      if (directNegotiationTimerRef.current) {
        clearTimeout(directNegotiationTimerRef.current);
        directNegotiationTimerRef.current = null;
      }
      if (transportState !== 'direct') {
        cleanupDirectTransport();
      }
    }
  }, [transportState]);

  useEffect(() => {
    if (hasWriteAccess || transportState === 'relay' || transportState === 'fallback_relay') {
      return;
    }
    cleanupDirectTransport();
    if (!transportSessionId) {
      return;
    }
    updateTransportSession({
      task_id: task.id,
      session_id: transportSessionId,
      transport_state: 'fallback_relay',
      transport_policy: transportPolicy,
      direct_candidate: false,
      reason: 'writer_revoked',
    });
  }, [hasWriteAccess, task.id, transportPolicy, transportSessionId, transportState, updateTransportSession]);

  useEffect(() => {
    const supportsRtc = typeof RTCPeerConnection !== 'undefined';
    if (
      !transportSessionId ||
      attemptedDirectSessionIdRef.current === transportSessionId ||
      websocketStatus !== 'connected' ||
      connectionState !== 'open' ||
      !hasWriteAccess ||
      !isTerminalReady ||
      transportPolicy !== 'direct_preferred' ||
      !directCandidate ||
      !supportsRtc ||
      transportState !== 'relay'
    ) {
      return;
    }

    attemptedDirectSessionIdRef.current = transportSessionId;

    void (async () => {
      try {
        const peer = new RTCPeerConnection();
        rtcPeerRef.current = peer;
        const channel = peer.createDataChannel('pty');
        rtcChannelRef.current = channel;

        channel.onmessage = (event) => {
          try {
            const raw =
              typeof event.data === 'string'
                ? event.data
                : event.data instanceof ArrayBuffer
                  ? new TextDecoder().decode(new Uint8Array(event.data))
                  : String(event.data ?? '');
            const parsed = JSON.parse(raw);
            if (parsed?.type === 'terminal_output' && parsed.payload) {
              useTerminalStore.getState().appendOutput(parsed.payload);
            } else if (parsed?.type === 'terminal_exit' && parsed.payload) {
              useTerminalStore.getState().markExit(parsed.payload);
            } else if (parsed?.type === 'terminal_error' && parsed.payload) {
              useTerminalStore.getState().markError(parsed.payload);
            }
          } catch {
            // ignore malformed direct payloads
          }
        };
        channel.onopen = () => {
          updateTransportSession({
            task_id: task.id,
            session_id: transportSessionId,
            transport_state: 'direct',
            transport_policy: transportPolicy,
            direct_candidate: true,
          });
        };
        channel.onclose = () => {
          if (latestTransportStateRef.current !== 'fallback_relay') {
            updateTransportSession({
              task_id: task.id,
              session_id: transportSessionId,
              transport_state: 'fallback_relay',
              transport_policy: transportPolicy,
              direct_candidate: false,
              reason: 'direct_channel_closed',
            });
          }
        };

        peer.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }
          send({
            type: 'pty_transport_signal',
            payload: {
              task_id: task.id,
              session_id: transportSessionId,
              signal_type: 'ice_candidate',
              candidate: event.candidate.toJSON(),
            },
          });
        };

        updateTransportSession({
          task_id: task.id,
          session_id: transportSessionId,
          transport_state: 'negotiating',
          transport_policy: transportPolicy,
          direct_candidate: true,
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        send({
          type: 'pty_transport_signal',
          payload: {
            task_id: task.id,
            session_id: transportSessionId,
            signal_type: 'offer',
            description: {
              type: offer.type,
              sdp: offer.sdp,
            },
            protocol: 'webrtc-datachannel-v1',
          },
        });

        if (directNegotiationTimerRef.current) {
          clearTimeout(directNegotiationTimerRef.current);
        }
        directNegotiationTimerRef.current = setTimeout(() => {
          updateTransportSession({
            task_id: task.id,
            session_id: transportSessionId,
            transport_state: 'fallback_relay',
            transport_policy: transportPolicy,
            direct_candidate: false,
            reason: 'direct_negotiation_timeout',
          });
          directNegotiationTimerRef.current = null;
          try {
            rtcChannelRef.current?.close();
          } catch {}
          try {
            rtcPeerRef.current?.close();
          } catch {}
          rtcChannelRef.current = null;
          rtcPeerRef.current = null;
        }, TERMINAL_DIRECT_NEGOTIATION_TIMEOUT_MS);
      } catch {
        updateTransportSession({
          task_id: task.id,
          session_id: transportSessionId,
          transport_state: 'fallback_relay',
          transport_policy: transportPolicy,
          direct_candidate: false,
          reason: 'offer_creation_failed',
        });
      }
    })();
  }, [
    connectionState,
    directCandidate,
    hasWriteAccess,
    isTerminalReady,
    send,
    task.id,
    transportPolicy,
    transportSessionId,
    transportState,
    updateTransportSession,
    websocketStatus,
  ]);

  const handleShortcutChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value;
    setShortcutValue('');
    if (!nextValue) {
      return;
    }
    const shortcut = TERMINAL_SHORTCUTS.find((item) => item.id === nextValue);
    if (!shortcut) {
      return;
    }
    sendTerminalInput(shortcut.data);
    terminalRef.current?.focus();
  };

  return (
    <div className="relative h-full overflow-hidden bg-paper p-3 md:p-4">
      <div
        ref={shellRef}
        className="absolute inset-3 overflow-hidden rounded-[20px] border border-[#1f2730] bg-[#10151c] shadow-[0_18px_48px_rgba(16,21,28,0.24)] md:inset-4"
      >
        <div className="flex h-10 items-center gap-2 border-b border-white/8 bg-[linear-gradient(90deg,rgba(240,101,67,0.12),rgba(34,211,238,0.08))] px-4">
          <button
            type="button"
            onClick={() => {
              void handleDeleteTask();
            }}
            disabled={isDeletingTask}
            aria-label="Delete current task"
            title="Delete current task"
            className="group relative inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#f87171] text-[#7f1d1d] transition-transform hover:scale-110 focus-visible:scale-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <CloseIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={!canRefreshTerminal}
            aria-label="Refresh terminal"
            title="Refresh terminal"
            className="group relative inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#fbbf24] text-[#78350f] transition-transform hover:scale-110 focus-visible:scale-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <RefreshIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              void handleToggleFullscreen();
            }}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="group relative inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#34d399] text-[#14532d] transition-transform hover:scale-110 focus-visible:scale-110"
          >
            <span className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <FullscreenIcon />
            </span>
          </button>
          {transportBadge ? (
            <div
              className={`rounded-full px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] ${
                transportBadge.tone === 'good'
                  ? 'bg-[#34d399]/15 text-[#bbf7d0]'
                  : transportBadge.tone === 'warn'
                    ? 'bg-[#fbbf24]/15 text-[#fde68a]'
                    : 'bg-white/8 text-white/70'
              }`}
            >
              {transportBadge.label}
            </div>
          ) : null}
          {latencyBadge ? (
            <div
              className={`rounded-full px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] ${
                latencyBadge.tone === 'bad'
                  ? 'bg-[#f87171]/15 text-[#fecaca]'
                  : latencyBadge.tone === 'warn'
                    ? 'bg-[#fbbf24]/15 text-[#fde68a]'
                    : 'bg-[#34d399]/15 text-[#bbf7d0]'
              }`}
              title={latencyBadge.detail}
            >
              {latencyBadge.label}
            </div>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor={`terminal-shortcuts-${task.id}`}>
              Terminal shortcuts
            </label>
            <select
              id={`terminal-shortcuts-${task.id}`}
              aria-label="Terminal shortcuts"
              value={shortcutValue}
              onChange={handleShortcutChange}
              disabled={!canSendInput}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-medium tracking-[0.08em] text-white/70 outline-none transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
            >
              <option value="">Shortcuts</option>
              {TERMINAL_SHORTCUTS.map((shortcut) => (
                <option key={shortcut.id} value={shortcut.id}>
                  {shortcut.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {sessionBanner ? (
          <div className="mx-3 mt-2">
            <InlineNotice variant={sessionBanner.tone}>{sessionBanner.message}</InlineNotice>
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="h-[calc(100%-2.5rem)] w-full cursor-text px-2 py-2"
          onClick={() => terminalRef.current?.focus()}
        />
      </div>
    </div>
  );
}
