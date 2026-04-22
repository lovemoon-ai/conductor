import { NextRequest } from "next/server";
import { authorize, callAgent } from "../_helpers";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const agentHost = params.get("agentHost");
  const ctx = await authorize(request, agentHost);
  if (ctx instanceof Response) return ctx;

  const tool = params.get("tool");
  const forceRefresh = params.get("forceRefresh") === "1";
  const args: Record<string, unknown> = { forceRefresh };
  if (tool === "codex" || tool === "claude" || tool === "kimi" || tool === "copilot") {
    args.tool = tool;
  }

  return callAgent(ctx, "quota", args, 30_000);
}
