/**
 * validation — runtime guards for values that cross the trust boundary
 * (localStorage, URL params, server JSON shape checks).
 *
 * TypeScript's `as X` cast lies confidently. It says "trust me, this
 * is an X" with zero runtime check. That's fine for narrowing inside
 * a function where you control the value, but on data crossing a
 * boundary (localStorage written by an older app version, JSON.parse
 * of a server response, URL query strings) it's a silent crash waiting
 * to happen. These helpers do the cheapest possible runtime check —
 * "is this value in the allowed set?" — and return a typed `T` if
 * yes, fallback if no.
 *
 * Intentionally small surface. We don't ship zod / io-ts because the
 * boundaries that genuinely need runtime validation are few (~5
 * sites), and a 50-byte string-set check is enough. If the boundaries
 * grow past a dozen, reach for zod.
 */

/**
 * Narrow an unknown value to one of a fixed set of string literals.
 * Returns the value typed as T if it matches, otherwise the fallback.
 *
 * Example:
 *   const allowed = ["online", "idle", "dnd", "offline"] as const;
 *   const status = oneOf<UserStatus>(rawValue, allowed, "online");
 *   // status is typed as UserStatus, never undefined
 *
 * Use this AT THE BOUNDARY (localStorage read, URL param parse, JSON
 * field check) — once narrowed, downstream code can rely on the type.
 */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Check that a parsed JSON object has the expected required keys.
 * Returns true if `value` is a non-null object containing every name
 * in `requiredKeys`. Doesn't validate the value TYPES of those keys —
 * call sites should check critical fields individually after.
 *
 * Pairs well with `JSON.parse` output for "did this come from the
 * shape we expect?" checks before casting.
 */
export function hasKeys<K extends string>(
  value: unknown,
  requiredKeys: readonly K[],
): value is Record<K, unknown> {
  if (!value || typeof value !== "object") return false;
  for (const k of requiredKeys) {
    if (!(k in value)) return false;
  }
  return true;
}
