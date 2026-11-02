import { readFileSync } from "node:fs";
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

const connectFrame = (value: unknown, flags = 0) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags; header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
};

describe("Kimi Connect JSON decoding", () => {
  it("handles split binary headers and UTF-8 while excluding thinking and user messages", () => {
    const decoder = new ChatStreamDecoder("kimi");
    const data = Buffer.concat([
      connectFrame({ message: { id: "user", role: "user", status: "MESSAGE_STATUS_COMPLETED" } }),
      connectFrame({ message: { id: "assistant", role: "assistant" } }),
      connectFrame({ op: "set", mask: "block.think", block: { id: "think", think: { content: "private" } } }),
      connectFrame({ op: "set", mask: "block.text", block: { id: "answer", text: { content: "你好" } } }),
      connectFrame({ op: "append", mask: "block.text.content", block: { id: "answer", text: { content: "\n世界" } } }),
      connectFrame({ op: "set", mask: "message.status", message: { id: "assistant", status: "MESSAGE_STATUS_COMPLETED" } }),
    ]);
    for (const byte of data) decoder.pushConnect(Uint8Array.of(byte));
    expect(decoder.text).toBe("你好\n世界");
    expect(decoder.complete).toBe(false);
    decoder.pushConnect(connectFrame({ done: {} }));
    expect(decoder.complete).toBe(true);
    decoder.finishConnect(); // The browser app may abort here before the trailer arrives.
    decoder.pushConnect(connectFrame({}, 2));
    decoder.finishConnect();
    expect(decoder.complete).toBe(true);
    expect(decoder.source).toBe("connect");
  });

  it("applies block replacements without duplicating earlier text", () => {
    const decoder = new ChatStreamDecoder("kimi");
    for (const value of [
      { op: "set", mask: "block.text", block: { id: "a", text: { content: "old" } } },
      { op: "set", mask: "block.text.content", block: { id: "a", text: { content: "new" } } },
      { op: "set", mask: "block.text", block: { id: "b", text: { content: " answer" } } },
    ]) decoder.pushConnect(connectFrame(value));
    expect(decoder.text).toBe("new answer");
  });

  it("rejects compressed, oversized, truncated and error streams without reporting success", () => {
    expect(() => new ChatStreamDecoder("kimi").pushConnect(connectFrame({}, 1))).toThrow(/flags/);
    const header = Buffer.alloc(5); header.writeUInt32BE(2_000_001, 1);
    expect(() => new ChatStreamDecoder("kimi").pushConnect(header)).toThrow(/limit/);
    const truncated = new ChatStreamDecoder("kimi");
    truncated.pushConnect(connectFrame({ done: {} }).subarray(0, 8));
    expect(() => truncated.finishConnect()).toThrow(/trailer/);
    expect(truncated.complete).toBe(false);
    const error = new ChatStreamDecoder("kimi");
    error.pushConnect(connectFrame({ error: { code: "resource_exhausted" } }, 2));
    expect(error.error).toMatch(/Connect error/);
    expect(error.complete).toBe(false);
    expect(() => error.pushConnect(connectFrame({}))).toThrow(/after Connect/);
  });
});

describe("DeepSeek response patches", () => {
  it("uses array offsets rather than fragment IDs and handles negative append paths", () => {
    const decoder = new ChatStreamDecoder("deepseek");
    decoder.push(frame({ v: { response: { fragments: [{ id: 41, type: "THINK", content: "private" }] } } }));
    decoder.push(frame({ p: "response/fragments", o: "APPEND", v: [{ id: 92, type: "RESPONSE", content: "a" }] }));
    decoder.push(frame({ p: "response/fragments/-1/content", o: "APPEND", v: "ns" }));
    decoder.push(frame({ v: "wer" }));
    expect(decoder.text).toBe("answer");
    decoder.push(frame({ p: "response", o: "BATCH", v: [{ p: "quasi_status", v: "FINISHED" }] }));
    expect(decoder.complete).toBe(false);
    decoder.push(frame({ p: "response", o: "BATCH", v: [{ p: "status", o: "SET", v: "FINISHED" }] }));
    expect(decoder.complete).toBe(true);
  });
});

const providerErrors = JSON.parse(readFileSync(new URL("./fixtures/provider-errors.json", import.meta.url), "utf8"));

describe("provider error messages", () => {
  it.each(["kimi", "deepseek"] as const)("recognizes the real %s concurrency rejection and never completes it", provider => {
    const decoder = new ChatStreamDecoder(provider);
    if (provider === "kimi") {
      decoder.pushConnect(connectFrame(providerErrors.kimi, 2));
      decoder.finishConnect();
    } else {
      decoder.push(frame(providerErrors.deepseek));
      decoder.push("data: [DONE]\n\n");
    }
    expect(decoder.errorCode).toBe("PROVIDER_CONCURRENCY_LIMIT");
    expect(decoder.error).toBe((provider === "kimi" ? "Kimi" : "DeepSeek") + " 账号同时生成的对话过多，请等待其他对话结束后重试。");
    expect(decoder.complete).toBe(false);
    expect(decoder.text).toBe("");
  });

  it("does not classify a generic resource exhaustion as a concurrency error", () => {
    const decoder = new ChatStreamDecoder("kimi");
    decoder.pushConnect(connectFrame({ error: { code: "resource_exhausted", message: "Daily usage exhausted" } }, 2));
    expect(decoder.errorCode).toBe("PROVIDER_ERROR");
    expect(decoder.error).toContain("[resource_exhausted]: Daily usage exhausted");
  });

  it("forwards bounded provider messages without dumping account metadata or encoded details", () => {
    const decoder = new ChatStreamDecoder("deepseek");
    decoder.push(frame({ type: "error", content: "Server\nfailed " + "x".repeat(600), metadata: { token: "must-not-leak" }, details: "must-not-leak" }));
    expect(decoder.error).toMatch(/^Provider returned an error: Server failed /);
    expect(decoder.error!.length).toBeLessThan(550);
    expect(decoder.error).not.toContain("must-not-leak");
    const unknown = new ChatStreamDecoder("kimi");
    unknown.pushConnect(connectFrame({ error: { details: [{ value: "must-not-leak" }] } }, 2));
    expect(unknown.error).toBe("Provider returned a Connect error");
  });

  it("preserves partial text while keeping a later provider error terminal", () => {
    const decoder = new ChatStreamDecoder("kimi");
    decoder.pushConnect(connectFrame({ mask: "block.text", block: { id: "a", text: { content: "partial" } } }));
    decoder.pushConnect(connectFrame({ error: { code: "unavailable", message: "Try again later" } }));
    decoder.pushConnect(connectFrame({ done: {} }));
    decoder.pushConnect(connectFrame({}, 2));
    expect(decoder.text).toBe("partial");
    expect(decoder.error).toContain("Try again later");
    expect(decoder.complete).toBe(false);
  });
});
