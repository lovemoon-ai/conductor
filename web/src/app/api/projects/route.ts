import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireActiveSubscription } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentDirectory } from "@/lib/conductor/task-file-storage";

export const GET = requireActiveSubscription(async (_request: NextRequest, user) => {
  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      metadata: p.metadata ? JSON.parse(p.metadata) : null,
      created_at: p.createdAt.toISOString(),
    }))
  );
});

export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json();
  const name = (body.name || "New Project").trim() || "New Project";
  const existing = await db.project.findFirst({
    where: { userId: user.id, name },
  });
  if (existing) {
    return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
  }
  let project;
  try {
    project = await db.project.create({
      data: {
        userId: user.id,
        name,
        metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({
    id: project.id,
    name: project.name,
    metadata: project.metadata ? JSON.parse(project.metadata) : null,
    created_at: project.createdAt.toISOString(),
  });
});

export const PATCH = requireActiveSubscription(async (request: NextRequest, user) => {
  const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const body = await request.json();
  const hasNameField = typeof body.name === "string";
  const name = hasNameField ? body.name.trim() : undefined;

  if (hasNameField && !name) {
    return NextResponse.json({ error: "Project name cannot be empty" }, { status: 400 });
  }

  let metadata: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "metadata")) {
    metadata = body.metadata === null ? null : JSON.stringify(body.metadata);
  }

  if (!name && metadata === undefined) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  if (name) {
    const existing = await db.project.findFirst({
      where: { userId: user.id, name, NOT: { id: projectId } },
    });
    if (existing) {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
  }

  let updatedCount;
  try {
    const result = await db.project.updateMany({
      where: { id: projectId, userId: user.id },
      data: {
        name: name ?? undefined,
        metadata,
      },
    });
    updatedCount = result.count;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
    throw error;
  }

  if (updatedCount === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: project.id,
    name: project.name,
    metadata: project.metadata ? JSON.parse(project.metadata) : null,
    created_at: project.createdAt.toISOString(),
  });
});

export const DELETE = requireActiveSubscription(async (request: NextRequest, user) => {
  const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const existing = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true, name: true },
  });

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.name.toLowerCase() === "default" || existing.name.toLowerCase() === "default project") {
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
});
