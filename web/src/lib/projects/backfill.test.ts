import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBackfillInflightForTests,
  backfillStaleProjectBindings,
} from "./backfill";
import { ProjectBindingValidationError } from "./daemon-binding";

const { dbMock, validateMock } = vi.hoisted(() => ({
  dbMock: {
    project: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  validateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

vi.mock("./daemon-binding", async () => {
  const actual = await vi.importActual<typeof import("./daemon-binding")>(
    "./daemon-binding",
  );
  return {
    ...actual,
    validateProjectBindingWithDaemon: validateMock,
  };
});

const baseSnapshot = {
  daemonHost: "daemon-a",
  workspacePath: "/repo/alpha",
  repoRoot: "/repo/alpha",
  worktreeBranch: "main",
  lastCommit: "abc123",
  gitRemoteUrl: "github.com/owner/alpha",
  fileCount: 42,
};

describe("backfillStaleProjectBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBackfillInflightForTests();
  });

  it("returns zero counts when no stale rows exist", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([]);

    const result = await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(result).toEqual({ scanned: 0, updated: 0, skipped: 0, errors: 0 });
    expect(validateMock).not.toHaveBeenCalled();
    expect(dbMock.project.update).not.toHaveBeenCalled();
  });

  it("writes back gitRemoteUrl when the daemon snapshot returns one", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([
      { id: "p-1", workspacePath: "/repo/alpha" },
    ]);
    validateMock.mockResolvedValueOnce(baseSnapshot);
    dbMock.project.update.mockResolvedValueOnce({});

    const result = await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, errors: 0 });
    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/alpha",
      }),
    );
    expect(dbMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-1" },
        data: expect.objectContaining({
          gitRemoteUrl: "github.com/owner/alpha",
          repoRoot: "/repo/alpha",
        }),
      }),
    );
  });

  it("skips rows whose workspace is not a git repo (snapshot.gitRemoteUrl is null)", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([
      { id: "p-1", workspacePath: "/tmp/scratch" },
    ]);
    validateMock.mockResolvedValueOnce({
      ...baseSnapshot,
      repoRoot: null,
      worktreeBranch: null,
      lastCommit: null,
      gitRemoteUrl: null,
      fileCount: null,
    });

    const result = await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 1, errors: 0 });
    expect(dbMock.project.update).not.toHaveBeenCalled();
  });

  it("skips rows when the daemon reports a workspace error and leaves them untouched", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([
      { id: "p-1", workspacePath: "/repo/missing" },
    ]);
    validateMock.mockRejectedValueOnce(
      new ProjectBindingValidationError(
        "Workspace path does not exist",
        400,
        "workspace_not_found",
      ),
    );

    const result = await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 1, errors: 0 });
    expect(dbMock.project.update).not.toHaveBeenCalled();
  });

  it("counts unexpected errors separately without aborting the run", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([
      { id: "p-1", workspacePath: "/repo/alpha" },
      { id: "p-2", workspacePath: "/repo/beta" },
    ]);
    validateMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ...baseSnapshot,
        workspacePath: "/repo/beta",
        gitRemoteUrl: "github.com/owner/beta",
      });
    dbMock.project.update.mockResolvedValueOnce({});

    const result = await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(result).toEqual({ scanned: 2, updated: 1, skipped: 0, errors: 1 });
    expect(dbMock.project.update).toHaveBeenCalledTimes(1);
    expect(dbMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-2" },
        data: expect.objectContaining({
          gitRemoteUrl: "github.com/owner/beta",
        }),
      }),
    );
  });

  it("dedups concurrent calls for the same (userId, daemonHost)", async () => {
    let resolveFindMany!: (rows: unknown[]) => void;
    dbMock.project.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFindMany = resolve as typeof resolveFindMany;
        }),
    );

    const first = backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });
    const second = backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    // The exported function is `async`, so each call creates a fresh outer
    // Promise even when the body returns the cached one — reference equality
    // on the returned Promises is therefore meaningless. The strong signal is
    // that the second call must not trigger a second DB scan.
    resolveFindMany([]);
    await Promise.all([first, second]);

    expect(dbMock.project.findMany).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh run after the previous one settles", async () => {
    dbMock.project.findMany.mockResolvedValueOnce([]);
    await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    dbMock.project.findMany.mockResolvedValueOnce([]);
    await backfillStaleProjectBindings({
      userId: "user-1",
      daemonHost: "daemon-a",
      perProjectDelayMs: 0,
    });

    expect(dbMock.project.findMany).toHaveBeenCalledTimes(2);
  });
});
