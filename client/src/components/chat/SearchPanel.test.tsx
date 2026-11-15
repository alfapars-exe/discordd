/**
 * SearchPanel race regression tests (QA 2026-05-28 bug #6):
 *
 *   1. Out-of-order responses — a slow response for an abandoned query
 *      resolving AFTER the newer one must not clobber the newer results.
 *   2. Live deletion — a WS delete (messageStore.lastDeleted) while the
 *      panel is open removes the matching row from the result snapshot.
 *   3. Result click — onSelectResult resolving false (message gone on the
 *      server) drops the row WITHOUT a panel toast (the navigator toasts —
 *      one toast only); true leaves the snapshot alone.
 *
 * The real stores pull in the full crypto/i18n import graph, so every
 * store the panel touches is mocked with a minimal REAL zustand store —
 * selector subscriptions behave exactly like production, without the
 * import weight. Pattern matches memberStore.test.ts (mock the API
 * module, drive state through the store, assert on the rendered output).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === "searchResultCount" ? String(options?.count) : key,
    i18n: { language: "en" },
  }), initReactI18next: { type: "3rdParty", init: () => {} } }));

vi.mock("../../api/search", () => ({
  searchMessages: vi.fn(),
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
vi.mock("../../crypto/keyStorage", () => ({
  getCachedDecryptedMessage: vi.fn(),
}));

// e2ee disabled + not ready -> the panel takes the server-side FTS5 path.
vi.mock("../../stores/serverStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useServerStore: create(() => ({
      activeServerId: "srv-1",
      activeServer: { id: "srv-1", e2ee_enabled: false },
    })),
  };
});

vi.mock("../../stores/e2eeStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useE2EEStore: create(() => ({ initStatus: "uninitialized" })),
  };
});

vi.mock("../../stores/messageStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useMessageStore: create(() => ({
      messagesByChannel: {},
      lastDeleted: null as { id: string; channel_id: string } | null,
    })),
  };
});

vi.mock("../../stores/toastStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useToastStore: create(() => ({ addToast: vi.fn() })),
  };
});

vi.mock("../shared/Avatar", () => ({
  default: () => null,
}));

import { getAuthSessionOwner, publishAuthOwnerChange, getAuthSessionSnapshot, publishAuthGenerationChange } from "../../api/authSessionEvents";
import SearchPanel from "./SearchPanel";
import { searchMessages } from "../../api/search";
import { getCachedDecryptedMessage } from "../../crypto/keyStorage";
import { useMessageStore } from "../../stores/messageStore";
import { useServerStore } from "../../stores/serverStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import type { SearchResult } from "../../api/search";
import type { APIResponse, Message } from "../../types";

/** Same minimal Message shape SearchPanel itself builds for E2EE results. */
function makeMessage(id: string, content: string): Message {
  return {
    id,
    channel_id: "ch-1",
    user_id: "",
    content,
    created_at: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    reply_to_id: null,
    referenced_message: null,
    author: { id: "", username: "qa", display_name: null, avatar_url: null, status: "offline" as const, custom_status: null, created_at: "" },
    encryption_version: 1,
  };
}

/** Manually-resolvable promise — lets the test control response order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ok(messages: Message[]): APIResponse<SearchResult> {
  return { success: true, data: { messages, total_count: messages.length } };
}

beforeEach(() => {
  snapshotReferences.mockReset().mockResolvedValue([]);
  vi.mocked(getCachedDecryptedMessage).mockReset();
});

/** Type into the search box and advance past the 300ms debounce. */
function typeQuery(value: string) {
  const input = screen.getByPlaceholderText("searchPlaceholder");
  fireEvent.change(input, { target: { value } });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("SearchPanel — result races", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(searchMessages).mockReset();
    useMessageStore.setState({ lastDeleted: null });
  });

  afterEach(() => {
    act(() => {
      useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: false } });
      useE2EEStore.setState({ initStatus: "uninitialized" });
    });
    vi.useRealTimers();
  });

  it.each([
    ["uninitialized", "ch-1"],
    ["ready", undefined],
  ] as const)("keeps an encrypted search local when status is %s and channel is %s", async (initStatus, channelId) => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus });
    vi.mocked(searchMessages).mockResolvedValue(ok([]));
    render(<SearchPanel channelId={channelId} onClose={() => {}} />);
    typeQuery("private search");
    await act(async () => {});
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("clears an old account search before server state finishes resetting", async () => {
    const owner = getAuthSessionOwner();
    const pending = deferred<APIResponse<SearchResult>>();
    vi.mocked(searchMessages).mockResolvedValueOnce(ok([makeMessage("old", "old account visible")])).mockReturnValueOnce(pending.promise);
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    try {
      typeQuery("first");
      await act(async () => {});
      expect(screen.getByText("old account visible")).toBeInTheDocument();
      typeQuery("pending");
      act(() => publishAuthOwnerChange("channel-search-next-owner"));
      expect(screen.getByPlaceholderText("searchPlaceholder")).toHaveValue("");
      expect(screen.queryByText("old account visible")).not.toBeInTheDocument();
      await act(async () => pending.resolve(ok([makeMessage("late", "old account late")])));
      expect(screen.queryByText("old account late")).not.toBeInTheDocument();
    } finally { act(() => publishAuthOwnerChange(owner)); }
  });

  it("ignores an older response that resolves after a newer one", async () => {
    const older = deferred<APIResponse<SearchResult>>();
    const newer = deferred<APIResponse<SearchResult>>();
    vi.mocked(searchMessages)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    render(<SearchPanel onClose={() => {}} />);

    typeQuery("first");
    typeQuery("second");
    expect(vi.mocked(searchMessages)).toHaveBeenCalledTimes(2);

    // Newer request resolves first…
    await act(async () => {
      newer.resolve(ok([makeMessage("m-new", "newer result")]));
    });
    expect(screen.getByText("newer result")).toBeInTheDocument();

    // …then the stale one — it must not clobber the newer results.
    await act(async () => {
      older.resolve(ok([makeMessage("m-old", "older result")]));
    });
    expect(screen.queryByText("older result")).not.toBeInTheDocument();
    expect(screen.getByText("newer result")).toBeInTheDocument();
  });

  it("removes decrypted results and abandons an ongoing scan when keys become unavailable", async () => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus: "ready" });
    const row = { messageId: "id", channelId: "ch-1", dmChannelId: null, content: "private match", timestamp: 1 };
    const delayed = deferred<typeof row[]>();
    vi.mocked(snapshotReferences).mockResolvedValueOnce([{ messageId: row.messageId, timestamp: row.timestamp }]).mockReturnValueOnce(delayed.promise);
    vi.mocked(getCachedDecryptedMessage).mockResolvedValueOnce(row);
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("private");
    await act(async () => {});
    expect(screen.getByText(row.content)).toBeInTheDocument();
    act(() => useE2EEStore.setState({ initStatus: "uninitialized" }));
    expect(screen.queryByText(row.content)).not.toBeInTheDocument();
    act(() => useE2EEStore.setState({ initStatus: "ready" }));
    typeQuery("match");
    const signal = vi.mocked(snapshotReferences).mock.lastCall?.[2];
    act(() => useE2EEStore.setState({ initStatus: "uninitialized" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => delayed.resolve([row]));
    expect(screen.queryByText(row.content)).not.toBeInTheDocument();
  });

  it("clears the previous channel's results and ignores its pending response", async () => {
    const pending = deferred<APIResponse<SearchResult>>();
    vi.mocked(searchMessages)
      .mockResolvedValueOnce(ok([makeMessage("old", "previous channel")]))
      .mockReturnValueOnce(pending.promise);
    const view = render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("first");
    await act(async () => {});
    expect(screen.getByText("previous channel")).toBeInTheDocument();
    typeQuery("second");
    view.rerender(<SearchPanel channelId="ch-2" onClose={() => {}} />);
    expect(screen.queryByText("previous channel")).not.toBeInTheDocument();
    await act(async () => pending.resolve(ok([makeMessage("late", "previous response")])));
    expect(screen.queryByText("previous response")).not.toBeInTheDocument();
  });

  it("drops a result row when messageStore reports its live deletion", async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce(
      ok([makeMessage("m-x", "doomed row"), makeMessage("m-y", "surviving row")])
    );

    render(<SearchPanel onClose={() => {}} />);
    typeQuery("row");

    // Flush the resolved search promise.
    await act(async () => {});
    expect(screen.getByText("doomed row")).toBeInTheDocument();
    expect(screen.getByText("surviving row")).toBeInTheDocument();

    // WS delete arrives while the panel is open.
    act(() => {
      useMessageStore.setState({ lastDeleted: { id: "m-x", channel_id: "ch-1" } });
    });

    expect(screen.queryByText("doomed row")).not.toBeInTheDocument();
    expect(screen.getByText("surviving row")).toBeInTheDocument();
  });

  it("returns to a populated channel page after the final hit disappears", async () => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus: "ready" });
    const rows = Array.from({ length: 26 }, (_, i) => ({
      messageId: `last-${i}`, channelId: "ch-1", dmChannelId: null, content: `match ${i}`, timestamp: i,
    }));
    vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp }) => ({ messageId, timestamp })));
    vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => id === "last-0" ? null : rows.find(row => row.messageId === id) ?? null);
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("match");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "searchNext" }));
    await act(async () => {});
    expect(screen.getByText("25", { selector: ".search-count" })).toBeInTheDocument();
    expect(screen.getByText("match 25")).toBeInTheDocument();
    expect(screen.getByText("match 1")).toBeInTheDocument();
    expect(screen.queryByText("noSearchResults")).not.toBeInTheDocument();
  });

  it("prunes stale channel matches and fills the next page", async () => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus: "ready" });
    const rows = Array.from({ length: 52 }, (_, i) => ({
      messageId: `refill-${i}`, channelId: "ch-1", dmChannelId: null, content: `match ${i}`, timestamp: i,
    }));
    vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp }) => ({ messageId, timestamp })));
    vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => {
      if (id === "refill-26") return null;
      const row = rows.find(row => row.messageId === id);
      return row ? { ...row, content: id === "refill-25" ? "edited away" : row.content } : null;
    });
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("match");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "searchNext" }));
    await act(async () => {});
    expect(screen.getByText("50", { selector: ".search-count" })).toBeInTheDocument();
    expect(screen.getByText("match 24")).toBeInTheDocument();
    expect(screen.getByText("match 0")).toBeInTheDocument();
    expect(screen.queryByText("edited away")).not.toBeInTheDocument();
  });

  it("keeps a deleted result off subsequent local search pages", async () => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus: "ready" });
    const rows = Array.from({ length: 52 }, (_, i) => ({
      messageId: String(i), channelId: "ch-1", dmChannelId: null,
      content: `hit number ${i}`, timestamp: i,
    }));
    vi.mocked(snapshotReferences).mockClear().mockImplementation(async () => rows.map(({ messageId, timestamp }) => ({ messageId, timestamp })));
    vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("hit");
    await act(async () => {});
    await act(async () => { useMessageStore.setState({ lastDeleted: { id: "23", channel_id: "ch-1" } }); });
    fireEvent.click(screen.getByRole("button", { name: "searchNext" }));
    await act(async () => {});
    expect(screen.getByText("hit number 24")).toBeInTheDocument();
    expect(screen.queryByText("hit number 23")).not.toBeInTheDocument();
    expect(snapshotReferences).toHaveBeenCalledTimes(1);
  });

  it("returns to the last available page when its only local result is deleted", async () => {
    useServerStore.setState({ activeServer: { ...useServerStore.getState().activeServer!, e2ee_enabled: true } });
    useE2EEStore.setState({ initStatus: "ready" });
    const rows = Array.from({ length: 26 }, (_, i) => ({
      messageId: String(i), channelId: "ch-1", dmChannelId: null, content: `match ${i}`, timestamp: i,
    }));
    vi.mocked(snapshotReferences).mockResolvedValueOnce(rows.map(({ messageId, timestamp }) => ({ messageId, timestamp })));
    vi.mocked(getCachedDecryptedMessage).mockImplementation(async id => rows.find(row => row.messageId === id) ?? null);
    render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
    typeQuery("match");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "searchNext" }));
    await act(async () => {});
    expect(screen.getByText("match 0")).toBeInTheDocument();
    await act(async () => useMessageStore.setState({ lastDeleted: { id: "0", channel_id: "ch-1" } }));
    expect(screen.getByText("match 25")).toBeInTheDocument();
    expect(screen.queryByText("match 0")).not.toBeInTheDocument();
  });
});

describe("SearchPanel — result click", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(searchMessages).mockReset();
    vi.mocked(useToastStore.getState().addToast).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a deletion once when navigation and WebSocket report the same missing row", async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce(ok([makeMessage("a", "gone row"), makeMessage("b", "kept row")]));
    const navigation = deferred<boolean>();
    render(<SearchPanel channelId="ch-1" onClose={() => {}} onSelectResult={() => navigation.promise} />);
    typeQuery("row");
    await act(async () => {});
    fireEvent.click(screen.getByText("gone row"));
    await act(async () => { useMessageStore.setState({ lastDeleted: { id: "a", channel_id: "ch-1" } }); });
    await act(async () => navigation.resolve(false));
    expect(screen.getByText("1", { selector: ".search-count" })).toBeInTheDocument();
  });

  it("drops the row (no duplicate panel toast) when navigation reports the message gone", async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce(
      ok([makeMessage("m-gone", "gone row"), makeMessage("m-ok", "kept row")])
    );
    const onSelectResult = vi.fn(async (m: Message) => m.id !== "m-gone");

    render(<SearchPanel channelId="ch-1" onClose={() => {}} onSelectResult={onSelectResult} />);
    typeQuery("row");
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText("gone row"));
    });
    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ id: "m-gone" }));
    expect(screen.queryByText("gone row")).not.toBeInTheDocument();
    expect(screen.getByText("kept row")).toBeInTheDocument();

    // A successful navigation leaves the snapshot untouched.
    await act(async () => {
      fireEvent.click(screen.getByText("kept row"));
    });
    expect(screen.getByText("kept row")).toBeInTheDocument();
    // The panel itself never toasts — useOpenAtMessage owns that message.
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });
});

it.each(["cache reset","session replacement","device replacement","input clear"] as const)("clears visible encrypted results and disposes the index on %s", async mode => {
  vi.useFakeTimers();
  useServerStore.setState(state => ({ activeServerId: "srv-1", activeServer: { ...state.activeServer!, id: "srv-1", e2ee_enabled: true } }));
  useE2EEStore.setState({ initStatus: "ready" });
  snapshotReferences.mockResolvedValueOnce([{messageId:"owned",timestamp:1}]);
  vi.mocked(getCachedDecryptedMessage).mockResolvedValue({messageId:"owned",timestamp:1,channelId:"ch-1",dmChannelId:null,content:"owned private match"});
  render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
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

it("coalesces repeated deletion events while one index removal is pending", async () => {
  vi.useFakeTimers();
  useServerStore.setState(state=>({activeServerId:"srv-1",activeServer:{...state.activeServer!,id:"srv-1",e2ee_enabled:true}}));
  useE2EEStore.setState({initStatus:"ready"});
  const rows=Array.from({length:2},(_,i)=>({messageId:`duplicate-${i}`,timestamp:i,channelId:"ch-1",dmChannelId:null,content:`duplicate match ${i}`}));
  snapshotReferences.mockResolvedValueOnce(rows);
  vi.mocked(getCachedDecryptedMessage).mockImplementation(async id=>rows.find(item=>item.messageId===id)??null);
  const view=render(<SearchPanel channelId="ch-1" onClose={()=>{}}/>);
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
    await act(async()=>{for(let i=0;i<1000;i++){useMessageStore.setState({lastDeleted:{id:"duplicate-0",channel_id:"ch-1"}});}});
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

it("fails explicitly if a deletion arrives before native storage is available", async () => {
  vi.useFakeTimers();
  useServerStore.setState(state => ({ activeServerId: "srv-1", activeServer: { ...state.activeServer!, id: "srv-1", e2ee_enabled: true } }));
  useE2EEStore.setState({ initStatus: "ready" });
  const { openCachedSearchDeletionPool } = await import("../../crypto/cachedSearchDeletionSpool");
  const { fakeCachedSearchDeletionPool } = await import("../../test/fakeCachedSearchDeletionPool");
  let ready!: (pool: ReturnType<typeof fakeCachedSearchDeletionPool>) => void;
  vi.mocked(openCachedSearchDeletionPool).mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
  const pool = fakeCachedSearchDeletionPool();
  const view = render(<SearchPanel channelId="ch-1" onClose={() => {}} />);
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private" } });
    act(() => useMessageStore.setState({ lastDeleted: { id: "early", channel_id: "ch-1" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("searchFailed");
    await act(async () => { ready(pool); await vi.advanceTimersByTimeAsync(300); });
    expect(snapshotReferences).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("searchFailed");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByText("noSearchResults")).toBeInTheDocument();
  } finally { view.unmount(); vi.useRealTimers(); }
});

it("distinguishes a failed encrypted search from a successful empty query and recovers", async () => {
  vi.useFakeTimers();
  useServerStore.setState(state=>({activeServerId:"srv-1",activeServer:{...state.activeServer!,id:"srv-1",e2ee_enabled:true}}));
  useE2EEStore.setState({initStatus:"ready"});
  snapshotReferences.mockRejectedValueOnce(new DOMException("Storage unavailable","QuotaExceededError"));
  snapshotReferences.mockResolvedValueOnce([]);
  const view=render(<SearchPanel channelId="ch-1" onClose={()=>{}}/>);
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
