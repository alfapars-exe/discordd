/**
 * DropZoneOverlay — Visual drop zones shown during tab drag.
 *
 * Pure visual (pointer-events: none). All drag events are handled
 * by the parent PanelView which passes activeZone as a prop.
 *
 * The DropZone type + calculateZone helper used to live in this file
 * but were extracted to ./dropZone.ts so this module exports only the
 * component — required for react-refresh/only-export-components
 * (Vite's Fast Refresh boundary must be component-pure).
 */

import type { DropZone } from "./dropZone";

type DropZoneOverlayProps = {
  activeZone: DropZone | null;
};

const ZONES: DropZone[] = ["left", "right", "top", "bottom", "center"];

function DropZoneOverlay({ activeZone }: DropZoneOverlayProps) {
  if (!activeZone) return null;

  return (
    <div className="drop-zone-overlay active">
      {ZONES.map((zone) => (
        <div
          key={zone}
          className={`drop-zone drop-zone-${zone}${activeZone === zone ? " highlight" : ""}`}
        />
      ))}
    </div>
  );
}

export default DropZoneOverlay;
