import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "./hub";

/**
 * These exercise the real hub wiring rather than a mocked `requestRemoteFile`:
 * request goes out over a registered agent connection, the daemon's reply is
 * fed back through `resolveRemoteFileResponse`, and the outcome mapping is
 * checked end to end.
 */
vi.mock("./hub", async () => {
  const actual = await vi.importActual<typeof import("./hub")>("./hub");
  const hub = new actual.RealtimeHub();
  return { ...actual, realtimeHub: hub };
});

const { realtimeHub } = await import("./hub");
const { requestRemoteFile } = await import("./remote-file");

function registerFakeDaemon(
  userId: string,
  host: string,
  onSend: (payload: any) => void,
) {
  const conn = {
    id: `conn-${host}`,
    kind: "agent" as const,
    userId,
    projectIds: [],
    host,
    capabilities: ["remote_file"],
    send: onSend,
    close: () => {},
  };
  (realtimeHub as RealtimeHub).register(conn);
  return conn;
}

describe("requestRemoteFile over the real hub", () => {
  it("delivers a pull request to the daemon and resolves with its write result", async () => {
    const sent: any[] = [];
    registerFakeDaemon("user-1", "ubuntu", (payload) => {
      sent.push(payload);
      queueMicrotask(() =>
        realtimeHub.resolveRemoteFileResponse(
          {
            request_id: payload.payload.request_id,
            action: "pull",
            result: { transferId: "t-1", bytesWritten: 42, path: "/srv/a.tar" },
            error: null,
          },
          "user-1",
          "ubuntu",
        ),
      );
    });

    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "ubuntu",
      action: "pull",
      args: { transferId: "t-1", transferToken: "tok", remotePath: "/srv/a.tar" },
      timeoutMs: 1_000,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("remote_file_request");
    expect(sent[0].payload.action).toBe("pull");
    expect(sent[0].payload.args).toEqual({
      transferId: "t-1",
      transferToken: "tok",
      remotePath: "/srv/a.tar",
    });
    expect(sent[0].payload.request_id).toBeTruthy();
    expect(outcome).toEqual({
      ok: true,
      action: "pull",
      result: { transferId: "t-1", bytesWritten: 42, path: "/srv/a.tar" },
    });
  });

  it("carries a push result back to the caller", async () => {
    registerFakeDaemon("user-1", "push-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteFileResponse(
          {
            request_id: payload.payload.request_id,
            action: "push",
            result: { transferId: "t-2", sizeBytes: 9, sha256: "abc", mode: 0o644, name: "x.log" },
          },
          "user-1",
          "push-host",
        ),
      );
    });

    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "push-host",
      action: "push",
      args: { transferId: "t-2", transferToken: "tok", remotePath: "/var/log/x.log" },
      timeoutMs: 1_000,
    });

    expect(outcome).toMatchObject({
      ok: true,
      action: "push",
      result: { sizeBytes: 9, sha256: "abc", name: "x.log" },
    });
  });

  it("maps a daemon-reported error to a remote_error outcome", async () => {
    registerFakeDaemon("user-1", "err-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteFileResponse(
          {
            request_id: payload.payload.request_id,
            action: "push",
            error: "no such file: /nope",
          },
          "user-1",
          "err-host",
        ),
      );
    });

    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "err-host",
      action: "push",
      args: { remotePath: "/nope" },
      timeoutMs: 1_000,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "remote_error",
      message: "no such file: /nope",
    });
  });

  it("reports agent_offline without waiting when the daemon is not connected", async () => {
    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "never-connected",
      action: "stat",
      args: { remotePath: "/tmp/x" },
      timeoutMs: 1_000,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "agent_offline",
      message: "daemon never-connected not connected",
    });
  });

  it("times out when the daemon never replies", async () => {
    registerFakeDaemon("user-1", "silent-host", () => {
      // Deliberately no reply.
    });

    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "silent-host",
      action: "stat",
      args: { remotePath: "/tmp/x" },
      timeoutMs: 20,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("fails fast when the daemon disconnects mid-transfer instead of waiting out the timeout", async () => {
    let conn: any;
    conn = {
      id: "conn-drop-host",
      kind: "agent" as const,
      userId: "user-1",
      projectIds: [],
      host: "drop-host",
      capabilities: ["remote_file"],
      // Simulate the socket dying the moment the request goes out.
      send: () => realtimeHub.unregister(conn.id),
      close: () => {},
    };
    (realtimeHub as RealtimeHub).register(conn);

    const started = Date.now();
    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "drop-host",
      action: "pull",
      args: { remotePath: "/srv/a.tar" },
      // The real default is 300s; a disconnect must not make anyone wait for it.
      timeoutMs: 300_000,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "agent_offline" });
    expect((outcome as { message: string }).message).toMatch(/disconnected before answering/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects further requests once a user has 4 in flight", async () => {
    registerFakeDaemon("cap-user", "cap-host", () => {
      // Never replies, so every request stays in flight.
    });

    const pending = Array.from({ length: 4 }, () =>
      requestRemoteFile({
        userId: "cap-user",
        agentHost: "cap-host",
        action: "pull",
        args: { remotePath: "/srv/a" },
        timeoutMs: 300,
      }),
    );

    const overflow = await requestRemoteFile({
      userId: "cap-user",
      agentHost: "cap-host",
      action: "pull",
      args: { remotePath: "/srv/a" },
      timeoutMs: 300,
    });
    expect(overflow).toMatchObject({ ok: false, reason: "too_many_inflight" });

    await Promise.all(pending);

    // Slots are released, so the next request is admitted again.
    const afterDrain = await requestRemoteFile({
      userId: "cap-user",
      agentHost: "cap-host",
      action: "pull",
      args: { remotePath: "/srv/a" },
      timeoutMs: 100,
    });
    expect(afterDrain).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("does not let one user's in-flight transfers block another user", async () => {
    registerFakeDaemon("noisy-user", "shared-host", () => {});
    registerFakeDaemon("quiet-user", "quiet-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteFileResponse(
          { request_id: payload.payload.request_id, action: "stat", result: { exists: true } },
          "quiet-user",
          "quiet-host",
        ),
      );
    });

    const noisy = Array.from({ length: 4 }, () =>
      requestRemoteFile({
        userId: "noisy-user",
        agentHost: "shared-host",
        action: "pull",
        args: { remotePath: "/srv/a" },
        timeoutMs: 300,
      }),
    );

    const outcome = await requestRemoteFile({
      userId: "quiet-user",
      agentHost: "quiet-host",
      action: "stat",
      args: { remotePath: "/tmp/x" },
      timeoutMs: 1_000,
    });
    expect(outcome).toMatchObject({ ok: true });

    await Promise.all(noisy);
  });

  it("ignores a reply forged by another user's daemon and times out instead", async () => {
    registerFakeDaemon("user-1", "victim-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteFileResponse(
          {
            request_id: payload.payload.request_id,
            action: "push",
            result: { hijacked: true },
          },
          "attacker",
          "victim-host",
        ),
      );
    });

    const outcome = await requestRemoteFile({
      userId: "user-1",
      agentHost: "victim-host",
      action: "push",
      args: { remotePath: "/etc/shadow" },
      timeoutMs: 20,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });
});
