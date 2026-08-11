/**
 * Safety Number — a human-comparable fingerprint of a two-party identity pair.
 *
 * Both sides of a conversation must be able to read the SAME string out loud
 * (or scan it) and compare it. That makes cross-device determinism the whole
 * point of this module: any input the two clients could disagree about — key
 * order, locale, clock, stored state — would silently produce two different
 * numbers and turn a real MITM warning into "our numbers just never match".
 *
 * Determinism contract (all four are invariants, each pinned by a test):
 *  1. Both identity keys are rendered as lowercase hex.
 *  2. The two hex strings are ordered by an EXPLICIT code-unit comparison, so
 *     neither side needs to know which key is "local". See compareByCodeUnit
 *     for why String.localeCompare is banned here.
 *  3. Canonical form is the two ordered hex strings joined with "\n", hashed
 *     with SHA-256, rendered as hex. The newline separator keeps the boundary
 *     between the two keys unambiguous.
 *  4. Display is the first 32 hex characters in space-separated groups of 4 —
 *     the same shape as the local-device fingerprint already shown in
 *     settings, so the two read as one family of identifiers.
 *
 * The function is synchronous and pure: no IndexedDB, no network, no Intl,
 * no Date. computeSafetyNumber(a, b) === computeSafetyNumber(b, a).
 *
 * This is a VERIFICATION aid, not a security boundary on its own: it lets a
 * user confirm out-of-band that the identity keys their device pinned are the
 * ones the peer actually holds. Confidentiality still comes from the Signal
 * session; truncation to 128 bits is a usability trade-off matching the
 * existing fingerprint UI.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Total order over the two canonical hex strings, by UTF-16 code unit.
 *
 * Deliberately NOT String.localeCompare: that is locale-dependent, so two
 * clients with different language settings could order the same key pair
 * differently, hash a different canonical string, and display two safety
 * numbers that never match — indistinguishable from a real key mismatch.
 * What this needs is agreement between devices, not alphabetical correctness
 * for a reader. Inputs are lowercase hex ([0-9a-f]), so a code-unit compare is
 * total and identical on every engine and locale.
 *
 * Same reasoning and same three lines as senderKeyProtocol's roster ordering;
 * duplicated rather than imported because that one is a private detail of the
 * channel module and this module must not depend on it.
 */
function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Number of hex characters shown (128 bits), and the group size. */
const DISPLAY_HEX_LENGTH = 32;
const GROUP_SIZE = 4;

/**
 * Renders a hex digest as the displayed safety number: the first 32 hex
 * characters in space-separated groups of 4.
 *
 * Chunked by slicing rather than a regex: for a string with no line
 * terminators — which a hex digest never has — a greedy left-to-right
 * `.{1,4}` global match and this loop produce byte-identical groups,
 * including the short trailing group and the empty-input case. The display
 * form is part of the cross-device determinism contract above, so the
 * grouping must stay a pure function of length, never of locale or engine
 * regex behaviour.
 */
function formatGroups(hexDigest: string): string {
  const shown = hexDigest.slice(0, DISPLAY_HEX_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < shown.length; i += GROUP_SIZE) {
    groups.push(shown.slice(i, i + GROUP_SIZE));
  }
  return groups.join(" ");
}

/**
 * Computes the safety number for a pair of identity public keys.
 *
 * Argument order is irrelevant by construction (see step 2 of the contract
 * above), so both peers pass their own key first and still agree.
 *
 * @param localIdentityKey  This device's identity public key (raw bytes)
 * @param remoteIdentityKey The peer device's pinned identity public key
 * @returns e.g. "1a2b 3c4d 5e6f 7081 92a3 b4c5 d6e7 f809"
 */
export function computeSafetyNumber(
  localIdentityKey: Uint8Array,
  remoteIdentityKey: Uint8Array
): string {
  const canonical = [
    bytesToHex(localIdentityKey),
    bytesToHex(remoteIdentityKey),
  ]
    .sort(compareByCodeUnit)
    .join("\n");

  return formatGroups(bytesToHex(sha256(new TextEncoder().encode(canonical))));
}
