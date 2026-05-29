/**
 * Shared types for the platform-admin tables. Each list defines its own
 * `SortKey` union and a `ColumnDef<SortKey>[]`; the generic keeps column
 * keys type-checked against that list's sortable fields.
 */

export type SortDir = "asc" | "desc";

export type ColumnAlign = "left" | "center" | "right";

export type ColumnDef<K extends string> = {
  key: K;
  labelKey: string;
  defaultWidth: number;
  minWidth: number;
  sortable: boolean;
  align: ColumnAlign;
};

/** Seed a width map from each column's defaultWidth. */
export function getDefaultWidths<K extends string>(
  columns: readonly ColumnDef<K>[],
): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col.key] = col.defaultWidth;
  }
  return widths;
}
