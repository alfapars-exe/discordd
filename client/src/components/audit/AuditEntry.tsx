/**
 * AuditEntry — Renders a single audit_logs row as a chat-style system line.
 *
 * Layout: [actor avatar] [localized text]                     [timestamp]
 *
 * The localization step is non-trivial because the server stores metadata
 * as snake_case JSON (Go convention) while i18next templates use
 * camelCase placeholders (more natural to read in a translation key).
 * `metadataToPlaceholders` does the conversion at render time — keeping
 * each side idiomatic without forcing the other to change.
 *
 * Actor / target may be `undefined` if they were deleted AFTER the audit
 * row was written (the snapshot is captured at write time so this only
 * happens for rows written before the snapshot column existed, or if
 * snapshots were never populated). Falls back to localized
 * "unknownActor" / "unknownTarget" labels for graceful display.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatMessageTime, formatFullDateTime } from "../../utils/dateFormat";
import Avatar from "../shared/Avatar";
import type { AuditLog } from "../../types";

type AuditEntryProps = {
  entry: AuditLog;
};

/**
 * Convert snake_case JSON keys to camelCase so they match i18next placeholders.
 * Returns an empty object if metadata is malformed — the i18n template
 * will simply leave `{{roleName}}` unsubstituted, which is preferable to
 * crashing the entire panel.
 */
function metadataToPlaceholders(raw: string): Record<string, string> {
  if (!raw) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = String(value ?? "");
  }
  return out;
}

function AuditEntry({ entry }: AuditEntryProps) {
  const { t, i18n } = useTranslation("audit");
  const locale = i18n.language;

  const actorName =
    entry.actor?.display_name ||
    entry.actor?.username ||
    t("unknownActor");

  const targetName =
    entry.target?.display_name ||
    entry.target?.username ||
    t("unknownTarget");

  const metaPlaceholders = useMemo(
    () => metadataToPlaceholders(entry.metadata),
    [entry.metadata]
  );

  const text = t(`events.${entry.event_type}`, {
    actor: actorName,
    target: targetName,
    ...metaPlaceholders,
    defaultValue: entry.event_type,
  });

  const shortTime = formatMessageTime(entry.created_at, locale, {
    yesterday: t("yesterday", { ns: "chat", defaultValue: "Yesterday" }),
  });
  const fullTime = formatFullDateTime(entry.created_at, locale);

  return (
    <div className="audit-entry" id={`audit-${entry.id}`}>
      <div className="audit-entry-avatar">
        <Avatar
          name={actorName}
          avatarUrl={entry.actor?.avatar_url ?? undefined}
          size={24}
        />
      </div>
      <div className="audit-entry-body">
        <span className="audit-entry-text">{text}</span>
        <time className="audit-entry-time" title={fullTime}>
          {shortTime}
        </time>
      </div>
    </div>
  );
}

export default AuditEntry;
