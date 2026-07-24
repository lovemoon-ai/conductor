// RFC 0029: helpers around the Task.killed_reason discriminator.
//
// The Task model now carries `killedReason` + `killedAt` so the restart path
// can tell apart "the user pressed Stop" (do not reclaim) from "we tripped a
// defensive timeout on a probably-still-healthy fire" (reclaim if possible).
// These helpers centralise the soft enum and let DB writes opt into the new
// columns without forcing every call-site through a giant Prisma `data`
// spread.

import type { PrismaClient } from "@prisma/client";

const KILLED_REASONS = [
  "user_stopped",
  "daemon_disconnected",
  "fire_exit",
  "crash",
  "unknown",
] as const;

export type KilledReason = (typeof KILLED_REASONS)[number];

export const RECLAIMABLE_KILLED_REASON: KilledReason = "daemon_disconnected";

export const isKilledReason = (value: unknown): value is KilledReason =>
  typeof value === "string" && KILLED_REASONS.includes(value as KilledReason);

export const normalizeKilledReason = (value: unknown): KilledReason => {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim().toLowerCase();
  return isKilledReason(trimmed) ? (trimmed as KilledReason) : "unknown";
};

/**
 * Returns the `data` patch used when a task transitions into `killed`.
 *
 * Centralised so we don't pepper every kill-site with the same two fields
 * (and so the column adds are no-op-safe if some yet-to-be-migrated SQLite
 * instance is missing the columns — callers can wrap with `withKilledReasonFallback`).
 */
export const buildKilledPatch = (
  reason: KilledReason,
  options: { killedAt?: Date } = {},
): { status: "killed"; killedReason: KilledReason; killedAt: Date } => ({
  status: "killed",
  killedReason: reason,
  killedAt: options.killedAt ?? new Date(),
});

/**
 * Returns a `data` patch that *revokes* a prior killed state (used by the
 * `daemon_disconnected` reclaim path: the fire was alive all along, so the
 * defensive killed entry should be wiped, not just hidden).
 */
export const buildKilledRevokePatch = (): {
  status: "running";
  killedReason: null;
  killedAt: null;
} => ({
  status: "running",
  killedReason: null,
  killedAt: null,
});

/**
 * Detects errors from a Prisma write that referenced `killed_reason` or
 * `killed_at` against a DB that has not run the 20260523120000 migration yet.
 * Mirrors the existing `isMissingPtySchemaError` style so legacy SQLite
 * instances can keep stopping tasks without 500s.
 */
export const isMissingKilledReasonSchemaError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? "";
  if (code === "P2022") {
    return /killed_reason|killed_at/i.test(message);
  }
  return /no such column.*killed_(reason|at)|killed_(reason|at).*does not exist/i.test(
    message,
  );
};

/**
 * Wraps a Prisma `task.update` style call so that if the underlying DB
 * predates the killed_reason migration, we silently fall back to a write
 * that omits the new fields. Callers MUST pass two builders: one for the
 * full data and one without the killed_reason fields.
 */
export async function withKilledReasonFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (isMissingKilledReasonSchemaError(error)) {
      return fallback();
    }
    throw error;
  }
}

/**
 * Best-effort write of just the killed_reason discriminator onto an existing
 * killed row. Used by sites that have already issued the `status: killed`
 * update before this RFC and want to layer the reason in without rewriting
 * the original transaction. Logs and swallows schema-missing errors.
 */
export async function tagKilledReason(
  db: PrismaClient,
  taskId: string,
  reason: KilledReason,
): Promise<void> {
  try {
    await db.task.update({
      where: { id: taskId },
      data: buildKilledPatch(reason),
    });
  } catch (error) {
    if (isMissingKilledReasonSchemaError(error)) {
      return;
    }
    throw error;
  }
}
