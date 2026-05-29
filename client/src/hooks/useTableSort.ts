import { useState, useMemo, useCallback } from "react";
import type { SortDir } from "../components/settings/adminTableTypes";

type SortableColumn<K extends string> = { key: K; sortable: boolean };

/**
 * Sortable-table state. Clicking a sortable column toggles asc/desc; picking
 * a different column resets to asc. Non-sortable columns are ignored. Sorting
 * runs on a copy via the caller-supplied comparator, so the source array is
 * never mutated.
 *
 * `columns` and `comparator` should be stable references (module-level) so
 * the memo and the toggle callback stay cheap.
 */
export function useTableSort<T, K extends string>(
  rows: T[],
  columns: readonly SortableColumn<K>[],
  comparator: (a: T, b: T, key: K, dir: SortDir) => number,
  initialKey: K,
  initialDir: SortDir = "asc",
): { sortKey: K; sortDir: SortDir; sortedRows: T[]; handleSort: (key: K) => void } {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => comparator(a, b, sortKey, sortDir)),
    [rows, comparator, sortKey, sortDir],
  );

  const handleSort = useCallback(
    (key: K) => {
      const col = columns.find((c) => c.key === key);
      if (!col?.sortable) return;
      if (sortKey === key) {
        setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [columns, sortKey],
  );

  return { sortKey, sortDir, sortedRows, handleSort };
}
