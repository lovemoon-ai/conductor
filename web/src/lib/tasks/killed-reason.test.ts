import { describe, expect, it, vi } from "vitest";
import {
  buildKilledPatch,
  buildKilledRevokePatch,
  isKilledReason,
  isMissingKilledReasonSchemaError,
  normalizeKilledReason,
  RECLAIMABLE_KILLED_REASON,
  withKilledReasonFallback,
} from "./killed-reason";

describe("killed-reason helpers", () => {
  it("only treats `daemon_disconnected` as the reclaim trigger", () => {
    expect(RECLAIMABLE_KILLED_REASON).toBe("daemon_disconnected");
    // The whitelist must intentionally include user_stopped — if someone
    // typos the constant we should fail loudly via the soft enum, not by
    // silently downgrading to `unknown`.
    expect(isKilledReason("daemon_disconnected")).toBe(true);
    expect(isKilledReason("user_stopped")).toBe(true);
    expect(isKilledReason("totally_made_up")).toBe(false);
  });

  it("normalises arbitrary input to `unknown` rather than throwing", () => {
    expect(normalizeKilledReason(undefined)).toBe("unknown");
    expect(normalizeKilledReason(null)).toBe("unknown");
    expect(normalizeKilledReason(42)).toBe("unknown");
    expect(normalizeKilledReason("  USER_STOPPED  ")).toBe("user_stopped");
    expect(normalizeKilledReason("rocket_science")).toBe("unknown");
  });

  it("buildKilledPatch stamps killed_at and locks status to `killed`", () => {
    const fixedNow = new Date("2026-05-23T12:00:00Z");
    const patch = buildKilledPatch("daemon_disconnected", { killedAt: fixedNow });
    expect(patch).toEqual({
      status: "killed",
      killedReason: "daemon_disconnected",
      killedAt: fixedNow,
    });
  });

  it("buildKilledRevokePatch fully clears the killed tombstone", () => {
    expect(buildKilledRevokePatch()).toEqual({
      status: "running",
      killedReason: null,
      killedAt: null,
    });
  });

  it("isMissingKilledReasonSchemaError recognises both P2022 and SQLite messages", () => {
    expect(
      isMissingKilledReasonSchemaError({
        code: "P2022",
        message: "Column `killed_reason` does not exist in table `tasks`",
      }),
    ).toBe(true);
    expect(
      isMissingKilledReasonSchemaError({
        message: "SQLITE_ERROR: no such column: killed_at",
      }),
    ).toBe(true);
    expect(
      isMissingKilledReasonSchemaError({ code: "P2022", message: "killed_unrelated" }),
    ).toBe(false);
    expect(isMissingKilledReasonSchemaError(new Error("connection refused"))).toBe(false);
    expect(isMissingKilledReasonSchemaError(null)).toBe(false);
  });

  it("withKilledReasonFallback only re-runs the fallback on schema errors", async () => {
    const primaryOk = vi.fn(async () => "primary-ok");
    const fallbackOk = vi.fn(async () => "fallback");
    await expect(withKilledReasonFallback(primaryOk, fallbackOk)).resolves.toBe(
      "primary-ok",
    );
    expect(fallbackOk).not.toHaveBeenCalled();

    const schemaErr = vi.fn(async () => {
      throw { code: "P2022", message: "no such column killed_reason" };
    });
    await expect(withKilledReasonFallback(schemaErr, fallbackOk)).resolves.toBe(
      "fallback",
    );

    const unrelatedErr = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(withKilledReasonFallback(unrelatedErr, fallbackOk)).rejects.toThrow(
      "connection refused",
    );
  });
});
