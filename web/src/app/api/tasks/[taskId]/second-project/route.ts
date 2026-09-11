import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { serializeTaskResponse } from "@/lib/tasks/serialization";

/**
 * Display-only "move task to project" endpoint.
 *
 * This sets (or clears) `Task.secondProjectId`, a pure presentation override
 * that changes which project bucket a task renders under WITHOUT touching its
 * real `projectId`, daemon, session, or any runtime behaviour. Constraints:
 *
 *   - Any owned task may be moved, regardless of which project it really
 *     belongs to. A move never rewrites `projectId`, so the task always stays
 *     eligible to be moved back to its home project.
 *   - The target project must belong to the caller. Passing `null` — or the
 *     task's own home project — clears the override and files the task back
 *     under its home project.
 */

type SecondProjectBody = {
  second_project_id?: unknown;
  secondProjectId?: unknown;
};

const readTargetField = (body: SecondProjectBody): unknown => {
  if (Object.prototype.hasOwnProperty.call(body, "second_project_id")) {
    return body.second_project_id;
  }
  if (Object.prototype.hasOwnProperty.call(body, "secondProjectId")) {
    return body.secondProjectId;
  }
  return undefined;
};

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;

  let body: SecondProjectBody;
  try {
    body = (await request.json()) as SecondProjectBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawTarget = readTargetField(body);
  if (rawTarget === undefined) {
    return NextResponse.json(
      { error: "second_project_id is required (use null to move back to default)" },
      { status: 400 },
    );
  }
  if (rawTarget !== null && typeof rawTarget !== "string") {
    return NextResponse.json(
      { error: "second_project_id must be a string or null" },
      { status: 400 },
    );
  }
  const targetProjectId =
    typeof rawTarget === "string" && rawTarget.trim() ? rawTarget.trim() : null;

  // Load the task scoped to the caller (ownership via project.userId).
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    include: { ptySession: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Filing a task under its own home project is the same thing as having no
  // override at all, so normalise it to `null` instead of storing a redundant
  // (and later stale) self-reference.
  const nextProjectId = targetProjectId === task.projectId ? null : targetProjectId;

  if (nextProjectId !== null) {
    const target = await db.project.findFirst({
      where: { id: nextProjectId, userId: user.id },
    });
    if (!target) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  }

  const updated = await db.task.update({
    where: { id: taskId },
    data: { secondProjectId: nextProjectId },
    include: { ptySession: true },
  });

  return NextResponse.json(serializeTaskResponse(updated));
}
