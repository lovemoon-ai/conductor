import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppEnv, resolveEnvCandidates, resolveEnvFile } from "./env-utils";

const ENV_KEYS = ["DATABASE_URL", "NEXT_PUBLIC_URL"] as const;

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("env utils", () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("prefers production local env in production mode", () => {
    expect(resolveEnvCandidates("production")).toEqual([
      ".env.production.local",
      ".env.local",
      ".env.production",
      ".env",
    ]);
  });

  it("falls back to production local env when running non-production commands without .env.local", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-env-utils-"));
    fs.writeFileSync(path.join(tmpDir, ".env.production.local"), "DATABASE_URL=file:/tmp/prod.db\n");
    fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_URL=file:/tmp/default.db\n");

    expect(resolveEnvFile(tmpDir, "")).toBe(path.join(tmpDir, ".env.production.local"));
  });

  it("loads DATABASE_URL from production local env", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-env-load-"));
    fs.writeFileSync(
      path.join(tmpDir, ".env.production.local"),
      "DATABASE_URL=file:/tmp/prod.db\nNEXT_PUBLIC_URL=https://prod.example.com\n",
    );

    expect(loadAppEnv({ cwd: tmpDir, nodeEnv: "" })).toBe(path.join(tmpDir, ".env.production.local"));
    expect(process.env.DATABASE_URL).toBe("file:/tmp/prod.db");
    expect(process.env.NEXT_PUBLIC_URL).toBe("https://prod.example.com");
  });
});
