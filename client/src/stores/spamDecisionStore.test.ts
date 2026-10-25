import { beforeEach, expect, it, vi } from "vitest";
import { useSpamDecisionStore } from "./spamDecisionStore";
import { useAuthStore } from "./authStore";
import { isMessageFilteredAsSpam, getMessageSpamDisposition, shouldSuppressMessagePreview } from "../utils/messageSpamPolicy";
import { usePreferencesStore } from "./preferencesStore";
import { useFriendStore } from "./friendStore";
import type { User } from "../types";
import { listSpamDecisions } from "../api/spam";
import { clearTokens, getAuthGeneration } from "../api/client";
vi.mock("../api/spam", () => ({ listSpamDecisions: vi.fn() }));
beforeEach(() => {
 vi.clearAllMocks();
 useSpamDecisionStore.setState({ accountId: null, decisions: {} });
 usePreferencesStore.setState({ data: {} });
 useFriendStore.setState({ friends: [] });
});
it("does not overwrite a newer live decision with an older reconnect snapshot", async () => {
 useAuthStore.setState({ user: { id: "one" } as User });
 let resolve!: (value: Awaited<ReturnType<typeof listSpamDecisions>>) => void;
 vi.mocked(listSpamDecisions).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
 const loading = useSpamDecisionStore.getState().refresh();
 useSpamDecisionStore.getState().apply({ user_id: "one", source_kind: "dm", message_id: "m", revision: "new", status: "restored" });
 resolve({ success: true, data: { entries: [{ source_kind: "dm", channel_id: "private", message_id: "m", revision: "old", status: "dismissed", reasons: [], created_at: "2026-10-24" }] } });
 await loading;
 expect(useSpamDecisionStore.getState().decisions["dm:m"].revision).toBe("new");
});
it("loads every decision page and detects repeated cursors", async () => {
 useAuthStore.setState({ user: { id: "one" } as User });
 vi.mocked(listSpamDecisions).mockResolvedValue({ success: true, data: { entries: [], next_cursor: "same" } });
 await useSpamDecisionStore.getState().refresh();
 expect(listSpamDecisions).toHaveBeenCalledTimes(2);
 expect(useSpamDecisionStore.getState().syncError).toBe(true);
});
it("ignores a pending snapshot after same-account reauthentication", async () => {
 useAuthStore.setState({ user: { id: "one" } as User });
 let resolve!: (value: Awaited<ReturnType<typeof listSpamDecisions>>) => void;
 vi.mocked(listSpamDecisions).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
 const loading = useSpamDecisionStore.getState().refresh();
 clearTokens();
 useAuthStore.setState({ user: { id: "one" } as User });
 resolve({ success: true, data: { entries: [{ source_kind: "dm", channel_id: "private", message_id: "stale", revision: "original", status: "restored", reasons: [], created_at: "2026-10-24" }] } });
 await loading;
 expect(useSpamDecisionStore.getState().decisions).toEqual({});
});
it("handles a failed snapshot without rejecting the reconnect task", async () => {
 useAuthStore.setState({ user: { id: "one" } as User });
 vi.mocked(listSpamDecisions).mockRejectedValueOnce(new Error("network unavailable"));
 await expect(useSpamDecisionStore.getState().refresh()).resolves.toBeUndefined();
 expect(useSpamDecisionStore.getState().syncError).toBe(true);
});
it("isolates account and source decision keys", () => {
 const store = useSpamDecisionStore.getState();
 store.apply({ user_id:"one",source_kind:"dm",message_id:"m",revision:"original",status:"restored" });
 store.apply({ user_id:"one",source_kind:"channel",message_id:"m",revision:"original",status:"dismissed" });
 expect(Object.keys(useSpamDecisionStore.getState().decisions)).toHaveLength(2);
 store.apply({ user_id:"two",source_kind:"dm",message_id:"other",revision:"original",status:"restored" });
 expect(Object.keys(useSpamDecisionStore.getState().decisions)).toEqual(["dm:other"]);
});
it("applies restored decisions only to matching account, source and message revision", () => {
 useAuthStore.setState({ user: { id: "one" } as User });
 const userId = "one";
 useFriendStore.setState({ ownerId:userId, authGeneration:getAuthGeneration(), friendsStatus:"ready", friends:[] });
 const message = {id:"m",user_id:"sender",content:"https://a.test@b.test",edited_at:null};
 useSpamDecisionStore.getState().apply({user_id:userId,source_kind:"dm",message_id:"m",revision:"original",status:"restored"});
 expect(isMessageFilteredAsSpam(message,"dm")).toBe(false);
 expect(isMessageFilteredAsSpam(message,"channel")).toBe(true);
 expect(isMessageFilteredAsSpam({...message,edited_at:"edited"},"dm")).toBe(true);
 useAuthStore.setState({ user: null });
 expect(getMessageSpamDisposition(message,"dm")).toBe("pending");
 expect(shouldSuppressMessagePreview(message,"dm")).toBe(true);
});
