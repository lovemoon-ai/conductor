import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { listBackendSessions } from "@/lib/agents/backend-sessions";

const querySchema = z.object({
  backends: z
    .string()
    .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z0-9_-]+$/i)).min(1).max(20))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Longest-prefix match of a session cwd against the user's project workspace
 * paths, respecting path boundaries (`/a/b` matches `/a/b/...`, not `/a/bc`).
 */
const matchProjectByCwd = (
  cwd: string | null,
  projects: Array<{ id: string; workspacePath: string | null }>,
): string | null => {
  if (!cwd) return null;
  let best: { id: string; length: number } | null = null;
  for (const project of projects) {
    const workspacePath = project.workspacePath?.replace(/\/+$/, "");
    if (!workspacePath) continue;
    if (cwd !== workspacePath && !cwd.startsWith(`${workspacePath}/`)) continue;
    if (!best || workspacePath.length > best.length) {
      best = { id: project.id, length: workspacePath.length };
    }
  }
  return best?.id ?? null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const { host: rawHost } = await params;
  let host = "";
  try {
    host = decodeURIComponent(rawHost || "").trim();
  } catch {
    return NextResponse.json({ error: "invalid host" }, { status: 400 });
  }
  if (!host) {
    return NextResponse.json({ error: "host required" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    backends: searchParams.get("backends") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json({ error: "invalid query" }, { status: 400 });
  }

  const outcome = await listBackendSessions({
    userId: userResult.id,
    agentHost: host,
    backends: parsedQuery.data.backends,
    limit: parsedQuery.data.limit,
  });
  if (!outcome.ok) {
    switch (outcome.reason) {
      case "daemon_offline":
        return NextResponse.json({ error: "daemon_offline" }, { status: 404 });
      case "capability_missing":
        return NextResponse.json({ error: "daemon_capability_missing" }, { status: 409 });
      case "timeout":
      default:
        return NextResponse.json({ error: "daemon_timeout" }, { status: 504 });
    }
  }

  const sessionIds = outcome.result.sessions.map((session) => session.session_id);
  const [linkedTasks, projects] = await Promise.all([
    sessionIds.length > 0
      ? db.task.findMany({
          where: { sessionId: { in: sessionIds }, project: { userId: userResult.id } },
          select: { id: true, sessionId: true },
          // Restart lineages can leave several tasks on one sessionId; link the
          // most recently updated one (first-wins below).
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
    db.project.findMany({
      where: { userId: userResult.id, daemonHost: host, workspacePath: { not: null } },
      select: { id: true, workspacePath: true },
    }),
  ]);
  const taskBySessionId = new Map<string, string>();
  for (const task of linkedTasks) {
    if (task.sessionId && !taskBySessionId.has(task.sessionId)) {
      taskBySessionId.set(task.sessionId, task.id);
    }
  }

  const sessions = outcome.result.sessions.map((session) => ({
    ...session,
    linked_task_id: taskBySessionId.get(session.session_id) ?? null,
    project_id: matchProjectByCwd(session.cwd, projects),
  }));

  return NextResponse.json({
    sessions,
    ...(outcome.result.errors.length > 0 ? { errors: outcome.result.errors } : {}),
  });
}
