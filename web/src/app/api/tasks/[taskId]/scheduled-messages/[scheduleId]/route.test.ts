import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/tasks/[taskId]/scheduled-messages/[scheduleId]/route";
import { createMockRequest } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/tasks/scheduled-messages", () => ({
  cancelScheduledMessageForTask: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { cancelScheduledMessageForTask } = await import("@/lib/tasks/scheduled-messages");

describe("/api/tasks/[taskId]/scheduled-messages/[scheduleId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(true);
  });

  it("cancels a scheduled message", async () => {
    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(204);
    expect(cancelScheduledMessageForTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
      scheduleId: "sched-1",
    });
  });

  it("returns 404 when no active schedule is canceled", async () => {
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/missing",
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "missing" }) },
    );

    expect(response.status).toBe(404);
  });
});
