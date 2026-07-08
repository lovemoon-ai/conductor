import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DailyReportSettingsCard } from "./DailyReportSettingsCard";
import { useDailyReportsStore } from "../store";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({
  getApiClient: () => apiMocks,
}));

describe("DailyReportSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDailyReportsStore.setState({
      setting: null,
      currentReport: null,
      history: [],
      isLoadingSetting: false,
      isLoadingReport: false,
      isSavingSetting: false,
      isGenerating: false,
      error: null,
    });
    apiMocks.get.mockResolvedValue({
      enabled: true,
      timezone: "Asia/Shanghai",
      sendTimeLocal: "20:00",
      deliveryChannels: ["in_app"],
      nextRunAt: "2026-07-01T12:00:00.000Z",
      lastSentForDate: "2026-06-30",
      lastRunAt: null,
      lastError: null,
    });
    apiMocks.patch.mockResolvedValue({
      enabled: false,
      timezone: "Asia/Shanghai",
      sendTimeLocal: "20:00",
      deliveryChannels: ["in_app"],
      nextRunAt: null,
      lastSentForDate: "2026-06-30",
      lastRunAt: null,
      lastError: null,
    });
  });

  it("hydrates and renders the stored setting", async () => {
    render(<DailyReportSettingsCard />);

    expect(await screen.findByRole("heading", { name: "Daily Summary" })).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith("/user-preferences/daily-report");
    expect(screen.getByLabelText("Show Daily and auto-send")).toBeChecked();
    expect(screen.queryByLabelText("Send time")).toBeNull();
    expect(screen.queryByLabelText("Timezone")).toBeNull();
    expect(screen.getByText("2026-06-30")).toBeInTheDocument();
  });

  it("saves edited settings", async () => {
    render(<DailyReportSettingsCard />);

    const enabled = await screen.findByLabelText("Show Daily and auto-send");
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiMocks.patch).toHaveBeenCalledWith("/user-preferences/daily-report", {
        enabled: false,
        deliveryChannels: ["in_app"],
      });
    });
  });
});
