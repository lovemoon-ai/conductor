import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  ProjectBindingValidationError,
  validateProjectBindingWithDaemon,
} from "@/lib/projects/daemon-binding";

/**
 * Cross-daemon project merging keys off `gitRemoteUrl`. Projects created
 * before the merge feature shipped (or projects whose first daemon validation
 * happened while the workspace was offline) carry a NULL `gitRemoteUrl` and
 * therefore never merge — even when the user upgraded both client and daemon.
 *
 * To unstick those rows without forcing the user to refresh each project
 * manually, the agent gateway calls `backfillStaleProjectBindings` every time
 * a daemon (re)connects. We scan the user's projects on that daemon for rows
 * still missing `gitRemoteUrl`, ask the daemon to re-snapshot each workspace,
 * and write back any fields that came up null.
 *
 * Design constraints:
 *  - Idempotent. `gitRemoteUrl IS NULL` is the entry guard, and we never
 *    overwrite a non-null value with null, so repeat runs (e.g. flapping
 *    daemons) cause no churn.
 *  - Bounded. Capped at MAX_PROJECTS_PER_RUN per connect, with a small delay
 *    between RPCs so a daemon that just rebooted isn't flooded.
 *  - Non-blocking. The caller invokes us with `void` — backfill must never
 *    delay agent registration or task draining.
 *  - Fault-tolerant. Validation errors (`workspace_not_found`, timeout) are
 *    logged and skipped; the row keeps its existing fields so a workspace
 *    that's only temporarily unavailable isn't wiped.
 */

const MAX_PROJECTS_PER_RUN = 50;
const PER_PROJECT_DELAY_MS = 200;
const VALIDATION_TIMEOUT_MS = 5_000;

/** Dedup concurrent runs for the same (user, daemon) tuple. */
const inflight = new Map<string, Promise<BackfillResult>>();

const inflightKey = (userId: string, daemonHost: string): string =>
  `${userId}::${daemonHost}`;

export type BackfillResult = {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
};

const isMissingMergeColumnsError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2022" &&
  (error.message.includes("git_remote_url") ||
    error.message.includes("gitRemoteUrl"));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find projects on this daemon that still need a `gitRemoteUrl` and ask the
 * daemon to fill them in. Returns a small summary so callers (or tests) can
 * verify the run did something.
 *
 * Safe to call multiple times — concurrent calls for the same
 * (userId, daemonHost) share one in-flight promise, and the SQL filter
 * (`gitRemoteUrl IS NULL`) makes the run idempotent.
 */
export async function backfillStaleProjectBindings(params: {
  userId: string;
  daemonHost: string;
  /** Optional override for tests; production should rely on the default. */
  validationTimeoutMs?: number;
  /** Optional override for tests so they don't pay the 200ms cost. */
  perProjectDelayMs?: number;
}): Promise<BackfillResult> {
  const { userId, daemonHost } = params;
  const key = inflightKey(userId, daemonHost);
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = runBackfill(params).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function runBackfill(params: {
  userId: string;
  daemonHost: string;
  validationTimeoutMs?: number;
  perProjectDelayMs?: number;
}): Promise<BackfillResult> {
  const {
    userId,
    daemonHost,
    validationTimeoutMs = VALIDATION_TIMEOUT_MS,
    perProjectDelayMs = PER_PROJECT_DELAY_MS,
  } = params;

  const result: BackfillResult = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  let stale: Array<{ id: string; workspacePath: string | null }>;
  try {
    stale = await db.project.findMany({
      where: {
        userId,
        daemonHost,
        workspacePath: { not: null },
        gitRemoteUrl: null,
        hiddenAt: null,
      },
      select: { id: true, workspacePath: true },
      take: MAX_PROJECTS_PER_RUN,
      orderBy: { createdAt: "asc" },
    });
  } catch (error) {
    if (isMissingMergeColumnsError(error)) {
      // DB hasn't run the merge-columns migration yet; nothing to backfill.
      console.warn(
        `[project-backfill] skipping: merge columns missing on this database`,
      );
      return result;
    }
    throw error;
  }

  result.scanned = stale.length;
  if (stale.length === 0) {
    return result;
  }

  console.log(
    `[project-backfill] start: userId=${userId}, daemonHost=${daemonHost}, candidates=${stale.length}`,
  );

  const processRow = async (row: (typeof stale)[number]) => {
    if (!row.workspacePath) {
      return { updated: 0, skipped: 1, errors: 0 };
    }
    try {
      const snapshot = await validateProjectBindingWithDaemon({
        userId,
        daemonHost,
        workspacePath: row.workspacePath,
        timeoutMs: validationTimeoutMs,
      });

      // Only commit fields the daemon actually returned. If the workspace
      // isn't a git repo, `gitRemoteUrl` stays null and we mark it skipped
      // rather than logging an error — that's a perfectly valid state, just
      // not one this backfill can fix.
      if (!snapshot.gitRemoteUrl) {
        return { updated: 0, skipped: 1, errors: 0 };
      }

      await db.project.update({
        where: { id: row.id },
        data: {
          // Refresh the full snapshot so derived UI fields (branch, last
          // commit, file count) also catch up with the workspace state on
          // disk, but never blank an existing value with null.
          ...(snapshot.repoRoot !== null ? { repoRoot: snapshot.repoRoot } : {}),
          ...(snapshot.worktreeBranch !== null
            ? { worktreeBranch: snapshot.worktreeBranch }
            : {}),
          ...(snapshot.lastCommit !== null
            ? { lastCommit: snapshot.lastCommit }
            : {}),
          gitRemoteUrl: snapshot.gitRemoteUrl,
          ...(snapshot.fileCount !== null
            ? { fileCount: snapshot.fileCount }
            : {}),
        },
      });
      console.log(
        `[project-backfill] updated project=${row.id} gitRemoteUrl=${snapshot.gitRemoteUrl}`,
      );
      return { updated: 1, skipped: 0, errors: 0 };
    } catch (error) {
      if (error instanceof ProjectBindingValidationError) {
        // Expected, non-fatal: workspace moved, daemon temporarily lost it,
        // or daemon disconnected mid-run. Leave the row alone so the next
        // reconnect can try again.
        console.warn(
          `[project-backfill] skip project=${row.id} (${
            error.code ?? "validation_error"
          }): ${error.message}`,
        );
        return { updated: 0, skipped: 1, errors: 0 };
      }
      console.error(
        `[project-backfill] unexpected error for project=${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { updated: 0, skipped: 0, errors: 1 };
    }
  };

  const rowResults = perProjectDelayMs > 0
    ? await (async () => {
        const sequentialResults: Array<{ updated: number; skipped: number; errors: number }> = [];
        for (const row of stale) {
          sequentialResults.push(await processRow(row));
          await sleep(perProjectDelayMs);
        }
        return sequentialResults;
      })()
    : await Promise.all(stale.map((row) => processRow(row)));

  for (const rowResult of rowResults) {
    result.updated += rowResult.updated;
    result.skipped += rowResult.skipped;
    result.errors += rowResult.errors;
  }

  console.log(
    `[project-backfill] done: userId=${userId}, daemonHost=${daemonHost}, scanned=${result.scanned}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors}`,
  );
  return result;
}

/**
 * Test-only helper: clear the in-flight dedup map so each test starts clean.
 * Not exported from any index; importers reach in by path. We keep this
 * deliberately tiny so production code paths don't accidentally rely on it.
 */
export const __resetBackfillInflightForTests = (): void => {
  inflight.clear();
};
