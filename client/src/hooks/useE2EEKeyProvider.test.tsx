import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ supported:true, install:vi.fn(async (..._args: unknown[]) => true), workers:[] as {terminate:ReturnType<typeof vi.fn>}[] }));
vi.mock("livekit-client", () => ({ isE2EESupported:() => fixture.supported }));
vi.mock("../audio/voiceEncryptionKeys", () => ({ IndexedVoiceKeyProvider:class { scope:string; constructor(scope:string) { this.scope=scope; } setIndexedKey(...args:unknown[]) { return fixture.install(...args); } }, isMediaKeyVersion:(index:number,epoch:number) => Number.isSafeInteger(epoch) && epoch>=0 && index===epoch%256 }));
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { useE2EEKeyProvider } from "./useE2EEKeyProvider";
const options = () => ({ onError:vi.fn(), enabled:true, scope:"room", keyIndex:0, keyEpoch:0, keyContext:"incarnation" });
beforeEach(() => { publishAuthOwnerChange("owner"); publishAuthGenerationChange(1); fixture.supported=true; fixture.install.mockReset().mockResolvedValue(true); fixture.workers=[]; vi.stubGlobal("Worker", class { terminate=vi.fn(); constructor() { fixture.workers.push(this); } }); });
describe("scoped encryption material readiness", () => {
 it("does not admit missing contracts, unsupported workers, or failed key installation", async () => {
  const opts=options(); fixture.supported=false;
  const view=renderHook(() => useE2EEKeyProvider("key", opts));
  await waitFor(() => expect(view.result.current.keyError).toBeTruthy()); expect(view.result.current.keyReady).toBe(false); expect(fixture.install).not.toHaveBeenCalled(); view.unmount();
  fixture.supported=true; const missing=renderHook(() => useE2EEKeyProvider("key", {...opts,keyContext:""}));
  await waitFor(() => expect(missing.result.current.keyError).toBeTruthy()); expect(missing.result.current.keyReady).toBe(false); missing.unmount();
  fixture.install.mockRejectedValue(new Error("derive failed")); const failed=renderHook(() => useE2EEKeyProvider("key",opts));
  await waitFor(() => expect(failed.result.current.keyError).toBeTruthy()); expect(failed.result.current.keyReady).toBe(false); failed.unmount();
 });
 it("invalidates readiness immediately on rekey and fences stale asynchronous completion", async () => {
  let finish!: (installed:boolean)=>void;
  fixture.install.mockImplementationOnce(() => new Promise<boolean>((resolve)=>{finish=resolve;}));
  const opts=options(); const view=renderHook(({pass,config})=>useE2EEKeyProvider(pass,config), {initialProps:{pass:"old",config:opts}});
  await waitFor(() => expect(fixture.install).toHaveBeenCalledOnce()); expect(view.result.current.keyReady).toBe(false);
  view.rerender({pass:"new",config:{...opts,keyEpoch:256}});
  await waitFor(() => expect(view.result.current.keyReady).toBe(true));
  const staleCurrent=fixture.install.mock.calls[0][3] as () => boolean; expect(staleCurrent()).toBe(false);
  await act(async()=>finish(true)); expect(view.result.current.keyReady).toBe(true);
  const worker=view.result.current.e2eeWorker;
  view.rerender({pass:"recreated",config:{...opts,keyContext:"new-incarnation"}});
  expect(view.result.current.keyReady).toBe(false);
  await waitFor(()=>expect(view.result.current.keyReady).toBe(true)); expect(view.result.current.e2eeWorker).not.toBe(worker);
  view.unmount(); expect(fixture.workers.every(w=>w.terminate.mock.calls.length===1)).toBe(true);
 });
 it("retires an account's material and worker on auth generation replacement", async()=>{
  const opts=options(); const view=renderHook(()=>useE2EEKeyProvider("key",opts));
  await waitFor(()=>expect(view.result.current.keyReady).toBe(true)); const old=view.result.current.keyProvider;
  act(()=>publishAuthGenerationChange(2)); expect(view.result.current.keyReady).toBe(false);
  await waitFor(()=>expect(view.result.current.keyReady).toBe(true)); expect(view.result.current.keyProvider).not.toBe(old); view.unmount();
 });
});
