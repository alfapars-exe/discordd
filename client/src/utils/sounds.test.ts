import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type VoiceMock = { soundsEnabled: boolean; masterVolume: number; outputDevice: string; isDeafened: boolean; isServerDeafened: boolean; currentVoiceChannelId: string | null; pendingVoiceChannelId?: string | null; _joinGeneration: number };
type AuthMock = { manualStatus: string; user?: { id: string } | null };
const h = vi.hoisted(() => ({
  voice: { soundsEnabled: true, masterVolume: 100, outputDevice: "", isDeafened: false, isServerDeafened: false, currentVoiceChannelId: null, _joinGeneration: 0 } as VoiceMock,
  auth: { manualStatus: "online" } as AuthMock,
  a11y: { notificationSoundVolume: 80 },
  gains: [] as number[],
  oscillators: 0,
  oscillatorNodes: [] as Array<{ stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }>,
  gainNodes: [] as Array<{ gain: FakeParam }> ,
  voiceListeners: [] as Array<(state: VoiceMock, previous: VoiceMock) => void>,
  authListeners: [] as Array<(state: AuthMock) => void>,
  sinkCalls: [] as string[],
  sinkError: null as Error | null,
  sinkPromise: null as Promise<void> | null,
  removeSinkApi: false,
  prefs: { muteAllSounds:false,messageSound:true,incomingCallSound:true,soundPack:"classic" },
  preferenceListeners: [] as Array<()=>void>,
  accessibilityListeners: [] as Array<()=>void>,
  resumePromise: null as Promise<void>|null,
  initialContextState: "running",
  contexts: [] as FakeCtx[],
}));

vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => h.voice, subscribe: (fn: (state: VoiceMock, previous: VoiceMock) => void) => { h.voiceListeners.push(fn); return () => {}; } } }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => h.auth, subscribe: (fn: (state: AuthMock) => void) => { h.authListeners.push(fn); return () => {}; } } }));
vi.mock("../stores/preferencesStore",()=>({usePreferencesStore:{subscribe:(fn:()=>void)=>{h.preferenceListeners.push(fn);return()=>{}}}}));
vi.mock("./notificationPreferences",()=>({getNotificationPreferences:()=>h.prefs}));
vi.mock("../stores/accessibilityStore", () => ({ useAccessibilityStore: { getState: () => h.a11y, subscribe:(fn:()=>void)=>{h.accessibilityListeners.push(fn);return()=>{}} } }));

class FakeParam {
  setValueAtTime = vi.fn((v: number) => {
    h.gains.push(v);
  });
  linearRampToValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeCtx {
  state = h.initialContextState;
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => h.resumePromise ?? Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  setSinkId = vi.fn(async (id: string) => {
    h.sinkCalls.push(id);
    if (h.removeSinkApi) return;
    if (id && h.sinkError) throw h.sinkError;
    if (h.sinkPromise) await h.sinkPromise;
  });
  constructor() {
    h.contexts.push(this);
    if (h.removeSinkApi) delete (this as Partial<FakeCtx>).setSinkId;
  }
  decodeAudioData = vi.fn(async () => ({ duration: 1 } as AudioBuffer));
  createBufferSource() { return { ...this.createOscillator(), buffer: null }; }
  createOscillator() {
    h.oscillators++;
    const node = {
      type: "sine",
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    h.oscillatorNodes.push(node);
    return node;
  }
  createGain() {
    const node = { gain: new FakeParam(), connect: vi.fn(), disconnect: vi.fn() };
    h.gainNodes.push(node);
    return node;
  }
}

import { playNotificationSound, playJoinSound, previewIncomingCallSound, playWatchStartSound, playVoiceEventSound, VOICE_SOUND_EVENTS, VOICE_SOUND_PREFERENCES, VOICE_SOUND_ASSETS, playToneAt, closeAudioContext, prepareAudioContext, releaseAudioContextWhenIdle } from "./sounds";
const subscriptionsAtModuleImport = h.voiceListeners.length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
  closeAudioContext();
  h.voice = { soundsEnabled: true, masterVolume: 100, outputDevice: "", isDeafened: false, isServerDeafened: false, currentVoiceChannelId: null, _joinGeneration: 0 };
  h.auth = { manualStatus: "online" };
  h.a11y = { notificationSoundVolume: 80 };
  h.gains = [];
  h.oscillators = 0;
  h.oscillatorNodes = [];
  h.gainNodes = [];
  h.sinkCalls = [];
  h.sinkError = null;
  h.sinkPromise = null;
  h.removeSinkApi = false;
  h.prefs={muteAllSounds:false,messageSound:true,incomingCallSound:true,soundPack:"classic"};
  h.resumePromise=null;h.initialContextState="running";h.contexts=[];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function playNotification(): void {
  playNotificationSound();
  vi.advanceTimersByTime(100);
}

describe("playNotificationSound (Faz E bugfix)", () => {
  it("uses notificationSoundVolume: 50 → peak gain 0.5 × 0.6 × 0.3", async () => {
    h.a11y.notificationSoundVolume = 50;
    playNotification();
    await vi.waitFor(() => expect(h.gains).toHaveLength(2));
    expect(h.gains).toHaveLength(2);
    for (const g of h.gains) expect(g).toBeCloseTo(0.5 * 0.6 * 0.3, 9);
  });

  it("notificationSoundVolume 0 → no tone at all", () => {
    h.a11y.notificationSoundVolume = 0;
    playNotification();
    expect(h.oscillators).toBe(0);
  });

  it("masterVolume does not affect the notification gain", async () => {
    h.voice.masterVolume = 10;
    playNotification();
    await vi.waitFor(() => expect(h.gains).toHaveLength(2));
    const low = [...h.gains];
    h.gains = [];
    h.voice.masterVolume = 100;
    playNotification();
    await vi.waitFor(() => expect(h.gains.length).toBeGreaterThan(0));
    expect(h.gains).toEqual(low);
    expect(low[0]).toBeCloseTo(0.8 * 0.6 * 0.3, 9);
  });

  it.each(["dnd", "offline"])("is silent in %s", (status) => {
    h.auth.manualStatus = status;
    playNotification();
    expect(h.oscillators).toBe(0);
  });

  it("is silent when sounds are disabled", () => {
    h.voice.soundsEnabled = false;
    playNotification();
    expect(h.oscillators).toBe(0);
  });
});

describe("join sound / playToneAt", () => {
  it("does not subscribe to stores at module import", () => {
    expect(subscriptionsAtModuleImport).toBe(0);
  });

  it("join sound still follows masterVolume", async () => {
    h.voice.masterVolume = 40;
    playJoinSound();
    await vi.waitFor(() => expect(h.gains).toHaveLength(1));
    expect(h.gains[0]).toBeCloseTo(0.4, 9);
  });

  it("playToneAt returns a stop function", () => {
    const stop = playToneAt(440, 440, 0.2, 1, "square", 0.1);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("routes a selected output before starting the tone", async () => {
    h.voice.outputDevice = "usb-speaker";
    playToneAt(440, 440, 0.2, 1, "sine", 0, true);
    await vi.waitFor(() => expect(h.oscillatorNodes[0]?.start).toHaveBeenCalled());
    expect(h.sinkCalls[0]).toBe("usb-speaker");
  });
  it("restores the latest choice when a pending switch returns to the already-routed output", async () => {
    h.voice.outputDevice = "speaker-a";
    playToneAt(440, 440, 1, 1);
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    let finish!: () => void;
    h.sinkPromise = new Promise<void>((resolve) => { finish = resolve; });
    const original = h.voice;
    h.voice = { ...h.voice, outputDevice: "speaker-b" };
    for (const listener of h.voiceListeners) listener(h.voice, original);
    await vi.waitFor(() => expect(h.sinkCalls).toContain("speaker-b"));
    const pending = h.voice;
    h.voice = { ...h.voice, outputDevice: "speaker-a" };
    for (const listener of h.voiceListeners) listener(h.voice, pending);
    h.sinkPromise = null;
    finish();
    await vi.waitFor(() => expect(h.sinkCalls).toEqual(["speaker-a", "speaker-b", "speaker-a"]));
    expect(h.oscillatorNodes[0].stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending tone synchronously", async () => {
    h.voice.outputDevice = "usb-speaker";
    const stop = playToneAt(440, 440, 0.2, 1);
    stop();
    await Promise.resolve();
    expect(h.oscillatorNodes).toHaveLength(0);
  });

  it("falls back to the default sink only for a missing selected device", async () => {
    h.voice.outputDevice = "missing-device";
    h.sinkError = new DOMException("missing", "NotFoundError");
    playToneAt(440, 440, 0.2, 1);
    await vi.waitFor(() => expect(h.oscillatorNodes[0]?.start).toHaveBeenCalled());
    expect(h.sinkCalls).toEqual(["missing-device", ""]);
  });

  it.each(["unsupported custom output", "output permission failure"])("does not play through the default sink after %s", async (caseName) => {
    h.voice.outputDevice = "private-device";
    if (caseName.startsWith("unsupported")) h.removeSinkApi = true;
    else h.sinkError = new DOMException("denied", "NotAllowedError");
    playToneAt(440, 440, 0.2, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.oscillatorNodes).toHaveLength(0);
    expect(h.sinkCalls).not.toContain("");
  });

  it("cancels a tone awaiting output setup when the auth generation changes", async () => {
    let releaseRoute!: () => void;
    h.voice.outputDevice = "usb-speaker";
    h.sinkPromise = new Promise<void>((resolve) => { releaseRoute = resolve; });
    playToneAt(440, 440, 0.2, 1);
    await vi.waitFor(() => expect(h.sinkCalls).toContain("usb-speaker"));
    const { publishAuthGenerationChange } = await import("../api/authSessionEvents");
    publishAuthGenerationChange(Date.now());
    releaseRoute();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.oscillatorNodes).toHaveLength(0);
  });

  it("cancels a tone awaiting output setup when its context closes", async () => {
    let releaseRoute!: () => void;
    h.voice.outputDevice = "usb-speaker";
    h.sinkPromise = new Promise<void>((resolve) => { releaseRoute = resolve; });
    playToneAt(440, 440, 0.2, 1);
    await vi.waitFor(() => expect(h.sinkCalls).toContain("usb-speaker"));
    closeAudioContext();
    releaseRoute();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.oscillatorNodes).toHaveLength(0);
  });

  it("updates active voice tone volume and silences it on deafen", async () => {
    const previous = h.voice;
    playToneAt(440, 440, 0.2, 1, "sine", 0, true);
    await vi.waitFor(() => expect(h.gainNodes[0]).toBeDefined());
    h.voice = { ...h.voice, masterVolume: 25 };
    for (const listener of h.voiceListeners) listener(h.voice, previous);
    expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.075, 0);
    const beforeDeafen = h.voice;
    h.voice = { ...h.voice, isDeafened: true };
    for (const listener of h.voiceListeners) listener(h.voice, beforeDeafen);
    expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
  });
});

describe("bounded event sound authorization",()=>{
 it.each(["dnd","message-off","mute-all"])("rechecks %s after deferred sink and cancels active notification requests",async mode=>{
  let finish!:()=>void;h.sinkPromise=new Promise<void>(done=>{finish=done});playNotificationSound();await vi.waitFor(()=>expect(h.sinkCalls).toHaveLength(1));
  if(mode==="dnd"){h.auth.manualStatus="dnd";h.authListeners.forEach(fn=>fn(h.auth))}else{if(mode==="message-off")h.prefs.messageSound=false;else h.prefs.muteAllSounds=true;h.preferenceListeners.forEach(fn=>fn())}
  h.sinkPromise=null;finish();await vi.advanceTimersByTimeAsync(150);expect(h.oscillators).toBe(0);
 });
 it("cancels a sounding notification and its second note immediately on DND but keeps voice effects eligible",async()=>{
  playNotificationSound();await vi.waitFor(()=>expect(h.oscillators).toBe(1));h.auth.manualStatus="dnd";h.authListeners.forEach(fn=>fn(h.auth));expect(h.oscillatorNodes[0].stop).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(1);
  playJoinSound();await vi.waitFor(()=>expect(h.oscillators).toBe(2));
 });
 it("global mute cancels active voice effects and forbids scheduled watch notes, while explicit previews ignore DND",async()=>{
  playWatchStartSound();await vi.waitFor(()=>expect(h.oscillators).toBe(1));h.prefs.muteAllSounds=true;h.preferenceListeners.forEach(fn=>fn());expect(h.oscillatorNodes[0].stop).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(1);playJoinSound();expect(h.oscillators).toBe(1);
  h.prefs.muteAllSounds=false;h.auth.manualStatus="dnd";previewIncomingCallSound();await vi.waitFor(()=>expect(h.oscillators).toBe(3));
 });
 it("retires a timed-out sink engine, allows a fresh request, and ignores late old routing completion",async()=>{
  let finish!:()=>void;h.sinkPromise=new Promise<void>(done=>{finish=done});h.voice.outputDevice="speaker-a";playJoinSound();await vi.waitFor(()=>expect(h.sinkCalls).toHaveLength(1));const old=h.contexts[0];await vi.advanceTimersByTimeAsync(10001);expect(old.close).toHaveBeenCalledOnce();expect(h.oscillators).toBe(0);
  h.sinkPromise=null;h.voice.outputDevice="speaker-b";playJoinSound();await vi.waitFor(()=>expect(h.oscillators).toBe(1));expect(h.contexts).toHaveLength(2);finish();await vi.advanceTimersByTimeAsync(1);expect(h.oscillators).toBe(1);expect(h.contexts[1].setSinkId).toHaveBeenLastCalledWith("speaker-b");expect(h.contexts[1].close).not.toHaveBeenCalled();
 });
 it("bounds suspended resume and rejects a resolved resume that did not make context running",async()=>{
  h.initialContextState="suspended";h.resumePromise=new Promise(()=>{});playJoinSound();await vi.advanceTimersByTimeAsync(10001);expect(h.contexts[0].close).toHaveBeenCalledOnce();expect(h.oscillators).toBe(0);
  h.resumePromise=null;playJoinSound();await vi.advanceTimersByTimeAsync(1);expect(h.oscillators).toBe(0);
 });
 it("never starts a deferred resume after notification permission is revoked",async()=>{
  let finish!:()=>void;h.initialContextState="suspended";h.resumePromise=new Promise<void>(done=>{finish=done});playNotificationSound();await vi.advanceTimersByTimeAsync(1);h.prefs.messageSound=false;h.preferenceListeners.forEach(fn=>fn());h.contexts[0].state="running";finish();await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(0);
 });
});

it("does not resurrect a second note when notification permission is revoked and restored before its timer",async()=>{
 playNotificationSound();await vi.waitFor(()=>expect(h.oscillators).toBe(1));h.prefs.messageSound=false;h.preferenceListeners.forEach(fn=>fn());h.prefs.messageSound=true;h.preferenceListeners.forEach(fn=>fn());await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(1);
 playWatchStartSound();await vi.waitFor(()=>expect(h.oscillators).toBe(2));h.prefs.muteAllSounds=true;h.preferenceListeners.forEach(fn=>fn());h.prefs.muteAllSounds=false;h.preferenceListeners.forEach(fn=>fn());await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(2);
});

it("retires even a superseded timed-out route so its late completion cannot redirect the newer device",async()=>{
 let finish!:()=>void;h.voice.outputDevice="a";h.sinkPromise=new Promise<void>(done=>{finish=done});playJoinSound();await vi.waitFor(()=>expect(h.sinkCalls).toEqual(["a"]));const previous=h.voice;h.voice={...h.voice,outputDevice:"b"};h.voiceListeners.forEach(fn=>fn(h.voice,previous));await vi.advanceTimersByTimeAsync(10001);expect(h.contexts[0].close).toHaveBeenCalledOnce();expect(h.contexts[0].setSinkId).toHaveBeenCalledTimes(1);
 h.sinkPromise=null;playJoinSound();await vi.waitFor(()=>expect(h.oscillators).toBe(1));expect(h.contexts[1].setSinkId).toHaveBeenCalledWith("b");finish();await vi.advanceTimersByTimeAsync(1);expect(h.contexts[1].close).not.toHaveBeenCalled();expect(h.oscillators).toBe(1);
});

it.each(["notification","preview"])("volume zero retires deferred %s even if restored before routing completes",async kind=>{
 let finish!:()=>void;h.sinkPromise=new Promise<void>(done=>{finish=done});if(kind==="notification")playNotificationSound();else previewIncomingCallSound();await vi.waitFor(()=>expect(h.sinkCalls).toHaveLength(1));h.a11y.notificationSoundVolume=0;h.accessibilityListeners.forEach(fn=>fn());h.a11y.notificationSoundVolume=80;h.accessibilityListeners.forEach(fn=>fn());h.sinkPromise=null;finish();await vi.advanceTimersByTimeAsync(150);expect(h.oscillators).toBe(0);
});
it("volume zero immediately cancels sounding notification/preview but leaves master-following voice effects",async()=>{
 playNotificationSound();previewIncomingCallSound();playJoinSound();await vi.waitFor(()=>expect(h.oscillators).toBe(4));const voice=h.oscillatorNodes[3];h.a11y.notificationSoundVolume=0;h.accessibilityListeners.forEach(fn=>fn());for(const node of h.oscillatorNodes.slice(0,3))expect(node.stop).toHaveBeenCalledTimes(2);expect(voice.stop).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(4);
});

it.each(VOICE_SOUND_EVENTS)("uses actual %s catalog tone for preview and respects its individual switch",async event=>{
 playVoiceEventSound(event);await vi.waitFor(()=>expect(h.oscillators).toBeGreaterThan(0));closeAudioContext();h.oscillators=0;const key=VOICE_SOUND_PREFERENCES[event];Object.assign(h.prefs,{[key]:false});playVoiceEventSound(event);await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(0);
});

it("individual watch preference revoke/restore cannot resurrect its delayed second note",async()=>{
 playVoiceEventSound("watchStart");await vi.waitFor(()=>expect(h.oscillators).toBe(1));Object.assign(h.prefs,{voiceWatchStartSound:false});h.preferenceListeners.forEach(fn=>fn());Object.assign(h.prefs,{voiceWatchStartSound:true});h.preferenceListeners.forEach(fn=>fn());await vi.advanceTimersByTimeAsync(100);expect(h.oscillators).toBe(1);
});

it.each(Object.entries(VOICE_SOUND_ASSETS))("plays recorded %s exactly once", async (event, url) => {
 playVoiceEventSound(event as keyof typeof VOICE_SOUND_ASSETS);
 await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
 expect(url).toContain(event + ".m4a");
 expect(h.oscillatorNodes[0].start).toHaveBeenCalledOnce();
 expect(h.gains[0]).toBe(1);
});
it("updates other recorded cue volume and silences it when deafened", async () => {
 playVoiceEventSound("streamStart"); await vi.waitFor(() => expect(h.gainNodes).toHaveLength(1));
 const previous = h.voice; h.voice = { ...previous, masterVolume: 25 };
 h.voiceListeners.forEach(fn => fn(h.voice, previous));
 expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.25, 0);
 const beforeDeafen = h.voice; h.voice = { ...beforeDeafen, isDeafened: true };
 h.voiceListeners.forEach(fn => fn(h.voice, beforeDeafen));
 expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
});

describe("channel notifications while deafened", () => {
  it.each(["join", "leave"] as const)("keeps %s audible under self and server deafen without changing either flag", async event => {
    h.voice = { ...h.voice, isDeafened: true, isServerDeafened: true, masterVolume: 25, outputDevice: "headphones" };
    playVoiceEventSound(event);
    await vi.waitFor(() => expect(h.gainNodes).toHaveLength(1));
    expect(h.sinkCalls).toEqual(["headphones"]);
    expect(h.gains[0]).toBe(0.25);
    expect(h.voice.isDeafened).toBe(true);
    expect(h.voice.isServerDeafened).toBe(true);
    const previous = h.voice;
    h.voice = { ...h.voice, masterVolume: 0 };
    h.voiceListeners.forEach(listener => listener(h.voice, previous));
    expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
  });

  it.each(["sounds-disabled", "mute-all", "join-disabled", "leave-disabled"])("honors %s while deafened", async mode => {
    h.voice.isDeafened = true;
    if (mode === "sounds-disabled") h.voice.soundsEnabled = false;
    else if (mode === "mute-all") h.prefs.muteAllSounds = true;
    else Object.assign(h.prefs, { [mode === "join-disabled" ? "voiceJoinSound" : "voiceLeaveSound"]: false });
    playVoiceEventSound(mode === "leave-disabled" ? "leave" : "join");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.oscillatorNodes).toHaveLength(0);
  });

  it("does not silence an active channel cue when deafen changes", async () => {
    playJoinSound();
    await vi.waitFor(() => expect(h.gainNodes).toHaveLength(1));
    const previous = h.voice;
    h.voice = { ...h.voice, isDeafened: true, isServerDeafened: true };
    h.voiceListeners.forEach(listener => listener(h.voice, previous));
    expect(h.gainNodes[0].gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
  });

  it("drops a channel cue awaiting routing when a newer channel transition wins", async () => {
    let release!: () => void;
    h.sinkPromise = new Promise<void>(resolve => { release = resolve; });
    h.voice = { ...h.voice, currentVoiceChannelId: "old", _joinGeneration: 1, isDeafened: true };
    playJoinSound();
    await vi.waitFor(() => expect(h.sinkCalls).toHaveLength(1));
    const previous = h.voice;
    h.voice = { ...h.voice, currentVoiceChannelId: "new", _joinGeneration: 2 };
    h.voiceListeners.forEach(listener => listener(h.voice, previous));
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.oscillatorNodes).toHaveLength(0);
  });
});

describe("voice session context lifecycle", () => {
  const IDLE_MS = 60_000;
  /** Ends the synthesized cue at `index` the way the browser does. */
  const endCue = (index: number) => (h.oscillatorNodes[index] as unknown as { onended: () => void }).onended();

  it("builds the context when a join starts, and the join cue reuses it", async () => {
    prepareAudioContext();
    expect(h.contexts).toHaveLength(1);
    expect(h.oscillators).toBe(0);
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    expect(h.contexts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["sounds-disabled", "mute-all"])("builds nothing at join start with %s", mode => {
    if (mode === "sounds-disabled") h.voice.soundsEnabled = false;
    else h.prefs.muteAllSounds = true;
    prepareAudioContext();
    expect(h.contexts).toHaveLength(0);
  });

  it("leaves cues silent when the browser has no AudioContext", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => prepareAudioContext()).not.toThrow();
    expect(h.contexts).toHaveLength(0);
  });

  it("a leave silences the session's cues but closes the context only after a minute without voice", async () => {
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    const context = h.contexts[0];
    releaseAudioContextWhenIdle();
    expect(h.oscillatorNodes[0].stop).toHaveBeenCalledTimes(2);
    expect(context.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(context.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    // The next cue starts from a fresh context, as after the old immediate close.
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(2));
    expect(h.contexts).toHaveLength(2);
  });

  it("a switch or a move keeps one context: the next join start cancels the pending close", async () => {
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    releaseAudioContextWhenIdle();
    prepareAudioContext();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0].close).not.toHaveBeenCalled();
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(2));
    expect(h.contexts).toHaveLength(1);
  });

  it("a cue restarts the countdown and is never closed under", async () => {
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    const context = h.contexts[0];
    releaseAudioContextWhenIdle();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10_000);
    playVoiceEventSound("mute");
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(2));
    expect(h.contexts).toHaveLength(1);
    // The original deadline passes: the cue pushed it back.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.close).not.toHaveBeenCalled();
    // The restarted deadline passes while the cue is still sounding.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10_000);
    expect(context.close).not.toHaveBeenCalled();
    endCue(1);
    // Only a full idle minute after that deadline closes it. (waitFor polls
    // advance the fake clock a little, hence the margin.)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 5_000);
    expect(context.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it.each(["current", "pending"])("does not close under a %s voice session at the deadline", async kind => {
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    releaseAudioContextWhenIdle();
    if (kind === "current") h.voice.currentVoiceChannelId = "ch";
    else h.voice.pendingVoiceChannelId = "ch";
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(h.contexts[0].close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Publishes a voice store change to the module, the way zustand does. */
  const voiceChanges = (next: Partial<VoiceMock>) => {
    const previous = h.voice;
    h.voice = { ...h.voice, ...next };
    h.voiceListeners.forEach(listener => listener(h.voice, previous));
  };

  it("closes the context a minute after a join from idle that did not commit", async () => {
    voiceChanges({ pendingVoiceChannelId: "ch", _joinGeneration: 1 });
    prepareAudioContext();
    expect(h.contexts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // The token request is refused: only the pending channel is cleared.
    voiceChanges({ pendingVoiceChannelId: null });
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(h.contexts[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("restores the idle close a failed switch or move had cancelled", async () => {
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    voiceChanges({ currentVoiceChannelId: "old", _joinGeneration: 1 });
    voiceChanges({ currentVoiceChannelId: null, _joinGeneration: 2 });
    releaseAudioContextWhenIdle();
    voiceChanges({ pendingVoiceChannelId: "new", _joinGeneration: 3 });
    prepareAudioContext();
    expect(vi.getTimerCount()).toBe(0);
    voiceChanges({ pendingVoiceChannelId: null });
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("closes the context a minute after the server ends the session", async () => {
    voiceChanges({ currentVoiceChannelId: "ch", _joinGeneration: 1 });
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    expect(vi.getTimerCount()).toBe(0);
    // Forced disconnect, AFK kick and replacement clear the channel without a leave.
    voiceChanges({ currentVoiceChannelId: null, _joinGeneration: 2 });
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(h.contexts[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("starts no idle close when the join commits or voice was already idle", async () => {
    voiceChanges({ pendingVoiceChannelId: "ch", _joinGeneration: 1 });
    prepareAudioContext();
    voiceChanges({ currentVoiceChannelId: "ch" });
    voiceChanges({ pendingVoiceChannelId: null });
    expect(vi.getTimerCount()).toBe(0);
    closeAudioContext();
    // Outside voice a notification cue's context is left alone, as before.
    voiceChanges({ currentVoiceChannelId: null, _joinGeneration: 2 });
    playNotification();
    await vi.waitFor(() => expect(h.contexts).toHaveLength(2));
    voiceChanges({ masterVolume: 50 });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(h.contexts[1].close).not.toHaveBeenCalled();
  });

  it("leaves no timer behind without a context or after an explicit close", async () => {
    releaseAudioContextWhenIdle();
    expect(vi.getTimerCount()).toBe(0);
    playJoinSound();
    await vi.waitFor(() => expect(h.oscillatorNodes).toHaveLength(1));
    releaseAudioContextWhenIdle();
    releaseAudioContextWhenIdle();
    expect(vi.getTimerCount()).toBe(1);
    closeAudioContext();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(h.contexts[0].close).toHaveBeenCalledOnce();
  });
});
