import { describe, it, expect, vi } from "vitest";
import { login } from "../src/commands/login.js";
import { ChatSession } from "../src/session.js";

describe("login confirmation", () => {
  it("fails a timed-out login without announcing a saved account", async () => {
    const close = vi.fn(async () => {});
    const messages: string[] = [];
    const open = vi.spyOn(ChatSession, "open").mockResolvedValue({
      provider: "deepseek", userDataDir: "/fixture", isLoggedIn: async () => false, close,
    } as unknown as ChatSession);
    try {
      await expect(login("deepseek", { autoExit: true, timeoutMs: 1, pollIntervalMs: 2,
        logger: { level: "silent", info: (value: unknown) => messages.push(String(value)), warn: () => {}, error: () => {}, debug: () => {} },
      })).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
      expect(close).toHaveBeenCalledOnce();
      expect(messages.join(" ")).not.toMatch(/Detected logged-in|Saved persistent/);
    } finally { open.mockRestore(); }
  });
});
