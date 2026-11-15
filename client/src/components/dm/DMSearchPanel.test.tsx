import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getAuthSessionOwner, publishAuthOwnerChange } from "../../api/authSessionEvents";
import DMSearchPanel from "./DMSearchPanel";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { getCachedDecryptedMessage, searchCachedDMMessages } from "../../crypto/keyStorage";

const openAtDMMessage = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../../hooks/useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtDMMessage }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === "searchResultCount" ? String(options?.count) : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../crypto/keyStorage", () => ({ searchCachedDMMessages: vi.fn(async () => []), getCachedDecryptedMessage: vi.fn() }));
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

it("reads only next-page records from the source-ordered encrypted search snapshot", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 30 }, (_, index) => ({
    messageId: `snapshot-${index + 1}`, channelId: "", dmChannelId: "dm", content: `match ${index + 1}`,
    timestamp: 100 - index, sourceSequence: String(index + 1),
  }));
  vi.mocked(searchCachedDMMessages).mockResolvedValueOnce(rows);
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText("match 30")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(searchCachedDMMessages).toHaveBeenCalledTimes(1);
  expect(vi.mocked(getCachedDecryptedMessage).mock.calls.map(([id]) => id)).toEqual(["snapshot-5", "snapshot-4", "snapshot-3", "snapshot-2", "snapshot-1"]);
  expect(screen.getByText("match 5")).toBeInTheDocument();
  expect(screen.queryByText("match 30")).not.toBeInTheDocument();
});

it("invalidates a pending encrypted search when the account owner changes", async () => {
  vi.useFakeTimers();
  const owner = getAuthSessionOwner();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  let resolve!: (rows: Awaited<ReturnType<typeof searchCachedDMMessages>>) => void;
  vi.mocked(searchCachedDMMessages).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old query" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => publishAuthOwnerChange("dm-search-next-owner"));
    await act(async () => resolve([{ messageId: "old", channelId: "", dmChannelId: "dm", content: "old private result", timestamp: 1 }]));
    expect(screen.queryByText("old private result")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  } finally { act(() => publishAuthOwnerChange(owner)); }
});

it("removes an off-page deleted DM from the snapshot before reading the next page", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 30 }, (_, index) => ({ messageId: `off-${index + 1}`, channelId: "", dmChannelId: "dm", content: `off match ${index + 1}`, timestamp: index + 1 }));
  vi.mocked(searchCachedDMMessages).mockResolvedValueOnce(rows);
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "off match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  act(() => useDMStore.setState({ lastDeletedDM: { id: "off-1", dm_channel_id: "dm" } }));
  expect(screen.getByText("29", { selector: ".search-count" })).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(getCachedDecryptedMessage).not.toHaveBeenCalledWith("off-1");
  expect(screen.queryByText("off match 1")).not.toBeInTheDocument();
  expect(searchCachedDMMessages).toHaveBeenCalledTimes(1);
});
