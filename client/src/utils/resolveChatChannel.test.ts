import { expect, it } from "vitest";
import type { CategoryWithChannels, Channel } from "../types";
import { resolveChatChannel } from "./resolveChatChannel";

function context() {
  return {
    currentOwnerId: "owner", currentAuthGeneration: 2,
    categoriesByServer: { server: [{ channels: [{ id: "parent", type: "text" }] }] as CategoryWithChannels[] },
    threads: { ownerId: "owner", authGeneration: 2, serverIdByThread: { thread: "server" },
      byID: { thread: { id: "thread", type: "thread", parent_channel_id: "parent", archived_at: null } as Channel },
      statusByParent: {} as Record<string, "loading" | "ready" | "error"> },
  };
}
it("keeps the thread destination but resolves only its text parent's ACL", () => {
  const source = context();
  expect(resolveChatChannel("thread", "server", source)).toEqual({ channel: source.threads.byID.thread, permissionChannelId: "parent" });
  expect(resolveChatChannel("parent", "server", source)?.permissionChannelId).toBe("parent");
});
it("rejects foreign account, generation and server provenance", () => {
  for (const change of ["owner", "generation", "server"]) {
    const source = context();
    if (change === "owner") source.threads.ownerId = "other";
    if (change === "generation") source.threads.authGeneration++;
    if (change === "server") source.threads.serverIdByThread.thread = "other";
    expect(resolveChatChannel("thread", "server", source)).toBeNull();
  }
});
it("rejects missing, nested, self and non-text parents", () => {
  for (const parent of [null, "thread", "missing"]) {
    const source = context();
    source.threads.byID.thread.parent_channel_id = parent;
    expect(resolveChatChannel("thread", "server", source)).toBeNull();
  }
  const source = context();
  source.categoriesByServer.server[0]!.channels[0]!.type = "voice";
  expect(resolveChatChannel("thread", "server", source)).toBeNull();
});
it("fails closed while parent metadata refresh is loading or failed", () => {
  const source = context();
  const key = JSON.stringify(["server", "parent"]);
  for (const status of ["loading", "error"] as const) {
    source.threads.statusByParent[key] = status;
    expect(resolveChatChannel("thread", "server", source)).toBeNull();
  }
  source.threads.statusByParent[key] = "ready";
  expect(resolveChatChannel("thread", "server", source)).not.toBeNull();
});
it("does not hide an archived thread from read-only resolution", () => {
  const source = context();
  source.threads.byID.thread.archived_at = "2026-10-25T00:00:00Z";
  expect(resolveChatChannel("thread", "server", source)?.channel.archived_at).toBeTruthy();
});
