import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { createPreviewSession, queuePreviewStat } from "@/lib/previews/preview-store";
import { realtimeHub } from "@/lib/realtime/hub";
import { requestRemoteFile } from "@/lib/realtime/remote-file";
import { resolveFireTaskRouting } from "@/lib/tasks/fire-routing";
import {
  encodePreviewPath,
  previewContentType,
  previewMaxBytes,
  previewViewUrl,
} from "@/shared/utils/file-preview";

export const runtime = "nodejs";

const PREVIEW_CAPABILITY = "remote_file_preview";
const STAT_TIMEOUT_MS = 15_000;

const requestSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, "path is required")
    .max(4096)
    .refine((value) => !value.includes("\0"), "path must not contain NUL bytes"),
});

const UNSUPPORTED = "this file type cannot be previewed";

/**
 * Open a temporary preview of a file the task's AI wrote on its daemon.
 *
 * This is the only authenticated step: it proves the caller owns the task,
 * asks the daemon where the file really lives, and mints a link scoped to that
 * file's directory. Everything served afterwards hangs off the returned token.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const user = await getActiveSubscriptionUser(request);
  if (user instanceof Response) return user;

  const [{ taskId }, rawBody] = await Promise.all([params, request.json().catch(() => ({}))]);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  if (!previewContentType(parsed.data.path)) {
    return NextResponse.json({ error: UNSUPPORTED }, { status: 415 });
  }

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      project: { select: { daemonHost: true } },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The files are on the daemon's machine, but a running task's
  // `executionHost` names its Fire process, which serves no files.
  const host = resolveFireTaskRouting(task, null).daemonAssociationHost ?? "";
  const agent = host
    ? realtimeHub.getAgentsForUser(user.id).find((entry) => entry.host === host)
    : null;
  if (!agent) {
    return NextResponse.json(
      { error: `daemon ${host || "for this task"} is not connected` },
      { status: 409 },
    );
  }
  if (!agent.capabilities?.includes(PREVIEW_CAPABILITY)) {
    return NextResponse.json(
      {
        error:
          `daemon ${host} does not support file preview — either it predates the feature (upgrade it) ` +
          "or it declined via `remote_file: false` in its config",
      },
      { status: 409 },
    );
  }

  const outcome = await queuePreviewStat(user.id, () =>
    requestRemoteFile({
      userId: user.id,
      agentHost: host,
      action: "stat",
      args: { remotePath: parsed.data.path, taskId },
      timeoutMs: STAT_TIMEOUT_MS,
    }),
  );
  if (!outcome.ok) {
    const status = outcome.reason === "too_many_inflight" ? 429 : outcome.reason === "remote_error" ? 409 : 503;
    return NextResponse.json({ error: outcome.message }, { status });
  }

  const stat = (outcome.result ?? {}) as {
    exists?: boolean;
    isFile?: boolean;
    sizeBytes?: number | null;
    realPath?: string | null;
  };
  if (!stat.exists || !stat.realPath) {
    return NextResponse.json({ error: `no such file on ${host}: ${parsed.data.path}` }, { status: 404 });
  }
  if (!stat.isFile) {
    return NextResponse.json({ error: "only files can be previewed" }, { status: 400 });
  }

  // Judge the file by what it really is, not by the name of a symlink to it.
  const name = path.posix.basename(stat.realPath);
  const rootPath = path.posix.dirname(stat.realPath);
  const maxBytes = previewMaxBytes(name);
  if (typeof stat.sizeBytes === "number" && stat.sizeBytes > maxBytes) {
    return NextResponse.json(
      { error: `file is too large to preview (limit ${maxBytes / 1024 / 1024} MB)` },
      { status: 413 },
    );
  }
  if (name.startsWith(".") || !previewContentType(name)) {
    return NextResponse.json({ error: UNSUPPORTED }, { status: 415 });
  }
  // The root is what the link can read; a file sitting directly in `/` would
  // make that the whole disk.
  if (rootPath === "/") {
    return NextResponse.json({ error: "files in the filesystem root cannot be previewed" }, { status: 403 });
  }

  const session = createPreviewSession({ userId: user.id, agentHost: host, rootPath });
  if (!session) {
    return NextResponse.json(
      { error: "too many open previews; wait a few minutes for one to expire" },
      { status: 429 },
    );
  }

  return NextResponse.json({
    token: session.token,
    path: name,
    url: `/api/preview/${session.token}/${encodePreviewPath(name)}`,
    viewUrl: previewViewUrl(session.token, name),
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}
