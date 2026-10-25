import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./constants", async (importOriginal) => {
  const original = await importOriginal<typeof import("./constants")>();
  return { ...original, isNativeApp: vi.fn(() => false) };
});

import { isNativeApp } from "./constants";
import { buildMessageLink, buildMessageRoute, parseMessageRoute } from "./messageLinks";

describe("message links", () => {
  beforeEach(() => {
    vi.mocked(isNativeApp).mockReturnValue(false);
    window.history.replaceState({}, "", "/channels");
  });

  it("round-trips a server channel target with escaped identifiers", () => {
    const target = { kind: "channel" as const, serverId: "server one", channelId: "chan/1", messageId: "msg#1" };
    const route = buildMessageRoute(target);
    expect(route).toBe("/channels/message/server/server%20one/chan%2F1/msg%231");
    expect(parseMessageRoute(route)).toEqual(target);
    expect(buildMessageLink(target)).toBe(`${window.location.origin}${route}`);
  });

  it("round-trips a direct-message target", () => {
    const target = { kind: "dm" as const, channelId: "dm-4", messageId: "message-9" };
    expect(parseMessageRoute(buildMessageRoute(target))).toEqual(target);
  });

  it("uses the current document base and a hash route in native shells", () => {
    vi.mocked(isNativeApp).mockReturnValue(true);
    expect(buildMessageLink({ kind: "dm", channelId: "dm", messageId: "msg" }))
      .toBe(`${window.location.href.split("#", 1)[0]}#/channels/message/dm/dm/msg`);
  });

  it.each([
    "/channels",
    "/channels/message/server/only/two",
    "/channels/message/dm/channel",
    "/channels/message/dm/%E0%A4%A/message",
    "/channels/message/unknown/a/b",
  ])("rejects malformed route %s", (route) => {
    expect(parseMessageRoute(route)).toBeNull();
  });
});
