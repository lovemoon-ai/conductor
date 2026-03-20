import { describe, expect, it } from "vitest";
import {
  countActiveTaskBuckets,
  exceedsFreeTaskLimit,
  exceedsTaskLimit,
  FREE_PLAN_LIMITS,
  getTaskLimitMessage,
  getTaskPlanBucket,
  isConductorFireHost,
  isFreeTier,
  isTaskActive,
  PLUS_PLAN_LIMITS,
} from "@/lib/subscription/plan-limits";

describe("plan-limits", () => {
  it("treats PLUS and PLUS_DEV tiers as non-free", () => {
    expect(isFreeTier("FREE")).toBe(true);
    expect(isFreeTier("free")).toBe(true);
    expect(isFreeTier("PLUS")).toBe(false);
    expect(isFreeTier("plus")).toBe(false);
    expect(isFreeTier("PLUS_DEV")).toBe(false);
    expect(isFreeTier("plus_dev")).toBe(false);
    expect(isFreeTier(undefined)).toBe(true);
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

  it("counts active tasks by free-plan bucket", () => {
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

  it("enforces free task limits by bucket", () => {
    expect(
      exceedsFreeTaskLimit("manual_fire", {
        manualFire: FREE_PLAN_LIMITS.activeManualFireTasks,
        app: 0,
      })
    ).toBe(true);
    expect(
      exceedsFreeTaskLimit("app", {
        manualFire: 0,
        app: FREE_PLAN_LIMITS.activeAppTasks,
      })
    ).toBe(true);
    expect(
      exceedsFreeTaskLimit("app", {
        manualFire: FREE_PLAN_LIMITS.activeManualFireTasks,
        app: 0,
      })
    ).toBe(false);
  });

  it("enforces tier-based task limits (unified function)", () => {
    // Free tier: limit is 1
    expect(
      exceedsTaskLimit("FREE", "manual_fire", {
        manualFire: 1,
        app: 0,
      })
    ).toBe(true);
    expect(
      exceedsTaskLimit("FREE", "manual_fire", {
        manualFire: 0,
        app: 0,
      })
    ).toBe(false);

    // Plus tier: limit is 10
    expect(
      exceedsTaskLimit("PLUS", "manual_fire", {
        manualFire: 10,
        app: 0,
      })
    ).toBe(true);
    expect(
      exceedsTaskLimit("PLUS", "manual_fire", {
        manualFire: 9,
        app: 0,
      })
    ).toBe(false);

    expect(
      exceedsTaskLimit("PLUS_DEV", "manual_fire", {
        manualFire: 10,
        app: 0,
      })
    ).toBe(true);

    // Plus tier app tasks
    expect(
      exceedsTaskLimit("PLUS", "app", {
        manualFire: 0,
        app: 10,
      })
    ).toBe(true);
    expect(
      exceedsTaskLimit("PLUS", "app", {
        manualFire: 0,
        app: 9,
      })
    ).toBe(false);
  });

  it("returns appropriate limit messages by tier", () => {
    expect(getTaskLimitMessage("FREE", "manual_fire")).toBe(
      "Free plan allows only one active manual fire task"
    );
    expect(getTaskLimitMessage("FREE", "app")).toBe(
      "Free plan allows only one active app task"
    );
    expect(getTaskLimitMessage("PLUS", "manual_fire")).toBe(
      "Plus plan allows only ten active manual fire tasks"
    );
    expect(getTaskLimitMessage("PLUS", "app")).toBe(
      "Plus plan allows only ten active app tasks"
    );
  });

  it("defines plus plan limits as 10", () => {
    expect(PLUS_PLAN_LIMITS.activeManualFireTasks).toBe(10);
    expect(PLUS_PLAN_LIMITS.activeAppTasks).toBe(10);
    expect(PLUS_PLAN_LIMITS.activeDaemonConnections).toBe(10);
  });
});
