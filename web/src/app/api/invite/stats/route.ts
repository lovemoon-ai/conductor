import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { getOrCreateInviteCode } from "@/lib/invite/service";

const REGISTER_REWARD_DAYS = 1;
const PLUS_REWARD_DAYS = 7;

export const GET = requireAuth(async (_request, user) => {
  try {
    const inviteCode = await getOrCreateInviteCode(user.id);

    const invitees = await db.user.findMany({
      where: { invitedByUserId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        phone: true,
        createdAt: true,
        inviteRegisteredRewardAt: true,
        invitePlusRewardAt: true,
      },
    });

    const registeredCount = invitees.filter((u) => Boolean(u.inviteRegisteredRewardAt)).length;
    const plusCount = invitees.filter((u) => Boolean(u.invitePlusRewardAt)).length;
    const rewardDays = registeredCount * REGISTER_REWARD_DAYS + plusCount * PLUS_REWARD_DAYS;

    const records = invitees.map((u) => ({
      id: u.id,
      email: u.email,
      phone: u.phone,
      createdAt: u.createdAt,
      registeredRewardAt: u.inviteRegisteredRewardAt,
      plusRewardAt: u.invitePlusRewardAt,
    }));

    return NextResponse.json({
      inviteCode,
      stats: {
        registeredCount,
        plusCount,
        rewardDays,
      },
      records,
    });
  } catch (error) {
    console.error("Failed to load invite stats:", error);
    return NextResponse.json({ error: "Failed to load invite stats" }, { status: 500 });
  }
});
