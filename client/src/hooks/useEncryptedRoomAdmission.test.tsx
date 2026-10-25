import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ rooms: [] as unknown[], enable: vi.fn(async () => {}), constructError: null as Error | null, capture: (() => Promise.resolve([])) as () => Promise<unknown[]>, publish: (async (track:unknown) => ({track})) as (track:unknown)=>Promise<{track:unknown}> }));
vi.mock("livekit-client", () => ({
  ExternalE2EEKeyProvider: class {}, createKeyMaterialFromString: vi.fn(),
  Track: { Source: { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  ConnectionState: { Connected: "connected" },
  RoomEvent: { Connected: "connected", LocalTrackPublished: "published", EncryptionError: "encryption-error", Reconnecting: "reconnecting", SignalReconnecting: "signal-reconnecting", Reconnected: "reconnected" },
  Room: class {
    localParticipant = { identity: "", trackPublications: new Map(), createTracks: vi.fn(() => sdk.capture()), createScreenTracks: vi.fn(() => sdk.capture()), publishTrack: vi.fn((track: unknown) => sdk.publish(track)), unpublishTrack: vi.fn(async () => {}) };
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    state = "disconnected";
    options: unknown;
    setE2EEEnabled = vi.fn((enabled: boolean) => { expect(enabled).toBe(true); return sdk.enable(); });
    disconnect = vi.fn(async () => {});
    constructor(options: unknown) { if (sdk.constructError) throw sdk.constructError; this.options = options; sdk.rooms.push(this); }
    on(event: string, handler: (...args: unknown[]) => void) { const handlers = this.listeners.get(event) ?? new Set(); handlers.add(handler); this.listeners.set(event, handlers); return this; }
    off(event: string, handler: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(handler); return this; }
    emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach((handler) => handler(...args)); }
  },
}));
import { Track } from "livekit-client";
import { IndexedVoiceKeyProvider } from "../audio/voiceEncryptionKeys";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { useEncryptedRoomAdmission } from "./useEncryptedRoomAdmission";

type Options = Parameters<typeof useEncryptedRoomAdmission>[0];
type TestRoom = { state: string; localParticipant: { identity: string; trackPublications: Map<string, ReturnType<typeof publication>> }; setE2EEEnabled: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void };
const token = (owner: string) => `header.${btoa(JSON.stringify({ sub: owner }))}.signature`;
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function options(): Options { return { enabled: true, token: token("owner"), scope: "owner-room", keyScope: "epoch-0", keyReady: false, keyError: null,
  keyProvider: new IndexedVoiceKeyProvider("fixture"), worker: fakeWorker(), roomOptions: {}, onError: vi.fn() }; }
function fakeWorker(autoAck = true): Worker {
 const listeners = new Set<(event: MessageEvent) => void>();
 const emit = (data: unknown) => listeners.forEach((handler) => handler({ data } as MessageEvent));
 return { emit, addEventListener: vi.fn((_event: string, handler: (event: MessageEvent) => void) => listeners.add(handler)),
  removeEventListener: vi.fn((_event: string, handler: (event: MessageEvent) => void) => listeners.delete(handler)),
  postMessage: vi.fn((data: unknown) => { if (autoAck) queueMicrotask(() => emit(data)); }) } as unknown as Worker;
}
async function connectAndAdmit(view: { result: { current: ReturnType<typeof useEncryptedRoomAdmission> } }) {
 await waitFor(() => expect(view.result.current.connect).toBe(true));
 const room = view.result.current.room as unknown as TestRoom;
 if (room.state !== "connected") act(() => { room.state = "connected"; room.localParticipant.identity = "owner"; room.emit("connected"); });
 await waitFor(() => expect(view.result.current.publishReady).toBe(true));
}

function publication(source = Track.Source.Microphone) {
  return { source, track: { mediaStreamTrack: { enabled: true, readyState: "live" }, isMuted: false } };
}
beforeEach(() => { sdk.rooms.length = 0; sdk.enable.mockReset().mockResolvedValue(undefined); sdk.constructError = null; sdk.capture=async()=>[]; sdk.publish=async(track)=>({track}); publishAuthOwnerChange("owner"); publishAuthGenerationChange(10); });

describe("encrypted room admission", () => {
  it("does not connect or admit publishers before key readiness and awaited explicit GCM enable", async () => {
    const pending = deferred(); sdk.enable.mockReturnValue(pending.promise);
    const initial = { ...options(), worker: fakeWorker(false) };
    const view = renderHook((props: Options) => useEncryptedRoomAdmission(props), { initialProps: initial });
    await waitFor(() => expect(view.result.current.room).not.toBeNull());
    expect(sdk.enable).not.toHaveBeenCalled(); expect(view.result.current.connect).toBe(false);
    view.rerender({ ...initial, keyReady: true });
    expect(sdk.enable).toHaveBeenCalledOnce(); expect(view.result.current.publishReady).toBe(false);
    await act(async () => pending.resolve());
    await waitFor(() => expect(view.result.current.connect).toBe(true));
    expect(view.result.current.publishReady).toBe(false);
    const worker = initial.worker as unknown as { postMessage: ReturnType<typeof vi.fn>; emit: (data: unknown) => void };
    expect(worker.postMessage).not.toHaveBeenCalled();
    const room = view.result.current.room as unknown as TestRoom;
    act(() => { room.state = "connected"; room.localParticipant.identity = "owner"; room.emit("connected"); });
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const request = worker.postMessage.mock.calls[0][0] as { kind: string; data: Record<string, unknown> };
    act(() => worker.emit({ ...request, data: { ...request.data, participantIdentity: "" } }));
    expect(view.result.current.publishReady).toBe(false);
    act(() => worker.emit({ ...request, data: { ...request.data, hichatRequestId: "wrong-nonce" } }));
    expect(view.result.current.publishReady).toBe(false);
    await act(async () => worker.emit(request));
    await waitFor(() => expect(view.result.current.publishReady).toBe(true)); view.unmount();
  });

  it("rejects retained credentials for another account and constructor/key/enable failures without a plaintext room", async () => {
    const initial = { ...options(), token: token("previous-owner"), keyReady: true };
    const mismatch = renderHook(() => useEncryptedRoomAdmission(initial));
    await waitFor(() => expect(mismatch.result.current.error).toBeTruthy());
    expect(sdk.rooms).toHaveLength(0); expect(sdk.enable).not.toHaveBeenCalled(); mismatch.unmount();
    sdk.constructError = new Error("unsupported room");
    const constructOptions = { ...options(), keyReady: true };
    const construct = renderHook(() => useEncryptedRoomAdmission(constructOptions));
    await waitFor(() => expect(construct.result.current.error).toBe(sdk.constructError));
    expect(construct.result.current.connect).toBe(false); construct.unmount(); sdk.constructError = null;
    sdk.enable.mockRejectedValue(new Error("enable failed"));
    const failedOptions = { ...options(), keyReady: true };
    const failed = renderHook(() => useEncryptedRoomAdmission(failedOptions));
    await waitFor(() => expect(failed.result.current.error).toBeTruthy());
    expect(failed.result.current.publishReady).toBe(false); expect((sdk.rooms[0] as TestRoom).disconnect).toHaveBeenCalled(); failed.unmount();
  });

  it("pauses tracks in layout phase during rekey, keeps the room, and never restores obsolete or disallowed media", async () => {
    const initial = { ...options(), keyReady: true };
    const view = renderHook((props: Options) => useEncryptedRoomAdmission(props), { initialProps: initial });
    await connectAndAdmit(view);
    const room = view.result.current.room as unknown as TestRoom;
    const mic = publication(), ended = publication(Track.Source.Camera), oldShare = publication(Track.Source.ScreenShare), camera = publication(Track.Source.Camera);
    room.localParticipant.trackPublications.set("mic", mic); room.localParticipant.trackPublications.set("ended", ended);
    room.localParticipant.trackPublications.set("share", oldShare); room.localParticipant.trackPublications.set("camera", camera);
    view.rerender({ ...initial, keyScope: "epoch-1", keyReady: false });
    expect(mic.track.mediaStreamTrack.enabled).toBe(false); expect(oldShare.track.mediaStreamTrack.enabled).toBe(false);
    expect(view.result.current.room).toBe(room); expect(view.result.current.connect).toBe(true); expect(room.disconnect).not.toHaveBeenCalled();
    const replacement = publication(Track.Source.ScreenShare);
    room.localParticipant.trackPublications.set("share", replacement);
    act(() => room.emit("published", replacement));
    expect(replacement.track.mediaStreamTrack.enabled).toBe(false);
    ended.track.mediaStreamTrack.readyState = "ended";
    view.rerender({ ...initial, keyScope: "epoch-1", allowRestore: (source) => source !== Track.Source.Microphone });
    await connectAndAdmit(view);
    expect(mic.track.mediaStreamTrack.enabled).toBe(false); expect(ended.track.mediaStreamTrack.enabled).toBe(false);
    expect(oldShare.track.mediaStreamTrack.enabled).toBe(false); expect(replacement.track.mediaStreamTrack.enabled).toBe(true); expect(camera.track.mediaStreamTrack.enabled).toBe(true);
    expect(sdk.rooms).toHaveLength(1); view.unmount();
  });

  it("closes media synchronously on auth replacement and never adopts a late enable completion", async () => {
    const pending = deferred(); sdk.enable.mockReturnValue(pending.promise);
    const initial = { ...options(), keyReady: true };
    const view = renderHook(() => useEncryptedRoomAdmission(initial));
    await waitFor(() => expect(sdk.rooms).toHaveLength(1));
    const room = sdk.rooms[0] as TestRoom, mic = publication(); room.localParticipant.trackPublications.set("mic", mic);
    act(() => publishAuthGenerationChange(11));
    expect(mic.track.mediaStreamTrack.enabled).toBe(false); expect(room.disconnect).toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(view.result.current.connect).toBe(false); expect(view.result.current.publishReady).toBe(false); view.unmount();
  });

  it("re-enables GCM after reconnect before restoring only current media and disconnects on worker failure", async () => {
    const initial = { ...options(), keyReady: true };
    const view = renderHook(() => useEncryptedRoomAdmission(initial));
    await connectAndAdmit(view);
    const room = view.result.current.room as unknown as TestRoom, mic = publication(); room.localParticipant.trackPublications.set("mic", mic);
    act(() => { room.state = "reconnecting"; room.emit("reconnecting"); });
    expect(mic.track.mediaStreamTrack.enabled).toBe(false); expect(view.result.current.publishReady).toBe(false);
    const pending = deferred(); sdk.enable.mockReturnValue(pending.promise);
    act(() => { room.state = "connected"; room.emit("reconnected"); }); expect(mic.track.mediaStreamTrack.enabled).toBe(false);
    mic.track.isMuted = true;
    await act(async () => pending.resolve()); await connectAndAdmit(view);
    expect(mic.track.mediaStreamTrack.enabled).toBe(false);
    const failure = new Error("worker cryptor failed"); act(() => room.emit("encryption-error", failure));
    expect(view.result.current.error).toBe(failure); expect(view.result.current.connect).toBe(false); expect(room.disconnect).toHaveBeenCalled(); view.unmount();
  });
  it("stops late SDK captures and unpublishes only an exact late publication after rekey or auth loss", async () => {
    const initial = { ...options(), keyReady:true };
    const view = renderHook((props: Options) => useEncryptedRoomAdmission(props), {initialProps:initial});
    await connectAndAdmit(view);
    const room = view.result.current.room as unknown as TestRoom;
    const participant = room.localParticipant as unknown as {createTracks:()=>Promise<unknown[]>;publishTrack:(track:unknown)=>Promise<unknown>;unpublishTrack:ReturnType<typeof vi.fn>};
    const track = {mediaStreamTrack:{enabled:true,readyState:"live"},stop:vi.fn()};
    // Delay the underlying SDK capture, not the admission wrapper.
    let finish!: (tracks:unknown[])=>void;
    // The mock SDK method is retained by the wrapper, so control its original promise through the fixture.
    const oldCapture = sdk.capture;
    sdk.capture = () => new Promise<unknown[]>((resolve)=>{finish=resolve;});
    const capture = participant.createTracks();
    view.rerender({...initial,keyScope:"next",keyReady:false});
    finish([track]); await expect(capture).rejects.toThrow("scope changed");
    expect(track.stop).toHaveBeenCalledOnce(); expect(track.mediaStreamTrack.enabled).toBe(false);
    sdk.capture=oldCapture;
    view.rerender({...initial,keyScope:"next"}); await connectAndAdmit(view);
    const late = {mediaStreamTrack:{enabled:true,readyState:"live"},stop:vi.fn()};
    let publishFinish!:()=>void;
    sdk.publish = (input:unknown)=>new Promise((resolve)=>{publishFinish=()=>resolve({track:input});});
    const publish=participant.publishTrack(late);
    act(()=>publishAuthGenerationChange(12));
    expect(late.mediaStreamTrack.enabled).toBe(false); expect(late.stop).toHaveBeenCalled();
    publishFinish(); await expect(publish).rejects.toThrow("scope changed");
    expect(late.stop).toHaveBeenCalled(); expect(participant.unpublishTrack).toHaveBeenCalledWith(late); view.unmount();
  });

  it("rejects a connected owner mismatch before any worker enable or publication admission",async()=>{
    const initial={...options(),keyReady:true};const view=renderHook(()=>useEncryptedRoomAdmission(initial));
    await waitFor(()=>expect(view.result.current.connect).toBe(true));
    const room=view.result.current.room as unknown as TestRoom;
    act(()=>{room.state="connected";room.localParticipant.identity="other";room.emit("connected");});
    await waitFor(()=>expect(view.result.current.error).toBeTruthy());expect(view.result.current.publishReady).toBe(false);
    expect(initial.worker?.postMessage).not.toHaveBeenCalled();expect(room.disconnect).toHaveBeenCalled();view.unmount();
  });
  it("allocates a fresh owned room under StrictMode and leaves retired wrappers deny-closed",async()=>{
    const initial={...options(),keyReady:true};const view=renderHook(()=>useEncryptedRoomAdmission(initial),{wrapper:StrictMode});
    await connectAndAdmit(view);expect(sdk.rooms.length).toBeGreaterThanOrEqual(2);
    const retired=sdk.rooms[0] as unknown as {localParticipant:{createTracks:()=>Promise<unknown[]>};disconnect:ReturnType<typeof vi.fn>};
    expect(retired.disconnect).toHaveBeenCalled();await expect(retired.localParticipant.createTracks()).rejects.toThrow("not admitted");
    expect(view.result.current.room).not.toBe(retired);view.unmount();
  });

  it("stops a GUM result belonging to a retired owner without touching a replacement room",async()=>{
    const initial={...options(),keyReady:true};const old=renderHook(()=>useEncryptedRoomAdmission(initial));await connectAndAdmit(old);
    const room=old.result.current.room as unknown as {localParticipant:{createTracks:()=>Promise<unknown[]>}};
    let finish!:(tracks:unknown[])=>void;sdk.capture=()=>new Promise(resolve=>{finish=resolve;});
    const pending=room.localParticipant.createTracks();
    act(()=>publishAuthGenerationChange(13));old.unmount();
    sdk.capture=async()=>[];
    const freshOptions={...options(),keyReady:true,scope:"new-room"};const fresh=renderHook(()=>useEncryptedRoomAdmission(freshOptions));await connectAndAdmit(fresh);
    const track={mediaStreamTrack:{enabled:true,readyState:"live"},stop:vi.fn()};finish([track]);await expect(pending).rejects.toThrow("scope changed");
    expect(track.stop).toHaveBeenCalledOnce();expect((fresh.result.current.room as unknown as TestRoom).disconnect).not.toHaveBeenCalled();expect(fresh.result.current.publishReady).toBe(true);fresh.unmount();
  });

});
