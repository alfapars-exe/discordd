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
 * the window can be rebuilt, and eagerly refetch what the user can actually
 * SEE: the active text tab of every panel (split view shows several channels
 * at once), each with its own serverId, plus the sidebar selection. Background
 * tabs heal lazily on next visit.
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
// Two panels: panel-1's ACTIVE tab is a cross-server channel (its own
// serverId), with a background tab that must NOT be eagerly healed; panel-2's
// active tab shows the sidebar-selected channel.
vi.mock("../../stores/uiStore", () => ({
  useUIStore: {
    getState: () => ({
      panels: {
        "panel-1": {
          id: "panel-1",
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              channelId: "ch-tab-1",
              type: "text",
              label: "genel",
              serverInfo: { serverId: "srv-9", serverName: "Other", serverIconUrl: null },
            },
            { id: "tab-bg", channelId: "ch-bg", type: "text", label: "arka-plan" },
          ],
        },
        "panel-2": {
          id: "panel-2",
          activeTabId: "tab-2",
          tabs: [
            {
              id: "tab-2",
              channelId: "ch-active",
              type: "text",
              label: "aktif",
              serverInfo: { serverId: "srv-1", serverName: "Main", serverIconUrl: null },
            },
          ],
        },
      },
    }),
  },
}));

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

  it("invalidates fetched flags and refetches every panel's ACTIVE tab (own serverId) on a re-connect ready", async () => {
    const { handleSystemEvent, invalidateFetchedFlags, fetchMessages } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(1);
    // panel-1 active tab (cross-server, explicit serverId) + panel-2 active
    // tab (which also covers the sidebar selection — no duplicate fetch).
    expect(fetchMessages).toHaveBeenCalledTimes(2);
    expect(fetchMessages).toHaveBeenCalledWith("ch-tab-1", "srv-9");
    expect(fetchMessages).toHaveBeenCalledWith("ch-active", "srv-1");
    // Background tabs heal lazily — never eagerly fetched.
    expect(fetchMessages).not.toHaveBeenCalledWith("ch-bg", undefined);
  });

  it("keeps invalidating on every subsequent reconnect", async () => {
    const { handleSystemEvent, invalidateFetchedFlags } = await loadFresh();

    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());
    await handleSystemEvent(readyMsg, ctx, vi.fn());

    expect(invalidateFetchedFlags).toHaveBeenCalledTimes(2);
  });
});
