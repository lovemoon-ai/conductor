import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CopilotSdkSession } from "../src/session-factory.js";
import { resolveBundledCopilotCliPath } from "../src/providers/copilot-sdk-session.js";

function assertBundledCopilotCliPath(value) {
  if (value === undefined) {
    return;
  }
  assert.match(
    value,
    /[\\/]@github[\\/]copilot-(?:darwin|linux|win32)-(?:arm64|x64)[\\/]copilot(?:\.exe)?$|[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/,
  );
  assert.doesNotMatch(value, /[\\/]@github[\\/]copilot[\\/]index\.js$/);
}

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeCopilotSession {
  constructor(sessionId, state, { onSendAndWait = null } = {}) {
    this.sessionId = sessionId;
    this.state = state;
    this.onSendAndWait = onSendAndWait;
    this.handlers = new Map();
  }

  on(eventType, handler) {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);
    return () => {
      const nextHandlers = (this.handlers.get(eventType) || []).filter((entry) => entry !== handler);
      if (nextHandlers.length > 0) {
        this.handlers.set(eventType, nextHandlers);
      } else {
        this.handlers.delete(eventType);
      }
    };
  }

  async emitEvent(event) {
    const handlers = this.handlers.get(event?.type) || [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  async sendAndWait(options, timeout) {
    this.state.prompts.push(options);
    this.state.sendTimeouts.push(timeout);
    if (typeof this.onSendAndWait === "function") {
      return await this.onSendAndWait(this, options);
    }
    return undefined;
  }

  async abort() {
    this.state.abortCalls += 1;
  }

  async disconnect() {
    this.state.disconnectCalls += 1;
    if (typeof this.state.onDisconnect === "function") {
      return await this.state.onDisconnect();
    }
  }
}

function createCopilotSdkHarness({ onCreateSession, onResumeSession, onDisconnect = null, onStop = null } = {}) {
  const state = {
    startCalls: 0,
    stopCalls: 0,
    forceStopCalls: 0,
    abortCalls: 0,
    disconnectCalls: 0,
    prompts: [],
    clientOptions: [],
    createSessionConfigs: [],
    resumeSessionConfigs: [],
    sendTimeouts: [],
    onDisconnect,
    onStop,
  };

  class FakeCopilotClient {
    constructor(options = {}) {
      state.clientOptions.push(options);
    }

    async start() {
      state.startCalls += 1;
    }

    async stop() {
      state.stopCalls += 1;
      if (typeof state.onStop === "function") {
        return await state.onStop();
      }
      return [];
    }

    async forceStop() {
      state.forceStopCalls += 1;
    }

    async createSession(config) {
      state.createSessionConfigs.push(config);
      if (typeof onCreateSession === "function") {
        return await onCreateSession(config, state);
      }
      return new FakeCopilotSession("copilot-session-1", state);
    }

    async resumeSession(sessionId, config) {
      state.resumeSessionConfigs.push({ sessionId, config });
      if (typeof onResumeSession === "function") {
        return await onResumeSession(sessionId, config, state);
      }
      return new FakeCopilotSession(sessionId, state);
    }
  }

  return {
    sdkModule: {
      CopilotClient: FakeCopilotClient,
      approveAll: () => ({ kind: "approved" }),
    },
    state,
  };
}

describe("copilot sdk session", () => {
  it("resolves the bundled Copilot platform executable before the JS loader", () => {
    const resolved = resolveBundledCopilotCliPath({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (packageName) => {
        if (packageName === "@github/copilot-darwin-arm64") {
          return "/tmp/node_modules/@github/copilot-darwin-arm64/copilot";
        }
        throw new Error(`unexpected package: ${packageName}`);
      },
      resolvePackagePaths: () => ["/tmp/node_modules"],
      existsSyncFn: (candidate) =>
        candidate === "/tmp/node_modules/@github/copilot-darwin-arm64/copilot" ||
        candidate === "/tmp/node_modules/@github/copilot/npm-loader.js",
    });

    assert.equal(resolved, "/tmp/node_modules/@github/copilot-darwin-arm64/copilot");
  });

  it("falls back to the Copilot npm loader when the platform package is absent", () => {
    const resolved = resolveBundledCopilotCliPath({
      platform: "linux",
      arch: "x64",
      resolvePackage: () => {
        throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
      },
      resolvePackagePaths: () => ["/tmp/node_modules"],
      existsSyncFn: (candidate) => candidate === "/tmp/node_modules/@github/copilot/npm-loader.js",
    });

    assert.equal(resolved, "/tmp/node_modules/@github/copilot/npm-loader.js");
  });

  it("runs streaming turns through the Copilot SDK and strips legacy CLI flags", async () => {
    const messages = [];
    const statuses = [];
    const harness = createCopilotSdkHarness({
      onCreateSession(config, state) {
        assert.equal(typeof config.onPermissionRequest, "function");
        assert.equal(config.workingDirectory, process.cwd());
        assert.equal(config.streaming, true);

        return new FakeCopilotSession("copilot-session-1", state, {
          async onSendAndWait(session) {
            await session.emitEvent({
              type: "assistant.turn_start",
              data: { turnId: "turn-1" },
            });
            await session.emitEvent({
              type: "assistant.intent",
              data: { intent: "Inspecting the workspace" },
            });
            await session.emitEvent({
              type: "assistant.reasoning_delta",
              data: { reasoningId: "reason-1", deltaContent: "thinking" },
            });
            await session.emitEvent({
              type: "tool.execution_start",
              data: { toolCallId: "tool-1", toolName: "read_file" },
            });
            await session.emitEvent({
              type: "tool.execution_progress",
              data: { toolCallId: "tool-1", progressMessage: "Reading package.json" },
            });
            await session.emitEvent({
              type: "tool.execution_complete",
              data: {
                toolCallId: "tool-1",
                success: true,
                result: {
                  content: "done",
                  contents: [{ type: "text", text: "done" }],
                },
              },
            });
            await session.emitEvent({
              type: "assistant.message_delta",
              data: { messageId: "message-1", deltaContent: "Hello " },
            });
            await session.emitEvent({
              type: "assistant.message_delta",
              data: { messageId: "message-1", deltaContent: "world" },
            });
            await session.emitEvent({
              type: "assistant.message",
              data: { messageId: "message-1", content: "Hello world" },
            });
            await session.emitEvent({
              type: "assistant.usage",
              data: {
                model: "gpt-5",
                inputTokens: 10,
                outputTokens: 20,
                reasoningEffort: "high",
                quotaSnapshots: {
                  core: {
                    isUnlimitedEntitlement: false,
                    entitlementRequests: 100,
                    usedRequests: 5,
                    usageAllowedWithExhaustedQuota: false,
                    overage: 0,
                    overageAllowedWithExhaustedQuota: false,
                    remainingPercentage: 0.95,
                  },
                },
              },
            });
            await session.emitEvent({
              type: "session.idle",
              data: {},
            });
            return {
              type: "assistant.message",
              data: { messageId: "message-1", content: "Hello world" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      commandLine: "copilot --allow-all-paths --allow-all-tools --trace",
      env: { PATH: "" },
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-copilot-1");

    const result = await session.runTurn("hello");

    assert.equal(result.text, "Hello world");
    assert.deepEqual(
      messages.map((payload) => payload.text),
      ["Hello world"],
    );
    assert.ok(messages.every((payload) => payload.replyTo === "reply-copilot-1"));
    assert.ok(statuses.some((payload) => payload.phase === "planning"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "workspace_inspection"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.some((payload) => payload.reply_in_progress === false));
    assert.ok(statuses.some((payload) => payload.reply_preview === "done"));
    assert.equal(session.getSessionInfo()?.model, "gpt-5");
    assert.equal(session.getSessionInfo()?.modelProvider, "github-copilot");
    assert.equal(session.getSessionInfo()?.reasoningEffort, "high");
    assert.deepEqual(session.threadOptions, {
      model: "gpt-5",
      modelProvider: "github-copilot",
    });

    const usage = await session.getSessionUsageSummary();
    assert.equal(usage.sessionId, "copilot-session-1");
    assert.equal(usage.manualResume?.command, "copilot --resume=copilot-session-1");
    assert.equal(usage.usage?.inputTokens, 10);
    assert.equal(harness.state.startCalls, 1);
    assert.equal(harness.state.stopCalls, 0);
    assertBundledCopilotCliPath(harness.state.clientOptions[0]?.cliPath);
    assert.deepEqual(harness.state.clientOptions[0]?.cliArgs, ["--trace"]);
    assert.equal(harness.state.prompts[0]?.mode, "immediate");
    assert.equal(harness.state.sendTimeouts[0], session.turnDeadlineMs + 5_000);

    await session.close();
    assert.equal(harness.state.disconnectCalls, 1);
    assert.equal(harness.state.stopCalls, 1);
  });

  it("uses the SDK-managed Copilot CLI for the default copilot command", async () => {
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-default-cli", state, {
          async onSendAndWait() {
            return {
              data: { content: "hello from copilot" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      commandLine: "copilot --allow-all-paths --allow-all-tools",
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    const result = await session.runTurn("hello");

    assert.equal(result.text, "hello from copilot");
    assertBundledCopilotCliPath(harness.state.clientOptions[0]?.cliPath);
    assert.equal(harness.state.clientOptions[0]?.cliArgs, undefined);

    await session.close();
  });

  it("unwraps env command wrappers for Copilot client options", async () => {
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-env-wrapper", state, {
          async onSendAndWait() {
            return {
              data: { content: "hello from env wrapper" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      commandLine: "env GITHUB_TOKEN=test-token copilot --trace",
      env: { PATH: "" },
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    const result = await session.runTurn("hello");

    assert.equal(result.text, "hello from env wrapper");
    assertBundledCopilotCliPath(harness.state.clientOptions[0]?.cliPath);
    assert.deepEqual(harness.state.clientOptions[0]?.cliArgs, ["--trace"]);
    assert.equal(harness.state.clientOptions[0]?.env?.GITHUB_TOKEN, undefined);
    assert.equal(harness.state.clientOptions[0]?.useLoggedInUser, true);

    await session.close();
  });

  it("keeps explicit COPILOT_CLI_PATH env instead of overriding cliPath", async () => {
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-explicit-env-cli", state, {
          async onSendAndWait() {
            return {
              data: { content: "hello from explicit cli" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      env: { COPILOT_CLI_PATH: "/custom/copilot" },
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    const result = await session.runTurn("hello");

    assert.equal(result.text, "hello from explicit cli");
    assert.equal(harness.state.clientOptions[0]?.cliPath, undefined);
    assert.equal(harness.state.clientOptions[0]?.env?.COPILOT_CLI_PATH, "/custom/copilot");

    await session.close();
  });

  it("emits one buffered assistant message when a turn only streams deltas", async () => {
    const messages = [];
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-delta-only", state, {
          async onSendAndWait(session) {
            await session.emitEvent({
              type: "assistant.message_delta",
              data: { messageId: "message-1", deltaContent: "Hello " },
            });
            await session.emitEvent({
              type: "assistant.message_delta",
              data: { messageId: "message-1", deltaContent: "world" },
            });
            await session.emitEvent({
              type: "session.idle",
              data: {},
            });
            return {
              data: { messageId: "message-1", content: "Hello world" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload);
    });

    const result = await session.runTurn("hello");

    assert.equal(result.text, "Hello world");
    assert.deepEqual(messages.map((payload) => payload.text), ["Hello world"]);

    await session.close();
  });

  it("rejects concurrent turns on the same Copilot session", async () => {
    const turnRelease = createDeferred();
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-concurrent", state, {
          async onSendAndWait() {
            await turnRelease.promise;
            return {
              data: { content: "done" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    const firstTurn = session.runTurn("hello");
    await Promise.resolve();

    await assert.rejects(
      () => session.runTurn("hello again"),
      (error) => error?.reason === "turn_already_running",
    );

    turnRelease.resolve();
    await firstTurn;
    await session.close();
  });

  it("rejects a pending turn when the session closes during boot", async () => {
    const createSessionGate = createDeferred();
    const harness = createCopilotSdkHarness({
      async onCreateSession() {
        return createSessionGate.promise;
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    const turnPromise = session.runTurn("hello");
    await session.close();

    await assert.rejects(
      () => turnPromise,
      (error) => error?.reason === "session_closed",
    );

    createSessionGate.resolve(new FakeCopilotSession("copilot-session-late", harness.state));
  });

  it("force-stops the Copilot client when close hangs during disconnect", async () => {
    const harness = createCopilotSdkHarness({
      onDisconnect: () => new Promise(() => {}),
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-close-timeout", state, {
          async onSendAndWait() {
            return {
              data: { content: "done" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      copilotCloseTimeoutMs: 10,
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    await session.runTurn("hello");
    await session.close();

    assert.equal(harness.state.disconnectCalls, 1);
    assert.equal(harness.state.stopCalls, 0);
    assert.equal(harness.state.forceStopCalls, 1);
  });

  it("force-stops the Copilot client when close hangs during stop", async () => {
    const harness = createCopilotSdkHarness({
      onStop: () => new Promise(() => {}),
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-stop-timeout", state, {
          async onSendAndWait() {
            return {
              data: { content: "done" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      copilotCloseTimeoutMs: 10,
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    await session.runTurn("hello");
    await session.close();

    assert.equal(harness.state.disconnectCalls, 1);
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.forceStopCalls, 1);
  });

  it("fails the turn when working status handlers throw", async () => {
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-handler-error", state, {
          async onSendAndWait(session) {
            await session.emitEvent({
              type: "assistant.turn_start",
              data: { turnId: "turn-1" },
            });
            await Promise.resolve();
            return {
              data: { content: "ignored" },
            };
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    session.setWorkingStatusHandler(async () => {
      throw new Error("status handler failed");
    });

    await assert.rejects(() => session.runTurn("hello"), /status handler failed/);
    await session.close();
  });

  it("surfaces auth_required from session errors", async () => {
    const authEvents = [];
    const statuses = [];
    const harness = createCopilotSdkHarness({
      onCreateSession(_config, state) {
        return new FakeCopilotSession("copilot-session-auth", state, {
          async onSendAndWait(session) {
            await session.emitEvent({
              type: "session.error",
              data: {
                errorType: "authentication",
                message: "Login required",
                statusCode: 401,
                url: "https://github.com/login/device",
              },
            });
            await session.emitEvent({
              type: "session.idle",
              data: {},
            });
            return undefined;
          },
        });
      },
    });

    const session = new CopilotSdkSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
    });

    session.on("auth_required", (payload) => {
      authEvents.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });

    await assert.rejects(() => session.runTurn("hello"), /Login required/);

    assert.equal(authEvents.length, 1);
    assert.equal(authEvents[0]?.reason, "login_required");
    assert.equal(authEvents[0]?.url, "https://github.com/login/device");
    assert.equal(statuses.at(-1)?.phase, "turn_failed");
    assert.equal(statuses.at(-1)?.reply_in_progress, false);

    await session.close();
  });
});
