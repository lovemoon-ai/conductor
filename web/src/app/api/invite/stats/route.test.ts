import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET } from "@/app/api/invite/stats/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";
import { signJwt } from "@/lib/auth/service";

const prisma = new PrismaClient();

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

describe("/api/invite/stats", () => {
  let inviterId: string;
  let token: string;

  beforeEach(async () => {
    const inviter = await prisma.user.create({
      data: {
        email: `stats-inviter-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        subscriptionStatus: "FREE_TRIAL",
        subscriptionTier: "FREE",
        trialEndsAt: addDays(new Date(), 7),
      },
    });
    inviterId = inviter.id;
    token = signJwt(inviterId);

    await prisma.user.update({
      where: { id: inviterId },
      data: { inviteCode: "STATSCODE" },
    });

    await prisma.user.create({
      data: {
        email: `stats-invitee-reg-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        invitedByUserId: inviterId,
        inviteRegisteredRewardAt: new Date(),
      },
    });

    await prisma.user.create({
      data: {
        email: `stats-invitee-plus-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        invitedByUserId: inviterId,
        inviteRegisteredRewardAt: new Date(),
        invitePlusRewardAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { invitedByUserId: inviterId } });
    await prisma.user.delete({ where: { id: inviterId } }).catch(() => {});
  });

  it("returns invite code, stats, and records", async () => {
    const request = createMockRequest({
      method: "GET",
      url: "http://localhost:6152/api/invite/stats",
      token,
    });

    const response = await GET(request);
    expect(response.status).toBe(200);

    const data = await extractJson(response);
    expect(data.inviteCode).toBeTruthy();
    expect(data.stats.registeredCount).toBe(2);
    expect(data.stats.plusCount).toBe(1);
    expect(data.stats.rewardDays).toBe(9);
    expect(Array.isArray(data.records)).toBe(true);
    expect(data.records.length).toBe(2);
  });
});
