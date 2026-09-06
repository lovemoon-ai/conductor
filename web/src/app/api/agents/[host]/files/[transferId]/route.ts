import { NextRequest, NextResponse } from "next/server";

import { resolveTransfer, transferSummary } from "../_helpers";
import { deleteTransfer } from "@/lib/transfers/transfer-store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; transferId: string }> },
) {
  const resolved = await resolveTransfer(request, params);
  if ("error" in resolved) return resolved.error;
  return NextResponse.json(transferSummary(resolved.transfer));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; transferId: string }> },
) {
  const resolved = await resolveTransfer(request, params);
  if ("error" in resolved) return resolved.error;

  await deleteTransfer(resolved.transfer.transferId);
  return NextResponse.json({ transferId: resolved.transfer.transferId, status: "cancelled" });
}
