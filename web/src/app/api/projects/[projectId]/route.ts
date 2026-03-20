import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentDirectory } from "@/lib/conductor/task-file-storage";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: project.id,
    name: project.name,
    metadata: project.metadata ? JSON.parse(project.metadata) : null,
    created_at: project.createdAt.toISOString(),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const body = await request.json();
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name) {
    const existing = await db.project.findFirst({
      where: { userId: user.id, name, NOT: { id: projectId } },
    });
    if (existing) {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
  }

  let project;
  try {
    project = await db.project.updateMany({
      where: { id: projectId, userId: user.id },
      data: {
        name,
        metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
      },
    });
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    if (code === "P2002") {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
    throw error;
  }

  if (project.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await db.project.findUnique({ where: { id: projectId } });
  return NextResponse.json({
    id: updated!.id,
    name: updated!.name,
    metadata: updated!.metadata ? JSON.parse(updated!.metadata) : null,
    created_at: updated!.createdAt.toISOString(),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { projectId } = await params;
  const existing = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true, name: true },
  });

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.name.toLowerCase() === "default") {
    return NextResponse.json({ error: "Cannot delete default project" }, { status: 400 });
  }

  const tasks = await db.task.findMany({
    where: { projectId },
    select: { id: true },
  });
  const taskIds = tasks.map((task) => task.id);

  if (taskIds.length > 0) {
    await db.message.deleteMany({
      where: {
        taskId: {
          in: taskIds,
        },
      },
    });
  }

  await db.task.deleteMany({
    where: { projectId },
  });
  await db.project.delete({
    where: { id: projectId },
  });
  await Promise.all(
    taskIds.map((taskId) =>
      Promise.resolve(deleteTaskAttachmentDirectory(taskId)).catch((error) => {
        console.error(
          `[projects] failed to delete attachment directory after project delete: projectId=${projectId}, taskId=${taskId}, error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
    ),
  );

  return new NextResponse(null, { status: 204 });
}
