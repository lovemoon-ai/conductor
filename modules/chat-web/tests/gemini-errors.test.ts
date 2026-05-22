import { describe, expect, it } from "vitest";

import {
  ProviderApiKeyRequiredError,
  ProviderPermissionDeniedError,
} from "../src/core/errors.js";

describe("ProviderApiKeyRequiredError", () => {
  it("carries the correct code, provider, and an actionable hint", () => {
    const err = new ProviderApiKeyRequiredError("gemini");
    expect(err.code).toBe("PROVIDER_API_KEY_REQUIRED");
    expect(err.provider).toBe("gemini");
    expect(err.hint).toMatch(/aistudio\.google\.com\/app\/apikey/);
  });

  it("appends an optional detail to the message", () => {
    const err = new ProviderApiKeyRequiredError(
      "gemini",
      'AI Studio shows "No API key selected"',
    );
    expect(err.message).toMatch(/No API key selected/);
    expect(err.message).toMatch(/needs an API key/);
  });

  it("gives a generic hint for non-gemini providers", () => {
    const err = new ProviderApiKeyRequiredError("other");
    expect(err.hint).toMatch(/Configure an API key for other/);
  });
});

describe("ProviderPermissionDeniedError", () => {
  it("captures the upstream error text in the message", () => {
    const upstream = "Failed to generate content: permission denied. Please try again.";
    const err = new ProviderPermissionDeniedError("gemini", upstream);
    expect(err.code).toBe("PROVIDER_PERMISSION_DENIED");
    expect(err.message).toContain("permission denied");
    expect(err.hint).toMatch(/missing\/invalid API key|quota/);
  });
});
