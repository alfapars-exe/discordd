/**
 * ExpressionCloneSection — "Copy from your other servers" block under the
 * Emojis / Stickers settings tabs (Faz D2, D2-22b).
 *
 * Lists copyable, non-clone items from the viewer's OTHER member servers and
 * clones one into `serverId` (the active server). Rendered only with
 * ManageExpressions on that server; items already cloned there show a
 * "copied" badge. UX only — the server re-checks every clone gate.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEmojiCatalog } from "../../hooks/useEmojiCatalog";
import { useStickerCatalog } from "../../hooks/useStickerCatalog";
import { useExpressionClone } from "../../hooks/useExpressionClone";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { alreadyCloned } from "../../utils/expressionClone";
import { hasPermission, Permissions } from "../../utils/permissions";
import type { ExpressionKind } from "../../types/expression";
import CustomEmoji from "../shared/CustomEmoji";
import StickerImage from "../shared/StickerImage";
import "../../styles/expressions.css";

type ExpressionCloneSectionProps = {
  kind: ExpressionKind;
  serverId: string;
};

type Row = {
  id: string;
  name: string;
  display_name: string;
  animated: boolean;
};

type Source = Row & { copyable: boolean; cloned_from: string | null };

type Group = { id: string; name: string; items: Row[] };

function ExpressionCloneSection({ kind, serverId }: ExpressionCloneSectionProps) {
  const { t } = useTranslation("expressions");
  const userId = useAuthStore((s) => s.user?.id);
  const members = useActiveMembers();
  const perms = members.find((m) => m.id === userId)?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageExpressions);

  const emojiCatalog = useEmojiCatalog(canManage && kind === "emoji");
  const stickerCatalog = useStickerCatalog(canManage && kind === "sticker");
  const clone = useExpressionClone();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const { groups, existing } = useMemo(() => {
    const out: Group[] = [];
    const servers: { id: string; name: string; items: Source[] }[] =
      kind === "emoji"
        ? emojiCatalog.servers.map((s) => ({ id: s.id, name: s.name, items: s.emojis }))
        : stickerCatalog.servers.map((s) => ({ id: s.id, name: s.name, items: s.stickers }));
    let target: Source[] = [];
    for (const s of servers) {
      if (s.id === serverId) {
        target = s.items;
        continue;
      }
      const items = s.items.filter((i) => i.copyable && i.cloned_from === null);
      if (items.length > 0) out.push({ id: s.id, name: s.name, items });
    }
    return { groups: out, existing: target };
  }, [kind, serverId, emojiCatalog.servers, stickerCatalog.servers]);

  if (!canManage) return null;

  const handleCopy = async (sourceId: string) => {
    if (pendingId) return;
    setPendingId(sourceId);
    await clone(kind, serverId, sourceId);
    setPendingId(null);
  };

  return (
    <div className="expression-clone-section">
      <h3 className="expression-clone-title">{t("copyFromServers")}</h3>
      <p className="emoji-settings-hint">{t("copyFromServersHint")}</p>
      {groups.length === 0 ? (
        <p className="expression-clone-empty">{kind === "sticker" ? t("noStickers") : t("noEmojis")}</p>
      ) : (
        groups.map((g) => (
          <section key={g.id} className="expression-clone-group">
            <h4 className="expression-clone-server">{g.name}</h4>
            <div className="emoji-settings-list">
              {g.items.map((item) => {
                const done = alreadyCloned(item.id, existing);
                return (
                  <div key={item.id} className="emoji-settings-row">
                    {kind === "sticker" ? (
                      <StickerImage id={item.id} name={item.name} animated={item.animated} still size="settings" />
                    ) : (
                      <CustomEmoji id={item.id} name={item.name} animated={item.animated} still />
                    )}
                    <div className="emoji-settings-names">
                      <span className="emoji-settings-display">{item.display_name}</span>
                      <span className="emoji-settings-code">:{item.name}:</span>
                    </div>
                    {done ? (
                      <span className="emoji-settings-badge">{t("copied")}</span>
                    ) : (
                      <button
                        type="button"
                        className="settings-btn settings-btn-secondary"
                        disabled={pendingId !== null}
                        onClick={() => void handleCopy(item.id)}
                      >
                        {t("copy")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export default ExpressionCloneSection;
