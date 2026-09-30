import { NextRequest } from "next/server";
import { externalQuotaBackends } from "@/lib/agents/external-quota-backends";
import { realtimeHub } from "@/lib/realtime/hub";
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
  const requestedExternal = params.getAll("externalQuotaBackend")
    .flatMap((value) => value.split(","))
    .flatMap((value) => {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    });
  // Clients that name none (the CLI) get the daemon's non-built-in backends,
  // same as the web AI Manager page derives from `supportedBackends`.
  const external = requestedExternal.length > 0
    ? requestedExternal
    : externalQuotaBackends(
        realtimeHub.getAgentsForUser(ctx.userId).find((agent) => agent.host === ctx.agentHost)
          ?.supportedBackends,
      );
  if (external.length > 0) {
    args.externalQuotaBackends = external;
  }

  return callAgent(ctx, "quota", args, 30_000);
}
