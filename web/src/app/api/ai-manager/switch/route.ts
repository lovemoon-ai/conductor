import { NextRequest, NextResponse } from "next/server";
import { authorize, callAgent } from "../_helpers";

export async function POST(request: NextRequest) {
  let body: { agentHost?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ctx = await authorize(request, body?.agentHost ?? null);
  if (ctx instanceof Response) return ctx;

  if (!body?.name || typeof body.name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  return callAgent(ctx, "switch_account", { name: body.name }, 30_000);
}
