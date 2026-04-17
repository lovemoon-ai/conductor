import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResumeArgsForBackend, expandEnvVars, parseCliArgs, resolveConfiguredPrePrompt } from "../bin/conductor-fire.js";
import { parseCliArgs, resolveAiSessionOptions } from "../bin/conductor-fire.js";
import { listRuntimeSupportedBackends, resetRuntimeBackendCacheForTests } from "../src/runtime-backends.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "..", "modules", "ai-sdk", "fixtures", "fake-external-provider.js");
const INVALID_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "..", "modules", "ai-sdk", "fixtures", "invalid-external-provider.js");
const DEFAULT_PROVIDER_PATH = process.env.AISDK_PROVIDER_PATH;

async function withProviderEnv(providerPath, fn) {
  const previousValue = process.env.AISDK_PROVIDER_PATH;
  if (providerPath) {
    process.env.AISDK_PROVIDER_PATH = providerPath;
  } else {
    delete process.env.AISDK_PROVIDER_PATH;
  }
  try {
    return await fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previousValue;
    }
  }
}

beforeEach(() => {
  delete process.env.AISDK_PROVIDER_PATH;
  resetRuntimeBackendCacheForTests();
});

afterEach(() => {
  if (DEFAULT_PROVIDER_PATH === undefined) {
    delete process.env.AISDK_PROVIDER_PATH;
  } else {
    process.env.AISDK_PROVIDER_PATH = DEFAULT_PROVIDER_PATH;
  }
  resetRuntimeBackendCacheForTests();
});

describe("conductor-fire defaults", () => {
  it("uses the first ai-sdk-supported allow_cli_list entry when --backend is omitted", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  copilot: copilot --allow-all-paths --allow-all-tools\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

  it("respects explicit --backend even when not first", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  qwen: qwen --foo\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

  it("rejects explicit built-in backends that are not allow-listed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  claude: claude --dangerously-skip-permissions\n",
      "utf8",
    );

    await assert.rejects(
      () =>
        parseCliArgs([
          "node",
          "conductor-fire",
          "--config-file",
          configPath,
          "--backend",
          "codex",
          "--",
          "fix",
          "bug",
        ]),
      /Unsupported backend "codex"/,
    );
  });

  it("accepts configured codex aliases and resolves them to the codex provider backend", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex-gamma: codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'\n",
      "utf8",
    );

    const args = await parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex-gamma",
      "--",
      "fix",
      "bug",
    ]);

    assert.equal(args.backend, "codex-gamma");
    assert.equal(args.sessionBackend, "codex");
  });

  it("accepts configured codex aliases when the launch command is wrapped by env", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex-gamma: env MODEL=fast codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'\n",
      "utf8",
    );

    const args = await parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex-gamma",
      "--",
      "fix",
      "bug",
    ]);

    assert.equal(args.backend, "codex-gamma");
    assert.equal(args.sessionBackend, "codex");
  });

  it("accepts configured codex aliases when the launch command is wrapped by env and pnpm exec", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex-gamma: env MODEL=fast pnpm exec codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'\n",
      "utf8",
    );

    const args = await parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex-gamma",
      "--",
      "fix",
      "bug",
    ]);

    assert.equal(args.backend, "codex-gamma");
    assert.equal(args.sessionBackend, "codex");
  });

  it("accepts configured codex aliases even when external provider discovery fails", async () => {
    await withProviderEnv(null, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "allow_cli_list:",
          "  codex-gamma: codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
          "envs:",
          `  AISDK_PROVIDER_PATH: ${INVALID_EXTERNAL_PROVIDER}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const args = await parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--backend",
        "codex-gamma",
        "--",
        "fix",
        "bug",
      ]);

      assert.equal(args.backend, "codex-gamma");
      assert.equal(args.sessionBackend, "codex");
    });
  });

  it("rejects legacy backend aliases", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n  claude: claude --dangerously-skip-permissions\n  opencode: opencode\n",
      "utf8",
    );

    await assert.rejects(
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
    await assert.rejects(
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
    await assert.rejects(
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

  it("rejects unsupported backends even when they appear in allow_cli_list", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  copilot: copilot --allow-all-paths --allow-all-tools\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    await assert.rejects(
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

  it("falls back to discovered external backends when allow_cli_list has no supported entries", async () => {
    await withProviderEnv(null, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "allow_cli_list:",
          "  copilot: copilot --allow-all-paths --allow-all-tools",
          "envs:",
          `  AISDK_PROVIDER_PATH: ${FIXTURE_EXTERNAL_PROVIDER}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const args = await parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--",
        "fix",
        "bug",
      ]);

      assert.equal(args.backend, "test-external");
    });
  });

  it("accepts external backend aliases declared by the provider", async () => {
    await withProviderEnv(null, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "envs:",
          `  AISDK_PROVIDER_PATH: ${FIXTURE_EXTERNAL_PROVIDER}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const args = await parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--backend",
        "test-external-alias",
        "--",
        "fix",
        "bug",
      ]);

      assert.equal(args.backend, "test-external-alias");
      assert.equal(args.sessionBackend, "test-external");
    });
  });

  it("accepts configured external aliases when the launch command is wrapped by pnpm exec", async () => {
    await withProviderEnv(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        "allow_cli_list:\n  my-external: pnpm exec test-external --profile fast\n",
        "utf8",
      );

      const args = await parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--backend",
        "my-external",
        "--",
        "fix",
        "bug",
      ]);

      assert.equal(args.backend, "my-external");
      assert.equal(args.sessionBackend, "test-external");
    });
  });

  it("accepts configured external aliases when the launch command is wrapped by env and pnpm exec", async () => {
    await withProviderEnv(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        "allow_cli_list:\n  my-external: env FOO=1 pnpm exec test-external --profile fast\n",
        "utf8",
      );

      const args = await parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--backend",
        "my-external",
        "--",
        "fix",
        "bug",
      ]);

      assert.equal(args.backend, "my-external");
      assert.equal(args.sessionBackend, "test-external");
    });
  });

  it("rejects raw external backends that are shadowed by configured aliases", async () => {
    await withProviderEnv(FIXTURE_EXTERNAL_PROVIDER, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        "allow_cli_list:\n  my-external: test-external --profile fast\n",
        "utf8",
      );

      await assert.rejects(
        () =>
          parseCliArgs([
            "node",
            "conductor-fire",
            "--config-file",
            configPath,
            "--backend",
            "test-external",
            "--",
            "fix",
            "bug",
          ]),
        /Unsupported backend "test-external"/,
      );
    });
  });

  it("rejects invalid external providers before choosing them as defaults", async () => {
    await withProviderEnv(null, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "envs:",
          `  AISDK_PROVIDER_PATH: ${INVALID_EXTERNAL_PROVIDER}`,
          "",
        ].join("\n"),
        "utf8",
      );

      await assert.rejects(
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
        /missing provider\.createSession/,
      );
    });
  });

  it("reloads an external provider after an initial descriptor failure", async () => {
    await withProviderEnv(null, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
      const providerPath = path.join(tempDir, "retryable-provider.js");
      const configPath = path.join(tempDir, "config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "envs:",
          `  AISDK_PROVIDER_PATH: ${providerPath}`,
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        providerPath,
        'export const providers = [{ backend: "retryable-external", variant: "retryable-external-provider" }];\n',
        "utf8",
      );

      await assert.rejects(
        () => listRuntimeSupportedBackends({ configFilePath: configPath }),
        /missing provider\.createSession/,
      );

      fs.writeFileSync(
        providerPath,
        [
          "export const providers = [",
          "  {",
          '    backend: "retryable-external",',
          '    variant: "retryable-external-provider",',
          "    async createSession() {",
          "      return null;",
          "    },",
          "  },",
          "];",
          "",
        ].join("\n"),
        "utf8",
      );

      const supportedBackends = await listRuntimeSupportedBackends({ configFilePath: configPath });
      assert.ok(supportedBackends.includes("retryable-external"));
    });
  });

  it("parses --resume and keeps default backend from first allow_cli_list entry", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n  claude: claude --dangerously-skip-permissions\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

  it("rejects legacy --from flags", async () => {
    await assert.rejects(
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

  it("does not treat --resume as prompt when no -- separator is used", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

  it("marks task title as non-explicit when --title is not provided", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

  it("marks task title as explicit when --title is provided", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
      "utf8",
    );

    const args = await parseCliArgs([
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

describe("pre_prompt config", () => {
  it("expands braced and bare environment variables", () => {
    const env = { PWD: "/tmp/demo", HOME: "/Users/test" };
    assert.equal(expandEnvVars("cwd=${PWD} home=$HOME missing=$NOPE", env), "cwd=/tmp/demo home=/Users/test missing=$NOPE");
  });

  it("loads backend-specific pre_prompt from config and expands env vars", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "pre_prompt:",
        '  mira: "inspect ${PWD} then continue"',
        "",
      ].join("\n"),
      "utf8",
    );

    const resolved = resolveConfiguredPrePrompt({
      configFilePath: configPath,
      backend: "mira",
      env: { ...process.env, PWD: "/Users/duino/ws/mira" },
    });

    assert.equal(resolved, "inspect /Users/duino/ws/mira then continue");
  });

  it("falls back to sessionBackend-specific pre_prompt", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "pre_prompt:",
        '  codex: "use ${PWD}"',
        "",
      ].join("\n"),
      "utf8",
    );

    const resolved = resolveConfiguredPrePrompt({
      configFilePath: configPath,
      backend: "codex-gamma",
      sessionBackend: "codex",
      env: { ...process.env, PWD: "/repo" },
    });

    assert.equal(resolved, "use /repo");
  });

  it("returns undefined when no pre_prompt is configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(configPath, "allow_cli_list:\n  codex: codex\n", "utf8");

    const resolved = resolveConfiguredPrePrompt({
      configFilePath: configPath,
      backend: "mira",
      env: process.env,
    });

    assert.equal(resolved, undefined);
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
