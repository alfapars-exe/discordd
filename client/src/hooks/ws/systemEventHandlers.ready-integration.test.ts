import { beforeEach, expect, it, vi } from "vitest";
import { handleSystemEvent } from "./systemEventHandlers";
import { setTokens } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import type { WSMessage } from "../../types";

// Exercise real ready/store wiring without making background HTTP requests.
vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  apiClient: vi.fn(async () => ({ success: false, error: "isolated fixture" })),
}));

beforeEach(() => {
  setTokens("ready-integration-token", "", "ready-viewer");
  useAuthStore.setState({ user: { id: "ready-viewer" } as never });
  useServerStore.setState({ servers: [], activeServerId: null });
});

it("processes ready with real store implementations and publishes the server list before connected", async () => {
  const status = vi.fn();
  await handleSystemEvent({ op: "ready", d: {
    online_user_ids: ["ready-viewer"], servers: [{ id: "ready-server", name: "Ready server", icon_url: null }],
    muted_server_ids: [], muted_channel_ids: [], pref_status: "online", voice_epoch: "ready-voice", game_activity_epoch: "ready-game",
  } } as WSMessage, { sendVoiceJoin: vi.fn() }, status);
  expect(status).toHaveBeenCalledWith("connected");
  expect(useServerStore.getState().servers.map((server) => server.id)).toEqual(["ready-server"]);
});


it("refreshes keys even when a LiveKit token survives an API reconnect", async () => {
  const { useVoiceStore } = await import("../../stores/voiceStore");
  const original = useVoiceStore.getState().refreshVoiceToken;
  let finish!: (value: never) => void;
  const refresh = vi.fn(() => new Promise<never>((resolve) => { finish = resolve; }));
  useVoiceStore.setState({ currentVoiceChannelId: "voice", currentVoiceServerId: "server", livekitToken: "retained", refreshVoiceToken: refresh });
  const sendVoiceJoin = vi.fn();
  await handleSystemEvent({ op: "ready", d: { online_user_ids: [], servers: [], muted_server_ids: [], muted_channel_ids: [], pref_status: "online", voice_epoch: "restarted", game_activity_epoch: "game" } } as unknown as WSMessage, { sendVoiceJoin }, vi.fn());
  expect(refresh).toHaveBeenCalledWith("voice");
  expect(sendVoiceJoin).not.toHaveBeenCalled();
  finish({ token: "fresh" } as never);
  await Promise.resolve();
  expect(sendVoiceJoin).toHaveBeenCalledWith("voice");
  useVoiceStore.setState({ currentVoiceChannelId: null, livekitToken: null, refreshVoiceToken: original });
});
