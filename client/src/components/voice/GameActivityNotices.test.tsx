import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GameActivityNotices from "./GameActivityNotices";
import VoiceOverlayContent, { type VoiceOverlaySnapshot } from "./VoiceOverlayContent";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key }) }));
const notice = (kind: "game_activity" | "now_playing" = "game_activity", n = 1) => ({ noticeId: `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`, label: "Friend", gameName: "CS2", kind, expiresAt: Date.now() + 3000 });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("renders independent passive game notices and expires locally without another main snapshot", () => {
  const entries = [notice(), notice("now_playing", 2)];
  const view = render(<GameActivityNotices gameActivityNotices={entries} voiceOverlayGameActivityNotifications height={144} bottom={8} />);
  expect(screen.getByText("overlayGameActivityNotice:Friend")).toBeInTheDocument();
  expect(screen.queryByText("overlayNowPlayingNotice:Friend")).not.toBeInTheDocument();
  expect(view.container.querySelector("section")).toHaveStyle({ pointerEvents: "none", maxHeight: "144px" });
  expect(screen.queryByRole("button")).not.toBeInTheDocument(); expect(screen.queryByRole("link")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(3001)); expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("rejects foreign identifiers and obeys native row capacity", () => {
  const view = render(<GameActivityNotices gameActivityNotices={[notice(), notice("now_playing", 2)]} voiceOverlayGameActivityNotifications voiceOverlayNowPlayingNotifications height={48} bottom={8} />);
  expect(screen.getAllByText("CS2")).toHaveLength(1);
  view.rerender(<GameActivityNotices gameActivityNotices={[{ ...notice(), userId: "private" } as ReturnType<typeof notice>]} voiceOverlayGameActivityNotifications height={48} bottom={8} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps compatibility passive and displays notices with other widgets disabled", () => {
  const snapshot: VoiceOverlaySnapshot = { enabled: true, voiceOverlayCompatibility: true, voiceOverlayGameActivityNotifications: true,
    gameActivityNotices: [notice()], gameActivityNoticeHeight: 48, participants: [], voiceOverlayMaxParticipants: 0,
    speakingOpacity: 95, idleOpacity: 35, scale: 100, position: "bottom-left", speakingOnly: false,
    voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always" };
  const view = render(<VoiceOverlayContent snapshot={snapshot} />);
  expect(screen.getByText("overlayGameActivityNotice:Friend")).toBeInTheDocument();
  expect(view.container.querySelector(".voice-overlay-root")).toHaveStyle({ paddingBottom: "56px" });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
