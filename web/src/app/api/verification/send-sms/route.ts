import { NextRequest, NextResponse } from "next/server";
import { sendVerificationSms } from "@/lib/verification/volc-sms";
import { db } from "@/lib/db";

const DEV_CODE = process.env.AUTH_DEV_CODE?.trim();
const isDev = process.env.NODE_ENV === "development";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const phone = body.phone?.trim();
  const countryCode = body.countryCode?.trim() || "+86";

  if (!phone) {
    return NextResponse.json({ error: "Phone required" }, { status: 400 });
  }

  const code = isDev && DEV_CODE ? DEV_CODE : Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // Store with country code prefix for verification
  const fullPhone = `${countryCode}${phone}`;
  await db.verification.create({
    data: { target: fullPhone, code, type: "SMS", expiresAt },
  });

  if (!(isDev && DEV_CODE)) {
    await sendVerificationSms(phone, code, countryCode);
  } else {
    console.log(`[DEV] Using dev code ${code} for ${fullPhone}`);
  }

  return NextResponse.json({ success: true, expiresIn: 300 });
}
