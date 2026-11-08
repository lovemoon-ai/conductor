import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRuntime } from "../src/runtime/engine.js";
import type { RuntimeState, Conversation, Turn, WorkerNotice } from "../src/runtime/types.js";

const runtimes: ChatRuntime[] = [], directories: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-lifecycle-"));
  directories.push(dir); return dir;
}
async function until(test: () => boolean) {
  for (let i = 0; i < 400; i++) { if (test()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Condition did not become true");
}
function chat(id: string, closed = false): Conversation {
  return { id, provider: "deepseek", accountId: "default", headless: true, url: "https://example.test/chat/" + id, createdAt: new Date().toISOString(), needsReview: false, closed,
    ...(closed ? { closedAt: new Date().toISOString() } : {}) };
}
function turn(id: string, conversationId: string, status: Turn["status"], ageMs = 0): Turn {
  const at = new Date(Date.now() - ageMs).toISOString();
  return { id, conversationId, requestId: id, input: id, timeoutMs: 60_000, status, text: "", createdAt: at,
    events: [{ seq: 1, turnId: id, type: status, at }] };
}
async function seed(dir: string, conversations: Conversation[], turns: Turn[] = []) {
  const state: RuntimeState = { version: 1, conversations: Object.fromEntries(conversations.map(c => [c.id, c])), turns: Object.fromEntries(turns.map(t => [t.id, t])) };
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state), { mode: 0o600 });
}
async function open(dir: string, options: Partial<Parameters<typeof ChatRuntime.open>[0]> = {}) {
  const runtime = await ChatRuntime.open({ directory: dir, workerFactory: config => ({
    async open() { return { ready: true, url: config.conversation.url ?? "https://example.test/chat/restored" }; }, async send(input) { return { text: input }; }, cancel() {}, async close() {},
  }), ...options });
  runtimes.push(runtime); return runtime;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of runtimes.splice(0)) await r.shutdown();
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("runtime retention and durable checkpoints", () => {
  it("frees closed conversations at the 256 cap, including their turns and profiles", async () => {
    const dir = await directory();
    const chats = Array.from({ length: 256 }, (_, i) => chat("chat-" + i));
    await seed(dir, chats, [turn("old-result", chats[0]!.id, "completed")]);
    await fs.mkdir(path.join(dir, "profiles", chats[0]!.id), { recursive: true });
    await fs.writeFile(path.join(dir, "profiles", chats[0]!.id, "data"), "profile");
    const runtime = await open(dir);
    await expect(runtime.create({ provider: "deepseek" })).rejects.toMatchObject({ code: "CAPACITY" });
    await runtime.closeConversation(chats[0]!.id);
    const fresh = await runtime.create({ provider: "deepseek" });
    expect(runtime.list()).toHaveLength(256);
    expect(runtime.get(fresh.id).closed).toBe(false);
    expect(runtime.get(chats[0]!.id).archived).toBe(true);
    expect(() => runtime.getTurn("old-result")).toThrow(/not found/);
    expect(await fs.stat(path.join(dir, "profiles", chats[0]!.id)).catch(() => undefined)).toBeUndefined();
    expect(runtime.get(chats[1]!.id).closed).toBe(false);
  });

  it("keeps only 32 closed chats, expires old ones, and sweeps orphaned profiles after a crash", async () => {
    const dir = await directory();
    const chats = Array.from({ length: 40 }, (_, i) => ({ ...chat("closed-" + i, true), closedAt: new Date(Date.now() - (40 - i) * 1000).toISOString() }));
    chats.push({ ...chat("expired", true), closedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    await seed(dir, chats);
    for (const id of ["closed-0", "closed-39", "expired", "orphan"]) await fs.mkdir(path.join(dir, "profiles", id), { recursive: true });
    const runtime = await open(dir);
    expect(runtime.list()).toHaveLength(32);
    expect(runtime.get("closed-0").archived).toBe(true);
    expect(runtime.get("closed-39").closed).toBe(true);
    for (const id of ["closed-0", "expired", "orphan"]) expect(await fs.stat(path.join(dir, "profiles", id)).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(dir, "profiles", "closed-39"))).toBeDefined();
    await runtime.resume("closed-39");
    expect(runtime.get("closed-39").closed).toBe(false);
    expect(runtime.get("closed-39").closedAt).toBeUndefined();
  });

  it("prunes old completed turns at 4096 while keeping recent results, uncertain turns and deduplication", async () => {
    const dir = await directory();
    const c = chat("active");
    const old = Array.from({ length: 4094 }, (_, i) => turn("old-" + i, c.id, "completed", 3_600_000 + i));
    const reviewChat = { ...chat("review-chat"), needsReview: true };
    await seed(dir, [c, reviewChat], [...old, turn("review", reviewChat.id, "uncertain", 3_600_000), turn("recent", c.id, "completed")]);
    const runtime = await open(dir);
    expect(runtime.getTurn("recent").status).toBe("completed");
    const fresh = await runtime.submit({ conversationId: c.id, requestId: "new", input: "new" });
    await until(() => runtime.getTurn(fresh.id).status === "completed");
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(state.turns).length).toBeLessThan(4096);
    expect(runtime.getTurn("review").status).toBe("uncertain");
    const duplicate = await runtime.submit({ conversationId: c.id, requestId: "recent", input: "recent", timeoutMs: 60_000 });
    expect(duplicate.id).toBe("recent");
    expect(runtime.getTurn(fresh.id).text).toBe("new");
  });

  it("can reclaim historical uncertain turns after the operator acknowledges the chat", async () => {
    const dir = await directory();
    const c = { ...chat("reviewed-history"), needsReview: true };
    await seed(dir, [c], Array.from({ length: 4096 }, (_, i) => turn("uncertain-" + i, c.id, "uncertain", 3_600_000)));
    const runtime = await open(dir);
    expect(runtime.getTurn("uncertain-0").status).toBe("uncertain");
    await runtime.resume(c.id, { acknowledgeUncertain: true });
    const fresh = await runtime.submit({ conversationId: c.id, requestId: "new-after-review", input: "new" });
    await until(() => runtime.getTurn(fresh.id).status === "completed");
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(state.turns).length).toBeLessThan(4096);
    expect(runtime.get(c.id).needsReview).toBe(false);
  });

  it("archives abandoned open chats without losing their stable identity or collecting recent and review-required chats", async () => {
    const dir = await directory();
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const abandoned = Array.from({ length: 256 }, (_, i) => ({ ...chat("abandoned-" + i), createdAt: old, lastActivityAt: old }));
    const recent = { ...chat("recent-open"), createdAt: old, lastActivityAt: new Date().toISOString() };
    const review = { ...chat("review-open"), createdAt: old, lastActivityAt: old, needsReview: true };
    await seed(dir, [...abandoned, recent, review]);
    await fs.mkdir(path.join(dir, "profiles", abandoned[0]!.id), { recursive: true });
    const runtime = await open(dir);
    expect(runtime.list().map(c => c.id).sort()).toEqual(["recent-open", "review-open"]);
    const saved = runtime.get(abandoned[0]!.id);
    expect(saved.archived).toBe(true);
    expect(saved.url).toBe(abandoned[0]!.url);
    expect(await fs.stat(path.join(dir, "profiles", abandoned[0]!.id)).catch(() => undefined)).toBeUndefined();
    await runtime.create({ provider: "deepseek" });
    await runtime.resume(saved.id);
    expect(runtime.get(saved.id).archived).toBeUndefined();
    expect(runtime.get(saved.id).url).toBe(saved.url);
  });

  it.each([false, true])("retains the completed-conversation guard after history and profile GC (closed=%s)", async closed => {
    const dir = await directory();
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const c = { ...chat("no-url", closed), createdAt: old, lastActivityAt: old, closedAt: closed ? old : undefined };
    delete c.url;
    await seed(dir, [c], [turn("completed", c.id, "completed", 8 * 86_400_000)]);
    let opened = 0;
    const runtime = await open(dir, { workerFactory: () => ({
      async open() { opened++; return { ready: true }; }, async send() { return { text: "unexpected" }; }, cancel() {}, async close() {},
    }) });
    expect(runtime.get(c.id).archived).toBe(true);
    expect(runtime.get(c.id).hasCompletedTurn).toBe(true);
    expect(() => runtime.getTurn("completed")).toThrow(/not found/);
    await expect(runtime.resume(c.id)).rejects.toMatchObject({ code: "RESUME_UNSUPPORTED" });
    expect(opened).toBe(0);
  });

  it("orders restoration after an in-flight profile cleanup so the replacement profile survives", async () => {
    const dir = await directory();
    const chats = Array.from({ length: 32 }, (_, i) => ({ ...chat("closed-" + i, true), closedAt: new Date(Date.now() - (32 - i) * 1000).toISOString() }));
    await seed(dir, chats);
    const profile = path.join(dir, "profiles", chats[0]!.id);
    await fs.mkdir(profile, { recursive: true });
    let opened = 0;
    const runtime = await open(dir, { workerFactory: config => ({
      async open() {
        opened++; await fs.mkdir(config.profileDir, { recursive: true });
        await fs.writeFile(path.join(config.profileDir, "restored"), "fresh");
        return { ready: true, url: config.conversation.url };
      }, async send() { return { text: "unused" }; }, cancel() {}, async close() {},
    }) });
    const fresh = await runtime.create({ provider: "deepseek" });
    const originalRm = fs.rm.bind(fs);
    let entered!: () => void, release!: () => void, intercepted = false;
    const deleting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === profile && !intercepted) { intercepted = true; entered(); await gate; }
      return originalRm(target, options);
    });
    const closing = runtime.closeConversation(fresh.id);
    await deleting;
    const restoring = runtime.resume(chats[0]!.id);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(opened).toBe(0);
    } finally { release(); }
    await closing; await restoring;
    expect(opened).toBe(1);
    expect(runtime.get(chats[0]!.id).archived).toBeUndefined();
    expect(await fs.readFile(path.join(profile, "restored"), "utf8")).toBe("fresh");
  });


  it("leaves TTL victims untouched when restoring an archived closed chat is rejected", async () => {
    const dir = await directory();
    const now = Date.now();
    const archived = { ...chat("archived-closed", true), closedAt: new Date(now - 8 * 86_400_000).toISOString() };
    const victim = { ...chat("ttl-victim", true), closedAt: new Date(now - 6 * 86_400_000).toISOString() };
    await seed(dir, [archived, victim]);
    const profile = path.join(dir, "profiles", victim.id);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "data"), "keep");
    const runtime = await open(dir);
    expect(runtime.get(archived.id).archived).toBe(true);
    const checkpoint = await fs.readFile(path.join(dir, "state.json"), "utf8");
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
    await expect(runtime.submit({ conversationId: archived.id, requestId: "rejected", input: "no" })).rejects.toMatchObject({ code: "CHAT_CLOSED" });
    expect(runtime.get(victim.id).archived).toBeUndefined();
    expect(await fs.readFile(path.join(profile, "data"), "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(dir, "state.json"), "utf8")).toBe(checkpoint);
    expect(await fs.stat(path.join(dir, "archive", victim.id + ".json")).catch(() => undefined)).toBeUndefined();
    await runtime.create({ provider: "deepseek" });
    expect(runtime.get(victim.id).archived).toBe(true);
    expect(await fs.stat(profile).catch(() => undefined)).toBeUndefined();
  });

  it("does not delete live profiles when the retention checkpoint fails", async () => {
    const dir = await directory();
    const now = Date.now();
    const victim = { ...chat("checkpoint-victim", true), closedAt: new Date(now - 6 * 86_400_000).toISOString() };
    await seed(dir, [victim]);
    const profile = path.join(dir, "profiles", victim.id);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "data"), "keep");
    const runtime = await open(dir);
    const checkpoint = await fs.readFile(path.join(dir, "state.json"), "utf8");
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === path.join(dir, "state.json") && !failed) {
        failed = true; throw Object.assign(new Error("checkpoint failed"), { code: "EIO" });
      }
      await rename(source, target);
    });
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
    await expect(runtime.create({ provider: "deepseek" })).rejects.toMatchObject({ code: "EIO" });
    expect(runtime.get(victim.id).archived).toBeUndefined();
    expect(await fs.readFile(path.join(profile, "data"), "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(dir, "state.json"), "utf8")).toBe(checkpoint);
    await runtime.create({ provider: "deepseek" });
    expect(runtime.get(victim.id).archived).toBe(true);
    expect(await fs.stat(profile).catch(() => undefined)).toBeUndefined();
  });

  it("protects closed chats and uncertain history until review is acknowledged", async () => {
    const dir = await directory();
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const review = { ...chat("closed-review", true), closedAt: old, needsReview: true };
    await seed(dir, [review, ...Array.from({ length: 40 }, (_, i) => chat("ordinary-" + i, true))],
      [turn("uncertain-review", review.id, "uncertain", 8 * 86_400_000)]);
    const profile = path.join(dir, "profiles", review.id);
    await fs.mkdir(profile, { recursive: true });
    let runtime = await open(dir);
    expect(runtime.list()).toHaveLength(33);
    expect(runtime.get(review.id).archived).toBeUndefined();
    expect(runtime.getTurn("uncertain-review").status).toBe("uncertain");
    expect(await fs.stat(profile)).toBeDefined();
    await runtime.shutdown();
    runtime = await open(dir);
    await runtime.closeConversation(review.id);
    expect(runtime.getTurn("uncertain-review").status).toBe("uncertain");
    await runtime.resume(review.id, { acknowledgeUncertain: true });
    await runtime.closeConversation(review.id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86_400_000);
    await runtime.create({ provider: "deepseek" });
    expect(runtime.get(review.id).archived).toBe(true);
    expect(() => runtime.getTurn("uncertain-review")).toThrow(/not found/);
    expect(await fs.stat(profile).catch(() => undefined)).toBeUndefined();
  });

  it("counts an accepted prompt as activity before collecting workerless idle chats", async () => {
    const dir = await directory();
    const c = chat("idle-submit");
    await seed(dir, [c]);
    const runtime = await open(dir);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    try {
      const fresh = await runtime.submit({ conversationId: c.id, requestId: "after-idle", input: "continue" });
      await until(() => runtime.getTurn(fresh.id).status === "completed");
      expect(runtime.get(c.id).archived).toBeUndefined();
      expect(runtime.getTurn(fresh.id).text).toBe("continue");
      expect(runtime.get(c.id).lastActivityAt).toBe(new Date().toISOString());
    } finally { vi.useRealTimers(); }
  });


  it("returns CHAT_CLOSED instead of pinning a removed worker when close races a headed resume", async () => {
    const dir = await directory();
    let entered!: () => void, release!: () => void;
    const opening = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtime = await open(dir, { workerFactory: () => ({
      async open() { entered(); await gate; return { ready: true, url: "https://example.test/chat/original" }; },
      async send(input) { return { text: input }; }, cancel() {}, async close() {},
    }) });
    const c = await runtime.create({ provider: "deepseek" });
    const resuming = expect(runtime.resume(c.id, { headed: true })).rejects.toMatchObject({ code: "CHAT_CLOSED" });
    try {
      await opening;
      await runtime.closeConversation(c.id);
    } finally { release(); }
    await resuming;
    expect(runtime.get(c.id).closed).toBe(true);
    expect(runtime.status()).toMatchObject({ workers: 0, pinnedChats: [] });
    await expect(runtime.resume(c.id, { headed: true })).resolves.toMatchObject({ ready: true, closed: false });
    expect(runtime.status().pinnedChats).toEqual([c.id]);
  });

  it("streams hundreds of deltas without rewriting the checkpoint, then durably commits the complete event history", async () => {
    const dir = await directory();
    let notify!: (notice: WorkerNotice) => void;
    let complete!: (result: { text: string }) => void;
    const runtime = await open(dir, { workerFactory: () => ({
      async open() { return { ready: true }; },
      async send(_input, _timeout, emit) {
        notify = emit; emit({ type: "submitting" }); emit({ type: "progress", text: "a" });
        return new Promise(resolve => { complete = resolve; });
      },
      cancel() {}, async close() {},
    }) });
    const c = await runtime.create({ provider: "deepseek" });
    const t = await runtime.submit({ conversationId: c.id, requestId: "stream", input: "stream" });
    await until(() => runtime.getTurn(t.id).status === "streaming");
    const file = path.join(dir, "state.json");
    const checkpoint = await fs.readFile(file, "utf8");
    const events: number[] = [];
    runtime.subscribe(t.id, e => events.push(e.seq));
    for (let i = 2; i <= 300; i++) notify({ type: "progress", text: "a".repeat(i) });
    await until(() => runtime.getTurn(t.id).text.length === 300);
    expect(await fs.readFile(file, "utf8")).toBe(checkpoint);
    expect(events).toHaveLength(299);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    // An unclean copy recovers the durable streaming checkpoint as uncertain,
    // rather than replaying or pretending the volatile tail was committed.
    const recoveredDir = await directory();
    await fs.copyFile(file, path.join(recoveredDir, "state.json"));
    const recovered = await open(recoveredDir);
    expect(recovered.getTurn(t.id).status).toBe("uncertain");
    expect(recovered.getTurn(t.id).text).toBe("a");
    complete({ text: "a".repeat(300) });
    await until(() => runtime.getTurn(t.id).status === "completed");
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.turns[t.id].text).toHaveLength(300);
    expect(persisted.turns[t.id].events.at(-1).type).toBe("completed");
    expect(persisted.turns[t.id].events.filter((e: { type: string }) => e.type === "message_delta")).toHaveLength(300);
  });

  it("expires stale queued prompts on crash recovery but runs recent queued work once", async () => {
    const dir = await directory();
    const expired = chat("expired-chat"), fresh = chat("fresh-chat"), active = chat("interrupted-chat");
    await seed(dir, [expired, fresh, active], [
      turn("expired", expired.id, "queued", 120_000),
      turn("fresh", fresh.id, "queued"),
      turn("interrupted", active.id, "submitting"),
    ]);
    const sent: string[] = [];
    const runtime = await open(dir, { workerFactory: () => ({
      async open() { return { ready: true }; }, async send(input) { sent.push(input); return { text: input }; }, cancel() {}, async close() {},
    }) });
    await until(() => runtime.getTurn("fresh").status === "completed");
    expect(sent).toEqual(["fresh"]);
    expect(runtime.getTurn("expired")).toMatchObject({ status: "cancelled", errorCode: "QUEUE_EXPIRED" });
    expect(runtime.get(expired.id).needsReview).toBe(false);
    expect(runtime.getTurn("interrupted").status).toBe("uncertain");
    expect(runtime.get(active.id).needsReview).toBe(true);
    expect((await runtime.submit({ conversationId: expired.id, requestId: "expired", input: "expired", timeoutMs: 60_000 })).id).toBe("expired");
  });

  it("also expires a queued prompt before sending when a live worker finally becomes available", async () => {
    const dir = await directory();
    let release!: (result: { text: string }) => void;
    const sent: string[] = [];
    const runtime = await open(dir, { maxWorkers: 1, workerFactory: () => ({
      async open() { return { ready: true, url: "https://example.test/chat/restored" }; },
      async send(input) { sent.push(input); return new Promise(resolve => { release = resolve; }); },
      cancel() {}, async close() {},
    }) });
    const a = await runtime.create({ provider: "deepseek" }), b = await runtime.create({ provider: "deepseek" });
    const first = await runtime.submit({ conversationId: a.id, requestId: "held", input: "held" });
    await until(() => sent.length === 1);
    const queued = await runtime.submit({ conversationId: b.id, requestId: "expired", input: "expired", timeoutMs: 100 });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1000);
    release({ text: "done" });
    await until(() => runtime.getTurn(first.id).status === "completed" && runtime.getTurn(queued.id).status === "cancelled");
    expect(runtime.getTurn(queued.id).errorCode).toBe("QUEUE_EXPIRED");
    expect(sent).toEqual(["held"]);
  });
});
