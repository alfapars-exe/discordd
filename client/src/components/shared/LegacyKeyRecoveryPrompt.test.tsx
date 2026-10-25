import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LegacyKeyRecoveryPrompt from "./LegacyKeyRecoveryPrompt";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../../api/authSessionEvents";

const fixture = vi.hoisted(() => ({
  initStatus: "legacy-recovery" as string,
  archive: { status: "eligible", deviceId: "device-1", identityFingerprint: "public-fingerprint" } as { status: string; deviceId?: string; identityFingerprint?: string },
  resolve: vi.fn(async (_choice: "import" | "fresh") => true),
  initialize: vi.fn(async (_userId: string) => {}),
  addToast: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => key === "legacyRecoveryFingerprint" ? `${key}:${values?.fingerprint}` : key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "user-1" } }) }));
vi.mock("../../stores/e2eeStore", () => ({
  useE2EEStore: (selector: (state: unknown) => unknown) => selector({
    initStatus: fixture.initStatus,
    legacyArchive: fixture.archive,
    initialize: fixture.initialize,
    resolveLegacyArchive: fixture.resolve,
  }),
}));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (selector: (state: unknown) => unknown) => selector({ addToast: fixture.addToast }) }));

describe("LegacyKeyRecoveryPrompt", () => {
  beforeEach(() => {
    publishAuthOwnerChange("user-1");
    publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    fixture.initStatus = "legacy-recovery";
    fixture.archive = { status: "eligible", deviceId: "device-1", identityFingerprint: "public-fingerprint" };
    fixture.resolve.mockReset().mockResolvedValue(true);
    fixture.initialize.mockReset().mockResolvedValue(undefined);
    fixture.addToast.mockClear();
  });

  afterEach(() => {
    publishAuthOwnerChange(null);
    publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  });

  it("requires explicit acknowledgement before importing and cannot be dismissed", () => {
    render(<LegacyKeyRecoveryPrompt />);
    expect(screen.getByText("legacyRecoveryFingerprint:public-fingerprint")).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: "legacyRecoveryImport" });
    expect(importButton).toBeDisabled();
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    expect(importButton).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("legacy-key-recovery-backdrop"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("imports only after acknowledgement and reports the store result", async () => {
    render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryImport" })); });
    expect(fixture.resolve).toHaveBeenCalledWith("import");
    expect(fixture.addToast).toHaveBeenCalledWith("success", "legacyRecoverySuccessImport");
  });

  it("keeps the blocking prompt open and reports a rejected store resolution", async () => {
    fixture.resolve.mockResolvedValue(false);
    render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryImport" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("legacyRecoveryImportFailed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fixture.addToast).not.toHaveBeenCalled();
  });

  it.each([true, false])("ignores a late %s resolution after unmount", async (result) => {
    let finish!: (value: boolean) => void;
    fixture.resolve.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const view = render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryImport" }));
    await act(async () => {
      view.unmount();
      finish(result);
      await Promise.resolve();
    });
    expect(fixture.addToast).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([true, false])("ignores a late %s resolution after the account changes", async (result) => {
    let finish!: (value: boolean) => void;
    fixture.resolve.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryImport" }));
    await act(async () => {
      publishAuthOwnerChange("user-2");
      publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
      finish(result);
      await Promise.resolve();
    });
    expect(fixture.addToast).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("resets archive ownership acknowledgement when the eligible fingerprint changes", () => {
    const view = render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByText("legacyRecoveryOwnershipAck"));
    expect(screen.getByRole("button", { name: "legacyRecoveryImport" })).toBeEnabled();
    fixture.archive = { status: "eligible", deviceId: "device-1", identityFingerprint: "new-public-fingerprint" };
    view.rerender(<LegacyKeyRecoveryPrompt />);
    expect(screen.getByRole("button", { name: "legacyRecoveryImport" })).toBeDisabled();
  });

  it("requires a second confirmation before choosing fresh keys", async () => {
    render(<LegacyKeyRecoveryPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryFresh" }));
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(screen.getByText("legacyRecoveryFreshWarning")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryFreshConfirm" })); });
    expect(fixture.resolve).toHaveBeenCalledWith("fresh");
    expect(fixture.addToast).toHaveBeenCalledWith("success", "legacyRecoverySuccessFresh");
  });

  it("disables import for unverified archives and allows a store-driven retry", async () => {
    fixture.archive = { status: "unverified" };
    render(<LegacyKeyRecoveryPrompt />);
    expect(screen.queryByRole("button", { name: "legacyRecoveryImport" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "legacyRecoveryRetry" })); });
    expect(fixture.initialize).toHaveBeenCalledWith("user-1");
  });

  it("renders nothing outside the explicit recovery state", () => {
    fixture.initStatus = "ready";
    const { container } = render(<LegacyKeyRecoveryPrompt />);
    expect(container).toBeEmptyDOMElement();
  });
});
