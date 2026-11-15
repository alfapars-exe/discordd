/**
 * useMessageEditing — Encapsulates a single message's edit-mode state.
 *
 * Single responsibility: own all editing concerns of one message —
 *   - edit toggle (isEditing)
 *   - draft content (editContent)
 *   - mention autocomplete query + selection tracking
 *   - convert resolved mentions back to <@id>/<@&id> tokens on save
 *
 * The component just gets back a small ref-and-handler bag and pipes
 * them into the textarea + autocomplete + Enter/Escape handlers.
 * No JSX here — pure state machine.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { MentionSelection } from "../components/chat/MentionAutocomplete";

export interface UseMessageEditingArgs {
  /** Initial content of the message being edited. */
  initialContent: string | null;
  /**
   * Saves the edited body upstream — called only when content actually
   * changed. Return value is ignored; we just await it for ordering.
   */
  saveEdit: (newContent: string) => unknown;
}

export interface UseMessageEditingResult {
  /** Whether the textarea is currently shown. */
  isEditing: boolean;
  /** Current draft text in the textarea. */
  editContent: string;
  /** Active mention autocomplete query — null when no @ trigger active. */
  editMentionQuery: string | null;
  /** Ref attached to the textarea for cursor placement. */
  editTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Enter edit mode — typically wired to "Edit" menu item. */
  startEdit: () => void;
  /** Save current draft via saveEdit, then leave edit mode. */
  saveAndExit: () => Promise<void>;
  /** Discard draft and leave edit mode. */
  cancel: () => void;
  /** onChange handler for the textarea — also drives mention detection. */
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Called when the user picks a mention in the autocomplete dropdown. */
  onMentionSelect: (mention: MentionSelection) => void;
  /** Closes the mention dropdown without picking anything. */
  closeMentionAutocomplete: () => void;
}

export function useMessageEditing(args: UseMessageEditingArgs): UseMessageEditingResult {
  const { initialContent, saveEdit } = args;

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(initialContent ?? "");
  const [editMentionQuery, setEditMentionQuery] = useState<string | null>(null);
  const [mentionCaret, setMentionCaret] = useState<{ position: number } | null>(null);
  const editGenerationRef = useRef(0);

  const editMentionStartRef = useRef<number>(-1);
  const editMentionSelectionsRef = useRef<MentionSelection[]>([]);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // The conditional textarea ref is attached before layout effects run.
  // Initialize its caret before paint/user input, rather than queuing a frame
  // that can overwrite a later select-all or pointer selection.
  useLayoutEffect(() => {
    if (!isEditing) return;
    const ta = editTextareaRef.current;
    if (!ta) return;
    const end = ta.value.length;
    ta.focus();
    ta.setSelectionRange(end, end);
  }, [isEditing]);

  useLayoutEffect(() => {
    if (!isEditing || !mentionCaret) return;
    const ta = editTextareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(mentionCaret.position, mentionCaret.position);
  }, [isEditing, mentionCaret]);

  const startEdit = useCallback(() => {
    editGenerationRef.current++;
    editMentionSelectionsRef.current = [];
    editMentionStartRef.current = -1;
    setEditMentionQuery(null);
    setMentionCaret(null);
    setEditContent(initialContent ?? "");
    setIsEditing(true);
  }, [initialContent]);

  const cancel = useCallback(() => {
    editGenerationRef.current++;
    editMentionSelectionsRef.current = [];
    editMentionStartRef.current = -1;
    setMentionCaret(null);
    setEditContent(initialContent ?? "");
    setEditMentionQuery(null);
    setIsEditing(false);
  }, [initialContent]);

  const closeMentionAutocomplete = useCallback(() => {
    setEditMentionQuery(null);
    editMentionStartRef.current = -1;
  }, []);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setEditContent(value);

    // Detect a mention trigger: an @ that follows whitespace or is at line start.
    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex < 0) {
      setEditMentionQuery(null);
      return;
    }
    const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
    if (charBeforeAt !== " " && charBeforeAt !== "\n" && atIndex !== 0) {
      setEditMentionQuery(null);
      return;
    }
    const query = textBeforeCursor.slice(atIndex + 1);
    if (query.includes("\n")) {
      setEditMentionQuery(null);
      return;
    }
    editMentionStartRef.current = atIndex;
    setEditMentionQuery(query);
  }, []);

  const onMentionSelect = useCallback((mention: MentionSelection) => {
    const start = editMentionStartRef.current;
    if (start < 0) return;

    editMentionSelectionsRef.current.push(mention);

    const cursorPos = editTextareaRef.current?.selectionStart;
    const displayText = `@${mention.name}`;
    setMentionCaret({ position: start + displayText.length + 1 });
    setEditContent((current) => {
      const before = current.slice(0, start);
      const after = current.slice(cursorPos ?? current.length);
      const newContent = `${before}${displayText} ${after}`;


      return newContent;
    });
    setEditMentionQuery(null);
    editMentionStartRef.current = -1;
  }, []);

  /** Convert resolved @name tokens back to <@id>/<@&id> structured form for storage. */
  const tokenize = useCallback((text: string): string => {
    let result = text;
    // Sort longest-name-first so substrings don't shadow longer names
    const sorted = [...editMentionSelectionsRef.current].sort(
      (a, b) => b.name.length - a.name.length,
    );
    for (const m of sorted) {
      const token = m.type === "role" ? `<@&${m.id}>` : `<@${m.id}>`;
      const escaped = m.name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      result = result.replaceAll(new RegExp(`@${escaped}`, "gi"), token);
    }
    return result;
  }, []);

  const saveAndExit = useCallback(async () => {
    // trimEnd only — trim() also stripped leading whitespace, which the
    // user may have typed intentionally (e.g. indented continuation,
    // leading bullet, or a space after a mention prefix).
    const generation = editGenerationRef.current;
    const tokenized = tokenize(editContent.trimEnd());
    if (tokenized && tokenized !== (initialContent ?? "")) {
      await saveEdit(tokenized);
    }
    if (editGenerationRef.current !== generation) return;
    editGenerationRef.current++;
    editMentionSelectionsRef.current = [];
    editMentionStartRef.current = -1;
    setEditMentionQuery(null);
    setMentionCaret(null);
    setIsEditing(false);
  }, [editContent, initialContent, saveEdit, tokenize]);

  return {
    isEditing,
    editContent,
    editMentionQuery,
    editTextareaRef,
    startEdit,
    saveAndExit,
    cancel,
    onChange,
    onMentionSelect,
    closeMentionAutocomplete,
  };
}
