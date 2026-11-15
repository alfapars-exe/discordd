import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CustomTitleBar from "./CustomTitleBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { delete window.electronAPI; vi.restoreAllMocks(); });

it("observes a rejected install request and keeps the downloaded update available for retry", async () => {
  let downloaded!: () => void;
  const install = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const api: Pick<NonNullable<Window["electronAPI"]>, "onMaximizedChange" | "onUpdateDownloaded" | "installUpdate"> = {
    onMaximizedChange: () => () => {},
    onUpdateDownloaded: callback => { downloaded = () => callback({ version: "2.0.0" }); return () => {}; },
    installUpdate: install,
  };
  window.electronAPI = api as NonNullable<Window["electronAPI"]>;
  const failure = Promise.reject(new Error("IPC unavailable"));
  void failure.catch(() => {});
  install.mockReturnValueOnce(failure);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const view = render(<CustomTitleBar />);
  try {
    act(() => downloaded());
    const button = screen.getByRole("button", { name: "updateRestart" });
    await act(async () => { fireEvent.click(button); await failure.catch(() => {}); });
    expect(warning).toHaveBeenCalledExactlyOnceWith("[updater] Install request failed");
    expect(screen.getByRole("button", { name: "updateRestart" })).toBe(button);
    await act(async () => { fireEvent.click(button); });
    expect(install).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); }
});
