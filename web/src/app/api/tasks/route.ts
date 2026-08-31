import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { createAndDispatchAiTask } from "@/lib/tasks/create-ai-task";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  normalizeTaskType,
  parseJsonObject,
  parseTaskType,
  serializeJsonObject,
  type JsonObject,
} from "@/lib/tasks/task-config";
import {
  buildTaskWorktreeLaunchConfig,
  inheritTaskWorktreeLaunchConfig,
  isTaskWorktreeRequested,
} from "@/lib/tasks/worktree";
import {
  applyLegacyTaskShape,
  isMissingAnyNewSchemaError,
  isMissingGroupIdColumnError,
  isMissingPtySchemaError,
  isMissingSecondProjectIdColumnError,
  legacyTaskSelect,
  PTY_SCHEMA_UNAVAILABLE_MESSAGE,
  taskSelectWithoutIssueId,
  withPtySchemaFallback,
} from "@/lib/tasks/pty-compat";
import {
  buildPtySessionCreateSeed,
  dispatchPtyTaskCreation,
  normalizeBackendType,
  pickDefaultAgentHost,
  resolvePtyAgentHost,
  validatePtyLaunchConfig,
  type ConnectedAgent,
} from "@/lib/tasks/pty-runtime";
import {
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import { recoverStaleDisconnectedAgentTasks } from "@/lib/tasks/stale-recovery";
import {
  findAttachedPtyTaskIdsByProjects,
  findAttachedTerminalsByAiTaskIds,
} from "@/lib/tasks/attached-terminal";
import { countActiveScheduledMessagesForTasks } from "@/lib/tasks/scheduled-messages";
import { evaluateRuntimeHealth } from "@/lib/tasks/runtime-preflight";
import { mergeRelatedTaskCardGroup } from "@/lib/user-preferences";
import {
  buildAgentBootstrap,
  buildGroupMemberMetadata,
  parseAgentsInput,
  TASK_GROUP_SCHEMA_UNAVAILABLE_MESSAGE,
} from "@/lib/tasks/agent-group";
import { resolveProjectAgentsRegistry } from "@/lib/projects/daemon-binding";

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readBodyField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): unknown => {
  if (hasOwn(body, snakeCaseKey)) {
    return body[snakeCaseKey];
  }
  if (hasOwn(body, camelCaseKey)) {
    return body[camelCaseKey];
  }
  return undefined;
};

const hasBodyField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): boolean => hasOwn(body, snakeCaseKey) || hasOwn(body, camelCaseKey);

const parseJsonField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): { hasField: boolean; value: JsonObject | null; raw: unknown } => {
  const hasField = hasBodyField(body, snakeCaseKey, camelCaseKey);
  const raw = hasField ? readBodyField(body, snakeCaseKey, camelCaseKey) : undefined;
  return {
    hasField,
    raw,
    value: parseJsonObject(raw),
  };
};

// Card previews only need the latest non-empty user + assistant message per
// task. The previous implementation loaded EVERY user/assistant message's full
// `content` for all task ids into memory just to keep the first two per task —
// at ~130 tasks with long agent transcripts that meant tens of thousands of
// rows and hundreds of MB hydrated per request.
const PREVIEW_MAX_CHARS = 200;

type TaskMessagePreview = { lastUserMessage: string | null; lastAssistantMessage: string | null };

// Keep the first (newest) non-empty message per role; inputs arrive newest-first
// so the `== null` guard makes the latest win. Truncated to keep the payload small.
const applyPreviewRow = (
  previews: Record<string, TaskMessagePreview>,
  taskId: string,
  role: string,
  rawContent: string | null,
): void => {
  const target = previews[taskId];
  if (!target) {
    return;
  }
  const content =
    typeof rawContent === "string" ? rawContent.trim().slice(0, PREVIEW_MAX_CHARS) : "";
  if (!content) {
    return;
  }
  if (role === "user") {
    if (target.lastUserMessage == null) {
      target.lastUserMessage = content;
    }
  } else if (role === "assistant") {
    if (target.lastAssistantMessage == null) {
      target.lastAssistantMessage = content;
    }
  }
};

// Warn once, not per request — on a dialect that always rejects the raw query
// (e.g. Postgres) the fallback would otherwise spam the log every list load.
let warnedPreviewFallback = false;

const buildTaskMessagePreviews = async (
  taskIds: string[],
): Promise<Record<string, TaskMessagePreview>> => {
  const previews: Record<string, TaskMessagePreview> = {};

  for (const taskId of taskIds) {
    previews[taskId] = {
      lastUserMessage: null,
      lastAssistantMessage: null,
    };
  }

  if (taskIds.length === 0) {
    return previews;
  }

  // Fast path: a window function returns exactly the <=2 rows we keep, truncated
  // in-DB, instead of hydrating every message. Double-quoted identifiers +
  // SUBSTR/ROW_NUMBER work on both SQLite (prod) and Postgres.
  try {
    const rows = await db.$queryRaw<Array<{ task_id: string; role: string; content: string | null }>>`
      SELECT "task_id", "role", "content"
      FROM (
        SELECT
          "task_id",
          "role",
          SUBSTR("content", 1, ${PREVIEW_MAX_CHARS}) AS "content",
          ROW_NUMBER() OVER (
            PARTITION BY "task_id", "role"
            ORDER BY "created_at" DESC, "id" DESC
          ) AS rn
        FROM "messages"
        WHERE "task_id" IN (${Prisma.join(taskIds)})
          AND "role" IN ('user', 'assistant')
          AND "content" IS NOT NULL
          AND TRIM("content") <> ''
      ) ranked
      WHERE rn = 1
    `;
    for (const row of rows) {
      applyPreviewRow(previews, row.task_id, row.role, row.content);
    }
    return previews;
  } catch (error) {
    // Fall back to a Prisma-typed query if the raw SQL is rejected on some
    // dialect (e.g. Postgres uuid vs text bind params in the IN list). Slower
    // (scans more rows) but correct — mirrors the schema-fallback pattern used
    // by the main task-list query in this route.
    if (!warnedPreviewFallback) {
      warnedPreviewFallback = true;
      console.warn(
        "[tasks.GET.previews] window-function query failed; using per-message scan fallback.",
        error,
      );
    }
  }

  const messages = await db.message.findMany({
    where: {
      taskId: { in: taskIds },
      role: { in: ["user", "assistant"] },
    },
    select: { taskId: true, role: true, content: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const message of messages) {
    applyPreviewRow(previews, message.taskId, message.role, message.content);
  }

  return previews;
};

// `projectIds` may be `null` (no filter), `[id]` (single project) or
// `[a, b, …]` (cross-daemon merged group). Display grouping honours the
// display-only `secondProjectId` override so a moved default-project task
// appears under its target project and NOT under the default one:
//   - a task whose real `projectId` is in the set but which has been moved
//     out (`secondProjectId` set) is EXCLUDED (mutual exclusion), and
//   - a task moved INTO one of these projects (`secondProjectId` in the set)
//     is INCLUDED even though its real `projectId` is the default project.
// `secondProjectId` is only ever set on default-project tasks, so for regular
// projects the second clause is a no-op and behaviour is unchanged.
const buildProjectIdFilter = (projectIds: string[] | null): Record<string, unknown> => {
  if (projectIds === null) return {};
  const idClause = projectIds.length === 1 ? projectIds[0] : { in: projectIds };
  return {
    OR: [
      { projectId: idClause, secondProjectId: null },
      { secondProjectId: idClause },
    ],
  };
};

// Pre-`second_project_id` fallback filter: plain projectId match, no reference
// to the display-only column. Used only when the DB predates the
// `second_project_id` migration, so the OR-based filter above would throw.
const buildLegacyProjectIdFilter = (
  projectIds: string[] | null,
): Record<string, unknown> => {
  if (projectIds === null) return {};
  if (projectIds.length === 1) return { projectId: projectIds[0] };
  return { projectId: { in: projectIds } };
};

const runTaskListQuery = (
  userId: string,
  projectFilter: Record<string, unknown>,
) => {
  // Achieved (packed) tasks are excluded from the active list and all counts.
  // Their transcripts live on for search via the Achieved-task manager.
  const activeFilter = { achievedAt: null };
  return withPtySchemaFallback(
    "tasks.GET.list",
    () =>
      db.task.findMany({
        where: {
          project: { userId },
          ...projectFilter,
          ...activeFilter,
        },
        include: {
          ptySession: true,
        },
      }),
    // Fallback tiers run only on pre-migration schemas that lack newer
    // columns. Such rows cannot be achieved (no `achieved_at` column), so the
    // active filter is intentionally omitted here to keep the query valid.
    async () =>
      (await db.task.findMany({
        where: {
          project: { userId },
          ...projectFilter,
        },
        select: legacyTaskSelect,
      })).map((task) => ({ ...applyLegacyTaskShape(task), issueId: null })),
    async () =>
      (await db.task.findMany({
        where: {
          project: { userId },
          ...projectFilter,
        },
        select: {
          ...taskSelectWithoutIssueId,
          ptySession: true,
        },
      })).map((task) => ({
        ...task,
        issueId: null,
        achievedAt: null,
        secondProjectId: null,
        groupId: null,
      })),
  );
};

const findTasksForList = async (userId: string, projectIds: string[] | null) => {
  try {
    return await runTaskListQuery(userId, buildProjectIdFilter(projectIds));
  } catch (error) {
    // The DB predates the `second_project_id` migration: the OR filter (and the
    // column SELECT) reference a column that does not exist. Degrade to a plain
    // projectId filter so the task list stays available until `db:push` runs.
    // Mutual-exclusion display for moved tasks is inert in this window because
    // no row can carry `secondProjectId` yet.
    if (!isMissingSecondProjectIdColumnError(error)) throw error;
    console.warn(
      "[tasks.GET.list] second_project_id column missing; falling back to plain projectId filter. Run 'pnpm -C web db:push'.",
    );
    return runTaskListQuery(userId, buildLegacyProjectIdFilter(projectIds));
  }
};

const getTaskListSortTime = (task: { updatedAt?: Date | null; createdAt: Date }) =>
  (task.updatedAt instanceof Date ? task.updatedAt : task.createdAt).getTime();

const createPtyTaskRecord = async (args: {
  requestedId?: string;
  projectId: string;
  title: string;
  status: string;
  agentHost: string | null;
  requestedBackendType: string | null;
  requestedSessionId: string | null;
  requestedSessionFilePath: string | null;
  launchConfig: JsonObject | null;
  metadata: JsonObject | null;
}) =>
  db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        id: args.requestedId,
        projectId: args.projectId,
        title: args.title,
        taskType: "pty_task",
        status: args.status,
        agentHost: args.agentHost,
        executionHost: null,
        backendType: args.requestedBackendType,
        sessionId: args.requestedSessionId,
        sessionFilePath: args.requestedSessionFilePath,
        launchConfig: serializeJsonObject(args.launchConfig),
        metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      },
    });

    const ptySession = await tx.ptySession.create({
      data: buildPtySessionCreateSeed(task.id, args.launchConfig),
    });

    return { task, ptySession };
  });

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id")?.trim() || null;
  // `project_ids` lets the UI fetch tasks across multiple projects in a single
  // call — used by the cross-daemon merged-project view so the task list shows
  // tasks from each daemon's same-named project together. Mutually exclusive
  // with `project_id`, mirroring the contract on `/api/issues`.
  const rawProjectIds = searchParams.get("project_ids");
  const explicitProjectIds = rawProjectIds
    ? rawProjectIds
        .split(",")
        .flatMap((value) => {
          const trimmed = value.trim();
          return trimmed ? [trimmed] : [];
        })
    : [];

  if (projectId && explicitProjectIds.length > 0) {
    return NextResponse.json(
      { error: "Specify either project_id or project_ids, not both" },
      { status: 400 },
    );
  }

  const recoverStale = searchParams.get("recover_stale") === "1";

  const projectIdFilter: string[] | null = explicitProjectIds.length > 0
    ? explicitProjectIds
    : projectId
      ? [projectId]
      : null;

  // `project_ids` was supplied but every value was blank — return an empty
  // list rather than silently falling back to the unfiltered query.
  if (projectIdFilter !== null && projectIdFilter.length === 0) {
    return NextResponse.json([]);
  }

  const rawTasks = await findTasksForList(user.id, projectIdFilter);

  // Exclude PTY tasks that are attached to an AI task — they are rendered
  // inside the AI task's detail pane, not as standalone cards. We exclude
  // by TWO independent signals so an orphaned AttachedTerminal row (or a
  // PTY task whose AttachedTerminal was deleted out of band) doesn't leak
  // into the list:
  //   (a) AttachedTerminal table maps ptyTaskId → an AI task in scope
  //   (b) The PTY task's own metadata carries `attachedToAiTaskId`
  const attachedPtyTaskIds = await findAttachedPtyTaskIdsByProjects(
    user.id,
    projectIdFilter,
  );
  const tasks = rawTasks.filter((task) => {
    if (attachedPtyTaskIds.has(task.id)) return false;
    if ((task.taskType ?? "ai_task") === "pty_task") {
      const metadata = parseJsonObject(task.metadata);
      if (typeof metadata?.attachedToAiTaskId === "string") return false;
    }
    return true;
  });

  if (recoverStale) {
    await recoverStaleDisconnectedAgentTasks(user.id, tasks as any);
  }

  const taskIds = tasks.map((task) => task.id);
  const messagePreviews = await buildTaskMessagePreviews(taskIds);
  // Only AI tasks can have attached terminals; restricting the lookup
  // keeps the query small.
  const aiTaskIds = tasks
    .filter((task) => (task.taskType ?? "ai_task") === "ai_task")
    .map((task) => task.id);
  const attachedTerminals = await findAttachedTerminalsByAiTaskIds(aiTaskIds);
  const activeScheduledMessageCounts = await countActiveScheduledMessagesForTasks({
    userId: user.id,
    taskIds,
  });

  const response = tasks
    .slice()
    .sort((a, b) => {
      const updatedDelta = getTaskListSortTime(b) - getTaskListSortTime(a);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .map((task) => {
      const attached = attachedTerminals.get(task.id) ?? null;
      return serializeTaskResponse({
        ...task,
        lastUserMessage: messagePreviews[task.id]?.lastUserMessage ?? null,
        lastAssistantMessage: messagePreviews[task.id]?.lastAssistantMessage ?? null,
        attachedTerminal: attached,
        activeScheduledMessageCount: activeScheduledMessageCounts.get(task.id) ?? 0,
      });
    });

  return NextResponse.json(response);
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const projectId = normalizeOptionalString(
    readBodyField(normalizedBody, "project_id", "projectId")
  );
  if (!projectId) {
    return NextResponse.json({ error: "project_id required" }, { status: 400 });
  }
  const hasParentTaskId = hasBodyField(
    normalizedBody,
    "parent_task_id",
    "parentTaskId",
  );
  const parentTaskId = normalizeOptionalString(
    readBodyField(normalizedBody, "parent_task_id", "parentTaskId"),
  );
  if (hasParentTaskId && !parentTaskId) {
    return NextResponse.json({ error: "parent_task_id must not be empty" }, { status: 400 });
  }

  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (parentTaskId) {
    let parentTask: { id: string } | null;
    try {
      parentTask = await db.task.findFirst({
        where: {
          id: parentTaskId,
          achievedAt: null,
          project: { userId: user.id },
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isMissingAnyNewSchemaError(error)) {
        throw error;
      }
      // Pre-achieve schemas have no archived tasks, so ownership is the only
      // visibility constraint available during a rolling deployment.
      parentTask = await db.task.findFirst({
        where: {
          id: parentTaskId,
          project: { userId: user.id },
        },
        select: { id: true },
      });
    }
    if (!parentTask) {
      return NextResponse.json(
        { error: "Parent task not found or is archived" },
        { status: 404 },
      );
    }
  }
  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const isDefaultProject = defaultProject?.projectId === project.id;
  const projectDaemonHost = normalizeOptionalString((project as { daemonHost?: string | null }).daemonHost);
  const projectWorkspacePath = normalizeOptionalString((project as { workspacePath?: string | null }).workspacePath);
  const projectRepoRoot = normalizeOptionalString((project as { repoRoot?: string | null }).repoRoot);
  const projectWorktreeBranch = normalizeOptionalString((project as { worktreeBranch?: string | null }).worktreeBranch);
  const projectLastCommit = normalizeOptionalString((project as { lastCommit?: string | null }).lastCommit);
  if (
    (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
    (projectDaemonHost && !projectWorkspacePath) ||
    (!projectDaemonHost && projectWorkspacePath)
  ) {
    return NextResponse.json({ error: "Project binding incomplete" }, { status: 409 });
  }

  const connectedAgents = realtimeHub.getAgentsForUser(
    user.id
  ) as ConnectedAgent[];
  const requestAgentHost = normalizeOptionalString(
    readBodyField(normalizedBody, "agent_host", "agentHost")
  );
  const isFireHostRequest = isConductorFireHost(requestAgentHost);
  if (
    projectDaemonHost &&
    !isFireHostRequest &&
    !connectedAgents.some((agent) => agent.host === projectDaemonHost)
  ) {
    return NextResponse.json(
      { error: `Project daemon ${projectDaemonHost} is offline` },
      { status: 409 },
    );
  }
  const hasTaskTypeField = hasBodyField(normalizedBody, "task_type", "taskType");
  const rawTaskType = readBodyField(normalizedBody, "task_type", "taskType");
  if (hasTaskTypeField && parseTaskType(rawTaskType) === null) {
    return NextResponse.json({ error: "invalid task_type" }, { status: 400 });
  }
  const taskType = normalizeTaskType(rawTaskType);
  const requestedBackendType = normalizeBackendType(
    readBodyField(normalizedBody, "backend_type", "backendType")
  );
  const requestedSessionId = normalizeOptionalString(
    readBodyField(normalizedBody, "session_id", "sessionId")
  );
  const requestedSessionFilePath = normalizeOptionalString(
    readBodyField(normalizedBody, "session_file_path", "sessionFilePath")
  );
  const initialContent = normalizeOptionalString(
    readBodyField(normalizedBody, "initial_content", "initialContent")
  );
  const agentsParse = parseAgentsInput(readBodyField(normalizedBody, "agents", "agents"));
  if (agentsParse && "error" in agentsParse) {
    return NextResponse.json({ error: agentsParse.error }, { status: 400 });
  }
  const agentGroup = agentsParse && "agents" in agentsParse ? agentsParse.agents : null;
  if (agentGroup && taskType !== "ai_task") {
    return NextResponse.json(
      { error: "agents is only supported for ai_task" },
      { status: 400 },
    );
  }
  // RFC 0033: agent doc paths are NOT hard-coded — they come from the project's
  // `agents` registry in `.conductor/settings.yaml`. Resolve it and require
  // every requested agent to be registered.
  const agentRegistry = agentGroup
    ? await resolveProjectAgentsRegistry({
        userId: user.id,
        daemonHost: projectDaemonHost,
        workspacePath: projectWorkspacePath,
      })
    : [];
  const agentRegistryMap = new Map(agentRegistry.map((entry) => [entry.name, entry]));
  if (agentGroup) {
    for (const spec of agentGroup) {
      if (!agentRegistryMap.has(spec.name)) {
        return NextResponse.json(
          {
            error: `unknown agent "${spec.name}" — register it in .conductor/settings.yaml (agents:)`,
          },
          { status: 400 },
        );
      }
    }
  }
  const launchConfigField = parseJsonField(normalizedBody, "launch_config", "launchConfig");
  if (
    launchConfigField.hasField &&
    launchConfigField.raw != null &&
    launchConfigField.value === null
  ) {
    return NextResponse.json({ error: "launch_config must be an object" }, { status: 400 });
  }
  let launchConfig = launchConfigField.value;
  const worktreeRequested = isTaskWorktreeRequested(launchConfig);
  if (taskType === "pty_task" && worktreeRequested) {
    return NextResponse.json({ error: "PTY task does not support worktree" }, { status: 400 });
  }
  const requestedId =
    typeof normalizedBody.id === "string" && normalizedBody.id.trim()
      ? normalizedBody.id
      : worktreeRequested || agentGroup
        ? randomUUID()
        : undefined;

  // Multi-agent group wiring (RFC 0033): agents[0] executes the task (worker);
  // agents[1..] are spawned as sibling reviewer tasks. Every task in the group
  // shares a `groupId` so members can discover each other via
  // `conductor task group` — we do NOT hard-pass sibling ids through the prompt.
  // All review behavior lives in the agent docs, run via the existing conductor
  // CLI — no orchestration here.
  const groupId: string | null = agentGroup ? randomUUID() : null;
  const workerEntry = agentGroup ? agentRegistryMap.get(agentGroup[0].name)! : null;
  // The worker's backend: its own agent-entry override, else the explicit
  // top-level backend_type, else the registry's per-agent default. Reviewers cascade the
  // same way, falling back to the worker's backend.
  const workerBackendType =
    agentGroup?.[0]?.backend ?? requestedBackendType ?? workerEntry?.backend ?? null;
  const reviewerSpecs: Array<{
    agent: string;
    backend: string | null;
    doc: string;
    taskId: string;
  }> =
    agentGroup && agentGroup.length > 1
      ? agentGroup.slice(1).map((spec) => {
          const entry = agentRegistryMap.get(spec.name)!;
          return {
            agent: spec.name,
            backend: spec.backend ?? entry.backend,
            doc: entry.doc,
            taskId: randomUUID(),
          };
        })
      : [];
  const groupWorkerInitialContent: string | null = agentGroup
    ? buildAgentBootstrap({
        agent: agentGroup[0].name,
        role: "worker",
        docPath: workerEntry!.doc,
        taskPrompt: initialContent,
      })
    : null;
  // For a worker in a group, the bootstrap (which already embeds the user's
  // original prompt) becomes the effective initial content.
  const effectiveInitialContent = groupWorkerInitialContent ?? initialContent;
  if (worktreeRequested && (!projectDaemonHost || !projectWorkspacePath || !projectRepoRoot)) {
    return NextResponse.json(
      { error: "Worktree requires a git-backed bound project" },
      { status: 409 },
    );
  }
  if (taskType === "ai_task") {
    const aiLaunchConfig: JsonObject = {
      ...(launchConfig ?? {}),
      ...(workerBackendType && launchConfig?.backendType === undefined
        ? { backendType: workerBackendType }
        : {}),
      ...(effectiveInitialContent && launchConfig?.initialContent === undefined
        ? { initialContent: effectiveInitialContent }
        : {}),
      ...(requestedSessionId && launchConfig?.resumeSessionId === undefined
        ? { resumeSessionId: requestedSessionId }
        : {}),
      ...(requestedSessionFilePath && launchConfig?.sessionFilePath === undefined
        ? { sessionFilePath: requestedSessionFilePath }
        : {}),
    };
    if (worktreeRequested) {
      try {
        launchConfig = buildTaskWorktreeLaunchConfig({
          launchConfig: aiLaunchConfig,
          worktreeId: requestedId!,
          projectRepoRoot: projectRepoRoot!,
          projectWorkspacePath: projectWorkspacePath!,
          projectWorktreeBranch,
          projectLastCommit,
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid worktree request" },
          { status: 409 },
        );
      }
    } else {
      if (projectWorkspacePath) {
        aiLaunchConfig.cwd = projectWorkspacePath;
      }
      if (projectWorktreeBranch) {
        aiLaunchConfig.worktreeBranch = projectWorktreeBranch;
      }
      launchConfig = Object.keys(aiLaunchConfig).length > 0 ? aiLaunchConfig : null;
    }
  }
  if (taskType === "pty_task" && projectWorkspacePath && launchConfig?.cwd === undefined) {
    launchConfig = { ...(launchConfig ?? {}), cwd: projectWorkspacePath };
  }
  if (taskType === "pty_task") {
    const launchConfigError = validatePtyLaunchConfig(launchConfig);
    if (launchConfigError) {
      return NextResponse.json({ error: launchConfigError }, { status: 400 });
    }
  }
  const hasAgentHostField = hasBodyField(normalizedBody, "agent_host", "agentHost");
  let agentHost = normalizeOptionalString(
    readBodyField(normalizedBody, "agent_host", "agentHost")
  );
  if (projectDaemonHost) {
    if (hasAgentHostField && agentHost && agentHost !== projectDaemonHost) {
      if (!isConductorFireHost(agentHost)) {
        return NextResponse.json(
          { error: `Project daemon ${projectDaemonHost} must be used for this task` },
          { status: 409 },
        );
      }
      // Fire host: keep fire's own agentHost for independent routing.
      // The associated daemon is preserved in task metadata.daemonName.
    } else {
      agentHost = projectDaemonHost;
    }
  }
  if (taskType === "pty_task") {
    const resolvedPtyAgent = resolvePtyAgentHost({
      connectedAgents,
      requestedAgentHost: agentHost,
      requestedBackendType,
      launchConfig,
    });
    if ("error" in resolvedPtyAgent) {
      return NextResponse.json({ error: resolvedPtyAgent.error }, { status: resolvedPtyAgent.status });
    }
    agentHost = resolvedPtyAgent.agentHost;
  } else if (!agentHost) {
    const pickedAgentHost = pickDefaultAgentHost(connectedAgents, workerBackendType);
    if (!pickedAgentHost) {
      const connectedDaemonCount = connectedAgents.filter(
        (agent) => !isConductorFireHost(agent.host),
      ).length;
      return NextResponse.json(
        {
          error:
            workerBackendType && connectedDaemonCount > 0
              ? `No connected daemon supports backend ${workerBackendType}`
              : "No app-task daemon is online",
        },
        { status: 409 },
      );
    }
    agentHost = pickedAgentHost;
  }

  if (taskType === "ai_task" && agentHost && !isConductorFireHost(agentHost)) {
    const selectedAgent = connectedAgents.find((agent) => agent.host === agentHost);
    if (!selectedAgent) {
      return NextResponse.json(
        { error: `App-task daemon ${agentHost} is offline` },
        { status: 409 },
      );
    }
    if (
      !agentGroup &&
      requestedBackendType &&
      !selectedAgent.supportedBackends.includes(requestedBackendType)
    ) {
      return NextResponse.json(
        {
          error: `Daemon ${agentHost} does not support backend ${requestedBackendType}`,
        },
        { status: 409 },
      );
    }
    // Runtime health preflight: the backend may be advertised as supported yet
    // unable to start a turn (CLI missing under the daemon env, not signed in,
    // …). Reject before any task/timeline activity with an actionable message.
    // Fail open when the daemon does not advertise health for this backend.
    const runtimeProblem = evaluateRuntimeHealth({
      agent: selectedAgent,
      backend: workerBackendType ?? requestedBackendType,
    });
    if (runtimeProblem) {
      return NextResponse.json(
        {
          error: "runtime_unavailable",
          backend: runtimeProblem.backend,
          daemon_host: runtimeProblem.daemonHost,
          reason: runtimeProblem.reason,
          message: runtimeProblem.message,
          recovery: runtimeProblem.recovery,
        },
        { status: 503 },
      );
    }
  }

  // Registry defaults are project-owned configuration, but execution still
  // has to match the selected daemon's live capabilities. Reject the whole
  // group before creating its worker when any member names a backend that the
  // daemon does not advertise; otherwise the API would return a task that can
  // never start (and reviewer creation is intentionally fail-soft).
  if (agentGroup && agentHost) {
    const executionAgent = connectedAgents.find((agent) => agent.host === agentHost);
    if (executionAgent) {
      const advertisedBackends = new Set(
        executionAgent.supportedBackends
          .map((backend) => normalizeBackendType(backend))
          .filter((backend): backend is string => Boolean(backend)),
      );
      const requestedAgentBackends = [
        { agent: agentGroup[0].name, backend: workerBackendType },
        ...reviewerSpecs.map((spec) => ({
          agent: spec.agent,
          backend: spec.backend ?? workerBackendType,
        })),
      ];
      const unsupported = requestedAgentBackends.find(
        (entry) => entry.backend && !advertisedBackends.has(entry.backend),
      );
      if (unsupported?.backend) {
        return NextResponse.json(
          {
            error:
              `agent "${unsupported.agent}" requires backend "${unsupported.backend}", ` +
              `but daemon "${agentHost}" does not advertise it`,
          },
          { status: 400 },
        );
      }
    }
  }

  const fireTaskDaemonName =
    isConductorFireHost(agentHost) && projectDaemonHost ? projectDaemonHost : null;

  let metadata = parseJsonObject(normalizedBody.metadata);
  if (taskType === "ai_task" && metadata) {
    if (workerBackendType && metadata.backendType === undefined) {
      metadata.backendType = workerBackendType;
    }
    if (effectiveInitialContent && metadata.initialContent === undefined) {
      metadata.initialContent = effectiveInitialContent;
    }
    if (fireTaskDaemonName && metadata.daemonName === undefined) {
      metadata.daemonName = fireTaskDaemonName;
    }
  } else if (taskType === "ai_task" && !metadata && (workerBackendType || effectiveInitialContent || fireTaskDaemonName)) {
    metadata = {
      ...(workerBackendType ? { backendType: workerBackendType } : {}),
      ...(effectiveInitialContent ? { initialContent: effectiveInitialContent } : {}),
      ...(fireTaskDaemonName ? { daemonName: fireTaskDaemonName } : {}),
    };
  }
  // Stamp the worker's group membership onto its metadata (RFC 0033) so the
  // group query can report its role/agent. The shared groupId is also written
  // to the task's group_id column below.
  if (taskType === "ai_task" && agentGroup && groupId) {
    metadata = {
      ...(metadata ?? {}),
      ...buildGroupMemberMetadata({ groupId, role: "worker", agent: agentGroup[0].name }),
    };
  }
  const title = normalizeOptionalString(normalizedBody.title) ?? "New Task";
  const defaultTaskStatus =
    taskType === "ai_task" && typeof agentHost === "string" && isConductorFireHost(agentHost)
      ? "running"
      : "init";
  const initialMessageContent =
    taskType === "ai_task" &&
    typeof metadata?.initialContent === "string" &&
    metadata.initialContent.trim()
      ? metadata.initialContent.trim()
      : null;

  let ptySession:
    | {
        id: string;
        taskId: string;
        state: string;
        entrypointType: string | null;
        toolPreset: string | null;
        commandJson: string | null;
        cwd: string | null;
        envJson: string | null;
        shell: string | null;
        pid: number | null;
        cols: number | null;
        rows: number | null;
        lastOutputSeq: number;
        startedAt: Date | null;
        closedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | undefined;
  let task;
  try {
    if (taskType === "pty_task") {
      const created = await createPtyTaskRecord({
        requestedId,
        projectId,
        title,
        status: normalizeTaskStatus(normalizedBody.status ?? defaultTaskStatus),
        agentHost,
        requestedBackendType,
        requestedSessionId,
        requestedSessionFilePath,
        launchConfig,
        metadata,
      });
      task = created.task;
      ptySession = created.ptySession;
    } else {
      task = await createAndDispatchAiTask({
        userId: user.id,
        projectId,
        issueId: null,
        title,
        agentHost,
        requestedId,
        requestedBackendType: workerBackendType,
        requestedSessionId,
        requestedSessionFilePath,
        launchConfig,
        metadata,
        initialMessageContent,
        status: normalizeTaskStatus(normalizedBody.status ?? defaultTaskStatus),
        groupId,
      });
    }
  } catch (error) {
    if (agentGroup && isMissingGroupIdColumnError(error)) {
      return NextResponse.json(
        { error: TASK_GROUP_SCHEMA_UNAVAILABLE_MESSAGE },
        { status: 409 },
      );
    }
    if (taskType === "pty_task" && isMissingPtySchemaError(error)) {
      return NextResponse.json({ error: PTY_SCHEMA_UNAVAILABLE_MESSAGE }, { status: 409 });
    }
    throw error;
  }

  if (taskType === "pty_task" && agentHost && ptySession) {
    await dispatchPtyTaskCreation({
      userId: user.id,
      agentHost,
      task: task as { id: string; projectId: string; title: string },
      ptySessionId: ptySession.id,
      launchConfig,
      bindTaskToAgent: (taskId, boundAgentHost, boundUserId) =>
        realtimeHub.bindTaskToAgent(taskId, boundAgentHost, boundUserId),
      sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
      resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
    });
  }

  let grouping:
    | {
        parent_task_id: string;
        grouped: boolean;
        warning?: string;
      }
    | undefined;
  if (parentTaskId) {
    try {
      const taskCardGroupsSnapshot = await mergeRelatedTaskCardGroup(
        user.id,
        parentTaskId,
        task.id,
      );
      realtimeHub.broadcastToUser(user.id, {
        type: "task_card_groups_update",
        payload: {
          user_id: user.id,
          snapshot: taskCardGroupsSnapshot,
          updated_at: new Date().toISOString(),
        },
      });
      grouping = {
        parent_task_id: parentTaskId,
        grouped: true,
      };
    } catch (error) {
      // Grouping is presentation state. Do not turn a successfully created
      // task into a failed POST that invites callers to create a duplicate.
      grouping = {
        parent_task_id: parentTaskId,
        grouped: false,
        warning: "Task was created, but parent task grouping could not be saved",
      };
      console.warn(
        `[tasks.POST] task ${task.id} was created but could not be grouped with ${parentTaskId}`,
        error,
      );
    }
  }

  // Spawn sibling reviewer tasks (RFC 0033). Each reviewer is an ordinary
  // ai_task sharing the group's `groupId` and a bootstrap pointing it at its own
  // agent doc. Each reviewer uses its own backend override, falling back to the
  // worker's backend. A reviewer spawn failure must never fail the worker
  // creation, so each is wrapped fail-soft.
  const reviewerTaskIds: string[] = [];
  // Pair each spawned reviewer with its agent name as we go. Looking the name
  // up afterwards would mean keying on the pre-allocated `spec.taskId` and
  // assuming it equals the id the create returned.
  const reviewerGroupMembers: Array<{ taskId: string; agent: string }> = [];
  if (taskType === "ai_task" && task && groupId && reviewerSpecs.length > 0) {
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
    const sharedWorktreeLaunchConfig = inheritTaskWorktreeLaunchConfig(launchConfig, {
      reuseOnly: true,
    });
    for (const spec of reviewerSpecs) {
      const reviewerBackendType = spec.backend ?? workerBackendType;
      const reviewerInitialContent = buildAgentBootstrap({
        agent: spec.agent,
        role: "reviewer",
        docPath: spec.doc,
      });
      const reviewerLaunchConfig: JsonObject = {
        ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
        ...(sharedWorktreeLaunchConfig ?? {
          ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),
          ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
        }),
        initialContent: reviewerInitialContent,
      };
      try {
        const reviewerTask = await createAndDispatchAiTask({
          userId: user.id,
          projectId,
          issueId: null,
          title: `Reviewer: ${spec.agent}`,
          agentHost,
          requestedId: spec.taskId,
          requestedBackendType: reviewerBackendType,
          launchConfig: reviewerLaunchConfig,
          metadata: {
            ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
            ...(fireTaskDaemonName ? { daemonName: fireTaskDaemonName } : {}),
            initialContent: reviewerInitialContent,
            ...buildGroupMemberMetadata({ groupId, role: "reviewer", agent: spec.agent }),
          },
          initialMessageContent: reviewerInitialContent,
          status: normalizeTaskStatus(defaultTaskStatus),
          groupId,
        });
        reviewerTaskIds.push(reviewerTask.id);
        reviewerGroupMembers.push({ taskId: reviewerTask.id, agent: spec.agent });
      } catch (error) {
        console.error(
          `Failed to spawn reviewer task for agent "${spec.agent}"`,
          error,
        );
      }
    }
  }

  // Collapse the group into a single tab card in the task list. The shared
  // `groupId` above is an execution-time relationship the agents use to find
  // each other; it is invisible to the list view, which renders from the
  // per-user card groups in `user_preferences`. Without this the members show
  // up as unrelated cards. Mirrors the restart successor path.
  let taskCardGroupsSnapshot:
    | Awaited<ReturnType<typeof mergeRelatedTaskCardGroup>>
    | null = null;
  if (reviewerGroupMembers.length > 0 && task) {
    // Name each tab after its agent, so the strip reads
    // "feature-dev | code-reviewer" instead of the default ordinals "1 | 2".
    const workerAgentName = agentGroup?.[0]?.name ?? null;
    for (const { taskId: reviewerTaskId, agent } of reviewerGroupMembers) {
      try {
        // Serial on purpose: each merge is a read-modify-write of one
        // preference row, so concurrent merges would clobber each other and
        // only the last reviewer would survive in the card.
        taskCardGroupsSnapshot = await mergeRelatedTaskCardGroup(
          user.id,
          task.id,
          reviewerTaskId,
          { source: workerAgentName, related: agent },
        );
      } catch (error) {
        // Grouping is presentation state. The tasks are already created and
        // dispatched; failing the POST here would invite a duplicate group.
        console.warn(
          `[tasks.POST] reviewer ${reviewerTaskId} was created but could not be grouped with ${task.id}`,
          error,
        );
      }
    }
    if (taskCardGroupsSnapshot) {
      realtimeHub.broadcastToUser(user.id, {
        type: "task_card_groups_update",
        payload: {
          user_id: user.id,
          snapshot: taskCardGroupsSnapshot,
          updated_at: new Date().toISOString(),
        },
      });
    }
  }

  const taskResponseRecord = ptySession ? { ...task, ptySession } : task;

  const taskResponse = serializeTaskResponse(taskResponseRecord);
  return NextResponse.json({
    ...taskResponse,
    ...(grouping ? { grouping } : {}),
    ...(reviewerTaskIds.length > 0 ? { reviewer_task_ids: reviewerTaskIds } : {}),
    ...(taskCardGroupsSnapshot
      ? { task_card_groups_snapshot: taskCardGroupsSnapshot }
      : {}),
  });
}
