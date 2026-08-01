import { db } from "@/lib/db";
import { deleteTaskAttachmentByStorageKey } from "@/lib/tasks/task-file-storage";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

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
      continue;
    }
    const result = await db.taskAttachment.deleteMany({
      where: { id: candidate.id, status: "expiring", messageId: null },
    });
    deleted += result.count;
  }
  return deleted;
}

export function startTaskAttachmentJanitor(log: Pick<Console, "info" | "error"> = console): NodeJS.Timeout {
  const timer = setInterval(() => {
    void pruneExpiredStagedTaskAttachments()
      .then((deletedCount) => {
        if (deletedCount > 0) log.info?.(`[attachments] pruned ${deletedCount} expired staged attachment(s)`);
      })
      .catch((error) => {
        log.error?.(`[attachments] failed to prune staged attachments: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, sweepIntervalMs());
  timer.unref?.();
  return timer;
}
