import { describe, expect, it } from "vitest";
import type { FriendshipWithUser } from "../types/friend";
import { gameActivityKey } from "../stores/gameActivityStore";
import { projectOverlayActivity, type OverlayActivityEntry, type OverlayActivityProjectionInput } from "./overlayActivity";

const game = { id: "local-game-id", name: "Example Game", started_at: "2026-10-25T09:00:00Z" };

function friend(userId: string, overrides: Partial<FriendshipWithUser> = {}): FriendshipWithUser {
  return {
    id: `friendship-${userId}`,
    status: "accepted",
    created_at: "2026-10-25T08:00:00Z",
    user_id: userId,
    username: `${userId}-handle`,
    display_name: `${userId} display`,
    avatar_url: null,
    user_status: "online",
    user_custom_status: null,
    ...overrides,
  };
}

function input(overrides: Partial<OverlayActivityProjectionInput> = {}): OverlayActivityProjectionInput {
  const target = friend("friend-1");
  return {
    ownerId: "viewer",
    authGeneration: 7,
    currentOwnerId: "viewer",
    currentAuthGeneration: 7,
    epoch: "ready-epoch-1",
    entries: { [gameActivityKey(target.user_id)]: { revision: 1, game } },
    friends: [target],
    blockedUserIds: [],
    statusByUserId: {},
    ...overrides,
  };
}

describe("projectOverlayActivity", () => {
  it("fails closed for mismatched auth ownership, generation, or missing epoch", () => {
    expect(projectOverlayActivity(input({ currentOwnerId: "other" }))).toEqual([]);
    expect(projectOverlayActivity(input({ currentAuthGeneration: 8 }))).toEqual([]);
    expect(projectOverlayActivity(input({ authGeneration: -1 }))).toEqual([]);
    expect(projectOverlayActivity(input({ epoch: null }))).toEqual([]);
    expect(projectOverlayActivity(input({ epoch: "" }))).toEqual([]);
  });

  it("projects only global grants and ignores server-only grants and revocation tombstones", () => {
    const serverOnly = friend("server-only");
    const revoked = friend("revoked");
    const globalFriend = friend("global");
    const entries: Record<string, OverlayActivityEntry> = {
      [gameActivityKey(serverOnly.user_id, "server-1")]: { revision: 2, game },
      [gameActivityKey(revoked.user_id)]: { revision: 3, game: null },
      [gameActivityKey(globalFriend.user_id)]: { revision: 4, game },
    };
    expect(projectOverlayActivity(input({ friends: [serverOnly, revoked, globalFriend], entries }))).toEqual([
      { userId: "global", label: "global display", gameName: "Example Game" },
    ]);
  });

  it("requires accepted friendship and uses live presence over the friendship fallback", () => {
    const pending = friend("pending", { status: "pending" });
    const blockedByViewer = friend("blocked");
    const offlineFallback = friend("offline-fallback", { user_status: "offline" });
    const liveOnline = friend("live-online", { user_status: "offline" });
    const liveOffline = friend("live-offline", { user_status: "online" });
    const entries: Record<string, OverlayActivityEntry> = Object.fromEntries(
      [pending, blockedByViewer, offlineFallback, liveOnline, liveOffline].map((row) => [gameActivityKey(row.user_id), { revision: 1, game }]),
    );
    expect(projectOverlayActivity(input({
      friends: [pending, blockedByViewer, offlineFallback, liveOnline, liveOffline],
      blockedUserIds: [blockedByViewer.user_id],
      statusByUserId: { [liveOnline.user_id]: "idle", [liveOffline.user_id]: "offline" },
      entries,
    }))).toEqual([{ userId: "live-online", label: "live-online display", gameName: "Example Game" }]);
  });

  it("omits malformed names and tombstones without leaking IDs, URLs, or timestamps", () => {
    const good = friend("good");
    const badPath = friend("bad-path");
    const badControl = friend("bad-control");
    const tooLong = friend("too-long");
    const revoked = friend("revoked");
    const entries: Record<string, OverlayActivityEntry> = {
      [gameActivityKey(good.user_id)]: { revision: 1, game },
      [gameActivityKey(badPath.user_id)]: { revision: 1, game: { ...game, name: "C:\\Games\\title.exe" } },
      [gameActivityKey(badControl.user_id)]: { revision: 1, game: { ...game, name: "bad\nname" } },
      [gameActivityKey(tooLong.user_id)]: { revision: 1, game: { ...game, name: "x".repeat(81) } },
      [gameActivityKey(revoked.user_id)]: { revision: 2, game: null },
    };
    const result = projectOverlayActivity(input({ friends: [good, badPath, badControl, tooLong, revoked], entries }));
    expect(result).toEqual([{ userId: "good", label: "good display", gameName: "Example Game" }]);
    expect(JSON.stringify(result)).not.toContain("started_at");
    expect(JSON.stringify(result)).not.toContain("local-game-id");
  });

  it("uses username when display name is empty and preserves friend order with a five-item cap", () => {
    const friends = Array.from({ length: 7 }, (_, index) => friend(`f-${index}`, {
      ...(index === 0 ? { display_name: " " } : {}),
    }));
    const entries: Record<string, OverlayActivityEntry> = Object.fromEntries(
      friends.map((row) => [gameActivityKey(row.user_id), { revision: 1, game }]),
    );
    const result = projectOverlayActivity(input({ friends, entries }));
    expect(result).toHaveLength(5);
    expect(result.map((row) => row.userId)).toEqual(["f-0", "f-1", "f-2", "f-3", "f-4"]);
    expect(result[0]?.label).toBe("f-0-handle");
  });
});
