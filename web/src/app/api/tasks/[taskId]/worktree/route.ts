import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { normalizeTaskStatus, parseJsonObject } from "@/lib/tasks/task-config";
import {
  hasSameTaskWorktreeRoot,
  acquireTaskWorktreeMutationLock,
  resolveTaskWorktreeCleanupHost,
  parseTaskWorktreeLaunchConfig,
  requestTaskWorktreeCleanup,
} from "@/lib/tasks/worktree";

const serializeTaskResponse = (task: {
  id: string;
  projectId: string;
  title: string;
  taskType?: string | null;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  launchConfig?: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: task.id,
  project_id: task.projectId,
  title: task.title,
  task_type: task.taskType ?? "ai_task",
  status: normalizeTaskStatus(task.status),
  agent_host: task.agentHost,
  execution_host: task.executionHost,
  backend_type: task.backendType,
  session_id: task.sessionId,
  session_file_path: task.sessionFilePath,
  launch_config: parseJsonObject(task.launchConfig),
  metadata: parseJsonObject(task.metadata),
  pty_session: null,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: {
      id: true,
      projectId: true,
      title: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      backendType: true,
      sessionId: true,
      sessionFilePath: true,
      launchConfig: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      project: {
        select: {
          daemonHost: true,
        },
      },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if ((task.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "PTY task does not support worktree cleanup" }, { status: 409 });
  }

  const worktreeConfig = parseTaskWorktreeLaunchConfig(task.launchConfig);
  if (!worktreeConfig) {
    return NextResponse.json({ error: "Task does not use an isolated worktree" }, { status: 409 });
  }

  const normalizedStatus = normalizeTaskStatus(task.status);
  if (normalizedStatus !== "completed" && normalizedStatus !== "killed") {
    return NextResponse.json({ error: "Stop this task before removing its worktree" }, { status: 409 });
  }
  const daemonHost =
    resolveTaskWorktreeCleanupHost({
      boundHost: realtimeHub.getTaskAgentHost(task.id),
      agentHost: task.agentHost,
      executionHost: task.executionHost,
      metadata: task.metadata,
      projectDaemonHost: task.project.daemonHost,
    });
  if (!daemonHost) {
    return NextResponse.json({ error: "Task missing daemon binding" }, { status: 409 });
  }
  if (!realtimeHub.hasAgentHost(daemonHost, user.id)) {
    return NextResponse.json({ error: `Task daemon ${daemonHost} is offline` }, { status: 409 });
  }

  const cleanupTarget = await db.$transaction(async (tx) => {
    await acquireTaskWorktreeMutationLock(tx as any, task.id);
    const sharedWorktreeTask =
      (
        await tx.task.findMany({
          where: {
            projectId: task.projectId,
            id: { not: task.id },
          },
          select: {
            id: true,
            launchConfig: true,
          },
        })
      ).find((candidate) => hasSameTaskWorktreeRoot(task.launchConfig, candidate.launchConfig)) ??
      null;
    if (sharedWorktreeTask?.id && sharedWorktreeTask.id !== task.id) {
      return {
        ok: false,
        error: "Worktree is still shared with another task",
        status: 409,
      } as const;
    }

    return {
      ok: true,
      agentHost: daemonHost,
      launchConfig: task.launchConfig,
    } as const;
  });

  if (!cleanupTarget.ok) {
    return NextResponse.json(
      { error: cleanupTarget.error },
      { status: cleanupTarget.status },
    );
  }

  const cleanupResult = await requestTaskWorktreeCleanup({
    userId: user.id,
    agentHost: cleanupTarget.agentHost,
    taskId: task.id,
    projectId: task.projectId,
    launchConfig: cleanupTarget.launchConfig,
  });
  if (!cleanupResult.ok) {
    return NextResponse.json(
      { error: cleanupResult.error },
      { status: cleanupResult.status },
    );
  }

  return NextResponse.json({
    task: serializeTaskResponse(task),
    cleaned_at: cleanupResult.result.cleaned_at,
    removed_path: cleanupResult.result.removed_path,
    worktree_branch: cleanupResult.result.worktree_branch,
  });
}
