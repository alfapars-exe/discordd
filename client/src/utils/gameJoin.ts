import { buildCS2SteamJoinURI, parseCS2SteamJoinRecipe } from "../../../electron/cs2-join-contract";
import type { ConsumedGameJoin, GameJoinTicket } from "../api/gameJoin";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validJoinTicket(value: GameJoinTicket, owner: string, target: string, revision: number, now = Date.now()): boolean {
  const expires = Date.parse(value?.expires_at);
  return !!value && uuid.test(value.ticket_id) && typeof value.ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.ticket)
    && value.viewer_user_id === owner && value.target_user_id === target && value.offer_revision === revision
    && Number.isSafeInteger(revision) && revision > 0 && value.adapter === "cs2-steam"
    && Number.isFinite(expires) && expires > now && expires <= now + 31_000;
}
/** Final web dispatch is deliberately separate from ticket preparation and only called by an explicit click. */
export function dispatchConsumedGameJoin(value: ConsumedGameJoin, ticket: GameJoinTicket, current: () => boolean,
  dispatch: (uri: string) => void = uri => window.location.assign(uri), now = Date.now()): boolean {
  if (!current() || !validJoinTicket(ticket, ticket.viewer_user_id, ticket.target_user_id, ticket.offer_revision, now)
    || value?.ticket_id !== ticket.ticket_id || value.viewer_user_id !== ticket.viewer_user_id
    || value.target_user_id !== ticket.target_user_id || value.offer_revision !== ticket.offer_revision
    || value.expires_at !== ticket.expires_at || !parseCS2SteamJoinRecipe(value.recipe)) return false;
  const uri = buildCS2SteamJoinURI(value.recipe);
  if (!uri || !current()) return false;
  try { dispatch(uri); return true; } catch { return false; }
}
