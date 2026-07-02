import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import {
  DailyReportInputError,
  DailyReportSchemaUnavailableError,
  getDailyReportSetting,
  updateDailyReportSetting,
} from "@/lib/daily-reports/daily-report";
import { resolveClientTimezone } from "@/lib/daily-reports/client-timezone";
import { realtimeHub } from "@/lib/realtime/hub";

const readBody = async (request: NextRequest): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
};

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const setting = await getDailyReportSetting(user.id);
  return NextResponse.json(setting);
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readBody(request);
  const deliveryChannels = Object.prototype.hasOwnProperty.call(body, "deliveryChannels")
    ? body.deliveryChannels
    : body.delivery_channels;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const timezone = enabled === false ? undefined : await resolveClientTimezone(request);

  try {
    const setting = await updateDailyReportSetting({
      userId: user.id,
      enabled,
      timezone,
      deliveryChannels,
    });

    realtimeHub.broadcastToUser(user.id, {
      type: "daily_report_setting_update",
      payload: {
        setting,
        updated_at: new Date().toISOString(),
      },
    });

    return NextResponse.json(setting);
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
