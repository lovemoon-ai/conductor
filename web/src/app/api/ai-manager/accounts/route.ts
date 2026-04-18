import { NextRequest } from "next/server";
import { authorize, callAgent } from "../_helpers";

export async function GET(request: NextRequest) {
  const agentHost = request.nextUrl.searchParams.get("agentHost");
  const ctx = await authorize(request, agentHost);
  if (ctx instanceof Response) return ctx;

  return callAgent(ctx, "list_accounts");
}
