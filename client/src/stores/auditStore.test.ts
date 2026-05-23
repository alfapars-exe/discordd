/**
 * auditStore regression tests — covers the two silent-failure modes
 * we saw during the audit channel rollout:
 *
 *   1. Live WS event arrives before fetchInitial — the store drops
 *      it silently (intentional, to avoid showing a lone isolated
 *      event in an otherwise-empty panel). This contract has to
 *      stay locked.
 *
 *   2. Same audit row arrives twice (broadcast races a /audit fetch).
 *      The store must dedup by id. Otherwise the chat-like feed
 *      would show duplicates after a tab refocus.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the API module before importing the store so the fetch
// helpers don't hit the network during unit tests.
vi.mock("../api/audit", () => ({
  listServerAudit: vi.fn(async () => ({ success: true, data: { entries: [] } })),
}));

import { useAuditStore } from "./auditStore";
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

describe("auditStore.handleAuditEvent", () => {
  beforeEach(() => {
    // Reset store between tests — Zustand keeps state across describes.
    useAuditStore.setState({
      eventsByServer: {},
      hasMoreByServer: {},
      isLoadingByServer: {},
    });
  });

  it("drops live events for servers we haven't fetched yet", () => {
    useAuditStore.getState().handleAuditEvent(makeEvent({ server_id: "srv-1" }));
    expect(useAuditStore.getState().eventsByServer["srv-1"]).toBeUndefined();
  });

  it("appends to the existing server's list when fetched", () => {
    // Seed the server as fetched (empty list).
    useAuditStore.setState({
      eventsByServer: { "srv-1": [] },
    });

    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "e1" }));
    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "e2" }));

    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries).toHaveLength(2);
    expect(entries?.[0].id).toBe("e1");
    expect(entries?.[1].id).toBe("e2");
  });

  it("dedupes by id (broadcast races fetchInitial pagination)", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [] },
    });

    const ev = makeEvent({ id: "dup-id" });
    useAuditStore.getState().handleAuditEvent(ev);
    useAuditStore.getState().handleAuditEvent(ev);
    useAuditStore.getState().handleAuditEvent(ev);

    const entries = useAuditStore.getState().eventsByServer["srv-1"];
    expect(entries).toHaveLength(1);
    expect(entries?.[0].id).toBe("dup-id");
  });

  it("does not cross-pollinate between servers", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [], "srv-2": [] },
    });

    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "a", server_id: "srv-1" }));
    useAuditStore.getState().handleAuditEvent(makeEvent({ id: "b", server_id: "srv-2" }));

    expect(useAuditStore.getState().eventsByServer["srv-1"]).toHaveLength(1);
    expect(useAuditStore.getState().eventsByServer["srv-2"]).toHaveLength(1);
    expect(useAuditStore.getState().eventsByServer["srv-1"]?.[0].id).toBe("a");
    expect(useAuditStore.getState().eventsByServer["srv-2"]?.[0].id).toBe("b");
  });

  it("clearServer drops all per-server state", () => {
    useAuditStore.setState({
      eventsByServer: { "srv-1": [makeEvent()] },
      hasMoreByServer: { "srv-1": true },
      isLoadingByServer: { "srv-1": false },
    });

    useAuditStore.getState().clearServer("srv-1");

    expect(useAuditStore.getState().eventsByServer["srv-1"]).toBeUndefined();
    expect(useAuditStore.getState().hasMoreByServer["srv-1"]).toBeUndefined();
    expect(useAuditStore.getState().isLoadingByServer["srv-1"]).toBeUndefined();
  });
});
