import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReportModal from "./ReportModal";
import { reportUser } from "../../api/report";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../api/report", () => ({ reportUser: vi.fn() }));

describe("ReportModal message evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reportUser).mockResolvedValue({ success: true, data: undefined });
  });

  it.each(["dm", "group"] as const)("does not disclose encrypted %s text until the reporter opts in", async (kind) => {
    const onClose = vi.fn();
    render(
      <ReportModal
        userId="target"
        username="Target"
        onClose={onClose}
        messageEvidence={{
          kind,
          channelId: "dm-1",
          messageId: "msg-1",
          content: "decrypted secret",
          encrypted: true,
        }}
      />,
    );

    expect(screen.getByText("reportEncryptedMessageHint")).toBeInTheDocument();
    fireEvent.click(screen.getByText("reportReasonHarassment"));
    fireEvent.change(screen.getByPlaceholderText("reportDescriptionPlaceholder"), {
      target: { value: "This report has enough detail" },
    });
    fireEvent.click(screen.getByRole("button", { name: "reportSubmit" }));

    await waitFor(() => expect(reportUser).toHaveBeenCalledTimes(1));
    expect(reportUser).toHaveBeenLastCalledWith("target", expect.objectContaining({
      source_kind: kind,
      source_channel_id: "dm-1",
      source_message_id: "msg-1",
      evidence_consent: false,
      evidence_content: undefined,
    }), undefined);

    cleanup();
    vi.mocked(reportUser).mockClear();
    render(
      <ReportModal
        userId="target-2"
        username="Target 2"
        onClose={vi.fn()}
        messageEvidence={{ kind: "channel", serverId: "s1", channelId: "c1", messageId: "m2", content: "shared", encrypted: true }}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "reportShareMessageContent" }));
    fireEvent.click(screen.getByText("reportReasonSpam"));
    fireEvent.change(screen.getByPlaceholderText("reportDescriptionPlaceholder"), { target: { value: "This is clearly unwanted spam" } });
    fireEvent.click(screen.getByRole("button", { name: "reportSubmit" }));
    await waitFor(() => expect(reportUser).toHaveBeenCalledWith("target-2", expect.objectContaining({
      evidence_consent: true,
      evidence_content: "shared",
    }), undefined));
  });
});
