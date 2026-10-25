import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  owner: "owner", generation: 1, enabled: true, compatibility:false, sourceMessage: "message", receive: undefined as ((value: { session: string; notificationId: string }) => void) | undefined,
  confirm: vi.fn(), prepare: vi.fn(), prime: vi.fn(), fetchBlocks: vi.fn(), open: vi.fn(), toast: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => ({ ownerId: h.owner, generation: h.generation }) }));
vi.mock("../stores/authStore", () => ({ useAuthStore: (pick?: (state: unknown) => unknown) => pick?.({ user: { id: h.owner } }) }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: Object.assign((pick: (state: unknown) => unknown) => pick({ voiceOverlayCompatibility:h.compatibility, voiceOverlayEnabled: h.enabled, voiceOverlayNotifications: true, voiceOverlayNotificationActions: true }), { getState: () => ({ voiceOverlayCompatibility:h.compatibility, voiceOverlayEnabled: h.enabled, voiceOverlayNotifications: true, voiceOverlayNotificationActions: true }) }) }));
vi.mock("../stores/blockStore", () => ({ useBlockStore: Object.assign(() => ({}), { getState: () => ({ fetchBlocked: h.fetchBlocks }) }) }));
vi.mock("../stores/notificationStore", () => ({ useNotificationStore: () => ({}) }));
vi.mock("../stores/preferencesStore", () => ({ usePreferencesStore: () => ({}) }));
vi.mock("../stores/channelStore", () => ({ useChannelStore: () => ({}) }));
vi.mock("../stores/memberStore", () => ({ useMemberStore: () => ({}) }));
vi.mock("../stores/channelPermissionStore", () => ({ useChannelPermissionStore: () => ({}) }));
vi.mock("../stores/threadStore", () => ({ useThreadStore: () => ({}) }));
vi.mock("../stores/messageStore", () => ({ useMessageStore: () => ({}) }));
vi.mock("../stores/groupDMStore",()=>({useGroupDMStore:()=>({})}));
vi.mock("../stores/dmStore", () => ({ useDMStore: () => ({}) }));
vi.mock("../stores/e2eeStore", () => ({ useE2EEStore: () => ({}) }));
vi.mock("../stores/spamDecisionStore", () => ({ useSpamDecisionStore: () => ({}) }));
vi.mock("../stores/friendStore", () => ({ useFriendStore: () => ({}) }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: h.toast }) } }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("./useOpenAtMessage", () => ({ useOpenAtMessage: () => ({ openAtMessage: h.open }) }));
vi.mock("../utils/overlayNotificationReply", () => ({
  primeOverlayNotificationReplyAccess: (...args: unknown[]) => h.prime(...args),
  resolveOverlayNotificationReplySource: (id: string) => id === "notice" ? { notificationId: id, ownerId: h.owner, generation: h.generation, serverId: "server", channelId: "channel", messageId: h.sourceMessage, actorId: "actor", permissionChannelId: "channel", label: "Channel" } : null,
  notificationReplyBinding: (source: unknown) => JSON.stringify(source),
  prepareOverlayNotificationReply: (...args: unknown[]) => h.prepare(...args),
}));
import { useOverlayNotificationReply } from "./useOverlayNotificationReply";
const rows = [{ id: "notice", category: "mention" as const }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); h.owner = "owner"; h.generation = 1; h.enabled = true; h.compatibility=false; h.sourceMessage = "message";
  h.confirm.mockResolvedValue(true); h.prepare.mockResolvedValue("prepared"); h.fetchBlocks.mockResolvedValue(undefined); h.prime.mockResolvedValue(undefined);
  Object.defineProperty(window, "electronAPI", { configurable: true, value: {
    onOverlayPrepareNotificationReply: (callback: typeof h.receive) => { h.receive = callback; return h.unsubscribe; }, confirmOverlayPrepareNotificationReply: h.confirm,
  } });
});
afterEach(() => { cleanup(); Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined }); });
it("publishes only opaque IDs and confirms the exact native click before preparing the source", async () => {
  const view = renderHook(() => useOverlayNotificationReply(true, rows));
  expect(view.result.current.notificationReplyIds).toEqual(["notice"]);
  const session = view.result.current.notificationReplySession!;
  await act(async () => { h.receive?.({ session, notificationId: "notice" }); });
  expect(h.confirm).toHaveBeenCalledExactlyOnceWith({ session, notificationId: "notice" });
  expect(h.prepare).toHaveBeenCalledOnce(); expect(h.prepare.mock.calls[0][0]).toMatchObject({ channelId: "channel", messageId: "message" });
  expect(h.toast).not.toHaveBeenCalled();
});
it("ignores an unknown source or wrong session and never prepares after rejected native confirmation", async () => {
  const view = renderHook(() => useOverlayNotificationReply(true, rows)); const session = view.result.current.notificationReplySession!;
  await act(async () => { h.receive?.({ session: "stale", notificationId: "notice" }); h.receive?.({ session, notificationId: "unknown" }); });
  expect(h.confirm).not.toHaveBeenCalled(); h.confirm.mockResolvedValueOnce(false);
  await act(async () => { h.receive?.({ session, notificationId: "notice" }); }); expect(h.prepare).not.toHaveBeenCalled();
});
it.each(["account", "generation", "disconnect", "retarget"])("fences a delayed native confirmation across %s changes", async reason => {
  const wait = deferred<boolean>(); h.confirm.mockReturnValueOnce(wait.promise);
  const view = renderHook(({ connected }) => useOverlayNotificationReply(connected, rows), { initialProps: { connected: true } });
  const session = view.result.current.notificationReplySession!;
  act(() => { h.receive?.({ session, notificationId: "notice" }); });
  if (reason === "account") h.owner = "other";
  if (reason === "generation") h.generation++;
  if (reason === "retarget") h.sourceMessage = "replacement";
  view.rerender({ connected: reason !== "disconnect" });
  await act(async () => { wait.resolve(true); });
  expect(h.prepare).not.toHaveBeenCalled(); expect(h.toast).not.toHaveBeenCalled();
});
it("coalesces duplicate in-flight clicks and reports a preserved draft conflict without success claims", async () => {
  const wait = deferred<boolean>(); h.confirm.mockReturnValueOnce(wait.promise); h.prepare.mockResolvedValueOnce("conflict");
  const view = renderHook(() => useOverlayNotificationReply(true, rows)); const session = view.result.current.notificationReplySession!;
  act(() => { h.receive?.({ session, notificationId: "notice" }); h.receive?.({ session, notificationId: "notice" }); });
  expect(h.confirm).toHaveBeenCalledOnce(); await act(async () => { wait.resolve(true); });
  await waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
  expect(h.toast).toHaveBeenCalledWith("info", "common:overlayReplyDraftConflict");
});
it("does not prepare a reply after compatibility changes across confirmation",async()=>{const gate=deferred<boolean>();h.confirm.mockReturnValueOnce(gate.promise);const view=renderHook(()=>useOverlayNotificationReply(true,rows));const old=view.result.current.notificationReplySession!;act(()=>h.receive?.({session:old,notificationId:"notice"}));h.compatibility=true;await act(async()=>gate.resolve(true));expect(h.prepare).not.toHaveBeenCalled();view.rerender();expect(view.result.current.notificationReplySession).toBeUndefined();h.compatibility=false;view.rerender();expect(view.result.current.notificationReplySession).not.toBe(old);});
