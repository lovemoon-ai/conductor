import { NextRequest, NextResponse } from "next/server";
import { authorizeRemoteExec, callRemoteExec } from "../../_helpers";

async function resolveRunId(
  request: NextRequest,
  params: Promise<{ host: string; runId: string }>,
) {
  const { host, runId: rawRunId } = await params;
  const ctx = await authorizeRemoteExec(request, host);
  if (ctx instanceof Response) return { error: ctx };

  let runId = "";
  try {
    runId = decodeURIComponent(rawRunId || "").trim();
  } catch {
    return { error: NextResponse.json({ error: "invalid runId" }, { status: 400 }) };
  }
  if (!runId) {
    return { error: NextResponse.json({ error: "runId required" }, { status: 400 }) };
  }
  return { ctx, runId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; runId: string }> },
) {
  const resolved = await resolveRunId(request, params);
  if (resolved.error) return resolved.error;

  return callRemoteExec(resolved.ctx, "status", { runId: resolved.runId }, 10_000);
}

/** Stop a run that is still going on the target host. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; runId: string }> },
) {
  const resolved = await resolveRunId(request, params);
  if (resolved.error) return resolved.error;

  // The daemon sends SIGTERM, waits, then SIGKILL, so allow for that grace
  // period plus a little slack before giving up on the response.
  return callRemoteExec(resolved.ctx, "cancel", { runId: resolved.runId }, 20_000);
}
