/** ProfileAbout — pronouns line + "About me" block of the profile card.
 *  Both values are user-written text: rendered as plain React text nodes
 *  only (no HTML, no linkify). Renders nothing when both are empty. */

import { useTranslation } from "react-i18next";

type Props = {
  bio?: string | null;
  pronouns?: string | null;
};

function ProfileAbout({ bio, pronouns }: Props) {
  const { t } = useTranslation("settings");
  if (!bio && !pronouns) return null;

  return (
    <>
      {pronouns && <div className="mc-pronouns">{pronouns}</div>}
      {bio && (
        <div className="mc-about">
          <div className="mc-about-title">{t("profileAboutMe")}</div>
          <div className="mc-about-text">{bio}</div>
        </div>
      )}
    </>
  );
}

export default ProfileAbout;
