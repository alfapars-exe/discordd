import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ apiClient: vi.fn() }));
import { apiClient } from "./client";
import { getMessagesAround } from "./messages";

describe("message history request lifetime", () => {
  it("forwards optional scope, timeout, and abort signal to around fetch", () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 5000, isCurrent: () => true };

    getMessagesAround("server-1", "channel-1", "message id", 40, options);

    expect(apiClient).toHaveBeenLastCalledWith(
      "/servers/server-1/channels/channel-1/messages?around=message+id&limit=40",
      options
    );
  });

  it("keeps the existing no-options request shape", () => {
    getMessagesAround("server", "channel", "message");
    expect(apiClient).toHaveBeenLastCalledWith(
      "/servers/server/channels/channel/messages?around=message",
      undefined
    );
  });
});
