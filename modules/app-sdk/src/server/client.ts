/**
 * AppClient + connect(): top-level handle for talking to Conductor.
 *
 * Owns:
 *   - one `Fetcher` (auth, timeout, errors)
 *   - lazy one `AppWebSocket` (created on first `tasks.subscribe()` /
 *     `tasks.streamReply()`)
 *   - `projects` + `tasks` sub-APIs.
 *
 * Lifecycle: callers should `await client.close()` on shutdown to release
 * the WS connection cleanly. Forgetting to close leaks a TCP socket but
 * doesn't lose data.
 */
import { ConductorAppError } from '../types/errors.js';
import type {
  CreateTaskInput,
  Task,
} from '../types/task.js';
import type { BindProjectInput, Project } from '../types/project.js';
import type {
  Message,
  SendMessageInput,
} from '../types/message.js';
import type { ChatEvent, StreamReplyDelta } from '../types/events.js';
import { Fetcher } from './fetcher.js';
import { ProjectsApi } from './http/projects.js';
import { TasksRestApi } from './http/tasks.js';
import { AppWebSocket } from './ws/socket.js';
import { subscribeToTask } from './tasks/subscribe.js';
import { streamReplyForTask } from './tasks/stream-reply.js';

// History catch-up tunables (used by TasksApi.subscribe):
//   CATCH_UP_DELAY_MS — gives Conductor's projector + DB write time to settle
//     before we re-read history after a terminal envelope, so the catch-up
//     doesn't race a still-in-flight commit and pull a stale page.
//   CATCH_UP_LIMIT  — window size for each catch-up pull. Matches the React
//     provider's choice; covers the largest realistic single-reply blast
//     (Fire occasionally emits several assistant turns in a row).
// Hoisted to module scope so both the value and the trade-off are documented
// in one place, and so each `subscribe()` call doesn't re-allocate them.
const CATCH_UP_DELAY_MS = 500;
const CATCH_UP_LIMIT = 20;

export interface ConnectOptions {
  /** Conductor backend URL, e.g. `https://conductor.example.com`. */
  baseUrl: string;
  /**
   * Bearer token issued from Conductor Settings → API Tokens.
   * Accepts a string or an async provider (for token rotation / vault lookup).
   */
  bearerToken: string | (() => Promise<string>);
  /** Custom fetch (SSR, testing). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Called once when any request returns 401. */
  onUnauthorized?: () => void;
  /**
   * Lazy: do not open the /ws/app connection until the first subscribe/stream
   * call. Default `true`. Set to `false` to eagerly connect at `connect()`.
   */
  lazyWebSocket?: boolean;
  /**
   * Inject a custom WebSocket constructor (used by tests).
   * Type widened to `unknown` to avoid forcing consumers to depend on the
   * specific `ws` types.
   */
  webSocketImpl?: unknown;
}

export type AppClientOptions = ConnectOptions;

export class AppClient {
  readonly projects: ProjectsApi;
  readonly tasks: TasksApi;

  private readonly _fetcher: Fetcher;
  private _socket: AppWebSocket | null = null;
  private _closed = false;

  private readonly options: AppClientOptions;

  constructor(options: AppClientOptions) {
    validateOptions(options);
    this.options = options;
    this._fetcher = new Fetcher({
      baseUrl: options.baseUrl,
      bearerToken: options.bearerToken,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      onUnauthorized: options.onUnauthorized,
    });
    this.projects = new ProjectsApi(this._fetcher);
    const rest = new TasksRestApi(this._fetcher);
    this.tasks = new TasksApi(
      rest,
      () => this.getOrCreateSocket(),
      () => this._closed,
    );
  }

  /**
   * Release the WS connection and mark the client closed. Idempotent —
   * calling twice is a no-op rather than a NPE. After close, any new
   * `tasks.subscribe()` / `tasks.streamReply()` / `tasks.*` REST call
   * throws synchronously instead of returning a hanging iterator.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
  }

  private getOrCreateSocket(): AppWebSocket {
    if (this._socket) return this._socket;
    this._socket = new AppWebSocket({
      baseUrl: this.options.baseUrl,
      bearerToken: this.options.bearerToken,
      webSocketImpl: this.options.webSocketImpl as never,
    });
    return this._socket;
  }
}

/**
 * `connect()`: thin async wrapper around the constructor. In v0.1 it's
 * synchronous-ish (no remote probe); kept async for forward compatibility
 * (v0.2 may probe `/api/auth/me` for early-failure semantics).
 */
export async function connect(options: ConnectOptions): Promise<AppClient> {
  return new AppClient(options);
}

// -------------------------------------------------------------------------
// Public TasksApi facade: composes the REST half (`TasksRestApi`) with the
// WS half (`subscribe` / `streamReply`). Keeps a single ergonomic surface
// without forcing callers to know about REST vs WS plumbing.
// -------------------------------------------------------------------------

export class TasksApi {
  /** @internal — constructed by `AppClient`; not part of the public surface. */
  constructor(
    private readonly rest: TasksRestApi,
    private readonly getSocket: () => AppWebSocket,
    private readonly isClosed: () => boolean = () => false,
  ) {}

  private assertOpen(): void {
    if (this.isClosed()) {
      throw new ConductorAppError({
        code: 'subscribe_failed',
        message: 'client is closed',
      });
    }
  }

  create(input: CreateTaskInput, opts?: { signal?: AbortSignal }): Promise<Task> {
    this.assertOpen();
    return this.rest.create(input, opts);
  }

  get(taskId: string, opts?: { signal?: AbortSignal }): Promise<Task> {
    this.assertOpen();
    return this.rest.get(taskId, opts);
  }

  list(
    filter?: { projectId?: string; status?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<Task[]> {
    this.assertOpen();
    return this.rest.list(filter, opts);
  }

  sendMessage(
    taskId: string,
    input: string | SendMessageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Message> {
    this.assertOpen();
    return this.rest.sendMessage(taskId, input, opts);
  }

  history(
    taskId: string,
    paging?: { beforeId?: string; limit?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<{
    messages: Message[];
    hasMoreBefore: boolean;
    oldestMessageId: string | null;
  }> {
    this.assertOpen();
    return this.rest.history(taskId, paging, opts);
  }

  interrupt(
    taskId: string,
    opts: { targetReplyTo: string; signal?: AbortSignal },
  ): Promise<void> {
    this.assertOpen();
    return this.rest.interrupt(taskId, opts);
  }

  /**
   * Subscribe to a task's event stream. Yields ChatEvents until the caller
   * breaks out of the `for await` loop, calls `signal.abort()`, or the
   * client is closed.
   *
   * The first call lazily opens a /ws/app connection; subsequent calls share
   * the same connection.
   *
   * History catch-up (enabled by default): when a terminal event arrives
   * (`task_finished`, `task_failed`, `runtime_status` flipping
   * `replyInProgress` true→false, or `connection_state` recovering from
   * `reconnecting → connected`), the wrapper pulls a window of recent
   * history via REST and injects any missing entries as synthetic
   * `message_appended` events. This compensates for Conductor deployments
   * where the realtime broadcast doesn't always reach the WS connection
   * (multi-instance fan-out without a backplane, idempotent commit retries
   * that bypass projection, momentary WS drops). Disable with
   * `disableHistoryCatchUp: true` for callers that prefer the raw stream.
   */
  subscribe(
    taskId: string,
    opts?: {
      signal?: AbortSignal;
      bufferCap?: number;
      /**
       * Disable the post-terminal history catch-up. Default: catch-up
       * enabled. Set to `true` to receive only events that traveled the
       * realtime path (no synthetic `message_appended` injected from
       * REST).
       */
      disableHistoryCatchUp?: boolean;
    },
  ): AsyncIterable<ChatEvent> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.subscribe requires a taskId',
      });
    }
    this.assertOpen();
    const socket = this.getSocket();
    const rest = this.rest;
    const inner = subscribeToTask(socket, taskId, opts);
    const catchUpEnabled = opts?.disableHistoryCatchUp !== true;

    return {
      // Each `for await` consumer gets its own iterator with its own queue,
      // pump task, knownIds set, and catch-up state. Multiple concurrent
      // iterations over the same returned AsyncIterable do not share state
      // beyond the underlying socket (which is shared by design).
      [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
        const innerIter = inner[Symbol.asyncIterator]();

        // Single unified event queue. Both the inner pump and the catch-up
        // task push into it; the public `next()` pulls from it. This gives
        // us a single source of truth and lets synthetic catch-up events
        // wake a parked consumer immediately (rather than waiting for the
        // next real envelope to arrive — which, after `task_finished`,
        // never does).
        const queue: ChatEvent[] = [];
        let pendingResolve:
          | ((r: IteratorResult<ChatEvent>) => void)
          | null = null;
        let upstreamDone = false;
        let consumerReturned = false;

        // Catch-up state — owned by this iterator instance.
        const knownIds = new Set<string>();
        let prevReplyInProgress: boolean | undefined;
        let prevConnectionState:
          | 'connected'
          | 'reconnecting'
          | 'offline'
          | undefined;
        let catchUpInFlight = 0;
        let needAnotherCatchUp = false;
        // The AbortController owned by the currently-running catch-up fetch
        // (if any). Reset to null when the fetch returns. `return()` aborts
        // it so the in-flight HTTP request — and any underlying socket —
        // releases promptly instead of running to completion only to have
        // its result discarded by the `consumerReturned` check.
        let activeCatchUpAbort: AbortController | null = null;

        const wakePending = (r: IteratorResult<ChatEvent>): void => {
          const resolver = pendingResolve;
          pendingResolve = null;
          resolver?.(r);
        };

        const drain = (): void => {
          if (!pendingResolve) return;
          if (queue.length > 0) {
            wakePending({ value: queue.shift()!, done: false });
            return;
          }
          // Only declare the stream finished once upstream is done AND no
          // catch-up is still in flight — otherwise a late-arriving
          // history page would have nowhere to land.
          if (upstreamDone && catchUpInFlight === 0) {
            wakePending({ value: undefined as never, done: true });
          }
        };

        const enqueue = (ev: ChatEvent): void => {
          if (consumerReturned) return;
          queue.push(ev);
          drain();
        };

        const triggerCatchUp = (delayMs: number): void => {
          if (consumerReturned || !catchUpEnabled) return;
          // Cap concurrency to one in-flight catch-up. If another trigger
          // fires while one is running, set a flag; the in-flight task
          // will spawn one more pass on completion. This collapses bursty
          // terminal events (e.g. runtime_status `replyInProgress=false`
          // followed by `task_finished`) into at most one extra round-trip.
          if (catchUpInFlight > 0) {
            needAnotherCatchUp = true;
            return;
          }
          catchUpInFlight += 1;
          const abort = new AbortController();
          activeCatchUpAbort = abort;
          void (async () => {
            try {
              if (delayMs > 0) {
                await new Promise((r) => setTimeout(r, delayMs));
              }
              if (consumerReturned || abort.signal.aborted) return;
              const page = await rest.history(
                taskId,
                { limit: CATCH_UP_LIMIT },
                { signal: abort.signal },
              );
              if (consumerReturned || abort.signal.aborted) return;
              for (const m of page.messages) {
                if (!m.id) continue;
                if (knownIds.has(m.id)) continue;
                knownIds.add(m.id);
                enqueue({ type: 'message_appended', message: m });
              }
            } catch (err) {
              // Aborted fetches are expected on consumer return — silent.
              // The Fetcher wraps native AbortError into ConductorAppError
              // with code 'stream_aborted', so we check both shapes.
              const name = (err as { name?: string } | null)?.name;
              const code = (err as { code?: string } | null)?.code;
              if (name === 'AbortError' || code === 'stream_aborted') return;
              // Catch-up is best-effort — a transient REST failure must
              // never poison the live stream. Surface as a warning so
              // integrators investigating "AI replies don't show up"
              // notice the upstream issue without losing the subscription.
              // eslint-disable-next-line no-console
              console.warn('[app-sdk] subscribe history catch-up failed', err);
            } finally {
              if (activeCatchUpAbort === abort) {
                activeCatchUpAbort = null;
              }
              catchUpInFlight -= 1;
              // Re-run once if another trigger fired while we were busy.
              if (needAnotherCatchUp && !consumerReturned) {
                needAnotherCatchUp = false;
                triggerCatchUp(0);
              }
              // Always drain — if upstream finished while we were in
              // flight, this is the call that lets the consumer see done.
              drain();
            }
          })();
        };

        // Pump: drives the inner iterator into the unified queue. Lives for
        // the lifetime of this iterator instance. Started lazily on the
        // first `next()` to preserve the original "do nothing until iterated"
        // contract — a consumer that creates an iterator but never pulls
        // (rare but legal) won't eagerly consume socket envelopes or open
        // the WS connection.
        let pumpStarted = false;
        const startPump = (): void => {
          if (pumpStarted) return;
          pumpStarted = true;
          const connectPromise = socket.connect().then(
            () => null,
            (err) => err as unknown,
          );
          void (async () => {
            try {
              const err = await connectPromise;
              if (err) {
                // Initial connect failed. Tear the inner iter down so its
                // listeners on the socket don't leak, surface a synthetic
                // task_failed, then close cleanly.
                try {
                  await innerIter.return?.();
                } catch {
                  /* ignore */
                }
                enqueue({
                  type: 'task_failed',
                  taskId,
                  error: errorToChatError(err, 'subscribe_failed'),
                });
                upstreamDone = true;
                drain();
                return;
              }
              while (!consumerReturned) {
                const r = await innerIter.next();
                if (r.done) {
                  upstreamDone = true;
                  drain();
                  return;
                }
                const ev = r.value;
                // Inspect each event for catch-up triggers BEFORE enqueueing
                // it. We let the real event pass through unchanged; the
                // catch-up's synthetic message_appended events will follow
                // it (and the reducer/consumer's id-keyed dedup makes any
                // overlap with a real-time message harmless).
                if (catchUpEnabled) {
                  if (ev.type === 'message_appended') {
                    if (ev.message.id) knownIds.add(ev.message.id);
                  } else if (
                    ev.type === 'task_finished' ||
                    ev.type === 'task_failed'
                  ) {
                    triggerCatchUp(CATCH_UP_DELAY_MS);
                  } else if (ev.type === 'runtime_status') {
                    const now = ev.status.replyInProgress;
                    if (prevReplyInProgress === true && now === false) {
                      triggerCatchUp(CATCH_UP_DELAY_MS);
                    }
                    prevReplyInProgress = now;
                  } else if (ev.type === 'connection_state') {
                    if (
                      ev.state === 'connected' &&
                      prevConnectionState === 'reconnecting'
                    ) {
                      // Reconnect catch-up has no projector race to wait on
                      // — the missed envelope was already persisted upstream.
                      // Fire immediately.
                      triggerCatchUp(0);
                    }
                    prevConnectionState = ev.state;
                  }
                }
                enqueue(ev);
              }
            } catch (err) {
              // The inner iterator's contract is to not throw, but be
              // defensive — a producer bug here must not crash the host.
              if (!consumerReturned) {
                enqueue({
                  type: 'task_failed',
                  taskId,
                  error: errorToChatError(err, 'subscribe_failed'),
                });
                upstreamDone = true;
                drain();
              }
            }
          })();
        };

        return {
          async next(): Promise<IteratorResult<ChatEvent>> {
            if (consumerReturned) {
              return { value: undefined as never, done: true };
            }
            // Lazy: the pump (and the WS connect it triggers) only starts
            // once a consumer actually pulls.
            startPump();
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (upstreamDone && catchUpInFlight === 0) {
              return { value: undefined as never, done: true };
            }
            return new Promise<IteratorResult<ChatEvent>>((resolve) => {
              pendingResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<ChatEvent>> {
            consumerReturned = true;
            // Abort any in-flight catch-up fetch so its HTTP request
            // releases now rather than running to completion only to have
            // its result discarded.
            activeCatchUpAbort?.abort();
            activeCatchUpAbort = null;
            try {
              await innerIter.return?.();
            } catch {
              /* ignore */
            }
            // Unblock anyone parked in next() so the for-await loop exits
            // promptly instead of waiting for the next event that will
            // never come.
            if (pendingResolve) {
              wakePending({ value: undefined as never, done: true });
            }
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  /**
   * Higher-level convenience: yield only AI reply deltas. Internally consumes
   * `subscribe()` and selects runtime_status preview chunks + the final
   * assistant message.
   */
  streamReply(
    taskId: string,
    opts?: { signal?: AbortSignal; emitInitialPreview?: boolean; idleTimeoutMs?: number },
  ): AsyncIterable<StreamReplyDelta> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.streamReply requires a taskId',
      });
    }
    this.assertOpen();
    const socket = this.getSocket();
    const inner = streamReplyForTask(socket, taskId, opts);
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamReplyDelta> {
        const innerIter = inner[Symbol.asyncIterator]();
        const connectPromise = socket.connect().then(
          () => null,
          (err) => err as unknown,
        );
        let connectChecked = false;
        return {
          async next(): Promise<IteratorResult<StreamReplyDelta>> {
            if (!connectChecked) {
              connectChecked = true;
              const err = await connectPromise;
              if (err) {
                try {
                  await innerIter.return?.();
                } catch {
                  /* ignore */
                }
                const delta: StreamReplyDelta = {
                  type: 'error',
                  error: errorToChatError(err, 'stream_aborted'),
                };
                return { value: delta, done: false };
              }
            }
            return innerIter.next();
          },
          async return(): Promise<IteratorResult<StreamReplyDelta>> {
            return (await innerIter.return?.()) ?? { value: undefined as never, done: true };
          },
        };
      },
    };
  }
}

/**
 * Translate an arbitrary thrown error into a ChatEventError. Preserves
 * `details` and `cause` so host UIs can surface server payloads / request IDs
 * without depending on the SDK error class directly.
 *
 * `defaultCode` is the fallback for the `code` field when the underlying
 * error doesn't carry one. Callers in the subscribe path pass
 * `'subscribe_failed'`; callers in the streamReply path pass
 * `'stream_aborted'` — that pairing keeps the surfaced code semantically
 * meaningful even when the underlying error is something opaque like a
 * generic `Error`.
 */
function errorToChatError(
  err: unknown,
  defaultCode: string = 'subscribe_failed',
): { code: string; message: string; details?: unknown; cause?: unknown } {
  if (err && typeof err === 'object') {
    const code = String((err as { code?: unknown }).code ?? defaultCode);
    const message = String(
      (err as { message?: unknown }).message ?? 'WebSocket connection failed',
    );
    const detailsRaw = (err as { details?: unknown }).details;
    const result: { code: string; message: string; details?: unknown; cause?: unknown } = {
      code,
      message,
    };
    if (detailsRaw !== undefined) result.details = detailsRaw;
    // Carry the original error as `cause` when it's an Error instance — host
    // UIs / loggers that walk the cause chain can recover the stack trace.
    if (err instanceof Error) result.cause = err;
    return result;
  }
  return { code: defaultCode, message: String(err) };
}

function validateOptions(options: AppClientOptions): void {
  if (!options.baseUrl) {
    throw new ConductorAppError({
      code: 'invalid_input',
      message: 'connect(): baseUrl is required',
    });
  }
  if (!options.bearerToken) {
    throw new ConductorAppError({
      code: 'invalid_input',
      message: 'connect(): bearerToken is required',
    });
  }
}
