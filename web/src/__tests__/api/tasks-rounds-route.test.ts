import { mockPrismaQuery } from "@/__tests__/mock-prisma-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startRound } from "@/app/api/tasks/[taskId]/rounds/route";
import { POST as endRound } from "@/app/api/tasks/[taskId]/rounds/end/route";
import { PATCH as patchPersistent } from "@/app/api/tasks/[taskId]/persistent/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    broadcast: vi.fn(),
  },
}));

vi.mock("@/lib/channel/task-ingress-service", () => {
  class TaskIngressError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return { TaskIngressError, appendUserMessageToTask: vi.fn() };
});

vi.mock("@/lib/tasks/task-stop", () => ({
  resolveTaskStopTargetHost: vi.fn().mockReturnValue("mac-mini"),
  stopTaskBeforeRelaunch: vi.fn(),
}));

vi.mock("@/lib/tasks/create-ai-task", () => ({
  finalizeAiTaskCreation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    agentOutbox: {
      updateMany: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    taskRuntimeState: {
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { appendUserMessageToTask, TaskIngressError } = await import("@/lib/channel/task-ingress-service");
const { stopTaskBeforeRelaunch } = await import("@/lib/tasks/task-stop");
const { finalizeAiTaskCreation } = await import("@/lib/tasks/create-ai-task");

const project = {
  id: "project-1",
  userId: "user-1",
  name: "conductor",
  daemonHost: "mac-mini",
  workspacePath: "/repo",
  repoRoot: "/repo",
  worktreeBranch: "main",
  lastCommit: "abc123",
};

const persistentMetadata = (persistent: Record<string, unknown> = {}) =>
  JSON.stringify({
    labelIds: ["l1"],
    persistent: {
      enabled: true,
      round: 2,
      instructions: "Follow claw/sop/06_release.md",
      summary: "Last release: 0.13.0",
      ...persistent,
    },
  });

const buildTask = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  projectId: project.id,
  secondProjectId: null,
  issueId: null,
  title: "Release",
  taskType: "ai_task",
  status: "running",
  agentHost: "mac-mini",
  executionHost: "mac-mini",
  backendType: "claude",
  sessionId: "session-old",
  sessionFilePath: "/sessions/old.jsonl",
  // The previous round's token counts.
  tokenUsageTotal: 250000,
  lastTurnTokenUsage: 40000,
  launchConfig: JSON.stringify({ cwd: "/repo" }),
  metadata: persistentMetadata(),
  achievedAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  ptySession: null,
  project,
  ...overrides,
});

/** The task row as the database currently holds it; `updateMany` honours the metadata compare-and-swap. */
let stored: ReturnType<typeof buildTask>;
const useTask = (overrides: Record<string, unknown> = {}) => {
  stored = buildTask(overrides);
};
const storedPersistent = () => JSON.parse(stored.metadata as string).persistent;

const call = async (
  handler: (request: any, context: any) => Promise<Response>,
  path: string,
  method: string,
  body?: unknown,
) => {
  const request = createMockRequest({
    method,
    url: `http://localhost:6152/api/tasks/task-1${path}`,
    token: createTestToken("user-1"),
    body,
  });
  return handler(request, { params: Promise.resolve({ taskId: "task-1" }) });
};

const agents = (...capabilities: string[][]) =>
  vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue(
    capabilities.map((caps, index) => ({
      id: `agent-${index}`,
      host: index === 0 ? "mac-mini" : `mini-${index + 1}`,
      supportedBackends: ["claude", "codex"],
      capabilities: caps,
    })) as any,
  );

describe("persistent task rounds API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTask();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
      subscriptionStatus: "ACTIVE",
      subscriptionTier: "PLUS",
      subscriptionEndsAt: new Date(Date.now() + 86400000),
      trialEndsAt: null,
      lastPaymentAt: null,
    } as any);
    mockPrismaQuery(db.task.findFirst).mockImplementation(async () => ({ ...stored }) as any);
    mockPrismaQuery(db.task.findUnique).mockImplementation(async () => ({ ...stored }) as any);
    mockPrismaQuery(db.task.updateMany).mockImplementation(async ({ where, data }: any) => {
      if (where.metadata !== undefined && where.metadata !== stored.metadata) return { count: 0 } as any;
      stored = { ...stored, ...data };
      return { count: 1 } as any;
    });
    let messageSeq = 0;
    const createdMessages: Array<{ id: string; taskId: string; clientMessageId?: string }> = [];
    vi.mocked(db.message.create).mockImplementation((async ({ data }: any) => {
      const message = { id: `msg-${++messageSeq}`, taskId: data.taskId, clientMessageId: data.clientMessageId };
      createdMessages.push(message);
      return { id: message.id, createdAt: data.createdAt };
    }) as any);
    // Honours { taskId, clientMessageId } and { clientMessageId, taskId: { not } } lookups.
    vi.mocked(db.message.findFirst).mockImplementation((async ({ where }: any) =>
      createdMessages.find((message) =>
        message.clientMessageId === where.clientMessageId &&
        (typeof where.taskId === "string" ? message.taskId === where.taskId : message.taskId !== where.taskId?.not),
      ) ?? null) as any);
    vi.mocked(db.agentOutbox.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) => callback(db));
    vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true });
    agents(["persistent_round_v1"]);
  });

  describe("POST /rounds", () => {
    it("starts a fresh session on the same task with only instructions and summary as context", async () => {
      const response = await call(startRound, "/rounds", "POST", {
        content: "Ship 0.14.0",
        backend_type: "codex",
        expected_round: 2,
      });
      expect(response.status).toBe(200);

      // The previous round's fire is stopped first.
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", stopTargetHost: "mac-mini" }),
      );

      // Divider, then the user's message as typed.
      const createdMessages = vi.mocked(db.message.create).mock.calls.map(([args]: any) => args.data);
      expect(JSON.parse(createdMessages[0].metadata)).toMatchObject({
        kind: "persistent_round_start",
        round: 3,
        backend_type: "codex",
      });
      expect(createdMessages[1]).toMatchObject({ role: "user", content: "Ship 0.14.0" });
      expect(createdMessages[1].createdAt.getTime()).toBeGreaterThan(createdMessages[0].createdAt.getTime());

      // Session binding is reset and round state advanced; other metadata survives.
      expect(stored).toMatchObject({
        status: "init",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        tokenUsageTotal: 0,
        lastTurnTokenUsage: null,
        launchConfig: JSON.stringify({ cwd: "/repo", worktreeBranch: "main" }),
      });
      expect(JSON.parse(stored.metadata as string).labelIds).toEqual(["l1"]);
      expect(storedPersistent()).toMatchObject({ round: 3, roundEndedAt: null, roundEndMessageId: null });

      // Commands queued for the previous round must not reach the new round's fire.
      expect(db.agentOutbox.updateMany).toHaveBeenCalledWith({
        where: { taskId: "task-1", status: { in: ["pending", "sent"] } },
        data: { status: "failed", lastError: "superseded_by_persistent_round" },
      });

      // Other clients learn the new round, whose token counts start over.
      expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "project-1", {
        type: "task_token_usage",
        payload: { task_id: "task-1", project_id: "project-1", token_usage_total: 0, last_turn_token_usage: null },
      });
      expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "project-1", {
        type: "task_status_update",
        payload: expect.objectContaining({
          status: "init",
          metadata: expect.objectContaining({ persistent: expect.objectContaining({ round: 3 }) }),
        }),
      });

      // The AI gets the context preamble; the chat shows the plain message.
      const finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
      expect(finalize.initialMessageContent).toBe("Ship 0.14.0");
      expect(finalize.agentInitialContent).toContain("Follow claw/sop/06_release.md");
      expect(finalize.agentInitialContent).toContain("Last release: 0.13.0");
      expect(finalize.agentInitialContent.endsWith("Ship 0.14.0")).toBe(true);
      expect(finalize.agentHost).toBe("mac-mini");
      expect(finalize.replaceExistingFire).toBe(true);
    });

    it("builds the prompt from the summary as it is after the stop", async () => {
      vi.mocked(stopTaskBeforeRelaunch).mockImplementation(async () => {
        // The summary capture keeps the rest of metadata.persistent (the round-start claim).
        stored = { ...stored, metadata: persistentMetadata({ ...storedPersistent(), summary: "Released 0.14.0" }) };
        return { ok: true };
      });
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
      const finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
      expect(finalize.agentInitialContent).toContain("Released 0.14.0");
    });

    it("builds a new worktree when asked", async () => {
      const response = await call(startRound, "/rounds", "POST", { content: "go", worktree: "new" });
      expect(response.status).toBe(200);
      expect(JSON.parse(stored.launchConfig as string)).toMatchObject({
        worktree: true,
        worktreeId: "task-1",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
      });
    });

    describe("global AI backend task (RFC 0041)", () => {
      const remoteWorkspace = {
        host: "ubuntu",
        projectId: "proj-ubuntu",
        repoRoot: "/home/u/repo",
        workspacePath: "/home/u/repo",
      };
      const useGlobalTask = () => {
        const metadata = JSON.parse(persistentMetadata());
        useTask({
          launchConfig: JSON.stringify({ remoteWorkspace }),
          metadata: JSON.stringify({ ...metadata, globalBackend: { host: "mac-mini", backend: "claude" } }),
          // Filed on the unbound default project: no local clone on the AI daemon.
          project: { ...project, id: "proj-default", daemonHost: null, workspacePath: null, repoRoot: null },
        });
      };

      it("keeps working in the remote project directory, with its protocol in the prompt", async () => {
        useGlobalTask();
        expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
        expect(JSON.parse(stored.launchConfig as string)).toEqual({ remoteWorkspace });
        const finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
        expect(finalize.agentInitialContent).toContain("[conductor:remote-workspace]");
        expect(finalize.agentInitialContent).not.toContain("READ-ONLY copy");
      });

      it("never calls an unrelated default-project dir a read-only copy of the repository", async () => {
        const metadata = JSON.parse(persistentMetadata());
        useTask({
          launchConfig: JSON.stringify({ remoteWorkspace }),
          metadata: JSON.stringify({ ...metadata, globalBackend: { host: "mac-mini", backend: "claude" } }),
          // No copy of the repo on the AI daemon: filed on the default project,
          // which happens to be a git repo bound to that same daemon.
          project: { ...project, id: "proj-default", name: "Default", gitRemoteUrl: "github.com/me/notes" },
        });
        const remoteProject = {
          id: "proj-ubuntu",
          name: "conductor",
          daemonHost: "ubuntu",
          workspacePath: "/home/u/repo",
          repoRoot: "/home/u/repo",
          gitRemoteUrl: "github.com/acme/conductor",
        };
        mockPrismaQuery(db.project.findFirst).mockResolvedValue(remoteProject as any);
        expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
        let finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
        expect(finalize.agentInitialContent).toContain("[conductor:remote-workspace]");
        expect(finalize.agentInitialContent).not.toContain("READ-ONLY copy");

        // A real copy of the same repository still gets the note.
        vi.mocked(finalizeAiTaskCreation).mockClear();
        useTask({
          launchConfig: JSON.stringify({ remoteWorkspace }),
          metadata: JSON.stringify({ ...metadata, globalBackend: { host: "mac-mini", backend: "claude" } }),
          project: { ...project, gitRemoteUrl: "github.com/acme/conductor" },
        });
        expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
        finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
        expect(finalize.agentInitialContent).toContain("(/repo) is a READ-ONLY copy");
      });

      it("keeps the remote project directory when the round moves to another daemon", async () => {
        useGlobalTask();
        agents(["persistent_round_v1"], ["persistent_round_v1"]);
        const response = await call(startRound, "/rounds", "POST", { content: "go", agent_host: "mini-2" });
        expect(response.status).toBe(200);
        expect(JSON.parse(stored.launchConfig as string)).toEqual({ remoteWorkspace });
      });

      it("builds the new worktree on the code's daemon, not the AI's", async () => {
        useGlobalTask();
        mockPrismaQuery(db.project.findFirst).mockResolvedValue({
          id: "proj-ubuntu",
          name: "conductor",
          daemonHost: "ubuntu",
          workspacePath: "/home/u/repo",
          repoRoot: "/home/u/repo",
          worktreeBranch: "develop",
        } as any);
        const response = await call(startRound, "/rounds", "POST", { content: "go", worktree: "new" });
        expect(response.status).toBe(200);
        const launchConfig = JSON.parse(stored.launchConfig as string);
        expect(launchConfig.worktree).toBeUndefined();
        expect(launchConfig.remoteWorktree).toMatchObject({ ...remoteWorkspace, baseRef: "develop" });
        const finalize = vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any;
        expect(finalize.agentInitialContent).toContain("[conductor:remote-worktree]");
      });
    });

    it("keeps the previous round's daemon by default", async () => {
      useTask({ agentHost: "mini-2", executionHost: "mini-2" });
      agents([], ["persistent_round_v1"]);
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
      expect((vi.mocked(finalizeAiTaskCreation).mock.calls[0][0] as any).agentHost).toBe("mini-2");
    });

    it("stores the sender's message metadata (clientRequestId) on the round's first message", async () => {
      const { startPersistentRound } = await import("@/lib/tasks/persistent-round");
      const result = await startPersistentRound({
        userId: "user-1",
        taskId: "task-1",
        content: "go",
        messageMetadata: { clientRequestId: "req-1" },
        clientMessageId: "req-1",
      });
      expect(result.ok).toBe(true);
      const firstMessage = vi.mocked(db.message.create).mock.calls[1][0].data as any;
      expect(JSON.parse(firstMessage.metadata)).toEqual({ clientRequestId: "req-1" });
      // The column a retry looks the message up by; the divider never carries it.
      expect(firstMessage.clientMessageId).toBe("req-1");
      expect((vi.mocked(db.message.create).mock.calls[0][0].data as any).clientMessageId).toBeUndefined();
    });

    it("stops a task whose status is unknown", async () => {
      useTask({ status: "unknown" });
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
      expect(stopTaskBeforeRelaunch).toHaveBeenCalled();
    });

    it("rejects a task that is not persistent", async () => {
      useTask({ metadata: null });
      const response = await call(startRound, "/rounds", "POST", { content: "go" });
      expect(response.status).toBe(409);
      expect(await extractJson(response)).toEqual({ error: "Task is not persistent" });
      expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
    });

    it("refuses a round on a daemon that cannot release the previous fire, even when stopped", async () => {
      agents([]);
      useTask({ status: "killed" });
      const response = await call(startRound, "/rounds", "POST", { content: "go" });
      expect(response.status).toBe(409);
      expect(stopTaskBeforeRelaunch).not.toHaveBeenCalled();
      expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
    });

    it("writes nothing and releases its claim when the previous round cannot be stopped", async () => {
      const before = stored;
      vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: false, error: "Timed out" });
      const response = await call(startRound, "/rounds", "POST", { content: "go" });
      expect(response.status).toBe(409);
      expect(stored.status).toBe(before.status);
      expect(storedPersistent()).toMatchObject({ round: 2, roundStarting: null });
      expect(db.message.create).not.toHaveBeenCalled();
      expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
      // A retry is not blocked by the released claim.
      vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true });
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
    });

    it("lets exactly one of two concurrent starts stop the old round and dispatch the new one", async () => {
      let releaseStop!: () => void;
      vi.mocked(stopTaskBeforeRelaunch).mockImplementation(
        () => new Promise((resolve) => { releaseStop = () => resolve({ ok: true }); }),
      );
      const first = call(startRound, "/rounds", "POST", { content: "from A" });
      const second = call(startRound, "/rounds", "POST", { content: "from B" });
      await vi.waitFor(() => expect(stopTaskBeforeRelaunch).toHaveBeenCalled());
      const loser = await second;
      releaseStop();
      const winner = await first;

      expect(winner.status).toBe(200);
      expect(loser.status).toBe(409);
      expect(await extractJson(loser)).toMatchObject({ error: "round_changed" });
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledTimes(1);
      expect(finalizeAiTaskCreation).toHaveBeenCalledTimes(1);
      expect(storedPersistent()).toMatchObject({ round: 3, roundStarting: null });
    });

    it("gives a retry of the same send the first attempt's message instead of round_changed", async () => {
      const { startPersistentRound } = await import("@/lib/tasks/persistent-round");
      let releaseStop!: () => void;
      vi.mocked(stopTaskBeforeRelaunch).mockImplementation(
        () => new Promise((resolve) => { releaseStop = () => resolve({ ok: true }); }),
      );
      const send = () => startPersistentRound({ userId: "user-1", taskId: "task-1", content: "go", clientMessageId: "req-1" });
      const first = send();
      await vi.waitFor(() => expect(stopTaskBeforeRelaunch).toHaveBeenCalled());
      const retry = send();
      // The retry waits on the first attempt's claim rather than failing.
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseStop();
      const [firstResult, retryResult] = await Promise.all([first, retry]);

      expect(firstResult).toMatchObject({ ok: true });
      expect(retryResult).toMatchObject({ ok: true, messageId: (firstResult as { messageId: string }).messageId });
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledTimes(1);
      expect(finalizeAiTaskCreation).toHaveBeenCalledTimes(1);
    });

    it("lets a retry start the round itself when the first attempt gave up", async () => {
      const { startPersistentRound } = await import("@/lib/tasks/persistent-round");
      let failStop!: () => void;
      vi.mocked(stopTaskBeforeRelaunch).mockImplementationOnce(
        () => new Promise((resolve) => { failStop = () => resolve({ ok: false, error: "Timed out" }); }),
      );
      const send = () => startPersistentRound({ userId: "user-1", taskId: "task-1", content: "go", clientMessageId: "req-1" });
      const first = send();
      await vi.waitFor(() => expect(stopTaskBeforeRelaunch).toHaveBeenCalled());
      const retry = send();
      await new Promise((resolve) => setTimeout(resolve, 20));
      failStop();

      expect(await first).toMatchObject({ ok: false, status: 409 });
      expect(await retry).toMatchObject({ ok: true });
      expect(finalizeAiTaskCreation).toHaveBeenCalledTimes(1);
      expect(storedPersistent()).toMatchObject({ round: 3, roundStarting: null });
    });

    it("refuses a client request id another task already used, before stopping anything", async () => {
      const { startPersistentRound } = await import("@/lib/tasks/persistent-round");
      vi.mocked(db.message.findFirst).mockResolvedValueOnce({ id: "other-task-msg" } as any);
      const result = await startPersistentRound({ userId: "user-1", taskId: "task-1", content: "go", clientMessageId: "req-1" });

      expect(result).toMatchObject({ ok: false, status: 409, details: { error: "client_request_id_in_use" } });
      expect(stopTaskBeforeRelaunch).not.toHaveBeenCalled();
      expect(storedPersistent().round).toBe(2);
      expect(storedPersistent().roundStarting ?? null).toBeNull();
    });

    it("maps a unique-id race at insert time to a 409 and releases the claim", async () => {
      const { startPersistentRound } = await import("@/lib/tasks/persistent-round");
      // Roll back like a real transaction when the callback throws.
      vi.mocked(db.$transaction).mockImplementationOnce(async (callback: any) => {
        const snapshot = stored;
        try {
          return await callback(db);
        } catch (error) {
          stored = snapshot;
          throw error;
        }
      });
      vi.mocked(db.message.create)
        .mockResolvedValueOnce({ id: "divider", createdAt: new Date() } as any)
        .mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
      const result = await startPersistentRound({ userId: "user-1", taskId: "task-1", content: "go", clientMessageId: "req-1" });

      expect(result).toMatchObject({ ok: false, status: 409, details: { error: "client_request_id_in_use" } });
      expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
      expect(storedPersistent()).toMatchObject({ round: 2, roundStarting: null });
    });

    it("ignores an expired round-start claim left by a crashed request", async () => {
      const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
      useTask({ metadata: persistentMetadata({ roundStarting: { id: "crashed", at: at(10_000) } }) });
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(409);
      expect(stopTaskBeforeRelaunch).not.toHaveBeenCalled();

      useTask({ metadata: persistentMetadata({ roundStarting: { id: "crashed", at: at(3 * 60_000) } }) });
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(200);
      expect(storedPersistent()).toMatchObject({ round: 3, roundStarting: null });
    });

    it("refuses a stale client that saw an older round", async () => {
      const response = await call(startRound, "/rounds", "POST", { content: "go", expected_round: 1 });
      expect(response.status).toBe(409);
      expect(await extractJson(response)).toMatchObject({ error: "round_changed" });
      expect(stopTaskBeforeRelaunch).not.toHaveBeenCalled();
    });

    it("creates one round when another request started it first", async () => {
      vi.mocked(stopTaskBeforeRelaunch).mockImplementation(async () => {
        stored = { ...stored, metadata: persistentMetadata({ round: 3 }) };
        return { ok: true };
      });
      const response = await call(startRound, "/rounds", "POST", { content: "go" });
      expect(response.status).toBe(409);
      expect(db.message.create).not.toHaveBeenCalled();
      expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
    });

    it("rejects an offline daemon and a missing message", async () => {
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
      expect((await call(startRound, "/rounds", "POST", { content: "go" })).status).toBe(409);
      expect((await call(startRound, "/rounds", "POST", { content: " " })).status).toBe(400);
    });
  });

  describe("POST /rounds/end", () => {
    it("asks the running AI for a summary, remembers the request and tells other clients", async () => {
      vi.mocked(appendUserMessageToTask).mockResolvedValue({
        task: null,
        message: { id: "req-9" },
      } as any);
      const response = await call(endRound, "/rounds/end", "POST");
      expect(response.status).toBe(200);
      expect(appendUserMessageToTask).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          metadata: { kind: "persistent_round_end", round: 2 },
        }),
      );
      expect(storedPersistent()).toMatchObject({ roundEndMessageId: "req-9", roundEndedAt: expect.any(String) });
      expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "project-1", {
        type: "task_status_update",
        payload: expect.objectContaining({ status: "running" }),
      });
    });

    it("ends a stopped round without a summary", async () => {
      useTask({ status: "killed" });
      expect((await call(endRound, "/rounds/end", "POST")).status).toBe(200);
      expect(appendUserMessageToTask).not.toHaveBeenCalled();
      expect(storedPersistent()).toMatchObject({ roundEndMessageId: null });
    });

    it("ends the round when the fire owner is gone", async () => {
      vi.mocked(appendUserMessageToTask).mockRejectedValue(
        new TaskIngressError("TASK_MISSING_ACTIVE_FIRE_OWNER", 409, "Task missing active fire owner"),
      );
      expect((await call(endRound, "/rounds/end", "POST")).status).toBe(200);
      expect(storedPersistent().roundEndedAt).toEqual(expect.any(String));
    });
  });

  describe("PATCH /persistent", () => {
    it("turns a task persistent, keeps other metadata and tells other clients", async () => {
      useTask({ metadata: JSON.stringify({ labelIds: ["l1"] }) });
      const response = await call(patchPersistent, "/persistent", "PATCH", {
        enabled: true,
        instructions: "Research weekly",
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(stored.metadata as string)).toEqual({
        labelIds: ["l1"],
        persistent: { enabled: true, instructions: "Research weekly" },
      });
      expect(realtimeHub.broadcast).toHaveBeenCalled();
    });

    it("drops a half-finished round when persistence is turned off", async () => {
      useTask({ metadata: persistentMetadata({ roundEndedAt: "2026-09-17T00:00:00.000Z", roundEndMessageId: "req-1" }) });
      expect((await call(patchPersistent, "/persistent", "PATCH", { enabled: false })).status).toBe(200);
      expect(storedPersistent()).toMatchObject({ enabled: false, roundEndedAt: null, roundEndMessageId: null });
    });

    it("rejects invalid input", async () => {
      const response = await call(patchPersistent, "/persistent", "PATCH", { summary: 42 });
      expect(response.status).toBe(400);
      expect(db.task.updateMany).not.toHaveBeenCalled();
    });
  });
});
