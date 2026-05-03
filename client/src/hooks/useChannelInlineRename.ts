/**
 * useChannelInlineRename — Inline rename state machine for the channel tree.
 *
 * Single responsibility: own the "click rename → typing → submit/cancel"
 * flow for both categories and channels, plus the emoji picker that opens
 * next to the input. The component just spreads `inputProps` onto its
 * input and calls `submitCategory()` / `submitChannel()` on enter.
 *
 * Mutually exclusive: starting a category rename automatically closes any
 * pending channel rename (and vice-versa). Same goes for the emoji picker.
 *
 * Closes the emoji picker on sidebar scroll because it lives in a portal —
 * its absolute position would otherwise drift off the rename button.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseChannelInlineRenameArgs {
  serverId: string | null;
  /** Persists a category rename. Returns success → toasts handled by caller. */
  saveCategory: (id: string, name: string) => Promise<{ success: boolean }>;
  /** Persists a channel rename. */
  saveChannel: (id: string, name: string) => Promise<{ success: boolean }>;
  /** Toast on success / failure — keeps copy/i18n in the caller. */
  onCategoryResult: (ok: boolean) => void;
  onChannelResult: (ok: boolean) => void;
  /** Hard cap on emoji input length so users can't paste a 1000-char string. */
  maxEmojiLength?: number;
}

export interface UseChannelInlineRenameResult {
  /** Currently renamed category id, or null. */
  renamingCategoryId: string | null;
  /** Currently renamed channel id, or null. */
  renamingChannelId: string | null;
  /** Live input value. */
  renameValue: string;
  /** Whether the emoji picker is open. */
  showRenameEmoji: boolean;
  /** Picker portal position (null when closed). */
  emojiPickerPos: { top: number; left: number } | null;
  /** Ref attached to the "open emoji" button so we can compute picker position. */
  renameEmojiBtnRef: React.RefObject<HTMLButtonElement | null>;

  /** Begin renaming a category — opens its inline input prefilled with name. */
  startCategoryRename: (id: string, name: string) => void;
  /** Begin renaming a channel. */
  startChannelRename: (id: string, name: string) => void;

  /** Update the input value (typing). */
  setRenameValue: (v: string) => void;
  /** Insert an emoji into the value, capped by maxEmojiLength. */
  insertEmoji: (emoji: string) => void;

  /** Persist the category rename. Closes input + picker. */
  submitCategory: () => Promise<void>;
  /** Persist the channel rename. */
  submitChannel: () => Promise<void>;
  /** Discard typing and close everything. */
  cancel: () => void;

  /** Toggle the emoji picker — auto-positions next to the button. */
  toggleEmojiPicker: () => void;
  /** Close just the emoji picker (rename input stays open). */
  closeEmojiPicker: () => void;
}

export function useChannelInlineRename(
  args: UseChannelInlineRenameArgs,
): UseChannelInlineRenameResult {
  const { serverId, saveCategory, saveChannel, onCategoryResult, onChannelResult, maxEmojiLength = 50 } = args;

  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showRenameEmoji, setShowRenameEmoji] = useState(false);
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ top: number; left: number } | null>(null);
  const renameEmojiBtnRef = useRef<HTMLButtonElement | null>(null);

  // Close emoji picker on sidebar scroll — portal absolute position would
  // otherwise drift away from the button anchor.
  useEffect(() => {
    if (!showRenameEmoji) return;
    const handleScroll = () => setShowRenameEmoji(false);
    const tree = document.querySelector(".ch-tree");
    tree?.addEventListener("scroll", handleScroll);
    return () => tree?.removeEventListener("scroll", handleScroll);
  }, [showRenameEmoji]);

  const startCategoryRename = useCallback((id: string, name: string) => {
    setShowRenameEmoji(false);
    setRenamingChannelId(null);
    setRenamingCategoryId(id);
    setRenameValue(name);
  }, []);

  const startChannelRename = useCallback((id: string, name: string) => {
    setShowRenameEmoji(false);
    setRenamingCategoryId(null);
    setRenamingChannelId(id);
    setRenameValue(name);
  }, []);

  const cancel = useCallback(() => {
    setShowRenameEmoji(false);
    setRenamingCategoryId(null);
    setRenamingChannelId(null);
  }, []);

  const submitCategory = useCallback(async () => {
    const id = renamingCategoryId;
    const name = renameValue.trim();
    setShowRenameEmoji(false);
    setRenamingCategoryId(null);
    if (!id || !name || !serverId) return;
    const res = await saveCategory(id, name);
    onCategoryResult(res.success);
  }, [renamingCategoryId, renameValue, serverId, saveCategory, onCategoryResult]);

  const submitChannel = useCallback(async () => {
    const id = renamingChannelId;
    const name = renameValue.trim();
    setShowRenameEmoji(false);
    setRenamingChannelId(null);
    if (!id || !name || !serverId) return;
    const res = await saveChannel(id, name);
    onChannelResult(res.success);
  }, [renamingChannelId, renameValue, serverId, saveChannel, onChannelResult]);

  const toggleEmojiPicker = useCallback(() => {
    setShowRenameEmoji((prev) => {
      const next = !prev;
      if (next && renameEmojiBtnRef.current) {
        const rect = renameEmojiBtnRef.current.getBoundingClientRect();
        setEmojiPickerPos({ top: rect.top, left: rect.right + 6 });
      }
      return next;
    });
  }, []);

  const closeEmojiPicker = useCallback(() => setShowRenameEmoji(false), []);

  const insertEmoji = useCallback(
    (emoji: string) => {
      setRenameValue((prev) => {
        const next = prev + emoji;
        // Count code points (emojis are multi-codepoint), not UTF-16 units
        return [...next].length <= maxEmojiLength ? next : prev;
      });
      setShowRenameEmoji(false);
    },
    [maxEmojiLength],
  );

  return {
    renamingCategoryId,
    renamingChannelId,
    renameValue,
    showRenameEmoji,
    emojiPickerPos,
    renameEmojiBtnRef,
    startCategoryRename,
    startChannelRename,
    setRenameValue,
    insertEmoji,
    submitCategory,
    submitChannel,
    cancel,
    toggleEmojiPicker,
    closeEmojiPicker,
  };
}
