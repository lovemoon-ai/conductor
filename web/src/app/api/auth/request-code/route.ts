import { NextRequest, NextResponse } from "next/server";
import { requestCode } from "@/lib/auth/service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.email && !body.phone) {
      return NextResponse.json({ error: "Email or phone required" }, { status: 400 });
    }
    const result = await requestCode(body);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
