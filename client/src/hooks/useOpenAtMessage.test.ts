/**
 * useOpenAtMessage — ordering + failure contract:
 *
 *   1. channel: tab opens, the window is fetched around the target, and
 *      scrollToMessageId is armed only AFTER the fetch resolved true.
 *   2. channel: a missing message (fetch resolves false) toasts, never arms
 *      the scroll target, and resolves false.
 *   3. DM: mirrors (1) through dmStore; the self channel is labelled "My Notes".
 *
 * Every store is a minimal REAL zustand store so selector subscriptions
 * behave like production without the crypto/i18n import graph.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
const shell = vi.hoisted(() => ({ enabled: false }));
vi.mock("../utils/uiShell", () => ({ get UI_SHELL_V2() { return shell.enabled; } }));

vi.mock("react-i18next", () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string) => (ns ? `${ns}:${key}` : key),
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../stores/uiStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return { useUIStore: create(() => ({ openTab: vi.fn() })) };
});
vi.mock("../stores/serverStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useServerStore: create(() => ({
      servers: [{ id: "srv-2", name: "Other", icon_url: null }],
      activeServerId: "srv-1",
    })),
  };
});
vi.mock("../stores/channelStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useChannelStore: create(() => ({
      categories: [{ id: "cat", channels: [{ id: "ch-1", name: "genel" }] }],
      selectChannel: vi.fn(),
    })),
  };
});
vi.mock("../stores/messageStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useMessageStore: create(() => ({
      fetchAroundMessage: vi.fn(),
      setScrollToMessageId: vi.fn(),
    })),
  };
});
vi.mock("../stores/dmStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useDMStore: create(() => ({
      channels: [
        { id: "dm-1", other_user: { id: "u-2", username: "bob", display_name: null } },
        { id: "dm-self", other_user: { id: "me", username: "me", display_name: null } },
      ],
      selectDM: vi.fn(),
      fetchMessagesAround: vi.fn(),
      setScrollToMessageId: vi.fn(),
    })),
  };
});
vi.mock("../api/authSessionEvents",()=>({getAuthSessionSnapshot:()=>({ownerId:"me",generation:1})}));
vi.mock("../stores/e2eeStore",()=>({useE2EEStore:{getState:()=>({localDeviceId:"device"})}}));
vi.mock("../stores/groupDMStore", async()=>{
 const {create}=await vi.importActual<typeof import("zustand")>("zustand");
 return {useGroupDMStore:create(()=>({ownerId:"me",authGeneration:1,groupsReady:true,loading:false,groups:[{id:"group",name:"Group",key_epoch:3,members:[{id:"me"}]}],fetchMessagesAround:vi.fn(),setScrollTarget:vi.fn(()=>1)}))};
});
vi.mock("../stores/authStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return { useAuthStore: create(() => ({ user: { id: "me" } })) };
});
vi.mock("../stores/mobileStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return { useMobileStore: create(() => ({ closeAllDrawers: vi.fn() })) };
});
vi.mock("../stores/toastStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return { useToastStore: create(() => ({ addToast: vi.fn() })) };
});

import { useOpenAtMessage } from "./useOpenAtMessage";
import { useUIStore } from "../stores/uiStore";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useDMStore } from "../stores/dmStore";
import { useToastStore } from "../stores/toastStore";

const openTab = () => vi.mocked(useUIStore.getState().openTab);
const fetchAround = () => vi.mocked(useMessageStore.getState().fetchAroundMessage);
const setScroll = () => vi.mocked(useMessageStore.getState().setScrollToMessageId);
const addToast = () => vi.mocked(useToastStore.getState().addToast);

beforeEach(() => {
  vi.clearAllMocks();
  shell.enabled = false;
});

describe("useOpenAtMessage — channel", () => {
  it("honors caller lifetime before navigation and after a failed asynchronous fetch", async () => {
    let current = false;
    const view = renderHook(() => useOpenAtMessage());
    await expect(view.result.current.openAtMessage("srv-1", "ch-1", "m-7", "", { isCurrent: () => current })).resolves.toBe(false);
    expect(openTab()).not.toHaveBeenCalled();
    let finish!: (found: boolean) => void;
    fetchAround().mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    current = true;
    let pending!: Promise<boolean>;
    act(() => { pending = view.result.current.openAtMessage("srv-1", "ch-1", "m-7", "", { isCurrent: () => current }); });
    current = false;
    await act(async () => { finish(false); await pending; });
    expect(await pending).toBe(false);
    expect(setScroll()).not.toHaveBeenCalled();
    expect(addToast()).not.toHaveBeenCalled();
  });
  it("does not scroll another V2 destination when a slow message lookup finishes", async () => {
    shell.enabled = true;
    let finish!: (found: boolean) => void;
    openTab().mockImplementation((channelId, type, label, serverInfo) => {
      useUIStore.setState({ destination: { channelId, type, label, serverInfo }, navigationRevision: 1 });
    });
    fetchAround().mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useOpenAtMessage());
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.openAtMessage("srv-1", "ch-1", "m-7"); });
    useUIStore.setState({ destination: { type: "dm", channelId: "other", label: "" }, navigationRevision: 2 });
    await act(async () => { finish(true); await pending; });
    expect(setScroll()).not.toHaveBeenCalled();
  });
  it("opens the tab, fetches around the target, then arms the scroll target", async () => {
    const calls: string[] = [];
    openTab().mockImplementation(() => { calls.push("openTab"); });
    fetchAround().mockImplementation(async () => { calls.push("fetch"); return true; });
    setScroll().mockImplementation(() => { calls.push("scroll"); });

    const { result } = renderHook(() => useOpenAtMessage());
    let ok = false;
    await act(async () => {
      ok = await result.current.openAtMessage("srv-1", "ch-1", "m-7");
    });

    expect(ok).toBe(true);
    expect(calls).toEqual(["openTab", "fetch", "scroll"]);
    // Same server: channel selected + tab named from the channel tree.
    expect(useChannelStore.getState().selectChannel).toHaveBeenCalledWith("ch-1");
    expect(openTab()).toHaveBeenCalledWith("ch-1", "text", "genel", undefined);
    expect(fetchAround()).toHaveBeenCalledWith("srv-1", "ch-1", "m-7");
    expect(setScroll()).toHaveBeenCalledWith("m-7");
    expect(addToast()).not.toHaveBeenCalled();
  });

  it("carries serverInfo for a cross-server target and uses the given name", async () => {
    fetchAround().mockResolvedValue(true);
    const { result } = renderHook(() => useOpenAtMessage());
    await act(async () => {
      await result.current.openAtMessage("srv-2", "ch-9", "m-1", "duyuru");
    });
    expect(useChannelStore.getState().selectChannel).not.toHaveBeenCalled();
    expect(openTab()).toHaveBeenCalledWith("ch-9", "text", "duyuru", {
      serverId: "srv-2", serverName: "Other", serverIconUrl: null,
    });
  });

  it("toasts and resolves false when the message is gone, without arming the scroll", async () => {
    fetchAround().mockResolvedValue(false);
    const { result } = renderHook(() => useOpenAtMessage());
    let ok = true;
    await act(async () => {
      ok = await result.current.openAtMessage("srv-1", "ch-1", "m-gone");
    });
    expect(ok).toBe(false);
    expect(addToast()).toHaveBeenCalledWith("info", "saved:messageGone");
    expect(setScroll()).not.toHaveBeenCalled();
  });
});

describe("useOpenAtMessage — DM", () => {
  it("does not navigate with stale caller context, or scroll/toast after context expires during a fetch", async () => {
    let current=false; const dm=useDMStore.getState();const {result}=renderHook(()=>useOpenAtMessage());
    expect(await result.current.openAtDMMessage("dm-1","message",{isCurrent:()=>current})).toBe(false);
    expect(dm.selectDM).not.toHaveBeenCalled();
    current=true;let finish!:(value:boolean)=>void;
    vi.mocked(dm.fetchMessagesAround).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    let opening!:Promise<boolean>;
    act(()=>{opening=result.current.openAtDMMessage("dm-1","message",{isCurrent:()=>current});});
    current=false;finish(false);
    expect(await opening).toBe(false);expect(dm.setScrollToMessageId).not.toHaveBeenCalled();expect(addToast()).not.toHaveBeenCalled();
  });
  it("opens the DM tab and scrolls after the around-fetch", async () => {
    const dm = useDMStore.getState();
    vi.mocked(dm.fetchMessagesAround).mockResolvedValue(true);
    const { result } = renderHook(() => useOpenAtMessage());
    let ok = false;
    await act(async () => {
      ok = await result.current.openAtDMMessage("dm-1", "dm-m-3");
    });
    expect(ok).toBe(true);
    expect(dm.selectDM).toHaveBeenCalledWith("dm-1");
    expect(openTab()).toHaveBeenCalledWith("dm-1", "dm", "bob");
    expect(dm.setScrollToMessageId).toHaveBeenCalledWith("dm-m-3");
  });

  it("labels the self channel as My Notes", async () => {
    const dm = useDMStore.getState();
    vi.mocked(dm.fetchMessagesAround).mockResolvedValue(true);
    const { result } = renderHook(() => useOpenAtMessage());
    await act(async () => {
      await result.current.openAtDMMessage("dm-self", "dm-m-1");
    });
    expect(openTab()).toHaveBeenCalledWith("dm-self", "dm", "dm:myNotes");
  });
});

it("group exact-source opens main chat then fetches before arming scroll; late membership loss cannot arm it",async()=>{
 const group=useGroupDMStore.getState();vi.mocked(group.fetchMessagesAround).mockResolvedValueOnce(true);const {result}=renderHook(()=>useOpenAtMessage());
 expect(await result.current.openAtGroupMessage("group","source")).toBe(true);expect(group.setScrollTarget).toHaveBeenCalledWith("group","source");
 vi.mocked(group.setScrollTarget).mockClear();let finish!:(value:boolean)=>void;vi.mocked(group.fetchMessagesAround).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 const pending=result.current.openAtGroupMessage("group","source");useGroupDMStore.setState({groups:[]});finish(true);expect(await pending).toBe(false);expect(group.setScrollTarget).not.toHaveBeenCalled();
});
