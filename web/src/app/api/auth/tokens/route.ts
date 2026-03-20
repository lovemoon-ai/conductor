import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { issueApiToken, listTokens, getLatestTokenValue } from "@/lib/auth/service";

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tokens = await listTokens(user.id);
  return NextResponse.json(tokens);
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const result = await issueApiToken(user.id, body.name);
  return NextResponse.json(result);
}
