import { describe, expect, it } from "vitest";

import { AIStudioAdapter, stripChromeFromTurn } from "../src/providers/aistudio.js";

describe("AIStudioAdapter — target product", () => {
  it("points at the developer playground (aistudio.google.com), distinct from the gemini consumer chat", () => {
    const adapter = new AIStudioAdapter();
    expect(adapter.homeUrl).toMatch(/^https:\/\/aistudio\.google\.com\/prompts\/new_chat/);
    expect(adapter.name).toBe("aistudio");
  });
});

describe("AIStudioAdapter.stripChromeFromTurn", () => {
  it("removes the 'Model HH:MM AM/PM' header that leaks from innerText", () => {
    const raw = ["Model 5:54 PM", "actual response"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("actual response");
  });

  it("removes single-line Material icon font ligatures", () => {
    const raw = ["edit", "more_vert", "Model 9:01 AM", "real content", "content_copy", "thumb_up", "thumb_down"].join(
      "\n",
    );
    expect(stripChromeFromTurn(raw)).toBe("real content");
  });

  it("preserves a ligature word when it appears as part of a sentence", () => {
    const raw = ["Model 1:23 PM", "an error occurred while parsing"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("an error occurred while parsing");
  });

  it("returns '' on empty / chrome-only input", () => {
    expect(stripChromeFromTurn("")).toBe("");
    expect(stripChromeFromTurn(["edit", "Model 5:54 PM", "content_copy"].join("\n"))).toBe("");
  });
});

describe("AIStudioAdapter.getConversationId", () => {
  function pageStub(url: string): import("playwright").Page {
    return { url: () => url } as unknown as import("playwright").Page;
  }

  const adapter = new AIStudioAdapter();

  it("returns null when on the placeholder /prompts/new_chat URL", () => {
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
    expect(adapter.getConversationId(pageStub("https://aistudio.google.com/settings"))).toBeNull();
  });
});
