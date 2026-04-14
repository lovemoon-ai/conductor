import { NextRequest, NextResponse } from "next/server";
import { requireActiveSubscription } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  compareProjectsForDisplay,
  isMissingProjectSortOrderColumnError,
} from "../shared";

const missingSortOrderResponse = () =>
  NextResponse.json(
    { error: "Project ordering requires database migration" },
    { status: 409 },
  );

export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json();
  const projectIds: unknown = body?.projectIds ?? body?.project_ids;
  const normalizedProjectIds = Array.isArray(projectIds)
    ? projectIds.map((id) => (typeof id === "string" ? id.trim() : id))
    : projectIds;

  if (
    !Array.isArray(normalizedProjectIds) ||
    normalizedProjectIds.length === 0 ||
    normalizedProjectIds.some((id) => typeof id !== "string" || !id)
  ) {
    return NextResponse.json(
      { error: "projectIds must be a non-empty string array" },
      { status: 400 },
    );
  }

  const requestedIds = normalizedProjectIds as string[];
  const uniqueIds = [...new Set(requestedIds)];
  if (uniqueIds.length !== requestedIds.length) {
    return NextResponse.json(
      { error: "projectIds must not contain duplicates" },
      { status: 400 },
    );
  }

  let projects;
  try {
    projects = await db.project.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        sortOrder: true,
        createdAt: true,
      },
    });
  } catch (error) {
    if (isMissingProjectSortOrderColumnError(error)) {
      return missingSortOrderResponse();
    }
    throw error;
  }
  const currentIds = [...projects].sort(compareProjectsForDisplay).map((project) => project.id);
  if (
    currentIds.length !== requestedIds.length ||
    currentIds.some((id) => !uniqueIds.includes(id))
  ) {
    return NextResponse.json(
      { error: "projectIds must include every project exactly once" },
      { status: 409 },
    );
  }

  try {
    await db.$transaction(
      requestedIds.map((id, index) =>
        db.project.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
  } catch (error) {
    if (isMissingProjectSortOrderColumnError(error)) {
      return missingSortOrderResponse();
    }
    throw error;
  }

  return NextResponse.json({ ok: true, projectIds: requestedIds, project_ids: requestedIds });
});
