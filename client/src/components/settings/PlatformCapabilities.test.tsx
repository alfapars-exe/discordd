import { render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformCapabilities from "./PlatformCapabilities";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../utils/constants", () => ({ isElectron: () => !!window.electronAPI }));
afterEach(() => vi.unstubAllGlobals());
describe("device capability explanations", () => {
  it("reports unavailable web/native controls without opening device or notification prompts", () => {
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn();
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
    render(<PlatformCapabilities />);
    expect(screen.getByText("capabilities.webIntro")).toBeInTheDocument();
    for (const key of ["startup", "tray", "globalShortcuts", "systemHelper"]) {
      expect(within(screen.getByText(`capabilities.${key}`).parentElement!).getByText("capabilities.unavailable")).toBeInTheDocument();
    }
    expect(screen.getByText("capabilities.notificationsDenied")).toBeInTheDocument();
    expect(screen.getByText("capabilities.conditional")).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("checks actual helper availability without starting a diagnostic or capture", async () => {
    const getSystemCaptureStatus = vi.fn().mockResolvedValue({state:"unavailable",reason:"helper_missing"});
    const startSystemCaptureDiagnostic = vi.fn();
    const startSystemCapture = vi.fn();
    vi.stubGlobal("electronAPI", {getSystemCaptureStatus,startSystemCaptureDiagnostic,startSystemCapture});
    render(<PlatformCapabilities />);
    const row=screen.getByText("capabilities.systemHelper").parentElement!;
    await waitFor(()=>expect(within(row).getByText("capabilities.unavailable")).toBeInTheDocument());
    expect(getSystemCaptureStatus).toHaveBeenCalledOnce();
    expect(startSystemCaptureDiagnostic).not.toHaveBeenCalled();
    expect(startSystemCapture).not.toHaveBeenCalled();
  });
});
