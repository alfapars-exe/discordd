import { describe, expect, it } from "vitest";
import { hasPermission, Permissions, resolveChannelPermissions } from "./permissions";

describe("Manage Events permission bit", () => {
  it("uses the next unused bit and is not implicitly granted to ordinary permissions", () => {
    expect(Permissions.ManageEvents).toBe(1 << 23);
    expect(hasPermission(0, Permissions.ManageEvents)).toBe(false);
    expect(hasPermission(Permissions.ManageEvents, Permissions.ManageEvents)).toBe(true);
    expect(hasPermission(Permissions.ManageChannels, Permissions.ManageEvents)).toBe(false);
  });

  it("keeps Admin's all-permissions bypass aligned with the expanded backend mask", () => {
    expect(resolveChannelPermissions(Permissions.Admin, [], [])).toBe((1 << 24) - 1);
    expect(hasPermission(resolveChannelPermissions(Permissions.Admin, [], []), Permissions.ManageEvents)).toBe(true);
  });
});
