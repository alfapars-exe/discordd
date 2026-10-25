import { beforeEach, describe, expect, it } from "vitest";
import { DEVELOPER_MODE_STORAGE_KEY, useDeveloperSettingsStore } from "./developerSettingsStore";

describe("developerSettingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useDeveloperSettingsStore.setState({ developerMode: false });
  });

  it("persists the developer-mode choice on this device", () => {
    useDeveloperSettingsStore.getState().setDeveloperMode(true);
    expect(useDeveloperSettingsStore.getState().developerMode).toBe(true);
    expect(localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY)).toBe("1");

    useDeveloperSettingsStore.getState().setDeveloperMode(false);
    expect(localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY)).toBe("0");
  });
});
