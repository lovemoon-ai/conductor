/**
 * Gapless playback of a streamed 16-bit LE mono PCM body: each network chunk
 * is scheduled right after the previous one, so audio starts on the first
 * chunk instead of after the whole reply is synthesized.
 */
export class PcmStreamPlayer {
  private readonly ctx: AudioContext;
  private nextStartAt = 0;
  private leftover: Uint8Array | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  onIdle: (() => void) | null = null;

  constructor(private readonly sampleRate: number) {
    this.ctx = new AudioContext();
  }

  /** Call from a user gesture (iOS/Safari keep audio suspended otherwise). */
  unlock() {
    void this.ctx.resume();
  }

  get idle() {
    return this.sources.size === 0;
  }

  push(chunk: Uint8Array) {
    let bytes = chunk;
    if (this.leftover) {
      bytes = new Uint8Array(this.leftover.length + chunk.length);
      bytes.set(this.leftover);
      bytes.set(chunk, this.leftover.length);
      this.leftover = null;
    }
    const usable = bytes.length - (bytes.length % 2);
    if (usable < bytes.length) this.leftover = bytes.slice(usable);
    if (usable === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.03, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onIdle?.();
    };
  }

  stop() {
    this.leftover = null;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextStartAt = 0;
  }

  close() {
    this.stop();
    void this.ctx.close();
  }
}
