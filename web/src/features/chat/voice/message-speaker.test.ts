import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const players = vi.hoisted(() => [] as Array<{ pushed: Uint8Array[]; idle: boolean; closed: boolean; onIdle: null | (() => void) }>);

vi.mock('./pcm-player', () => ({
  PcmStreamPlayer: class {
    pushed: Uint8Array[] = [];
    idle = true;
    closed = false;
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
    close() {
      this.closed = true;
    }
  },
}));
vi.mock('@/lib/auth/token-storage', () => ({ getStoredJwtToken: () => 'jwt-1' }));

const { MAX_MESSAGE_SPEECH_CHARS, onMessageSpeechStart, speakMessage, splitForSpeech, stopMessageSpeech, toggleMessageSpeech, useMessageSpeakerStore } = await import('./message-speaker');

describe('splitForSpeech', () => {
  it('keeps short text whole and cuts long text at sentence ends', () => {
    expect(splitForSpeech('你好。')).toEqual(['你好。']);
    const parts = splitForSpeech('一二三四。五六七八。九十', 6);
    expect(parts).toEqual(['一二三四。', '五六七八。', '九十']);
    expect(splitForSpeech('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});

describe('message speaker', () => {
  const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));

  beforeEach(() => {
    players.length = 0;
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    stopMessageSpeech();
    vi.unstubAllGlobals();
  });

  it('synthesizes the whole message and plays it, then goes quiet', async () => {
    await speakMessage('m1', '**你好**，这是 `conductor` 的回复。');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/speech/synthesize');
    expect(JSON.parse(init.body as string)).toEqual({ text: '你好，这是 conductor 的回复。', format: 'pcm' });
    expect(players[0].pushed).toHaveLength(1);
    expect(useMessageSpeakerStore.getState()).toMatchObject({ messageId: 'm1', status: 'playing' });

    players[0].idle = true;
    players[0].onIdle?.();
    expect(useMessageSpeakerStore.getState()).toMatchObject({ messageId: null, status: 'idle' });
    expect(players[0].closed).toBe(true);
  });

  it('toggling the playing message stops it; another message replaces it', async () => {
    await speakMessage('m1', '第一条。');
    toggleMessageSpeech('m1', '第一条。');
    expect(useMessageSpeakerStore.getState().messageId).toBeNull();
    expect(players[0].closed).toBe(true);

    await speakMessage('m1', '第一条。');
    await speakMessage('m2', '第二条。');
    expect(players[1].closed).toBe(true);
    expect(useMessageSpeakerStore.getState().messageId).toBe('m2');
  });

  it('tells listeners (voice mode) when a message starts, and caps very long messages', async () => {
    const listener = vi.fn();
    const unsubscribe = onMessageSpeechStart(listener);
    await speakMessage('m1', '很长的一句话。'.repeat(3_000));
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    const texts = fetchSpy.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).text as string);
    const total = texts.join('').length;
    expect(total).toBeLessThanOrEqual(MAX_MESSAGE_SPEECH_CHARS + 2);
    expect(total).toBeGreaterThan(MAX_MESSAGE_SPEECH_CHARS / 2);
  });

  it('reports synthesis failures', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'speech synthesis is not configured' }), { status: 503 }));
    await speakMessage('m1', '你好。');
    expect(useMessageSpeakerStore.getState()).toMatchObject({ messageId: null, status: 'idle', error: 'speech synthesis is not configured' });
  });
});
