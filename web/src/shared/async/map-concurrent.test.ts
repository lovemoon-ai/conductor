import { describe, expect, it, vi } from "vitest";
import { mapConcurrentSettled } from "./map-concurrent";

describe("mapConcurrentSettled", () => {
  it("limits active workers and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    const promise = mapConcurrentSettled(
      [0, 1, 2, 3, 4, 5],
      3,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return value * 2;
      },
    );

    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0, 3).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0, 3).forEach((release) => release());

    await expect(promise).resolves.toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
      { status: "fulfilled", value: 6 },
      { status: "fulfilled", value: 8 },
      { status: "fulfilled", value: 10 },
    ]);
    expect(maxActive).toBe(3);
  });

  it("continues after rejection and reports progress", async () => {
    const progress = vi.fn();

    const results = await mapConcurrentSettled(
      ["first", "failed", "last"],
      2,
      async (value) => {
        if (value === "failed") throw new Error("boom");
        return value;
      },
      progress,
    );

    expect(results[0]).toEqual({ status: "fulfilled", value: "first" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "boom" }),
    });
    expect(results[2]).toEqual({ status: "fulfilled", value: "last" });
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it("handles empty input and rejects invalid concurrency", async () => {
    await expect(mapConcurrentSettled([], 3, async () => undefined)).resolves.toEqual([]);
    await expect(mapConcurrentSettled([1], 0, async () => undefined)).rejects.toThrow(
      "concurrency must be a positive integer",
    );
  });

  it("continues when the progress observer throws", async () => {
    const worker = vi.fn(async (value: number) => value);

    await expect(mapConcurrentSettled(
      [1, 2, 3],
      2,
      worker,
      () => {
        throw new Error("render unavailable");
      },
    )).resolves.toHaveLength(3);
    expect(worker).toHaveBeenCalledTimes(3);
  });
});
