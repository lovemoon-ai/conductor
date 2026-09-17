import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/runtime-status/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");

const runningTask = {
  id: "task-1",
  projectId: "proj-1",
  taskType: "ai_task",
  status: "running",
  agentHost: "conductor-fire-a",
  executionHost: "conductor-fire-a",
  metadata: JSON.stringify({ daemonName: "daemon-a" }),
  project: { daemonHost: "daemon-a" },
};

const post = () =>
  POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:6152/api/tasks/task-1/runtime-status",
    }),
    { params: Promise.resolve({ taskId: "task-1" }) },
  );

describe("/api/tasks/[taskId]/runtime-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as never);
  });

  it("asks the task fire owner to report its runtime status", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(runningTask as never);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const response = await post();
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith("user-1", "conductor-fire-a", {
      type: "report_runtime_status",
      payload: { task_id: "task-1", project_id: "proj-1" },
    });
    expect(data).toEqual({ requested: true, task_id: "task-1", agent_hosts: ["conductor-fire-a"] });
  });

  it("reports requested=false when the fire owner is offline", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(runningTask as never);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(false);

    const response = await post();
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ requested: false, task_id: "task-1", agent_hosts: [] });
  });

  it("rejects tasks that are not running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...runningTask, status: "completed" } as never);

    const response = await post();

    expect(response.status).toBe(409);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("returns 404 for tasks outside the user's projects", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);

    const response = await post();

    expect(response.status).toBe(404);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });
});
