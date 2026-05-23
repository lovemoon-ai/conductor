import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProfileManager } from "../src/core/profile-manager.js";
import { profileDir, profilesDir } from "../src/core/paths.js";

describe("profile manager", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chat-web-test-"));
    process.env.CHAT_WEB_HOME = tmp;
  });

  afterEach(async () => {
    delete process.env.CHAT_WEB_HOME;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates the profile dir on ensureProfile", async () => {
    const pm = createProfileManager();
    const dir = await pm.ensureProfile("chatgpt");
    expect(dir).toBe(profileDir("chatgpt"));
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("sanitises unusual provider names so we don't path-escape", async () => {
    const pm = createProfileManager();
    const dir = await pm.ensureProfile("evil/../name");
    expect(dir.startsWith(profilesDir())).toBe(true);
    expect(dir).not.toContain("..");
  });

  it("listProfiles returns the created profiles", async () => {
    const pm = createProfileManager();
    await pm.ensureProfile("chatgpt");
    await pm.ensureProfile("deepseek");
    const list = await pm.listProfiles();
    expect(list.sort()).toEqual(["chatgpt", "deepseek"]);
  });

  it("listProfiles returns [] when no profiles exist yet", async () => {
    const pm = createProfileManager();
    const list = await pm.listProfiles();
    expect(list).toEqual([]);
  });

  it("clearProfile removes the directory", async () => {
    const pm = createProfileManager();
    const dir = await pm.ensureProfile("chatgpt");
    await pm.clearProfile("chatgpt");
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
