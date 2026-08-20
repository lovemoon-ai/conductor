import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRemoteExec, callRemoteExec } from "./_helpers";

const NUL = String.fromCharCode(0);
const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 30_000;
/** Slack so the daemon's own wait always expires first and we get a real run
 *  snapshot back instead of a bare gateway timeout. */
const RESPONSE_SLACK_MS = 5_000;

const noNul = (label: string) =>
  ({ message: `${label} must not contain NUL bytes` }) as const;

const requestSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1, "command is required")
    .refine((value) => !value.includes(NUL), noNul("command")),
  args: z
    .array(z.string().refine((value) => !value.includes(NUL), noNul("args")))
    .max(256, "too many args")
    .optional(),
  workspace: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const { host } = await params;
  const ctx = await authorizeRemoteExec(request, host);
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

  const waitMs = parsed.data.timeoutMs ?? DEFAULT_WAIT_MS;
  return callRemoteExec(ctx, "exec", { ...parsed.data, timeoutMs: waitMs }, waitMs + RESPONSE_SLACK_MS);
}
