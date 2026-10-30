import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));
vi.mock("../utils/constants", () => ({
  API_BASE_URL: "https://api.test.local/api",
  SERVER_URL: "https://api.test.local",
  isElectron: () => true,
  isCapacitor: () => false,
  isAppProtocolPage: () => true,
}));

import i18n, { changeLanguage, ensureNamespaces } from "../i18n";
import { clearTokens } from "./client";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "./authSessionEvents";
import { useVoiceStore } from "../stores/voiceStore";
import { playMusic, searchMusic } from "./music";
import { showMusicRequestError } from "../utils/musicRequestError";

const radioURL = "https://www.youtube.com/watch?v=0KbRhUtFwkc&list=RD0KbRhUtFwkc&start_radio=1";
const fetchMock = vi.fn();
let generation = 100;
const snapshot = { server_id: "s", channel_id: "c", session_id: "feedback-session", revision: 0,
  is_active: false, is_paused: true, queue: [], repeat_mode: "off" as const };

beforeEach(() => {
  vi.clearAllMocks();
  clearTokens();
  publishAuthOwnerChange("music-feedback-user");
  publishAuthGenerationChange(++generation);
  useVoiceStore.setState({ currentVoiceServerId: "s", currentVoiceChannelId: "c", musicBotStates: {}, musicBotRevisions: {} });
  // Keep the actual versioned music protocol and current-room checks. Only
  // successful adoption/state reads are supplied before the provider failure.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.endsWith("/control-session")) return Promise.resolve(new Response(JSON.stringify({ success: true,
      data: { ...snapshot, minimum_protocol: 2 } }), { headers: { "Content-Type": "application/json" } }));
    if (url.endsWith("/state")) return Promise.resolve(new Response(JSON.stringify({ success: true, data: snapshot }),
      { headers: { "Content-Type": "application/json" } }));
    return fetchMock(url, init);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["tr", "en"])("music API to toast feedback (%s)", (locale) => {
  beforeEach(async () => { await ensureNamespaces(["music"]); await changeLanguage(locale); });

  it.each(["play", "search"])("identifies server-to-YouTube failure from JSON 502 on %s", async (action) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("app://hichat/api/servers/s/channels/c/music/");
  });

  it.each([502, 503, 504])("describes HTML HTTP %i as temporary service unavailability", async (status) => {
    fetchMock.mockResolvedValue(new Response("<html>edge detail</html>", {
      status, headers: { "Content-Type": "text/html" },
    }));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:serverMaintenance"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube|edge detail/i);
  });

  it("keeps malformed gateway JSON separate from classified provider errors", async () => {
    fetchMock.mockResolvedValue(new Response("<html>edge detail</html>", {
      status: 502, headers: { "Content-Type": "application/json" },
    }));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:serverMaintenance"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube|edge detail/i);
  });

  it("keeps client connectivity failure distinct from server-to-YouTube failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    showMusicRequestError(await playMusic("s", "c", radioURL), "play");
    expect(addToast.mock.calls[0][1]).toBe(i18n.t("auth:networkError"));
    expect(addToast.mock.calls[0][1]).not.toMatch(/maintenance|bakım|YouTube/i);
  });

  it("preserves ambiguous playback timeout feedback without replaying the POST", async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const pending = playMusic("s", "c", radioURL);
    await vi.advanceTimersByTimeAsync(50_000);
    const response = await pending;
    showMusicRequestError(response, "play");
    expect(response.isTimeout).toBe(true);
    expect(addToast).toHaveBeenCalledExactlyOnceWith("info", i18n.t("music:playTimeout"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
