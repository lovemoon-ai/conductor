import { describe, expect, it } from "vitest";
import {
  MAX_AGENTS_PER_TASK,
  buildAgentBootstrap,
  buildGroupMemberMetadata,
  parseAgentsInput,
} from "./agent-group";

describe("parseAgentsInput", () => {
  it("returns null when the field is absent", () => {
    expect(parseAgentsInput(undefined)).toBeNull();
    expect(parseAgentsInput(null)).toBeNull();
  });

  it("accepts a valid ordered list of bare names (backend null)", () => {
    expect(parseAgentsInput(["feature-dev", "code-reviewer"])).toEqual({
      agents: [
        { name: "feature-dev", backend: null },
        { name: "code-reviewer", backend: null },
      ],
    });
  });

  it("accepts object entries with per-agent backend", () => {
    expect(
      parseAgentsInput([
        { name: "feature-dev", backend: "claude" },
        { name: "code-reviewer", backend: "Codex" },
        { name: "security" },
      ]),
    ).toEqual({
      agents: [
        { name: "feature-dev", backend: "claude" },
        { name: "code-reviewer", backend: "codex" },
        { name: "security", backend: null },
      ],
    });
  });

  it("treats blank backend as no override", () => {
    expect(parseAgentsInput([{ name: "dev", backend: "  " }])).toEqual({
      agents: [{ name: "dev", backend: null }],
    });
  });

  it("rejects an invalid backend slug", () => {
    expect(parseAgentsInput([{ name: "dev", backend: "bad/backend" }])).toMatchObject({
      error: expect.stringContaining("invalid backend"),
    });
  });

  it("rejects a non-string backend", () => {
    expect(parseAgentsInput([{ name: "dev", backend: 3 }])).toMatchObject({
      error: expect.stringContaining("must be a string"),
    });
  });

  it("accepts a single agent (worker only)", () => {
    expect(parseAgentsInput(["feature-dev"])).toEqual({
      agents: [{ name: "feature-dev", backend: null }],
    });
  });

  it("trims whitespace around names", () => {
    expect(parseAgentsInput([" feature-dev ", "code-reviewer"])).toEqual({
      agents: [
        { name: "feature-dev", backend: null },
        { name: "code-reviewer", backend: null },
      ],
    });
  });

  it("rejects a non-array", () => {
    expect(parseAgentsInput("feature-dev")).toEqual({
      error: "agents must be an array of agent names",
    });
  });

  it("rejects an empty array", () => {
    expect(parseAgentsInput([])).toEqual({ error: "agents must not be empty" });
  });

  it("rejects more than the max", () => {
    const many = Array.from({ length: MAX_AGENTS_PER_TASK + 1 }, (_, i) => `a${i}`);
    expect(parseAgentsInput(many)).toEqual({
      error: `agents supports at most ${MAX_AGENTS_PER_TASK} entries`,
    });
  });

  it("rejects entries that are neither string nor object", () => {
    expect(parseAgentsInput(["feature-dev", 3])).toEqual({
      error: "each agent must be a string name or { name, backend? }",
    });
  });

  it("rejects object entries without a string name", () => {
    expect(parseAgentsInput([{ backend: "claude" }])).toEqual({
      error: "each agent must have a string name",
    });
  });

  it("rejects blank entries", () => {
    expect(parseAgentsInput(["feature-dev", "   "])).toEqual({
      error: "agent names must not be blank",
    });
  });

  it("rejects path traversal / separators in registry keys", () => {
    expect(parseAgentsInput(["../secrets"])).toMatchObject({
      error: expect.stringContaining("invalid agent name"),
    });
    expect(parseAgentsInput(["a/b"])).toMatchObject({
      error: expect.stringContaining("invalid agent name"),
    });
    expect(parseAgentsInput([".hidden"])).toMatchObject({
      error: expect.stringContaining("invalid agent name"),
    });
  });

  it("rejects duplicates", () => {
    expect(parseAgentsInput(["dev", "dev"])).toEqual({ error: 'duplicate agent "dev"' });
  });
});

describe("buildGroupMemberMetadata", () => {
  it("stamps groupId + role + agent", () => {
    expect(
      buildGroupMemberMetadata({ groupId: "grp-1", role: "reviewer", agent: "code-reviewer" }),
    ).toEqual({ groupId: "grp-1", agentRole: "reviewer", agentName: "code-reviewer" });
  });
});

describe("buildAgentBootstrap", () => {
  it("points the worker at its doc and appends the original task prompt", () => {
    const text = buildAgentBootstrap({
      agent: "feature-dev",
      role: "worker",
      docPath: "personas/build-agent.md",
      taskPrompt: "Implement the login page",
    });
    expect(text).toContain('You are the "feature-dev" agent');
    expect(text).toContain("personas/build-agent.md");
    expect(text).toContain("--- Task ---");
    expect(text).toContain("Implement the login page");
    // worker is not told to run `conductor task group`
    expect(text).not.toContain("conductor task group");
  });

  it("tells the reviewer to discover its group via `conductor task group`", () => {
    const text = buildAgentBootstrap({
      agent: "code-reviewer",
      role: "reviewer",
      docPath: "reviews/code.md",
    });
    expect(text).toContain('You are the "code-reviewer" agent');
    expect(text).toContain("reviews/code.md");
    expect(text).toContain("conductor task group");
    // no hard-passed sibling ids, no task section
    expect(text).not.toContain("--- Task ---");
  });

  it("does not append a Task section for a worker without a prompt", () => {
    const text = buildAgentBootstrap({
      agent: "feature-dev",
      role: "worker",
      docPath: "agents/dev.md",
      taskPrompt: "   ",
    });
    expect(text).not.toContain("--- Task ---");
  });
});
