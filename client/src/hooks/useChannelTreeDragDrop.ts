/**
 * useChannelTreeDragDrop — owns the three drag-and-drop concerns of the
 * channel tree sidebar:
 *
 *   1. Channel reorder (within a category and across categories)
 *   2. Category reorder
 *   3. Voice user move (admin/moderator drags a member between voice
 *      channels — emits voice_move_user via the WebSocket)
 *
 * These three are coupled because they share the same drop targets:
 *   - Channel rows accept either a channel reorder OR a voice user move.
 *   - Category headers accept either a category reorder OR a channel
 *     drop (move a channel into that category).
 *
 * The multiplexed handlers (`handleChannelDragOver`, `handleChannelDrop`,
 * etc.) inspect which kind of drag is in flight via the relevant ref and
 * dispatch accordingly. Trying to split this into separate hooks per
 * concern would break the multiplexing — each row would need three
 * separate listeners and the dispatch logic would still have to live
 * somewhere.
 *
 * Returned object:
 *   - `state`: visual cues (dropIndicator, catDropIndicator,
 *     voiceDropTargetId, draggingVoiceUserId) — read by render functions
 *     to highlight rows and show insertion lines.
 *   - `isChannelDragging(id)`: convenience check the row uses to apply
 *     a fade class while it's the source of a drag.
 *   - `channelHandlers` / `catHandlers` / `voiceUserHandlers`: bind into
 *     onDrag* props on the appropriate elements.
 *
 * The hook reads `categories` from the channel store and uses
 * `reorderChannels` / `reorderCategories` actions plus the voice
 * `_wsSend` to commit moves. Errors raise a toast via `useToastStore`.
 *
 * Was previously ~350 lines spread across ChannelTree.tsx.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useChannelStore } from "../stores/channelStore";
import { useToastStore } from "../stores/toastStore";
import { useVoiceStore } from "../stores/voiceStore";

type DropPosition = "above" | "below";
type ChannelDropIndicator = { channelId: string; position: DropPosition } | null;
type CatDropIndicator = { categoryId: string; position: DropPosition } | null;

type Options = {
  /**
   * Whether the current user has the MoveMembers permission AND can
   * connect to the target voice channel. The hook calls this before
   * accepting a voice-user drop.
   */
  canConnectVoice: (channelId: string) => boolean;
};

export function useChannelTreeDragDrop({ canConnectVoice }: Options) {
  const { t: tCh } = useTranslation("channels");
  const categories = useChannelStore((s) => s.categories);
  const reorderChannels = useChannelStore((s) => s.reorderChannels);
  const reorderCategories = useChannelStore((s) => s.reorderCategories);
  const wsSend = useVoiceStore((s) => s._wsSend);
  const addToast = useToastStore((s) => s.addToast);

  // ─── Channel reorder state ───
  const dragChannelIdRef = useRef<string | null>(null);
  const dragCategoryIdRef = useRef<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<ChannelDropIndicator>(null);

  // ─── Category reorder state ───
  const dragCatReorderIdRef = useRef<string | null>(null);
  const [catDropIndicator, setCatDropIndicator] = useState<CatDropIndicator>(null);

  // ─── Voice-user move state ───
  const dragVoiceUserIdRef = useRef<string | null>(null);
  const dragVoiceSourceChannelRef = useRef<string | null>(null);
  const [draggingVoiceUserId, setDraggingVoiceUserId] = useState<string | null>(null);
  const [voiceDropTargetId, setVoiceDropTargetId] = useState<string | null>(null);

  function reportReorderError() {
    addToast("error", tCh("reorderError"));
  }

  // ─── Category handlers ───────────────────────────────────────────

  const handleCatDragStart = useCallback(
    (e: React.DragEvent, categoryId: string) => {
      e.stopPropagation();
      dragCatReorderIdRef.current = categoryId;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/category", categoryId);
    },
    [],
  );

  const handleCatDragOver = useCallback(
    (e: React.DragEvent, categoryId: string) => {
      if (!dragCatReorderIdRef.current) return;
      if (dragCatReorderIdRef.current === categoryId) {
        e.preventDefault();
        setCatDropIndicator(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos: DropPosition = e.clientY < midY ? "above" : "below";
      setCatDropIndicator({ categoryId, position: pos });
    },
    [],
  );

  const handleCatDragLeave = useCallback(() => {
    setCatDropIndicator(null);
  }, []);

  const handleCatDrop = useCallback(
    (e: React.DragEvent, targetCategoryId: string) => {
      e.preventDefault();
      setCatDropIndicator(null);

      const dragId = dragCatReorderIdRef.current;
      dragCatReorderIdRef.current = null;
      if (!dragId || dragId === targetCategoryId) return;

      const named = categories.filter((cg) => cg.category.id !== "");
      const dragIdx = named.findIndex((cg) => cg.category.id === dragId);
      const targetIdx = named.findIndex((cg) => cg.category.id === targetCategoryId);
      if (dragIdx === -1 || targetIdx === -1) return;

      const ordered = [...named];
      const [dragged] = ordered.splice(dragIdx, 1);

      let insertIdx = ordered.findIndex((cg) => cg.category.id === targetCategoryId);
      if (insertIdx === -1) insertIdx = ordered.length;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY >= midY) insertIdx += 1;

      ordered.splice(insertIdx, 0, dragged);

      const items = ordered.map((cg, idx) => ({
        id: cg.category.id,
        position: idx,
      }));
      reorderCategories(items).then((ok) => {
        if (!ok) reportReorderError();
      });
    },
    // reportReorderError closes over addToast/tCh; categories changes drive resorts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, reorderCategories],
  );

  const handleCatDragEnd = useCallback(() => {
    dragCatReorderIdRef.current = null;
    setCatDropIndicator(null);
  }, []);

  // ─── Channel-into-category-header handlers ───────────────────────

  const handleCategoryHeaderDragOver = useCallback((e: React.DragEvent) => {
    if (!dragChannelIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleCategoryHeaderDrop = useCallback(
    (e: React.DragEvent, targetCategoryId: string) => {
      e.preventDefault();
      setDropIndicator(null);

      const dragId = dragChannelIdRef.current;
      const dragCatId = dragCategoryIdRef.current;
      dragChannelIdRef.current = null;
      dragCategoryIdRef.current = null;

      if (!dragId) return;
      if (dragCatId === targetCategoryId) return;

      const sourceCat = categories.find((c) => c.category.id === dragCatId);
      if (!sourceCat) return;

      const draggedChannel = sourceCat.channels.find((ch) => ch.id === dragId);
      if (!draggedChannel) return;

      const targetCat = categories.find((c) => c.category.id === targetCategoryId);

      const items: { id: string; position: number; category_id?: string }[] = [];

      sourceCat.channels
        .filter((ch) => ch.id !== dragId)
        .forEach((ch, idx) => items.push({ id: ch.id, position: idx }));

      const targetChannels = targetCat?.channels ?? [];
      targetChannels.forEach((ch, idx) => items.push({ id: ch.id, position: idx }));
      items.push({
        id: dragId,
        position: targetChannels.length,
        category_id: targetCategoryId,
      });

      reorderChannels(items).then((ok) => {
        if (!ok) reportReorderError();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, reorderChannels],
  );

  // Multiplexed: a category header row accepts either a channel drop OR
  // a category reorder.
  const handleCatRowDragOver = useCallback(
    (e: React.DragEvent, categoryId: string) => {
      if (dragCatReorderIdRef.current) {
        handleCatDragOver(e, categoryId);
      } else {
        handleCategoryHeaderDragOver(e);
      }
    },
    [handleCatDragOver, handleCategoryHeaderDragOver],
  );

  const handleCatRowDrop = useCallback(
    (e: React.DragEvent, categoryId: string) => {
      if (dragCatReorderIdRef.current) {
        handleCatDrop(e, categoryId);
      } else {
        handleCategoryHeaderDrop(e, categoryId);
      }
    },
    [handleCatDrop, handleCategoryHeaderDrop],
  );

  // ─── Channel reorder handlers ────────────────────────────────────

  const handleChannelDragStart = useCallback(
    (channelId: string, categoryId: string) => {
      dragChannelIdRef.current = channelId;
      dragCategoryIdRef.current = categoryId;
    },
    [],
  );

  const handleChannelDragEnd = useCallback(() => {
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;
    setDropIndicator(null);
  }, []);

  function applyChannelReorderDragOver(e: React.DragEvent, channelId: string) {
    if (dragChannelIdRef.current === channelId) {
      e.preventDefault();
      setDropIndicator(null);
      return;
    }
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: DropPosition = e.clientY < midY ? "above" : "below";
    setDropIndicator({ channelId, position: pos });
  }

  function applyChannelReorderDrop(
    e: React.DragEvent,
    targetChannelId: string,
    categoryId: string,
  ) {
    e.preventDefault();
    setDropIndicator(null);

    const dragId = dragChannelIdRef.current;
    const dragCatId = dragCategoryIdRef.current;
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;

    if (!dragId || dragId === targetChannelId) return;

    const isCrossCategory = dragCatId !== categoryId;

    if (isCrossCategory) {
      const sourceCat = categories.find((c) => c.category.id === dragCatId);
      const targetCat = categories.find((c) => c.category.id === categoryId);
      if (!sourceCat || !targetCat) return;

      const draggedChannel = sourceCat.channels.find((ch) => ch.id === dragId);
      if (!draggedChannel) return;

      const targetOrdered = [...targetCat.channels];
      let insertIdx = targetOrdered.findIndex((ch) => ch.id === targetChannelId);
      if (insertIdx === -1) insertIdx = targetOrdered.length;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY >= midY) insertIdx += 1;

      targetOrdered.splice(insertIdx, 0, draggedChannel);

      const items: { id: string; position: number; category_id?: string }[] = [];
      sourceCat.channels
        .filter((ch) => ch.id !== dragId)
        .forEach((ch, idx) => items.push({ id: ch.id, position: idx }));

      targetOrdered.forEach((ch, idx) => {
        if (ch.id === dragId) {
          items.push({ id: ch.id, position: idx, category_id: categoryId });
        } else {
          items.push({ id: ch.id, position: idx });
        }
      });

      reorderChannels(items).then((ok) => {
        if (!ok) reportReorderError();
      });
      return;
    }

    // Same-category reorder
    const cat = categories.find((c) => c.category.id === categoryId);
    if (!cat) return;

    const ordered = [...cat.channels];
    const dragIdx = ordered.findIndex((ch) => ch.id === dragId);
    const targetIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [dragged] = ordered.splice(dragIdx, 1);

    let insertIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
    if (insertIdx === -1) insertIdx = ordered.length;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    const items = ordered.map((ch, idx) => ({ id: ch.id, position: idx }));
    reorderChannels(items).then((ok) => {
      if (!ok) reportReorderError();
    });
  }

  // ─── Voice-user move handlers ────────────────────────────────────

  const handleVoiceUserDragStart = useCallback(
    (e: React.DragEvent, userId: string, channelId: string) => {
      // stopPropagation prevents conflict with channel reorder drag.
      e.stopPropagation();
      dragVoiceUserIdRef.current = userId;
      dragVoiceSourceChannelRef.current = channelId;
      setDraggingVoiceUserId(userId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/voice-user", userId);
    },
    [],
  );

  const handleVoiceUserDragEnd = useCallback(() => {
    dragVoiceUserIdRef.current = null;
    dragVoiceSourceChannelRef.current = null;
    setDraggingVoiceUserId(null);
    setVoiceDropTargetId(null);
  }, []);

  // ─── Multiplexed channel-row handlers ────────────────────────────

  const handleChannelDragOver = useCallback(
    (e: React.DragEvent, channelId: string, channelType: string, categoryId: string) => {
      if (dragVoiceUserIdRef.current) {
        // Block drop on non-voice, same channel, or where mover lacks
        // ConnectVoice on the target.
        if (
          channelType !== "voice" ||
          dragVoiceSourceChannelRef.current === channelId ||
          !canConnectVoice(channelId)
        ) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setVoiceDropTargetId(channelId);
        return;
      }
      applyChannelReorderDragOver(e, channelId);
      // categoryId is used only by drop, kept in signature for symmetry.
      void categoryId;
    },
    [canConnectVoice],
  );

  const handleChannelDragLeave = useCallback((e: React.DragEvent) => {
    if (dragVoiceUserIdRef.current) {
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      setVoiceDropTargetId(null);
      return;
    }
    setDropIndicator(null);
  }, []);

  const handleChannelDrop = useCallback(
    (e: React.DragEvent, targetChannelId: string, categoryId: string) => {
      if (dragVoiceUserIdRef.current) {
        e.preventDefault();
        const targetUserId = dragVoiceUserIdRef.current;
        dragVoiceUserIdRef.current = null;
        dragVoiceSourceChannelRef.current = null;
        setDraggingVoiceUserId(null);
        setVoiceDropTargetId(null);
        wsSend?.("voice_move_user", {
          target_user_id: targetUserId,
          target_channel_id: targetChannelId,
        });
        return;
      }
      applyChannelReorderDrop(e, targetChannelId, categoryId);
    },
    // applyChannelReorderDrop reads `categories`/`reorderChannels` via closure
    // — stable identities aren't required for drop handlers, but we still
    // recompute on those changes so the latest state is captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, reorderChannels, wsSend],
  );

  const isChannelDragging = useCallback(
    (channelId: string) => dragChannelIdRef.current === channelId,
    [],
  );

  return {
    // Visual state
    dropIndicator,
    catDropIndicator,
    draggingVoiceUserId,
    voiceDropTargetId,
    isChannelDragging,

    // Category handlers (bind to category header rows)
    handleCatDragStart,
    handleCatDragEnd,
    handleCatRowDragOver,
    handleCatRowDrop,
    handleCatDragLeave,

    // Channel row handlers (bind to channel rows)
    handleChannelDragStart,
    handleChannelDragEnd,
    handleChannelDragOver,
    handleChannelDragLeave,
    handleChannelDrop,

    // Voice user handlers (bind to voice participant rows)
    handleVoiceUserDragStart,
    handleVoiceUserDragEnd,
  };
}
