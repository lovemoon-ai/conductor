import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

const INVITE_REWARD_DAYS_ON_REGISTER = 1;
const INVITE_REWARD_DAYS_ON_PLUS = 7;
export const SEED_INVITE_CODE = "GEQ8BXKK";
const SEED_INVITEE_PLUS_DAYS = 180;
const SEED_OWNER_PLUS_DAYS = 360;

const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_GENERATION_ATTEMPTS = 10;
type DbClient = Prisma.TransactionClient;

const SUBSCRIPTION_STATUS = {
  ACTIVE: "ACTIVE",
} as const;

const SUBSCRIPTION_TIER = {
  PLUS: "PLUS",
  PLUS_DEV: "PLUS_DEV",
} as const;

function isPermanentPlusTier(tier: string | null | undefined): boolean {
  return (tier ?? "").trim().toUpperCase() === SUBSCRIPTION_TIER.PLUS_DEV;
}

function normalizeInviteCode(inviteCode: string | null | undefined): string {
  return (inviteCode ?? "").trim().toUpperCase();
}

function isSeedInviteCode(inviteCode: string | null | undefined): boolean {
  return normalizeInviteCode(inviteCode) === SEED_INVITE_CODE;
}

function generateCandidateCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    const idx = bytes[i] % INVITE_CODE_ALPHABET.length;
    code += INVITE_CODE_ALPHABET[idx];
  }
  return code;
}

async function generateUniqueInviteCode(): Promise<string> {
  const candidates = Array.from(
    { length: MAX_GENERATION_ATTEMPTS },
    () => generateCandidateCode(),
  );
  const existingUsers = await Promise.all(
    candidates.map((candidate) => db.user.findUnique({ where: { inviteCode: candidate } })),
  );
  const availableIndex = existingUsers.findIndex((existing) => !existing);
  if (availableIndex !== -1) {
    return candidates[availableIndex];
  }
  throw new Error("Failed to generate unique invite code");
}

export async function getOrCreateInviteCode(userId: string, client?: DbClient): Promise<string> {
  const prisma = client ?? db;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, inviteCode: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  if (user.inviteCode) {
    if (isSeedInviteCode(user.inviteCode)) {
      await ensureUserAccessDays(user.id, SEED_OWNER_PLUS_DAYS, prisma);
    }
    return user.inviteCode;
  }

  const inviteCode = await generateUniqueInviteCode();
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { inviteCode },
    select: { inviteCode: true },
  });

  if (!updated.inviteCode) {
    throw new Error("Failed to persist invite code");
  }

  return updated.inviteCode;
}

export async function findInviterByCode(inviteCode: string, client?: DbClient) {
  const prisma = client ?? db;
  const normalized = normalizeInviteCode(inviteCode);
  if (!normalized) return null;
  return prisma.user.findUnique({ where: { inviteCode: normalized } });
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Extend a user's PLUS entitlement window by the given number of days.
 * This reward always grants PLUS access, even if the user is currently FREE.
 */
async function extendUserAccessDays(userId: string, days: number, client?: DbClient) {
  const prisma = client ?? db;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("User not found");
  }

  if (user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE && isPermanentPlusTier(user.subscriptionTier)) {
    return user;
  }

  const now = new Date();
  const base = user.subscriptionEndsAt && user.subscriptionEndsAt > now
    ? user.subscriptionEndsAt
    : now;
  const subscriptionEndsAt = addDays(base, days);

  return prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionTier: SUBSCRIPTION_TIER.PLUS,
      subscriptionEndsAt,
    },
  });
}

/**
 * Ensure a user's PLUS entitlement window has at least `days` days from now.
 * If current entitlement is already longer, keep it unchanged.
 */
async function ensureUserAccessDays(userId: string, days: number, client?: DbClient) {
  const prisma = client ?? db;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("User not found");
  }

  if (user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE && isPermanentPlusTier(user.subscriptionTier)) {
    return user;
  }

  const now = new Date();
  const minimumEndsAt = addDays(now, days);
  const subscriptionEndsAt =
    user.subscriptionEndsAt && user.subscriptionEndsAt > minimumEndsAt
      ? user.subscriptionEndsAt
      : minimumEndsAt;

  if (
    user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE &&
    user.subscriptionTier === SUBSCRIPTION_TIER.PLUS &&
    user.subscriptionEndsAt &&
    user.subscriptionEndsAt.getTime() === subscriptionEndsAt.getTime()
  ) {
    return user;
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionTier: SUBSCRIPTION_TIER.PLUS,
      subscriptionEndsAt,
    },
  });
}

async function grantInviteRegisterReward(inviterUserId: string, client?: DbClient) {
  const prisma = client ?? db;
  const inviter = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { inviteCode: true },
  });
  if (!inviter) {
    throw new Error("User not found");
  }

  if (isSeedInviteCode(inviter.inviteCode)) {
    await ensureUserAccessDays(inviterUserId, SEED_OWNER_PLUS_DAYS, prisma);
    return;
  }

  await extendUserAccessDays(inviterUserId, INVITE_REWARD_DAYS_ON_REGISTER, prisma);
}

async function grantInvitePlusReward(inviterUserId: string, client?: DbClient) {
  const prisma = client ?? db;
  const inviter = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { inviteCode: true },
  });
  if (!inviter) {
    throw new Error("User not found");
  }

  if (isSeedInviteCode(inviter.inviteCode)) {
    await ensureUserAccessDays(inviterUserId, SEED_OWNER_PLUS_DAYS, prisma);
    return;
  }

  await extendUserAccessDays(inviterUserId, INVITE_REWARD_DAYS_ON_PLUS, prisma);
}

/**
 * Apply invite registration benefits:
 * - default invite code: inviter +1 day
 * - seed invite code (GEQ8BXKK): invitee 180 days PLUS, owner 360 days PLUS
 */
export async function applyInviteRegisterRewardPolicy(
  inviterUserId: string,
  inviteeUserId: string,
  inviteCode: string,
  client?: DbClient,
) {
  if (isSeedInviteCode(inviteCode)) {
    await ensureUserAccessDays(inviteeUserId, SEED_INVITEE_PLUS_DAYS, client);
    await ensureUserAccessDays(inviterUserId, SEED_OWNER_PLUS_DAYS, client);
    return { policy: "seed" as const };
  }

  await grantInviteRegisterReward(inviterUserId, client);
  return { policy: "default" as const };
}

/**
 * Called when an invited user completes a PLUS purchase.
 * Ensures the PLUS reward is only granted once per invited user.
 */
export async function applyInvitePlusRewardForInvitee(inviteeUserId: string) {
  const now = new Date();
  let result: { applied: true; reason: "applied" } | { applied: false; reason: "no-inviter" | "already-applied" } =
    { applied: false, reason: "no-inviter" };

  await db.$transaction(async (tx) => {
    const invitee = await tx.user.findUnique({
      where: { id: inviteeUserId },
      select: { invitePlusRewardAt: true, invitedByUserId: true },
    });

    if (!invitee?.invitedByUserId) {
      result = { applied: false, reason: "no-inviter" };
      return;
    }

    if (invitee.invitePlusRewardAt) {
      result = { applied: false, reason: "already-applied" };
      return;
    }

    await grantInvitePlusReward(invitee.invitedByUserId, tx);

    await tx.user.update({
      where: { id: inviteeUserId },
      data: { invitePlusRewardAt: now },
    });

    result = { applied: true, reason: "applied" };
  });

  return result;
}
