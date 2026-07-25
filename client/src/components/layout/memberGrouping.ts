/**
 * Pure member-list partitioning: split into online/offline, group online by
 * highest role, sort. Extracted from MemberList so the derived-state logic is
 * unit-testable without a full store/render harness (and memoizable — every
 * `presence_update` currently recomputes all of this on render).
 *
 * Behaviour is intentionally identical to the previous inline implementation;
 * memberGrouping.test.ts pins it.
 */

import type { MemberWithRoles, Role } from "../../types";

/** Members sharing the same highest role. */
export type RoleGroup = {
  role: Role;
  members: MemberWithRoles[];
};

/** Result of partitioning a server's member list for display. */
export type MemberPartition = {
  /** Online members grouped by highest role, groups sorted by position DESC. */
  onlineGroups: RoleGroup[];
  /** Online members with no roles at all. */
  ungroupedOnline: MemberWithRoles[];
  /** Offline members, sorted by display name / username. */
  sortedOffline: MemberWithRoles[];
};

/** Returns the member's highest-position role (used for grouping). */
export function getHighestRole(member: MemberWithRoles): Role | null {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

function byName(a: MemberWithRoles, b: MemberWithRoles): number {
  const nameA = a.display_name ?? a.username ?? "";
  const nameB = b.display_name ?? b.username ?? "";
  return nameA.localeCompare(nameB);
}

/** Groups members by highest role, sorted by role position DESC. */
export function groupByHighestRole(members: MemberWithRoles[]): RoleGroup[] {
  const groups = new Map<string, RoleGroup>();

  for (const member of members) {
    const highest = getHighestRole(member);
    if (!highest) continue;

    const existing = groups.get(highest.id);
    if (existing) {
      existing.members.push(member);
    } else {
      groups.set(highest.id, { role: highest, members: [member] });
    }
  }

  // Sort groups by position DESC, members within each group by name.
  const result = Array.from(groups.values()).sort(
    (a, b) => b.role.position - a.role.position
  );
  for (const group of result) {
    group.members.sort(byName);
  }
  return result;
}

/**
 * partitionMembers splits the list by presence and prepares the three display
 * buckets in one pass-ish. onlineUserIds is the presence set from the store.
 */
export function partitionMembers(
  members: MemberWithRoles[],
  onlineUserIds: Set<string>
): MemberPartition {
  const onlineMembers = members.filter((m) => onlineUserIds.has(m.id));
  const offlineMembers = members.filter((m) => !onlineUserIds.has(m.id));

  return {
    onlineGroups: groupByHighestRole(onlineMembers),
    ungroupedOnline: onlineMembers.filter((m) => m.roles.length === 0),
    sortedOffline: [...offlineMembers].sort(byName),
  };
}
