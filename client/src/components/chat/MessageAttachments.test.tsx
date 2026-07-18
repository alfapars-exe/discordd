import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MessageAttachments from "./MessageAttachments";
import type { ChatMessage, ChatAttachment } from "../../hooks/useChatContext";

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

  it("falls back to file-card when the <img> fires onError", () => {
    const msg = makeMessage({ attachments: [makeAttachment()] });
    render(<MessageAttachments message={msg} />);
    const img = screen.getByRole("img", { name: "example.png" });
    fireEvent.error(img);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("example.png")).toBeInTheDocument();
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
