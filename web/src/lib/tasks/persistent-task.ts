import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  parseJsonObject,
  type JsonObject,
} from "@/lib/tasks/task-config";
import {
  PERSISTENT_METADATA_KEY,
  readPersistentTaskState,
  type PersistentTaskState,
} from "@/shared/utils/persistent-task";

/**
 * Instructions and summary are sent to the AI on the command line (`--prefill`),
 * so keep them well below per-argument limits even for 3-byte CJK text.
 */
export const MAX_PERSISTENT_TEXT_LENGTH = 8_000;

export type PersistentTaskSettingsInput = {
  enabled?: boolean;
  instructions?: string;
  summary?: string;
};

/** Merges `patch` into `metadata.persistent`, leaving every other key untouched. */
export const withPersistentState = (
  metadata: JsonObject | null,
  patch: Partial<PersistentTaskState>,
): JsonObject => {
  const current = parseJsonObject(metadata?.[PERSISTENT_METADATA_KEY]) ?? {};
  return { ...(metadata ?? {}), [PERSISTENT_METADATA_KEY]: { ...current, ...patch } };
};

type TaskMetadataClient = Pick<typeof db.task, "findUnique" | "updateMany">;

/**
 * Read-modify-write of `task.metadata` guarded by compare-and-swap on the stored
 * string, so concurrent writers (summary capture, round start/end, settings,
 * labels) cannot silently drop each other's keys. `mutate` returns null to skip.
 */
export async function updateTaskMetadata(
  client: TaskMetadataClient,
  taskId: string,
  mutate: (metadata: JsonObject | null) => JsonObject | null,
): Promise<{ metadata: JsonObject; status: string; projectId: string } | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await client.findUnique({
      where: { id: taskId },
      select: { metadata: true, status: true, projectId: true },
    });
    if (!row) return null;
    const next = mutate(parseJsonObject(row.metadata));
    if (!next) return null;
    const { count } = await client.updateMany({
      where: { id: taskId, metadata: row.metadata },
      data: { metadata: JSON.stringify(next) },
    });
    if (count === 1) {
      return { metadata: next, status: row.status, projectId: row.projectId };
    }
  }
  throw new Error(`Task ${taskId} metadata kept changing; giving up`);
}

/** Lets every open client (other tabs, devices) pick up round state changes. */
export const broadcastPersistentTaskUpdate = (input: {
  userId: string;
  taskId: string;
  projectId: string;
  status: string;
  metadata: JsonObject | null;
}) => {
  realtimeHub.broadcast(input.userId, input.projectId, {
    type: "task_status_update",
    payload: {
      task_id: input.taskId,
      project_id: input.projectId,
      status: normalizeTaskStatus(input.status),
      metadata: input.metadata,
    },
  });
};

export const readPersistentSettingsInput = (
  body: Record<string, unknown>,
): PersistentTaskSettingsInput | { error: string } => {
  const settings: PersistentTaskSettingsInput = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be a boolean" };
    settings.enabled = body.enabled;
  }
  for (const key of ["instructions", "summary"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${key} must be a string` };
    if (value.length > MAX_PERSISTENT_TEXT_LENGTH) {
      return { error: `${key} must be at most ${MAX_PERSISTENT_TEXT_LENGTH} characters` };
    }
    settings[key] = value;
  }
  if (Object.keys(settings).length === 0) {
    return { error: "Provide at least one of enabled, instructions, summary" };
  }
  return settings;
};

export const buildPersistentRoundSummaryRequest = (round: number): string =>
  [
    `[Persistent task — end of round ${round}]`,
    "This round is ending. The next round starts a fresh AI session that will NOT see this conversation.",
    "Write a concise summary for it: current state, key decisions and results, and anything the next round must know or do.",
    "Merge in whatever is still relevant from the summary of previous rounds you were given at the start.",
    "Reply with the summary only.",
  ].join("\n");

export const buildPersistentRoundPrompt = (args: {
  round: number;
  instructions: string;
  summary: string;
  content: string;
}): string => {
  const sections = [
    `[Persistent task — round ${args.round}]\nThis is a new round of a recurring task. You start with a fresh session and no prior conversation history.`,
  ];
  if (args.instructions.trim()) {
    sections.push(`Standing instructions:\n${args.instructions.trim()}`);
  }
  if (args.summary.trim()) {
    sections.push(`Summary of previous rounds:\n${args.summary.trim()}`);
  }
  sections.push(`---\n${args.content}`);
  return sections.join("\n\n");
};

// Fire's placeholder when a backend turn produced no text, e.g. "(claude 未返回任何文本)".
const EMPTY_REPLY_PLACEHOLDER = /^\([^()]+ 未返回任何文本\)$/;

/**
 * Stores the AI's reply to the end-of-round summary request as the task's
 * rolling summary. Called for every committed SDK message; cheap unless the
 * message actually replies to the pending request. The last reply wins, which
 * in session-stream mode is the final text of the turn. Status lines that also
 * carry `reply_to` (errors, interruptions, empty-turn placeholders) never
 * replace a summary.
 */
export async function capturePersistentRoundSummary(input: {
  userId: string;
  taskId: string;
  taskMetadata: unknown;
  content: string;
  messageMetadata?: Record<string, unknown> | null;
}): Promise<void> {
  const messageMetadata = input.messageMetadata ?? {};
  const replyTo = normalizeOptionalString(messageMetadata.reply_to);
  const content = input.content.trim();
  if (
    !replyTo ||
    !content ||
    messageMetadata.severity === "error" ||
    messageMetadata.interrupted === true ||
    messageMetadata.synthetic === true ||
    EMPTY_REPLY_PLACEHOLDER.test(content)
  ) {
    return;
  }
  if (readPersistentTaskState(parseJsonObject(input.taskMetadata))?.roundEndMessageId !== replyTo) {
    return;
  }

  const summary = content.length > MAX_PERSISTENT_TEXT_LENGTH
    ? `${content.slice(0, MAX_PERSISTENT_TEXT_LENGTH)}…`
    : content;
  const updated = await updateTaskMetadata(db.task, input.taskId, (metadata) =>
    readPersistentTaskState(metadata)?.roundEndMessageId === replyTo
      ? withPersistentState(metadata, { summary })
      : null,
  );
  if (updated) {
    broadcastPersistentTaskUpdate({ userId: input.userId, taskId: input.taskId, ...updated });
  }
}
