import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { revokeToken } from "@/lib/auth/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tokenId } = await params;
  const ok = await revokeToken(user.id, tokenId);
  if (!ok) return NextResponse.json({ error: "Token not found" }, { status: 404 });

  return new NextResponse(null, { status: 204 });
}
