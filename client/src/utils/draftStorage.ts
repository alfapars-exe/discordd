/**
 * draftStorage — Per-channel composer draft persistence via localStorage.
 *
 * Companion to T3.6 offline detection. When the client goes offline mid-
 * compose (radio dropped, VPN toggled, laptop lid closed), a
 * refresh-then-reconnect cycle can lose the message being typed. The
 * composer already tries to preserve state in React memory, but a full
 * page reload wipes that too. Persisting the draft on every meaningful
 * keystroke — cheap in localStorage terms — closes that gap.
 *
 * Design notes:
 *   - Storage key is namespaced ("mqvi_draft:{scope}:{channelId}") so
 *     channel drafts don't collide with DM drafts and neither collides
 *     with future features that might key on the same channelId.
 *   - Length is hard-capped at MAX_DRAFT_CHARS. Composer already gates
 *     MAX_MESSAGE_LENGTH (999) at send time; we allow a bit more here
 *     (2048) so a paste that's above the send cap can still be saved
 *     while the user trims it down.
 *   - Every operation swallows localStorage failures (quota, private-
 *     mode, iOS Safari's disabled-storage state). Losing a draft is a
 *     UX regression, not a crash — the composer works fine without.
 */

const KEY_PREFIX = "mqvi_draft:";

/** Hard cap on how much we'll persist. See file header for the rationale. */
export const MAX_DRAFT_CHARS = 2048;

/** Namespace for the storage key. Channel and DM drafts don't collide. */
export type DraftScope = "channel" | "dm";

function keyFor(scope: DraftScope, channelId: string): string {
  return `${KEY_PREFIX}${scope}:${channelId}`;
}

/**
 * saveDraft persists `content` under the given channelId. Empty / all-
 * whitespace input clears the draft instead of storing a blank — a
 * common composer state (user typed then deleted) shouldn't leave an
 * orphan localStorage entry that shows up in dev-tools like a stale
 * message the app "should" have sent.
 */
export function saveDraft(scope: DraftScope, channelId: string, content: string): void {
  if (!channelId) return;
  const trimmed = content.trim();
  if (trimmed === "") {
    clearDraft(scope, channelId);
    return;
  }
  const bounded = content.length > MAX_DRAFT_CHARS ? content.slice(0, MAX_DRAFT_CHARS) : content;
  try {
    localStorage.setItem(keyFor(scope, channelId), bounded);
  } catch {
    /* quota / private mode / iOS Safari — losing a draft is UX debt, not crash. */
  }
}

/** loadDraft returns the previously-saved content or "" if none. */
export function loadDraft(scope: DraftScope, channelId: string): string {
  if (!channelId) return "";
  try {
    const raw = localStorage.getItem(keyFor(scope, channelId));
    if (raw === null) return "";
    // A stale entry that somehow grew past the cap is truncated on
    // read too — belt-and-braces against a manual localStorage edit.
    return raw.length > MAX_DRAFT_CHARS ? raw.slice(0, MAX_DRAFT_CHARS) : raw;
  } catch {
    return "";
  }
}

/** clearDraft removes the entry, if any. Idempotent — safe to call on send. */
export function clearDraft(scope: DraftScope, channelId: string): void {
  if (!channelId) return;
  try {
    localStorage.removeItem(keyFor(scope, channelId));
  } catch {
    /* ignore */
  }
}

/**
 * clearAllDrafts wipes every draft across every scope+channel. Used on
 * logout so a shared machine doesn't leave the previous account's
 * half-written messages visible to the next user opening a channel
 * with the same channelId.
 */
export function clearAllDrafts(): void {
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}
