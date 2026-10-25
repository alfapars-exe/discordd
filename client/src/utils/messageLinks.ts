import { isNativeApp } from "./constants";

export type MessageLinkTarget =
  | { kind: "channel"; serverId: string; channelId: string; messageId: string }
  | { kind: "dm"; channelId: string; messageId: string };

const PREFIX = ["channels", "message"] as const;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function dec(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

export function buildMessageRoute(target: MessageLinkTarget): string {
  if (target.kind === "channel") {
    return `/${PREFIX[0]}/${PREFIX[1]}/server/${enc(target.serverId)}/${enc(target.channelId)}/${enc(target.messageId)}`;
  }
  return `/${PREFIX[0]}/${PREFIX[1]}/dm/${enc(target.channelId)}/${enc(target.messageId)}`;
}

export function buildMessageLink(target: MessageLinkTarget): string {
  return buildRouteLink(buildMessageRoute(target));
}

/** Build a shareable URL for an app route in both browser and native shells. */
export function buildRouteLink(route: string): string {
  if (isNativeApp()) {
    const base = window.location.href.split("#", 1)[0];
    return base + "#" + route;
  }
  return window.location.origin + route;
}

export function parseMessageRoute(pathname: string): MessageLinkTarget | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== PREFIX[0] || parts[1] !== PREFIX[1]) return null;

  if (parts[2] === "server" && parts.length === 6) {
    const serverId = dec(parts[3]);
    const channelId = dec(parts[4]);
    const messageId = dec(parts[5]);
    return serverId && channelId && messageId
      ? { kind: "channel", serverId, channelId, messageId }
      : null;
  }

  if (parts[2] === "dm" && parts.length === 5) {
    const channelId = dec(parts[3]);
    const messageId = dec(parts[4]);
    return channelId && messageId ? { kind: "dm", channelId, messageId } : null;
  }

  return null;
}
