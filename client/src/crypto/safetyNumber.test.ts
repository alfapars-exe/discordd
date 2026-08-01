/**
 * safetyNumber tests — the determinism contract, not the hash.
 *
 * A safety number is only useful if two independent clients, with different
 * locales and opposite ideas of which key is "local", print the identical
 * string. Every test here pins one way that agreement could silently break:
 * argument order, locale-sensitive collation, or the display grouping.
 *
 * No mocking: the module is pure by contract, so it is exercised directly.
 */

import { describe, it, expect } from "vitest";
import { computeSafetyNumber } from "./safetyNumber";

/** Distinct fill patterns so the two operands stay distinguishable. */
const KEY_A = new Uint8Array(32).fill(0xa1);
const KEY_B = new Uint8Array(32).fill(0xb2);

/** KEY_A with a single bit flipped in the last byte. */
const KEY_A_NEIGHBOUR = (() => {
  const k = new Uint8Array(KEY_A);
  k[31] ^= 0x01;
  return k;
})();

/** Display shape: 8 groups of 4 lowercase hex chars, single-space separated. */
const DISPLAY_RE = /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/;

describe("computeSafetyNumber — symmetry", () => {
  it("is identical whichever key is passed first (the core invariant)", () => {
    // Alice passes her key first, Bob passes his first. They must agree, or
    // every verification attempt would fail as if a MITM were present.
    expect(computeSafetyNumber(KEY_A, KEY_B)).toBe(
      computeSafetyNumber(KEY_B, KEY_A)
    );
  });

  it("is stable when both sides hold the same key (self-pair)", () => {
    const first = computeSafetyNumber(KEY_A, KEY_A);
    expect(computeSafetyNumber(KEY_A, KEY_A)).toBe(first);
    expect(first).toMatch(DISPLAY_RE);
  });

  it("returns the same value across repeated calls (no hidden state)", () => {
    const first = computeSafetyNumber(KEY_A, KEY_B);
    for (let i = 0; i < 5; i++) {
      expect(computeSafetyNumber(KEY_A, KEY_B)).toBe(first);
    }
  });
});

describe("computeSafetyNumber — distinctness", () => {
  it("different key pairs produce different numbers", () => {
    expect(computeSafetyNumber(KEY_A, KEY_B)).not.toBe(
      computeSafetyNumber(KEY_A, KEY_A)
    );
    expect(computeSafetyNumber(KEY_A, KEY_B)).not.toBe(
      computeSafetyNumber(KEY_B, KEY_B)
    );
  });

  it("a single flipped bit changes the number", () => {
    // If it did not, a key substitution could be hidden from the user.
    expect(computeSafetyNumber(KEY_A, KEY_B)).not.toBe(
      computeSafetyNumber(KEY_A_NEIGHBOUR, KEY_B)
    );
  });
});

describe("computeSafetyNumber — display format", () => {
  it("renders 8 space-separated groups of 4 lowercase hex characters", () => {
    expect(computeSafetyNumber(KEY_A, KEY_B)).toMatch(DISPLAY_RE);
    expect(computeSafetyNumber(KEY_B, KEY_A)).toMatch(DISPLAY_RE);
    expect(computeSafetyNumber(KEY_A_NEIGHBOUR, KEY_B)).toMatch(DISPLAY_RE);
  });

  it("matches the known-answer vector for the canonical form", () => {
    // sha256("a1"*32 + "\n" + "b2"*32), first 128 bits, grouped by 4.
    // Hard-coded so an accidental change to the canonical form (separator,
    // ordering, truncation length) shows up as a failing vector rather than
    // as safety numbers that silently stop matching older clients.
    expect(computeSafetyNumber(KEY_A, KEY_B)).toBe(
      "550c 5359 f4ec 70c8 2825 ca3a b505 f941"
    );
  });
});

describe("computeSafetyNumber — locale independence", () => {
  it("ignores String.prototype.localeCompare (a tr-TR collator must not matter)", () => {
    const baseline = computeSafetyNumber(KEY_A, KEY_B);
    const original = String.prototype.localeCompare;

    try {
      // Stand-in for a hostile/divergent locale collator: it reverses the
      // order of the two hex strings. An implementation that sorted with
      // localeCompare would hash "b2… \n a1…" instead of "a1… \n b2…" and
      // produce a different number — exactly the cross-locale mismatch this
      // module must not have.
      String.prototype.localeCompare = function reversed(
        this: string,
        that: string
      ): number {
        if (this < that) return 1;
        if (this > that) return -1;
        return 0;
      } as typeof String.prototype.localeCompare;

      expect(computeSafetyNumber(KEY_A, KEY_B)).toBe(baseline);
      expect(computeSafetyNumber(KEY_B, KEY_A)).toBe(baseline);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("ignores Intl.Collator entirely", () => {
    const baseline = computeSafetyNumber(KEY_A, KEY_B);
    const originalCollator = Intl.Collator;

    try {
      // Any use of Intl.Collator inside the module would throw here.
      (Intl as { Collator: typeof Intl.Collator }).Collator = function () {
        throw new Error("Intl.Collator must not be used by safetyNumber");
      } as unknown as typeof Intl.Collator;

      expect(computeSafetyNumber(KEY_A, KEY_B)).toBe(baseline);
      expect(computeSafetyNumber(KEY_B, KEY_A)).toBe(baseline);
    } finally {
      (Intl as { Collator: typeof Intl.Collator }).Collator = originalCollator;
    }
  });

  it("code-unit order agrees with tr-TR collation for the hex alphabet", () => {
    // Documents WHY lowercase hex is the safe canonical alphabet: it contains
    // none of the characters (dotted/dotless i, ç, ğ, ş) where Turkish
    // collation diverges from code-unit order. If a future change widened the
    // canonical form beyond [0-9a-f], this assertion is the tripwire.
    const collator = new Intl.Collator("tr-TR");
    const alphabet = "0123456789abcdef".split("");

    for (const a of alphabet) {
      for (const b of alphabet) {
        const codeUnit = a < b ? -1 : a > b ? 1 : 0;
        expect(Math.sign(collator.compare(a, b))).toBe(codeUnit);
      }
    }
  });
});
