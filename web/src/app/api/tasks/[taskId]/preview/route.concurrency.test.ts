import { expect, it, vi } from "vitest";

// Unlike `route.test.ts` this keeps the real `remote-file` limiter (four daemon
// requests per user, the fifth refused outright) and only fakes the socket.

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(async () => ({ id: "user-1" })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(async () => ({
        agentHost: "ubuntu",
        executionHost: null,
        metadata: null,
        project: { daemonHost: "ubuntu" },
      })),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: () => [{ id: "a", host: "ubuntu", capabilities: ["remote_file", "remote_file_preview"] }],
    sendToAgentHost: () => true,
    hasAgentHost: () => true,
    cancelRemoteFileResponse: () => undefined,
    // A daemon some milliseconds away answering a `stat`.
    waitForRemoteFileResponse: () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ result: { exists: true, isFile: true, sizeBytes: 10, realPath: "/home/dev/out/a.png" } }),
          10,
        ),
      ),
  },
}));

const { POST } = await import("./route");
const { createMockRequest } = await import("@/__tests__/helpers");

it("opens every picture of a reply even when they are all asked for at once", async () => {
  const statuses = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      POST(createMockRequest({ method: "POST", body: { path: `out/img${i}.png` } }), {
        params: Promise.resolve({ taskId: "task-1" }),
      }).then((response) => response.status),
    ),
  );
  // Before the queue, six of these ten were refused with 429.
  expect(statuses).toEqual(Array(10).fill(200));
});
