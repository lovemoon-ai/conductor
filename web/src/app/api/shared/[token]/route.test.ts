import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/shared/[token]/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/tasks/shared-task", () => ({
  loadSharedTask: vi.fn(),
}));

const { loadSharedTask } = await import("@/lib/tasks/shared-task");

describe("/api/shared/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for invalid token", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({ status: "not_found" } as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/bad-token" }),
      { params: Promise.resolve({ token: "bad-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(404);
    expect(data).toEqual({ error: "Not found" });
  });

  it("returns 410 for expired share link", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({ status: "expired" } as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(410);
    expect(data).toEqual({ error: "This shared link has expired" });
  });

  it("returns task and messages for valid token", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({
      status: "ok",
      data: {
        task: {
          id: "task-1",
          title: "Test Task",
          status: "completed",
          taskType: "ai_task",
          createdAt: "2026-04-01T00:00:00.000Z",
          expiresAt: null,
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Hello",
            createdAt: "2026-04-01T00:01:00.000Z",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Hi there!",
            createdAt: "2026-04-01T00:02:00.000Z",
          },
        ],
      },
    } as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.task).toEqual({
      id: "task-1",
      title: "Test Task",
      status: "completed",
      taskType: "ai_task",
      createdAt: "2026-04-01T00:00:00.000Z",
      expiresAt: null,
    });
    expect(data.messages).toHaveLength(2);
  });
});
