/**
 * useChannelTreeMenus — Category + channel context-menu builders for the
 * channel tree sidebar.
 *
 * Owns the two ContextMenu states. The component wires `openCategoryMenu` /
 * `openChannelMenu` into row onContextMenu handlers and renders `menusJsx`
 * (the two portal-rendered ContextMenu instances).
 *
 * Side-effectful collaborators (rename starters, confirm dialog, toasts,
 * modal setters) are threaded in via args — the hook reads no stores itself.
 *
 * Was previously inline in ChannelTree.tsx.
 */

import { useTranslation } from "react-i18next";
import ContextMenu from "../components/shared/ContextMenu";
import { useContextMenu, type ContextMenuItem } from "./useContextMenu";
import * as channelApi from "../api/channels";
import type { useConfirm } from "./useConfirm";
import type { UseChannelInlineRenameResult } from "./useChannelInlineRename";
import type { Channel } from "../types";

type UseChannelTreeMenusArgs = {
  /** MANAGE_CHANNELS — gates the rename/permissions/delete items. */
  canManageChannels: boolean;
  activeServerId: string | null;
  /** Muted text channel ids (channel store). */
  mutedChannelIds: Set<string>;
  unmuteChannel: (channelId: string) => Promise<boolean>;
  addToast: (type: "success" | "error", message: string) => void;
  confirmDialog: ReturnType<typeof useConfirm>;
  /** Inline rename starters (useChannelInlineRename). */
  rename: Pick<UseChannelInlineRenameResult, "startCategoryRename" | "startChannelRename">;
  /** Opens the channel permission modal. */
  setPermModalChannel: (channel: Channel | null) => void;
  /** Opens the channel mute duration picker at the click position. */
  setChannelMutePicker: (picker: { channelId: string; x: number; y: number } | null) => void;
};

export function useChannelTreeMenus({
  canManageChannels,
  activeServerId,
  mutedChannelIds,
  unmuteChannel,
  addToast,
  confirmDialog,
  rename,
  setPermModalChannel,
  setChannelMutePicker,
}: UseChannelTreeMenusArgs) {
  const { t: tCh } = useTranslation("channels");

  const { menuState: catMenuState, openMenu: openCatMenu, closeMenu: closeCatMenu } = useContextMenu();

  // Channel context menu
  const { menuState: chMenuState, openMenu: openChMenu, closeMenu: closeChMenu } = useContextMenu();

  // ─── Category Context Menu ───

  function handleCategoryContextMenu(e: React.MouseEvent, categoryId: string, categoryName: string) {
    if (!canManageChannels) return;

    const items: ContextMenuItem[] = [
      {
        label: tCh("renameCategory"),
        onClick: () => rename.startCategoryRename(categoryId, categoryName),
      },
      {
        label: tCh("deleteCategory"),
        danger: true,
        separator: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: tCh("deleteCategory"),
            message: tCh("deleteCategoryConfirm", { name: categoryName }),
            confirmLabel: tCh("deleteCategory"),
            danger: true,
          });
          if (!ok) return;
          const res = await channelApi.deleteCategory(activeServerId!, categoryId);
          if (res.success) {
            addToast("success", tCh("categoryDeleted"));
          } else {
            addToast("error", tCh("categoryDeleteError"));
          }
        },
      },
    ];

    openCatMenu(e, items);
  }

  // ─── Channel Context Menu ───

  function handleChannelContextMenu(e: React.MouseEvent, ch: Channel) {
    const items: ContextMenuItem[] = [];

    if (canManageChannels) {
      items.push({
        label: tCh("renameChannel"),
        onClick: () => rename.startChannelRename(ch.id, ch.name),
      });
      items.push({
        label: tCh("channelPermissions"),
        onClick: () => setPermModalChannel(ch),
      });
      items.push({
        label: tCh("deleteChannel"),
        danger: true,
        separator: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: tCh("deleteChannel"),
            message: tCh("deleteConfirm", { name: ch.name }),
            confirmLabel: tCh("deleteChannel"),
            danger: true,
          });
          if (!ok) return;
          const res = await channelApi.deleteChannel(activeServerId!, ch.id);
          if (res.success) {
            addToast("success", tCh("channelDeleted"));
          } else {
            addToast("error", tCh("channelDeleteError"));
          }
        },
      });
    }

    // Mute/unmute — text channels only
    if (ch.type === "text") {
      const isMuted = mutedChannelIds.has(ch.id);
      items.push({
        label: isMuted ? tCh("unmuteChannel") : tCh("muteChannel"),
        separator: items.length > 0,
        onClick: async () => {
          if (isMuted) {
            const ok = await unmuteChannel(ch.id);
            if (ok) addToast("success", tCh("channelUnmuted"));
          } else {
            setChannelMutePicker({ channelId: ch.id, x: e.clientX, y: e.clientY });
          }
        },
      });
    }

    if (items.length === 0) return;
    openChMenu(e, items);
  }

  const menusJsx = (
    <>
      {/* Category Context Menu */}
      <ContextMenu state={catMenuState} onClose={closeCatMenu} />

      {/* Channel Context Menu */}
      <ContextMenu state={chMenuState} onClose={closeChMenu} />
    </>
  );

  return {
    openCategoryMenu: handleCategoryContextMenu,
    openChannelMenu: handleChannelContextMenu,
    menusJsx,
  };
}
