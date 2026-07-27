import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  hasConfiguredPublicBackendUrl,
  resolvePublicBackendUrl,
} from "@/lib/auth/config-utils";
import { db } from "@/lib/db";
import {
  deliverAgentOutboxForHost,
  deliverAgentOutboxRow,
  isMissingAgentOutboxTableError,
} from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import {
  buildHandoffNoticeContent,
  buildResumeHandoffUrl,
  createInternalResumeHandoffShare,
  HANDOFF_NOTICE_METADATA,
} from "@/lib/tasks/shared-task";
import {
  applyLegacyTaskShape,
  isMissingAnyNewSchemaError,
  isMissingIssueIdSchemaError,
  isMissingPtySchemaError,
  legacyTaskSelect,
  taskSelectWithoutIssueId,
  withPtySchemaFallback,
} from "@/lib/tasks/pty-compat";
import {
  normalizeOptionalString,
  parseJsonObject,
  serializeJsonObject,
  normalizeTaskStatus,
} from "@/lib/tasks/task-config";
import {
  acquireTaskWorktreeMutationLock,
  inheritTaskWorktreeLaunchConfig,
} from "@/lib/tasks/worktree";
import { normalizeBackendType } from "@/lib/tasks/pty-runtime";
import {
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import {
  canCreateSuccessorTask,
  canInplaceRestart,
  normalizeRestartStrategy,
  RESTARTABLE_SOURCE_STATUSES,
  STOPPED_TASK_STATUSES,
} from "@/lib/tasks/restart";
import {
  buildKilledRevokePatch,
  RECLAIMABLE_KILLED_REASON,
} from "@/lib/tasks/killed-reason";
import { isTaskReclaimEnabled } from "@/lib/tasks/reclaim-config";

const appendBackendSuffix = (title: string, backend: string): string => `${title} [${backend}]`;
const REFRESH_SESSION_ACK_TIMEOUT_MS = 60_000;
// RFC 0029: 60s mirrors the worst-case fire ↔ daemon round-trip when the
// SDK worker is mid-provider-call. Long enough that a brief hang doesn't
// false-negative; short enough that a truly dead fire doesn't park the
// restart UI behind it.
const RECLAIM_TASK_ACK_TIMEOUT_MS = 60_000;

const normalizeRestartMode = (value: unknown): "refresh_session" | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "refresh_session" || normalized === "refreshsession") {
    return "refresh_session";
  }
  return null;
};

const uniqueHosts = (hosts: Array<string | null>): string[] =>
  hosts.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

const findRestartSourceTask = async (userId: string, taskId: string) =>
  withPtySchemaFallback(
    "tasks.taskId.restart.findSource",
    () =>
      db.task.findFirst({
        where: { id: taskId, project: { userId } },
      }),
    () =>
      withPtySchemaFallback(
        "tasks.taskId.restart.findSource.withoutIssueId",
        async () => {
          const task = await db.task.findFirst({
            where: { id: taskId, project: { userId } },
            select: taskSelectWithoutIssueId,
          });
          return task ? { ...task, issueId: null, achievedAt: null } : null;
        },
        async () => {
          const task = await db.task.findFirst({
            where: { id: taskId, project: { userId } },
            select: legacyTaskSelect,
          });
          return task ? { ...applyLegacyTaskShape(task), issueId: null } : null;
        },
      ),
  );

const updateTaskWithRestartFallback = async (
  taskStore: any,
  args: { where: { id: string }; data: Record<string, unknown> },
  issueId: string | null,
) => {
  try {
    return await taskStore.update(args);
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) {
      throw error;
    }

    try {
      const task = await taskStore.update({
        ...args,
        select: taskSelectWithoutIssueId,
      });
      return { ...task, issueId };
    } catch (fallbackError) {
      if (!isMissingPtySchemaError(fallbackError)) {
        throw fallbackError;
      }

      return applyLegacyTaskShape(
        await taskStore.update({
          ...args,
          select: legacyTaskSelect,
        }),
      );
    }
  }
};

const createSuccessorTaskWithRestartFallback = async (
  taskStore: any,
  args: { data: Record<string, unknown> },
) => {
  try {
    return await taskStore.create(args);
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) {
      throw error;
    }

    if (isMissingIssueIdSchemaError(error)) {
      const { issueId: _issueId, ...dataWithoutIssueId } = args.data;
      try {
        const task = await taskStore.create({
          data: dataWithoutIssueId,
          select: taskSelectWithoutIssueId,
        });
        return { ...task, issueId: null };
      } catch (fallbackError) {
        if (!isMissingPtySchemaError(fallbackError)) {
          throw fallbackError;
        }
      }
    }

    const {
      issueId: _issueId,
      taskType: _taskType,
      launchConfig: _launchConfig,
      ...legacyData
    } = args.data;
    return applyLegacyTaskShape(
      await taskStore.create({
        data: legacyData,
        select: legacyTaskSelect,
      }),
    );
  }
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const [{ taskId }, body] = await Promise.all([
    params,
    request.json().catch(() => null),
  ]);
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const sourceTask = await findRestartSourceTask(user.id, taskId);
  if (!sourceTask) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const project = await db.project.findFirst({
    where: { id: sourceTask.projectId, userId: user.id },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const isDefaultProject = defaultProject?.projectId === project.id;
  const projectDaemonHost = normalizeOptionalString((project as { daemonHost?: string | null }).daemonHost);
  const projectWorkspacePath = normalizeOptionalString((project as { workspacePath?: string | null }).workspacePath);
  const projectWorktreeBranch = normalizeOptionalString((project as { worktreeBranch?: string | null }).worktreeBranch);
  if (
    (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
    (projectDaemonHost && !projectWorkspacePath) ||
    (!projectDaemonHost && projectWorkspacePath)
  ) {
    return NextResponse.json({ error: "Project binding incomplete" }, { status: 409 });
  }
  if ((sourceTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "Only ai_task supports restart" }, { status: 409 });
  }

  const sourceBackend = normalizeBackendType(sourceTask.backendType);
  if (!sourceBackend) {
    return NextResponse.json({ error: "Task missing backend binding" }, { status: 409 });
  }
  const sourceLaunchConfig = parseJsonObject(sourceTask.launchConfig);
  const inheritedWorktreeLaunchConfig = inheritTaskWorktreeLaunchConfig(sourceLaunchConfig);

  const sourceSessionId = normalizeOptionalString(sourceTask.sessionId);
  if (!sourceSessionId) {
    return NextResponse.json({ error: "Task missing session binding" }, { status: 409 });
  }

  const sourceStatus = normalizeTaskStatus(sourceTask.status);
  if (!RESTARTABLE_SOURCE_STATUSES.has(sourceStatus as any)) {
    return NextResponse.json({ error: "Only running or stopped ai_task can restart" }, { status: 409 });
  }

  const sourceAgentHost = normalizeOptionalString(sourceTask.agentHost);
  if (!sourceAgentHost) {
    return NextResponse.json({ error: "Task missing source daemon binding" }, { status: 409 });
  }

  const connectedAgents = realtimeHub.getAgentsForUser(user.id);
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  const sourceTaskMetadata = parseJsonObject(sourceTask.metadata);
  const sourceMetadataDaemonHost = normalizeOptionalString(sourceTaskMetadata?.daemonName);
  const sourceExecutionHost = normalizeOptionalString(sourceTask.executionHost);
  const boundTaskHost = normalizeOptionalString(realtimeHub.getTaskAgentHost(sourceTask.id));
  const boundFireHost =
    boundTaskHost && isConductorFireHost(boundTaskHost)
      ? boundTaskHost
      : null;
  const sourceMetadataDaemonCandidate =
    sourceMetadataDaemonHost && !isConductorFireHost(sourceMetadataDaemonHost)
      ? sourceMetadataDaemonHost
      : null;
  const sourceExecutionFireHost =
    sourceExecutionHost && isConductorFireHost(sourceExecutionHost)
      ? sourceExecutionHost
      : null;
  const sourceAgentFireHost =
    sourceAgentHost && isConductorFireHost(sourceAgentHost)
      ? sourceAgentHost
      : null;
  const sourceExecutionDaemonHost =
    sourceExecutionHost && !isConductorFireHost(sourceExecutionHost)
      ? sourceExecutionHost
      : null;
  const projectDaemonCandidate =
    projectDaemonHost && !isConductorFireHost(projectDaemonHost)
      ? projectDaemonHost
      : null;
  const manualFireDaemonHostCandidates = new Set<string>();
  for (const candidate of [
    sourceMetadataDaemonCandidate,
    sourceExecutionDaemonHost,
    projectDaemonCandidate,
  ]) {
    if (candidate) {
      manualFireDaemonHostCandidates.add(candidate);
    }
  }
  const manualFireDaemonHosts = Array.from(manualFireDaemonHostCandidates);
  const refreshSessionFireHostCandidates = uniqueHosts([
    boundFireHost && (
      sourceExecutionFireHost
        ? boundFireHost === sourceExecutionFireHost
        : sourceAgentFireHost
          ? boundFireHost === sourceAgentFireHost
          : true
    )
      ? boundFireHost
      : null,
    sourceExecutionFireHost,
    sourceAgentFireHost,
  ]);
  const preferredManualFireDaemonHost = manualFireDaemonHosts[0] ?? null;

  const hasExplicitBackendTarget =
    Object.prototype.hasOwnProperty.call(normalizedBody, "backend_type") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "backendType");
  const requestedBackend =
    normalizeBackendType(normalizedBody.backend_type ?? normalizedBody.backendType);
  if (hasExplicitBackendTarget && !requestedBackend) {
    return NextResponse.json({ error: "invalid backend_type" }, { status: 400 });
  }
  const targetBackend = requestedBackend ?? sourceBackend;
  const requestedRestartMode = normalizeRestartMode(
    normalizedBody.restart_mode ?? normalizedBody.restartMode,
  );
  const hasExplicitRestartMode =
    Object.prototype.hasOwnProperty.call(normalizedBody, "restart_mode") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "restartMode");
  if (hasExplicitRestartMode && !requestedRestartMode) {
    return NextResponse.json({ error: "invalid restart_mode" }, { status: 400 });
  }
  const requestedStrategy = normalizeRestartStrategy(normalizedBody.strategy ?? normalizedBody.restart_strategy);
  const hasExplicitStrategy =
    Object.prototype.hasOwnProperty.call(normalizedBody, "strategy") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "restart_strategy");
  if (hasExplicitStrategy && !requestedStrategy) {
    return NextResponse.json({ error: "invalid strategy" }, { status: 400 });
  }

  // Explicit daemon override. Lets the caller run the restart on a specific
  // online daemon instead of the auto-resolved one — used when the original
  // daemon is offline (e.g. un-packing an achieved task, or "open new session")
  // and the user picks another connected daemon. Only meaningful for the
  // new_task / successor path; refresh_session always reuses the live host.
  const requestedAgentHost = normalizeOptionalString(
    normalizedBody.agent_host ??
      normalizedBody.agentHost ??
      normalizedBody.target_daemon_host ??
      normalizedBody.targetDaemonHost,
  );

  // Fire tasks can create new tasks from running state; in-place restart
  // normally requires a stopped row. An achieved task is also safe to resume:
  // packing already tore down its runtime, even if a late pre-fix daemon event
  // left the persisted status incorrectly reading `running`.
  const canDoInplaceRestart =
    Boolean(sourceTask.achievedAt) || STOPPED_TASK_STATUSES.has(sourceStatus as any);
  const isExplicitInplaceRequest = requestedStrategy === "inplace" ||
    (!requestedStrategy && canDoInplaceRestart && targetBackend === sourceBackend);
  if (isManualFireTask && isExplicitInplaceRequest && !canDoInplaceRestart) {
    return NextResponse.json(
      { error: "manual fire task can only in-place restart after it has stopped" },
      { status: 409 },
    );
  }

  const isRefreshSessionRequest = requestedRestartMode === "refresh_session";
  // An explicit override wins over auto-resolution (except for refresh_session,
  // which must reuse the live fire host).
  const useAgentHostOverride = Boolean(requestedAgentHost) && !isRefreshSessionRequest;
  let restartAgentHost = useAgentHostOverride
    ? requestedAgentHost
    : isRefreshSessionRequest
    ? (
      refreshSessionFireHostCandidates.find((host) =>
        connectedAgents.some((agent) => agent.host === host),
      ) ?? refreshSessionFireHostCandidates[0]
    )
    : isManualFireTask
      ? (
        manualFireDaemonHosts.find((host) =>
          connectedAgents.some((agent) => agent.host === host),
        ) ?? preferredManualFireDaemonHost
      )
      : sourceAgentHost;
  const shouldUseProjectDaemonBinding = Boolean(
    projectDaemonHost &&
    !useAgentHostOverride &&
    !isRefreshSessionRequest &&
    !(requestedRestartMode === "refresh_session" && isManualFireTask),
  );
  if (shouldUseProjectDaemonBinding && projectDaemonHost) {
    if (
      sourceAgentHost &&
      !isConductorFireHost(sourceAgentHost) &&
      sourceAgentHost !== projectDaemonHost
    ) {
      return NextResponse.json(
        { error: `Task daemon ${sourceAgentHost} does not match project binding ${projectDaemonHost}` },
        { status: 409 },
      );
    }
    restartAgentHost = projectDaemonHost;
  }
  if (!restartAgentHost) {
    return NextResponse.json(
      {
        error: isRefreshSessionRequest
          ? "Task missing active fire session host"
          : isManualFireTask
          ? "Task missing original daemon binding"
          : `No compatible daemon online for backend ${targetBackend}`,
      },
      { status: 409 },
    );
  }
  const restartAgent = connectedAgents.find((agent) => agent.host === restartAgentHost) ?? null;
  if (!restartAgent) {
    return NextResponse.json(
      {
        error: useAgentHostOverride
          ? `Selected daemon ${restartAgentHost} is offline`
          : isRefreshSessionRequest
          ? `Fire host ${restartAgentHost} is offline`
          : shouldUseProjectDaemonBinding
          ? `Project daemon ${restartAgentHost} is offline`
          : isManualFireTask
            ? `Original daemon ${restartAgentHost} is offline`
            : `Source daemon ${sourceAgentHost} is offline`,
      },
      { status: 409 },
    );
  }
  const supportedBackends = Array.isArray(restartAgent.supportedBackends) ? restartAgent.supportedBackends : [];
  const restartAgentCapabilities = Array.isArray(restartAgent.capabilities) ? restartAgent.capabilities : [];
  if (!supportedBackends.includes(targetBackend)) {
    return NextResponse.json(
      { error: `Daemon ${restartAgentHost} does not support backend ${targetBackend}` },
      { status: 409 },
    );
  }

  const requestId = randomUUID();
  const now = new Date();

  if (requestedRestartMode === "refresh_session") {
    if (sourceStatus !== "running") {
      return NextResponse.json(
        { error: "Session refresh requires a running ai_task" },
        { status: 409 },
      );
    }
    if (hasExplicitStrategy) {
      return NextResponse.json(
        { error: "restart_mode refresh_session cannot be combined with strategy" },
        { status: 400 },
      );
    }
    if (targetBackend !== sourceBackend) {
      return NextResponse.json(
        { error: "Session refresh must reuse the current backend" },
        { status: 409 },
      );
    }
    if (!restartAgentCapabilities.includes("refresh_session_inplace")) {
      return NextResponse.json(
        { error: `Daemon ${restartAgentHost} does not support AI session refresh` },
        { status: 409 },
      );
    }

    await db.$transaction(async (tx) => {
      if (inheritedWorktreeLaunchConfig) {
        await acquireTaskWorktreeMutationLock(
          tx as any,
          sourceTask.id,
        );
      }

      await tx.agentOutbox.create({
        data: {
          userId: user.id,
          agentHost: restartAgentHost,
          taskId: sourceTask.id,
          eventType: "refresh_session",
          requestId,
          payloadJson: JSON.stringify({
            type: "refresh_session",
            payload: {
              task_id: sourceTask.id,
              project_id: sourceTask.projectId,
              reason: "refresh_session_inplace",
              session_id: sourceSessionId,
              session_file_path: sourceTask.sessionFilePath ?? undefined,
              request_id: requestId,
            },
          }),
          status: "pending",
          attemptCount: 0,
          nextRetryAt: null,
        },
      });
    });

    const restartAckPromise = realtimeHub.waitForAgentCommandAck(
      sourceTask.id,
      requestId,
      REFRESH_SESSION_ACK_TIMEOUT_MS,
      {
        expectedHosts: [restartAgentHost],
        eventType: "refresh_session",
      },
    );
    await deliverAgentOutboxForHost({
      userId: user.id,
      agentHost: restartAgentHost,
      sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
      resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
    }).catch(() => {});
    const restartAcked = await restartAckPromise;

    if (restartAcked !== true) {
      if (restartAcked === null) {
        await db.agentOutbox.updateMany({
          where: {
            userId: user.id,
            requestId,
            status: { in: ["pending", "sent"] },
          },
          data: {
            status: "failed",
            nextRetryAt: null,
            lastError: "ack_timeout:refresh_session",
          },
        });
      }
      return NextResponse.json(
        {
          error: restartAcked === false
            ? "AI session refresh was rejected by daemon"
            : "Timed out waiting for AI session refresh",
        },
        { status: restartAcked === false ? 502 : 504 },
      );
    }

    return NextResponse.json({
      mode: "inplace_restart",
      source_task_id: sourceTask.id,
      task: serializeTaskResponse(sourceTask),
    });
  }

  const canResumeInPlace =
    (Boolean(sourceTask.achievedAt) && targetBackend === sourceBackend) ||
    canInplaceRestart(sourceStatus, sourceBackend, targetBackend);
  const strategy =
    requestedStrategy ??
    (canResumeInPlace ? "inplace" : "new_task");
  const isBackendSwitch = targetBackend !== sourceBackend;
  const isInplaceRestart = strategy === "inplace";

  if (isInplaceRestart && !canResumeInPlace) {
    return NextResponse.json(
      { error: "In-place restart requires a stopped task on the current backend" },
      { status: 409 },
    );
  }

  if (!isInplaceRestart && !canCreateSuccessorTask(sourceBackend, targetBackend)) {
    return NextResponse.json(
      { error: `Backend switch ${sourceBackend} -> ${targetBackend} is not supported` },
      { status: 409 },
    );
  }

  // RFC 0029: Reclaim attempt. When the source task was defensively killed
  // because the daemon went silent (not because the user pressed Stop) and
  // there is still a fire bound to the original host, try a non-spawning
  // reclaim before falling through to the existing spawn path. The reclaim
  // is intentionally tightly gated:
  //   * feature-flag must be on (CONDUCTOR_TASK_RECLAIM_ENABLED);
  //   * killed_reason must equal `daemon_disconnected`;
  //   * restart must be in-place on the same backend (cross-backend goes
  //     through the new_task forking path which has no live fire to reuse);
  //   * the previously-bound agent host must still be online — otherwise
  //     we'd be waiting 60s for an ack that cannot come.
  // Any failure (ack=false, timeout, schema fallback hit) cleans up the
  // outbox row and falls through to the original `restart_task` flow, so
  // the user experience never regresses past today's behavior.
  const reclaimEnabled = isTaskReclaimEnabled();
  const sourceKilledReason =
    typeof (sourceTask as { killedReason?: unknown }).killedReason === "string"
      ? (sourceTask as { killedReason?: string }).killedReason
      : null;
  const boundReclaimHost = normalizeOptionalString(
    realtimeHub.getTaskAgentHost(sourceTask.id),
  );
  const shouldAttemptReclaim =
    reclaimEnabled &&
    isInplaceRestart &&
    !isBackendSwitch &&
    sourceStatus === "killed" &&
    sourceKilledReason === RECLAIMABLE_KILLED_REASON &&
    Boolean(boundReclaimHost) &&
    boundReclaimHost === restartAgentHost;

  if (shouldAttemptReclaim && boundReclaimHost) {
    const reclaimRequestId = randomUUID();
    let reclaimOutboxCreated = false;
    try {
      try {
        await db.agentOutbox.create({
          data: {
            userId: user.id,
            agentHost: boundReclaimHost,
            taskId: sourceTask.id,
            eventType: "reclaim_task",
            requestId: reclaimRequestId,
            payloadJson: JSON.stringify({
              type: "reclaim_task",
              payload: {
                task_id: sourceTask.id,
                project_id: sourceTask.projectId,
                expected_session_id: sourceSessionId,
                expected_backend_type: sourceBackend,
                ack_timeout_ms: RECLAIM_TASK_ACK_TIMEOUT_MS,
                request_id: reclaimRequestId,
              },
            }),
            status: "pending",
            attemptCount: 0,
            nextRetryAt: null,
          },
        });
        reclaimOutboxCreated = true;
      } catch (outboxError) {
        // The outbox table is gated by an older migration; if it's missing
        // we cannot persist a reclaim request, so silently fall back to the
        // legacy spawn restart below. Anything else propagates.
        if (!isMissingAgentOutboxTableError(outboxError)) {
          throw outboxError;
        }
      }

      if (reclaimOutboxCreated) {
        const reclaimAckPromise = realtimeHub.waitForAgentCommandAck(
          sourceTask.id,
          reclaimRequestId,
          RECLAIM_TASK_ACK_TIMEOUT_MS,
          {
            expectedHosts: [boundReclaimHost],
            eventType: "reclaim_task",
          },
        );
        deliverAgentOutboxForHost({
          userId: user.id,
          agentHost: boundReclaimHost,
          sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
            realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
          resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
        }).catch(() => {});

        const reclaimAcked = await reclaimAckPromise;
        if (reclaimAcked === true) {
          // Fire is alive and reclaimed; revoke the defensive killed flags
          // so the next observer sees the task as `running` without ever
          // having spawned a new fire. We intentionally do NOT bump
          // executionHost — the binding never moved.
          const revokePatch = buildKilledRevokePatch();
          const reclaimedTask = await updateTaskWithRestartFallback(
            db.task,
            {
              where: { id: sourceTask.id },
              data: {
                ...revokePatch,
                updatedAt: now,
              },
            },
            sourceTask.issueId ?? null,
          );
          realtimeHub.bindTaskToAgent(sourceTask.id, boundReclaimHost);
          return NextResponse.json({
            mode: "reclaim",
            source_task_id: sourceTask.id,
            reclaim_host: boundReclaimHost,
            task: serializeTaskResponse(reclaimedTask),
          });
        }

        // ack === false (explicit failure) or null (timeout). Tag the
        // outbox row failed so it doesn't ride the normal retry loop and
        // resurrect later, then fall through to spawn.
        await db.agentOutbox
          .updateMany({
            where: {
              userId: user.id,
              requestId: reclaimRequestId,
              status: { in: ["pending", "sent"] },
            },
            data: {
              status: "failed",
              nextRetryAt: null,
              lastError:
                reclaimAcked === false
                  ? "reclaim_rejected"
                  : "reclaim_ack_timeout",
            },
          })
          .catch(() => {});
      }
    } catch (reclaimError) {
      console.warn(
        `[restart] reclaim attempt failed for ${sourceTask.id}, falling back to spawn restart: ${
          reclaimError instanceof Error ? reclaimError.message : String(reclaimError)
        }`,
      );
      // Best-effort: cancel the in-memory waiter so we don't leak it.
      realtimeHub.cancelAgentCommandAck?.(sourceTask.id, reclaimRequestId);
    }
  }

  if (isInplaceRestart) {
    const updatedTask = await db.$transaction(async (tx) => {
      if (inheritedWorktreeLaunchConfig) {
        await acquireTaskWorktreeMutationLock(
          tx as any,
          sourceTask.id,
        );
      }

      await tx.agentOutbox.create({
        data: {
          userId: user.id,
          agentHost: restartAgentHost,
          taskId: sourceTask.id,
          eventType: "restart_task",
          requestId,
          payloadJson: JSON.stringify({
            type: "restart_task",
            payload: {
              mode: "resume_inplace",
              source_task_id: sourceTask.id,
              target_task_id: sourceTask.id,
              project_id: sourceTask.projectId,
              title: sourceTask.title,
              source_backend_type: sourceBackend,
              source_session_id: sourceSessionId,
              source_session_file_path: sourceTask.sessionFilePath ?? undefined,
              target_backend_type: targetBackend,
              target_launch_config: inheritedWorktreeLaunchConfig ?? undefined,
              request_id: requestId,
            },
          }),
          status: "pending",
          attemptCount: 0,
          nextRetryAt: null,
        },
      });

      return updateTaskWithRestartFallback(
        tx.task,
        {
          where: { id: sourceTask.id },
          data: {
            // Packing may have converted a live task to killed/user_stopped.
            // Recovering it must clear that tombstone as well as changing the
            // visible status, otherwise the restored row is self-contradictory.
            ...(sourceTask.achievedAt
              ? buildKilledRevokePatch()
              : { status: "running" }),
            executionHost: restartAgentHost,
            agentHost: restartAgentHost,
            // A resumed task is no longer "achieved" (packed): reviving it in
            // place un-packs it. Only touch the column when the source was
            // actually achieved — a row can't be achieved unless the column
            // exists, so normal restarts stay valid on pre-migration schemas.
            ...(sourceTask.achievedAt ? { achievedAt: null } : {}),
            updatedAt: now,
          },
        },
        sourceTask.issueId ?? null,
      );
    });

    // If this in-place restart un-packed an achieved task, tell the app clients
    // so it returns to the active list.
    if (sourceTask.achievedAt) {
      realtimeHub.broadcast(user.id, sourceTask.projectId, {
        type: "task_restored",
        payload: { task_id: sourceTask.id, project_id: sourceTask.projectId },
      });
    }

    realtimeHub.bindTaskToAgent(sourceTask.id, restartAgentHost);
    await deliverAgentOutboxForHost({
      userId: user.id,
      agentHost: restartAgentHost,
      sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
      resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
    }).catch(() => {});

    return NextResponse.json({
      mode: "inplace_restart",
      source_task_id: sourceTask.id,
      task: serializeTaskResponse(updatedTask),
    });
  }

  const successorTaskId = randomUUID();
  const successorTitle = appendBackendSuffix(sourceTask.title, targetBackend);
  const sourceMetadata = parseJsonObject(sourceTask.metadata) ?? {};
  const successorMetadata = {
    continuedFromTaskId: sourceTask.id,
    restartSourceBackendType: sourceBackend,
    restartStrategy: "new_task",
  };
  // Workspace continuity contract for "new task from this":
  //   1. If the source task is on a git worktree, inherit the full worktree
  //      launch_config so the daemon lands the successor in the SAME
  //      `.conductor/worktrees/<branch>` folder (identity is keyed off
  //      `worktreeBranch`, see worktree.ts::sanitizeWorktreeFolderName and
  //      daemon.js::buildTaskWorktreeRoot).
  //   2. Otherwise preserve the source task's own `cwd` rather than silently
  //      resetting to `projectWorkspacePath`. A source task whose
  //      launch_config.cwd points at a subdirectory (or a different workspace
  //      entirely) must not have its successor jump back to the project root
  //      — that breaks the user's expectation that "continue this work" means
  //      "continue in the same place".
  const sourceCwd = normalizeOptionalString(sourceLaunchConfig?.cwd);
  const successorCwd = sourceCwd ?? projectWorkspacePath ?? null;
  const successorLaunchConfig = inheritedWorktreeLaunchConfig ?? {
    ...(successorCwd ? { cwd: successorCwd } : {}),
    ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
  };

  // Generate a short-lived handoff share so the successor backend can pull the
  // prior conversation as plain text — this replaces brittle JSONL session
  // translation (ai-bridge) with a semantic resume. Fail fast: without this
  // URL the daemon would only be able to produce a doomed-to-fail successor,
  // so we surface the real cause to the caller instead of writing a half-baked
  // outbox event and a confusing "resume_context_url missing" failure later.
  //
  // In production, the public backend URL MUST come from an env var — falling
  // back to `request.nextUrl.origin` can yield an internal host (e.g.
  // `http://127.0.0.1:3000` behind a reverse proxy) that a daemon on a
  // different machine cannot reach. Refuse rather than ship a broken URL.
  if (process.env.NODE_ENV === "production" && !hasConfiguredPublicBackendUrl()) {
    return NextResponse.json(
      {
        error:
          "Server is missing PUBLIC_BACKEND_URL (or NEXT_PUBLIC_URL / BACKEND_URL). A publicly-reachable base URL is required to mint the resume-handoff share link used by cross-backend restart.",
      },
      { status: 500 },
    );
  }

  let resumeContextUrl: string;
  try {
    const { token } = await createInternalResumeHandoffShare({
      taskId: sourceTask.id,
      ownerUserId: user.id,
    });
    const baseUrl = resolvePublicBackendUrl(request.nextUrl.origin);
    resumeContextUrl = buildResumeHandoffUrl(baseUrl, token);
  } catch (error) {
    console.error("[restart] failed to mint resume-handoff share", error);
    return NextResponse.json(
      {
        error:
          "Failed to prepare resume context for the successor backend. Please retry; if this persists, check server logs for the share-link error.",
      },
      { status: 500 },
    );
  }

  const { task: createdTask, restartOutboxRow } = await db.$transaction(async (tx) => {
    if (inheritedWorktreeLaunchConfig) {
      await acquireTaskWorktreeMutationLock(
        tx as any,
        sourceTask.id,
      );
    }

    const task = await createSuccessorTaskWithRestartFallback(tx.task, {
      data: {
        id: successorTaskId,
        projectId: sourceTask.projectId,
        issueId: sourceTask.issueId ?? null,
        title: successorTitle,
        taskType: "ai_task",
        status: "init",
        agentHost: restartAgentHost,
        executionHost: null,
        backendType: targetBackend,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: serializeJsonObject(
          Object.keys(successorLaunchConfig).length > 0 ? successorLaunchConfig : null,
        ),
        metadata: JSON.stringify(successorMetadata),
      },
    });

    // Seed the successor task's chat with a short human-friendly notice so
    // the user does not stare at an empty conversation while the new AI
    // fetches the transcript URL. Failure here is non-fatal: the AI will
    // still start correctly; the user just won't see the notice bubble.
    const [, , restartOutboxRow] = await Promise.all([
      tx.message
        .create({
          data: {
            taskId: successorTaskId,
            role: "sdk",
            content: buildHandoffNoticeContent({
              sourceTitle: sourceTask.title,
              sourceBackend,
              targetBackend,
            }),
            metadata: JSON.stringify(HANDOFF_NOTICE_METADATA),
          },
        })
        .catch((error: unknown) => {
          console.error("[restart] failed to insert handoff notice message", error);
        }),
      tx.task.update({
        where: { id: sourceTask.id },
        data: {
          metadata: JSON.stringify({
            ...sourceMetadata,
            successorTaskId,
            restartRequestId: requestId,
            ...(isBackendSwitch ? { backendSwitchRequestId: requestId } : {}),
          }),
        },
        select: { id: true },
      }),
      tx.agentOutbox.create({
        data: {
          userId: user.id,
          agentHost: restartAgentHost,
          taskId: successorTaskId,
          eventType: "restart_task",
          requestId,
          payloadJson: JSON.stringify({
            type: "restart_task",
            payload: {
              mode: "fork_to_new_task",
              source_task_id: sourceTask.id,
              target_task_id: successorTaskId,
              project_id: sourceTask.projectId,
              title: successorTitle,
              source_backend_type: sourceBackend,
              source_session_id: sourceSessionId,
              source_session_file_path: sourceTask.sessionFilePath ?? undefined,
              target_backend_type: targetBackend,
              target_launch_config:
                Object.keys(successorLaunchConfig).length > 0
                  ? successorLaunchConfig
                  : undefined,
              // Plain-text transcript URL the successor backend should fetch as
              // its resume context (replaces JSONL session translation).
              resume_context_url: resumeContextUrl,
              request_id: requestId,
            },
          }),
          status: "pending",
          attemptCount: 0,
          nextRetryAt: null,
        },
      }),
    ]);

    return { task, restartOutboxRow };
  });

  realtimeHub.bindTaskToAgent(successorTaskId, restartAgentHost);
  await deliverAgentOutboxRow(restartOutboxRow, {
    userId: user.id,
    agentHost: restartAgentHost,
    sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
      realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
    resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
  }).catch(() => {});

  return NextResponse.json({
    mode: isBackendSwitch ? "backend_switch_new_task" : "successor_new_task",
    source_task_id: sourceTask.id,
    task: serializeTaskResponse(createdTask),
  });
}
