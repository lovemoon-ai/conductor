import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../bin/conductor-issue.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

const ISSUES = [
  { id: "i1", projectId: "p1", title: "One", status: "backlog", priority: "P1" },
  { id: "i2", projectId: "p2", projectName: "beta", title: "Two", status: "doing", priority: "P2" },
  { id: "i3", projectId: "p2", title: "Three", status: "done" },
];

describe("conductor issue delete", () => {
  it("requires --yes", async () => {
    const r = await runWithFetch(main, ["delete", "i1"], {});
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.err, /--yes/);
  });

  it("DELETEs /api/issues/:id", async () => {
    const r = await runWithFetch(main, ["delete", "i 1", "--yes"], {
      "DELETE /api/issues/i%201": () => ({ status: 204, body: undefined }),
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].method, "DELETE");
    assert.equal(r.calls[0].path, "/api/issues/i%201");
    assert.equal(r.calls[0].body, undefined);
    assert.match(r.out, /Deleted issue i 1/);
  });

  it("--json output", async () => {
    const r = await runWithFetch(main, ["delete", "i1", "--yes", "--json"], {
      "DELETE /api/issues/i1": () => ({ status: 204, body: undefined }),
    });
    assert.deepEqual(JSON.parse(r.out), { deleted: true, id: "i1" });
  });

  it("--dry-run makes no request (no --yes needed)", async () => {
    const r = await runWithFetch(main, ["delete", "i1", "--dry-run", "--json"], {});
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 0);
    const payload = JSON.parse(r.out);
    assert.equal(payload.request.method, "DELETE");
    assert.equal(payload.request.url, "https://backend.example/api/issues/i1");
  });

  it("404 -> exit 4; 409 surfaces the server reason", async () => {
    const n = await runWithFetch(main, ["delete", "i1", "--yes"], {
      "DELETE /api/issues/i1": () => ({ status: 404, body: { error: "Not found" } }),
    });
    assert.equal(n.code, 4);
    const c = await runWithFetch(main, ["delete", "i1", "--yes"], {
      "DELETE /api/issues/i1": () => ({ status: 409, body: { error: "Move the issue out of doing before deleting it" } }),
    });
    assert.notEqual(c.code, 0);
    assert.match(c.err, /Move the issue out of doing/);
  });
});

describe("conductor issue list across projects", () => {
  it("--all-projects GETs /api/issues without a project filter", async () => {
    const r = await runWithFetch(main, ["list", "--all-projects", "--json"], {
      "GET /api/issues": () => ISSUES,
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].method, "GET");
    assert.deepEqual(r.calls[0].query, {});
    assert.deepEqual(JSON.parse(r.out).map((i) => i.id), ["i1", "i2", "i3"]);
  });

  it("--project-ids sends project_ids (deduped) and filters status/limit client-side", async () => {
    const r = await runWithFetch(
      main,
      ["list", "--project-ids", "p1, p2,p1", "--status", "backlog,doing", "--limit", "1", "--json"],
      { "GET /api/issues": () => ISSUES },
    );
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].query, { project_ids: "p1,p2" });
    assert.deepEqual(JSON.parse(r.out).map((i) => i.id), ["i1"]);
  });

  it("--json uses the same normalized shape as single-project list", async () => {
    const r = await runWithFetch(main, ["list", "--all-projects", "--json"], {
      "GET /api/issues": () => [
        { id: "i9", project_id: "p1", projectName: "alpha", title: "Nine", status: "todo", created_at: "t0", activeTask: null },
      ],
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [{
      id: "i9", title: "Nine", status: "todo", projectId: "p1", createdAt: "t0",
    }]);
  });

  it("--limit 0 is an args error on both list paths", async () => {
    for (const args of [["list", "--all-projects", "--limit", "0"], ["list", "--project", "p1", "--limit", "0"]]) {
      const r = await runWithFetch(main, args, { "GET /api/issues": () => ISSUES });
      assert.equal(r.code, 2, args.join(" "));
      assert.equal(r.calls.length, 0);
      assert.match(r.err, /--limit must be a positive integer/);
    }
  });

  it("human output includes a PROJECT column", async () => {
    const r = await runWithFetch(main, ["list", "--all-projects"], { "GET /api/issues": () => ISSUES });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ID\s+PROJECT\s+STATUS\s+PRIO\s+TITLE/);
    assert.match(r.out, /i1\s+p1\s+backlog\s+P1\s+One/);
    assert.match(r.out, /i2\s+beta\s+doing/);
  });

  it("empty result", async () => {
    const r = await runWithFetch(main, ["list", "--all-projects"], { "GET /api/issues": () => [] });
    assert.match(r.out, /\(no issues\)/);
  });

  it("rejects combining the selectors", async () => {
    const a = await runWithFetch(main, ["list", "--all-projects", "--project-ids", "p1"], {});
    assert.equal(a.code, 2);
    const b = await runWithFetch(main, ["list", "--project", "p1", "--all-projects"], {});
    assert.equal(b.code, 2);
    assert.equal(a.calls.length + b.calls.length, 0);
  });

  it("404 -> exit 4", async () => {
    const r = await runWithFetch(main, ["list", "--project-ids", "p9"], {
      "GET /api/issues": () => ({ status: 404, body: { error: "Project not found" } }),
    });
    assert.equal(r.code, 4);
    assert.match(r.err, /Project not found/);
  });
});
