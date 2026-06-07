/**
 * RFC 0032: per-user catchphrase library.
 *
 * Each row is a short phrase the user frequently sends to AI. The set is
 * global to the user (cross-project) and surfaced in the chat composer via
 * an empty-input double-click popover.
 *
 * Storage uses a dedicated `user_catchphrases` table (Option B in the RFC)
 * so we can have per-row timestamps, per-row reorder, and future
 * `lastUsedAt`-based ranking without rewriting one giant JSON blob.
 */
import { db } from "@/lib/db";
import { z } from "zod";
import {
  MAX_CATCHPHRASES_PER_USER,
  MAX_CATCHPHRASE_TEXT_LENGTH,
} from "@/features/catchphrases/limits";

export { MAX_CATCHPHRASES_PER_USER, MAX_CATCHPHRASE_TEXT_LENGTH };

export const catchphraseTextSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, "Catchphrase text must not be empty")
      .max(MAX_CATCHPHRASE_TEXT_LENGTH, `Catchphrase text must be at most ${MAX_CATCHPHRASE_TEXT_LENGTH} characters`),
  );

export const createCatchphraseSchema = z.object({
  text: catchphraseTextSchema,
});

export const updateCatchphraseSchema = z.object({
  text: catchphraseTextSchema,
});

export const reorderCatchphrasesSchema = z.object({
  /**
   * Ordered list of catchphrase ids — index = new sortOrder. The server
   * rewrites `sort_order` to be 0..N-1 matching this array, so callers do
   * not have to pre-compute integers.
   */
  ids: z
    .array(z.string().min(1))
    .max(MAX_CATCHPHRASES_PER_USER)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: "Duplicate ids are not allowed in a reorder payload",
    }),
});

export type Catchphrase = {
  id: string;
  text: string;
  sortOrder: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class CatchphraseLimitReachedError extends Error {
  constructor() {
    super(`You can have at most ${MAX_CATCHPHRASES_PER_USER} catchphrases.`);
    this.name = "CatchphraseLimitReachedError";
  }
}

export class CatchphraseNotFoundError extends Error {
  constructor() {
    super("Catchphrase not found.");
    this.name = "CatchphraseNotFoundError";
  }
}

const toClient = (row: {
  id: string;
  text: string;
  sortOrder: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Catchphrase => ({
  id: row.id,
  text: row.text,
  sortOrder: row.sortOrder,
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listCatchphrases(userId: string): Promise<Catchphrase[]> {
  const rows = await db.userCatchphrase.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toClient);
}

export async function createCatchphrase(userId: string, text: string): Promise<Catchphrase> {
  // NOTE on concurrency: SQLite (the dev/self-host target) serialises
  // writers, so this count→create pair is effectively atomic. On Postgres
  // at READ COMMITTED two concurrent transactions can both observe
  // count<100 and both insert, briefly pushing a single user above the
  // soft cap (e.g. 101). We accept that — the cap is a UX guardrail, not
  // a security invariant, and the popover list still renders fine. If
  // future product needs a strict cap on Postgres, switch this transaction
  // to SERIALIZABLE or take an advisory lock keyed on userId.
  return db.$transaction(async (tx) => {
    const count = await tx.userCatchphrase.count({ where: { userId } });
    if (count >= MAX_CATCHPHRASES_PER_USER) {
      throw new CatchphraseLimitReachedError();
    }
    // Append: place new row at max(sortOrder)+1 to preserve user-defined order.
    const last = await tx.userCatchphrase.findFirst({
      where: { userId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const nextSortOrder = (last?.sortOrder ?? -1) + 1;
    const row = await tx.userCatchphrase.create({
      data: {
        userId,
        text,
        sortOrder: nextSortOrder,
      },
    });
    return toClient(row);
  });
}

export async function updateCatchphrase(
  userId: string,
  id: string,
  text: string,
): Promise<Catchphrase> {
  // Cross-user isolation: only update if userId+id both match. updateMany
  // returns count; a 0-count means either the row is gone or belongs to
  // another user — both surface as not-found to the caller.
  const result = await db.userCatchphrase.updateMany({
    where: { id, userId },
    data: { text },
  });
  if (result.count === 0) {
    throw new CatchphraseNotFoundError();
  }
  // Re-fetch through (id, userId) so a concurrent delete or any future
  // refactor cannot leak a row that belongs to someone else.
  const row = await db.userCatchphrase.findFirst({ where: { id, userId } });
  if (!row) {
    throw new CatchphraseNotFoundError();
  }
  return toClient(row);
}

export async function deleteCatchphrase(userId: string, id: string): Promise<void> {
  const result = await db.userCatchphrase.deleteMany({
    where: { id, userId },
  });
  if (result.count === 0) {
    throw new CatchphraseNotFoundError();
  }
}

export class CatchphraseReorderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatchphraseReorderMismatchError";
  }
}

export async function reorderCatchphrases(
  userId: string,
  orderedIds: string[],
): Promise<Catchphrase[]> {
  // The Zod schema already enforced uniqueness in orderedIds. Inside the
  // transaction we additionally require that the supplied ids EXACTLY
  // match the user's current set — same length, same membership. Any
  // mismatch (missing or unknown id) means the client's view of the world
  // is stale; we refuse the write so the rest of the rows don't end up
  // with colliding sort_order values silently.
  await db.$transaction(async (tx) => {
    const owned = await tx.userCatchphrase.findMany({
      where: { userId },
      select: { id: true },
    });
    if (owned.length !== orderedIds.length) {
      throw new CatchphraseReorderMismatchError(
        `Reorder payload length ${orderedIds.length} does not match current count ${owned.length}.`,
      );
    }
    const ownedSet = new Set(owned.map((row) => row.id));
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) {
        throw new CatchphraseReorderMismatchError(
          `Reorder payload contains id "${id}" not owned by user.`,
        );
      }
    }
    for (let i = 0; i < orderedIds.length; i += 1) {
      await tx.userCatchphrase.update({
        where: { id: orderedIds[i] },
        data: { sortOrder: i },
      });
    }
  });
  return listCatchphrases(userId);
}

export async function touchCatchphrase(userId: string, id: string): Promise<Catchphrase> {
  const result = await db.userCatchphrase.updateMany({
    where: { id, userId },
    data: { lastUsedAt: new Date() },
  });
  if (result.count === 0) {
    throw new CatchphraseNotFoundError();
  }
  const row = await db.userCatchphrase.findFirst({ where: { id, userId } });
  if (!row) {
    throw new CatchphraseNotFoundError();
  }
  return toClient(row);
}
