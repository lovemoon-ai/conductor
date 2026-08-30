import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, PATCH } from "@/app/api/tasks/[taskId]/scheduled-messages/[scheduleId]/route";
import { createMockRequest } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

// The real module pulls in Prisma, so the error class is restated here: the
// route only needs `instanceof` to match the class it imports.
vi.mock("@/lib/tasks/scheduled-messages", () => {
  class ScheduledMessageError extends Error {
    code: string;
    status: number;
    details: Record<string, unknown>;

    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = { error: code, message };
    }
  }

  return {
    ScheduledMessageError,
    cancelScheduledMessageForTask: vi.fn(),
    deleteScheduledMessageForTask: vi.fn(),
    getScheduledMessageStatusForTask: vi.fn(),
    updateScheduledMessageForTask: vi.fn(),
  };
});

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const {
  ScheduledMessageError,
  cancelScheduledMessageForTask,
  deleteScheduledMessageForTask,
  getScheduledMessageStatusForTask,
  updateScheduledMessageForTask,
} = await import("@/lib/tasks/scheduled-messages");

describe("/api/tasks/[taskId]/scheduled-messages/[scheduleId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(true);
    vi.mocked(deleteScheduledMessageForTask).mockResolvedValue(false);
    vi.mocked(getScheduledMessageStatusForTask).mockResolvedValue(null);
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
    expect(deleteScheduledMessageForTask).not.toHaveBeenCalled();
  });

  it("hard-deletes a finished schedule that cannot be canceled", async () => {
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(false);
    vi.mocked(deleteScheduledMessageForTask).mockResolvedValue(true);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(204);
    expect(deleteScheduledMessageForTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
      scheduleId: "sched-1",
    });
  });

  it("reports an in-flight send as a 409 rather than a missing row", async () => {
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(false);
    vi.mocked(getScheduledMessageStatusForTask).mockResolvedValue("sending");

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "schedule_in_flight",
      message: "This scheduled message is being sent right now. Try again in a moment.",
    });
  });

  it("returns 404 when the schedule can neither be canceled nor deleted", async () => {
    vi.mocked(cancelScheduledMessageForTask).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/missing",
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "missing" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Scheduled message is already completed, canceled, or does not exist",
    });
  });

  it("updates the content and schedule of an active row", async () => {
    vi.mocked(updateScheduledMessageForTask).mockResolvedValue({ id: "sched-1" } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
        body: {
          content: "ping again",
          schedule: { mode: "interval", every: 2, unit: "hour" },
        },
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(200);
    expect(updateScheduledMessageForTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
      scheduleId: "sched-1",
      content: "ping again",
      schedule: { mode: "interval", every: 2, unit: "hour" },
    });
  });

  it("rejects an update that changes nothing", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(400);
    expect(updateScheduledMessageForTask).not.toHaveBeenCalled();
  });

  it("returns 404 when the schedule does not exist", async () => {
    vi.mocked(updateScheduledMessageForTask).mockResolvedValue(null);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/missing",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("surfaces a 409 when the schedule is no longer editable", async () => {
    vi.mocked(updateScheduledMessageForTask).mockRejectedValue(
      new ScheduledMessageError(
        "schedule_not_editable",
        409,
        "Only active scheduled messages can be edited",
      ),
    );

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages/sched-1",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1", scheduleId: "sched-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "schedule_not_editable",
      message: "Only active scheduled messages can be edited",
    });
  });
});
