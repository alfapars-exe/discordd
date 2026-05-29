/**
 * AdminTable — presentational, generic table shared by the platform-admin
 * lists (users / servers / reports). It owns the toolbar (search + optional
 * extra control + count), the loading/empty states, and the sortable,
 * resizable table; everything list-specific is injected:
 *
 *  - `classPrefix`   → preserves each list's existing CSS namespace
 *                      ("admin-user" / "admin-server" / "admin-report")
 *                      so no stylesheet changes are needed.
 *  - `renderCell`    → per-list cell content (incl. inline editors).
 *  - `toolbarExtra`  → e.g. the reports status filter <select>.
 *  - `children`      → context menu + dialogs, rendered inside the list div.
 *
 * Sort/filter/resize state lives in the caller via the useTableSort /
 * useTableFilter / useColumnResize hooks; this component is pure rendering.
 */

import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import type { ColumnDef, SortDir } from "./adminTableTypes";

type AdminTableProps<T, K extends string> = {
  classPrefix: string;
  columns: readonly ColumnDef<K>[];
  /** Rows already filtered + sorted by the caller. */
  rows: T[];
  /** Unfiltered total, for the "shown / total" count + empty-vs-no-results copy. */
  totalCount: number;
  isLoading: boolean;
  loadingText: string;
  emptyText: string;
  noResultsText: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  toolbarExtra?: ReactNode;
  columnWidths: Record<string, number>;
  onResizeStart: (e: ReactMouseEvent, colKey: string) => void;
  sortKey: K;
  sortDir: SortDir;
  onSort: (key: K) => void;
  getColumnLabel: (col: ColumnDef<K>) => string;
  getRowKey: (row: T) => string;
  getRowClassName?: (row: T) => string;
  onRowContextMenu?: (e: ReactMouseEvent, row: T) => void;
  renderCell: (row: T, colKey: K) => ReactNode;
  children?: ReactNode;
};

function AdminTable<T, K extends string>({
  classPrefix,
  columns,
  rows,
  totalCount,
  isLoading,
  loadingText,
  emptyText,
  noResultsText,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  toolbarExtra,
  columnWidths,
  onResizeStart,
  sortKey,
  sortDir,
  onSort,
  getColumnLabel,
  getRowKey,
  getRowClassName,
  onRowContextMenu,
  renderCell,
  children,
}: AdminTableProps<T, K>) {
  if (isLoading) {
    return (
      <div className={`${classPrefix}-list`}>
        <p className="no-channel">{loadingText}</p>
      </div>
    );
  }

  return (
    <div className={`${classPrefix}-list`}>
      {/* Toolbar: search + optional extra control + count */}
      <div className={`${classPrefix}-toolbar`}>
        <input
          className={`${classPrefix}-search`}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
        />
        {toolbarExtra}
        <span className={`${classPrefix}-count`}>
          {rows.length} / {totalCount}
        </span>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="no-channel">{totalCount === 0 ? emptyText : noResultsText}</p>
      ) : (
        <div className={`${classPrefix}-table-wrap`}>
          <table className={`${classPrefix}-table`}>
            <colgroup>
              {columns.map((col) => (
                <col key={col.key} style={{ width: columnWidths[col.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={col.sortable ? "sortable" : ""}
                    onClick={() => onSort(col.key)}
                  >
                    <div
                      className={`${classPrefix}-th-content`}
                      style={{
                        justifyContent:
                          col.align === "right"
                            ? "flex-end"
                            : col.align === "center"
                              ? "center"
                              : "flex-start",
                      }}
                    >
                      <span>{getColumnLabel(col)}</span>
                      {sortKey === col.key && (
                        <span className={`${classPrefix}-sort-icon`}>
                          {sortDir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </div>
                    {/* Resize handle */}
                    <div
                      className={`${classPrefix}-resize-handle`}
                      onMouseDown={(e) => onResizeStart(e, col.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={getRowKey(row)}
                  className={getRowClassName?.(row) || ""}
                  onContextMenu={
                    onRowContextMenu ? (e) => onRowContextMenu(e, row) : undefined
                  }
                >
                  {columns.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align }}>
                      {renderCell(row, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {children}
    </div>
  );
}

export default AdminTable;
