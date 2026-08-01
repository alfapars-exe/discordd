/**
 * EN/TR locale key-parity check — namespaces touched by the moderation
 * timeout/temp-ban UX change (B1). Every user-facing string must exist in
 * both languages; this test catches an EN key added without its TR
 * counterpart (or vice versa) going forward.
 *
 * `lastSeenHours` is an intentional, documented exception — see
 * i18n/plural.test.ts: EN needs _one/_other plural suffixes, TR doesn't
 * inflect a noun after a number and keeps a single un-suffixed key.
 */

import { describe, it, expect } from "vitest";
import enCommon from "./locales/en/common.json";
import trCommon from "./locales/tr/common.json";
import enChat from "./locales/en/chat.json";
import trChat from "./locales/tr/chat.json";
import enVoice from "./locales/en/voice.json";
import trVoice from "./locales/tr/voice.json";
import enSettings from "./locales/en/settings.json";
import trSettings from "./locales/tr/settings.json";
import enAudit from "./locales/en/audit.json";
import trAudit from "./locales/tr/audit.json";

/** Recursively flattens a JSON translation tree into dot-separated key paths. */
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const KNOWN_ONLY_IN_EN = new Set(["lastSeenHours_one", "lastSeenHours_other"]);
const KNOWN_ONLY_IN_TR = new Set(["lastSeenHours"]);

function assertKeyParity(
  nsName: string,
  en: Record<string, unknown>,
  tr: Record<string, unknown>
) {
  const enKeys = new Set(flattenKeys(en));
  const trKeys = new Set(flattenKeys(tr));

  const missingInTr = [...enKeys].filter((k) => !trKeys.has(k) && !KNOWN_ONLY_IN_EN.has(k));
  const missingInEn = [...trKeys].filter((k) => !enKeys.has(k) && !KNOWN_ONLY_IN_TR.has(k));

  expect(missingInTr, `${nsName}: keys present in en but missing in tr`).toEqual([]);
  expect(missingInEn, `${nsName}: keys present in tr but missing in en`).toEqual([]);
}

describe("EN/TR locale key parity", () => {
  it("common.json", () => assertKeyParity("common", enCommon, trCommon));
  it("chat.json", () => assertKeyParity("chat", enChat, trChat));
  it("voice.json", () => assertKeyParity("voice", enVoice, trVoice));
  it("settings.json", () => assertKeyParity("settings", enSettings, trSettings));
  it("audit.json", () => assertKeyParity("audit", enAudit, trAudit));
});
