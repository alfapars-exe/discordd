import { SERVER_URL } from "./constants";
import type { CategoryWithChannels, ServerListItem, User } from "../types";

// Display metadata only. Never restore authentication, permissions, messages or voice state.
export const STARTUP_CACHE_KEY = `hichat.startup.v1:${SERVER_URL}`;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024;
export type StartupSnapshot = {
  version: 1; savedAt: number;
  user: { id: string; name: string };
  servers: ServerListItem[];
  channels: Record<string, { id: string; name: string; type: string }[]>;
};
const text = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
export function clearStartupCache(): void { try { localStorage.removeItem(STARTUP_CACHE_KEY); } catch { /* optional storage */ } }
export function readStartupCache(): StartupSnapshot | null {
  try {
    const raw = localStorage.getItem(STARTUP_CACHE_KEY);
    if (!raw) return null;
    if (raw.length > MAX_BYTES) throw Error("oversize");
    const s = JSON.parse(raw) as StartupSnapshot;
    if (s.version !== 1 || !Number.isFinite(s.savedAt) || Date.now() - s.savedAt > MAX_AGE || s.savedAt > Date.now() + 60_000
      || !text(s.user?.id) || !text(s.user?.name) || !Array.isArray(s.servers) || s.servers.length > 100 || !s.channels || typeof s.channels !== "object" || Array.isArray(s.channels)) throw Error("invalid");
    // Reconstruct the allowlist instead of trusting arbitrary persisted properties.
    const servers = s.servers.map(x => { if (!text(x.id) || !text(x.name)) throw Error("server"); return { id: x.id, name: x.name, icon_url: null }; });
    const channels: StartupSnapshot["channels"] = {};
    for (const server of servers) {
      const rows = s.channels[server.id];
      if (!rows) continue;
      if (!Array.isArray(rows) || rows.length > 300) throw Error("channels");
      channels[server.id] = rows.map(x => { if (!text(x.id) || !text(x.name) || !["text", "voice", "screen", "forum", "announcement"].includes(x.type)) throw Error("channel"); return { id: x.id, name: x.name, type: x.type }; });
    }
    return { version: 1, savedAt: s.savedAt, user: { id: s.user.id, name: s.user.name }, servers, channels };
  } catch { clearStartupCache(); return null; }
}
function write(s: StartupSnapshot): void {
  try { const raw = JSON.stringify(s); if (raw.length <= MAX_BYTES) localStorage.setItem(STARTUP_CACHE_KEY, raw); } catch { /* quota/disabled disk must not prevent startup */ }
}
export function rememberStartupUser(user: Pick<User, "id" | "username" | "display_name">): void {
  const previous = readStartupCache();
  write({ version: 1, savedAt: Date.now(), user: { id: user.id, name: user.display_name || user.username }, servers: previous?.user.id === user.id ? previous.servers : [], channels: previous?.user.id === user.id ? previous.channels : {} });
}
export function rememberStartupServers(owner: string | null, servers: ServerListItem[]): void {
  const s = readStartupCache();
  if (!owner || s?.user.id !== owner) return;
  const ids = new Set(servers.slice(0, 100).map(x => x.id));
  write({ ...s, savedAt: Date.now(), servers: servers.slice(0, 100).map(x => ({ id: x.id, name: x.name, icon_url: null })), channels: Object.fromEntries(Object.entries(s.channels).filter(([id]) => ids.has(id))) });
}
export function rememberStartupChannels(owner: string | null, serverId: string, groups: CategoryWithChannels[]): void {
  const s = readStartupCache();
  if (!owner || s?.user.id !== owner || !s.servers.some(x => x.id === serverId)) return;
  write({ ...s, savedAt: Date.now(), channels: { ...s.channels, [serverId]: groups.flatMap(g => g.channels).slice(0, 300).map(x => ({ id: x.id, name: x.name, type: x.type })) } });
}
