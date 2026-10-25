import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokens, setTokens } from "../api/client";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import * as api from "../api/channelPermissions";
import { useAuthStore } from "./authStore";
import { useServerStore } from "./serverStore";
import { useChannelPermissionStore } from "./channelPermissionStore";

vi.mock("../api/channelPermissions", () => ({
  getOverrides: vi.fn(),
  setOverride: vi.fn(),
  deleteOverride: vi.fn(),
}));
vi.mock("./authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: null })) };
});

const owner = (id: string) => ({ id } as never);

beforeEach(() => {
  clearTokens();
  setTokens("permission-test-token", "", "permission-owner");
  useAuthStore.setState({ user: owner("permission-owner") });
  publishAuthOwnerChange("permission-owner");
  useServerStore.setState({ activeServerId: "server-1" });
  useChannelPermissionStore.setState({ overridesByChannel: {}, fetchedChannels: new Set(), statusByChannel: {} });
  vi.mocked(api.getOverrides).mockReset();
});

describe("channel permission override freshness", () => {
  it("distinguishes an authoritative empty override list from unavailable data", async () => {
    vi.mocked(api.getOverrides).mockResolvedValue({ success: true, data: [] } as never);
    const store = useChannelPermissionStore.getState();
    expect(store.getOverrideStatus("channel-1", "server-1")).toBe("unavailable");

    await store.fetchOverrides("channel-1", "server-1");

    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("ready");
    expect(useChannelPermissionStore.getState().fetchedChannels.has("channel-1")).toBe(true);
  });

  it("reports errors as non-ready and permits a later retry", async () => {
    vi.mocked(api.getOverrides)
      .mockResolvedValueOnce({ success: false, data: undefined } as never)
      .mockResolvedValueOnce({ success: true, data: [] } as never);
    await useChannelPermissionStore.getState().fetchOverrides("channel-1", "server-1");
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("error");
    expect(useChannelPermissionStore.getState().fetchedChannels.has("channel-1")).toBe(false);

    await useChannelPermissionStore.getState().fetchOverrides("channel-1", "server-1");
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("ready");
    expect(api.getOverrides).toHaveBeenCalledTimes(2);
  });

  it("clears synchronously when real token installation advances generation for the same owner", async () => {
    vi.mocked(api.getOverrides).mockResolvedValue({ success: true, data: [] } as never);
    await useChannelPermissionStore.getState().fetchOverrides("channel-1", "server-1");
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("ready");

    // Reauthentication can advance the API session generation before the
    // auth store publishes its refreshed User object.
    setTokens("same-owner-new-session", "", "permission-owner");

    expect(useChannelPermissionStore.getState().overridesByChannel["channel-1"]).toBeUndefined();
    expect(useChannelPermissionStore.getState().fetchedChannels.has("channel-1")).toBe(false);
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("unavailable");
  });

  it("deduplicates same-scope requests and rejects a late response after account change", async () => {
    let finish!: (value: { success: boolean; data: [] }) => void;
    vi.mocked(api.getOverrides).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }) as never);
    const store = useChannelPermissionStore.getState();
    const first = store.fetchOverrides("channel-1", "server-1");
    const duplicate = store.fetchOverrides("channel-1", "server-1");
    expect(api.getOverrides).toHaveBeenCalledTimes(1);
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("loading");

    clearTokens();
    setTokens("other-account-token", "", "other-owner");
    useAuthStore.setState({ user: owner("other-owner") });
    publishAuthOwnerChange("other-owner");
    finish({ success: true, data: [] });
    await Promise.all([first, duplicate]);

    expect(useChannelPermissionStore.getState().overridesByChannel["channel-1"]).toBeUndefined();
    expect(useChannelPermissionStore.getState().fetchedChannels.has("channel-1")).toBe(false);
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-1")).toBe("unavailable");
  });

  it("does not accept a non-explicit request after the active server changes", async () => {
    let finish!: (value: { success: boolean; data: [] }) => void;
    vi.mocked(api.getOverrides).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }) as never);
    const pending = useChannelPermissionStore.getState().fetchOverrides("channel-1");
    useServerStore.setState({ activeServerId: "server-2" });
    finish({ success: true, data: [] });
    await pending;
    expect(useChannelPermissionStore.getState().fetchedChannels.has("channel-1")).toBe(false);
    expect(useChannelPermissionStore.getState().getOverrideStatus("channel-1", "server-2")).toBe("unavailable");
  });
});
