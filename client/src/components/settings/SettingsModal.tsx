/** Full-screen settings overlay. Layout: left SettingsNav + right content area. */

import { useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
// SettingsNav stays eager — it's the always-visible left rail.
import SettingsNav from "./SettingsNav";

// Lazy-load each settings panel. The settings modal is rarely opened
// and users typically visit a single tab per session, so loading
// every panel up-front (the 21 panels here total ~4-5k lines of
// admin-heavy code, the biggest being AdminUserList 681 / AdminReportList
// 677 / VoiceSettings 633) is pure waste. With lazy + Suspense, only
// the active tab's chunk arrives — usually <50 KB each.
const RoleSettings = lazy(() => import("./RoleSettings"));
const ProfileSettings = lazy(() => import("./ProfileSettings"));
const AppearanceSettings = lazy(() => import("./AppearanceSettings"));
const AccessibilitySettings = lazy(() => import("./AccessibilitySettings"));
const ServerGeneralSettings = lazy(() => import("./ServerGeneralSettings"));
const InviteSettings = lazy(() => import("./InviteSettings"));
const VoiceSettings = lazy(() => import("./VoiceSettings"));
const ChannelSettings = lazy(() => import("./ChannelSettings"));
const MembersSettings = lazy(() => import("./MembersSettings"));
const SecuritySettings = lazy(() => import("./SecuritySettings"));
const PlatformSettings = lazy(() => import("./PlatformSettings"));
const LiveKitQuotaPanel = lazy(() => import("./LiveKitQuotaPanel"));
const AdminServerList = lazy(() => import("./AdminServerList"));
const AdminUserList = lazy(() => import("./AdminUserList"));
const AdminReportList = lazy(() => import("./AdminReportList"));
const AdminLogsPanel = lazy(() => import("./AdminLogsPanel"));
const ConnectionsSettings = lazy(() => import("./ConnectionsSettings"));
const EncryptionSettings = lazy(() => import("./EncryptionSettings"));
const GeneralSettings = lazy(() => import("./GeneralSettings"));
const FeedbackSettings = lazy(() => import("./FeedbackSettings"));
const BlockedUsersSettings = lazy(() => import("./BlockedUsersSettings"));
const AdminFeedbackList = lazy(() => import("./AdminFeedbackList"));

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

      {/* Content + close wrapper — close button is anchored to the content
          panel (not the viewport) so it doesn't overlap with members panel
          on wide screens. The wrap is position:relative so the absolute
          close stays pinned to its top-right corner. */}
      <div className="settings-content-wrap">
        <button
          onClick={closeSettings}
          className="settings-close"
          title={t("title") + " — ESC"}
        >
          ✕
        </button>
        <div className="settings-content">
          <Suspense fallback={<SettingsPanelFallback />}>
            <SettingsContent activeTab={activeTab} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** Compact spinner shown while a settings panel chunk downloads. */
function SettingsPanelFallback() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 200 }}>
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-surface border-t-brand" />
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

    case "accessibility":
      return <AccessibilitySettings />;

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
