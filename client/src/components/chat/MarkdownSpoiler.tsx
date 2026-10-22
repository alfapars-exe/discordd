/**
 * MarkdownSpoiler — `||hidden||` content (Faz D1, Sözleşme §9).
 *
 * Closed: content is aria-hidden, visually hidden (images too) and not
 * clickable, so a link or emoji inside can't be triggered or read before
 * the viewer opts in. Opens on click / Enter / Space; stays open.
 */

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type MarkdownSpoilerProps = { children: ReactNode };

function MarkdownSpoiler({ children }: MarkdownSpoilerProps) {
  const { t } = useTranslation("expressions");
  const [revealed, setRevealed] = useState(false);

  const reveal = () => setRevealed(true);

  const handleClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (revealed) return;
    e.preventDefault();
    e.stopPropagation();
    reveal();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (revealed) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      reveal();
    }
  };

  return (
    <span
      className="msg-spoiler"
      data-revealed={revealed ? "true" : undefined}
      role="button"
      tabIndex={revealed ? -1 : 0}
      aria-expanded={revealed}
      aria-label={revealed ? undefined : t("spoilerReveal")}
      title={revealed ? undefined : t("spoiler")}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* inert while closed: links / InviteCard buttons inside are neither
          focusable nor clickable until the viewer reveals the spoiler. */}
      <span
        className="msg-spoiler-content"
        aria-hidden={revealed ? undefined : true}
        inert={!revealed}
      >
        {children}
      </span>
    </span>
  );
}

export default MarkdownSpoiler;
