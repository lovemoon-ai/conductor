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
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_URL || ""}/login?error=token_failed`);
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const emails = await emailRes.json();
    const primaryEmail = emails.find((e: { primary: boolean }) => e.primary)?.email || userData.email;

    let user = await db.user.findFirst({
      where: { provider: "GITHUB", providerId: String(userData.id) },
    });

    if (!user && primaryEmail) {
      user = await db.user.findUnique({ where: { email: primaryEmail } });
      if (user) {
        await db.user.update({
          where: { id: user.id },
          data: { provider: "GITHUB", providerId: String(userData.id) },
        });
      }
    }

    if (!user) {
      const placeholder = randomBytes(16).toString("hex");
      const { hash, salt } = hashSecret(placeholder);
      user = await db.user.create({
        data: {
          email: primaryEmail,
          provider: "GITHUB",
          providerId: String(userData.id),
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
    console.error("GitHub OAuth error:", error);
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_URL || ""}/login?error=oauth_failed`);
  }
}
