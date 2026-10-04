import { getStoredJwtToken } from '@/lib/auth/token-storage';

/**
 * Starts synthesizing `text` immediately and buffers the streamed PCM, so the
 * next reply is already being synthesized while the current one plays.
 * Single consumer: call `read()` once.
 */
export class TtsPrefetch {
  readonly controller = new AbortController();
  private readonly chunks: Uint8Array[] = [];
  private finished = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(readonly text: string) {
    void this.run();
  }

  abort() {
    this.controller.abort();
  }

  async *read(): AsyncGenerator<Uint8Array> {
    let index = 0;
    for (;;) {
      if (index < this.chunks.length) {
        const chunk = this.chunks[index];
        this.chunks[index] = new Uint8Array(0); // release memory once consumed
        index += 1;
        yield chunk;
        continue;
      }
      if (this.finished) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify() {
    this.wake?.();
    this.wake = null;
  }

  private async run() {
    try {
      const token = getStoredJwtToken();
      const response = await fetch('/api/speech/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: this.text, format: 'pcm' }),
        signal: this.controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Speech synthesis failed (HTTP ${response.status})`);
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          this.chunks.push(value);
          this.notify();
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('Speech synthesis failed');
    } finally {
      this.finished = true;
      this.notify();
    }
  }
}
