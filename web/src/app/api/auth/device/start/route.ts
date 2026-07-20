import { NextRequest, NextResponse } from "next/server";
import {
  DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  startDeviceAuthorization,
} from "@/lib/auth/device-auth";
import { resolveDeviceAuthorizationBaseUrl } from "@/lib/auth/config-utils";

function getClientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const publicBaseUrl = resolveDeviceAuthorizationBaseUrl(request.nextUrl.origin);

  const result = await startDeviceAuthorization({
    requestedByIp: getClientIp(request),
    cliVersion: typeof body.cli_version === "string" ? body.cli_version : null,
    hostname: typeof body.hostname === "string" ? body.hostname : null,
    platform: typeof body.platform === "string" ? body.platform : null,
    backendUrl: typeof body.backend_url === "string" ? body.backend_url : publicBaseUrl,
  });

  return NextResponse.json({
    device_code: result.deviceCode,
    user_code: result.userCode,
    verification_uri: `${publicBaseUrl}/activate`,
    verification_uri_complete: `${publicBaseUrl}/activate?user_code=${encodeURIComponent(result.userCode)}`,
    expires_in: result.expiresIn,
    interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  });
}
