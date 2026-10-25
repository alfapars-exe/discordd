import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

import GeneralSettings from "./GeneralSettings";
import { useToastStore } from "../../stores/toastStore";

const getAppSettings = vi.fn();
const setAppSetting = vi.fn();
const getSystemCaptureStatus = vi.fn();
const startSystemCaptureDiagnostic = vi.fn();
const stopSystemCaptureDiagnostic = vi.fn();

beforeEach(() => {
  getAppSettings.mockReset();
  setAppSetting.mockReset();
  getSystemCaptureStatus.mockReset().mockResolvedValue({ state: "stopped" });
  startSystemCaptureDiagnostic.mockReset().mockResolvedValue("diagnostic-token");
  stopSystemCaptureDiagnostic.mockReset().mockResolvedValue(true);
  getAppSettings.mockResolvedValue({
    openAtLogin: false,
    startMinimized: false,
    closeToTray: true,
    transparentBackground: false,
    hardwareAcceleration: true,
  });
  setAppSetting.mockResolvedValue(undefined);
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { getAppSettings, setAppSetting, getSystemCaptureStatus, startSystemCaptureDiagnostic, stopSystemCaptureDiagnostic },
  });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("GeneralSettings", () => {
  it("persists hardware acceleration and explains that restart is required", async () => {
    render(<GeneralSettings />);
    const toggle = await screen.findByRole("switch", { name: "hardwareAcceleration" });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(setAppSetting).toHaveBeenCalledWith("hardwareAcceleration", false);
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe("restartRequired");
    });
  });

  it("rolls the visible setting back when desktop persistence fails", async () => {
    setAppSetting.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<GeneralSettings />);
    const toggle = await screen.findByRole("switch", { name: "openAtLogin" });

    fireEvent.click(toggle);
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.type).toBe("error"));
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("shows retry instead of rendering default toggles when settings cannot be loaded", async () => {
    getAppSettings.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<GeneralSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("desktopSettingsLoadError");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "desktopSettingsRetry" }));
    await screen.findByRole("switch", { name: "openAtLogin" });
    expect(getAppSettings).toHaveBeenCalledTimes(2);
  });

  it("ignores settings that resolve after the settings view unmounts", async () => {
    let resolveSettings: ((value: unknown) => void) | undefined;
    getAppSettings.mockImplementationOnce(() => new Promise((resolve) => { resolveSettings = resolve; }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<GeneralSettings />);
    view.unmount();
    await act(async () => {
      resolveSettings?.({ openAtLogin: true, startMinimized: false, closeToTray: true, hardwareAcceleration: true });
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reads helper status without starting capture when settings opens", async () => {
    render(<GeneralSettings />);
    await screen.findByRole("button", { name: "systemCaptureStart" });
    expect(getSystemCaptureStatus).toHaveBeenCalled();
    expect(startSystemCaptureDiagnostic).not.toHaveBeenCalled();
  });

  it("starts an opt-in diagnostic capture and stops only its returned owner token on unmount", async () => {
    getSystemCaptureStatus.mockResolvedValueOnce({ state: "stopped" }).mockResolvedValueOnce({ state: "running", owner: "diagnostic" });
    const view = render(<GeneralSettings />);
    const start = await screen.findByRole("button", { name: "systemCaptureStart" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByRole("button", { name: "systemCaptureStop" })).toBeInTheDocument());
    expect(startSystemCaptureDiagnostic).toHaveBeenCalledOnce();
    view.unmount();
    expect(stopSystemCaptureDiagnostic).toHaveBeenCalledWith("diagnostic-token");
  });

  it("does not offer diagnostic capture while screen-share capture owns the helper", async () => {
    getSystemCaptureStatus.mockResolvedValue({ state: "running", owner: "screen_share" });
    render(<GeneralSettings />);
    const start = await screen.findByRole("button", { name: "systemCaptureStart" });
    expect(start).toBeDisabled();
    expect(startSystemCaptureDiagnostic).not.toHaveBeenCalled();
  });

  it("stops a diagnostic run if its start completes after the settings view unmounts", async () => {
    let finishStart: ((token: string) => void) | undefined;
    startSystemCaptureDiagnostic.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const view = render(<GeneralSettings />);
    const start = await screen.findByRole("button", { name: "systemCaptureStart" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(startSystemCaptureDiagnostic).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => { finishStart!("late-diagnostic-token"); });
    await waitFor(() => expect(stopSystemCaptureDiagnostic).toHaveBeenCalledWith("late-diagnostic-token"));
  });

  it("does not let an older status poll overwrite a completed start", async () => {
    vi.useFakeTimers();
    getSystemCaptureStatus.mockResolvedValueOnce({ state: "stopped" });
    let resolveOldPoll: ((value: { state: "stopped" }) => void) | undefined;
    const view = render(<GeneralSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); await Promise.resolve(); });
    getSystemCaptureStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOldPoll = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    getSystemCaptureStatus.mockResolvedValueOnce({ state: "running", owner: "diagnostic" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "systemCaptureStart" }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "systemCaptureStop" })).toBeInTheDocument();
    await act(async () => { resolveOldPoll?.({ state: "stopped" }); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "systemCaptureStop" })).toBeInTheDocument();
    view.unmount();
  });
});
