import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServerEmoji, ServerSticker } from "../../types/expression";
import type { ChatContextValue } from "../../hooks/useChatContext";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts && Object.keys(opts).length > 0 ? `${key}(${Object.values(opts).join(",")})` : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../hooks/useReducedMotion", () => ({ useReducedMotion: () => false }));

vi.mock("../inbox/PopoverShell", () => ({
  default: ({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) => (
    <div role="dialog" aria-label={ariaLabel}>
      {children}
    </div>
  ),
}));

const h = vi.hoisted(() => ({
  emojiServers: [] as { id: string; name: string; emojis: unknown[] }[],
  emojiByServer: {} as Record<string, unknown[]>,
  stickerById: {} as Record<string, unknown>,
  stickerServers: [] as { id: string; name: string; stickers: unknown[] }[],
  perms: 0,
  activeServerId: "s-dst" as string | null,
  addToast: vi.fn(),
}));

vi.mock("../../hooks/useEmojiCatalog", () => ({
  useEmojiCatalog: () => ({ status: "ready", servers: h.emojiServers, byServer: h.emojiByServer }),
}));

vi.mock("../../hooks/useStickerCatalog", () => ({
  useStickerCatalog: () => ({
    status: "ready",
    servers: h.stickerServers,
    byServer: {},
    byId: h.stickerById,
  }),
}));

vi.mock("../../stores/authStore", () => ({
  useAuthStore: <T,>(sel: (s: { user: { id: string } }) => T) => sel({ user: { id: "me" } }),
}));

vi.mock("../../stores/memberStore", () => ({
  useActiveMembers: () => [{ id: "me", effective_permissions: h.perms }],
}));

vi.mock("../../stores/serverStore", () => ({
  useServerStore: <T,>(sel: (s: { servers: { id: string; name: string }[]; activeServerId: string | null }) => T) =>
    sel({
      servers: [
        { id: "s-src", name: "Source Server" },
        { id: "s-dst", name: "Target Server" },
      ],
      activeServerId: h.activeServerId,
    }),
}));

vi.mock("../../stores/toastStore", () => ({
  useToastStore: <T,>(sel: (s: { addToast: typeof h.addToast }) => T) => sel({ addToast: h.addToast }),
}));

vi.mock("../../api/expressionClone", () => ({
  cloneEmoji: vi.fn(),
  cloneSticker: vi.fn(),
}));

import * as cloneApi from "../../api/expressionClone";
import { ChatContext } from "../../hooks/useChatContext";
import { useEmojiStore } from "../../stores/emojiStore";
import { useStickerStore } from "../../stores/stickerStore";
import { Permissions } from "../../utils/permissions";
import ExpressionInfoPopover from "./ExpressionInfoPopover";

const api = vi.mocked(cloneApi);
const SRC = "0123456789abcdef";
const NEW = "fedcba9876543210";

function emoji(over: Partial<ServerEmoji> = {}): ServerEmoji {
  return {
    id: SRC,
    server_id: "s-src",
    name: "kedi",
    display_name: "Kedi Emoji",
    animated: false,
    url: `/api/uploads/emojis/${SRC}.png`,
    animated_url: null,
    copyable: true,
    cloned_from: null,
    created_by: "u1",
    created_at: "2026-10-22T10:00:00Z",
    ...over,
  };
}

function sticker(over: Partial<ServerSticker> = {}): ServerSticker {
  return {
    id: SRC,
    server_id: "s-src",
    name: "mutlu",
    display_name: "Mutlu Kedi",
    description: "çok mutlu",
    tags: ["kedi", "mutlu"],
    animated: false,
    url: `/api/uploads/stickers/${SRC}.png`,
    animated_url: null,
    copyable: true,
    cloned_from: null,
    created_by: "u1",
    created_at: "2026-10-22T10:00:00Z",
    ...over,
  };
}

const channelCtx = { mode: "channel", serverId: "s-dst" } as unknown as ChatContextValue;
const dmCtx = { mode: "dm" } as unknown as ChatContextValue;
const anchor = { rect: new DOMRect(0, 0, 10, 10), placement: "below" as const };

function renderPopover(kind: "emoji" | "sticker", ctx: ChatContextValue = channelCtx) {
  return render(
    <ChatContext.Provider value={ctx}>
      <ExpressionInfoPopover kind={kind} id={SRC} name="kedi" animated={false} anchor={anchor} onClose={() => {}} />
    </ChatContext.Provider>,
  );
}

function setEmojiCatalog(list: ServerEmoji[]) {
  h.emojiByServer = {};
  for (const e of list) (h.emojiByServer[e.server_id] ??= []).push(e);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.emojiByServer = {};
  h.stickerById = {};
  h.perms = Permissions.ManageExpressions;
  h.activeServerId = "s-dst";
  useEmojiStore.getState().reset();
  useStickerStore.getState().reset();
});

describe("ExpressionInfoPopover", () => {
  it("not in the viewer's catalog: only :name: + generic line, never a server name", () => {
    renderPopover("emoji");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(":kedi:");
    expect(dialog.textContent).toContain("fromOtherServer");
    expect(dialog.textContent).not.toContain("Source Server");
    expect(dialog.textContent).not.toContain("Target Server");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("catalog emoji: display name, source server, copyable badge and clone button", () => {
    setEmojiCatalog([emoji()]);
    renderPopover("emoji");
    expect(screen.getByText("Kedi Emoji")).toBeInTheDocument();
    expect(screen.getByText("sourceServer(Source Server)")).toBeInTheDocument();
    expect(screen.getByText("copyableBadge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "addToServer(Target Server)" })).toBeInTheDocument();
  });

  it("sticker shows description + tags", () => {
    h.stickerById = { [SRC]: sticker() };
    renderPopover("sticker");
    expect(screen.getByText("Mutlu Kedi")).toBeInTheDocument();
    expect(screen.getByText("çok mutlu")).toBeInTheDocument();
    expect(screen.getByText("mutlu")).toBeInTheDocument();
  });

  it("no clone button without ManageExpressions / in DMs / for non-copyable / for clones / same server", () => {
    setEmojiCatalog([emoji()]);
    h.perms = 0;
    const { unmount } = renderPopover("emoji");
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    h.perms = Permissions.ManageExpressions;
    const dm = renderPopover("emoji", dmCtx);
    expect(screen.queryByRole("button")).toBeNull();
    dm.unmount();

    setEmojiCatalog([emoji({ copyable: false })]);
    const nc = renderPopover("emoji");
    expect(screen.queryByRole("button")).toBeNull();
    nc.unmount();

    setEmojiCatalog([emoji({ cloned_from: "ffffffffffffffff" })]);
    const cl = renderPopover("emoji");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("cloneOf")).toBeInTheDocument();
    cl.unmount();

    setEmojiCatalog([emoji({ server_id: "s-dst" })]);
    renderPopover("emoji");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hides the button when the target already holds a clone of it", () => {
    setEmojiCatalog([emoji()]);
    useEmojiStore.getState().handleCreate(emoji({ id: NEW, server_id: "s-dst", cloned_from: SRC, copyable: false }));
    renderPopover("emoji");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clone success: calls the API for the active server, upserts the store, toasts copied", async () => {
    setEmojiCatalog([emoji()]);
    const created = emoji({ id: NEW, server_id: "s-dst", cloned_from: SRC, copyable: false });
    api.cloneEmoji.mockResolvedValue({ success: true, data: created });
    renderPopover("emoji");
    fireEvent.click(screen.getByRole("button", { name: "addToServer(Target Server)" }));
    await waitFor(() => expect(h.addToast).toHaveBeenCalledWith("success", "copied"));
    expect(api.cloneEmoji).toHaveBeenCalledWith("s-dst", SRC);
    expect(useEmojiStore.getState().byId[NEW]).toEqual(created);
    // Now cloned → the offer disappears.
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });

  it("clone failure maps the server code to an i18n toast", async () => {
    h.stickerById = { [SRC]: sticker() };
    api.cloneSticker.mockResolvedValue({ success: false, code: "EXPRESSION_LIMIT_REACHED", error: "x" });
    renderPopover("sticker");
    fireEvent.click(screen.getByRole("button", { name: "addToServer(Target Server)" }));
    await waitFor(() => expect(h.addToast).toHaveBeenCalledWith("error", "stickerLimitReached"));
    expect(api.cloneSticker).toHaveBeenCalledWith("s-dst", SRC);
  });
});
