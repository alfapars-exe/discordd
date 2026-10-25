import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ apiClient: vi.fn() }));
import { apiClient } from "./client";
import { getMusicState, pauseMusic, playMusic, removeMusicQueueItem, reorderMusicQueue, restoreMusicSession, resumeMusic, searchMusic, seekMusic, setMusicRepeatMode, shuffleMusicQueue, skipMusic, stopMusic } from "./music";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient).mockResolvedValue({ success: true });
});

describe("music API request deadlines", () => {
  it.each([
    ["skip", skipMusic], ["pause", pauseMusic], ["resume", resumeMusic], ["stop", stopMusic],
  ] as const)("bounds %s without adding an automatic mutation retry", async (action, request) => {
    await request("origin-server", "voice-channel");
    expect(apiClient).toHaveBeenCalledExactlyOnceWith(`/servers/origin-server/channels/voice-channel/music/${action}`, {
      method: "POST", timeoutMs: 15_000,
    });
  });

  it("bounds initial state loading so retry remains available", async () => {
    await getMusicState("origin-server", "voice-channel");
    expect(apiClient).toHaveBeenCalledExactlyOnceWith("/servers/origin-server/channels/voice-channel/music/state", { timeoutMs: 15_000 });
  });

  it("preserves the longer extraction deadline for play", async () => {
    await playMusic("origin-server", "voice-channel", "https://youtu.be/example");
    expect(apiClient).toHaveBeenCalledExactlyOnceWith("/servers/origin-server/channels/voice-channel/music/play", {
      method: "POST", body: { url: "https://youtu.be/example" }, timeoutMs: 50_000,
    });
  });

  it("encodes bounded search text in the query string", async () => {
    await searchMusic("origin-server", "voice-channel", "daft punk & friends");
    expect(apiClient).toHaveBeenCalledExactlyOnceWith(
      "/servers/origin-server/channels/voice-channel/music/search?q=daft%20punk%20%26%20friends",
      { timeoutMs: 25_000 },
    );
  });

  it("uses stable queue IDs and optimistic revisions for queue mutations", async () => {
    await removeMusicQueueItem("s", "c", "item/id", 4);
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/queue/item%2Fid?revision=4", { method: "DELETE", timeoutMs: 15_000 });
    await reorderMusicQueue("s", "c", ["b", "a"], 5);
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/queue", {
      method: "PUT", body: { queue_item_ids: ["b", "a"], expected_revision: 5 }, timeoutMs: 15_000,
    });
    await shuffleMusicQueue("s", "c", 6);
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/shuffle", {
      method: "POST", body: { expected_revision: 6 }, timeoutMs: 15_000,
    });
    await setMusicRepeatMode("s", "c", "all");
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/repeat", {
      method: "PUT", body: { mode: "all" }, timeoutMs: 15_000,
    });
    await restoreMusicSession("s", "c");
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/restore", { method: "POST", timeoutMs: 15_000 });
    await seekMusic("s", "c", 42.9);
    expect(apiClient).toHaveBeenLastCalledWith("/servers/s/channels/c/music/seek", {
      method: "POST", body: { seconds: 42 }, timeoutMs: 15_000,
    });
  });
});
