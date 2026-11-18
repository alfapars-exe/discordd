import { compareMessageTimestamps } from "../../utils/messageTimestamp";
import type { Message, ReactionGroup } from "../../types";

type MessageChange = {
  created?: Message;
  edited?: Message;
  reactions?: ReactionGroup[];
  deleted?: boolean;
};

export function compareMessages(a: Message, b: Message): number {
  return compareMessageTimestamps(a.created_at, b.created_at) || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
}

/** Preserve the API's page order, inserting live-only rows by the same cursor. */
function insertLiveRows(page: Message[], extra: Message[]): Message[] {
  if (extra.length === 0) return page;
  extra.sort(compareMessages);
  const result: Message[] = [];
  let i = 0;
  for (const row of page) {
    while (i < extra.length && compareMessages(extra[i], row) < 0) result.push(extra[i++]);
    result.push(row);
  }
  return result.concat(extra.slice(i));
}

export function insertLiveMessage(rows: Message[], message: Message): Message[] {
  if (!rows.length || compareMessages(rows[rows.length - 1], message) <= 0) return [...rows, message];
  return insertLiveRows(rows, [message]);
}

export function mergeChannelEdit(current: Message, edit: Message): Message {
  // The durable message_update publisher sets reactions to []. Reaction changes
  // arrive on their own event; history pages carry the hydrated reaction list.
  if (current.edited_at && (!edit.edited_at || compareMessageTimestamps(current.edited_at, edit.edited_at) > 0)) return current;
  return { ...edit, reactions: current.reactions ?? edit.reactions };
}

/** One entry per changed id until the channel's snapshot or detached window is reconciled. */
export class ChannelHistoryChanges {
  private readonly byId = new Map<string, MessageChange>();

  private change(id: string): MessageChange {
    let entry = this.byId.get(id);
    if (!entry) {
      entry = {};
      this.byId.set(id, entry);
    }
    return entry;
  }

  create(message: Message): boolean {
    const entry = this.change(message.id);
    if (entry.deleted) return false;
    entry.created ??= message;
    return true;
  }

  edit(message: Message): void {
    const entry = this.change(message.id);
    if (entry.deleted) return;
    entry.edited = entry.edited ? mergeChannelEdit(entry.edited, message) : message;
  }

  react(id: string, reactions: ReactionGroup[]): void {
    const entry = this.change(id);
    if (!entry.deleted) entry.reactions = reactions;
  }

  remove(id: string): void {
    this.byId.set(id, { deleted: true });
  }

  apply(page: Message[], options: { includeCreates?: boolean; oldest?: Message } = {}): Message[] {
    const seen = new Set<string>();
    const rows: Message[] = [];
    const extra: Message[] = [];
    const applyRow = (row: Message, target: Message[]) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      const change = this.byId.get(row.id);
      if (change?.deleted) return;
      let next = change?.edited ? mergeChannelEdit(row, change.edited) : row;
      if (change?.reactions) next = { ...next, reactions: change.reactions };
      if (next.reply_to_id && this.byId.get(next.reply_to_id)?.deleted) {
        next = { ...next, referenced_message: { id: next.reply_to_id, author: null, content: null } };
      }
      target.push(next);
    };
    for (const row of page) applyRow(row, rows);
    if (options.includeCreates) {
      for (const entry of this.byId.values()) {
        if (entry.created && (!options.oldest || compareMessages(entry.created, options.oldest) >= 0)) {
          applyRow(entry.created, extra);
        }
      }
    }
    return insertLiveRows(rows, extra);
  }
}

export type HistoryWindow = { rows: Message[]; hasMore: boolean };

export function reconnectTail(previous: HistoryWindow | undefined, page: Message[], hasMore: boolean): HistoryWindow {
  if (previous && hasMore && page.length > 0) {
    const ids = new Set(page.map((m) => m.id));
    if (previous.rows.some((m) => ids.has(m.id))) {
      const prefix = previous.rows.filter((m) => compareMessages(m, page[0]) < 0 && !ids.has(m.id));
      if (prefix.length > 0) return { rows: [...prefix, ...page], hasMore: previous.hasMore };
    }
  }
  // With no common anchor, appending the old window would hide a pagination gap.
  return { rows: page, hasMore };
}
