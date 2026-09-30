import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../bin/conductor-settings.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

const P = "/api/user-preferences";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-settings-test-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const CATCHPHRASES = {
  catchphrases: [
    { id: "c1", text: "please add a test", sortOrder: 0, lastUsedAt: null },
    { id: "c2", text: "ship it", sortOrder: 1, lastUsedAt: null },
  ],
};

describe("conductor settings global-backends", () => {
  const current = { backends: [{ host: "macmini", backend: "claude" }] };

  it("get prints a table", async () => {
    const { code, out, calls } = await runWithFetch(main, ["global-backends", "get"], {
      [`GET ${P}/global-ai-backends`]: current,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "GET");
    assert.match(out, /^HOST\s+BACKEND/m);
    assert.match(out, /macmini\s+claude/);
  });

  it("get --json prints raw", async () => {
    const { out } = await runWithFetch(main, ["global-backends", "get", "--json"], {
      [`GET ${P}/global-ai-backends`]: current,
    });
    assert.deepEqual(JSON.parse(out), current);
  });

  it("set PUTs the body (bare array accepted)", async () => {
    const { code, calls } = await runWithFetch(
      main,
      ["global-backends", "set", "--json-body", '[{"host":"ubuntu","backend":"codex"}]'],
      { [`PUT ${P}/global-ai-backends`]: (call) => call.body },
    );
    assert.equal(code, 0);
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual(calls[0].body, { backends: [{ host: "ubuntu", backend: "codex" }] });
  });

  it("set reads --from-file", async () => {
    const file = path.join(tmpDir, "backends.json");
    fs.writeFileSync(file, JSON.stringify({ backends: [] }));
    const { code, calls } = await runWithFetch(main, ["global-backends", "set", "--from-file", file], {
      [`PUT ${P}/global-ai-backends`]: (call) => call.body,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { backends: [] });
  });

  it("set rejects bad JSON with exit 2 and no request", async () => {
    const { code, calls } = await runWithFetch(main, ["global-backends", "set", "--json-body", "{nope"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("add reads then PUTs the appended list", async () => {
    const { code, out, calls } = await runWithFetch(main, ["global-backends", "add", "ubuntu", "codex"], {
      [`GET ${P}/global-ai-backends`]: current,
      [`PUT ${P}/global-ai-backends`]: (call) => call.body,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
    assert.deepEqual(calls[1].body, {
      backends: [{ host: "macmini", backend: "claude" }, { host: "ubuntu", backend: "codex" }],
    });
    assert.match(out, /Added ubuntu \/ codex/);
  });

  it("add --dry-run reads but does not write", async () => {
    const { code, out, calls } = await runWithFetch(main, ["global-backends", "add", "ubuntu", "codex", "--dry-run", "--json"], {
      [`GET ${P}/global-ai-backends`]: current,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    assert.equal(JSON.parse(out).request.method, "PUT");
  });

  it("remove PUTs the filtered list", async () => {
    const { code, calls } = await runWithFetch(main, ["global-backends", "remove", "macmini", "claude"], {
      [`GET ${P}/global-ai-backends`]: current,
      [`PUT ${P}/global-ai-backends`]: (call) => call.body,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[1].body, { backends: [] });
  });

  it("remove and add match the server's normalization (trimmed host, lowercase backend)", async () => {
    const routes = {
      [`GET ${P}/global-ai-backends`]: current,
      [`PUT ${P}/global-ai-backends`]: (call) => call.body,
    };
    const rm = await runWithFetch(main, ["global-backends", "remove", " macmini ", "Claude"], routes);
    assert.equal(rm.code, 0, rm.err);
    assert.deepEqual(rm.calls[1].body, { backends: [] });
    const add = await runWithFetch(main, ["global-backends", "add", "macmini", "CLAUDE"], routes);
    assert.equal(add.code, 0, add.err);
    assert.deepEqual(add.calls.map((c) => c.method), ["GET"]);
  });

  it("remove of an unknown pair exits 4 without writing", async () => {
    const { code, calls } = await runWithFetch(main, ["global-backends", "remove", "x", "y"], {
      [`GET ${P}/global-ai-backends`]: current,
    });
    assert.equal(code, 4);
    assert.equal(calls.length, 1);
  });

  it("server 400 reason is surfaced with exit 2", async () => {
    const { code, err } = await runWithFetch(main, ["global-backends", "add", "ubuntu", "codex"], {
      [`GET ${P}/global-ai-backends`]: current,
      [`PUT ${P}/global-ai-backends`]: { status: 400, body: { error: "ubuntu / codex: daemon ubuntu is offline" } },
    });
    assert.equal(code, 2);
    assert.match(err, /daemon ubuntu is offline/);
  });
});

describe("conductor settings catchphrases", () => {
  it("list", async () => {
    const { code, out, calls } = await runWithFetch(main, ["catchphrases", "list"], {
      [`GET ${P}/catchphrases`]: CATCHPHRASES,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].path, `${P}/catchphrases`);
    assert.match(out, /c1\s+please add a test/);
    assert.match(out, /c2\s+ship it/);
  });

  it("add joins words and reports the new id", async () => {
    const { code, out, calls } = await runWithFetch(main, ["catchphrases", "add", "ship", "it"], {
      [`POST ${P}/catchphrases`]: { status: 201, body: CATCHPHRASES },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { text: "ship it" });
    assert.match(out, /Added catchphrase c2/);
  });

  it("add --json prints the raw snapshot", async () => {
    const { out } = await runWithFetch(main, ["catchphrases", "add", "x", "--json"], {
      [`POST ${P}/catchphrases`]: CATCHPHRASES,
    });
    assert.deepEqual(JSON.parse(out), CATCHPHRASES);
  });

  it("update PATCHes /:id", async () => {
    const { code, calls } = await runWithFetch(main, ["catchphrases", "update", "c1", "new", "text"], {
      [`PATCH ${P}/catchphrases/c1`]: CATCHPHRASES,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(calls[0].body, { text: "new text" });
  });

  it("delete DELETEs /:id", async () => {
    const { code, out, calls } = await runWithFetch(main, ["catchphrases", "delete", "c1"], {
      [`DELETE ${P}/catchphrases/c1`]: CATCHPHRASES,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].body, undefined);
    assert.match(out, /Deleted catchphrase c1/);
  });

  it("delete --dry-run sends nothing", async () => {
    const { code, out, calls } = await runWithFetch(main, ["catchphrases", "delete", "c1", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out, /DELETE https:\/\/backend\.example\/api\/user-preferences\/catchphrases\/c1/);
  });

  it("delete of an unknown id exits 4", async () => {
    const { code, err } = await runWithFetch(main, ["catchphrases", "delete", "zz"], {
      [`DELETE ${P}/catchphrases/zz`]: { status: 404, body: { error: "Catchphrase not found" } },
    });
    assert.equal(code, 4);
    assert.match(err, /Catchphrase not found/);
  });

  it("reorder PUTs ids in order", async () => {
    const { code, calls } = await runWithFetch(main, ["catchphrases", "reorder", "c2", "c1"], {
      [`PUT ${P}/catchphrases/reorder`]: CATCHPHRASES,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual(calls[0].body, { ids: ["c2", "c1"] });
  });

  it("touch POSTs /:id/touch", async () => {
    const { code, calls } = await runWithFetch(main, ["catchphrases", "touch", "c1"], {
      [`POST ${P}/catchphrases/c1/touch`]: CATCHPHRASES,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, undefined);
  });
});

describe("conductor settings daily-report", () => {
  const setting = {
    enabled: true,
    timezone: "Asia/Shanghai",
    sendTimeLocal: "09:00",
    deliveryChannels: ["in_app"],
    nextRunAt: "2026-09-30T01:00:00.000Z",
  };

  it("get", async () => {
    const { code, out, calls } = await runWithFetch(main, ["daily-report", "get"], {
      [`GET ${P}/daily-report`]: setting,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "GET");
    assert.match(out, /enabled:\s+true/);
    assert.match(out, /channels:\s+in_app/);
  });

  it("set PATCHes enabled + channels and sends the timezone header", async () => {
    const { code, calls } = await runWithFetch(
      main,
      ["daily-report", "set", "--enabled", "--delivery-channels", "in_app,feishu", "--timezone", "Europe/Paris"],
      { [`PATCH ${P}/daily-report`]: setting },
    );
    assert.equal(code, 0);
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(calls[0].body, { enabled: true, deliveryChannels: ["in_app", "feishu"] });
    assert.equal(calls[0].headers["X-Client-Timezone"], "Europe/Paris");
  });

  it("set --enabled false", async () => {
    const { calls } = await runWithFetch(main, ["daily-report", "set", "--enabled", "false"], {
      [`PATCH ${P}/daily-report`]: { ...setting, enabled: false },
    });
    assert.deepEqual(calls[0].body, { enabled: false });
  });

  it("set --dry-run sends nothing", async () => {
    const { code, out, calls } = await runWithFetch(main, ["daily-report", "set", "--enabled", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(JSON.parse(out).request.body, { enabled: true });
  });

  it("set rejects unknown channels and empty updates", async () => {
    const bad = await runWithFetch(main, ["daily-report", "set", "--delivery-channels", "email"], {});
    assert.equal(bad.code, 2);
    const empty = await runWithFetch(main, ["daily-report", "set"], {});
    assert.equal(empty.code, 2);
    assert.equal(bad.calls.length + empty.calls.length, 0);
  });
});

describe("conductor settings reports", () => {
  const report = {
    reportDate: "2026-09-28",
    timezone: "Asia/Shanghai",
    status: "generated",
    summaryMarkdown: "# Summary\n- did things",
    persisted: true,
  };

  it("list sends list=1 and limit", async () => {
    const { code, out, calls } = await runWithFetch(main, ["reports", "list", "--limit", "5"], {
      "GET /api/daily-reports": { reports: [report] },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { list: "1", limit: "5" });
    assert.match(out, /2026-09-28\s+generated\s+Asia\/Shanghai/);
  });

  it("daily-reports alias works", async () => {
    const { code, calls } = await runWithFetch(main, ["daily-reports", "list"], {
      "GET /api/daily-reports": { reports: [] },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { list: "1" });
  });

  it("show passes date/timezone and prints the summary", async () => {
    const { code, out, calls } = await runWithFetch(main, ["reports", "show", "--date", "2026-09-28", "--timezone", "UTC"], {
      "GET /api/daily-reports": report,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { date: "2026-09-28", timezone: "UTC" });
    assert.match(out, /# Summary/);
  });

  it("show validates --date", async () => {
    const { code, calls } = await runWithFetch(main, ["reports", "show", "--date", "yesterday"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("generate POSTs reportDate", async () => {
    const { code, out, calls } = await runWithFetch(main, ["reports", "generate", "--date", "2026-09-28", "--json"], {
      "POST /api/daily-reports": report,
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { reportDate: "2026-09-28" });
    assert.deepEqual(JSON.parse(out), report);
  });

  it("generate --dry-run sends nothing", async () => {
    const { code, calls } = await runWithFetch(main, ["reports", "generate", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  });

  it("maps 403 (no subscription) to exit 3", async () => {
    const { code } = await runWithFetch(main, ["reports", "list"], {
      "GET /api/daily-reports": { status: 403, body: { error: "Subscription required" } },
    });
    assert.equal(code, 3);
  });
});

describe("conductor settings task-list", () => {
  it("get", async () => {
    const { code, out } = await runWithFetch(main, ["task-list", "get"], {
      [`GET ${P}/task-list`]: { tasksRunningOnly: true, tasks_running_only: true },
    });
    assert.equal(code, 0);
    assert.match(out, /tasksRunningOnly: true/);
  });

  it("set --running-only PATCHes", async () => {
    const { code, calls } = await runWithFetch(main, ["task-list", "set", "--running-only", "false"], {
      [`PATCH ${P}/task-list`]: { tasksRunningOnly: false },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(calls[0].body, { tasksRunningOnly: false });
  });

  it("set --json-body PATCHes the given body", async () => {
    const { calls } = await runWithFetch(main, ["task-list", "set", "--json-body", '{"tasksRunningOnly":true}'], {
      [`PATCH ${P}/task-list`]: { tasksRunningOnly: true },
    });
    assert.deepEqual(calls[0].body, { tasksRunningOnly: true });
  });

  it("set without a value exits 2", async () => {
    const { code, calls } = await runWithFetch(main, ["task-list", "set"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });
});

for (const [resource, memberKey] of [["task-card-groups", "taskIds"], ["project-card-groups", "projectIds"]]) {
  describe(`conductor settings ${resource}`, () => {
    const groups = [{ id: "g1", [memberKey]: ["a", "b"] }];
    const snapshot = { version: 1, revision: 3, scopes: { "projects:all": groups } };

    it("get", async () => {
      const { code, out, calls } = await runWithFetch(main, [resource, "get"], {
        [`GET ${P}/${resource}`]: snapshot,
      });
      assert.equal(code, 0);
      assert.equal(calls[0].path, `${P}/${resource}`);
      assert.match(out, /revision: 3/);
      assert.match(out, /g1\s+2 \w+s: a, b/);
    });

    it("set wraps a bare array with the default scope", async () => {
      const { code, calls } = await runWithFetch(main, [resource, "set", "--json-body", JSON.stringify(groups)], {
        [`PATCH ${P}/${resource}`]: snapshot,
      });
      assert.equal(code, 0);
      assert.equal(calls[0].method, "PATCH");
      assert.deepEqual(calls[0].body, { scope: "projects:all", groups });
    });

    it("set passes a full body and honours --scope", async () => {
      const { calls } = await runWithFetch(
        main,
        [resource, "set", "--scope", "projects:p1", "--json-body", JSON.stringify({ scope: "projects:all", groups: [] })],
        { [`PATCH ${P}/${resource}`]: snapshot },
      );
      assert.deepEqual(calls[0].body, { scope: "projects:p1", groups: [] });
    });

    it("set --dry-run sends nothing", async () => {
      const { code, calls } = await runWithFetch(main, [resource, "set", "--json-body", "[]", "--dry-run"], {});
      assert.equal(code, 0);
      assert.equal(calls.length, 0);
    });

    it("get maps 401 to exit 3", async () => {
      const { code } = await runWithFetch(main, [resource, "get"], {
        [`GET ${P}/${resource}`]: { status: 401, body: { error: "Unauthorized" } },
      });
      assert.equal(code, 3);
    });
  });
}

describe("conductor settings usage", () => {
  it("requires a subcommand", async () => {
    const { code } = await runWithFetch(main, [], {});
    assert.equal(code, 2);
    const nested = await runWithFetch(main, ["catchphrases"], {});
    assert.equal(nested.code, 2);
  });
});
