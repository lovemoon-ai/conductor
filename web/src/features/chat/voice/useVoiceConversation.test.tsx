import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/shared/types';

const mic = vi.hoisted(() => ({ onChunk: null as null | ((pcm: ArrayBuffer, rms: number) => void), stop: vi.fn(), opened: 0 }));
const players = vi.hoisted(() => [] as Array<{ pushed: Uint8Array[]; idle: boolean; onIdle: null | (() => void) }>);

vi.mock('./mic-capture', () => ({
  MIC_SAMPLE_RATE: 16_000,
  startMicCapture: vi.fn(async (onChunk: (pcm: ArrayBuffer, rms: number) => void) => {
    mic.onChunk = onChunk;
    mic.opened += 1;
    return { stop: mic.stop };
  }),
}));
vi.mock('./pcm-player', () => ({
  PcmStreamPlayer: class {
    pushed: Uint8Array[] = [];
    idle = true;
    onIdle: null | (() => void) = null;
    constructor() {
      players.push(this);
    }
    unlock() {}
    push(chunk: Uint8Array) {
      this.pushed.push(chunk);
      this.idle = false;
    }
    stop() {
      this.idle = true;
    }
    close() {}
  },
}));
vi.mock('@/features/realtime', () => ({
  resolveAppWebSocketUrl: (token: string) => `ws://host/ws/app?token=${token}`,
}));
vi.mock('@/lib/auth/token-storage', () => ({ getStoredJwtToken: () => 'jwt-1' }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  binaryType = '';
  onopen: null | (() => void) = null;
  onmessage: null | ((event: { data: string }) => void) = null;
  onclose: null | (() => void) = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(envelope: unknown) {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

const { useVoiceConversation } = await import('./useVoiceConversation');

const reply = (id: string, content: string): Message => ({
  id, taskId: 't1', role: 'sdk', content, metadata: { reply_to: 'u1' },
});

describe('useVoiceConversation', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    players.length = 0;
    mic.opened = 0;
    mic.stop.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setup = (
    onSend: (text: string) => unknown = vi.fn(),
    extra: { onKeepText?: (text: string) => void; userToken?: string | null } = {},
  ) => renderHook(
    (props: { messages: Message[]; replyInProgress: boolean }) => useVoiceConversation({
      taskId: 't1', userToken: 'user-token', onSend: onSend as never, ...extra, ...props,
    }),
    { initialProps: { messages: [reply('old', '旧回复')], replyInProgress: false } },
  );
  type Hook = ReturnType<typeof setup>;
  const lastSocket = () => FakeSocket.instances.at(-1)!;

  /** Tap, speak, tap, get `text` back: the message is sent and voice mode waits for the reply. */
  const talk = async (hook: Hook, text = '跑一下测试。') => {
    await act(async () => hook.result.current.toggle());
    expect(hook.result.current.phase).toBe('recording');
    act(() => lastSocket().open());
    act(() => hook.result.current.toggle());
    await act(async () => lastSocket().receive({ type: 'result', payload: { text } }));
  };

  it('records from the first tap to the second tap; pauses never send', async () => {
    const onSend = vi.fn();
    const hook = setup(onSend);
    const { result } = hook;
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe('recording');
    const socket = lastSocket();
    expect(socket.url).toBe('ws://host/ws/speech?token=user-token');

    act(() => mic.onChunk!(new ArrayBuffer(3200), 0.2)); // before the socket opens: buffered
    act(() => socket.open());
    expect(socket.sent[0]).toBe(JSON.stringify({ type: 'start', payload: { sample_rate: 16_000, tts_prewarm: true } }));
    act(() => mic.onChunk!(new ArrayBuffer(3200), 0.001)); // silence is still sent
    expect(socket.sent.slice(1)).toHaveLength(2);
    expect(socket.sent.slice(1).every((chunk) => chunk instanceof ArrayBuffer)).toBe(true);

    // Doubao flags a pause: keep recording.
    act(() => socket.receive({ type: 'partial', payload: { text: '跑一下', endpoint: true } }));
    expect(result.current.phase).toBe('recording');
    expect(result.current.partial).toBe('跑一下');
    expect(socket.sent.at(-1)).not.toBe(JSON.stringify({ type: 'finish' }));

    act(() => result.current.toggle());
    expect(result.current.phase).toBe('recognizing');
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'finish' }));
    expect(mic.stop).toHaveBeenCalled();

    await act(async () => socket.receive({ type: 'result', payload: { text: '跑一下，然后提交。' } }));
    expect(onSend).toHaveBeenCalledWith('跑一下，然后提交。');
    expect(result.current.phase).toBe('waiting');
  });

  it('reads new AI replies aloud, then waits for the next tap without reopening the mic', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal('fetch', fetchSpy);
    const hook = setup();
    const { result, rerender } = hook;
    await talk(hook);

    await act(async () => rerender({
      messages: [reply('old', '旧回复'), reply('r1', '已完成，**测试**全部通过。\n```\nlog\n```')],
      replyInProgress: true,
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/speech/synthesize');
    expect(JSON.parse(String(init.body))).toEqual({ text: '已完成，测试全部通过。', format: 'pcm' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(players[0].pushed).toHaveLength(1);
    expect(result.current.phase).toBe('speaking');

    await act(async () => rerender({ messages: [reply('old', '旧回复'), reply('r1', 'x')], replyInProgress: false }));
    expect(result.current.phase).toBe('speaking'); // still playing
    await act(async () => {
      players[0].idle = true;
      players[0].onIdle?.();
    });
    expect(result.current.phase).toBe('idle');
    expect(mic.opened).toBe(1);

    await act(async () => result.current.toggle()); // next message
    expect(result.current.phase).toBe('recording');
    expect(mic.opened).toBe(2);
  });

  it('does not read replies aloud while the user is recording', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    vi.stubGlobal('fetch', fetchSpy);
    const hook = setup();
    const { result, rerender } = hook;
    await act(async () => result.current.toggle());
    act(() => lastSocket().open());
    await act(async () => rerender({ messages: [reply('r1', '先说一句。')], replyInProgress: true }));
    expect(result.current.phase).toBe('recording');
    expect(players[0].pushed).toHaveLength(0);

    act(() => result.current.toggle());
    await act(async () => lastSocket().receive({ type: 'result', payload: { text: '好的' } }));
    await act(async () => {});
    expect(players[0].pushed).toHaveLength(1);
  });

  it('turns voice mode off when the message could not be sent', async () => {
    const onSend = vi.fn(async () => false);
    const hook = setup(onSend);
    await talk(hook);
    expect(onSend).toHaveBeenCalledWith('跑一下测试。');
    expect(hook.result.current.phase).toBe('off');
    expect(hook.result.current.error).toMatch(/Not sent/);
  });

  it('goes back to idle when nothing was recognized', async () => {
    const onSend = vi.fn();
    const hook = setup(onSend);
    await talk(hook, '  ');
    expect(onSend).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.error).toMatch(/Didn't catch/);
  });

  it('synthesizes the next reply while the current one is still playing', async () => {
    let releaseFirst!: () => void;
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const { text } = JSON.parse(String(init.body)) as { text: string };
      if (text !== '第一段。') return new Response(new Uint8Array([9, 9]));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 1]));
          releaseFirst = () => controller.close();
        },
      }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = setup();
    await talk(hook);
    await act(async () => hook.rerender({
      messages: [reply('r1', '第一段。'), reply('r2', '第二段。'), reply('r3', '第三段。'), reply('r4', '第四段。')],
      replyInProgress: true,
    }));
    // r1 is still streaming, yet r2 and r3 are already being synthesized; r4 waits.
    const texts = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init.body)).text);
    expect(texts()).toEqual(['第一段。', '第二段。', '第三段。']);
    expect(players[0].pushed.map((chunk) => [...chunk])).toEqual([[1, 1]]);

    await act(async () => releaseFirst());
    await act(async () => {});
    expect(texts()).toEqual(['第一段。', '第二段。', '第三段。', '第四段。']);
    expect(players[0].pushed.map((chunk) => [...chunk])).toEqual([[1, 1], [9, 9], [9, 9], [9, 9]]);
  });

  it('tapping while it speaks interrupts, skips the rest of the turn and starts recording', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
    }));
    const hook = setup();
    const { result, rerender } = hook;
    await talk(hook);
    await act(async () => rerender({ messages: [reply('r1', '一。'), reply('r2', '二。')], replyInProgress: true }));
    expect(result.current.phase).toBe('speaking');
    expect(signals).toHaveLength(2);

    await act(async () => result.current.toggle());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.current.phase).toBe('recording');
    await act(async () => rerender({ messages: [reply('r1', '一。'), reply('r2', '二。'), reply('r3', '三。')], replyInProgress: true }));
    expect(signals).toHaveLength(2); // muted for the rest of the interrupted turn
  });

  it('a typed message after a ■ interrupt is read aloud again', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchSpy);
    const hook = setup();
    const { result, rerender } = hook;
    await talk(hook);
    await act(async () => rerender({ messages: [reply('r1', '一。')], replyInProgress: true }));
    expect(result.current.phase).toBe('speaking');
    await act(async () => result.current.toggle()); // ■, then the user types instead of talking
    act(() => result.current.cancel());
    const typed: Message = { id: 'u2', taskId: 't1', role: 'user', content: '打字问一句' };
    await act(async () => rerender({ messages: [reply('r1', '一。'), typed, reply('r2', '二。')], replyInProgress: true }));
    const texts = fetchSpy.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).text);
    expect(texts).toEqual(['一。', '二。']);
  });

  it('keeps what was heard in the composer, unsent, when recognition fails part-way', async () => {
    const onSend = vi.fn();
    const onKeepText = vi.fn();
    const hook = setup(onSend, { onKeepText });
    await act(async () => hook.result.current.toggle());
    const socket = lastSocket();
    act(() => socket.open());
    act(() => socket.receive({ type: 'partial', payload: { text: '帮我把' } }));
    await act(async () => socket.receive({
      type: 'error',
      payload: { message: 'speech transcription failed', detail: 'volc asr connection closed early', text: '帮我把' },
    }));
    expect(onKeepText).toHaveBeenCalledWith('帮我把');
    expect(onSend).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.error).toMatch(/input box/);
    expect(mic.stop).toHaveBeenCalled();
  });

  it('does not open audio when there is no sign-in token', async () => {
    const hook = setup(vi.fn(), { userToken: null });
    await act(async () => hook.result.current.toggle());
    await act(async () => hook.result.current.toggle());
    expect(players).toHaveLength(0);
    expect(hook.result.current.phase).toBe('off');
    expect(hook.result.current.error).toMatch(/Sign in/);
  });

  it('✕ discards the recording without sending', async () => {
    const onSend = vi.fn();
    const hook = setup(onSend);
    await act(async () => hook.result.current.toggle());
    const socket = lastSocket();
    act(() => socket.open());
    act(() => socket.receive({ type: 'partial', payload: { text: '说错了' } }));
    expect(hook.result.current.recordingSince).toEqual(expect.any(Number));
    act(() => hook.result.current.cancel());
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'cancel' }));
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.partial).toBe('');
    expect(hook.result.current.recordingSince).toBeNull();
    expect(mic.stop).toHaveBeenCalled();
    await act(async () => socket.receive({ type: 'result', payload: { text: '说错了' } }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('streams the mic level to subscribers and drops it to 0 on send', async () => {
    const hook = setup();
    const levels: number[] = [];
    act(() => { hook.result.current.subscribeLevel((level) => levels.push(level)); });
    await act(async () => hook.result.current.toggle());
    act(() => {
      mic.onChunk!(new ArrayBuffer(3200), 0);
      mic.onChunk!(new ArrayBuffer(3200), 0.3);
      mic.onChunk!(new ArrayBuffer(3200), 0.6);
    });
    expect(levels.slice(-3)).toEqual([0, 1, 1]);
    act(() => mic.onChunk!(new ArrayBuffer(3200), 0.075));
    expect(levels.at(-1)).toBeCloseTo(0.5);
    act(() => hook.result.current.toggle());
    expect(levels.at(-1)).toBe(0);
  });

  it('exit turns voice mode off and releases the mic', async () => {
    const hook = setup();
    await act(async () => hook.result.current.toggle());
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('off');
    expect(mic.stop).toHaveBeenCalled();
  });
});
