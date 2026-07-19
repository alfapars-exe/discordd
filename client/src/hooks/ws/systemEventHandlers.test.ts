/**
 * systemEventHandlers — `ready` reconnect refetch tests.
 *
 * Bug being pinned: channel messages have no optimistic insert, so a
 * message bubble only appears via the WS `message_create` echo. If the
 * socket drops between POST and echo, that echo is lost — and because
 * messageStore guards refetch behind a module-level `fetchedChannels` set,
 * the channel is never fetched again for the life of the tab. The user sees
 * their message vanish and concludes the send failed.
 *
 * On a RE-connect `ready` (not the first one) we drop the fetched-flags so
 * the window can be rebuilt, and eagerly refetch the channel the user is
 * actually looking at. Other channels heal lazily on next visit.
 *
 * Each test re-imports the module under test through vi.resetModules() so
 * the module-level "have we been ready before" flag starts clean.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

vi.mock("../../stores/channelStore", () => ({
  useChannelStore: {
    getState: () => ({
      selectedChannelId: "ch-active",
      setMutedChannelsFromReady: vi.fn(),
      fetchChannels: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/messageStore", () => ({
  useMessageStore: {
    getState: () => ({
      invalidateFetchedFlags: vi.fn(),
      fetchMessages: vi.fn(),
      handleAuthorUpdate: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/memberStore", () => ({
  useMemberStore: { getState: () => ({ handleReady: vi.fn(), membersByServer: {} }) },
}));
vi.mock("../../stores/roleStore", () => ({ useRoleStore: { getState: () => ({}) } }));
vi.mock("../../stores/voiceStore", () => ({
  useVoiceStore: {
    getState: () => ({ currentVoiceChannelId: null, livekitToken: null }),
  },
}));
vi.mock("../../stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({
      setServersFromReady: vi.fn(),
      setMutedServersFromReady: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/readStateStore", () => ({
  useReadStateStore: { getState: () => ({ fetchAllUnreadCounts: vi.fn() }) },
}));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ setManualStatus: vi.fn(), user: { id: "me" } }) },
}));
vi.mock("../../stores/dmStore", () => ({
  useDMStore: {
    getState: () => ({ fetchChannels: vi.fn(), fetchDMSettings: vi.fn() }),
  },
}));
vi.mock("../../stores/friendStore", () => ({
  useFriendStore: { getState: () => ({ fetchFriends: vi.fn(), fetchRequests: vi.fn() }) },
}));
vi.mock("../../stores/blockStore", () => ({
  useBlockStore: { getState: () => ({ fetchBlocked: vi.fn() }) },
}));
vi.mock("../../stores/p2pCallStore", () => ({ useP2PCallStore: { getState: () => ({}) } }));
vi.mock("../../stores/e2eeStore", () => ({ useE2EEStore: { getState: () => ({}) } }));
vi.mock("../../stores/badgeStore", () => ({ useBadgeStore: { getState: () => ({}) } }));
vi.mock("../../stores/soundboardStore", () => ({
  useSoundboardStore: { getState: () => ({}) },
}));
vi.mock("../../stores/auditStore", () => ({ useAuditStore: { getState: () => ({}) } }));

const ctx: WSHandlerContext = { sendVoiceJoin: vi.fn() };

const readyMsg: WSMessage = {
  op: "ready",
  d: {
    online_user_ids: [],
    servers: [],
    muted_server_ids: [],
    muted_channel_ids: [],
    pref_status: "",
  },
};

/**
 * Fresh module graph per test so the module-level "seen ready before" flag
 * resets. Returns the handler plus the mocked messageStore spies, which are
 * re-created by the mock factory on every reset.
 */
async function loadFresh() {
  vi.resetModules();
  const { handleSystemEvent } = await import("./systemEventHandlers");
  const { useMessageStore } = await import("../../stores/messageStore");
  // getState() is a factory in the mock — capture one instance and pin it so
  // the handler and the assertions observe the same spies.
  const storeState = useMessageStore.getState();
  vi.spyOn(useMessageStore, "getState").mockReturnValue(storeState);
  return {
    handleSystemEvent,
    invalidateFetchedFlags: storeState.invalidateFetchedFlags,
    fetchMessages: storeState.fetchMessages,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSystemEvent — ready reconnect refetch", () => {
  it("does NOT invalidate or refetch on the first ready (initial connect)", async () => {
    const { handleSystemEvent, invalidateFetchedFlags, fetchMessages } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).not.toHaveBeenCalled();
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("invalidates fetched flags and refetches the active channel on a re-connect ready", async () => {
    const { handleSystemEvent, invalidateFetchedFlags, fetchMessages } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(1);
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages).toHaveBeenCalledWith("ch-active");
  });

  it("keeps invalidating on every subsequent reconnect", async () => {
    const { handleSystemEvent, invalidateFetchedFlags } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(2);
  });
});
