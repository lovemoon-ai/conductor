import { db } from '@/lib/db';
import type { Prisma, User } from '@prisma/client';
import { applyInvitePlusRewardForInvitee } from '@/lib/invite/service';

// Subscription status constants
export const SUBSCRIPTION_STATUS = {
  FREE_TRIAL: 'FREE_TRIAL',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

// Subscription tier constants
export const SUBSCRIPTION_TIER = {
  FREE: 'FREE',
  PLUS: 'PLUS',
  PLUS_DEV: 'PLUS_DEV',
} as const;

export const isPermanentPlusTier = (tier: unknown): boolean =>
  typeof tier === 'string' && tier.trim().toUpperCase() === SUBSCRIPTION_TIER.PLUS_DEV;

export const isPlusTier = (tier: unknown): boolean => {
  const normalizedTier = typeof tier === 'string' ? tier.trim().toUpperCase() : '';
  return normalizedTier === SUBSCRIPTION_TIER.PLUS || normalizedTier === SUBSCRIPTION_TIER.PLUS_DEV;
};

// Check if running in development/local environment
const isLocalDev = process.env.NODE_ENV === 'development' ||
  (process.env.NEXT_PUBLIC_URL || '').includes('localhost');

// Plus subscription price in cents (¥0.01 for local testing, ¥49 in production)
export const PLUS_PRICE_CNY = isLocalDev ? 1 : 4900;
// Plus subscription price in cents ($0.50 for local testing, $7 in production)
export const PLUS_PRICE_USD = isLocalDev ? 50 : 700;

// Trial period in days
export const TRIAL_PERIOD_DAYS = 7;

// Subscription period in days (monthly)
export const SUBSCRIPTION_PERIOD_DAYS = 30;
export const NEW_USER_PLUS_ACCESS_DAYS = SUBSCRIPTION_PERIOD_DAYS;

type DbClient = Prisma.TransactionClient;

/**
 * Start free trial for a new user
 * Sets trial end date to 7 days from now
 */
export async function startFreeTrial(userId: string, client?: DbClient): Promise<User> {
  const prisma = client ?? db;
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_PERIOD_DAYS);

  return await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.FREE_TRIAL,
      subscriptionTier: SUBSCRIPTION_TIER.FREE,
      trialEndsAt,
    },
  });
}

/**
 * Grant default permanent Plus Dev access to a newly registered user.
 */
export async function startNewUserPlusAccess(userId: string, client?: DbClient): Promise<User> {
  const prisma = client ?? db;

  return await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionTier: SUBSCRIPTION_TIER.PLUS_DEV,
      subscriptionEndsAt: null,
      trialEndsAt: null,
    },
  });
}

/**
 * Activate Plus subscription after successful payment
 * Sets subscription end date to 30 days from now
 */
export async function activatePlusSubscription(
  userId: string,
  orderId: string
): Promise<User> {
  const existingUser = await db.user.findUnique({
    where: { id: userId },
    select: { subscriptionTier: true },
  });
  if (!existingUser) {
    throw new Error('User not found');
  }

  const now = new Date();
  const subscriptionEndsAt = new Date();
  subscriptionEndsAt.setDate(subscriptionEndsAt.getDate() + SUBSCRIPTION_PERIOD_DAYS);

  return await db.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionTier: isPermanentPlusTier(existingUser.subscriptionTier)
        ? SUBSCRIPTION_TIER.PLUS_DEV
        : SUBSCRIPTION_TIER.PLUS,
      subscriptionEndsAt: isPermanentPlusTier(existingUser.subscriptionTier) ? null : subscriptionEndsAt,
      lastPaymentAt: now,
    },
  });
}

/**
 * Check if user has active subscription.
 * Always returns true — subscription restrictions have been removed.
 */
export function isSubscriptionActive(_user: User): boolean {
  return true;
}

/**
 * Get subscription status details for a user
 */
export async function getSubscriptionStatus(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const isActive = isSubscriptionActive(user);
  const now = new Date();

  let daysRemaining = 0;
  let expiresAt: Date | null = null;

  if (user.subscriptionStatus === SUBSCRIPTION_STATUS.FREE_TRIAL && user.trialEndsAt) {
    expiresAt = user.trialEndsAt;
    daysRemaining = Math.max(
      0,
      Math.ceil((user.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    );
  } else if (
    user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE &&
    isPermanentPlusTier(user.subscriptionTier)
  ) {
    expiresAt = null;
    daysRemaining = 0;
  } else if (user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE && user.subscriptionEndsAt) {
    expiresAt = user.subscriptionEndsAt;
    daysRemaining = Math.max(
      0,
      Math.ceil((user.subscriptionEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    );
  }

  return {
    status: user.subscriptionStatus,
    tier: user.subscriptionTier,
    isActive,
    daysRemaining,
    expiresAt,
    trialEndsAt: user.trialEndsAt,
    subscriptionEndsAt: user.subscriptionEndsAt,
    lastPaymentAt: user.lastPaymentAt,
  };
}

/**
 * Check and update expired subscriptions
 * Should be called periodically or on user access
 */
export async function checkAndUpdateExpiredSubscription(userId: string): Promise<User> {
  const user = await db.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date();
  let needsUpdate = false;
  const updates: Partial<User> = {};

  // Check if trial has expired
  if (
    user.subscriptionStatus === SUBSCRIPTION_STATUS.FREE_TRIAL &&
    user.trialEndsAt &&
    user.trialEndsAt <= now
  ) {
    updates.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
    needsUpdate = true;
  }

  // Check if paid subscription has expired
  if (
    user.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE &&
    !isPermanentPlusTier(user.subscriptionTier) &&
    user.subscriptionEndsAt &&
    user.subscriptionEndsAt <= now
  ) {
    updates.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
    needsUpdate = true;
  }

  if (needsUpdate) {
    return await db.user.update({
      where: { id: userId },
      data: updates,
    });
  }

  return user;
}

/**
 * Renew Plus subscription (extend by 30 days)
 */
export async function renewPlusSubscription(userId: string): Promise<User> {
  const user = await db.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date();

  if (isPermanentPlusTier(user.subscriptionTier)) {
    const updated = await db.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
        subscriptionTier: SUBSCRIPTION_TIER.PLUS_DEV,
        subscriptionEndsAt: null,
        lastPaymentAt: now,
      },
    });

    await applyInvitePlusRewardForInvitee(userId);
    return updated;
  }

  let newSubscriptionEndsAt: Date;

  // If subscription is still active, extend from current end date
  // Otherwise, extend from now
  if (user.subscriptionEndsAt && user.subscriptionEndsAt > now) {
    newSubscriptionEndsAt = new Date(user.subscriptionEndsAt);
    newSubscriptionEndsAt.setDate(newSubscriptionEndsAt.getDate() + SUBSCRIPTION_PERIOD_DAYS);
  } else {
    newSubscriptionEndsAt = new Date();
    newSubscriptionEndsAt.setDate(newSubscriptionEndsAt.getDate() + SUBSCRIPTION_PERIOD_DAYS);
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionTier: SUBSCRIPTION_TIER.PLUS,
      subscriptionEndsAt: newSubscriptionEndsAt,
      lastPaymentAt: now,
    },
  });

  // If this user was invited, grant the inviter a one-time PLUS reward.
  await applyInvitePlusRewardForInvitee(userId);

  return updated;
}
