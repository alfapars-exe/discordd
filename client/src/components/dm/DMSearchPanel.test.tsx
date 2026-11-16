import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getAuthSessionOwner, publishAuthOwnerChange, getAuthSessionSnapshot, publishAuthGenerationChange } from "../../api/authSessionEvents";
import DMSearchPanel from "./DMSearchPanel";
import type { DMMessage } from "../../types";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { getCachedDecryptedMessage } from "../../crypto/keyStorage";

const openAtDMMessage = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../../hooks/useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtDMMessage }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === "searchResultCount" ? String(options?.count) : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
const snapshotReferences = vi.hoisted(() => vi.fn(async (_channel: string, _query: string, _signal?: AbortSignal): Promise<{messageId:string;timestamp:number;sourceSequence?:string}[]> => []));
vi.mock("../../crypto/cachedSearchDeletionSpool", async () => {
  const { fakeCachedSearchDeletionPool } = await import("../../test/fakeCachedSearchDeletionPool");
  return { openCachedSearchDeletionPool: vi.fn(async () => fakeCachedSearchDeletionPool()) };
});
vi.mock("../../crypto/cachedSearchSnapshot", async () => {
  const { fakeCachedSearchSnapshot } = await import("../../test/fakeCachedSearchSnapshot");
  return { createCachedSearchSnapshot: vi.fn(async (kind: "channel" | "dm", channel: string, query: string, signal?: AbortSignal) =>
    fakeCachedSearchSnapshot(kind, await snapshotReferences(channel, query, signal))) };
});
vi.mock("../../crypto/keyStorage", () => ({ getCachedDecryptedMessage: vi.fn() }));
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
  expect(snapshotReferences).toHaveBeenCalledTimes(Number(local));
  expect(useDMStore.getState().searchMessages).toHaveBeenCalledTimes(Number(remote));
});

it("counts a missing DM once when deletion arrives during navigation", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = ["first", "second"].map(messageId => ({
    messageId, channelId: "", dmChannelId: "dm", content: messageId, timestamp: 1,
  }));
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp }) => ({ messageId, timestamp, sourceSequence: undefined })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  let finishNavigation!: (found: boolean) => void;
  openAtDMMessage.mockImplementationOnce(() => new Promise(resolve => { finishNavigation = resolve; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "s" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  fireEvent.click(screen.getByText("first"));
  await act(async () => { useDMStore.setState({ lastDeletedDM: { id: "first", dm_channel_id: "dm" } }); });
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
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(row => ({ messageId: row.messageId, timestamp: row.timestamp, sourceSequence: "sourceSequence" in row ? row.sourceSequence as string : undefined })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText("match 30")).toBeInTheDocument();
  expect(getCachedDecryptedMessage).toHaveBeenCalledTimes(25);
  vi.mocked(getCachedDecryptedMessage).mockClear();
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(snapshotReferences).toHaveBeenCalledTimes(1);
  expect(vi.mocked(getCachedDecryptedMessage).mock.calls.map(([id]) => id)).toEqual(["snapshot-5", "snapshot-4", "snapshot-3", "snapshot-2", "snapshot-1"]);
  expect(screen.getByText("match 5")).toBeInTheDocument();
  expect(screen.queryByText("match 30")).not.toBeInTheDocument();
});

it("invalidates a pending encrypted search when the account owner changes", async () => {
  vi.useFakeTimers();
  const owner = getAuthSessionOwner();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  let resolve!: (rows: Awaited<ReturnType<typeof snapshotReferences>>) => void;
  vi.mocked(snapshotReferences).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old query" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => publishAuthOwnerChange("dm-search-next-owner"));
    await act(async () => resolve([{ messageId: "old", timestamp: 1, sourceSequence: undefined }]));
    expect(screen.queryByText("old private result")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  } finally { act(() => publishAuthOwnerChange(owner)); }
});

it("removes an off-page deleted DM from the snapshot before reading the next page", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 30 }, (_, index) => ({ messageId: `off-${index + 1}`, channelId: "", dmChannelId: "dm", content: `off match ${index + 1}`, timestamp: index + 1 }));
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(row => ({ messageId: row.messageId, timestamp: row.timestamp, sourceSequence: "sourceSequence" in row ? row.sourceSequence as string : undefined })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "off match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { useDMStore.setState({ lastDeletedDM: { id: "off-1", dm_channel_id: "dm" } }); });
  expect(screen.getByText("29", { selector: ".search-count" })).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(getCachedDecryptedMessage).not.toHaveBeenCalledWith("off-1");
  expect(screen.queryByText("off match 1")).not.toBeInTheDocument();
  expect(snapshotReferences).toHaveBeenCalledTimes(1);
});

it("discards first-page content reads completed after an account switch", async () => {
  vi.useFakeTimers();
  const owner = getAuthSessionOwner();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  vi.mocked(snapshotReferences).mockResolvedValueOnce([{ messageId: "late", timestamp: 1, sourceSequence: undefined }]);
  let finish!: (row: Awaited<ReturnType<typeof getCachedDecryptedMessage>>) => void;
  vi.mocked(getCachedDecryptedMessage).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(getCachedDecryptedMessage).toHaveBeenCalledWith("late");
    act(() => publishAuthOwnerChange("dm-content-next-owner"));
    await act(async () => finish({ messageId: "late", channelId: "", dmChannelId: "dm", content: "private old-owner content", timestamp: 1 }));
    expect(screen.queryByText("private old-owner content")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  } finally { act(() => publishAuthOwnerChange(owner)); }
});

it("removes missing and edited-away hits and fills the first page from remaining references", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 27 }, (_, index) => ({
    messageId: `refill-${index + 1}`, timestamp: index + 1, sourceSequence: String(index + 1),
    channelId: "", dmChannelId: "dm", content: `match ${index + 1}`,
  }));
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp, sourceSequence }) => ({ messageId, timestamp, sourceSequence })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => {
    if (id === "refill-27") return null;
    const row = rows.find(row => row.messageId === id);
    return row ? { ...row, content: id === "refill-26" ? "edited away" : row.content } : null;
  });
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText("25", { selector: ".search-count" })).toBeInTheDocument();
  expect(screen.getByText("match 25")).toBeInTheDocument();
  expect(screen.getByText("match 1")).toBeInTheDocument();
  expect(screen.queryByText("edited away")).not.toBeInTheDocument();
  expect(getCachedDecryptedMessage).toHaveBeenCalledTimes(27);
  expect(snapshotReferences).toHaveBeenCalledTimes(1);
});

it("does not restore a DM deleted while its first-page cache read is pending", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  vi.mocked(snapshotReferences).mockResolvedValueOnce([{ messageId: "deleted-pending", timestamp: 1, sourceSequence: undefined }]);
  let finish!: (row: Awaited<ReturnType<typeof getCachedDecryptedMessage>>) => void;
  vi.mocked(getCachedDecryptedMessage).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "private" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { useDMStore.setState({ lastDeletedDM: { id: "deleted-pending", dm_channel_id: "dm" } }); });
  await act(async () => finish({ messageId: "deleted-pending", channelId: "", dmChannelId: "dm", content: "private deleted result", timestamp: 1 }));
  expect(screen.queryByText("private deleted result")).not.toBeInTheDocument();
  expect(screen.getByText("noSearchResults")).toBeInTheDocument();
});

it("returns to the last populated page when the final page's only hit disappears", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 26 }, (_, index) => ({
    messageId: `last-${index}`, channelId: "", dmChannelId: "dm", content: `match ${index}`,
    timestamp: index, sourceSequence: String(index + 1),
  }));
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp, sourceSequence }) => ({ messageId, timestamp, sourceSequence })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => id === "last-0" ? null : rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(screen.getByText("match 25")).toBeInTheDocument();
  expect(screen.getByText("match 1")).toBeInTheDocument();
  expect(screen.getByText("25", { selector: ".search-count" })).toBeInTheDocument();
  expect(screen.queryByText("noSearchResults")).not.toBeInTheDocument();
});

it("keeps a newer query snapshot intact when an older content read rejects its shared ID", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 30 }, (_, i) => ({
    messageId: i === 0 ? "shared-id" : `new-${i + 1}`, channelId: "", dmChannelId: "dm",
    content: `new match ${i + 1}`, timestamp: i, sourceSequence: String(i + 1),
  }));
  vi.mocked(snapshotReferences)
    .mockResolvedValueOnce([{ messageId: "shared-id", timestamp: 0, sourceSequence: undefined }])
    .mockResolvedValueOnce(rows.map(({ messageId, timestamp, sourceSequence }) => ({ messageId, timestamp, sourceSequence })));
  let finishOld!: (row: Awaited<ReturnType<typeof getCachedDecryptedMessage>>) => void;
  vi.mocked(getCachedDecryptedMessage)
    .mockImplementation(async id => rows.find(row => row.messageId === id) ?? null)
    .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "old" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText("new match 30")).toBeInTheDocument();
  await act(async () => finishOld(null));
  await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
  expect(screen.getByText("new match 1")).toBeInTheDocument();
  expect(screen.getByText("30", { selector: ".search-count" })).toBeInTheDocument();
});

it("fills the visible DM page after a live deletion without repeating the search scan", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 26 }, (_, i) => ({
    messageId: `live-${i}`, channelId: "", dmChannelId: "dm", content: `live match ${i}`,
    timestamp: i, sourceSequence: String(i + 1),
  }));
  vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp, sourceSequence }) => ({ messageId, timestamp, sourceSequence })));
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "live match" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.queryByText("live match 0")).not.toBeInTheDocument();
  await act(async () => useDMStore.setState({ lastDeletedDM: { id: "live-25", dm_channel_id: "dm" } }));
  expect(screen.getByText("live match 0")).toBeInTheDocument();
  expect(screen.queryByText("live match 25")).not.toBeInTheDocument();
  expect(screen.getByText("25", { selector: ".search-count" })).toBeInTheDocument();
  expect(snapshotReferences).toHaveBeenCalledTimes(1);
});

it.each(["cache reset","session replacement","device replacement","input clear"] as const)("clears visible encrypted results and disposes the index on %s", async mode => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })) }));
  useE2EEStore.setState({ initStatus: "ready" });
  snapshotReferences.mockResolvedValueOnce([{messageId:"owned",timestamp:1}]);
  vi.mocked(getCachedDecryptedMessage).mockResolvedValue({messageId:"owned",timestamp:1,channelId:"",dmChannelId:"dm",content:"owned private match"});
  render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"private match"}});
  await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
  expect(screen.getByText("owned private match")).toBeInTheDocument();
  const {createCachedSearchSnapshot}=await import("../../crypto/cachedSearchSnapshot");
  const index=await vi.mocked(createCachedSearchSnapshot).mock.results.at(-1)!.value;
  const {notifyCachedSearchReset}=await import("../../crypto/cachedSearchEpoch");
  const generation=getAuthSessionSnapshot().generation,device=useE2EEStore.getState().localDeviceId;
  try {
    if(mode==="session replacement")act(()=>publishAuthGenerationChange(generation+1));
    else if(mode==="device replacement")act(()=>useE2EEStore.setState({localDeviceId:"replacement-device"}));
    else if(mode==="input clear")fireEvent.change(screen.getByRole("textbox"),{target:{value:""}});
    else act(()=>notifyCachedSearchReset("fixture-source"));
    expect(screen.queryByText("owned private match")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    await expect(index.page(0,25)).rejects.toThrow("disposed");
  } finally {
    if(mode==="session replacement")act(()=>publishAuthGenerationChange(generation));
    if(mode==="device replacement")act(()=>useE2EEStore.setState({localDeviceId:device}));
  }
});

it("keeps counts monotonic when off-page deletion commits return out of order", async () => {
 vi.useFakeTimers();useDMStore.setState(state=>({channels:state.channels.map(c=>({...c,e2ee_enabled:true}))}));useE2EEStore.setState({initStatus:"ready"});
 const rows=Array.from({length:30},(_,i)=>({messageId:`order-${i}`,timestamp:i,sourceSequence:String(i+1),channelId:"",dmChannelId:"dm",content:`order match ${i}`}));
 snapshotReferences.mockResolvedValueOnce(rows);vi.mocked(getCachedDecryptedMessage).mockImplementation(async id=>rows.find(row=>row.messageId===id)??null);
 render(<DMSearchPanel channelId="dm" onClose={()=>{}}/>);fireEvent.change(screen.getByRole("textbox"),{target:{value:"order match"}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
 const {createCachedSearchSnapshot}=await import("../../crypto/cachedSearchSnapshot"),index=await vi.mocked(createCachedSearchSnapshot).mock.results.at(-1)!.value;
 const original=index.removeMany.bind(index);let first!:()=>void,second!:()=>void;
 const one=new Promise<void>(resolve=>{first=resolve;}),two=new Promise<void>(resolve=>{second=resolve;});
 const remove=vi.spyOn(index,"removeMany").mockImplementationOnce(async(...args)=>{const value=await original(...args);await one;return value;}).mockImplementationOnce(async(...args)=>{const value=await original(...args);await two;return value;});
 await act(async()=>{useDMStore.setState({lastDeletedDM:{id:"order-0",dm_channel_id:"dm"}});});
 await act(async()=>{useDMStore.setState({lastDeletedDM:{id:"order-1",dm_channel_id:"dm"}});});
 await act(async()=>second());expect(screen.getByText("searching")).toBeInTheDocument();
 expect(remove).toHaveBeenCalledTimes(1);
 await act(async()=>first());expect(screen.getByText("28",{selector:".search-count"})).toBeInTheDocument();
 expect(remove).toHaveBeenCalledTimes(2);
 expect(snapshotReferences).toHaveBeenCalledTimes(1);
});

it("coalesces repeated deletion events while one index removal is pending", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state=>({channels:state.channels.map(item=>({...item,e2ee_enabled:true}))}));
  useE2EEStore.setState({initStatus:"ready"});
  const rows=Array.from({length:2},(_,i)=>({messageId:`duplicate-${i}`,timestamp:i,channelId:"",dmChannelId:"dm",content:`duplicate match ${i}`}));
  snapshotReferences.mockResolvedValueOnce(rows);
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id=>rows.find(item=>item.messageId===id)??null);
  const view=render(<DMSearchPanel channelId="dm" onClose={()=>{}}/>);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  try {
    fireEvent.change(screen.getByRole("textbox"),{target:{value:"duplicate match"}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(screen.getByText("2",{selector:".search-count"})).toBeInTheDocument();
    const {createCachedSearchSnapshot}=await import("../../crypto/cachedSearchSnapshot");
    const index=await vi.mocked(createCachedSearchSnapshot).mock.results.at(-1)!.value;
    const original=index.removeMany.bind(index);
    const remove=vi.spyOn(index,"removeMany").mockImplementation(async(...args)=>{await gate;return original(...args);});
    await act(async()=>{for(let i=0;i<1000;i++){useDMStore.setState({lastDeletedDM:{id:"duplicate-0",dm_channel_id:"dm"}});}});
    expect(screen.queryByText("duplicate match 0")).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async()=>release());
    expect(screen.getByText("1",{selector:".search-count"})).toBeInTheDocument();
    expect(screen.getByText("duplicate match 1")).toBeInTheDocument();
  } finally {
    await act(async()=>release());
    view.unmount();vi.restoreAllMocks();vi.useRealTimers();
  }
});

it("distinguishes a failed encrypted search from a successful empty query and recovers", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state=>({channels:state.channels.map(c=>({...c,e2ee_enabled:true}))}));
  useE2EEStore.setState({initStatus:"ready"});
  snapshotReferences.mockRejectedValueOnce(new DOMException("Storage unavailable","QuotaExceededError"));
  snapshotReferences.mockResolvedValueOnce([]);
  const view=render(<DMSearchPanel channelId="dm" onClose={()=>{}}/>);
  try {
    fireEvent.change(screen.getByRole("textbox"),{target:{value:"first"}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(screen.getByRole("alert")).toHaveTextContent("searchFailed");
    expect(screen.queryByText("noSearchResults")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"),{target:{value:"second"}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("noSearchResults")).toBeInTheDocument();
  } finally {view.unmount();vi.useRealTimers();}
});


it.each(["replace", "clear", "owner"] as const)("discards a pending plaintext result after %s", async (change) => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: false })) }));
  const search = vi.mocked(useDMStore.getState().searchMessages);
  let finish!: (value: Awaited<ReturnType<typeof search>>) => void;
  search.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const owner = getAuthSessionOwner();
  const view = render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abandoned" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledWith("dm", "abandoned", 25, 0);
    if (change === "owner") act(() => publishAuthOwnerChange("plaintext-search-next-owner"));
    else fireEvent.change(screen.getByRole("textbox"), { target: { value: change === "clear" ? "" : "replacement" } });
    await act(async () => finish({ messages: [], total_count: 0 }));
    expect(screen.queryByText("noSearchResults")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue(change === "replace" ? "replacement" : "");
    if (change === "replace") {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(screen.getByText("noSearchResults")).toBeInTheDocument();
    }
  } finally {
    view.unmount();
    if (change === "owner") act(() => publishAuthOwnerChange(owner));
  }
});


it.each(["loaded", "found", "missing"] as const)("navigates plaintext search results when the selected message is %s", async (mode) => {
  vi.useFakeTimers();
  const message: DMMessage = {
    id: "selected", dm_channel_id: "dm", user_id: "peer", content: "selected result", created_at: "2026-11-16T00:00:00Z",
    edited_at: null, reply_to_id: null, is_pinned: false, attachments: [], reactions: [], referenced_message: null, encryption_version: 0,
    author: { id: "peer", username: "peer", display_name: null, avatar_url: null, status: "offline", custom_status: null, created_at: "" },
  };
  const scroll = vi.fn(), close = vi.fn();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: false })),
    messagesByChannel: { dm: mode === "loaded" ? [message] : [] }, setScrollToMessageId: scroll }));
  vi.mocked(useDMStore.getState().searchMessages).mockResolvedValueOnce({ messages: [message], total_count: 1 });
  if (mode !== "loaded") openAtDMMessage.mockResolvedValueOnce(mode === "found");
  const view = render(<DMSearchPanel channelId="dm" onClose={close} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "selected" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { fireEvent.click(screen.getByText("selected result")); });
    expect(scroll).toHaveBeenCalledTimes(Number(mode === "loaded"));
    if (mode === "loaded") expect(scroll).toHaveBeenCalledWith("selected");
    else expect(openAtDMMessage).toHaveBeenCalledWith("dm", "selected");
    expect(close).toHaveBeenCalledTimes(Number(mode !== "missing"));
    if (mode === "missing") {
      expect(screen.queryByText("selected result")).not.toBeInTheDocument();
      expect(screen.getByText("noSearchResults")).toBeInTheDocument();
    }
  } finally { view.unmount(); }
});

it("returns to the previous encrypted page without rebuilding its search snapshot", async () => {
  vi.useFakeTimers();
  useDMStore.setState(state => ({ channels: state.channels.map(c => ({ ...c, e2ee_enabled: true })), messagesByChannel: {} }));
  useE2EEStore.setState({ initStatus: "ready" });
  const rows = Array.from({ length: 30 }, (_, index) => ({ messageId: `previous-${index + 1}`, dmChannelId: "dm", channelId: "",
    content: `previous match ${index + 1}`, timestamp: index + 1, sourceSequence: String(index + 1) }));
  snapshotReferences.mockResolvedValueOnce(rows);
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
  const view = render(<DMSearchPanel channelId="dm" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "previous match" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { fireEvent.click(screen.getByText("searchNext")); });
    expect(screen.getByText("previous match 5")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText("searchPrev")); });
    expect(screen.getByText("previous match 30")).toBeInTheDocument();
    expect(screen.queryByText("previous match 5")).not.toBeInTheDocument();
    expect(snapshotReferences).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});
