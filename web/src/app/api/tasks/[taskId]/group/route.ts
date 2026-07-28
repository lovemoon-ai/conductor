import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { TASK_GROUP_SCHEMA_UNAVAILABLE_MESSAGE } from "@/lib/tasks/agent-group";
import { isMissingGroupIdColumnError } from "@/lib/tasks/pty-compat";

/**
 * RFC 0033 — task group discovery.
 *
 * `GET /api/tasks/:taskId/group` answers "is this task in a multi-agent group,
 * and if so, who are its siblings?" It returns every task sharing the same
 * `groupId` (scoped to the requesting owner), each with its role/agent. Agents
 * call this via `conductor task group` to find the task(s) they read from and
 * send feedback to — no sibling ids are hard-passed through the prompt.
 */

const parseStoredMetadata = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;

  let self: { id: string; groupId: string | null } | null;
  try {
    self = await db.task.findFirst({
      where: { id: taskId, project: { userId: user.id } },
      select: { id: true, groupId: true },
    });
  } catch (error) {
    if (!isMissingGroupIdColumnError(error)) throw error;
    return NextResponse.json(
      { error: TASK_GROUP_SCHEMA_UNAVAILABLE_MESSAGE },
      { status: 409 },
    );
  }
  if (!self) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Not part of a group → report so explicitly (empty members).
  if (!self.groupId) {
    return NextResponse.json({ group_id: null, members: [] });
  }

  const siblings = await db.task.findMany({
    where: {
      groupId: self.groupId,
      project: { userId: user.id },
    },
    select: {
      id: true,
      title: true,
      status: true,
      backendType: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const members = siblings.map((task) => {
    const meta = parseStoredMetadata(task.metadata);
    return {
      task_id: task.id,
      role: asString(meta?.agentRole),
      agent: asString(meta?.agentName),
      title: task.title,
      status: task.status,
      backend_type: task.backendType,
      is_self: task.id === self.id,
    };
  });

  return NextResponse.json({ group_id: self.groupId, members });
}
