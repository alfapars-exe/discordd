import { randomUUID } from "node:crypto";
import { sanitizeUpstreamOrigin } from "./api-proxy";
import { buildCS2SteamJoinURI } from "./cs2-join-contract";

export interface GameJoinContext { origin: string; ownerId: string; generation: number; nonce: string }
export interface CS2JoinRequest { scopeNonce: string; ticketId: string; ticket: string; targetUserId: string; offerRevision: number; accessToken: string; requestId: string }
export type CS2JoinStatus = "forwarded" | "denied" | "expired" | "busy" | "unavailable" | "error";
export interface GameJoinContextAck { accepted: boolean; scopeNonce: string | null }
type Endpoint = object;
type Context = GameJoinContext & { scopeNonce: string; endpoint: Endpoint };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userID = /^[A-Za-z0-9_-]{1,128}$/;
function record(raw: unknown, keys: string[]): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(raw).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(raw, key));
}
const revision = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;

/** Main-process only. No token, invite or ticket is persisted or logged. */
export function createCS2JoinController(options: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  openExternal: (url: string) => Promise<unknown>;
  isCurrent: (endpoint: Endpoint) => boolean;
  allowLoopback?: boolean; now?: () => number; timeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  let context: Context | null = null;
  let pending: AbortController | null = null;
  const consumed = new Map<string, number>();
  const attempts: number[] = [];
  const current = (value: Context) => context === value && options.isCurrent(value.endpoint);
  function retire(endpoint?: Endpoint) {
    if (endpoint && context?.endpoint !== endpoint) return;
    context = null;
    pending?.abort();
    pending = null;
  }
  function sync(endpoint: Endpoint, raw: unknown): GameJoinContextAck {
    if (!options.isCurrent(endpoint)) return { accepted: false, scopeNonce: null };
    if (raw === null) { retire(); return { accepted: true, scopeNonce: null }; }
    if (!record(raw, ["origin", "ownerId", "generation", "nonce"]) || typeof raw.origin !== "string" || raw.origin.length > 2048 || typeof raw.ownerId !== "string" || !userID.test(raw.ownerId) || typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 0 || typeof raw.nonce !== "string" || !uuid.test(raw.nonce)) {
      retire(); return { accepted: false, scopeNonce: null };
    }
    const origin = sanitizeUpstreamOrigin(raw.origin, { allowLoopback: options.allowLoopback });
    if (!origin || origin !== raw.origin) { retire(); return { accepted: false, scopeNonce: null }; }
    if (context && context.endpoint === endpoint && context.origin === origin && context.ownerId === raw.ownerId && context.generation === raw.generation && context.nonce === raw.nonce) return { accepted: true, scopeNonce: context.scopeNonce };
    retire();
    context = { origin, ownerId: raw.ownerId, generation: raw.generation, nonce: raw.nonce, endpoint, scopeNonce: randomUUID() };
    return { accepted: true, scopeNonce: context.scopeNonce };
  }
  async function launch(endpoint: Endpoint, raw: unknown): Promise<CS2JoinStatus> {
    const active = context;
    if (!active || active.endpoint !== endpoint || !current(active)) return "denied";
    if (!record(raw, ["scopeNonce", "ticketId", "ticket", "targetUserId", "offerRevision", "accessToken", "requestId"]) || raw.scopeNonce !== active.scopeNonce || typeof raw.ticketId !== "string" || !uuid.test(raw.ticketId) || typeof raw.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.ticket) || typeof raw.targetUserId !== "string" || !userID.test(raw.targetUserId) || !revision(raw.offerRevision) || typeof raw.accessToken !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(raw.accessToken) || typeof raw.requestId !== "string" || !uuid.test(raw.requestId)) return "denied";
    if (pending) return "busy";
    const at = now();
    for (const [key, expiry] of consumed) if (expiry <= at) consumed.delete(key);
    while (attempts.length && attempts[0] <= at - 10_000) attempts.shift();
    if (attempts.length >= 10 || consumed.has(raw.ticketId) || consumed.has(raw.requestId) || consumed.size >= 256) return "denied";
    attempts.push(at);
    // Reserve before any await; even a failed network call needs a newly minted ticket.
    consumed.set(raw.ticketId, at + 35_000); consumed.set(raw.requestId, at + 35_000);
    const abort = new AbortController(); pending = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async (): Promise<CS2JoinStatus> => {
      const response = await options.fetch(`${active.origin}/api/game-join/tickets/consume`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw.accessToken}` },
        body: JSON.stringify({ ticket: raw.ticket, expected_user_id: active.ownerId }),
        redirect: "error", credentials: "omit", cache: "no-store", signal: abort.signal,
      });
      try {
      if (!current(active) || abort.signal.aborted) return "denied";
      if (response.status === 410) return "expired";
      if ([401, 403, 404, 409].includes(response.status)) return "denied";
      if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return "error";
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) return "error";
      if (!response.body) return "error";
      const reader = response.body.getReader();
      const cancelReader = () => { try { void reader.cancel().catch(() => undefined); } catch { /* Teardown cannot prolong or reject the operation. */ } };
      abort.signal.addEventListener("abort", cancelReader, { once: true });
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (!current(active) || abort.signal.aborted) return "denied";
          if (item.done) break;
          length += item.value.byteLength;
          if (length > 65_536) return "error";
          chunks.push(item.value);
        }
      } finally { abort.signal.removeEventListener("abort", cancelReader); cancelReader(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(envelope, ["success", "data"]) || envelope.success !== true || !record(envelope.data, ["ticket_id", "viewer_user_id", "target_user_id", "offer_revision", "expires_at", "recipe"])) return "error";
      const data = envelope.data;
      if (data.ticket_id !== raw.ticketId || data.viewer_user_id !== active.ownerId || data.target_user_id !== raw.targetUserId || data.offer_revision !== raw.offerRevision || typeof data.expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(data.expires_at)) return "denied";
      const expiry = Date.parse(data.expires_at);
      if (!Number.isFinite(expiry) || expiry <= now()) return "expired";
      if (expiry > now() + 35_000) return "denied";
      const uri = buildCS2SteamJoinURI(data.recipe);
      if (!uri || !current(active) || abort.signal.aborted) return "denied";
      // This is the irreversible dispatch boundary, not proof Steam joined a lobby.
      await options.openExternal(uri);
      return current(active) && !abort.signal.aborted ? "forwarded" : "denied";
      } finally {
        // Also retire bodies rejected before a reader was acquired: HTTP errors,
        // content-type/length rejection, and late fetch responses after logout.
        // A hostile/hung cancellation must never keep IPC pending past its deadline.
        try { if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined); } catch { /* Best-effort bounded cleanup. */ }
      }
    };
    try {
      return await Promise.race([operation(), new Promise<CS2JoinStatus>(resolve => {
        timer = setTimeout(() => { abort.abort(); resolve("error"); }, options.timeoutMs ?? 8000);
      })]);
    } catch { return current(active) && !abort.signal.aborted ? "error" : "denied"; }
    finally { if (timer) clearTimeout(timer); if (pending === abort) pending = null; }
  }
  return { sync, launch, retire };
}
