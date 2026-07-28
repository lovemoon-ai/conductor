import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";
import { teardownTaskRuntime } from "@/lib/tasks/teardown";

// Statuses that are NOT terminal. Packing tears down the live session, so a
// packed task must land in a terminal state — otherwise a later in-place
// un-pack (restart) is rejected ("requires a stopped task") and the row is
// left inconsistent (status=running with no runtime).
const NON_TERMINAL_STATUSES = new Set(["running", "killing", "init"]);

const isPrismaTransactionStartBusyError = (
  error: unknown,
): error is { code: "P2028"; message?: string } =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === "P2028"
  && "message" in error
  && typeof error.message === "string"
  && error.message.includes("Unable to start a transaction in the given time");

/**
 * Achieve (pack) a task.
 *
 * Behaves like DELETE for the runtime side — kills the attached PTY, stops the
 * daemon session, cleans the worktree, and drops runtime rows — but PRESERVES
 * the `Message` transcript and the `Task` row, stamping `achievedAt`. The task
 * then disappears from the active list and all task counts, while its chat
 * history stays searchable in the Achieved-task manager for later retrieval.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const startedAt = Date.now();
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const existing = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      agentHost: true,
      executionHost: true,
      status: true,
      launchConfig: true,
      metadata: true,
      achievedAt: true,
      project: { select: { daemonHost: true } },
    },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Idempotent: already achieved.
  if (existing.achievedAt) {
    return NextResponse.json({
      id: existing.id,
      achievedAt: existing.achievedAt.toISOString(),
    });
  }

  const achievedAt = new Date();
  // Force a non-terminal task into `killed` so its (now torn-down) runtime and
  // status agree, and so an in-place un-pack later succeeds.
  const terminalPatch = NON_TERMINAL_STATUSES.has(normalizeTaskStatus(existing.status))
    ? { status: "killed", killedReason: "user_stopped", killedAt: achievedAt }
    : {};
  const teardownStartedAt = Date.now();
  let teardown: Awaited<ReturnType<typeof teardownTaskRuntime>>;
  try {
    teardown = await teardownTaskRuntime({
      userId: user.id,
      task: existing,
      reason: "achieved_by_user",
      archivePatch: { achievedAt, ...terminalPatch },
      // Keep attachments: the preserved transcript may reference uploaded files.
      deleteAttachmentDirectory: false,
    });
  } catch (error) {
    if (!isPrismaTransactionStartBusyError(error)) {
      console.error("[task-achieve] teardown failed", {
        taskId,
        projectId: existing.projectId,
        prismaCode:
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : null,
        totalDurationMs: Date.now() - startedAt,
        teardownDurationMs: Date.now() - teardownStartedAt,
      });
      throw error;
    }
    console.error("[task-achieve] transaction busy", {
      taskId,
      projectId: existing.projectId,
      prismaCode: error.code,
      totalDurationMs: Date.now() - startedAt,
      teardownDurationMs: Date.now() - teardownStartedAt,
    });
    return NextResponse.json(
      {
        error: "Archive is temporarily busy; retry this task.",
        code: "archive_busy",
        retryable: true,
      },
      { status: 503 },
    );
  }
  if (!teardown.ok) {
    console.warn("[task-achieve] teardown rejected", {
      taskId,
      projectId: existing.projectId,
      status: teardown.status ?? 409,
      totalDurationMs: Date.now() - startedAt,
      teardownDurationMs: Date.now() - teardownStartedAt,
    });
    return NextResponse.json(
      { error: teardown.error ?? "Failed to pack task" },
      { status: teardown.status ?? 409 },
    );
  }

  realtimeHub.broadcast(user.id, existing.projectId, {
    type: "task_achieved",
    payload: {
      task_id: taskId,
      project_id: existing.projectId,
      achieved_at: achievedAt.toISOString(),
    },
  });

  console.info("[task-achieve] completed", {
    taskId,
    projectId: existing.projectId,
    totalDurationMs: Date.now() - startedAt,
    teardownDurationMs: Date.now() - teardownStartedAt,
  });
  return NextResponse.json({ id: taskId, achievedAt: achievedAt.toISOString() });
}
