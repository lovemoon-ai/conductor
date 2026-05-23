import { describe, expect, it } from "vitest";

import { waitUntilStable } from "../src/core/response-watcher.js";

describe("waitUntilStable", () => {
  it("returns once the text stops changing for stableMs", async () => {
    const samples = [
      "",
      "Hi",
      "Hi there",
      "Hi there!",
      "Hi there!",
      "Hi there!",
      "Hi there!",
    ];
    let i = 0;
    const result = await waitUntilStable(
      async () => samples[Math.min(i++, samples.length - 1)]!,
      { pollIntervalMs: 10, stableMs: 80, timeoutMs: 2_000 },
    );
    expect(result).toBe("Hi there!");
  });

  it("respects timeoutMs by returning the latest seen text instead of throwing", async () => {
    let counter = 0;
    const result = await waitUntilStable(
      async () => `chunk-${counter++}`, // always changing
      { pollIntervalMs: 10, stableMs: 50, timeoutMs: 120 },
    );
    expect(result).toMatch(/^chunk-\d+$/);
  });

  it("treats errors from getText as empty without crashing", async () => {
    const samples = ["", "", "ok"];
    let i = 0;
    const result = await waitUntilStable(
      async () => {
        // Once we hit "ok", stick on it forever. While we haven't seen a
        // value yet, throwing should be treated as empty.
        const next = i < samples.length ? samples[i++]! : samples[samples.length - 1]!;
        if (next === "") throw new Error("not yet");
        return next;
      },
      { pollIntervalMs: 10, stableMs: 50, timeoutMs: 2_000 },
    );
    expect(result).toBe("ok");
  });

  it("emits onProgress when the text grows", async () => {
    const samples = ["", "Hi", "Hi there", "Hi there"];
    let i = 0;
    const events: string[] = [];
    await waitUntilStable(
      async () => samples[Math.min(i++, samples.length - 1)]!,
      {
        pollIntervalMs: 5,
        stableMs: 40,
        timeoutMs: 2_000,
        onProgress: (t) => events.push(t),
      },
    );
    expect(events).toEqual(["Hi", "Hi there"]);
  });
});
