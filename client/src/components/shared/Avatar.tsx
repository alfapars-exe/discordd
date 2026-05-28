/** Avatar — Role-based gradient avatar with image or initial fallback. */

import { resolveAssetUrl } from "../../utils/constants";

type AvatarProps = {
  name: string;
  role?: "admin" | "mod" | null;
  avatarUrl?: string | null;
  size?: number;
  isCircle?: boolean;
  /** True when the consumer renders the name next to the avatar. Lighthouse
   * audit (Mayıs 28 2026) flagged `alt={name}` as "redundant alt text" in the
   * member list and user bar — screen readers read the name twice. Default
   * true matches the common case (lists, headers, user bar). Set false for
   * standalone avatars where the alt is the only label. */
  hasAdjacentLabel?: boolean;
};

function getGradientClass(role?: "admin" | "mod" | null): string {
  switch (role) {
    case "admin":
      return "av-admin";
    case "mod":
      return "av-mod";
    default:
      return "av-default";
  }
}

function Avatar({ name, role, avatarUrl, size = 30, isCircle = true, hasAdjacentLabel = true }: AvatarProps) {
  const roundClass = isCircle ? "avatar avatar-round" : "avatar";
  const fontSize = size * 0.37;

  if (avatarUrl) {
    return (
      <img
        src={resolveAssetUrl(avatarUrl)}
        alt={hasAdjacentLabel ? "" : name}
        // role="presentation" reinforces empty alt for older assistive tech
        // when the adjacent label is the canonical announcement.
        {...(hasAdjacentLabel ? { role: "presentation" } : {})}
        className={roundClass}
        style={{ width: size, height: size, objectFit: "cover" }}
      />
    );
  }

  return (
    <div
      className={`${roundClass} ${getGradientClass(role)}`}
      style={{ width: size, height: size, fontSize }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default Avatar;
