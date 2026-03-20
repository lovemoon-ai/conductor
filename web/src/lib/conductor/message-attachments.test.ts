import { describe, expect, it, vi } from "vitest";

import { getMessageAttachments } from "./message-attachments";

describe("message attachments", () => {
  it("filters expired attachments out of message responses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T03:00:00.000Z"));

    const attachments = getMessageAttachments({
      attachments: [
        {
          id: "att-1",
          name: "fresh.png",
          mimeType: "image/png",
          sizeBytes: 10,
          kind: "image",
          downloadUrl: "/api/tasks/task-1/attachments/att-1",
          expiresAt: "2026-03-11T03:05:00.000Z",
        },
        {
          id: "att-2",
          name: "expired.png",
          mimeType: "image/png",
          sizeBytes: 11,
          kind: "image",
          downloadUrl: "/api/tasks/task-1/attachments/att-2",
          expiresAt: "2026-03-11T02:59:00.000Z",
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe("att-1");

    vi.useRealTimers();
  });
});
