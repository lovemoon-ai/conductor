import { describe, expect, it } from "vitest";
import { signAttachmentTransferToken, verifyAttachmentTransferToken } from "./attachment-transfer-token";

describe("attachment transfer token", () => {
  it("binds a short-lived token to task, attachment, and target host", () => {
    const token = signAttachmentTransferToken({
      taskId: "task-1", attachmentId: "att-1", agentHost: "fire-a",
    });
    expect(verifyAttachmentTransferToken(token, {
      taskId: "task-1", attachmentId: "att-1", agentHost: "fire-a",
    })).toBe(true);
    expect(verifyAttachmentTransferToken(token, {
      taskId: "task-1", attachmentId: "att-1", agentHost: "fire-b",
    })).toBe(false);
  });
});
