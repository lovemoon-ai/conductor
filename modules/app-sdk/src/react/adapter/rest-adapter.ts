/**
 * createRestAdapter: default `ChatAdapter` that talks to a host BFF exposing
 * Conductor-shaped REST endpoints + an SSE event stream.
 *
 * Expected BFF surface (all relative to `baseUrl`, all returning JSON):
 *
 *   GET  /tasks/:taskId/messages?pagination=1&limit=N&before_id=...
 *        → { messages, pagination: { has_more_before, oldest_message_id } }
 *   POST /tasks/:taskId/messages
 *        body: { content, role?, clientRequestId?, metadata? }
 *        → Message
 *   POST /tasks/:taskId/interrupt
 *        body: { target_reply_to }
 *        → 200
 *   POST /tasks/:taskId/restart           (optional)
 *        body: { restart_mode? }
 *        → 200
 *   GET  /tasks/:taskId/events
 *        → text/event-stream emitting `data: <ChatEvent JSON>\n\n`
 *
 * Auth: optionally a Bearer token via `authToken` (string or async fn) sent
 * on REST calls. Cookies are honored by default via `credentials: 'include'`
 * (configurable). EventSource doesn't support custom headers in the
 * standard browser API — for token-based SSE auth, hosts should put the
 * token in the URL or rely on cookies.
 */
import type { ChatAdapter } from '../../types/adapter.js';
import { ConductorAppError } from '../../types/errors.js';
import { mapHttpStatusToErrorCode } from '../../types/error-codes.js';
import type { ChatEvent } from '../../types/events.js';
import type { Message, SendMessageInput } from '../../types/message.js';

export interface RestAdapterOptions {
  /** BFF base URL (relative or absolute), e.g. `/api/conductor`. */
  baseUrl: string;
  /** Bearer token (string or async provider). Optional — omit for cookie-based auth. */
  authToken?: string | (() => Promise<string>);
  /**
   * Whether to send credentials (cookies) for REST + SSE. Defaults to
   * 'include' (assume same-origin BFF or CORS configured to allow creds).
   */
  credentials?: RequestCredentials;
  /** Override fetch (SSR, testing). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Override EventSource constructor. Lets hosts inject `eventsource` polyfill
   * for environments without native EventSource (Node-side rendering).
   * Defaults to `globalThis.EventSource`.
   */
  eventSource?: typeof globalThis.EventSource;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /**
   * Enable the optional `restart()` adapter method. Default `false`.
   *
   * When enabled, `<ChatView>` shows restart affordances (empty-state button +
   * bubble action). You MUST then implement `POST {baseUrl}/tasks/:id/restart`
   * on your BFF (forward to Conductor's `POST /api/tasks/:id/restart`, or call
   * `client.tasks.restart()`), or the control will 404. Left `false`, the
   * widget hides all restart UI.
   */
  enableRestart?: boolean;
}

export function createRestAdapter(options: RestAdapterOptions): ChatAdapter {
  if (!options.baseUrl) {
    throw new ConductorAppError({
      code: 'invalid_input',
      message: 'createRestAdapter requires baseUrl',
    });
  }
  const fetchImpl =
    options.fetch ?? (globalThis.fetch as typeof globalThis.fetch);
  const EventSourceCtor =
    options.eventSource ??
    (typeof globalThis !== 'undefined'
      ? (globalThis as { EventSource?: typeof EventSource }).EventSource
      : undefined);
  const credentials = options.credentials ?? 'include';
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function resolveAuth(): Promise<string | null> {
    const t = options.authToken;
    if (!t) return null;
    if (typeof t === 'string') return t;
    return await t();
  }

  async function buildHeaders(
    init: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const auth = await resolveAuth();
    return {
      Accept: 'application/json',
      ...init,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    };
  }

  async function jsonFetch<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; signal?: AbortSignal; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = buildUrl(baseUrl, path, init.query);
    const headers = await buildHeaders(
      init.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    );
    const composed = composeAbortSignals(init.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        credentials,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: composed.signal,
      });
    } catch (cause) {
      composed.dispose();
      if ((cause as { name?: string })?.name === 'AbortError') {
        throw new ConductorAppError({
          code: composed.timedOut ? 'timeout' : 'stream_aborted',
          message: composed.timedOut
            ? `Request timed out after ${timeoutMs}ms`
            : 'Request aborted',
          cause,
        });
      }
      throw new ConductorAppError({
        code: 'network_error',
        message: `Network error: ${(cause as Error)?.message ?? String(cause)}`,
        cause,
      });
    }
    composed.dispose();
    if (!res.ok) {
      const detail = await safeJson(res);
      const message =
        detail && typeof detail === 'object' && 'error' in detail
          ? String((detail as { error: unknown }).error)
          : null;
      throw new ConductorAppError({
        code: mapHttpStatusToErrorCode(res.status, detail, message),
        status: res.status,
        message: message ?? `${method} ${path} failed with ${res.status}`,
        details: detail,
      });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  const adapter: ChatAdapter = {
    async fetchHistory(taskId, opts) {
      if (!taskId) {
        throw new ConductorAppError({
          code: 'invalid_input',
          message: 'fetchHistory requires a taskId',
        });
      }
      const body = await jsonFetch<{
        messages: Message[];
        pagination?: { has_more_before?: boolean; oldest_message_id?: string | null };
      }>('GET', `/tasks/${encodeURIComponent(taskId)}/messages`, {
        signal: opts?.signal,
        query: {
          pagination: '1',
          ...(opts?.beforeId ? { before_id: opts.beforeId } : {}),
          ...(opts?.limit ? { limit: opts.limit } : {}),
        },
      });
      return {
        messages: body?.messages ?? [],
        hasMoreBefore: Boolean(body?.pagination?.has_more_before),
        oldestMessageId: body?.pagination?.oldest_message_id ?? null,
      };
    },

    subscribe(taskId, handler) {
      if (!taskId) {
        throw new ConductorAppError({
          code: 'invalid_input',
          message: 'subscribe requires a taskId',
        });
      }
      if (!EventSourceCtor) {
        throw new ConductorAppError({
          code: 'subscribe_failed',
          message:
            'No EventSource available. Either run in a browser or pass eventSource via createRestAdapter options.',
        });
      }
      const url = buildUrl(baseUrl, `/tasks/${encodeURIComponent(taskId)}/events`);
      const es = new EventSourceCtor(url, { withCredentials: credentials === 'include' });
      let closed = false;

      const emit = (state: 'connected' | 'reconnecting' | 'offline') => {
        try {
          handler({ type: 'connection_state', state });
        } catch {
          /* swallow */
        }
      };

      const onOpen = () => emit('connected');
      const onMessage = (e: MessageEvent) => {
        if (closed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          try {
            handler(parsed as ChatEvent);
          } catch {
            /* swallow */
          }
        }
      };
      const onError = () => {
        if (closed) return;
        emit('reconnecting');
      };

      es.addEventListener('open', onOpen as EventListener);
      es.addEventListener('message', onMessage as EventListener);
      es.addEventListener('error', onError as EventListener);

      return {
        unsubscribe() {
          if (closed) return;
          closed = true;
          es.removeEventListener('open', onOpen as EventListener);
          es.removeEventListener('message', onMessage as EventListener);
          es.removeEventListener('error', onError as EventListener);
          es.close();
        },
      };
    },

    async sendMessage(taskId, input: SendMessageInput) {
      if (!taskId) {
        throw new ConductorAppError({
          code: 'invalid_input',
          message: 'sendMessage requires a taskId',
        });
      }
      const body = await jsonFetch<Message>(
        'POST',
        `/tasks/${encodeURIComponent(taskId)}/messages`,
        {
          body: {
            content: input.content,
            ...(input.role ? { role: input.role } : {}),
            ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        },
      );
      return body;
    },

    async interrupt(taskId, opts) {
      if (!taskId) {
        throw new ConductorAppError({
          code: 'invalid_input',
          message: 'interrupt requires a taskId',
        });
      }
      await jsonFetch<void>(
        'POST',
        `/tasks/${encodeURIComponent(taskId)}/interrupt`,
        { body: { target_reply_to: opts.targetReplyTo } },
      );
    },
  };

  // Restart is opt-in: only expose it when the host has wired the BFF route.
  // Exposing it unconditionally would make `<ChatView>` show restart UI that
  // 404s against a BFF that only implements the four core routes.
  if (options.enableRestart) {
    adapter.restart = async (taskId, opts) => {
      if (!taskId) {
        throw new ConductorAppError({
          code: 'invalid_input',
          message: 'restart requires a taskId',
        });
      }
      const restartMode = opts?.restartMode?.trim();
      await jsonFetch<void>(
        'POST',
        `/tasks/${encodeURIComponent(taskId)}/restart`,
        { body: restartMode ? { restart_mode: restartMode } : {} },
      );
    };
  }

  return adapter;
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  let url = `${base}${cleanPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const s = params.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Status-to-error-code mapping lives in `src/types/error-codes.ts` — see
// the shared `mapHttpStatusToErrorCode` for precedence rules at 404 / 409.
// Both this BFF-side adapter and the direct-to-Conductor /server fetcher
// see the same `{ error: "..." }` body shape, so the same logic applies.

function composeAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; readonly timedOut: boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  const onExternal = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternal);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternal);
    },
    get timedOut() {
      return timedOut;
    },
  };
}
