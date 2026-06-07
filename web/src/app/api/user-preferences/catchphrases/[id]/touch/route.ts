import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import {
  CatchphraseNotFoundError,
  listCatchphrases,
  touchCatchphrase,
} from "@/lib/user-catchphrases";

/**
 * POST /api/user-preferences/catchphrases/:id/touch
 *
 * Bumps `last_used_at` on the row. Used by the chat composer popover when a
 * user picks (single or double-click) a catchphrase. We intentionally do NOT
 * broadcast a realtime snapshot here — the only field that changed is
 * `lastUsedAt`, which is consumed by future "most recent" sort (deferred
 * past v1) and is not worth waking every other tab for.
 *
 * Response envelope matches the rest of the catchphrases API: `{ catchphrases }`
 * with the user's current snapshot. Callers that only care about the bump can
 * ignore the body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    await touchCatchphrase(user.id, id);
  } catch (error) {
    if (error instanceof CatchphraseNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }

  const catchphrases = await listCatchphrases(user.id);
  return NextResponse.json({ catchphrases });
}
