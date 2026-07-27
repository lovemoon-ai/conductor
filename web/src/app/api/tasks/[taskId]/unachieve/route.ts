import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { resolveAchievedTaskDaemonHost } from "@/lib/tasks/achieved-daemon";
import { normalizeBackendType } from "@/lib/tasks/pty-runtime";
import { normalizeOptionalString } from "@/lib/tasks/task-config";

/**
 * POST /api/tasks/[taskId]/unachieve
 *
 * Un-pack (restore) an achieved task. This endpoint is the DECISION gate — it
 * resolves which daemon should run the revived session and which restart
 * strategy applies, then returns a plan the client executes via
 * `POST /api/tasks/[taskId]/restart`. It does NOT mutate the task itself; the
 * restart route clears `achievedAt` on a successful in-place resume (so an
 * un-packed task that fails to resume and forks to a new task keeps the
 * original archived — see design decision "keep archived on new_task").
 *
 * Decision tree (matches the agreed design):
 *   - original daemon offline & no override → 409 { code: "daemon_offline",
 *     candidates } so the client shows a daemon picker.
 *   - target daemon == original (online)   → { strategy: "inplace" }  (attempt
 *     resume; falls back to new_task on the daemon side if not resumable).
 *   - target daemon != original            → { strategy: "new_task" } (fork a
 *     successor seeded from the transcript; original stays archived).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const requestedAgentHost = normalizeOptionalString(
    body.agent_host ?? body.agentHost ?? body.target_daemon_host ?? body.targetDaemonHost,
  );

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      backendType: true,
      metadata: true,
      achievedAt: true,
      project: { select: { daemonHost: true } },
    },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!task.achievedAt) {
    return NextResponse.json({ error: "Task is not achieved" }, { status: 409 });
  }
  if ((task.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "Only ai_task can be un-packed" }, { status: 409 });
  }

  const targetBackend = normalizeBackendType(task.backendType);
  const connectedAgents = realtimeHub.getAgentsForUser(user.id);
  const isOnline = (host: string) =>
    connectedAgents.some((agent) => agent.host === host);
  const supportsBackend = (host: string) =>
    !targetBackend ||
    connectedAgents.some(
      (agent) => agent.host === host && agent.supportedBackends.includes(targetBackend),
    );

  // Resolve the task's real daemon association. Manual-fire rows may persist
  // conductor-fire-* in both host columns; metadata.daemonName is the durable
  // link back to the daemon in that case.
  const originalHost = resolveAchievedTaskDaemonHost(task);

  // Candidate online daemons that can host the revived backend.
  const candidates = connectedAgents
    .filter((agent) => supportsBackend(agent.host))
    .map((agent) => ({ host: agent.host, supportedBackends: agent.supportedBackends }));

  // Explicit override supplied by the client (user picked a daemon).
  if (requestedAgentHost) {
    if (!isOnline(requestedAgentHost)) {
      return NextResponse.json(
        { error: `Selected daemon ${requestedAgentHost} is offline` },
        { status: 409 },
      );
    }
    if (!supportsBackend(requestedAgentHost)) {
      return NextResponse.json(
        {
          error: `Daemon ${requestedAgentHost} does not support backend ${targetBackend}`,
        },
        { status: 409 },
      );
    }
    const strategy = requestedAgentHost === originalHost ? "inplace" : "new_task";
    return NextResponse.json({
      strategy,
      agentHost: requestedAgentHost,
      taskId: task.id,
    });
  }

  // No override: prefer the original daemon when it's online and capable.
  if (originalHost && isOnline(originalHost) && supportsBackend(originalHost)) {
    return NextResponse.json({
      strategy: "inplace",
      agentHost: originalHost,
      taskId: task.id,
    });
  }

  // Original offline (or incapable): ask the client to pick a daemon.
  return NextResponse.json(
    {
      code: "daemon_offline",
      error: originalHost
        ? `Original daemon ${originalHost} is offline; choose another daemon to restore this task.`
        : "Choose a daemon to restore this task.",
      originalHost: originalHost ?? null,
      candidates,
    },
    { status: 409 },
  );
}
