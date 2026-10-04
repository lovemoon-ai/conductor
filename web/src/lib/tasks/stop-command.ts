import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { resolveFireTaskRouting } from "@/lib/tasks/fire-routing";
import { normalizeOptionalString, normalizeTaskStatus } from "@/lib/tasks/task-config";

export const isStopCommand = (content: unknown): boolean =>
  typeof content === "string" && /^\/stop$/i.test(content.trim());

/**
 * `/stop`: fire only reads the next message once its current turn ends, so the
 * server interrupts that turn right away. It targets the runtime's reply when
 * known (older fires drop target-less interrupts); no target = whatever turn runs.
 * Returns whether a fire owner was reached.
 */
export async function interruptRunningTurn(userId: string, taskId: string): Promise<boolean> {
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId } },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      project: { select: { daemonHost: true } },
      runtimeState: { select: { replyInProgress: true, replyTo: true } },
    },
  });
  if (!task || (task.taskType ?? "ai_task") !== "ai_task" || normalizeTaskStatus(task.status) !== "running") {
    return false;
  }
  const routing = resolveFireTaskRouting(task, normalizeOptionalString(realtimeHub.getTaskAgentHost(taskId)));
  const targetReplyTo = task.runtimeState?.replyInProgress ? normalizeOptionalString(task.runtimeState.replyTo) : null;
  const envelope = {
    type: "interrupt_turn",
    payload: {
      task_id: taskId,
      project_id: task.projectId,
      request_id: randomUUID(),
      reason: "user_interrupt",
      ...(targetReplyTo ? { target_reply_to: targetReplyTo } : {}),
    },
  };
  return routing.fireOwnerCandidates.filter((host) => realtimeHub.sendToAgentHost(userId, host, envelope)).length > 0;
}
