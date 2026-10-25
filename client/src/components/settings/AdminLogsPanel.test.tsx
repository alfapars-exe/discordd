import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminLogsPanel from "./AdminLogsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), health: vi.fn(), clear: vi.fn(), toast: vi.fn(), confirm: vi.fn(),
  t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock("../../api/admin", () => ({ listAppLogs: mocks.list, getAppLogHealth: mocks.health, clearAppLogs: mocks.clear }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (select: (state: unknown) => unknown) => select({ addToast: mocks.toast }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("../../utils/apiError", () => ({ showApiError: vi.fn() }));
vi.mock("../../utils/dateFormat", () => ({ formatDateTime: (value: string) => value }));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.list.mockResolvedValue({ success: true, data: { logs: [{ id: "one", level: "error", category: "client", message: "failed extraction", metadata: "{}", created_at: "2026-10-25T12:00:00+00:00", last_seen_at: "2026-10-25T12:00:01+00:00", occurrence_count: 3, request_id: "req-42", event_code: "MUSIC_NETWORK", component: "music" }], total: 1 } });
  mocks.health.mockResolvedValue({ success: true, data: { error_queue: 2, normal_queue: 1, error_capacity: 512, normal_capacity: 256, dropped_error: 1, dropped_warn: 2, dropped_info: 3, failed_events: 4, write_failures: 1, last_success_at: "2026-10-25T12:00:02Z", retention_days: 7 } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows correlation, grouped occurrences and storage loss with valid offset timestamps", async () => {
  render(<AdminLogsPanel />);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByText("req-42")).toBeInTheDocument();
  expect(screen.getByText(/platformLogsOccurrences/)).toHaveTextContent('"count":3');
  expect(screen.getByRole("status")).toHaveTextContent('"days":7');
  expect(screen.getByRole("status")).toHaveTextContent('"failed":4');
  expect(screen.getByText("2026-10-25T12:00:00+00:00")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "platformLogsCategoryClient" })).toBeInTheDocument();
});

it("sends exact correlation and date filters after debounce", async () => {
  render(<AdminLogsPanel />);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  fireEvent.change(screen.getByLabelText("platformLogsFilter_request_id"), { target: { value: "req-search" } });
  fireEvent.change(screen.getByLabelText("platformLogsFilter_event_code"), { target: { value: "PREVIEW_TIMEOUT" } });
  fireEvent.change(screen.getByLabelText("platformLogsFilter_component"), { target: { value: "link_preview" } });
  fireEvent.change(screen.getByLabelText("platformLogsFilter_from"), { target: { value: "2026-10-24T10:00" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: "req-search", event_code: "PREVIEW_TIMEOUT", component: "link_preview", from: new Date("2026-10-24T10:00").toISOString(), offset: 0 }));
});

it("still shows sink health when the log database request fails", async () => {
  mocks.list.mockRejectedValue(new Error("database unavailable"));
  render(<AdminLogsPanel />);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByRole("status")).toHaveTextContent("platformLogsLoss");
  expect(mocks.toast).toHaveBeenCalled();
});
