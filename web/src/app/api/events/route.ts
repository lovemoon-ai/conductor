import { NextRequest, NextResponse } from "next/server";

const events: unknown[] = [];

export async function GET() {
  return NextResponse.json(events);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  events.push(body);
  return NextResponse.json({ ok: true, count: events.length });
}

export async function DELETE() {
  events.length = 0;
  return NextResponse.json({ ok: true });
}
