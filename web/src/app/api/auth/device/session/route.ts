import { NextRequest, NextResponse } from "next/server";
import { getPublicDeviceAuthorization } from "@/lib/auth/device-auth";

export async function GET(request: NextRequest) {
  const userCode = request.nextUrl.searchParams.get("user_code")?.trim() || "";
  if (!userCode) {
    return NextResponse.json({ error: "user_code is required" }, { status: 400 });
  }

  const session = await getPublicDeviceAuthorization(userCode);
  if (!session) {
    return NextResponse.json({ error: "Device authorization not found" }, { status: 404 });
  }

  return NextResponse.json({
    status: session.status,
    user_code: session.userCode,
    cli_version: session.cliVersion,
    hostname: session.hostname,
    platform: session.platform,
    backend_url: session.backendUrl,
    expires_at: session.expiresAt,
    approved_at: session.approvedAt,
  });
}
