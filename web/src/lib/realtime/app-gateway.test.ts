import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hub", () => ({
  realtimeHub: {
    sendToAgent: vi.fn(),
    hasAgentHost: vi.fn(),
    getTaskAgentHost: vi.fn(),
    getAgentsForUser: vi.fn().mockReturnValue([]),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
  },
}));

const { realtimeHub } = await import("./hub");
const {
  buildForwardPtyTransportSignalEnvelope,
  buildForwardTerminalEnvelope,
  buildPtyTransportSessionEnvelope,
  deliverTerminalAttachEnvelope,
  shouldRefreshPtyTransportSessionOnWriterGrant,
  shouldRevokePreviousWriterTransport,
} = await import("./app-gateway");

const originalPtyTransportPolicy = process.env.PTY_TRANSPORT_POLICY;

describe("app-gateway terminal attach delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPtyTransportPolicy === undefined) {
      delete process.env.PTY_TRANSPORT_POLICY;
      return;
    }
    process.env.PTY_TRANSPORT_POLICY = originalPtyTransportPolicy;
  });

  it("falls back to executionHost when the task binding was cleared during reconnect", () => {
    const envelope = {
      type: "terminal_attach",
      payload: {
        task_id: "task-pty-1",
      },
    };

    vi.mocked(realtimeHub.sendToAgent).mockReturnValue(false);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const delivered = deliverTerminalAttachEnvelope({
      userId: "user-1",
      taskId: "task-pty-1",
      executionHost: "daemon-reconnected",
      agentHost: "daemon-original",
      envelope,
    });

    expect(delivered).toBe(true);
    expect(realtimeHub.sendToAgent).toHaveBeenCalledWith("user-1", "task-pty-1", envelope);
    expect(realtimeHub.hasAgentHost).toHaveBeenCalledWith("daemon-reconnected", "user-1");
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-1", "daemon-reconnected", "user-1");
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith("user-1", "daemon-reconnected", envelope);
  });

  it("routes the attach envelope with the owning userId so a shared host name cannot cross tenants", () => {
    const envelope = { type: "terminal_attach", payload: { task_id: "task-pty-2" } };

    vi.mocked(realtimeHub.sendToAgent).mockReturnValue(true);

    const delivered = deliverTerminalAttachEnvelope({
      userId: "user-2",
      taskId: "task-pty-2",
      executionHost: "MacBook-Pro.local",
      agentHost: "MacBook-Pro.local",
      envelope,
    });

    expect(delivered).toBe(true);
    expect(realtimeHub.sendToAgent).toHaveBeenCalledWith("user-2", "task-pty-2", envelope);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
  });


  it("builds a relay PTY transport session envelope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T10:00:00.000Z"));
    process.env.PTY_TRANSPORT_POLICY = "relay_only";

    const envelope = buildPtyTransportSessionEnvelope({
      taskId: "task-pty-3",
      connectionId: "conn-1",
      writerConnectionId: "conn-1",
      sessionId: "transport-stable-1",
    });

    expect(envelope).toMatchObject({
      type: "pty_transport_session",
      payload: {
        task_id: "task-pty-3",
        session_id: "transport-stable-1",
        transport_policy: "relay_only",
        writer_connection_id: "conn-1",
        direct_candidate: false,
        issued_at: "2026-03-17T10:00:00.000Z",
        expires_at: "2026-03-17T10:00:30.000Z",
      },
    });
    expect("transport_state" in (envelope.payload as Record<string, unknown>)).toBe(false);
  });

  it("can force a fresh relay negotiation epoch in a PTY transport session envelope", () => {
    const envelope = buildPtyTransportSessionEnvelope({
      taskId: "task-pty-epoch-1",
      connectionId: "conn-writer-1",
      writerConnectionId: "conn-writer-1",
      sessionId: "transport-epoch-2",
      transportState: "relay",
    });

    expect(envelope).toMatchObject({
      type: "pty_transport_session",
      payload: {
        task_id: "task-pty-epoch-1",
        session_id: "transport-epoch-2",
        transport_state: "relay",
        writer_connection_id: "conn-writer-1",
      },
    });
  });

  it("forwards PTY transport signals with the originating app connection id", () => {
    const envelope = buildForwardPtyTransportSignalEnvelope(
      {
        task_id: "task-pty-9",
        session_id: "transport-1",
        signal_type: "direct_request",
      },
      "task-pty-9",
      "conn-app-1",
    );

    expect(envelope).toEqual({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-9",
        session_id: "transport-1",
        signal_type: "direct_request",
        connection_id: "conn-app-1",
      },
    });
  });

  it("adds PTY latency metadata when forwarding terminal_input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T09:45:00.000Z"));

    const envelope = buildForwardTerminalEnvelope(
      "terminal_input",
      {
        task_id: "task-pty-2",
        data: "ls\r",
        client_input_seq: 12,
        client_sent_at: "2026-03-17T09:44:59.900Z",
      },
      "task-pty-2",
    );

    expect(envelope).toEqual({
      type: "terminal_input",
      payload: {
        task_id: "task-pty-2",
        data: "ls\r",
        client_input_seq: 12,
        client_sent_at: "2026-03-17T09:44:59.900Z",
        server_received_at: "2026-03-17T09:45:00.000Z",
      },
    });

    vi.useRealTimers();
  });

  it("does not revoke previous writer transport when writer request was denied", () => {
    expect(
      shouldRevokePreviousWriterTransport({
        previousWriterConnectionId: "conn-writer-1",
        nextWriterConnectionId: "conn-writer-1",
        granted: false,
        requestedConnectionId: "conn-viewer-2",
      }),
    ).toBe(false);
  });

  it("revokes previous writer transport only after ownership actually changes", () => {
    expect(
      shouldRevokePreviousWriterTransport({
        previousWriterConnectionId: "conn-writer-1",
        nextWriterConnectionId: "conn-viewer-2",
        granted: true,
        requestedConnectionId: "conn-viewer-2",
      }),
    ).toBe(true);
  });

  it("refreshes the PTY direct negotiation epoch when writer ownership returns to a connection", () => {
    expect(
      shouldRefreshPtyTransportSessionOnWriterGrant({
        previousWriterConnectionId: "conn-writer-old",
        nextWriterConnectionId: "conn-writer-new",
        granted: true,
        requestedConnectionId: "conn-writer-new",
      }),
    ).toBe(true);
    expect(
      shouldRefreshPtyTransportSessionOnWriterGrant({
        previousWriterConnectionId: "conn-writer-new",
        nextWriterConnectionId: "conn-writer-new",
        granted: true,
        requestedConnectionId: "conn-writer-new",
      }),
    ).toBe(false);
    expect(
      shouldRefreshPtyTransportSessionOnWriterGrant({
        previousWriterConnectionId: "conn-writer-old",
        nextWriterConnectionId: "conn-writer-old",
        granted: false,
        requestedConnectionId: "conn-writer-new",
      }),
    ).toBe(false);
  });
});
