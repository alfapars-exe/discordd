import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

type ResizableColumn<K extends string> = {
  key: K;
  defaultWidth: number;
  minWidth: number;
};

/**
 * Column-resize state + drag handling for the admin tables. Seeds widths from
 * each column's defaultWidth and drives live resize through document-level
 * mousemove/mouseup listeners attached once on mount.
 *
 * Latest-ref mirrors (widthsRef/columnsRef) let the move handler read current
 * widths and column metadata without re-subscribing every render — writing a
 * ref in the render body would trip react-hooks/refs, so the writes live in a
 * post-commit useLayoutEffect.
 */
export function useColumnResize<K extends string>(
  columns: readonly ResizableColumn<K>[],
): {
  columnWidths: Record<string, number>;
  handleResizeStart: (e: ReactMouseEvent, colKey: string) => void;
} {
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    const widths: Record<string, number> = {};
    for (const col of columns) widths[col.key] = col.defaultWidth;
    return widths;
  });

  const resizingRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);
  const widthsRef = useRef(columnWidths);
  const columnsRef = useRef(columns);
  useLayoutEffect(() => {
    widthsRef.current = columnWidths;
    columnsRef.current = columns;
  });

  const handleResizeStart = useCallback((e: ReactMouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = {
      col: colKey,
      startX: e.clientX,
      startWidth: widthsRef.current[colKey] ?? 100,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      const { col, startX, startWidth } = resizingRef.current;
      const colDef = columnsRef.current.find((c) => c.key === col);
      const minW = colDef?.minWidth ?? 50;
      const newWidth = Math.max(minW, startWidth + (e.clientX - startX));
      setColumnWidths((prev) => ({ ...prev, [col]: newWidth }));
    }

    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return { columnWidths, handleResizeStart };
}
