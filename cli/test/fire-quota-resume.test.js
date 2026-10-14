import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BridgeRunner } from "../bin/conductor-fire.js";
import {
  QUOTA_RESUME_PROMPT,
  buildQuotaResumePrompt,
  computeQuotaResumeAt,
  createQuotaResumeScheduler,
  mergeQueuedMessages,
  parseQuotaLimitError,
  parseQuotaResumePrompt,
} from "../src/fire/quota-resume.js";

const QUOTA_ERROR = "You've hit your session limit · resets 1:20am (Asia/Shanghai)";

describe("parseQuotaLimitError", () => {
  // 2026-10-04 23:30 in Asia/Shanghai
  const now = new Date("2026-10-04T15:30:00.000Z");

  it("reads a time-only reset in the named zone", () => {
    const quota = parseQuotaLimitError(QUOTA_ERROR, { now });
    assert.equal(quota.resetAt.toISOString(), "2026-10-04T17:20:00.000Z");
  });

  it("rolls a reset time already behind us over to the next day", () => {
    const quota = parseQuotaLimitError("You've hit your limit · resets 11pm (Asia/Shanghai)", { now });
    assert.equal(quota.resetAt.toISOString(), "2026-10-05T15:00:00.000Z");
  });

  it("reads a dated reset", () => {
    const quota = parseQuotaLimitError("You've hit your weekly limit · resets Oct 7, 2am (Asia/Shanghai)", { now });
    assert.equal(quota.resetAt.toISOString(), "2026-10-06T18:00:00.000Z");
  });

  it("reads an epoch reset and a relative retry", () => {
    assert.equal(
      parseQuotaLimitError("Claude AI usage limit reached|1791183600", { now }).resetAt.toISOString(),
      "2026-10-05T07:00:00.000Z",
    );
    assert.equal(
      parseQuotaLimitError("You've hit your usage limit. Try again in 2 hours 13 minutes.", { now }).resetAt.toISOString(),
      "2026-10-04T17:43:00.000Z",
    );
  });

  it("recognises a quota error without a reset time", () => {
    assert.deepEqual(parseQuotaLimitError("You've hit your session limit", { now }), { resetAt: null });
  });

  it("ignores other errors", () => {
    assert.equal(parseQuotaLimitError("Prompt is too long", { now }), null);
    assert.equal(parseQuotaLimitError("tui process has exited", { now }), null);
  });
});

describe("computeQuotaResumeAt", () => {
  const now = new Date("2026-10-04T15:30:00.000Z");

  it("resumes one minute after the reset plus jitter", () => {
    const resetAt = new Date("2026-10-04T17:20:00.000Z");
    assert.equal(computeQuotaResumeAt(resetAt, { now, random: () => 0 }).toISOString(), "2026-10-04T17:21:00.000Z");
    assert.equal(computeQuotaResumeAt(resetAt, { now, random: () => 1 }).toISOString(), "2026-10-04T17:25:00.000Z");
  });

  it("falls back to an hour when the reset is unknown, and never schedules in the past", () => {
    assert.equal(computeQuotaResumeAt(null, { now, random: () => 0 }).toISOString(), "2026-10-04T16:31:00.000Z");
    assert.equal(
      computeQuotaResumeAt(new Date("2026-10-01T00:00:00.000Z"), { now, random: () => 0 }).toISOString(),
      "2026-10-04T15:31:00.000Z",
    );
  });
});

describe("createQuotaResumeScheduler", () => {
  it("is unavailable without a backend url and token", () => {
    assert.equal(createQuotaResumeScheduler({ env: {}, fetchImpl: async () => ({}) }), null);
  });

  it("creates a quota_resume schedule without the agent actor header", async () => {
    const requests = [];
    const scheduler = createQuotaResumeScheduler({
      env: { CONDUCTOR_BACKEND_URL: "https://conductor.test/", CONDUCTOR_AGENT_TOKEN: "tok" },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 201, json: async () => ({ id: "sched-1" }) };
      },
    });
    const created = await scheduler.schedule({
      taskId: "task-1",
      sendAt: new Date("2026-10-04T17:21:00.000Z"),
      content: "resume",
    });
    assert.deepEqual(created, { id: "sched-1" });
    assert.equal(requests[0].url, "https://conductor.test/api/tasks/task-1/scheduled-messages");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.Authorization, "Bearer tok");
    assert.equal(requests[0].init.headers["X-Conductor-Actor"], undefined);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      content: "resume",
      source: "quota_resume",
      schedule: { mode: "at", sendAt: "2026-10-04T17:21:00.000Z" },
    });
  });
});

function createHarness({
  turnErrors = [],
  scheduler = undefined,
  startAt = "2026-10-04T15:30:00.000Z",
  leftoverSchedules = [],
  extra = {},
} = {}) {
  const clock = { now: new Date(startAt) };
  const turns = [];
  const sentMessages = [];
  const runtimeStatuses = [];
  const schedulerCalls = { schedule: [], update: [], cancel: [] };
  const fakeScheduler =
    scheduler === undefined
      ? {
          schedule: async (input) => {
            schedulerCalls.schedule.push(input);
            return { id: `sched-${schedulerCalls.schedule.length}` };
          },
          update: async (input) => {
            schedulerCalls.update.push(input);
          },
          cancel: async (input) => {
            schedulerCalls.cancel.push(input);
          },
          listActive: async () => leftoverSchedules,
        }
      : scheduler;
  const runner = new BridgeRunner({
    backendSession: {
      runTurn: async (content) => {
        turns.push(content);
        const error = turnErrors.shift();
        if (error) {
          throw new Error(error);
        }
        return { text: "done", items: [], usage: null };
      },
      threadId: "thread-1",
      threadOptions: { model: "claude" },
    },
    conductor: {
      receiveMessages: async () => ({ messages: [] }),
      ackMessages: async () => ({}),
      sendRuntimeStatus: async (taskId, payload) => {
        runtimeStatuses.push(payload);
        return {};
      },
      sendMessage: async (taskId, content, metadata) => {
        sentMessages.push({ content, metadata });
        return { message_id: `reply-${sentMessages.length}` };
      },
    },
    taskId: "task-1",
    pollIntervalMs: 10,
    initialPrompt: "",
    includeInitialImages: false,
    cliArgs: [],
    backendName: "claude",
    quotaResumeScheduler: fakeScheduler,
    now: () => clock.now,
    random: () => 0,
    ...extra,
  });
  return { runner, clock, turns, sentMessages, runtimeStatuses, schedulerCalls };
}

describe("BridgeRunner quota wait", () => {
  it("schedules one resume, queues messages while waiting, and resumes with all of them", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR] });

    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });
    assert.equal(h.turns.length, 1);
    assert.equal(h.schedulerCalls.schedule.length, 1);
    assert.equal(h.schedulerCalls.schedule[0].sendAt.toISOString(), "2026-10-04T17:21:00.000Z");
    assert.match(h.schedulerCalls.schedule[0].content, /do X/);
    assert.equal(h.sentMessages.length, 1);
    assert.match(h.sentMessages[0].content, /额度已用完/);
    assert.equal(h.sentMessages.some((m) => m.content.includes("处理失败")), false);
    assert.equal(h.runtimeStatuses.at(-1).phase, "quota_wait");

    // Before the reset: queued, no turn, no extra chat message.
    h.clock.now = new Date("2026-10-04T16:00:00.000Z");
    await h.runner.respondToMessage({ message_id: "msg-2", role: "user", content: "also Y" });
    await h.runner.respondToMessage({ message_id: "msg-3", role: "user", content: "and Z" });
    assert.equal(h.turns.length, 1);
    assert.equal(h.sentMessages.length, 1);
    assert.equal(h.schedulerCalls.update.length, 2);
    assert.match(h.schedulerCalls.update[1].content, /do X[\s\S]*also Y[\s\S]*and Z/);

    // The scheduled resume arrives.
    h.clock.now = new Date("2026-10-04T17:21:00.000Z");
    await h.runner.respondToMessage({
      message_id: "msg-sched",
      role: "user",
      content: h.schedulerCalls.update[1].content,
      metadata: { scheduledMessageId: "sched-1" },
    });
    assert.equal(h.turns.length, 2);
    assert.ok(h.turns[1].startsWith(QUOTA_RESUME_PROMPT));
    assert.match(h.turns[1], /do X[\s\S]*also Y[\s\S]*and Z/);
    assert.equal(h.runner.quotaWait, null);
    assert.equal(h.schedulerCalls.cancel.length, 0);
    assert.equal(h.runner.quotaResumeAttempts, 0);
  });

  it("ends the wait early on a message after the reset and cancels the schedule", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR] });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });

    h.clock.now = new Date("2026-10-04T17:20:30.000Z");
    await h.runner.respondToMessage({ message_id: "msg-2", role: "user", content: "status?" });
    assert.equal(h.turns.length, 2);
    assert.match(h.turns[1], /do X[\s\S]*status\?/);
    assert.deepEqual(h.schedulerCalls.cancel, [{ taskId: "task-1", scheduleId: "sched-1" }]);
  });

  it("re-schedules when the resume hits the quota again, then gives up after the cap", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR, QUOTA_ERROR, QUOTA_ERROR, QUOTA_ERROR] });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      h.clock.now = new Date(h.runner.quotaWait.sendAt.getTime());
      await h.runner.respondToMessage({
        message_id: `msg-sched-${attempt}`,
        role: "user",
        content: QUOTA_RESUME_PROMPT,
        metadata: { scheduledMessageId: `sched-${attempt}` },
      });
      // The original message is never dropped from the resume prompt.
      assert.match(h.turns.at(-1), /do X/);
      if (attempt < 3) {
        assert.equal(h.schedulerCalls.schedule.length, attempt + 1);
        assert.match(h.schedulerCalls.schedule.at(-1).content, /do X/);
      }
    }
    assert.equal(h.schedulerCalls.schedule.length, 3);
    assert.equal(h.runner.quotaWait, null);
    assert.equal(h.sentMessages.filter((m) => m.content.includes("处理失败")).length, 1);
  });

  it("falls back to fire's own clock when the schedule cannot be created", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR], scheduler: null });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });
    assert.match(h.sentMessages[0].content, /本进程计时/);

    await h.runner.runLocalQuotaResumeIfDue();
    assert.equal(h.turns.length, 1);

    h.clock.now = new Date("2026-10-04T17:21:00.000Z");
    await h.runner.runLocalQuotaResumeIfDue();
    assert.equal(h.turns.length, 2);
    assert.match(h.turns[1], /do X/);
    assert.equal(h.runner.quotaWait, null);
  });

  it("reports other errors as before", async () => {
    const h = createHarness({ turnErrors: ["something else broke"] });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });
    assert.equal(h.schedulerCalls.schedule.length, 0);
    assert.equal(h.runner.quotaWait, null);
    assert.ok(h.sentMessages.some((m) => m.content.includes("处理失败: something else broke")));
  });
});

describe("buildQuotaResumePrompt", () => {
  it("lists pending messages in order", () => {
    const prompt = buildQuotaResumePrompt([{ content: "a" }, { content: " " }, { content: "b" }]);
    assert.ok(prompt.startsWith(QUOTA_RESUME_PROMPT));
    assert.match(prompt, /以下 2 条消息[\s\S]*消息 1 ---\na[\s\S]*消息 2 ---\nb/);
  });
});

describe("BridgeRunner quota wait: restarts, start-up prompts, background turns", () => {
  it("keeps the queued messages when a resume fails again after a fire restart", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR] });
    // This fire never saw the earlier wait; the resume text is all it has.
    const resume = buildQuotaResumePrompt([{ content: "do X" }, { content: "also Y" }]);
    await h.runner.respondToMessage({ message_id: "msg-sched", role: "user", content: resume });

    assert.equal(h.schedulerCalls.schedule.length, 1);
    assert.match(h.schedulerCalls.schedule[0].content, /do X[\s\S]*also Y/);
    assert.equal((h.schedulerCalls.schedule[0].content.match(/还没有处理/g) || []).length, 1);
  });

  it("carries over the resume schedule an earlier fire left behind", async () => {
    const h = createHarness({
      turnErrors: [QUOTA_ERROR],
      leftoverSchedules: [{ id: "old", source: "quota_resume", content: buildQuotaResumePrompt([{ content: "older A" }]) }],
    });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "new B" });

    assert.match(h.schedulerCalls.schedule[0].content, /older A[\s\S]*new B/);
    assert.deepEqual(h.runner.quotaWait.queued.map((item) => item.content), ["older A", "new B"]);
  });

  it("queues the initial prompt when the pre-prompt already hit the quota", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR, QUOTA_ERROR] });
    await h.runner.handlePrePromptMessage("PRE");
    await h.runner.handleSyntheticMessage("INIT", { includeImages: false });

    assert.equal(h.turns.length, 1);
    assert.equal(h.schedulerCalls.schedule.length, 1);
    assert.equal(h.runner.quotaResumeAttempts, 1);
    assert.deepEqual(h.runner.quotaWait.queued.map((item) => item.content), ["PRE", "INIT"]);
    assert.match(h.schedulerCalls.update.at(-1).content, /PRE[\s\S]*INIT/);
  });

  it("parks the task when a background turn hits the quota, once", async () => {
    const h = createHarness();
    const status = { background: true, phase: "turn_failed", status_done_line: QUOTA_ERROR, reply_in_progress: false };
    await h.runner.handleContinuousWorkingStatus(status);
    // The process exit that follows reports the same failure again.
    await h.runner.handleContinuousWorkingStatus({ ...status, status_done_line: `Claude Code returned an error result: ${QUOTA_ERROR}` });

    assert.equal(h.turns.length, 0);
    assert.equal(h.schedulerCalls.schedule.length, 1);
    assert.equal(h.schedulerCalls.schedule[0].content, QUOTA_RESUME_PROMPT);
    assert.equal(h.sentMessages.filter((m) => /额度已用完/.test(m.content)).length, 1);
    assert.ok(h.runner.quotaWait);
  });

  it("ignores background failures that are not quota errors, and user-turn statuses", async () => {
    const h = createHarness();
    await h.runner.handleContinuousWorkingStatus({ background: true, phase: "turn_failed", status_done_line: "boom" });
    await h.runner.handleContinuousWorkingStatus({ phase: "turn_failed", status_done_line: QUOTA_ERROR });
    assert.equal(h.schedulerCalls.schedule.length, 0);
    assert.equal(h.runner.quotaWait, null);
    assert.equal(h.runtimeStatuses.length, 2);
  });

  it("does not cancel the schedule once its send time has come", async () => {
    const h = createHarness({ turnErrors: [QUOTA_ERROR] });
    await h.runner.respondToMessage({ message_id: "msg-1", role: "user", content: "do X" });

    // The resume arrives with text a person edited, so fire cannot tell it apart.
    h.clock.now = new Date("2026-10-04T17:21:00.000Z");
    await h.runner.respondToMessage({ message_id: "msg-edited", role: "user", content: "继续" });
    assert.equal(h.turns.length, 2);
    assert.equal(h.schedulerCalls.cancel.length, 0);
  });
});

describe("quota resume helpers", () => {
  it("reads the pending messages back out of a resume prompt", () => {
    const items = [{ content: "first\nline two" }, { content: "second" }];
    assert.deepEqual(
      parseQuotaResumePrompt(buildQuotaResumePrompt(items)).map((item) => item.content),
      ["first\nline two", "second"],
    );
    assert.deepEqual(parseQuotaResumePrompt(QUOTA_RESUME_PROMPT), []);
    assert.deepEqual(parseQuotaResumePrompt("hello"), []);
  });

  it("merges pending lists without repeats", () => {
    assert.deepEqual(
      mergeQueuedMessages([{ content: "a" }, { content: "b" }], [{ content: "b" }, { content: "c" }]).map((i) => i.content),
      ["a", "b", "c"],
    );
  });

  it("cancels with cancel_only and treats an already-sent schedule as done", async () => {
    const requests = [];
    const scheduler = createQuotaResumeScheduler({
      env: { CONDUCTOR_BACKEND_URL: "https://conductor.test", CONDUCTOR_AGENT_TOKEN: "tok" },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: false, status: 409, json: async () => ({}) };
      },
    });
    await scheduler.cancel({ taskId: "task-1", scheduleId: "sched-1" });
    assert.equal(requests[0].url, "https://conductor.test/api/tasks/task-1/scheduled-messages/sched-1?cancel_only=1");
    assert.equal(requests[0].init.method, "DELETE");
  });

  it("lists only quota_resume schedules, by source or, on older servers, by text", async () => {
    const scheduler = createQuotaResumeScheduler({
      env: { CONDUCTOR_BACKEND_URL: "https://conductor.test", CONDUCTOR_AGENT_TOKEN: "tok" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          schedules: [
            { id: "a", source: "quota_resume", content: QUOTA_RESUME_PROMPT },
            { id: "b", source: "message_bubble", content: "ping" },
            { id: "c", content: QUOTA_RESUME_PROMPT },
            { id: "d", content: "ping" },
          ],
        }),
      }),
    });
    assert.deepEqual((await scheduler.listActive({ taskId: "task-1" })).map((row) => row.id), ["a", "c"]);
  });
});
