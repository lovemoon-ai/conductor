import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { checkSpeechRateLimit } from "./rate-limit";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TRANSCRIBE_MODEL = "glm-asr-2512";
const GLM_TRANSCRIPTIONS_URL = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";

const isSupportedAudioType = (type: string): boolean => {
  const normalized = type.trim().toLowerCase();
  return normalized === "audio/wav" ||
    normalized === "audio/wave" ||
    normalized === "audio/x-wav" ||
    normalized === "audio/mpeg" ||
    normalized === "audio/mp3" ||
    normalized === "application/octet-stream";
};

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Speech transcription is not configured: GLM_API_KEY missing" },
      { status: 503 },
    );
  }

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

  const upstreamFormData = new FormData();
  upstreamFormData.set("file", fileValue, fileValue.name || "speech.wav");
  upstreamFormData.set("model", process.env.GLM_ASR_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL);
  upstreamFormData.set("stream", "false");

  let upstream: Response;
  try {
    upstream = await fetch(GLM_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: upstreamFormData,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transcription request failed" },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { error: "Transcription failed", detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid transcription response" }, { status: 502 });
  }

  const transcript =
    parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
      ? parsed.text.trim()
      : "";
  if (!transcript) {
    return NextResponse.json({ error: "No speech recognized" }, { status: 422 });
  }

  return NextResponse.json({ text: transcript });
}
