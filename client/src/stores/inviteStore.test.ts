import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse, Invite } from "../types";
vi.mock("../api/invites", () => ({ getInvites: vi.fn(), createInvite: vi.fn(), deleteInvite: vi.fn() }));
import * as api from "../api/invites";
import { useInviteStore } from "./inviteStore";

function invite(code: string): Invite {
  return { code, created_by: "me", max_uses: 0, uses: 0, expires_at: null, created_at: "2026-01-01", creator_username: "me", creator_display_name: null };
}
function sevenDayInvite(code: string): Invite {
  const created = new Date(Date.now() - 60_000);
  const expires = new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    ...invite(code),
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  useInviteStore.getState().clearForServerSwitch();
});

describe("invite server isolation", () => {
  it("never reuses another server's permanent link when the requested lookup fails", async () => {
    useInviteStore.setState({ _loadedServerId: "other", invites: [invite("other-code")] });
    vi.mocked(api.getInvites).mockResolvedValue({ success: false, error: "forbidden" });
    expect(await useInviteStore.getState().getOrCreatePermanentInvite("target")).toBeNull();
    expect(api.createInvite).not.toHaveBeenCalled();
    expect(useInviteStore.getState().invites).toEqual([]);
  });

  it("returns each request's scoped data without an older server overwriting the visible list", async () => {
    const first = deferred<APIResponse<Invite[]>>();
    const second = deferred<APIResponse<Invite[]>>();
    vi.mocked(api.getInvites).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = useInviteStore.getState().fetchInvites("one");
    const two = useInviteStore.getState().fetchInvites("two");
    second.resolve({ success: true, data: [invite("two")] });
    expect(await two).toEqual([invite("two")]);
    first.resolve({ success: true, data: [invite("one")] });
    expect(await one).toEqual([invite("one")]);
    expect(useInviteStore.getState()).toMatchObject({ _loadedServerId: "two", invites: [invite("two")], isLoading: false });
  });

  it("keeps newer same-server results when requests complete in reverse order", async () => {
    const first = deferred<APIResponse<Invite[]>>();
    const second = deferred<APIResponse<Invite[]>>();
    vi.mocked(api.getInvites).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = useInviteStore.getState().fetchInvites("same");
    const two = useInviteStore.getState().fetchInvites("same");
    second.resolve({ success: true, data: [] });
    await two;
    first.resolve({ success: true, data: [invite("revoked")] });
    await one;
    expect(useInviteStore.getState().invites).toEqual([]);
  });

  it("does not resurrect cleared data from an in-flight request", async () => {
    const pending = deferred<APIResponse<Invite[]>>();
    vi.mocked(api.getInvites).mockReturnValue(pending.promise);
    const load = useInviteStore.getState().fetchInvites("old");
    useInviteStore.getState().clearForServerSwitch();
    pending.resolve({ success: true, data: [invite("old")] });
    expect(await load).toBeNull();
    expect(useInviteStore.getState()).toMatchObject({ _loadedServerId: null, invites: [], isLoading: false });
  });

  it("deduplicates simultaneous permanent-invite creation for one server", async () => {
    vi.mocked(api.getInvites).mockResolvedValue({ success: true, data: [] });
    vi.mocked(api.createInvite).mockResolvedValue({ success: true, data: invite("new") });
    const [first, second] = await Promise.all([
      useInviteStore.getState().getOrCreatePermanentInvite("one"),
      useInviteStore.getState().getOrCreatePermanentInvite("one"),
    ]);
    expect(first?.code).toBe("new");
    expect(second?.code).toBe("new");
    expect(api.createInvite).toHaveBeenCalledExactlyOnceWith("one", { max_uses: 0, expires_in: 0 });
  });

  it("creates and deduplicates the default seven-day share invite", async () => {
    vi.mocked(api.getInvites).mockResolvedValue({ success: true, data: [] });
    vi.mocked(api.createInvite).mockResolvedValue({ success: true, data: sevenDayInvite("share") });
    const [first, second] = await Promise.all([
      useInviteStore.getState().getOrCreateShareInvite("one"),
      useInviteStore.getState().getOrCreateShareInvite("one"),
    ]);
    expect(first?.code).toBe("share");
    expect(second?.code).toBe("share");
    expect(api.createInvite).toHaveBeenCalledExactlyOnceWith("one", { max_uses: 0, expires_in: 10080 });
  });

  it("does not switch the visible list back when background invite creation finishes", async () => {
    const pending = deferred<APIResponse<Invite>>();
    vi.mocked(api.createInvite).mockReturnValue(pending.promise);
    useInviteStore.setState({ _loadedServerId: "one" });
    const create = useInviteStore.getState().createInvite("one", 5, 60);
    useInviteStore.setState({ _loadedServerId: "two", invites: [invite("two")] });
    pending.resolve({ success: true, data: invite("one") });
    expect((await create)?.code).toBe("one");
    expect(api.getInvites).not.toHaveBeenCalled();
    expect(useInviteStore.getState()).toMatchObject({ _loadedServerId: "two", invites: [invite("two")] });
  });

  it("does not mutate the visible list when deleting in another server", async () => {
    useInviteStore.setState({ _loadedServerId: "two", invites: [invite("two")] });
    vi.mocked(api.deleteInvite).mockResolvedValue({ success: true, data: { message: "deleted" } });
    expect(await useInviteStore.getState().deleteInvite("one", "one")).toBe(true);
    expect(useInviteStore.getState().invites).toEqual([invite("two")]);
  });

  it("clears loading and returns no invite after transport failure", async () => {
    vi.mocked(api.getInvites).mockRejectedValue(new Error("offline"));
    expect(await useInviteStore.getState().getOrCreatePermanentInvite("one")).toBeNull();
    expect(useInviteStore.getState().isLoading).toBe(false);
    expect(api.createInvite).not.toHaveBeenCalled();
  });
});
