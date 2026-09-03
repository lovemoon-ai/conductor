import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import {
  buildFireSpawnArgs,
  collectBackendSessions,
  startDaemon as startDaemonReal,
} from "../src/daemon.js";

// Same startup isolation daemon.test.js uses: the real AI manager probes
// installed CLIs with real child processes, which is slow and escapes mocks.
const startDaemon = (config, deps = {}) =>
  startDaemonReal(config, {
    createAiManagerHandlers: () => ({ manager: { checkInstallAll: async () => ({}) } }),
    ...deps,
  });

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("buildFireSpawnArgs resume forwarding", () => {
  it("appends --resume <id> before -- when launch_config.resumeSessionId is set", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "claude",
      initialContent: "continue please",
      launchConfig: { resumeSessionId: "sess-123" },
    });
    const resumeIndex = args.indexOf("--resume");
    assert.ok(resumeIndex >= 0, "--resume flag must be appended");
    assert.equal(args[resumeIndex + 1], "sess-123");
    assert.ok(resumeIndex < args.indexOf("--"), "--resume must come before --");
  });

  it("accepts the snake_case resume_session_id spelling", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "claude",
      initialContent: "",
      launchConfig: { resume_session_id: "sess-snake" },
    });
    const resumeIndex = args.indexOf("--resume");
    assert.ok(resumeIndex >= 0);
    assert.equal(args[resumeIndex + 1], "sess-snake");
  });

  it("omits --resume when no resumeSessionId is provided", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "claude",
      initialContent: "hello",
      launchConfig: {},
    });
    assert.ok(!args.includes("--resume"));
  });

  it("omits --resume for empty or whitespace-only session ids", () => {
    for (const value of ["", "   "]) {
      const args = buildFireSpawnArgs({
        selectedBackend: "claude",
        initialContent: "hello",
        launchConfig: { resumeSessionId: value },
      });
      assert.ok(!args.includes("--resume"), `must not resume for ${JSON.stringify(value)}`);
    }
  });
});

describe("collectBackendSessions", () => {
  it("defaults to the intersection of listable and supported backends", async () => {
    const listedBackends = [];
    const { sessions, errors } = await collectBackendSessions({
      supportedBackends: ["claude", "codex", "opencode"],
      listSessions: async (backend) => {
        listedBackends.push(backend);
        return [];
      },
    });
    assert.deepEqual(listedBackends, ["claude", "codex"]);
    assert.deepEqual(sessions, []);
    assert.deepEqual(errors, []);
  });

  it("maps entries to snake_case, converts epoch ms to ISO, and sorts newest first", async () => {
    const { sessions, errors } = await collectBackendSessions({
      requestedBackends: ["claude", "codex"],
      supportedBackends: ["claude", "codex"],
      listSessions: async (backend) => {
        if (backend === "claude") {
          return [
            {
              sessionId: "old",
              sessionFilePath: "/tmp/old.jsonl",
              cwd: "/repo/a",
              title: "older",
              updatedAt: Date.UTC(2026, 8, 1, 10, 0, 0),
            },
            { sessionId: "no-time", title: "untimed" },
          ];
        }
        return [
          {
            sessionId: "new",
            sessionFilePath: "/tmp/new.jsonl",
            cwd: "/repo/b",
            title: "newer",
            updatedAt: Date.UTC(2026, 8, 2, 10, 0, 0),
          },
        ];
      },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      sessions.map((s) => s.session_id),
      ["new", "old", "no-time"],
      "must be merged across backends, newest first, null timestamps last",
    );
    assert.deepEqual(sessions[0], {
      backend: "codex",
      session_id: "new",
      session_file_path: "/tmp/new.jsonl",
      cwd: "/repo/b",
      title: "newer",
      updated_at: "2026-09-02T10:00:00.000Z",
    });
    assert.equal(sessions[2].updated_at, null);
    assert.equal(sessions[2].session_file_path, null);
  });

  it("reports unsupported backends in errors without affecting others", async () => {
    const { sessions, errors } = await collectBackendSessions({
      requestedBackends: ["claude", "kimi", "not-a-backend"],
      supportedBackends: ["claude", "codex"],
      listSessions: async (backend) => [
        { sessionId: `${backend}-1`, updatedAt: 1000 },
      ],
    });
    assert.deepEqual(sessions.map((s) => s.session_id), ["claude-1"]);
    assert.equal(errors.length, 2);
    assert.deepEqual(errors.map((e) => e.backend).sort(), ["kimi", "not-a-backend"]);
    for (const entry of errors) {
      assert.equal(typeof entry.message, "string");
      assert.ok(entry.message.length > 0);
    }
  });

  it("turns a single backend failure into an error entry and keeps the rest", async () => {
    const { sessions, errors } = await collectBackendSessions({
      requestedBackends: ["claude", "codex"],
      supportedBackends: ["claude", "codex"],
      listSessions: async (backend) => {
        if (backend === "codex") {
          throw new Error("codex store unreadable");
        }
        return [{ sessionId: "ok", updatedAt: 5 }];
      },
    });
    assert.deepEqual(sessions.map((s) => s.session_id), ["ok"]);
    assert.deepEqual(errors, [{ backend: "codex", message: "codex store unreadable" }]);
  });

  it("defaults the per-backend limit to 20 and caps it at 50", async () => {
    const seenLimits = [];
    const listSessions = async (backend, { limit }) => {
      seenLimits.push(limit);
      return [];
    };
    const base = { requestedBackends: ["claude"], supportedBackends: ["claude"], listSessions };
    await collectBackendSessions({ ...base });
    await collectBackendSessions({ ...base, limit: 5 });
    await collectBackendSessions({ ...base, limit: 100 });
    await collectBackendSessions({ ...base, limit: "nonsense" });
    assert.deepEqual(seenLimits, [20, 5, 50, 20]);
  });

  it("dedupes repeated backends and skips blank entries", async () => {
    const listedBackends = [];
    const { errors } = await collectBackendSessions({
      requestedBackends: ["claude", "claude", "", 42],
      supportedBackends: ["claude"],
      listSessions: async (backend) => {
        listedBackends.push(backend);
        return [];
      },
    });
    assert.deepEqual(listedBackends, ["claude"]);
    assert.deepEqual(errors, []);
  });
});

describe("daemon list_backend_sessions RPC", () => {
  const ISOLATED_ENV_KEYS = [
    "HOME",
    "CONDUCTOR_CONFIG",
    "CONDUCTOR_HOME",
    "CONDUCTOR_FIRE_TMUX_MODE",
    "CONDUCTOR_AGENT_TOKEN",
    "CONDUCTOR_BACKEND_URL",
    "CONDUCTOR_WS_URL",
  ];

  let wss;
  let daemon;
  let port;
  let previousEnv;
  let testHomeDir;

  before(async () => {
    previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-daemon-sessions-"));
    for (const key of ISOLATED_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.HOME = testHomeDir;
    wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => wss.on("listening", resolve));
    port = wss.address().port;
  });

  after(() => {
    if (daemon) daemon.close();
    if (wss) wss.close();
    for (const [key, value] of previousEnv ?? []) {
      restoreEnv(key, value);
    }
    if (testHomeDir) {
      fs.rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  it("answers list_backend_sessions with backend_sessions_listed", async () => {
    const receivedFromDaemon = [];
    let capabilitiesHeader = "";

    wss.once("connection", (ws, req) => {
      capabilitiesHeader = String(req.headers["x-conductor-capabilities"] || "");
      ws.on("message", (raw) => {
        try {
          receivedFromDaemon.push(JSON.parse(raw.toString("utf8")));
        } catch {
          // ignore non-JSON frames
        }
      });
      // Give the daemon's async backend discovery a beat to populate
      // SUPPORTED_BACKENDS before asking for the intersection.
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "list_backend_sessions",
            payload: {
              request_id: "req-sessions-1",
              backends: ["claude", "not-a-backend"],
              limit: 5,
            },
          }),
        );
      }, 500);
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: path.join(testHomeDir, "workspace"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-sessions-test",
      },
      {
        listBackendSessions: async (backend, { limit }) => {
          assert.equal(backend, "claude");
          assert.equal(limit, 5);
          return [
            {
              sessionId: "sess-abc",
              sessionFilePath: "/tmp/sess-abc.jsonl",
              cwd: "/repo/demo",
              title: "demo session",
              updatedAt: Date.UTC(2026, 8, 2, 10, 0, 0),
            },
          ];
        },
        spawnSync: () => ({ status: 1, error: new Error("ENOENT"), pid: undefined }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
      },
    );

    const deadline = Date.now() + 8000;
    let reply;
    while (!reply && Date.now() < deadline) {
      reply = receivedFromDaemon.find((msg) => msg?.type === "backend_sessions_listed");
      if (!reply) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    assert.ok(reply, "daemon must reply with backend_sessions_listed");
    assert.equal(reply.payload.request_id, "req-sessions-1");
    assert.deepEqual(reply.payload.sessions, [
      {
        backend: "claude",
        session_id: "sess-abc",
        session_file_path: "/tmp/sess-abc.jsonl",
        cwd: "/repo/demo",
        title: "demo session",
        updated_at: "2026-09-02T10:00:00.000Z",
      },
    ]);
    assert.equal(reply.payload.errors.length, 1);
    assert.equal(reply.payload.errors[0].backend, "not-a-backend");
    assert.ok(
      capabilitiesHeader.split(",").includes("backend_session_list"),
      `x-conductor-capabilities must advertise backend_session_list; got: ${capabilitiesHeader}`,
    );
  });
});
