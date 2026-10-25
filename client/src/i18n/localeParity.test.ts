/**
 * EN/TR locale key and interpolation parity for every namespace on disk. Every user-facing
 * string must exist in
 * both languages; this test catches an EN key added without its TR
 * counterpart (or vice versa) going forward.
 *
 * `lastSeenHours` is an intentional, documented exception — see
 * i18n/plural.test.ts: EN needs _one/_other plural suffixes, TR doesn't
 * inflect a noun after a number and keeps a single un-suffixed key.
 */

import { describe, it, expect } from "vitest";
import enE2EE from "./locales/en/e2ee.json";
import trE2EE from "./locales/tr/e2ee.json";
import enMusic from "./locales/en/music.json";
import trMusic from "./locales/tr/music.json";
import { RECOVERY_PASSPHRASE_I18N_KEYS } from "../crypto/recoveryPassphrase";
import { MUSIC_BOT_ERROR_REASONS } from "../types/music";

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

const KNOWN_ONLY_IN_EN = new Set(["lastSeenHours_one", "lastSeenHours_other", "memberCount_one", "memberCount_other"]);
const KNOWN_ONLY_IN_TR = new Set(["lastSeenHours", "memberCount"]);

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

const englishNamespaces = import.meta.glob<Record<string, unknown>>("./locales/en/*.json", { eager: true, import: "default" });
const turkishNamespaces = import.meta.glob<Record<string, unknown>>("./locales/tr/*.json", { eager: true, import: "default" });

describe("EN/TR locale key parity", () => {
  it("checks every namespace available in both languages", () => {
    const names = (resources: typeof englishNamespaces) => Object.keys(resources).map((path) => path.split("/").at(-1)).sort();
    expect(names(englishNamespaces)).toEqual(names(turkishNamespaces));
  });
  for (const [path, en] of Object.entries(englishNamespaces)) {
    const tr = turkishNamespaces[path.replace("/en/", "/tr/")];
    const namespace = path.split("/").at(-1)!;
    it(namespace, () => assertKeyParity(namespace, en, tr));
    it(`${namespace} interpolation variables`, () => {
      const valueAt = (tree: Record<string, unknown>, key: string): unknown => key.split(".").reduce<unknown>((value, part) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, tree);
      const tokens = (value: unknown) => typeof value === "string"
        ? [...new Set([...value.matchAll(/{{-?\s*([^}, ]+)/g)].map((match) => match[1]))].sort() : [];
      for (const key of flattenKeys(en)) {
        const english = valueAt(en, key);
        const turkish = valueAt(tr, key) ?? valueAt(tr, key.replace(/_(one|other)$/, ""));
        expect(tokens(english), `${namespace}:${key} interpolation mismatch`).toEqual(tokens(turkish));
      }
    });
  }
});

/**
 * The music_bot_error handler builds `music:reason_<code>` from a whitelisted
 * server reason code. Same failure mode as the block below: a code with no
 * key in either locale would render the raw key, and parity alone would
 * still pass.
 */
describe("music bot reason keys resolve", () => {
  const enKeys = new Set(flattenKeys(enMusic));
  const trKeys = new Set(flattenKeys(trMusic));

  for (const code of MUSIC_BOT_ERROR_REASONS) {
    const key = `reason_${code}`;
    it(`${code} -> ${key}`, () => {
      expect(enKeys.has(key), `music/en is missing "${key}"`).toBe(true);
      expect(trKeys.has(key), `music/tr is missing "${key}"`).toBe(true);
    });
  }
});

/**
 * The recovery passphrase policy (pentest 2026-07-26, finding H-10) returns
 * an i18n key with each rejection instead of a message. Parity alone would
 * not catch the failure mode that matters here: a key the policy emits but
 * that exists in NEITHER locale renders as the raw key string ("tooShort") to
 * the user, in both languages, and every parity test still passes.
 */
describe("recovery passphrase rejection keys resolve", () => {
  const enKeys = new Set(flattenKeys(enE2EE));
  const trKeys = new Set(flattenKeys(trE2EE));

  for (const [reason, key] of Object.entries(RECOVERY_PASSPHRASE_I18N_KEYS)) {
    it(`${reason} -> ${key}`, () => {
      expect(enKeys.has(key), `e2ee/en is missing "${key}"`).toBe(true);
      expect(trKeys.has(key), `e2ee/tr is missing "${key}"`).toBe(true);
    });
  }
});
