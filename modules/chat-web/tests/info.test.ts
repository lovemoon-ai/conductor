import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatInfo, info } from "../src/commands/info.js";
import { createProfileManager } from "../src/core/profile-manager.js";
import { registerBuiltinProviders } from "../src/providers/index.js";

describe("info command (filesystem-only mode)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chat-web-info-test-"));
    process.env.CHAT_WEB_HOME = tmp;
    registerBuiltinProviders();
  });

  afterEach(async () => {
    delete process.env.CHAT_WEB_HOME;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports profile=no when nothing has been saved yet", async () => {
    const rows = await info();
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("chatgpt");
    expect(names).toContain("deepseek");
    expect(names).toContain("gemini");
    expect(names).toContain("aistudio");
    for (const r of rows) {
      expect(r.profileExists).toBe(false);
      expect(r.loggedIn).toBeUndefined();
      expect(r.profileLastUsed).toBeUndefined();
    }
  });

  it("reports profile=yes once the profile dir exists", async () => {
    await createProfileManager().ensureProfile("chatgpt");
    const rows = await info({ provider: "chatgpt" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profileExists).toBe(true);
    expect(rows[0]!.profileLastUsed).toBeTruthy();
  });

  it("formats nicely with a helpful next-step hint when not signed in", async () => {
    const rows = await info({ provider: "chatgpt" });
    const out = formatInfo(rows);
    expect(out).toMatch(/Provider:\s+chatgpt/);
    expect(out).toMatch(/chat-web login chatgpt/);
  });

  it("respects an explicit provider filter", async () => {
    const rows = await info({ provider: "deepseek" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("deepseek");
  });
});
