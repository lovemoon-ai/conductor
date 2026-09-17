import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { resolveFireTaskRouting } from "@/lib/tasks/fire-routing";
import { normalizeTaskStatus, normalizeOptionalString } from "@/lib/tasks/task-config";

/**
 * Ask the task's fire to re-report its runtime status (current tool + elapsed
 * time while a turn runs). Fire answers over the normal `task_runtime_status`
 * broadcast, so this is fire-and-forget: the app calls it on page load and when
 * its reply-in-progress watchdog sees no frames.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) {
    return userResult;
  }
  const user = userResult;
  const { taskId } = await params;

  const task = await db.task.findFirst({
    where: {
      id: taskId,
      project: { userId: user.id },
    },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      project: {
        select: {
          daemonHost: true,
        },
      },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((task.taskType ?? "ai_task") !== "ai_task" || normalizeTaskStatus(task.status) !== "running") {
    return NextResponse.json(
      { error: "task_not_running", message: "Only running ai_task reports runtime status" },
      { status: 409 },
    );
  }

  const boundAgentHost = normalizeOptionalString(realtimeHub.getTaskAgentHost(taskId));
  const routing = resolveFireTaskRouting(task, boundAgentHost);
  const envelope = {
    type: "report_runtime_status",
    payload: {
      task_id: taskId,
      project_id: task.projectId,
    },
  };
  const deliveredHosts = routing.fireOwnerCandidates.filter((host) =>
    realtimeHub.sendToAgentHost(user.id, host, envelope),
  );

  return NextResponse.json({
    requested: deliveredHosts.length > 0,
    task_id: taskId,
    agent_hosts: deliveredHosts,
  });
}
