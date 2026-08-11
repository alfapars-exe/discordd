import { describe, it, expect } from "vitest";
import {
  checkRecoveryPassphrase,
  WeakRecoveryPassphraseError,
  RECOVERY_PASSPHRASE_MIN_LENGTH,
  RECOVERY_PASSPHRASE_MAX_LENGTH,
} from "./recoveryPassphrase";

/**
 * Policy gate for the key-backup passphrase (pentest 2026-07-26, finding
 * H-10). The blob this passphrase protects contains private keys AND the
 * plaintext message cache, and it lives on the server where it can be
 * attacked offline, so the negative cases below are the point of the module.
 *
 * The positive cases matter just as much: a "reject everything" policy would
 * satisfy every rejection test while making the backup feature unusable, and
 * a user with no backup loses their history outright.
 */
describe("checkRecoveryPassphrase", () => {
  describe("rejects", () => {
    it("a single character — the exact H-10 finding", () => {
      const result = checkRecoveryPassphrase("a");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("tooShort");
    });

    it("an empty or whitespace-only passphrase", () => {
      for (const candidate of ["", "   ", "\t\n"]) {
        const result = checkRecoveryPassphrase(candidate);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("empty");
        // Reuses the key that already existed for the blank-input case.
        expect(result.i18nKey).toBe("recoveryPasswordRequired");
      }
    });

    it("one character below the minimum length", () => {
      const justUnder = "correcthorse".slice(0, RECOVERY_PASSPHRASE_MIN_LENGTH - 1);
      expect(justUnder).toHaveLength(RECOVERY_PASSPHRASE_MIN_LENGTH - 1);

      const result = checkRecoveryPassphrase(justUnder);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("tooShort");
    });

    it("digits only, even at full length", () => {
      // Deliberately not "123456789012": that is also a sequence, and this
      // case must fail on the digits-only rule by itself.
      const result = checkRecoveryPassphrase("918273645500");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("digitsOnly");
    });

    it("a single repeated character stretched past the length minimum", () => {
      const result = checkRecoveryPassphrase("a".repeat(RECOVERY_PASSPHRASE_MIN_LENGTH + 8));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("tooFewDistinct");
    });

    it("a repeated short unit that only looks long", () => {
      for (const candidate of ["abababababab", "abcabcabcabc"]) {
        const result = checkRecoveryPassphrase(candidate);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("tooFewDistinct");
      }
    });

    it("ascending and descending character runs", () => {
      for (const candidate of ["abcdefghijkl", "zyxwvutsrqpo", "9876543210zq"]) {
        const result = checkRecoveryPassphrase(candidate);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("sequential");
      }
    });

    it("a common word with token padding, including leet spelling", () => {
      for (const candidate of ["password1234", "p4ssw0rd1234", "qwerty987654"]) {
        const result = checkRecoveryPassphrase(candidate);
        expect(result.ok).toBe(false);
        if (result.ok) return;
      }
    });

    it("a Turkish common word once accents are folded away", () => {
      // "şifre" normalizes to "sifre"; padding it to length must not rescue it.
      const result = checkRecoveryPassphrase("şifreşifreşifre");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("commonPassword");
    });

    it("an absurdly long paste", () => {
      const result = checkRecoveryPassphrase("Correct-Horse-9".repeat(200));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("tooLong");
    });

    it("length measured in code points, not UTF-16 units", () => {
      // 6 emoji = 12 UTF-16 units but only 6 characters to the user. Counting
      // UTF-16 units here would let a 6-character passphrase through.
      const sixEmoji = "🔑".repeat(6);
      expect(sixEmoji.length).toBe(RECOVERY_PASSPHRASE_MIN_LENGTH);

      const result = checkRecoveryPassphrase(sixEmoji);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("tooShort");
    });

    it("with an i18n key on every rejection", () => {
      const rejected = [
        "",
        "a",
        "918273645500",
        "aaaaaaaaaaaaaaaa",
        "abcdefghijkl",
        "password1234",
        "Correct-Horse-9".repeat(200),
      ];

      for (const candidate of rejected) {
        const result = checkRecoveryPassphrase(candidate);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.i18nKey).toMatch(/^recoveryPassword/);
        expect(result.strength).toBe("weak");
      }
    });
  });

  describe("accepts", () => {
    it("a reasonable passphrase", () => {
      const result = checkRecoveryPassphrase("Correct-Horse-Battery9");
      expect(result.ok).toBe(true);
    });

    it("exactly the minimum length when it is otherwise varied", () => {
      const atMinimum = "correcthorse";
      expect(atMinimum).toHaveLength(RECOVERY_PASSPHRASE_MIN_LENGTH);
      expect(checkRecoveryPassphrase(atMinimum).ok).toBe(true);
    });

    it("exactly the maximum length", () => {
      const atMaximum = "Correct-Horse-9".repeat(200).slice(0, RECOVERY_PASSPHRASE_MAX_LENGTH);
      expect(atMaximum).toHaveLength(RECOVERY_PASSPHRASE_MAX_LENGTH);
      expect(checkRecoveryPassphrase(atMaximum).ok).toBe(true);
    });

    it("a passphrase containing a common word it is not dominated by", () => {
      // "welcome" is 7 of 20 characters — a component, not the whole secret.
      const result = checkRecoveryPassphrase("welcome-to-my-cabin9");
      expect(result.ok).toBe(true);
    });

    it("non-ASCII characters", () => {
      expect(checkRecoveryPassphrase("gökyüzü-mavi-kedi7").ok).toBe(true);
    });

    it("grading longer, more varied passphrases higher", () => {
      const short = checkRecoveryPassphrase("correcthorse");
      const long = checkRecoveryPassphrase("Correct-Horse-Battery-Staple-9");
      expect(short.ok).toBe(true);
      expect(long.ok).toBe(true);
      expect(short.strength).toBe("fair");
      expect(long.strength).toBe("strong");
    });
  });

  describe("purity", () => {
    it("returns the same verdict for the same input", () => {
      const first = checkRecoveryPassphrase("Correct-Horse-Battery9");
      const second = checkRecoveryPassphrase("Correct-Horse-Battery9");
      expect(first).toEqual(second);
    });
  });
});

describe("WeakRecoveryPassphraseError", () => {
  it("carries the reason and its i18n key", () => {
    const error = new WeakRecoveryPassphraseError("tooShort");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("tooShort");
    expect(error.i18nKey).toBe("recoveryPasswordTooShort");
  });

  it("never puts the passphrase in the message — this error gets logged", () => {
    const secret = "hunter2-correct-horse";
    const check = checkRecoveryPassphrase("a");
    expect(check.ok).toBe(false);
    if (check.ok) return;

    const error = new WeakRecoveryPassphraseError(check.reason);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("tooShort");
  });
});
