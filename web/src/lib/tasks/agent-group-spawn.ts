/**
 * Server-side wiring for multi-agent task groups (RFC 0033), shared by every
 * route that starts a group: `POST /api/tasks` and the Issue todo→doing spawn.
 * See `./agent-group` for the model; this module resolves the registry, checks
 * backends against the execution daemon and spawns the reviewer siblings.
 */

import { randomUUID } from "crypto";
import { resolveProjectAgentsRegistry } from "@/lib/projects/daemon-binding";
import { realtimeHub } from "@/lib/realtime/hub";
import { createAndDispatchAiTask } from "@/lib/tasks/create-ai-task";
import { normalizeBackendType, type ConnectedAgent } from "@/lib/tasks/pty-runtime";
import { type JsonObject } from "@/lib/tasks/task-config";
import { inheritTaskWorktreeLaunchConfig } from "@/lib/tasks/worktree";
import { mergeRelatedTaskCardGroup } from "@/lib/user-preferences";
import { buildAgentBootstrap, buildGroupMemberMetadata, type AgentSpec } from "./agent-group";

export interface AgentGroupPlan {
  groupId: string;
  workerAgent: string;
  /** Workspace-relative path to the worker's agent doc, from the registry. */
  workerDoc: string;
  workerBackendType: string | null;
  reviewers: Array<{ agent: string; backend: string | null; doc: string; taskId: string }>;
}

/**
 * Agent doc paths are NOT hard-coded — they come from the project's `agents`
 * registry in `.conductor/settings.yaml`. Every requested agent must be
 * registered. agents[0] executes the task (worker); agents[1..] become sibling
 * reviewer tasks. The worker's backend is its own agent-entry override, else
 * the explicit request backend, else the registry's per-agent default;
 * reviewers cascade the same way, falling back to the worker's backend.
 */
export async function resolveAgentGroupPlan(params: {
  userId: string;
  agents: AgentSpec[];
  daemonHost: string | null;
  workspacePath: string | null;
  requestedBackendType: string | null;
}): Promise<{ error: string } | AgentGroupPlan> {
  const registry = await resolveProjectAgentsRegistry({
    userId: params.userId,
    daemonHost: params.daemonHost,
    workspacePath: params.workspacePath,
  });
  const registryMap = new Map(registry.map((entry) => [entry.name, entry]));
  const unknown = params.agents.find((spec) => !registryMap.has(spec.name));
  if (unknown) {
    return {
      error: `unknown agent "${unknown.name}" — register it in .conductor/settings.yaml (agents:)`,
    };
  }
  const [worker, ...reviewers] = params.agents;
  const workerEntry = registryMap.get(worker.name)!;
  return {
    groupId: randomUUID(),
    workerAgent: worker.name,
    workerDoc: workerEntry.doc,
    workerBackendType: worker.backend ?? params.requestedBackendType ?? workerEntry.backend ?? null,
    reviewers: reviewers.map((spec) => {
      const entry = registryMap.get(spec.name)!;
      return {
        agent: spec.name,
        backend: spec.backend ?? entry.backend,
        doc: entry.doc,
        taskId: randomUUID(),
      };
    }),
  };
}

/**
 * Registry defaults are project-owned configuration, but execution still has to
 * match the selected daemon's live capabilities. Returns an error when any
 * member names a backend the daemon does not advertise; otherwise the caller
 * would return a task that can never start (reviewer creation is fail-soft).
 */
export function findAgentGroupBackendError(
  plan: AgentGroupPlan,
  executionAgent: ConnectedAgent,
): string | null {
  const advertisedBackends = new Set(
    executionAgent.supportedBackends
      .map((backend) => normalizeBackendType(backend))
      .filter((backend): backend is string => Boolean(backend)),
  );
  const unsupported = [
    { agent: plan.workerAgent, backend: plan.workerBackendType },
    ...plan.reviewers.map((spec) => ({
      agent: spec.agent,
      backend: spec.backend ?? plan.workerBackendType,
    })),
  ].find((entry) => entry.backend && !advertisedBackends.has(entry.backend));
  return unsupported?.backend
    ? `agent "${unsupported.agent}" requires backend "${unsupported.backend}", ` +
        `but daemon "${executionAgent.host}" does not advertise it`
    : null;
}

/**
 * Spawn the plan's reviewer tasks next to an already-created worker. Each
 * reviewer is an ordinary ai_task sharing the group's `groupId` and a bootstrap
 * pointing it at its own agent doc. A reviewer spawn failure never fails the
 * worker creation, so each is wrapped fail-soft.
 */
export async function spawnAgentGroupReviewers(params: {
  userId: string;
  projectId: string;
  workerTaskId: string;
  plan: AgentGroupPlan;
  agentHost: string | null;
  workerLaunchConfig: JsonObject | null;
  projectWorkspacePath: string | null;
  projectWorktreeBranch: string | null;
  fireTaskDaemonName?: string | null;
  status?: string;
}): Promise<{
  reviewerTaskIds: string[];
  taskCardGroupsSnapshot: Awaited<ReturnType<typeof mergeRelatedTaskCardGroup>> | null;
}> {
  const { userId, projectId, workerTaskId, plan } = params;
  // Pair each spawned reviewer with its agent name as we go. Looking the name
  // up afterwards would mean keying on the pre-allocated `spec.taskId` and
  // assuming it equals the id the create returned.
  const reviewerGroupMembers: Array<{ taskId: string; agent: string }> = [];
  // Every member of a group must run in the *same* working directory: the
  // worker's worktree when `worktree` was requested, otherwise the project
  // workspace root. Reuse the worker's resolved worktree fields verbatim so
  // the daemon's `buildTaskWorktreeRoot` (keyed on worktreeBranch) lands all
  // siblings in one folder — the same sharing branch/fork tasks rely on.
  //
  // `reuseOnly` marks reviewers as non-owners: the worker creates the branch,
  // reviewers wait for it. Without this every member would race on the same
  // `git worktree add -b`. They still carry the full worktree identity so
  // teardown's `hasSameTaskWorktreeRoot` sibling guard can see them and skip
  // cleanup while a reviewer is still running.
  const sharedWorktreeLaunchConfig = inheritTaskWorktreeLaunchConfig(params.workerLaunchConfig, {
    reuseOnly: true,
  });
  for (const spec of plan.reviewers) {
    const reviewerBackendType = spec.backend ?? plan.workerBackendType;
    const reviewerInitialContent = buildAgentBootstrap({
      agent: spec.agent,
      role: "reviewer",
      docPath: spec.doc,
    });
    const reviewerLaunchConfig: JsonObject = {
      ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
      ...(sharedWorktreeLaunchConfig ?? {
        ...(params.projectWorkspacePath ? { cwd: params.projectWorkspacePath } : {}),
        ...(params.projectWorktreeBranch ? { worktreeBranch: params.projectWorktreeBranch } : {}),
      }),
      initialContent: reviewerInitialContent,
    };
    try {
      const reviewerTask = await createAndDispatchAiTask({
        userId,
        projectId,
        issueId: null,
        title: `Reviewer: ${spec.agent}`,
        agentHost: params.agentHost,
        requestedId: spec.taskId,
        requestedBackendType: reviewerBackendType,
        launchConfig: reviewerLaunchConfig,
        metadata: {
          ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
          ...(params.fireTaskDaemonName ? { daemonName: params.fireTaskDaemonName } : {}),
          initialContent: reviewerInitialContent,
          ...buildGroupMemberMetadata({ groupId: plan.groupId, role: "reviewer", agent: spec.agent }),
        },
        initialMessageContent: reviewerInitialContent,
        status: params.status,
        groupId: plan.groupId,
      });
      reviewerGroupMembers.push({ taskId: reviewerTask.id, agent: spec.agent });
    } catch (error) {
      console.error(
        `Failed to spawn reviewer task for agent "${spec.agent}"`,
        error,
      );
    }
  }

  // Collapse the group into a single tab card in the task list. The shared
  // `groupId` above is an execution-time relationship the agents use to find
  // each other; it is invisible to the list view, which renders from the
  // per-user card groups in `user_preferences`. Without this the members show
  // up as unrelated cards. Mirrors the restart successor path.
  let taskCardGroupsSnapshot: Awaited<ReturnType<typeof mergeRelatedTaskCardGroup>> | null = null;
  for (const { taskId: reviewerTaskId, agent } of reviewerGroupMembers) {
    try {
      // Serial on purpose: each merge is a read-modify-write of one
      // preference row, so concurrent merges would clobber each other and
      // only the last reviewer would survive in the card. Name each tab after
      // its agent, so the strip reads "feature-dev | code-reviewer" instead of
      // the default ordinals "1 | 2".
      taskCardGroupsSnapshot = await mergeRelatedTaskCardGroup(
        userId,
        workerTaskId,
        reviewerTaskId,
        { source: plan.workerAgent, related: agent },
      );
    } catch (error) {
      // Grouping is presentation state. The tasks are already created and
      // dispatched; failing the request here would invite a duplicate group.
      console.warn(
        `[agent-group] reviewer ${reviewerTaskId} was created but could not be grouped with ${workerTaskId}`,
        error,
      );
    }
  }
  if (taskCardGroupsSnapshot) {
    realtimeHub.broadcastToUser(userId, {
      type: "task_card_groups_update",
      payload: {
        user_id: userId,
        snapshot: taskCardGroupsSnapshot,
        updated_at: new Date().toISOString(),
      },
    });
  }

  return {
    reviewerTaskIds: reviewerGroupMembers.map((member) => member.taskId),
    taskCardGroupsSnapshot,
  };
}
