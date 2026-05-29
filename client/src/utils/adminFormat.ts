/**
 * adminFormat — formatting helpers shared by the platform-admin tables
 * (AdminUserList / AdminServerList / AdminReportList).
 *
 * Deliberately separate from utils/dateFormat.ts (which formats chat-message
 * timestamps): these carry admin-specific semantics — SQLite UTC parsing,
 * MB storage sizes, and compact "5m / 2h / 3d" relative labels with
 * caller-supplied i18n strings. Behaviour was lifted verbatim from the three
 * admin lists so the displayed values do not change.
 */

/** SQLite timestamps lack the "Z" suffix — append it so they parse as UTC. */
export function parseUTC(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

/**
 * Absolute date+time label. `assumeUTC` preserves a pre-refactor divergence:
 * the report table appended "Z" before parsing (treat as UTC) while the user
 * table did not (treat as local). Kept as an explicit flag so neither table's
 * rendered time shifts — fixing that inconsistency is a separate decision.
 */
export function formatDateTime(iso: string, opts?: { assumeUTC?: boolean }): string {
  try {
    const normalized = opts?.assumeUTC && !iso.endsWith("Z") ? iso + "Z" : iso;
    return new Date(normalized).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Date-only label (no time) — used by the server table. */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Storage size in MB with KB/MB/GB thresholds. */
export function formatStorage(mb: number): string {
  if (mb < 0.01) return "0 MB";
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Compact relative-time label ("just now" / "5m" / "2h" / "3d"), falling
 * back to an absolute date past 30 days. `nowMs` is supplied by the caller
 * (a snapshot — see useNowTick) so render stays pure; the labels and the
 * >30d fallback are caller-supplied to preserve each table's exact wording.
 */
export function formatRelativeTime(
  iso: string | null,
  nowMs: number,
  opts: { neverLabel: string; justNowLabel: string; fallback: (iso: string) => string },
): string {
  if (!iso) return opts.neverLabel;
  try {
    const diff = nowMs - parseUTC(iso);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return opts.justNowLabel;
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    return opts.fallback(iso);
  } catch {
    return iso ?? "";
  }
}
