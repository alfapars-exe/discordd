import type { CategoryWithChannels, Channel } from "../types";

type ThreadLookup = {
  ownerId: string | null;
  authGeneration: number;
  byID: Record<string, Channel>;
  serverIdByThread: Record<string, string>;
  statusByParent: Record<string, "loading" | "ready" | "error">;
  statusByThread?: Record<string, "loading" | "ready" | "error">;
};
type Context = {
  categoriesByServer: Record<string, CategoryWithChannels[] | undefined>;
  threads: ThreadLookup;
  currentOwnerId: string | null;
  currentAuthGeneration: number;
};

/** A thread's destination and its governing parent ACL are different IDs. */
export function resolveChatChannel(channelId: string | null, serverId: string | undefined, context: Context): { channel: Channel; permissionChannelId: string } | null {
  if (!channelId || !serverId) return null;
  const channels = context.categoriesByServer[serverId]?.flatMap((category) => category.channels) ?? [];
  const direct = channels.find((channel) => channel.id === channelId && channel.type !== "thread");
  if (direct) return { channel: direct, permissionChannelId: direct.id };
  const { threads } = context;
  if (!context.currentOwnerId || threads.ownerId !== context.currentOwnerId
    || threads.authGeneration !== context.currentAuthGeneration
    || threads.serverIdByThread[channelId] !== serverId) return null;
  const thread = threads.byID[channelId];
  const threadStatus = threads.statusByThread?.[channelId];
  if (threadStatus === "loading" || threadStatus === "error") return null;
  if (!thread || thread.type !== "thread" || !thread.parent_channel_id || thread.parent_channel_id === thread.id) return null;
  const parent = channels.find((channel) => channel.id === thread.parent_channel_id && channel.type === "text");
  if (!parent) return null;
  const status = threads.statusByParent[JSON.stringify([serverId, parent.id])];
  if (status === "loading" || status === "error") return null;
  return { channel: thread, permissionChannelId: parent.id };
}
