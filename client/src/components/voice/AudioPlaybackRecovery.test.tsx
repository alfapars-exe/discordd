import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionState, type Room } from "livekit-client";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../../api/authSessionEvents";
import { useVoiceStore } from "../../stores/voiceStore";
import AudioPlaybackRecovery from "./AudioPlaybackRecovery";

const h = vi.hoisted(() => ({ canPlay: true }));
vi.mock("@livekit/components-react", () => ({ useAudioPlayback: (room: Room) => ({ canPlayAudio: h.canPlay, startAudio: () => room.startAudio() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ currentVoiceChannelId: "channel", _joinGeneration: 1, isDeafened: false, isServerDeafened: false, isMuted: true, masterVolume: 50, screenShareVolumes: { peer: 75 } })) };
});
const room = () => ({ state: ConnectionState.Connected, canPlaybackAudio: false, startAudio: vi.fn(async () => {}) });
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  h.canPlay = false; publishAuthOwnerChange("owner"); publishAuthGenerationChange(1);
  useVoiceStore.setState({ currentVoiceChannelId: "channel", _joinGeneration: 1, isDeafened: false, isServerDeafened: false, isMuted: true, masterVolume: 50, screenShareVolumes: { peer: 75 } });
});
afterEach(cleanup);

it("offers an explicit gesture only when the SDK reports playback blocked", () => {
  const r = room(); h.canPlay = true;
  const view = render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  expect(screen.queryByRole("button")).toBeNull();
  h.canPlay = false; view.rerender(<AudioPlaybackRecovery room={r as unknown as Room} />);
  expect(screen.getByRole("button", { name: "audioPlaybackStart" })).toBeTruthy();
  expect(r.startAudio).not.toHaveBeenCalled();
});

it("starts synchronously inside the gesture, deduplicates pending clicks and preserves mute/volume intent", async () => {
  const r = room(), pending = deferred(); r.startAudio.mockReturnValue(pending.promise);
  render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  const before = useVoiceStore.getState();
  fireEvent.click(screen.getByRole("button"));
  expect(r.startAudio).toHaveBeenCalledOnce();
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.click(screen.getByRole("button")); expect(r.startAudio).toHaveBeenCalledOnce();
  expect(useVoiceStore.getState()).toBe(before);
  await act(async () => pending.resolve());
  expect(screen.getByRole("button")).not.toBeDisabled();
});

it("keeps a failed attempt retryable without exposing a raw browser error", async () => {
  const r = room(); r.startAudio.mockRejectedValue(new Error("private browser details"));
  render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  await act(async () => fireEvent.click(screen.getByRole("button")));
  expect(screen.getByText("audioPlaybackRetry")).toBeTruthy();
  expect(screen.queryByText("private browser details")).toBeNull();
  expect(screen.getByRole("button")).not.toBeDisabled();
});

it.each(["owner", "generation", "channel", "join", "disconnected", "deafened", "server-deafened"])("rejects a stale action after %s changes", async (change) => {
  const r = room(); render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  const button = screen.getByRole("button");
  act(() => {
    if (change === "owner") publishAuthOwnerChange("other");
    if (change === "generation") publishAuthGenerationChange(2);
    if (change === "channel") useVoiceStore.setState({ currentVoiceChannelId: "other" });
    if (change === "join") useVoiceStore.setState({ _joinGeneration: 2 });
    if (change === "disconnected") r.state = ConnectionState.Disconnected;
    if (change === "deafened") useVoiceStore.setState({ isDeafened: true });
    if (change === "server-deafened") useVoiceStore.setState({ isServerDeafened: true });
  });
  fireEvent.click(button);
  expect(r.startAudio).not.toHaveBeenCalled();
});

it("ignores the previous room's delayed failure", async () => {
  const old = room(), next = room(), pending = deferred(); old.startAudio.mockReturnValue(pending.promise);
  const view = render(<AudioPlaybackRecovery room={old as unknown as Room} />);
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<AudioPlaybackRecovery room={next as unknown as Room} />);
  await act(async () => pending.reject(new Error("old room")));
  expect(screen.queryByText("audioPlaybackRetry")).toBeNull();
  expect(screen.getByRole("button")).not.toBeDisabled();
});


it("rechecks the SDK's live flag before acting on an outdated blocked button", () => {
  const r = room(); render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  r.canPlaybackAudio = true;
  fireEvent.click(screen.getByRole("button"));
  expect(r.startAudio).not.toHaveBeenCalled();
});

it("handles rejection after unmount without another playback request or preference changes", async () => {
  const r = room(), pending = deferred(); r.startAudio.mockReturnValue(pending.promise);
  const before = useVoiceStore.getState();
  const view = render(<AudioPlaybackRecovery room={r as unknown as Room} />);
  fireEvent.click(screen.getByRole("button")); view.unmount();
  await act(async () => pending.reject(new Error("retired room")));
  expect(r.startAudio).toHaveBeenCalledOnce();
  expect(useVoiceStore.getState()).toBe(before);
});
