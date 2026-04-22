import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { filterRuntimeSupportedAllowCliList, listAdvertisedBackends, resetRuntimeBackendCacheForTests } from "../src/runtime-backends.js";

import {
  applyWorkingDirectory,
  bootstrapResumeContextForFire,
  buildConductorConnectHeaders,
  BridgeRunner,
  createPendingRemoteInterruptQueue,
  FireWatchdog,
  formatFatalError,
  injectResolvedTaskId,
  isLaunchedByDaemon,
  parseCliArgs,
  resolveDaemonHost,
  resolveAiSessionCommandLine,
  resolveFreshSessionBootstrapLockPath,
  resolveProjectId,
  resolveRequestedTaskTitle,
  shouldFireReportTaskStatus,
  shouldRunReconnectRecovery,
  withFreshSessionBootstrapLock,
  writeFireTaskMarker,
} from "../bin/conductor-fire.js";
import { detectTaskId } from "../bin/conductor-send-file.js";

const CONFIG_PATH = os.homedir() + "/.conductor/config-dev.yaml";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-external-provider.js",
);
const INVALID_EXTERNAL_PROVIDER = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "invalid-external-provider.js",
);

function createIsolatedConfigPath() {
  assert.ok(fs.existsSync(CONFIG_PATH), `Config file not found: ${CONFIG_PATH}`);
  const content = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = yaml.load(content);
  assert.ok(parsed && typeof parsed === "object", "Config file is invalid");
  assert.ok(parsed.allow_cli_list && typeof parsed.allow_cli_list === "object", "allow_cli_list missing");
  if (parsed.envs && typeof parsed.envs === "object") {
    delete parsed.envs.AISDK_PROVIDER_PATH;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-config-"));
  const isolatedConfigPath = path.join(tempDir, "config.yaml");
  fs.writeFileSync(isolatedConfigPath, yaml.dump(parsed), "utf8");
  return isolatedConfigPath;
}

async function loadAllowCliList(configPath = CONFIG_PATH) {
  assert.ok(fs.existsSync(configPath), `Config file not found: ${configPath}`);
  const content = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(content);
  assert.ok(parsed && typeof parsed === "object", "Config file is invalid");
  assert.ok(parsed.allow_cli_list && typeof parsed.allow_cli_list === "object", "allow_cli_list missing");
  const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
  delete process.env.AISDK_PROVIDER_PATH;
  resetRuntimeBackendCacheForTests();
  try {
    return await filterRuntimeSupportedAllowCliList(parsed.allow_cli_list, { configFilePath: configPath });
  } finally {
    if (previousProviderPath === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previousProviderPath;
    }
    resetRuntimeBackendCacheForTests();
  }
}

async function withClearedProviderEnv(fn) {
  const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
  delete process.env.AISDK_PROVIDER_PATH;
  resetRuntimeBackendCacheForTests();
  try {
    return await fn();
  } finally {
    if (previousProviderPath === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previousProviderPath;
    }
    resetRuntimeBackendCacheForTests();
  }
}

function runCli(args) {
  const cliPath = path.resolve(__dirname, "..", "bin", "conductor-fire.js");
  const env = { ...process.env };
  delete env.AISDK_PROVIDER_PATH;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { env }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr ? `${err.message}\n${stderr}` : err.message;
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function assertStartupProcessesOnlyLiveQueue({
  backendName,
  createBackendSession,
  expectedContents,
  resumeSessionId = "",
}) {
  const sentMessages = [];
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  let runTurnCalls = 0;
  let runner;
  let receiveCount = 0;

  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("startup backfill should not fetch task history");
  };

  try {
    const backendSession = createBackendSession({
      onRunTurn: () => {
        runTurnCalls += 1;
      },
    });

    runner = new BridgeRunner({
      backendSession,
      conductor: {
        receiveMessages: async () => {
          receiveCount += 1;
          if (receiveCount === 1) {
            return {
              messages: [{ message_id: `msg-${backendName}-1`, role: "user", content: "hello" }],
              has_more: false,
            };
          }
          runner.stopped = true;
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: `task-start-live-${backendName}`,
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName,
      resumeSessionId,
    });

    await runner.start();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.equal(runTurnCalls, 1);
  assert.deepEqual(
    sentMessages.map((entry) => entry.content),
    expectedContents,
  );
}

describe("conductor-fire backends", () => {
  it("uses allow_cli_list from config-dev.yaml", async (t) => {
    const configPath = createIsolatedConfigPath();
    t.after(() => {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      resetRuntimeBackendCacheForTests();
    });
    const allowCliList = await loadAllowCliList(configPath);
    const backends = Object.keys(allowCliList);
    assert.ok(backends.length > 0, "allow_cli_list is empty");
  });

  it("keeps configured codex aliases in the filtered allow_cli_list", async () => {
    const allowCliList = await filterRuntimeSupportedAllowCliList({
      "codex-gamma": "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });

    assert.deepEqual(allowCliList, {
      "codex-gamma": "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });
  });

  it("keeps configured codex aliases when the command is wrapped by env", async () => {
    const allowCliList = await filterRuntimeSupportedAllowCliList({
      "codex-gamma": "env MODEL=fast codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });

    assert.deepEqual(allowCliList, {
      "codex-gamma": "env MODEL=fast codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });
  });

  it("keeps configured codex aliases when the command is wrapped by env and pnpm exec", async () => {
    const allowCliList = await filterRuntimeSupportedAllowCliList({
      "codex-gamma": "env MODEL=fast pnpm exec codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });

    assert.deepEqual(allowCliList, {
      "codex-gamma": "env MODEL=fast pnpm exec codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
    });
  });

  it("keeps configured codex aliases when external provider discovery fails", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    process.env.AISDK_PROVIDER_PATH = INVALID_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      const allowCliList = await filterRuntimeSupportedAllowCliList({
        "codex-gamma": "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
      });

      assert.deepEqual(allowCliList, {
        "codex-gamma": "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
      });
    } finally {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("keeps configured external aliases in the filtered allow_cli_list", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      const allowCliList = await filterRuntimeSupportedAllowCliList({
        "my-external": "test-external --profile fast",
      });

      assert.deepEqual(allowCliList, {
        "my-external": "test-external --profile fast",
      });
    } finally {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("keeps configured external aliases when the command is wrapped by pnpm exec", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      const allowCliList = await filterRuntimeSupportedAllowCliList({
        "my-external": "pnpm exec test-external --profile fast",
      });

      assert.deepEqual(allowCliList, {
        "my-external": "pnpm exec test-external --profile fast",
      });
    } finally {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("keeps configured external aliases when the command is wrapped by env and pnpm exec", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      const allowCliList = await filterRuntimeSupportedAllowCliList({
        "my-external": "env FOO=1 pnpm exec test-external --profile fast",
      });

      assert.deepEqual(allowCliList, {
        "my-external": "env FOO=1 pnpm exec test-external --profile fast",
      });
    } finally {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("merges process env provider paths with config-file AISDK_PROVIDER_PATH lists", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-provider-"));
    const configPath = path.join(tempDir, "config.yaml");
    const providerPath = path.join(tempDir, "yaml-list-provider.js");
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      fs.writeFileSync(
        providerPath,
        [
          "export const providers = [",
          "  {",
          '    backend: "yaml-list-external",',
          '    variant: "yaml-list-external-provider",',
          "    async createSession() {",
          "      return {};",
          "    },",
          "  },",
          "];",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        configPath,
        [
          "envs:",
          "  AISDK_PROVIDER_PATH:",
          `    - ${JSON.stringify(providerPath)}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const allowCliList = await filterRuntimeSupportedAllowCliList(
        {
          "test-external": "test-external --profile fast",
          "yaml-list-external": "yaml-list-cli",
        },
        { configFilePath: configPath },
      );
      const advertisedBackends = await listAdvertisedBackends(allowCliList, { configFilePath: configPath });

      assert.deepEqual(allowCliList, {
        "test-external": "test-external --profile fast",
        "yaml-list-external": "yaml-list-cli",
      });
      assert.deepEqual(advertisedBackends.supportedBackends, ["test-external", "yaml-list-external", "copilot"]);
      assert.deepEqual(advertisedBackends.runtimeBackendMap, {
        "test-external": "test-external",
        "yaml-list-external": "yaml-list-external",
        "copilot": "copilot",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("hides raw external backends that are shadowed by configured aliases", async () => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-provider-"));
    const configPath = path.join(tempDir, "config.yaml");
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();
    try {
      fs.writeFileSync(configPath, "envs: {}\n", "utf8");
      const allowCliList = await filterRuntimeSupportedAllowCliList({
        "my-external": "test-external --profile fast",
      }, { configFilePath: configPath });
      const advertisedBackends = await listAdvertisedBackends(allowCliList, { configFilePath: configPath });

      assert.deepEqual(advertisedBackends.supportedBackends, ["my-external", "copilot"]);
      assert.deepEqual(advertisedBackends.externalBackends, []);
      assert.deepEqual(advertisedBackends.runtimeBackendMap, {
        "my-external": "test-external",
        "copilot": "copilot",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
    }
  });

  it("defaults to first allow_cli_list entry when --backend is omitted", async (t) => {
    const configPath = createIsolatedConfigPath();
    t.after(() => {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      resetRuntimeBackendCacheForTests();
    });
    const allowCliList = await loadAllowCliList(configPath);
    const defaultBackend = Object.keys(allowCliList)[0];
    const args = await withClearedProviderEnv(() =>
      parseCliArgs([
        "node",
        "conductor-fire",
        "--config-file",
        configPath,
        "--",
        "ping",
      ]),
    );
    assert.equal(args.backend, defaultBackend);
  });

  it("lists backends from config-dev.yaml", async (t) => {
    const configPath = createIsolatedConfigPath();
    t.after(() => {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      resetRuntimeBackendCacheForTests();
    });
    const allowCliList = await loadAllowCliList(configPath);
    const defaultBackend = Object.keys(allowCliList)[0];
    const output = await runCli(["--config-file", configPath, "--list-backends"]);
    assert.ok(output.includes("Supported backends (from config):"));
    for (const [name, command] of Object.entries(allowCliList)) {
      assert.ok(output.includes(`  ${name}: ${command}`));
    }
    assert.ok(output.includes(`Default: ${defaultBackend}`));
  });

  it("surfaces provider discovery failures from --list-backends", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-list-backends-"));
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

    t.after(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      resetRuntimeBackendCacheForTests();
    });

    await assert.rejects(
      () => runCli(["--config-file", configPath, "--list-backends"]),
      /missing provider\.createSession/,
    );
  });

  it("resolves the opencode ai-sdk command from allow_cli_list", () => {
    const commandLine = resolveAiSessionCommandLine(
      "opencode",
      {
        opencode: "\"/custom/Open Code/bin/opencode\" --flag=\"a b\"",
      },
      {},
    );

    assert.equal(commandLine, "\"/custom/Open Code/bin/opencode\" --flag=\"a b\"");
  });

  it("resolves the kimi ai-sdk command from allow_cli_list", () => {
    const commandLine = resolveAiSessionCommandLine(
      "kimi",
      {
        kimi: "\"/custom/Kimi/bin/kimi\" --debug",
      },
      {},
    );

    assert.equal(commandLine, "\"/custom/Kimi/bin/kimi\" --debug");
  });

  it("converts configured codex aliases into app-server commands", () => {
    const commandLine = resolveAiSessionCommandLine(
      "codex-gamma",
      {
        "codex-gamma": "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b'",
      },
      {},
      "codex",
    );

    assert.equal(
      commandLine,
      "codex -c 'model_provider=ollama' -c 'model=gemma4:e4b' app-server --listen stdio://",
    );
  });

  it("falls back to the daemon cli command for opencode sessions", () => {
    const commandLine = resolveAiSessionCommandLine(
      "opencode",
      {},
      {
        CONDUCTOR_CLI_COMMAND: "\"/daemon/Open Code/bin/opencode\" --flag=\"a b\"",
      },
    );

    assert.equal(commandLine, "\"/daemon/Open Code/bin/opencode\" --flag=\"a b\"");
  });

  it("prefers CONDUCTOR_KIMI_COMMAND for kimi sessions", () => {
    const commandLine = resolveAiSessionCommandLine(
      "kimi",
      {},
      {
        CONDUCTOR_KIMI_COMMAND: "\"/env/Kimi/bin/kimi\" --trace",
        CONDUCTOR_CLI_COMMAND: "\"/daemon/Kimi/bin/kimi\" --debug",
      },
    );

    assert.equal(commandLine, "\"/env/Kimi/bin/kimi\" --trace");
  });

  it("falls back to the daemon cli command for kimi sessions", () => {
    const commandLine = resolveAiSessionCommandLine(
      "kimi",
      {},
      {
        CONDUCTOR_CLI_COMMAND: "\"/daemon/Kimi/bin/kimi\" --debug",
      },
    );

    assert.equal(commandLine, "\"/daemon/Kimi/bin/kimi\" --debug");
  });

  it("treats CONDUCTOR_LAUNCHED_BY_DAEMON as daemon-hosted even without a cli command", () => {
    assert.equal(
      isLaunchedByDaemon({
        CONDUCTOR_LAUNCHED_BY_DAEMON: "1",
      }),
      true,
    );
    assert.equal(
      isLaunchedByDaemon({
        CONDUCTOR_LAUNCHED_BY_DAEMON: "false",
        CONDUCTOR_CLI_COMMAND: "",
      }),
      false,
    );
  });

  it("still reports final task status from fire after daemon launch", () => {
    assert.equal(
      shouldFireReportTaskStatus({ launchedByDaemon: true, phase: "running" }),
      false,
    );
    assert.equal(
      shouldFireReportTaskStatus({ launchedByDaemon: true, phase: "reconnect_running" }),
      false,
    );
    assert.equal(
      shouldFireReportTaskStatus({ launchedByDaemon: true, phase: "final" }),
      true,
    );
  });

  it("switches process cwd before backend/conductor startup when resume is used", async () => {
    const originalCwd = process.cwd();
    const originalPwd = process.env.PWD;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-resume-cwd-"));
    try {
      const switched = await applyWorkingDirectory(tempDir);
      assert.equal(fs.realpathSync(switched), fs.realpathSync(tempDir));
      assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(tempDir));
      assert.equal(fs.realpathSync(process.env.PWD), fs.realpathSync(tempDir));
    } finally {
      process.chdir(originalCwd);
      if (originalPwd === undefined) {
        delete process.env.PWD;
      } else {
        process.env.PWD = originalPwd;
      }
    }
  });

  it("uses CONDUCTOR_RESUME_CWD to skip provider-specific resume context lookup", async () => {
    let resolveCalls = 0;
    let applyCalls = 0;
    const messages = [];

    const result = await bootstrapResumeContextForFire({
      backend: "opencode",
      resumeSessionId: "session-opencode-1",
      env: {
        CONDUCTOR_RESUME_CWD: "/tmp/opencode-resume-cwd",
      },
      resolveResumeContextFn: async () => {
        resolveCalls += 1;
        throw new Error("resolveResumeContext should be skipped");
      },
      applyWorkingDirectoryFn: async (targetPath) => {
        applyCalls += 1;
        assert.equal(targetPath, "/tmp/opencode-resume-cwd");
        return targetPath;
      },
      logger: (message) => {
        messages.push(message);
      },
    });

    assert.equal(resolveCalls, 0);
    assert.equal(applyCalls, 1);
    assert.equal(result.resumeContext, null);
    assert.equal(result.runtimeProjectPath, "/tmp/opencode-resume-cwd");
    assert.ok(messages.some((message) => message.includes("CONDUCTOR_RESUME_CWD")));
  });

  it("preserves the requested backend alias when resolving resume context", async () => {
    let resolvedBackend = null;

    const result = await bootstrapResumeContextForFire({
      backend: "copilot-enterprise",
      resumeSessionId: "session-copilot-alias-1",
      env: {},
      resolveResumeContextFn: async (backend, sessionId) => {
        resolvedBackend = backend;
        return {
          provider: "copilot",
          sessionId,
          sessionPath: null,
          cwd: "/tmp/copilot-alias-workspace",
        };
      },
      applyWorkingDirectoryFn: async (targetPath) => targetPath,
      logger: () => {},
    });

    assert.equal(resolvedBackend, "copilot-enterprise");
    assert.equal(result.resumeContext?.provider, "copilot");
    assert.equal(result.runtimeProjectPath, "/tmp/copilot-alias-workspace");
  });

  it("falls back to session backend when bootstrapping resume without requested backend", async () => {
    let resolvedBackend = null;

    const result = await bootstrapResumeContextForFire({
      backend: "",
      sessionBackend: "copilot",
      resumeSessionId: "session-copilot-session-backend-1",
      env: {},
      resolveResumeContextFn: async (backend, sessionId) => {
        resolvedBackend = backend;
        return {
          provider: "copilot",
          sessionId,
          sessionPath: null,
          cwd: "/tmp/copilot-session-backend-workspace",
        };
      },
      applyWorkingDirectoryFn: async (targetPath) => targetPath,
      logger: () => {},
    });

    assert.equal(resolvedBackend, "copilot");
    assert.equal(result.resumeContext?.provider, "copilot");
    assert.equal(result.runtimeProjectPath, "/tmp/copilot-session-backend-workspace");
  });

  it("uses resume runtime path basename as default task title", () => {
    const runtimePath = "/tmp/workspace-from-resume";
    const resolved = resolveRequestedTaskTitle({
      cliTaskTitle: "",
      hasExplicitTaskTitle: false,
      envTaskTitle: "",
      runtimeProjectPath: runtimePath,
    });
    assert.equal(resolved, "workspace-from-resume");
  });

  it("stores the resolved task id in CONDUCTOR_TASK_ID for child tools", () => {
    const env = {};
    const taskId = injectResolvedTaskId(" 12345678-1234-1234-1234-1234567890ab ", env);

    assert.equal(taskId, "12345678-1234-1234-1234-1234567890ab");
    assert.equal(env.CONDUCTOR_TASK_ID, "12345678-1234-1234-1234-1234567890ab");
  });

  it("writes a fire task marker that send-file can auto-detect", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-task-marker-"));
    const oldTaskId = "11111111-1111-1111-1111-111111111111";
    const nextTaskId = "22222222-2222-2222-2222-222222222222";
    const oldMarkerPath = writeFireTaskMarker(oldTaskId, tempDir);
    const markerPath = writeFireTaskMarker(nextTaskId, tempDir);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));

    assert.equal(fs.existsSync(oldMarkerPath), false);
    assert.equal(marker.taskId, nextTaskId);
    assert.equal(marker.source, "conductor-fire");
    assert.equal(detectTaskId({ cwd: tempDir, env: {} }), nextTaskId);
  });

  it("builds conductor websocket headers with refresh-session capability metadata", () => {
    assert.deepEqual(
      buildConductorConnectHeaders("0.2.21", {
        backends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      }),
      {
      "x-conductor-version": "0.2.21",
        "x-conductor-backends": "codex",
        "x-conductor-capabilities": "refresh_session_inplace",
      },
    );
  });

  it("stops the current backend session and reuses the same refresh promise for duplicate request ids", async () => {
    const closeCalls = [];
    const runner = new BridgeRunner({
      backendSession: {
        close: async () => {
          closeCalls.push("close");
        },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-refresh-control-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
      resumeSessionId: "sess-refresh-control-1",
    });

    const firstPromise = runner.requestRefreshSessionFromRemote({
      taskId: "task-refresh-control-1",
      requestId: "req-refresh-control-1",
      sessionId: "sess-refresh-control-1",
      sessionFilePath: "/tmp/sess-refresh-control-1.jsonl",
    });
    const secondPromise = runner.requestRefreshSessionFromRemote({
      taskId: "task-refresh-control-1",
      requestId: "req-refresh-control-1",
      sessionId: "sess-refresh-control-1",
      sessionFilePath: "/tmp/sess-refresh-control-1.jsonl",
    });

    assert.deepEqual(closeCalls, ["close"]);
    assert.equal(runner.stopped, true);
    assert.equal(runner.getRefreshSessionRequest().sessionId, "sess-refresh-control-1");
    runner.getRefreshSessionRequest().resolve(true);

    assert.equal(await firstPromise, true);
    assert.equal(await secondPromise, true);
  });

  it("keeps explicit cli title even when resume runtime path is provided", () => {
    const resolved = resolveRequestedTaskTitle({
      cliTaskTitle: "manual-title",
      hasExplicitTaskTitle: true,
      envTaskTitle: "",
      runtimeProjectPath: "/tmp/workspace-from-resume",
    });
    assert.equal(resolved, "manual-title");
  });

  it("formats fatal error without stack by default", () => {
    const error = new Error("Free plan limit reached");
    error.stack = "Error: Free plan limit reached\n    at main (fake.js:1:1)";
    const formatted = formatFatalError(error, { showStack: false });
    assert.equal(formatted, "Free plan limit reached");
  });

  it("formats fatal error with stack when enabled", () => {
    const error = new Error("Free plan limit reached");
    error.stack = "Error: Free plan limit reached\n    at main (fake.js:1:1)";
    const formatted = formatFatalError(error, { showStack: true });
    assert.ok(formatted.includes("at main (fake.js:1:1)"));
  });

  it("derives a stable codex fresh-session lock path from cwd", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-lock-"));
    const samePath = resolveFreshSessionBootstrapLockPath("codex", tempDir);
    const samePathAgain = resolveFreshSessionBootstrapLockPath("codex", tempDir);
    const otherBackendPath = resolveFreshSessionBootstrapLockPath("claude", tempDir);

    assert.ok(samePath);
    assert.equal(samePath, samePathAgain);
    assert.equal(otherBackendPath, null);
  });

  it("returns the resolved project id from daemon confirmation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-project-"));
    const calls = [];
    const conductor = {
      matchProjectByPath: async (payload) => {
        calls.push({ method: "match", payload });
        if (calls.length === 1) {
          return {
            project_id: "pending-project",
            project_name: "Pending Project",
            matched_path: tempDir,
          };
        }
        return {
          project_id: "confirmed-project",
          project_name: "Confirmed Project",
          matched_path: tempDir,
        };
      },
      bindProjectPath: async (projectId, payload) => {
        calls.push({ method: "bind", projectId, payload });
        return {
          success: true,
          project_id: "confirmed-project",
          path: tempDir,
        };
      },
    };

    const resolved = await resolveProjectId(conductor, null, {
      daemonName: "daemon-a",
      projectPath: tempDir,
    });

    assert.equal(resolved, "confirmed-project");
    assert.equal(calls[0].method, "match");
    assert.equal(calls[1].method, "bind");
  });

  it("resolves manual fire daemon host from env when config daemon name is absent", () => {
    const previousDaemonName = process.env.CONDUCTOR_DAEMON_NAME;
    delete process.env.CONDUCTOR_AGENT_NAME;
    process.env.CONDUCTOR_DAEMON_NAME = "daemon-from-env";
    try {
      assert.equal(resolveDaemonHost(""), "daemon-from-env");
    } finally {
      if (previousDaemonName === undefined) {
        delete process.env.CONDUCTOR_DAEMON_NAME;
      } else {
        process.env.CONDUCTOR_DAEMON_NAME = previousDaemonName;
      }
    }
  });

  it("releases fresh-session lock after bootstrap finishes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-lock-"));
    const lockPath = resolveFreshSessionBootstrapLockPath("codex", tempDir);
    assert.ok(lockPath);

    const result = await withFreshSessionBootstrapLock("codex", tempDir, async () => {
      assert.equal(fs.existsSync(lockPath), true);
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("fire watchdog force-reconnects on stale websocket health", async () => {
    let now = 0;
    const reconnectReasons = [];
    const watchdog = new FireWatchdog({
      staleWsMs: 20,
      connectGraceMs: 1,
      reconnectCooldownMs: 10,
      onForceReconnect: async (reason) => {
        reconnectReasons.push(reason);
      },
      logger: () => {},
      now: () => now,
    });

    watchdog.onConnected({ isReconnect: false, connectedAt: 0 });
    now = 25;
    await watchdog.runOnce();

    assert.deepEqual(reconnectReasons, ["watchdog:stale_ws_health"]);
    assert.equal(watchdog.getDebugState().wsConnected, false);
  });

  it("fire watchdog respects reconnect cooldown for repeated stale checks", async () => {
    let now = 0;
    const reconnectReasons = [];
    const watchdog = new FireWatchdog({
      staleWsMs: 20,
      connectGraceMs: 1,
      reconnectCooldownMs: 10,
      onForceReconnect: async (reason) => {
        reconnectReasons.push(reason);
      },
      logger: () => {},
      now: () => now,
    });

    watchdog.onConnected({ isReconnect: false, connectedAt: 0 });
    now = 25;
    await watchdog.runOnce();
    watchdog.onConnected({ isReconnect: true, connectedAt: 26 });
    now = 30;
    await watchdog.runOnce();

    assert.deepEqual(reconnectReasons, ["watchdog:stale_ws_health"]);
  });

  it("fire watchdog clears heal attempts after a post-reconnect pong", async () => {
    let now = 0;
    const reconnectReasons = [];
    const logs = [];
    const watchdog = new FireWatchdog({
      staleWsMs: 20,
      connectGraceMs: 1,
      reconnectCooldownMs: 10,
      onForceReconnect: async (reason) => {
        reconnectReasons.push(reason);
      },
      logger: (line) => {
        logs.push(line);
      },
      now: () => now,
    });

    watchdog.onConnected({ isReconnect: false, connectedAt: 0 });
    now = 25;
    await watchdog.runOnce();
    watchdog.onConnected({ isReconnect: true, connectedAt: 30 });
    watchdog.onPong({ at: 31 });

    assert.deepEqual(reconnectReasons, ["watchdog:stale_ws_health"]);
    assert.equal(watchdog.getDebugState().healAttempts, 0);
    assert.ok(logs.some((line) => line.includes("healthy again after self-heal via pong")));
  });

  it("skips reconnect recovery after remote stop or during shutdown", () => {
    const activeRunner = { shouldSuppressReconnectRecovery: () => false };
    const stoppedRunner = { shouldSuppressReconnectRecovery: () => true };

    assert.equal(
      shouldRunReconnectRecovery({ isReconnect: true, fireShuttingDown: false, runner: activeRunner }),
      true,
    );
    assert.equal(
      shouldRunReconnectRecovery({ isReconnect: true, fireShuttingDown: false, runner: stoppedRunner }),
      false,
    );
    assert.equal(
      shouldRunReconnectRecovery({ isReconnect: true, fireShuttingDown: true, runner: activeRunner }),
      false,
    );
  });

  it("stops bridge runner when stop_task is requested remotely", async () => {
    let backendCloseCalls = 0;
    const runner = new BridgeRunner({
      backendSession: {
        close: async () => {
          backendCloseCalls += 1;
        },
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-stop-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.requestStopFromRemote({
      taskId: "task-stop-1",
      reason: "deleted_by_user",
      requestId: "req-stop-1",
    });

    assert.equal(runner.stopped, true);
    assert.equal(backendCloseCalls, 1);
    assert.equal(runner.getRemoteStopSummary(), "task stopped by app: deleted_by_user");
  });

  it("exits start loop immediately when already stopped by remote command", async () => {
    let polled = false;
    const runner = new BridgeRunner({
      backendSession: {
        close: async () => {},
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => {
          polled = true;
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-stop-2",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.requestStopFromRemote({
      taskId: "task-stop-2",
      reason: "deleted_by_user",
    });
    await runner.start();
    assert.equal(polled, false);
  });

  it("exits promptly when stop_task arrives during an in-flight turn", async () => {
    let runTurnReject;
    let closeCalls = 0;
    let startedResolve;
    const turnStarted = new Promise((resolve) => {
      startedResolve = resolve;
    });
    const blockedTurn = new Promise((_, reject) => {
      runTurnReject = reject;
    });

    let receiveCount = 0;
    const runner = new BridgeRunner({
      backendSession: {
        close: async () => {
          closeCalls += 1;
          const closedError = new Error("TUI session closed");
          closedError.reason = "session_closed";
          runTurnReject(closedError);
        },
        runTurn: async () => {
          startedResolve();
          return blockedTurn;
        },
        threadId: "thread-1",
        threadOptions: { model: "claude" },
      },
      conductor: {
        receiveMessages: async () => {
          receiveCount += 1;
          if (receiveCount === 1) {
            return {
              messages: [{ message_id: "msg-1", role: "user", content: "hi, 1+1=" }],
              has_more: false,
            };
          }
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-stop-inflight",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "claude",
      daemonName: "daemon-a",
    });

    const startPromise = runner.start();
    await turnStarted;
    await runner.requestStopFromRemote({
      taskId: "task-stop-inflight",
      reason: "deleted_by_user",
      requestId: "req-stop-inflight",
    });

    const result = await Promise.race([
      startPromise.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    assert.equal(result, "done");
    assert.equal(closeCalls, 1);
    assert.equal(runner.stopped, true);
  });

  it("sends an interrupt confirmation when interrupt_turn stops the current turn", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    let interruptCalls = 0;
    let turnStartedResolve;
    let runTurnReject;
    const turnStarted = new Promise((resolve) => {
      turnStartedResolve = resolve;
    });
    const blockedTurn = new Promise((_, reject) => {
      runTurnReject = reject;
    });

    const runner = new BridgeRunner({
      backendSession: {
        interruptCurrentTurn: async () => {
          interruptCalls += 1;
          const interruptedError = new Error("turn interrupted");
          interruptedError.reason = "turn_interrupted";
          runTurnReject(interruptedError);
        },
        runTurn: async () => {
          turnStartedResolve();
          return blockedTurn;
        },
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-interrupt-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    const respondPromise = runner.respondToMessage({
      message_id: "msg-interrupt-1",
      role: "user",
      content: "hello",
    });
    await turnStarted;
    await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-1",
      requestId: "req-interrupt-1",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-1",
    });
    await respondPromise;

    assert.equal(interruptCalls, 1);
    assert.equal(runner.stopped, false);
    assert.ok(runner.processedMessageIds.has("msg-interrupt-1"));
    assert.deepEqual(
      sentMessages,
      [
        {
          taskId: "task-interrupt-1",
          content: "Conversation interrupted",
          metadata: {
            backend: "codex",
            reply_to: "msg-interrupt-1",
            interrupted: true,
            interruption_request_id: "req-interrupt-1",
            reason: "user_interrupt",
            cli_args: [],
          },
        },
      ],
    );
    assert.ok(
      sentRuntimeStatuses.some(
        (entry) =>
          entry.payload?.phase === "interrupted" &&
          entry.payload?.reply_in_progress === false &&
          entry.payload?.status_done_line === "Conversation interrupted",
      ),
    );
  });

  it("keeps startup interrupt acknowledgements pending until a runner handles them", async () => {
    const pendingQueue = createPendingRemoteInterruptQueue();
    let settled = false;

    const interruptPromise = pendingQueue.enqueue({
      taskId: "task-startup-interrupt-1",
      targetReplyTo: "msg-startup-interrupt-1",
    });
    void interruptPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    assert.equal(settled, false);

    await pendingQueue.flushWith(async (event) => event?.targetReplyTo === "msg-startup-interrupt-1");

    assert.equal(await interruptPromise, true);
  });

  it("rejects queued startup interrupts when runner bootstrap never completes", async () => {
    const pendingQueue = createPendingRemoteInterruptQueue();
    const interruptPromise = pendingQueue.enqueue({
      taskId: "task-startup-interrupt-fail-1",
      targetReplyTo: "msg-startup-interrupt-fail-1",
    });

    pendingQueue.rejectAll();

    assert.equal(await interruptPromise, false);
  });

  it("queues an interrupt that arrives before the reply starts and applies it once the turn begins", async () => {
    const sentMessages = [];
    let interruptCalls = 0;
    let runTurnReject;
    const blockedTurn = new Promise((_, reject) => {
      runTurnReject = reject;
    });

    const runner = new BridgeRunner({
      backendSession: {
        interruptCurrentTurn: async () => {
          interruptCalls += 1;
          const interruptedError = new Error("turn interrupted");
          interruptedError.reason = "turn_interrupted";
          runTurnReject(interruptedError);
        },
        runTurn: async () => blockedTurn,
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-interrupt-queued-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    const queuedInterruptAccepted = await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-queued-1",
      requestId: "req-interrupt-queued-1",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-queued-1",
    });

    await runner.respondToMessage({
      message_id: "msg-interrupt-queued-1",
      role: "user",
      content: "hello",
    });

    assert.equal(queuedInterruptAccepted, true);
    assert.equal(interruptCalls, 1);
    assert.deepEqual(
      sentMessages,
      [
        {
          taskId: "task-interrupt-queued-1",
          content: "Conversation interrupted",
          metadata: {
            backend: "codex",
            reply_to: "msg-interrupt-queued-1",
            interrupted: true,
            interruption_request_id: "req-interrupt-queued-1",
            reason: "user_interrupt",
            cli_args: [],
          },
        },
      ],
    );
  });

  it("retries an interrupt that arrives before the backend turn is interruptible", async () => {
    const sentMessages = [];
    let interruptCalls = 0;
    let backendTurnActive = false;
    let runTurnReject;
    let startStatusSeenResolve;
    let releaseStartStatus;
    const startStatusSeen = new Promise((resolve) => {
      startStatusSeenResolve = resolve;
    });
    const startStatusBlocked = new Promise((resolve) => {
      releaseStartStatus = resolve;
    });
    const blockedTurn = new Promise((_, reject) => {
      runTurnReject = reject;
    });

    const runner = new BridgeRunner({
      backendSession: {
        interruptCurrentTurn: async () => {
          interruptCalls += 1;
          if (!backendTurnActive) {
            return false;
          }
          const interruptedError = new Error("turn interrupted");
          interruptedError.reason = "turn_interrupted";
          runTurnReject(interruptedError);
          return true;
        },
        runTurn: async () => {
          backendTurnActive = true;
          return blockedTurn;
        },
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (_taskId, payload) => {
          if (payload?.reply_in_progress === true && payload?.phase === "start_turn") {
            startStatusSeenResolve();
            await startStatusBlocked;
          }
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-interrupt-race-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    const respondPromise = runner.respondToMessage({
      message_id: "msg-interrupt-race-1",
      role: "user",
      content: "hello",
    });
    await startStatusSeen;

    const accepted = await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-race-1",
      requestId: "req-interrupt-race-1",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-race-1",
    });
    releaseStartStatus();
    await respondPromise;

    assert.equal(accepted, true);
    assert.ok(interruptCalls >= 2);
    assert.deepEqual(
      sentMessages,
      [
        {
          taskId: "task-interrupt-race-1",
          content: "Conversation interrupted",
          metadata: {
            backend: "codex",
            reply_to: "msg-interrupt-race-1",
            interrupted: true,
            interruption_request_id: "req-interrupt-race-1",
            reason: "user_interrupt",
            cli_args: [],
          },
        },
      ],
    );
  });

  it("retries backend interruption when the first interrupt attempt fails", async () => {
    const sentMessages = [];
    let interruptCalls = 0;
    let turnStartedResolve;
    let runTurnReject;
    const turnStarted = new Promise((resolve) => {
      turnStartedResolve = resolve;
    });
    const blockedTurn = new Promise((_, reject) => {
      runTurnReject = reject;
    });

    const runner = new BridgeRunner({
      backendSession: {
        interruptCurrentTurn: async () => {
          interruptCalls += 1;
          if (interruptCalls === 1) {
            throw new Error("transient interrupt transport failure");
          }
          const interruptedError = new Error("turn interrupted");
          interruptedError.reason = "turn_interrupted";
          runTurnReject(interruptedError);
        },
        runTurn: async () => {
          turnStartedResolve();
          return blockedTurn;
        },
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-interrupt-retry-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    const respondPromise = runner.respondToMessage({
      message_id: "msg-interrupt-retry-1",
      role: "user",
      content: "hello",
    });
    await turnStarted;

    const firstAttempt = await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-retry-1",
      requestId: "req-interrupt-retry-1",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-retry-1",
    });
    const secondAttempt = await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-retry-1",
      requestId: "req-interrupt-retry-2",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-retry-1",
    });
    await respondPromise;

    assert.equal(firstAttempt, false);
    assert.equal(secondAttempt, true);
    assert.equal(interruptCalls, 2);
    assert.deepEqual(
      sentMessages,
      [
        {
          taskId: "task-interrupt-retry-1",
          content: "Conversation interrupted",
          metadata: {
            backend: "codex",
            reply_to: "msg-interrupt-retry-1",
            interrupted: true,
            interruption_request_id: "req-interrupt-retry-2",
            reason: "user_interrupt",
            cli_args: [],
          },
        },
      ],
    );
  });

  it("does not interrupt the backend after runTurn has already completed", async () => {
    let interruptCalls = 0;
    let sendMessageResolve;
    let sendMessageStartedResolve;
    const sendMessageStarted = new Promise((resolve) => {
      sendMessageStartedResolve = resolve;
    });
    const sendMessageBlocked = new Promise((resolve) => {
      sendMessageResolve = resolve;
    });

    const runner = new BridgeRunner({
      backendSession: {
        interruptCurrentTurn: async () => {
          interruptCalls += 1;
        },
        runTurn: async () => ({
          text: "completed reply",
          usage: null,
          items: [],
          metadata: null,
        }),
        threadId: "thread-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => {
          sendMessageStartedResolve();
          await sendMessageBlocked;
          return {};
        },
      },
      taskId: "task-interrupt-tail-1",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    const respondPromise = runner.respondToMessage({
      message_id: "msg-interrupt-tail-1",
      role: "user",
      content: "hello",
    });
    await sendMessageStarted;

    const interruptAccepted = await runner.requestInterruptFromRemote({
      taskId: "task-interrupt-tail-1",
      requestId: "req-interrupt-tail-1",
      reason: "user_interrupt",
      targetReplyTo: "msg-interrupt-tail-1",
    });
    sendMessageResolve();
    await respondPromise;

    assert.equal(interruptAccepted, false);
    assert.equal(interruptCalls, 0);
  });

  it("announces session started without id when real session id is unavailable", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    const runner = new BridgeRunner({
      backendSession: {
        ensureSessionInfo: async () => null,
        getSessionInfo: () => null,
        getSessionUsageSummary: async () => null,
        close: async () => {},
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "codex-1772707261812",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-announcement-no-id",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.announceBackendSession();

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].content, "codex session started (model=codex)");
    assert.equal(sentMessages[0].metadata?.model, "codex");
    assert.equal(sentMessages[0].metadata?.model_provider, undefined);
    assert.equal(sentMessages[0].metadata?.session_id, undefined);
    assert.equal(sentMessages[0].metadata?.thread_id, undefined);
    assert.equal(sentRuntimeStatuses.length, 1);
    assert.equal(sentRuntimeStatuses[0].payload?.session_id, undefined);
    assert.equal(sentRuntimeStatuses[0].payload?.thread_id, undefined);
  });

  it("announces resumed session id even when backend cannot rediscover it yet", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    const resumedSessionId = "resume-session-1";

    const runner = new BridgeRunner({
      backendSession: {
        ensureSessionInfo: async () => null,
        getSessionInfo: () => null,
        getSessionUsageSummary: async () => null,
        close: async () => {},
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "fresh-thread-id-should-not-leak",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-announcement-resume-id",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
      resumeSessionId: resumedSessionId,
    });

    await runner.announceBackendSession();

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].content, `codex session started: ${resumedSessionId} (model=codex)`);
    assert.equal(sentMessages[0].metadata?.model, "codex");
    assert.equal(sentMessages[0].metadata?.model_provider, undefined);
    assert.equal(sentMessages[0].metadata?.session_id, resumedSessionId);
    assert.equal(sentMessages[0].metadata?.thread_id, resumedSessionId);
    assert.equal(sentRuntimeStatuses.length, 1);
    assert.equal(sentRuntimeStatuses[0].payload?.session_id, resumedSessionId);
    assert.equal(sentRuntimeStatuses[0].payload?.thread_id, resumedSessionId);
  });

  it("announces session started with id when real session id is available", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    const realSessionId = "019cb2a4-de18-70b0-816b-a9b0d99400bb";

    const runner = new BridgeRunner({
      backendSession: {
        ensureSessionInfo: async () => ({ sessionId: realSessionId, sessionFilePath: "/tmp/session.jsonl" }),
        getSessionInfo: () => ({ sessionId: realSessionId, sessionFilePath: "/tmp/session.jsonl" }),
        getSessionUsageSummary: async () => null,
        close: async () => {},
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "codex-1772707261812",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-announcement-with-id",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.announceBackendSession();

    assert.equal(sentMessages.length, 1);
    assert.equal(
      sentMessages[0].content,
      `codex session started: ${realSessionId} (model=codex)`,
    );
    assert.equal(sentMessages[0].metadata?.model, "codex");
    assert.equal(sentMessages[0].metadata?.model_provider, undefined);
    assert.equal(sentMessages[0].metadata?.session_id, realSessionId);
    assert.equal(sentMessages[0].metadata?.thread_id, realSessionId);
    assert.equal(sentRuntimeStatuses.length, 1);
    assert.equal(sentRuntimeStatuses[0].payload?.session_id, realSessionId);
    assert.equal(sentRuntimeStatuses[0].payload?.thread_id, realSessionId);
  });

  it("does not emit WAIT_READY state for session-file backend session announcement", async () => {
    const sentRuntimeStatuses = [];

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        ensureSessionInfo: async () => ({ sessionId: "session-stream", sessionFilePath: "/tmp/session-stream.jsonl" }),
        getSessionInfo: () => ({ sessionId: "session-stream", sessionFilePath: "/tmp/session-stream.jsonl" }),
        getSessionUsageSummary: async () => null,
        close: async () => {},
        runTurn: async () => ({ text: "", usage: null, items: [], metadata: {} }),
        threadId: "thread-stream",
        threadOptions: { model: "copilot" },
        setSessionMessageHandler: () => {},
        setWorkingStatusHandler: () => {},
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-session-announcement-stream",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "copilot",
    });

    await runner.announceBackendSession();

    assert.equal(sentRuntimeStatuses.length, 1);
    assert.equal(sentRuntimeStatuses[0].payload?.phase, "session_started");
    assert.equal(sentRuntimeStatuses[0].payload?.state, undefined);
    assert.equal(sentRuntimeStatuses[0].payload?.status_done_line, undefined);
  });

  it("binds discovered session id after streamed claude reply when announcement had no id", async () => {
    const sentMessages = [];
    const bindCalls = [];
    let sessionInfo = null;
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";
    const realSessionId = "22222222-2222-2222-2222-222222222222";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        ensureSessionInfo: async () => sessionInfo,
        getSessionInfo: () => sessionInfo,
        getSessionUsageSummary: async () => null,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => {
          sessionInfo = {
            sessionId: realSessionId,
            sessionFilePath: "/tmp/claude-session.jsonl",
          };
          await workingStatusHandler?.({
            phase: "message_aggregation",
            source: "claude-agent-sdk",
            reply_in_progress: true,
            status_line: "claude composing reply",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "Claude streamed reply",
            source: "claude-agent-sdk",
            preserveWhitespace: true,
            sessionId: realSessionId,
            sessionFilePath: "/tmp/claude-session.jsonl",
            replyTo: activeReplyTo,
          });
          return {
            text: "Claude streamed reply",
            usage: null,
            items: [],
            metadata: { source: "claude-agent-sdk" },
          };
        },
        close: async () => {},
        threadId: "",
        threadOptions: { model: "claude" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
        bindTaskSession: async (taskId, payload) => {
          bindCalls.push({ taskId, payload });
          return {};
        },
      },
      taskId: "task-session-bind-late-claude",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "claude",
      daemonName: "daemon-a",
    });

    await runner.announceBackendSession();
    assert.equal(bindCalls.length, 0);
    assert.equal(sentMessages[0]?.content, "claude session started (model=claude)");
    assert.equal(sentMessages[0]?.metadata?.model, "claude");
    assert.equal(sentMessages[0]?.metadata?.model_provider, undefined);

    await runner.respondToMessage({ message_id: "msg-claude-late-bind", role: "user", content: "hello" });

    assert.equal(bindCalls.length, 1);
    assert.equal(bindCalls[0].payload.session_id, realSessionId);
    assert.equal(bindCalls[0].payload.session_file_path, "/tmp/claude-session.jsonl");
    assert.equal(bindCalls[0].payload.daemon_name, "daemon-a");
    assert.equal(sentMessages[1]?.content, "Claude streamed reply");
    assert.equal(sentMessages[1]?.metadata?.session_id, realSessionId);
  });

  it("streams codex replies from session file handler instead of runTurn text", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async (_content, { onProgress }) => {
          await workingStatusHandler?.({
            phase: "working_status_monitor",
            reply_in_progress: true,
            status_line: "• Working (12s • esc to interrupt)",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "first streamed reply",
            sessionId: "session-stream-1",
            sessionFilePath: "/tmp/session-stream-1.jsonl",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "second streamed reply",
            sessionId: "session-stream-1",
            sessionFilePath: "/tmp/session-stream-1.jsonl",
            replyTo: activeReplyTo,
          });
          await workingStatusHandler?.({
            phase: "working_status_clear",
            reply_in_progress: false,
            replyTo: activeReplyTo,
          });
          return {
            text: "direct result should be ignored",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-stream-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-stream",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.respondToMessage({ message_id: "msg-stream-1", role: "user", content: "hello" });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["first streamed reply", "second streamed reply"],
    );
    assert.equal(
      sentMessages.every((entry) => entry.metadata?.reply_to === "msg-stream-1"),
      true,
    );
    assert.equal(
      sentMessages.some((entry) => entry.content.includes("direct result should be ignored")),
      false,
    );
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.status_done_line === "codex finished"),
      false,
    );
    assert.equal(
      sentRuntimeStatuses.some(
        (entry) => entry.payload?.status_line === "• Working (12s • esc to interrupt)",
      ),
      true,
    );
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.state === "DONE"),
      false,
    );
  });

  it("forwards codex app-server messages without fire-side aggregation", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => {
          await workingStatusHandler?.({
            phase: "turn_started",
            source: "codex-app-server",
            reply_in_progress: true,
            status_line: "codex is working",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "hello world",
            source: "codex-app-server",
            preserveWhitespace: true,
            sessionId: "session-app-server-1",
            sessionFilePath: "/tmp/session-app-server-1.jsonl",
            replyTo: activeReplyTo,
          });
          await workingStatusHandler?.({
            phase: "turn_completed",
            source: "codex-app-server",
            reply_in_progress: false,
            status_done_line: "codex finished",
            replyTo: activeReplyTo,
          });
          return {
            text: "hello world",
            usage: null,
            items: [],
            metadata: { source: "codex-app-server" },
          };
        },
        threadId: "thread-app-server-1",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-app-server",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.respondToMessage({ message_id: "msg-app-server-1", role: "user", content: "hello" });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["hello world"],
    );
    assert.equal(sentMessages[0].metadata?.reply_to, "msg-app-server-1");
    assert.equal(sentMessages[0].metadata?.session_stream, true);
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.status_line === "codex is working"),
      true,
    );
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.status_done_line === "codex finished"),
      true,
    );
  });

  it("keeps multiple codex app-server assistant messages separated", async () => {
    const sentMessages = [];
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => {
          await workingStatusHandler?.({
            phase: "turn_started",
            source: "codex-app-server",
            reply_in_progress: true,
            status_line: "codex is working",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "开始计时 2 分钟。",
            source: "codex-app-server",
            preserveWhitespace: true,
            sessionId: "session-app-server-2",
            sessionFilePath: "/tmp/session-app-server-2.jsonl",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "完成",
            source: "codex-app-server",
            preserveWhitespace: true,
            sessionId: "session-app-server-2",
            sessionFilePath: "/tmp/session-app-server-2.jsonl",
            replyTo: activeReplyTo,
          });
          await workingStatusHandler?.({
            phase: "turn_completed",
            source: "codex-app-server",
            reply_in_progress: false,
            status_done_line: "codex finished",
            replyTo: activeReplyTo,
          });
          return {
            text: "开始计时 2 分钟。完成",
            usage: null,
            items: [],
            metadata: { source: "codex-app-server" },
          };
        },
        threadId: "thread-app-server-2",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-app-server-multi",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.respondToMessage({ message_id: "msg-app-server-2", role: "user", content: "hello" });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["开始计时 2 分钟。", "完成"],
    );
    assert.ok(sentMessages.every((entry) => entry.metadata?.reply_to === "msg-app-server-2"));
    assert.ok(sentMessages.every((entry) => entry.metadata?.session_stream === true));
  });

  it("streams copilot replies from session file handler instead of runTurn text", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => {
          await workingStatusHandler?.({
            phase: "working_status_monitor",
            reply_in_progress: true,
            status_line: "◎ Running timer (Esc to cancel · 202 B)",
            replyTo: activeReplyTo,
          });
          await sessionMessageHandler?.({
            text: "copilot streamed reply",
            sessionId: "session-stream-copilot",
            sessionFilePath: "/tmp/session-stream-copilot.jsonl",
            replyTo: activeReplyTo,
          });
          await workingStatusHandler?.({
            phase: "working_status_clear",
            reply_in_progress: false,
            replyTo: activeReplyTo,
          });
          return {
            text: "copilot direct result should be ignored",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-stream-copilot",
        threadOptions: { model: "copilot" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-stream-copilot",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "copilot",
    });

    await runner.respondToMessage({ message_id: "msg-stream-copilot-1", role: "user", content: "hello" });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["copilot streamed reply"],
    );
    assert.equal(sentMessages[0].metadata?.reply_to, "msg-stream-copilot-1");
    assert.equal(
      sentMessages.some((entry) => entry.content.includes("direct result should be ignored")),
      false,
    );
    assert.equal(
      sentRuntimeStatuses.some(
        (entry) => entry.payload?.status_line === "◎ Running timer (Esc to cancel · 202 B)",
      ),
      true,
    );
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.state === "DONE"),
      false,
    );
  });

  it("keeps forwarding codex session file replies after runTurn has resolved", async () => {
    const sentMessages = [];
    let sessionMessageHandler = null;
    let workingStatusHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => ({
          text: "",
          usage: null,
          items: [],
          metadata: {},
        }),
        threadId: "thread-stream-late",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-stream-late",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.respondToMessage({ message_id: "msg-stream-late", role: "user", content: "hello again" });
    await workingStatusHandler?.({
      phase: "working_status_monitor",
      reply_in_progress: true,
      status_line: "• Working (21s • esc to interrupt)",
      replyTo: activeReplyTo,
    });
    await sessionMessageHandler?.({
      text: "late streamed follow-up",
      sessionId: "session-stream-late",
      sessionFilePath: "/tmp/session-stream-late.jsonl",
      replyTo: activeReplyTo,
    });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["late streamed follow-up"],
    );
    assert.equal(sentMessages[0].metadata?.reply_to, "msg-stream-late");
  });

  it("does not report codex checkpoint unavailable after a streamed reply was already sent", async () => {
    const sentMessages = [];
    const sentRuntimeStatuses = [];
    let sessionMessageHandler = null;
    let activeReplyTo = "";

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: () => {},
        runTurn: async () => {
          await sessionMessageHandler?.({
            text: "streamed before checkpoint error",
            sessionId: "session-stream-checkpoint",
            sessionFilePath: "/tmp/session-stream-checkpoint.jsonl",
            replyTo: activeReplyTo,
          });
          throw new Error("Codex session file checkpoint unavailable");
        },
        threadId: "thread-stream-checkpoint",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-session-stream-checkpoint",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await runner.respondToMessage({ message_id: "msg-stream-checkpoint", role: "user", content: "hello" });

    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["streamed before checkpoint error"],
    );
    assert.equal(
      sentMessages.some((entry) => String(entry.content || "").includes("处理失败")),
      false,
    );
    assert.equal(runner.processedMessageIds.has("msg-stream-checkpoint"), true);
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.state === "ERROR"),
      false,
    );
    assert.equal(
      sentRuntimeStatuses.some((entry) => entry.payload?.phase === "session_stream_settled"),
      true,
    );
  });

  it("keeps forwarding codex Working status updates outside runTurn callbacks", async () => {
    const sentRuntimeStatuses = [];
    let workingStatusHandler = null;

    const runner = new BridgeRunner({
      backendSession: {
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: () => {},
        setWorkingStatusHandler: (handler) => {
          workingStatusHandler = handler;
        },
        runTurn: async () => ({
          text: "",
          usage: null,
          items: [],
          metadata: {},
        }),
        threadId: "thread-working-monitor",
        threadOptions: { model: "codex" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async (taskId, payload) => {
          sentRuntimeStatuses.push({ taskId, payload });
          return {};
        },
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-working-monitor",
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
    });

    await workingStatusHandler?.({
      phase: "working_status_monitor",
      reply_in_progress: true,
      status_line: "• Working (5s • esc to interrupt)",
      replyTo: "msg-working-1",
    });
    await workingStatusHandler?.({
      phase: "working_status_monitor",
      reply_in_progress: true,
      status_line: "• Working (6s • esc to interrupt)",
      replyTo: "msg-working-1",
    });
    await workingStatusHandler?.({
      phase: "working_status_clear",
      reply_in_progress: false,
      replyTo: "msg-working-1",
    });

    assert.deepEqual(
      sentRuntimeStatuses.map((entry) => entry.payload?.status_line || ""),
      ["• Working (5s • esc to interrupt)", "• Working (6s • esc to interrupt)", ""],
    );
    assert.equal(sentRuntimeStatuses[0].payload?.reply_in_progress, true);
    assert.equal(sentRuntimeStatuses[1].payload?.reply_in_progress, true);
    assert.equal(sentRuntimeStatuses[2].payload?.reply_in_progress, false);
    assert.equal(sentRuntimeStatuses[2].payload?.state, undefined);
  });

  it("starts codex from live queue without startup history backfill", async () => {
    let sessionMessageHandler = null;
    let activeReplyTo = "";

    await assertStartupProcessesOnlyLiveQueue({
      backendName: "codex",
      createBackendSession: ({ onRunTurn }) => ({
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: () => {},
        runTurn: async () => {
          onRunTurn();
          await sessionMessageHandler?.({
            text: "codex live reply",
            sessionId: "session-live-codex",
            sessionFilePath: "/tmp/session-live-codex.jsonl",
            replyTo: activeReplyTo,
          });
          return { text: "", usage: null, items: [], metadata: {} };
        },
        threadId: "thread-live-codex",
        threadOptions: { model: "codex" },
      }),
      expectedContents: ["codex live reply"],
    });
  });

  it("starts claude from live queue without startup history backfill", async () => {
    await assertStartupProcessesOnlyLiveQueue({
      backendName: "claude",
      createBackendSession: ({ onRunTurn }) => ({
        runTurn: async () => {
          onRunTurn();
          return {
            text: "claude live reply",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-live-claude",
        threadOptions: { model: "claude" },
      }),
      expectedContents: ["claude live reply"],
    });
  });

  it("starts opencode from live queue without startup history backfill", async () => {
    let sessionMessageHandler = null;
    let activeReplyTo = "";

    await assertStartupProcessesOnlyLiveQueue({
      backendName: "opencode",
      createBackendSession: ({ onRunTurn }) => ({
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: () => {},
        runTurn: async () => {
          onRunTurn();
          await sessionMessageHandler?.({
            text: "opencode live reply",
            sessionId: "session-live-opencode",
            replyTo: activeReplyTo,
          });
          return {
            text: "opencode direct result should be ignored",
            usage: null,
            items: [],
            metadata: { source: "opencode-sdk" },
          };
        },
        threadId: "thread-live-opencode",
        threadOptions: { model: "opencode" },
      }),
      expectedContents: ["opencode live reply"],
    });
  });

  it("starts copilot from live queue without startup history backfill", async () => {
    await assertStartupProcessesOnlyLiveQueue({
      backendName: "copilot",
      createBackendSession: ({ onRunTurn }) => ({
        runTurn: async () => {
          onRunTurn();
          return {
            text: "copilot live reply",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-live-copilot",
        threadOptions: { model: "copilot" },
      }),
      expectedContents: ["copilot live reply"],
    });
  });

  it("processes the initial prompt once from the live queue and preserves initial images", async () => {
    const sentMessages = [];
    const runTurnCalls = [];
    let runner;
    let receiveCount = 0;

    const backendSession = {
      runTurn: async (content, options = {}) => {
        runTurnCalls.push({ content, options });
        return {
          text: "initial live reply",
          usage: null,
          items: [],
          metadata: {},
        };
      },
      threadId: "thread-initial-live",
      threadOptions: { model: "claude" },
    };

    runner = new BridgeRunner({
      backendSession,
      conductor: {
        receiveMessages: async () => {
          receiveCount += 1;
          if (receiveCount === 1) {
            return {
              messages: [{ message_id: "msg-initial-1", role: "user", content: "hello with image" }],
              has_more: false,
            };
          }
          runner.stopped = true;
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-initial-live-once",
      pollIntervalMs: 500,
      initialPrompt: "hello with image",
      initialPromptDelivery: "queued",
      includeInitialImages: true,
      cliArgs: [],
      backendName: "claude",
    });

    await runner.start();

    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0].content, "hello with image");
    assert.equal(runTurnCalls[0].options.useInitialImages, true);
    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["initial live reply"],
    );
    assert.equal(sentMessages[0].metadata?.reply_to, "msg-initial-1");
  });

  it("retries queued initial prompts with initial images until the turn succeeds", async () => {
    const runTurnCalls = [];
    let attempt = 0;

    const runner = new BridgeRunner({
      backendSession: {
        runTurn: async (content, options = {}) => {
          attempt += 1;
          runTurnCalls.push({ content, options });
          if (attempt === 1) {
            throw new Error("transient opencode failure");
          }
          return {
            text: "initial retry reply",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-initial-retry",
        threadOptions: { model: "opencode" },
      },
      conductor: {
        receiveMessages: async () => ({ messages: [] }),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async () => ({}),
      },
      taskId: "task-initial-retry",
      pollIntervalMs: 500,
      initialPrompt: "hello with image",
      initialPromptDelivery: "queued",
      includeInitialImages: true,
      cliArgs: [],
      backendName: "opencode",
    });

    await runner.respondToMessage({ message_id: "msg-initial-retry", role: "user", content: "hello with image" });
    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0].options.useInitialImages, true);
    assert.equal(runner.pendingInitialPrompt, "hello with image");

    await runner.respondToMessage({ message_id: "msg-initial-retry", role: "user", content: "hello with image" });
    assert.equal(runTurnCalls.length, 2);
    assert.equal(runTurnCalls[1].options.useInitialImages, true);
    assert.equal(runner.pendingInitialPrompt, "");
  });

  it("keeps synthetic initial prompt handling when attaching to an existing task", async () => {
    const sentMessages = [];
    let sessionMessageHandler = null;
    let activeReplyTo = "";
    let runner;
    let receiveCount = 0;
    const runTurnCalls = [];

    const backendSession = {
      usesSessionFileReplyStream: () => true,
      setSessionMessageHandler: (handler) => {
        sessionMessageHandler = handler;
      },
      setSessionReplyTarget: (replyTo) => {
        activeReplyTo = String(replyTo || "");
      },
      setWorkingStatusHandler: () => {},
      runTurn: async (content, options = {}) => {
        runTurnCalls.push({ content, options });
        await sessionMessageHandler?.({
          text: "attach live reply",
          sessionId: "session-attach-live",
          replyTo: activeReplyTo,
        });
        return { text: "", usage: null, items: [], metadata: {} };
      },
      threadId: "thread-attach-live",
      threadOptions: { model: "opencode" },
    };

    runner = new BridgeRunner({
      backendSession,
      conductor: {
        receiveMessages: async () => {
          receiveCount += 1;
          if (receiveCount === 1) {
            runner.stopped = true;
          }
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-attach-initial",
      pollIntervalMs: 500,
      initialPrompt: "attach prompt",
      initialPromptDelivery: "synthetic",
      includeInitialImages: true,
      cliArgs: [],
      backendName: "opencode",
    });

    await runner.start();

    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0].content, "attach prompt");
    assert.equal(runTurnCalls[0].options.useInitialImages, true);
    assert.deepEqual(
      sentMessages.map((entry) => entry.content),
      ["attach live reply"],
    );
    assert.equal(sentMessages[0].metadata?.reply_to, "initial");
  });

  it("starts resumed backend sessions from live queue without startup drain", async () => {
    let sessionMessageHandler = null;
    let activeReplyTo = "";

    await assertStartupProcessesOnlyLiveQueue({
      backendName: "codex",
      resumeSessionId: "019cb2a4-de18-70b0-816b-a9b0d99400bb",
      createBackendSession: ({ onRunTurn }) => ({
        usesSessionFileReplyStream: () => true,
        setSessionMessageHandler: (handler) => {
          sessionMessageHandler = handler;
        },
        setSessionReplyTarget: (replyTo) => {
          activeReplyTo = String(replyTo || "");
        },
        setWorkingStatusHandler: () => {},
        runTurn: async () => {
          onRunTurn();
          await sessionMessageHandler?.({
            text: "codex resumed live reply",
            sessionId: "session-live-codex-resume",
            sessionFilePath: "/tmp/session-live-codex-resume.jsonl",
            replyTo: activeReplyTo,
          });
          return { text: "", usage: null, items: [], metadata: {} };
        },
        threadId: "thread-live-codex-resume",
        threadOptions: { model: "codex" },
      }),
      expectedContents: ["codex resumed live reply"],
    });
  });
});

describe("pre_prompt delivery", () => {
  it("sends pre_prompt as a user-visible synthetic message and triggers a runTurn before any real message", async () => {
    const runTurnCalls = [];
    const sentMessages = [];
    let receiveCount = 0;

    const runner = new BridgeRunner({
      backendSession: {
        runTurn: async (content, options = {}) => {
          runTurnCalls.push({ content, options });
          return {
            text: "pre_prompt ack reply",
            usage: null,
            items: [],
            metadata: {},
          };
        },
        threadId: "thread-preprompt",
        threadOptions: { model: "claude" },
      },
      conductor: {
        receiveMessages: async () => {
          receiveCount += 1;
          // Stop after pre_prompt handling completes; no real user messages exist.
          runner.stopped = true;
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-pre-prompt",
      pollIntervalMs: 500,
      initialPrompt: "",
      initialPromptDelivery: "none",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "claude",
      prePrompt: "follow repo guidelines strictly",
      shouldProcessPrePrompt: true,
    });

    await runner.start();

    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0].content, "follow repo guidelines strictly");
    assert.equal(runTurnCalls[0].options.useInitialImages, false);

    const userBubble = sentMessages.find((entry) => entry.metadata?.pre_prompt === true);
    assert.ok(userBubble, "pre_prompt must be surfaced as a visible message");
    assert.equal(userBubble.content, "follow repo guidelines strictly");
    assert.equal(userBubble.metadata.role, "user");
    assert.equal(userBubble.metadata.visible_as, "user");
    assert.equal(userBubble.metadata.origin, "pre_prompt");

    const replyBubble = sentMessages.find((entry) => entry.metadata?.pre_prompt_response === true);
    assert.ok(replyBubble, "pre_prompt AI reply must be surfaced");
    assert.match(replyBubble.content, /pre_prompt ack reply/);

    assert.equal(runner.shouldProcessPrePrompt, false, "pre_prompt must not be re-processed");
    assert.ok(receiveCount >= 1, "main loop should still run after pre_prompt");
  });

  it("does not process pre_prompt when shouldProcessPrePrompt is false (e.g. reconnect)", async () => {
    const runTurnCalls = [];
    const sentMessages = [];

    const runner = new BridgeRunner({
      backendSession: {
        runTurn: async (content, options = {}) => {
          runTurnCalls.push({ content, options });
          return { text: "", usage: null, items: [], metadata: {} };
        },
        threadId: "thread-preprompt-skip",
        threadOptions: { model: "claude" },
      },
      conductor: {
        receiveMessages: async () => {
          runner.stopped = true;
          return { messages: [] };
        },
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        sendMessage: async (taskId, content, metadata) => {
          sentMessages.push({ taskId, content, metadata });
          return {};
        },
      },
      taskId: "task-pre-prompt-skip",
      pollIntervalMs: 500,
      initialPrompt: "",
      initialPromptDelivery: "none",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "claude",
      prePrompt: "should be skipped",
      shouldProcessPrePrompt: false,
    });

    await runner.start();

    assert.equal(runTurnCalls.length, 0);
    assert.equal(
      sentMessages.filter((entry) => entry.metadata?.pre_prompt === true).length,
      0,
    );
  });
});
