import { describe, expect, it } from "vitest";
import { TurnQueue } from "../src/core/turn-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("profile turn queue", () => {
  it("executes FIFO with positions and releases the slot after failure", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    const order: string[] = [];
    const positions: number[] = [];
    const a = queue.run(async () => { order.push("A1"); await gate.promise; throw new Error("failed A"); });
    const checked = expect(a).rejects.toThrow("failed A");
    const b = queue.run(async () => { order.push("B1"); return "B"; }, { onPosition: (n) => positions.push(n) });
    const a2 = queue.run(async () => { order.push("A2"); });
    await Promise.resolve();
    expect(order).toEqual(["A1"]);
    expect(positions).toContain(1);
    gate.resolve();
    await checked;
    expect(await b).toBe("B");
    await a2;
    expect(order).toEqual(["A1", "B1", "A2"]);
    expect(positions.at(-1)).toBe(0);
  });

  it("removes cancelled pending work without executing it", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    const a = queue.run(async () => gate.promise);
    const controller = new AbortController();
    let ran = false;
    const pending = queue.run(async () => { ran = true; }, { signal: controller.signal });
    const checked = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await checked;
    gate.resolve();
    await a;
    await queue.run(async () => {});
    expect(ran).toBe(false);
  });

  it("does not release active work merely because its signal was aborted", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    const controller = new AbortController();
    let bStarted = false;
    const a = queue.run(async () => gate.promise, { signal: controller.signal });
    await Promise.resolve();
    const b = queue.run(async () => { bStarted = true; });
    controller.abort();
    await Promise.resolve();
    expect(bStarted).toBe(false);
    gate.resolve();
    await Promise.all([a, b]);
    expect(bStarted).toBe(true);
  });
});
