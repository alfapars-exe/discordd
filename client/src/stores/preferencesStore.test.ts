import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { APIResponse } from "../types";
import type { UserPreferencesResponse } from "../api/preferences";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), theme: vi.fn(), appearance: vi.fn(), sidebar: vi.fn(), voice: vi.fn(), accessibility: vi.fn(),
  resets: [vi.fn(), vi.fn(), vi.fn(), vi.fn()],
}));
vi.mock("../api/preferences", () => ({ getPreferences: mocks.get, updatePreferences: mocks.update }));
vi.mock("../utils/constants", () => ({ SERVER_URL: "https://one.example" }));
vi.mock("./settingsStore", () => ({ useSettingsStore: { getState: () => ({ applyFromServer: mocks.theme, applyAppearanceFromServer: mocks.appearance, resetAccountPreferences: mocks.resets[0] }) } }));
vi.mock("./sidebarStore", () => ({ useSidebarStore: { getState: () => ({ applyFromServer: mocks.sidebar, resetAccountPreferences: mocks.resets[1] }) } }));
vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => ({ applyFromServer: mocks.voice, resetAccountPreferences: mocks.resets[2] }) } }));
vi.mock("./accessibilityStore", () => ({ useAccessibilityStore: { getState: () => ({ applyFromServer: mocks.accessibility, resetAccountPreferences: mocks.resets[3] }) } }));
import { usePreferencesStore } from "./preferencesStore";
import { bindPreferencePresenter } from "./preferencePresenter";

type Response = APIResponse<UserPreferencesResponse>;
function ok(data: Record<string, unknown> = {}, user_id = "alice"): Response {
  return { success: true, data: { user_id, data, updated_at: "2026-10-23" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const state = () => usePreferencesStore.getState();
const pendingKey = "hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice";
const snapshotKey = "hichat.preferences.snapshot.v1:https%3A%2F%2Fone.example:alice";
const legacyBackupKey = "hichat.preferences.legacy-presentation.v1";
const legacyImportKey = "hichat.preferences.legacy-imported.v1:https%3A%2F%2Fone.example:alice";
async function settle() { await vi.dynamicImportSettled(); }
async function ready(data: Record<string, unknown> = {}) {
  mocks.get.mockResolvedValue(ok(data));
  state().bindAccount("alice");
  await state().fetchAndApply();
}

describe("account-scoped preference synchronization", () => {
  beforeEach(() => {
    state().reset();
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.get.mockResolvedValue(ok());
    mocks.update.mockResolvedValue({ success: true });
  });
  afterEach(async () => {
    state().reset();
    await settle();
    vi.useRealTimers();
  });


  it.each([false,true])("does not replay an acknowledged PATCH after presentation fails (newer pending=%s)", async newer => {
    await ready();
    const {applyAccountPreferences}=await import("./applyAccountPreferences");
    let reject!: (error:Error)=>void;
    bindPreferencePresenter(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    try {
      state().set({theme:"accepted"});
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.update).toHaveBeenCalledTimes(1);
      if(newer)state().set({appearance:{uiScale:130}});
      reject(new Error("local presenter unavailable"));await settle();
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().hasPendingChanges).toBe(newer);
      expect(localStorage.getItem(pendingKey)).toBe(newer?JSON.stringify({appearance:{uiScale:130}}):null);
      expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({theme:"accepted"});
      bindPreferencePresenter(async()=>applyAccountPreferences);
      await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(newer?2:1);
      if(newer)expect(mocks.update.mock.calls[1][0]).toEqual({appearance:{uiScale:130}});
      expect(mocks.theme).toHaveBeenLastCalledWith("accepted");
      expect(state().syncStatus).toBe("saved");
      expect(state().hasPendingChanges).toBe(false);
    }finally{bindPreferencePresenter(async()=>applyAccountPreferences);}
  });
  it("keeps acknowledged edits out of the queue when local presentation retry also fails", async()=>{
    await ready();
    const {applyAccountPreferences}=await import("./applyAccountPreferences");
    const failed=deferred<typeof applyAccountPreferences>();
    bindPreferencePresenter(()=>failed.promise);
    try {
      state().set({theme:"accepted"});await vi.advanceTimersByTimeAsync(1000);
      state().set({appearance:{uiScale:130}});
      failed.reject(new Error("local presenter still unavailable"));await settle();
      await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().hasPendingChanges).toBe(true);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({appearance:{uiScale:130}});
      bindPreferencePresenter(async()=>applyAccountPreferences);
      await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(2);
      expect(mocks.update.mock.calls[1][0]).toEqual({appearance:{uiScale:130}});
    }finally{bindPreferencePresenter(async()=>applyAccountPreferences);}
  });

  it("fences a pending presentation retry when the account changes",async()=>{
    await ready();
    const {applyAccountPreferences}=await import("./applyAccountPreferences");
    bindPreferencePresenter(async()=>{throw new Error("local presenter unavailable");});
    const loader=deferred<typeof applyAccountPreferences>();
    try {
      state().set({theme:"alice-accepted"});await vi.advanceTimersByTimeAsync(1000);
      expect(state().syncError).toBe("preferences_apply_failed");
      bindPreferencePresenter(()=>loader.promise);
      const retry=state().retrySync();
      state().bindAccount("bob");state().set({theme:"bob-pending"});
      loader.resolve(applyAccountPreferences);await retry;await settle();
      expect(state().accountId).toBe("bob");
      expect(state().data).toEqual({theme:"bob-pending"});
      expect(state().syncStatus).toBe("pending");
      expect(state().hasPendingChanges).toBe(true);
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.theme).not.toHaveBeenCalledWith("alice-accepted");
    }finally{loader.resolve(applyAccountPreferences);bindPreferencePresenter(async()=>applyAccountPreferences);}
  });

  it.each([
    { boundary: "owner", publication: "sync", owner: "bob", backend: undefined },
    { boundary: "backend", publication: "sync", owner: "alice", backend: "https://two.example" },
    { boundary: "owner", publication: "microtask", owner: "bob", backend: undefined },
    { boundary: "backend", publication: "microtask", owner: "alice", backend: "https://two.example" },
  ] as const)("retires a presentation retry after $boundary replacement during $publication publication", async ({ publication, owner, backend }) => {
    await ready();
    const { applyAccountPreferences } = await import("./applyAccountPreferences");
    bindPreferencePresenter(async () => { throw new Error("presentation unavailable"); });
    let stop = () => {};
    try {
      state().set({ theme: "alice-accepted" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(state().syncError).toBe("preferences_apply_failed");
      bindPreferencePresenter(async () => applyAccountPreferences);
      mocks.get.mockClear();
      stop = usePreferencesStore.subscribe(next => {
        if (next.syncStatus !== "saved") return;
        stop();
        const replace = () => {
          state().bindAccount(owner, backend);
          state().set({ theme: "replacement-pending" });
        };
        if (publication === "sync") replace();
        else void Promise.resolve().then(replace);
      });
      await state().retrySync();
      await settle();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(state().accountId).toBe(owner);
      expect(state().data).toEqual({ theme: "replacement-pending" });
      expect(state().isLoaded).toBe(false);
      expect(state().syncStatus).toBe("pending");
    } finally { stop(); bindPreferencePresenter(async () => applyAccountPreferences); }
  });

  it.each(["loader","application"] as const)("recovers failed initial preference presentation without rebinding (%s)",async phase=>{
    const {applyAccountPreferences}=await import("./applyAccountPreferences");
    bindPreferencePresenter(async()=>{
      if(phase==="loader")throw new Error("presenter chunk unavailable");
      return ()=>{throw new Error("local application unavailable");};
    });
    try {
      state().bindAccount("alice");state().set({theme:"queued-before-load"});
      await state().fetchAndApply();
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().isLoaded).toBe(false);
      await state().retrySync();
      expect(mocks.get).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();
      expect(state().hasPendingChanges).toBe(true);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({theme:"queued-before-load"});
      bindPreferencePresenter(async()=>applyAccountPreferences);
      await state().retrySync();
      expect(mocks.get).toHaveBeenCalledTimes(1);expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0]).toEqual({theme:"queued-before-load"});
      expect(state().syncStatus).toBe("saved");expect(state().isLoaded).toBe(true);
      expect(state().hasPendingChanges).toBe(false);
      expect(mocks.theme).toHaveBeenLastCalledWith("queued-before-load");
    }finally{bindPreferencePresenter(async()=>applyAccountPreferences);}
  });

  it("retries an authoritative GET presentation with the original reset and session-preservation plan",async()=>{
    await ready({theme:"removed-on-server",voice_settings:{masterVolume:45}});
    const {applyAccountPreferences}=await import("./applyAccountPreferences");
    bindPreferencePresenter(async()=>{throw new Error("presenter chunk unavailable");});
    try {
      mocks.get.mockResolvedValueOnce(ok({}));await state().fetchAndApply();
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().data).toEqual({});
      for(const reset of mocks.resets)reset.mockClear();
      bindPreferencePresenter(async()=>applyAccountPreferences);
      await state().retrySync();
      expect(mocks.resets[0]).toHaveBeenCalledExactlyOnceWith(true,expect.any(Function));
      expect(mocks.resets[1]).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.resets[2]).toHaveBeenCalledExactlyOnceWith(true);
      expect(mocks.resets[3]).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.get).toHaveBeenCalledTimes(2);expect(mocks.update).not.toHaveBeenCalled();
      expect(state().syncStatus).toBe("saved");
    }finally{bindPreferencePresenter(async()=>applyAccountPreferences);}
  });

  it("stops an old presenter when a destination subscriber synchronously binds another account",async()=>{
    await ready();
    mocks.theme.mockImplementationOnce(()=>{
      state().bindAccount("bob");state().set({appearance:{uiScale:150}});
    });
    try {
      mocks.get.mockResolvedValueOnce(ok({theme:"alice-remote",appearance:{uiScale:130},voice_settings:{masterVolume:45}}));
      await state().fetchAndApply();await settle();
      expect(state().accountId).toBe("bob");
      expect(state().data).toEqual({appearance:{uiScale:150}});
      expect(state().hasPendingChanges).toBe(true);
      expect(mocks.appearance).not.toHaveBeenCalledWith({uiScale:130});
      expect(mocks.voice).not.toHaveBeenCalledWith({masterVolume:45});
      expect(mocks.appearance).toHaveBeenLastCalledWith({uiScale:150});
    }finally{mocks.theme.mockReset();}
  });

  it.each(["current","owner","backend"] as const)("persists a validated PATCH before saved observers can fail or replace scope (%s)",async boundary=>{
    await ready();
    const failure=new Error("saved observer failed");let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="saved")return;
      stop();
      if(boundary!=="current"){
        state().bindAccount(boundary==="owner"?"bob":"alice",boundary==="backend"?"https://two.example":undefined);
        state().set({theme:"replacement-pending"});
      }
      throw failure;
    });
    try{
      state().set({theme:"accepted"});await vi.advanceTimersByTimeAsync(1000);
      expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({theme:"accepted"});
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      if(boundary==="current"){
        expect(state().syncError).toBe("preferences_apply_failed");
        await state().retrySync();
        expect(mocks.update).toHaveBeenCalledTimes(1);
        expect(state().syncStatus).toBe("saved");
      }else{
        expect(state().data).toEqual({theme:"replacement-pending"});
        expect(state().hasPendingChanges).toBe(true);
        expect(state().syncError).toBeNull();
      }
    }finally{stop();}
  });

  it("retains an authoritative GET before a loaded observer fails and retries only local application",async()=>{
    await ready({theme:"old"});
    mocks.get.mockResolvedValueOnce(ok({theme:"fresh"}));
    let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="saved"||next.data.theme!=="fresh")return;
      stop();throw new Error("loaded observer failed");
    });
    try{
      await state().fetchAndApply();
      expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({theme:"fresh"});
      expect(state().syncError).toBe("preferences_apply_failed");
      await state().retrySync();
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.theme).toHaveBeenLastCalledWith("fresh");
      expect(state().syncStatus).toBe("saved");
    }finally{stop();}
  });

  it("releases a failed saving notification without dispatching or stranding its pending patch",async()=>{
    await ready();let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="saving")return;
      stop();throw new Error("saving observer failed");
    });
    try{
      state().set({theme:"pending-before-dispatch"});
      await vi.advanceTimersByTimeAsync(1000);
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().hasPendingChanges).toBe(true);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({theme:"pending-before-dispatch"});
      expect(mocks.update).not.toHaveBeenCalled();
      await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0]).toEqual({theme:"pending-before-dispatch"});
      expect(state().syncStatus).toBe("saved");
      expect(localStorage.getItem(pendingKey)).toBeNull();
    }finally{stop();}
  });

  it("does not assign a retired pre-dispatch writer promise to a replacing account",async()=>{
    await ready();let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="saving")return;
      stop();state().bindAccount("bob");state().set({theme:"bob-pending"});
    });
    try{
      state().set({theme:"alice-pending"});await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.update).not.toHaveBeenCalled();
      mocks.get.mockResolvedValue(ok({},"bob"));
      await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0]).toEqual({theme:"bob-pending"});
      expect(state().accountId).toBe("bob");
      expect(state().hasPendingChanges).toBe(false);
      expect(state().syncStatus).toBe("saved");
    }finally{stop();}
  });

  it("reserves its writer before saving observers can request another same-account flush",async()=>{
    await ready();const write=deferred<Response>();
    mocks.update.mockReturnValueOnce(write.promise);
    let joined:Promise<void>=Promise.resolve(),stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="saving")return;
      stop();state().set({appearance:{uiScale:130}});joined=state().retrySync();
    });
    try{
      state().set({theme:"first"});await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0]).toEqual({theme:"first"});
      write.resolve({success:true});await joined;await settle();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.update).toHaveBeenCalledTimes(2);
      expect(mocks.update.mock.calls[1][0]).toEqual({appearance:{uiScale:130}});
      expect(state().hasPendingChanges).toBe(false);
    }finally{stop();write.resolve({success:true});}
  });

  it.each(["fetch","write"] as const)("releases the %s handle when its error notification rejects",async phase=>{
    if(phase==="write")await ready();else state().bindAccount("alice");
    state().set({theme:"recoverable"});
    if(phase==="fetch")mocks.get.mockRejectedValueOnce(new Error("offline"));
    else mocks.update.mockRejectedValueOnce(new Error("offline"));
    const failure=new Error("error observer failed");let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{if(next.syncStatus==="error"){stop();throw failure;}});
    try{
      await expect(phase==="fetch"?state().fetchAndApply():state().retrySync()).rejects.toBe(failure);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({theme:"recoverable"});
      await state().retrySync();
      expect(state().syncStatus).toBe("saved");
      expect(state().hasPendingChanges).toBe(false);
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(mocks.update).toHaveBeenCalledTimes(phase==="write"?2:1);
    }finally{stop();}
  });
  it("observes a detached flush rejection and leaves its persisted patch retryable",async()=>{
    await ready();mocks.update.mockRejectedValueOnce(new Error("offline"));
    const diagnostic=vi.spyOn(console,"error").mockImplementation(()=>{});
    let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{if(next.syncStatus==="error"){stop();throw new Error("private observer detail");}});
    try{
      state().set({theme:"recoverable"});await vi.advanceTimersByTimeAsync(1000);
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[preferences] background_flush_failed");
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({theme:"recoverable"});
      await state().retrySync();expect(state().syncStatus).toBe("saved");
    }finally{stop();diagnostic.mockRestore();}
  });

  it.each(["fetch","write"] as const)("keeps replacement-account work intact when retired %s cleanup rejects",async phase=>{
    if(phase==="write")await ready();else state().bindAccount("alice");
    state().set({theme:"alice-recoverable"});
    if(phase==="fetch")mocks.get.mockRejectedValueOnce(new Error("offline"));
    else mocks.update.mockRejectedValueOnce(new Error("offline"));
    const failure=new Error("retired observer failed");let stop=()=>{},replacement:Promise<void>=Promise.resolve();
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="error")return;
      stop();state().bindAccount("bob");state().set({theme:"bob-pending"});
      mocks.get.mockResolvedValue(ok({},"bob"));replacement=state().retrySync();
      throw failure;
    });
    try{
      await expect(phase==="fetch"?state().fetchAndApply():state().retrySync()).rejects.toBe(failure);
      await replacement;
      expect(state().accountId).toBe("bob");expect(state().syncStatus).toBe("saved");
      expect(state().data).toEqual({theme:"bob-pending"});expect(state().hasPendingChanges).toBe(false);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({theme:"alice-recoverable"});
      expect(mocks.update.mock.calls.at(-1)![0]).toEqual({theme:"bob-pending"});
    }finally{stop();}
  });

  it("marks only the importing account when a pending observer replaces its binding",async()=>{
    localStorage.setItem("mqvi_ui_scale","140");await ready();
    let stop=()=>{};
    stop=usePreferencesStore.subscribe(next=>{
      if(next.syncStatus!=="pending"||(next.data.appearance as {uiScale?:number})?.uiScale!==140)return;
      stop();state().bindAccount("bob");
    });
    try{
      expect(await state().importLegacyPreferences()).toBe(false);
      expect(localStorage.getItem(legacyImportKey)).toBe("1");
      const bobMarker="hichat.preferences.legacy-imported.v1:https%3A%2F%2Fone.example:bob";
      expect(localStorage.getItem(bobMarker)).toBeNull();
      mocks.get.mockResolvedValueOnce(ok({},"bob"));await state().fetchAndApply();
      expect(state().legacyImportAvailable).toBe(true);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({appearance:{uiScale:140}});
    }finally{stop();}
  });
  it.each(["presenter","observer"] as const)("retains imported queue and offers local retry after %s failure",async phase=>{
    localStorage.setItem("mqvi_ui_scale","140");await ready();
    const {applyAccountPreferences}=await import("./applyAccountPreferences");let stop=()=>{};
    if(phase==="presenter")bindPreferencePresenter(async()=>{throw new Error("presenter unavailable");});
    else stop=usePreferencesStore.subscribe(next=>{if(next.syncStatus==="pending"){stop();throw new Error("pending observer failed");}});
    try{
      await expect(state().importLegacyPreferences()).resolves.toBe(false);
      expect(localStorage.getItem(legacyImportKey)).toBe("1");
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({appearance:{uiScale:140}});
      expect(state().syncError).toBe("preferences_apply_failed");
      expect(state().hasPendingChanges).toBe(true);
      bindPreferencePresenter(async()=>applyAccountPreferences);await state().retrySync();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0]).toEqual({appearance:{uiScale:140}});
      expect(state().syncStatus).toBe("saved");
    }finally{stop();bindPreferencePresenter(async()=>applyAccountPreferences);}
  });

  it("returns a failed import when the refresh it joined rejects,without assigning its backup",async()=>{
    localStorage.setItem("mqvi_ui_scale","140");await ready();
    const response=deferred<Response>();mocks.get.mockReturnValueOnce(response.promise);
    let stop=()=>{};const failure=new Error("refresh error observer failed");
    stop=usePreferencesStore.subscribe(next=>{if(next.syncStatus==="error"){stop();throw failure;}});
    try{
      const refresh=state().fetchAndApply();const rejected=expect(refresh).rejects.toBe(failure);
      const importing=state().importLegacyPreferences();await settle();
      response.reject(new Error("offline"));await rejected;
      await expect(importing).resolves.toBe(false);
      expect(localStorage.getItem(legacyImportKey)).toBeNull();
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(state().syncError).toBe("preferences_load_failed");
    }finally{stop();response.resolve(ok());}
  });
  it("does not assign legacy data after a joined refresh reports account mismatch",async()=>{
    localStorage.setItem("mqvi_ui_scale","140");await ready();
    const response=deferred<Response>();mocks.get.mockReturnValueOnce(response.promise);
    const refresh=state().fetchAndApply(),importing=state().importLegacyPreferences();await settle();
    response.resolve({success:false,code:"PREFERENCES_ACCOUNT_MISMATCH"});
    await refresh;expect(await importing).toBe(false);
    expect(state().syncError).toBe("preferences_account_mismatch");
    expect(state().data).toEqual({});expect(state().hasPendingChanges).toBe(false);
    expect(localStorage.getItem(legacyImportKey)).toBeNull();expect(localStorage.getItem(pendingKey)).toBeNull();
  });

  it("does not overwrite a binding selected by a reset observer", async () => {
    await ready();
    state().set({ theme: "alice-queued" });
    let stop = () => {};
    stop = usePreferencesStore.subscribe(next => {
      if (next.accountId !== null) return;
      stop();
      state().bindAccount("carol");
      state().set({ theme: "carol-queued" });
    });
    try {
      state().bindAccount("bob");
      await settle();
      expect(state().accountId).toBe("carol");
      expect(state().data).toEqual({ theme: "carol-queued" });
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ theme: "alice-queued" });
      expect(mocks.theme).toHaveBeenLastCalledWith("carol-queued");
    } finally { stop(); }
  });

  it.each(["owner", "backend"] as const)("prepares only the surviving binding after a bound observer replaces %s", async boundary => {
    const { applyAccountPreferences } = await import("./applyAccountPreferences");
    const loading = deferred<typeof applyAccountPreferences>();
    bindPreferencePresenter(() => loading.promise);
    let stop = () => {};
    stop = usePreferencesStore.subscribe(next => {
      if (next.accountId !== "alice") return;
      stop();
      state().bindAccount(boundary === "owner" ? "bob" : "alice", "https://two.example");
      state().set({ theme: "survivor" });
    });
    try {
      state().bindAccount("alice");
      loading.resolve(applyAccountPreferences);
      await settle();
      for (const reset of mocks.resets) expect(reset).toHaveBeenCalledTimes(1);
      expect(mocks.theme).toHaveBeenLastCalledWith("survivor");
      expect(mocks.get).not.toHaveBeenCalled();
      expect(state().accountId).toBe(boundary === "owner" ? "bob" : "alice");
    } finally {
      stop(); loading.resolve(applyAccountPreferences);
      bindPreferencePresenter(async () => applyAccountPreferences);
    }
  });

  it("prepares committed binding data even if its bound observer throws", async () => {
    const { applyAccountPreferences } = await import("./applyAccountPreferences");
    bindPreferencePresenter(async () => applyAccountPreferences);
    localStorage.setItem(snapshotKey, JSON.stringify({ theme: "cached-owner" }));
    const failure = new Error("bound observer failed");
    let stop = () => {};
    stop = usePreferencesStore.subscribe(next => {
      if (next.accountId === "alice") { stop(); throw failure; }
    });
    try {
      expect(() => state().bindAccount("alice")).toThrow(failure);
      await settle();
      for (const reset of mocks.resets) expect(reset).toHaveBeenCalledTimes(1);
      expect(mocks.theme).toHaveBeenLastCalledWith("cached-owner");
      expect(state().accountId).toBe("alice");
      expect(mocks.get).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("fences an old account while the production presenter is still loading", async () => {
    const { applyAccountPreferences } = await import("./applyAccountPreferences");
    const loading = deferred<typeof applyAccountPreferences>();
    bindPreferencePresenter(() => loading.promise);
    try {
      state().bindAccount("alice");
      state().set({ theme: "alice-pending" });
      const oldFetch = state().fetchAndApply();
      state().bindAccount("bob");
      state().set({ theme: "bob-pending" });
      loading.resolve(applyAccountPreferences);
      await oldFetch;
      await settle();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.theme).not.toHaveBeenCalledWith("alice-pending");
      expect(mocks.theme).toHaveBeenLastCalledWith("bob-pending");
      for (const reset of mocks.resets) expect(reset).toHaveBeenCalledTimes(1);
      expect(state().accountId).toBe("bob");
      expect(state().data.theme).toBe("bob-pending");
      expect(state().hasPendingChanges).toBe(true);
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toMatchObject({ theme: "alice-pending" });
    } finally {
      loading.resolve(applyAccountPreferences);
      bindPreferencePresenter(async () => applyAccountPreferences);
    }
  });

  it.each([true, false])("restores channel message notification choice %s offline without leaking accounts", async value => {
    await ready({ notifications: { channelMessageNotifications: value } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ notifications: { channelMessageNotifications: value } });
    state().reset();
    state().bindAccount("alice");
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    await state().fetchAndApply();
    expect(state().data.notifications).toEqual({ channelMessageNotifications: value });
    expect(state().syncError).toBe("preferences_load_failed");
    state().bindAccount("bob");
    expect(state().data).toEqual({});
  });

  it("never queues device-only overlay flags in an account patch", async () => {
    await ready();
    state().set({ voice_settings: { masterVolume: 65, voiceOverlayCompatibility: true, voiceOverlayVideo: true, voiceOverlayStreams: true, voiceOverlayWelcome: true, voiceOverlayGoLive: true } });
    expect(state().data.voice_settings).toEqual({ masterVolume: 65 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { masterVolume: 65 } });
  });

  it("does not send or queue unauthenticated edits", async () => {
    state().set({ theme: "midnight" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(state().hasPendingChanges).toBe(false);
  });

  it.each(["krisp", "dpdfnet"])("migrates hidden %s in snapshots, pending caches and server reads", async (engine) => {
    localStorage.setItem(snapshotKey, JSON.stringify({ voice_settings: { noiseReductionEngine: engine, masterVolume: 72 } }));
    localStorage.setItem(pendingKey, JSON.stringify({ voice_settings: { noiseReductionEngine: engine, inputVolume: 125 } }));
    state().bindAccount("alice");
    await settle();
    expect(state().data.voice_settings).toEqual({ noiseReductionEngine: "rnnoise", masterVolume: 72, inputVolume: 125 });
    for (const key of [snapshotKey, pendingKey]) {
      expect(JSON.parse(localStorage.getItem(key)!).voice_settings.noiseReductionEngine).toBe("rnnoise");
    }
    mocks.get.mockResolvedValue(ok({ voice_settings: { noiseReductionEngine: engine, masterVolume: 64 } }));
    await state().fetchAndApply();
    expect(mocks.voice).toHaveBeenLastCalledWith({ noiseReductionEngine: "rnnoise", masterVolume: 64, inputVolume: 125 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { noiseReductionEngine: "rnnoise", inputVolume: 125 } });
  });

  it("preserves GTCRN in account caches and outgoing preferences", async () => {
    await ready({ voice_settings: { noiseReductionEngine: "gtcrn", micSensitivity: 60 } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).voice_settings.noiseReductionEngine).toBe("gtcrn");
    state().set({ voice_settings: { noiseReductionEngine: "gtcrn" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { noiseReductionEngine: "gtcrn" } });
    state().set({ voice_settings: { noiseReductionEngine: "krisp" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[1][0]).toEqual({ voice_settings: { noiseReductionEngine: "rnnoise" } });
  });

  it("preserves stream-sharing consent in account cache and outgoing patches", async () => {
    await ready({ privacy: { shareStreamUpdates: false } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy.shareStreamUpdates).toBe(false);
    state().set({ privacy: { shareStreamUpdates: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ privacy: { shareStreamUpdates: true } });
  });

  it("retains explicit game activity privacy in account cache and queued writes", async () => {
    const privacy = { shareGameActivity: false, gameActivityNewServerAudience: "none", gameActivityServerOverrides: { privateServer: false } };
    await ready({ privacy });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy).toEqual(privacy);
    const patch = { shareGameActivity: true, gameActivityNewServerAudience: "small", gameActivityServerOverrides: { smallServer: true } };
    state().set({ privacy: patch });
    expect(JSON.parse(localStorage.getItem(pendingKey)!).privacy).toEqual(patch);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ privacy: patch });
    expect(state().get<{ gameActivityServerOverrides: Record<string, boolean> }>("privacy")?.gameActivityServerOverrides).toEqual({ privateServer: false, smallServer: true });
  });

  it("drops malformed game activity privacy from persisted cache", async () => {
    await ready({ privacy: { shareGameActivity: "true", gameActivityNewServerAudience: "everyone", gameActivityServerOverrides: { server: "yes" }, shareStreamUpdates: false } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy).toEqual({ shareStreamUpdates: false });
  });

  it("debounces leaf patches, preserving sibling data and unknown legacy keys", async () => {
    await ready({ voice_settings: { userVolumes: { bob: 60 }, masterVolume: 80 }, legacy: { retained: true } });
    state().set({ voice_settings: { userVolumes: { carol: 75 } } });
    state().set({ voice_settings: { masterVolume: 90 } });
    expect(state().data.voice_settings).toEqual({ userVolumes: { bob: 60, carol: 75 }, masterVolume: 90 });
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { userVolumes: { carol: 75 }, masterVolume: 90 } });
    expect(state().data.legacy).toEqual({ retained: true });
    expect(state().syncStatus).toBe("saved");
  });

  it.each(["envelope", "exception"])("retains edits on %s failure and retries explicitly", async (failure) => {
    await ready();
    if (failure === "envelope") mocks.update.mockResolvedValueOnce({ success: false, error: "offline" });
    else mocks.update.mockRejectedValueOnce(new Error("offline"));
    state().set({ accessibility: { chatFontSize: 20 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_save_failed");
    expect(state().hasPendingChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await state().retrySync();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toEqual({ accessibility: { chatFontSize: 20 } });
    expect(state().hasPendingChanges).toBe(false);
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });

  it("serializes writes and keeps later edits over the older acknowledgement", async () => {
    await ready();
    const first = deferred<Response>();
    mocks.update.mockReturnValueOnce(first.promise);
    state().set({ theme: "first", voice_settings: { masterVolume: 30 } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ theme: "second", voice_settings: { masterVolume: 60 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    first.resolve(ok({ theme: "first", voice_settings: { masterVolume: 30 } }));
    await settle();
    expect(state().data.theme).toBe("second");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toEqual({ theme: "second", voice_settings: { masterVolume: 60 } });
  });

  it("merges a failed in-flight patch underneath new edits", async () => {
    await ready();
    const first = deferred<Response>();
    mocks.update.mockReturnValueOnce(first.promise);
    state().set({ accessibility: { chatFontSize: 18, density: "compact" } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ accessibility: { chatFontSize: 22 } });
    first.resolve({ success: false });
    await settle();
    await state().retrySync();
    expect(mocks.update.mock.calls[1][0]).toEqual({ accessibility: { chatFontSize: 22, density: "compact" } });
  });

  it("does not overwrite edits made during hydration and resets dependent defaults", async () => {
    const fetch = deferred<Response>();
    mocks.get.mockReturnValueOnce(fetch.promise);
    state().bindAccount("alice");
    const hydration = state().fetchAndApply();
    await settle();
    state().set({ accessibility: { chatFontSize: 22 }, appearance: { uiScale: 120 } });
    fetch.resolve(ok({ accessibility: { chatFontSize: 16, density: "cozy" }, appearance: { uiScale: 100 } }));
    await hydration;
    expect(state().data.accessibility).toEqual({ chatFontSize: 22, density: "cozy" });
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 22, density: "cozy" });
    expect(mocks.appearance).toHaveBeenLastCalledWith({ uiScale: 120 });
    for (const reset of mocks.resets) expect(reset).toHaveBeenCalledTimes(2);
    expect(mocks.resets[0]).toHaveBeenLastCalledWith(true,expect.any(Function));
    expect(mocks.resets[2]).toHaveBeenLastCalledWith(true);
  });

  it("retains edits when initial fetch fails; retry reloads before writing", async () => {
    mocks.get.mockResolvedValueOnce({ success: false });
    state().bindAccount("alice");
    state().set({ theme: "midnight" });
    await state().fetchAndApply();
    expect(state().isLoaded).toBe(false);
    expect(state().syncError).toBe("preferences_load_failed");
    expect(mocks.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await state().retrySync();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[0][0]).toEqual({ theme: "midnight" });
  });

  it("coalesces focus refreshes into one request", async () => {
    await ready();
    const next = deferred<Response>();
    mocks.get.mockReturnValueOnce(next.promise);
    const one = state().fetchAndApply();
    const two = state().fetchAndApply();
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    next.resolve(ok({ theme: "updated-elsewhere" }));
    await Promise.all([one, two]);
    expect(state().data.theme).toBe("updated-elsewhere");
  });

  it("preserves an edit committed while a refresh is in flight", async () => {
    await ready();
    const next = deferred<Response>();
    mocks.get.mockReturnValueOnce(next.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ theme: "fresh-local" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    next.resolve(ok({ theme: "older-server" }));
    await refresh;
    expect(state().data.theme).toBe("fresh-local");
    expect(mocks.theme).toHaveBeenLastCalledWith("fresh-local");
  });

  it("does not report saved when a refresh finishes before an outstanding PATCH", async () => {
    await ready({ appearance: { uiScale: 100 } });
    const response = deferred<Response>();
    const write = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    mocks.update.mockReturnValueOnce(write.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("saving");
    response.resolve(ok({ appearance: { uiScale: 100 } }));
    await refresh;
    expect(state().syncStatus).toBe("saving");
    expect(state().hasPendingChanges).toBe(true);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 100 } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    write.resolve({ success: false, error: "offline" });
    await settle();
    expect(state().syncStatus).toBe("error");
    expect(state().hasPendingChanges).toBe(true);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
  });

  it("ignores late hydration after switching accounts", async () => {
    const old = deferred<Response>();
    mocks.get.mockReturnValueOnce(old.promise);
    state().bindAccount("alice");
    const oldLoad = state().fetchAndApply();
    await settle();
    const oldContext = mocks.get.mock.calls[0][0];
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({ theme: "bob-theme" }, "bob"));
    await state().fetchAndApply();
    old.resolve(ok({ theme: "alice-theme" }));
    await oldLoad;
    expect(oldContext.expectedUserId).toBe("alice");
    expect(mocks.get.mock.calls[1][0].expectedUserId).toBe("bob");
    expect(oldContext.isCurrent()).toBe(false);
    expect(oldContext.signal.aborted).toBe(true);
    expect(state().data.theme).toBe("bob-theme");
    expect(mocks.theme).not.toHaveBeenCalledWith("alice-theme");
  });

  it("reset cancels queued writes without flushing under the next account", async () => {
    await ready();
    state().set({ theme: "alice-theme" });
    state().reset();
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({}, "bob"));
    await state().fetchAndApply();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(state().data).toEqual({});
    state().bindAccount("alice");
    expect(state().data.theme).toBe("alice-theme");
  });

  it("late writes cannot clear or mutate the next account's pending state", async () => {
    await ready();
    const old = deferred<Response>();
    mocks.update.mockReturnValueOnce(old.promise);
    state().set({ theme: "alice-theme" });
    await vi.advanceTimersByTimeAsync(1000);
    const context = mocks.update.mock.calls[0][1];
    state().bindAccount("bob");
    state().set({ theme: "bob-theme" });
    old.resolve(ok({ theme: "alice-theme" }));
    await settle();
    expect(context.expectedUserId).toBe("alice");
    expect(context.isCurrent()).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(state().data.theme).toBe("bob-theme");
    expect(state().hasPendingChanges).toBe(true);
  });

  it("scopes recoverable pending edits by backend and user, with a nonsecret allowlist", async () => {
    await ready();
    state().set({ theme: "midnight", token: "secret", accessibility: { chatFontSize: 19, arbitrarySecret: "secret" }, voice_settings: { cameraDevice: "secret-id", inputDevice: "mic-id", outputDevice: "speaker-id", muteHotkeyGlobal: true, masterVolume: 50 } });
    const raw = localStorage.getItem(pendingKey)!;
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("Device");
    expect(raw).not.toContain("muteHotkeyGlobal");
    state().bindAccount("alice", "https://two.example");
    expect(state().data).toEqual({});
    state().bindAccount("alice", "https://one.example");
    expect(state().data).toEqual({ theme: "midnight", accessibility: { chatFontSize: 19 }, voice_settings: { masterVolume: 50 } });
  });

  it("strips device-local fields from hydration and outbound patches", async () => {
    await ready({ voice_settings: {
      cameraDevice: "other", inputDevice: "mic", outputDevice: "speaker", muteHotkeyGlobal: true, cameraFps: 30,
      voiceOverlayEnabled: true, voiceOverlayMode: "game", voiceOverlayPosition: "top-left", voiceOverlayMaxParticipants: 4,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } });
    expect(mocks.voice).toHaveBeenLastCalledWith({ cameraFps: 30 });
    state().set({ voice_settings: {
      inputDevice: "mine", cameraQuality: "1080p", voiceOverlayEnabled: false, voiceOverlayNameDisplay: "never",
      voiceOverlayMode: "game",
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } });
    await state().retrySync();
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { cameraQuality: "1080p" } });
  });

  it("filters legacy overlay keys from cached pending patches but keeps synced audio preferences", async () => {
    localStorage.setItem(pendingKey, JSON.stringify({ voice_settings: {
      voiceOverlayEnabled: false, voiceOverlaySpeakingOpacity: 55, voiceOverlayPosition: "top-right",
      voiceOverlayPinned: true,
      voiceOverlayQuickActions: true, voiceOverlayClickableActions: true,
      voiceOverlayActivity: true,
      voiceOverlayGameActivityNotifications: true, voiceOverlayNowPlayingNotifications: true,
      voiceOverlayNotifications: true,
      voiceOverlayNotificationActions: true,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
      voiceOverlaySpeakingOnly: true, voiceOverlayMode: "game", voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "never",
      voiceOverlayMaxParticipants: 0, masterVolume: 38,
    } }));
    mocks.get.mockResolvedValueOnce(ok({ voice_settings: {
      voiceOverlayEnabled: true, voiceOverlayMode: "desktop", voiceOverlayPosition: "top-left", voiceOverlayMaxParticipants: 25, cameraFps: 30,
      voiceOverlayPinned: false,
      voiceOverlayQuickActions: false, voiceOverlayClickableActions: false,
      voiceOverlayActivity: false,
      voiceOverlayGameActivityNotifications: false, voiceOverlayNowPlayingNotifications: false,
      voiceOverlayNotifications: false,
      voiceOverlayNotificationActions: false,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } }));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(mocks.voice).toHaveBeenLastCalledWith({ cameraFps: 30, masterVolume: 38 });
    expect(JSON.parse(localStorage.getItem(pendingKey)!).voice_settings).toEqual({ masterVolume: 38 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { masterVolume: 38 } });
  });

  it("rejects mismatched account responses and ignores invalid cache JSON", async () => {
    localStorage.setItem("hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice", "bad-json");
    mocks.get.mockResolvedValueOnce(ok({ theme: "wrong" }, "bob"));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(state().syncStatus).toBe("error");
    expect(state().data).toEqual({});
    expect(mocks.theme).not.toHaveBeenCalled();
  });

  it.each(["conflict", "response identity"])("preserves pending edits and reports a GET account %s without automatic retry", async (failure) => {
    mocks.get.mockResolvedValueOnce(failure === "conflict"
      ? { success: false, code: "PREFERENCES_ACCOUNT_MISMATCH" }
      : ok({ appearance: { uiScale: 90 } }, "bob"));
    state().bindAccount("alice");
    state().set({ appearance: { uiScale: 140 } });
    await state().fetchAndApply();
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_account_mismatch");
    expect(state().accountId).toBe("alice");
    expect(state().isLoaded).toBe(false);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(state().hasPendingChanges).toBe(true);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["conflict", "response identity"])("preserves pending edits and reports a PATCH account %s without automatic retry", async (failure) => {
    await ready({ appearance: { uiScale: 100 } });
    mocks.update.mockResolvedValueOnce(failure === "conflict"
      ? { success: false, code: "PREFERENCES_ACCOUNT_MISMATCH" }
      : ok({ appearance: { uiScale: 90 } }, "bob"));
    state().set({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_account_mismatch");
    expect(state().accountId).toBe("alice");
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(state().hasPendingChanges).toBe(true);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 100 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("retains cosmetics and validated GIF favorites in the account cache", async () => {
    await ready();
    const gif = { id: "g1", title: "hello", url: "https://static.klipy.com/a.gif", preview_url: "https://static.klipy.com/a.png", width: 200, height: 100 };
    state().set({ cosmetics_view: { plain: true }, gif_favorites: [gif, { ...gif, id: "bad", url: "https://tracker.example/pixel" }] });
    state().reset();
    state().bindAccount("alice");
    expect(state().data.cosmetics_view).toEqual({ plain: true });
    expect(state().data.gif_favorites).toEqual([gif]);
  });

  it("filters corrupt cache and legacy server fields before dependent-store hydration", async () => {
    const key = "hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice";
    localStorage.setItem(key, JSON.stringify({ accessibility: { chatFontSize: "huge", density: "invalid", applyFromServer: "overwrite", setChatFontSize: "overwrite", reduceMotion: true }, appearance: { uiScale: 9999, resetAccountPreferences: "overwrite" } }));
    mocks.get.mockResolvedValueOnce(ok({ accessibility: { resetAccountPreferences: "overwrite", chatFontSize: 17, reduceMotion: false }, voice_settings: { masterVolume: "loud", cameraFps: 60, inputDevice: "private" } }));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 17, reduceMotion: true });
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(mocks.appearance).not.toHaveBeenCalled();
  });

  it("applies merged PATCH acknowledgements to visible settings", async () => {
    await ready({ accessibility: { chatFontSize: 16, density: "default" } });
    mocks.update.mockResolvedValueOnce(ok({ accessibility: { chatFontSize: 20, density: "compact" } }));
    state().set({ accessibility: { chatFontSize: 20 } });
    await state().retrySync();
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 20, density: "compact" });
  });

  it("restores the same account's acknowledged snapshot when the initial GET is offline", async () => {
    const previous = { theme: "midnight", appearance: { neonEnabled: true, uiScale: 120 }, accessibility: { chatFontSize: 20 } };
    await ready(previous);
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual(previous);
    state().reset();
    vi.clearAllMocks();
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    state().bindAccount("alice");
    expect(state().data).toEqual(previous);
    expect(state().hasPendingChanges).toBe(false);
    expect(state().isLoaded).toBe(false);
    await state().fetchAndApply();
    expect(state().data).toEqual(previous);
    expect(state().syncError).toBe("preferences_load_failed");
    expect(mocks.appearance).toHaveBeenLastCalledWith(previous.appearance);
    expect(mocks.accessibility).toHaveBeenLastCalledWith(previous.accessibility);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not load another account or backend's acknowledged snapshot", async () => {
    await ready({ accessibility: { chatFontSize: 23 }, voice_settings: { userVolumes: { privateFriend: 20 } } });
    state().bindAccount("bob");
    expect(state().data).toEqual({});
    state().bindAccount("alice", "https://two.example");
    expect(state().data).toEqual({});
    state().bindAccount("alice");
    expect(state().data.accessibility).toEqual({ chatFontSize: 23 });
    expect(state().hasPendingChanges).toBe(false);
  });

  it("layers recoverable pending edits over the snapshot and replays only those edits", async () => {
    await ready({ appearance: { uiScale: 110 }, accessibility: { density: "cozy", chatFontSize: 18 } });
    state().set({ accessibility: { chatFontSize: 22 } });
    state().reset();
    state().bindAccount("alice");
    expect(state().data).toEqual({ appearance: { uiScale: 110 }, accessibility: { density: "cozy", chatFontSize: 22 } });
    mocks.get.mockResolvedValueOnce(ok({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 16, density: "default" } }));
    await state().fetchAndApply();
    expect(state().data).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 22, density: "default" } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 16, density: "default" } });
    await state().retrySync();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ accessibility: { chatFontSize: 22 } }, expect.any(Object));
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 22, density: "default" } });
  });

  it("never writes unacknowledged newer edits into the acknowledged snapshot", async () => {
    await ready({ appearance: { uiScale: 100 }, accessibility: { chatFontSize: 16 } });
    const response = deferred<Response>();
    mocks.update.mockReturnValueOnce(response.promise);
    state().set({ appearance: { uiScale: 120 } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 20 } });
    response.resolve({ success: true });
    await settle();
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 120 }, accessibility: { chatFontSize: 16 } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 20 } });
  });

  it("keeps acknowledged edits made during a stale GET in the recoverable snapshot", async () => {
    await ready({ theme: "initial" });
    const response = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ theme: "new-acknowledged" });
    await vi.advanceTimersByTimeAsync(1000);
    response.resolve(ok({ theme: "older-get" }));
    await refresh;
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ theme: "new-acknowledged" });
    state().reset();
    state().bindAccount("alice");
    expect(state().data.theme).toBe("new-acknowledged");
    expect(state().hasPendingChanges).toBe(false);
  });

  it("replaces the old snapshot on authoritative GET and preserves session state during defaults reset", async () => {
    await ready({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 23 } });
    mocks.get.mockResolvedValueOnce(ok({ appearance: { neonEnabled: true } }));
    await state().fetchAndApply();
    expect(state().data).toEqual({ appearance: { neonEnabled: true } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { neonEnabled: true } });
    expect(mocks.resets[0]).toHaveBeenLastCalledWith(true,expect.any(Function));
    expect(mocks.resets[2]).toHaveBeenLastCalledWith(true);
    state().reset();
    state().bindAccount("alice");
    await settle();
    expect(mocks.resets[0]).toHaveBeenLastCalledWith(false,expect.any(Function));
    expect(mocks.resets[2]).toHaveBeenLastCalledWith();
  });

  it("uses the same safe allowlist for acknowledged caches and ignores corrupt snapshots", async () => {
    await ready({
      appearance: { uiScale: 120, transparentBackground: true },
      accessibility: { reduceMotion: true, reset: "overwrite" },
      voice_settings: { masterVolume: 50, inputDevice: "private-device" }, token: "secret",
    });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 120 }, accessibility: { reduceMotion: true }, voice_settings: { masterVolume: 50 } });
    state().reset();
    localStorage.setItem(snapshotKey, "invalid-json");
    state().bindAccount("alice");
    expect(state().data).toEqual({});
  });

  it("backs up upgrade-time appearance/accessibility before any defaults reset without auto-importing", async () => {
    localStorage.setItem("mqvi_blur_enabled", "1");
    localStorage.setItem("mqvi_blur_strength", "32");
    localStorage.setItem("mqvi_wallpaper_enabled", "0");
    localStorage.setItem("mqvi_lightning_enabled", "1");
    localStorage.setItem("mqvi_lightning_blur", "8");
    localStorage.setItem("mqvi_neon_enabled", "1");
    localStorage.setItem("mqvi_neon_intensity", "85");
    localStorage.setItem("mqvi_ui_scale", "140");
    localStorage.setItem("hichat-avatar-animation", "always");
    localStorage.setItem("mqvi_transparent_bg", "1");
    localStorage.setItem("tayfa.accessibility.v1", JSON.stringify({ chatFontSize: 21, reduceMotion: true, reset: "bad" }));
    localStorage.setItem("mqvi_voice_settings", JSON.stringify({ userVolumes: { privateUser: 30 } }));
    localStorage.setItem("gif_favorites", "private-favorite");
    state().bindAccount("alice");
    const backup = {
      appearance: { blurEnabled: true, blurStrength: 32, wallpaperEnabled: false, lightningEnabled: true, lightningBlur: 8, neonEnabled: true, neonIntensity: 85, uiScale: 140, avatarAnimation: "always" },
      accessibility: { chatFontSize: 21, reduceMotion: true },
    };
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual(backup);
    expect(mocks.resets[0]).not.toHaveBeenCalled();
    expect(state().data).toEqual({});
    expect(state().legacyImportAvailable).toBe(false);
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(true);
    expect(state().data).toEqual({});
    expect(mocks.appearance).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(await state().importLegacyPreferences()).toBe(true);
    expect(state().data).toEqual(backup);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual(backup);
    expect(mocks.appearance).toHaveBeenLastCalledWith(backup.appearance);
    expect(mocks.accessibility).toHaveBeenLastCalledWith(backup.accessibility);
    expect(localStorage.getItem(legacyImportKey)).toBe("1");
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual(backup);
    expect(state().legacyImportAvailable).toBe(false);
    await state().retrySync();
    expect(mocks.update.mock.calls[0][0]).toEqual(backup);
  });

  it("imports only missing legacy leaves; existing server and in-session edits always win", async () => {
    localStorage.setItem("mqvi_ui_scale", "150");
    localStorage.setItem("mqvi_neon_enabled", "1");
    localStorage.setItem("tayfa.accessibility.v1", JSON.stringify({ chatFontSize: 22, reduceMotion: true }));
    await ready({ appearance: { uiScale: 110 } });
    state().set({ accessibility: { chatFontSize: 19 } });
    expect(await state().importLegacyPreferences()).toBe(true);
    expect(state().data).toEqual({ appearance: { uiScale: 110, neonEnabled: true }, accessibility: { chatFontSize: 19, reduceMotion: true } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { neonEnabled: true }, accessibility: { chatFontSize: 19, reduceMotion: true } });
  });

  it("requires a successful initial GET before legacy import and rechecks eligibility after a refresh", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    mocks.get.mockResolvedValueOnce({ success: false });
    state().bindAccount("alice");
    expect(await state().importLegacyPreferences()).toBe(false);
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
    await state().retrySync();
    expect(state().legacyImportAvailable).toBe(true);
    const response = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    const refresh = state().fetchAndApply();
    const importing = state().importLegacyPreferences();
    await settle();
    response.resolve(ok({ appearance: { uiScale: 125 } }));
    await refresh;
    expect(await importing).toBe(false);
    expect(state().data).toEqual({ appearance: { uiScale: 125 } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains backup after an import and never auto-imports it into another account", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    await ready();
    expect(await state().importLegacyPreferences()).toBe(true);
    await state().retrySync();
    const backup = localStorage.getItem(legacyBackupKey);
    localStorage.setItem("mqvi_ui_scale", "190");
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({}, "bob"));
    await state().fetchAndApply();
    expect(state().data).toEqual({});
    expect(state().legacyImportAvailable).toBe(true);
    expect(localStorage.getItem(legacyBackupKey)).toBe(backup);
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
  });

  it("does not mark import complete if the account pending queue cannot be safely persisted", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    await ready();
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === pendingKey) throw new Error("quota");
      original.call(this, key, value);
    });
    try {
      expect(await state().importLegacyPreferences()).toBe(false);
      expect(state().data).toEqual({});
      expect(state().legacyImportAvailable).toBe(true);
      expect(localStorage.getItem(legacyImportKey)).toBeNull();
      expect(localStorage.getItem(legacyBackupKey)).not.toBeNull();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); }
  });

  it("filters a corrupted backup to presentation leaves and hides unavailable imports", async () => {
    localStorage.setItem(legacyBackupKey, JSON.stringify({
      appearance: { uiScale: 500, neonEnabled: true, transparentBackground: true },
      accessibility: { chatFontSize: "huge", reduceMotion: true, reset: "bad" },
      voice_settings: { userVolumes: { privateUser: 20 } }, gif_favorites: [{ id: "private" }], token: "secret",
    }));
    await ready({ appearance: { neonEnabled: false }, accessibility: { reduceMotion: false } });
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains the in-memory recovery copy across account resets when backup storage is full", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === legacyBackupKey) throw new Error("quota");
      original.call(this, key, value);
    });
    try {
      await ready();
      expect(state().legacyImportAvailable).toBe(true);
      localStorage.setItem("mqvi_ui_scale", "190");
      state().bindAccount("bob");
      mocks.get.mockResolvedValueOnce(ok({}, "bob"));
      await state().fetchAndApply();
      expect(state().data).toEqual({});
      expect(await state().importLegacyPreferences()).toBe(true);
      expect(state().data).toEqual({ appearance: { uiScale: 140 } });
    } finally { storage.mockRestore(); }
    state().reset();
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual({ appearance: { uiScale: 140 } });
  });
});

it("preserves account-scoped voice event booleans without leaking them to another account",()=>{
 state().reset();localStorage.clear();state().bindAccount("alice");const keys=["voiceStreamStartSound","voiceStreamStopSound","voiceJoinSound","voiceLeaveSound","voiceWatchStartSound","voiceWatchStopSound","voiceMuteSound","voiceUnmuteSound","voiceDeafenSound","voiceUndeafenSound"];for(const key of keys){state().set({notifications:{[key]:false}});expect(state().data.notifications).toMatchObject({[key]:false});}state().bindAccount("bob");for(const key of keys)expect((state().data.notifications as Record<string,unknown>|undefined)?.[key]).toBeUndefined();
});
