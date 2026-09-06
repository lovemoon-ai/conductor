import test from "node:test";
import assert from "node:assert/strict";

import {
  ConductorConfig,
} from "@love-moon/conductor-sdk";
import {
  parseArgs,
  parseTimeoutMs,
  runRemoteExec,
} from "../src/remote/exec.js";
import { runRemote } from "../bin/conductor-remote.js";

const config = new ConductorConfig({
  agentToken: "test-token",
  backendUrl: "http://localhost:6152",
});

function makeConsole() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  };
}

function makeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) {
        throw new Error(`unexpected extra fetch: ${url}`);
      }
      return {
        ok: next.status === undefined || next.status < 400,
        status: next.status ?? 200,
        text: async () => JSON.stringify(next.body ?? {}),
      };
    },
  };
}

const completedRun = (overrides = {}) => ({
  runId: "run-1",
  status: "completed",
  exitCode: 0,
  stdoutTail: "marker.txt\n",
  stderrTail: "",
  truncated: false,
  error: null,
  ...overrides,
});

test("parseArgs accepts a trailing command without a -- separator", () => {
  const { options, command } = parseArgs([
    "--target",
    "ubuntu",
    "--workspace",
    "/home/duino/ws/holomotion",
    "ls",
    ".",
  ]);

  assert.equal(options.target, "ubuntu");
  assert.equal(options.workspace, "/home/duino/ws/holomotion");
  assert.deepEqual(command, ["ls", "."]);
});

test("parseArgs keeps flags after -- as part of the remote command", () => {
  const { options, command } = parseArgs([
    "-t",
    "ubuntu",
    "--",
    "git",
    "log",
    "--oneline",
    "-5",
  ]);

  assert.equal(options.target, "ubuntu");
  assert.deepEqual(command, ["git", "log", "--oneline", "-5"]);
});

test("parseArgs does not swallow command flags that look like conductor flags", () => {
  const { command } = parseArgs(["-t", "ubuntu", "ls", "--json"]);
  assert.deepEqual(command, ["ls", "--json"]);
});

test("parseArgs supports --flag=value, repeated --env and boolean flags", () => {
  const { options, command } = parseArgs([
    "--target=ubuntu",
    "--json",
    "-e",
    "FOO=1",
    "--env",
    "BAR=two=three",
    "echo",
    "hi",
  ]);

  assert.equal(options.target, "ubuntu");
  assert.equal(options.json, true);
  assert.deepEqual(options.env, { FOO: "1", BAR: "two=three" });
  assert.deepEqual(command, ["echo", "hi"]);
});

test("parseArgs rejects a value flag with no value and a malformed --env", () => {
  assert.throws(() => parseArgs(["--target"]), /--target requires a value/);
  assert.throws(() => parseArgs(["--env", "NOPE", "ls"]), /--env expects KEY=VALUE/);
});

test("parseTimeoutMs understands bare seconds and duration suffixes", () => {
  assert.equal(parseTimeoutMs(undefined), 60_000);
  assert.equal(parseTimeoutMs("45"), 45_000);
  assert.equal(parseTimeoutMs("500ms"), 500);
  assert.equal(parseTimeoutMs("2m"), 120_000);
  assert.throws(() => parseTimeoutMs("soon"), /invalid --timeout/);
});

test("runRemoteExec posts argv to the target daemon and returns its exit code", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([{ body: completedRun({ exitCode: 0 }) }]);

  const code = await runRemoteExec(
    ["--target", "ubuntu", "--workspace", "/home/duino/ws/holomotion", "ls", "."],
    { console: consoleImpl, fetch, config },
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:6152/api/agents/ubuntu/exec");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command: "ls",
    args: ["."],
    workspace: "/home/duino/ws/holomotion",
    // Capped, NOT the full --timeout: see the regression test below.
    timeoutMs: 10_000,
  });
});

// Regression: the POST used to be handed the whole `--timeout`, so a single
// request blocked for the entire deadline and `now() < deadline` was already
// false by the time the poll loop was reached — the polling path (and the
// `runs/[runId]` route with it) was dead code at every realistic timeout.
test("runRemoteExec caps the blocking POST wait so the poll loop stays reachable", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { runId: "run-2", status: "running", exitCode: null, stdoutTail: "" } },
    { body: completedRun({ runId: "run-2", stdoutTail: "polled\n" }) },
  ]);
  let clock = 0;

  const code = await runRemoteExec(["-t", "ubuntu", "--timeout", "5m", "sleep", "60"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
    now: () => (clock += 1_000),
  });

  const posted = JSON.parse(calls[0].init.body);
  assert.equal(posted.timeoutMs, 10_000, "POST wait must stay capped even with --timeout 5m");
  assert.ok(posted.timeoutMs < 300_000, "POST must not consume the whole deadline");
  assert.equal(calls.length, 2, "the poll loop must actually run");
  assert.equal(code, 0);
});

// Regression: a single failed status poll used to throw out of the loop and
// abort a long run that was still perfectly healthy.
test("runRemoteExec survives a transient status-poll failure and keeps waiting", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { runId: "run-3", status: "running", exitCode: null, stdoutTail: "" } },
    { status: 504, body: { error: "daemon did not respond within 10000ms" } },
    { body: completedRun({ runId: "run-3", stdoutTail: "recovered\n" }) },
  ]);
  let clock = 0;

  const code = await runRemoteExec(["-t", "ubuntu", "--timeout", "2m", "./build.sh"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
    now: () => (clock += 1_000),
  });

  assert.equal(calls.length, 3, "must retry after the failed poll instead of aborting");
  assert.equal(code, 0);
});

test("runRemoteExec stops polling when the daemon reports running without a runId", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { status: "running", exitCode: null, stdoutTail: "" } },
  ]);

  const code = await runRemoteExec(["-t", "ubuntu", "--timeout", "2m", "ls"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
  });

  assert.equal(calls.length, 1, "must not GET /runs/undefined");
  assert.equal(code, 255, "CLI-level failures use ssh's 255");
  assert.match(consoleImpl.errors.join("\n"), /no runId/);
});

test("runRemoteExec propagates a non-zero remote exit code", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([
    { body: completedRun({ status: "failed", exitCode: 3, stdoutTail: "" }) },
  ]);

  const code = await runRemoteExec(["-t", "ubuntu", "false"], {
    console: consoleImpl,
    fetch,
    config,
  });

  assert.equal(code, 3);
});

test("runRemoteExec polls the run endpoint while the command is still running", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { runId: "run-9", status: "running", exitCode: null, stdoutTail: "" } },
    { body: completedRun({ runId: "run-9", exitCode: 0, stdoutTail: "done\n" }) },
  ]);

  const code = await runRemoteExec(["-t", "ubuntu", "sleep", "1"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "http://localhost:6152/api/agents/ubuntu/exec/runs/run-9");
  assert.equal(calls[1].init.method, "GET");
});

test("runRemoteExec stops polling once the deadline passes and reports the run id", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([
    { body: { runId: "run-slow", status: "running", exitCode: null, stdoutTail: "" } },
  ]);
  let clock = 0;

  const code = await runRemoteExec(["-t", "ubuntu", "--timeout", "1s", "sleep", "600"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
    now: () => {
      clock += 5_000;
      return clock;
    },
  });

  assert.equal(code, 255, "CLI-level failures use ssh's 255");
  assert.match(consoleImpl.errors.join("\n"), /still running on ubuntu/);
  assert.match(consoleImpl.errors.join("\n"), /run-slow/);
});

test("runRemoteExec surfaces API errors with the right exit code", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([{ status: 404, body: { error: "daemon not connected" } }]);

  const code = await runRemoteExec(["-t", "ghost", "ls"], {
    console: consoleImpl,
    fetch,
    config,
  });

  assert.equal(code, 255, "CLI-level failures use ssh's 255");
  assert.match(consoleImpl.errors.join("\n"), /daemon not connected/);
});

test("runRemoteExec requires a target and a command", async () => {
  const withTargetOnly = makeConsole();
  assert.equal(
    await runRemoteExec(["-t", "ubuntu"], { console: withTargetOnly, config }),
    255,
  );
  assert.match(withTargetOnly.errors.join("\n"), /no command given/);

  const withCommandOnly = makeConsole();
  assert.equal(await runRemoteExec(["ls"], { console: withCommandOnly, config }), 255);
  assert.match(withCommandOnly.errors.join("\n"), /--target <daemon> is required/);
});

test("runRemoteExec --kill-on-timeout stops the run instead of leaving it behind", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { runId: "run-kill", status: "running", exitCode: null, stdoutTail: "" } },
    { body: { runId: "run-kill", status: "cancelled", exitCode: null, signal: "SIGTERM", stdoutTail: "" } },
  ]);
  let clock = 0;

  const code = await runRemoteExec(
    ["-t", "ubuntu", "--timeout", "1s", "--kill-on-timeout", "sleep", "600"],
    {
      console: consoleImpl,
      fetch,
      config,
      sleep: async () => {},
      now: () => (clock += 5_000),
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].url, "http://localhost:6152/api/agents/ubuntu/exec/runs/run-kill");
  assert.equal(code, 255, "a cancelled run is not a successful run");
  assert.match(consoleImpl.errors.join("\n"), /stopped the command on ubuntu/);
});

test("runRemoteExec leaves the run alone without --kill-on-timeout", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { runId: "run-keep", status: "running", exitCode: null, stdoutTail: "" } },
  ]);
  let clock = 0;

  await runRemoteExec(["-t", "ubuntu", "--timeout", "1s", "sleep", "600"], {
    console: consoleImpl,
    fetch,
    config,
    sleep: async () => {},
    now: () => (clock += 5_000),
  });

  assert.equal(calls.length, 1, "must not issue a DELETE");
  assert.match(consoleImpl.errors.join("\n"), /--kill-on-timeout/);
});

test("runRemoteExec --json prints the raw run payload", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([{ body: completedRun() }]);

  const code = await runRemoteExec(["-t", "ubuntu", "--json", "ls"], {
    console: consoleImpl,
    fetch,
    config,
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(consoleImpl.logs.join("\n")).runId, "run-1");
});

test("runRemote dispatches to the exec verb", async () => {
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([{ body: completedRun() }]);

  const code = await runRemote(["exec", "-t", "ubuntu", "ls", "."], {
    config,
    fetch,
    console: consoleImpl,
    sleep: async () => {},
  });

  assert.equal(code, 0);
  assert.match(calls[0].url, /\/api\/agents\/ubuntu\/exec$/);
});

test("runRemote dispatches to the cp verb", async () => {
  const consoleImpl = makeConsole();
  const code = await runRemote(["cp", "./a", "./b"], {
    config,
    fetch: async () => {
      throw new Error("should not reach the network");
    },
    console: consoleImpl,
  });

  // Both sides local is a cp-level usage error, which proves the verb ran.
  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("must name a daemon")));
});

test("runRemote names an unknown verb instead of guessing", async () => {
  const consoleImpl = makeConsole();
  const code = await runRemote(["scp", "./a", "ubuntu:/b"], { config, console: consoleImpl });
  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("unknown verb 'scp'")));
  assert.ok(consoleImpl.errors.some((line) => line.includes("Valid verbs: exec, cp")));
});

test("runRemote passes a verb's own --help through to that verb", async () => {
  const consoleImpl = makeConsole();
  assert.equal(await runRemote(["cp", "--help"], { config, console: consoleImpl }), 0);
  assert.ok(consoleImpl.logs.join("\n").includes("conductor remote cp"));

  const execConsole = makeConsole();
  assert.equal(await runRemote(["exec", "--help"], { config, console: execConsole }), 0);
  assert.ok(execConsole.logs.join("\n").includes("conductor remote exec"));
});

test("runRemote with no verb prints help and fails", async () => {
  const consoleImpl = makeConsole();
  assert.equal(await runRemote([], { config, console: consoleImpl }), 255);
  assert.ok(consoleImpl.logs.join("\n").includes("conductor remote - act on"));
});

test("runRemote --help succeeds", async () => {
  const consoleImpl = makeConsole();
  assert.equal(await runRemote(["--help"], { config, console: consoleImpl }), 0);
  assert.ok(consoleImpl.logs.join("\n").includes("Verbs:"));
});

test("remote exec still passes the remote command's own flags through untouched", async () => {
  const { fetch, calls } = makeFetch([{ body: completedRun() }]);
  await runRemote(["exec", "-t", "ubuntu", "--", "git", "log", "--oneline", "-5"], {
    config,
    fetch,
    console: makeConsole(),
    sleep: async () => {},
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.command, "git");
  assert.deepEqual(body.args, ["log", "--oneline", "-5"]);
});

test("runRemoteExec still prints output when --kill-on-timeout fails to stop the run", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([
    { body: { runId: "run-1", status: "running", stdoutTail: "partial output\n" } },
    { body: { runId: "run-1", status: "running", stdoutTail: "partial output\n" } },
    { status: 502, body: { error: "daemon went away" } },
  ]);

  let clock = 0;
  const code = await runRemoteExec(
    ["-t", "ubuntu", "--timeout", "1s", "--kill-on-timeout", "--json", "sleep", "60"],
    {
      config,
      fetch,
      console: consoleImpl,
      sleep: async () => {},
      now: () => (clock += 900),
    },
  );

  assert.equal(code, 255);
  // The kill failing must not swallow the run we already have in hand.
  assert.ok(consoleImpl.errors.some((line) => line.includes("failed to stop the run")));
  assert.ok(consoleImpl.logs.join("\n").includes("partial output"));
});
