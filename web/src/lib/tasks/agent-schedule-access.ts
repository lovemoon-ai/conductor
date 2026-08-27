import type { NextRequest } from "next/server";
import { db as defaultDb } from "@/lib/db";

/**
 * Per-task access control for agent-initiated scheduled-message writes
 * (borrowed from AgentsServer's `provider_jobs_access`). A human can tighten
 * what the autonomous agent turn is allowed to do:
 *
 *   - "full"      (default): the agent may list/create/cancel schedules.
 *   - "read_only": the agent may list schedules only.
 *   - "blocked":   the agent may not touch schedules at all.
 *
 * Enforcement only applies to AGENT-originated requests (marked with the
 * `X-Conductor-Actor: agent` header set by the daemon-launched agent tooling).
 * Ordinary human/app requests carry no such header and are never restricted, so
 * a person can always manage schedules through the UI regardless of this
 * setting. The live task setting is checked on every call, so tightening access
 * mid-turn blocks the agent's next write immediately.
 *
 * IMPORTANT — this is a COOPERATIVE control, not a hard security boundary. The
 * agent shares the user's bearer token, and attribution relies on the sanctioned
 * `conductor task schedule` CLI / SDK setting the `X-Conductor-Actor` header. An
 * agent that calls the endpoints directly (e.g. raw HTTP) and omits the header
 * is treated as human and is NOT restricted. It governs the intended tooling
 * path and protects against accidental/eager scheduling; it does not defend
 * against a deliberately non-cooperative or compromised agent. A hard boundary
 * would require a separate per-turn scoped capability instead of the shared
 * user token.
 */

export type AgentScheduleAccess = "full" | "read_only" | "blocked";

export const DEFAULT_AGENT_SCHEDULE_ACCESS: AgentScheduleAccess = "full";

const VALID_ACCESS = new Set<AgentScheduleAccess>(["full", "read_only", "blocked"]);

const METADATA_KEY = "agentScheduleAccess";

type DbLike = Pick<typeof defaultDb, "task">;

export function parseAgentScheduleAccess(value: unknown): AgentScheduleAccess | null {
  return typeof value === "string" && VALID_ACCESS.has(value as AgentScheduleAccess)
    ? (value as AgentScheduleAccess)
    : null;
}

export function readAgentScheduleAccessFromMetadata(
  metadata: string | null | undefined,
): AgentScheduleAccess {
  if (!metadata) return DEFAULT_AGENT_SCHEDULE_ACCESS;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown> | null;
    return parseAgentScheduleAccess(parsed?.[METADATA_KEY]) ?? DEFAULT_AGENT_SCHEDULE_ACCESS;
  } catch {
    return DEFAULT_AGENT_SCHEDULE_ACCESS;
  }
}

/** Whether a request is an autonomous agent turn acting on the task. */
export function isAgentActor(request: NextRequest): boolean {
  return (request.headers.get("x-conductor-actor") ?? "").trim().toLowerCase() === "agent";
}

export type AgentWriteDenial = {
  error: "agent_schedule_forbidden";
  access: AgentScheduleAccess;
  message: string;
};

/**
 * Returns a denial payload when an agent write is not permitted by the access
 * level, or null when it is allowed. Reads (list) are governed separately by
 * `agentReadDenied`.
 */
export function agentWriteDenied(access: AgentScheduleAccess): AgentWriteDenial | null {
  if (access === "full") return null;
  return {
    error: "agent_schedule_forbidden",
    access,
    message:
      access === "blocked"
        ? "Agent scheduling is blocked for this task"
        : "Agent scheduling is read-only for this task",
  };
}

export function agentReadDenied(access: AgentScheduleAccess): AgentWriteDenial | null {
  if (access !== "blocked") return null;
  return {
    error: "agent_schedule_forbidden",
    access,
    message: "Agent scheduling is blocked for this task",
  };
}

/**
 * Resolve the effective access for a request. Returns "full" for non-agent
 * requests (they are never restricted) and the live task setting for agent
 * requests. Returns null when the task is not owned by the user (the caller
 * lets the downstream ownership check produce the 404).
 */
export async function resolveRequestScheduleAccess(input: {
  request: NextRequest;
  userId: string;
  taskId: string;
  client?: DbLike;
}): Promise<AgentScheduleAccess | "not_agent"> {
  if (!isAgentActor(input.request)) {
    return "not_agent";
  }
  const db = input.client ?? defaultDb;
  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
    select: { metadata: true },
  });
  return readAgentScheduleAccessFromMetadata(task?.metadata);
}

/**
 * Persist a new access level onto the task's metadata JSON (owner-scoped).
 * Returns the stored access, or null when the task is not found / not owned.
 */
export async function setAgentScheduleAccessForTask(input: {
  userId: string;
  taskId: string;
  access: AgentScheduleAccess;
  client?: DbLike;
}): Promise<AgentScheduleAccess | null> {
  const db = input.client ?? defaultDb;
  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
    select: { id: true, metadata: true },
  });
  if (!task) return null;

  let metadata: Record<string, unknown> = {};
  if (task.metadata) {
    try {
      const parsed = JSON.parse(task.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
  }
  metadata[METADATA_KEY] = input.access;
  await db.task.update({ where: { id: task.id }, data: { metadata: JSON.stringify(metadata) } });
  return input.access;
}
