import { describe, expect, it } from "vitest";

import {
  isSupportedAudioType,
  normalizeLanguageTag,
  pcm16MonoToWav,
} from "./transcribe";

describe("speech transcription helpers", () => {
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
});
