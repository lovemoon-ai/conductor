import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDigestSourcePacket,
  summarizeHandoffDigest,
  HandoffDigestError,
} from "@/lib/tasks/handoff-digest";

const makeClient = (task: unknown, messages: unknown[]) => ({
  task: { findFirst: vi.fn().mockResolvedValue(task) },
  message: { findMany: vi.fn().mockResolvedValue(messages) },
});

describe("buildDigestSourcePacket", () => {
  it("returns null when the task is not owned by the user", async () => {
    const client = makeClient(null, []);
    const packet = await buildDigestSourcePacket({
      userId: "u1",
      taskId: "t1",
      client: client as never,
    });
    expect(packet).toBeNull();
    expect(client.message.findMany).not.toHaveBeenCalled();
  });

  it("builds a chronological packet scoped to the user", async () => {
    const client = makeClient(
      { id: "t1", title: "Ship API", backendType: "codex", project: { name: "Web" } },
      [
        { role: "assistant", content: "done part 2" },
        { role: "user", content: "do part 1" },
      ],
    );
    const packet = await buildDigestSourcePacket({
      userId: "u1",
      taskId: "t1",
      client: client as never,
    });
    expect(packet).not.toBeNull();
    expect(packet!.taskTitle).toBe("Ship API");
    expect(packet!.backend).toBe("codex");
    expect(packet!.projectName).toBe("Web");
    // reversed to chronological
    expect(packet!.messages.map((m) => m.text)).toEqual(["do part 1", "done part 2"]);
    const where = client.task.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: "t1", project: { userId: "u1" } });
  });

  it("caps the packet by character budget and reports truncation", async () => {
    const big = "x".repeat(2000);
    const client = makeClient(
      { id: "t1", title: "T", backendType: null, project: { name: null } },
      [
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
      ],
    );
    const packet = await buildDigestSourcePacket({
      userId: "u1",
      taskId: "t1",
      maxChars: 2500,
      client: client as never,
    });
    expect(packet!.messages).toHaveLength(1);
    expect(packet!.truncatedMessages).toBe(2);
  });
});

describe("summarizeHandoffDigest", () => {
  const OLD_ENV = { ...process.env };
  const packet = {
    taskId: "t1",
    taskTitle: "Ship API",
    backend: "codex",
    projectName: "Web",
    messageCount: 2,
    truncatedMessages: 0,
    messages: [{ role: "user", text: "do it" }],
  };

  beforeEach(() => {
    process.env.GLM_API_KEY = "test-key";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.clearAllMocks();
  });

  it("throws missing_api_key when no key is configured", async () => {
    delete process.env.GLM_API_KEY;
    await expect(
      summarizeHandoffDigest({ packet, fetchImpl: vi.fn() as never }),
    ).rejects.toMatchObject({ reason: "missing_api_key" });
  });

  it("returns the summarized markdown on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "# 任务交接\n..." } }] }),
        { status: 200 },
      ),
    );
    const result = await summarizeHandoffDigest({ packet, fetchImpl: fetchImpl as never });
    expect(result.digestMarkdown).toContain("任务交接");
    expect(result.summarizer.provider).toBe("glm");
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer test-key");
  });

  it("throws http_error on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      summarizeHandoffDigest({ packet, fetchImpl: fetchImpl as never }),
    ).rejects.toBeInstanceOf(HandoffDigestError);
  });

  it("throws empty_response when the model returns nothing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    );
    await expect(
      summarizeHandoffDigest({ packet, fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ reason: "empty_response" });
  });
});
