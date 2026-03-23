import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KimiCliSession } from "../src/session-factory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_KIMI_WIRE = path.resolve(__dirname, "..", "fixtures", "fake-kimi-wire.js");

class IdleCloseTransport extends EventEmitter {
  constructor() {
    super();
    this.bootCalls = 0;
    this.requestCalls = 0;
    this.closeCalls = 0;
  }

  async boot() {
    this.bootCalls += 1;
  }

  async request() {
    this.requestCalls += 1;
    return {};
  }

  async close() {
    this.closeCalls += 1;
  }
}

class ExitDuringTurnTransport extends EventEmitter {
  constructor() {
    super();
    this.bootCalls = 0;
    this.closeCalls = 0;
    this.promptRequests = 0;
  }

  async boot() {
    this.bootCalls += 1;
  }

  async request(method) {
    if (method === "prompt") {
      this.promptRequests += 1;
      return await new Promise(() => {});
    }
    if (method === "cancel") {
      return {};
    }
    return {};
  }

  async close() {
    this.closeCalls += 1;
  }
}

class ChatteryTransport extends EventEmitter {
  constructor() {
    super();
    this.bootCalls = 0;
    this.closeCalls = 0;
  }

  async boot() {
    this.bootCalls += 1;
  }

  async request(method) {
    if (method === "prompt") {
      this.emit("event", { type: "TurnBegin", payload: {} });
      this.emit("event", { type: "StepBegin", payload: { n: 1 } });
      for (let index = 0; index < 6; index += 1) {
        this.emit("event", {
          type: "ContentPart",
          payload: { type: "think", think: `thought-${index}` },
        });
      }
      for (const text of ["H", "He", "Hel", "Hello", "Hello world", "Hello world from Kimi"]) {
        this.emit("event", {
          type: "ContentPart",
          payload: { type: "text", text },
        });
      }
      this.emit("event", {
        type: "ToolCall",
        payload: {
          id: "tool-1",
          function: { name: "Shell" },
        },
      });
      this.emit("event", {
        type: "ToolResult",
        payload: {
          tool_call_id: "tool-1",
          return_value: { message: "command finished" },
        },
      });
      this.emit("event", { type: "TurnEnd", payload: {} });
      return { status: "finished" };
    }
    if (method === "cancel") {
      return {};
    }
    return {};
  }

  async close() {
    this.closeCalls += 1;
  }
}

describe("kimi cli session", () => {
  it("runs kimi turns through wire mode and preserves the same session across turns", async () => {
    const messages = [];
    const statuses = [];
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_WIRE}`,
      logger: { log: () => {} },
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-kimi-1");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, session.getSnapshot().sessionId);
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    const firstTurn = await session.runTurn("Reply with exactly OK");
    assert.equal(firstTurn.text, "OK from fake kimi\n");

    const secondTurn = await session.runTurn("Reply again [multi-turn]");
    assert.equal(secondTurn.text, "turn 2 from fake kimi\n");

    assert.deepEqual(
      messages.map((payload) => payload.text),
      ["OK from fake kimi\n", "turn 2 from fake kimi\n"],
    );
    assert.ok(messages.every((payload) => payload.replyTo === "reply-kimi-1"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_started"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "command_execution"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.some((payload) => payload.reply_in_progress === false));
    assert.ok(statuses.every((payload) => payload.source === "kimi-cli-wire"));

    const usage = await session.getSessionUsageSummary();
    assert.equal(usage.sessionId, sessionInfo.sessionId);
    assert.equal(usage.contextUsagePercent, 57);
    assert.equal(usage.tokenUsage.output, 12);
    assert.equal(usage.manualResume.ready, true);
    assert.match(usage.manualResume.command, new RegExp(`^${process.execPath} .*fake-kimi-wire\\.js --work-dir `));
    assert.match(usage.manualResume.command, / --session /);

    await session.close();
  });

  it("emits auth_required when kimi reports missing model configuration", async () => {
    const authRequiredEvents = [];
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_WIRE}`,
      logger: { log: () => {} },
    });

    session.on("auth_required", (payload) => {
      authRequiredEvents.push(payload);
    });

    await session.ensureSessionInfo();

    await assert.rejects(
      () => session.runTurn("trigger [auth-error]"),
      /LLM is not set/,
    );

    assert.equal(authRequiredEvents.length > 0, true);
    assert.equal(authRequiredEvents.at(-1)?.reason, "login_required");

    await session.close();
  });

  it("fails fast when kimi requests interactive input in unattended mode", async () => {
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_WIRE}`,
      logger: { log: () => {} },
    });

    await session.ensureSessionInfo();

    await assert.rejects(
      () => session.runTurn("please ask me [question]"),
      /interactive input in unattended Conductor mode/,
    );

    await session.close();
  });

  it("does not boot the transport when closing an idle session", async () => {
    const transport = new IdleCloseTransport();
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport,
      logger: { log: () => {} },
    });

    await session.close();

    assert.equal(transport.bootCalls, 0);
    assert.equal(transport.requestCalls, 0);
    assert.equal(transport.closeCalls, 1);
  });

  it("surfaces transport exits instead of rewriting them as session_closed", async () => {
    const transport = new ExitDuringTurnTransport();
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport,
      logger: { log: () => {} },
    });

    const turnPromise = session.runTurn("Reply with exactly OK");
    await new Promise((resolve) => setImmediate(resolve));
    transport.emit("process_exit", {
      code: 1,
      signal: null,
      stderr: ["auth missing"],
    });

    await assert.rejects(turnPromise, (error) => {
      assert.equal(error?.reason, "transport_exited");
      assert.match(String(error?.message || ""), /Kimi CLI exited: auth missing/);
      return true;
    });

    assert.equal(transport.promptRequests, 1);
    assert.equal(transport.closeCalls, 0);
  });

  it("builds manual resume commands from the resolved transport command", () => {
    const session = new KimiCliSession("kimi", {
      cwd: "/tmp/Kimi Workspace",
      commandLine: "\"/custom/Kimi App/bin/kimi\" --trace",
      resumeSessionId: "session-kimi-42",
      model: "kimi-k2.5",
      logger: { log: () => {} },
    });

    const command = session.getSnapshot().manualResume?.command || "";
    assert.equal(
      command,
      "'/custom/Kimi App/bin/kimi' --trace --work-dir '/tmp/Kimi Workspace' --session session-kimi-42 --model kimi-k2.5",
    );
  });

  it("deduplicates and throttles noisy status updates with more natural wording", async () => {
    const statuses = [];
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport: new ChatteryTransport(),
      logger: { log: () => {} },
    });

    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });

    const result = await session.runTurn("Reply with hello");
    assert.equal(result.text, "HHeHelHelloHello worldHello world from Kimi");

    const reasoningStatuses = statuses.filter((payload) => payload.phase === "reasoning");
    const messageAggregationStatuses = statuses.filter((payload) => payload.phase === "message_aggregation");
    const turnStartedStatuses = statuses.filter((payload) => payload.phase === "turn_started");
    const commandStatuses = statuses.filter((payload) => payload.phase === "command_execution");
    const terminalStatus = statuses.at(-1);

    assert.equal(turnStartedStatuses.length, 1);
    assert.equal(reasoningStatuses.length, 1);
    assert.ok(messageAggregationStatuses.length >= 1);
    assert.ok(messageAggregationStatuses.length <= 2);
    assert.equal(commandStatuses.length, 2);
    assert.equal(turnStartedStatuses[0]?.status_line, "Kimi is working on it");
    assert.equal(reasoningStatuses[0]?.status_line, "Kimi is thinking");
    assert.equal(messageAggregationStatuses[0]?.status_line, "Kimi is writing the reply");
    assert.equal(commandStatuses[0]?.status_line, "Kimi is running Shell");
    assert.equal(commandStatuses[1]?.status_done_line, "command finished");
    assert.equal(terminalStatus?.status_done_line, "Kimi finished");

    await session.close();
  });
});
