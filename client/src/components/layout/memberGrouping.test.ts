import { describe, it, expect } from "vitest";
import type { MemberWithRoles, Role } from "../../types";
import { getHighestRole, groupByHighestRole, partitionMembers } from "./memberGrouping";

// Characterizes the member-list grouping/sorting logic (the Faz 6 perf
// target). Locks the current behaviour so the upcoming memoization/
// virtualization work cannot silently change who appears where or in what
// order.

function role(id: string, position: number): Role {
  return { id, position, name: id.toUpperCase() } as unknown as Role;
}

function member(id: string, opts: { name?: string; roles?: Role[] } = {}): MemberWithRoles {
  return {
    id,
    username: opts.name ?? id,
    display_name: opts.name ?? id,
    roles: opts.roles ?? [],
  } as unknown as MemberWithRoles;
}

describe("getHighestRole", () => {
  it("returns null when the member has no roles", () => {
    expect(getHighestRole(member("u1"))).toBeNull();
  });

  it("returns the highest-position role", () => {
    const admin = role("admin", 10);
    const mod = role("mod", 5);
    const got = getHighestRole(member("u1", { roles: [mod, admin] }));
    expect(got?.id).toBe("admin");
  });
});

describe("groupByHighestRole", () => {
  const admin = role("admin", 10);
  const mod = role("mod", 5);

  it("groups members by their highest role", () => {
    const groups = groupByHighestRole([
      member("a", { roles: [admin] }),
      member("b", { roles: [mod] }),
      member("c", { roles: [admin, mod] }), // highest = admin
    ]);
    const byRole = Object.fromEntries(groups.map((g) => [g.role.id, g.members.map((m) => m.id)]));
    expect(byRole.admin.sort()).toEqual(["a", "c"]);
    expect(byRole.mod).toEqual(["b"]);
  });

  it("sorts groups by role position DESC", () => {
    const groups = groupByHighestRole([
      member("b", { roles: [mod] }),
      member("a", { roles: [admin] }),
    ]);
    expect(groups.map((g) => g.role.id)).toEqual(["admin", "mod"]);
  });

  it("sorts members within a group by display name", () => {
    const groups = groupByHighestRole([
      member("z", { name: "Zed", roles: [admin] }),
      member("a", { name: "Ann", roles: [admin] }),
      member("m", { name: "Max", roles: [admin] }),
    ]);
    expect(groups[0].members.map((m) => m.username)).toEqual(["Ann", "Max", "Zed"]);
  });

  it("excludes members with no roles", () => {
    const groups = groupByHighestRole([
      member("a", { roles: [admin] }),
      member("norole"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("partitionMembers", () => {
  const admin = role("admin", 10);

  it("splits online vs offline by the presence set", () => {
    const members = [
      member("on1", { roles: [admin] }),
      member("on2"),
      member("off1"),
    ];
    const online = new Set(["on1", "on2"]);
    const p = partitionMembers(members, online);

    expect(p.onlineGroups.flatMap((g) => g.members.map((m) => m.id))).toEqual(["on1"]);
    expect(p.ungroupedOnline.map((m) => m.id)).toEqual(["on2"]);
    expect(p.sortedOffline.map((m) => m.id)).toEqual(["off1"]);
  });

  it("sorts offline members by name and never groups them", () => {
    const members = [
      member("x", { name: "Xavier" }),
      member("a", { name: "Aaron", roles: [admin] }), // roles ignored while offline
    ];
    const p = partitionMembers(members, new Set()); // everyone offline
    expect(p.onlineGroups).toHaveLength(0);
    expect(p.sortedOffline.map((m) => m.username)).toEqual(["Aaron", "Xavier"]);
  });

  it("puts a roleless online member in ungroupedOnline, not a group", () => {
    const p = partitionMembers([member("solo")], new Set(["solo"]));
    expect(p.onlineGroups).toHaveLength(0);
    expect(p.ungroupedOnline.map((m) => m.id)).toEqual(["solo"]);
  });
});
