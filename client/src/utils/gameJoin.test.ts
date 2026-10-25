import { describe, expect, it, vi } from "vitest";
import { dispatchConsumedGameJoin, validJoinTicket } from "./gameJoin";
import type { GameJoinTicket, ConsumedGameJoin } from "../api/gameJoin";
const now = Date.parse("2026-10-25T12:00:00Z");
const ticket: GameJoinTicket = { ticket_id: "12345678-1234-4234-8234-123456789abc", ticket: "a".repeat(43), viewer_user_id: "viewer", target_user_id: "target", offer_revision: 7, expires_at: new Date(now + 20000).toISOString(), adapter: "cs2-steam" };
const id = (kind: bigint, instance: bigint) => ((1n << 56n) | (kind << 52n) | (instance << 32n) | 123n).toString();
const consumed: ConsumedGameJoin = { ticket_id: ticket.ticket_id, viewer_user_id: "viewer", target_user_id: "target", offer_revision: 7, expires_at: ticket.expires_at,
  recipe: { adapter: "cs2-steam", lobbyId: id(8n, 1n << 18n), inviterId: id(1n, 1n) } };
describe("CS2 final web dispatch", () => {
  it("forwards only a reconstructed supported URI, never claims successful joining", () => {
    const launch = vi.fn();
    expect(dispatchConsumedGameJoin(consumed, ticket, () => true, launch, now)).toBe(true);
    expect(launch).toHaveBeenCalledWith(`steam://joinlobby/730/${consumed.recipe.lobbyId}/${consumed.recipe.inviterId}`);
  });
  it.each([
    { target_user_id: "other" }, { viewer_user_id: "other" }, { offer_revision: 8 }, { ticket_id: "87654321-1234-4234-8234-123456789abc" },
    { expires_at: new Date(now + 25000).toISOString() }, { recipe: { ...consumed.recipe, adapter: "arbitrary" } },
    { recipe: { ...consumed.recipe, url: "file:///C:/malicious.exe" } },
  ])("rejects a replaced identity/revision/expiry/recipe %j", patch => {
    const launch = vi.fn();
    expect(dispatchConsumedGameJoin({ ...consumed, ...patch } as ConsumedGameJoin, ticket, () => true, launch, now)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
  it("denies stale authorization, expired/far-future tickets and failed protocol handlers", () => {
    expect(dispatchConsumedGameJoin(consumed, ticket, () => false, vi.fn(), now)).toBe(false);
    expect(validJoinTicket(ticket, "viewer", "target", 7, now + 20000)).toBe(false);
    expect(validJoinTicket({ ...ticket, expires_at: new Date(now + 40000).toISOString() }, "viewer", "target", 7, now)).toBe(false);
    expect(dispatchConsumedGameJoin(consumed, ticket, () => true, () => { throw new Error("blocked"); }, now)).toBe(false);
  });
});
