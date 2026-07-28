import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  getProjectCardGroupsPreferences,
  setProjectCardGroupsScope,
  ProjectCardGroupsPreferencesConflictError,
  ProjectCardGroupsPreferencesLimitError,
  ProjectCardGroupsPreferencesUnavailableError,
} from "@/lib/user-preferences";
import {
  MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE,
  MAX_SYNCED_PROJECTS_PER_CARD,
  readSyncedProjectCardGroups,
} from "@/features/projects/utils/project-card-groups";

const MAX_REQUEST_JSON_LENGTH = 128_000;

const isValidScope = (value: unknown): value is string =>
  typeof value === "string"
  && value.startsWith("projects:")
  && value.length <= 512;

const validateGroupsPayload = (value: unknown): string | null => {
  if (!Array.isArray(value)) return "groups must be an array";
  if (value.length > MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE) {
    return `groups supports at most ${MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE} entries`;
  }

  const groupIds = new Set<string>();
  const claimedProjectIds = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return "each group must be an object";
    }
    const group = candidate as Record<string, unknown>;
    if (typeof group.id !== "string" || !group.id || group.id.length > 200 || groupIds.has(group.id)) {
      return "each group must have a unique valid id";
    }
    if (
      !Array.isArray(group.projectIds)
      || group.projectIds.length < 2
      || group.projectIds.length > MAX_SYNCED_PROJECTS_PER_CARD
    ) {
      return `each group must contain 2-${MAX_SYNCED_PROJECTS_PER_CARD} projects`;
    }
    for (const projectId of group.projectIds) {
      if (
        typeof projectId !== "string"
        || !projectId
        || projectId.length > 200
        || claimedProjectIds.has(projectId)
      ) {
        return "project ids must be valid and may belong to only one group";
      }
      claimedProjectIds.add(projectId);
    }
    if (
      group.labels !== undefined
      && (!group.labels || typeof group.labels !== "object" || Array.isArray(group.labels))
    ) {
      return "group labels must be an object";
    }
    groupIds.add(group.id);
  }
  return null;
};

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await getProjectCardGroupsPreferences(user.id));
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (!isValidScope(record.scope)) {
    return NextResponse.json({ error: "scope must be a valid projects: scope" }, { status: 400 });
  }
  const groupsError = validateGroupsPayload(record.groups);
  if (groupsError) {
    return NextResponse.json({ error: groupsError }, { status: 400 });
  }
  if (JSON.stringify(record.groups).length > MAX_REQUEST_JSON_LENGTH) {
    return NextResponse.json({ error: "Project card groups payload is too large" }, { status: 413 });
  }

  try {
    const snapshot = await setProjectCardGroupsScope(
      user.id,
      record.scope,
      readSyncedProjectCardGroups(record.groups),
    );
    realtimeHub.broadcastToUser(user.id, {
      type: "project_card_groups_update",
      payload: {
        user_id: user.id,
        snapshot,
        updated_at: new Date().toISOString(),
      },
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof ProjectCardGroupsPreferencesLimitError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof ProjectCardGroupsPreferencesUnavailableError
      || error instanceof ProjectCardGroupsPreferencesConflictError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
