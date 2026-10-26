import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../types";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";

const { listThreads, getThread } = vi.hoisted(() => ({ listThreads: vi.fn(), getThread: vi.fn() }));
vi.mock("../api/threads", () => ({ listThreads, getThread }));
import { useThreadStore } from "./threadStore";

function thread(id: string, parent: string | null = "parent", patch: Partial<Channel> = {}): Channel {
  return { id, name: `thread-${id}`, type: "thread", category_id: null, topic: null, position: 0, user_limit: 0,
    bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: parent, starter_message_id: `message-${id}`, ...patch };
}
const ok = (threads: Channel[]) => ({ success: true, data: { threads } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  const current = getAuthSessionSnapshot();
  publishAuthOwnerChange("thread-test-owner");
  publishAuthGenerationChange(current.generation + 1);
  useThreadStore.setState({ ownerId: "thread-test-owner", authGeneration: getAuthSessionSnapshot().generation,
    byID: {}, byParent: {}, loadedParents: {}, serverIdByThread: {}, statusByParent: {}, statusByThread: {} });
  listThreads.mockReset();
  getThread.mockReset();
});

describe("threadStore account and server provenance", () => {
  it.each(["refresh", "remove"] as const)("makes an invalidated deep-link request retryable after parent %s", async (action) => {
    const old = deferred<{ success: boolean; data: Channel }>();
    const retry = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(old.promise).mockReturnValueOnce(retry.promise);
    const first = useThreadStore.getState().loadThread("server-a", "deep");
    expect(useThreadStore.getState().statusByThread.deep).toBe("loading");
    if (action === "refresh") {
      listThreads.mockResolvedValueOnce(ok([thread("listed", "another-parent")]));
      await useThreadStore.getState().loadParent("server-a", "another-parent");
      expect(useThreadStore.getState().statusByThread.listed).toBe("ready");
    } else useThreadStore.getState().removeParent("another-parent", "server-a");
    expect(useThreadStore.getState().statusByThread.deep).toBe("error");
    const second = useThreadStore.getState().loadThread("server-a", "deep", true);
    expect(getThread).toHaveBeenCalledTimes(2);
    old.resolve({ success: true, data: thread("deep", "parent", { name: "obsolete" }) });
    await first;
    expect(useThreadStore.getState().statusByThread.deep).toBe("loading");
    expect(useThreadStore.getState().byID.deep).toBeUndefined();
    retry.resolve({ success: true, data: thread("deep", "parent", { name: "fresh" }) });
    await second;
    expect(useThreadStore.getState().statusByThread.deep).toBe("ready");
    expect(useThreadStore.getState().byID.deep.name).toBe("fresh");
  });

  it("requires a validated thread and explicit server provenance when remembering", () => {
    expect(useThreadStore.getState().ownerId).toBe("thread-test-owner");
    expect(useThreadStore.getState().authGeneration).toBe(getAuthSessionSnapshot().generation);
    const remember = useThreadStore.getState().remember;
    remember(thread("bad", null), "server-a");
    remember({ ...thread("not-thread"), type: "text" }, "server-a");
    remember(thread("missing-parent", null), "server-a");
    expect(useThreadStore.getState().byID).toEqual({});
    remember(thread("same-id"), "server-a");
    remember(thread("same-id", "other-parent", { archived_at: "2026-02-01" }), "server-b");
    expect(useThreadStore.getState().serverIdByThread).toEqual({ "same-id": "server-a" });
    expect(useThreadStore.getState().byID["same-id"].archived_at).toBeUndefined();
  });

  it("replaces a successful parent list and removes deleted thread records", async () => {
    listThreads.mockResolvedValueOnce(ok([thread("old")]));
    await useThreadStore.getState().loadParent("server-a", "parent");
    listThreads.mockResolvedValueOnce(ok([thread("new")]));
    await useThreadStore.getState().loadParent("server-a", "parent");
    const state = useThreadStore.getState();
    expect(state.byParent.parent.map((item) => item.id)).toEqual(["new"]);
    expect(state.byID.old).toBeUndefined();
    expect(state.serverIdByThread.old).toBeUndefined();
    expect(state.statusByParent[JSON.stringify(["server-a", "parent"])]).toBe("ready");
    expect(listThreads).toHaveBeenLastCalledWith("server-a", "parent", true, expect.objectContaining({ expectedUserId: "thread-test-owner", isCurrent: expect.any(Function) }));
  });

  it("records failed list refreshes without pretending the parent is ready", async () => {
    listThreads.mockResolvedValueOnce({ success: false, data: undefined });
    await useThreadStore.getState().loadParent("server-a", "parent");
    expect(useThreadStore.getState().statusByParent[JSON.stringify(["server-a", "parent"])]).toBe("error");
  });

  it("loads a deep-linked thread once, verifies its id/type/parent, and scopes the API request", async () => {
    getThread.mockResolvedValueOnce({ success: true, data: thread("deep-link") });
    await Promise.all([
      useThreadStore.getState().loadThread("server-a", "deep-link"),
      useThreadStore.getState().loadThread("server-a", "deep-link"),
    ]);
    expect(getThread).toHaveBeenCalledTimes(1);
    expect(getThread).toHaveBeenCalledWith("server-a", "deep-link", expect.objectContaining({ expectedUserId: "thread-test-owner", isCurrent: expect.any(Function) }));
    expect(useThreadStore.getState().byID["deep-link"]).toMatchObject({ id: "deep-link", type: "thread", parent_channel_id: "parent" });
    expect(useThreadStore.getState().serverIdByThread["deep-link"]).toBe("server-a");
    expect(useThreadStore.getState().statusByThread["deep-link"]).toBe("ready");
  });

  it("returns cached detail unless forced, then refreshes it while retaining singleflight", async () => {
    useThreadStore.getState().remember(thread("cached"), "server-a");
    await useThreadStore.getState().loadThread("server-a", "cached");
    expect(getThread).not.toHaveBeenCalled();
    const pending = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(pending.promise);
    const first = useThreadStore.getState().loadThread("server-a", "cached", true);
    const second = useThreadStore.getState().loadThread("server-a", "cached", true);
    expect(getThread).toHaveBeenCalledTimes(1);
    pending.resolve({ success: true, data: thread("cached", "parent", { archived_at: "2026-04-01" }) });
    await Promise.all([first, second]);
    expect(useThreadStore.getState().byID.cached.archived_at).toBe("2026-04-01");
  });

  it("records an API failure as error instead of reporting a loaded thread", async () => {
    getThread.mockResolvedValueOnce({ success: false, data: undefined });
    await useThreadStore.getState().loadThread("server-a", "unavailable");
    expect(useThreadStore.getState().byID.unavailable).toBeUndefined();
    expect(useThreadStore.getState().statusByThread.unavailable).toBe("error");
  });

  it.each([
    ["wrong id", thread("other")],
    ["wrong type", { ...thread("deep-link"), type: "text" }],
    ["missing parent", thread("deep-link", null)],
  ])("fails closed for a deep link with %s", async (_label, data) => {
    getThread.mockResolvedValueOnce({ success: true, data });
    await useThreadStore.getState().loadThread("server-a", "deep-link");
    expect(useThreadStore.getState().byID["deep-link"]).toBeUndefined();
    expect(useThreadStore.getState().statusByThread["deep-link"]).toBe("error");
  });

  it("does not let a removed thread or parent be resurrected by an in-flight deep-link fetch", async () => {
    const pendingThread = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(pendingThread.promise);
    const loadingThread = useThreadStore.getState().loadThread("server-a", "late-thread");
    useThreadStore.getState().remove("late-thread", "server-a");
    pendingThread.resolve({ success: true, data: thread("late-thread") });
    await loadingThread;
    expect(useThreadStore.getState().byID["late-thread"]).toBeUndefined();

    const pendingParent = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(pendingParent.promise);
    const loadingParentThread = useThreadStore.getState().loadThread("server-a", "parent-removed-thread");
    useThreadStore.getState().removeParent("parent", "server-a");
    pendingParent.resolve({ success: true, data: thread("parent-removed-thread") });
    await loadingParentThread;
    expect(useThreadStore.getState().byID["parent-removed-thread"]).toBeUndefined();
  });

  it("does not let a superseded detail success or failure overwrite a newer request status", async () => {
    const oldResponse = deferred<{ success: boolean; data: Channel }>();
    const newResponse = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const oldLoad = useThreadStore.getState().loadThread("server-a", "same-thread");
    useThreadStore.getState().remove("same-thread", "server-a");
    const newLoad = useThreadStore.getState().loadThread("server-a", "same-thread");
    oldResponse.resolve({ success: true, data: thread("same-thread") });
    await oldLoad;
    expect(useThreadStore.getState().statusByThread["same-thread"]).toBe("loading");
    newResponse.resolve({ success: true, data: thread("same-thread") });
    await newLoad;
    expect(useThreadStore.getState().statusByThread["same-thread"]).toBe("ready");

    const oldFailure = deferred<{ success: boolean; data: Channel }>();
    const latestResponse = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(oldFailure.promise).mockReturnValueOnce(latestResponse.promise);
    const staleLoad = useThreadStore.getState().loadThread("server-a", "failure-race");
    useThreadStore.getState().remove("failure-race", "server-a");
    const latestLoad = useThreadStore.getState().loadThread("server-a", "failure-race");
    oldFailure.reject(new Error("stale network failure"));
    await staleLoad;
    expect(useThreadStore.getState().statusByThread["failure-race"]).toBe("loading");
    latestResponse.resolve({ success: true, data: thread("failure-race") });
    await latestLoad;
    expect(useThreadStore.getState().statusByThread["failure-race"]).toBe("ready");
  });

  it("rejects a deep-link response after an auth generation change", async () => {
    const pending = deferred<{ success: boolean; data: Channel }>();
    getThread.mockReturnValueOnce(pending.promise);
    const loading = useThreadStore.getState().loadThread("server-a", "late-auth-thread");
    publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    pending.resolve({ success: true, data: thread("late-auth-thread") });
    await loading;
    expect(useThreadStore.getState().byID).toEqual({});
    expect(useThreadStore.getState().statusByThread).toEqual({});
  });

  it("does not remap a thread ID already attributed to another server", async () => {
    useThreadStore.getState().remember(thread("shared-id"), "server-a");
    listThreads.mockResolvedValueOnce(ok([thread("shared-id", "parent", { name: "foreign replacement" })]));
    await useThreadStore.getState().loadParent("server-b", "parent");
    expect(useThreadStore.getState().serverIdByThread["shared-id"]).toBe("server-a");
    expect(useThreadStore.getState().byID["shared-id"].name).toBe("thread-shared-id");
  });

  it.each(["owner", "generation"]) ("clears state and ignores an in-flight load after %s changes", async (change) => {
    const pending = deferred<ReturnType<typeof ok>>();
    listThreads.mockReturnValueOnce(pending.promise);
    const loading = useThreadStore.getState().loadParent("server-a", "parent");
    if (change === "owner") publishAuthOwnerChange("other-owner");
    else publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    pending.resolve(ok([thread("late")]));
    await loading;
    await Promise.resolve();
    await Promise.resolve();
    expect(useThreadStore.getState().byID).toEqual({});
    expect(useThreadStore.getState().statusByParent).toEqual({});
  });

  it("does not let a late list overwrite a newer remember/archive response", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    listThreads.mockReturnValueOnce(pending.promise);
    const loading = useThreadStore.getState().loadParent("server-a", "parent");
    const updated = thread("one", "parent", { archived_at: "2026-03-01" });
    useThreadStore.getState().remember(updated, "server-a");
    const refreshed = deferred<ReturnType<typeof ok>>();
    listThreads.mockReturnValueOnce(refreshed.promise);
    const refresh = useThreadStore.getState().loadParent("server-a", "parent");
    expect(listThreads).toHaveBeenCalledTimes(2);
    refreshed.resolve(ok([updated]));
    await refresh;
    pending.resolve(ok([thread("one")]));
    await loading;
    expect(useThreadStore.getState().byID.one.archived_at).toBe("2026-03-01");
    expect(useThreadStore.getState().statusByParent[JSON.stringify(["server-a", "parent"])]).toBe("ready");
  });

  it("scopes remove and removeParent to the mapped server and fences pending refreshes", async () => {
    useThreadStore.getState().remember(thread("from-a"), "server-a");
    useThreadStore.getState().remember(thread("from-b"), "server-b");
    useThreadStore.getState().remove("from-a", "server-b");
    expect(useThreadStore.getState().byID["from-a"]).toBeDefined();
    useThreadStore.getState().remove("from-a", "server-a");
    expect(useThreadStore.getState().byID["from-a"]).toBeUndefined();
    const pending = deferred<ReturnType<typeof ok>>();
    listThreads.mockReturnValueOnce(pending.promise);
    const loading = useThreadStore.getState().loadParent("server-b", "parent");
    useThreadStore.getState().removeParent("parent", "server-b");
    pending.resolve(ok([thread("resurrected")]));
    await loading;
    expect(useThreadStore.getState().byID["from-b"]).toBeUndefined();
    expect(useThreadStore.getState().byID.resurrected).toBeUndefined();
    expect(useThreadStore.getState().byParent.parent).toBeUndefined();
  });
});
