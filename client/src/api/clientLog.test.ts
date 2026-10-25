import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiClient: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock("./client", () => ({ apiClient: mocks.apiClient }));
vi.mock("../utils/constants", () => ({ isElectron: () => false, isCapacitor: () => false }));

import { logOptionalTelemetry } from "./clientLog";
import { usePreferencesStore } from "../stores/preferencesStore";

describe("optional improvement telemetry consent", () => {
  beforeEach(() => {
    mocks.apiClient.mockClear();
    usePreferencesStore.setState({ data: {}, isLoaded: true, accountId: "account-a" });
  });

  it("emits nothing when consent is absent or disabled", async () => {
    await logOptionalTelemetry("screen_share_stats", { fps: 30 });
    usePreferencesStore.setState({ data: { privacy: { improvementTelemetry: false } } });
    await logOptionalTelemetry("screen_share_stats", { fps: 30 });
    expect(mocks.apiClient).not.toHaveBeenCalled();
  });

  it("emits a classified event after explicit opt-in", async () => {
    usePreferencesStore.setState({ data: { privacy: { improvementTelemetry: true } } });
    await logOptionalTelemetry("screen_share_stats", { fps: 30 });
    expect(mocks.apiClient).toHaveBeenCalledWith("/client-log", expect.objectContaining({
      method: "POST",
      body: expect.objectContaining({
        message: "screen_share_stats",
        metadata: expect.objectContaining({ fps: "30", telemetryClass: "optional-improvement" }),
      }),
    }));
  });
});
