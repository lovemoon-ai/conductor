import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureDefaultProject, signJwt, hashSecret } from "@/lib/auth/service";
import { startNewUserPlusAccess } from "@/lib/subscription/service";
import { randomBytes } from "crypto";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_URL || ""}/login?error=no_code`);
  }

  try {
    const redirectUri = `${process.env.NEXT_PUBLIC_URL || "http://localhost:6152"}/api/auth/google/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_URL || ""}/login?error=token_failed`);
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    let user = await db.user.findFirst({
      where: { provider: "GOOGLE", providerId: userData.id },
    });

    if (!user && userData.email) {
      user = await db.user.findUnique({ where: { email: userData.email } });
      if (user) {
        await db.user.update({
          where: { id: user.id },
          data: { provider: "GOOGLE", providerId: userData.id },
        });
      }
    }

    if (!user) {
      const placeholder = randomBytes(16).toString("hex");
      const { hash, salt } = hashSecret(placeholder);
      user = await db.user.create({
        data: {
          email: userData.email,
          provider: "GOOGLE",
          providerId: userData.id,
          passwordHash: hash,
          passwordSalt: salt,
        },
      });
      await startNewUserPlusAccess(user.id);
      await ensureDefaultProject(user.id);
    }

    const jwt = signJwt(user.id);
    const baseUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:6152";

    return NextResponse.redirect(`${baseUrl}/?token=${jwt}`);
  } catch (error) {
    console.error("Google OAuth error:", error);
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_URL || ""}/login?error=oauth_failed`);
  }
}
