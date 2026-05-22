import { describe, expect, it } from "vitest";

import {
  ChatWebError,
  InputNotFoundError,
  NotLoggedInError,
  ResponseTimeoutError,
  UnknownProviderError,
} from "../src/core/errors.js";

describe("typed errors", () => {
  it("NotLoggedInError carries a code and hint", () => {
    const err = new NotLoggedInError("chatgpt");
    expect(err).toBeInstanceOf(ChatWebError);
    expect(err.code).toBe("NOT_LOGGED_IN");
    expect(err.provider).toBe("chatgpt");
    expect(err.hint).toMatch(/chat-web login chatgpt/);
  });

  it("InputNotFoundError suggests doctor", () => {
    const err = new InputNotFoundError("deepseek");
    expect(err.code).toBe("INPUT_NOT_FOUND");
    expect(err.hint).toMatch(/doctor deepseek/);
  });

  it("ResponseTimeoutError doubles the timeout suggestion", () => {
    const err = new ResponseTimeoutError("chatgpt", 60_000);
    expect(err.code).toBe("RESPONSE_TIMEOUT");
    expect(err.hint).toMatch(/--timeout 120000/);
  });

  it("UnknownProviderError lists known providers", () => {
    const err = new UnknownProviderError("foo", ["chatgpt", "deepseek"]);
    expect(err.message).toMatch(/chatgpt/);
    expect(err.message).toMatch(/deepseek/);
  });
});
