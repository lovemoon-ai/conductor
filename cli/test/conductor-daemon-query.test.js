import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { main } from "../bin/conductor-daemon-query.js";
import { FakeBackendApi, makeCliDeps } from "./helpers/fake-backend.js";
import { BackendApiError } from "../../modules/conductor-sdk/dist/index.js";

function makeStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  stream.collect = () => chunks.join("");
  return stream;
}

async function run(args, backend) {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await main(args, { stdout, stderr, ...makeCliDeps(backend) });
  return { code, out: stdout.collect(), err: stderr.collect() };
}

const agents = [
  { host: "macmini", version: "0.13.1", supportedBackends: ["claude", "kimi"], shared: false },
  { host: "conductor-fire-macmini-abc", version: "0.13.1", supportedBackends: ["claude"], shared: false },
  { host: "l20", version: "0.12.0", supportedBackends: ["codex"], shared: true, ownerLabel: "alice" },
];

describe("conductor daemon list", () => {
  it("lists daemons and hides ephemeral fire hosts by default", async () => {
    const { code, out, err } = await run(["list"], new FakeBackendApi({ agents }));
    assert.equal(code, 0, err);
    const lines = out.trim().split("\n");
    assert.match(lines[0], /^HOST\s+VERSION\s+BACKENDS$/);
    assert.match(lines[1], /^macmini\s+0\.13\.1\s+claude,kimi$/);
    assert.match(lines[2], /^l20 \(shared by alice\)\s+0\.12\.0\s+codex$/);
    assert.equal(out.includes("conductor-fire-"), false);
  });

  it("--all --json includes fire hosts", async () => {
    const { code, out } = await run(["list", "--all", "--json"], new FakeBackendApi({ agents }));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out).map((a) => a.host), agents.map((a) => a.host));
  });
});

describe("conductor daemon tools", () => {
  it("shows install and network status per AI tool", async () => {
    const backend = new FakeBackendApi({
      aiManagerStatus: {
        install: {
          claude: { installed: true, version: "2.1.270" },
          copilot: { installed: false },
        },
        network: {
          claude: { reachable: true, latencyMs: 88, endpoint: "https://api.anthropic.com" },
          copilot: { reachable: false, endpoint: "", error: "not installed" },
        },
      },
    });
    const { code, out, err } = await run(["tools", "macmini"], backend);
    assert.equal(code, 0, err);
    assert.deepEqual(backend.calls.at(-1), { method: "getAiManagerStatus", agentHost: "macmini" });
    const lines = out.trim().split("\n");
    assert.match(lines[0], /^TOOL\s+INSTALLED\s+VERSION\s+NETWORK$/);
    assert.match(lines[1], /^claude\s+yes\s+2\.1\.270\s+ok \(88ms\)$/);
    assert.match(lines[2], /^copilot\s+no\s*$/);
  });

  it("surfaces an offline daemon as not found", async () => {
    const backend = new FakeBackendApi();
    backend.getAiManagerStatus = async () => {
      throw new BackendApiError("Backend responded with 404", 404, { error: "daemon not connected for this user" });
    };
    const { code, err } = await run(["tools", "gone"], backend);
    assert.equal(code, 4);
    assert.match(err, /daemon not connected/);
  });
});

describe("conductor daemon argument errors", () => {
  for (const verb of ["tools", "quota"]) {
    it(`${verb} without <host> exits 2 without calling the backend`, async () => {
      const backend = new FakeBackendApi();
      const { code, err } = await run([verb], backend);
      assert.equal(code, 2);
      assert.match(err, /Not enough non-option arguments/);
      assert.deepEqual(backend.calls, []);
    });
  }
});

describe("conductor daemon quota", () => {
  it("summarizes usage windows, balances and errors per tool", async () => {
    const backend = new FakeBackendApi({
      aiManagerQuota: {
        claude: {
          tool: "claude",
          source: "fresh",
          fiveHour: { usedPercent: 41, remainingPercent: 59 },
          weekly: { usedPercent: 70.4, remainingPercent: 29.6 },
          overage: { status: "rejected", disabledReason: "out_of_credits" },
        },
        dsh: {
          tool: "dsh",
          source: "cached",
          primaryBalance: { currency: "CNY", totalBalance: 23.5 },
        },
        kimi: { tool: "kimi", source: "unknown", error: "token expired" },
        external: {
          "codex-sol": { backend: "codex-sol", source: "fresh", daily: { usedPercent: 5, remainingPercent: 95 } },
        },
      },
    });
    const { code, out, err } = await run(["quota", "macmini", "--tool", "claude", "--refresh"], backend);
    assert.equal(code, 0, err);
    assert.deepEqual(backend.calls.at(-1), {
      method: "getAiManagerQuota",
      agentHost: "macmini",
      params: { tool: "claude", forceRefresh: true },
    });
    const lines = out.trim().split("\n");
    assert.match(lines[0], /^TOOL\s+SOURCE\s+QUOTA$/);
    assert.match(lines[1], /^claude\s+fresh\s+5h 41% used · weekly 70% used · overage rejected \(out_of_credits\)$/);
    assert.match(lines[2], /^dsh\s+cached\s+balance 23\.5 CNY$/);
    assert.match(lines[3], /^kimi\s+unknown\s+error: token expired$/);
    assert.match(lines[4], /^codex-sol\s+fresh\s+daily 5% used$/);
  });
});
