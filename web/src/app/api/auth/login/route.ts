import { NextRequest, NextResponse } from "next/server";
import { loginWithCode } from "@/lib/auth/service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // Support both identifier and phone/email fields
    const identifier = body.identifier || body.phone || body.email;
    const result = await loginWithCode({ identifier, code: body.code });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
