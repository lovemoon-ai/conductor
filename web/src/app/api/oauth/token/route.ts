import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { consumeSsoAuthorizationCode, getOrIssueConnectedAppToken } from "@/lib/sso/service";

const RequestSchema = z.object({
  grant_type: z.string().trim(),
  client_id: z.string().trim().min(1, "client_id is required"),
  client_secret: z.string().min(1, "client_secret is required"),
  code: z.string().trim().min(1, "code is required"),
  redirect_uri: z.string().trim().min(1, "redirect_uri is required"),
});

function publicBaseUrl(request: NextRequest): string {
  const envBase = process.env.CONDUCTOR_PUBLIC_BASE_URL?.trim();
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(/:$/, "") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json(
      { error: "invalid_request", message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.grant_type !== "authorization_code") {
    return NextResponse.json(
      { error: "unsupported_grant_type", message: "grant_type must be 'authorization_code'" },
      { status: 400 },
    );
  }

  const result = await consumeSsoAuthorizationCode({
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret,
    redirectUri: parsed.data.redirect_uri,
    code: parsed.data.code,
  });

  if (!result.ok) {
    switch (result.error.kind) {
      case "unknown_client":
        return NextResponse.json(
          { error: "invalid_client", message: "Unknown client_id" },
          { status: 401 },
        );
      case "invalid_client_secret":
        return NextResponse.json(
          { error: "invalid_client", message: "Invalid client_secret" },
          { status: 401 },
        );
      case "invalid_redirect_uri":
        return NextResponse.json(
          { error: "invalid_grant", message: "Invalid redirect_uri" },
          { status: 400 },
        );
      case "invalid_code":
        return NextResponse.json(
          { error: "invalid_grant", message: "Invalid or expired authorization code" },
          { status: 400 },
        );
    }
  }

  const { userId, client } = result.data;

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json(
      { error: "invalid_grant", message: "User no longer exists" },
      { status: 400 },
    );
  }

  const accessToken = await getOrIssueConnectedAppToken(user.id, client.clientId);

  return NextResponse.json({
    access_token: accessToken,
    token_type: "Bearer",
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: null,
    },
    conductor_base_url: publicBaseUrl(request),
  });
}
