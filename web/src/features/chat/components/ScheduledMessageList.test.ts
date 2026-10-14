import { describe, expect, it } from "vitest";
import type { ScheduledMessageSummary } from "@/shared/types";
import { describeSchedule } from "./ScheduledMessageList";

const schedule = (overrides: Partial<ScheduledMessageSummary>): ScheduledMessageSummary => ({
  id: "sched-1",
  taskId: "task-1",
  content: "resume",
  kind: "once_at",
  condition: "none",
  status: "active",
  nextRunAt: "2026-10-04T17:21:00.000Z",
  runCount: 0,
  skipCount: 0,
  failureCount: 0,
  stopWhenTaskNotRunning: true,
  createdAt: "2026-10-04T15:30:00.000Z",
  ...overrides,
});

describe("describeSchedule", () => {
  it("labels a fire-made quota resume", () => {
    expect(describeSchedule(schedule({ source: "quota_resume" }))).toMatch(/^Auto-resume after quota reset, at /);
  });

  it("keeps the plain label for a person-made one-off", () => {
    expect(describeSchedule(schedule({ source: "message_bubble" }))).toMatch(/^Once at /);
  });
});
