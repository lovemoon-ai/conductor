import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/middleware";
import { createSsoAuthorizationCode } from "@/lib/sso/service";

const RequestSchema = z.object({
  client_id: z.string().trim().min(1, "client_id is required"),
  redirect_uri: z.string().trim().min(1, "redirect_uri is required"),
  state: z.string().optional().nullable(),
  response_type: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await createSsoAuthorizationCode({
    userId: user.id,
    clientId: parsed.data.client_id,
    redirectUri: parsed.data.redirect_uri,
    state: parsed.data.state ?? null,
    responseType: parsed.data.response_type ?? "code",
  });

  if (!result.ok) {
    switch (result.error.kind) {
      case "unknown_client":
        return NextResponse.json(
          { error: "unknown_client", message: "Unknown client_id" },
          { status: 403 },
        );
      case "invalid_redirect_uri":
        return NextResponse.json(
          { error: "invalid_redirect_uri", message: "Invalid redirect_uri" },
          { status: 403 },
        );
      case "invalid_response_type":
        return NextResponse.json(
          { error: "unsupported_response_type", message: "response_type must be 'code'" },
          { status: 400 },
        );
    }
  }

  return NextResponse.json({
    redirect_uri: result.data.redirectUri,
    expires_at: result.data.expiresAt.toISOString(),
  });
}
