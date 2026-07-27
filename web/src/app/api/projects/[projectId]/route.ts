import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentDirectory } from "@/lib/tasks/task-file-storage";
import {
  buildTaskWorktreeCleanupOutboxData,
  getTaskWorktreeRootKey,
  resolveTaskWorktreeCleanupHost,
} from "@/lib/tasks/worktree";
import { stopTaskBeforeRelaunch } from "@/lib/tasks/task-stop";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";
import { realtimeHub } from "@/lib/realtime/hub";
import { countActiveScheduledMessagesForProjects } from "@/lib/tasks/scheduled-messages";
import {
  hasOwn,
  isBindingConfirmed,
  normalizeBoolean,
  normalizeOptionalInt,
  normalizeOptionalString,
  normalizeOptionalWorkspacePath,
  normalizeWorkspacePath,
  parseProjectMetadata,
  PROJECT_SERIALIZATION_SELECT,
  readField,
  readProjectBindingCandidateInput,
  readProjectBindingInput,
  readProjectBindingPath,
  readProjectMetadataInput,
  serializeProject,
} from "../shared";

const findProjectBindingConflict = async (params: {
  userId: string;
  daemonHost: string;
  workspacePath: string;
  excludeProjectId?: string | null;
}) => {
  const normalizedWorkspacePath = normalizeWorkspacePath(params.workspacePath);
  const excludeFilter = params.excludeProjectId
    ? { id: { not: params.excludeProjectId } }
    : {};

  const confirmedConflict = await db.project.findFirst({
    where: {
      userId: params.userId,
      daemonHost: params.daemonHost,
      workspacePath: normalizedWorkspacePath,
      ...excludeFilter,
    },
    select: { id: true, daemonHost: true, workspacePath: true, metadata: true },
  });
  if (confirmedConflict) {
    return confirmedConflict;
  }

  const pendingCandidates = await db.project.findMany({
    where: {
      userId: params.userId,
      daemonHost: null,
      ...excludeFilter,
    },
    select: { id: true, daemonHost: true, workspacePath: true, metadata: true },
  });

  for (const project of pendingCandidates) {
    const projectPath = readProjectBindingPath(project, params.daemonHost);
    if (!projectPath) {
      continue;
    }
    if (normalizeWorkspacePath(projectPath) === normalizedWorkspacePath) {
      return project;
    }
  }

  return null;
};

const findProjectNameConflict = async (params: {
  userId: string;
  daemonHost: string | null;
  name: string;
  excludeProjectId?: string | null;
}) => {
  if (!params.daemonHost || !params.name) {
    return null;
  }

  return db.project.findFirst({
    where: {
      userId: params.userId,
      daemonHost: params.daemonHost,
      name: params.name,
      ...(params.excludeProjectId ? { id: { not: params.excludeProjectId } } : {}),
    },
    select: { id: true },
  });
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: PROJECT_SERIALIZATION_SELECT,
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const activeScheduledMessageCounts = await countActiveScheduledMessagesForProjects({
    userId: user.id,
    projectIds: [projectId],
  });

  return NextResponse.json(
    {
      ...serializeProject(project, defaultProject?.projectId === projectId),
      activeScheduledMessageCount: activeScheduledMessageCounts.get(projectId) ?? 0,
      active_scheduled_message_count: activeScheduledMessageCounts.get(projectId) ?? 0,
    },
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const [{ projectId }, body] = await Promise.all([
    params,
    request.json(),
  ]);
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const rawName = normalizedBody.name;
  const name = typeof rawName === "string" ? rawName.trim() : undefined;
  if (typeof rawName === "string" && !name) {
    return NextResponse.json({ error: "Project name cannot be empty" }, { status: 400 });
  }
  const binding = readProjectBindingInput(normalizedBody);
  const bindingConfirmed = isBindingConfirmed(normalizedBody);
  const metadataInput = readProjectMetadataInput(normalizedBody);
  if (metadataInput.error) {
    return NextResponse.json({ error: metadataInput.error }, { status: 400 });
  }
  const hasBindingIdentityField = binding.daemonHost !== null || binding.workspacePath !== null;
  const hasSnapshotField =
    binding.repoRoot !== null ||
    binding.worktreeBranch !== null ||
    binding.lastCommit !== null ||
    binding.lastCommitAt !== null ||
    binding.fileCount !== null;
  const hasBindingField = hasBindingIdentityField || hasSnapshotField;

  // Use the pre-serialized string from the validator so the bytes we store
  // match the bytes we size-checked. Anything that survives `error` handling
  // above is either `null` (clear) or a non-null serialized object.
  const metadata: string | null | undefined = metadataInput.hasField
    ? metadataInput.serialized
    : undefined;

  if (!name && metadata === undefined && !hasBindingField) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const existingProject = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: {
      id: true,
      daemonHost: true,
      workspacePath: true,
      repoRoot: true,
      worktreeBranch: true,
      lastCommit: true,
      lastCommitAt: true,
      fileCount: true,
    },
  });
  if (!existingProject) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  if (defaultProject?.projectId === projectId && hasBindingIdentityField) {
    return NextResponse.json({ error: "Default project binding cannot be changed" }, { status: 409 });
  }

  if (hasBindingField && !bindingConfirmed) {
    return NextResponse.json(
      { error: "Binding fields require confirmed binding from daemon/CLI" },
      { status: 409 },
    );
  }

  if (hasBindingIdentityField && (!binding.daemonHost || !binding.workspacePath)) {
    return NextResponse.json({ error: "daemonHost and workspacePath are required to bind a project" }, { status: 400 });
  }

  if (bindingConfirmed && hasBindingIdentityField) {
    const bindingConflict = await findProjectBindingConflict({
      userId: user.id,
      daemonHost: binding.daemonHost!,
      workspacePath: binding.workspacePath!,
      excludeProjectId: projectId,
    });
    if (bindingConflict) {
      return NextResponse.json({ error: "Project binding already exists" }, { status: 409 });
    }
  }

  const effectiveDaemonHost = binding.daemonHost ?? existingProject.daemonHost;
  const projectNameConflict = name
    ? await findProjectNameConflict({
        userId: user.id,
        daemonHost: effectiveDaemonHost,
        name,
        excludeProjectId: projectId,
      })
    : null;
  if (projectNameConflict) {
    return NextResponse.json({ error: "Project name already exists on this daemon" }, { status: 409 });
  }

  const bindingIdentityChange =
    (binding.daemonHost !== null && binding.daemonHost !== existingProject.daemonHost) ||
    (binding.workspacePath !== null && binding.workspacePath !== existingProject.workspacePath);
  if (bindingIdentityChange && (existingProject.daemonHost || existingProject.workspacePath)) {
    return NextResponse.json({ error: "Project binding is immutable; create a new project to rebind" }, { status: 409 });
  }

  let updatedCount;
  try {
    const result = await db.project.updateMany({
      where: { id: projectId, userId: user.id },
      data: {
        name: name ?? undefined,
        daemonHost: binding.daemonHost ?? undefined,
        workspacePath: binding.workspacePath ?? undefined,
        repoRoot: binding.repoRoot ?? undefined,
        worktreeBranch: binding.worktreeBranch ?? undefined,
        lastCommit: binding.lastCommit ?? undefined,
        lastCommitAt: binding.lastCommitAt ?? undefined,
        fileCount: binding.fileCount ?? undefined,
        metadata,
      },
    });
    updatedCount = result.count;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: name ? "Project name already exists on this daemon" : "Project binding already exists" },
        { status: 409 },
      );
    }
    throw error;
  }

  if (updatedCount === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await db.project.findUnique({
    where: { id: projectId },
    select: PROJECT_SERIALIZATION_SELECT,
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(serializeProject(updated, defaultProject?.projectId === projectId));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const existing = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true, name: true, daemonHost: true },
  });

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  if (defaultProject?.projectId === existing.id) {
    return NextResponse.json({ error: "Cannot delete default project" }, { status: 400 });
  }

  const tasks = await db.task.findMany({
    where: { projectId },
    select: {
      id: true,
      taskType: true,
      launchConfig: true,
      metadata: true,
      agentHost: true,
      executionHost: true,
      status: true,
    },
  });
  const taskIds = tasks.map((task) => task.id);
  const cleanupTargets = new Map<
    string,
    {
      task: (typeof tasks)[number];
      agentHost: string;
    }
  >();
  const activeTasks: Array<{
    taskId: string;
    agentHost: string;
    taskLabel: string;
  }> = [];

  for (const task of tasks) {
    const taskHost = resolveTaskWorktreeCleanupHost({
      boundHost: realtimeHub.getTaskAgentHost(task.id),
      agentHost: task.agentHost,
      executionHost: task.executionHost,
      metadata: task.metadata,
      projectDaemonHost: existing.daemonHost,
    });
    const worktreeRootKey = getTaskWorktreeRootKey(task.launchConfig);
    if (worktreeRootKey && taskHost && !cleanupTargets.has(worktreeRootKey)) {
      cleanupTargets.set(worktreeRootKey, { task, agentHost: taskHost });
    }
    const normalizedTaskStatus = normalizeTaskStatus(task.status);
    if (
      normalizedTaskStatus === "running" ||
      normalizedTaskStatus === "killing" ||
      normalizedTaskStatus === "unknown"
    ) {
      if (!taskHost) {
        return NextResponse.json({ error: "Task missing daemon binding" }, { status: 409 });
      }
      activeTasks.push({
        taskId: task.id,
        agentHost: taskHost,
        taskLabel: task.taskType === "pty_task" ? "PTY task" : "task",
      });
    }
  }

  const stopResults = await Promise.allSettled(
    activeTasks.map((activeTask) =>
      stopTaskBeforeRelaunch({
        userId: user.id,
        taskId: activeTask.taskId,
        projectId,
        stopTargetHost: activeTask.agentHost,
        reason: "project_deleted",
        taskLabel: activeTask.taskLabel,
      }),
    ),
  );
  for (let i = 0; i < stopResults.length; i++) {
    const result = stopResults[i];
    const activeTask = activeTasks[i];
    if (result.status === "rejected" || !result.value.ok) {
      const error =
        result.status === "rejected"
          ? String(result.reason)
          : result.value.error ?? `Failed to stop task ${activeTask.taskId}`;
      return NextResponse.json({ error }, { status: 409 });
    }
  }

  await db.$transaction(async (tx) => {
    for (const { task, agentHost } of cleanupTargets.values()) {
      await tx.agentOutbox.create({
        data: buildTaskWorktreeCleanupOutboxData({
          userId: user.id,
          agentHost,
          taskId: task.id,
          projectId,
          launchConfig: task.launchConfig,
          requestId: randomUUID(),
          force: true,
        }),
      });
    }

    if (taskIds.length > 0) {
      await tx.message.deleteMany({
        where: {
          taskId: {
            in: taskIds,
          },
        },
      });
    }

    await tx.task.deleteMany({
      where: { projectId },
    });
    // Tasks that were *displayed* under this project via the display-only
    // `secondProjectId` override still live in their real (default) project.
    // Clearing the override reverts them to the inbox instead of leaving them
    // orphaned — pointing at a project that no longer exists would hide them
    // from every task-list view (excluded from default, target gone).
    await tx.task.updateMany({
      where: { secondProjectId: projectId },
      data: { secondProjectId: null },
    });
    await tx.project.delete({
      where: { id: projectId },
    });
  });

  await Promise.all(
    taskIds.map((taskId) =>
      Promise.resolve(deleteTaskAttachmentDirectory(taskId)).catch((error) => {
        console.error(
          `[projects] failed to delete attachment directory after project delete: projectId=${projectId}, taskId=${taskId}, error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
    ),
  );

  await Promise.all(taskIds.map((taskId) => Promise.resolve(realtimeHub.unbindTask(taskId))));

  return new NextResponse(null, { status: 204 });
}
