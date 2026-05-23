import { describe, expect, it } from "vitest";

import {
  CHATGPT_CONVERSATION_URL,
  ChatGPTSSECollector,
} from "../src/providers/chatgpt-sse-collector.js";

describe("CHATGPT_CONVERSATION_URL regex", () => {
  it("matches the streaming endpoint variants", () => {
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/conversation")).toBe(true);
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/f/conversation")).toBe(true);
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/lat/r/conversation")).toBe(true);
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/conversation?stream=1")).toBe(true);
  });

  it("does NOT match the sibling JSON endpoints that race the SSE", () => {
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/conversation/init")).toBe(false);
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/f/conversation/prepare")).toBe(false);
    expect(CHATGPT_CONVERSATION_URL.test("https://chatgpt.com/backend-api/conversation/textdocs/abc")).toBe(false);
  });
});

/**
 * The collector is exercised via its public `ingest()` method, which
 * accepts a raw SSE body. This way the tests don't need a real
 * Playwright Response and we cover both observed ChatGPT formats:
 *   - "v1 delta encoding" with `{p, o, v}` frames
 *   - Full message snapshots with `{message: {...}}`
 */

describe("ChatGPTSSECollector — full message snapshots", () => {
  it("extracts the markdown verbatim from an assistant snapshot", () => {
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["- alpha\\n- beta\\n```python\\ndef f():\\n    pass\\n```"]},"status":"finished_successfully"},"conversation_id":"c1"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe(
      "- alpha\n- beta\n```python\ndef f():\n    pass\n```",
    );
  });

  it("prefers the most recent finished_successfully snapshot over an in-progress one", () => {
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["partial"]},"status":"in_progress"}}',
      "",
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["partial complete"]},"status":"finished_successfully"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("partial complete");
  });
});

describe("ChatGPTSSECollector — v1 delta encoding", () => {
  it("assembles append deltas onto a snapshot's parts[0]", () => {
    const body = [
      'event: delta_encoding',
      'data: "v1"',
      "",
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"status":"in_progress"}}',
      "",
      'data: {"p":"/message/content/parts/0","o":"append","v":"Hello"}',
      "",
      'data: {"v":", "}',
      "",
      'data: {"v":"world!"}',
      "",
      'data: {"type":"message_stream_complete","conversation_id":"c1"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("Hello, world!");
    expect(c.isStreamComplete()).toBe(true);
  });

  it("handles a replace op", () => {
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["wrong"]},"status":"in_progress"}}',
      "",
      'data: {"p":"/message/content/parts/0","o":"replace","v":"right"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("right");
  });

  it("ignores deltas targeting paths other than message parts", () => {
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["body"]},"status":"in_progress"}}',
      "",
      'data: {"p":"/message/metadata/finish_details","o":"replace","v":{"type":"stop"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("body");
  });

  it("handles patch arrays of sub-deltas", () => {
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"status":"in_progress"}}',
      "",
      'data: {"p":"/message/content/parts/0","o":"patch","v":[{"o":"append","p":"/message/content/parts/0","v":"A"},{"o":"append","v":"B"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("AB");
  });

  it("processes a real-shape closing patch with empty top-level path", () => {
    // Mirrors what ChatGPT actually sends: the LAST text token (e.g. the
    // closing ``` of a code block) is wrapped inside a top-level patch
    // whose own `p` is "" — children carry the real paths. The wrapper
    // must NOT be discarded by the parts-path check; if it is, every
    // code-block answer loses its closing fence.
    const body = [
      'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"status":"in_progress"}}',
      "",
      'data: {"p":"/message/content/parts/0","o":"append","v":"```python\\nprint(1)\\n"}',
      "",
      'data: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"```"},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
      "",
      'data: {"type":"message_stream_complete"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(body);
    expect(c.getCurrentTurnText()).toBe("```python\nprint(1)\n```");
  });
});

describe("ChatGPTSSECollector — terminators", () => {
  it("marks isStreamComplete on [DONE]", () => {
    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest("data: [DONE]\n\n");
    expect(c.isStreamComplete()).toBe(true);
  });

  it("marks isStreamComplete on message_stream_complete", () => {
    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest('data: {"type":"message_stream_complete"}\n\n');
    expect(c.isStreamComplete()).toBe(true);
  });
});

describe("ChatGPTSSECollector — beginTurn behavior", () => {
  it("resolves beginTurn() promise with the collected text once ingested", async () => {
    const c = new ChatGPTSSECollector();
    const wait = c.beginTurn();
    setTimeout(() => {
      c.ingest(
        [
          'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["hello"]},"status":"finished_successfully"}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
    }, 10);
    const text = await wait;
    expect(text).toBe("hello");
  });

  it("supersedes an earlier pending turn when beginTurn is called again", async () => {
    const c = new ChatGPTSSECollector();
    const first = c.beginTurn();
    const second = c.beginTurn();
    setTimeout(() => {
      c.ingest(
        [
          'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["second"]},"status":"finished_successfully"}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
    }, 10);
    await expect(first).rejects.toThrow(/Superseded/);
    await expect(second).resolves.toBe("second");
  });

  it("resolves with the empty string on timeout (caller can fall back)", async () => {
    const c = new ChatGPTSSECollector();
    const wait = c.beginTurn({ timeoutMs: 30 });
    await expect(wait).resolves.toBe("");
  });

  it("getCurrentTurnText returns '' after beginTurn until the new turn ingests data (no stale leak)", () => {
    // Regression for task 09b34cf4-…: an earlier impl returned the
    // previous turn's text as a cross-turn cache, which leaked the
    // "1+1=2" answer into the next prompt's extraction fallback.
    const c = new ChatGPTSSECollector();
    c.beginTurn();
    c.ingest(
      [
        'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["first answer"]},"status":"finished_successfully"}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    expect(c.getCurrentTurnText()).toBe("first answer");

    // After a new turn starts and BEFORE any events arrive, the text
    // MUST be empty — not the previous turn's answer.
    c.beginTurn();
    expect(c.getCurrentTurnText()).toBe("");
  });

  it("getLastAssistantText is removed and throws if called (loud failure on legacy callers)", () => {
    const c = new ChatGPTSSECollector();
    // Cast through unknown — TypeScript should already flag the call,
    // but legacy JS callers would silently get stale data; we now throw.
    expect(() => (c as unknown as { getLastAssistantText: () => string }).getLastAssistantText()).toThrow(
      /getLastAssistantText\(\) was removed/,
    );
  });
});
