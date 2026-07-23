'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'next/navigation';
import { useWebSocketStore } from '@/features/realtime';
import { useRuntimeStore } from '@/features/realtime';
import { useTasksStore } from '@/features/tasks';
import { formatPercent, normalizeTaskId } from './ConnectionStatus.utils';

const formatActiveScheduleCount = (count: number) => `${Math.max(0, count)} active`;

const COPIED_BUBBLE_DURATION_MS = 2000;
const LONG_PRESS_DURATION_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const BUBBLE_OFFSET_X = 12;
const BUBBLE_OFFSET_Y = 4;
// Sized for the longest label ("Copy failed"); only affects near-edge clamping.
const BUBBLE_ESTIMATED_WIDTH = 96;
const BUBBLE_ESTIMATED_HEIGHT = 26;
const BUBBLE_VIEWPORT_MARGIN = 8;

// Keeps the bubble on screen when copying near a viewport edge (common on phones).
const clampBubblePosition = (x: number, y: number) => {
  if (typeof window === 'undefined') {
    return { x, y };
  }
  const maxX = window.innerWidth - BUBBLE_ESTIMATED_WIDTH - BUBBLE_VIEWPORT_MARGIN;
  const minY = BUBBLE_ESTIMATED_HEIGHT + BUBBLE_VIEWPORT_MARGIN;
  return {
    x: Math.max(BUBBLE_VIEWPORT_MARGIN, Math.min(x, Math.max(BUBBLE_VIEWPORT_MARGIN, maxX))),
    y: Math.max(minY, Math.min(y, window.innerHeight - BUBBLE_VIEWPORT_MARGIN)),
  };
};

// `textarea.select()` alone is a no-op on iOS Safari, so the fallback selects an
// explicit range. Kept off-screen via opacity rather than a negative offset so the
// page does not jump when focus moves to it.
const copyWithExecCommand = (value: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.contentEditable = 'true';
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(textarea);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textarea.setSelectionRange?.(0, value.length);
    textarea.select?.();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
};

const copyToClipboard = async (value: string): Promise<boolean> => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // WebKit can reject clipboard writes made outside a synchronous user
      // gesture (our long-press fires from a timer), so fall through instead
      // of reporting failure straight away.
    }
  }

  try {
    return copyWithExecCommand(value);
  } catch {
    return false;
  }
};

export function ConnectionStatus({
  detailsEnabled = false,
  taskId: taskIdOverride,
}: {
  detailsEnabled?: boolean;
  taskId?: string | null;
}) {
  const status = useWebSocketStore((state) => state.status);
  const params = useParams<{ taskId?: string | string[] }>();
  const routeTaskId = useMemo(() => normalizeTaskId(params?.taskId), [params]);
  const taskId = taskIdOverride ?? routeTaskId;
  const runtime = useRuntimeStore((state) => (taskId ? state.byTask[taskId] : undefined));
  const currentTask = useTasksStore((state) => {
    if (!taskId) {
      return undefined;
    }
    return state.tasks.find((item) => item.id === taskId);
  });
  const isPtyTask = currentTask?.taskType === 'pty_task';
  const [open, setOpen] = useState(false);
  const [copiedBubble, setCopiedBubble] = useState<{ x: number; y: number; ok: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef({ x: 0, y: 0 });
  const longPressFiredRef = useRef(false);
  const lastPointerTypeRef = useRef<string>('mouse');

  const statusConfig = {
    connected: {
      color: 'bg-[var(--success)]',
      pulse: false,
      label: 'Connected',
    },
    connecting: {
      color: 'bg-[var(--warning)]',
      pulse: true,
      label: 'Connecting...',
    },
    disconnected: {
      color: 'bg-[var(--error)]',
      pulse: false,
      label: 'Disconnected',
    },
  };

  const config = statusConfig[status];
  const pid = runtime?.pid ?? null;
  const taskIdValue = taskId || 'n/a';
  const sessionId = runtime?.sessionId || runtime?.threadId || currentTask?.sessionId || 'n/a';
  const tokenUsagePercent = formatPercent(runtime?.tokenUsagePercent);
  const contextUsagePercent = formatPercent(runtime?.contextUsagePercent);
  const scheduledLabel = formatActiveScheduleCount(currentTask?.activeScheduledMessageCount ?? 0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setCopiedBubble(null);
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, [open]);

  const copyValueAt = async (value: string, x: number, y: number) => {
    if (!value || value === 'n/a') {
      return;
    }
    const copied = await copyToClipboard(value);
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
    }
    // Always surface an outcome: a silent no-op is indistinguishable from the
    // gesture not registering, which just makes users retry.
    setCopiedBubble({
      ...clampBubblePosition(x + BUBBLE_OFFSET_X, y - BUBBLE_OFFSET_Y),
      ok: copied,
    });
    copiedTimerRef.current = setTimeout(() => {
      setCopiedBubble(null);
      copiedTimerRef.current = null;
    }, COPIED_BUBBLE_DURATION_MS);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Desktop copies on double-click; touch devices cannot rely on `dblclick`
  // (double-tap is consumed by zoom), so they copy on a 500ms long-press.
  const copyGestureProps = (value: string) => ({
    title: 'Double-click or long-press to copy',
    onDoubleClick: (event: ReactMouseEvent<HTMLSpanElement>) => {
      if (longPressFiredRef.current) {
        return;
      }
      void copyValueAt(value, event.clientX, event.clientY);
    },
    onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => {
      lastPointerTypeRef.current = event.pointerType;
      longPressFiredRef.current = false;
      if (event.pointerType === 'mouse') {
        return;
      }
      clearLongPress();
      const { clientX, clientY } = event;
      longPressStartRef.current = { x: clientX, y: clientY };
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressFiredRef.current = true;
        void copyValueAt(value, clientX, clientY);
      }, LONG_PRESS_DURATION_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (!longPressTimerRef.current) {
        return;
      }
      const dx = event.clientX - longPressStartRef.current.x;
      const dy = event.clientY - longPressStartRef.current.y;
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX) {
        clearLongPress();
      }
    },
    onPointerUp: clearLongPress,
    onPointerCancel: clearLongPress,
    onContextMenu: (event: ReactMouseEvent<HTMLSpanElement>) => {
      // Android fires contextmenu at the same moment our long-press copies.
      if (lastPointerTypeRef.current !== 'mouse') {
        event.preventDefault();
      }
    },
  });

  // `-webkit-touch-callout` only suppresses the long-press menu, not the selection
  // itself, so touch devices also need `user-select: none` to stop iOS from starting
  // a text selection mid long-press. Mouse devices keep manual selection.
  const copyableClassName = `break-all cursor-pointer rounded px-0.5 -mx-0.5 transition-colors [-webkit-touch-callout:none] pointer-coarse:select-none ${
    isPtyTask ? 'text-white hover:bg-white/10' : 'text-ink hover:bg-[var(--border)]/40'
  }`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!detailsEnabled) {
            return;
          }
          setOpen((prev) => !prev);
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--border)]/30 hover:bg-[var(--border)]/45 transition-colors"
        aria-label="Open connection details"
        aria-expanded={detailsEnabled ? open : undefined}
      >
        <span className="relative flex size-2.5">
          {config.pulse && (
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75`} />
          )}
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.color}`} />
        </span>
        <span className="text-xs font-medium text-muted hidden sm:inline">
          {config.label}
        </span>
      </button>

      {detailsEnabled && open && (
        <div
          className={`absolute right-0 mt-2 w-[22rem] rounded-xl border backdrop-blur-md shadow-xl p-3 z-30 ${
            isPtyTask
              ? 'border-white/10 bg-zinc-950/70 text-white'
              : 'border-border bg-panel/70'
          }`}
        >
          <div className={`mb-2 text-xs font-semibold ${isPtyTask ? 'text-white' : 'text-ink'}`}>Runtime Details</div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1 gap-x-2 text-xs">
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Task ID</span>
            <span className={copyableClassName} {...copyGestureProps(taskIdValue)}>
              {taskIdValue}
            </span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>PID</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{pid ?? 'n/a'}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Scheduled</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{scheduledLabel}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Session ID</span>
            <span className={copyableClassName} {...copyGestureProps(sessionId)}>
              {sessionId}
            </span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Token Usage</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{tokenUsagePercent}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Context Usage</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{contextUsagePercent}</span>
          </div>
        </div>
      )}

      {copiedBubble && typeof document !== 'undefined'
        ? createPortal(
            <div
              role={copiedBubble.ok ? 'status' : 'alert'}
              className={`pointer-events-none fixed z-[100] -translate-y-full rounded-md px-2 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm ${
                copiedBubble.ok ? 'bg-zinc-900/90' : 'bg-[var(--error)]/95'
              }`}
              style={{ left: copiedBubble.x, top: copiedBubble.y }}
            >
              {copiedBubble.ok ? 'Copied' : 'Copy failed'}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
