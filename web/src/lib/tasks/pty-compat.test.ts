import { describe, expect, it } from "vitest";
import {
  applyLegacyTaskShape,
  isMissingGroupIdColumnError,
  isMissingPtySchemaError,
  taskSelectWithoutIssueId,
} from "./pty-compat";

describe("task schema compatibility shape", () => {
  it("keeps killed-state and group columns in the issue-id-only fallback select", () => {
    expect(taskSelectWithoutIssueId).toMatchObject({
      killedReason: true,
      killedAt: true,
      groupId: true,
    });
  });

  it("backfills nullable killed-state columns for legacy task rows", () => {
    const task = applyLegacyTaskShape({
      id: "task-1",
      projectId: "project-1",
      title: "task",
      status: "killed",
      agentHost: null,
      executionHost: null,
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      metadata: null,
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      updatedAt: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(task).toMatchObject({
      taskType: "ai_task",
      launchConfig: null,
      ptySession: null,
      killedReason: null,
      killedAt: null,
    });
  });

  it("falls back when a rolling deployment reads pre-killed-state schema", () => {
    expect(
      isMissingPtySchemaError({
        code: "P2022",
        message: "The column `tasks.killed_reason` does not exist in the current database.",
      }),
    ).toBe(true);
    expect(
      isMissingPtySchemaError({
        code: "P2022",
        message: "The column `tasks.killed_at` does not exist in the current database.",
      }),
    ).toBe(true);
    expect(
      isMissingPtySchemaError({
        code: "P2022",
        message: "The column `tasks.group_id` does not exist in the current database.",
      }),
    ).toBe(true);
    expect(
      isMissingGroupIdColumnError({
        code: "P2022",
        message: "The column `tasks.group_id` does not exist in the current database.",
      }),
    ).toBe(true);
    expect(
      isMissingGroupIdColumnError({
        code: "P2022",
        message: "The column `tasks.task_type` does not exist in the current database.",
      }),
    ).toBe(false);
  });
});
