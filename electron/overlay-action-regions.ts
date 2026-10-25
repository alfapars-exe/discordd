/** Main-owned fixed hit targets for the passive voice overlay toolbar. */

export const ACTION_BUTTON_SIZE = 40;
export const ACTIONS_HEIGHT = 48;
export const ACTIONS_RIGHT_INSET = 8;
export const ACTION_BUTTON_GAP = 8;
export const MIN_WINDOW_WIDTH = 112;
export const MIN_WINDOW_HEIGHT = 64;
export const INBOX_ACTION_WIDTH = 88;
export const INBOX_ACTION_HEIGHT = 20;

export interface OverlayActionPoint { x: number; y: number }
export interface OverlayActionWindowBounds { x: number; y: number; width: number; height: number }
export type OverlayAction = "toggle-mute" | "toggle-deafen";
export type OverlayNotificationAction = "open-inbox";

function isFinitePoint(value: unknown): value is OverlayActionPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.x === "number" && Number.isFinite(row.x)
    && typeof row.y === "number" && Number.isFinite(row.y);
}

function isUsableBounds(value: unknown): value is OverlayActionWindowBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.x === "number" && Number.isFinite(row.x)
    && typeof row.y === "number" && Number.isFinite(row.y)
    && typeof row.width === "number" && Number.isFinite(row.width) && row.width >= MIN_WINDOW_WIDTH
    && typeof row.height === "number" && Number.isFinite(row.height) && row.height >= MIN_WINDOW_HEIGHT;
}

function inside(x: number, y: number, left: number, top: number): boolean {
  return x >= left && x < left + ACTION_BUTTON_SIZE
    && y >= top && y < top + ACTION_BUTTON_SIZE;
}

/**
 * Resolve a screen-DIP pointer against fixed main-owned action regions.
 * `available` must already include authorization and visible-window checks.
 */
export function overlayActionAt(
  point: OverlayActionPoint,
  windowBounds: OverlayActionWindowBounds,
  available: boolean,
): OverlayAction | null {
  if (available !== true || !isFinitePoint(point) || !isUsableBounds(windowBounds)) return null;

  const localX = point.x - windowBounds.x;
  const localY = point.y - windowBounds.y;
  const top = windowBounds.height - ACTIONS_HEIGHT;
  const muteLeft = windowBounds.width - ACTION_BUTTON_SIZE * 2 - ACTION_BUTTON_GAP - ACTIONS_RIGHT_INSET;
  const deafenLeft = windowBounds.width - ACTION_BUTTON_SIZE - ACTIONS_RIGHT_INSET;
  if (inside(localX, localY, muteLeft, top)) return "toggle-mute";
  if (inside(localX, localY, deafenLeft, top)) return "toggle-deafen";
  return null;
}

/** Exact local hit region for the notification panel's generic inbox button. */
export function overlayNotificationActionAt(
  point: OverlayActionPoint,
  windowBounds: OverlayActionWindowBounds,
  available: boolean,
): OverlayNotificationAction | null {
  if (available !== true || !isFinitePoint(point) || !windowBounds ||
    ![windowBounds.x, windowBounds.y, windowBounds.width, windowBounds.height].every(Number.isFinite) ||
    windowBounds.width < INBOX_ACTION_WIDTH || windowBounds.height < INBOX_ACTION_HEIGHT) return null;
  const x = point.x - windowBounds.x;
  const y = point.y - windowBounds.y;
  return x >= 0 && x < INBOX_ACTION_WIDTH && y >= 0 && y < INBOX_ACTION_HEIGHT ? "open-inbox" : null;
}

/** Fixed reply buttons occupy only their own 88x20 DIP row regions. */
export function overlayNotificationReplyRowAt(point: OverlayActionPoint, bounds: OverlayActionWindowBounds, rows: number): number | null {
  if (!isFinitePoint(point) || !Number.isInteger(rows) || rows < 1 || rows > 3
    || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width < INBOX_ACTION_WIDTH) return null;
  const x = point.x - bounds.x, y = point.y - bounds.y;
  if (x < 0 || x >= INBOX_ACTION_WIDTH) return null;
  for (let row = 0; row < rows; row++) {
    const top = 20 + row * 32 + 6;
    if (bounds.height >= top + 20 && y >= top && y < top + 20) return row;
  }
  return null;
}
