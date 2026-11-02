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
  const runtime = await ChatRuntime.open({ directory: dir, workerFactory: () => ({
    async open() { return { ready: true, url: "https://example.test/chat/restored" }; }, async send(input) { return { text: input }; }, cancel() {}, async close() {},
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
    expect(() => runtime.get(chats[0]!.id)).toThrow(/not found/);
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
