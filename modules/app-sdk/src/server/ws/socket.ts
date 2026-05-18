/**
 * AppWebSocket: thin client over Conductor's /ws/app endpoint.
 *
 * Responsibilities:
 *   - Open one user-scoped WebSocket connection per AppClient.
 *   - Carry the bearer token via `?token=...` query param (matches
 *     `app-gateway.ts` `extractToken()`).
 *   - Auto-reconnect with capped exponential backoff (250ms → 30s).
 *   - Fan-out raw envelopes to N subscribers (one per `tasks.subscribe()`).
 *
 * Not yet implemented (M1 OK to defer):
 *   - Server-side filtering. /ws/app currently broadcasts every event for the
 *     user; we filter by `taskId` in the subscribe layer.
 *   - SSE fallback for environments that block WS. Will live in /react's
 *     default REST adapter.
 */
import WebSocket, { type Event as WsEvent, type CloseEvent, type MessageEvent } from 'ws';
import { ConductorAppError } from '../../types/errors.js';

/** @internal */
export interface AppWebSocketOptions {
  baseUrl: string;
  bearerToken: string | (() => Promise<string>);
  /**
   * Maximum total reconnect attempts before surfacing an error. Default
   * `Infinity` — caller relies on `onError` / `close()` to bail out.
   */
  maxReconnects?: number;
  /** Initial backoff in ms. Default 250. */
  initialBackoffMs?: number;
  /** Backoff cap in ms. Default 30_000. */
  maxBackoffMs?: number;
  /** Inject a custom WebSocket constructor (used by tests). */
  webSocketImpl?: typeof WebSocket;
}

type RawListener = (envelope: unknown) => void;
type ConnStateListener = (
  state: 'connected' | 'reconnecting' | 'offline',
) => void;
type CloseListener = () => void;

/** @internal */
export class AppWebSocket {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rawListeners = new Set<RawListener>();
  private readonly stateListeners = new Set<ConnStateListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private currentState: 'connected' | 'reconnecting' | 'offline' = 'offline';
  /** Resolved when at least one connection has opened successfully. */
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejector: ((err: unknown) => void) | null = null;
  /** Tracks whether we've ever opened a connection — gates state replay. */
  private hasEverConnected = false;

  constructor(private readonly options: AppWebSocketOptions) {}

  onEnvelope(listener: RawListener): { unsubscribe(): void } {
    this.rawListeners.add(listener);
    return {
      unsubscribe: () => {
        this.rawListeners.delete(listener);
      },
    };
  }

  /**
   * Subscribe to the terminal "client closed" event. Fires exactly once when
   * `close()` is invoked (or zero times if the socket is GC'd without close).
   *
   * Iterators that have already passed `connect()` need this signal — the
   * regular `rawListeners` are cleared at close time, so the inner
   * `subscribeToTask` loop would otherwise wedge waiting on `next()`. Late
   * subscribers (after `close()` has run) get fired synchronously so they
   * can't miss the signal.
   *
   * Returns an unsubscribe callback. Idempotent.
   */
  onClose(listener: CloseListener): () => void {
    if (this.closed) {
      // Replay synchronously so a late subscriber doesn't wedge.
      try {
        listener();
      } catch {
        // isolated
      }
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onConnectionState(listener: ConnStateListener): { unsubscribe(): void } {
    // Replay the current state on subscribe so late joiners don't get stuck
    // waiting for the next transition. We skip only the pristine 'offline'
    // before any connection attempt has happened — a synthetic "you're
    // offline" before the first attempt is noise.
    //
    // Replay is SYNCHRONOUS (rather than queueMicrotask'd) so that the
    // replayed state cannot be reordered against subsequent real
    // transitions. If we deferred via microtask and the socket happened to
    // emit a 'reconnecting' event before the microtask drained, the listener
    // would see [reconnecting, connected] when reality was [connected,
    // reconnecting]. Synchronous replay before adding the listener
    // guarantees [<replay>, <next real transitions>...].
    if (this.hasEverConnected || this.currentState !== 'offline') {
      try {
        listener(this.currentState);
      } catch {
        // isolated — one bad subscriber shouldn't crash registration.
      }
    }
    this.stateListeners.add(listener);
    return {
      unsubscribe: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  /**
   * Open the connection (idempotent). Returns when the first OPEN event fires.
   *
   * The returned promise rejects only if the *initial* connection attempt
   * fails (e.g. the token provider throws). Once we've ever connected, the
   * promise resolves and subsequent disconnects are handled by the
   * auto-reconnect loop (visible via `onConnectionState`).
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new ConductorAppError({
        code: 'subscribe_failed',
        message: 'AppWebSocket was closed; create a new one.',
      });
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.readyPromise) return this.readyPromise;

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejector = reject;
    });
    // Attach a no-op catch so we never produce an unhandled rejection if the
    // caller awaits the outer `connect()` (which throws) without separately
    // observing this inner promise.
    readyPromise.catch(() => undefined);
    this.readyPromise = readyPromise;

    try {
      await this.openOnce();
    } catch (cause) {
      // Initial open failed (e.g. buildUrl rejected). Clear the
      // promise/state so the next caller can retry cleanly.
      const rejector = this.readyRejector;
      this.readyPromise = null;
      this.readyResolver = null;
      this.readyRejector = null;
      const error =
        cause instanceof ConductorAppError
          ? cause
          : new ConductorAppError({
              code: 'subscribe_failed',
              message: `Failed to open WebSocket: ${
                (cause as Error)?.message ?? String(cause)
              }`,
              cause,
            });
      if (rejector) rejector(error);
      throw error;
    }
    return readyPromise;
  }

  close(): void {
    // Idempotent. Calling close() twice is a normal shutdown pattern
    // (try/finally; double-cleanup in tests) — second call must no-op
    // rather than NPE on this.socket.close() or re-fire closeListeners.
    if (this.closed) return;
    // Capture the in-flight connect rejector BEFORE flipping `closed = true`.
    // After `closed = true`, our own `handleClose` early-returns and would
    // never call the rejector. Calling `this.socket.close()` synchronously
    // fires the 'close' event on some transports — by capturing first and
    // rejecting after cleanup, we guarantee a definitive failure to anyone
    // still awaiting `connect()`.
    const pendingRejector = this.readyRejector;
    // Snapshot close listeners before flipping `closed`. We have to fire
    // them AFTER cleanup so the iterator can observe a fully-quiesced
    // socket state, but we must capture them now because `closed = true`
    // makes future `onClose()` calls fire synchronously and we want the
    // current set to fire exactly once.
    const closeListenersSnapshot = Array.from(this.closeListeners);
    this.closed = true;
    this.rawListeners.clear();
    this.stateListeners.clear();
    this.closeListeners.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignored — closing during a bad state should not crash callers.
      }
    }
    this.socket = null;
    // Null out the ready-promise slots so a subsequent unexpected close
    // can't double-reject (the second reject would be a no-op on the
    // already-settled promise, but the field clear is the source of truth).
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejector = null;
    this.setState('offline');
    if (pendingRejector) {
      pendingRejector(
        new ConductorAppError({
          code: 'subscribe_failed',
          message: 'client closed before connect resolved',
        }),
      );
    }
    // Notify subscribe iterators that have already completed connect() —
    // their rawListener has been cleared, so without this signal they'd
    // park indefinitely on their next pull. Fired AFTER cleanup so the
    // listener observes the socket in its final closed state.
    for (const listener of closeListenersSnapshot) {
      try {
        listener();
      } catch {
        // isolated — one bad subscriber shouldn't crash shutdown.
      }
    }
  }

  private async openOnce(): Promise<void> {
    const url = await this.buildUrl();
    const Ctor = this.options.webSocketImpl ?? WebSocket;
    const socket = new Ctor(url);
    this.socket = socket;

    socket.addEventListener('open', this.handleOpen as (e: WsEvent) => void);
    socket.addEventListener('message', this.handleMessage as (e: MessageEvent) => void);
    socket.addEventListener('close', this.handleClose as (e: CloseEvent) => void);
    socket.addEventListener('error', this.handleError as (e: WsEvent) => void);
  }

  private readonly handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.hasEverConnected = true;
    this.setState('connected');
    if (this.readyResolver) {
      this.readyResolver();
      this.readyResolver = null;
      this.readyRejector = null;
    }
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    const data = event.data;
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof Buffer) {
      text = data.toString('utf8');
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else {
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    for (const listener of this.rawListeners) {
      try {
        listener(envelope);
      } catch {
        // listener errors are isolated — one bad subscriber shouldn't crash
        // the socket pump.
      }
    }
  };

  private readonly handleClose = (): void => {
    this.socket = null;
    if (this.closed) return;
    // If the socket closed before it ever opened (auth rejection, server
    // restart mid-handshake, etc.), the in-flight `connect()` would otherwise
    // hang forever — its readyPromise was never resolved or rejected. Reject
    // it explicitly so callers see a definitive failure before we null the
    // slots and let the reconnect loop install a fresh promise on the next
    // connect().
    const pendingRejector = this.readyRejector;
    // Reset the ready promise so the next `connect()` call after a
    // disconnect/reconnect cycle can hand back a fresh promise that
    // resolves on the next OPEN, rather than the already-resolved
    // original.
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejector = null;
    if (pendingRejector) {
      pendingRejector(
        new ConductorAppError({
          code: 'subscribe_failed',
          message: 'socket closed before open',
        }),
      );
    }
    this.scheduleReconnect();
  };

  private readonly handleError = (): void => {
    // Browsers / ws don't surface useful info from the error event itself;
    // close handler runs immediately after, so the reconnect is scheduled there.
  };

  private scheduleReconnect(): void {
    const max = this.options.maxReconnects ?? Number.POSITIVE_INFINITY;
    if (this.reconnectAttempts >= max) {
      this.setState('offline');
      this.closed = true;
      return;
    }
    this.setState('reconnecting');
    const backoff = computeBackoff(
      this.reconnectAttempts,
      this.options.initialBackoffMs ?? 250,
      this.options.maxBackoffMs ?? 30_000,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.openOnce().catch(() => this.scheduleReconnect());
    }, backoff);
  }

  private setState(state: 'connected' | 'reconnecting' | 'offline'): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // isolated
      }
    }
  }

  private async buildUrl(): Promise<string> {
    const token =
      typeof this.options.bearerToken === 'string'
        ? this.options.bearerToken
        : await this.options.bearerToken();
    // Parse the base URL so we map http→ws / https→wss safely. A bare
    // `replace(/^http/, 'ws')` mishandles e.g. `httpsproxy://` or any
    // URL whose protocol doesn't start cleanly with `http`.
    const parsed = new URL(this.options.baseUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    // Drop any trailing slash from the pathname before appending `/ws/app`.
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${pathname}/ws/app`;
    parsed.search = `?token=${encodeURIComponent(token)}`;
    return parsed.toString();
  }
}

/**
 * @internal Exposed for unit testing.
 */
export function computeBackoff(attempt: number, initial: number, max: number): number {
  const exp = Math.min(initial * 2 ** attempt, max);
  // Full jitter avoids reconnect stampedes when many clients lost the
  // connection simultaneously (e.g. server restart). Floor at half the
  // initial delay so a single client doesn't busy-loop on rapid failures.
  const jittered = Math.floor(Math.random() * exp);
  const floor = Math.floor(initial / 2);
  return Math.max(jittered, floor);
}
