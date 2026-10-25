import { describe, expect, it } from "vitest";
import { ChatStreamDecoder } from "../src/runtime/stream-decoder.js";

const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\r\n\r\n";
describe("runtime SSE decoding", () => {
  it("frames split CRLF and preserves Claude text across arbitrary boundaries", () => {
    const decoder = new ChatStreamDecoder("claude");
    const data = frame({ type: "content_block_delta", delta: { type: "text_delta", text: "你好\n```ts\n" } }) +
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "let x = 1;\n```" } }) +
      frame({ type: "message_stop" });
    for (const character of data) decoder.push(character);
    expect(decoder.text).toBe("你好\n```ts\nlet x = 1;\n```");
    expect(decoder.complete).toBe(true);
  });
  it("does not treat a partial response as complete", () => {
    const decoder = new ChatStreamDecoder("kimi");
    decoder.push(frame({ event: "cmpl", text: "partial" }));
    expect(decoder.text).toBe("partial");
    expect(decoder.complete).toBe(false);
    decoder.push(frame({ event: "all_done" }));
    expect(decoder.complete).toBe(true);
  });
  it("reuses ChatGPT message reconstruction without forcing EOF", () => {
    const decoder = new ChatStreamDecoder("chatgpt");
    decoder.push(frame({ message: { id: "m1", author: { role: "assistant" }, content: { parts: ["# Hello"] }, status: "in_progress" } }));
    expect(decoder.text).toBe("# Hello");
    expect(decoder.complete).toBe(false);
    decoder.push("data: [DONE]\n\n");
    expect(decoder.complete).toBe(true);
  });
  it("keeps DeepSeek thought fragments out of assistant text", () => {
    const decoder = new ChatStreamDecoder("deepseek");
    decoder.push(frame({ response: { fragments: [{ id: 0, type: "THINK", content: "private" }, { id: 1, type: "RESPONSE", content: "" }] } }));
    decoder.push(frame({ p: "response/fragments/1/content", o: "APPEND", v: "answer" }));
    expect(decoder.text).toBe("answer");
    decoder.push(frame({ p: "response/status", v: "FINISHED" }));
    expect(decoder.complete).toBe(true);
  });
});
