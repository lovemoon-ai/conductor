import { describe, expect, it } from "vitest";

import { GeminiAdapter, stripChromeFromTurn } from "../src/providers/gemini.js";

describe("GeminiAdapter — target product", () => {
  it("points at the consumer chat (gemini.google.com), not the AI Studio playground", () => {
    const adapter = new GeminiAdapter();
    // AI Studio (aistudio.google.com) requires an API key and is a
    // developer playground — wrong product surface for chat-web's
    // consumer-chat automation model. The consumer chat is at
    // gemini.google.com and matches the chatgpt.com persistent-profile UX.
    expect(adapter.homeUrl).toMatch(/^https:\/\/gemini\.google\.com\/app(\b|$)/);
    expect(adapter.homeUrl).not.toMatch(/aistudio/);
  });
});

describe("stripChromeFromTurn (gemini.google.com)", () => {
  it("strips the 'Gemini said' prefix that <model-response> wraps around content", () => {
    expect(stripChromeFromTurn("Gemini said\n\nHello!")).toBe("Hello!");
  });

  it("is case-insensitive and tolerant of extra whitespace", () => {
    expect(stripChromeFromTurn("gemini said\nhi")).toBe("hi");
    expect(stripChromeFromTurn("Gemini said   actual content")).toBe("actual content");
  });

  it("returns text verbatim when there is no chrome prefix", () => {
    expect(stripChromeFromTurn("Hello! Thanks for dropping in.")).toBe(
      "Hello! Thanks for dropping in.",
    );
  });

  it("preserves multi-paragraph content after the prefix", () => {
    expect(stripChromeFromTurn("Gemini said\n\npara 1\n\npara 2")).toBe("para 1\n\npara 2");
  });

  it("returns '' for empty input", () => {
    expect(stripChromeFromTurn("")).toBe("");
  });

  it("does NOT strip the legacy AI Studio chrome — that was a different product", () => {
    // AI Studio's leaks (Model HH:MM AM/PM header, "edit"/"more_vert"
    // icon ligatures) don't appear on gemini.google.com's
    // <message-content>, so we no longer remove them. If they ever
    // show up, the right fix is a new helper, not extending this one.
    const aiStudioStyle = ["edit", "more_vert", "Model 5:54 PM", "real content"].join("\n");
    // Output is identical because no "Gemini said" prefix is present.
    expect(stripChromeFromTurn(aiStudioStyle)).toBe(aiStudioStyle.trim());
  });
});

describe("GeminiAdapter.getConversationId", () => {
  function pageStub(url: string): import("playwright").Page {
    return { url: () => url } as unknown as import("playwright").Page;
  }

  const adapter = new GeminiAdapter();

  it("extracts the conversation id from gemini.google.com/app/{id}", () => {
    expect(
      adapter.getConversationId(pageStub("https://gemini.google.com/app/372437d29c30422f")),
    ).toBe("372437d29c30422f");
  });

  it("works with trailing slash / query / hash", () => {
    expect(
      adapter.getConversationId(pageStub("https://gemini.google.com/app/abc12345abcd1234/")),
    ).toBe("abc12345abcd1234");
    expect(
      adapter.getConversationId(pageStub("https://gemini.google.com/app/abc12345abcd1234?foo=bar")),
    ).toBe("abc12345abcd1234");
    expect(
      adapter.getConversationId(pageStub("https://gemini.google.com/app/abc12345abcd1234#anchor")),
    ).toBe("abc12345abcd1234");
  });

  it("also accepts UUID-shaped ids", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://gemini.google.com/app/6a103f7e-bd94-83ea-ae46-9652657bbedf"),
      ),
    ).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
  });

  it("returns null on the bare /app home (no conversation yet)", () => {
    expect(adapter.getConversationId(pageStub("https://gemini.google.com/app"))).toBeNull();
    expect(adapter.getConversationId(pageStub("https://gemini.google.com/app/"))).toBeNull();
  });

  it("returns null on auth / signin pages", () => {
    expect(
      adapter.getConversationId(pageStub("https://accounts.google.com/signin/v2/identifier")),
    ).toBeNull();
  });
});
