/** Full-screen settings overlay. Layout: left SettingsNav + right content area. */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import SettingsNav from "./SettingsNav";
import RoleSettings from "./RoleSettings";
import ProfileSettings from "./ProfileSettings";
import AppearanceSettings from "./AppearanceSettings";
import ServerGeneralSettings from "./ServerGeneralSettings";
import InviteSettings from "./InviteSettings";
import VoiceSettings from "./VoiceSettings";
import ChannelSettings from "./ChannelSettings";
import MembersSettings from "./MembersSettings";
import SecuritySettings from "./SecuritySettings";
import PlatformSettings from "./PlatformSettings";
import LiveKitQuotaPanel from "./LiveKitQuotaPanel";
import AdminServerList from "./AdminServerList";
import AdminUserList from "./AdminUserList";
import AdminReportList from "./AdminReportList";
import AdminLogsPanel from "./AdminLogsPanel";
import ConnectionsSettings from "./ConnectionsSettings";
import EncryptionSettings from "./EncryptionSettings";
import GeneralSettings from "./GeneralSettings";
import FeedbackSettings from "./FeedbackSettings";
import BlockedUsersSettings from "./BlockedUsersSettings";
import AdminFeedbackList from "./AdminFeedbackList";
import { useAuthStore } from "../../stores/authStore";

function SettingsModal() {
  const { t } = useTranslation("settings");
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeSettings();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeSettings]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      closeSettings();
    }
  }

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      {/* Nav sidebar */}
      <SettingsNav />

      {/* Content area */}
      <div className="settings-content">
        <SettingsContent activeTab={activeTab} />
      </div>

      {/* Close button */}
      <button
        onClick={closeSettings}
        className="settings-close"
        title={t("title") + " — ESC"}
      >
        ✕
      </button>
    </div>
  );
}

/** Renders the active tab's component. */
function SettingsContent({ activeTab }: { activeTab: string }) {
  // Platform admins see the full feedback inbox (everyone's tickets) on the
  // user-settings "Geri Bildirim" tab — they can also create their own from
  // there. The platform-feedback tab is removed since it would duplicate.
  const isPlatformAdmin = useAuthStore((s) => s.user?.is_platform_admin ?? false);

  switch (activeTab) {
    case "profile":
      return <ProfileSettings />;

    case "roles":
      return <RoleSettings />;

    case "server-general":
      return <ServerGeneralSettings />;

    case "invites":
      return <InviteSettings />;

    case "voice":
      return <VoiceSettings />;

    case "channels":
      return <ChannelSettings />;

    case "appearance":
      return <AppearanceSettings />;

    case "general":
      return <GeneralSettings />;

    case "members":
      return <MembersSettings />;

    case "security":
      return <SecuritySettings />;

    case "encryption":
      return <EncryptionSettings />;

    case "feedback":
      return isPlatformAdmin ? <AdminFeedbackList /> : <FeedbackSettings />;

    case "blocked-users":
      return <BlockedUsersSettings />;

    case "platform":
      return <PlatformSettings />;

    case "platform-quota":
      return <LiveKitQuotaPanel />;

    case "platform-servers":
      return <AdminServerList />;

    case "platform-users":
      return <AdminUserList />;

    case "platform-reports":
      return <AdminReportList />;

    case "platform-logs":
      return <AdminLogsPanel />;

    case "platform-feedback":
      return <AdminFeedbackList />;

    case "platform-connections":
      return <ConnectionsSettings />;

    default:
      return null;
  }
}

export default SettingsModal;
