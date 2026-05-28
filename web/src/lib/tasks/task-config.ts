const TASK_TYPE_VALUES = ["ai_task", "pty_task"] as const;

export type TaskType = (typeof TASK_TYPE_VALUES)[number];
export type JsonObject = Record<string, unknown>;

export const DEFAULT_TASK_TYPE: TaskType = "ai_task";

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseTaskType = (value: unknown): TaskType | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return TASK_TYPE_VALUES.includes(normalized as TaskType)
    ? (normalized as TaskType)
    : null;
};

export const normalizeTaskType = (value: unknown): TaskType =>
  parseTaskType(value) ?? DEFAULT_TASK_TYPE;

export const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

export const normalizePositiveInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const parseJsonObject = (value: unknown): JsonObject | null => {
  if (value == null) return null;
  if (isJsonObject(value)) return value;
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "init") return "init";
  if (normalized === "running") return "running";
  if (normalized === "killing" || normalized === "stopping") return "killing";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

export const serializeJsonObject = (value: unknown): string | null => {
  const jsonObject = parseJsonObject(value);
  return jsonObject ? JSON.stringify(jsonObject) : null;
};
