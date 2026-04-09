import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loginWithCode, registerWithCode } from "./service";

const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
const verificationTargets = new Set<string>();

function futureDate(days = 1): Date {
  const next = new Date();
  next.setDate(next.getDate() + days);
  return next;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

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
