import { beforeEach, describe, expect, it } from "vitest";
import { composerKey, conversationScrollPositions, useComposerDraftStore } from "./composerDraftStore";
import type { ChatMessage } from "../hooks/useChatContext";

const channel = composerKey("alice", "channel", "general", "server");
const dm = composerKey("alice", "dm", "general");
const group = composerKey("alice","group","group-one");
beforeEach(() => useComposerDraftStore.getState().reset());

describe("in-memory conversation drafts", () => {
  it("preserves the complete pre-edit group draft and restores it on cancellation",()=>{
    const store=useComposerDraftStore.getState(),file=new File(["draft"],"draft.txt");
    store.patch(group,{content:"unsent",files:[file],groupReplyToId:"reply"});
    expect(store.beginGroupEdit(group,"message","original message")).toBe(true);
    expect(useComposerDraftStore.getState().drafts[group]).toMatchObject({content:"original message",files:[],groupEditingId:"message",groupReplyToId:undefined});
    store.patch(group,{content:"edited but unsent"});
    expect(store.beginGroupEdit(group,"message","must not reset typing")).toBe(true);
    expect(useComposerDraftStore.getState().drafts[group].content).toBe("edited but unsent");
    expect(store.beginGroupEdit(group,"different","must not discard edit")).toBe(false);
    expect(store.cancelGroupEdit(group)).toBe(true);
    expect(useComposerDraftStore.getState().drafts[group]).toMatchObject({content:"unsent",files:[file],groupReplyToId:"reply",sending:null});
    expect(useComposerDraftStore.getState().drafts[group].groupEditingId).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts[group].groupEditBackup).toBeUndefined();
  });
  it("restores a pre-edit draft only when the submitted edit revision completes",()=>{
    const store=useComposerDraftStore.getState();store.patch(group,{content:"saved original draft"});store.beginGroupEdit(group,"m","message text");
    const ticket=store.beginSend(group)!;
    expect(store.cancelGroupEdit(group)).toBe(false);
    expect(store.beginGroupEdit(group,"other","text")).toBe(false);
    expect(store.finishSend(group,ticket,true,"group-edit")).toBe(true);
    expect(useComposerDraftStore.getState().drafts[group]).toMatchObject({content:"saved original draft",sending:null});
    expect(useComposerDraftStore.getState().drafts[group].groupEditingId).toBeUndefined();
  });
  it("keeps failed or newer pending edit text and its backup instead of clearing either",()=>{
    const store=useComposerDraftStore.getState();store.patch(group,{content:"unsent"});store.beginGroupEdit(group,"m","editing");
    const failed=store.beginSend(group)!;expect(store.finishSend(group,failed,false,"group-edit")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[group]).toMatchObject({content:"editing",groupEditBackup:{content:"unsent"}});
    const changed=store.beginSend(group)!;store.patch(group,{content:"newer edit"});
    expect(store.finishSend(group,changed,true,"group-edit")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[group]).toMatchObject({content:"newer edit",groupEditingId:"m",groupEditBackup:{content:"unsent"},sending:null});
    expect(store.cancelGroupEdit(group)).toBe(true);
    expect(useComposerDraftStore.getState().drafts[group].content).toBe("unsent");
  });
  it("does not restore old-account backups after a reset or affect another group",()=>{
    const store=useComposerDraftStore.getState(),other=composerKey("alice","group","group-two");
    store.patch(group,{content:"private draft"});store.beginGroupEdit(group,"m","editing");const stale=store.beginSend(group)!;
    store.patch(other,{content:"other group"});store.reset();store.patch(group,{content:"new session"});
    expect(store.finishSend(group,stale,true,"group-edit")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[group].content).toBe("new session");
    expect(useComposerDraftStore.getState().drafts[other]).toBeUndefined();
  });
  it("isolates account, server and conversation kind, including file and reply state", () => {
    const file = new File(["hello"], "note.txt");
    const reply = { id: "message-1" } as ChatMessage;
    const store = useComposerDraftStore.getState();
    store.patch(channel, { content: "Channel draft", files: [file], replyingTo: reply,
      mentions: [{ id: "bob", name: "Bob", type: "user" }], emojis: [] });
    store.patch(dm, { content: "DM draft" });
    const drafts = useComposerDraftStore.getState().drafts;
    expect(drafts[channel]).toMatchObject({ content: "Channel draft", files: [file], replyingTo: reply });
    expect(drafts[dm]).toMatchObject({ content: "DM draft", files: [], replyingTo: null });
    expect(drafts[composerKey("bob", "channel", "general", "server")]).toBeUndefined();
    expect(drafts[composerKey("alice", "channel", "general", "other")]).toBeUndefined();
  });

  it("holds a synchronous send lock through unmount and only clears the submitted revision", () => {
    const store = useComposerDraftStore.getState();
    store.patch(channel, { content: "first" });
    const ticket = store.beginSend(channel)!;
    expect(store.beginSend(channel)).toBeNull();
    store.patch(channel, { content: "new edit" });
    store.patch(dm, { content: "separate" });
    expect(store.finishSend(channel, ticket, true)).toBe(false);
    expect(useComposerDraftStore.getState().drafts[channel].content).toBe("new edit");
    expect(useComposerDraftStore.getState().drafts[dm].content).toBe("separate");
    const next = store.beginSend(channel)!;
    expect(store.finishSend(channel, next, true)).toBe(true);
    expect(useComposerDraftStore.getState().drafts[channel].content).toBe("");
  });

  it("preserves failed sends and ignores stale completions after logout/re-login", () => {
    const store = useComposerDraftStore.getState();
    store.patch(channel, { content: "retry me" });
    const failed = store.beginSend(channel)!;
    store.finishSend(channel, failed, false);
    expect(useComposerDraftStore.getState().drafts[channel].content).toBe("retry me");
    const stale = store.beginSend(channel)!;
    conversationScrollPositions.set(channel, 345);
    store.reset();
    expect(conversationScrollPositions.size).toBe(0);
    store.patch(channel, { content: "new session" });
    const current = store.beginSend(channel)!;
    expect(store.finishSend(channel, stale, true)).toBe(false);
    expect(useComposerDraftStore.getState().drafts[channel].sending).toBe(current);
    expect(useComposerDraftStore.getState().drafts[channel].content).toBe("new session");
  });

  it("clears only command text on confirmed success, preserving files and reply", () => {
    const store = useComposerDraftStore.getState();
    const file = new File(["keep"], "keep.txt");
    const reply = { id: "keep-reply" } as ChatMessage;
    store.patch(channel, { content: "/pause", files: [file], replyingTo: reply,
      mentions: [{ id: "bob", name: "Bob", type: "user" }] });
    const ticket = store.beginSend(channel)!;
    expect(store.finishSend(channel, ticket, true, "command")).toBe(true);
    expect(useComposerDraftStore.getState().drafts[channel]).toMatchObject({
      content: "", files: [file], replyingTo: reply, mentions: [], emojis: [], sending: null,
    });
  });

  it("retains uncertain command drafts, with no automatic new send", () => {
    const store = useComposerDraftStore.getState();
    const file = new File(["keep"], "keep.txt");
    const reply = { id: "keep-reply" } as ChatMessage;
    store.patch(channel, { content: "/play url", files: [file], replyingTo: reply });
    const ticket = store.beginSend(channel)!;
    expect(store.finishSend(channel, ticket, false, "command")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[channel]).toMatchObject({
      content: "/play url", files: [file], replyingTo: reply, sending: null,
    });
  });

  it("does not clear a changed revision when a command completes", () => {
    const store = useComposerDraftStore.getState();
    store.patch(channel, { content: "/skip" });
    const ticket = store.beginSend(channel)!;
    const file = new File(["later"], "later.txt");
    store.patch(channel, { content: "later draft", files: [file] });
    expect(store.finishSend(channel, ticket, true, "command")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[channel]).toMatchObject({ content: "later draft", files: [file], sending: null });
  });

  it("ignores an old command completion after a session reset", () => {
    const store = useComposerDraftStore.getState();
    store.patch(channel, { content: "/skip" });
    const stale = store.beginSend(channel)!;
    store.reset();
    store.patch(channel, { content: "new session" });
    const current = store.beginSend(channel)!;
    expect(store.finishSend(channel, stale, true, "command")).toBe(false);
    expect(useComposerDraftStore.getState().drafts[channel]).toMatchObject({ content: "new session", sending: current });
  });
});
