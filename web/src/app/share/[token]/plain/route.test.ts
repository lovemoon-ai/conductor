import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/share/[token]/plain/route";
import { createMockRequest } from "@/__tests__/helpers";

vi.mock("@/lib/tasks/shared-task", () => ({
  loadSharedTask: vi.fn(),
  buildSharedPlainText: vi.fn(),
}));

const { loadSharedTask, buildSharedPlainText } = await import("@/lib/tasks/shared-task");

describe("/share/[token]/plain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 plain text when token is invalid", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({ status: "not_found" } as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/share/bad/plain" }),
      { params: Promise.resolve({ token: "bad" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Not found");
  });

  it("returns 410 plain text when token has expired", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({ status: "expired" } as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/share/expired/plain" }),
      { params: Promise.resolve({ token: "expired" }) },
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("This shared link has expired.");
  });

  it("returns raw text transcript for valid links", async () => {
    vi.mocked(loadSharedTask).mockResolvedValue({
      status: "ok",
      data: {
        task: {
          id: "task-1",
          title: "Shared Task",
          status: "completed",
          taskType: "ai_task",
          createdAt: "2026-04-10T12:00:00.000Z",
          expiresAt: "2026-04-17T12:00:00.000Z",
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Question one",
            createdAt: "2026-04-10T12:01:00.000Z",
          },
        ],
      },
    } as any);
    vi.mocked(buildSharedPlainText).mockReturnValue("User: Question one");

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/share/test/plain" }),
      { params: Promise.resolve({ token: "test" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("User: Question one");
  });
});
