import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { resetSpeechTranscribeRateLimitsForTest } from "./rate-limit";
import { POST } from "./route";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");

const makeRequest = (file: File, fields: Record<string, string> = {}) => {
  const formData = new FormData();
  formData.set("file", file);
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new NextRequest("http://localhost:6152/api/speech/transcribe", {
    method: "POST",
    body: formData,
  });
};

describe("/api/speech/transcribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSpeechTranscribeRateLimitsForTest();
    vi.stubEnv("GLM_API_KEY", "glm-test");
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  afterEach(() => {
    resetSpeechTranscribeRateLimitsForTest();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards wav audio to GLM transcription and returns text", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "继续这个任务" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
      { language: "zh-CN" },
    ));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ text: "继续这个任务" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer glm-test" },
        body: expect.any(FormData),
      }),
    );
    const upstreamFormData = fetchSpy.mock.calls[0][1].body as FormData;
    expect(upstreamFormData.get("model")).toBe("glm-asr-2512");
    expect(upstreamFormData.get("stream")).toBe("false");
    expect(upstreamFormData.get("file")).toBeInstanceOf(File);
  });

  it("returns 503 when transcription is not configured", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    const response = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
    ));
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.error).toBe("Speech transcription is not configured: GLM_API_KEY missing");
  });

  it("rejects unsupported audio types", async () => {
    const response = await POST(makeRequest(
      new File(["not-a-wav"], "speech.txt", { type: "text/plain" }),
    ));
    const data = await response.json();

    expect(response.status).toBe(415);
    expect(data.error).toBe("unsupported audio type");
  });

  it("maps upstream transcription failures to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad api key", { status: 401 })),
    );

    const response = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
    ));
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.error).toBe("Transcription failed");
    expect(data.detail).toBe("bad api key");
  });

  it("rate limits speech transcription requests per user", async () => {
    vi.stubEnv("SPEECH_TRANSCRIBE_MAX_REQUESTS_PER_MINUTE", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "继续" }), { status: 200 })),
    );

    const first = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
    ));
    const second = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
    ));
    const data = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    expect(data.error).toBe("speech transcription rate limit exceeded");
    expect(data.retry_after_seconds).toBeGreaterThan(0);
  });

  it("enforces an hourly speech transcription byte quota per user", async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv("SPEECH_TRANSCRIBE_MAX_BYTES_PER_HOUR", "8");
    vi.stubGlobal("fetch", fetchSpy);

    const response = await POST(makeRequest(
      new File(["wav-bytes"], "speech.wav", { type: "audio/wav" }),
    ));
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data.error).toBe("speech transcription rate limit exceeded");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
