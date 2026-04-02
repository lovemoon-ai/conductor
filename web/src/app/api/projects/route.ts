import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireActiveSubscription } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentDirectory } from "@/lib/conductor/task-file-storage";

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string,
  nested?: Record<string, unknown> | null,
): unknown => {
  if (hasOwn(body, snakeCaseKey)) {
    return body[snakeCaseKey];
  }
  if (hasOwn(body, camelCaseKey)) {
    return body[camelCaseKey];
  }
  if (nested) {
    if (hasOwn(nested, snakeCaseKey)) {
      return nested[snakeCaseKey];
    }
    if (hasOwn(nested, camelCaseKey)) {
      return nested[camelCaseKey];
    }
  }
  return undefined;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeWorkspacePath = (value: string): string => {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized || trimmed;
};

const normalizeOptionalWorkspacePath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeWorkspacePath(value);
  return normalized || null;
};

const normalizeOptionalInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const normalizeBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
};

const readProjectBindingInput = (body: Record<string, unknown>) => {
  const nestedBinding =
    hasOwn(body, "binding") && body.binding && typeof body.binding === "object" && !Array.isArray(body.binding)
      ? (body.binding as Record<string, unknown>)
      : null;

  return {
    daemonHost: normalizeOptionalString(readField(body, "daemon_host", "daemonHost", nestedBinding)),
    workspacePath: normalizeOptionalWorkspacePath(readField(body, "workspace_path", "workspacePath", nestedBinding)),
    repoRoot: normalizeOptionalString(readField(body, "repo_root", "repoRoot", nestedBinding)),
    worktreeBranch: normalizeOptionalString(readField(body, "worktree_branch", "worktreeBranch", nestedBinding)),
    lastCommit: normalizeOptionalString(readField(body, "last_commit", "lastCommit", nestedBinding)),
    fileCount: normalizeOptionalInt(readField(body, "file_count", "fileCount", nestedBinding)),
  };
};

const readProjectBindingCandidateInput = (
  metadata: Record<string, unknown> | null | undefined,
): { daemonHost: string; workspacePath: string } | null => {
  if (!metadata) {
    return null;
  }

  const rawCandidate =
    hasOwn(metadata, "bindingCandidate")
      ? metadata.bindingCandidate
      : hasOwn(metadata, "binding_candidate")
        ? metadata.binding_candidate
        : null;
  if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
    return null;
  }

  const candidate = rawCandidate as Record<string, unknown>;
  const daemonHost = normalizeOptionalString(readField(candidate, "daemon_host", "daemonHost"));
  const workspacePath = normalizeOptionalWorkspacePath(readField(candidate, "workspace_path", "workspacePath"));
  if (!daemonHost || !workspacePath) {
    return null;
  }

  return { daemonHost, workspacePath };
};

const readLegacyLocalPath = (metadata: Record<string, unknown> | null | undefined, daemonHost: string): string | null => {
  if (!metadata) {
    return null;
  }

  const localPaths = metadata.localPaths;
  if (!localPaths) {
    return null;
  }

  if (typeof localPaths === "string") {
    const normalized = normalizeOptionalWorkspacePath(localPaths);
    return normalized || null;
  }

  if (Array.isArray(localPaths)) {
    for (const candidate of localPaths) {
      if (typeof candidate === "string") {
        const normalized = normalizeOptionalWorkspacePath(candidate);
        if (normalized) {
          return normalized;
        }
      }
    }
    return null;
  }

  if (typeof localPaths === "object") {
    const candidate = (localPaths as Record<string, unknown>)[daemonHost];
    const normalized = normalizeOptionalWorkspacePath(candidate);
    return normalized || null;
  }

  return null;
};

const readProjectBindingPath = (
  project: {
    daemonHost: string | null;
    workspacePath: string | null;
    metadata: string | null;
  },
  daemonHost: string,
): string | null => {
  const boundDaemonHost = normalizeOptionalString(project.daemonHost);
  const boundWorkspacePath = normalizeOptionalWorkspacePath(project.workspacePath);
  if (boundDaemonHost && boundWorkspacePath && boundDaemonHost === daemonHost) {
    return boundWorkspacePath;
  }

  const parsed = parseProjectMetadata(project.metadata);
  const candidate = readProjectBindingCandidateInput(parsed);
  if (candidate && candidate.daemonHost === daemonHost) {
    return candidate.workspacePath;
  }

  return readLegacyLocalPath(parsed, daemonHost);
};

const findProjectBindingMatch = async (params: {
  userId: string;
  daemonHost: string;
  workspacePath: string;
  excludeProjectId?: string | null;
}) => {
  const normalizedWorkspacePath = normalizeWorkspacePath(params.workspacePath);

  const projects = await db.project.findMany({
    where: { userId: params.userId },
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

  let bestConfirmedMatch:
    | {
        id: string;
        name: string;
        daemonHost: string | null;
        workspacePath: string | null;
        repoRoot: string | null;
        worktreeBranch: string | null;
        lastCommit: string | null;
        fileCount: number | null;
        metadata: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | null = null;
  let bestPendingMatch:
    | {
        id: string;
        name: string;
        daemonHost: string | null;
        workspacePath: string | null;
        repoRoot: string | null;
        worktreeBranch: string | null;
        lastCommit: string | null;
        fileCount: number | null;
        metadata: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | null = null;

  for (const project of projects) {
    if (params.excludeProjectId && project.id === params.excludeProjectId) {
      continue;
    }
    const projectPath = readProjectBindingPath(project, params.daemonHost);
    if (!projectPath) {
      continue;
    }
    if (normalizeWorkspacePath(projectPath) !== normalizedWorkspacePath) {
      continue;
    }
    const hasBoundDaemonHost = normalizeOptionalString(project.daemonHost) === params.daemonHost;
    const hasBoundWorkspacePath = normalizeOptionalWorkspacePath(project.workspacePath);
    if (hasBoundDaemonHost && hasBoundWorkspacePath) {
      if (!bestConfirmedMatch) {
        bestConfirmedMatch = project;
      }
      continue;
    }
    if (!bestPendingMatch) {
      bestPendingMatch = project;
    }
  }

  return bestConfirmedMatch ?? bestPendingMatch;
};

const serializeProjectMetadata = (
  metadata: Record<string, unknown> | null | undefined,
  bindingCandidate: { daemonHost: string; workspacePath: string } | null,
): string | null | undefined => {
  if (metadata === undefined) {
    return bindingCandidate ? JSON.stringify({ bindingCandidate }) : undefined;
  }
  if (metadata === null) {
    return bindingCandidate ? JSON.stringify({ bindingCandidate }) : null;
  }
  if (!bindingCandidate) {
    return JSON.stringify(metadata);
  }
  return JSON.stringify({
    ...metadata,
    bindingCandidate,
  });
};

const isBindingConfirmed = (body: Record<string, unknown>): boolean =>
  normalizeBoolean(
    readField(body, "binding_confirmed", "bindingConfirmed") ||
      readField(body, "confirmed_binding", "confirmedBinding"),
  );

const readProjectMetadataInput = (body: Record<string, unknown>): {
  hasField: boolean;
  value: Record<string, unknown> | null | undefined;
  error?: string;
} => {
  if (!hasOwn(body, "metadata")) {
    return { hasField: false, value: undefined };
  }

  const raw = body.metadata;
  if (raw === null) {
    return { hasField: true, value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { hasField: true, value: undefined, error: "metadata must be an object or null" };
  }
  return { hasField: true, value: raw as Record<string, unknown> };
};

const parseProjectMetadata = (value: string | null): Record<string, unknown> | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

const serializeProject = (
  project: {
    id: string;
    name: string;
    daemonHost: string | null;
    workspacePath: string | null;
    repoRoot: string | null;
    worktreeBranch: string | null;
    lastCommit: string | null;
    fileCount: number | null;
    metadata: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  isDefault: boolean,
) => ({
  id: project.id,
  name: project.name,
  daemonHost: project.daemonHost,
  workspacePath: project.workspacePath,
  repoRoot: project.repoRoot,
  worktreeBranch: project.worktreeBranch,
  lastCommit: project.lastCommit,
  fileCount: project.fileCount,
  isDefault: isDefault,
  metadata: parseProjectMetadata(project.metadata),
  created_at: project.createdAt.toISOString(),
  updated_at: project.updatedAt.toISOString(),
});

export const GET = requireActiveSubscription(async (_request: NextRequest, user) => {
  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  const defaultProjects = await db.defaultProject.findMany({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const defaultProjectIds = new Set(defaultProjects.map((entry) => entry.projectId));

  return NextResponse.json(
    projects.map((p) => serializeProject(p, defaultProjectIds.has(p.id)))
  );
});

export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const hasNameField = typeof normalizedBody.name === "string";
  const nameInput = hasNameField ? normalizedBody.name.trim() : "";
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
  const hasUnconfirmedBindingFields =
    binding.daemonHost !== null ||
    binding.workspacePath !== null ||
    binding.repoRoot !== null ||
    binding.worktreeBranch !== null ||
    binding.lastCommit !== null ||
    binding.fileCount !== null;
  if (isDefaultProject && (bindingConfirmed || hasUnconfirmedBindingFields || bindingCandidate)) {
    return NextResponse.json({ error: "Default project cannot be bound to a daemon path" }, { status: 400 });
  }
  if (!isDefaultProject && !bindingConfirmed) {
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
  const serializedMetadata = serializeProjectMetadata(
    metadataInput.value,
    !bindingConfirmed ? bindingCandidate : null,
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

  if (!isDefaultProject && bindingConfirmed && (!binding.daemonHost || !binding.workspacePath)) {
    return NextResponse.json({ error: "daemonHost and workspacePath are required" }, { status: 400 });
  }

  if (!isDefaultProject && !bindingConfirmed && bindingCandidate) {
    const existingBinding = await findProjectBindingMatch({
      userId: user.id,
      daemonHost: bindingCandidate.daemonHost,
      workspacePath: bindingCandidate.workspacePath,
    });
    if (existingBinding) {
      return NextResponse.json({ error: "Project binding already exists" }, { status: 409 });
    }
  }

  if (bindingConfirmed) {
    const existingByBinding = await findProjectBindingMatch({
      userId: user.id,
      daemonHost: binding.daemonHost!,
      workspacePath: binding.workspacePath!,
    });
    const nameConflict = hasNameField
      ? await findProjectNameConflict({
          userId: user.id,
          daemonHost: binding.daemonHost!,
          name,
          excludeProjectId: existingByBinding?.id ?? null,
        })
      : null;
    if (nameConflict) {
      return NextResponse.json({ error: "Project name already exists on this daemon" }, { status: 409 });
    }
    if (existingByBinding) {
      const updated = await db.project.update({
        where: { id: existingByBinding.id },
        data: {
          name: hasNameField ? name : undefined,
          repoRoot: binding.repoRoot ?? undefined,
          worktreeBranch: binding.worktreeBranch ?? undefined,
          lastCommit: binding.lastCommit ?? undefined,
          fileCount: binding.fileCount ?? undefined,
          metadata: metadataInput.hasField ? serializedMetadata : undefined,
        },
      });
      return NextResponse.json(serializeProject(updated, false));
    }
  }

  if (!bindingConfirmed && hasNameField && bindingCandidate) {
    const nameConflict = await findProjectNameConflict({
      userId: user.id,
      daemonHost: bindingCandidate.daemonHost,
      name,
    });
    if (nameConflict) {
      return NextResponse.json({ error: "Project name already exists on this daemon" }, { status: 409 });
    }
  }

  let project;
  try {
    project = await db.project.create({
      data: {
        userId: user.id,
        name: isDefaultProject ? (hasNameField ? name : "Default Project") : name,
        daemonHost: bindingConfirmed ? binding.daemonHost : null,
        workspacePath: bindingConfirmed ? binding.workspacePath : null,
        repoRoot: bindingConfirmed ? binding.repoRoot : null,
        worktreeBranch: bindingConfirmed ? binding.worktreeBranch : null,
        lastCommit: bindingConfirmed ? binding.lastCommit : null,
        fileCount: bindingConfirmed ? binding.fileCount : null,
        metadata: serializedMetadata,
      },
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
  const hasNameField = typeof normalizedBody.name === "string";
  const name = hasNameField ? normalizedBody.name.trim() : undefined;
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

  const project = await db.project.findUnique({ where: { id: projectId } });
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
    select: { id: true, name: true },
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
    select: { id: true },
  });
  const taskIds = tasks.map((task) => task.id);

  if (taskIds.length > 0) {
    await db.message.deleteMany({
      where: {
        taskId: {
          in: taskIds,
        },
      },
    });
  }

  await db.task.deleteMany({
    where: { projectId },
  });
  await db.project.delete({
    where: { id: projectId },
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

  return new NextResponse(null, { status: 204 });
});
