import { randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { hashSecret, verifySecret } from "@/lib/auth/service";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_PART_LENGTH = 4;
const USER_CODE_PARTS = 2;
const DEVICE_CODE_PREFIX_LENGTH = 12;

export const DEVICE_AUTH_EXPIRES_IN_SECONDS = 600;
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 3;

export type DeviceAuthSessionStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

type DeviceAuthSessionDelegate = {
  findUnique: (...args: any[]) => Promise<any>;
  findMany: (...args: any[]) => Promise<any[]>;
  create: (...args: any[]) => Promise<any>;
  update: (...args: any[]) => Promise<any>;
  updateMany: (...args: any[]) => Promise<any>;
};

const deviceAuthSessions = (db as PrismaClient & { deviceAuthSession: DeviceAuthSessionDelegate })
  .deviceAuthSession;
const userTokens = (db as PrismaClient & { userToken: PrismaClient["userToken"] }).userToken;

export interface DeviceAuthStartInput {
  requestedByIp?: string | null;
  cliVersion?: string | null;
  hostname?: string | null;
  platform?: string | null;
  backendUrl?: string | null;
}

export interface DeviceAuthStartResult {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export interface PublicDeviceAuthSession {
  status: DeviceAuthSessionStatus;
  userCode: string;
  cliVersion: string | null;
  hostname: string | null;
  platform: string | null;
  backendUrl: string | null;
  expiresAt: string;
  approvedAt: string | null;
}

export type DeviceAuthPollResult =
  | { status: "pending" }
  | { status: "denied"; message: string }
  | { status: "expired"; message: string }
  | { status: "consumed"; message: string }
  | { status: "approved"; agentToken: string };

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase();
}

function buildDeviceCodePrefix(deviceCode: string): string {
  return deviceCode.slice(0, DEVICE_CODE_PREFIX_LENGTH);
}

function generateUserCodePart(length: number): string {
  const chars: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * USER_CODE_ALPHABET.length);
    chars.push(USER_CODE_ALPHABET[randomIndex]);
  }
  return chars.join("");
}

function generateUserCode(): string {
  const parts: string[] = [];
  for (let index = 0; index < USER_CODE_PARTS; index += 1) {
    parts.push(generateUserCodePart(USER_CODE_PART_LENGTH));
  }
  return parts.join("-");
}

async function generateUniqueUserCode(): Promise<string> {
  const candidates = Array.from({ length: 10 }, () => generateUserCode());
  const existingSessions = await Promise.all(
    candidates.map((candidate) =>
      deviceAuthSessions.findUnique({
        where: { userCode: candidate },
        select: { id: true },
      })
    ),
  );
  const availableIndex = existingSessions.findIndex((existing) => !existing);
  if (availableIndex !== -1) {
    return candidates[availableIndex];
  }
  throw new Error("Failed to allocate device authorization code");
}

async function findSessionByDeviceCode(deviceCode: string) {
  const normalized = deviceCode.trim();
  if (!normalized) {
    return null;
  }

  const prefix = buildDeviceCodePrefix(normalized);
  const candidates = await deviceAuthSessions.findMany({
    where: {
      deviceCodePrefix: prefix,
      status: {
        in: ["pending", "approved", "denied", "expired", "consumed"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  for (const candidate of candidates) {
    if (verifySecret(normalized, candidate.deviceCodeHash, candidate.deviceCodeSalt)) {
      return candidate;
    }
  }

  return null;
}

async function markExpiredIfNeeded(session: {
  id: string;
  status: string;
  expiresAt: Date;
}) {
  if (session.status !== "pending") {
    return session.status as DeviceAuthSessionStatus;
  }
  if (session.expiresAt.getTime() > Date.now()) {
    return "pending" as const;
  }

  await deviceAuthSessions.update({
    where: { id: session.id },
    data: { status: "expired" },
  });
  return "expired" as const;
}

async function getLatestActiveTokenRecord(userId: string) {
  return userTokens.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

async function issueApiTokenRecord(
  client: {
    userToken: {
      create: (...args: any[]) => Promise<any>;
      findFirst: (...args: any[]) => Promise<any>;
    };
  },
  userId: string,
  name?: string | null,
) {
  const rawToken = randomBytes(24).toString("hex");
  const { hash, salt } = hashSecret(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  return client.userToken.create({
    data: {
      userId,
      name,
      tokenHash: hash,
      tokenSalt: salt,
      tokenPrefix,
      tokenValue: rawToken,
    },
  });
}

export async function startDeviceAuthorization(input: DeviceAuthStartInput = {}): Promise<DeviceAuthStartResult> {
  const deviceCode = randomBytes(32).toString("hex");
  const { hash, salt } = hashSecret(deviceCode);
  const userCode = await generateUniqueUserCode();
  const expiresAt = new Date(Date.now() + DEVICE_AUTH_EXPIRES_IN_SECONDS * 1000);

  await deviceAuthSessions.create({
    data: {
      deviceCodeHash: hash,
      deviceCodeSalt: salt,
      deviceCodePrefix: buildDeviceCodePrefix(deviceCode),
      userCode,
      requestedByIp: normalizeOptionalString(input.requestedByIp),
      cliVersion: normalizeOptionalString(input.cliVersion),
      hostname: normalizeOptionalString(input.hostname),
      platform: normalizeOptionalString(input.platform),
      backendUrl: normalizeOptionalString(input.backendUrl),
      expiresAt,
    },
  });

  return {
    deviceCode,
    userCode,
    expiresIn: DEVICE_AUTH_EXPIRES_IN_SECONDS,
    interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  };
}

export async function getPublicDeviceAuthorization(userCode: string): Promise<PublicDeviceAuthSession | null> {
  const normalizedUserCode = normalizeUserCode(userCode);
  if (!normalizedUserCode) {
    return null;
  }

  const session = await deviceAuthSessions.findUnique({
    where: { userCode: normalizedUserCode },
  });
  if (!session) {
    return null;
  }

  const status = await markExpiredIfNeeded(session);
  return {
    status,
    userCode: session.userCode,
    cliVersion: session.cliVersion ?? null,
    hostname: session.hostname ?? null,
    platform: session.platform ?? null,
    backendUrl: session.backendUrl ?? null,
    expiresAt: session.expiresAt.toISOString(),
    approvedAt: session.approvedAt?.toISOString() ?? null,
  };
}

export async function approveDeviceAuthorization(userCode: string, userId: string): Promise<{ status: "approved" }> {
  const normalizedUserCode = normalizeUserCode(userCode);
  if (!normalizedUserCode) {
    throw new Error("user_code is required");
  }

  return db.$transaction(async (tx) => {
    const session = await tx.deviceAuthSession.findUnique({
      where: { userCode: normalizedUserCode },
    });
    if (!session) {
      throw new Error("Device authorization not found");
    }

    const now = new Date();
    if (session.status === "pending" && session.expiresAt.getTime() <= now.getTime()) {
      await tx.deviceAuthSession.updateMany({
        where: { id: session.id, status: "pending" },
        data: { status: "expired" },
      });
      throw new Error("Device authorization expired");
    }

    if (session.status === "expired") {
      throw new Error("Device authorization expired");
    }
    if (session.status === "denied") {
      throw new Error("Device authorization denied");
    }
    if (session.status === "consumed") {
      if (session.approvedByUserId === userId) {
        return { status: "approved" as const };
      }
      throw new Error("Device authorization already completed");
    }
    if (session.status === "approved") {
      if (session.approvedByUserId === userId) {
        return { status: "approved" as const };
      }
      throw new Error("Device authorization already approved by another account");
    }

    let tokenRecord = await tx.userToken.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!tokenRecord) {
      tokenRecord = await issueApiTokenRecord(
        tx,
        userId,
        session.hostname ? `config-${session.hostname}` : "config-device",
      );
    }

    if (!tokenRecord?.id) {
      throw new Error("Failed to issue device authorization token");
    }

    const updateResult = await tx.deviceAuthSession.updateMany({
      where: {
        id: session.id,
        status: "pending",
      },
      data: {
        status: "approved",
        approvedAt: now,
        approvedByUserId: userId,
        issuedUserTokenId: tokenRecord.id,
      },
    });

    if (updateResult.count === 1) {
      return { status: "approved" as const };
    }

    const latest = await tx.deviceAuthSession.findUnique({
      where: { id: session.id },
    });
    if (!latest) {
      throw new Error("Device authorization not found");
    }
    if (latest.approvedByUserId === userId && (latest.status === "approved" || latest.status === "consumed")) {
      return { status: "approved" as const };
    }
    if (latest.status === "approved" || latest.status === "consumed") {
      throw new Error("Device authorization already approved by another account");
    }
    if (latest.status === "expired") {
      throw new Error("Device authorization expired");
    }
    if (latest.status === "denied") {
      throw new Error("Device authorization denied");
    }

    throw new Error("Failed to approve device authorization");
  });
}

export async function pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthPollResult> {
  const session = await findSessionByDeviceCode(deviceCode);
  if (!session) {
    throw new Error("Invalid device code");
  }

  const status = await markExpiredIfNeeded(session);
  if (status === "pending") {
    return { status: "pending" };
  }
  if (status === "denied") {
    return { status: "denied", message: "Authorization denied" };
  }
  if (status === "expired") {
    return { status: "expired", message: "Authorization expired" };
  }
  if (status === "consumed") {
    return { status: "consumed", message: "Authorization already completed" };
  }

  const tokenRecord = session.issuedUserTokenId
    ? await db.userToken.findUnique({
        where: { id: session.issuedUserTokenId },
      })
    : null;

  if (!tokenRecord?.tokenValue || tokenRecord.revokedAt) {
    throw new Error("Authorized device token is unavailable");
  }

  const consumeResult = await deviceAuthSessions.updateMany({
    where: { id: session.id, status: "approved" },
    data: {
      status: "consumed",
      consumedAt: new Date(),
    },
  });

  if (consumeResult.count !== 1) {
    return { status: "consumed", message: "Authorization already completed" };
  }

  return {
    status: "approved",
    agentToken: tokenRecord.tokenValue,
  };
}
