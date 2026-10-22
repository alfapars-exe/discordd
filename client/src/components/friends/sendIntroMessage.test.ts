/**
 * sendIntroMessage — client-side orchestration of the optional intro DM that
 * rides along with a friend request.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../stores/dmStore", () => {
  const createOrGetChannel = vi.fn();
  const sendMessage = vi.fn();
  return { useDMStore: { getState: () => ({ createOrGetChannel, sendMessage }) } };
});
vi.mock("../../stores/toastStore", () => {
  const addToast = vi.fn();
  return { useToastStore: { getState: () => ({ addToast }) } };
});
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { sendIntroMessage, INTRO_MAX_LENGTH } from "./sendIntroMessage";
import { useDMStore } from "../../stores/dmStore";
import { useToastStore } from "../../stores/toastStore";

const dm = () => useDMStore.getState();
const toast = () => useToastStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendIntroMessage", () => {
  it("opens (or reuses) the DM and sends the trimmed text", async () => {
    vi.mocked(dm().createOrGetChannel).mockResolvedValueOnce("ch-1");
    vi.mocked(dm().sendMessage).mockResolvedValueOnce(true);

    const result = await sendIntroMessage("u-target", "  hello there  ");

    expect(result).toBe("sent");
    expect(dm().createOrGetChannel).toHaveBeenCalledWith("u-target");
    expect(dm().sendMessage).toHaveBeenCalledWith("ch-1", "hello there");
    expect(toast().addToast).not.toHaveBeenCalled();
  });

  it("caps the message at INTRO_MAX_LENGTH characters", async () => {
    vi.mocked(dm().createOrGetChannel).mockResolvedValueOnce("ch-1");
    vi.mocked(dm().sendMessage).mockResolvedValueOnce(true);

    await sendIntroMessage("u-target", "x".repeat(INTRO_MAX_LENGTH + 50));

    const sent = vi.mocked(dm().sendMessage).mock.calls[0][1];
    expect(sent).toHaveLength(INTRO_MAX_LENGTH);
  });

  it("toasts an info message and reports channel_unavailable when the DM cannot be opened", async () => {
    vi.mocked(dm().createOrGetChannel).mockResolvedValueOnce(null);

    const result = await sendIntroMessage("u-target", "hi");

    expect(result).toBe("channel_unavailable");
    expect(dm().sendMessage).not.toHaveBeenCalled();
    expect(toast().addToast).toHaveBeenCalledWith("info", "common:friendIntroNotDelivered");
  });

  it("reports send_failed without a second toast when dmStore.sendMessage fails", async () => {
    vi.mocked(dm().createOrGetChannel).mockResolvedValueOnce("ch-1");
    vi.mocked(dm().sendMessage).mockResolvedValueOnce(false);

    const result = await sendIntroMessage("u-target", "hi");

    expect(result).toBe("send_failed");
    expect(toast().addToast).not.toHaveBeenCalled();
  });

  it("does nothing for an empty / whitespace-only message", async () => {
    const result = await sendIntroMessage("u-target", "   ");

    expect(result).toBe("sent");
    expect(dm().createOrGetChannel).not.toHaveBeenCalled();
    expect(dm().sendMessage).not.toHaveBeenCalled();
  });
});
