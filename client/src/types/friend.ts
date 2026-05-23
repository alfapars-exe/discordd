/**
 * Friendship + friend-request types.
 */

import type { UserStatus } from "./user";

/**
 * Friendship record with the other user's info.
 * status: "pending" | "accepted" | "blocked"
 */
export type FriendshipWithUser = {
  id: string;
  status: "pending" | "accepted" | "blocked";
  created_at: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  user_status: UserStatus;
  user_custom_status: string | null;
};

export type FriendRequestsResponse = {
  incoming: FriendshipWithUser[];
  outgoing: FriendshipWithUser[];
};
