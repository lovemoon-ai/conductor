import { NextRequest, NextResponse } from "next/server";
import { loadSharedTask } from "@/lib/tasks/shared-task";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const result = await loadSharedTask(token);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.status === "expired") {
    return NextResponse.json({ error: "This shared link has expired" }, { status: 410 });
  }
  return NextResponse.json(result.data);
}
