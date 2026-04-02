import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";

const normalizePath = (value: string): string => value.replace(/\/+$/, "");

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

const readLegacyLocalPath = (metadata: string | null, daemonHost: string): string | null => {
  const parsed = parseProjectMetadata(metadata);
  if (!parsed) {
    return null;
  }

  const localPaths = parsed.localPaths;
  if (!localPaths) {
    return null;
  }

  if (typeof localPaths === "string") {
    const normalized = localPaths.trim();
    return normalized || null;
  }

  if (Array.isArray(localPaths)) {
    for (const candidate of localPaths) {
      if (typeof candidate === "string") {
        const normalized = candidate.trim();
        if (normalized) {
          return normalized;
        }
      }
    }
    return null;
  }

  if (typeof localPaths === "object") {
    const candidate = (localPaths as Record<string, unknown>)[daemonHost];
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      return normalized || null;
    }
  }

  return null;
};

const readBindingCandidatePath = (metadata: string | null, daemonHost: string): string | null => {
  const parsed = parseProjectMetadata(metadata);
  if (!parsed) {
    return null;
  }

  const rawCandidate =
    Object.prototype.hasOwnProperty.call(parsed, "bindingCandidate")
      ? parsed.bindingCandidate
      : Object.prototype.hasOwnProperty.call(parsed, "binding_candidate")
        ? parsed.binding_candidate
        : null;
  if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
    return null;
  }

  const candidate = rawCandidate as Record<string, unknown>;
  const candidateDaemonHost =
    typeof candidate.daemonHost === "string"
      ? candidate.daemonHost.trim()
      : typeof candidate.daemon_host === "string"
        ? candidate.daemon_host.trim()
        : "";
  if (!candidateDaemonHost || candidateDaemonHost !== daemonHost) {
    return null;
  }

  const candidatePath =
    typeof candidate.workspacePath === "string"
      ? candidate.workspacePath.trim()
      : typeof candidate.workspace_path === "string"
        ? candidate.workspace_path.trim()
        : "";
  return candidatePath || null;
};

const serializeProject = (project: {
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
}) => ({
  id: project.id,
  name: project.name,
  daemon_host: project.daemonHost,
  workspace_path: project.workspacePath,
  repo_root: project.repoRoot,
  worktree_branch: project.worktreeBranch,
  last_commit: project.lastCommit,
  file_count: project.fileCount,
  metadata: parseProjectMetadata(project.metadata),
  created_at: project.createdAt.toISOString(),
  updated_at: project.updatedAt.toISOString(),
});

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const daemonHost =
    (typeof normalizedBody.daemonHost === "string" ? normalizedBody.daemonHost.trim() : "") ||
    (typeof normalizedBody.daemon_host === "string" ? normalizedBody.daemon_host.trim() : "") ||
    (typeof normalizedBody.hostname === "string" ? normalizedBody.hostname.trim() : "");
  const requestPath = typeof normalizedBody.path === "string" ? normalizedBody.path.trim() : "";

  if (!daemonHost || !requestPath) {
    return NextResponse.json({ error: "daemonHost and path are required" }, { status: 400 });
  }

  const projects = await db.project.findMany({
    where: {
      userId: user.id,
      OR: [{ daemonHost }, { daemonHost: null }],
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

  const normalizedRequestPath = normalizePath(requestPath);
  let bestConfirmedMatch:
    | {
        project: (typeof projects)[number];
        boundPath: string;
        normalizedBoundPath: string;
      }
    | undefined;
  let bestPendingMatch:
    | {
        project: (typeof projects)[number];
        boundPath: string;
        normalizedBoundPath: string;
      }
    | undefined;

  for (const project of projects) {
    const boundWorkspacePath =
      typeof project.workspacePath === "string" && project.workspacePath.trim()
        ? project.workspacePath.trim()
        : null;
    const isConfirmedBinding =
      typeof project.daemonHost === "string" &&
      project.daemonHost.trim() === daemonHost &&
      boundWorkspacePath !== null;
    const workspacePath =
      boundWorkspacePath ||
      readBindingCandidatePath(project.metadata, daemonHost) ||
      readLegacyLocalPath(project.metadata, daemonHost);
    if (!workspacePath) continue;

    const normalizedBoundPath = normalizePath(workspacePath);
    if (
      normalizedRequestPath === normalizedBoundPath ||
      normalizedRequestPath.startsWith(normalizedBoundPath + "/")
    ) {
      const candidate = { project, boundPath: workspacePath, normalizedBoundPath };
      if (isConfirmedBinding) {
        if (!bestConfirmedMatch || normalizedBoundPath.length > bestConfirmedMatch.normalizedBoundPath.length) {
          bestConfirmedMatch = candidate;
        }
      } else if (
        !bestPendingMatch ||
        normalizedBoundPath.length > bestPendingMatch.normalizedBoundPath.length
      ) {
        bestPendingMatch = candidate;
      }
    }
  }

  const bestMatch = bestConfirmedMatch ?? bestPendingMatch;
  if (bestMatch) {
    return NextResponse.json({
      project: serializeProject(bestMatch.project),
      matched_path: bestMatch.boundPath,
    });
  }

  return NextResponse.json({ project: null, matched_path: null });
}
