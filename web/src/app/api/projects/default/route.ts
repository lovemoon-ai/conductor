import { NextRequest, NextResponse } from "next/server";
import { requireActiveSubscription } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  PROJECT_SERIALIZATION_BASE_SELECT,
  isMissingProjectHiddenAtColumnError,
  serializeProject,
} from "../shared";

/**
 * Switch the user's default project mapping (DefaultProject table).
 *
 * Body: { projectId: string }
 *
 * Notes:
 * - Idempotent upsert: any of the user's own projects can be marked default.
 * - Hidden projects are rejected (mirrors PATCH constraint that default projects
 *   cannot be hidden).
 * - Bound projects are accepted: while POST /api/projects forbids creating a
 *   default project with bindings, an existing bound project is allowed to be
 *   promoted to default here. The DefaultProject table only stores the mapping;
 *   no fields on the underlying Project row are mutated.
 *
 * Tracked by RFC 0025 §2.
 */
export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json().catch(() => null);
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const rawProjectId = normalizedBody.projectId ?? normalizedBody.project_id;
  const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  // Wrap the hidden-check + upsert in a transaction (review H4). On SQLite
  // this serializes against concurrent PATCH `{hidden:true}` writers; on
  // Postgres at READ COMMITTED there is still a small window, but we
  // re-check `hiddenAt` inside the transaction so the worst case is a stale
  // upsert that's immediately followed by a PATCH flipping `hiddenAt` —
  // detectable downstream and fixable by retrying the call.
  try {
    const project = await db.$transaction(async (tx) => {
      let row: Awaited<ReturnType<typeof tx.project.findUnique>> | null;
      try {
        row = await tx.project.findUnique({
          where: { id: projectId },
          select: { ...PROJECT_SERIALIZATION_BASE_SELECT, hiddenAt: true },
        });
      } catch (error) {
        if (!isMissingProjectHiddenAtColumnError(error)) throw error;
        row = await tx.project.findUnique({
          where: { id: projectId },
          select: PROJECT_SERIALIZATION_BASE_SELECT,
        });
      }
      if (!row || row.userId !== user.id) {
        throw Object.assign(new Error("not_found"), { kind: "not_found" });
      }
      const hiddenAt = (row as { hiddenAt?: Date | null }).hiddenAt ?? null;
      if (hiddenAt) {
        throw Object.assign(new Error("hidden"), { kind: "hidden" });
      }
      await tx.defaultProject.upsert({
        where: { userId: user.id },
        update: { projectId: row.id },
        create: { userId: user.id, projectId: row.id },
      });
      return row;
    });

    return NextResponse.json(serializeProject(project, true));
  } catch (error) {
    if (error && typeof error === "object" && "kind" in (error as Record<string, unknown>)) {
      const kind = (error as { kind: string }).kind;
      if (kind === "not_found") {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      if (kind === "hidden") {
        return NextResponse.json(
          { error: "Hidden project cannot be set as default" },
          { status: 400 },
        );
      }
    }
    throw error;
  }
});
