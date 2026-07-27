import { db } from "@/lib/db";
import { resolveAchievedTaskDaemonHost } from "@/lib/tasks/achieved-daemon";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";

export interface AchievedTaskSearchResult {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  backendType: string | null;
  agentHost: string | null;
  daemonHost: string | null;
  status: string;
  achievedAt: string;
  createdAt: string;
  snippet: string | null;
  messageCount: number;
}

const DEFAULT_LIMIT = 100;
const SNIPPET_RADIUS = 90;

const buildAchievedTaskWhere = (args: {
  userId: string;
  query?: string | null;
  daemonHost?: string | null;
  projectIds?: string[] | null;
}): Record<string, unknown> => {
  const query = (args.query ?? "").trim();
  const daemonHost = (args.daemonHost ?? "").trim();
  const projectIds = [...new Set(
    (args.projectIds ?? []).flatMap((projectId) => {
      const normalized = projectId.trim();
      return normalized ? [normalized] : [];
    }),
  )];
  const where: Record<string, unknown> = {
    project: {
      userId: args.userId,
      ...(daemonHost ? { daemonHost } : {}),
      ...(projectIds.length === 1
        ? { id: projectIds[0] }
        : projectIds.length > 1
          ? { id: { in: projectIds } }
          : {}),
    },
    achievedAt: { not: null },
  };
  if (query) {
    where.OR = [
      { title: { contains: query } },
      { messages: { some: { content: { contains: query } } } },
    ];
  }
  return where;
};

/**
 * Extract a short snippet around the first case-insensitive occurrence of
 * `query` in `content`. Returns null when there is no match.
 */
const buildSnippet = (content: string, query: string): string | null => {
  if (!query) return null;
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(content.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
};

/**
 * Search a user's achieved (packed) tasks by title and transcript content.
 *
 * Current implementation: SQLite `LIKE` scan (Prisma `contains`) scoped to the
 * user + `achievedAt != null`, which is cheap because the achieved set is small
 * and low-traffic. Kept behind this single function so it can later be swapped
 * for an FTS5 virtual table + `MATCH` without touching callers.
 */
export const searchAchievedTasks = async (args: {
  userId: string;
  query?: string | null;
  daemonHost?: string | null;
  projectIds?: string[] | null;
  limit?: number;
  offset?: number;
}): Promise<AchievedTaskSearchResult[]> => {
  const query = (args.query ?? "").trim();
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), 500);
  const offset = Math.max(args.offset ?? 0, 0);
  const baseWhere = buildAchievedTaskWhere(args);

  const tasks = await db.task.findMany({
    where: baseWhere,
    orderBy: { achievedAt: "desc" },
    skip: offset,
    take: limit,
    select: {
      id: true,
      title: true,
      projectId: true,
      backendType: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      status: true,
      achievedAt: true,
      createdAt: true,
      project: { select: { name: true, daemonHost: true } },
      _count: { select: { messages: true } },
    },
  });

  // Snippet + content-match: only when there is a query. Fetch at most one
  // matching message per result task. A single `findMany` across all results
  // looks cheaper, but it has no per-task limit and can materialize thousands
  // of matching transcript rows just to keep the first ten snippets.
  const snippetByTask = new Map<string, string>();
  if (query && tasks.length > 0) {
    const matches = await Promise.all(
      tasks.map(async (task) => ({
        taskId: task.id,
        message: await db.message.findFirst({
          where: {
            taskId: task.id,
            content: { contains: query },
          },
          orderBy: { createdAt: "asc" },
          select: { content: true },
        }),
      })),
    );
    for (const match of matches) {
      if (!match.message) continue;
      const snippet = buildSnippet(match.message.content, query);
      if (snippet) snippetByTask.set(match.taskId, snippet);
    }
  }

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    projectId: t.projectId ?? null,
    projectName: t.project?.name ?? null,
    backendType: t.backendType ?? null,
    agentHost: t.agentHost ?? null,
    daemonHost: resolveAchievedTaskDaemonHost(t),
    status: normalizeTaskStatus(t.status),
    achievedAt: (t.achievedAt as Date).toISOString(),
    createdAt: t.createdAt.toISOString(),
    snippet: snippetByTask.get(t.id) ?? null,
    messageCount: t._count?.messages ?? 0,
  }));
};

export const countAchievedTasks = async (args: {
  userId: string;
  query?: string | null;
  daemonHost?: string | null;
  projectIds?: string[] | null;
}): Promise<number> => {
  return db.task.count({
    where: buildAchievedTaskWhere(args),
  });
};
