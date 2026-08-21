import { db } from "@/lib/db";
import {
  deleteTaskAttachmentByStorageKey,
  pruneOrphanedTaskAttachmentFiles,
  taskAttachmentTtlMs,
} from "@/lib/tasks/task-file-storage";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DELETE_RETRY_BACKOFF_MS = 5 * 60_000;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export async function reconcileOrphanedTaskAttachmentFiles(now = new Date()): Promise<number> {
  const records = await db.taskAttachment.findMany({ select: { storageKey: true } });
  return pruneOrphanedTaskAttachmentFiles(
    new Set(records.map((record) => record.storageKey)),
    new Date(now.getTime() - ORPHAN_GRACE_MS),
  );
}

function sweepIntervalMs(): number {
  const parsed = Number.parseInt(process.env.CONDUCTOR_ATTACHMENT_SWEEP_INTERVAL_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_SWEEP_INTERVAL_MS;
}

export async function pruneExpiredStagedTaskAttachments(now = new Date()): Promise<number> {
  const candidates = await db.taskAttachment.findMany({
    where: {
      status: { in: ["uploaded", "expiring"] },
      messageId: null,
      expiresAt: { lte: now },
    },
    select: { id: true, taskId: true, storageKey: true, status: true },
    orderBy: { expiresAt: "asc" },
    take: 100,
  });

  let deleted = 0;
  for (const candidate of candidates) {
    if (candidate.status === "uploaded") {
      const claimed = await db.taskAttachment.updateMany({
        where: {
          id: candidate.id,
          status: "uploaded",
          messageId: null,
          expiresAt: { lte: now },
        },
        data: { status: "expiring" },
      });
      if (claimed.count !== 1) continue;
    }

    try {
      await deleteTaskAttachmentByStorageKey(candidate.taskId, candidate.storageKey);
    } catch {
      // Keep the claimed row so a later sweep can retry without allowing the
      // attachment to be rebound while its file deletion is uncertain.
      await db.taskAttachment.updateMany({
        where: { id: candidate.id, status: "expiring", messageId: null },
        data: { expiresAt: new Date(now.getTime() + DELETE_RETRY_BACKOFF_MS) },
      }).catch(() => undefined);
      continue;
    }
    const result = await db.taskAttachment.deleteMany({
      where: { id: candidate.id, status: "expiring", messageId: null },
    });
    deleted += result.count;
  }
  return deleted;
}

/**
 * Reclaim disk for attachments the Daemon already downloaded and verified.
 * Once an attachment is `materialized` the Daemon owns a SHA-256 verified copy
 * in the task worktree, so the Web copy is only needed for browser preview.
 * The row is kept (status `pruned`) so message history still renders the file
 * name, size and kind after the bytes are gone.
 *
 * `bound` attachments are deliberately excluded: nobody has confirmed a remote
 * copy yet, and deleting one would strand the message forever.
 */
export async function pruneMaterializedTaskAttachmentFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - taskAttachmentTtlMs());
  const candidates = await db.taskAttachment.findMany({
    where: { status: "materialized", materializedAt: { lte: cutoff } },
    select: { id: true, taskId: true, storageKey: true },
    orderBy: { materializedAt: "asc" },
    take: 100,
  });

  let pruned = 0;
  for (const candidate of candidates) {
    try {
      await deleteTaskAttachmentByStorageKey(candidate.taskId, candidate.storageKey);
    } catch {
      // Leave the row as `materialized` so the next sweep retries the deletion.
      continue;
    }
    const result = await db.taskAttachment.updateMany({
      where: { id: candidate.id, status: "materialized" },
      data: { status: "pruned" },
    });
    pruned += result.count;
  }
  return pruned;
}

export function startTaskAttachmentJanitor(log: Pick<Console, "info" | "error"> = console): NodeJS.Timeout {
  let sweepCount = 0;
  const timer = setInterval(() => {
    void pruneExpiredStagedTaskAttachments()
      .then(async (deletedCount) => {
        if (deletedCount > 0) log.info?.(`[attachments] pruned ${deletedCount} expired staged attachment(s)`);
        const prunedCount = await pruneMaterializedTaskAttachmentFiles();
        if (prunedCount > 0) log.info?.(`[attachments] released ${prunedCount} delivered attachment file(s)`);
        sweepCount += 1;
        if (sweepCount % 60 === 0) {
          const orphanCount = await reconcileOrphanedTaskAttachmentFiles();
          if (orphanCount > 0) log.info?.(`[attachments] pruned ${orphanCount} orphaned attachment file(s)`);
        }
      })
      .catch((error) => {
        log.error?.(`[attachments] failed to prune staged attachments: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, sweepIntervalMs());
  timer.unref?.();
  return timer;
}
