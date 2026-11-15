import {
  ACCESSIBILITY_NUMBER_RANGES,
  DEFAULT_ACCESSIBILITY,
  NOTIFICATION_DURATION_OPTIONS,
  type AccessibilityState,
} from "./accessibilityPreferenceDefaults";

const NUMBER_LIMITS: Partial<Record<keyof AccessibilityState, readonly [number, number]>> = ACCESSIBILITY_NUMBER_RANGES;
const ENUM_OPTIONS: Partial<{ [K in keyof AccessibilityState]: readonly AccessibilityState[K][] }> = {
  density: ["compact", "default", "cozy"],
  messageStyle: ["default", "compact"],
  stickerAnimation: ["always", "interaction", "never"],
  roleColorMode: ["names", "dots", "hidden"],
  officialMessageStyle: ["default", "subtle", "prominent"],
  notificationDuration: NOTIFICATION_DURATION_OPTIONS,
};

function validField(key: keyof AccessibilityState, value: unknown): boolean {
  const limits = NUMBER_LIMITS[key];
  if (limits) {
    return typeof value === "number" && Number.isFinite(value) && value >= limits[0] && value <= limits[1];
  }
  const options: readonly unknown[] | undefined = ENUM_OPTIONS[key];
  if (options) return options.includes(value);
  return typeof DEFAULT_ACCESSIBILITY[key] === "boolean" && typeof value === "boolean";
}

/** Local hydration and account recovery accept the same owned, current fields. */
export function sanitizeAccessibilityPreferences(value: unknown): Partial<AccessibilityState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_ACCESSIBILITY) as (keyof AccessibilityState)[]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const item = source[key];
    if (validField(key, item)) valid[key] = item;
  }
  return valid as Partial<AccessibilityState>;
}
