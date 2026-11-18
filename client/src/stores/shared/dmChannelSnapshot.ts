import type { DMChannelWithUser } from "../../types";

type ChannelIdentity = Pick<DMChannelWithUser, "id"> & {
  readonly other_user: Pick<DMChannelWithUser["other_user"], "id">;
};

/** Preserve reference identity: only missing self-DM rows may join the snapshot. */
export function onlySelfDMChannelsAdded(initialChannels: readonly ChannelIdentity[], currentChannels: readonly ChannelIdentity[], ownerId: string | null): boolean {
  const initialById = new Map(initialChannels.map(channel => [channel.id, channel]));
  const currentById = new Map(currentChannels.map(channel => [channel.id, channel]));
  return currentChannels.length >= initialChannels.length
    && initialChannels.every(channel => currentById.get(channel.id) === channel)
    && currentChannels.every(channel => initialById.get(channel.id) === channel
      || channel.other_user.id === ownerId);
}

/** Local read/unread deltas made during a request override its server snapshot. */
export function mergeDMChannelUnreadCounts(listedChannels: readonly Pick<DMChannelWithUser, "id" | "unread_count">[], initialUnreadCounts: Readonly<Record<string, number>>, currentUnreadCounts: Readonly<Record<string, number>>): Record<string, number> {
  const dmUnreadCounts: Record<string, number> = {};
  for (const ch of listedChannels) {
    if (ch.unread_count > 0) dmUnreadCounts[ch.id] = ch.unread_count;
  }
  for (const id of new Set([...Object.keys(initialUnreadCounts), ...Object.keys(currentUnreadCounts)])) {
    if (initialUnreadCounts[id] !== currentUnreadCounts[id]) {
      if (currentUnreadCounts[id] === undefined) delete dmUnreadCounts[id];
      else dmUnreadCounts[id] = currentUnreadCounts[id];
    }
  }
  return dmUnreadCounts;
}

/** The listed row wins; append each missing local self-DM once, in local order. */
export function retainSelfDMChannels<T extends ChannelIdentity>(listedChannels: readonly T[], currentChannels: readonly T[], ownerId: string | null): T[] {
  const channels = [...listedChannels];
  const listedIds = new Set(channels.map(channel => channel.id));
  for (const channel of currentChannels) {
    if (channel.other_user.id === ownerId && !listedIds.has(channel.id)) {
      channels.push(channel);
      listedIds.add(channel.id);
    }
  }
  return channels;
}
