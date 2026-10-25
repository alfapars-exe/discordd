import { describe, expect, it } from "vitest";
import { isUiShellV2Enabled } from "./uiShell";

describe("UI shell rollout default", () => {
  it("defaults to the single-destination shell unless rollback is explicit", () => {
    expect(isUiShellV2Enabled(undefined)).toBe(true);
    expect(isUiShellV2Enabled("")).toBe(true);
    expect(isUiShellV2Enabled("true")).toBe(true);
    expect(isUiShellV2Enabled("false")).toBe(false);
  });
});
