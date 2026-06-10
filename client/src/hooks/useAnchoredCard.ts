/**
 * useAnchoredCard — positioning + dismissal plumbing for an anchored
 * popover card (MemberCard). Clamps the requested position into the
 * viewport (8px padding) and closes on outside mousedown. While a child
 * modal is open (`childModalOpen`), the click-outside handler is
 * suppressed so clicks inside the modal don't dismiss the card under it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useAnchoredCard(
  position: { top: number; left: number },
  onClose: () => void,
  childModalOpen: boolean
) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

  const childModalOpenRef = useRef(false);
  // Mirror the open-child-modal state into a ref so the click-outside
  // handler (registered once in useEffect) can read the latest value
  // without re-subscribing on every state change. useLayoutEffect runs
  // synchronously after commit but before paint, so the ref is fresh
  // by the time any pointer event fires.
  useLayoutEffect(() => {
    childModalOpenRef.current = childModalOpen;
  });

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const pad = 8;
    let { top, left } = position;

    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - rect.width - pad;
    }

    if (top !== position.top || left !== position.left) {
      setAdjustedPos({ top, left });
    }
  }, [position]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (childModalOpenRef.current) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    const frameId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  return { cardRef, adjustedPos };
}
