import { describe, expect, it } from "vitest";
import {
  countActiveTaskBuckets,
  exceedsFreeTaskLimit,
  exceedsTaskLimit,
  getTaskPlanBucket,
  isConductorFireHost,
  isFreeTier,
  isTaskActive,
} from "@/lib/subscription/plan-limits";

describe("plan-limits", () => {
  it("isFreeTier always returns false (no tier restrictions)", () => {
    expect(isFreeTier("FREE")).toBe(false);
    expect(isFreeTier("PLUS")).toBe(false);
    expect(isFreeTier("PLUS_DEV")).toBe(false);
    expect(isFreeTier(undefined)).toBe(false);
  });

  it("detects conductor-fire hosts", () => {
    expect(isConductorFireHost("conductor-fire-mac-123")).toBe(true);
    expect(isConductorFireHost("daemon-a")).toBe(false);
    expect(isConductorFireHost(null)).toBe(false);
  });

  it("classifies task bucket by host", () => {
    expect(getTaskPlanBucket("conductor-fire-host")).toBe("manual_fire");
    expect(getTaskPlanBucket("daemon-a")).toBe("app");
    expect(getTaskPlanBucket(undefined)).toBe("app");
  });

  it("treats unknown and running statuses as active", () => {
    expect(isTaskActive("unknown")).toBe(true);
    expect(isTaskActive("running")).toBe(true);
    expect(isTaskActive("completed")).toBe(false);
    expect(isTaskActive("failed")).toBe(false);
  });

  it("counts active tasks by bucket", () => {
    const counts = countActiveTaskBuckets([
      { status: "running", agentHost: "conductor-fire-a" },
      { status: "unknown", agentHost: "daemon-a" },
      { status: "completed", agentHost: "conductor-fire-b" },
      { status: "failed", agentHost: "daemon-b" },
      { status: "running", agentHost: null },
    ]);

    expect(counts.manualFire).toBe(1);
    expect(counts.app).toBe(2);
  });

  it("never exceeds task limits (limits removed)", () => {
    expect(exceedsFreeTaskLimit("manual_fire", { manualFire: 100, app: 0 })).toBe(false);
    expect(exceedsFreeTaskLimit("app", { manualFire: 0, app: 100 })).toBe(false);
    expect(exceedsTaskLimit("FREE", "manual_fire", { manualFire: 100, app: 0 })).toBe(false);
    expect(exceedsTaskLimit("PLUS", "manual_fire", { manualFire: 100, app: 0 })).toBe(false);
    expect(exceedsTaskLimit("PLUS", "app", { manualFire: 0, app: 100 })).toBe(false);
  });
});
