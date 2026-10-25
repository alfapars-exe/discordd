/**
 * ContextMenu — Portal-rendered right-click menu.
 * Auto-adjusts position to stay within viewport.
 * Closes on outside click or Escape.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuState } from "../../hooks/useContextMenu";

type ContextMenuProps = {
  state: ContextMenuState;
  onClose: () => void;
};

function ContextMenu({ state, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  useEffect(() => {
    if (!state.isOpen) return;
    const origin = document.activeElement;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu)?.focus();
    return () => {
      if (origin instanceof HTMLElement && origin.isConnected &&
          (document.activeElement === document.body || menu?.contains(document.activeElement))) origin.focus();
    };
  }, [state.isOpen]);

  useEffect(() => {
    if (openSubmenu === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>(".ctx-submenu button:not(:disabled)")?.focus();
  }, [openSubmenu]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!state.isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape" && !menuRef.current?.contains(e.target as Node)) { e.preventDefault(); e.stopPropagation(); onClose(); }
    }

    // Wait one frame so the right-click event itself isn't caught as "click outside"
    const frame = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [state.isOpen, onClose]);

  // Clamp position to viewport
  useEffect(() => {
    if (!state.isOpen || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = state.x;
    let adjustedY = state.y;

    // Shift left if overflowing right
    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }

    // Shift up if overflowing bottom
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [state.isOpen, state.x, state.y]);

  if (!state.isOpen) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: state.x, top: state.y }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const menu = target.closest<HTMLElement>("[role='menu']");
        if (!menu) return;
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(button => button.closest("[role='menu']") === menu);
        const index = buttons.indexOf(target as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Escape" || (event.key === "ArrowLeft" && openSubmenu !== null)) {
          event.preventDefault(); event.stopPropagation();
          if (openSubmenu !== null) {
            const parent = menuRef.current?.querySelector<HTMLButtonElement>(`[data-submenu-index='${openSubmenu}']`);
            setOpenSubmenu(null); parent?.focus();
          } else onClose();
        } else if (event.key === "ArrowRight" && target.getAttribute("aria-haspopup") === "menu") {
          event.preventDefault(); event.stopPropagation();
          setOpenSubmenu(Number(target.dataset.submenuIndex));
        } else if (event.key === "Tab") {
          onClose();
        }
      }}
    >
      {state.items.map((item, i) => (
        <div
          key={i}
          className="ctx-item-wrap"
          onMouseEnter={() => setOpenSubmenu(item.children?.length ? i : null)}
          onMouseLeave={() => setOpenSubmenu(null)}
        >
          {item.separator && <div className="ctx-separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-submenu-index={i}
            aria-haspopup={item.children?.length ? "menu" : undefined}
            aria-expanded={item.children?.length ? openSubmenu === i : undefined}
            className={`ctx-item${item.danger ? " ctx-danger" : ""}${item.disabled ? " ctx-disabled" : ""}`}
            onClick={() => {
              if (item.children?.length) {
                setOpenSubmenu(openSubmenu === i ? null : i);
                return;
              }
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
          >
            <span>{item.label}</span>
            {item.children?.length ? <span aria-hidden="true">›</span> : null}
          </button>
          {item.children?.length && openSubmenu === i && (
            <div className="ctx-submenu" role="menu" aria-label={item.label}>
              {item.children.map((child, childIndex) => (
                <button
                  key={childIndex}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`ctx-item${child.danger ? " ctx-danger" : ""}${child.disabled ? " ctx-disabled" : ""}`}
                  disabled={child.disabled}
                  onClick={() => {
                    if (child.disabled) return;
                    child.onClick();
                    onClose();
                  }}
                >
                  {child.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body
  );
}

export default ContextMenu;
