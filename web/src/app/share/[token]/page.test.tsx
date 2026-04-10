import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharedTaskPage from "./page";

const fetchMock = vi.fn();
const paramsState = { token: "shared-token-1" };
const writeTextMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => paramsState,
}));

vi.mock("@/features/chat", () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => (
    <div data-testid="message-bubble">{message.content}</div>
  ),
}));

describe("SharedTaskPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  it("shows the expiration notice for shared links", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        task: {
          title: "Shared Task",
          status: "completed",
          taskType: "ai_task",
          createdAt: "2026-04-10T12:00:00.000Z",
          expiresAt: "2026-04-17T12:00:00.000Z",
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "hello",
            createdAt: "2026-04-10T12:01:00.000Z",
          },
        ],
      }),
    });

    render(<SharedTaskPage />);

    expect(await screen.findByText("Shared Task")).toBeInTheDocument();
    expect(screen.getByText("Shared conversation · 2026/4/10 · Expires 2026/4/17")).toBeInTheDocument();
    expect(screen.getByTestId("message-bubble")).toHaveTextContent("hello");
    expect(screen.getByRole("button", { name: "Share for AI" })).toBeInTheDocument();
  });

  it("shows an expired error when the API returns 410", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 410,
    });

    render(<SharedTaskPage />);

    expect(await screen.findByText("This shared link has expired.")).toBeInTheDocument();
  });

  it("copies a plain text link for AI tools", async () => {
    writeTextMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        task: {
          title: "Shared Task",
          status: "completed",
          taskType: "ai_task",
          createdAt: "2026-04-10T12:00:00.000Z",
          expiresAt: "2026-04-17T12:00:00.000Z",
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Question one",
            createdAt: "2026-04-10T12:01:00.000Z",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Answer one",
            createdAt: "2026-04-10T12:02:00.000Z",
          },
        ],
      }),
    });

    render(<SharedTaskPage />);

    await screen.findByText("Shared Task");

    fireEvent.click(screen.getByRole("button", { name: "Share for AI" }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("http://localhost:3000/share/shared-token-1/plain");
    });
    expect(screen.getByRole("button", { name: "AI link copied" })).toBeInTheDocument();
  });
});
