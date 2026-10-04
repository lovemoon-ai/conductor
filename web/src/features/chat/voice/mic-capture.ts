export const MIC_SAMPLE_RATE = 16_000;
/** 100 ms of 16 kHz audio per chunk. */
export const MIC_CHUNK_SAMPLES = 1_600;

// Resamples the device rate down to 16 kHz mono PCM16 and posts 100 ms chunks
// together with their RMS level (0..1) for the voice activity check.
const WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${MIC_SAMPLE_RATE};
    this.pos = 0;
    this.out = new Int16Array(${MIC_CHUNK_SAMPLES});
    this.filled = 0;
    this.energy = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const next = i + 1 < input.length ? input[i + 1] : input[i];
      const s = Math.max(-1, Math.min(1, input[i] + (next - input[i]) * frac));
      this.out[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.energy += s * s;
      if (this.filled === this.out.length) {
        const rms = Math.sqrt(this.energy / this.filled);
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(${MIC_CHUNK_SAMPLES});
        this.filled = 0;
        this.energy = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;

export type MicCapture = { stop: () => void };

export async function startMicCapture(
  onChunk: (pcm: ArrayBuffer, rms: number) => void,
): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access needs HTTPS (or localhost).');
  }
  // Created before the first await so it is still inside the click gesture;
  // Safari/iOS otherwise leave it suspended and no audio ever arrives.
  const ctx = new AudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    void ctx.close();
    throw error;
  }
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-downsampler');
  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onChunk(event.data.pcm, event.data.rms);
  };
  source.connect(node);
  // Keep the node in the rendered graph so the browser pulls it; it outputs silence.
  node.connect(ctx.destination);
  return {
    stop: () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
    },
  };
}
