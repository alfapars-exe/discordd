/**
 * VolumeSlider — range input with local drag state and frame-capped commits.
 *
 * Raw onChange on a range input fires per pointer move; routing every event
 * straight into a zustand setter re-rendered the whole settings panel (and,
 * pre-debounce, did a synchronous localStorage write) per pixel, making the
 * drag feel sticky. The thumb now tracks LOCAL state instantly while store
 * commits are throttled to one per animation frame, with a final commit on
 * release/blur so the last position is never lost.
 */

import { useEffect, useRef, useState } from "react";

/** Inline gradient for slider filled portion (Chrome lacks ::-moz-range-progress). */
function sliderTrackStyle(value: number, max: number): React.CSSProperties {
  const pct = (value / max) * 100;
  return {
    background: `linear-gradient(to right, var(--primary) ${pct}%, var(--bg-5) ${pct}%)`,
  };
}

type VolumeSliderProps = {
  value: number;
  min?: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Formats the value label; defaults to percent. */
  format?: (value: number) => string;
  ariaLabel?: string;
};

function VolumeSlider({
  value,
  min = 0,
  max,
  step = 1,
  onChange,
  format,
  ariaLabel,
}: VolumeSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef(value);

  // External updates (server sync, reset) win when the user isn't dragging.
  useEffect(() => {
    if (!draggingRef.current) setLocalValue(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const commitThrottled = (next: number) => {
    latestRef.current = next;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      onChange(latestRef.current);
    });
  };

  const commitFinal = () => {
    draggingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    onChange(latestRef.current);
  };

  return (
    <div className="vs-slider-row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocalValue(next);
          commitThrottled(next);
        }}
        onPointerUp={commitFinal}
        onBlur={commitFinal}
        className="vs-range"
        style={sliderTrackStyle(localValue, max)}
        aria-label={ariaLabel}
      />
      <span className="vs-slider-value">
        {format ? format(localValue) : `${localValue}%`}
      </span>
    </div>
  );
}

export default VolumeSlider;
