import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/voiceStore", async () => { const { create } = await import("zustand"); return {
  useVoiceStore: create(() => ({
    localMutedUsers: {}, activeSpeakers: {}, watchingScreenShares: {}, screenShareViewers: {},
    toggleWatchScreenShare: vi.fn(), currentVoiceChannelId: null,
  })),
}; });
vi.mock("../../stores/authStore", async () => { const { create } = await import("zustand"); return {
  useAuthStore: create(() => ({ user: { id: "me" } })),
}; });
vi.mock("../../stores/uiStore", async () => { const { create } = await import("zustand"); return {
  useUIStore: create(() => ({ openTab: vi.fn() })),
}; });
vi.mock("../shared/Avatar", () => ({ default: ({ name }: { name: string }) => <img alt={`${name} avatar`} /> }));
import VoiceParticipantList from "./VoiceParticipantList";
import type { VoiceState } from "../../types";

const person = (id: string): VoiceState => ({
  user_id: id, channel_id: "b", username: id, display_name: id, avatar_url: "",
  is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false,
});

function renderList(pendingUserIds?: ReadonlySet<string>, canMoveMembers = true) {
  const onDragStart = vi.fn();
  // Stands in for ChannelItem's draggable wrapper, whose dragstart arms a channel reorder.
  const onChannelDragStart = vi.fn();
  render(
    <div draggable onDragStart={onChannelDragStart}>
      <VoiceParticipantList
        participants={[person("me"), person("ada"), person("bob")]}
        pendingUserIds={pendingUserIds}
        channelId="b"
        channelName="Room"
        canMoveMembers={canMoveMembers}
        draggingVoiceUserId={null}
        onDragStart={onDragStart}
        onDragEnd={vi.fn()}
        onContextMenu={vi.fn()}
        onShowUserCard={vi.fn()}
        getActiveServerInfo={() => undefined}
      />
    </div>,
  );
  const row = (name: string) => screen.getByText(name).closest(".ch-tree-voice-user") as HTMLElement;
  return { me: row("me"), ada: row("ada"), bob: row("bob"), onDragStart, onChannelDragStart };
}

it("draws unconfirmed rows dimmed and busy, without the drag hint", () => {
  const rows = renderList(new Set(["me", "ada"]));
  for (const pending of [rows.me, rows.ada]) {
    expect(pending).toHaveClass("vu-pending");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("title", "connectingToVoice");
  }
  expect(rows.bob).not.toHaveClass("vu-pending");
  expect(rows.bob).not.toHaveAttribute("aria-busy");
  expect(rows.bob).toHaveAttribute("draggable", "true");
  expect(rows.bob).toHaveAttribute("title", "dragToMove");
});

it("leaves every row as before when nothing is pending", () => {
  const rows = renderList();
  for (const row of [rows.me, rows.ada, rows.bob]) {
    expect(row).not.toHaveClass("vu-pending");
    expect(row).toHaveAttribute("draggable", "true");
  }
});

// The row sits inside the channel's draggable wrapper. A row that is not a
// drag source itself hands the gesture to that wrapper (a channel reorder),
// so an unconfirmed row stays a drag source and cancels the drag instead.
it("cancels a drag started on an unconfirmed row instead of moving the member or the channel", () => {
  const rows = renderList(new Set(["me", "ada"]));
  for (const pending of [rows.me, rows.ada]) {
    expect(pending).toHaveAttribute("draggable", "true");
    for (const origin of [pending, pending.querySelector("img") as HTMLElement]) {
      // fireEvent returns false when the event's default was prevented.
      expect(fireEvent.dragStart(origin)).toBe(false);
    }
  }
  expect(rows.onDragStart).not.toHaveBeenCalled();
  expect(rows.onChannelDragStart).not.toHaveBeenCalled();

  expect(fireEvent.dragStart(rows.bob)).toBe(true);
  expect(rows.onDragStart).toHaveBeenCalledExactlyOnceWith(expect.anything(), "bob", "b");
});

it("cancels an avatar drag on a member the user may not move", () => {
  const rows = renderList(undefined, false);
  expect(rows.ada).toHaveAttribute("draggable", "false");
  expect(fireEvent.dragStart(rows.ada.querySelector("img") as HTMLElement)).toBe(false);
  expect(rows.onDragStart).not.toHaveBeenCalled();
  expect(rows.onChannelDragStart).not.toHaveBeenCalled();

  // The user's own row still starts a drag: that is the channel switch.
  expect(fireEvent.dragStart(rows.me)).toBe(true);
  expect(rows.onDragStart).toHaveBeenCalledExactlyOnceWith(expect.anything(), "me", "b");
});
