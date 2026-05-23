import { NextRequest } from "next/server";
import { authorizeCustomCommands, callCustomCommands } from "./_helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const { host } = await params;
  const ctx = await authorizeCustomCommands(request, host);
  if (ctx instanceof Response) return ctx;

  return callCustomCommands(ctx, "list");
}
