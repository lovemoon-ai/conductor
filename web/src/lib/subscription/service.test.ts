import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { SEED_INVITE_CODE } from '@/lib/invite/service';
import {
  startFreeTrial,
  startNewUserPlusAccess,
  activatePlusSubscription,
  isSubscriptionActive,
  getSubscriptionStatus,
  checkAndUpdateExpiredSubscription,
  renewPlusSubscription,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_TIER,
  TRIAL_PERIOD_DAYS,
  SUBSCRIPTION_PERIOD_DAYS,
} from './service';

const prisma = new PrismaClient();

async function ensureSeedOwner() {
  const existing = await prisma.user.findUnique({
    where: { inviteCode: SEED_INVITE_CODE },
  });
  if (existing) {
    return { user: existing, created: false };
  }

  const created = await prisma.user.create({
    data: {
      email: `seed-owner-${Date.now()}@example.com`,
      passwordHash: 'test-hash',
      passwordSalt: 'test-salt',
      inviteCode: SEED_INVITE_CODE,
    },
  });
  return { user: created, created: true };
}

async function restoreUserStateIfExists(
  userId: string,
  data: {
    subscriptionStatus: string;
    subscriptionTier: string;
    subscriptionEndsAt: Date | null;
    lastPaymentAt: Date | null;
    trialEndsAt: Date | null;
  }
) {
  await prisma.user.updateMany({
    where: { id: userId },
    data,
  });
}

describe('Subscription Service', () => {
  let testUserId: string;

  beforeEach(async () => {
    // Create a test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        passwordHash: 'test-hash',
        passwordSalt: 'test-salt',
      },
    });
    testUserId = user.id;
  });

  afterEach(async () => {
    // Clean up test user
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  describe('startFreeTrial', () => {
    it('should set trial end date to 7 days from now', async () => {
      const user = await startFreeTrial(testUserId);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.FREE_TRIAL);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.FREE);
      expect(user.trialEndsAt).toBeDefined();

      const now = new Date();
      const expectedTrialEnd = new Date();
      expectedTrialEnd.setDate(expectedTrialEnd.getDate() + TRIAL_PERIOD_DAYS);

      // Allow 1 second difference for test execution time
      const timeDiff = Math.abs(
        user.trialEndsAt!.getTime() - expectedTrialEnd.getTime()
      );
      expect(timeDiff).toBeLessThan(1000);
    });
  });

  describe('startNewUserPlusAccess', () => {
    it('should set new users to permanent Plus Dev access', async () => {
      const user = await startNewUserPlusAccess(testUserId);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS_DEV);
      expect(user.subscriptionEndsAt).toBeNull();
      expect(user.trialEndsAt).toBeNull();
    });
  });

  describe('activatePlusSubscription', () => {
    it('should activate Plus subscription for 30 days', async () => {
      // Create a test order
      const order = await prisma.order.create({
        data: {
          userId: testUserId,
          amount: 4900,
          currency: 'CNY',
          provider: 'ALIPAY',
          status: 'COMPLETED',
        },
      });

      const user = await activatePlusSubscription(testUserId, order.id);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS);
      expect(user.subscriptionEndsAt).toBeDefined();
      expect(user.lastPaymentAt).toBeDefined();

      const now = new Date();
      const expectedSubEnd = new Date();
      expectedSubEnd.setDate(expectedSubEnd.getDate() + SUBSCRIPTION_PERIOD_DAYS);

      const timeDiff = Math.abs(
        user.subscriptionEndsAt!.getTime() - expectedSubEnd.getTime()
      );
      expect(timeDiff).toBeLessThan(1000);

      // Clean up
      await prisma.order.delete({ where: { id: order.id } });
    });

    it('should still activate seed invite code owner Plus subscription for 30 days', async () => {
      const { user: seedOwner, created } = await ensureSeedOwner();
      const originalState = {
        subscriptionStatus: seedOwner.subscriptionStatus,
        subscriptionTier: seedOwner.subscriptionTier,
        subscriptionEndsAt: seedOwner.subscriptionEndsAt,
        lastPaymentAt: seedOwner.lastPaymentAt,
        trialEndsAt: seedOwner.trialEndsAt,
      };

      const order = await prisma.order.create({
        data: {
          userId: seedOwner.id,
          amount: 4900,
          currency: 'CNY',
          provider: 'ALIPAY',
          status: 'COMPLETED',
        },
      });

      try {
        const user = await activatePlusSubscription(seedOwner.id, order.id);
        expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
        expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS);
        expect(user.subscriptionEndsAt).toBeDefined();

        const expectedSubEnd = new Date();
        expectedSubEnd.setDate(expectedSubEnd.getDate() + SUBSCRIPTION_PERIOD_DAYS);
        const timeDiff = Math.abs(user.subscriptionEndsAt!.getTime() - expectedSubEnd.getTime());
        expect(timeDiff).toBeLessThan(1000);
      } finally {
        await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
        if (created) {
          await prisma.user.delete({ where: { id: seedOwner.id } }).catch(() => {});
        } else {
          await restoreUserStateIfExists(seedOwner.id, originalState);
        }
      }
    });
  });

  describe('isSubscriptionActive', () => {
    it('should return true for active free trial', async () => {
      const user = await startFreeTrial(testUserId);
      expect(isSubscriptionActive(user)).toBe(true);
    });

    it('should return false for expired free trial', async () => {
      const user = await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.FREE_TRIAL,
          trialEndsAt: new Date(Date.now() - 1000), // 1 second ago
        },
      });
      expect(isSubscriptionActive(user)).toBe(false);
    });

    it('should return true for active Plus subscription', async () => {
      const order = await prisma.order.create({
        data: {
          userId: testUserId,
          amount: 4900,
          currency: 'CNY',
          provider: 'ALIPAY',
          status: 'COMPLETED',
        },
      });

      const user = await activatePlusSubscription(testUserId, order.id);
      expect(isSubscriptionActive(user)).toBe(true);

      await prisma.order.delete({ where: { id: order.id } });
    });

    it('should return true for active Plus Dev subscription without expiry', async () => {
      const user = await startNewUserPlusAccess(testUserId);
      expect(isSubscriptionActive(user)).toBe(true);
    });

    it('should return false for expired Plus subscription', async () => {
      const user = await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
          subscriptionEndsAt: new Date(Date.now() - 1000), // 1 second ago
        },
      });
      expect(isSubscriptionActive(user)).toBe(false);
    });
  });

  describe('getSubscriptionStatus', () => {
    it('should return correct status for active trial', async () => {
      await startFreeTrial(testUserId);
      const status = await getSubscriptionStatus(testUserId);

      expect(status.status).toBe(SUBSCRIPTION_STATUS.FREE_TRIAL);
      expect(status.tier).toBe(SUBSCRIPTION_TIER.FREE);
      expect(status.isActive).toBe(true);
      expect(status.daysRemaining).toBeGreaterThan(0);
      expect(status.daysRemaining).toBeLessThanOrEqual(TRIAL_PERIOD_DAYS);
    });

    it('should return active status for Plus Dev without expiry', async () => {
      await startNewUserPlusAccess(testUserId);
      const status = await getSubscriptionStatus(testUserId);

      expect(status.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(status.tier).toBe(SUBSCRIPTION_TIER.PLUS_DEV);
      expect(status.isActive).toBe(true);
      expect(status.daysRemaining).toBe(0);
      expect(status.expiresAt).toBeNull();
      expect(status.subscriptionEndsAt).toBeNull();
    });

    it('should throw error for non-existent user', async () => {
      await expect(
        getSubscriptionStatus('non-existent-id')
      ).rejects.toThrow('User not found');
    });
  });

  describe('checkAndUpdateExpiredSubscription', () => {
    it('should update expired trial to EXPIRED status', async () => {
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.FREE_TRIAL,
          trialEndsAt: new Date(Date.now() - 1000),
        },
      });

      const user = await checkAndUpdateExpiredSubscription(testUserId);
      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    });

    it('should update expired Plus subscription to EXPIRED status', async () => {
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
          subscriptionEndsAt: new Date(Date.now() - 1000),
        },
      });

      const user = await checkAndUpdateExpiredSubscription(testUserId);
      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    });

    it('should not update active subscription', async () => {
      await startFreeTrial(testUserId);
      const before = await prisma.user.findUnique({ where: { id: testUserId } });

      const user = await checkAndUpdateExpiredSubscription(testUserId);
      expect(user.subscriptionStatus).toBe(before!.subscriptionStatus);
    });

    it('should not expire Plus Dev subscriptions', async () => {
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
          subscriptionTier: SUBSCRIPTION_TIER.PLUS_DEV,
          subscriptionEndsAt: null,
        },
      });

      const user = await checkAndUpdateExpiredSubscription(testUserId);
      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS_DEV);
      expect(user.subscriptionEndsAt).toBeNull();
    });
  });

  describe('renewPlusSubscription', () => {
    it('should extend active subscription by 30 days', async () => {
      const order = await prisma.order.create({
        data: {
          userId: testUserId,
          amount: 4900,
          currency: 'CNY',
          provider: 'ALIPAY',
          status: 'COMPLETED',
        },
      });

      await activatePlusSubscription(testUserId, order.id);
      const before = await prisma.user.findUnique({ where: { id: testUserId } });

      const user = await renewPlusSubscription(testUserId);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS);

      // New end date should be 30 days after the previous end date
      const expectedEnd = new Date(before!.subscriptionEndsAt!);
      expectedEnd.setDate(expectedEnd.getDate() + SUBSCRIPTION_PERIOD_DAYS);

      const timeDiff = Math.abs(
        user.subscriptionEndsAt!.getTime() - expectedEnd.getTime()
      );
      expect(timeDiff).toBeLessThan(1000);

      await prisma.order.delete({ where: { id: order.id } });
    });

    it('should start new subscription if expired', async () => {
      await prisma.user.update({
        where: { id: testUserId },
        data: {
          subscriptionStatus: SUBSCRIPTION_STATUS.EXPIRED,
          subscriptionEndsAt: new Date(Date.now() - 86400000), // 1 day ago
        },
      });

      const user = await renewPlusSubscription(testUserId);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS);

      const now = new Date();
      const expectedEnd = new Date();
      expectedEnd.setDate(expectedEnd.getDate() + SUBSCRIPTION_PERIOD_DAYS);

      const timeDiff = Math.abs(
        user.subscriptionEndsAt!.getTime() - expectedEnd.getTime()
      );
      expect(timeDiff).toBeLessThan(1000);
    });

    it('should extend active seed owner subscription by 30 days', async () => {
      const { user: seedOwner, created } = await ensureSeedOwner();
      const originalState = {
        subscriptionStatus: seedOwner.subscriptionStatus,
        subscriptionTier: seedOwner.subscriptionTier,
        subscriptionEndsAt: seedOwner.subscriptionEndsAt,
        lastPaymentAt: seedOwner.lastPaymentAt,
        trialEndsAt: seedOwner.trialEndsAt,
      };

      const order = await prisma.order.create({
        data: {
          userId: seedOwner.id,
          amount: 4900,
          currency: 'CNY',
          provider: 'ALIPAY',
          status: 'COMPLETED',
        },
      });

      try {
        await activatePlusSubscription(seedOwner.id, order.id);
        const before = await prisma.user.findUnique({ where: { id: seedOwner.id } });
        const user = await renewPlusSubscription(seedOwner.id);

        const expectedEnd = new Date(before!.subscriptionEndsAt!);
        expectedEnd.setDate(expectedEnd.getDate() + SUBSCRIPTION_PERIOD_DAYS);

        const timeDiff = Math.abs(
          user.subscriptionEndsAt!.getTime() - expectedEnd.getTime()
        );
        expect(timeDiff).toBeLessThan(1000);
      } finally {
        await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
        if (created) {
          await prisma.user.delete({ where: { id: seedOwner.id } }).catch(() => {});
        } else {
          await restoreUserStateIfExists(seedOwner.id, originalState);
        }
      }
    });

    it('should preserve Plus Dev as permanent on renew', async () => {
      await startNewUserPlusAccess(testUserId);

      const user = await renewPlusSubscription(testUserId);

      expect(user.subscriptionStatus).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(user.subscriptionTier).toBe(SUBSCRIPTION_TIER.PLUS_DEV);
      expect(user.subscriptionEndsAt).toBeNull();
      expect(user.lastPaymentAt).toBeDefined();
    });
  });
});
