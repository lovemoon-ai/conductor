import { NextRequest, NextResponse } from "next/server";
import { pollDeviceAuthorization } from "@/lib/auth/device-auth";
import { resolveAgentWebsocketUrl, resolvePublicBackendUrl } from "@/lib/auth/config-utils";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
    if (!deviceCode) {
      return NextResponse.json({ error: "device_code is required" }, { status: 400 });
    }

    const result = await pollDeviceAuthorization(deviceCode);
    if (result.status !== "approved") {
      return NextResponse.json(result);
    }

    const backendUrl = resolvePublicBackendUrl(request.nextUrl.origin);
    return NextResponse.json({
      status: "approved",
      agent_token: result.agentToken,
      backend_url: backendUrl,
      websocket_url: resolveAgentWebsocketUrl(backendUrl),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
