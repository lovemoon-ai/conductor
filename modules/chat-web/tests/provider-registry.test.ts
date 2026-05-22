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

  it("exposes the gemini home URL with the requested model", () => {
    registerBuiltinProviders();
    const gemini = getProvider("gemini");
    expect(gemini.homeUrl).toContain("aistudio.google.com");
    expect(gemini.homeUrl).toContain("gemini-3.5-flash");
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
