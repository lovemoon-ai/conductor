/**
 * Integration tests for <ChatView /> end-to-end against a mock ChatAdapter.
 *
 * Exercises:
 *   - Initial history hydration from adapter.fetchHistory.
 *   - subscribe/handler routing for message_appended / runtime_status / failure.
 *   - Optimistic send → confirm path.
 *   - Interrupt button visibility based on runtime state.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ChatView } from '../../src/react/index.js';
import { ChatProvider, useChat } from '../../src/react/store/chat-store.js';
import type { ChatAdapter } from '../../src/types/adapter.js';
import type { ChatEvent } from '../../src/types/events.js';
import type { Message, SendMessageInput } from '../../src/types/message.js';

interface AdapterControl {
  adapter: ChatAdapter;
  pushEvent(event: ChatEvent): void;
  sentMessages: Array<{ taskId: string; input: SendMessageInput }>;
  interrupts: Array<{ taskId: string; targetReplyTo: string }>;
}

function makeMockAdapter(initialHistory: Message[] = []): AdapterControl {
  const handlers = new Set<(event: ChatEvent) => void>();
  const sent: AdapterControl['sentMessages'] = [];
  const interrupts: AdapterControl['interrupts'] = [];

  const adapter: ChatAdapter = {
    async fetchHistory(_taskId, _opts) {
      return {
        messages: initialHistory,
        hasMoreBefore: false,
        oldestMessageId: initialHistory[0]?.id ?? null,
      };
    },
    subscribe(_taskId, handler) {
      handlers.add(handler);
      // Simulate WS connected state.
      queueMicrotask(() => handler({ type: 'connection_state', state: 'connected' }));
      return {
        unsubscribe() {
          handlers.delete(handler);
        },
      };
    },
    async sendMessage(taskId, input) {
      sent.push({ taskId, input });
      const message: Message = {
        id: `srv:${sent.length}`,
        taskId,
        role: input.role ?? 'sdk',
        content: input.content,
        metadata: input.metadata ?? null,
        attachments: [],
        createdAt: new Date().toISOString(),
      };
      return message;
    },
    async interrupt(taskId, opts) {
      interrupts.push({ taskId, targetReplyTo: opts.targetReplyTo });
    },
  };

  return {
    adapter,
    pushEvent(event) {
      for (const h of handlers) h(event);
    },
    sentMessages: sent,
    interrupts,
  };
}

/**
 * Drain the microtask queue. Many of the integration tests below dispatch a
 * promise-based action (sendMessage, fetchHistory) and need to wait for
 * resulting state updates to flush before asserting. Awaiting two empty
 * promises is enough to settle the await→dispatch→re-render chain that
 * happens entirely on the microtask queue.
 *
 * Centralised here so the send + re-subscribe tests use one consistent
 * synchronisation idiom rather than ad-hoc `await Promise.resolve()` chains.
 */
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Set the value of a controlled textarea such that React's internal value
 * tracker registers the change. Needed because plain `el.value = 'x'` doesn't
 * fire the React onChange handler when React is tracking the input.
 */
function setReactTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  );
  proto?.set?.call(el, value);
}

/** Mount a component into a fresh container, returning teardown. */
async function mount(ui: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  // Give one extra microtask flush so the initial fetchHistory / subscribe
  // pipelines settle before the test asserts.
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('<ChatView /> integration', () => {
  it('hydrates initial history from adapter.fetchHistory', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'm_old',
        taskId: 't_1',
        role: 'user',
        content: 'Hello?',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
      {
        id: 'm_old2',
        taskId: 't_1',
        role: 'assistant',
        content: 'Hi there',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:01Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={ctl.adapter} />,
    );

    const bubbles = container.querySelectorAll('.conductor-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].textContent).toBe('Hello?');
    expect(bubbles[1].textContent).toBe('Hi there');

    await unmount();
  });

  it('renders message_appended events from subscribe', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={ctl.adapter} />,
    );

    await act(async () => {
      ctl.pushEvent({
        type: 'message_appended',
        message: {
          id: 'm_live',
          taskId: 't_1',
          role: 'assistant',
          content: 'live reply',
          metadata: null,
          attachments: [],
          createdAt: '2026-05-17T00:01:00Z',
        },
      });
    });

    const bubbles = container.querySelectorAll('.conductor-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toBe('live reply');
    await unmount();
  });

  it('renders runtime_status thinking indicator + status line', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView
        taskId="t_1"
        adapter={ctl.adapter}
        labels={{ statusThinking: '正在思考…' }}
      />,
    );

    await act(async () => {
      ctl.pushEvent({
        type: 'runtime_status',
        status: {
          taskId: 't_1',
          state: 'thinking',
          replyInProgress: true,
          replyTo: 'r_42',
        },
      });
    });

    const indicator = container.querySelector('.conductor-runtime-indicator--active');
    expect(indicator).not.toBeNull();
    const text = container.querySelector('.conductor-runtime-text')?.textContent;
    expect(text).toBe('正在思考…');
    await unmount();
  });

  it('shows interrupt button while reply is in progress and calls adapter.interrupt', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={ctl.adapter} />,
    );

    await act(async () => {
      ctl.pushEvent({
        type: 'runtime_status',
        status: {
          taskId: 't_1',
          state: 'thinking',
          replyInProgress: true,
          replyTo: 'r_42',
        },
      });
    });

    const interruptButton = container.querySelector(
      '.conductor-button--interrupt',
    ) as HTMLButtonElement | null;
    expect(interruptButton).not.toBeNull();

    await act(async () => {
      interruptButton!.click();
    });
    expect(ctl.interrupts).toHaveLength(1);
    expect(ctl.interrupts[0]).toEqual({ taskId: 't_1', targetReplyTo: 'r_42' });

    await unmount();
  });

  it('sends a message: optimistic insert → server confirm replaces id', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={ctl.adapter} />,
    );
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const sendBtn = container.querySelector(
      '.conductor-button--send',
    ) as HTMLButtonElement;
    expect(textarea).not.toBeNull();
    expect(sendBtn).not.toBeNull();

    // Setting .value directly doesn't fire React's tracked-value onChange in
    // React 19 — we have to use the underlying property setter so React's
    // value-tracker sees the change. This is the standard workaround when
    // not pulling in @testing-library/react.
    await act(async () => {
      setReactTextareaValue(textarea, 'first');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendBtn.click();
      // Allow the await sendMessage() inside the reducer to resolve.
      await flushPromises();
    });

    expect(ctl.sentMessages).toHaveLength(1);
    expect(ctl.sentMessages[0].input.content).toBe('first');
    expect(typeof ctl.sentMessages[0].input.clientRequestId).toBe('string');

    // After confirm, the only visible bubble should be the server-id one,
    // not the optimistic 'pending:' one.
    const bubbles = container.querySelectorAll('[data-message-id]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].getAttribute('data-message-id')).toMatch(/^srv:/);

    await unmount();
  });

  it('propagates ChatEventError details/cause from task_failed into chat state (V3 M3)', async () => {
    // Regression: the TASK_FAILED dispatch previously stripped
    // `details` / `cause` from ChatEventError, defeating the purpose of
    // Round 2 M9 (which extended the wire shape to carry them). The store
    // must forward both to host UIs.
    const ctl = makeMockAdapter();
    let captured: { code?: string; details?: unknown; cause?: unknown } | null = null;
    function ErrorProbe() {
      const { state } = useChat();
      if (state.error) {
        captured = {
          code: state.error.code,
          details: state.error.details,
          cause: state.error.cause,
        };
      }
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChatProvider taskId="t_err" adapter={ctl.adapter}>
          <ErrorProbe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const originalCause = new Error('boom');
    await act(async () => {
      ctl.pushEvent({
        type: 'task_failed',
        taskId: 't_err',
        error: {
          code: 'subscribe_failed',
          message: 'died',
          details: { requestId: 'rq_42', extra: 'info' },
          cause: originalCause,
        },
      });
    });

    expect(captured).not.toBeNull();
    expect(captured!.code).toBe('subscribe_failed');
    expect(captured!.details).toEqual({ requestId: 'rq_42', extra: 'info' });
    expect(captured!.cause).toBe(originalCause);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('applies theme prop as CSS variables on the root', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView
        taskId="t_theme"
        adapter={ctl.adapter}
        theme={{ accent: '#abcdef' }}
      />,
    );
    const root = container.querySelector(
      '[data-task-id="t_theme"]',
    ) as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root!.style.getPropertyValue('--accent')).toBe('#abcdef');
    await unmount();
  });

  it('history catch-up after runtime_status replyInProgress true→false displays the message', async () => {
    // Regression for the "AI reply doesn't show up until refresh" issue:
    // simulate a deployment where the final message_appended is lost in the
    // realtime path but the row is in DB. The catch-up triggered on the
    // runtime_status flip should pull it via fetchHistory and surface it.
    const handlers = new Set<(event: ChatEvent) => void>();
    let fetchHistoryCalls = 0;
    const adapter: ChatAdapter = {
      async fetchHistory(_taskId, _opts) {
        fetchHistoryCalls += 1;
        // First call: initial hydration — no messages yet.
        // Subsequent calls (the catch-up): include the late assistant reply.
        if (fetchHistoryCalls === 1) {
          return { messages: [], hasMoreBefore: false, oldestMessageId: null };
        }
        return {
          messages: [
            {
              id: 'm_late_reply',
              taskId: 't_1',
              role: 'assistant',
              content: 'recovered via catch-up',
              metadata: null,
              attachments: [],
              createdAt: '2026-05-17T00:00:05Z',
            },
          ],
          hasMoreBefore: false,
          oldestMessageId: 'm_late_reply',
        };
      },
      subscribe(_taskId, handler) {
        handlers.add(handler);
        queueMicrotask(() =>
          handler({ type: 'connection_state', state: 'connected' }),
        );
        return {
          unsubscribe() {
            handlers.delete(handler);
          },
        };
      },
      async sendMessage() {
        throw new Error('not used');
      },
      async interrupt() {
        /* noop */
      },
    };

    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={adapter} />,
    );

    // No bubbles initially.
    expect(container.querySelectorAll('.conductor-bubble')).toHaveLength(0);

    // Push the runtime_status flip that the realtime path actually does
    // emit reliably. The final message_appended never arrives via realtime
    // — this models the broken realtime path. Catch-up must recover it.
    await act(async () => {
      for (const h of handlers) {
        h({
          type: 'runtime_status',
          status: { taskId: 't_1', state: 'thinking', replyInProgress: true },
        });
      }
    });
    await act(async () => {
      for (const h of handlers) {
        h({
          type: 'runtime_status',
          status: { taskId: 't_1', state: 'idle', replyInProgress: false },
        });
      }
    });

    // Wait for the 500ms scheduled catch-up + fetch resolution.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    // The catch-up must have run and the recovered message must render.
    expect(fetchHistoryCalls).toBeGreaterThanOrEqual(2);
    const bubbles = container.querySelectorAll('.conductor-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toBe('recovered via catch-up');

    await unmount();
  });

  it('catch-up dedupes against a message_appended already received in real time', async () => {
    // The real-time path delivered the assistant reply correctly; the
    // catch-up triggered on task_finished pulls history that contains the
    // same id. The reducer's id-keyed dedup must keep the UI to exactly
    // one bubble.
    const handlers = new Set<(event: ChatEvent) => void>();
    let fetchHistoryCalls = 0;
    const sharedMessage = {
      id: 'm_realtime',
      taskId: 't_1',
      role: 'assistant',
      content: 'arrived once',
      metadata: null,
      attachments: [],
      createdAt: '2026-05-17T00:00:03Z',
    } as const;
    const adapter: ChatAdapter = {
      async fetchHistory() {
        fetchHistoryCalls += 1;
        if (fetchHistoryCalls === 1) {
          return { messages: [], hasMoreBefore: false, oldestMessageId: null };
        }
        return {
          messages: [{ ...sharedMessage }],
          hasMoreBefore: false,
          oldestMessageId: sharedMessage.id,
        };
      },
      subscribe(_taskId, handler) {
        handlers.add(handler);
        return {
          unsubscribe() {
            handlers.delete(handler);
          },
        };
      },
      async sendMessage() {
        throw new Error('not used');
      },
      async interrupt() {
        /* noop */
      },
    };

    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={adapter} />,
    );

    // Real-time delivery first.
    await act(async () => {
      for (const h of handlers) {
        h({ type: 'message_appended', message: { ...sharedMessage } });
      }
    });
    expect(container.querySelectorAll('.conductor-bubble')).toHaveLength(1);

    // Then terminal event triggers a catch-up that pulls the same message.
    await act(async () => {
      for (const h of handlers) {
        h({ type: 'task_finished', taskId: 't_1' });
      }
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    // Still exactly one bubble — dedup-by-id kept the duplicate out.
    const bubbles = container.querySelectorAll('.conductor-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toBe('arrived once');

    await unmount();
  });
});

describe('<ChatProvider /> context value freshness', () => {
  it('useChat().taskId updates when the taskId prop changes (regression for stale ref)', async () => {
    const ctl = makeMockAdapter();
    let observed: string | null = null;
    function Probe() {
      observed = useChat().taskId;
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ChatProvider taskId="t1" adapter={ctl.adapter}>
          <Probe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(observed).toBe('t1');

    await act(async () => {
      root.render(
        <ChatProvider taskId="t2" adapter={ctl.adapter}>
          <Probe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(observed).toBe('t2');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('adapter swap does NOT re-subscribe until taskId changes (regression: inline adapter loop)', async () => {
    // V3 contract: changing the adapter prop while keeping the same taskId
    // does NOT tear down + re-establish the subscription. The previous
    // behaviour caused infinite loops for integrators who created their
    // adapter inline (`<ChatView adapter={createRestAdapter({...})} />`).
    //
    // Adapter changes are still honoured for imperative actions
    // (send / interrupt / loadEarlier) via adapterRef, and the next
    // taskId-driven re-subscribe will use the latest adapter.
    const ctl1 = makeMockAdapter();
    const ctl2 = makeMockAdapter();
    function Probe() {
      useChat();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let subscribeCallCount = 0;
    const origSubscribe1 = ctl1.adapter.subscribe;
    ctl1.adapter.subscribe = (taskId, handler) => {
      subscribeCallCount += 1;
      return origSubscribe1(taskId, handler);
    };
    const origSubscribe2 = ctl2.adapter.subscribe;
    ctl2.adapter.subscribe = (taskId, handler) => {
      subscribeCallCount += 1;
      return origSubscribe2(taskId, handler);
    };

    await act(async () => {
      root.render(
        <ChatProvider taskId="t1" adapter={ctl1.adapter}>
          <Probe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(subscribeCallCount).toBe(1);

    // Swap adapter while keeping taskId — must NOT re-subscribe.
    await act(async () => {
      root.render(
        <ChatProvider taskId="t1" adapter={ctl2.adapter}>
          <Probe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(subscribeCallCount).toBe(1);

    // Change taskId — that DOES re-subscribe, using the latest adapter (ctl2).
    await act(async () => {
      root.render(
        <ChatProvider taskId="t2" adapter={ctl2.adapter}>
          <Probe />
        </ChatProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(subscribeCallCount).toBe(2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('inline adapter on every render does NOT cause re-subscribe loop (regression)', async () => {
    // The pre-V3 deps `[taskId, adapter]` caused integrators who wrote
    // `<ChatView adapter={createRestAdapter({...})} />` to re-subscribe on
    // every render — infinite loops when a parent state change re-rendered
    // the tree. We now key the subscribe effect on taskId only; this test
    // pins the count to <5 across several renders.
    function makeFreshAdapter(): ChatAdapter {
      return {
        async fetchHistory() {
          return { messages: [], hasMoreBefore: false, oldestMessageId: null };
        },
        subscribe(_taskId, _handler) {
          return { unsubscribe() {} };
        },
        async sendMessage(taskId, input) {
          return {
            id: 's:1',
            taskId,
            role: 'user',
            content: input.content,
            metadata: null,
            attachments: [],
            createdAt: new Date().toISOString(),
          };
        },
        async interrupt() {},
      };
    }

    let subscribeCallCount = 0;
    const wrapAdapter = (a: ChatAdapter): ChatAdapter => ({
      ...a,
      subscribe(taskId, handler) {
        subscribeCallCount += 1;
        return a.subscribe(taskId, handler);
      },
    });

    function Probe() {
      useChat();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Render the same taskId 6 times, each with a freshly-created adapter
    // (mimics what `<ChatView adapter={createRestAdapter({...})} />` does
    // when the parent re-renders).
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        root.render(
          <ChatProvider taskId="t_stable" adapter={wrapAdapter(makeFreshAdapter())}>
            <Probe />
          </ChatProvider>,
        );
      });
      await act(async () => {
        await flushPromises();
      });
    }

    // Must NOT have re-subscribed on every render. Allow tiny slack for
    // React StrictMode-style double invocations.
    expect(subscribeCallCount).toBeLessThan(5);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
