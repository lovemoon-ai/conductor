import { describe, expect, it } from "vitest";

import { GeminiAdapter, stripChromeFromTurn } from "../src/providers/gemini.js";

describe("GeminiAdapter — target product", () => {
  it("points at AI Studio's prompts/new_chat (what users mean by 'Gemini' free web chat)", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.homeUrl).toMatch(/^https:\/\/aistudio\.google\.com\/prompts\/new_chat(\b|$)/);
  });
});

describe("GeminiAdapter.stripChromeFromTurn", () => {
  it("removes the 'Model HH:MM AM/PM' turn header that leaks from innerText", () => {
    const raw = [
      "edit",
      "more_vert",
      "Model 5:54 PM",
      "Gemini 是 Google 开发的多模态大语言模型家族。",
      "content_copy",
      "thumb_up",
      "thumb_down",
    ].join("\n");
    expect(stripChromeFromTurn(raw)).toBe(
      "Gemini 是 Google 开发的多模态大语言模型家族。",
    );
  });

  it("keeps multi-line content while dropping chrome", () => {
    const raw = ["Model 9:01 AM", "error", "Real model output here.", "content_copy"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("Real model output here.");
  });

  it("does NOT drop a line where the ligature word is embedded in a sentence", () => {
    const raw = ["Model 1:23 PM", "an error occurred while parsing"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("an error occurred while parsing");
  });

  it("handles 24-hour-style headers", () => {
    const raw = ["Model 14:05", "Hello"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("Hello");
  });

  it("returns '' when only chrome is present", () => {
    const raw = ["edit", "more_vert", "Model 5:54 PM", "content_copy"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("");
  });

  it("preserves intentional blank lines between paragraphs", () => {
    const raw = [
      "Model 5:54 PM",
      "Paragraph one.",
      "",
      "Paragraph two.",
      "content_copy",
    ].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("Paragraph one.\n\nParagraph two.");
  });

  it("returns '' on empty input", () => {
    expect(stripChromeFromTurn("")).toBe("");
  });
});

describe("GeminiAdapter.getConversationId", () => {
  function pageStub(url: string): import("playwright").Page {
    return { url: () => url } as unknown as import("playwright").Page;
  }

  const adapter = new GeminiAdapter();

  it("returns null on the placeholder /prompts/new_chat URL", () => {
    expect(adapter.getConversationId(pageStub("https://aistudio.google.com/prompts/new_chat"))).toBeNull();
    expect(
      adapter.getConversationId(pageStub("https://aistudio.google.com/prompts/new_chat?model=gemini-2.5-flash")),
    ).toBeNull();
  });

  it("extracts the slug from /prompts/{slug} once the prompt is saved", () => {
    expect(
      adapter.getConversationId(pageStub("https://aistudio.google.com/prompts/abc12345-deadbeef")),
    ).toBe("abc12345-deadbeef");
  });

  it("returns null for unrelated paths", () => {
    expect(adapter.getConversationId(pageStub("https://aistudio.google.com/"))).toBeNull();
    expect(adapter.getConversationId(pageStub("https://accounts.google.com/signin"))).toBeNull();
  });
});
