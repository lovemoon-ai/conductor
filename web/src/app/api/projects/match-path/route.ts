import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  readProjectBindingPath,
  serializeProject,
} from "../shared";

const normalizePath = (value: string): string => value.replace(/\/+$/, "");

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
      lastCommitAt: true,
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
    const workspacePath = readProjectBindingPath(
      {
        daemonHost: project.daemonHost,
        workspacePath: project.workspacePath,
        metadata: project.metadata,
      },
      daemonHost,
    );
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
