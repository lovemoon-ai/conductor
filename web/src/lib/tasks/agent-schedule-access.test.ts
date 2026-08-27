import { describe, expect, it, vi } from "vitest";
import { createMockRequest } from "@/__tests__/helpers";
import {
  agentReadDenied,
  agentWriteDenied,
  isAgentActor,
  parseAgentScheduleAccess,
  readAgentScheduleAccessFromMetadata,
  resolveRequestScheduleAccess,
  setAgentScheduleAccessForTask,
} from "@/lib/tasks/agent-schedule-access";

describe("parse/read agent schedule access", () => {
  it("accepts only the three valid values", () => {
    expect(parseAgentScheduleAccess("full")).toBe("full");
    expect(parseAgentScheduleAccess("read_only")).toBe("read_only");
    expect(parseAgentScheduleAccess("blocked")).toBe("blocked");
    expect(parseAgentScheduleAccess("nonsense")).toBeNull();
    expect(parseAgentScheduleAccess(3)).toBeNull();
  });

  it("defaults to full for missing/invalid metadata", () => {
    expect(readAgentScheduleAccessFromMetadata(null)).toBe("full");
    expect(readAgentScheduleAccessFromMetadata("not json")).toBe("full");
    expect(readAgentScheduleAccessFromMetadata(JSON.stringify({}))).toBe("full");
    expect(
      readAgentScheduleAccessFromMetadata(JSON.stringify({ agentScheduleAccess: "blocked" })),
    ).toBe("blocked");
  });
});

describe("actor detection + denial", () => {
  it("detects the agent actor header case-insensitively", () => {
    expect(isAgentActor(createMockRequest({ headers: { "x-conductor-actor": "agent" } }))).toBe(true);
    expect(isAgentActor(createMockRequest({ headers: { "X-Conductor-Actor": "AGENT" } }))).toBe(true);
    expect(isAgentActor(createMockRequest({}))).toBe(false);
    expect(isAgentActor(createMockRequest({ headers: { "x-conductor-actor": "human" } }))).toBe(false);
  });

  it("denies writes for read_only and blocked, allows full", () => {
    expect(agentWriteDenied("full")).toBeNull();
    expect(agentWriteDenied("read_only")?.access).toBe("read_only");
    expect(agentWriteDenied("blocked")?.access).toBe("blocked");
  });

  it("denies reads only for blocked", () => {
    expect(agentReadDenied("full")).toBeNull();
    expect(agentReadDenied("read_only")).toBeNull();
    expect(agentReadDenied("blocked")?.access).toBe("blocked");
  });
});

describe("resolveRequestScheduleAccess", () => {
  it("returns not_agent for a request without the actor header", async () => {
    const client = { task: { findFirst: vi.fn() } };
    const access = await resolveRequestScheduleAccess({
      request: createMockRequest({}),
      userId: "u1",
      taskId: "t1",
      client: client as never,
    });
    expect(access).toBe("not_agent");
    expect(client.task.findFirst).not.toHaveBeenCalled();
  });

  it("returns the live task access for an agent request", async () => {
    const client = {
      task: {
        findFirst: vi.fn().mockResolvedValue({
          metadata: JSON.stringify({ agentScheduleAccess: "read_only" }),
        }),
      },
    };
    const access = await resolveRequestScheduleAccess({
      request: createMockRequest({ headers: { "x-conductor-actor": "agent" } }),
      userId: "u1",
      taskId: "t1",
      client: client as never,
    });
    expect(access).toBe("read_only");
  });
});

describe("setAgentScheduleAccessForTask", () => {
  it("returns null when the task is not owned by the user", async () => {
    const client = { task: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() } };
    const result = await setAgentScheduleAccessForTask({
      userId: "u1",
      taskId: "t1",
      access: "blocked",
      client: client as never,
    });
    expect(result).toBeNull();
    expect(client.task.update).not.toHaveBeenCalled();
  });

  it("merges the access into existing metadata", async () => {
    const client = {
      task: {
        findFirst: vi.fn().mockResolvedValue({ id: "t1", metadata: JSON.stringify({ keep: 1 }) }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const result = await setAgentScheduleAccessForTask({
      userId: "u1",
      taskId: "t1",
      access: "blocked",
      client: client as never,
    });
    expect(result).toBe("blocked");
    const data = client.task.update.mock.calls[0][0].data;
    expect(JSON.parse(data.metadata)).toEqual({ keep: 1, agentScheduleAccess: "blocked" });
  });
});
