import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeCustomCommands, callCustomCommands } from "../_helpers";

const keySchema = z
  .string()
  .trim()
  .min(1, "key is required")
  .max(80, "key is too long")
  .refine((value) => !/[\x00-\x1F\x7F/\\]/.test(value), {
    message: "key contains invalid characters",
  });

const requestSchema = z.object({
  key: keySchema,
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const { host } = await params;
  const ctx = await authorizeCustomCommands(request, host);
  if (ctx instanceof Response) return ctx;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  return callCustomCommands(ctx, "run", { key: parsed.data.key }, 10_000);
}
