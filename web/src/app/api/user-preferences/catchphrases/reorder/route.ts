import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  CatchphraseReorderMismatchError,
  reorderCatchphrases,
  reorderCatchphrasesSchema,
} from "@/lib/user-catchphrases";

export async function PUT(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = reorderCatchphrasesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  let catchphrases;
  try {
    catchphrases = await reorderCatchphrases(user.id, parsed.data.ids);
  } catch (error) {
    if (error instanceof CatchphraseReorderMismatchError) {
      // 409 Conflict — client's view of the catchphrase set is stale.
      // The client store should re-hydrate and retry.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  realtimeHub.broadcastToUser(user.id, {
    type: "user_catchphrase_update",
    payload: {
      catchphrases,
      updated_at: new Date().toISOString(),
    },
  });

  return NextResponse.json({ catchphrases });
}
