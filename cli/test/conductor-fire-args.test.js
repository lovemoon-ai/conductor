import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildResumeArgsForBackend, parseCliArgs } from "../bin/conductor-fire.js";

describe("conductor-fire defaults", () => {
  it("uses the first ai-sdk-supported allow_cli_list entry when --backend is omitted", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  copilot: copilot --allow-all-paths --allow-all-tools\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--",
      "fix",
      "bug",
    ]);

    assert.equal(args.backend, "codex");
  });

  it("respects explicit --backend even when not first", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  qwen: qwen --foo\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex",
      "--",
      "fix",
      "bug",
    ]);

    assert.equal(args.backend, "codex");
  });

  it("rejects legacy backend aliases", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n  claude: claude --dangerously-skip-permissions\n  opencode: opencode\n",
      "utf8",
    );

    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--backend",
          "code",
          "--",
          "fix",
          "bug",
        ]),
      /Unsupported backend "code"/,
    );
    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--backend",
          "claude-code",
          "--",
          "fix",
          "bug",
        ]),
      /Unsupported backend "claude-code"/,
    );
    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--backend",
          "open-code",
          "--",
          "fix",
          "bug",
        ]),
      /Unsupported backend "open-code"/,
    );
  });

  it("rejects unsupported backends even when they appear in allow_cli_list", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  copilot: copilot --allow-all-paths --allow-all-tools\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--backend",
          "copilot",
          "--",
          "fix",
          "bug",
        ]),
      /Unsupported backend "copilot"/,
    );
  });

  it("rejects configs that only contain unsupported backends", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  copilot: copilot --allow-all-paths --allow-all-tools\n",
      "utf8",
    );

    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--",
          "fix",
          "bug",
        ]),
      /No supported backends configured/,
    );
  });

  it("parses --resume and keeps default backend from first allow_cli_list entry", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n  claude: claude --dangerously-skip-permissions\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--resume",
      "019cb2a4-de18-70b0-816b-a9b0d99400bb",
    ]);

    assert.equal(args.backend, "codex");
    assert.equal(args.resumeSessionId, "019cb2a4-de18-70b0-816b-a9b0d99400bb");
  });

  it("rejects legacy --from flags", () => {
    assert.throws(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--from",
          "codex:019cb2a4-de18-70b0-816b-a9b0d99400bb",
        ]),
      /--from and --from-provider were removed/,
    );
  });

  it("does not treat --resume as prompt when no -- separator is used", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex",
      "--resume",
      "019cb2a4-de18-70b0-816b-a9b0d99400bb",
    ]);

    assert.equal(args.initialPrompt, "");
    assert.equal(args.resumeSessionId, "019cb2a4-de18-70b0-816b-a9b0d99400bb");
    assert.deepEqual(args.rawBackendArgs, []);
  });

  it("marks task title as non-explicit when --title is not provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--resume",
      "019cb2a4-de18-70b0-816b-a9b0d99400bb",
    ]);

    assert.equal(args.taskTitle, "");
    assert.equal(args.hasExplicitTaskTitle, false);
  });

  it("marks task title as explicit when --title is provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--title",
      "my-task",
      "--resume",
      "019cb2a4-de18-70b0-816b-a9b0d99400bb",
    ]);

    assert.equal(args.taskTitle, "my-task");
    assert.equal(args.hasExplicitTaskTitle, true);
  });
});

describe("resume command args", () => {
  it("formats codex resume args as positional subcommand", () => {
    const args = buildResumeArgsForBackend("codex", "019cb2a4-de18-70b0-816b-a9b0d99400bb");
    assert.deepEqual(args, ["resume", "019cb2a4-de18-70b0-816b-a9b0d99400bb"]);
  });

  it("formats code backend resume args as codex-style subcommand", () => {
    const args = buildResumeArgsForBackend("code", "019cb2a4-de18-70b0-816b-a9b0d99400bb");
    assert.deepEqual(args, ["resume", "019cb2a4-de18-70b0-816b-a9b0d99400bb"]);
  });

  it("formats claude resume args as two arguments", () => {
    const args = buildResumeArgsForBackend("claude", "9c761ab9-e360-4488-af51-dd7788a22cdb");
    assert.deepEqual(args, ["--resume", "9c761ab9-e360-4488-af51-dd7788a22cdb"]);
  });

  it("formats copilot resume args as equals-style flag", () => {
    const args = buildResumeArgsForBackend("copilot", "38395aba-10fe-4a9e-863e-c7ed750e0809");
    assert.deepEqual(args, ["--resume=38395aba-10fe-4a9e-863e-c7ed750e0809"]);
  });

  it("formats kimi resume args as session flags", () => {
    const args = buildResumeArgsForBackend("kimi", "kimi-session-42");
    assert.deepEqual(args, ["--session", "kimi-session-42"]);
  });

  it("returns empty args when resume session id is not provided", () => {
    const args = buildResumeArgsForBackend("codex", "");
    assert.deepEqual(args, []);
  });
});
