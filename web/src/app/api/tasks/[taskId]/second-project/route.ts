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
 *   - Only tasks whose real `projectId` is the caller's default project may be
 *     moved (a moved task keeps `projectId === default`, so it always remains
 *     eligible to be moved back).
 *   - The target project must belong to the caller and must not be the default
 *     project itself — passing `null` is how a task is moved back to default.
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

  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
  });

  // Moving OUT (setting a target) is only allowed for tasks whose real project
  // is the current default. Moving BACK to the inbox (clearing the override) is
  // always allowed for an owned task — otherwise a task moved before the user
  // switched their default project could never be reverted (its real project is
  // no longer the default), leaving it stranded.
  if (targetProjectId !== null) {
    if (!defaultProject || task.projectId !== defaultProject.projectId) {
      return NextResponse.json(
        { error: "Only default-project tasks can be moved" },
        { status: 403 },
      );
    }
    if (targetProjectId === defaultProject.projectId) {
      return NextResponse.json(
        { error: "Use null to move a task back to the default project" },
        { status: 400 },
      );
    }
    const target = await db.project.findFirst({
      where: { id: targetProjectId, userId: user.id },
    });
    if (!target) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  }

  const updated = await db.task.update({
    where: { id: taskId },
    data: { secondProjectId: targetProjectId },
    include: { ptySession: true },
  });

  return NextResponse.json(serializeTaskResponse(updated));
}
