import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { resolveProjectAgentsRegistry } from "@/lib/projects/daemon-binding";

/**
 * RFC 0033 — list the agents a project registers in `.conductor/settings.yaml`.
 *
 * Drives the task-composer's agent picker. Only the fields the UI needs are
 * returned (name, description, default backend) — the doc PATH is intentionally
 * not exposed to the client; it is resolved server-side at task creation. Empty
 * list when the project has no workspace on this host or no `agents:` block.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true, daemonHost: true, workspacePath: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const registry = await resolveProjectAgentsRegistry({
    userId: user.id,
    daemonHost: project.daemonHost,
    workspacePath: project.workspacePath,
  });
  return NextResponse.json({
    agents: registry.map((entry) => ({
      name: entry.name,
      description: entry.description,
      backend: entry.backend,
    })),
  });
}
