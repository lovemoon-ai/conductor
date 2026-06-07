import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  CatchphraseNotFoundError,
  deleteCatchphrase,
  listCatchphrases,
  updateCatchphrase,
  updateCatchphraseSchema,
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = updateCatchphraseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    await updateCatchphrase(user.id, id, parsed.data.text);
  } catch (error) {
    if (error instanceof CatchphraseNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }

  const catchphrases = await broadcastSnapshot(user.id);
  return NextResponse.json({ catchphrases });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    await deleteCatchphrase(user.id, id);
  } catch (error) {
    if (error instanceof CatchphraseNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }

  const catchphrases = await broadcastSnapshot(user.id);
  return NextResponse.json({ catchphrases });
}
