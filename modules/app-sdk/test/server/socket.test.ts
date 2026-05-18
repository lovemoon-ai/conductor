/**
 * Tests for the AppWebSocket transport: reconnect lifecycle + computeBackoff
 * floor + URL building.
 */
import { describe, it, expect } from 'vitest';
import { AppWebSocket, computeBackoff } from '../../src/server/ws/socket.js';

class FakeSocket {
  public static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeSocket.CONNECTING;
  private listeners: Record<string, ((arg: unknown) => void)[]> = {};

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.fire('open', {});
    });
  }

  addEventListener(type: string, fn: (arg: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (arg: unknown) => void): void {
    const list = this.listeners[type];
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire('close', {});
  }

  emitClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire('close', {});
  }

  private fire(type: string, arg: unknown): void {
    const list = this.listeners[type] ?? [];
    for (const fn of list.slice()) fn(arg);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('computeBackoff', () => {
  it('never returns less than half the initial delay', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = computeBackoff(0, 500, 30_000);
      expect(v).toBeGreaterThanOrEqual(250);
    }
  });

  it('respects the upper cap even for large attempt numbers', () => {
    const v = computeBackoff(50, 250, 30_000);
    expect(v).toBeLessThanOrEqual(30_000);
  });
});

describe('AppWebSocket URL building', () => {
  it('maps https://host → wss:// + /ws/app path', async () => {
    const ws = new AppWebSocket({
      baseUrl: 'https://conductor.example.com',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();
    expect(FakeSocket.instances.length).toBeGreaterThan(0);
    const url = FakeSocket.instances[FakeSocket.instances.length - 1].url;
    expect(url.startsWith('wss://conductor.example.com/ws/app?token=tok')).toBe(true);
    ws.close();
  });

  it('maps http://host:port → ws:// + path', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok2',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();
    const url = FakeSocket.instances[FakeSocket.instances.length - 1].url;
    expect(url.startsWith('ws://localhost:6152/ws/app?token=tok2')).toBe(true);
    ws.close();
  });
});

describe('AppWebSocket reconnect lifecycle', () => {
  it('connect() after a disconnect resolves on the next OPEN (regression)', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
      initialBackoffMs: 4,
      maxBackoffMs: 10,
    });

    await ws.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    // Simulate a server-side close (not a manual close on our end).
    FakeSocket.instances[0].emitClose();

    // After close, scheduleReconnect schedules a new openOnce via setTimeout.
    // Wait long enough for the timer + openOnce + open microtask to fire.
    await new Promise((r) => setTimeout(r, 25));
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);

    // A new connect() should resolve against the *new* socket (not the
    // original, already-resolved promise). Regression: previously
    // readyPromise wasn't reset, so this would return immediately even if
    // the new socket hadn't yet opened.
    await ws.connect();

    ws.close();
  });

  it('rejects an in-flight connect() if the socket closes before opening (V2)', async () => {
    // Regression: previously, handleClose nulled the readyResolver/Rejector
    // without calling the rejector. If the WS server rejected the auth
    // handshake (close event fires without a prior open), `await connect()`
    // hung forever. Now handleClose rejects the in-flight promise with
    // `subscribe_failed`.
    FakeSocket.instances = [];

    class CloseFirstSocket {
      public static instances: CloseFirstSocket[] = [];
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState: number = CloseFirstSocket.CONNECTING;
      private listeners: Record<string, ((arg: unknown) => void)[]> = {};

      constructor(public readonly url: string) {
        CloseFirstSocket.instances.push(this);
        // Fire close *before* open — auth rejection / mid-handshake server
        // restart pattern.
        queueMicrotask(() => {
          this.readyState = CloseFirstSocket.CLOSED;
          this.fire('close', {});
        });
      }

      addEventListener(type: string, fn: (arg: unknown) => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type: string, fn: (arg: unknown) => void): void {
        const list = this.listeners[type];
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
      close(): void {
        this.readyState = CloseFirstSocket.CLOSED;
      }
      private fire(type: string, arg: unknown): void {
        const list = this.listeners[type] ?? [];
        for (const fn of list.slice()) fn(arg);
      }
    }

    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: CloseFirstSocket as never,
      // Avoid the reconnect loop opening a new socket and racing the assertion.
      maxReconnects: 0,
      initialBackoffMs: 2,
      maxBackoffMs: 10,
    });

    let rejected = false;
    let rejectionCode: string | undefined;
    try {
      await ws.connect();
    } catch (err) {
      rejected = true;
      rejectionCode = (err as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    expect(rejectionCode).toBe('subscribe_failed');

    ws.close();
  });

  it('close() rejects an in-flight connect() promise (V3 H1)', async () => {
    // Regression: previously, close() set this.closed = true and then called
    // socket.close(). If the FakeSocket never fires open or close on its own,
    // handleClose would either never run or early-return on `closed`. Either
    // way, the in-flight connect() promise was left hanging. close() now
    // captures the rejector and explicitly rejects after cleanup.
    class SilentSocket {
      public static instances: SilentSocket[] = [];
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState: number = SilentSocket.CONNECTING;
      private listeners: Record<string, ((arg: unknown) => void)[]> = {};

      constructor(public readonly url: string) {
        SilentSocket.instances.push(this);
        // Intentionally never fires open or close on its own.
      }

      addEventListener(type: string, fn: (arg: unknown) => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type: string, fn: (arg: unknown) => void): void {
        const list = this.listeners[type];
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
      close(): void {
        // Don't fire 'close' — we want to verify the close-then-reject path
        // works even if the underlying transport's close() is a no-op.
        this.readyState = SilentSocket.CLOSED;
      }
    }

    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: SilentSocket as never,
      maxReconnects: 0,
    });

    // Start the connect but don't await — the socket will never open.
    const connectPromise = ws.connect();
    // Race against a short timer so the test fails fast if the promise hangs.
    const raced = Promise.race([
      connectPromise.then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err }),
      ),
      new Promise<{ ok: 'timeout' }>((r) => setTimeout(() => r({ ok: 'timeout' }), 100)),
    ]);

    // Now close before the socket ever opens or closes on its own.
    ws.close();

    const result = await raced;
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect((result.err as { code?: string }).code).toBe('subscribe_failed');
      expect(String((result.err as { message?: string }).message)).toMatch(/closed/);
    }
  });

  it('onConnectionState replays the current state to late subscribers (M2)', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();

    const seen: string[] = [];
    ws.onConnectionState((s) => seen.push(s));
    await tick();
    expect(seen).toEqual(['connected']);

    ws.close();
  });

  it('onClose fires registered listeners on close() and is idempotent (M2)', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();

    let fires = 0;
    ws.onClose(() => {
      fires += 1;
    });

    ws.close();
    expect(fires).toBe(1);

    // Idempotent: second close is a no-op (must not re-fire listeners
    // because they were cleared, and must not NPE).
    ws.close();
    expect(fires).toBe(1);
  });

  it('onClose fires synchronously when registered AFTER close() (M2 late-subscriber safety)', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();
    ws.close();

    let fired = false;
    ws.onClose(() => {
      fired = true;
    });
    // No tick needed — late subscribers fire synchronously, otherwise an
    // iterator that subscribes during shutdown could wedge.
    expect(fired).toBe(true);
  });

  it('onClose unsubscribe before close() prevents the listener from firing (M2)', async () => {
    FakeSocket.instances = [];
    const ws = new AppWebSocket({
      baseUrl: 'http://x',
      bearerToken: 'tok',
      webSocketImpl: FakeSocket as never,
    });
    await ws.connect();

    let fired = false;
    const unsub = ws.onClose(() => {
      fired = true;
    });
    unsub();
    ws.close();
    expect(fired).toBe(false);
  });
});
