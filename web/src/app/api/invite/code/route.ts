import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/middleware";
import { getOrCreateInviteCode } from "@/lib/invite/service";

export const GET = requireAuth(async (_request, user) => {
  try {
    const inviteCode = await getOrCreateInviteCode(user.id);
    return NextResponse.json({ inviteCode });
  } catch (error) {
    console.error("Failed to get invite code:", error);
    return NextResponse.json({ error: "Failed to get invite code" }, { status: 500 });
  }
});
