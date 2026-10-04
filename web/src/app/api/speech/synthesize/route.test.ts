import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { resetSpeechTranscribeRateLimitsForTest } from "@/lib/speech/rate-limit";
import { POST } from "./route";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));
vi.mock("@/lib/speech/volc-tts", () => ({
  synthesizeVolcSpeech: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { synthesizeVolcSpeech } = await import("@/lib/speech/volc-tts");

const makeRequest = (body: unknown) => new NextRequest("http://localhost:6152/api/speech/synthesize", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

describe("/api/speech/synthesize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSpeechTranscribeRateLimitsForTest();
    vi.stubEnv("VOLC_SPEECH_API_KEY", "key-1");
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: "user-1" } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("streams synthesized pcm audio", async () => {
    vi.mocked(synthesizeVolcSpeech).mockImplementation(async function* () {
      yield Buffer.from([1, 2]);
      yield Buffer.from([3, 4]);
    });

    const response = await POST(makeRequest({ text: " 你好 ", format: "pcm" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/pcm;rate=24000;channels=1");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(synthesizeVolcSpeech).toHaveBeenCalledWith(expect.objectContaining({
      text: "你好",
      format: "pcm",
      sampleRate: 24_000,
      userId: "user-1",
    }));
  });

  it("defaults to mp3", async () => {
    vi.mocked(synthesizeVolcSpeech).mockImplementation(async function* () {
      yield Buffer.from("ID3");
    });
    const response = await POST(makeRequest({ text: "hi" }));
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("rejects empty or oversized text", async () => {
    expect((await POST(makeRequest({ text: "  " }))).status).toBe(400);
    expect((await POST(makeRequest({ text: "a".repeat(2_001) }))).status).toBe(400);
    expect((await POST(makeRequest({ text: "hi", format: "wav" }))).status).toBe(400);
    expect(synthesizeVolcSpeech).not.toHaveBeenCalled();
  });

  it("returns 503 when doubao speech is not configured", async () => {
    vi.stubEnv("VOLC_SPEECH_API_KEY", "");
    const response = await POST(makeRequest({ text: "hi" }));
    expect(response.status).toBe(503);
  });

  it("returns 502 when the upstream fails before any audio", async () => {
    vi.mocked(synthesizeVolcSpeech).mockImplementation(async function* () {
      throw new Error("volc tts handshake failed: HTTP 401");
    });
    const response = await POST(makeRequest({ text: "hi" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "speech synthesis failed" });
  });

  it("requires auth", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(new Response("{}", { status: 401 }));
    expect((await POST(makeRequest({ text: "hi" }))).status).toBe(401);
  });
});
