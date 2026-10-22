import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ServerEmoji } from "../../types/expression";

type CapturedProps = { custom?: { id: string; emojis: { id: string; skins: { src: string }[] }[] }[] };

const captured = vi.hoisted(() => ({ props: null as CapturedProps | null }));

vi.mock("@emoji-mart/react", () => ({
  default: (props: CapturedProps) => {
    captured.props = props;
    return null;
  },
}));

vi.mock("@emoji-mart/data", () => ({ default: { categories: [], emojis: {} } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

function emoji(id: string, name: string): ServerEmoji {
  return {
    id,
    server_id: "s1",
    name,
    display_name: name,
    animated: false,
    url: `/api/uploads/emojis/${id}.png`,
    animated_url: null,
    copyable: false,
    cloned_from: null,
    created_by: null,
    created_at: "2026-10-22T10:00:00Z",
  };
}

vi.mock("../../hooks/useEmojiCatalog", () => ({
  useEmojiCatalog: () => ({
    status: "ready",
    byServer: {},
    servers: [
      {
        id: "s1",
        name: "Server One",
        emojis: [emoji("0123456789abcdef", "ok"), emoji("../../evil", "bad"), emoji("ABCDEF0123456789", "upper")],
      },
      { id: "s2", name: "Only Bad", emojis: [emoji("x", "bad2")] },
    ],
  }),
}));

import EmojiPicker from "./EmojiPicker";

describe("EmojiPicker — custom categories", () => {
  it("drops emojis whose id is not 16 lowercase hex (and empty categories)", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} customEmojis />);
    await waitFor(() => expect(captured.props).not.toBeNull());
    const custom = captured.props?.custom ?? [];
    expect(custom.map((c) => c.id)).toEqual(["server_s1"]);
    expect(custom[0].emojis.map((e) => e.id)).toEqual(["0123456789abcdef"]);
    expect(custom[0].emojis[0].skins[0].src).toContain("/api/uploads/emojis/0123456789abcdef.png");
  });
});
