import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DMSearchPanel from "./DMSearchPanel";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { searchCachedDMMessages } from "../../crypto/keyStorage";

const openAtDMMessage = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../../hooks/useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtDMMessage }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === "searchResultCount" ? String(options?.count) : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../crypto/keyStorage", () => ({ searchCachedDMMessages: vi.fn(async () => []) }));
vi.mock("../../stores/dmStore", async () => {
  const { create } = await import("zustand");
  return { useDMStore: create(() => ({
    messagesByChannel: {},
    channels: [{ id: "dm", e2ee_enabled: true }],
    searchMessages: vi.fn(async () => ({ messages: [], total_count: 0 })),
  })) };
});
vi.mock("../../stores/e2eeStore", async () => {
  const { create } = await import("zustand");
  return { useE2EEStore: create(() => ({ initStatus: "uninitialized" })) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  [true, "uninitialized", false, false],
  [true, "ready", true, false],
  [false, "uninitialized", false, true],
] as const)("routes DM search for encryption=%s and keys=%s", async (encrypted, initStatus, local, remote) => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: encrypted })) }));
  useE2EEStore.setState({ initStatus });
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "private words" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(searchCachedDMMessages).toHaveBeenCalledTimes(Number(local));
  expect(useDMStore.getState().searchMessages).toHaveBeenCalledTimes(Number(remote));
});

it("counts a missing DM once when deletion arrives during navigation", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  vi.mocked(searchCachedDMMessages).mockResolvedValueOnce(["first", "second"].map(messageId => ({
    messageId, channelId: "", dmChannelId: "dm", content: messageId, timestamp: 1,
  })));
  let finishNavigation!: (found: boolean) => void;
  openAtDMMessage.mockImplementationOnce(() => new Promise(resolve => { finishNavigation = resolve; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "words" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  fireEvent.click(screen.getByText("first"));
  act(() => useDMStore.setState({ lastDeletedDM: { id: "first", dm_channel_id: "dm" } }));
  await act(async () => finishNavigation(false));
  expect(screen.getByText("1", { selector: ".search-count" })).toBeInTheDocument();
  expect(screen.getByText("second")).toBeInTheDocument();
});
