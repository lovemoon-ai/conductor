/**
 * Per-instance chat state.
 *
 * Uses React Context + useReducer rather than zustand to avoid pulling in a
 * runtime dependency for the v0.1 widget. The reducer's shape is identical
 * to what `web/src/features/chat/store.ts` carries today, so a future
 * extraction phase can swap implementations without changing the public
 * widget API.
 *
 * Multiple `<ChatView>` instances on the same page each create their own
 * provider + store — state is isolated by construction.
 */
import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import type { ChatAdapter } from '../../types/adapter.js';
import type { ChatEvent } from '../../types/events.js';
import type { Message, SendMessageInput } from '../../types/message.js';
import type { RuntimeStatus } from '../../types/runtime.js';

/**
 * Inline UUID generator — kept in sync with `src/server/id.ts`. We don't
 * import from /server because that would pull a Node-only module into the
 * /react bundle (and trip the bundle-smoke guard). The fallbacks below
 * mirror id.ts so server-side idempotency keys (which key on this id)
 * stay consistent regardless of which side generated them.
 *
 * The crypto.randomUUID path produces an RFC4122 v4 string; the
 * getRandomValues fallback produces a 32-char hex string (raw 16 random
 * bytes, no dashes). The last-resort Math.random fallback is reachable
 * only on environments missing both Web Crypto APIs — vanishingly rare.
 */
function generateRequestId(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (a: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ChatState {
  messages: Message[];
  /** Optimistically inserted, awaiting server echo. Keyed by clientRequestId. */
  pendingByClientId: Record<string, Message>;
  runtime: RuntimeStatus | null;
  connectionState: 'connected' | 'reconnecting' | 'offline';
  hasMoreBefore: boolean;
  oldestMessageId: string | null;
  loadingHistory: boolean;
  error: ChatError | null;
  /** ID of the latest assistant reply, used for interrupt targeting. */
  latestReplyId: string | null;
}

const INITIAL_STATE: ChatState = {
  messages: [],
  pendingByClientId: {},
  runtime: null,
  connectionState: 'offline',
  hasMoreBefore: false,
  oldestMessageId: null,
  loadingHistory: false,
  error: null,
  latestReplyId: null,
};

/**
 * Error captured into chat state. Carries the structured fields from
 * `ConductorAppError` and from `ChatEventError` (task_failed envelopes) so
 * the host UI can surface request IDs, server payloads, and the original
 * cause without depending on the SDK error class directly.
 *
 * `cause` is also carried for parity with `ChatEventError` — terminal errors
 * surfaced via WS (e.g. iterator-synthesised task_failed) include an `Error`
 * instance in `cause` so callers walking the cause chain recover the stack.
 */
export interface ChatError {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  details?: unknown;
  cause?: unknown;
}

type Action =
  | { type: 'HYDRATE_HISTORY'; messages: Message[]; hasMoreBefore: boolean; oldestMessageId: string | null }
  | { type: 'PREPEND_HISTORY'; messages: Message[]; hasMoreBefore: boolean; oldestMessageId: string | null }
  | { type: 'LOADING_HISTORY'; loading: boolean }
  | { type: 'OPTIMISTIC_SEND'; message: Message; clientRequestId: string }
  | { type: 'CONFIRM_SEND'; clientRequestId: string; serverMessage: Message }
  | { type: 'ROLLBACK_SEND'; clientRequestId: string }
  | { type: 'APPEND_MESSAGE'; message: Message }
  | { type: 'UPDATE_MESSAGE'; message: Message }
  | { type: 'SET_RUNTIME'; status: RuntimeStatus }
  | { type: 'SET_CONNECTION'; state: 'connected' | 'reconnecting' | 'offline' }
  | { type: 'SET_ERROR'; error: ChatError | null }
  | { type: 'TASK_FAILED'; error: ChatError }
  | { type: 'TASK_FINISHED' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'HYDRATE_HISTORY':
      return {
        ...state,
        messages: dedupSorted(action.messages),
        hasMoreBefore: action.hasMoreBefore,
        oldestMessageId: action.oldestMessageId,
      };
    case 'PREPEND_HISTORY':
      return {
        ...state,
        messages: dedupSorted([...action.messages, ...state.messages]),
        hasMoreBefore: action.hasMoreBefore,
        oldestMessageId: action.oldestMessageId ?? state.oldestMessageId,
      };
    case 'LOADING_HISTORY':
      return { ...state, loadingHistory: action.loading };
    case 'OPTIMISTIC_SEND': {
      // Insert optimistically; server echo will replace once it arrives.
      return {
        ...state,
        messages: dedupSorted([...state.messages, action.message]),
        pendingByClientId: {
          ...state.pendingByClientId,
          [action.clientRequestId]: action.message,
        },
      };
    }
    case 'CONFIRM_SEND': {
      const { [action.clientRequestId]: _pending, ...rest } = state.pendingByClientId;
      // Remove the optimistic copy (it carried a temp id starting with
      // 'pending:<clientRequestId>') and replace with the server message.
      const pendingId = `pending:${action.clientRequestId}`;
      const filtered = state.messages.filter((m) => m.id !== pendingId);
      return {
        ...state,
        pendingByClientId: rest,
        messages: dedupSorted([...filtered, action.serverMessage]),
      };
    }
    case 'ROLLBACK_SEND': {
      const { [action.clientRequestId]: _pending, ...rest } = state.pendingByClientId;
      return {
        ...state,
        pendingByClientId: rest,
        messages: state.messages.filter(
          (m) => m.id !== `pending:${action.clientRequestId}`,
        ),
      };
    }
    case 'APPEND_MESSAGE': {
      const next = dedupSorted([...state.messages, action.message]);
      // `latestReplyId` is the "the AI just replied" signal used for
      // interrupt targeting. Only genuine assistant messages should
      // advance it — user/sdk echoes, daemon-emitted system info
      // (`metadata.synthetic`), and outbound app messages
      // (`metadata.audit.actor='app'`) all look like assistant-shaped
      // messages but aren't real replies.
      const meta = action.message.metadata as Record<string, unknown> | null;
      const auditActor =
        meta && typeof meta === 'object'
          ? (meta.audit as { actor?: unknown } | undefined)?.actor
          : undefined;
      const isSynthetic = Boolean(meta && (meta as { synthetic?: unknown }).synthetic === true);
      const isAppEcho = auditActor === 'app';
      const isAssistant =
        action.message.role !== 'user' &&
        action.message.role !== 'sdk' &&
        action.message.role !== 'system' &&
        !isSynthetic &&
        !isAppEcho;
      return {
        ...state,
        messages: next,
        latestReplyId: isAssistant ? action.message.id : state.latestReplyId,
      };
    }
    case 'UPDATE_MESSAGE': {
      const idx = state.messages.findIndex((m) => m.id === action.message.id);
      if (idx === -1) return state;
      const next = state.messages.slice();
      next[idx] = action.message;
      return { ...state, messages: next };
    }
    case 'SET_RUNTIME': {
      const replyTo = action.status.replyTo ?? state.latestReplyId;
      return {
        ...state,
        runtime: action.status,
        latestReplyId: replyTo ?? state.latestReplyId,
      };
    }
    case 'SET_CONNECTION':
      return { ...state, connectionState: action.state };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'TASK_FAILED':
      return { ...state, error: action.error };
    case 'TASK_FINISHED':
      // Keep messages; clear transient runtime state.
      return { ...state, runtime: null };
    default:
      return state;
  }
}

function dedupSorted(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of messages) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.createdAt || '');
    const tb = Date.parse(b.createdAt || '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

// -------------------------------------------------------------------------
// Context / Provider / hooks
// -------------------------------------------------------------------------

interface ChatContextValue {
  state: ChatState;
  taskId: string;
  adapter: ChatAdapter;
  send: (content: string, opts?: { metadata?: Record<string, unknown> }) => Promise<void>;
  interrupt: () => Promise<void>;
  loadEarlier: () => Promise<void>;
  /**
   * Restart the task's AI session. No-op when the adapter doesn't implement
   * `restart` — check `restartSupported` before surfacing restart UI.
   */
  restart: (opts?: { restartMode?: string }) => Promise<void>;
  /** True when the active adapter implements `restart`. */
  restartSupported: boolean;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error(
      'useChat() must be called inside <ChatProvider> (or <ChatView>, which wraps it).',
    );
  }
  return ctx;
}

export interface ChatProviderProps {
  taskId: string;
  adapter: ChatAdapter;
  onError?: (error: unknown) => void;
  children: ReactNode;
}

export function ChatProvider(props: ChatProviderProps) {
  const { taskId, adapter, onError } = props;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const taskIdRef = useRef(taskId);
  const adapterRef = useRef(adapter);
  const onErrorRef = useRef(onError);
  taskIdRef.current = taskId;
  onErrorRef.current = onError;

  // Adapter contract:
  //
  //   The subscribe/fetchHistory effect is keyed ONLY on `taskId`, not on the
  //   adapter reference. This is intentional: integrators commonly inline
  //   `createRestAdapter({...})` directly in JSX, which produces a fresh
  //   adapter object on every render. Keying the subscribe effect on adapter
  //   identity in that case caused infinite re-subscribe loops in v0.1.
  //
  //   Adapter changes are picked up the next time `taskId` changes (i.e. the
  //   next subscribe). For the typical pattern — one stable BFF backing every
  //   task — this is exactly right. Integrators who *do* want to swap
  //   adapters mid-conversation should unmount/remount <ChatProvider> with a
  //   fresh `key`, or change taskId.
  //
  //   We keep `adapterRef` up to date below so imperative actions
  //   (send / interrupt / loadEarlier) always hit the latest adapter.
  useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  // Fetch initial history + subscribe to events whenever taskId changes.
  // We read `adapterRef.current` synchronously at effect-fire time so a fresh
  // adapter is honored on the next subscribe without forcing a re-subscribe
  // on every parent render.
  useEffect(() => {
    const activeAdapter = adapterRef.current;
    let cancelled = false;
    const abort = new AbortController();

    // ---------------------------------------------------------------------
    // History catch-up (defense-in-depth against missed `message_appended`)
    //
    // Why: not every Conductor deployment guarantees real-time delivery of
    // `task_sdk_message`. Multi-instance broadcast hubs without a pub/sub
    // backplane, idempotent retries that bypass projection, and momentary
    // WS disconnects can all swallow the final assistant message envelope.
    // Refreshing the page would show the message (it lives in DB history).
    // This catch-up emulates that refresh transparently.
    //
    // When: after `task_finished` / `task_failed`, after `runtime_status`
    // transitions `replyInProgress` true→false, and after the underlying
    // connection transitions `reconnecting → connected` (so we backfill
    // anything that arrived while we were offline).
    //
    // Safety: the reducer's `dedupSorted` already keys on `message.id`, so
    // re-dispatching a message we already have is a no-op for the UI.
    // Errors here are logged but never poison chat state.
    // ---------------------------------------------------------------------
    let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
    let catchUpInFlight = false;
    let needAnotherCatchUp = false;
    let catchUpAbort: AbortController | null = null;
    let prevReplyInProgress: boolean | undefined;
    let prevConnectionState:
      | 'connected'
      | 'reconnecting'
      | 'offline'
      | undefined;

    const runCatchUp = async (): Promise<void> => {
      if (cancelled) return;
      catchUpInFlight = true;
      // Note: we don't abort `catchUpAbort` here because `scheduleCatchUp`
      // already guarantees runCatchUp isn't invoked while a previous fetch
      // is in flight (the in-flight check returns early). The controller
      // is created fresh per run; cleanup aborts whatever's active.
      catchUpAbort = new AbortController();
      try {
        const page = await activeAdapter.fetchHistory(taskId, {
          limit: 20,
          signal: catchUpAbort.signal,
        });
        if (cancelled) return;
        for (const m of page.messages) {
          if (!m.id) continue;
          dispatch({ type: 'APPEND_MESSAGE', message: m });
        }
      } catch (err) {
        // Aborts come back two ways: raw `AbortError` from fetch itself, or
        // a `ConductorAppError { code: 'stream_aborted' }` if the adapter
        // wraps it (the default REST adapter does). Treat both as silent.
        const name = (err as { name?: string } | null)?.name;
        const code = (err as { code?: string } | null)?.code;
        if (name === 'AbortError' || code === 'stream_aborted') return;
        // eslint-disable-next-line no-console
        console.warn('[app-sdk] history catch-up failed', err);
      } finally {
        catchUpInFlight = false;
        if (needAnotherCatchUp && !cancelled) {
          needAnotherCatchUp = false;
          void runCatchUp();
        }
      }
    };

    const scheduleCatchUp = (delayMs: number): void => {
      if (cancelled) return;
      // Coalesce: if a catch-up is already in flight, mark that we should run
      // one more pass when it completes. This collapses bursty terminal
      // events (e.g. runtime_status flips immediately followed by
      // task_finished) into at most one extra round-trip.
      if (catchUpInFlight) {
        needAnotherCatchUp = true;
        return;
      }
      if (catchUpTimer) clearTimeout(catchUpTimer);
      catchUpTimer = setTimeout(() => {
        catchUpTimer = null;
        void runCatchUp();
      }, delayMs);
    };

    dispatch({ type: 'LOADING_HISTORY', loading: true });
    activeAdapter
      .fetchHistory(taskId, { signal: abort.signal })
      .then((page) => {
        if (cancelled) return;
        dispatch({
          type: 'HYDRATE_HISTORY',
          messages: page.messages,
          hasMoreBefore: page.hasMoreBefore,
          oldestMessageId: page.oldestMessageId,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        onErrorRef.current?.(err);
        dispatch({
          type: 'SET_ERROR',
          error: extractError(err),
        });
      })
      .finally(() => {
        if (!cancelled) dispatch({ type: 'LOADING_HISTORY', loading: false });
      });

    const sub = activeAdapter.subscribe(taskId, (event: ChatEvent) => {
      if (cancelled) return;
      switch (event.type) {
        case 'message_appended':
          dispatch({ type: 'APPEND_MESSAGE', message: event.message });
          break;
        case 'message_updated':
          dispatch({ type: 'UPDATE_MESSAGE', message: event.message });
          break;
        case 'runtime_status': {
          dispatch({ type: 'SET_RUNTIME', status: event.status });
          // Reply just ended? Backfill in case the final assistant message
          // envelope was lost in the realtime path. Delay 500ms so the
          // server has time to commit + project the row before we read it.
          const now = event.status.replyInProgress;
          if (prevReplyInProgress === true && now === false) {
            scheduleCatchUp(500);
          }
          prevReplyInProgress = now;
          break;
        }
        case 'task_finished':
          dispatch({ type: 'TASK_FINISHED' });
          scheduleCatchUp(500);
          break;
        case 'task_failed': {
          // Preserve the full ChatEventError payload so host UIs can surface
          // server-side details / request IDs / the original cause. The
          // Round 2 M9 work added these fields to ChatEventError; this is
          // the consumer-side hand-off into the React store.
          const taskErr: ChatError = {
            code: event.error.code,
            message: event.error.message,
          };
          if (event.error.details !== undefined) taskErr.details = event.error.details;
          if (event.error.cause !== undefined) taskErr.cause = event.error.cause;
          // requestId is not part of ChatEventError today, but if a producer
          // ever stashes it inside details (e.g. `{ requestId, ... }`), we
          // still don't promote it implicitly — that would conflict with
          // intentional shape choices on the producer side. Hosts that need
          // it read it from `error.details`.
          dispatch({ type: 'TASK_FAILED', error: taskErr });
          // Some `task_failed` events are synthetic — emitted by the SDK
          // when the WS closes — and the actual last assistant message may
          // still be persisted server-side. Run a catch-up so the user
          // doesn't lose it.
          scheduleCatchUp(500);
          break;
        }
        case 'connection_state': {
          dispatch({ type: 'SET_CONNECTION', state: event.state });
          // After a transient WS drop, the broadcast we missed during the
          // reconnect window is gone forever (Conductor's /ws/app does not
          // replay). Backfill immediately on `reconnecting → connected`.
          if (
            event.state === 'connected' &&
            prevConnectionState === 'reconnecting'
          ) {
            scheduleCatchUp(0);
          }
          prevConnectionState = event.state;
          break;
        }
      }
    });

    return () => {
      cancelled = true;
      abort.abort();
      sub.unsubscribe();
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
        catchUpTimer = null;
      }
      catchUpAbort?.abort();
    };
  }, [taskId]);

  const value = useMemo<ChatContextValue>(() => {
    const send = async (content: string, opts?: { metadata?: Record<string, unknown> }) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const clientRequestId = generateRequestId();
      const optimistic: Message = {
        id: `pending:${clientRequestId}`,
        taskId: taskIdRef.current,
        // The widget represents a real human typing — always 'user'. This
        // matters for routing on the backend: the daemon's message router
        // only forwards `task_user_message` envelopes to the AI fire process
        // (see conductor-sdk's message/router.ts). A message persisted with
        // role='sdk' would silently get ignored by codex/claude, leaving
        // the user wondering why their question never got a reply.
        role: 'user',
        content: trimmed,
        metadata: opts?.metadata ?? null,
        attachments: [],
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'OPTIMISTIC_SEND', message: optimistic, clientRequestId });
      try {
        const payload: SendMessageInput = {
          content: trimmed,
          clientRequestId,
          role: 'user',
          ...(opts?.metadata ? { metadata: opts.metadata } : {}),
        };
        const server = await adapterRef.current.sendMessage(taskIdRef.current, payload);
        dispatch({ type: 'CONFIRM_SEND', clientRequestId, serverMessage: server });
      } catch (err) {
        dispatch({ type: 'ROLLBACK_SEND', clientRequestId });
        onErrorRef.current?.(err);
        dispatch({ type: 'SET_ERROR', error: extractError(err) });
      }
    };

    const interrupt = async () => {
      // `targetReplyTo` is captured at memo time from `state.runtime.replyTo`
      // / `state.latestReplyId`. Between the user pressing the button and
      // the click handler firing, the backend may have advanced to a new
      // reply — making this id slightly stale. Backend responds with 404 on
      // a stale target (no-op from the user's perspective), so there's no
      // correctness issue; this is called out for awareness only. If we
      // wanted to chase the freshest id we'd switch to a ref + read at click
      // time, but the 404 path is benign and avoids an extra ref.
      const targetReplyTo = state.runtime?.replyTo ?? state.latestReplyId;
      if (!targetReplyTo) return;
      try {
        await adapterRef.current.interrupt(taskIdRef.current, { targetReplyTo });
      } catch (err) {
        onErrorRef.current?.(err);
        dispatch({ type: 'SET_ERROR', error: extractError(err) });
      }
    };

    const loadEarlier = async () => {
      if (!state.hasMoreBefore || state.loadingHistory) return;
      dispatch({ type: 'LOADING_HISTORY', loading: true });
      try {
        const page = await adapterRef.current.fetchHistory(taskIdRef.current, {
          beforeId: state.oldestMessageId ?? undefined,
        });
        dispatch({
          type: 'PREPEND_HISTORY',
          messages: page.messages,
          hasMoreBefore: page.hasMoreBefore,
          oldestMessageId: page.oldestMessageId,
        });
      } catch (err) {
        onErrorRef.current?.(err);
        dispatch({ type: 'SET_ERROR', error: extractError(err) });
      } finally {
        dispatch({ type: 'LOADING_HISTORY', loading: false });
      }
    };

    const restart = async (opts?: { restartMode?: string }) => {
      const fn = adapterRef.current.restart;
      if (!fn) return;
      try {
        await fn(taskIdRef.current, opts);
      } catch (err) {
        onErrorRef.current?.(err);
        dispatch({ type: 'SET_ERROR', error: extractError(err) });
      }
    };

    return {
      state,
      taskId,
      adapter,
      send,
      interrupt,
      loadEarlier,
      restart,
      // `adapter` is in the dep array, so this re-derives whenever the adapter
      // reference changes (the next subscribe also picks up the change).
      restartSupported: typeof adapter.restart === 'function',
    };
    // Include `taskId` and `adapter` so consumers reading `useChat().taskId`
    // see the updated value after a prop change.
  }, [state, taskId, adapter]);

  return <ChatContext.Provider value={value}>{props.children}</ChatContext.Provider>;
}

function extractError(err: unknown): ChatError {
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    const code = String(obj.code ?? 'unknown_error');
    const message = String(obj.message ?? 'Unknown error');
    const status = typeof obj.status === 'number' ? obj.status : undefined;
    const requestId = typeof obj.requestId === 'string' ? obj.requestId : undefined;
    const details = obj.details ?? undefined;
    return {
      code,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
  return { code: 'unknown_error', message: String(err) };
}
