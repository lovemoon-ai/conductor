import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { approveDeviceAuthorization } from "@/lib/auth/device-auth";

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const userCode = typeof body.user_code === "string" ? body.user_code.trim() : "";
    if (!userCode) {
      return NextResponse.json({ error: "user_code is required" }, { status: 400 });
    }

    await approveDeviceAuthorization(userCode, user.id);
    return NextResponse.json({ ok: true, status: "approved" });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
