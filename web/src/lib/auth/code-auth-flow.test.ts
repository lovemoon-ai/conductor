import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loginWithCode, registerWithCode } from "./service";

const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
const verificationTargets = new Set<string>();

async function ignoreExistingSchema(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("duplicate column name") ||
      message.includes("already exists")
    ) {
      return;
    }
    throw error;
  }
}

function futureDate(days = 1): Date {
  const next = new Date();
  next.setDate(next.getDate() + days);
  return next;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

beforeAll(async () => {
  await ignoreExistingSchema(() => prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "project_collaborations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "invite_token" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await ignoreExistingSchema(() => prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "project_collaborations_invite_token_key"
    ON "project_collaborations"("invite_token")
  `));
  await ignoreExistingSchema(() => prisma.$executeRawUnsafe(`
    ALTER TABLE "projects" ADD COLUMN "collaboration_id" TEXT
  `));
  await ignoreExistingSchema(() => prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "collaboration_members" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "collaboration_id" TEXT NOT NULL,
      "user_id" TEXT NOT NULL,
      "project_id" TEXT NOT NULL,
      "joined_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `));
});

afterEach(async () => {
  if (verificationTargets.size > 0) {
    await prisma.verification.deleteMany({
      where: {
        target: {
          in: [...verificationTargets],
        },
      },
    });
    verificationTargets.clear();
  }

  if (createdUserIds.size > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [...createdUserIds],
        },
      },
    });
    createdUserIds.clear();
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("code auth default project repair", () => {
  it("creates the default_project mapping when a new user registers", async () => {
    const email = uniqueEmail("register-default-project");
    verificationTargets.add(email);

    await prisma.verification.create({
      data: {
        target: email,
        code: "123456",
        type: "EMAIL",
        expiresAt: futureDate(),
        verified: false,
      },
    });

    const result = await registerWithCode({
      email,
      code: "123456",
    });
    createdUserIds.add(result.user.id);

    const defaultProject = await prisma.defaultProject.findUnique({
      where: { userId: result.user.id },
      include: { project: true },
    });

    expect(result.registered).toBe(true);
    expect(defaultProject?.projectId).toBeTruthy();
    expect(defaultProject?.project.name).toBe("Default Project");
  });

  it("repairs a legacy default project mapping during login", async () => {
    const email = uniqueEmail("login-default-project-repair");
    verificationTargets.add(email);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "hash",
        passwordSalt: "salt",
      },
    });
    createdUserIds.add(user.id);

    const legacyProject = await prisma.project.create({
      data: {
        userId: user.id,
        name: "Default Project",
        metadata: JSON.stringify({ autoCreated: true, isDefault: true }),
      },
    });

    await prisma.verification.create({
      data: {
        target: email,
        code: "654321",
        type: "EMAIL",
        expiresAt: futureDate(),
        verified: false,
      },
    });

    const result = await loginWithCode({
      identifier: email,
      code: "654321",
    });

    const defaultProject = await prisma.defaultProject.findUnique({
      where: { userId: user.id },
      include: { project: true },
    });

    expect(result.user.id).toBe(user.id);
    expect(defaultProject?.projectId).toBe(legacyProject.id);
    expect(defaultProject?.project.name).toBe("Default Project");
  });
});
