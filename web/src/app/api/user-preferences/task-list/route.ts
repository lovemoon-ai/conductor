import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  getTaskListPreferences,
  normalizeTaskListPreferences,
  setTaskListPreferences,
  UserPreferencesSchemaUnavailableError,
  type TaskListPreferences,
} from "@/lib/user-preferences";

const readBooleanField = (body: Record<string, unknown>): boolean | null => {
  const value = Object.prototype.hasOwnProperty.call(body, "tasksRunningOnly")
    ? body.tasksRunningOnly
    : body.tasks_running_only;
  return typeof value === "boolean" ? value : null;
};

const serializeTaskListPreferences = (preferences: TaskListPreferences) => ({
  tasksRunningOnly: preferences.tasksRunningOnly,
  tasks_running_only: preferences.tasksRunningOnly,
});

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const preferences = await getTaskListPreferences(user.id);
  return NextResponse.json(serializeTaskListPreferences(preferences));
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const tasksRunningOnly = readBooleanField(normalizedBody);
  if (tasksRunningOnly === null) {
    return NextResponse.json(
      { error: "tasksRunningOnly must be a boolean" },
      { status: 400 },
    );
  }

  let preferences: TaskListPreferences;
  try {
    preferences = await setTaskListPreferences(
      user.id,
      normalizeTaskListPreferences({ tasksRunningOnly }),
    );
  } catch (error) {
    if (error instanceof UserPreferencesSchemaUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  const serialized = serializeTaskListPreferences(preferences);

  realtimeHub.broadcastToUser(user.id, {
    type: "user_preference_update",
    payload: {
      scope: "task_list",
      preferences: serialized,
      updated_at: new Date().toISOString(),
    },
  });

  return NextResponse.json(serialized);
}
