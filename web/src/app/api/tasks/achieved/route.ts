import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  countAchievedTasks,
  searchAchievedTasks,
} from "@/lib/tasks/achieved-search";

/**
 * GET /api/tasks/achieved?q=&projectId=&projectIds=&daemonHost=&page=&limit=
 *
 * Lists / searches the current user's achieved (packed) tasks by title and
 * transcript content. Results are capped at 10 items per page.
 */
export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const projectId = searchParams.get("projectId")?.trim() ?? "";
  const projectIds = projectId
    ? [projectId]
    : [...new Set(
        (searchParams.get("projectIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      )].slice(0, 100);
  const daemonHost = searchParams.get("daemonHost");
  const pageRaw = Number.parseInt(searchParams.get("page") ?? "", 10);
  const limitRaw = searchParams.get("limit");
  const requestedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 10;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 10)
    : 10;

  const searchArgs = {
    userId: user.id,
    query,
    projectIds,
    daemonHost,
  };
  const [tasks, total] = await Promise.all([
    searchAchievedTasks({
      ...searchArgs,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    countAchievedTasks(searchArgs),
  ]);

  return NextResponse.json({
    tasks,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}
