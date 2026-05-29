/**
 * Regression tests for the admin-table hooks extracted from the three
 * platform-admin lists. They lock the behaviours most likely to break in a
 * structural extraction: sort toggling, non-sortable no-ops, the empty-query
 * short-circuit, and resize min-clamping + drag lifecycle.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTableSort } from "./useTableSort";
import { useTableFilter } from "./useTableFilter";
import { useColumnResize } from "./useColumnResize";
import { useNowTick } from "./useNowTick";
import type { SortDir } from "../components/settings/adminTableTypes";

type Row = { id: string; n: number; m: number };

const SORT_COLS = [
  { key: "n" as const, sortable: true },
  { key: "m" as const, sortable: true },
  { key: "id" as const, sortable: false },
];
type SortKey = "n" | "m" | "id";

function cmp(a: Row, b: Row, key: SortKey, dir: SortDir): number {
  let r = 0;
  if (key === "n") r = a.n - b.n;
  else if (key === "m") r = a.m - b.m;
  else r = a.id.localeCompare(b.id);
  return dir === "desc" ? -r : r;
}

const ROWS: Row[] = [
  { id: "a", n: 3, m: 10 },
  { id: "b", n: 1, m: 30 },
  { id: "c", n: 2, m: 20 },
];

describe("useTableSort", () => {
  it("sorts by the initial key ascending without mutating the source", () => {
    const { result } = renderHook(() => useTableSort(ROWS, SORT_COLS, cmp, "n", "asc"));
    expect(result.current.sortedRows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(ROWS.map((r) => r.n)).toEqual([3, 1, 2]); // source untouched
  });

  it("toggles asc -> desc when the same column is clicked", () => {
    const { result } = renderHook(() => useTableSort(ROWS, SORT_COLS, cmp, "n", "asc"));
    act(() => result.current.handleSort("n"));
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.sortedRows.map((r) => r.n)).toEqual([3, 2, 1]);
  });

  it("resets to asc when a different sortable column is clicked", () => {
    const { result } = renderHook(() => useTableSort(ROWS, SORT_COLS, cmp, "n", "desc"));
    act(() => result.current.handleSort("m"));
    expect(result.current.sortKey).toBe("m");
    expect(result.current.sortDir).toBe("asc");
  });

  it("ignores clicks on non-sortable columns", () => {
    const { result } = renderHook(() => useTableSort(ROWS, SORT_COLS, cmp, "n", "asc"));
    act(() => result.current.handleSort("id"));
    expect(result.current.sortKey).toBe("n");
    expect(result.current.sortDir).toBe("asc");
  });
});

describe("useTableFilter", () => {
  const predicate = (r: Row, q: string) => r.id.includes(q);

  it("returns the same array reference for a blank query", () => {
    const { result } = renderHook(() => useTableFilter(ROWS, "   ", predicate));
    expect(result.current).toBe(ROWS);
  });

  it("filters via the predicate against the normalized query", () => {
    const { result } = renderHook(() => useTableFilter(ROWS, " B ", predicate));
    expect(result.current.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("useColumnResize", () => {
  const RCOLS = [
    { key: "a" as const, defaultWidth: 100, minWidth: 60 },
    { key: "b" as const, defaultWidth: 200, minWidth: 80 },
  ];
  const fakeEvent = (clientX: number) =>
    ({ preventDefault() {}, stopPropagation() {}, clientX }) as unknown as ReactMouseEvent;

  it("seeds widths from defaultWidth", () => {
    const { result } = renderHook(() => useColumnResize(RCOLS));
    expect(result.current.columnWidths).toEqual({ a: 100, b: 200 });
  });

  it("resizes relative to the drag start and clamps to minWidth", () => {
    const { result } = renderHook(() => useColumnResize(RCOLS));

    act(() => result.current.handleResizeStart(fakeEvent(0), "a"));
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 }));
    });
    expect(result.current.columnWidths.a).toBe(150);

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: -1000 }));
    });
    expect(result.current.columnWidths.a).toBe(60); // clamped to minWidth

    // mouseup ends the drag — further movement is a no-op
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 9999 }));
    });
    expect(result.current.columnWidths.a).toBe(60);
  });
});

describe("useNowTick", () => {
  it("advances the snapshot on the interval", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useNowTick(1000));
      const first = result.current;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
