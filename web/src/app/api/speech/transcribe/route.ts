import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  MAX_AUDIO_BYTES,
  isSupportedAudioType,
  normalizeLanguageTag,
  transcribeSpeechFile,
} from "@/lib/speech/transcribe";
import { checkSpeechRateLimit } from "./rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const formData = await request.formData();
  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (fileValue.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  if (fileValue.type && !isSupportedAudioType(fileValue.type)) {
    return NextResponse.json({ error: "unsupported audio type" }, { status: 415 });
  }

  const rateLimit = checkSpeechRateLimit(userResult.id, fileValue.size);
  if (!rateLimit.allowed) {
    console.warn("speech_transcribe_rate_limited", {
      file_bytes: fileValue.size,
      retry_after_seconds: rateLimit.retryAfterSeconds,
    });
    return NextResponse.json(
      {
        error: "speech transcription rate limit exceeded",
        retry_after_seconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const result = await transcribeSpeechFile({
    file: fileValue,
    filename: fileValue.name || "speech.wav",
    language: normalizeLanguageTag(formData.get("language")),
    source: "http",
  });
  if (!result.ok) {
    const body: Record<string, unknown> = { error: result.error };
    if (result.detail) body.detail = result.detail;
    if (result.retryAfterSeconds) body.retry_after_seconds = result.retryAfterSeconds;
    return NextResponse.json(body, { status: result.status });
  }

  return NextResponse.json({ text: result.text });
}
