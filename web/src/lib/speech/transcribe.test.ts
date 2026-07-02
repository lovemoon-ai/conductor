import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractSpeechStreamText,
  isSupportedAudioType,
  mergeSpeechTranscriptText,
  normalizeLanguageTag,
  parseSpeechEventStreamDataLines,
  pcm16MonoToWav,
  transcribeSpeechFileStream,
} from "./transcribe";

describe("speech transcription helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("normalizes language tags without accepting non-strings", () => {
    expect(normalizeLanguageTag(" zh-CN ")).toBe("zh-CN");
    expect(normalizeLanguageTag(null)).toBe("");
    expect(normalizeLanguageTag(123)).toBe("");
    expect(normalizeLanguageTag("x".repeat(40))).toHaveLength(32);
  });

  it("recognizes supported upload audio types", () => {
    expect(isSupportedAudioType("audio/wav")).toBe(true);
    expect(isSupportedAudioType("AUDIO/MP3")).toBe(true);
    expect(isSupportedAudioType("application/octet-stream")).toBe(true);
    expect(isSupportedAudioType("text/plain")).toBe(false);
  });

  it("wraps PCM16 mono bytes in a WAV header", () => {
    const wav = pcm16MonoToWav(Buffer.from([1, 0, 2, 0]), 16_000);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4);
  });

  it("parses event stream data lines", () => {
    expect(parseSpeechEventStreamDataLines([
      "event: message",
      "data: {\"text\":\"你\"}",
      "data: {\"text\":\"好\"}",
      "",
    ].join("\n"))).toEqual(["{\"text\":\"你\"}", "{\"text\":\"好\"}"]);
  });

  it("extracts text from common streaming payload shapes", () => {
    expect(extractSpeechStreamText({ text: "你好" })).toBe("你好");
    expect(extractSpeechStreamText({ choices: [{ delta: { content: "继续" } }] })).toBe("继续");
    expect(extractSpeechStreamText({ payload: { transcript: "下一步" } })).toBe("下一步");
  });

  it("merges snapshot and delta transcript chunks without corrupting revisions", () => {
    expect(mergeSpeechTranscriptText("", "你好")).toBe("你好");
    expect(mergeSpeechTranscriptText("你好", "你好世界")).toBe("你好世界");
    expect(mergeSpeechTranscriptText("打开设置", "打开任务")).toBe("打开任务");
    expect(mergeSpeechTranscriptText("你好", "世界", "delta")).toBe("你好世界");
    expect(mergeSpeechTranscriptText("hello", " world", "delta")).toBe("hello world");
  });

  it("streams upstream transcription chunks as partial transcript text", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-test");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"text\":\"继续\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"text\":\"继续这个任务\"}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const partials: string[] = [];

    const result = await transcribeSpeechFileStream({
      file: new Blob(["wav-bytes"], { type: "audio/wav" }),
      filename: "speech.wav",
      language: "zh-CN",
      source: "websocket",
      onPartial: (text) => partials.push(text),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("继续这个任务");
    }
    expect(partials).toEqual(["继续", "继续这个任务"]);
    const upstreamFormData = fetchSpy.mock.calls[0][1].body as FormData;
    expect(upstreamFormData.get("stream")).toBe("true");
    expect(upstreamFormData.get("language")).toBe("zh-CN");
  });

  it("preserves spaces when streaming delta chunks", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-test");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"delta\":\"hello\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"delta\":\" world\"}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const result = await transcribeSpeechFileStream({
      file: new Blob(["wav-bytes"], { type: "audio/wav" }),
      filename: "speech.wav",
      language: "en-US",
      source: "websocket",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("hello world");
    }
  });
});
