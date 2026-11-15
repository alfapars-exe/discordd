import { beforeEach, expect, it, vi } from "vitest";
import type { APIResponse, DMMessage, DMMessagePage, Message, MessagePage, ReactionGroup } from "../types";

const markAsRead = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ owner: "history-owner-a" }));
vi.mock("../api/messages", () => ({ getMessages: vi.fn(), getMessagesAfter: vi.fn() }));
vi.mock("../api/dm", () => ({ getDMMessages: vi.fn(), getDMMessagesAfter: vi.fn(), markDMRead: vi.fn(async () => ({ success: true })) }));
vi.mock("../crypto/channelEncryption", () => ({
  encryptChannelMessage: vi.fn(), decryptChannelMessages: vi.fn(async (rows: Message[]) => rows),
}));
vi.mock("../crypto/dmEncryption", () => ({
  encryptDMMessage: vi.fn(), decryptDMMessages: vi.fn(async (rows: DMMessage[]) => rows),
  pushSentPlaintext: vi.fn(), discardSentPlaintext: vi.fn(), cacheEditPlaintext: vi.fn(), discardEditPlaintext: vi.fn(),
}));
vi.mock("../utils/registerSpamMessage", () => ({ registerSpamBatch: vi.fn() }));
vi.mock("./authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: identity.owner } }) } }));
vi.mock("./e2eeStore", () => ({ useE2EEStore: { getState: () => ({ initStatus: "ready", localDeviceId: null }) } }));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => ({ activeServerId: "server", activeServer: { id: "server", e2ee_enabled: false } }) } }));
vi.mock("./readStateStore", () => ({ useReadStateStore: { getState: () => ({ markAsRead }) } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));

import { useMessageStore } from "./messageStore";
import { useDMStore } from "./dmStore";
import * as messageApi from "../api/messages";
import * as dmApi from "../api/dm";
import { clearTokens } from "../api/client";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import { observeDMMessage } from "../crypto/dmMessageVersions";

type Row = { id: string; content?: string; created_at?: string; conversation?: string };
let conversation = "";
let serial = 0;
const reactions: ReactionGroup[] = [{ emoji: "ok", count: 1, users: ["reader"] }];
function common(row: Row) {
  return {
    id: row.id, user_id: "sender", content: row.content ?? row.id,
    created_at: row.created_at ?? "2026-01-01T00:00:01Z", edited_at: null,
    attachments: [], reactions: [], reply_to_id: null, referenced_message: null,
    encryption_version: 0 as const,
    author: { id: "sender", username: "sender", display_name: null, avatar_url: null, status: "online" as const, custom_status: null, created_at: "" },
  };
}
function channelRow(row: Row): Message { return { ...common(row), channel_id: row.conversation ?? conversation, mentions: [], role_mentions: [] }; }
function dmRow(row: Row): DMMessage { return { ...common(row), dm_channel_id: row.conversation ?? conversation, is_pinned: false }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function queuePage<T>(admit: (promise: Promise<APIResponse<T>>) => void, data: T) {
  const gate = deferred<APIResponse<T>>();
  admit(gate.promise);
  return () => gate.resolve({ success: true, data });
}
function requested(run: () => Promise<void>, count: () => number) {
  const before = count();
  const pending = run();
  expect(count()).toBe(before + 1);
  return pending;
}
const fixtures = [
  {
    name: "channel",
    queue: (rows: Row[], hasMore = false) => queuePage<MessagePage>(promise => vi.mocked(messageApi.getMessages).mockReturnValueOnce(promise), { messages: rows.map(channelRow), has_more: hasMore }),
    queueAfter: (rows: Row[]) => queuePage<MessagePage>(promise => vi.mocked(messageApi.getMessagesAfter).mockReturnValueOnce(promise), { messages: rows.map(channelRow), has_more: false, has_more_after: false }),
    fetch: () => requested(() => useMessageStore.getState().fetchMessages(conversation, "server"), () => vi.mocked(messageApi.getMessages).mock.calls.length),
    older: () => requested(() => useMessageStore.getState().fetchOlderMessages(conversation, "server"), () => vi.mocked(messageApi.getMessages).mock.calls.length),
    newer: () => requested(() => useMessageStore.getState().fetchNewerMessages(conversation, "server"), () => vi.mocked(messageApi.getMessagesAfter).mock.calls.length),
    detach: () => useMessageStore.setState({ hasMoreAfterByChannel: { [conversation]: true } }),
    hasMoreAfter: () => useMessageStore.getState().hasMoreAfterByChannel[conversation],
    beforeCursor: () => vi.mocked(messageApi.getMessages).mock.calls.at(-1)?.[2],
    afterCursor: () => vi.mocked(messageApi.getMessagesAfter).mock.calls.at(-1)?.[2],
    forwardReadCursor: "base",
    cursor: () => markAsRead.mock.calls.at(-1)?.[1],
    create: (row: Row) => useMessageStore.getState().handleMessageCreate(channelRow(row)),
    edit: (row: Row) => useMessageStore.getState().handleMessageUpdate({ ...channelRow(row), edited_at: "2026-01-01T00:01:00Z" }),
    react: (id: string) => useMessageStore.getState().handleReactionUpdate({ channel_id: conversation, message_id: id, reactions }),
    remove: (id: string) => useMessageStore.getState().handleMessageDelete({ channel_id: conversation, id }),
    read: () => useMessageStore.getState().messagesByChannel[conversation] ?? [],
  },
  {
    name: "dm",
    queue: (rows: Row[], hasMore = false) => queuePage<DMMessagePage>(promise => vi.mocked(dmApi.getDMMessages).mockReturnValueOnce(promise), { messages: rows.map(dmRow), has_more: hasMore }),
    queueAfter: (rows: Row[]) => queuePage<DMMessagePage>(promise => vi.mocked(dmApi.getDMMessagesAfter).mockReturnValueOnce(promise), { messages: rows.map(dmRow), has_more: false, has_more_after: false }),
    fetch: () => requested(() => useDMStore.getState().fetchMessages(conversation), () => vi.mocked(dmApi.getDMMessages).mock.calls.length),
    older: () => requested(() => useDMStore.getState().fetchOlderMessages(conversation), () => vi.mocked(dmApi.getDMMessages).mock.calls.length),
    newer: () => requested(() => useDMStore.getState().fetchNewerMessages(conversation), () => vi.mocked(dmApi.getDMMessagesAfter).mock.calls.length),
    detach: () => useDMStore.setState({ hasMoreAfterByChannel: { [conversation]: true }, dmUnreadCounts: { [conversation]: 1 } }),
    hasMoreAfter: () => useDMStore.getState().hasMoreAfterByChannel[conversation],
    beforeCursor: () => vi.mocked(dmApi.getDMMessages).mock.calls.at(-1)?.[1],
    afterCursor: () => vi.mocked(dmApi.getDMMessagesAfter).mock.calls.at(-1)?.[1],
    forwardReadCursor: "live",
    cursor: () => vi.mocked(dmApi.markDMRead).mock.calls.at(-1)?.[1],
    create: (row: Row) => { observeDMMessage(conversation, row.id); useDMStore.getState().handleDMMessageCreate(dmRow(row)); },
    edit: (row: Row) => { observeDMMessage(conversation, row.id); useDMStore.getState().handleDMMessageUpdate({ ...dmRow(row), edited_at: "2026-01-01T00:01:00Z" }); },
    react: (id: string) => useDMStore.getState().handleDMReactionUpdate({ dm_channel_id: conversation, dm_message_id: id, reactions }),
    remove: (id: string) => { observeDMMessage(conversation, id, true); useDMStore.getState().handleDMMessageDelete({ dm_channel_id: conversation, id }); },
    read: () => useDMStore.getState().messagesByChannel[conversation] ?? [],
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(messageApi.getMessages).mockReset();
  vi.mocked(messageApi.getMessagesAfter).mockReset();
  vi.mocked(dmApi.getDMMessages).mockReset();
  vi.mocked(dmApi.getDMMessagesAfter).mockReset();
  identity.owner = "history-owner-a";
  publishAuthOwnerChange(identity.owner);
  clearTokens();
  conversation = `history-contract-${++serial}`;
  useDMStore.setState({ selectedDMId: conversation, dmUnreadCounts: { [conversation]: 1 } });
});

for (const fixture of fixtures) {
  it(`${fixture.name}: preserves live edit/reaction/deletion while the REST snapshot is pending`, async () => {
    const release = fixture.queue([{ id: "base" }, { id: "gone" }]);
    const loading = fixture.fetch();
    fixture.create({ id: "live", created_at: "2026-01-01T00:00:03Z" });
    fixture.edit({ id: "live", content: "edited live", created_at: "2026-01-01T00:00:03Z" });
    fixture.react("live");
    fixture.remove("gone");
    release(); await loading;
    expect(fixture.read().map(row => row.id)).toEqual(["base", "live"]);
    expect(fixture.read()[1]).toMatchObject({ content: "edited live", reactions });
    expect(fixture.cursor()).toBe("live");
  });

  it(`${fixture.name}: deduplicates a replay and retains the edit over an overlapping REST row`, async () => {
    const live = { id: "live", created_at: "2026-01-01T00:00:03Z" };
    const release = fixture.queue([{ id: "base" }, live]);
    const loading = fixture.fetch();
    fixture.create(live); fixture.create(live);
    fixture.edit({ ...live, content: "latest" });
    release(); await loading;
    expect(fixture.read().map(row => row.id)).toEqual(["base", "live"]);
    expect(fixture.read()[1].content).toBe("latest");
    expect(fixture.cursor()).toBe("live");
  });

  it(`${fixture.name}: ignores an old account's pending response`, async () => {
    const release = fixture.queue([{ id: "private-old" }]);
    const loading = fixture.fetch();
    identity.owner = "history-owner-b";
    publishAuthOwnerChange(identity.owner); clearTokens();
    release(); await loading;
    expect(fixture.read()).toEqual([]);
    expect(fixture.cursor()).toBeUndefined();
  });

  it(`${fixture.name}: keeps the newer response when an aborted request completes late`, async () => {
    const old = fixture.queue([{ id: "old" }]);
    const oldLoad = fixture.fetch();
    const latest = fixture.queue([{ id: "new" }]);
    const latestLoad = fixture.fetch();
    latest(); await latestLoad;
    old(); await oldLoad;
    expect(fixture.read().map(row => row.id)).toEqual(["new"]);
    expect(fixture.cursor()).toBe("new");
  });

  it(`${fixture.name}: rejects rows belonging to another conversation`, async () => {
    const release = fixture.queue([{ id: "base" }, { id: "foreign", conversation: "another-conversation" }]);
    const loading = fixture.fetch();
    release(); await loading;
    expect(fixture.read().map(row => row.id)).toEqual(["base"]);
    expect(fixture.cursor()).toBe("base");
  });
  it(`${fixture.name}: preserves an edited loaded row through overlapping older pagination`, async () => {
    const live = { id: "live", created_at: "2026-01-01T00:00:03Z" };
    const initial = fixture.queue([live], true);
    const first = fixture.fetch(); initial(); await first;
    fixture.edit({ ...live, content: "edited loaded row" });
    const release = fixture.queue([{ id: "base" }, live]);
    const older = fixture.older();
    expect(fixture.beforeCursor()).toBe("live");
    release(); await older;
    expect(fixture.read().map(row => row.id)).toEqual(["base", "live"]);
    expect(fixture.read()[1].content).toBe("edited loaded row");
    expect(fixture.cursor()).toBe("live");
  });

  it(`${fixture.name}: drains edited live events when forward pagination reaches the tail`, async () => {
    const initial = fixture.queue([{ id: "base" }]);
    const first = fixture.fetch(); initial(); await first;
    fixture.detach();
    const release = fixture.queueAfter([{ id: "base" }, { id: "middle", created_at: "2026-01-01T00:00:02Z" }]);
    const newer = fixture.newer();
    expect(fixture.afterCursor()).toBe("base");
    const live = { id: "live", created_at: "2026-01-01T00:00:03Z" };
    fixture.create(live); fixture.edit({ ...live, content: "edited detached" }); fixture.react("live");
    expect(fixture.read().map(row => row.id)).toEqual(["base"]);
    release(); await newer;
    expect(fixture.read().map(row => row.id)).toEqual(["base", "middle", "live"]);
    expect(fixture.read()[2]).toMatchObject({ content: "edited detached", reactions });
    expect(fixture.hasMoreAfter()).toBe(false);
    // Channel forward reads are published by the view; DM drains mark the tail here.
    expect(fixture.cursor()).toBe(fixture.forwardReadCursor);
  });

}
