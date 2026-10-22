/** ProfilePreviewCard — live preview of the viewer's profile card in
 *  Settings → Profile. Draws the same hero / name / about pieces as the
 *  MemberCard from the form's draft values (including not-yet-saved
 *  avatar / banner object URLs). Inline — no portal, no backdrop. */

import { useTranslation } from "react-i18next";
import ProfileHero from "../members/memberCard/ProfileHero";
import ProfileAbout from "../members/memberCard/ProfileAbout";

type Props = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  animatedUrl: string | null;
  bannerUrl: string | null;
  accentColor: string;
  bio: string;
  pronouns: string;
  customStatus: string;
};

function ProfilePreviewCard({
  username,
  displayName,
  avatarUrl,
  animatedUrl,
  bannerUrl,
  accentColor,
  bio,
  pronouns,
  customStatus,
}: Props) {
  const { t } = useTranslation("settings");
  const name = displayName.trim() || username;

  return (
    <div className="profile-preview">
      <span className="settings-label">{t("profilePreview")}</span>
      <div className="profile-preview-card" data-testid="profile-preview-card">
        <ProfileHero
          name={name}
          avatarUrl={avatarUrl}
          animatedUrl={animatedUrl}
          bannerUrl={bannerUrl}
          accentColor={accentColor || null}
          animate
        />
        <div className="mc-body">
          <div className="mc-identity">
            <div className="mc-name">{name}</div>
            {displayName.trim() && <div className="mc-username">@{username}</div>}
            {customStatus && <div className="mc-custom-status">{customStatus}</div>}
          </div>
          <ProfileAbout bio={bio.trim() || null} pronouns={pronouns.trim() || null} />
        </div>
      </div>
    </div>
  );
}

export default ProfilePreviewCard;
