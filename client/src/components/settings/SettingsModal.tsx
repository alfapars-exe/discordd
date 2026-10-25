/** Full-screen settings overlay. Layout: left SettingsNav + right content area. */

import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useActiveMembers } from "../../stores/memberStore";
import { isElectron, SERVER_URL } from "../../utils/constants";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { getSettingsGroups } from "./settingsNavigation";
// SettingsNav stays eager — it's the always-visible left rail.
import SettingsNav from "./SettingsNav";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";
import PreferencesSyncStatus from "./PreferencesSyncStatus";
import { SettingsWorkspaceContext } from "./settingsWorkspaceContext";
import { useSettingsWorkspace } from "../../hooks/useSettingsWorkspace";
import RelatedSettings from "./RelatedSettings";
import "../../styles/settings-workspace.css";

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
const NotificationSettings = lazy(() => import("./NotificationSettings"));
const ServerGeneralSettings = lazy(() => import("./ServerGeneralSettings"));
const InviteSettings = lazy(() => import("./InviteSettings"));
const VoiceSettings = lazy(() => import("./VoiceSettings"));
const ChannelSettings = lazy(() => import("./ChannelSettings"));
const MembersSettings = lazy(() => import("./MembersSettings"));
const SecuritySettings = lazy(() => import("./SecuritySettings"));
const ApplicationSettings = lazy(() => import("./ApplicationSettings"));
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
const EmailCampaignPanel = lazy(() => import("./EmailCampaignPanel"));
const DiagnosticsSettings = lazy(() => import("./DiagnosticsSettings"));
const EmojiSettings = lazy(() => import("./EmojiSettings"));
const StickerSettings = lazy(() => import("./StickerSettings"));
const EntranceSoundSettings = lazy(() => import("./EntranceSoundSettings"));
const EntranceServerSettings = lazy(() => import("./EntranceServerSettings"));
const CosmeticsSettings = lazy(() => import("./CosmeticsSettings"));
const ServerApplicationSettings = lazy(() => import("./ServerApplicationSettings"));
const DeveloperSettings = lazy(() => import("./DeveloperSettings"));
const RegisteredGamesSettings = lazy(() => import("./RegisteredGamesSettings"));
const ActivityPrivacySettings = lazy(() => import("./ActivityPrivacySettings"));

function SettingsModal() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const context = useSettingsStore((s) => s.context);
  const contextServerId = useSettingsStore((s) => s.contextServerId);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const activeServer = useServerStore((s) => s.activeServer);
  const user = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const permissions = members.find((member) => member.id === user?.id)?.effective_permissions ?? 0;
  const allowedTabs = getSettingsGroups(permissions, user?.is_platform_admin ?? false, isElectron(), UI_SHELL_V2 ? context : undefined)
    .flatMap((group) => group.items.map((item) => item.id));
  const isAllowed = allowedTabs.includes(activeTab) && (!UI_SHELL_V2 || context !== "server" || (!!contextServerId && contextServerId === activeServerId));
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const workspace = useSettingsWorkspace({
    isOpen, activeTab, allowedTabs, setActiveTab, closeSettings,
    scope: JSON.stringify([SERVER_URL, user?.id, context, contextServerId]),
  }, contentRef);
  const requestClose = workspace.close;
  const requestCloseRef = useRef(requestClose);
  useLayoutEffect(() => { requestCloseRef.current = requestClose; }, [requestClose]);

  // Hide the privileged panel synchronously, then close. Never keep a stale
  // editor alive after membership/permissions or its server context change.
  useEffect(() => {
    if (isOpen && !isAllowed) closeSettings();
  }, [isOpen, isAllowed, closeSettings]);

  // The outer dialog owns focus only while a nested dialog/picker is absent.
  // Existing modals listen on document; inspect nested layers in capture so
  // their Escape cannot also close settings later in the same event.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]'
    ) ?? []).filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
    const nestedLayer = () => Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], .modal-backdrop, .emoji-picker, .color-picker-popover'
    )).find((element) => element !== dialog && !element.matches(".mobile-drawer")
      && !element.contains(dialog) && !element.closest('[inert], [aria-hidden="true"]'));
    const frame = requestAnimationFrame(() => (focusable()[0] ?? dialog)?.focus());

    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || nestedLayer()) return;
      if (e.key === "Escape") {
        // Search and other local controls can consume Escape before document.
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (target?.matches('input[type="search"]') && (target as HTMLInputElement).value) return;
        e.preventDefault();
        e.stopPropagation();
        requestCloseRef.current();
      } else if (e.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { e.preventDefault(); dialog?.focus(); return; }
        if (e.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
          e.preventDefault(); first.focus();
        }
      }
    }

    function containFocus(e: FocusEvent) {
      if (!nestedLayer() && !dialog?.contains(e.target as Node)) (focusable()[0] ?? dialog)?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  // Body scroll lock
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      requestClose();
    }
  }

  return (
    <SettingsWorkspaceContext.Provider value={workspace}>
    <div ref={dialogRef} tabIndex={-1} className={`settings-overlay${UI_SHELL_V2 ? " settings-overlay--v2" : ""}`} onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-label={t("title")}>
      {/* Nav sidebar */}
      <SettingsNav />

      {/* Content + close wrapper — close button is anchored to the content
          panel (not the viewport) so it doesn't overlap with members panel
          on wide screens. The wrap is position:relative so the absolute
          close stays pinned to its top-right corner. */}
      <div className="settings-content-wrap">
        <button
          onClick={requestClose}
          className="settings-close"
          aria-label={tCommon("close")}
          title={t("title") + " — ESC"}
        >
          ✕
        </button>
        <div ref={contentRef} className="settings-content">
          {workspace.canGoBack && <button className="settings-workspace-back" onClick={workspace.back}>{t("workspace.back")}</button>}
          {context === "account" && <PreferencesSyncStatus />}
          {UI_SHELL_V2 && <div className="settings-context-heading">
            <span>{context === "server" ? t("serverSettings") : context === "platform" ? t("platformSettings") : t("userSettings")}</span>
            {context === "server" && activeServer?.id === contextServerId && <strong>{activeServer.name}</strong>}
          </div>}
          {/* Boundary covers only the panel content — overlay chrome (close
              button, ESC handler, nav) stays outside so a crashed panel can
              still be closed. */}
          <SectionErrorBoundary section="settings">
            <Suspense fallback={<SettingsPanelFallback />}>
              {isAllowed && <div key={JSON.stringify([user?.id, context, contextServerId, activeTab])} data-settings-panel={activeTab}>
                <SettingsContent activeTab={activeTab} />
                <RelatedSettings tab={activeTab} allowedTabs={allowedTabs} />
              </div>}
            </Suspense>
          </SectionErrorBoundary>
        </div>
      </div>
    </div>
    </SettingsWorkspaceContext.Provider>
  );
}

/** Compact spinner shown while a settings panel chunk downloads. */
function SettingsPanelFallback() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 200 }}>
      <div className="app-loading-spinner" />
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

    case "emojis":
      return <EmojiSettings />;

    case "stickers":
      return <StickerSettings />;

    case "entrance-sounds":
      return <EntranceServerSettings />;

    case "server-applications":
      return <ServerApplicationSettings />;

    case "voice":
      return <VoiceSettings />;

    case "entrance":
      return <EntranceSoundSettings />;

    case "cosmetics":
      return <CosmeticsSettings />;

    case "channels":
      return <ChannelSettings />;

    case "appearance":
      return <AppearanceSettings />;

    case "accessibility":
      return <AccessibilitySettings />;

    case "notifications":
      return <NotificationSettings />;

    case "registered-games":
      return <RegisteredGamesSettings />;

    case "activity-privacy":
      return <ActivityPrivacySettings />;

    case "general":
      return <GeneralSettings />;

    case "members":
      return <MembersSettings />;

    case "security":
      return <SecuritySettings />;

    case "applications":
      return <ApplicationSettings />;

    case "encryption":
      return <EncryptionSettings />;

    case "feedback":
      return isPlatformAdmin ? <AdminFeedbackList /> : <FeedbackSettings />;

    case "blocked-users":
      return <BlockedUsersSettings />;

    case "diagnostics":
      return <DiagnosticsSettings />;

    case "developer":
      return <DeveloperSettings />;

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

    case "platform-campaigns":
      return isPlatformAdmin ? <EmailCampaignPanel /> : null;

    case "platform-connections":
      return <ConnectionsSettings />;

    default:
      return null;
  }
}

export default SettingsModal;
