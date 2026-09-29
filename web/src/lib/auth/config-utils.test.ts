import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePublicBackendUrl } from "./config-utils";

describe("resolvePublicBackendUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites a stale retired-apex env value to the canonical host", () => {
    // Prod .env still carried the apex after it switched to 404, so resume
    // handoff links (`/share/<token>/plain`) pointed at a dead host.
    vi.stubEnv("NEXT_PUBLIC_URL", "https://conductor-ai.top/");
    expect(resolvePublicBackendUrl()).toBe("https://conductor.conductor-ai.top");
  });

  it("rewrites a retired-apex request origin fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_URL", "");
    vi.stubEnv("PUBLIC_BACKEND_URL", "");
    vi.stubEnv("BACKEND_URL", "");
    expect(resolvePublicBackendUrl("http://conductor-ai.top")).toBe(
      "https://conductor.conductor-ai.top",
    );
  });

  it("leaves other hosts untouched", () => {
    vi.stubEnv("NEXT_PUBLIC_URL", "http://localhost:6152");
    expect(resolvePublicBackendUrl()).toBe("http://localhost:6152");
  });
});
