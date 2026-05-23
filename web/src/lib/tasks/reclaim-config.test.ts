import { describe, expect, it } from "vitest";
import { isTaskReclaimEnabled, TASK_RECLAIM_ENV_VAR } from "./reclaim-config";

describe("isTaskReclaimEnabled", () => {
  const withEnv = (value: string | undefined) => ({
    [TASK_RECLAIM_ENV_VAR]: value,
  }) as unknown as NodeJS.ProcessEnv;

  it("returns false when the env var is unset (safe default for Phase 1)", () => {
    expect(isTaskReclaimEnabled(withEnv(undefined))).toBe(false);
  });

  it("accepts the documented truthy strings (case-insensitive)", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "On"]) {
      expect(isTaskReclaimEnabled(withEnv(value))).toBe(true);
    }
  });

  it("rejects anything else (including ambiguous values like `enabled`)", () => {
    for (const value of ["0", "false", "no", "off", "enabled", "", "  "]) {
      expect(isTaskReclaimEnabled(withEnv(value))).toBe(false);
    }
  });
});
