import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/digest/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/tasks/handoff-digest", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/tasks/handoff-digest")>();
  return {
    ...mod,
    buildDigestSourcePacket: vi.fn(),
    summarizeHandoffDigest: vi.fn(),
  };
});

const digest = await import("@/lib/tasks/handoff-digest");

const USER_ID = "user-1";

const callDigest = async (taskId = "t-1", authed = true) =>
  POST(
    createMockRequest({
      method: "POST",
      url: `http://localhost:6152/api/tasks/${taskId}/digest`,
      token: authed ? createTestToken(USER_ID) : undefined,
    }),
    { params: Promise.resolve({ taskId }) },
  );

const packet = {
  taskId: "t-1",
  taskTitle: "Ship API",
  backend: "codex",
  projectName: "Web",
  messageCount: 3,
  truncatedMessages: 1,
  messages: [{ role: "user", text: "do it" }],
};

describe("POST /api/tasks/[taskId]/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: USER_ID,
      email: "test@example.com",
      phone: null,
    } as never);
    vi.mocked(digest.buildDigestSourcePacket).mockResolvedValue(packet);
    vi.mocked(digest.summarizeHandoffDigest).mockResolvedValue({
      digestMarkdown: "# 任务交接\n...",
      summarizer: { provider: "glm", model: "glm-5.2", generatedAt: "2024-01-01T00:00:00.000Z" },
    });
  });

  it("rejects unauthenticated callers", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);
    const res = await callDigest("t-1", false);
    expect(res.status).toBe(401);
    expect(digest.buildDigestSourcePacket).not.toHaveBeenCalled();
  });

  it("returns 404 when the task is not owned by the caller", async () => {
    vi.mocked(digest.buildDigestSourcePacket).mockResolvedValue(null);
    const res = await callDigest();
    expect(res.status).toBe(404);
  });

  it("returns 409 for a task with no messages", async () => {
    vi.mocked(digest.buildDigestSourcePacket).mockResolvedValue({ ...packet, messageCount: 0 });
    const res = await callDigest();
    expect(res.status).toBe(409);
  });

  it("returns the summarized digest markdown on success", async () => {
    const res = await callDigest();
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body).toMatchObject({
      ok: true,
      task_id: "t-1",
      digest_markdown: "# 任务交接\n...",
      source: { message_count: 3, truncated_messages: 1 },
    });
  });

  it("fails visibly with 502 when the summarizer errors", async () => {
    vi.mocked(digest.summarizeHandoffDigest).mockRejectedValue(
      new digest.HandoffDigestError("http_error", "GLM digest failed with HTTP 500"),
    );
    const res = await callDigest();
    expect(res.status).toBe(502);
    const body = await extractJson(res);
    expect(body).toMatchObject({ error: "digest_failed", reason: "http_error" });
  });

  it("returns 503 when the summarizer is not configured", async () => {
    vi.mocked(digest.summarizeHandoffDigest).mockRejectedValue(
      new digest.HandoffDigestError("missing_api_key", "GLM_API_KEY is not configured"),
    );
    const res = await callDigest();
    expect(res.status).toBe(503);
  });
});
