/**
 * AttachedTerminal API — bind one PTY task to one AI task.
 *
 * URL is intentionally singular (`/terminal`, not `/terminals/[id]`): the
 * data model enforces 1:1 via @unique on AttachedTerminal.aiTaskId, and the
 * URL encodes that contract so a future move to N:1 is a visible breaking
 * change rather than a silent expansion.
 *
 * The PTY task itself is a regular Task(task_type=pty_task), so the daemon
 * protocol and TerminalView never need to know about this layer — only the
 * top-level task list query has to filter out attached PTY tasks (see
 * findAttachedPtyTaskIdsByProjects).
 */

import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  ATTACHED_TERMINAL_SCHEMA_UNAVAILABLE_MESSAGE,
  createAttachedTerminalRecord,
  deletePtyTaskWithKill,
  dispatchAttachedTerminalCreation,
  findAttachedTerminalForAiTask,
  inheritPtyLaunchConfigFromAiTask,
  isMissingAttachedTerminalSchemaError,
  resolveAttachedTerminalAgentHost,
} from "@/lib/tasks/attached-terminal";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";

const fetchAiTask = async (taskId: string, userId: string) =>
  db.task.findFirst({
    where: { id: taskId, project: { userId } },
    select: {
      id: true,
      projectId: true,
      title: true,
      taskType: true,
      agentHost: true,
      launchConfig: true,
      project: {
        select: {
          daemonHost: true,
          workspacePath: true,
        },
      },
    },
  });

// Defense-in-depth user scope. The caller chain already proves the user
// owns the PTY task (we looked it up via a user-scoped AttachedTerminal),
// but anchoring the user predicate here too prevents a future refactor from
// silently widening the auth boundary.
const loadAttachedPtyTask = async (ptyTaskId: string, userId: string) =>
  db.task.findFirst({
    where: { id: ptyTaskId, project: { userId } },
    include: { ptySession: true },
  });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const aiTask = await fetchAiTask(taskId, user.id);
  if (!aiTask) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((aiTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json(
      { error: "Attached terminals are only supported for ai_task" },
      { status: 400 },
    );
  }

  const attached = await findAttachedTerminalForAiTask(aiTask.id);
  if (!attached) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const ptyTask = await loadAttachedPtyTask(attached.ptyTaskId, user.id);
  if (!ptyTask) {
    // Inconsistent state — the cascade should have kept these together.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: attached.id,
    ai_task_id: attached.aiTaskId,
    pty_task_id: attached.ptyTaskId,
    created_at: attached.createdAt.toISOString(),
    updated_at: attached.updatedAt.toISOString(),
    pty_task: serializeTaskResponse(ptyTask),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const aiTask = await fetchAiTask(taskId, user.id);
  if (!aiTask) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((aiTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json(
      { error: "Attached terminals are only supported for ai_task" },
      { status: 400 },
    );
  }

  // Enforce 1:1 before doing any expensive agent work. The DB also enforces
  // this via @unique on aiTaskId, but checking first gives a clean 409 vs.
  // an opaque Prisma error.
  const existingAttached = await findAttachedTerminalForAiTask(aiTask.id);
  if (existingAttached) {
    return NextResponse.json(
      { error: "This task already has an attached terminal" },
      { status: 409 },
    );
  }

  const ptyLaunchConfig = inheritPtyLaunchConfigFromAiTask(
    aiTask.launchConfig,
    aiTask.project?.workspacePath ?? null,
  );

  const agentResolution = resolveAttachedTerminalAgentHost({
    userId: user.id,
    aiTaskAgentHost: aiTask.agentHost,
    projectDaemonHost: aiTask.project?.daemonHost ?? null,
    ptyLaunchConfig,
  });
  if ("error" in agentResolution) {
    return NextResponse.json({ error: agentResolution.error }, { status: agentResolution.status });
  }

  let created: Awaited<ReturnType<typeof createAttachedTerminalRecord>>;
  try {
    created = await createAttachedTerminalRecord({
      aiTask,
      ptyTaskTitle: `${aiTask.title} · terminal`,
      agentHost: agentResolution.agentHost,
      ptyLaunchConfig,
      status: normalizeTaskStatus("init"),
    });
  } catch (error) {
    if (isMissingAttachedTerminalSchemaError(error)) {
      return NextResponse.json(
        { error: ATTACHED_TERMINAL_SCHEMA_UNAVAILABLE_MESSAGE },
        { status: 409 },
      );
    }
    // Prisma unique-violation when racing two POSTs.
    if ((error as { code?: unknown })?.code === "P2002") {
      return NextResponse.json(
        { error: "This task already has an attached terminal" },
        { status: 409 },
      );
    }
    // P2003 = FK violation. Hit when the AI task is deleted between our
    // existence check and the insert (the AttachedTerminal.aiTaskId FK can't
    // resolve). Return 404 instead of 500 so the client retries the right
    // way.
    if ((error as { code?: unknown })?.code === "P2003") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  // If agent dispatch throws (agent disconnected mid-request, outbox queue
  // failure, etc.) the AttachedTerminal + PTY Task rows would be left
  // pointing at a process that was never spawned. Roll back so the user can
  // retry cleanly instead of seeing a zombie terminal.
  try {
    await dispatchAttachedTerminalCreation({
      userId: user.id,
      agentHost: agentResolution.agentHost,
      ptyTask: {
        id: created.ptyTask.id,
        projectId: created.ptyTask.projectId,
        title: created.ptyTask.title,
      },
      ptySessionId: created.ptySession.id,
      launchConfig: ptyLaunchConfig,
    });
  } catch (dispatchError) {
    console.error(
      `[attached-terminal] dispatch failed; rolling back: aiTaskId=${aiTask.id}, ptyTaskId=${created.ptyTask.id}, error=${
        dispatchError instanceof Error ? dispatchError.message : String(dispatchError)
      }`,
    );
    // forceStop: even though the row is still "init", the agent may have
    // already received the create envelope before the dispatch JS threw
    // (partial network send / outbox race). Issue a stop_task anyway so
    // we don't leak a process on the agent.
    await deletePtyTaskWithKill({
      userId: user.id,
      ptyTaskId: created.ptyTask.id,
      forceStop: true,
    }).catch((rollbackError) => {
      console.error(
        `[attached-terminal] rollback also failed: ptyTaskId=${created.ptyTask.id}, error=${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
      );
    });
    return NextResponse.json(
      { error: "Failed to start terminal on the agent. Please retry." },
      { status: 502 },
    );
  }

  const ptyTaskWithSession = { ...created.ptyTask, ptySession: created.ptySession };
  return NextResponse.json(
    {
      id: created.attached.id,
      ai_task_id: created.attached.aiTaskId,
      pty_task_id: created.attached.ptyTaskId,
      created_at: created.attached.createdAt.toISOString(),
      updated_at: created.attached.updatedAt.toISOString(),
      pty_task: serializeTaskResponse(ptyTaskWithSession),
    },
    { status: 201 },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const aiTask = await fetchAiTask(taskId, user.id);
  if (!aiTask) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((aiTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json(
      { error: "Attached terminals are only supported for ai_task" },
      { status: 400 },
    );
  }

  const attached = await findAttachedTerminalForAiTask(aiTask.id);
  if (!attached) {
    // Idempotent: a second DELETE after success is not an error.
    return new NextResponse(null, { status: 204 });
  }

  await deletePtyTaskWithKill({ userId: user.id, ptyTaskId: attached.ptyTaskId });
  // The AttachedTerminal row is cascade-deleted when the PTY task is deleted
  // (FK relation "AttachedTerminalPtyTask" has onDelete: Cascade).
  return new NextResponse(null, { status: 204 });
}
