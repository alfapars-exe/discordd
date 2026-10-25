import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LofiPlayer from "./LofiPlayer";
import { publishAuthGenerationChange } from "../../api/authSessionEvents";

const fixture = vi.hoisted(() => ({
  voice: { outputDevice: "speaker-a", masterVolume: 50, isDeafened: false, isServerDeafened: false },
  player: { play: vi.fn(), pause: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setVolume: vi.fn(), setOutputDevice: vi.fn() },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../audio/lofiEngine", () => ({ createLofiPlayer: () => fixture.player }));
vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: (select: (state: typeof fixture.voice) => unknown) => select(fixture.voice) }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.resetAllMocks();
  fixture.voice = { outputDevice: "speaker-a", masterVolume: 50, isDeafened: false, isServerDeafened: false };
  fixture.player.setOutputDevice.mockResolvedValue({ fallback: false, supported: true });
  for (const method of [fixture.player.play, fixture.player.pause, fixture.player.stop, fixture.player.dispose]) method.mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
it("does not autoplay and applies personal volume, master volume and deafen", async () => {
  const view = render(<LofiPlayer onClose={vi.fn()} />);
  await waitFor(() => expect(fixture.player.setOutputDevice).toHaveBeenCalledWith("speaker-a"));
  expect(fixture.player.play).not.toHaveBeenCalled();
  expect(fixture.player.setVolume).toHaveBeenLastCalledWith(0.1);
  fireEvent.change(screen.getByRole("slider"), { target: { value: "60" } });
  expect(fixture.player.setVolume).toHaveBeenLastCalledWith(0.3);
  fixture.voice.isDeafened = true;
  view.rerender(<LofiPlayer onClose={vi.fn()} />);
  expect(fixture.player.setVolume).toHaveBeenLastCalledWith(0);
  expect(screen.getByText("lofiDeafened")).toBeInTheDocument();
  fixture.voice.isDeafened = false;
  fixture.voice.isServerDeafened = true;
  view.rerender(<LofiPlayer onClose={vi.fn()} />);
  expect(fixture.player.setVolume).toHaveBeenLastCalledWith(0);
  fixture.voice.isServerDeafened = false;
  view.rerender(<LofiPlayer onClose={vi.fn()} />);
  expect(fixture.player.setVolume).toHaveBeenLastCalledWith(0.3);
});
it("waits for serialized latest output before playing", async () => {
  let resolve!: (value: { fallback: boolean; supported: boolean }) => void;
  fixture.player.setOutputDevice.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<LofiPlayer onClose={vi.fn()} />);
  await waitFor(() => expect(fixture.player.setOutputDevice).toHaveBeenCalledTimes(1));
  fixture.voice.outputDevice = "speaker-b";
  view.rerender(<LofiPlayer onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(fixture.player.play).not.toHaveBeenCalled();
  await act(async () => resolve({ fallback: false, supported: true }));
  await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());
  expect(fixture.player.setOutputDevice.mock.calls.map(([id]) => id)).toEqual(["speaker-a", "speaker-b"]);
});
it("reports playback failures and allows retry, pause and stop", async () => {
  fixture.player.play.mockRejectedValueOnce(new Error("permission denied"));
  render(<LofiPlayer onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByRole("alert")).toHaveTextContent("lofiPlaybackError");
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByText("lofiPlaying")).toBeInTheDocument();
  fireEvent.click(screen.getByText("lofiPause"));
  expect(await screen.findByText("lofiPaused")).toBeInTheDocument();
  fireEvent.click(screen.getByText("lofiStop"));
  expect(await screen.findByText("lofiStopped")).toBeInTheDocument();
});
it.each([
  ["NotAllowedError", "lofiPermissionError"],
  ["SecurityError", "lofiPermissionError"],
  ["NotFoundError", "lofiDeviceError"],
  ["NotReadableError", "lofiDeviceError"],
])("explains %s without exposing the platform error message", async (name, key) => {
  fixture.player.play.mockRejectedValueOnce(new DOMException("private-device-details", name));
  render(<LofiPlayer onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByRole("alert")).toHaveTextContent(key);
  expect(screen.queryByText("private-device-details")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByText("lofiPlaying")).toBeInTheDocument();
});
it("honestly reports unsupported custom output", async () => {
  fixture.player.setOutputDevice.mockResolvedValue({ fallback: false, supported: false });
  render(<LofiPlayer onClose={vi.fn()} />);
  expect(await screen.findByText("lofiOutputUnsupported")).toBeInTheDocument();
});
it("reports fallback discovered only when first playback creates the audio context", async () => {
  fixture.player.play.mockResolvedValue({ fallback: true, supported: true });
  render(<LofiPlayer onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByText("lofiPlaying")).toBeInTheDocument();
  expect(screen.getByText("lofiOutputFallback")).toBeInTheDocument();
});
it.each(["unsupported", "failed"])("reflects paused playback when live output becomes %s", async (kind) => {
  const view = render(<LofiPlayer onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByText("lofiPlaying")).toBeInTheDocument();
  if (kind === "unsupported") fixture.player.setOutputDevice.mockResolvedValue({ fallback: false, supported: false });
  else fixture.player.setOutputDevice.mockRejectedValue(new Error("sink denied"));
  fixture.voice.outputDevice = "speaker-b";
  view.rerender(<LofiPlayer onClose={vi.fn()} />);
  expect(await screen.findByText("lofiPaused")).toBeInTheDocument();
  expect(screen.getByText(kind === "unsupported" ? "lofiOutputUnsupported" : "lofiOutputError")).toBeInTheDocument();
});
it("retries a failed output selection before playing and reports fallback", async () => {
  fixture.player.setOutputDevice.mockRejectedValueOnce(new Error("device removed"))
    .mockResolvedValue({ fallback: true, supported: true });
  render(<LofiPlayer onClose={vi.fn()} />);
  expect(await screen.findByText("lofiOutputError")).toBeInTheDocument();
  fireEvent.click(screen.getByText("lofiPlay"));
  expect(await screen.findByText("lofiPlaying")).toBeInTheDocument();
  expect(screen.getByText("lofiOutputFallback")).toBeInTheDocument();
});
it("closing while output is pending prevents a late play", async () => {
  let finish!: (value: { fallback: boolean; supported: boolean }) => void;
  fixture.player.setOutputDevice.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<LofiPlayer onClose={vi.fn()} />);
  await waitFor(() => expect(fixture.player.setOutputDevice).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("lofiPlay"));
  fireEvent.click(screen.getByText("close"));
  await act(async () => finish({ fallback: false, supported: true }));
  expect(fixture.player.play).not.toHaveBeenCalled();
  expect(fixture.player.dispose).toHaveBeenCalledOnce();
});
it("disposes on session change and ignores late play completion", async () => {
  let finish!: () => void;
  fixture.player.play.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  render(<LofiPlayer onClose={onClose} />);
  fireEvent.click(screen.getByText("lofiPlay"));
  await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());
  act(() => publishAuthGenerationChange(12));
  expect(onClose).toHaveBeenCalledOnce();
  expect(fixture.player.dispose).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(screen.queryByText("lofiPlaying")).not.toBeInTheDocument();
});
it("Escape closes and cleanup restores trigger focus", async () => {
  const button = document.createElement("button"); document.body.append(button); button.focus();
  const onClose = vi.fn();
  const view = render(<LofiPlayer onClose={onClose} />);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(button);
  button.remove();
});
