import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MessageAttachments from "./MessageAttachments";
import { ensureFreshToken } from "../../api/client";
import type { ChatMessage, ChatAttachment } from "../../hooks/useChatContext";

vi.mock("../../api/client", () => ({
  ensureFreshToken: vi.fn(async () => "fresh-token"),
}));

vi.mock("./EncryptedAttachment", () => ({
  default: ({ attachment }: { attachment: ChatAttachment }) => (
    <div data-testid="encrypted-attachment">{attachment.filename}</div>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("../../utils/constants", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../utils/constants");
  return {
    ...actual,
    resolveAssetUrl: (path: string) => `https://cdn.test/${path}`,
  };
});

function makeAttachment(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "att-1",
    filename: "example.png",
    file_url: "/files/example.png",
    file_size: 1024,
    mime_type: "image/png",
    ...over,
  };
}

function makeMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    user_id: "user-1",
    content: null,
    edited_at: null,
    created_at: "2026-07-18T00:00:00Z",
    reply_to_id: null,
    is_pinned: false,
    author: { id: "user-1", username: "alice", display_name: "Alice", avatar_url: null } as ChatMessage["author"],
    attachments: [],
    reactions: [],
    referenced_message: null,
    ...over,
  };
}

describe("MessageAttachments", () => {
  beforeEach(() => {
    vi.mocked(ensureFreshToken).mockClear();
  });

  it("renders nothing when there are no attachments", () => {
    const { container } = render(<MessageAttachments message={makeMessage()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders <img> when mime_type says image", () => {
    const msg = makeMessage({ attachments: [makeAttachment()] });
    render(<MessageAttachments message={msg} />);
    expect(screen.getByRole("img", { name: "example.png" })).toBeInTheDocument();
  });

  it("renders <img> when mime_type is null but filename ends in .png", () => {
    const msg = makeMessage({
      attachments: [makeAttachment({ mime_type: null, filename: "silent.png" })],
    });
    render(<MessageAttachments message={msg} />);
    expect(screen.getByRole("img", { name: "silent.png" })).toBeInTheDocument();
  });

  it("renders <img> when mime_type is application/octet-stream but filename ends in .jpg", () => {
    const msg = makeMessage({
      attachments: [
        makeAttachment({
          mime_type: "application/octet-stream",
          filename: "camera-roll.jpg",
        }),
      ],
    });
    render(<MessageAttachments message={msg} />);
    expect(screen.getByRole("img", { name: "camera-roll.jpg" })).toBeInTheDocument();
  });

  it("falls back to file-card when mime_type is null and extension is unknown", () => {
    const msg = makeMessage({
      attachments: [
        makeAttachment({ mime_type: null, filename: "notes.pdf" }),
      ],
    });
    render(<MessageAttachments message={msg} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();
  });

  /**
   * A single onError is usually a stale `hichat_media` cookie (its value is the
   * access token, but its Max-Age far outlives that token). Refresh the token
   * and re-request with a busted URL instead of latching to a file card — the
   * old latch-on-first-error made the tile stick as a generic file card for the
   * life of the render even once the cookie was refreshed.
   */
  it("refreshes the token and retries with a busted src on the first onError", async () => {
    const msg = makeMessage({ attachments: [makeAttachment()] });
    render(<MessageAttachments message={msg} />);
    const img = screen.getByRole("img", { name: "example.png" });
    const originalSrc = img.getAttribute("src");
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "example.png" }).getAttribute("src")).not.toBe(
        originalSrc
      );
    });
    expect(ensureFreshToken).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "example.png" })).toBeInTheDocument();
  });

  it("latches to the file card when the retried <img> also fires onError", async () => {
    const msg = makeMessage({ attachments: [makeAttachment()] });
    render(<MessageAttachments message={msg} />);
    const img = screen.getByRole("img", { name: "example.png" });
    const originalSrc = img.getAttribute("src");
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "example.png" }).getAttribute("src")).not.toBe(
        originalSrc
      );
    });
    fireEvent.error(screen.getByRole("img", { name: "example.png" }));

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("example.png")).toBeInTheDocument();
    expect(ensureFreshToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the image inline when the retry succeeds", async () => {
    const msg = makeMessage({ attachments: [makeAttachment()] });
    render(<MessageAttachments message={msg} />);
    fireEvent.error(screen.getByRole("img", { name: "example.png" }));

    await waitFor(() => expect(ensureFreshToken).toHaveBeenCalledTimes(1));

    const retried = screen.getByRole("img", { name: "example.png" });
    expect(retried).toBeInTheDocument();
    expect(retried.closest("a")).toHaveAttribute(
      "href",
      "https://cdn.test//files/example.png"
    );
    expect(screen.queryByText("1.0 KB")).toBeNull();
  });

  it("renders EncryptedAttachment when encryption_version=1 and key present", () => {
    const msg = makeMessage({
      attachments: [makeAttachment()],
      encryption_version: 1,
      e2ee_file_keys: [
        {
          key: "k",
          iv: "n",
          filename: "example.png",
          mimeType: "image/png",
          originalSize: 1,
          digest: "d",
        },
      ],
    });
    render(<MessageAttachments message={msg} />);
    expect(screen.getByTestId("encrypted-attachment")).toBeInTheDocument();
  });

  it("renders a 'missing key' placeholder when encryption_version=1 but key is missing", () => {
    const msg = makeMessage({
      attachments: [makeAttachment()],
      encryption_version: 1,
      e2ee_file_keys: [],
    });
    render(<MessageAttachments message={msg} />);
    expect(screen.queryByTestId("encrypted-attachment")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("example.png")).toBeInTheDocument();
    expect(screen.getByText(/e2eeKeyMissing/)).toBeInTheDocument();
  });
});
