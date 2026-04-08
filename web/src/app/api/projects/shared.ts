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
    const candidate = (localPaths as Record<string, unknown>)[daemonHost];
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
};
