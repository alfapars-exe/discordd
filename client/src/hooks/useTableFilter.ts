import { useMemo } from "react";

/**
 * Filters rows by a normalized (trimmed + lowercased) search query using a
 * caller-supplied predicate. Returns the original array reference unchanged
 * when the query is blank — matching the pre-refactor behaviour where an
 * empty search short-circuited before allocating a new array.
 *
 * The predicate must be stable (module-level fn or useCallback) to avoid
 * recomputing every render.
 */
export function useTableFilter<T>(
  rows: T[],
  query: string,
  predicate: (row: T, normalizedQuery: string) => boolean,
): T[] {
  return useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter((row) => predicate(row, q));
  }, [rows, query, predicate]);
}
