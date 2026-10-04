import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { checkSpeechRateLimit } from "@/lib/speech/rate-limit";
import { isVolcSpeechConfigured } from "@/lib/speech/volc-protocol";
import { synthesizeVolcSpeech } from "@/lib/speech/volc-tts";

export const runtime = "nodejs";

const MAX_SYNTHESIZE_CHARS = 2_000;
const PCM_SAMPLE_RATE = 24_000;

const bodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_SYNTHESIZE_CHARS),
  format: z.enum(["pcm", "mp3"]).default("mp3"),
});

/**
 * Text to speech (Doubao TTS 2.0), streamed as it is synthesized.
 * `pcm` = raw 16-bit LE mono at 24 kHz, for low-latency playback in the
 * web voice mode; `mp3` for saving a file (CLI).
 */
export async function POST(request: NextRequest) {
  const user = await getActiveSubscriptionUser(request);
  if (user instanceof Response) return user;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `text is required (at most ${MAX_SYNTHESIZE_CHARS} characters)` },
      { status: 400 },
    );
  }
  if (!isVolcSpeechConfigured()) {
    return NextResponse.json({ error: "speech synthesis is not configured" }, { status: 503 });
  }
  const { text, format } = parsed.data;
  // Separate bucket from transcription, same limits.
  const rateLimit = checkSpeechRateLimit(`tts:${user.id}`, Buffer.byteLength(text));
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "speech synthesis rate limit exceeded", retry_after_seconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const abort = new AbortController();
  request.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const audio = synthesizeVolcSpeech({
    text,
    format,
    sampleRate: PCM_SAMPLE_RATE,
    userId: user.id,
    signal: abort.signal,
  });

  // Wait for the first chunk so upstream failures still get a JSON error status.
  let first: IteratorResult<Buffer>;
  try {
    first = await audio.next();
  } catch (error) {
    console.warn("speech_synthesize_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "speech synthesis failed" }, { status: 502 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(new Uint8Array(first.value));
      if (first.done) controller.close();
    },
    async pull(controller) {
      try {
        const next = await audio.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      } catch (error) {
        console.warn("speech_synthesize_stream_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        controller.error(error);
      }
    },
    cancel() {
      abort.abort();
      void audio.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": format === "pcm" ? `audio/pcm;rate=${PCM_SAMPLE_RATE};channels=1` : "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
