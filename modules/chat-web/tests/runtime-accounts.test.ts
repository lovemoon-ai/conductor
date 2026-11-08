import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { saveRuntimeAccount, readRuntimeAccount } from "../src/runtime/accounts.js";

describe("runtime account bootstrap", () => {
  it("keeps login credentials private and excludes conversation drafts and selections", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-auth-"));
    try {
      for (const [provider, key] of [["kimi", "access_token"], ["deepseek", "userToken"]]) {
        await saveRuntimeAccount(provider!, { cookies: [], origins: [{
          origin: "https://example.test",
          localStorage: [{ name: key!, value: "fixture-credential" }, { name: "chatId", value: "other-conversation" }, { name: "__appKit_@deepseek/chat_lastSessionValue", value: "other-conversation" }],
          indexedDB: [{ name: "kimi-chat-draft", version: 1, stores: [] }],
        }] }, "default", directory);
        const saved = await readRuntimeAccount(provider!, "default", directory);
        expect(saved?.state.origins[0]?.localStorage).toEqual([{ name: key, value: "fixture-credential" }]);
        expect(saved?.state.origins[0]).not.toHaveProperty("indexedDB");
        if (process.platform !== "win32") {
          expect((await fs.stat(path.join(directory, provider!, "default.json"))).mode & 0o777).toBe(0o600);
          expect((await fs.stat(path.join(directory, provider!))).mode & 0o777).toBe(0o700);
        }
      }
      expect(await readRuntimeAccount("kimi", "missing", directory)).toBeUndefined();
      await expect(readRuntimeAccount("kimi", "../outside", directory)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
