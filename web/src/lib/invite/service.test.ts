import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getOrCreateInviteCode,
  SEED_INVITE_CODE,
  SEED_OWNER_PLUS_DAYS,
} from "@/lib/invite/service";
import { registerWithCode } from "@/lib/auth/service";
import { renewPlusSubscription } from "@/lib/subscription/service";

const prisma = new PrismaClient();

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

describe("Invite Code Flow", () => {
  let inviterId: string;

  beforeEach(async () => {
    const inviter = await prisma.user.create({
      data: {
        email: `inviter-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        subscriptionStatus: "FREE_TRIAL",
        subscriptionTier: "FREE",
        trialEndsAt: addDays(new Date(), 7),
      },
    });
    inviterId = inviter.id;
  });

  afterEach(async () => {
    // Delete invitees first due to invitedBy relation.
    await prisma.user.deleteMany({ where: { invitedByUserId: inviterId } });
    await prisma.verification.deleteMany({
      where: {
        OR: [
          { target: { startsWith: "1870000" } },
          { target: { startsWith: "+861870000" } },
        ],
      },
    });
    await prisma.user.delete({ where: { id: inviterId } }).catch(() => {});
  });

  it("grants inviter 1 day when a new user registers with invite code", async () => {
    const inviteCode = await getOrCreateInviteCode(inviterId);
    const inviterBefore = await prisma.user.findUnique({ where: { id: inviterId } });
    expect(inviterBefore?.subscriptionTier).toBe("FREE");
    expect(inviterBefore?.subscriptionEndsAt).toBeNull();

    const phone = `1870000${Math.floor(Math.random() * 9000 + 1000)}`;
    const code = "123456";
    const fullPhone = `+86${phone}`;

    await prisma.verification.create({
      data: {
        target: fullPhone,
        code,
        type: "SMS",
        expiresAt: addDays(new Date(), 1),
        verified: false,
      },
    });

    const result = await registerWithCode({ phone, countryCode: "+86", code, inviteCode });
    expect(result.registered).toBe(true);

    const invitee = await prisma.user.findUnique({ where: { id: result.user.id } });
    expect(invitee?.invitedByUserId).toBe(inviterId);
    expect(invitee?.inviteRegisteredRewardAt).toBeTruthy();
    expect(invitee?.subscriptionTier).toBe("PLUS_DEV");
    expect(invitee?.subscriptionStatus).toBe("ACTIVE");
    expect(invitee?.subscriptionEndsAt).toBeNull();

    const inviterAfter = await prisma.user.findUnique({ where: { id: inviterId } });
    expect(inviterAfter?.subscriptionTier).toBe("PLUS");
    expect(inviterAfter?.subscriptionStatus).toBe("ACTIVE");
    expect(inviterAfter?.subscriptionEndsAt).toBeTruthy();

    const beforeTime = Date.now();
    const afterTime = inviterAfter!.subscriptionEndsAt!.getTime();
    const diffDays = (afterTime - beforeTime) / (1000 * 60 * 60 * 24);

    expect(diffDays).toBeGreaterThan(0.9);
    expect(diffDays).toBeLessThan(1.2);
  });

  it("applies seed invite policy for GEQ8BXKK", async () => {
    await prisma.user.update({
      where: { id: inviterId },
      data: { inviteCode: SEED_INVITE_CODE },
    });

    const phone = `1870000${Math.floor(Math.random() * 9000 + 1000)}`;
    const code = "123456";
    const fullPhone = `+86${phone}`;

    await prisma.verification.create({
      data: {
        target: fullPhone,
        code,
        type: "SMS",
        expiresAt: addDays(new Date(), 1),
        verified: false,
      },
    });

    const result = await registerWithCode({
      phone,
      countryCode: "+86",
      code,
      inviteCode: SEED_INVITE_CODE,
    });
    expect(result.registered).toBe(true);

    const invitee = await prisma.user.findUnique({ where: { id: result.user.id } });
    expect(invitee?.invitedByUserId).toBe(inviterId);
    expect(invitee?.inviteRegisteredRewardAt).toBeTruthy();
    expect(invitee?.subscriptionTier).toBe("PLUS_DEV");
    expect(invitee?.subscriptionStatus).toBe("ACTIVE");
    expect(invitee?.subscriptionEndsAt).toBeNull();

    const inviterAfter = await prisma.user.findUnique({ where: { id: inviterId } });
    expect(inviterAfter?.subscriptionTier).toBe("PLUS");
    expect(inviterAfter?.subscriptionStatus).toBe("ACTIVE");
    expect(inviterAfter?.subscriptionEndsAt).toBeTruthy();

    const inviterDiffDays = (inviterAfter!.subscriptionEndsAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(inviterDiffDays).toBeGreaterThan(SEED_OWNER_PLUS_DAYS - 0.2);
    expect(inviterDiffDays).toBeLessThan(SEED_OWNER_PLUS_DAYS + 0.2);
  });

  it("grants inviter 7 days once when the invited user buys PLUS", async () => {
    const inviteCode = await getOrCreateInviteCode(inviterId);
    const inviterBefore = await prisma.user.findUnique({ where: { id: inviterId } });
    expect(inviterBefore?.subscriptionTier).toBe("FREE");
    expect(inviterBefore?.subscriptionEndsAt).toBeNull();

    const invitee = await prisma.user.create({
      data: {
        email: `invitee-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        invitedByUserId: inviterId,
        subscriptionStatus: "FREE_TRIAL",
        subscriptionTier: "FREE",
        trialEndsAt: addDays(new Date(), 7),
        inviteRegisteredRewardAt: new Date(),
      },
    });

    // Ensure invite code is actually used/valid in the system.
    expect(inviteCode).toBeTruthy();

    await renewPlusSubscription(invitee.id);

    const inviterAfterFirst = await prisma.user.findUnique({ where: { id: inviterId } });
    const inviteeAfterFirst = await prisma.user.findUnique({ where: { id: invitee.id } });

    expect(inviteeAfterFirst?.invitePlusRewardAt).toBeTruthy();
    expect(inviterAfterFirst?.subscriptionTier).toBe("PLUS");
    expect(inviterAfterFirst?.subscriptionStatus).toBe("ACTIVE");
    expect(inviterAfterFirst?.subscriptionEndsAt).toBeTruthy();

    const firstDiffDays = (inviterAfterFirst!.subscriptionEndsAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    expect(firstDiffDays).toBeGreaterThan(6.9);
    expect(firstDiffDays).toBeLessThan(7.2);

    // Renew again; inviter should not receive another reward.
    await renewPlusSubscription(invitee.id);

    const inviterAfterSecond = await prisma.user.findUnique({ where: { id: inviterId } });
    const secondDiffDays =
      (inviterAfterSecond!.subscriptionEndsAt!.getTime() - inviterAfterFirst!.subscriptionEndsAt!.getTime()) /
      (1000 * 60 * 60 * 24);

    expect(secondDiffDays).toBeGreaterThan(-0.05);
    expect(secondDiffDays).toBeLessThan(0.05);
  });

  it("keeps seed invite code owner at 360-day policy when invited user buys PLUS", async () => {
    await prisma.user.update({
      where: { id: inviterId },
      data: { inviteCode: SEED_INVITE_CODE },
    });

    const invitee = await prisma.user.create({
      data: {
        email: `seed-invitee-${Date.now()}@example.com`,
        passwordHash: "hash",
        passwordSalt: "salt",
        invitedByUserId: inviterId,
        subscriptionStatus: "FREE_TRIAL",
        subscriptionTier: "FREE",
        trialEndsAt: addDays(new Date(), 7),
        inviteRegisteredRewardAt: new Date(),
      },
    });

    await renewPlusSubscription(invitee.id);

    const inviterAfter = await prisma.user.findUnique({ where: { id: inviterId } });
    expect(inviterAfter?.subscriptionTier).toBe("PLUS");
    expect(inviterAfter?.subscriptionStatus).toBe("ACTIVE");
    expect(inviterAfter?.subscriptionEndsAt).toBeTruthy();

    const inviterDiffDays = (inviterAfter!.subscriptionEndsAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(inviterDiffDays).toBeGreaterThan(SEED_OWNER_PLUS_DAYS - 0.2);
    expect(inviterDiffDays).toBeLessThan(SEED_OWNER_PLUS_DAYS + 0.2);
  });
});
