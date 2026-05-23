import { NextRequest, NextResponse } from "next/server";
import { authorizeCustomCommands, callCustomCommands } from "../../_helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; runId: string }> },
) {
  const { host, runId: rawRunId } = await params;
  const ctx = await authorizeCustomCommands(request, host);
  if (ctx instanceof Response) return ctx;

  let runId = "";
  try {
    runId = decodeURIComponent(rawRunId || "").trim();
  } catch {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }

  return callCustomCommands(ctx, "status", { runId }, 10_000);
}
