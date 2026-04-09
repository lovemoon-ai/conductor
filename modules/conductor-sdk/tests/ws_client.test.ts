import { afterEach, describe, expect, test, vi } from 'vitest';

import { ConductorWebSocketClient } from '../src/ws/index.js';
import { ConductorConfig } from '../src/config/index.js';

function makeConfig(): ConductorConfig {
  return new ConductorConfig({
    agentToken: 'token',
    backendUrl: 'https://backend.local',
  });
}

class FakeSocket {
  sent: string[] = [];
  closed = false;
  private queue: (string | null)[] = [];
  private waiters: Array<(value: string | null) => void> = [];
  private pongHandlers: Array<() => void> = [];
  private closeInfoHandlers: Array<(info: { code?: number | null; reason?: string | null }) => void> = [];

  feed(payload: Record<string, any>): void {
    const message = JSON.stringify(payload);
    if (this.waiters.length) {
      const resolve = this.waiters.shift()!;
      resolve(message);
    } else {
      this.queue.push(message);
    }
  }

  async send(data: string): Promise<void> {
    this.sent.push(data);
  }

  async ping(): Promise<void> {
    if (this.closed) {
      throw new Error('closed');
    }
    queueMicrotask(() => {
      for (const handler of this.pongHandlers) {
        handler();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handler of this.closeInfoHandlers) {
      handler({ code: 1000, reason: null });
    }
    this.enqueue(null);
  }

  async terminate(): Promise<void> {
    await this.close();
  }

  async closeWithInfo(code: number, reason: string): Promise<void> {
    this.closed = true;
    for (const handler of this.closeInfoHandlers) {
      handler({ code, reason });
    }
    this.enqueue(null);
  }

  onPong(handler: () => void): void {
    this.pongHandlers.push(handler);
  }

  onCloseInfo(handler: (info: { code?: number | null; reason?: string | null }) => void): void {
    this.closeInfoHandlers.push(handler);
  }

  private enqueue(value: string | null): void {
    if (this.waiters.length) {
      const resolve = this.waiters.shift()!;
      resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  private nextValue(): Promise<string | null> {
    if (this.queue.length) {
      const value = this.queue.shift() ?? null;
      return Promise.resolve(value);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    while (true) {
      const value = await this.nextValue();
      if (value === null) {
        return;
      }
      yield value;
    }
  }
}

describe('ConductorWebSocketClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('dispatches backend events to handlers', async () => {
    const connections: FakeSocket[] = [];
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      heartbeatInterval: 10,
      connectImpl: async () => {
        const socket = new FakeSocket();
        connections.push(socket);
        return socket as any;
      },
    });
    const received: Record<string, any>[] = [];
    client.registerHandler(async (payload) => {
      received.push(payload);
    });
    await client.connect();
    connections[0].feed({ type: 'task_user_message' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual([{ type: 'task_user_message' }]);
    await client.disconnect();
  });

  test('reconnects after close and can send payloads', async () => {
    const connections: FakeSocket[] = [];
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      heartbeatInterval: 10,
      connectImpl: async () => {
        const socket = new FakeSocket();
        connections.push(socket);
        return socket as any;
      },
    });
    await client.connect();
    await connections[0].close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.sendJson({ type: 'ping' });
    expect(connections.length).toBeGreaterThanOrEqual(2);
    const last = connections[connections.length - 1];
    expect(JSON.parse(last.sent.at(-1)!)).toEqual({ type: 'ping' });
    await client.disconnect();
  });

  test('invokes onConnected for initial connect and reconnect', async () => {
    const connections: FakeSocket[] = [];
    const events: boolean[] = [];
    let disconnects = 0;
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      heartbeatInterval: 10,
      onConnected: ({ isReconnect }) => {
        events.push(isReconnect);
      },
      onDisconnected: () => {
        disconnects += 1;
      },
      connectImpl: async () => {
        const socket = new FakeSocket();
        connections.push(socket);
        return socket as any;
      },
    });

    await client.connect();
    expect(events).toEqual([false]);

    await connections[0].close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(disconnects).toBe(1);
    expect(events.includes(true)).toBe(true);
    await client.disconnect();
  });

  test('forces reconnect when pong is missing', async () => {
    vi.useFakeTimers();

    class NoPongSocket extends FakeSocket {
      override async ping(): Promise<void> {
        if (this.closed) {
          throw new Error('closed');
        }
      }
    }

    const connections: FakeSocket[] = [];
    const disconnectReasons: string[] = [];
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      heartbeatInterval: 10,
      onDisconnected: (event) => {
        disconnectReasons.push(event.reason);
      },
      connectImpl: async () => {
        const socket = connections.length === 0 ? new NoPongSocket() : new FakeSocket();
        connections.push(socket);
        return socket as any;
      },
    });

    await client.connect();
    await vi.advanceTimersByTimeAsync(50);

    expect(disconnectReasons).toContain('pong_timeout');
    expect(connections.length).toBeGreaterThanOrEqual(2);
    await client.disconnect();
  });

  test('does not require onPong support for legacy socket adapters', async () => {
    const connections: FakeSocket[] = [];
    const disconnectReasons: string[] = [];
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      heartbeatInterval: 10,
      onDisconnected: (event) => {
        disconnectReasons.push(event.reason);
      },
      connectImpl: async () => {
        const socket = new FakeSocket() as FakeSocket & { onPong?: (() => void) | undefined };
        socket.onPong = undefined;
        connections.push(socket);
        return socket as any;
      },
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await client.sendJson({ type: 'ping' });

    expect(disconnectReasons).toEqual([]);
    expect(connections).toHaveLength(1);
    expect(JSON.parse(connections[0].sent.at(-1)!)).toEqual({ type: 'ping' });
    await client.disconnect();
  });

  test('backs off reconnect attempts after duplicate-host disconnects', async () => {
    vi.useFakeTimers();
    const connections: FakeSocket[] = [];
    const client = new ConductorWebSocketClient(makeConfig(), {
      reconnectDelay: 10,
      duplicateHostReconnectDelay: 200,
      heartbeatInterval: 10,
      connectImpl: async () => {
        const socket = new FakeSocket();
        connections.push(socket);
        return socket as any;
      },
    });

    await client.connect();
    await connections[0].closeWithInfo(4002, 'duplicate-host');
    await vi.advanceTimersByTimeAsync(50);

    expect(connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);

    expect(connections.length).toBeGreaterThanOrEqual(2);
    await client.disconnect();
  });
});
