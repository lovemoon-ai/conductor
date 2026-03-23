import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBootstrapEnv,
  parseBootstrapArgs,
  resolveBootstrapBaseUrl,
  resolveBootstrapEnvFile,
} from "./bootstrap-self-host-user-lib";

const envKeys = ["NEXT_PUBLIC_URL", "PUBLIC_BACKEND_URL", "API_BASE_URL", "DATABASE_URL"] as const;

function clearEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

describe("bootstrap self-host script helpers", () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("prefers .env.production.local for self-host bootstrap", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-bootstrap-env-"));
    fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_URL=file:/tmp/default.db\n");
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "DATABASE_URL=file:/tmp/local.db\n");
    fs.writeFileSync(path.join(tmpDir, ".env.production.local"), "DATABASE_URL=file:/tmp/prod.db\n");

    expect(resolveBootstrapEnvFile(tmpDir)).toBe(path.join(tmpDir, ".env.production.local"));
  });

  it("loads DATABASE_URL from .env.production.local", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-bootstrap-load-"));
    fs.writeFileSync(path.join(tmpDir, ".env.production.local"), "DATABASE_URL=file:/tmp/prod.db\nNEXT_PUBLIC_URL=https://prod.example.com\n");

    expect(loadBootstrapEnv(tmpDir)).toBe(path.join(tmpDir, ".env.production.local"));
    expect(process.env.DATABASE_URL).toBe("file:/tmp/prod.db");
    expect(process.env.NEXT_PUBLIC_URL).toBe("https://prod.example.com");
  });

  it("resolves base url from env when explicit flag is absent", () => {
    process.env.NEXT_PUBLIC_URL = "https://selfhost.example.com";
    expect(resolveBootstrapBaseUrl(null)).toBe("https://selfhost.example.com/");
  });

  it("parses phone and base-url arguments", () => {
    expect(parseBootstrapArgs(["--phone", "+8613800138000", "--base-url", "https://a.example.com"])).toEqual({
      help: false,
      phone: "+8613800138000",
      baseUrl: "https://a.example.com",
    });
  });
});
