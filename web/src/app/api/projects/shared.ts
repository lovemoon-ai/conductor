import { Prisma } from "@prisma/client";
import {
  collaborationSummarySelect,
  serializeCollaboration,
  type CollaborationSummaryRecord,
} from "@/lib/collaboration/service";

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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
    const map = localPaths as Record<string, unknown>;
    const candidate = map[daemonHost] ?? map["default"] ?? map["*"];
    const normalized = normalizeOptionalWorkspacePath(candidate);
    return normalized || null;
  }

  return null;
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
    gitRemoteUrl: normalizeOptionalString(readField(body, "git_remote_url", "gitRemoteUrl", nestedBinding)),
    fileCount: normalizeOptionalInt(readField(body, "file_count", "fileCount", nestedBinding)),
  };
};

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

const isBindingConfirmed = (body: Record<string, unknown>): boolean =>
  normalizeBoolean(
    readField(body, "binding_confirmed", "bindingConfirmed") ||
      readField(body, "confirmed_binding", "confirmedBinding"),
  );

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

type SerializableProject = {
  id: string;
  name: string;
  daemonHost: string | null;
  workspacePath: string | null;
  repoRoot: string | null;
  worktreeBranch: string | null;
  lastCommit: string | null;
  gitRemoteUrl?: string | null;
  fileCount: number | null;
  sortOrder?: number | null;
  hiddenAt?: Date | null;
  mergeOptOut?: boolean;
  collaborationId?: string | null;
  collaboration?: CollaborationSummaryRecord | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// BASE_SELECT is intentionally scalar-only so that callers that bind the
// result to Prisma's default `Project` type (e.g. `let row: Awaited<...>`)
// still compile. The `collaboration` relation is added per-route via the
// expanded variants below so the merge of RFC 0025 (cli-entity-commands) and
// RFC 0026 (project-collaboration) doesn't break consumers that don't ask
// for the relation.
const PROJECT_SERIALIZATION_BASE_SELECT = {
  id: true,
  name: true,
  daemonHost: true,
  workspacePath: true,
  repoRoot: true,
  worktreeBranch: true,
  lastCommit: true,
  fileCount: true,
  collaborationId: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

const PROJECT_SERIALIZATION_SELECT = {
  ...PROJECT_SERIALIZATION_BASE_SELECT,
  collaboration: {
    select: collaborationSummarySelect,
  },
  hiddenAt: true,
  gitRemoteUrl: true,
  mergeOptOut: true,
} satisfies Prisma.ProjectSelect;

const PROJECT_SERIALIZATION_WITH_SORT_SELECT = {
  ...PROJECT_SERIALIZATION_SELECT,
  sortOrder: true,
} satisfies Prisma.ProjectSelect;

const PROJECT_SERIALIZATION_WITH_SORT_NO_HIDDEN_SELECT = {
  ...PROJECT_SERIALIZATION_BASE_SELECT,
  collaboration: {
    select: collaborationSummarySelect,
  },
  sortOrder: true,
} satisfies Prisma.ProjectSelect;

type SortableProject = {
  id: string;
  sortOrder?: number | null;
  createdAt: Date;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissingProjectSortOrderColumnError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2022" &&
  (errorMessage(error).includes("sort_order") || errorMessage(error).includes("sortOrder"));

const isMissingProjectHiddenAtColumnError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2022" &&
  (errorMessage(error).includes("hidden_at") || errorMessage(error).includes("hiddenAt"));

const isMissingProjectMergeColumnsError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2022" &&
  (errorMessage(error).includes("git_remote_url") ||
    errorMessage(error).includes("gitRemoteUrl") ||
    errorMessage(error).includes("merge_opt_out") ||
    errorMessage(error).includes("mergeOptOut"));

const getComparableSortOrder = (project: SortableProject): number =>
  typeof project.sortOrder === "number" && Number.isInteger(project.sortOrder)
    ? project.sortOrder
    : Number.MAX_SAFE_INTEGER;

const compareProjectsForDisplay = <T extends SortableProject>(a: T, b: T): number => {
  const sortOrderDelta = getComparableSortOrder(a) - getComparableSortOrder(b);
  if (sortOrderDelta !== 0) {
    return sortOrderDelta;
  }
  const createdAtDelta = b.createdAt.getTime() - a.createdAt.getTime();
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }
  return a.id.localeCompare(b.id);
};

const serializeProject = (
  project: SerializableProject,
  isDefault = false,
) => {
  const createdAt = project.createdAt.toISOString();
  const updatedAt = project.updatedAt.toISOString();
  const hiddenAt = project.hiddenAt ? project.hiddenAt.toISOString() : null;
  const hidden = Boolean(project.hiddenAt);
  const gitRemoteUrl = project.gitRemoteUrl ?? null;
  const mergeOptOut = Boolean(project.mergeOptOut);
  return {
    id: project.id,
    name: project.name,
    // camelCase — primary fields consumed by the web client and SDK.
    daemonHost: project.daemonHost,
    workspacePath: project.workspacePath,
    repoRoot: project.repoRoot,
    worktreeBranch: project.worktreeBranch,
    lastCommit: project.lastCommit,
    gitRemoteUrl,
    fileCount: project.fileCount,
    sortOrder: project.sortOrder,
    collaborationId: project.collaborationId ?? null,
    collaboration: project.collaboration ? serializeCollaboration(project.collaboration) : null,
    hidden,
    hiddenAt,
    mergeOptOut,
    isDefault: isDefault,
    createdAt,
    updatedAt,
    // snake_case aliases — kept for older clients / tests.
    daemon_host: project.daemonHost,
    workspace_path: project.workspacePath,
    repo_root: project.repoRoot,
    worktree_branch: project.worktreeBranch,
    last_commit: project.lastCommit,
    git_remote_url: gitRemoteUrl,
    file_count: project.fileCount,
    sort_order: project.sortOrder,
    collaboration_id: project.collaborationId ?? null,
    hidden_at: hiddenAt,
    merge_opt_out: mergeOptOut,
    is_default: isDefault,
    created_at: createdAt,
    updated_at: updatedAt,
    metadata: parseProjectMetadata(project.metadata),
  };
};

export {
  hasOwn,
  isBindingConfirmed,
  normalizeBoolean,
  normalizeOptionalInt,
  normalizeOptionalString,
  normalizeOptionalWorkspacePath,
  normalizeWorkspacePath,
  parseProjectMetadata,
  readField,
  readLegacyLocalPath,
  readProjectBindingCandidateInput,
  readProjectBindingInput,
  readProjectBindingPath,
  readProjectMetadataInput,
  isMissingProjectSortOrderColumnError,
  isMissingProjectHiddenAtColumnError,
  isMissingProjectMergeColumnsError,
  PROJECT_SERIALIZATION_BASE_SELECT,
  PROJECT_SERIALIZATION_SELECT,
  PROJECT_SERIALIZATION_WITH_SORT_SELECT,
  PROJECT_SERIALIZATION_WITH_SORT_NO_HIDDEN_SELECT,
  compareProjectsForDisplay,
  serializeProject,
};
