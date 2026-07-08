import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { GET, POST, PATCH, DELETE } from "@/app/api/projects/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

const countActiveScheduledMessagesForProjectsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
    },
    message: {
      deleteMany: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
    },
    defaultProject: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    unbindTask: vi.fn(),
  },
}));

vi.mock("@/lib/projects/daemon-binding", () => ({
  validateProjectBindingWithDaemon: vi.fn(),
  ProjectBindingValidationError: class ProjectBindingValidationError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = "ProjectBindingValidationError";
      this.status = status;
      this.code = code;
    }
    },
  }));

vi.mock("@/lib/tasks/task-stop", () => ({
  stopTaskBeforeRelaunch: vi.fn(),
}));

vi.mock("@/lib/tasks/scheduled-messages", () => ({
  countActiveScheduledMessagesForProjects: countActiveScheduledMessagesForProjectsMock,
}));

vi.mock("@/lib/projects/project-settings-yaml", () => ({
  readProjectSettingsYaml: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { readProjectSettingsYaml } = await import("@/lib/projects/project-settings-yaml");
const { deleteTaskAttachmentDirectory } = await import("@/lib/tasks/task-file-storage");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { stopTaskBeforeRelaunch } = await import("@/lib/tasks/task-stop");
const {
  validateProjectBindingWithDaemon,
  ProjectBindingValidationError,
} = await import("@/lib/projects/daemon-binding");

const missingSortOrderColumnError = () =>
  new Prisma.PrismaClientKnownRequestError(
    "The column `projects.sort_order` does not exist in the current database.",
    {
      code: "P2022",
      clientVersion: "test",
    },
  );

describe("/api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.project.findFirst).mockReset();
    vi.mocked(db.project.findMany).mockReset();
    vi.mocked(db.project.findUnique).mockReset();
    vi.mocked(db.project.aggregate).mockReset();
    vi.mocked(db.defaultProject.findMany).mockReset();
    vi.mocked(db.defaultProject.findUnique).mockReset();
    vi.mocked(db.defaultProject.findMany).mockResolvedValue([]);
    vi.mocked(db.project.findMany).mockResolvedValue([]);
    vi.mocked(db.task.groupBy).mockResolvedValue([]);
    countActiveScheduledMessagesForProjectsMock.mockResolvedValue(new Map());
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
    vi.mocked(db.project.findFirst).mockResolvedValue(null);
    vi.mocked(db.project.findUnique).mockResolvedValue(null);
    vi.mocked(db.project.aggregate).mockResolvedValue({ _max: { sortOrder: null } } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.unbindTask).mockImplementation(() => undefined);
    vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function"
        ? callback({
            message: db.message,
            task: db.task,
            project: db.project,
            agentOutbox: db.agentOutbox,
          })
        : callback,
    );
    vi.mocked(validateProjectBindingWithDaemon).mockReset();
    vi.mocked(readProjectSettingsYaml).mockReset();
    vi.mocked(readProjectSettingsYaml).mockResolvedValue({ icon: null });
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
    vi.mocked(db.agentOutbox.create).mockResolvedValue({ id: "outbox-1" } as any);
  });

  describe("GET", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({});
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return user projects when authenticated", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProjects = [
        {
          id: "proj-1",
          name: "Project 1",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: JSON.stringify({ key: "value" }),
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue(mockProjects);
      countActiveScheduledMessagesForProjectsMock.mockResolvedValue(new Map([["proj-1", 4]]));

      const token = createTestToken("user-1");
      const request = createMockRequest({ token });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("proj-1");
      expect(data[0].name).toBe("Project 1");
      expect(data[0].metadata).toEqual({ key: "value" });
      expect(data[0].activeScheduledMessageCount).toBe(4);
      expect(data[0].active_scheduled_message_count).toBe(4);
      expect(countActiveScheduledMessagesForProjectsMock).toHaveBeenCalledWith({ userId: "user-1" });
    });

    it("surfaces the icon read from .conductor/settings.yaml on each project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue([
        {
          id: "proj-with-icon",
          name: "With Icon",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/with-icon",
          repoRoot: null,
          worktreeBranch: null,
          lastCommit: null,
          fileCount: null,
          sortOrder: 0,
          metadata: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
        {
          id: "proj-without-icon",
          name: "No Icon",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/no-icon",
          repoRoot: null,
          worktreeBranch: null,
          lastCommit: null,
          fileCount: null,
          sortOrder: 1,
          metadata: null,
          createdAt: new Date("2024-01-02"),
          updatedAt: new Date("2024-01-02"),
        },
      ] as any);
      vi.mocked(readProjectSettingsYaml).mockImplementation(async (workspacePath) => {
        if (workspacePath === "/Users/duo/ws/with-icon") {
          return { icon: "🚀" };
        }
        return { icon: null };
      });

      const response = await GET(createMockRequest({ token: createTestToken("user-1") }));
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      const byId = Object.fromEntries(
        (data as Array<{ id: string; icon: string | null }>).map((entry) => [entry.id, entry.icon]),
      );
      expect(byId["proj-with-icon"]).toBe("🚀");
      expect(byId["proj-without-icon"]).toBeNull();
    });

    it("returns projects in stable sort order with legacy null values last", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue([
        {
          id: "proj-null",
          name: "Legacy",
          userId: "user-1",
          daemonHost: null,
          workspacePath: null,
          repoRoot: null,
          worktreeBranch: null,
          lastCommit: null,
          fileCount: null,
          sortOrder: null,
          metadata: null,
          createdAt: new Date("2024-01-03"),
          updatedAt: new Date("2024-01-03"),
        },
        {
          id: "proj-1",
          name: "One",
          userId: "user-1",
          daemonHost: null,
          workspacePath: null,
          repoRoot: null,
          worktreeBranch: null,
          lastCommit: null,
          fileCount: null,
          sortOrder: 1,
          metadata: null,
          createdAt: new Date("2024-01-02"),
          updatedAt: new Date("2024-01-02"),
        },
        {
          id: "proj-0",
          name: "Zero",
          userId: "user-1",
          daemonHost: null,
          workspacePath: null,
          repoRoot: null,
          worktreeBranch: null,
          lastCommit: null,
          fileCount: null,
          sortOrder: 0,
          metadata: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const response = await GET(createMockRequest({ token }));
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.map((project: { id: string }) => project.id)).toEqual([
        "proj-0",
        "proj-1",
        "proj-null",
      ]);
    });

    it("falls back to createdAt ordering when sort_order column is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany)
        .mockRejectedValueOnce(missingSortOrderColumnError())
        .mockResolvedValueOnce([
          {
            id: "proj-new",
            name: "Newer",
            userId: "user-1",
            daemonHost: null,
            workspacePath: null,
            repoRoot: null,
            worktreeBranch: null,
            lastCommit: null,
            fileCount: null,
            metadata: null,
            createdAt: new Date("2024-01-03"),
            updatedAt: new Date("2024-01-03"),
          },
          {
            id: "proj-old",
            name: "Older",
            userId: "user-1",
            daemonHost: null,
            workspacePath: null,
            repoRoot: null,
            worktreeBranch: null,
            lastCommit: null,
            fileCount: null,
            metadata: null,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ] as any);

      const response = await GET(createMockRequest({ token: createTestToken("user-1") }));
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.map((project: { id: string }) => project.id)).toEqual(["proj-new", "proj-old"]);
      expect(data[0].sortOrder).toBeUndefined();
      expect(db.project.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        orderBy: { createdAt: "desc" },
      }));
    });
  });

  describe("POST", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({
        method: "POST",
        body: { name: "New Project" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should create project when authenticated", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-2",
        name: "New Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.mocked(db.project.create).mockResolvedValue(mockProject);
      vi.mocked(readProjectSettingsYaml).mockResolvedValueOnce({ icon: "🚀" });

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "New Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-2");
      expect(data.name).toBe("New Project");
      expect(data.icon).toBe("🚀");
      expect(db.project.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          sortOrder: 0,
        }),
      }));
    });

    it("creates projects without sortOrder when sort_order column is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-nosort",
        name: "No Sort Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          bindingCandidate: {
            daemonHost: "daemon-1",
            workspacePath: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.aggregate).mockRejectedValueOnce(missingSortOrderColumnError());
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const response = await POST(createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {
          name: "No Sort Project",
          metadata: {
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          },
        },
      }));
      const data = await extractJson(response);
      const createArgs = vi.mocked(db.project.create).mock.calls[0][0] as any;

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-nosort");
      expect(createArgs.data).not.toHaveProperty("sortOrder");
      expect(createArgs.select).not.toHaveProperty("sortOrder");
    });

    it("should validate daemonHost and workspacePath before creating a bound project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-validated",
        name: "Validated Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor-real",
        repoRoot: "/Users/duo/ws/conductor-real",
        worktreeBranch: "main",
        lastCommit: "abc123",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: null,
        fileCount: 42,
        metadata: JSON.stringify({ settingsIcon: "🚀" }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(validateProjectBindingWithDaemon).mockResolvedValue({
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor-real",
        repoRoot: "/Users/duo/ws/conductor-real",
        worktreeBranch: "main",
        lastCommit: "abc123",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: null,
        fileCount: 42,
        icon: "🚀",
      });
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Validated Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-validated");
      expect(data.icon).toBe("🚀");
      expect(validateProjectBindingWithDaemon).toHaveBeenCalledWith({
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor",
      });
      expect(db.project.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          name: "Validated Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor-real",
          repoRoot: "/Users/duo/ws/conductor-real",
          worktreeBranch: "main",
          lastCommit: "abc123",
          lastCommitAt: "2026-05-12T14:30:00.000Z",
          fileCount: 42,
          metadata: JSON.stringify({ settingsIcon: "🚀" }),
        }),
      }));
    });

    it("preserves cached icon metadata when promoting an existing binding with an old daemon", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const existingProject = {
        id: "proj-existing",
        name: "Existing Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor-real",
        repoRoot: "/Users/duo/ws/conductor-real",
        worktreeBranch: "main",
        lastCommit: "old",
        lastCommitAt: null,
        gitRemoteUrl: null,
        fileCount: 40,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "old-icon" }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };
      const updatedProject = {
        ...existingProject,
        name: "Existing Project",
        lastCommit: "abc123",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        fileCount: 42,
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(validateProjectBindingWithDaemon).mockResolvedValue({
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor-real",
        repoRoot: "/Users/duo/ws/conductor-real",
        worktreeBranch: "main",
        lastCommit: "abc123",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: null,
        fileCount: 42,
      });
      vi.mocked(db.project.findFirst).mockResolvedValueOnce(existingProject);
      vi.mocked(db.project.update).mockResolvedValue(updatedProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.project.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          metadata: JSON.stringify({ color: "blue", settingsIcon: "old-icon" }),
        }),
      }));
      expect(data.icon).toBe("old-icon");
    });

    it("should return validation errors from the daemon binding check", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(validateProjectBindingWithDaemon).mockRejectedValue(
        new ProjectBindingValidationError(
          "Workspace path does not exist on daemon daemon-1: /Users/duo/missing",
          400,
          "workspace_not_found",
        ),
      );

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Broken Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/missing",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("Workspace path does not exist on daemon daemon-1: /Users/duo/missing");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should create a pending project when given a binding candidate metadata", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-pending",
        name: "Pending Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          bindingCandidate: {
            daemonHost: "daemon-1",
            workspacePath: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          metadata: {
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-pending");
      expect(data.daemon_host).toBeNull();
      expect(data.workspace_path).toBeNull();
      expect(data.metadata).toEqual({
        bindingCandidate: {
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
        },
      });
      expect(db.project.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          name: "Pending Project",
          daemonHost: null,
          workspacePath: null,
          metadata: JSON.stringify({
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          }),
        }),
      }));
    });

    it("should reject a pending binding candidate when the same workspace is already bound", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue([
        {
          id: "proj-existing",
          name: "Existing Project",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          metadata: {
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project binding already exists");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject unconfirmed snapshot fields before daemon validation", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Snapshot fields require confirmed binding from daemon/CLI");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject metadata that is not an object or null", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Bad Metadata Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          bindingConfirmed: true,
          metadata: "oops",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("metadata must be an object or null");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject duplicate project name on the same daemon", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-existing",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "New Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/other",
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project name already exists on this daemon");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject confirmed binding without daemon host or workspace path", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Bound Project",
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("daemonHost and workspacePath are required");
    });
  });

  describe("DELETE", () => {
    it("should return 400 when projectId is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects",
      });
      const response = await DELETE(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("projectId is required");
    });

    it("should delete project and children successfully", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({ id: "proj-1", name: "Demo" } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-1",
          taskType: "ai_task",
          launchConfig: null,
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(db.task.findMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1" },
        select: {
          id: true,
          taskType: true,
          launchConfig: true,
          metadata: true,
          agentHost: true,
          executionHost: true,
          status: true,
        },
      });
      expect(db.message.deleteMany).toHaveBeenCalledWith({
        where: {
          taskId: {
            in: ["task-1"],
          },
        },
      });
      expect(db.task.deleteMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1" },
      });
      expect(db.project.delete).toHaveBeenCalledWith({
        where: { id: "proj-1" },
      });
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-1");
      expect(db.agentOutbox.create).not.toHaveBeenCalled();
    });

    it("should queue worktree cleanup before deleting a project with isolated worktree tasks", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({ id: "proj-1", name: "Demo" } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-worktree-1",
          launchConfig: JSON.stringify({
            worktree: true,
            worktreeId: "task-worktree-1",
            worktreeBranch: "abc123",
            worktreeBaseRef: "main",
            projectRepoRoot: "/repo",
            projectWorkspacePath: "/repo/app",
            projectRelativePath: "app",
          }),
          metadata: null,
          agentHost: "daemon-offline",
          executionHost: "daemon-offline",
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(db.agentOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            agentHost: "daemon-offline",
            taskId: "task-worktree-1",
            eventType: "cleanup_task_worktree",
          }),
        }),
      );
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-1");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-1");
    });

    it("should stop active plain tasks before deleting a project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-plain",
        name: "Plain Project",
        daemonHost: "daemon-a",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-plain-running",
          taskType: "ai_task",
          launchConfig: null,
          metadata: null,
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          status: "running",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-plain" } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-plain",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          taskId: "task-plain-running",
          projectId: "proj-plain",
          stopTargetHost: "daemon-a",
          reason: "project_deleted",
          taskLabel: "task",
        }),
      );
      expect(db.agentOutbox.create).not.toHaveBeenCalled();
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-plain-running");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-plain-running");
    });

    it("should stop active worktree tasks and queue one cleanup per shared root before deleting a project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        daemonHost: "daemon-a",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-worktree-source",
          launchConfig: JSON.stringify({
            worktree: true,
            worktreeId: "task-worktree-source",
            worktreeBranch: "abc123",
            worktreeBaseRef: "main",
            projectRepoRoot: "/repo",
            projectWorkspacePath: "/repo/app",
            projectRelativePath: "app",
          }),
          metadata: JSON.stringify({ daemonName: "daemon-a" }),
          agentHost: "conductor-fire-debug-1",
          executionHost: null,
          status: "running",
        },
        {
          id: "task-worktree-successor",
          launchConfig: JSON.stringify({
            worktree: true,
            worktree_id: "task-worktree-source",
            worktree_branch: "abc123",
            worktree_base_ref: "main",
            project_repo_root: "/repo",
            project_workspace_path: "/repo/app",
            project_relative_path: "app",
          }),
          metadata: null,
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 2 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          taskId: "task-worktree-source",
          projectId: "proj-1",
          stopTargetHost: "daemon-a",
          reason: "project_deleted",
          taskLabel: "task",
        }),
      );
      expect(db.agentOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            agentHost: "daemon-a",
            taskId: "task-worktree-source",
            eventType: "cleanup_task_worktree",
          }),
        }),
      );
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-source");
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-successor");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-source");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-successor");
    });
  });

  describe("PATCH", () => {
    it("should return 400 when projectId is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects",
        body: { name: "Renamed" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("projectId is required");
    });

    it("should rename project successfully", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst)
        .mockResolvedValueOnce({
          id: "proj-1",
          name: "Original",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: null,
          createdAt: new Date("2024-01-01"),
        } as any)
        .mockResolvedValueOnce(null);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Renamed",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { name: "Renamed" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-1");
      expect(data.name).toBe("Renamed");
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proj-1", userId: "user-1" },
          data: expect.objectContaining({
            name: "Renamed",
            metadata: undefined,
          }),
        }),
      );
    });

    it("hides a non-default project when hidden:true is sent", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: null,
      } as any);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      const hiddenAt = new Date("2026-04-26T10:00:00.000Z");
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt,
        metadata: null,
        createdAt: new Date("2026-04-01"),
        updatedAt: hiddenAt,
      } as any);
      vi.mocked(readProjectSettingsYaml).mockResolvedValueOnce({ icon: "🚀" });

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { hidden: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.hidden).toBe(true);
      expect(data.hiddenAt).toBe(hiddenAt.toISOString());
      expect(data.hidden_at).toBe(hiddenAt.toISOString());
      expect(data.icon).toBe("🚀");
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proj-1", userId: "user-1" },
          data: expect.objectContaining({ hiddenAt: expect.any(Date) }),
        }),
      );
    });

    it("rejects hiding the default project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.defaultProject.findUnique).mockResolvedValue({
        id: "default-map-1",
        userId: "user-1",
        projectId: "proj-default",
      } as any);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-default",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        hiddenAt: null,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-default",
        body: { hidden: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("Default project cannot be hidden");
      expect(db.project.updateMany).not.toHaveBeenCalled();
    });

    it("clears the hidden timestamp when hidden:false is sent", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const previouslyHiddenAt = new Date("2026-04-25T08:00:00.000Z");
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: previouslyHiddenAt,
      } as any);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: null,
        metadata: null,
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-04-26"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { hidden: false },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.hidden).toBe(false);
      expect(data.hiddenAt).toBeNull();
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proj-1", userId: "user-1" },
          data: expect.objectContaining({ hiddenAt: null }),
        }),
      );
    });

    it("preserves the hidden timestamp when hiding an already-hidden project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const existingHiddenAt = new Date("2026-04-25T08:00:00.000Z");
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: existingHiddenAt,
      } as any);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: existingHiddenAt,
        metadata: null,
        createdAt: new Date("2026-04-01"),
        updatedAt: existingHiddenAt,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { hidden: true },
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ hiddenAt: existingHiddenAt }),
        }),
      );
    });

    it("rejects non-boolean hidden values", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { hidden: "yes" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("hidden must be a boolean");
    });

    it("should reject changing the default project binding", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.defaultProject.findUnique).mockResolvedValue({
        id: "default-map-1",
        userId: "user-1",
        projectId: "proj-1",
      } as any);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Default Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: null,
        createdAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: {
          daemonHost: "daemon-a",
          workspacePath: "/repo/new",
          bindingConfirmed: true,
        },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Default project binding cannot be changed");
    });

    it("persists mergeOptOut=true via PATCH", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: null,
      } as any);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 10,
        hiddenAt: null,
        mergeOptOut: true,
        metadata: null,
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      } as any);
      vi.mocked(readProjectSettingsYaml).mockResolvedValueOnce({ icon: "🚀" });

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { mergeOptOut: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.mergeOptOut).toBe(true);
      expect(data.merge_opt_out).toBe(true);
      expect(data.icon).toBe("🚀");
      // Update payload must include the new column.
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proj-1", userId: "user-1" },
          data: expect.objectContaining({ mergeOptOut: true }),
        }),
      );
    });

    it("rejects mergeOptOut writes loudly when the merge columns are missing in the database", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: null,
      } as any);
      vi.mocked(db.project.updateMany).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "The column `projects.merge_opt_out` does not exist in the current database.",
          { code: "P2022", clientVersion: "test" },
        ),
      );

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { mergeOptOut: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(String(data.error)).toContain("pnpm db:push");
    });

    it("re-validates against the daemon and refreshes snapshot fields when refresh:true", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "old-commit",
        fileCount: 10,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "old" }),
        hiddenAt: null,
      } as any);
      vi.mocked(validateProjectBindingWithDaemon).mockResolvedValueOnce({
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
        icon: "🚀",
      });
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: new Date("2026-05-12T14:30:00.000Z"),
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
        hiddenAt: null,
        mergeOptOut: false,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "🚀" }),
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { refresh: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(validateProjectBindingWithDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          daemonHost: "daemon-a",
          workspacePath: "/repo/app",
        }),
      );
      // The DB write should carry the daemon-supplied fields, not the
      // existing project's stale values.
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastCommit: "fresh-commit",
            lastCommitAt: "2026-05-12T14:30:00.000Z",
            gitRemoteUrl: "github.com/foo/bar",
            fileCount: 12,
            metadata: JSON.stringify({ color: "blue", settingsIcon: "🚀" }),
          }),
        }),
      );
      expect(data.lastCommit).toBe("fresh-commit");
      expect(data.lastCommitAt).toBe("2026-05-12T14:30:00.000Z");
      expect(data.gitRemoteUrl).toBe("github.com/foo/bar");
      expect(data.icon).toBe("🚀");
    });

    it("leaves cached icon metadata untouched when refreshing with an old daemon", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "old-commit",
        fileCount: 10,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "old-icon" }),
        hiddenAt: null,
      } as any);
      vi.mocked(validateProjectBindingWithDaemon).mockResolvedValueOnce({
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
      });
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: new Date("2026-05-12T14:30:00.000Z"),
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
        hiddenAt: null,
        mergeOptOut: false,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "old-icon" }),
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { refresh: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: undefined,
          }),
        }),
      );
      expect(data.icon).toBe("old-icon");
    });

    it("drops oversized daemon icons instead of caching oversized metadata", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const oversizedIcon = `data:image/png;base64,${"a".repeat(193 * 1024)}`;
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "old-commit",
        fileCount: 10,
        metadata: JSON.stringify({ color: "blue", settingsIcon: "old-icon" }),
        hiddenAt: null,
      } as any);
      vi.mocked(validateProjectBindingWithDaemon).mockResolvedValueOnce({
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: "2026-05-12T14:30:00.000Z",
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
        icon: oversizedIcon,
      });
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Demo",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "fresh-commit",
        lastCommitAt: new Date("2026-05-12T14:30:00.000Z"),
        gitRemoteUrl: "github.com/foo/bar",
        fileCount: 12,
        hiddenAt: null,
        mergeOptOut: false,
        metadata: JSON.stringify({ color: "blue" }),
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { refresh: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: JSON.stringify({ color: "blue" }),
          }),
        }),
      );
      expect(data.icon).toBeNull();
    });

    it("refuses refresh:true when the project has no confirmed binding", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-default",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        hiddenAt: null,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-default",
        body: { refresh: true },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(String(data.error)).toContain("no confirmed binding");
      expect(validateProjectBindingWithDaemon).not.toHaveBeenCalled();
    });

    it("rejects combining refresh:true with caller-supplied binding fields", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce({
        id: "proj-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        hiddenAt: null,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: {
          refresh: true,
          repoRoot: "/repo/manual",
          bindingConfirmed: true,
        },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(String(data.error)).toContain("refresh");
    });
  });
});
