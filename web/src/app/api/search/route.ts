import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { searchMessages } from "@/lib/search/message-search";

/**
 * Whole-history search across every message in the caller's tasks.
 *
 * GET /api/search?q=<query>&limit=<n>
 *
 * Borrowed from AgentsServer's cross-chat search. Backed by an incremental
 * SQLite FTS5 index when available, degrading to a portable LIKE scan
 * otherwise (see `@/lib/search/message-search`).
 */
export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsedLimit = limitParam ? Number(limitParam) : undefined;
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;

  if (!query) {
    return NextResponse.json({ query: "", backend: "fts", hits: [] });
  }

  const result = await searchMessages({ userId: user.id, query, limit });
  return NextResponse.json(result);
}
