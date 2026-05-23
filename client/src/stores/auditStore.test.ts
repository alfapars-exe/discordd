/**
 * auditStore regression tests — pinned around the silent-failure modes
 * we saw in production (Track R) and the surrounding contract:
 *
 *   1. Live WS events MUST seed the events map when no fetch has run
 *      yet. Pre-Track-R the store dropped them, which is what caused
 *      voice-kick / voice-move actions to never appear in the Denetim
 *      channel until the user reopened it.
 *
 *   2. Dedup-by-id MUST skip empty-string ids. Pre-Track-R the server
 *      broadcast carried id="" because the SQLite Insert didn't echo
 *      back the DB-generated UUID; the second sequential event then
 *      hit `current.some(e => e.id === "")` → true → silently dropped.
 *
 *   3. fetchInitial MUST still run once per server even if WS events
 *      already seeded entries — that's how we backfill older history
 *      from the DB. The gate is now `initialFetchedByServer`, not the
 *      presence of the entries map.
 *
 *   4. fetchInitial MUST merge with WS-seeded entries (dedup by id when
 *      non-empty, then re-sort by created_at).
 *
 *   5. clearServer MUST drop the new initialFetchedByServer flag too
 *      so a server-leave / re-join cycle works cleanly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the API module before importing the store so the fetch
// helpers don't hit the network during unit tests.
vi.mock("../api/audit", () => ({
  listServerAudit: vi.fn(async () => ({ success: true, data: { entries: [] } })),
}));

import { useAuditStore } from "./auditStore";
import { listServerAudit } from "../api/audit";
import type { AuditLog } from "../types";

function makeEvent(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "evt-1",
    server_id: "srv-1",
    actor_user_id: "user-a",
    target_user_id: "user-b",
    event_type: "server_mute",
    metadata: "{}",
    created_at: "2026-05-23T10:00:00Z",
    ...overrides,
  };
}

function resetStore() {
  // Reset store between tests — Zustand keeps state across describes.
  useAuditStore.setState({
    eventsByServer: {},
    hasMoreByServer: {},
    isLoadingByServer: {},
    initialFetchedByServer: {},
  });
}

describe("auditStore.handleAuditEvent", () => {
  beforeEach(resetStore);

  it("seeds the events map when server hasn't been fetched yet (Track R bug 2a)", () => {
    // Pre-Track-R this test asserted the event was DROPPED. We flipped the
    // contract: moderation actions taken before the user opens the audit
    // channel must show up the moment they do, so we keep the event.
    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "live-1", server_id: "srv-1" }));

    const state = useAuditStore.getState();
    expect(state.eventsByServer["srv-1"]).toHaveLength(1);
    expect(state.eventsByServer["srv-1"]?.[0].id).toBe("live-1");
    // hasMore=true tells the channel UI there's older history to backfill
    // from the DB when the user opens the channel.
    expect(state.hasMoreByServer["srv-1"]).toBe(true);
    // We have NOT done a DB backfill yet — fetchInitial should still run.
    expect(state.initialFetchedByServer["srv-1"]).toBeFalsy();
  });

  it("appends to the existing server's list when fetched", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [] },
      initialFetchedByServer: { "srv-1": true },
    });

    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "e1" }));
    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "e2" }));

    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries).toHaveLength(2);
    expect(entries?.[0].id).toBe("e1");
    expect(entries?.[1].id).toBe("e2");
  });

  it("dedupes by id when broadcast races fetchInitial pagination", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [] },
      initialFetchedByServer: { "srv-1": true },
    });

    const ev = makeEvent({ id: "dup-id" });
    useAuditStore.getState().handleAuditEvent(ev);
    useAuditStore.getState().handleAuditEvent(ev);
    useAuditStore.getState().handleAuditEvent(ev);

    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries).toHaveLength(1);
    expect(entries?.[0].id).toBe("dup-id");
  });

  it("does NOT dedupe events that share an empty id (Track R bug 2b)", () => {
    // Pre-Track-R the server broadcast omitted the DB-generated id; every
    // event arrived with id="" and the dedup-by-id check collapsed them
    // into a single visible row. After the fix, empty ids skip the dedup
    // step so sequential events (kick → move → mute) all render.
    useAuditStore.setState({
      eventsByServer: { "srv-1": [] },
      initialFetchedByServer: { "srv-1": true },
    });

    useAuditStore.getState().handleAuditEvent(makeEvent({
      id: "",
      event_type: "voice_kick",
      created_at: "2026-05-23T10:00:00Z",
    }));
    useAuditStore.getState().handleAuditEvent(makeEvent({
      id: "",
      event_type: "voice_move",
      created_at: "2026-05-23T10:00:01Z",
    }));
    useAuditStore.getState().handleAuditEvent(makeEvent({
      id: "",
      event_type: "server_mute",
      created_at: "2026-05-23T10:00:02Z",
    }));

    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries).toHaveLength(3);
    expect(entries?.map((e) => e.event_type)).toEqual([
      "voice_kick",
      "voice_move",
      "server_mute",
    ]);
  });

  it("does not cross-pollinate between servers", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [], "srv-2": [] },
      initialFetchedByServer: { "srv-1": true, "srv-2": true },
    });

    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "a", server_id: "srv-1" }));
    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "b", server_id: "srv-2" }));

    expect(useAuditStore.getState().eventsByServer["srv-1"]).toHaveLength(1);
    expect(useAuditStore.getState().eventsByServer["srv-2"]).toHaveLength(1);
    expect(useAuditStore.getState().eventsByServer["srv-1"]?.[0].id).toBe("a");
    expect(useAuditStore.getState().eventsByServer["srv-2"]?.[0].id).toBe("b");
  });
});

describe("auditStore.fetchInitial", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(listServerAudit).mockReset();
  });

  it("merges WS-seeded entries with the DB backfill", async () => {
    // Simulate: a live event arrived before the channel was opened.
    const liveEvent = makeEvent({
      id: "live-1",
      created_at: "2026-05-23T10:00:30Z",
    });
    useAuditStore.getState().handleAuditEvent(liveEvent);

    // DB has two older entries.
    vi.mocked(listServerAudit).mockResolvedValueOnce({
      success: true,
      data: {
        entries: [
          makeEvent({ id: "db-2", created_at: "2026-05-23T10:00:20Z" }),
          makeEvent({ id: "db-1", created_at: "2026-05-23T10:00:10Z" }),
        ],
      },
    });

    await useAuditStore.getState().fetchInitial("srv-1");

    // Expected merge: oldest → newest by created_at.
    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries?.map((e) => e.id)).toEqual(["db-1", "db-2", "live-1"]);
    expect(useAuditStore.getState().initialFetchedByServer["srv-1"]).toBe(true);
  });

  it("dedupes when a WS-seeded entry also appears in the DB backfill", async () => {
    const sharedEvent = makeEvent({
      id: "shared-id",
      created_at: "2026-05-23T10:00:30Z",
    });
    useAuditStore.getState().handleAuditEvent(sharedEvent);

    vi.mocked(listServerAudit).mockResolvedValueOnce({
      success: true,
      data: { entries: [sharedEvent] },
    });

    await useAuditStore.getState().fetchInitial("srv-1");

    expect(useAuditStore.getState().eventsByServer["srv-1"]).toHaveLength(1);
  });

  it("does not refetch after initialFetchedByServer is set", async () => {
    vi.mocked(listServerAudit).mockResolvedValueOnce({
      success: true,
      data: { entries: [] },
    });

    await useAuditStore.getState().fetchInitial("srv-1");
    await useAuditStore.getState().fetchInitial("srv-1");
    await useAuditStore.getState().fetchInitial("srv-1");

    // Only the first call hits the API; the gate prevents further requests.
    expect(vi.mocked(listServerAudit)).toHaveBeenCalledTimes(1);
  });
});

describe("auditStore.clearServer", () => {
  beforeEach(resetStore);

  it("drops all per-server state including initialFetchedByServer", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [makeEvent()] },
      hasMoreByServer: { "srv-1": true },
      isLoadingByServer: { "srv-1": false },
      initialFetchedByServer: { "srv-1": true },
    });

    useAuditStore.getState().clearServer("srv-1");

    const state = useAuditStore.getState();
    expect(state.eventsByServer["srv-1"]).toBeUndefined();
    expect(state.hasMoreByServer["srv-1"]).toBeUndefined();
    expect(state.isLoadingByServer["srv-1"]).toBeUndefined();
    expect(state.initialFetchedByServer["srv-1"]).toBeUndefined();
  });
});
