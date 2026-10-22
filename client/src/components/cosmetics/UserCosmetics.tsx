/**
 * Per-user cosmetic wrappers for list rows rendered inside a `.map()` (where
 * the row itself cannot call hooks), e.g. the sidebar DM list (Faz G).
 * Each one reads the user's slots for `scope` (null = global) itself.
 */

import type { ComponentProps } from "react";
import DecoratedAvatar from "./DecoratedAvatar";
import Nameplate from "./Nameplate";
import { useUserCosmetics } from "../../hooks/useUserCosmetics";

type AvatarProps = Omit<ComponentProps<typeof DecoratedAvatar>, "frame"> & {
  userId: string;
  scope: string | null;
};

export function UserDecoratedAvatar({ userId, scope, ...rest }: AvatarProps) {
  const slots = useUserCosmetics(userId, scope);
  return <DecoratedAvatar {...rest} frame={slots.avatar_frame} />;
}

export function UserNameplate({ userId, scope }: { userId: string; scope: string | null }) {
  const slots = useUserCosmetics(userId, scope);
  return <Nameplate nameplate={slots.nameplate} />;
}
