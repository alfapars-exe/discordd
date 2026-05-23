/**
 * Role + member + badge types — server-scoped identity-adjacent.
 */

import type { UserStatus } from "./user";

export type Role = {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: number;
  is_default: boolean;
  is_owner: boolean;
  mentionable: boolean;
};

/** Member info with roles and computed effective_permissions. */
export type MemberWithRoles = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  custom_status: string | null;
  created_at: string;
  roles: Role[];
  effective_permissions: number;
};

/** Badge template created by the badge admin. */
export type Badge = {
  id: string;
  name: string;
  icon: string;
  icon_type: "builtin" | "custom";
  color1: string;
  color2: string | null;
  created_by: string;
  created_at: string;
};

/** A badge assigned to a specific user. */
export type UserBadge = {
  id: string;
  user_id: string;
  badge_id: string;
  assigned_by: string;
  assigned_at: string;
  badge?: Badge;
};

export type Ban = {
  user_id: string;
  username: string;
  reason: string;
  banned_by: string;
  created_at: string;
};
