import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  CatchphraseLimitReachedError,
  createCatchphrase,
  createCatchphraseSchema,
  listCatchphrases,
} from "@/lib/user-catchphrases";

const broadcastSnapshot = async (userId: string) => {
  const catchphrases = await listCatchphrases(userId);
  realtimeHub.broadcastToUser(userId, {
    type: "user_catchphrase_update",
    payload: {
      catchphrases,
      updated_at: new Date().toISOString(),
    },
  });
  return catchphrases;
};

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const catchphrases = await listCatchphrases(user.id);
  return NextResponse.json({ catchphrases });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createCatchphraseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    await createCatchphrase(user.id, parsed.data.text);
  } catch (error) {
    if (error instanceof CatchphraseLimitReachedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const catchphrases = await broadcastSnapshot(user.id);
  return NextResponse.json({ catchphrases }, { status: 201 });
}
