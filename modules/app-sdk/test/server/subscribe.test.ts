/**
 * Tests for tasks.subscribe() + tasks.streamReply().
 *
 * Strategy: inject a fake WebSocket constructor that lets the test push
 * envelopes into the socket. The order in these tests matters:
 *
 *   1. Start the consumer (`for await` or pending `iter.next()`) FIRST —
 *      this triggers the lazy WS subscription to register its listener.
 *   2. Wait a microtask tick so the FakeSocket constructor runs and
 *      transitions to OPEN.
 *   3. Push envelopes; they will reach the consumer.
 *
 * Pushing before the consumer starts iterating is a bug — the envelope is
 * dropped on the floor because no listener is attached yet.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect } from '../../src/server/index.js';
import type { ChatEvent, StreamReplyDelta } from '../../src/types/index.js';

afterEach(() => {
  // Defensive: any test that flipped to fake timers must restore real ones
  // so subsequent tests using `tick()`/setTimeout actually advance.
  vi.useRealTimers();
});

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

  pushEnvelope(envelope: unknown): void {
    this.fire('message', { data: JSON.stringify(envelope) });
  }

  private fire(type: string, arg: unknown): void {
    const list = this.listeners[type] ?? [];
    for (const fn of list.slice()) fn(arg);
  }
}

function resetFakeSocket() {
  FakeSocket.instances = [];
}

/**
 * Wait one macrotask tick — long enough for queueMicrotask + setTimeout(0).
 *
 * TODO(round-3): replace `await tick()` with proper synchronization (Promise
 * tied to the FakeSocket's open callback) in the older tests. The V1/V2 and
 * idle-timeout tests added in Round 2 already use either fake timers or a
 * deterministic socket-state machine; the others were left on `tick()` to
 * keep this round's diff scoped.
 */
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('tasks.subscribe', () => {
  it('yields message_appended events filtered by taskId', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    // Start consuming BEFORE pushing envelopes.
    const events: ChatEvent[] = [];
    const done = (async () => {
      for await (const evt of client.tasks.subscribe('t_1')) {
        events.push(evt);
        if (events.filter((e) => e.type === 'message_appended').length >= 2) {
          break;
        }
      }
    })();

    // Wait until the FakeSocket has been constructed and opened.
    await tick();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];

    socket.pushEnvelope({
      type: 'task_user_message',
      payload: {
        id: 'm_1',
        task_id: 't_1',
        role: 'user',
        content: 'hello',
        created_at: '2026-05-17T00:00:00Z',
      },
    });
    socket.pushEnvelope({
      type: 'task_user_message',
      payload: {
        id: 'm_other',
        task_id: 't_other', // filtered out
        role: 'user',
        content: 'noise',
        created_at: '2026-05-17T00:00:01Z',
      },
    });
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_2',
        task_id: 't_1',
        role: 'assistant',
        content: 'world',
        created_at: '2026-05-17T00:00:02Z',
      },
    });

    await done;

    const messageEvents = events.filter((e) => e.type === 'message_appended');
    expect(messageEvents).toHaveLength(2);
    expect((messageEvents[0] as { message: { id: string } }).message.id).toBe('m_1');
    expect((messageEvents[1] as { message: { id: string } }).message.id).toBe('m_2');

    // None of the 't_other' envelope should have leaked through.
    expect(
      events.find(
        (e) =>
          e.type === 'message_appended' &&
          (e as { message: { taskId: string } }).message.taskId === 't_other',
      ),
    ).toBeUndefined();

    await client.close();
  });

  it('terminates cleanly on AbortSignal', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const controller = new AbortController();
    let received = 0;
    let endedCleanly = false;
    const consumer = (async () => {
      for await (const _evt of client.tasks.subscribe('t_1', {
        signal: controller.signal,
      })) {
        received += 1;
      }
      endedCleanly = true;
    })();

    await tick();
    controller.abort();
    await consumer;

    expect(endedCleanly).toBe(true);
    // Optional: a connection_state event may have arrived first; that's OK.
    expect(received).toBeGreaterThanOrEqual(0);
    await client.close();
  });
});

describe('tasks.streamReply', () => {
  it('yields text deltas from reply_preview then done on assistant message', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1')) {
        yielded.push(delta);
        if (delta.type === 'done') break;
      }
    })();

    await tick();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];

    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: { task_id: 't_1', state: 'thinking', reply_preview: 'Hel', reply_to: 'r_1' },
    });
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: { task_id: 't_1', state: 'thinking', reply_preview: 'Hello', reply_to: 'r_1' },
    });
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_final',
        task_id: 't_1',
        role: 'assistant',
        content: 'Hello world',
        created_at: '2026-05-17T00:01:00Z',
      },
    });

    await consumer;

    const textDeltas = yielded.filter((d) => d.type === 'text');
    expect(textDeltas.length).toBeGreaterThanOrEqual(2);
    expect((textDeltas[0] as { text: string }).text).toBe('Hel');
    // Second delta should be the post-bootstrap diff slice.
    expect((textDeltas[1] as { text: string }).text).toBe('lo');

    const done = yielded.find((d) => d.type === 'done');
    expect(done).toBeDefined();
    expect((done as { message: { id: string } }).message.id).toBe('m_final');

    await client.close();
  });

  it('yields error on task_status_update=failed', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1')) {
        yielded.push(delta);
        if (delta.type === 'error') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'failed', summary: 'boom' },
    });

    await consumer;

    const err = yielded.find((d) => d.type === 'error');
    expect(err).toBeDefined();
    expect((err as { error: { message: string } }).error.message).toBe('boom');

    await client.close();
  });

  it('skips app-origin SDK echoes (audit.actor=app) and yields the next non-echo as done', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1')) {
        yielded.push(delta);
        if (delta.type === 'done') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // App-origin echo of the outbound prompt — must be skipped.
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_echo',
        task_id: 't_1',
        role: 'sdk',
        content: 'echo of our prompt',
        metadata: { audit: { actor: 'app', sdkName: 'x' } },
        created_at: '2026-05-17T00:00:00Z',
      },
    });
    // The real AI reply (also role='sdk' but no audit.actor=app) — yielded as done.
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_ai',
        task_id: 't_1',
        role: 'sdk',
        content: 'real reply',
        created_at: '2026-05-17T00:00:01Z',
      },
    });

    await consumer;

    const done = yielded.find((d) => d.type === 'done');
    expect(done).toBeDefined();
    expect((done as { message: { id: string } }).message.id).toBe('m_ai');
    await client.close();
  });

  it('skips synthetic system messages (metadata.synthetic=true)', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1')) {
        yielded.push(delta);
        if (delta.type === 'done') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_synthetic',
        task_id: 't_1',
        role: 'sdk',
        content: 'session started',
        metadata: { synthetic: true },
        created_at: '2026-05-17T00:00:00Z',
      },
    });
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_real',
        task_id: 't_1',
        role: 'sdk',
        content: 'actual reply',
        created_at: '2026-05-17T00:00:01Z',
      },
    });

    await consumer;

    const done = yielded.find((d) => d.type === 'done');
    expect(done).toBeDefined();
    expect((done as { message: { id: string } }).message.id).toBe('m_real');
    await client.close();
  });

  it('yields error on task_finished without a reply (regression: previously hung silently)', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1')) {
        yielded.push(delta);
        if (delta.type === 'error') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;

    const err = yielded.find((d) => d.type === 'error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('task_not_running');
    await client.close();
  });

  it('does not leak the external abort listener after normal completion (V1 regression)', async () => {
    // Regression: streamReplyForTask used to attach an anonymous
    // `() => idleController.abort()` listener to the external AbortSignal
    // and never remove it. Long-lived AbortControllers re-used across many
    // streamReply invocations leaked one listener per call. Now we name the
    // listener and remove it in the iterator's `finally` block.
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    // Spy on add/remove so we can balance them. We can't use
    // AbortSignal.prototype.addEventListener directly because Vitest doesn't
    // proxy globals; just record on a wrapper.
    const controller = new AbortController();
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    let activeListenerCount = 0;
    controller.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
      if (type === 'abort') activeListenerCount += 1;
      realAdd(type, fn, opts);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
      if (type === 'abort') activeListenerCount -= 1;
      realRemove(type, fn, opts);
    }) as typeof controller.signal.removeEventListener;

    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1', {
        signal: controller.signal,
      })) {
        if (delta.type === 'done') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // Drive the iterator to a 'done' delta via a real assistant message.
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_only',
        task_id: 't_1',
        role: 'assistant',
        content: 'final',
        created_at: '2026-05-17T00:01:00Z',
      },
    });

    await consumer;
    // After normal completion the external-signal listener must have been
    // removed. Net count should be 0 — every addEventListener('abort', ...)
    // paired with a removeEventListener('abort', ...).
    expect(activeListenerCount).toBe(0);
    await client.close();
  });

  it('emits a terminal error after idleTimeoutMs with no deltas', async () => {
    // Use fake timers so the idle-timeout assertion isn't wall-clock bound
    // and the test doesn't pay a real 50ms sleep. We still rely on the JS
    // microtask queue for the connection open transition (`queueMicrotask`
    // inside FakeSocket); vi.advanceTimersByTimeAsync drains microtasks
    // between scheduled timers, so both run in the right order.
    vi.useFakeTimers();
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const yielded: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const delta of client.tasks.streamReply('t_1', { idleTimeoutMs: 50 })) {
        yielded.push(delta);
        if (delta.type === 'error') break;
      }
    })();

    // Drain microtasks so FakeSocket's queueMicrotask transitions to OPEN.
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0];
    // Push only events that are filtered out (user echo + synthetic system).
    socket.pushEnvelope({
      type: 'task_user_message',
      payload: {
        id: 'm_user',
        task_id: 't_1',
        role: 'user',
        content: 'hi',
        created_at: '2026-05-17T00:00:00Z',
      },
    });

    // Fast-forward past the 50ms idle timeout. advanceTimersByTimeAsync
    // also drains intervening microtasks so the abort propagates through
    // the inner iterator into the for-await loop.
    await vi.advanceTimersByTimeAsync(60);
    await consumer;

    const err = yielded.find((d) => d.type === 'error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('stream_aborted');
    await client.close();
    vi.useRealTimers();
  });
});

describe('tasks.subscribe / streamReply connect errors', () => {
  it('surfaces a failing bearerToken provider as a task_failed event on the iterator (subscribe)', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: async () => {
        throw new Error('token vault down');
      },
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const evt of client.tasks.subscribe('t_1')) {
        events.push(evt);
        if (evt.type === 'task_failed') break;
      }
    })();

    await consumer;

    const failed = events.find((e) => e.type === 'task_failed');
    expect(failed).toBeDefined();
    expect((failed as { error: { message: string } }).error.message).toMatch(/token vault down|WebSocket/);
    await client.close();
  });

  it('subscribe iterator yields task_failed when client.close() runs before connect resolves (V3 H1 e2e)', async () => {
    // Wire up a transport that never opens. The subscribe iterator's first
    // next() will be parked on socket.connect(). Calling client.close()
    // should cause that connect promise to reject, which the iterator
    // catches and surfaces as a synthetic `task_failed` event.
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
        this.readyState = SilentSocket.CLOSED;
      }
    }

    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: SilentSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const evt of client.tasks.subscribe('t_h1')) {
        events.push(evt);
        if (evt.type === 'task_failed') break;
      }
    })();

    // Yield once so the subscribe iterator parks on socket.connect().
    await Promise.resolve();
    // Close the client; this rejects the in-flight connect promise.
    await client.close();
    await consumer;

    const failed = events.find((e) => e.type === 'task_failed');
    expect(failed).toBeDefined();
    expect((failed as { error: { code: string } }).error.code).toBe('subscribe_failed');
    expect(String((failed as { error: { message: string } }).error.message)).toMatch(/closed/);
  });

  it('surfaces a failing bearerToken provider as an error delta on streamReply', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: async () => {
        throw new Error('token vault down');
      },
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const deltas: StreamReplyDelta[] = [];
    const consumer = (async () => {
      for await (const d of client.tasks.streamReply('t_1')) {
        deltas.push(d);
        if (d.type === 'error') break;
      }
    })();

    await consumer;

    const err = deltas.find((d) => d.type === 'error');
    expect(err).toBeDefined();
    await client.close();
  });
});

describe('AppClient.close() shutdown semantics (M2)', () => {
  it('subscribe iterator yields synthetic task_failed and returns when client.close() runs mid-stream', async () => {
    // Iterator has ALREADY passed connect() and consumed an event. The
    // pre-M2 bug was: socket.close() cleared the rawListeners, the iterator
    // sat on its next() Promise forever. Now AppWebSocket.onClose fires a
    // synthetic terminal task_failed and finish()es the iterator.
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    let iteratorEndedCleanly = false;
    const consumer = (async () => {
      for await (const evt of client.tasks.subscribe('t_1')) {
        events.push(evt);
      }
      iteratorEndedCleanly = true;
    })();

    // Wait for connect, then push one event so the iterator is firmly past
    // connect() and listening on rawListeners.
    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_user_message',
      payload: {
        id: 'm_1',
        task_id: 't_1',
        role: 'user',
        content: 'hello',
        created_at: '2026-05-17T00:00:00Z',
      },
    });
    // Yield to let that message reach the consumer.
    await tick();
    expect(events.some((e) => e.type === 'message_appended')).toBe(true);

    // Now close — must surface as a synthetic task_failed and end cleanly.
    await client.close();
    await consumer;

    expect(iteratorEndedCleanly).toBe(true);
    const failed = events.find((e) => e.type === 'task_failed');
    expect(failed).toBeDefined();
    expect((failed as { error: { code: string } }).error.code).toBe('subscribe_failed');
    expect(String((failed as { error: { message: string } }).error.message)).toMatch(/closed/);
  });

  it('streamReply iterator yields synthetic error and returns when client.close() runs mid-stream', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    const deltas: StreamReplyDelta[] = [];
    let ended = false;
    const consumer = (async () => {
      for await (const d of client.tasks.streamReply('t_1')) {
        deltas.push(d);
      }
      ended = true;
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // Push a runtime_status so the iterator is firmly past connect() and
    // sitting on rawListeners.
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: { task_id: 't_1', state: 'thinking', reply_preview: 'Hi', reply_to: 'r_1' },
    });
    await tick();

    await client.close();
    await consumer;

    expect(ended).toBe(true);
    const err = deltas.find((d) => d.type === 'error');
    expect(err).toBeDefined();
    // streamReply maps subscribe's task_failed → its own error delta;
    // the code propagates through.
    expect((err as { error: { code: string } }).error.code).toBe('subscribe_failed');
  });

  it('client.close() is idempotent', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });

    // First close should succeed.
    await client.close();
    // Second close must not throw (pre-M2 NPE'd on this.socket.close()).
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('tasks.subscribe() called AFTER client.close() throws synchronously', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });
    await client.close();

    expect(() => client.tasks.subscribe('t_1')).toThrow(/closed/);
    expect(() => client.tasks.streamReply('t_1')).toThrow(/closed/);
  });

  it('tasks REST methods called AFTER client.close() throw synchronously', async () => {
    resetFakeSocket();
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch: (() => Promise.resolve(new Response('{}', { status: 200 }))) as never,
      webSocketImpl: FakeSocket as never,
    });
    await client.close();

    expect(() => client.tasks.create({ projectId: 'p', title: 't' })).toThrow(/closed/);
    expect(() => client.tasks.get('t_1')).toThrow(/closed/);
    expect(() => client.tasks.list()).toThrow(/closed/);
    expect(() => client.tasks.sendMessage('t_1', 'hi')).toThrow(/closed/);
    expect(() => client.tasks.history('t_1')).toThrow(/closed/);
    expect(() => client.tasks.interrupt('t_1', { targetReplyTo: 'r' })).toThrow(/closed/);
  });

});
