import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiClient } = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock("./client", () => ({ apiClient }));

import { sendEncryptedMessage, sendMessage } from "./messages";

describe("message send session context", () => {
  beforeEach(() => apiClient.mockReset().mockResolvedValue({ id: "sent" }));

  const isCurrent = vi.fn(() => true);

  it("forwards the exact account-session predicate on JSON plaintext sends without putting it in the body", async () => {
    await sendMessage("server", "channel", "hello", undefined, "reply", { isCurrent });
    expect(apiClient).toHaveBeenCalledOnce();
    const [path, options] = apiClient.mock.calls[0];
    expect(path).toBe("/servers/server/channels/channel/messages");
    expect(options.isCurrent).toBe(isCurrent);
    expect(options.body).toEqual({ content: "hello", reply_to_id: "reply" });
    expect(JSON.stringify(options.body)).not.toContain("isCurrent");
  });

  it("forwards the context on plaintext multipart sends without adding a context form field", async () => {
    const file = new File(["attachment"], "attachment.txt", { type: "text/plain" });
    await sendMessage("server", "channel", "hello", [file], "reply", { isCurrent });
    const [, options] = apiClient.mock.calls[0];
    expect(options.isCurrent).toBe(isCurrent);
    expect(options.body).toBeInstanceOf(FormData);
    const body = options.body as FormData;
    expect(body.get("content")).toBe("hello");
    expect(body.get("reply_to_id")).toBe("reply");
    expect([...body.keys()].sort()).toEqual(["content", "files", "reply_to_id"]);
  });

  it("forwards context on JSON encrypted sends and never serializes plaintext content", async () => {
    await sendEncryptedMessage("server", "channel", "ciphertext-value", "device-id", "metadata", undefined, "reply", { isCurrent });
    const [, options] = apiClient.mock.calls[0];
    expect(options.isCurrent).toBe(isCurrent);
    expect(options.body).toEqual({ encryption_version: 1, ciphertext: "ciphertext-value", sender_device_id: "device-id", e2ee_metadata: "metadata", reply_to_id: "reply" });
    expect(options.body).not.toHaveProperty("content");
    expect(JSON.stringify(options.body)).not.toContain("isCurrent");
  });

  it("forwards context on encrypted multipart sends without plaintext or context fields", async () => {
    const file = new File(["encrypted attachment"], "attachment.bin", { type: "application/octet-stream" });
    await sendEncryptedMessage("server", "channel", "ciphertext-value", "device-id", "metadata", [file], "reply", { isCurrent });
    const [, options] = apiClient.mock.calls[0];
    expect(options.isCurrent).toBe(isCurrent);
    expect(options.body).toBeInstanceOf(FormData);
    const body = options.body as FormData;
    expect(body.get("ciphertext")).toBe("ciphertext-value");
    expect(body.get("content")).toBeNull();
    expect([...body.keys()].sort()).toEqual(["ciphertext", "e2ee_metadata", "encryption_version", "files", "reply_to_id", "sender_device_id"]);
  });
});
