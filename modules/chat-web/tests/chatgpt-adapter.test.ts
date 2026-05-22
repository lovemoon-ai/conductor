import { describe, expect, it } from "vitest";

import { ChatGPTAdapter } from "../src/providers/chatgpt.js";

/**
 * `getConversationId(page)` parses ChatGPT's conversation UUID out of the
 * page URL. We don't need a real Playwright Page — a minimal `{ url() }`
 * stub is enough to exercise every branch of the parser.
 */
function pageStub(url: string): import("playwright").Page {
  return { url: () => url } as unknown as import("playwright").Page;
}

describe("ChatGPTAdapter.getConversationId", () => {
  const adapter = new ChatGPTAdapter();

  it("extracts the UUID from chatgpt.com/c/{uuid}", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://chatgpt.com/c/6a103f7e-bd94-83ea-ae46-9652657bbedf"),
      ),
    ).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
  });

  it("works with a trailing slash", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://chatgpt.com/c/6a103f7e-bd94-83ea-ae46-9652657bbedf/"),
      ),
    ).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
  });

  it("works with a query string", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://chatgpt.com/c/6a103f7e-bd94-83ea-ae46-9652657bbedf?model=gpt-4o"),
      ),
    ).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
  });

  it("works with a hash fragment", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://chatgpt.com/c/6a103f7e-bd94-83ea-ae46-9652657bbedf#anchor"),
      ),
    ).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
  });

  it("returns null on the fresh-chat home url", () => {
    expect(adapter.getConversationId(pageStub("https://chatgpt.com/"))).toBeNull();
    expect(adapter.getConversationId(pageStub("https://chatgpt.com/?model=gpt-4o"))).toBeNull();
  });

  it("returns null on shareable / settings paths that aren't conversations", () => {
    expect(adapter.getConversationId(pageStub("https://chatgpt.com/g/g-foo/bar"))).toBeNull();
    expect(adapter.getConversationId(pageStub("https://chatgpt.com/settings"))).toBeNull();
  });

  it("returns null on accidentally-malformed URLs", () => {
    expect(adapter.getConversationId(pageStub(""))).toBeNull();
    expect(adapter.getConversationId(pageStub("not a url"))).toBeNull();
  });

  it("survives an alternate ChatGPT host (e.g. ab.chatgpt.com)", () => {
    expect(
      adapter.getConversationId(
        pageStub("https://ab.chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      ),
    ).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
