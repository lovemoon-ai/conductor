import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { getLatestTokenValue, issueApiToken } from "@/lib/auth/service";
import { resolveAgentWebsocketUrl, resolvePublicBackendUrl } from "@/lib/auth/config-utils";
import { getFeishuProviderConfigForUser } from "@/lib/channel/provider-config";

export { resolveAgentWebsocketUrl };

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let tokenValue = await getLatestTokenValue(user.id);
  if (!tokenValue) {
    const result = await issueApiToken(user.id, "config");
    tokenValue = result.token;
  }

  const backendUrl = resolvePublicBackendUrl(request.nextUrl.origin);
  const wsUrl = resolveAgentWebsocketUrl(backendUrl);

  const lines = [
    `agent_token: "${tokenValue}"`,
    `backend_url: "${backendUrl}"`,
    '# Update daemon_name before running conductor daemon.',
    'daemon_name: "my-daemon"',
  ];
  if (wsUrl) lines.push(`websocket_url: "${wsUrl}"`);
  const feishuConfig = await getFeishuProviderConfigForUser(user.id);
  lines.push('', 'channels:', '  # Fill feishu bot credentials, then POST this YAML to /api/channel/feishu/config', '  feishu:');
  if (feishuConfig) {
    lines.push(`    app_id: "${feishuConfig.appId}"`);
    lines.push(`    app_secret: "${feishuConfig.appSecret}"`);
    lines.push(`    verification_token: "${feishuConfig.verificationToken}"`);
    lines.push(`    encrypt_key: "${feishuConfig.encryptKey ?? ''}"`);
  } else {
    lines.push('    app_id: ""');
    lines.push('    app_secret: ""');
    lines.push('    verification_token: ""');
    lines.push('    encrypt_key: ""');
  }
  lines.push("log_level: info", "");

  const yaml = lines.join("\n");

  return new NextResponse(yaml, {
    headers: {
      "Content-Type": "application/x-yaml",
      "Content-Disposition": 'attachment; filename="config.yaml"',
    },
  });
}
