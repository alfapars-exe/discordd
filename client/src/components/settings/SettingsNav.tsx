/** Settings sidebar navigation. Server Settings visible only to authorized users. */

import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { isElectron } from "../../utils/constants";
import type { SettingsTab } from "../../stores/settingsStore";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { getSettingsGroups, SETTINGS_SECTIONS } from "./settingsNavigation";
import { SettingsWorkspaceContext } from "./settingsWorkspaceContext";

function SettingsNav() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const [query, setQuery] = useState("");
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const workspace = useContext(SettingsWorkspaceContext);
  const navigate = workspace?.navigate ?? setActiveTab;
  const context = useSettingsStore((s) => s.context);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const isMobile = useIsMobile();

  const members = useActiveMembers();
  const currentMember = members.find((m) => m.id === user?.id);
  const perms = currentMember?.effective_permissions ?? 0;

  // Live app version — read once from electron main (bundled package.json).
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    window.electronAPI?.getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const isPlatformAdmin = user?.is_platform_admin ?? false;

  // Build the allowed navigation first. Searching must never reveal an
  // admin-only or desktop-only destination that was previously hidden.
  const groups = getSettingsGroups(perms, isPlatformAdmin, isElectron(), UI_SHELL_V2 ? context : undefined);
  const search = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.map((group) => ({ ...group, items: group.items.filter((item) =>
    !search || `${t(group.label)} ${t(item.labelKey)} ${(SETTINGS_SECTIONS[item.id] ?? []).map((section) => t(section.labelKey)).join(" ")} ${activeTab === item.id ? workspace?.sections.map((section) => section.label).join(" ") ?? "" : ""}`.toLocaleLowerCase().includes(search)
  ) })).filter((group) => group.items.length > 0);

  return (
    <nav className="settings-nav settings-nav--searchable" aria-label={t("title")}>
      <div className="settings-nav-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchSettings")} aria-label={t("searchSettings")}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }} />
        {query && <button onClick={() => setQuery("")} aria-label={tCommon("clear")}>×</button>}
      </div>
      {visibleGroups.length === 0 && <p className="settings-nav-empty" role="status">{tCommon("noResults")}</p>}
      {isMobile ? (
        <select className="settings-nav-select" aria-label={t("chooseSettingsSection")}
          value={visibleGroups.some((g) => g.items.some((item) => item.id === activeTab)) ? activeTab : ""}
          onChange={(e) => {
            if (!e.target.value) return;
            const [tab, section] = e.target.value.split("#");
            if (section && workspace) workspace.navigate(tab as SettingsTab, section);
            else navigate(tab as SettingsTab);
          }}>
          <option value="" disabled>{t("chooseSettingsSection")}</option>
          {visibleGroups.map((group) => <optgroup key={group.label} label={t(group.label)}>
            {group.items.flatMap((item) => [
              <option key={item.id} value={item.id}>{t(item.labelKey)}</option>,
              ...(search && item.id !== activeTab && workspace ? (SETTINGS_SECTIONS[item.id] ?? []).filter((section) => t(section.labelKey).toLocaleLowerCase().includes(search))
                .map((section) => <option key={`${item.id}-${section.id}`} value={`${item.id}#${section.id}`}>{t(item.labelKey)} — {t(section.labelKey)}</option>) : []),
            ])}
          </optgroup>)}
        </select>
      ) : visibleGroups.map((group) => (
        <section key={group.label} className="settings-nav-group">
          <h3 className="settings-nav-label">{t(group.label)}</h3>
          {group.items.map((item) => <div key={item.id}>
            <button key={item.id} className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
              aria-current={activeTab === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}>{t(item.labelKey)}</button>
            {item.id === activeTab && !!workspace?.sections.length && <div className="settings-nav-sections" aria-label={t("workspace.sections")}>
              {workspace.sections.filter((section) => !search || section.label.toLocaleLowerCase().includes(search)
                || t(item.labelKey).toLocaleLowerCase().includes(search)).map((section) => <button key={section.id}
                className={`settings-nav-section${workspace.activeSection === section.id ? " active" : ""}`}
                aria-current={workspace.activeSection === section.id ? "location" : undefined}
                onClick={() => workspace.navigateSection(section.id)}>{section.label}</button>)}
            </div>}
            {item.id !== activeTab && search && workspace && <div className="settings-nav-sections">
              {(SETTINGS_SECTIONS[item.id] ?? []).filter((section) => t(section.labelKey).toLocaleLowerCase().includes(search)).map((section) => <button key={section.id}
                className="settings-nav-section" onClick={() => workspace.navigate(item.id, section.id)}>{t(section.labelKey)}</button>)}
            </div>}
          </div>)}
        </section>
      ))}
      {isMobile && !!workspace?.sections.length && <select className="settings-nav-select settings-nav-section-select"
        aria-label={t("workspace.sections")} value={workspace.activeSection ?? ""}
        onChange={(event) => workspace.navigateSection(event.target.value)}>
        {workspace.sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select>}

      {/* Account actions stay out of server/platform management. */}
      {(!UI_SHELL_V2 || context === "account") && <>
      {!isMobile && <div className="settings-nav-divider settings-nav-divider-push" />}
      <button
        className="settings-nav-item settings-nav-logout"
        onClick={() => { void logout(); }}
      >
        {t("logOut")}
      </button>
      </>}

      {/* App Version — desktop only, read from electron main at mount */}
      {!isMobile && appVersion && (
        <p className="settings-nav-version">HiChat! v{appVersion}</p>
      )}
    </nav>
  );
}

export default SettingsNav;
