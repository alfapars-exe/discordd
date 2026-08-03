/**
 * Recovery passphrase policy — strength gate for the key-backup passphrase.
 *
 * Pentest 2026-07-26, finding H-10: the recovery passphrase had no strength
 * policy at all, so a single character was accepted.
 *
 * WHY THIS SECRET IS NOT AN ORDINARY PASSWORD
 * The blob it unlocks (keyBackup.createBackup) carries the identity private
 * key, the signing private key, every signed/one-time prekey, every
 * Double-Ratchet session, every sender key, AND the message cache — i.e. the
 * PLAINTEXT of past messages. It is stored server-side, so a hostile or
 * breached server can attack it offline, at leisure, with no rate limit and
 * no lockout. A weak passphrase there is full retroactive disclosure, and
 * unlike an account password it cannot be "reset" after the fact: the blob
 * an attacker already copied stays crackable forever.
 *
 * WHY THE KDF DOES NOT SAVE US
 * keyBackup derives with PBKDF2-HMAC-SHA256 at 2,000,000 iterations. That
 * raises the cost PER GUESS, not the number of guesses required, so it
 * multiplies a weak passphrase's tiny search space by a constant and leaves
 * it weak. Order of magnitude: one PBKDF2 iteration is 2 SHA-256 compressions
 * (inner + outer HMAC), so one guess costs ~4e6 compressions. A high-end GPU
 * sustains on the order of 1e10 SHA-256 compressions/s => ~2.5e3 guesses/s;
 * a 100-GPU rig => ~2.5e5 guesses/s, ~8e12 guesses/year (~2^43). So the KDF
 * buys roughly 43 bits of headroom per attacker-year, and everything past
 * that has to come from the passphrase itself.
 *
 * WHY 12 (RECOVERY_PASSPHRASE_MIN_LENGTH)
 * NIST SP 800-63B sets 8 as the floor for ordinary memorized secrets and
 * tells verifiers to blocklist repetitive/sequential/common strings instead
 * of imposing character-class composition rules. We go above that floor and
 * follow the blocklist half, because this secret is worth more than an
 * account password. Empirically, human-chosen 8-character passwords carry
 * roughly 20-30 bits of real entropy, which the rig above exhausts in
 * minutes; 12 characters with the obvious patterns removed lands nearer
 * 35-45 bits, i.e. months of dedicated cluster time. Honest limitation: 12
 * human-chosen characters is a FLOOR that deletes the catastrophic cases,
 * not a proof of 43+ bits. The genuinely safe answer is a generated
 * multi-word phrase, which is what the UI hint nudges toward. 12 is also
 * where the trade-off sits: a longer hard minimum pushes users to write the
 * phrase down or to dismiss the backup prompt entirely, and a user with no
 * backup at all loses their history outright.
 *
 * SCOPE — ENFORCED AT SET TIME ONLY
 * Nothing here runs on the restore path. A backup created before this policy
 * (or under any weaker one) must stay restorable forever; refusing to accept
 * a legacy weak passphrase on restore would lock users out of their own keys
 * while protecting nobody. Pinned by the e2eeStore test
 * "restoreFromRecovery (backward compatibility)".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * No dictionary/adversarial-guessing estimator (zxcvbn or equivalent). That
 * would be a new dependency, which is a user-level decision in this repo, so
 * the checks below are limited to structural patterns that need no corpus.
 * Consequence: a passphrase like "Tuesday.Coffee" passes structurally while a
 * real estimator would rate it mediocre. This is a floor, not a guarantee.
 *
 * Pure and synchronous by contract: the store uses it as a hard gate and the
 * UI calls it on every keystroke for live feedback. No I/O, no clock, no
 * randomness — same input always yields the same verdict on both sides.
 * It never logs, stores, or transmits the passphrase.
 */

// ──────────────────────────────────
// Policy constants
// ──────────────────────────────────

/** Hard minimum length, in Unicode code points. Rationale in the file header. */
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 12;

/**
 * Upper bound, in code points. Not a security property — PBKDF2 accepts any
 * length — just a guard so a pathological paste cannot stall the KDF or the
 * per-keystroke UI check.
 */
export const RECOVERY_PASSPHRASE_MAX_LENGTH = 1024;

/**
 * Minimum number of DISTINCT code points.
 *
 * Catches the "long but nearly constant" family that a length check alone
 * lets through: "aaaaaaaaaaaa" (1 distinct), "abababababab" (2),
 * "abcabcabcabc" (3). Their real search space is the size of the small
 * alphabet plus the repetition rule, nowhere near their apparent length.
 */
const MIN_DISTINCT_CHARACTERS = 5;

/**
 * Reject when this many code points run consecutively (+1 or -1 each step):
 * "123456", "abcdef", "fedcba". Six is short enough to catch keyboard-walk
 * padding and long enough that an ordinary phrase does not trip it by
 * accident — natural language essentially never produces six consecutive
 * ascending code points.
 */
const MAX_SEQUENTIAL_RUN = 6;

/**
 * Reject when a blocklist token covers at least this fraction of the
 * normalized passphrase, e.g. "password1234" (8/12). Coverage sums ALL
 * non-overlapping occurrences of the token, so repeating a weak word does
 * not buy length: "sifresifresifre" is 15/15, not 5/15.
 *
 * Below half, the token is a component of a longer phrase rather than the
 * phrase itself, so "welcometomycabin9" (7/17) passes.
 */
const COMMON_TOKEN_COVERAGE = 0.5;

/**
 * Tokens whose presence dominates a passphrase's guessability. Stored in
 * normalized form (see normalizeForTokenMatch): lowercase, de-accented,
 * leet-folded, alphanumerics only. Deliberately small — this is a
 * "catch the obvious" list, NOT a substitute for a real corpus. EN and TR
 * entries both appear because the app ships in both languages.
 */
const COMMON_TOKENS: readonly string[] = [
  "password",
  "passwort",
  "parola",
  "sifre",
  "gizli",
  "anahtar",
  "kurtarma",
  "qwerty",
  "azerty",
  "qazwsx",
  "asdfgh",
  "zxcvbn",
  "letmein",
  "welcome",
  "iloveyou",
  "admin",
  "administrator",
  "login",
  "master",
  "secret",
  "hichat",
  "discord",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "trustno",
];

// ──────────────────────────────────
// Result types
// ──────────────────────────────────

/**
 * Stable rejection codes. The store surfaces these; tests assert on them.
 * Treat them as part of this module's contract — the i18n keys below are
 * derived from them, so renaming one means renaming a user-visible string.
 */
export type RecoveryPassphraseRejection =
  | "empty"
  | "tooShort"
  | "tooLong"
  | "tooFewDistinct"
  | "digitsOnly"
  | "sequential"
  | "commonPassword";

/** UI-only badge. Never a gate — acceptance is decided by the checks above. */
export type RecoveryPassphraseStrength = "weak" | "fair" | "good" | "strong";

export type RecoveryPassphraseCheck =
  | {
      readonly ok: true;
      readonly strength: RecoveryPassphraseStrength;
    }
  | {
      readonly ok: false;
      readonly reason: RecoveryPassphraseRejection;
      /**
       * Key in the "e2ee" i18n namespace. Carried in the result (the pattern
       * utils/detectOS.ts already uses) so the two call sites — settings and
       * the recovery prompt — cannot drift into showing different wording for
       * the same rejection.
       */
      readonly i18nKey: string;
      /** Always "weak": a rejected passphrase has no meaningful grade. */
      readonly strength: "weak";
    };

/**
 * reason -> i18n key, in the "e2ee" namespace.
 *
 * Exported so i18n/localeParity.test.ts can assert every key here really
 * exists in BOTH locale files. Without that link a renamed key would surface
 * to users as the raw key string, and only in one language.
 */
export const RECOVERY_PASSPHRASE_I18N_KEYS: Readonly<
  Record<RecoveryPassphraseRejection, string>
> = {
  // Reuses the pre-existing key rather than adding a duplicate string.
  empty: "recoveryPasswordRequired",
  tooShort: "recoveryPasswordTooShort",
  tooLong: "recoveryPasswordTooLong",
  tooFewDistinct: "recoveryPasswordTooFewDistinct",
  digitsOnly: "recoveryPasswordDigitsOnly",
  sequential: "recoveryPasswordSequential",
  commonPassword: "recoveryPasswordCommon",
};

/**
 * Thrown by the enforcement chokepoint (e2eeStore.setRecoveryPassword) when a
 * passphrase fails the policy.
 *
 * The message carries the rejection CODE only. The passphrase itself must
 * never reach an Error message, a log line, or telemetry — this error is
 * console.error'd by callers.
 */
export class WeakRecoveryPassphraseError extends Error {
  readonly reason: RecoveryPassphraseRejection;
  readonly i18nKey: string;

  constructor(reason: RecoveryPassphraseRejection) {
    super(`Recovery passphrase rejected by policy: ${reason}`);
    this.name = "WeakRecoveryPassphraseError";
    this.reason = reason;
    this.i18nKey = RECOVERY_PASSPHRASE_I18N_KEYS[reason];
  }
}

// ──────────────────────────────────
// Internals
// ──────────────────────────────────

/**
 * Fold the passphrase to a form where blocklist tokens are still visible
 * through cosmetic obfuscation: lowercase, strip combining marks (so "şifre"
 * and "sifre" match), map the common leet substitutions, then drop everything
 * that is not [a-z0-9].
 *
 * Turkish dotless "ı" has no decomposition, so it is mapped explicitly;
 * "İ".toLowerCase() yields "i" plus a combining dot, which NFD stripping
 * already handles.
 */
const LEET_FOLD: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
};

function normalizeForTokenMatch(passphrase: string): string {
  return passphrase
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[01345678@$!]/g, (ch) => LEET_FOLD[ch] ?? ch)
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Total length covered by non-overlapping occurrences of `token` in `text`.
 * Non-overlapping so that a self-overlapping token cannot report coverage
 * larger than the string it was found in.
 */
function tokenCoverage(text: string, token: string): number {
  let covered = 0;
  let from = 0;

  for (;;) {
    const at = text.indexOf(token, from);
    if (at === -1) return covered;
    covered += token.length;
    from = at + token.length;
  }
}

/** Longest run of code points stepping by exactly +1 or -1. */
function longestSequentialRun(codePoints: readonly number[]): number {
  if (codePoints.length === 0) return 0;

  let longest = 1;
  let ascending = 1;
  let descending = 1;

  for (let i = 1; i < codePoints.length; i++) {
    const delta = codePoints[i] - codePoints[i - 1];
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    longest = Math.max(longest, ascending, descending);
  }

  return longest;
}

/**
 * Naive pool-size entropy estimate, for the UI badge only.
 *
 * This OVERSTATES human-chosen passphrases badly — it assumes every character
 * is drawn uniformly and independently, which "Password123!" plainly is not.
 * It is a coarse "longer and more varied is better" hint. Never gate on it.
 * Non-ASCII letters land in the symbol bucket, which overstates them further.
 */
function estimateBits(passphrase: string, length: number): number {
  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(passphrase)) pool += 33;
  if (pool === 0) return 0;
  return length * Math.log2(pool);
}

function reject(reason: RecoveryPassphraseRejection): RecoveryPassphraseCheck {
  return {
    ok: false,
    reason,
    i18nKey: RECOVERY_PASSPHRASE_I18N_KEYS[reason],
    strength: "weak",
  };
}

// ──────────────────────────────────
// Public API
// ──────────────────────────────────

/**
 * Evaluate a candidate recovery passphrase.
 *
 * Evaluates the string EXACTLY as given, because that is what gets fed to
 * PBKDF2 — callers that trim must trim before calling, or the verdict will
 * not describe the secret actually used. Whitespace-only input is "empty".
 */
export function checkRecoveryPassphrase(passphrase: string): RecoveryPassphraseCheck {
  if (passphrase.trim().length === 0) return reject("empty");

  // Code points, not UTF-16 units: an emoji or an astral character is one
  // character to the user and must count as one here too.
  const codePoints = Array.from(passphrase, (ch) => ch.codePointAt(0) ?? 0);
  const length = codePoints.length;

  if (length > RECOVERY_PASSPHRASE_MAX_LENGTH) return reject("tooLong");
  if (length < RECOVERY_PASSPHRASE_MIN_LENGTH) return reject("tooShort");

  // Digit-only strings look long but are PINs, dates and phone numbers in
  // practice; even at the theoretical maximum, 12 digits is only ~40 bits.
  if (/^[0-9]+$/.test(passphrase)) return reject("digitsOnly");

  if (new Set(codePoints).size < MIN_DISTINCT_CHARACTERS) {
    return reject("tooFewDistinct");
  }

  if (longestSequentialRun(codePoints) >= MAX_SEQUENTIAL_RUN) {
    return reject("sequential");
  }

  const normalized = normalizeForTokenMatch(passphrase);
  if (normalized.length > 0) {
    for (const token of COMMON_TOKENS) {
      const coverage = tokenCoverage(normalized, token) / normalized.length;
      if (coverage >= COMMON_TOKEN_COVERAGE) {
        return reject("commonPassword");
      }
    }
  }

  const bits = estimateBits(passphrase, length);
  const strength: RecoveryPassphraseStrength =
    bits >= 80 ? "strong" : bits >= 65 ? "good" : "fair";

  return { ok: true, strength };
}
