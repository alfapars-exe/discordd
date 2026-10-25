/** Pure local-video wire contract. No Electron/Node/runtime or credentials. */
export type OverlayVideoKind = "camera" | "screen";
export type OverlayMediaSource = { mid: string; tileId: string; kind: OverlayVideoKind };
export type OverlayICECandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null };
type Base = { protocol: 1; session: string; revision: number };
export type OverlayMediaEnvelope = Base & (
 { kind: "offer"; descriptionId: string; sdp: string; sources: OverlayMediaSource[] } |
 { kind: "answer"; descriptionId: string; replyTo: string; sdp: string } |
 { kind: "candidate"; offerId: string; descriptionId: string; candidate: OverlayICECandidate } |
 { kind: "end"; reason: "closed" | "scope" | "source" | "error" });
export type OverlaySDPSection = { mid: string; direction: "sendonly" | "recvonly"; active: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const token = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && /^[A-Za-z0-9_-]+$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
/** Only same-machine host candidates: no STUN/TURN or arbitrary DNS targets. */
export function isLocalOverlayAddress(value: string): boolean {
 if (/^[a-z0-9-]{1,63}\.local$/i.test(value)) return true;
 if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) { const parts = value.split("."); if (parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part))) return false; const ip = parts.map(Number); if (ip.some(part => part > 255)) return false; return ip[0] === 10 || ip[0] === 127 || ip[0] === 192 && ip[1] === 168 || ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31 || ip[0] === 169 && ip[1] === 254; }
 if (!/^[0-9a-f:]+$/i.test(value) || value.includes(":::") || value.startsWith(":") && !value.startsWith("::") || value.endsWith(":") && !value.endsWith("::") || value.split("::").length > 2) return false;
 const halves = value.split("::"), groups = value.split(":").filter(Boolean);
 if (groups.some(group => group.length > 4) || (halves.length === 1 ? groups.length !== 8 : groups.length >= 8)) return false;
 const first = value.startsWith(":") ? 0 : Number.parseInt(groups[0] ?? "0", 16);
 return /^(?:0*:)*0*1$/i.test(value) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
export function isLocalOverlayCandidate(candidate: string): boolean {
 if (candidate === "") return true;
 if (candidate.length > 2048 || /[^\x20-\x7e]/.test(candidate)) return false;
 const parts = candidate.trim().split(/\s+/);
 if (parts.length < 8 || !/^candidate:[A-Za-z0-9+/]{1,64}$/.test(parts[0]) || parts[1] !== "1" || !/^(udp|tcp)$/i.test(parts[2]) || !/^\d{1,10}$/.test(parts[3]) || Number(parts[3]) > 4294967295 || !isLocalOverlayAddress(parts[4]) || !/^\d{1,5}$/.test(parts[5]) || Number(parts[5]) < 1 || Number(parts[5]) > 65535 || parts[6] !== "typ" || parts[7] !== "host") return false;
 if ((parts.length - 8) % 2) return false;
 const seen = new Set<string>();
 for (let i = 8; i < parts.length; i += 2) { const key = parts[i], value = parts[i + 1]; if (seen.has(key)) return false; seen.add(key);
  if (key === "tcptype") { if (!/^(active|passive|so)$/.test(value) || parts[2].toLowerCase() !== "tcp") return false; }
  else if (key === "ufrag") { if (!/^[A-Za-z0-9+/]{1,256}$/.test(value)) return false; }
  else if (!["generation", "network-id", "network-cost"].includes(key) || !/^\d{1,10}$/.test(value)) return false;
 }
 return parts[2].toLowerCase() !== "tcp" || seen.has("tcptype");
}
export function parseOverlayVideoSDP(sdp: unknown, direction: "sendonly" | "recvonly"): OverlaySDPSection[] | null {
 if (typeof sdp !== "string" || !sdp.length || sdp.length > 28000 || /[^\x20-\x7e\r\n]/.test(sdp) || /(?:stun|turn|turns):/i.test(sdp)) return null;
 const sections: Array<{ mid: string; direction: string; active: boolean; directionSeen: boolean }> = []; let section: typeof sections[number] | null = null; let fingerprint = false;
 for (const raw of sdp.split(/\r?\n/)) { const line = raw.trim();
  if (line.startsWith("m=")) { const parts = line.slice(2).split(/\s+/); if (parts[0] !== "video" || !/^\d{1,5}$/.test(parts[1] ?? "") || Number(parts[1]) > 65535 || parts[2] !== "UDP/TLS/RTP/SAVPF") return null; section = { mid: "", direction: "", active: Number(parts[1]) !== 0, directionSeen: false }; sections.push(section); if (sections.length > 4) return null; }
  else if (line.startsWith("a=mid:")) { if (!section || section.mid) return null; section.mid = line.slice(6); }
  else if (/^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line)) { if (!section || section.directionSeen) return null; section.directionSeen = true; section.direction = line.slice(2); }
  else if (line.startsWith("a=candidate:")) { if (!isLocalOverlayCandidate(line.slice(2))) return null; }
  else if (line.startsWith("c=")) { const parts = line.split(/\s+/), address = parts[2]; if (parts.length !== 3 || !["c=IN"].includes(parts[0]) || !["IP4", "IP6"].includes(parts[1]) || !address || address !== "0.0.0.0" && address !== "::" && !isLocalOverlayAddress(address)) return null; }
  else if (line.startsWith("o=")) { const parts = line.split(/\s+/), address = parts[5]; if (parts.length !== 6 || !address || address !== "0.0.0.0" && address !== "::" && !isLocalOverlayAddress(address)) return null; }
  else if (line.startsWith("a=fingerprint:")) { if (!/^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(line)) return null; fingerprint = true; }
  else if (/^a=(ice-server|remote-candidates|sctp-port|sctpmap|msid-semantic:.*data)/i.test(line)) return null;
 }
 if (!fingerprint || !sections.length || sections.some(value => !token(value.mid, 32) || !value.active || value.direction !== direction) || new Set(sections.map(value => value.mid)).size !== sections.length) return null;
 return sections.map(value => ({ mid: value.mid, direction, active: value.active }));
}
export function parseOverlayMediaEnvelope(raw: unknown): OverlayMediaEnvelope | null {
 if (!object(raw) || raw.protocol !== 1 || !id(raw.session) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return null;
 const common = ["protocol", "session", "revision", "kind"];
 if (raw.kind === "end") return keys(raw, [...common, "reason"]) && ["closed", "scope", "source", "error"].includes(raw.reason as string) ? { protocol: 1, session: raw.session, revision: raw.revision as number, kind: "end", reason: raw.reason as "closed" | "scope" | "source" | "error" } : null;
 if (raw.kind === "candidate") { if (!keys(raw, [...common, "offerId", "descriptionId", "candidate"]) || !id(raw.offerId) || !id(raw.descriptionId) || !object(raw.candidate)) return null; const candidate = raw.candidate;
  if (!keys(candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]) || typeof candidate.candidate !== "string" || !isLocalOverlayCandidate(candidate.candidate) || candidate.sdpMid !== null && !token(candidate.sdpMid, 32) || candidate.sdpMLineIndex !== null && (!Number.isInteger(candidate.sdpMLineIndex) || (candidate.sdpMLineIndex as number) < 0 || (candidate.sdpMLineIndex as number) > 3) || candidate.usernameFragment !== undefined && candidate.usernameFragment !== null && (typeof candidate.usernameFragment !== "string" || !/^[A-Za-z0-9+/]{1,256}$/.test(candidate.usernameFragment))) return null;
  return { protocol: 1, session: raw.session, revision: raw.revision as number, kind: "candidate", offerId: raw.offerId, descriptionId: raw.descriptionId, candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid as string | null, sdpMLineIndex: candidate.sdpMLineIndex as number | null, ...(candidate.usernameFragment !== undefined ? { usernameFragment: candidate.usernameFragment as string | null } : {}) } };
 }
 if (!id(raw.descriptionId)) return null;
 if (raw.kind === "answer") return keys(raw, [...common, "descriptionId", "replyTo", "sdp"]) && id(raw.replyTo) && raw.descriptionId !== raw.replyTo && parseOverlayVideoSDP(raw.sdp, "recvonly") ? { protocol: 1, session: raw.session, revision: raw.revision as number, kind: "answer", descriptionId: raw.descriptionId, replyTo: raw.replyTo, sdp: raw.sdp as string } : null;
 if (raw.kind !== "offer" || !keys(raw, [...common, "descriptionId", "sdp", "sources"]) || !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 4) return null;
 const sections = parseOverlayVideoSDP(raw.sdp, "sendonly"); if (!sections || sections.length !== raw.sources.length) return null;
 const mids = new Set<string>(), tiles = new Set<string>(); let cameras = 0, screens = 0;
 for (const source of raw.sources) { if (!object(source) || !keys(source, ["mid", "tileId", "kind"]) || !token(source.mid, 32) || !token(source.tileId, 64) || !sections.some(section => section.mid === source.mid) || mids.has(source.mid) || tiles.has(source.tileId)) return null; mids.add(source.mid); tiles.add(source.tileId); if (source.kind === "camera") cameras++; else if (source.kind === "screen") screens++; else return null; }
 return cameras <= 2 && screens <= 2 ? { protocol: 1, session: raw.session, revision: raw.revision as number, kind: "offer", descriptionId: raw.descriptionId, sdp: raw.sdp as string, sources: raw.sources.map(source => ({ mid: source.mid as string, tileId: source.tileId as string, kind: source.kind as OverlayVideoKind })) } : null;
}
