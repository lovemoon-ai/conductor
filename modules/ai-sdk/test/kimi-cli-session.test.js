import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KimiCliSession,
  KimiPrintSession,
  createLocalAiSession,
} from "../src/session-factory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_KIMI_WIRE = path.resolve(__dirname, "..", "fixtures", "fake-kimi-wire.js");
const FAKE_KIMI_CODE = path.resolve(__dirname, "..", "fixtures", "fake-kimi-code.js");

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
  it("detects Kimi Code 0.26 prompt mode and resumes with its real session id", async () => {
    const logs = [];
    const messages = [];
    const sessionEvents = [];
    const session = await createLocalAiSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_CODE}`,
      logger: { log: (line) => logs.push(line) },
    });

    assert.ok(session instanceof KimiPrintSession);
    assert.equal(session.getSnapshot().provider, "kimi-cli-print");
    assert.equal(session.getSnapshot().sessionId, undefined);

    session.on("session", (payload) => {
      sessionEvents.push(payload);
    });
    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload);
    });

    const pendingSessionInfo = await session.ensureSessionInfo();
    assert.equal(pendingSessionInfo.sessionId, undefined);
    assert.equal(pendingSessionInfo.sessionIdDeferred, true);
    assert.equal(sessionEvents.length, 0);

    const firstTurn = await session.runTurn("Reply with exactly OK");
    assert.equal(firstTurn.text, "OK from fake Kimi Code\n");
    assert.ok(logs.some((line) => line.includes("--prompt <redacted:")));
    assert.ok(logs.every((line) => !line.includes("Reply with exactly OK")));
    assert.equal(session.getSnapshot().sessionId, "ses_kimi_code_026");
    assert.equal(session.getSessionInfo().sessionIdDeferred, false);
    assert.deepEqual(sessionEvents.map((payload) => payload.sessionId), ["ses_kimi_code_026"]);

    const secondTurn = await session.runTurn("Reply again");
    assert.equal(secondTurn.text, "turn 2 from fake Kimi Code\n");
    assert.deepEqual(
      messages.map((payload) => payload.text),
      ["OK from fake Kimi Code\n", "turn 2 from fake Kimi Code\n"],
    );

    const manualResume = session.getSnapshot().manualResume?.command || "";
    assert.match(manualResume, /^cd .* && /);
    assert.match(manualResume, / --session ses_kimi_code_026$/);
    assert.doesNotMatch(manualResume, /--work-dir|--wire|--print/);

    const interruptedTurn = session.runTurn("Wait for interruption [slow]");
    const interruptDeadline = Date.now() + 1_000;
    while (!session.currentTurn?.child && Date.now() < interruptDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(session.currentTurn?.child);
    assert.equal(await session.interruptCurrentTurn(), true);
    await assert.rejects(interruptedTurn, (error) => {
      assert.equal(error?.reason, "turn_interrupted");
      return true;
    });

    await session.close();
  });

  it("strips managed short aliases from Kimi Code prompt command lines", async () => {
    const session = await createLocalAiSession("kimi", {
      cwd: process.cwd(),
      commandLine: [
        process.execPath,
        FAKE_KIMI_CODE,
        "-S", "stale-session",
        "-rlegacy-session",
        "-c",
        "-m", "stale-model",
        "-pold-prompt",
        "-w", "/tmp/stale-workspace",
        "-y",
        "-C",
      ].join(" "),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof KimiPrintSession);
    assert.deepEqual(session.baseArgs, [FAKE_KIMI_CODE]);

    const result = await session.runTurn("Reply with exactly OK");
    assert.equal(result.text, "OK from fake Kimi Code\n");
    assert.equal(session.threadId, "ses_kimi_code_026");

    await session.close();
  });

  it("consumes the legacy -c prompt value while retaining unrelated base arguments", async () => {
    const session = new KimiPrintSession("kimi", {
      cwd: process.cwd(),
      kimiCliMode: "wire",
      commandLine: [
        process.execPath,
        FAKE_KIMI_CODE,
        "-c", "stale-prompt",
        "--debug",
        "-w", "/tmp/stale-workspace",
      ].join(" "),
      logger: { log: () => {} },
    });

    assert.deepEqual(session.baseArgs, [FAKE_KIMI_CODE, "--debug"]);
    await session.close();
  });

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
    assert.equal(reasoningStatuses.length, 2);
    assert.ok(messageAggregationStatuses.length >= 1);
    assert.ok(messageAggregationStatuses.length <= 2);
    assert.equal(commandStatuses.length, 2);
    assert.equal(turnStartedStatuses[0]?.status_line, "Kimi is working on it");
    assert.equal(reasoningStatuses[0]?.status_line, "Kimi is thinking");
    assert.equal(reasoningStatuses[1]?.status_line, "thought-0");
    assert.equal(messageAggregationStatuses[0]?.status_line, "Kimi is writing the reply");
    assert.equal(commandStatuses[0]?.status_line, "Kimi is running Shell");
    assert.equal(commandStatuses[1]?.status_done_line, "command finished");
    assert.equal(terminalStatus?.status_done_line, "Kimi finished");

    await session.close();
  });

  it("streams think snippets into the reasoning status line with throttling", async () => {
    let fakeNow = 0;
    const statuses = [];
    const transport = new (class extends EventEmitter {
      async boot() {}
      async request(method) {
        if (method === "prompt") {
          this.emit("event", { type: "TurnBegin", payload: {} });
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "think", think: "Design the module. " },
          });
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "think", think: "Suppressed within throttle. " },
          });
          fakeNow += 3000;
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "think", think: "Now write the tests." },
          });
          this.emit("event", { type: "TurnEnd", payload: {} });
          return { status: "finished" };
        }
        return {};
      }
      async close() {}
    })();
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport,
      logger: { log: () => {} },
      now: () => fakeNow,
    });

    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });

    await session.runTurn("go");

    const reasoningLines = statuses
      .filter((payload) => payload.phase === "reasoning")
      .map((payload) => payload.status_line);
    assert.deepEqual(reasoningLines, [
      "Design the module.",
      "Design the module. Suppressed within throttle. Now write the tests.",
    ]);

    await session.close();
  });

  it("streams buffered assistant text at step boundaries", async () => {
    const messages = [];
    const transport = new (class extends EventEmitter {
      async boot() {}
      async request(method) {
        if (method === "prompt") {
          this.emit("event", { type: "TurnBegin", payload: {} });
          this.emit("event", { type: "StepBegin", payload: { n: 1 } });
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "text", text: "Step one done. " },
          });
          this.emit("event", { type: "StepBegin", payload: { n: 2 } });
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "text", text: "Final answer." },
          });
          this.emit("event", { type: "TurnEnd", payload: {} });
          return { status: "finished" };
        }
        return {};
      }
      async close() {}
    })();
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport,
      logger: { log: () => {} },
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload.text);
    });

    const result = await session.runTurn("go");
    assert.equal(result.text, "Step one done. Final answer.");
    assert.deepEqual(messages, ["Step one done. ", "Final answer."]);

    await session.close();
  });

  it("clears reply_in_progress on TurnEnd even when the prompt RPC never resolves", async () => {
    const statuses = [];
    const messages = [];
    // Simulates BUG-R6-01: the wire reports TurnEnd but the `prompt` JSON-RPC
    // response is delayed/dropped, so runTurn stays blocked. The terminal
    // clear must still fire off the TurnEnd wire event.
    const transport = new (class extends EventEmitter {
      async boot() {}
      async request(method) {
        if (method === "prompt") {
          this.emit("event", { type: "TurnBegin", payload: {} });
          this.emit("event", { type: "StepBegin", payload: { n: 1 } });
          this.emit("event", {
            type: "ContentPart",
            payload: { type: "text", text: "Final answer." },
          });
          this.emit("event", { type: "TurnEnd", payload: {} });
          // Never resolves: mimics a dropped/raced prompt RPC response.
          return await new Promise(() => {});
        }
        return {};
      }
      async close() {}
    })();
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      transport,
      logger: { log: () => {} },
    });

    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload.text);
    });

    const turnPromise = session.runTurn("go");
    turnPromise.catch(() => {});

    const deadline = Date.now() + 1_000;
    while (
      !statuses.some((payload) => payload.reply_in_progress === false) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const terminalStatus = statuses.find((payload) => payload.reply_in_progress === false);
    assert.ok(terminalStatus, "terminal status with reply_in_progress=false was emitted on TurnEnd");
    assert.equal(terminalStatus.phase, "turn_completed");
    assert.equal(terminalStatus.status_done_line, "Kimi finished");
    // Buffered assistant text is flushed before the terminal clear.
    assert.deepEqual(messages, ["Final answer."]);

    await session.close();
  });
});
