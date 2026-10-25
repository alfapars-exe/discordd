import { useContext } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsTab } from "../../stores/settingsStore";
import { SettingsWorkspaceContext } from "./settingsWorkspaceContext";

const links: Partial<Record<SettingsTab, { tab: SettingsTab; title: string; description: string }[]>> = {
  "registered-games": [{ tab: "activity-privacy", title: "activityPrivacyTitle", description: "activityPrivacyMasterHint" }],
  "activity-privacy": [{ tab: "registered-games", title: "registeredGamesTitle", description: "activityPrivacyLocalNotice" }],
  profile: [{ tab: "appearance", title: "appearance", description: "workspace.appearanceDescription" }],
  appearance: [{ tab: "accessibility", title: "accessibility", description: "workspace.accessibilityDescription" }],
  accessibility: [
    { tab: "appearance", title: "appearance", description: "workspace.appearanceDescription" },
    { tab: "voice", title: "voiceSettings", description: "workspace.voiceDescription" },
  ],
  voice: [{ tab: "accessibility", title: "accessibility", description: "workspace.accessibilityDescription" }],
  entrance: [{ tab: "voice", title: "voiceSettings", description: "workspace.voiceDescription" }],
  security: [{ tab: "encryption", title: "encryption", description: "workspace.encryptionDescription" }],
  encryption: [{ tab: "security", title: "security", description: "workspace.securityDescription" }],
};

export default function RelatedSettings({ tab, allowedTabs }: { tab: SettingsTab; allowedTabs: SettingsTab[] }) {
  const workspace = useContext(SettingsWorkspaceContext);
  const { t } = useTranslation("settings");
  const destinations = links[tab]?.filter((link) => allowedTabs.includes(link.tab)) ?? [];
  if (!workspace || !destinations.length) return null;
  return <section className="settings-related" aria-label={t("workspace.related")}>
    <h3>{t("workspace.related")}</h3>
    {destinations.map((link) => <button key={link.tab} className="settings-related-card" onClick={() => workspace.navigate(link.tab)}>
      <span><strong>{t(link.title)}</strong><span>{t(link.description)}</span></span><span aria-hidden="true">›</span>
    </button>)}
  </section>;
}
