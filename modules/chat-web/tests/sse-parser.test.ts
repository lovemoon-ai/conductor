import { describe, expect, it } from "vitest";

import { parseSSE } from "../src/core/sse-parser.js";

describe("parseSSE", () => {
  it("parses a single event with data:", () => {
    const out = parseSSE('data: {"v":"Hello"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toBe('{"v":"Hello"}');
    expect(out[0]!.event).toBeUndefined();
  });

  it("joins multi-line data with \\n", () => {
    const out = parseSSE("data: line one\ndata: line two\n\n");
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toBe("line one\nline two");
  });

  it("captures event: name", () => {
    const out = parseSSE('event: delta\ndata: {"v":"hi"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("delta");
    expect(out[0]!.data).toBe('{"v":"hi"}');
  });

  it("strips a single leading space after the colon", () => {
    const out = parseSSE("data: with-space\n\ndata:no-space\n\n");
    expect(out.map((e) => e.data)).toEqual(["with-space", "no-space"]);
  });

  it("ignores comment lines starting with :", () => {
    const out = parseSSE(": keep-alive ping\ndata: payload\n\n");
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toBe("payload");
  });

  it("handles \\r\\n line endings", () => {
    const out = parseSSE("data: a\r\ndata: b\r\n\r\n");
    expect(out[0]!.data).toBe("a\nb");
  });

  it("splits multiple events on a blank line", () => {
    const out = parseSSE("data: one\n\ndata: two\n\ndata: three\n\n");
    expect(out.map((e) => e.data)).toEqual(["one", "two", "three"]);
  });

  it("drops events that contain no data line", () => {
    const out = parseSSE("event: heartbeat\n\ndata: payload\n\n");
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toBe("payload");
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(parseSSE("")).toEqual([]);
    expect(parseSSE("\n\n\n")).toEqual([]);
  });
});
