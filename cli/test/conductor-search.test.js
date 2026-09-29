import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../bin/conductor-search.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

const HITS = {
  query: "flaky test",
  backend: "fts",
  hits: [
    { taskId: "t1", taskTitle: "Fix CI", messageId: "m1", role: "user", snippet: "the [flaky test]\nagain", createdAt: "2026-09-01T10:00:00.000Z" },
    { taskId: "t2", taskTitle: "Refactor", messageId: "m2", role: "assistant", snippet: "no [flaky test] here", createdAt: "2026-09-02T11:00:00.000Z" },
    { taskId: "t1", taskTitle: "Fix CI", messageId: "m3", role: "assistant", snippet: "fixed [flaky test]", createdAt: "2026-09-01T12:00:00.000Z" },
  ],
};

describe("conductor search", () => {
  it("joins the query words and sends q + default limit", async () => {
    const { code, out, calls } = await runWithFetch(main, ["flaky", "test"], { "GET /api/search": HITS });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].path, "/api/search");
    assert.deepEqual(calls[0].query, { q: "flaky test", limit: "30" });
    assert.equal(calls[0].headers.Authorization, "Bearer test-token");
    // grouped by task, in first-seen order
    assert.match(out, /3 hits in 2 tasks \(backend: fts\)/);
    const fixIdx = out.indexOf("Fix CI  [t1]");
    const refIdx = out.indexOf("Refactor  [t2]");
    assert.ok(fixIdx >= 0 && refIdx > fixIdx);
    assert.match(out, /fixed \[flaky test\]/);
    assert.match(out, /the \[flaky test\] again/);
  });

  it("passes --limit and prints raw JSON with --json", async () => {
    const { code, out, calls } = await runWithFetch(main, ["x", "--limit", "5", "--json"], { "GET /api/search": HITS });
    assert.equal(code, 0);
    assert.equal(calls[0].query.limit, "5");
    assert.deepEqual(JSON.parse(out), HITS);
  });

  it("reports no hits", async () => {
    const { code, out } = await runWithFetch(main, ["nothing"], {
      "GET /api/search": { query: "nothing", backend: "like", hits: [] },
    });
    assert.equal(code, 0);
    assert.match(out, /No messages match "nothing"/);
  });

  it("requires a query", async () => {
    const { code, calls } = await runWithFetch(main, [], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("maps 401 to exit 3", async () => {
    const { code, err } = await runWithFetch(main, ["x"], {
      "GET /api/search": { status: 401, body: { error: "Unauthorized" } },
    });
    assert.equal(code, 3);
    assert.match(err, /Unauthorized/);
  });
});
