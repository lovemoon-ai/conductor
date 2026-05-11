import { describe, expect, it } from "vitest";

import {
  AUDIT_RESERVED_TOP_LEVEL_KEYS,
  stripTopLevelAuditKeys,
} from "./metadata";

describe("stripTopLevelAuditKeys", () => {
  it("returns null for null/undefined", () => {
    expect(stripTopLevelAuditKeys(null)).toBe(null);
    expect(stripTopLevelAuditKeys(undefined)).toBe(null);
  });

  it("returns the value as-is when it is not a plain object", () => {
    // We intentionally pass through arrays / non-object values rather than
    // coercing them — the route then handles its own validation.
    expect(stripTopLevelAuditKeys([] as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("strips every reserved top-level key", () => {
    const input = {
      actor: "system",
      cliVersion: "fake",
      sdkVersion: "fake",
      invokedBy: "attacker",
      custom: "kept",
      audit: { actor: "cli" },
    };
    const out = stripTopLevelAuditKeys(input);
    expect(out).toEqual({
      custom: "kept",
      audit: { actor: "cli" },
    });
    // Source mutation safety — `stripTopLevelAuditKeys` returns a clone.
    expect(input.actor).toBe("system");
  });

  it("leaves audit nested object untouched", () => {
    const input = {
      audit: { actor: "cli", cliVersion: "1.0.0", invokedBy: null },
    };
    expect(stripTopLevelAuditKeys(input)).toEqual(input);
  });

  it("constant lists exactly the four reserved keys (review M3 boundary)", () => {
    expect([...AUDIT_RESERVED_TOP_LEVEL_KEYS]).toEqual([
      "actor",
      "cliVersion",
      "sdkVersion",
      "invokedBy",
    ]);
  });
});
