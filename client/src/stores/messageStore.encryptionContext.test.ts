import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Server } from "../types";

const fixture = vi.hoisted(() => ({
  activeServerId: "other-server",
  activeServer: { id: "other-server", e2ee_enabled: false },
  initStatus: "ready",
  localDeviceId: "device-1" as string | null,
  userId: "user-1" as string | null,
  toast: vi.fn(),
}));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => fixture } }));
vi.mock("./e2eeStore", () => ({ useE2EEStore: { getState: () => fixture } }));
vi.mock("./authStore", () => ({ useAuthStore: { getState: () => ({ user: fixture.userId ? { id: fixture.userId } : null }) } }));
vi.mock("./readStateStore", () => ({ useReadStateStore: { getState: () => ({ markAsRead: vi.fn() }) } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: fixture.toast }) } }));
vi.mock("../api/servers", () => ({ getServer: vi.fn() }));
vi.mock("../api/messages", () => ({ sendMessage: vi.fn(), sendEncryptedMessage: vi.fn(), editMessage: vi.fn(), editEncryptedMessage: vi.fn() }));
vi.mock("../crypto/channelEncryption", () => ({
  encryptChannelMessage: vi.fn(),
  decryptChannelMessages: vi.fn(),
  SuppressedRosterError: class extends Error {},
}));
vi.mock("../crypto/keyStorage", () => ({ cacheDecryptedMessage: vi.fn(async () => {}) }));

import { useMessageStore } from "./messageStore";
import { useComposerDraftStore } from "./composerDraftStore";
import * as api from "../api/messages";
import { getServer } from "../api/servers";
import { encryptChannelMessage } from "../crypto/channelEncryption";
import { publishAuthOwnerChange } from "../api/authSessionEvents";

function originServer(encrypted = true): Server {
  return { id: "origin-server", e2ee_enabled: encrypted } as Server;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.activeServerId = "other-server";
  fixture.activeServer = { id: "other-server", e2ee_enabled: false };
  fixture.initStatus = "ready";
  fixture.localDeviceId = "device-1";
  fixture.userId = "user-1";
  publishAuthOwnerChange("user-1");
  useComposerDraftStore.getState().reset();
  useMessageStore.setState({ messagesByChannel: {}, hasMoreAfterByChannel: {} });
  vi.mocked(getServer).mockResolvedValue({ success: true, data: originServer() });
  vi.mocked(encryptChannelMessage).mockResolvedValue({ distributionId: "distribution-1" } as Awaited<ReturnType<typeof encryptChannelMessage>>);
  vi.mocked(api.sendMessage).mockResolvedValue({ success: true });
  vi.mocked(api.sendEncryptedMessage).mockResolvedValue({ success: true });
  vi.mocked(api.editMessage).mockResolvedValue({ success: true });
  vi.mocked(api.editEncryptedMessage).mockResolvedValue({ success: true });
});

describe("channel sends use the origin's encryption policy", () => {
  it("encrypts the origin even while a plaintext server is selected", async () => {
    expect(await useMessageStore.getState().sendMessage("channel-A", "private", undefined, undefined, "origin-server")).toBe(true);
    expect(getServer).toHaveBeenCalledWith("origin-server");
    expect(encryptChannelMessage).toHaveBeenCalledWith("channel-A", "user-1", "device-1", expect.any(String), "origin-server");
    expect(api.sendEncryptedMessage).toHaveBeenCalledWith("origin-server", "channel-A", expect.any(String), "device-1", expect.any(String), undefined, undefined);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does not encrypt a plaintext origin merely because the selected server is encrypted", async () => {
    fixture.activeServer.e2ee_enabled = true;
    vi.mocked(getServer).mockResolvedValue({ success: true, data: originServer(false) });
    await useMessageStore.getState().sendMessage("channel-A", "public", undefined, undefined, "origin-server");
    expect(api.sendMessage).toHaveBeenCalledWith("origin-server", "channel-A", "public", undefined, undefined);
    expect(encryptChannelMessage).not.toHaveBeenCalled();
    expect(api.sendEncryptedMessage).not.toHaveBeenCalled();
  });

  it.each(["initializing", "failed"])("never falls back to plaintext for an encrypted origin when E2EE is %s", async (status) => {
    fixture.initStatus = status;
    expect(await useMessageStore.getState().sendMessage("channel-A", "private", undefined, undefined, "origin-server")).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendEncryptedMessage).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalled();
  });

  it("refuses to guess the policy when origin metadata cannot be fetched", async () => {
    vi.mocked(getServer).mockResolvedValue({ success: false, status: 403 });
    expect(await useMessageStore.getState().sendMessage("channel-A", "private", undefined, undefined, "origin-server")).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendEncryptedMessage).not.toHaveBeenCalled();
  });

  it("keeps encrypted edits scoped to the origin and never falls back when the message channel is absent", async () => {
    useMessageStore.setState({ messagesByChannel: { "channel-A": [{ id: "message-A" } as Message] } });
    expect(await useMessageStore.getState().editMessage("message-A", "edit", "origin-server")).toBe(true);
    expect(encryptChannelMessage).toHaveBeenCalledWith("channel-A", "user-1", "device-1", "edit", "origin-server");
    expect(api.editEncryptedMessage).toHaveBeenCalledWith("origin-server", "message-A", expect.any(String), "device-1", expect.any(String));
    expect(await useMessageStore.getState().editMessage("missing", "edit", "origin-server")).toBe(false);
    expect(api.editMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch a pending encryption result after session reset", async () => {
    const encryption = deferred<Awaited<ReturnType<typeof encryptChannelMessage>>>();
    vi.mocked(encryptChannelMessage).mockReturnValue(encryption.promise);
    const send = useMessageStore.getState().sendMessage("channel-A", "private", undefined, undefined, "origin-server");
    await vi.waitFor(() => expect(encryptChannelMessage).toHaveBeenCalled());
    useComposerDraftStore.getState().reset();
    encryption.resolve({ distributionId: "late" } as Awaited<ReturnType<typeof encryptChannelMessage>>);
    expect(await send).toBe(false);
    expect(api.sendEncryptedMessage).not.toHaveBeenCalled();
  });

  it("does not insert an old account's response into the next session's cache", async () => {
    const response = deferred<Awaited<ReturnType<typeof api.sendMessage>>>();
    vi.mocked(getServer).mockResolvedValue({ success: true, data: originServer(false) });
    vi.mocked(api.sendMessage).mockReturnValue(response.promise);
    const send = useMessageStore.getState().sendMessage("channel-A", "private", undefined, undefined, "origin-server");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    useComposerDraftStore.getState().reset();
    response.resolve({ success: true, data: { id: "late", channel_id: "channel-A" } as Message });
    expect(await send).toBe(false);
    expect(useMessageStore.getState().messagesByChannel["channel-A"]).toBeUndefined();
  });

  it("does not retry a transient send after the account session resets", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getServer).mockResolvedValue({ success: true, data: originServer(false) });
      vi.mocked(api.sendMessage).mockResolvedValue({ success: false, isNetworkError: true });
      const send = useMessageStore.getState().sendMessage("channel-A", "old session", undefined, undefined, "origin-server");
      await vi.advanceTimersByTimeAsync(0);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      useComposerDraftStore.getState().reset();
      await vi.advanceTimersByTimeAsync(1500);
      expect(await send).toBe(false);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
