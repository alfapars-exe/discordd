/**
 * Invite types — server invite code records.
 */

export type Invite = {
  code: string;
  created_by: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
  creator_username: string;
  creator_display_name: string | null;
};
