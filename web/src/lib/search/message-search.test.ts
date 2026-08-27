import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    message: { findMany: vi.fn() },
  },
}));

const { db } = await import("@/lib/db");
const {
  buildFtsMatchQuery,
  searchMessages,
  backfillMessageSearchIndex,
  __setFtsAvailableForTests,
  __resetFtsStateForTests,
} = await import("@/lib/search/message-search");

const OLD_DB_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_DIALECT: process.env.DB_DIALECT,
};

afterEach(() => {
  vi.clearAllMocks();
  __setFtsAvailableForTests(false);
  process.env.DATABASE_URL = OLD_DB_ENV.DATABASE_URL;
  process.env.DB_DIALECT = OLD_DB_ENV.DB_DIALECT;
});

describe("buildFtsMatchQuery", () => {
  it("turns bare terms into AND-ed quoted prefix terms", () => {
    expect(buildFtsMatchQuery("api contract")).toBe('"api"* "contract"*');
  });

  it("neutralises FTS syntax characters", () => {
    expect(buildFtsMatchQuery('foo* "bar')).toBe('"foo"* "bar"*');
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(buildFtsMatchQuery("   ")).toBe("");
  });
});

describe("searchMessages (FTS backend)", () => {
  it("queries the FTS index scoped to the user and maps rows", async () => {
    __setFtsAvailableForTests(true);
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        message_id: "m-1",
        task_id: "t-1",
        role: "assistant",
        created_at: "2024-05-01T00:00:00.000Z",
        task_title: "Ship the API",
        snippet: "the [api] contract",
      },
    ]);
    const client = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: queryRawUnsafe,
    };

    const result = await searchMessages({
      userId: "user-1",
      query: "api",
      client,
    });

    expect(result.backend).toBe("fts");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      taskId: "t-1",
      taskTitle: "Ship the API",
      messageId: "m-1",
      role: "assistant",
      snippet: "the [api] contract",
    });
    // The MATCH expression and the ownership user id are both bound.
    const args = queryRawUnsafe.mock.calls[0];
    expect(args[1]).toBe('"api"*');
    expect(args[2]).toBe("user-1");
  });

  it("lazily self-initializes the FTS schema when the boot flag is unset", async () => {
    // Reproduces the Next.js production boundary: the route module instance
    // never had its boot flag set, so searchMessages must resolve availability
    // itself instead of defaulting to the LIKE fallback.
    __resetFtsStateForTests();
    process.env.DATABASE_URL = "file:/tmp/does-not-matter.db";
    process.env.DB_DIALECT = "sqlite";
    const executeRawUnsafe = vi.fn().mockResolvedValue(0);
    const client = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          message_id: "m-9",
          task_id: "t-9",
          role: "user",
          created_at: "2024-06-01T00:00:00.000Z",
          task_title: "Lazy",
          snippet: "[api]",
        },
      ]),
    };

    const result = await searchMessages({ userId: "u1", query: "api", client });

    // The schema was ensured lazily (CREATE VIRTUAL TABLE / triggers ran)...
    expect(executeRawUnsafe).toHaveBeenCalled();
    // ...and the query used the FTS index rather than falling back to LIKE.
    expect(result.backend).toBe("fts");
    expect(result.hits[0]?.messageId).toBe("m-9");
  });

  it("falls back to LIKE when the FTS query throws", async () => {
    __setFtsAvailableForTests(true);
    const client = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("malformed MATCH")),
    };
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "m-2",
        role: "user",
        content: "please check the API contract carefully",
        createdAt: new Date("2024-05-02T00:00:00.000Z"),
        taskId: "t-2",
        task: { title: "Contract work" },
      },
    ] as never);

    const result = await searchMessages({ userId: "user-1", query: "API", client });

    expect(result.backend).toBe("like");
    expect(result.hits[0]).toMatchObject({ taskId: "t-2", messageId: "m-2" });
    expect(result.hits[0].snippet.toLowerCase()).toContain("api");
  });
});

describe("backfillMessageSearchIndex", () => {
  it("skips the expensive scan when the index is already in sync", async () => {
    __setFtsAvailableForTests(true);
    const executeRawUnsafe = vi.fn();
    const client = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ missing: 0 }]),
    };
    const result = await backfillMessageSearchIndex(client as never);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("runs the backfill INSERT when the index is behind", async () => {
    __setFtsAvailableForTests(true);
    const executeRawUnsafe = vi.fn().mockResolvedValue(0);
    const client = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ missing: 3 }]),
    };
    const result = await backfillMessageSearchIndex(client as never);
    expect(result).toEqual({ ok: true });
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe.mock.calls[0][0]).toContain("INSERT INTO");
  });

  it("reports unavailable when FTS is not initialized", async () => {
    __setFtsAvailableForTests(false);
    const result = await backfillMessageSearchIndex({
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    } as never);
    expect(result).toEqual({ ok: false, error: "fts-unavailable" });
  });
});

describe("searchMessages (LIKE backend)", () => {
  it("scopes the LIKE scan to the user's tasks", async () => {
    __setFtsAvailableForTests(false);
    vi.mocked(db.message.findMany).mockResolvedValue([] as never);

    const result = await searchMessages({ userId: "user-9", query: "hello", limit: 5 });

    expect(result.backend).toBe("like");
    const arg = vi.mocked(db.message.findMany).mock.calls[0][0] as {
      where: { content: { contains: string }; task: { project: { userId: string } } };
      take: number;
    };
    expect(arg.where.content).toEqual({ contains: "hello" });
    expect(arg.where.task.project.userId).toBe("user-9");
    expect(arg.take).toBe(5);
  });

  it("returns no hits for an empty query without hitting the database", async () => {
    __setFtsAvailableForTests(false);
    const result = await searchMessages({ userId: "user-1", query: "   " });
    expect(result.hits).toEqual([]);
    expect(db.message.findMany).not.toHaveBeenCalled();
  });
});
