/**
 * ChannelTree — Collapsible tree with Friends, DMs, and Server sections.
 * Friends and DM sections are extracted into their own components.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { hasPermission, Permissions, resolveChannelPermissions } from "../../utils/permissions";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useMobileStore } from "../../stores/mobileStore";
import FriendsSection from "./FriendsSection";
import DMSection from "./DMSection";
import ServerList from "./ServerList";
import AdminSection from "./AdminSection";
import CategoryItem from "./CategoryItem";
import ChannelItem from "./ChannelItem";
import VoiceParticipantList from "./VoiceParticipantList";
import ChannelTreeOverlays from "./ChannelTreeOverlays";
import { useConfirm } from "../../hooks/useConfirm";
import { useChannelInlineRename } from "../../hooks/useChannelInlineRename";
import { useChannelTreeDragDrop } from "../../hooks/useChannelTreeDragDrop";
import { useChannelTreeMenus } from "../../hooks/useChannelTreeMenus";
import * as channelApi from "../../api/channels";
import type { Channel, PublicUser } from "../../types";

type ChannelTreeProps = {
  onJoinVoice: (channelId: string) => void;
};

function ChannelTree({ onJoinVoice }: ChannelTreeProps) {
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const mutedServerIds = useServerStore((s) => s.mutedServerIds);

  const confirmDialog = useConfirm();

  // User profile card state (shared between sections)
  const [userCardTarget, setUserCardTarget] = useState<{
    user: PublicUser;
    top: number;
    left: number;
  } | null>(null);

  // Mute duration picker state
  const [mutePicker, setMutePicker] = useState<{
    serverId: string;
    x: number;
    y: number;
  } | null>(null);

  // Invite Friends modal state
  const [inviteTarget, setInviteTarget] = useState<{
    serverId: string;
    serverName: string;
  } | null>(null);

  // Channel mute duration picker state
  const [channelMutePicker, setChannelMutePicker] = useState<{
    channelId: string;
    x: number;
    y: number;
  } | null>(null);

  // Inline rename state machine — hook owns ids, value, and emoji picker portal.
  const rename = useChannelInlineRename({
    serverId: activeServerId,
    saveCategory: (id, name) => channelApi.updateCategory(activeServerId!, id, { name }),
    saveChannel: (id, name) => channelApi.updateChannel(activeServerId!, id, { name }),
    onCategoryResult: (ok) =>
      ok ? addToast("success", tCh("categoryUpdated")) : addToast("error", tCh("categoryUpdateError")),
    onChannelResult: (ok) =>
      ok ? addToast("success", tCh("channelUpdated")) : addToast("error", tCh("channelUpdateError")),
  });

  // Channel permission modal state
  const [permModalChannel, setPermModalChannel] = useState<Channel | null>(null);

  // Add Server modal state
  const [showAddServer, setShowAddServer] = useState(false);

  const openTab = useUIStore((s) => s.openTab);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);

  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const addToast = useToastStore((s) => s.addToast);
  const mutedChannelIds = useChannelStore((s) => s.mutedChannelIds);
  const unmuteChannel = useChannelStore((s) => s.unmuteChannel);
  const { t: tCh } = useTranslation("channels");

  // MANAGE_CHANNELS permission
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageChannels = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageChannels)
    : false;

  // MOVE_MEMBERS permission (voice user drag & drop)
  const canMoveMembers = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.MoveMembers)
    : false;

  // ─── Context Menus ───
  // Category + channel context-menu builders — the hook owns both menu
  // states and renders the two ContextMenu instances via `menusJsx`.
  const { openCategoryMenu, openChannelMenu, menusJsx } = useChannelTreeMenus({
    canManageChannels,
    activeServerId,
    mutedChannelIds,
    unmuteChannel,
    addToast,
    confirmDialog,
    rename,
    setPermModalChannel,
    setChannelMutePicker,
  });

  // Channel permission overrides for ConnectVoice check
  const overridesByChannel = useChannelPermissionStore((s) => s.overridesByChannel);
  const fetchOverridesForChannels = useChannelPermissionStore((s) => s.fetchOverridesForChannels);

  // Fetch overrides for all voice channels when categories change
  useEffect(() => {
    const voiceChannelIds: string[] = [];
    for (const cg of categories) {
      for (const ch of cg.channels) {
        if (ch.type === "voice") voiceChannelIds.push(ch.id);
      }
    }
    if (voiceChannelIds.length > 0) {
      fetchOverridesForChannels(voiceChannelIds);
    }
  }, [categories, fetchOverridesForChannels]);

  /** Check if current user can connect to a voice channel (considering overrides) */
  const canConnectVoice = useCallback(
    (channelId: string): boolean => {
      if (!currentMember) return false;
      const basePerms = currentMember.effective_permissions;
      const roleIds = currentMember.roles.map((r) => r.id);
      const overrides = overridesByChannel[channelId] ?? [];
      const effective = resolveChannelPermissions(basePerms, roleIds, overrides);
      return (effective & Permissions.ConnectVoice) !== 0;
    },
    [currentMember, overridesByChannel]
  );

  // ─── Voice User Context Menu State ───
  const [voiceCtxMenu, setVoiceCtxMenu] = useState<{
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    x: number;
    y: number;
  } | null>(null);

  // ─── Create Channel/Category Modal State ───
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModalMode, setCreateModalMode] = useState<"category" | "channel" | undefined>(undefined);
  const [createModalCategoryId, setCreateModalCategoryId] = useState<string | undefined>(undefined);

  // ─── Drag & Drop ───
  // All three DnD concerns (channel reorder, category reorder, voice user
  // move) live in one hook because they share drop targets and need to be
  // dispatched off shared refs.
  const {
    dropIndicator,
    catDropIndicator,
    draggingVoiceUserId,
    voiceDropTargetId,
    isChannelDragging,
    handleCatDragStart,
    handleCatDragEnd,
    handleCatRowDragOver,
    handleCatRowDrop,
    handleCatDragLeave,
    handleChannelDragStart,
    handleChannelDragEnd,
    handleChannelDragOver,
    handleChannelDragLeave,
    handleChannelDrop,
    handleVoiceUserDragStart,
    handleVoiceUserDragEnd,
  } = useChannelTreeDragDrop({ canConnectVoice });

  // ─── Handlers ───

  /** Active server info for tab display */
  function getActiveServerInfo(): TabServerInfo | undefined {
    if (!activeServerId) return undefined;
    const srv = servers.find((s) => s.id === activeServerId);
    if (!srv) return undefined;
    return { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
  }

  function handleTextChannelClick(channelId: string, channelName: string, channelType: "text" | "audit" = "text") {
    selectChannel(channelId);
    // Text and audit channels both reach this handler (they're "chat-like"
    // — see ChannelItem click path). The TabType differs though: AuditChannel
    // is rendered when type==="audit", ChatArea when type==="text". Passing
    // a hardcoded "text" here would silently open audit channels as text
    // channels — exactly the bug that caused "denetim alanı çalışmıyor".
    openTab(channelId, channelType, channelName, getActiveServerInfo());
    closeAllDrawers();
  }

  function handleVoiceChannelClick(channelId: string, channelName: string) {
    onJoinVoice(channelId);
    openTab(channelId, "voice", channelName, getActiveServerInfo());
    closeAllDrawers();
  }

  // Callback for FriendsSection / DMSection to show user profile card
  const handleShowUserCard = useCallback((user: PublicUser, top: number, left: number) => {
    setUserCardTarget({ user, top, left });
  }, []);

  return (
    <div className="ch-tree">
      <FriendsSection onShowUserCard={handleShowUserCard} />
      <DMSection onShowUserCard={handleShowUserCard} />
      <AdminSection />

      <ServerList
        onAddServer={() => setShowAddServer(true)}
        onCreateChannel={() => {
          setCreateModalMode(undefined);
          setCreateModalCategoryId(undefined);
          setShowCreateModal(true);
        }}
        onInviteServer={(serverId, serverName) => setInviteTarget({ serverId, serverName })}
        onMuteServer={(serverId, x, y) => setMutePicker({ serverId, x, y })}
        renderServerBody={(srvId) => (
          <>
            {canManageChannels &&
              categories.length > 0 && !categories.some((c) => c.category.id === "") && (
              <div
                className="ch-tree-uncat-drop"
                onDragOver={(e) => handleCatRowDragOver(e, "")}
                onDrop={(e) => handleCatRowDrop(e, "")}
              />
            )}

            {categories.map((cg) => {
                    const isUncategorized = cg.category.id === "";
                    const catKey = isUncategorized ? "cat:__uncategorized__" : `cat:${cg.category.id}`;
                    const catExpanded = isUncategorized ? true : isSectionExpanded(catKey);
                    const catId = cg.category.id;
                    const catDropClass =
                      catDropIndicator?.categoryId === catId && catDropIndicator.position === "above" ? " cat-drop-above"
                      : catDropIndicator?.categoryId === catId && catDropIndicator.position === "below" ? " cat-drop-below"
                      : "";

                    return (
                      <CategoryItem
                        key={catId || "__uncategorized__"}
                        category={cg.category}
                        isUncategorized={isUncategorized}
                        expanded={catExpanded}
                        canManageChannels={canManageChannels}
                        onToggle={() => toggleSection(catKey)}
                        onContextMenu={(e) => openCategoryMenu(e, catId, cg.category.name)}
                        onCreateChannel={() => {
                          setCreateModalMode("channel");
                          setCreateModalCategoryId(catId);
                          setShowCreateModal(true);
                        }}
                        catDropClass={catDropClass}
                        onCatDragStart={(e) => handleCatDragStart(e, catId)}
                        onCatRowDragOver={(e) => handleCatRowDragOver(e, catId)}
                        onCatDragLeave={handleCatDragLeave}
                        onCatRowDrop={(e) => handleCatRowDrop(e, catId)}
                        onCatDragEnd={handleCatDragEnd}
                        onUncatDragOver={(e) => handleCatRowDragOver(e, "")}
                        onUncatDrop={(e) => handleCatRowDrop(e, "")}
                        isRenaming={rename.renamingCategoryId === catId}
                        renameValue={rename.renameValue}
                        onRenameChange={rename.setRenameValue}
                        onRenameSubmit={rename.submitCategory}
                        onRenameCancel={rename.cancel}
                        showRenameEmoji={rename.showRenameEmoji}
                        renameEmojiBtnRef={rename.renameEmojiBtnRef}
                        onOpenRenameEmoji={rename.toggleEmojiPicker}
                      >
                        {cg.channels.map((ch) => {
                    // Chat-like = text OR audit; both render chat-style content
                    // and use `selectedChannelId` for active state. Only the
                    // literal "voice" type tracks `currentVoiceChannelId` and
                    // gates on canConnectVoice.
                    const isVoice = ch.type === "voice";
                    const chActive = isVoice
                      ? ch.id === currentVoiceChannelId
                      : ch.id === selectedChannelId;
                    const unread = unreadCounts[ch.id] ?? 0;
                    const participants = voiceStates[ch.id] ?? [];
                    const isServerMuted = mutedServerIds.has(srvId);
                    const isChannelMuted = mutedChannelIds.has(ch.id);
                    const isEffectivelyMuted = isServerMuted || isChannelMuted;
                    const isVoiceLocked = isVoice && !canConnectVoice(ch.id);

                    return (
                      <ChannelItem
                        key={ch.id}
                        channel={ch}
                        isActive={chActive}
                        unread={unread}
                        isEffectivelyMuted={isEffectivelyMuted}
                        isVoiceLocked={isVoiceLocked}
                        voiceDropTarget={voiceDropTargetId === ch.id}
                        canManageChannels={canManageChannels}
                        isDragging={isChannelDragging(ch.id)}
                        dropPos={dropIndicator?.channelId === ch.id ? dropIndicator.position : null}
                        onClick={() => {
                          if (isVoiceLocked) return;
                          if (isVoice) {
                            handleVoiceChannelClick(ch.id, ch.name);
                          } else {
                            // text + audit both reach the chat-like handler,
                            // but they need different TabType so the right
                            // component renders (ChatArea vs AuditChannel).
                            handleTextChannelClick(
                              ch.id,
                              ch.name,
                              ch.type === "audit" ? "audit" : "text",
                            );
                          }
                        }}
                        onContextMenu={(e) => openChannelMenu(e, ch)}
                        onDragStart={() => handleChannelDragStart(ch.id, cg.category.id)}
                        onDragOver={(e) => handleChannelDragOver(e, ch.id, ch.type, cg.category.id)}
                        onDragLeave={handleChannelDragLeave}
                        onDrop={(e) => handleChannelDrop(e, ch.id, cg.category.id)}
                        onDragEnd={handleChannelDragEnd}
                        isRenaming={rename.renamingChannelId === ch.id}
                        renameValue={rename.renameValue}
                        onRenameChange={rename.setRenameValue}
                        onRenameSubmit={rename.submitChannel}
                        onRenameCancel={rename.cancel}
                        showRenameEmoji={rename.showRenameEmoji}
                        renameEmojiBtnRef={rename.renameEmojiBtnRef}
                        onOpenRenameEmoji={rename.toggleEmojiPicker}
                      >
                        {isVoice && participants.length > 0 && (
                          <VoiceParticipantList
                            participants={participants}
                            channelId={ch.id}
                            channelName={ch.name}
                            canMoveMembers={canMoveMembers}
                            draggingVoiceUserId={draggingVoiceUserId}
                            onDragStart={handleVoiceUserDragStart}
                            onDragEnd={handleVoiceUserDragEnd}
                            onContextMenu={setVoiceCtxMenu}
                            onShowUserCard={handleShowUserCard}
                            getActiveServerInfo={getActiveServerInfo}
                          />
                        )}
                      </ChannelItem>
                    );
                  })}
                </CategoryItem>
              );
            })}
          </>
        )}
      />

      <ChannelTreeOverlays
        showAddServer={showAddServer}
        setShowAddServer={setShowAddServer}
        userCardTarget={userCardTarget}
        setUserCardTarget={setUserCardTarget}
        mutePicker={mutePicker}
        setMutePicker={setMutePicker}
        inviteTarget={inviteTarget}
        setInviteTarget={setInviteTarget}
        voiceCtxMenu={voiceCtxMenu}
        setVoiceCtxMenu={setVoiceCtxMenu}
        showCreateModal={showCreateModal}
        setShowCreateModal={setShowCreateModal}
        createModalMode={createModalMode}
        createModalCategoryId={createModalCategoryId}
        channelMutePicker={channelMutePicker}
        setChannelMutePicker={setChannelMutePicker}
        permModalChannel={permModalChannel}
        setPermModalChannel={setPermModalChannel}
        rename={rename}
      />

      {/* Category + Channel Context Menus */}
      {menusJsx}
    </div>
  );
}

export default ChannelTree;
