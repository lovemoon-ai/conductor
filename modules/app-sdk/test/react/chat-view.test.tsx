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
import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ChatView, createRestAdapter } from '../../src/react/index.js';
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

// Scroll position + composer drafts now persist in sessionStorage keyed by
// taskId; clear between tests so per-task state from one test can't leak into
// the next (several reuse short taskIds).
beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

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

  it('renders default plain-text content when renderMessageContent is not provided', async () => {
    // Regression guard: existing consumers that never set the new prop must
    // keep getting the v0.1 plain-text rendering. Specifically, content with
    // markdown-looking characters (`**bold**`) must NOT be parsed — it must
    // come through as literal text.
    const ctl = makeMockAdapter([
      {
        id: 'm_plain',
        taskId: 't_1',
        role: 'assistant',
        content: '**hello** _world_',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_1" adapter={ctl.adapter} />,
    );

    const bubble = container.querySelector('.conductor-bubble');
    expect(bubble).not.toBeNull();
    // Literal characters preserved; no <strong> / <em> elements injected.
    expect(bubble!.textContent).toBe('**hello** _world_');
    expect(bubble!.querySelector('strong')).toBeNull();
    expect(bubble!.querySelector('em')).toBeNull();
    await unmount();
  });

  it('uses renderMessageContent to replace bubble inner content', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'm_md',
        taskId: 't_1',
        role: 'assistant',
        content: '**bold** text',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);

    // Fake "markdown" renderer — emits a <strong> element if the content
    // starts with `**`. Realistic enough to verify the slot is wired in
    // without pulling react-markdown into the test dependencies.
    const renderMessageContent = (m: Message) => {
      const match = /^\*\*(.+?)\*\*\s*(.*)$/.exec(m.content);
      if (!match) return m.content;
      return (
        <>
          <strong data-testid={`md-strong-${m.id}`}>{match[1]}</strong>
          {match[2] ? ` ${match[2]}` : null}
        </>
      );
    };

    const { container, unmount } = await mount(
      <ChatView
        taskId="t_1"
        adapter={ctl.adapter}
        renderMessageContent={renderMessageContent}
      />,
    );

    const bubble = container.querySelector('.conductor-bubble');
    expect(bubble).not.toBeNull();
    // The bubble container itself is still owned by the SDK — same class /
    // structure as the default render.
    expect(bubble!.closest('.conductor-message')).not.toBeNull();
    // But the inner content was replaced by our custom renderer.
    const strong = bubble!.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('bold');
    expect(strong!.getAttribute('data-testid')).toBe('md-strong-m_md');
    expect(bubble!.textContent).toBe('bold text');
    await unmount();
  });

  it('renderMessageContent receives the full Message (role, metadata, attachments)', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'm_with_meta',
        taskId: 't_1',
        role: 'assistant',
        content: 'irrelevant',
        metadata: { audit: { actor: 'fire' } },
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);

    const received: Message[] = [];
    const renderMessageContent = (m: Message) => {
      received.push(m);
      return `[${m.role}] ${m.content}`;
    };

    const { container, unmount } = await mount(
      <ChatView
        taskId="t_1"
        adapter={ctl.adapter}
        renderMessageContent={renderMessageContent}
      />,
    );

    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last.id).toBe('m_with_meta');
    expect(last.role).toBe('assistant');
    // The renderer can branch on metadata too — confirm it's passed through.
    expect(last.metadata).toEqual({ audit: { actor: 'fire' } });

    const bubble = container.querySelector('.conductor-bubble');
    expect(bubble!.textContent).toBe('[assistant] irrelevant');
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

describe('<ChatView /> navigation affordances', () => {
  function historyWithTwoQuestions(): Message[] {
    return [
      {
        id: 'q1',
        taskId: 't_nav',
        role: 'user',
        content: 'first question',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
      {
        id: 'a1',
        taskId: 't_nav',
        role: 'assistant',
        content: 'first answer',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:01Z',
      },
      {
        id: 'q2',
        taskId: 't_nav',
        role: 'user',
        content: 'second question',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:02Z',
      },
    ];
  }

  /** Force jsdom (which reports 0 for all layout metrics) into a scrollable
   * state so the scroll affordances have something to react to. */
  function stubScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  }

  it('double-click on a user bubble opens the action menu with copy + resend', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_menu',
        role: 'user',
        content: 'hello world',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_menu" adapter={ctl.adapter} />,
    );

    // No menu before interaction.
    expect(container.querySelector('[data-testid="conductor-bubble-menu"]')).toBeNull();

    const bubble = container.querySelector(
      '[data-role="user"] .conductor-bubble',
    ) as HTMLElement;
    expect(bubble).not.toBeNull();

    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const menu = container.querySelector('[data-testid="conductor-bubble-menu"]');
    expect(menu).not.toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-copy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-resend"]')).not.toBeNull();

    await unmount();
  });

  it('action menu omits resend for assistant messages', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'a1',
        taskId: 't_menu',
        role: 'assistant',
        content: 'I am the assistant',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_menu" adapter={ctl.adapter} />,
    );

    const bubble = container.querySelector(
      '[data-role="assistant"] .conductor-bubble',
    ) as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="conductor-bubble-menu-copy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-resend"]')).toBeNull();

    await unmount();
  });

  it('copy action writes the message content to the clipboard', async () => {
    const writes: string[] = [];
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text: string) {
          writes.push(text);
        },
      },
    });

    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_copy',
        role: 'user',
        content: 'copy me please',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_copy" adapter={ctl.adapter} />,
    );

    const bubble = container.querySelector(
      '[data-role="user"] .conductor-bubble',
    ) as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const copyBtn = container.querySelector(
      '[data-testid="conductor-bubble-menu-copy"]',
    ) as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
      await flushPromises();
    });

    expect(writes).toEqual(['copy me please']);
    // Feedback label flips to "Copied" before the sheet auto-dismisses.
    expect(copyBtn.textContent).toBe('Copied');

    await unmount();
  });

  it('resend action sends the message content again via the adapter', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_resend',
        role: 'user',
        content: 'do it again',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_resend" adapter={ctl.adapter} />,
    );

    const bubble = container.querySelector(
      '[data-role="user"] .conductor-bubble',
    ) as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const resendBtn = container.querySelector(
      '[data-testid="conductor-bubble-menu-resend"]',
    ) as HTMLButtonElement;
    await act(async () => {
      resendBtn.click();
      await flushPromises();
    });

    expect(ctl.sentMessages).toHaveLength(1);
    expect(ctl.sentMessages[0].input.content).toBe('do it again');
    // Menu closes after the action.
    expect(container.querySelector('[data-testid="conductor-bubble-menu"]')).toBeNull();

    await unmount();
  });

  it('shows the scroll-to-bottom button when scrolled away from the bottom, hides it on click', async () => {
    const ctl = makeMockAdapter(historyWithTwoQuestions());
    const { container, unmount } = await mount(
      <ChatView taskId="t_nav" adapter={ctl.adapter} />,
    );

    const list = container.querySelector('.conductor-message-list') as HTMLElement;
    stubScrollMetrics(list, 1000, 200);
    list.scrollTop = 100; // far from the bottom (max scrollTop = 800)

    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const button = container.querySelector(
      '[data-testid="conductor-scroll-to-bottom"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
    });

    // After jumping to the bottom the button hides itself.
    expect(container.querySelector('[data-testid="conductor-scroll-to-bottom"]')).toBeNull();
    expect(list.scrollTop).toBe(800);

    await unmount();
  });

  it('reveals the question-anchor rail with one dot per user message when scrolling up', async () => {
    const ctl = makeMockAdapter(historyWithTwoQuestions());
    const { container, unmount } = await mount(
      <ChatView taskId="t_nav" adapter={ctl.adapter} />,
    );

    const list = container.querySelector('.conductor-message-list') as HTMLElement;
    stubScrollMetrics(list, 1000, 200);

    // Establish a downward baseline first…
    list.scrollTop = 500;
    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    // …then scroll up to reveal the rail.
    list.scrollTop = 100;
    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const nav = container.querySelector('.conductor-question-nav');
    expect(nav).not.toBeNull();
    expect(nav!.classList.contains('conductor-question-nav--visible')).toBe(true);
    // Two user-side messages → two anchor dots.
    expect(nav!.querySelectorAll('.conductor-question-nav__dot')).toHaveLength(2);

    await unmount();
  });
});

describe('<ChatView /> conductor parity features', () => {
  it('renders an image attachment from the message', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'a1',
        taskId: 't_att',
        role: 'assistant',
        content: 'see image',
        metadata: null,
        attachments: [
          {
            id: 'att1',
            filename: 'pic.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            url: 'https://example.test/pic.png',
          },
        ],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_att" adapter={ctl.adapter} />,
    );

    const img = container.querySelector('.conductor-attachment__image') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.test/pic.png');
    // The bubble text stays clean (attachment is a sibling, not inside it).
    const bubble = container.querySelector('.conductor-bubble');
    expect(bubble!.textContent).toBe('see image');

    await unmount();
  });

  it('renders the "via {app}" origin chip only when showAppOriginChip is set', async () => {
    const history: Message[] = [
      {
        id: 'm_app',
        taskId: 't_origin',
        role: 'assistant',
        content: 'app authored',
        metadata: { audit: { actor: 'app', appDisplayName: 'Acme Bot' } },
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ];

    // Off by default.
    const ctlOff = makeMockAdapter(history);
    const off = await mount(<ChatView taskId="t_origin" adapter={ctlOff.adapter} />);
    expect(off.container.querySelector('.conductor-bubble__origin')).toBeNull();
    await off.unmount();

    // On when requested.
    const ctlOn = makeMockAdapter(history);
    const on = await mount(
      <ChatView taskId="t_origin" adapter={ctlOn.adapter} showAppOriginChip />,
    );
    const chip = on.container.querySelector('.conductor-bubble__origin');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('via Acme Bot');
    await on.unmount();
  });

  it('persists the composer draft per task across remounts', async () => {
    const ctl = makeMockAdapter();
    const first = await mount(<ChatView taskId="t_draft" adapter={ctl.adapter} />);
    const textarea = first.container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      setReactTextareaValue(textarea, 'unsent thoughts');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await first.unmount();

    // Remount the same task — the draft should be restored.
    const ctl2 = makeMockAdapter();
    const second = await mount(<ChatView taskId="t_draft" adapter={ctl2.adapter} />);
    const restored = second.container.querySelector('textarea') as HTMLTextAreaElement;
    expect(restored.value).toBe('unsent thoughts');
    await second.unmount();
  });

  it('ArrowUp recalls the most recent sent prompt into the composer', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_hist',
        role: 'user',
        content: 'an earlier question',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(
      <ChatView taskId="t_hist" adapter={ctl.adapter} />,
    );

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });

    expect(textarea.value).toBe('an earlier question');
    await unmount();
  });

  it('shows a restart button in the empty state when the adapter supports restart', async () => {
    const restarts: Array<{ taskId: string; opts?: { restartMode?: string } }> = [];
    const adapter: ChatAdapter = {
      async fetchHistory() {
        return { messages: [], hasMoreBefore: false, oldestMessageId: null };
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      async sendMessage(taskId, input) {
        return {
          id: 's:1',
          taskId,
          role: input.role ?? 'user',
          content: input.content,
          metadata: null,
          attachments: [],
          createdAt: new Date().toISOString(),
        };
      },
      async interrupt() {},
      async restart(taskId, opts) {
        restarts.push({ taskId, opts });
      },
    };

    const { container, unmount } = await mount(<ChatView taskId="t_restart" adapter={adapter} />);

    const restartBtn = container.querySelector(
      '[data-testid="conductor-empty-restart"]',
    ) as HTMLButtonElement | null;
    expect(restartBtn).not.toBeNull();

    await act(async () => {
      restartBtn!.click();
      await flushPromises();
    });

    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toEqual({ taskId: 't_restart', opts: { restartMode: 'refresh_session' } });

    await unmount();
  });

  it('hides restart affordances when the adapter does not implement restart', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(
      <ChatView taskId="t_norestart" adapter={ctl.adapter} />,
    );
    expect(container.querySelector('[data-testid="conductor-empty-restart"]')).toBeNull();
    await unmount();
  });

  it('auto-loads older history when scrolled to the top', async () => {
    const calls: Array<{ beforeId?: string }> = [];
    const adapter: ChatAdapter = {
      async fetchHistory(_taskId, opts) {
        calls.push({ beforeId: opts?.beforeId });
        if (!opts?.beforeId) {
          return {
            messages: [
              {
                id: 'm1',
                taskId: 't_top',
                role: 'user',
                content: 'newest',
                metadata: null,
                attachments: [],
                createdAt: '2026-05-17T00:00:05Z',
              },
            ],
            hasMoreBefore: true,
            oldestMessageId: 'm1',
          };
        }
        return {
          messages: [
            {
              id: 'm0',
              taskId: 't_top',
              role: 'assistant',
              content: 'older',
              metadata: null,
              attachments: [],
              createdAt: '2026-05-17T00:00:00Z',
            },
          ],
          hasMoreBefore: false,
          oldestMessageId: 'm0',
        };
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      async sendMessage() {
        throw new Error('not used');
      },
      async interrupt() {},
    };

    const { container, unmount } = await mount(<ChatView taskId="t_top" adapter={adapter} />);

    const list = container.querySelector('.conductor-message-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    list.scrollTop = 0; // at the very top

    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await flushPromises();
    });

    // First call = initial hydrate (no beforeId); a later call paginated with
    // before_id = the oldest message id.
    expect(calls.some((c) => c.beforeId === 'm1')).toBe(true);

    await unmount();
  });

  it('offers an interrupt action in the bubble menu while a reply is in progress', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_int',
        role: 'user',
        content: 'go',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    const { container, unmount } = await mount(<ChatView taskId="t_int" adapter={ctl.adapter} />);

    await act(async () => {
      ctl.pushEvent({
        type: 'runtime_status',
        status: { taskId: 't_int', state: 'thinking', replyInProgress: true, replyTo: 'r_9' },
      });
    });

    const bubble = container.querySelector('[data-role="user"] .conductor-bubble') as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const interruptItem = container.querySelector(
      '[data-testid="conductor-bubble-menu-interrupt"]',
    ) as HTMLButtonElement | null;
    expect(interruptItem).not.toBeNull();

    await act(async () => {
      interruptItem!.click();
      await flushPromises();
    });

    expect(ctl.interrupts).toHaveLength(1);
    expect(ctl.interrupts[0]).toEqual({ taskId: 't_int', targetReplyTo: 'r_9' });

    await unmount();
  });
});

describe('<ChatView /> review fixes (F1–F5)', () => {
  it('F1: createRestAdapter omits restart() by default, exposes it when enabled', () => {
    expect(typeof createRestAdapter({ baseUrl: '/api' }).restart).toBe('undefined');
    expect(typeof createRestAdapter({ baseUrl: '/api', enableRestart: true }).restart).toBe(
      'function',
    );
  });

  it('F2: Shift+Enter does not send; plain Enter does', async () => {
    const ctl = makeMockAdapter();
    const { container, unmount } = await mount(<ChatView taskId="t_se" adapter={ctl.adapter} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      setReactTextareaValue(ta, 'line one');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(ctl.sentMessages).toHaveLength(0); // Shift+Enter must not send

    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushPromises();
    });
    expect(ctl.sentMessages).toHaveLength(1);
    expect(ctl.sentMessages[0].input.content).toBe('line one');

    await unmount();
  });

  it('F3: a user message from another client does not yank a scrolled-up reader', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_f3',
        role: 'user',
        content: 'first',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
      {
        id: 'a1',
        taskId: 't_f3',
        role: 'assistant',
        content: 'reply',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:01Z',
      },
    ]);
    const { container, unmount } = await mount(<ChatView taskId="t_f3" adapter={ctl.adapter} />);

    const list = container.querySelector('.conductor-message-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    list.scrollTop = 100; // scrolled up, not stuck to bottom (max = 800)
    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Remote user message — a real id, NOT an optimistic `pending:` id.
    await act(async () => {
      ctl.pushEvent({
        type: 'message_appended',
        message: {
          id: 'remote_user',
          taskId: 't_f3',
          role: 'user',
          content: 'from another tab',
          metadata: null,
          attachments: [],
          createdAt: '2026-05-17T00:00:02Z',
        },
      });
    });

    // Reader stays put — not snapped to the bottom (800).
    expect(list.scrollTop).toBe(100);

    await unmount();
  });

  it('F4: readOnly hides the composer interrupt button and mutating menu actions', async () => {
    const ctl = makeMockAdapter([
      {
        id: 'q1',
        taskId: 't_ro',
        role: 'user',
        content: 'hi',
        metadata: null,
        attachments: [],
        createdAt: '2026-05-17T00:00:00Z',
      },
    ]);
    // Adapter supports restart so we can confirm it's hidden under readOnly too.
    (ctl.adapter as { restart?: unknown }).restart = async () => {};

    const { container, unmount } = await mount(
      <ChatView taskId="t_ro" adapter={ctl.adapter} readOnly />,
    );

    await act(async () => {
      ctl.pushEvent({
        type: 'runtime_status',
        status: { taskId: 't_ro', state: 'thinking', replyInProgress: true, replyTo: 'r1' },
      });
    });

    // Composer interrupt is hidden in read-only mode.
    expect(container.querySelector('.conductor-button--interrupt')).toBeNull();

    // The action menu still opens (and copy works), but mutating actions are gone.
    const bubble = container.querySelector('[data-role="user"] .conductor-bubble') as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="conductor-bubble-menu-copy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-resend"]')).toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-interrupt"]')).toBeNull();
    expect(container.querySelector('[data-testid="conductor-bubble-menu-restart"]')).toBeNull();

    await unmount();
  });
});
