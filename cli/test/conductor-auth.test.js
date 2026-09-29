import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../bin/conductor-auth.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

describe("conductor auth", () => {
  it("whoami calls GET /api/auth/me", async () => {
    const { code, out, calls } = await runWithFetch(main, ["whoami"], {
      "GET /api/auth/me": { user: { id: "u1", email: "a@b.c", phone: null, tokenScope: "full" } },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].path, "/api/auth/me");
    assert.match(out, /id:\s+u1/);
    assert.match(out, /email:\s+a@b\.c/);
    assert.doesNotMatch(out, /phone/);
  });

  it("whoami --json prints the raw response", async () => {
    const body = { user: { id: "u1", email: null, phone: "123" } };
    const { out } = await runWithFetch(main, ["whoami", "--json"], { "GET /api/auth/me": body });
    assert.deepEqual(JSON.parse(out), body);
  });

  it("whoami maps 401 to exit 3", async () => {
    const { code, err } = await runWithFetch(main, ["whoami"], {
      "GET /api/auth/me": { status: 401, body: { error: "Unauthorized" } },
    });
    assert.equal(code, 3);
    assert.match(err, /Unauthorized/);
  });

  it("tokens list renders a table", async () => {
    const tokens = [
      { id: "tok1", name: "webapp", token_prefix: "abcd1234", created_at: "2026-09-01T00:00:00.000Z", last_used_at: null },
    ];
    const { code, out, calls } = await runWithFetch(main, ["tokens", "list"], { "GET /api/auth/tokens": tokens });
    assert.equal(code, 0);
    assert.equal(calls[0].path, "/api/auth/tokens");
    assert.match(out, /^ID\s+PREFIX\s+CREATED\s+LAST USED\s+NAME/m);
    assert.match(out, /tok1\s+abcd1234\s+2026-09-01T00:00:00\.000Z\s+-\s+webapp/);
  });

  it("tokens list --json", async () => {
    const { out } = await runWithFetch(main, ["tokens", "list", "--json"], { "GET /api/auth/tokens": [] });
    assert.deepEqual(JSON.parse(out), []);
  });

  it("tokens create posts the name and prints the token once with a warning", async () => {
    const { code, out, err, calls } = await runWithFetch(main, ["tokens", "create", "--name", "ci"], {
      "POST /api/auth/tokens": { token: "secret-token-value", tokenId: "tok9", tokenPrefix: "secret-t", createdAt: "x" },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { name: "ci" });
    assert.match(out, /Created token tok9/);
    assert.match(out, /token: secret-token-value/);
    assert.match(err, /shown only once/);
  });

  it("tokens create defaults the name and supports --json", async () => {
    const created = { token: "t", tokenId: "tok9", tokenPrefix: "t", createdAt: "x" };
    const { out, calls } = await runWithFetch(main, ["tokens", "create", "--json"], { "POST /api/auth/tokens": created });
    assert.deepEqual(calls[0].body, { name: "cli" });
    assert.deepEqual(JSON.parse(out), created);
  });

  it("tokens create --dry-run sends nothing", async () => {
    const { code, out, calls } = await runWithFetch(main, ["tokens", "create", "--name", "ci", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const preview = JSON.parse(out);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.request.method, "POST");
    assert.equal(preview.request.url, "https://backend.example/api/auth/tokens");
    assert.deepEqual(preview.request.body, { name: "ci" });
  });

  it("tokens revoke posts to the revoke route (204)", async () => {
    const { code, out, calls } = await runWithFetch(main, ["tokens", "revoke", "tok/1"], {
      "POST /api/auth/tokens/tok%2F1/revoke": { status: 204, body: undefined },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, undefined);
    assert.match(out, /Revoked token tok\/1/);
  });

  it("tokens revoke --dry-run sends nothing", async () => {
    const { code, out, calls } = await runWithFetch(main, ["tokens", "revoke", "tok1", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out, /\[dry-run\] would send:/);
    assert.match(out, /POST https:\/\/backend\.example\/api\/auth\/tokens\/tok1\/revoke/);
  });

  it("tokens revoke of an unknown id exits 4", async () => {
    const { code, err } = await runWithFetch(main, ["tokens", "revoke", "nope"], {
      "POST /api/auth/tokens/nope/revoke": { status: 404, body: { error: "Token not found" } },
    });
    assert.equal(code, 4);
    assert.match(err, /Token not found/);
  });

  it("requires a subcommand", async () => {
    const { code } = await runWithFetch(main, ["tokens"], {});
    assert.equal(code, 2);
  });
});
