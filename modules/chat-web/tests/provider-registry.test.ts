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
    expect(names).toContain("aistudio");
  });

  it("gemini and aistudio are SEPARATE providers (different products under the same brand)", () => {
    registerBuiltinProviders();
    const gemini = getProvider("gemini");
    const aistudio = getProvider("aistudio");
    expect(gemini.homeUrl).toMatch(/gemini\.google\.com/);
    expect(aistudio.homeUrl).toMatch(/aistudio\.google\.com/);
    expect(gemini).not.toBe(aistudio);
  });

  it("exposes the gemini consumer-chat home URL (NOT AI Studio)", () => {
    registerBuiltinProviders();
    const gemini = getProvider("gemini");
    // chat-web's Gemini integration deliberately targets the consumer
    // chat at gemini.google.com (free with Google login, matches the
    // chatgpt.com persistent-profile UX). AI Studio is a separate
    // developer playground that requires an API key per request.
    expect(gemini.homeUrl).toMatch(/^https:\/\/gemini\.google\.com\/app(\b|$)/);
    expect(gemini.homeUrl).not.toMatch(/aistudio/);
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
