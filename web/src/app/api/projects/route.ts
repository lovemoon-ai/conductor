import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { requireActiveSubscription } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentDirectory } from "@/lib/tasks/task-file-storage";
import {
  ProjectBindingValidationError,
  validateProjectBindingWithDaemon,
} from "@/lib/projects/daemon-binding";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  buildTaskWorktreeCleanupOutboxData,
  getTaskWorktreeRootKey,
  resolveTaskWorktreeCleanupHost,
} from "@/lib/tasks/worktree";
import { stopTaskBeforeRelaunch } from "@/lib/tasks/task-stop";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";
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
  PROJECT_SERIALIZATION_WITH_SORT_SELECT,
  readField,
  readProjectBindingCandidateInput,
  readProjectBindingInput,
  readProjectBindingPath,
  readProjectMetadataInput,
  isMissingProjectSortOrderColumnError,
  compareProjectsForDisplay,
  serializeProject,
} from "./shared";

const findProjectBindingMatch = async (params: {
  userId: string;
  daemonHost: string;
  workspacePath: string;
  excludeProjectId?: string | null;
}) => {
  const normalizedWorkspacePath = normalizeWorkspacePath(params.workspacePath);
  const excludeFilter = params.excludeProjectId
    ? { id: { not: params.excludeProjectId } }
    : {};

  const confirmedMatch = await db.project.findFirst({
    where: {
      userId: params.userId,
      daemonHost: params.daemonHost,
      workspacePath: normalizedWorkspacePath,
      ...excludeFilter,
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      daemonHost: true,
      workspacePath: true,
      repoRoot: true,
      worktreeBranch: true,
      lastCommit: true,
      fileCount: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (confirmedMatch) {
    return confirmedMatch;
  }

  const pendingCandidates = await db.project.findMany({
    where: {
      userId: params.userId,
      daemonHost: null,
      ...excludeFilter,
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      daemonHost: true,
      workspacePath: true,
      repoRoot: true,
      worktreeBranch: true,
      lastCommit: true,
      fileCount: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  for (const project of pendingCandidates) {
    const projectPath = readProjectBindingPath(project, params.daemonHost);
    if (!projectPath) {
      continue;
    }
    if (normalizeWorkspacePath(projectPath) !== normalizedWorkspacePath) {
      continue;
    }
    return project;
  }

  return null;
};

const serializeProjectMetadata = (
  metadata: Record<string, unknown> | null | undefined,
  bindingCandidate: { daemonHost: string; workspacePath: string } | null,
): string | null | undefined => {
  const normalizedMetadata =
    metadata && typeof metadata === "object"
      ? Object.fromEntries(
          Object.entries(metadata).filter(
            ([key]) => key !== "bindingCandidate" && key !== "binding_candidate",
          ),
        )
      : metadata;
  if (metadata === undefined) {
    return bindingCandidate ? JSON.stringify({ bindingCandidate }) : undefined;
  }
  if (metadata === null) {
    return bindingCandidate ? JSON.stringify({ bindingCandidate }) : null;
  }
  if (!bindingCandidate) {
    return JSON.stringify(normalizedMetadata);
  }
  return JSON.stringify({
    ...normalizedMetadata,
    bindingCandidate,
  });
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

const listProjectsForDisplay = async (userId: string) => {
  try {
    return await db.project.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      select: PROJECT_SERIALIZATION_WITH_SORT_SELECT,
    });
  } catch (error) {
    if (!isMissingProjectSortOrderColumnError(error)) {
      throw error;
    }
    return db.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: PROJECT_SERIALIZATION_SELECT,
    });
  }
};

const getNextProjectSortOrder = async (userId: string): Promise<number | null> => {
  try {
    const result = await db.project.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    const maxSortOrder = result._max.sortOrder;
    return typeof maxSortOrder === "number" && Number.isInteger(maxSortOrder)
      ? maxSortOrder + 1
      : 0;
  } catch (error) {
    if (isMissingProjectSortOrderColumnError(error)) {
      return null;
    }
    throw error;
  }
};

export const GET = requireActiveSubscription(async (_request: NextRequest, user) => {
  const [projects, defaultProjects, taskStatusGroups] = await Promise.all([
    listProjectsForDisplay(user.id),
    db.defaultProject.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    }),
    db.task.groupBy({
      by: ["projectId", "status"],
      where: { project: { userId: user.id } },
      _count: { _all: true },
    }),
  ]);
  const defaultProjectIds = new Set(defaultProjects.map((entry) => entry.projectId));

  // Build per-project task status counts with normalized status keys.
  const taskCountsByProject = new Map<string, Record<string, number>>();
  for (const group of taskStatusGroups) {
    const normalizedStatus = normalizeTaskStatus(group.status);
    if (!taskCountsByProject.has(group.projectId)) {
      taskCountsByProject.set(group.projectId, {});
    }
    const counts = taskCountsByProject.get(group.projectId)!;
    counts[normalizedStatus] = (counts[normalizedStatus] ?? 0) + group._count._all;
  }

  return NextResponse.json(
    [...projects].sort(compareProjectsForDisplay).map((p) => ({
      ...serializeProject(p, defaultProjectIds.has(p.id)),
      taskStatusCounts: taskCountsByProject.get(p.id) ?? {},
      task_status_counts: taskCountsByProject.get(p.id) ?? {},
    }))
  );
});

export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const rawName = normalizedBody.name;
  const hasNameField = typeof rawName === "string";
  const nameInput = hasNameField ? rawName.trim() : "";
  if (hasNameField && !nameInput) {
    return NextResponse.json({ error: "Project name cannot be empty" }, { status: 400 });
  }
  const name = nameInput || "New Project";

  const binding = readProjectBindingInput(normalizedBody);
  const bindingConfirmed = isBindingConfirmed(normalizedBody);
  const isDefaultProject = normalizeBoolean(readField(normalizedBody, "is_default", "isDefault"));
  const metadataInput = readProjectMetadataInput(normalizedBody);
  if (metadataInput.error) {
    return NextResponse.json({ error: metadataInput.error }, { status: 400 });
  }
  const bindingCandidate = readProjectBindingCandidateInput(metadataInput.value);
  const hasBindingIdentityField = binding.daemonHost !== null || binding.workspacePath !== null;
  const hasSnapshotField =
    binding.repoRoot !== null ||
    binding.worktreeBranch !== null ||
    binding.lastCommit !== null ||
    binding.fileCount !== null;
  const hasUnconfirmedBindingFields = hasBindingIdentityField || hasSnapshotField;
  const shouldValidateWithDaemon =
    !isDefaultProject &&
    !bindingConfirmed &&
    binding.daemonHost !== null &&
    binding.workspacePath !== null;

  if (isDefaultProject && (bindingConfirmed || hasUnconfirmedBindingFields || bindingCandidate)) {
    return NextResponse.json({ error: "Default project cannot be bound to a daemon path" }, { status: 400 });
  }

  let effectiveBinding = binding;
  let effectiveBindingConfirmed = bindingConfirmed;
  let effectiveBindingCandidate = bindingCandidate;

  if (!isDefaultProject && !bindingConfirmed) {
    if (shouldValidateWithDaemon) {
      if (hasSnapshotField) {
        return NextResponse.json(
          { error: "Snapshot fields require confirmed binding from daemon/CLI" },
          { status: 409 },
        );
      }
      if (bindingCandidate) {
        return NextResponse.json(
          { error: "bindingCandidate metadata cannot be combined with daemonHost/workspacePath" },
          { status: 400 },
        );
      }
      try {
        const validatedBinding = await validateProjectBindingWithDaemon({
          userId: user.id,
          daemonHost: binding.daemonHost!,
          workspacePath: binding.workspacePath!,
        });
        effectiveBinding = {
          daemonHost: validatedBinding.daemonHost,
          workspacePath: validatedBinding.workspacePath,
          repoRoot: validatedBinding.repoRoot,
          worktreeBranch: validatedBinding.worktreeBranch,
          lastCommit: validatedBinding.lastCommit,
          fileCount: validatedBinding.fileCount,
        };
        effectiveBindingConfirmed = true;
        effectiveBindingCandidate = null;
      } catch (error) {
        if (error instanceof ProjectBindingValidationError) {
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
      }
    } else {
      if (hasUnconfirmedBindingFields) {
        return NextResponse.json({ error: "Binding fields require confirmed binding from daemon/CLI" }, { status: 409 });
      }
      if (!bindingCandidate) {
        return NextResponse.json(
          { error: "bindingCandidate metadata is required for non-default projects" },
          { status: 400 },
        );
      }
    }
  }
  const serializedMetadata = serializeProjectMetadata(
    metadataInput.value,
    !effectiveBindingConfirmed ? effectiveBindingCandidate : null,
  );

  if (isDefaultProject) {
    const defaultProject = await db.defaultProject.findUnique({
      where: { userId: user.id },
      select: { projectId: true },
    });
    if (defaultProject) {
      return NextResponse.json({ error: "Default project already exists" }, { status: 409 });
    }
  }

  if (!isDefaultProject && effectiveBindingConfirmed && (!effectiveBinding.daemonHost || !effectiveBinding.workspacePath)) {
    return NextResponse.json({ error: "daemonHost and workspacePath are required" }, { status: 400 });
  }

  if (!isDefaultProject && !effectiveBindingConfirmed && effectiveBindingCandidate) {
    const existingBinding = await findProjectBindingMatch({
      userId: user.id,
      daemonHost: effectiveBindingCandidate.daemonHost,
      workspacePath: effectiveBindingCandidate.workspacePath,
    });
    if (existingBinding) {
      return NextResponse.json({ error: "Project binding already exists" }, { status: 409 });
    }
  }

  if (effectiveBindingConfirmed) {
    const existingByBinding = await findProjectBindingMatch({
      userId: user.id,
      daemonHost: effectiveBinding.daemonHost!,
      workspacePath: effectiveBinding.workspacePath!,
    });
    const nameConflict = hasNameField
      ? await findProjectNameConflict({
          userId: user.id,
          daemonHost: effectiveBinding.daemonHost!,
          name,
          excludeProjectId: existingByBinding?.id ?? null,
        })
      : null;
    if (nameConflict) {
      return NextResponse.json({ error: "Project name already exists on this daemon" }, { status: 409 });
    }
    if (existingByBinding) {
      const promotedMetadata =
        !metadataInput.hasField && existingByBinding.metadata
          ? serializeProjectMetadata(parseProjectMetadata(existingByBinding.metadata), null)
          : undefined;
      const updated = await db.project.update({
        where: { id: existingByBinding.id },
        data: {
          name: hasNameField ? name : undefined,
          daemonHost: effectiveBinding.daemonHost ?? undefined,
          workspacePath: effectiveBinding.workspacePath ?? undefined,
          repoRoot: effectiveBinding.repoRoot ?? undefined,
          worktreeBranch: effectiveBinding.worktreeBranch ?? undefined,
          lastCommit: effectiveBinding.lastCommit ?? undefined,
          fileCount: effectiveBinding.fileCount ?? undefined,
          metadata: metadataInput.hasField ? serializedMetadata : promotedMetadata,
        },
        select: PROJECT_SERIALIZATION_SELECT,
      });
      return NextResponse.json(serializeProject(updated, false));
    }
  }

  if (!effectiveBindingConfirmed && hasNameField && effectiveBindingCandidate) {
    const nameConflict = await findProjectNameConflict({
      userId: user.id,
      daemonHost: effectiveBindingCandidate.daemonHost,
      name,
    });
    if (nameConflict) {
      return NextResponse.json({ error: "Project name already exists on this daemon" }, { status: 409 });
    }
  }

  if (!effectiveBindingConfirmed) {
    const effectiveName = isDefaultProject ? (hasNameField ? name : "Default Project") : name;
    const unboundNameConflict = await db.project.findFirst({
      where: {
        userId: user.id,
        daemonHost: null,
        name: effectiveName,
      },
      select: { id: true },
    });
    if (unboundNameConflict) {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
  }

  let project;
  try {
    const nextSortOrder = await getNextProjectSortOrder(user.id);
    const projectData = {
      userId: user.id,
      name: isDefaultProject ? (hasNameField ? name : "Default Project") : name,
      daemonHost: effectiveBindingConfirmed ? effectiveBinding.daemonHost : null,
      workspacePath: effectiveBindingConfirmed ? effectiveBinding.workspacePath : null,
      repoRoot: effectiveBindingConfirmed ? effectiveBinding.repoRoot : null,
      worktreeBranch: effectiveBindingConfirmed ? effectiveBinding.worktreeBranch : null,
      lastCommit: effectiveBindingConfirmed ? effectiveBinding.lastCommit : null,
      fileCount: effectiveBindingConfirmed ? effectiveBinding.fileCount : null,
      metadata: serializedMetadata,
      ...(nextSortOrder === null ? {} : { sortOrder: nextSortOrder }),
    };
    project = await db.project.create({
      data: projectData,
      select: nextSortOrder === null ? PROJECT_SERIALIZATION_SELECT : PROJECT_SERIALIZATION_WITH_SORT_SELECT,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Project binding already exists" }, { status: 409 });
    }
    throw error;
  }

  if (isDefaultProject) {
    try {
      await db.defaultProject.create({
        data: {
          userId: user.id,
          projectId: project.id,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: "Default project already exists" }, { status: 409 });
      }
      throw error;
    }
  }

  return NextResponse.json(serializeProject(project, isDefaultProject));
});

export const PATCH = requireActiveSubscription(async (request: NextRequest, user) => {
  const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const rawName = normalizedBody.name;
  const hasNameField = typeof rawName === "string";
  const name = hasNameField ? rawName.trim() : undefined;
  const binding = readProjectBindingInput(normalizedBody);
  const bindingConfirmed = isBindingConfirmed(normalizedBody);
  const metadataInput = readProjectMetadataInput(normalizedBody);
  if (metadataInput.error) {
    return NextResponse.json({ error: metadataInput.error }, { status: 400 });
  }

  if (hasNameField && !name) {
    return NextResponse.json({ error: "Project name cannot be empty" }, { status: 400 });
  }

  let metadata: string | null | undefined;
  if (metadataInput.hasField) {
    metadata =
      metadataInput.value === null
        ? null
        : metadataInput.value === undefined
          ? undefined
          : JSON.stringify(metadataInput.value);
  }

  const hasBindingIdentityField = binding.daemonHost !== null || binding.workspacePath !== null;
  const hasSnapshotField =
    binding.repoRoot !== null ||
    binding.worktreeBranch !== null ||
    binding.lastCommit !== null ||
    binding.fileCount !== null;
  const hasBindingField = hasBindingIdentityField || hasSnapshotField;

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

  const projectNameConflict = name
    ? await findProjectNameConflict({
        userId: user.id,
        daemonHost: binding.daemonHost ?? existingProject.daemonHost,
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
        fileCount: binding.fileCount ?? undefined,
        metadata,
      },
    });
    updatedCount = result.count;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: hasNameField ? "Project name already exists on this daemon" : "Project binding already exists" },
        { status: 409 },
      );
    }
    throw error;
  }

  if (updatedCount === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: PROJECT_SERIALIZATION_SELECT,
  });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const isDefault = defaultProject?.projectId === projectId;

  return NextResponse.json(serializeProject(project, isDefault));
});

export const DELETE = requireActiveSubscription(async (request: NextRequest, user) => {
  const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const existing = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true, name: true, daemonHost: true },
  });
  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
});
