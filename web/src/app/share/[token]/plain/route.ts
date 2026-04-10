import { NextRequest } from "next/server";
import { buildSharedPlainText, loadSharedTask } from "@/lib/tasks/shared-task";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const result = await loadSharedTask(token);

  if (result.status === "not_found") {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (result.status === "expired") {
    return new Response("This shared link has expired.", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(buildSharedPlainText(result.data), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
