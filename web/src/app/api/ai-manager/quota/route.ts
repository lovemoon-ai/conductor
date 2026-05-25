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
  if (tool) {
    args.tool = tool;
  }
  const externalQuotaBackends = params.getAll("externalQuotaBackend")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (externalQuotaBackends.length > 0) {
    args.externalQuotaBackends = externalQuotaBackends;
  }

  return callAgent(ctx, "quota", args, 30_000);
}
