import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEECH_SAMPLE_RATE,
  normalizeSpeechSampleRate,
  parseSpeechControlMessage,
} from "./gateway-protocol";

describe("speech websocket gateway helpers", () => {
  it("normalizes unsupported sample rates to the default", () => {
    expect(normalizeSpeechSampleRate(16_000)).toBe(16_000);
    expect(normalizeSpeechSampleRate("48000")).toBe(48_000);
    expect(normalizeSpeechSampleRate(4_000)).toBe(DEFAULT_SPEECH_SAMPLE_RATE);
    expect(normalizeSpeechSampleRate(96_000)).toBe(DEFAULT_SPEECH_SAMPLE_RATE);
    expect(normalizeSpeechSampleRate("bad")).toBe(DEFAULT_SPEECH_SAMPLE_RATE);
  });

  it("parses supported control messages only", () => {
    expect(parseSpeechControlMessage(JSON.stringify({ type: "finish" }))).toEqual({
      type: "finish",
    });
    expect(parseSpeechControlMessage(JSON.stringify({
      type: "start",
      payload: { language: "zh-CN", sample_rate: 16_000 },
    }))).toEqual({
      type: "start",
      payload: { language: "zh-CN", sample_rate: 16_000 },
    });
    expect(parseSpeechControlMessage("{bad")).toBeNull();
    expect(parseSpeechControlMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});
