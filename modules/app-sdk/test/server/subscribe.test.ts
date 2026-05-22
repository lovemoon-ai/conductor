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

/**
 * History catch-up: when a terminal envelope arrives but the realtime path
 * dropped the final assistant message_appended (multi-instance broadcast
 * without a backplane, idempotent retries that bypass projection, WS drops
 * during the reconnect window…), tasks.subscribe should backfill from REST.
 */
describe('tasks.subscribe history catch-up', () => {
  function makeFetchReturningHistory(
    messagesByCall: Array<Array<Record<string, unknown>>>,
  ): {
    fetch: typeof globalThis.fetch;
    historyCalls: number;
  } {
    let historyCalls = 0;
    const fetch = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes('/messages')) {
        const idx = Math.min(historyCalls, messagesByCall.length - 1);
        historyCalls += 1;
        return new Response(
          JSON.stringify({
            messages: messagesByCall[idx] ?? [],
            pagination: { has_more_before: false, oldest_message_id: null },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as never;
    return {
      fetch,
      get historyCalls() {
        return historyCalls;
      },
    } as { fetch: typeof globalThis.fetch; historyCalls: number };
  }

  it('emits synthetic message_appended after task_finished when realtime dropped the assistant message', async () => {
    resetFakeSocket();
    const { fetch } = makeFetchReturningHistory([
      [
        {
          id: 'm_late',
          task_id: 't_1',
          role: 'assistant',
          content: 'late reply',
          created_at: '2026-05-17T00:00:05Z',
        },
      ],
    ]);
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        const hasFinished = events.some((e) => e.type === 'task_finished');
        const hasMessage = events.some((e) => e.type === 'message_appended');
        if (hasFinished && hasMessage) break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // Terminal envelope arrives without any preceding message_appended —
    // simulating the missed-broadcast scenario.
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;
    await client.close();

    const messageEvents = events.filter((e) => e.type === 'message_appended');
    expect(messageEvents).toHaveLength(1);
    expect((messageEvents[0] as { message: { id: string } }).message.id).toBe(
      'm_late',
    );
  });

  it('dedupes against an earlier real-time message_appended (same id is not re-emitted)', async () => {
    resetFakeSocket();
    const { fetch } = makeFetchReturningHistory([
      [
        {
          id: 'm_real',
          task_id: 't_1',
          role: 'assistant',
          content: 'real reply',
          created_at: '2026-05-17T00:00:03Z',
        },
      ],
    ]);
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        if (ev.type === 'task_finished') {
          // Wait for the catch-up's 500ms timer + REST round-trip to land
          // before stopping. Otherwise the test races the consumer-break
          // and may miss a (correctly de-duplicated) zero events.
          await new Promise((r) => setTimeout(r, 800));
          break;
        }
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_sdk_message',
      payload: {
        id: 'm_real',
        task_id: 't_1',
        role: 'assistant',
        content: 'real reply',
        created_at: '2026-05-17T00:00:03Z',
      },
    });
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;
    await client.close();

    // Exactly one message_appended for 'm_real' — the real one. The catch-up
    // saw it in history but skipped it because knownIds already had the id.
    const messageEvents = events.filter(
      (e) =>
        e.type === 'message_appended' &&
        (e as { message: { id: string } }).message.id === 'm_real',
    );
    expect(messageEvents).toHaveLength(1);
  });

  it('triggers catch-up on runtime_status replyInProgress true→false transition', async () => {
    resetFakeSocket();
    const { fetch } = makeFetchReturningHistory([
      [
        {
          id: 'm_after_reply',
          task_id: 't_1',
          role: 'assistant',
          content: 'final',
          created_at: '2026-05-17T00:00:04Z',
        },
      ],
    ]);
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        if (ev.type === 'message_appended') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // First runtime_status: reply in progress.
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: {
        task_id: 't_1',
        state: 'thinking',
        reply_in_progress: true,
      },
    });
    // Then: reply ended. Catch-up should fire.
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: {
        task_id: 't_1',
        state: 'idle',
        reply_in_progress: false,
      },
    });

    await consumer;
    await client.close();

    const messageEvents = events.filter((e) => e.type === 'message_appended');
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      (messageEvents[0] as { message: { id: string } }).message.id,
    ).toBe('m_after_reply');
  });

  it('does NOT trigger catch-up when disableHistoryCatchUp is true', async () => {
    resetFakeSocket();
    let historyHits = 0;
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('/messages')) historyHits += 1;
      return new Response(
        JSON.stringify({ messages: [], pagination: {} }),
        { status: 200 },
      );
    }) as never;
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1', {
        disableHistoryCatchUp: true,
      })) {
        events.push(ev);
        if (ev.type === 'task_finished') {
          // Give any (incorrectly) scheduled catch-up a chance to run before
          // we bail. 700ms covers the 500ms delay + a comfortable margin.
          await new Promise((r) => setTimeout(r, 700));
          break;
        }
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;
    await client.close();

    expect(historyHits).toBe(0);
    expect(events.filter((e) => e.type === 'message_appended')).toHaveLength(
      0,
    );
  });

  it('triggers catch-up on connection_state reconnecting → connected', async () => {
    resetFakeSocket();
    const { fetch } = makeFetchReturningHistory([
      [
        {
          id: 'm_missed_during_reconnect',
          task_id: 't_1',
          role: 'assistant',
          content: 'arrived offline',
          created_at: '2026-05-17T00:00:10Z',
        },
      ],
    ]);
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        if (ev.type === 'message_appended') break;
      }
    })();

    await tick();
    const firstSocket = FakeSocket.instances[0];
    // Drop the socket — this triggers the reconnect cycle. The SDK emits
    // connection_state: 'reconnecting' then (after reopen) 'connected'.
    // We use the default backoff (250ms initial with jitter); `await consumer`
    // below is unbounded, so the test waits as long as needed for the
    // reconnect to land and the catch-up to inject `message_appended`.
    firstSocket.close();

    await consumer;
    await client.close();

    const stateTransitions = events
      .filter((e) => e.type === 'connection_state')
      .map((e) => (e as { state: string }).state);
    expect(stateTransitions).toContain('reconnecting');
    expect(stateTransitions).toContain('connected');

    const messageEvents = events.filter((e) => e.type === 'message_appended');
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      (messageEvents[0] as { message: { id: string } }).message.id,
    ).toBe('m_missed_during_reconnect');
  });

  it('triggers catch-up on task_failed (parity with task_finished)', async () => {
    resetFakeSocket();
    const { fetch } = makeFetchReturningHistory([
      [
        {
          id: 'm_persisted_before_failure',
          task_id: 't_1',
          role: 'assistant',
          content: 'partial reply',
          created_at: '2026-05-17T00:00:05Z',
        },
      ],
    ]);
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        if (ev.type === 'message_appended') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // task_status_update with status=failed maps to task_failed in the SDK
    // envelope layer; that's the realistic path. Push it directly.
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: {
        task_id: 't_1',
        status: 'failed',
        summary: 'simulated upstream failure',
      },
    });

    await consumer;
    await client.close();

    const messageEvents = events.filter((e) => e.type === 'message_appended');
    expect(messageEvents).toHaveLength(1);
    expect(
      (messageEvents[0] as { message: { id: string } }).message.id,
    ).toBe('m_persisted_before_failure');
  });

  it('coalesces bursty terminal events into a single history fetch', async () => {
    resetFakeSocket();
    let historyHits = 0;
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('/messages')) {
        historyHits += 1;
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 'm_final',
                task_id: 't_1',
                role: 'assistant',
                content: 'done',
                created_at: '2026-05-17T00:00:06Z',
              },
            ],
            pagination: {},
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as never;
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const consumer = (async () => {
      for await (const ev of client.tasks.subscribe('t_1')) {
        events.push(ev);
        if (ev.type === 'message_appended') {
          // Wait a bit past the 500ms catch-up delay window so any
          // (incorrectly) duplicated fetch has time to surface.
          await new Promise((r) => setTimeout(r, 600));
          break;
        }
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    // Burst: runtime_status flips true→false, then task_finished arrives
    // ~immediately. Both events trigger a catch-up; the wrapper must
    // coalesce them into a single REST round-trip.
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: { task_id: 't_1', state: 'thinking', reply_in_progress: true },
    });
    socket.pushEnvelope({
      type: 'task_runtime_status',
      payload: { task_id: 't_1', state: 'idle', reply_in_progress: false },
    });
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;
    await client.close();

    // Within the 500ms delay window, both triggers should collapse: only one
    // setTimeout actually schedules a fetch, and the in-flight check on the
    // second trigger flips `needAnotherCatchUp` rather than spawning a new
    // request. The needAnother pass then runs once more (re-fetches), so
    // total acceptable count is 1 or 2 — never higher.
    expect(historyHits).toBeGreaterThanOrEqual(1);
    expect(historyHits).toBeLessThanOrEqual(2);
  });

  it('catch-up REST failure does not break the live stream', async () => {
    resetFakeSocket();
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('/messages')) {
        // Simulate a transient upstream failure.
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as never;
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    // Silence the expected console.warn so test output stays clean.
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const events: ChatEvent[] = [];
      const consumer = (async () => {
        for await (const ev of client.tasks.subscribe('t_1')) {
          events.push(ev);
          if (
            ev.type === 'message_appended' &&
            (ev as { message: { id: string } }).message.id === 'm_after_failure'
          ) {
            break;
          }
        }
      })();

      await tick();
      const socket = FakeSocket.instances[0];
      // First: terminal event triggers a catch-up that will fail.
      socket.pushEnvelope({
        type: 'task_status_update',
        payload: { task_id: 't_1', status: 'finished' },
      });
      // Wait for the failed catch-up to complete + console.warn to fire.
      await new Promise((r) => setTimeout(r, 700));
      // Then: a real-time message arrives via the live stream. The failed
      // catch-up must not have torn down the subscription.
      socket.pushEnvelope({
        type: 'task_sdk_message',
        payload: {
          id: 'm_after_failure',
          task_id: 't_1',
          role: 'assistant',
          content: 'live event still flowing',
          created_at: '2026-05-17T00:00:07Z',
        },
      });

      await consumer;
      await client.close();

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(String(warnings[0]?.[0] ?? '')).toMatch(/catch-up failed/);
      expect(
        events.some(
          (e) =>
            e.type === 'message_appended' &&
            (e as { message: { id: string } }).message.id === 'm_after_failure',
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('consumer return() aborts an in-flight catch-up fetch', async () => {
    resetFakeSocket();
    let fetchStarted = false;
    let fetchAborted = false;
    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes('/messages')) {
        fetchStarted = true;
        // Hang until aborted — this simulates a slow / stuck upstream.
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              fetchAborted = true;
              const err = new Error('aborted');
              (err as { name: string }).name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      return new Response('{}', { status: 200 });
    }) as never;

    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'tok',
      fetch,
      webSocketImpl: FakeSocket as never,
    });

    const events: ChatEvent[] = [];
    const iter = client.tasks.subscribe('t_1')[Symbol.asyncIterator]();
    // Pull until we see task_finished, then call return() while the
    // catch-up's fetch is still hanging.
    const consumer = (async () => {
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        events.push(r.value);
        if (r.value.type === 'task_finished') break;
      }
    })();

    await tick();
    const socket = FakeSocket.instances[0];
    socket.pushEnvelope({
      type: 'task_status_update',
      payload: { task_id: 't_1', status: 'finished' },
    });

    await consumer;
    // Give the catch-up's setTimeout time to elapse and start the fetch.
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchStarted).toBe(true);

    // Now return() — should abort the in-flight fetch.
    await iter.return!();
    // Allow the abort to propagate through the fetch mock.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchAborted).toBe(true);

    await client.close();
  });
});
