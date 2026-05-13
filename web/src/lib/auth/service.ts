import { randomBytes, pbkdf2Sync, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { Prisma, type Project, type User } from "@prisma/client";
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
const DEFAULT_PROJECT_NAME = "Default Project";
const DEFAULT_PROJECT_METADATA = JSON.stringify({ autoCreated: true, isDefault: true });

const PROJECT_WITHOUT_SORT_ORDER_SELECT = {
  id: true,
  userId: true,
  name: true,
  daemonHost: true,
  workspacePath: true,
  repoRoot: true,
  worktreeBranch: true,
  lastCommit: true,
  lastCommitAt: true,
  fileCount: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

const parseProjectMetadata = (value: string | null): Record<string, unknown> | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isLegacyDefaultProject = (project: { metadata: string | null }): boolean => {
  const metadata = parseProjectMetadata(project.metadata);
  return Boolean(metadata?.autoCreated === true && metadata?.isDefault === true);
};

type DbClient = Prisma.TransactionClient;

const authErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissingProjectSortOrderColumnError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2022" &&
  (authErrorMessage(error).includes("sort_order") || authErrorMessage(error).includes("sortOrder"));

async function findDefaultProjectMapping(prisma: DbClient, userId: string) {
  try {
    return await prisma.defaultProject.findUnique({
      where: { userId },
      include: { project: true },
    });
  } catch (error) {
    if (!isMissingProjectSortOrderColumnError(error)) {
      throw error;
    }
    return prisma.defaultProject.findUnique({
      where: { userId },
      include: { project: { select: PROJECT_WITHOUT_SORT_ORDER_SELECT } },
    });
  }
}

export type AuthUser = { id: string; email: string | null; phone: string | null };
export type SelfHostBootstrapUserResult = {
  user: User;
  project: Project;
  normalizedPhone: string;
  created: boolean;
};

export function hashSecret(secret: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt ?? randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return { hash, salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const computed = pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return timingSafeEqual(Buffer.from(hash, "hex"), computed);
}

export function normalizeSelfHostBootstrapPhone(rawPhone: string): string {
  const normalized = rawPhone.trim().replace(/\s+/g, "");
  if (!normalized.startsWith("+")) {
    throw new Error("Phone must start with '+' and include country code");
  }
  if (!/^\+\d+$/.test(normalized)) {
    throw new Error("Phone must contain only '+' and digits");
  }
  return normalized;
}

export async function ensureDefaultProject(userId: string, client?: DbClient): Promise<Project> {
  const prisma = client ?? db;
  const existingDefault = await findDefaultProjectMapping(prisma, userId);
  if (existingDefault?.project) {
    return existingDefault.project as Project;
  }

  const legacyCandidates = await prisma.project.findMany({
    where: {
      userId,
      daemonHost: null,
    },
    orderBy: { createdAt: "asc" },
    select: PROJECT_WITHOUT_SORT_ORDER_SELECT,
  });
  const legacyDefault = legacyCandidates.find(isLegacyDefaultProject) ?? null;
  if (legacyDefault) {
    await prisma.defaultProject.upsert({
      where: { userId },
      update: { projectId: legacyDefault.id },
      create: { userId, projectId: legacyDefault.id },
    });
    return legacyDefault as Project;
  }

  try {
    const project = await prisma.project.create({
      data: {
        userId,
        name: DEFAULT_PROJECT_NAME,
        metadata: DEFAULT_PROJECT_METADATA,
      },
      select: PROJECT_WITHOUT_SORT_ORDER_SELECT,
    });
    await prisma.defaultProject.create({
      data: {
        userId,
        projectId: project.id,
      },
    });
    return project as Project;
  } catch {
    const createdDefault = await findDefaultProjectMapping(prisma, userId);
    if (createdDefault?.project) {
      return createdDefault.project as Project;
    }
    const createdCandidates = await prisma.project.findMany({
      where: { userId, daemonHost: null },
      orderBy: { createdAt: "asc" },
      select: PROJECT_WITHOUT_SORT_ORDER_SELECT,
    });
    const created = createdCandidates.find(isLegacyDefaultProject) ?? null;
    if (!created) {
      throw new Error("Failed to ensure default project");
    }
    await prisma.defaultProject.upsert({
      where: { userId },
      update: { projectId: created.id },
      create: { userId, projectId: created.id },
    });
    return created as Project;
  }
}

function createPlaceholderPassword() {
  const placeholder = randomBytes(16).toString("hex");
  return hashSecret(placeholder);
}

export async function bootstrapSelfHostUserByPhone(rawPhone: string): Promise<SelfHostBootstrapUserResult> {
  const normalizedPhone = normalizeSelfHostBootstrapPhone(rawPhone);

  const loadExistingUser = async () => {
    const existing = await db.user.findUnique({
      where: { phone: normalizedPhone },
    });

    if (!existing) {
      return null;
    }

    const project = await ensureDefaultProject(existing.id);
    return {
      user: existing,
      project,
      normalizedPhone,
      created: false,
    } satisfies SelfHostBootstrapUserResult;
  };

  const existing = await loadExistingUser();
  if (existing) {
    return existing;
  }

  let user: User;
  let project: Project;
  try {
    ({ user, project } = await db.$transaction(async (tx) => {
      const { hash, salt } = createPlaceholderPassword();
      const user = await tx.user.create({
        data: {
          email: null,
          phone: normalizedPhone,
          passwordHash: hash,
          passwordSalt: salt,
        },
      });

      await startNewUserPlusAccess(user.id, tx);
      const project = await ensureDefaultProject(user.id, tx);

      const hydratedUser = await tx.user.findUnique({
        where: { id: user.id },
      });
      if (!hydratedUser) {
        throw new Error("Failed to load bootstrap user");
      }

      return {
        user: hydratedUser,
        project,
      };
    }));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const concurrentExisting = await loadExistingUser();
      if (concurrentExisting) {
        return concurrentExisting;
      }
    }
    throw error;
  }

  return {
    user,
    project,
    normalizedPhone,
    created: true,
  };
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
    await ensureDefaultProject(existing.id);
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

      await ensureDefaultProject(created.id, tx);

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
  await ensureDefaultProject(user.id);

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
