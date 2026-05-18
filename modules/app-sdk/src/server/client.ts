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
   */
  subscribe(taskId: string, opts?: { signal?: AbortSignal; bufferCap?: number }): AsyncIterable<ChatEvent> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.subscribe requires a taskId',
      });
    }
    this.assertOpen();
    const socket = this.getSocket();
    const inner = subscribeToTask(socket, taskId, opts);
    // Surface connect() failures into the iterator instead of silently
    // swallowing them. We wrap the inner iterable so the first thing the
    // caller awaits is the connect promise — on failure we yield a
    // synthetic `task_failed` and end the stream.
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
        const innerIter = inner[Symbol.asyncIterator]();
        const connectPromise = socket.connect().then(
          () => null,
          (err) => err as unknown,
        );
        let connectChecked = false;
        return {
          async next(): Promise<IteratorResult<ChatEvent>> {
            if (!connectChecked) {
              connectChecked = true;
              const err = await connectPromise;
              if (err) {
                // Tear down the inner subscription so we don't leak listeners.
                try {
                  await innerIter.return?.();
                } catch {
                  /* ignore */
                }
                const event: ChatEvent = {
                  type: 'task_failed',
                  taskId,
                  error: errorToChatError(err, 'subscribe_failed'),
                };
                return { value: event, done: false };
              }
            }
            return innerIter.next();
          },
          async return(): Promise<IteratorResult<ChatEvent>> {
            return (await innerIter.return?.()) ?? { value: undefined as never, done: true };
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
