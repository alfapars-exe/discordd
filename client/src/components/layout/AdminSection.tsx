/**
 * AdminSection — Platform-admin-only sidebar entry.
 *
 * Visible only when the current user has is_platform_admin = true. Provides a
 * one-click jump to Settings → Platform Users (the existing AdminUserList),
 * which already supports listing every registered user and ban / unban
 * actions via /api/admin/users.
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";

function AdminSection() {
  const { t } = useTranslation("common");
  const isPlatformAdmin = useAuthStore((s) => s.user?.is_platform_admin ?? false);
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);
  const openSettings = useSettingsStore((s) => s.openSettings);

  if (!isPlatformAdmin) return null;

  const isExpanded = expandedSections["admin"] ?? true;

  return (
    <div className="ch-tree-section">
      <button
        className="ch-tree-section-header"
        onClick={() => toggleSection("admin")}
      >
        <span className={`ch-tree-chevron${isExpanded ? " expanded" : ""}`}>&#x276F;</span>
        <span>{t("adminSection")}</span>
      </button>

      {isExpanded && (
        <div className="ch-tree-section-body">
          <button
            className="ch-tree-item"
            onClick={() => openSettings("platform-users")}
            title={t("registeredUsers")}
          >
            <svg className="ch-tree-icon" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5.13a4 4 0 11-8 0 4 4 0 018 0zm6 3a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="ch-tree-label">{t("registeredUsers")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminSection;
