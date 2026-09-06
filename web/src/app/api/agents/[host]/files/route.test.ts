import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { GET as GET_TRANSFER, DELETE as DELETE_TRANSFER } from "./[transferId]/route";
import { PUT as PUT_CONTENT, GET as GET_CONTENT } from "./[transferId]/content/route";
import { POST as POST_DELIVER } from "./[transferId]/deliver/route";
import {
  GET as AGENT_GET_CONTENT,
  PUT as AGENT_PUT_CONTENT,
} from "@/app/api/agent/files/[transferId]/content/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";
import { signTransferToken } from "@/lib/transfers/transfer-token";
import { resetTransferStoreForTests } from "@/lib/transfers/transfer-store";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/remote-file", () => ({
  requestRemoteFile: vi.fn(),
  requestRemoteFileDetached: vi.fn(),
}));

vi.mock("@/lib/auth/agent-request", () => ({
  authenticateAgentRequest: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestRemoteFile, requestRemoteFileDetached } = await import("@/lib/realtime/remote-file");

/**
 * The routes call the detached wrapper, which answers early for a slow daemon
 * and writes the outcome onto the record later. Every test here models a
 * daemon that answers immediately, so delegate to the `requestRemoteFile` mock
 * and settle inline — that is precisely the fast path.
 */
function useImmediateDaemon() {
  vi.mocked(requestRemoteFileDetached).mockImplementation(async (opts: any, onSettled: any) => {
    const outcome = await (requestRemoteFile as any)(opts);
    onSettled(outcome);
    return outcome;
  });
}
const { authenticateAgentRequest } = await import("@/lib/auth/agent-request");

const authedUser = { id: "user-1", email: "test@example.com", phone: null } as any;

const agentWithRemoteFile = (host: string) => ({
  id: `agent-${host}`,
  host,
  supportedBackends: ["codex"],
  capabilities: ["remote_exec", "remote_file"],
});

const hostParams = (host: string) => ({ params: Promise.resolve({ host }) });
const transferParams = (host: string, transferId: string) => ({
  params: Promise.resolve({ host, transferId }),
});
const agentParams = (transferId: string) => ({ params: Promise.resolve({ transferId }) });

function binaryRequest(method: string, body: Buffer, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:6152/api/agents/ubuntu/files/x/content", {
    method,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength),
      ...headers,
    },
    body: new Uint8Array(body),
    // Node's fetch requires this for a request that carries a body stream.
    duplex: "half",
  } as any);
}

async function createUpload(body: Record<string, unknown> = {}) {
  const res = await POST(
    createMockRequest({
      method: "POST",
      body: { direction: "up", remotePath: "/srv/app/a.tar", ...body },
    }),
    hostParams("ubuntu"),
  );
  return { res, data: await extractJson(res) };
}

let storageRoot = "";
const originalStorageDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;
const BUDGET_ENV = [
  "CONDUCTOR_REMOTE_FILE_MAX_BYTES",
  "CONDUCTOR_REMOTE_FILE_TOTAL_BYTES",
  "CONDUCTOR_REMOTE_FILE_USER_BYTES",
] as const;
const originalBudgetEnv = new Map(BUDGET_ENV.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  vi.clearAllMocks();
  useImmediateDaemon();
  resetTransferStoreForTests();
  for (const key of BUDGET_ENV) {
    const previous = originalBudgetEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-files-route-"));
  process.env.CONDUCTOR_FILE_STORAGE_DIR = storageRoot;
  vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
  vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRemoteFile("ubuntu")]);
  vi.mocked(authenticateAgentRequest).mockResolvedValue({
    user: authedUser,
    agentHost: "ubuntu",
  } as any);
});

afterAll(async () => {
  if (originalStorageDir === undefined) delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
  else process.env.CONDUCTOR_FILE_STORAGE_DIR = originalStorageDir;
  for (const key of BUDGET_ENV) {
    const previous = originalBudgetEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("/api/agents/[host]/files authorization", () => {
  it("returns 401 passthrough when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const res = await POST(
      createMockRequest({ method: "POST", body: { direction: "up", remotePath: "/srv/a.tar" } }),
      hostParams("ubuntu"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the daemon is not connected", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    const { res, data } = await createUpload();
    expect(res.status).toBe(404);
    expect(data.error).toMatch(/not connected/);
  });

  it("returns 409 when the daemon lacks the remote_file capability", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-old", host: "ubuntu", supportedBackends: ["codex"], capabilities: ["remote_exec"] },
    ]);
    const { res, data } = await createUpload();

    expect(res.status).toBe(409);
    // Both remedies must be named: an old daemon and an opted-out one look
    // identical on the wire but need different fixes.
    expect(data.error).toMatch(/remote file transfer/);
    expect(data.error).toMatch(/upgrade/);
    expect(data.error).toMatch(/remote_file: false/);
  });

  it("rejects a body with a missing or NUL-bearing remotePath", async () => {
    const missing = await POST(
      createMockRequest({ method: "POST", body: { direction: "up" } }),
      hostParams("ubuntu"),
    );
    expect(missing.status).toBe(400);

    const { res, data } = await createUpload({ remotePath: `/srv/a${String.fromCharCode(0)}b` });
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/NUL/);
  });

  it("returns 413 when the declared size already exceeds the limit", async () => {
    const { res } = await createUpload({ sizeBytes: 1024 * 1024 * 1024 + 1 });
    expect(res.status).toBe(413);
  });

  it("returns 429 once the user holds 4 live transfers", async () => {
    // Declared sizes, so the concurrency cap is what bites: an upload that
    // declares nothing has to reserve the whole per-file maximum.
    for (let i = 0; i < 4; i += 1) {
      const { res } = await createUpload({ sizeBytes: 1024 });
      expect(res.status).toBe(200);
    }
    const { res, data } = await createUpload({ sizeBytes: 1024 });
    expect(res.status).toBe(429);
    expect(data.error).toMatch(/too many concurrent/);
  });

  it("returns 507 when the global staging budget is spoken for", async () => {
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "1000";
    const first = await createUpload({ sizeBytes: 600 });
    expect(first.res.status).toBe(200);

    // Not one byte has been staged yet: only a reservation taken at create
    // time can catch this before the disk does.
    const { res, data } = await createUpload({ sizeBytes: 600 });
    expect(res.status).toBe(507);
    expect(data.error).toMatch(/staging is full/);
  });

  it("returns 507 when this account's staging budget is spoken for", async () => {
    process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "1000";
    expect((await createUpload({ sizeBytes: 600 })).res.status).toBe(200);
    const { res, data } = await createUpload({ sizeBytes: 600 });
    expect(res.status).toBe(507);
    expect(data.error).toMatch(/budget exhausted for this account/);
  });
});

describe("up path: stage, deliver, then the daemon pulls", () => {
  const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
  const digest = createHash("sha256").update(payload).digest("hex");

  it("walks create -> PUT content -> deliver -> GET -> DELETE", async () => {
    const { res: createRes, data: created } = await createUpload({
      name: "a.tar",
      sizeBytes: payload.byteLength,
      sha256: digest,
      mode: 0o644,
    });
    expect(createRes.status).toBe(200);
    expect(created).toEqual({ transferId: expect.any(String), status: "staged" });
    const transferId = created.transferId as string;

    const putRes = await PUT_CONTENT(
      binaryRequest("PUT", payload),
      transferParams("ubuntu", transferId),
    );
    const put = await extractJson(putRes);
    expect(putRes.status).toBe(200);
    expect(put).toEqual({
      transferId,
      status: "uploaded",
      receivedBytes: payload.byteLength,
      complete: true,
      sizeBytes: payload.byteLength,
      sha256: digest,
    });

    // The daemon can now fetch the staged bytes with its pull token.
    const agentRes = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content", {
        headers: {
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "pull",
          }),
        },
      }),
      agentParams(transferId),
    );
    expect(agentRes.status).toBe(200);
    expect(agentRes.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(Buffer.from(await agentRes.arrayBuffer())).toEqual(payload);

    vi.mocked(requestRemoteFile).mockResolvedValue({
      ok: true,
      action: "pull",
      result: { transferId, bytesWritten: payload.byteLength, path: "/srv/app/a.tar" },
    });
    const deliverRes = await POST_DELIVER(
      createMockRequest({ method: "POST" }),
      transferParams("ubuntu", transferId),
    );
    const deliver = await extractJson(deliverRes);
    expect(deliverRes.status).toBe(200);
    // `path` echoes where the daemon actually wrote, which can differ from
    // `remotePath` when the destination was an existing directory.
    expect(deliver).toEqual({
      transferId,
      status: "ready",
      bytesWritten: payload.byteLength,
      path: "/srv/app/a.tar",
    });

    const call = vi.mocked(requestRemoteFile).mock.calls[0][0];
    expect(call.action).toBe("pull");
    expect(call.args).toMatchObject({
      transferId,
      remotePath: "/srv/app/a.tar",
      // Carried so a directory destination keeps the source filename.
      name: "a.tar",
      sha256: digest,
      sizeBytes: payload.byteLength,
      mode: 0o644,
    });
    expect(typeof call.args?.transferToken).toBe("string");

    const statusRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(await extractJson(statusRes)).toEqual({
      transferId,
      direction: "up",
      status: "ready",
      sizeBytes: payload.byteLength,
      receivedBytes: payload.byteLength,
      sha256: digest,
      mode: 0o644,
      name: "a.tar",
      remotePath: "/srv/app/a.tar",
      error: null,
    });

    const deleteRes = await DELETE_TRANSFER(
      createMockRequest({ method: "DELETE" }),
      transferParams("ubuntu", transferId),
    );
    expect(await extractJson(deleteRes)).toEqual({ transferId, status: "cancelled" });
    // The bytes go with the record.
    expect(await fs.readdir(path.join(storageRoot, "remote-transfers"))).toEqual([]);

    const goneRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(goneRes.status).toBe(404);
  });

  it("refuses content whose sha256 does not match what was declared", async () => {
    const { data: created } = await createUpload({ sha256: "a".repeat(64) });
    const res = await PUT_CONTENT(
      binaryRequest("PUT", payload),
      transferParams("ubuntu", created.transferId),
    );
    const data = await extractJson(res);
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/sha256 mismatch/);
  });

  it("returns 413 when the staged body exceeds the configured maximum", async () => {
    const previous = process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES;
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "8";
    try {
      const { data: created } = await createUpload();
      const res = await PUT_CONTENT(
        binaryRequest("PUT", payload),
        transferParams("ubuntu", created.transferId),
      );
      expect(res.status).toBe(413);
    } finally {
      if (previous === undefined) delete process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES;
      else process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = previous;
    }
  });

  it("refuses to deliver a transfer whose content was never uploaded", async () => {
    const { data: created } = await createUpload();
    const res = await POST_DELIVER(
      createMockRequest({ method: "POST" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(res.status).toBe(409);
    expect(requestRemoteFile).not.toHaveBeenCalled();
  });

  it("records a daemon-side failure on the transfer instead of losing it", async () => {
    const { data: created } = await createUpload();
    await PUT_CONTENT(binaryRequest("PUT", payload), transferParams("ubuntu", created.transferId));

    vi.mocked(requestRemoteFile).mockResolvedValue({
      ok: false,
      reason: "remote_error",
      message: "EACCES: /srv/app/a.tar",
    });
    const res = await POST_DELIVER(
      createMockRequest({ method: "POST" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(await extractJson(res)).toEqual({
      transferId: created.transferId,
      status: "failed",
      error: "EACCES: /srv/app/a.tar",
    });

    const statusRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(await extractJson(statusRes)).toMatchObject({
      status: "failed",
      error: "EACCES: /srv/app/a.tar",
    });
  });

  it("maps an exhausted realtime budget to 429 and leaves the transfer deliverable", async () => {
    const { data: created } = await createUpload();
    await PUT_CONTENT(binaryRequest("PUT", payload), transferParams("ubuntu", created.transferId));

    vi.mocked(requestRemoteFile).mockResolvedValue({
      ok: false,
      reason: "too_many_inflight",
      message: "too many concurrent remote file transfers (limit 4); retry shortly",
    });
    const res = await POST_DELIVER(
      createMockRequest({ method: "POST" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(res.status).toBe(429);

    const statusRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(await extractJson(statusRes)).toMatchObject({ status: "uploaded" });
  });
});

describe("down path: the daemon pushes, then the CLI fetches", () => {
  const payload = Buffer.from("2026-09-06 log line\n");
  const digest = createHash("sha256").update(payload).digest("hex");

  async function createDownload() {
    // The daemon's `push` runs while POST /files is still open, so stage the
    // bytes from inside the mock exactly like the real sequence does.
    vi.mocked(requestRemoteFile).mockImplementation(async (opts: any) => {
      const transferId = opts.args.transferId as string;
      const agentRes = await AGENT_PUT_CONTENT(
        binaryRequest("PUT", payload, {
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "push",
          }),
        }),
        agentParams(transferId),
      );
      expect(agentRes.status).toBe(200);
      return {
        ok: true,
        action: "push",
        result: {
          transferId,
          sizeBytes: payload.byteLength,
          sha256: digest,
          mode: 0o640,
          name: "x.log",
        },
      };
    });

    const res = await POST(
      createMockRequest({
        method: "POST",
        body: { direction: "down", remotePath: "/var/log/x.log" },
      }),
      hostParams("ubuntu"),
    );
    return { res, data: await extractJson(res) };
  }

  it("returns ready once the daemon has pushed, then streams the bytes", async () => {
    const { res, data } = await createDownload();
    expect(res.status).toBe(200);
    // The client cannot verify what it is not told: answering with only
    // `{transferId, status}` turned its checksum and size checks into no-ops.
    expect(data).toEqual({
      transferId: expect.any(String),
      direction: "down",
      status: "ready",
      sizeBytes: payload.byteLength,
      receivedBytes: payload.byteLength,
      sha256: digest,
      mode: 0o640,
      name: "x.log",
      remotePath: "/var/log/x.log",
      error: null,
    });
    const transferId = data.transferId as string;

    const call = vi.mocked(requestRemoteFile).mock.calls[0][0];
    expect(call.action).toBe("push");
    expect(call.args).toMatchObject({ transferId, remotePath: "/var/log/x.log" });
    expect(typeof call.args?.transferToken).toBe("string");

    const statusRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(await extractJson(statusRes)).toEqual({
      transferId,
      direction: "down",
      status: "ready",
      sizeBytes: payload.byteLength,
      receivedBytes: payload.byteLength,
      sha256: digest,
      mode: 0o640,
      name: "x.log",
      remotePath: "/var/log/x.log",
      error: null,
    });

    const contentRes = await GET_CONTENT(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(contentRes.headers.get("etag")).toBe(`"${digest}"`);
    expect(Buffer.from(await contentRes.arrayBuffer())).toEqual(payload);
  });

  it("marks the transfer failed and reports the reason when the daemon says no", async () => {
    vi.mocked(requestRemoteFile).mockResolvedValue({
      ok: false,
      reason: "remote_error",
      message: "no such file: /var/log/x.log",
    });

    const res = await POST(
      createMockRequest({
        method: "POST",
        body: { direction: "down", remotePath: "/var/log/x.log" },
      }),
      hostParams("ubuntu"),
    );
    const data = await extractJson(res);
    expect(data).toMatchObject({ status: "failed", error: "no such file: /var/log/x.log" });

    const contentRes = await GET_CONTENT(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", data.transferId),
    );
    expect(contentRes.status).toBe(409);
  });

  it("refuses PUT on a download and GET content on an upload", async () => {
    const { data: down } = await createDownload();
    const putOnDown = await PUT_CONTENT(
      binaryRequest("PUT", payload),
      transferParams("ubuntu", down.transferId),
    );
    expect(putOnDown.status).toBe(409);

    vi.mocked(requestRemoteFile).mockReset();
    const { data: up } = await createUpload();
    const getOnUp = await GET_CONTENT(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", up.transferId),
    );
    expect(getOnUp.status).toBe(409);
  });

  it("reports the checksum it measured, not the one the daemon claimed", async () => {
    // The daemon hashes the source in a separate read from the one it streams.
    // On a file still being appended to those disagree, and only the staged
    // bytes are what this server will actually serve.
    const lie = createHash("sha256").update("a different file entirely").digest("hex");
    vi.mocked(requestRemoteFile).mockImplementation(async (opts: any) => {
      const transferId = opts.args.transferId as string;
      await AGENT_PUT_CONTENT(
        binaryRequest("PUT", payload, {
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "push",
          }),
        }),
        agentParams(transferId),
      );
      return {
        ok: true,
        action: "push",
        result: { transferId, sizeBytes: 999_999, sha256: lie, mode: 0o640, name: "x.log" },
      };
    });

    const res = await POST(
      createMockRequest({
        method: "POST",
        body: { direction: "down", remotePath: "/var/log/x.log" },
      }),
      hostParams("ubuntu"),
    );
    const data = await extractJson(res);
    expect(data.sha256).toBe(digest);
    expect(data.sizeBytes).toBe(payload.byteLength);
    // Only the two facts the bytes cannot reveal come from the daemon.
    expect(data.mode).toBe(0o640);
    expect(data.name).toBe("x.log");
  });

  it("keeps staged bytes reachable after the daemon goes offline", async () => {
    const { data } = await createDownload();
    const transferId = data.transferId as string;

    // The laptop sleeps in the window between the push and the CLI's fetch.
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);

    const statusRes = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(statusRes.status).toBe(200);

    const contentRes = await GET_CONTENT(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(contentRes.status).toBe(200);
    expect(Buffer.from(await contentRes.arrayBuffer())).toEqual(payload);

    // And the user can still reclaim the slot.
    const deleteRes = await DELETE_TRANSFER(
      createMockRequest({ method: "DELETE" }),
      transferParams("ubuntu", transferId),
    );
    expect(deleteRes.status).toBe(200);
  });

  it("does not let completed transfers exhaust the concurrency budget", async () => {
    // Six quick copies in a row. This used to 429 on the fifth and stay
    // locked for the whole TTL, because `ready` still counted as live.
    for (let i = 0; i < 6; i += 1) {
      const { res } = await createDownload();
      expect(res.status, `transfer ${i + 1} should not be throttled`).toBe(200);
    }
  });

  it("resumes a download from a byte offset with 206", async () => {
    const { data } = await createDownload();
    const transferId = data.transferId as string;

    const res = await GET_CONTENT(
      createMockRequest({ method: "GET", headers: { range: "bytes=6-" } }),
      transferParams("ubuntu", transferId),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toBe(
      `bytes 6-${payload.byteLength - 1}/${payload.byteLength}`,
    );
    expect(res.headers.get("content-length")).toBe(String(payload.byteLength - 6));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(payload.subarray(6));

    // A closed range works too, and still reports the whole size.
    const closed = await GET_CONTENT(
      createMockRequest({ method: "GET", headers: { range: "bytes=2-4" } }),
      transferParams("ubuntu", transferId),
    );
    expect(closed.status).toBe(206);
    expect(closed.headers.get("content-range")).toBe(`bytes 2-4/${payload.byteLength}`);
    expect(Buffer.from(await closed.arrayBuffer())).toEqual(payload.subarray(2, 5));
  });

  it("answers 416 for a range that starts past the staged bytes", async () => {
    const { data } = await createDownload();
    const res = await GET_CONTENT(
      createMockRequest({ method: "GET", headers: { range: `bytes=${payload.byteLength}-` } }),
      transferParams("ubuntu", data.transferId),
    );
    expect(res.status).toBe(416);
    // The client learns the real size from the 416 itself.
    expect(res.headers.get("content-range")).toBe(`bytes */${payload.byteLength}`);
  });

  it("lets the daemon stage a download one chunk at a time", async () => {
    vi.mocked(requestRemoteFile).mockImplementation(async (opts: any) => {
      const transferId = opts.args.transferId as string;
      for (let start = 0; start < payload.byteLength; start += 8) {
        const slice = payload.subarray(start, Math.min(start + 8, payload.byteLength));
        const chunkRes = await AGENT_PUT_CONTENT(
          binaryRequest("PUT", slice, {
            "content-range": `bytes ${start}-${start + slice.byteLength - 1}/${payload.byteLength}`,
            "x-conductor-transfer-token": signTransferToken({
              transferId,
              agentHost: "ubuntu",
              purpose: "push",
            }),
          }),
          agentParams(transferId),
        );
        const body = await extractJson(chunkRes);
        expect(chunkRes.status).toBe(200);
        expect(body.receivedBytes).toBe(start + slice.byteLength);
        expect(body.complete).toBe(start + slice.byteLength === payload.byteLength);
      }
      return { ok: true, action: "push", result: { transferId, mode: 0o640, name: "x.log" } };
    });

    const res = await POST(
      createMockRequest({
        method: "POST",
        body: { direction: "down", remotePath: "/var/log/x.log" },
      }),
      hostParams("ubuntu"),
    );
    const data = await extractJson(res);
    expect(data).toMatchObject({
      status: "ready",
      sizeBytes: payload.byteLength,
      receivedBytes: payload.byteLength,
      sha256: digest,
    });

    // The CLI reads the assembled file back, and it is byte-identical.
    const contentRes = await GET_CONTENT(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", data.transferId),
    );
    expect(Buffer.from(await contentRes.arrayBuffer())).toEqual(payload);
  });

});

describe("two-phase handoff for slow transfers", () => {
  const payload = Buffer.from("a large-ish file");
  const digest = createHash("sha256").update(payload).digest("hex");

  it("answers a slow download with 'requested' and goes ready when the daemon lands", async () => {
    // A 1 GiB push cannot finish inside an HTTP request: nginx cuts an idle
    // proxied response at 60s. So the route must answer early and let the
    // client poll, or every large transfer becomes a spurious 504.
    let settle: ((outcome: any) => void) | undefined;
    vi.mocked(requestRemoteFileDetached).mockImplementation(async (opts: any, onSettled: any) => {
      settle = async () => {
        const transferId = opts.args.transferId as string;
        await AGENT_PUT_CONTENT(
          binaryRequest("PUT", payload, {
            "x-conductor-transfer-token": signTransferToken({
              transferId,
              agentHost: "ubuntu",
              purpose: "push",
            }),
          }),
          agentParams(transferId),
        );
        onSettled({ ok: true, action: "push", result: { transferId, mode: 0o640, name: "x.log" } });
      };
      return { ok: false, reason: "pending", message: "daemon is still transferring" };
    });

    const res = await POST(
      createMockRequest({
        method: "POST",
        body: { direction: "down", remotePath: "/var/log/x.log" },
      }),
      hostParams("ubuntu"),
    );
    const data = await extractJson(res);
    expect(res.status).toBe(200);
    expect(data.status).toBe("requested");
    const transferId = data.transferId as string;

    // Polling before the daemon finishes must not look like success.
    let status = await extractJson(await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    ));
    expect(status.status).not.toBe("ready");

    await settle!(null);

    status = await extractJson(await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    ));
    expect(status.status).toBe("ready");
    expect(status.sha256).toBe(digest);
    expect(status.sizeBytes).toBe(payload.byteLength);
  });

  it("answers a slow delivery with 'delivering' and records the eventual failure", async () => {
    const { data: created } = await createUpload({
      name: "a.tar",
      sizeBytes: payload.byteLength,
      sha256: digest,
    });
    const transferId = created.transferId as string;
    await PUT_CONTENT(binaryRequest("PUT", payload), transferParams("ubuntu", transferId));

    let settle: ((outcome: any) => void) | undefined;
    vi.mocked(requestRemoteFileDetached).mockImplementation(async (_opts: any, onSettled: any) => {
      settle = onSettled;
      return { ok: false, reason: "pending", message: "daemon is still transferring" };
    });

    const deliverRes = await POST_DELIVER(
      createMockRequest({ method: "POST" }),
      transferParams("ubuntu", transferId),
    );
    expect(deliverRes.status).toBe(200);
    expect((await extractJson(deliverRes)).status).toBe("delivering");

    // A failure that arrives after the HTTP request is gone must still land on
    // the record, or the client polls a "delivering" transfer forever.
    settle!({ ok: false, reason: "remote_error", message: "disk full on ubuntu" });

    const status = await extractJson(await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    ));
    expect(status.status).toBe("failed");
    expect(status.error).toBe("disk full on ubuntu");
  });
});

describe("cross-tenant and daemon-facing guards", () => {
  it("hides another user's transfer behind a 404", async () => {
    const { data: created } = await createUpload();

    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ ...authedUser, id: "user-2" } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRemoteFile("ubuntu")]);
    const res = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", created.transferId),
    );
    expect(res.status).toBe(404);
  });

  it("pins a transfer to the host in its own URL", async () => {
    const { data: created } = await createUpload();
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRemoteFile("other-host")]);

    const res = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("other-host", created.transferId),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a daemon without a valid transfer token", async () => {
    const { data: created } = await createUpload();
    await PUT_CONTENT(
      binaryRequest("PUT", Buffer.from("abc")),
      transferParams("ubuntu", created.transferId),
    );

    const noToken = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content"),
      agentParams(created.transferId),
    );
    expect(noToken.status).toBe(404);

    // A push token must not unlock the pull route for the same transfer.
    const wrongPurpose = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content", {
        headers: {
          "x-conductor-transfer-token": signTransferToken({
            transferId: created.transferId,
            agentHost: "ubuntu",
            purpose: "push",
          }),
        },
      }),
      agentParams(created.transferId),
    );
    expect(wrongPurpose.status).toBe(404);
  });

  it("rejects an unauthenticated daemon", async () => {
    vi.mocked(authenticateAgentRequest).mockResolvedValue(null as any);
    const res = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content"),
      agentParams("whatever"),
    );
    expect(res.status).toBe(401);
  });
});

describe("chunked uploads over the wire", () => {
  const payload = Buffer.concat([
    Buffer.alloc(16, 0x41),
    Buffer.alloc(16, 0x42),
    Buffer.alloc(11, 0x43),
  ]);
  const digest = createHash("sha256").update(payload).digest("hex");

  const chunkRequest = (start: number, end: number, total = payload.byteLength) =>
    binaryRequest("PUT", payload.subarray(start, end), {
      "content-range": `bytes ${start}-${end - 1}/${total}`,
    });

  async function stagedUpload() {
    const { data } = await createUpload({ sizeBytes: payload.byteLength, sha256: digest });
    return data.transferId as string;
  }

  it("assembles three chunks and hashes the whole file at the end", async () => {
    const transferId = await stagedUpload();

    const first = await PUT_CONTENT(chunkRequest(0, 16), transferParams("ubuntu", transferId));
    expect(first.status).toBe(200);
    expect(await extractJson(first)).toEqual({
      transferId,
      status: "staged",
      receivedBytes: 16,
      complete: false,
    });

    // The status route is how a client that lost its cursor finds it again.
    const midway = await GET_TRANSFER(
      createMockRequest({ method: "GET" }),
      transferParams("ubuntu", transferId),
    );
    expect(await extractJson(midway)).toMatchObject({ status: "staged", receivedBytes: 16 });

    // ...and the daemon must not be able to pull a half-assembled file.
    const early = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content", {
        headers: {
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "pull",
          }),
        },
      }),
      agentParams(transferId),
    );
    expect(early.status).toBe(409);

    expect(await extractJson(
      await PUT_CONTENT(chunkRequest(16, 32), transferParams("ubuntu", transferId)),
    )).toMatchObject({ receivedBytes: 32, complete: false });

    const last = await PUT_CONTENT(
      chunkRequest(32, payload.byteLength),
      transferParams("ubuntu", transferId),
    );
    expect(last.status).toBe(200);
    expect(await extractJson(last)).toEqual({
      transferId,
      status: "uploaded",
      receivedBytes: payload.byteLength,
      complete: true,
      sizeBytes: payload.byteLength,
      sha256: digest,
    });

    // The assembled bytes are exactly the file the client declared.
    const pulled = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content", {
        headers: {
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "pull",
          }),
        },
      }),
      agentParams(transferId),
    );
    expect(pulled.status).toBe(200);
    expect(pulled.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await pulled.arrayBuffer())).toEqual(payload);

    // A daemon whose own `.part` already holds the first 32 bytes resumes
    // from there rather than re-downloading the file.
    const resumed = await AGENT_GET_CONTENT(
      new NextRequest("http://localhost:6152/api/agent/files/x/content", {
        headers: {
          range: "bytes=32-",
          "x-conductor-transfer-token": signTransferToken({
            transferId,
            agentHost: "ubuntu",
            purpose: "pull",
          }),
        },
      }),
      agentParams(transferId),
    );
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get("content-range")).toBe(`bytes 32-42/${payload.byteLength}`);
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(payload.subarray(32));
  });

  it("answers a chunk at the wrong offset with 409 and the real cursor", async () => {
    const transferId = await stagedUpload();
    await PUT_CONTENT(chunkRequest(0, 16), transferParams("ubuntu", transferId));

    const skipped = await PUT_CONTENT(chunkRequest(32, 43), transferParams("ubuntu", transferId));
    expect(skipped.status).toBe(409);
    expect(await extractJson(skipped)).toMatchObject({ receivedBytes: 16 });

    // A duplicate of a chunk already taken is the same story from the other side.
    const rewound = await PUT_CONTENT(chunkRequest(0, 16), transferParams("ubuntu", transferId));
    expect(rewound.status).toBe(409);
    expect(await extractJson(rewound)).toMatchObject({ receivedBytes: 16 });

    // Retrying from the reported offset finishes the transfer.
    await PUT_CONTENT(chunkRequest(16, 32), transferParams("ubuntu", transferId));
    const done = await PUT_CONTENT(
      chunkRequest(32, payload.byteLength),
      transferParams("ubuntu", transferId),
    );
    expect(await extractJson(done)).toMatchObject({ complete: true, sha256: digest });
  });

  it("rejects a total that contradicts the size declared at create time", async () => {
    const transferId = await stagedUpload();
    const res = await PUT_CONTENT(
      chunkRequest(0, 16, payload.byteLength + 100),
      transferParams("ubuntu", transferId),
    );
    expect(res.status).toBe(400);
    expect((await extractJson(res)).error).toMatch(/does not match the declared size/);
  });

  it("rejects a malformed Content-Range instead of guessing", async () => {
    const transferId = await stagedUpload();
    const res = await PUT_CONTENT(
      binaryRequest("PUT", payload.subarray(0, 16), { "content-range": "bytes 0-15/*" }),
      transferParams("ubuntu", transferId),
    );
    expect(res.status).toBe(400);
    expect((await extractJson(res)).error).toMatch(/Content-Range/);
  });

  it("returns 413 when the declared total exceeds the per-file maximum", async () => {
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "20";
    const { data } = await createUpload();
    const res = await PUT_CONTENT(
      chunkRequest(0, 16, 5000),
      transferParams("ubuntu", data.transferId),
    );
    expect(res.status).toBe(413);
  });
});
