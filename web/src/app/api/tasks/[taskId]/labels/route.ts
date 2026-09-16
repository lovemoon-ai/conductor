import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  findMergedProjectMembers,
  type MergedGroupProject,
} from "@/lib/projects/merged-group";
import { readTaskLabelsFromMetadata } from "@/lib/projects/task-labels";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import { parseJsonObject } from "@/lib/tasks/task-config";
import {
  buildMetadataWithTaskLabelIds,
  normalizeTaskLabelIds,
  readTaskLabelIdsFromMetadata,
} from "@/lib/tasks/task-labels";

/**
 * Replace the set of task labels attached to a task.
 *
 * A dedicated endpoint rather than a `metadata` PATCH because the generic task
 * PATCH merges the whole blob: two clients toggling different labels would
 * clobber each other, and the caller would have to send back daemon-owned keys
 * it has no business round-tripping. PUT here is a targeted replace of exactly
 * one key.
 *
 * Only ids NEWLY added by this request are validated. Each must be defined on
 * the merged cross-daemon group of either:
 *   - the project the task is DISPLAYED under (`secondProjectId`) — that is
 *     the list the task card's picker offers; or
 *   - the task's real project.
 * An unknown new id is rejected rather than silently dropped, so a client bug
 * surfaces instead of quietly losing the user's edit.
 *
 * Ids the task already carries are always allowed to stay, even if no longer
 * defined (the label was deleted, or the task was filed under another project).
 * Pickers preserve such ids when toggling others, so rejecting them would make
 * every later edit on that task fail.
 */

type LabelsBody = {
  label_ids?: unknown;
  labelIds?: unknown;
};

const readLabelIdsField = (body: LabelsBody): unknown => {
  if (Object.prototype.hasOwnProperty.call(body, "label_ids")) {
    return body.label_ids;
  }
  if (Object.prototype.hasOwnProperty.call(body, "labelIds")) {
    return body.labelIds;
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

  let body: LabelsBody;
  try {
    body = (await request.json()) as LabelsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawLabelIds = readLabelIdsField(body);
  if (rawLabelIds === undefined) {
    return NextResponse.json(
      { error: "label_ids is required (use [] to clear all labels)" },
      { status: 400 },
    );
  }
  if (!Array.isArray(rawLabelIds)) {
    return NextResponse.json(
      { error: "label_ids must be an array of label ids" },
      { status: 400 },
    );
  }
  if (rawLabelIds.some((entry) => typeof entry !== "string")) {
    return NextResponse.json(
      { error: "label_ids must contain only strings" },
      { status: 400 },
    );
  }

  const requestedIds = normalizeTaskLabelIds(rawLabelIds);

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    include: { project: true, ptySession: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existingIds = new Set(
    readTaskLabelIdsFromMetadata(parseJsonObject(task.metadata)),
  );
  const addedIds = requestedIds.filter((id) => !existingIds.has(id));

  if (addedIds.length > 0) {
    const labelSources: MergedGroupProject[] = [task.project];
    const displayProjectId = task.secondProjectId?.trim();
    if (displayProjectId && displayProjectId !== task.projectId) {
      // Scoped to the caller: a stale or foreign override contributes nothing.
      const displayProject = await db.project.findFirst({
        where: { id: displayProjectId, userId: user.id },
      });
      if (displayProject) labelSources.push(displayProject);
    }
    const groups = await Promise.all(
      labelSources.map((source) => findMergedProjectMembers(user.id, source)),
    );
    const known = new Set(
      groups.flat().flatMap((member) =>
        readTaskLabelsFromMetadata(parseJsonObject(member.metadata)).map(
          (label) => label.id,
        ),
      ),
    );
    const unknown = addedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return NextResponse.json(
        {
          error: `Unknown label id(s) for this project: ${unknown.join(", ")}`,
        },
        { status: 400 },
      );
    }
  }

  const updated = await db.task.update({
    where: { id: taskId },
    data: {
      metadata: JSON.stringify(
        buildMetadataWithTaskLabelIds(parseJsonObject(task.metadata), requestedIds),
      ),
    },
    include: { ptySession: true },
  });

  return NextResponse.json(serializeTaskResponse(updated));
}
