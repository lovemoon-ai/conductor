import { describe, expect, it } from "vitest";

import { UnknownProviderError } from "../src/core/errors.js";
import { getProvider, listProviders, registerProvider } from "../src/core/provider.js";
import { registerBuiltinProviders } from "../src/providers/index.js";

describe("provider registry", () => {
  it("registers the bundled providers", () => {
    registerBuiltinProviders();
    const names = listProviders();
    expect(names).toContain("chatgpt");
    expect(names).toContain("deepseek");
    expect(names).toContain("gemini");
  });

  it("targets AI Studio's prompts/new_chat (what users call 'Gemini free web chat')", () => {
    registerBuiltinProviders();
    const gemini = getProvider("gemini");
    // The page is freely usable for chat without entering an API key.
    // (gemini.google.com is a different consumer surface that many user
    // networks block at the DNS layer; we don't target it.)
    expect(gemini.homeUrl).toMatch(/^https:\/\/aistudio\.google\.com\/prompts\/new_chat(\b|$)/);
  });

  it("throws UnknownProviderError for unknown names", () => {
    registerBuiltinProviders();
    expect(() => getProvider("does-not-exist")).toThrowError(UnknownProviderError);
  });

  it("can register a custom provider", () => {
    registerProvider({
      name: "fake",
      homeUrl: "https://example.com",
      async open() {},
      async isLoggedIn() {
        return true;
      },
      async findInput() {
        throw new Error("not implemented");
      },
      async findSendButton() {
        return null;
      },
      async sendMessage() {},
      async waitForResponse() {
        return "";
      },
      async extractLastAssistantMessage() {
        return "";
      },
    });
    expect(getProvider("fake").name).toBe("fake");
  });
});
