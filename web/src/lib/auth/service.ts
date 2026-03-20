import { randomBytes, pbkdf2Sync, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { sendVerificationEmail } from "@/lib/verification/resend-email";
import { sendVerificationSms } from "@/lib/verification/volc-sms";
import { startNewUserPlusAccess } from "@/lib/subscription/service";
import { findInviterByCode, applyInviteRegisterRewardPolicy } from "@/lib/invite/service";

const JWT_SECRET = process.env.JWT_SECRET || "conductor-jwt-secret";
const DEV_CODE = process.env.AUTH_DEV_CODE?.trim() || "000000";
const isDev = process.env.NODE_ENV === "development";

// PBKDF2 parameters (must match old backend)
const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

export type AuthUser = { id: string; email: string | null; phone: string | null };

export function hashSecret(secret: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt ?? randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return { hash, salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const computed = pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return timingSafeEqual(Buffer.from(hash, "hex"), computed);
}

export function signJwt(userId: string): string {
  return jwt.sign({ sub: userId, role: "user" }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyJwt(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string };
  } catch {
    return null;
  }
}

export async function authenticateToken(token: string): Promise<AuthUser | null> {
  if (token.includes(".")) {
    const payload = verifyJwt(token);
    if (!payload) return null;
    const user = await db.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;
    return { id: user.id, email: user.email, phone: user.phone };
  }

  const tokenPrefix = token.slice(0, 8);
  const candidates = await db.userToken.findMany({
    where: { tokenPrefix, revokedAt: null },
    include: { user: true },
  });

  for (const candidate of candidates) {
    if (verifySecret(token, candidate.tokenHash, candidate.tokenSalt)) {
      await db.userToken.update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      });
      return { id: candidate.user.id, email: candidate.user.email, phone: candidate.user.phone };
    }
  }
  return null;
}

export async function requestCode(input: { email?: string; phone?: string; countryCode?: string }): Promise<{ code?: string; expiresIn: number }> {
  const email = input.email?.trim();
  const phone = input.phone?.trim();
  const countryCode = input.countryCode?.trim() || "+86";
  if (!email && !phone) throw new Error("Email or phone required");

  // For phone, store with country code prefix
  const target = email ?? `${countryCode}${phone}`;
  const type = email ? "EMAIL" : "SMS";
  const code = isDev && DEV_CODE ? DEV_CODE : Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.verification.create({
    data: { target, code, type, expiresAt },
  });

  if (!(isDev && DEV_CODE)) {
    if (email) {
      await sendVerificationEmail(email, code);
    } else {
      await sendVerificationSms(phone!, code, countryCode);
    }
  } else {
    console.log(`[DEV] Using dev code ${code} for ${target}`);
  }

  return { code: isDev && DEV_CODE ? code : undefined, expiresIn: 300 };
}

async function verifyCode(target: string, code: string, type: "EMAIL" | "SMS"): Promise<boolean> {
  const now = new Date();
  const record = await db.verification.findFirst({
    where: { target, code, type, verified: false, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });

  if (record) {
    await db.verification.update({
      where: { id: record.id },
      data: { verified: true },
    });
    return true;
  }

  return Boolean(isDev && DEV_CODE && code === DEV_CODE);
}

export async function registerWithCode(input: {
  email?: string;
  phone?: string;
  countryCode?: string;
  code: string;
  inviteCode?: string;
}) {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  const countryCode = input.countryCode?.trim() || "+86";
  if (!email && !phone) throw new Error("Email or phone is required");

  // For phone, use full phone number with country code
  const target = email ?? `${countryCode}${phone}`;
  const type = email ? "EMAIL" : "SMS";
  const ok = await verifyCode(target, input.code, type);
  if (!ok) throw new Error("Invalid verification code");

  const inviteCode = input.inviteCode?.trim().toUpperCase();
  const inviter = inviteCode ? await findInviterByCode(inviteCode) : null;
  if (inviteCode && !inviter) {
    throw new Error("Invalid invite code");
  }

  const existing = email
    ? await db.user.findUnique({ where: { email } })
    : phone
    ? await db.user.findUnique({ where: { phone: target } })
    : null;

  if (existing) {
    return { token: signJwt(existing.id), user: { id: existing.id, email: existing.email, phone: existing.phone }, registered: false };
  }

  const placeholder = randomBytes(16).toString("hex");
  const { hash, salt } = hashSecret(placeholder);

  const now = new Date();

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, phone: phone ? target : null, passwordHash: hash, passwordSalt: salt },
    });

    // Start free trial for new user
    await startNewUserPlusAccess(created.id, tx);

    if (inviter && inviter.id !== created.id) {
      await tx.user.update({
        where: { id: created.id },
        data: {
          invitedByUserId: inviter.id,
          inviteRegisteredRewardAt: now,
        },
      });
      await applyInviteRegisterRewardPolicy(inviter.id, created.id, inviteCode!, tx);
    }

    await tx.project.create({
      data: {
        userId: created.id,
        name: "Default Project",
        metadata: JSON.stringify({ autoCreated: true, isDefault: true }),
      },
    });

    return created;
  });

  return {
    token: signJwt(user.id),
    user: { id: user.id, email: user.email, phone: user.phone },
    registered: true,
  };
}

export async function loginWithCode(input: { identifier: string; code: string }) {
  const identifier = input.identifier.trim();
  const type = identifier.includes("@") ? "EMAIL" : "SMS";
  const ok = await verifyCode(identifier, input.code, type);
  if (!ok) throw new Error("Invalid verification code");
  const user = identifier.includes("@")
    ? await db.user.findUnique({ where: { email: identifier } })
    : await db.user.findUnique({ where: { phone: identifier } });

  if (!user) throw new Error("Account not found");

  return { token: signJwt(user.id), user: { id: user.id, email: user.email, phone: user.phone } };
}

export async function issueApiToken(userId: string, name?: string | null) {
  const rawToken = randomBytes(24).toString("hex");
  const { hash, salt } = hashSecret(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  const record = await db.userToken.create({
    data: { userId, name, tokenHash: hash, tokenSalt: salt, tokenPrefix, tokenValue: rawToken },
  });

  return { token: rawToken, tokenId: record.id, tokenPrefix, createdAt: record.createdAt.toISOString() };
}

export async function getLatestTokenValue(userId: string): Promise<string | null> {
  const latest = await db.userToken.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return latest?.tokenValue ?? null;
}

export async function listTokens(userId: string) {
  const tokens = await db.userToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return tokens.map((t) => ({
    id: t.id,
    name: t.name,
    token_prefix: t.tokenPrefix,
    created_at: t.createdAt.toISOString(),
    last_used_at: t.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await db.userToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}
