import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicBotChannelState } from "../types";

const { addToast, voice } = vi.hoisted(() => ({
  addToast: vi.fn(),
  voice: {
    currentVoiceServerId: "s", currentVoiceChannelId: "c", _joinGeneration: 1,
    musicBotResetRevision: 0,
    musicBotStates: {} as Record<string, MusicBotChannelState>,
    musicBotRevisions: {} as Record<string, number>,
    setMusicBotState: vi.fn(), clearMusicBotState: vi.fn(),
  },
}));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => voice } }));
vi.mock("../utils/constants", () => ({
  API_BASE_URL: "https://api.test.local/api",
  SERVER_URL: "https://api.test.local",
  isElectron: () => true,
  isCapacitor: () => false,
  isAppProtocolPage: () => true,
}));

import i18n from "../i18n";
import { clearTokens } from "./client";
import { publishAuthOwnerChange } from "./authSessionEvents";
import { playMusic, searchMusic } from "./music";
import { showMusicRequestError } from "../utils/musicRequestError";

const radioURL = "https://www.youtube.com/watch?v=0KbRhUtFwkc&list=RD0KbRhUtFwkc&start_radio=1";
const fetchMock = vi.fn();
const providerFetch = vi.fn();
const session = { server_id: "s", channel_id: "c", session_id: "session", revision: 0, minimum_protocol: 2 };
const state: MusicBotChannelState = { ...session, is_active: false, is_paused: false, queue: [] };

beforeEach(() => {
  vi.clearAllMocks();
  clearTokens();
  publishAuthOwnerChange("human");
  voice.musicBotStates = {};
  voice.musicBotRevisions = {};
  voice.setMusicBotState.mockImplementation((channelId: string, next: MusicBotChannelState) => {
    voice.musicBotStates[channelId] = next;
    voice.musicBotRevisions[channelId] = (voice.musicBotRevisions[channelId] ?? 0) + 1;
  });
  voice.clearMusicBotState.mockImplementation((channelId: string) => { delete voice.musicBotStates[channelId]; });
  // Complete the current main protocol's adoption before exercising the
  // actual play response through apiClient and the localized toast helper.
  fetchMock.mockImplementation((url: string, options: RequestInit) => {
    const data = url.endsWith("/control-session") ? session : url.endsWith("/state") ? state : undefined;
    if (data) return Promise.resolve(new Response(JSON.stringify({ success: true, data }), {
      headers: { "Content-Type": "application/json" },
    }));
    return providerFetch(url, options);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["tr", "en"])("music API to toast feedback (%s)", (locale) => {
  beforeEach(async () => { await i18n.changeLanguage(locale); });

  it.each(["play", "search"])("identifies server-to-YouTube failure from JSON 502 on %s", async (action) => {
    providerFetch.mockResolvedValue(new Response(JSON.stringify({
      success: false,
      code: "MUSIC_NETWORK",
      error: "service_unavailable: private provider detail",
    }), { status: 502, headers: { "Content-Type": "application/json" } }));

    const response = action === "play"
      ? await playMusic("s", "c", radioURL)
      : await searchMusic("s", "c", "song");
    showMusicRequestError(response, "play");

    expect(response.code).toBe("MUSIC_NETWORK");
    expect(addToast).toHaveBeenCalledExactlyOnceWith("error", i18n.t("music:reason_network"));
    expect(addToast.mock.calls[0][1]).toContain("HiChat");
    expect(addToast.mock.calls[0][1]).toContain("YouTube");
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|private provider/i);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls[0][0]).toContain("app://hichat/api/servers/s/channels/c/music/");
  });

  it.each([502, 503, 504])("describes HTML HTTP %i as temporary service unavailability", async (status) => {
    providerFetch.mockResolvedValue(new Response("<html>edge detail</html>", {
      status, headers: { "Content-Type": "text/html" },
    }));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:serverMaintenance"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube|edge detail/i);
  });

  it("keeps malformed gateway JSON separate from classified provider errors", async () => {
    providerFetch.mockResolvedValue(new Response("<html>edge detail</html>", {
      status: 502, headers: { "Content-Type": "application/json" },
    }));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:serverMaintenance"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube|edge detail/i);
  });

  it("keeps client connectivity failure distinct from server-to-YouTube failure", async () => {
    providerFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:networkError"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube/i);
  });

  it("preserves ambiguous playback timeout feedback without replaying the POST", async () => {
    vi.useFakeTimers();
    providerFetch.mockReturnValue(new Promise<Response>(() => {}));
    const pending = playMusic("s", "c", radioURL);
    await vi.advanceTimersByTimeAsync(50_000);
    const response = await pending;
    showMusicRequestError(response, "play");
    expect(response.isTimeout).toBe(true);
    expect(addToast).toHaveBeenCalledExactlyOnceWith("info", i18n.t("music:playTimeout"));
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
