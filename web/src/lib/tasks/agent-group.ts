/**
 * Multi-agent task groups (worker + reviewer[s]).
 *
 * A task can be created with an ordered list of agents. The first agent executes
 * the task (the "worker"); any additional agents are spawned as sibling
 * "reviewer" tasks that review the worker. All review behavior (cadence, what to
 * read, when/how to send feedback) lives in each registered agent doc and is
 * carried out by the agent through Conductor's existing CLI
 * (`conductor task messages|show|send|schedule`).
 *
 * Group membership is a first-class, queryable relationship: every task created
 * together shares a `groupId` (persisted on the task). An agent discovers its
 * siblings at runtime with `conductor task group` (→ `GET /tasks/:id/group`) —
 * task ids are NOT hard-passed through the prompt. See RFC 0033.
 *
 * Which agents exist and where each agent's doc lives is NOT hard-coded: it is
 * the project's `agents` registry in `.conductor/settings.yaml` (parsed by
 * `readProjectAgentsRegistry`). The create route resolves each agent's doc path
 * from that registry and passes it here as `docPath`.
 */

/** Upper bound on agents per task to avoid accidental fan-out. */
export const MAX_AGENTS_PER_TASK = 8;

export const TASK_GROUP_SCHEMA_UNAVAILABLE_MESSAGE =
  "Task groups require the latest database migration";

/**
 * Valid registry keys start alphanumeric, then contain only alphanumerics /
 * `.` `_` `-`. Paths are resolved independently from settings.yaml, so request
 * values are names only and can never smuggle a doc path.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Backend names are short slugs (claude, codex, kimi, opencode, …). */
const BACKEND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type LinkedTaskRole = "worker" | "reviewer";

/**
 * A normalized agent entry from the `agents` request field. `backend` is the
 * optional per-agent backend override (worker → task's backend; each reviewer →
 * its own backend, falling back to the worker's). Null when unspecified.
 */
export interface AgentSpec {
  name: string;
  backend: string | null;
}

/**
 * Per-task group metadata stamped onto each member's `metadata`, so the group
 * query can report each task's role and agent without re-deriving them.
 */
export interface GroupMemberMetadata {
  groupId: string;
  agentRole: LinkedTaskRole;
  agentName: string;
}

export type ParseAgentsResult =
  | null // field absent → single-task path, unchanged behavior
  | { error: string }
  | { agents: AgentSpec[] };

/**
 * Parse + validate the request `agents` field.
 *
 * Each entry may be a bare string (agent name) or an object
 * `{ name, backend? }` (per-agent backend override). Returns `null` when the
 * field is absent (caller falls back to the normal single-task create),
 * `{ error }` when present-but-malformed (caller returns 400), or `{ agents }`
 * with normalized specs when valid.
 */
export function parseAgentsInput(raw: unknown): ParseAgentsResult {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    return { error: "agents must be an array of agent names" };
  }
  if (raw.length === 0) {
    return { error: "agents must not be empty" };
  }
  if (raw.length > MAX_AGENTS_PER_TASK) {
    return { error: `agents supports at most ${MAX_AGENTS_PER_TASK} entries` };
  }
  const agents: AgentSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let rawName: unknown;
    let rawBackend: unknown;
    if (typeof entry === "string") {
      rawName = entry;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      rawName = (entry as Record<string, unknown>).name;
      rawBackend = (entry as Record<string, unknown>).backend;
    } else {
      return { error: "each agent must be a string name or { name, backend? }" };
    }

    if (typeof rawName !== "string") {
      return { error: "each agent must have a string name" };
    }
    const name = rawName.trim();
    if (!name) {
      return { error: "agent names must not be blank" };
    }
    if (!AGENT_NAME_RE.test(name)) {
      return {
        error: `invalid agent name "${rawName}" (allowed: letters, digits, . _ -)`,
      };
    }
    if (seen.has(name)) {
      return { error: `duplicate agent "${name}"` };
    }

    let backend: string | null = null;
    if (rawBackend !== undefined && rawBackend !== null) {
      if (typeof rawBackend !== "string") {
        return { error: `backend for agent "${name}" must be a string` };
      }
      const trimmed = rawBackend.trim().toLowerCase();
      if (trimmed) {
        if (!BACKEND_NAME_RE.test(trimmed)) {
          return { error: `invalid backend "${rawBackend}" for agent "${name}"` };
        }
        backend = trimmed;
      }
    }

    seen.add(name);
    agents.push({ name, backend });
  }
  return { agents };
}

/** Build the per-task group metadata for a member. */
export function buildGroupMemberMetadata(params: {
  groupId: string;
  role: LinkedTaskRole;
  agent: string;
}): GroupMemberMetadata {
  return { groupId: params.groupId, agentRole: params.role, agentName: params.agent };
}

/**
 * Compose the initial turn ("bootstrap") delivered to a task in a group. It is
 * deliberately generic — it points the agent at its own doc and, for reviewers,
 * tells it how to discover its siblings (`conductor task group`). It hard-codes
 * no review policy and no sibling task ids. For the worker, the user's original
 * task prompt is appended after the bootstrap.
 */
export function buildAgentBootstrap(params: {
  agent: string;
  role: LinkedTaskRole;
  /** Workspace-relative path to this agent's doc, from the project registry. */
  docPath: string;
  /** The user's original task prompt (worker only). */
  taskPrompt?: string | null;
}): string {
  const { agent, role, docPath, taskPrompt } = params;
  const lines: string[] = [];
  lines.push(
    `[conductor:agent] You are the "${agent}" agent for this task group (your role: ${role}).`,
  );
  lines.push(`Read and follow your agent doc: ${docPath}`);

  if (role === "reviewer") {
    lines.push("");
    lines.push(
      "To discover the task(s) you review and their ids, run: `conductor task group`",
    );
    lines.push(
      "(it lists every task in your group; the entry with role \"worker\" is your review target). " +
        "Follow your agent doc to set your own review cadence and to read/send feedback " +
        "via `conductor task messages|show|send`.",
    );
  }

  const bootstrap = lines.join("\n");
  const prompt = typeof taskPrompt === "string" ? taskPrompt.trim() : "";
  if (role === "worker" && prompt) {
    return `${bootstrap}\n\n--- Task ---\n${prompt}`;
  }
  return bootstrap;
}
