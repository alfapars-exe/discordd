import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { GroupDM, GroupDMMessage } from "../../types/groupDM";
const mediaGate = vi.hoisted(() => ({ visible: true, inspect: vi.fn() }));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../api/groupDM", () => ({ listPinnedGroupDMMessages: vi.fn(), unpinGroupDMMessage: vi.fn(), pinGroupDMMessage: vi.fn() }));
vi.mock("../../crypto/dmEncryption", () => ({ decryptGroupDMMessages: vi.fn(async (messages: GroupDMMessage[]) => messages), encryptGroupDMMessage: vi.fn() }));
vi.mock("./GroupDMMessageBody", () => ({ default: ({ message }: { message: GroupDMMessage }) => <p>{message.content}</p> }));
vi.mock("../chat/GroupSpamGate", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("../chat/EncryptedAttachment", () => ({ default: ({ fileMeta }: { fileMeta: { filename: string } }) => <span>{fileMeta.filename}</span> }));
vi.mock("../chat/UnclassifiedMediaGate", () => ({ default: (props: { children: ReactNode }) => { mediaGate.inspect(props); return mediaGate.visible ? props.children : <span>private media withheld</span>; } }));
import GroupDMPinsPanel from "./GroupDMPinsPanel";
import * as api from "../../api/groupDM";
import { decryptGroupDMMessages } from "../../crypto/dmEncryption";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { getAuthGeneration, setTokens } from "../../api/client";
import { GROUP_DM_PINS_CHANGED, captureGroupDMPinScope, pinCurrentGroupDMMessage } from "../../utils/groupDMPins";
import { handleDMEvent } from "../../hooks/ws/dmEventHandlers";

const message = (id = "pin"): GroupDMMessage => ({ id, group_id: "group", user_id: "peer", content: "decrypted pin", encryption_version: 1, ciphertext: "ciphertext", created_at: "2026-10-25T00:00:00Z" } as GroupDMMessage);
beforeEach(() => {
  vi.clearAllMocks();
  mediaGate.visible = true;
  setTokens("test", "", "viewer");
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useE2EEStore.setState({ localDeviceId: "device", initStatus: "ready" });
  useGroupDMStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), groupsReady: true,
    groups: [{ id: "group", key_epoch: 1, members: [{ id: "viewer" }, { id: "peer" }] } as GroupDM] });
  vi.mocked(api.listPinnedGroupDMMessages).mockReset().mockResolvedValue({ success: true, data: { messages: [message()] } });
  vi.mocked(api.unpinGroupDMMessage).mockReset().mockResolvedValue({ success: true, data: { status: "unpinned" } });
  vi.mocked(api.pinGroupDMMessage).mockReset().mockResolvedValue({ success: true, data: { status: "pinned" } });
  vi.mocked(decryptGroupDMMessages).mockReset().mockImplementation(async (messages) => messages);
});

it("decrypts account-scoped pins and removes one only after confirmed unpin", async () => {
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  expect(await screen.findByText("decrypted pin")).toBeInTheDocument();
  expect(api.listPinnedGroupDMMessages).toHaveBeenCalledWith("group", expect.objectContaining({ expectedUserId: "viewer", isCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
  expect(decryptGroupDMMessages).toHaveBeenCalledWith([message()], expect.any(Function));
  fireEvent.click(screen.getByRole("button", { name: "unpinMessage" }));
  await waitFor(() => expect(screen.queryByText("decrypted pin")).not.toBeInTheDocument());
});

it("keeps a failed unpin visible and supports retry", async () => {
  vi.mocked(api.unpinGroupDMMessage).mockResolvedValueOnce({ success: false, error: "forbidden" });
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  await screen.findByText("decrypted pin");
  fireEvent.click(screen.getByRole("button", { name: "unpinMessage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("groupPinUpdateFailed");
  expect(screen.getByText("decrypted pin")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "groupPinsRetry" }));
  await waitFor(() => expect(screen.queryByText("decrypted pin")).not.toBeInTheDocument());
});

it("renders file-only pins through matching decrypted keys and private-media gating", async () => {
  mediaGate.visible = false;
  const meta = { key: "key", iv: "iv", filename: "private-photo.png", mimeType: "image/png", originalSize: 4, digest: "digest" };
  const attachment = { id: "attachment", group_message_id: "pin", filename: "encrypted_0.bin", file_url: "/api/files/encrypted", file_size: 4, mime_type: "application/octet-stream", created_at: "2026-10-25T00:00:00Z" };
  vi.mocked(api.listPinnedGroupDMMessages).mockResolvedValue({ success: true, data: { messages: [{ ...message(), content: "", attachments: [attachment], e2ee_file_keys: [meta] }] } });
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  expect(await screen.findByText("private media withheld")).toBeInTheDocument();
  expect(screen.queryByText("private-photo.png")).not.toBeInTheDocument();
  expect(mediaGate.inspect).toHaveBeenCalledWith(expect.objectContaining({ privateConversation: true, sourceKind: "group", sourceChannelId: "group", mediaInputs: [{ url: attachment.file_url, mimeType: "image/png", fileMeta: meta }] }));
});

it("does not silently hide a pinned attachment whose decrypted key is unavailable", async () => {
  vi.mocked(api.listPinnedGroupDMMessages).mockResolvedValue({ success: true, data: { messages: [{ ...message(), content: "", attachments: [{ id: "missing", filename: "encrypted_0.bin" } as never] }] } });
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  expect(await screen.findByRole("note")).toHaveTextContent("common:encryptedMessageUnavailable");
});

it("retries load failures without claiming an empty successful list", async () => {
  vi.mocked(api.listPinnedGroupDMMessages).mockResolvedValueOnce({ success: false, error: "offline" });
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("groupPinsLoadFailed");
  fireEvent.click(screen.getByRole("button", { name: "groupPinsRetry" }));
  expect(await screen.findByText("decrypted pin")).toBeInTheDocument();
});

it("does not decrypt or expose an old-account response", async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.listPinnedGroupDMMessages>>) => void;
  vi.mocked(api.listPinnedGroupDMMessages).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  act(() => useAuthStore.setState({ user: { id: "other" } as never }));
  await act(async () => finish({ success: true, data: { messages: [message()] } }));
  expect(decryptGroupDMMessages).not.toHaveBeenCalled();
  expect(screen.queryByText("decrypted pin")).not.toBeInTheDocument();
});

it("clears immediately after membership or key epoch changes and fences a delayed decrypt", async () => {
  let finish!: (value: GroupDMMessage[]) => void;
  vi.mocked(decryptGroupDMMessages).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  await waitFor(() => expect(decryptGroupDMMessages).toHaveBeenCalledOnce());
  act(() => useGroupDMStore.setState({ groups: [] }));
  await act(async () => finish([message()]));
  expect(screen.queryByText("decrypted pin")).not.toBeInTheDocument();
});

it("refreshes pins only for current-member current-socket events", async () => {
  render(<GroupDMPinsPanel groupId="group" onClose={vi.fn()} />);
  await screen.findByText("decrypted pin");
  await act(async () => handleDMEvent({ op: "group_dm_pins_update", d: { group_id: "group", message_id: "pin", pinned: true } }, () => false));
  expect(api.listPinnedGroupDMMessages).toHaveBeenCalledOnce();
  await act(async () => handleDMEvent({ op: "group_dm_pins_update", d: { group_id: "group", message_id: "pin", pinned: true } }, () => true));
  await waitFor(() => expect(api.listPinnedGroupDMMessages).toHaveBeenCalledTimes(2));
  const oldKey = captureGroupDMPinScope("group")!.key;
  act(() => useGroupDMStore.setState({ groups: [] }));
  act(() => window.dispatchEvent(new CustomEvent(GROUP_DM_PINS_CHANGED, { detail: { groupId: "group", scopeKey: oldKey } })));
  expect(api.listPinnedGroupDMMessages).toHaveBeenCalledTimes(2);
});

it("pins only under current captured caller identity and rejects stale success", async () => {
  expect(await pinCurrentGroupDMMessage("group", "pin", { ownerId: "other", authGeneration: getAuthGeneration() })).toBe(false);
  expect(api.pinGroupDMMessage).not.toHaveBeenCalled();
  let finish!: (value: Awaited<ReturnType<typeof api.pinGroupDMMessage>>) => void;
  vi.mocked(api.pinGroupDMMessage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = pinCurrentGroupDMMessage("group", "pin");
  useGroupDMStore.setState({ groups: [] });
  finish({ success: true, data: { status: "pinned" } });
  expect(await pending).toBe(false);
});
