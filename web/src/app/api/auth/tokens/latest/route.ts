import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { getLatestTokenValue } from "@/lib/auth/service";

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getLatestTokenValue(user.id);
  return NextResponse.json({ token });
}
