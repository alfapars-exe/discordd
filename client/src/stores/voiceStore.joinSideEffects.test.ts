import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceStore } from "./voiceStore";
import { useAuthStore } from "./authStore";
import * as nativePlugins from "../utils/nativePlugins";
import * as voiceApi from "../api/voice";
import { prepareAudioContext, releaseAudioContextWhenIdle } from "../utils/sounds";
import { beginVoiceJoinTiming, markVoiceJoinToken, settleVoiceJoinRequest } from "../audio/voiceJoinTiming";

// Same boundary as voiceStore.test.ts, plus the two collaborators under test:
// the cue AudioContext lifecycle and the join timing marks.
vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(), getAuthGeneration: () => 1 }));
vi.mock("../utils/sounds", () => ({ prepareAudioContext: vi.fn(), releaseAudioContextWhenIdle: vi.fn() }));
vi.mock("../audio/voiceJoinTiming", () => ({
  beginVoiceJoinTiming: vi.fn(), markVoiceJoinToken: vi.fn(), settleVoiceJoinRequest: vi.fn(),
}));
vi.mock("./preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: vi.fn() }) } }));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => ({ activeServerId: "srv1" }) } }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));

type TokenResponse = Awaited<ReturnType<typeof voiceApi.getVoiceToken>>;
const tokens = vi.mocked(voiceApi.getVoiceToken);
const http = { token: "http-token", url: "wss://http.test", channel_id: "voice" };
const tokenFor = (sub: string) => `h.${btoa(JSON.stringify({ sub }))}.s`;
const embedded = { token: tokenFor("me"), url: "wss://embedded.test", channel_id: "voice" };
const order = (mock: unknown) => vi.mocked(mock as () => void).mock.invocationCallOrder[0];

beforeEach(() => {
  vi.clearAllMocks();
  tokens.mockReset().mockResolvedValue({ success: true, data: http });
  useAuthStore.setState({ user: { id: "me" } as never });
  useVoiceStore.setState({ currentVoiceChannelId: null, pendingVoiceChannelId: null, livekitToken: null, livekitUrl: null, inputMode: "voice_activity" });
});
afterEach(() => {
  useVoiceStore.getState().leaveVoiceChannel();
  useAuthStore.setState({ user: null });
});

describe("joinVoiceChannel — cue AudioContext", () => {
  it("builds the context once the token request is in flight, before it resolves", async () => {
    let finish!: (response: TokenResponse) => void;
    tokens.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const joining = useVoiceStore.getState().joinVoiceChannel("voice");
    await vi.waitFor(() => expect(tokens).toHaveBeenCalledOnce());
    expect(prepareAudioContext).toHaveBeenCalledOnce();
    expect(order(tokens)).toBeLessThan(order(prepareAudioContext));
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    finish({ success: true, data: http });
    await joining;
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe("voice");
    expect(prepareAudioContext).toHaveBeenCalledOnce();
  });

  it("keeps the context for a join that carries its credentials", async () => {
    await useVoiceStore.getState().joinVoiceChannel("voice", { credentials: embedded });
    expect(tokens).not.toHaveBeenCalled();
    expect(prepareAudioContext).toHaveBeenCalledOnce();
  });

  it("builds nothing for a join that is cancelled before its request", async () => {
    const joining = useVoiceStore.getState().joinVoiceChannel("voice");
    useVoiceStore.getState().leaveVoiceChannel();
    await expect(joining).resolves.toBeNull();
    expect(prepareAudioContext).not.toHaveBeenCalled();
  });

  it("a leave hands the context over for an idle close instead of closing it", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "voice" });
    useVoiceStore.getState().leaveVoiceChannel();
    expect(releaseAudioContextWhenIdle).toHaveBeenCalledOnce();
  });

  it("a switch releases and then keeps the same context", async () => {
    useVoiceStore.setState({ currentVoiceChannelId: "old" });
    useVoiceStore.getState().leaveVoiceChannel();
    await useVoiceStore.getState().joinVoiceChannel("voice");
    expect(order(releaseAudioContextWhenIdle)).toBeLessThan(order(prepareAudioContext));
  });
});

describe("joinVoiceChannel — timing marks", () => {
  it("opens the attempt synchronously under the new generation, as a plain join by default", () => {
    const joining = useVoiceStore.getState().joinVoiceChannel("voice");
    expect(beginVoiceJoinTiming).toHaveBeenCalledExactlyOnceWith(useVoiceStore.getState()._joinGeneration, "join");
    return joining;
  });

  it.each(["switch", "move", "rejoin"] as const)("labels the attempt as a %s when the caller says so", async kind => {
    await useVoiceStore.getState().joinVoiceChannel("voice", { kind });
    expect(beginVoiceJoinTiming).toHaveBeenCalledExactlyOnceWith(useVoiceStore.getState()._joinGeneration, kind);
  });

  it("marks fetched credentials at the commit and then settles the request", async () => {
    await useVoiceStore.getState().joinVoiceChannel("voice");
    const generation = useVoiceStore.getState()._joinGeneration;
    expect(markVoiceJoinToken).toHaveBeenCalledExactlyOnceWith(generation, "fetched");
    expect(settleVoiceJoinRequest).toHaveBeenCalledExactlyOnceWith(generation);
    expect(order(markVoiceJoinToken)).toBeLessThan(order(settleVoiceJoinRequest));
  });

  it("marks credentials embedded in a move", async () => {
    await useVoiceStore.getState().joinVoiceChannel("voice", { credentials: embedded, kind: "move" });
    expect(markVoiceJoinToken).toHaveBeenCalledExactlyOnceWith(useVoiceStore.getState()._joinGeneration, "embedded");
  });

  it.each(["refused", "cancelled"])("settles a %s join without a token mark", async outcome => {
    if (outcome === "refused") tokens.mockResolvedValueOnce({ success: false, error: "denied" });
    const joining = useVoiceStore.getState().joinVoiceChannel("voice");
    const generation = useVoiceStore.getState()._joinGeneration;
    if (outcome === "cancelled") useVoiceStore.getState().leaveVoiceChannel();
    await expect(joining).resolves.toBeNull();
    expect(markVoiceJoinToken).not.toHaveBeenCalled();
    expect(settleVoiceJoinRequest).toHaveBeenCalledExactlyOnceWith(generation);
  });

  it("opens no attempt for native voice, whose room the JS client never reports", async () => {
    const native = vi.spyOn(nativePlugins, "isNativeVoice").mockReturnValue(true);
    const connect = vi.spyOn(nativePlugins, "nativeVoiceConnect").mockResolvedValue(undefined as never);
    const disconnect = vi.spyOn(nativePlugins, "nativeVoiceDisconnect").mockImplementation(() => undefined as never);
    try {
      await useVoiceStore.getState().joinVoiceChannel("voice");
      expect(useVoiceStore.getState().currentVoiceChannelId).toBe("voice");
      expect(beginVoiceJoinTiming).not.toHaveBeenCalled();
      useVoiceStore.getState().leaveVoiceChannel();
    } finally {
      native.mockRestore(); connect.mockRestore(); disconnect.mockRestore();
    }
  });
});
