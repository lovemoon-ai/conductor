import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  DailyReportInputError,
  DailyReportSchemaUnavailableError,
  getDailyReport,
  listDailyReportRuns,
  persistDailyReport,
} from "@/lib/daily-reports/daily-report";

const readBody = async (request: NextRequest): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
};

const parseLimit = (value: string | null): number => {
  if (!value) return 14;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 14;
  return Math.min(parsed, 60);
};

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const list = searchParams.get("list");
  if (list === "1" || list === "true") {
    return NextResponse.json({
      reports: await listDailyReportRuns({
        userId: user.id,
        limit: parseLimit(searchParams.get("limit")),
      }),
    });
  }

  try {
    const report = await getDailyReport({
      userId: user.id,
      reportDate: searchParams.get("date"),
      timezone: searchParams.get("timezone"),
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof DailyReportInputError) {
      return NextResponse.json(error.details, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const body = await readBody(request);

  try {
    const report = await persistDailyReport({
      userId: user.id,
      reportDate: typeof body.reportDate === "string" ? body.reportDate : typeof body.report_date === "string" ? body.report_date : null,
      timezone: typeof body.timezone === "string" ? body.timezone : null,
      status: "generated",
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof DailyReportInputError) {
      return NextResponse.json(error.details, { status: error.status });
    }
    if (error instanceof DailyReportSchemaUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
