/**
 * ChannelTreeOverlays — Overlay/modal layer for the channel tree.
 *
 * Consolidates every conditional overlay that used to sit at the bottom
 * of ChannelTree: modals, duration pickers, the member profile card, the
 * voice user context menu, and the rename emoji picker portal.
 * ChannelTree owns all the state — this component only renders it.
 */

import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import VoiceUserContextMenu from "../voice/VoiceUserContextMenu";
import MuteDurationPicker from "../servers/MuteDurationPicker";
import MemberCard from "../members/MemberCard";
import InviteFriendsModal from "../servers/InviteFriendsModal";
import AddServerModal from "../servers/AddServerModal";
import CreateChannelModal from "../channels/CreateChannelModal";
import ChannelMuteDurationPicker from "../channels/ChannelMuteDurationPicker";
import ChannelPermissionEditor from "../settings/ChannelPermissionEditor";
import Modal from "../shared/Modal";
import EmojiPicker from "../shared/EmojiPicker";
import type { UseChannelInlineRenameResult } from "../../hooks/useChannelInlineRename";
import type { Channel, PublicUser } from "../../types";

type UserCardTarget = { user: PublicUser; top: number; left: number };
type MutePickerTarget = { serverId: string; x: number; y: number };
type InviteTarget = { serverId: string; serverName: string };
type VoiceCtxMenuTarget = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  x: number;
  y: number;
};
type ChannelMutePickerTarget = { channelId: string; x: number; y: number };

type ChannelTreeOverlaysProps = {
  // Add Server modal
  showAddServer: boolean;
  setShowAddServer: (open: boolean) => void;
  // User profile card (shared between FriendsSection / DMSection / voice participants)
  userCardTarget: UserCardTarget | null;
  setUserCardTarget: (target: UserCardTarget | null) => void;
  // Server mute duration picker
  mutePicker: MutePickerTarget | null;
  setMutePicker: (picker: MutePickerTarget | null) => void;
  // Invite Friends modal
  inviteTarget: InviteTarget | null;
  setInviteTarget: (target: InviteTarget | null) => void;
  // Voice user context menu
  voiceCtxMenu: VoiceCtxMenuTarget | null;
  setVoiceCtxMenu: (menu: VoiceCtxMenuTarget | null) => void;
  // Create Channel/Category modal
  showCreateModal: boolean;
  setShowCreateModal: (open: boolean) => void;
  createModalMode: "category" | "channel" | undefined;
  createModalCategoryId: string | undefined;
  // Channel mute duration picker
  channelMutePicker: ChannelMutePickerTarget | null;
  setChannelMutePicker: (picker: ChannelMutePickerTarget | null) => void;
  // Channel permission modal
  permModalChannel: Channel | null;
  setPermModalChannel: (channel: Channel | null) => void;
  /** Inline rename hook result — drives the emoji picker portal. */
  rename: UseChannelInlineRenameResult;
};

function ChannelTreeOverlays({
  showAddServer,
  setShowAddServer,
  userCardTarget,
  setUserCardTarget,
  mutePicker,
  setMutePicker,
  inviteTarget,
  setInviteTarget,
  voiceCtxMenu,
  setVoiceCtxMenu,
  showCreateModal,
  setShowCreateModal,
  createModalMode,
  createModalCategoryId,
  channelMutePicker,
  setChannelMutePicker,
  permModalChannel,
  setPermModalChannel,
  rename,
}: ChannelTreeOverlaysProps) {
  const { t: tCh } = useTranslation("channels");

  return (
    <>
      {/* Add Server Modal */}
      {showAddServer && (
        <AddServerModal
          onClose={() => setShowAddServer(false)}
        />
      )}

      {/* User Profile Card (shared between FriendsSection / DMSection / voice participants) */}
      {userCardTarget && (
        <MemberCard
          user={userCardTarget.user}
          position={{ top: userCardTarget.top, left: userCardTarget.left }}
          onClose={() => setUserCardTarget(null)}
        />
      )}

      {/* Mute Duration Picker */}
      {mutePicker && (
        <MuteDurationPicker
          serverId={mutePicker.serverId}
          x={mutePicker.x}
          y={mutePicker.y}
          onClose={() => setMutePicker(null)}
        />
      )}

      {/* Invite Friends Modal */}
      {inviteTarget && (
        <InviteFriendsModal
          serverId={inviteTarget.serverId}
          serverName={inviteTarget.serverName}
          onClose={() => setInviteTarget(null)}
        />
      )}

      {/* Voice User Context Menu */}
      {voiceCtxMenu && (
        <VoiceUserContextMenu
          userId={voiceCtxMenu.userId}
          username={voiceCtxMenu.username}
          displayName={voiceCtxMenu.displayName}
          avatarUrl={voiceCtxMenu.avatarUrl}
          position={{ x: voiceCtxMenu.x, y: voiceCtxMenu.y }}
          onClose={() => setVoiceCtxMenu(null)}
        />
      )}

      {/* Create Channel/Category Modal */}
      {showCreateModal && (
        <CreateChannelModal
          onClose={() => setShowCreateModal(false)}
          defaultMode={createModalMode}
          defaultCategoryId={createModalCategoryId}
        />
      )}

      {/* Channel Mute Duration Picker */}
      {channelMutePicker && (
        <ChannelMuteDurationPicker
          channelId={channelMutePicker.channelId}
          x={channelMutePicker.x}
          y={channelMutePicker.y}
          onClose={() => setChannelMutePicker(null)}
        />
      )}

      {/* Channel Permission Modal */}
      {permModalChannel && (
        <Modal
          isOpen
          onClose={() => setPermModalChannel(null)}
          title={tCh("channelPermissions")}
        >
          <ChannelPermissionEditor channel={permModalChannel} />
        </Modal>
      )}

      {/* Emoji picker — portaled to body to escape sidebar overflow:hidden */}
      {rename.showRenameEmoji && rename.emojiPickerPos && createPortal(
        <div
          className="ch-tree-rename-picker-portal"
          style={{ position: "fixed", top: rename.emojiPickerPos.top, left: rename.emojiPickerPos.left, zIndex: 9999 }}
        >
          <EmojiPicker
            onSelect={rename.insertEmoji}
            onClose={rename.closeEmojiPicker}
          />
        </div>,
        document.body
      )}
    </>
  );
}

export default ChannelTreeOverlays;
