/**
 * StickerMessage — a whole-message `<sticker:…>` token rendered as a large
 * image (Faz D2, D2-20). Clicking it opens ExpressionInfoPopover.
 */

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import StickerImage from "../shared/StickerImage";
import ExpressionInfoPopover from "./ExpressionInfoPopover";
import type { PopoverAnchor } from "../inbox/PopoverShell";

type StickerMessageProps = { id: string; name: string; animated: boolean };

function StickerMessage({ id, name, animated }: StickerMessageProps) {
  const { t } = useTranslation("expressions");
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  return (
    <>
      <button
        type="button"
        className="msg-sticker-btn"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={t("stickerAlt", { name })}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((prev) => (prev ? null : { rect, placement: "below" }));
        }}
      >
        <StickerImage id={id} name={name} animated={animated} size="message" />
      </button>
      {anchor && (
        <ExpressionInfoPopover
          kind="sticker"
          id={id}
          name={name}
          animated={animated}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

export default memo(StickerMessage);
