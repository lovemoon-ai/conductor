import { NextRequest, NextResponse } from "next/server";
import { sendVerificationEmail } from "@/lib/verification/resend-email";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const email = body.email?.trim();

  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.verification.create({
    data: { target: email, code, type: "EMAIL", expiresAt },
  });

  await sendVerificationEmail(email, code);

  return NextResponse.json({ success: true, expiresIn: 300 });
}
