/**
 * Auth API request/response shapes.
 */

import type { User } from "./user";

export type LoginRequest = {
  username: string;
  password: string;
};

export type RegisterRequest = {
  username: string;
  password: string;
  display_name?: string;
  email?: string;
};

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  user: User;
};
