import { describe, expect, it } from "vitest";
import { evaluateRuntimeHealth } from "@/lib/tasks/runtime-preflight";

const agent = (runtimeHealth?: Record<string, string>) => ({
  host: "daemon-1",
  runtimeHealth,
});

describe("evaluateRuntimeHealth", () => {
  it("returns null when the daemon advertises the backend as ready", () => {
    expect(evaluateRuntimeHealth({ agent: agent({ claude: "ready" }), backend: "claude" })).toBeNull();
  });

  it("fails open when no health is advertised for the backend", () => {
    expect(evaluateRuntimeHealth({ agent: agent({ codex: "ready" }), backend: "claude" })).toBeNull();
    expect(evaluateRuntimeHealth({ agent: agent(undefined), backend: "claude" })).toBeNull();
  });

  it("fails open on an unknown/future health state", () => {
    expect(
      evaluateRuntimeHealth({ agent: agent({ claude: "degraded" }), backend: "claude" }),
    ).toBeNull();
  });

  it("treats `missing` as advisory and does NOT block", () => {
    // `missing` comes from a PATH `which` probe that cannot see custom/absolute
    // CLI paths, so it must never hard-block task creation.
    expect(
      evaluateRuntimeHealth({ agent: agent({ claude: "missing" }), backend: "claude" }),
    ).toBeNull();
  });

  it("returns null when there is no backend or agent", () => {
    expect(evaluateRuntimeHealth({ agent: agent({ claude: "error" }), backend: null })).toBeNull();
    expect(evaluateRuntimeHealth({ agent: null, backend: "claude" })).toBeNull();
  });

  it("flags an unauthenticated backend", () => {
    const problem = evaluateRuntimeHealth({
      agent: agent({ codex: "unauthenticated" }),
      backend: "codex",
    });
    expect(problem?.reason).toBe("unauthenticated");
    expect(problem?.recovery).toContain("Sign in");
  });

  it("is case-insensitive on the backend name", () => {
    const problem = evaluateRuntimeHealth({ agent: agent({ claude: "error" }), backend: "Claude" });
    expect(problem?.reason).toBe("error");
  });
});
