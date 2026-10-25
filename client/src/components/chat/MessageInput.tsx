/** MessageInput — Message compose area. Works in both channel and DM via ChatContext. */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useConversationCommand } from "../../hooks/useConversationCommand";
import { useFocusComposerOnTyping } from "../../hooks/useFocusComposerOnTyping";
import { useMusicSlashCommand } from "../../hooks/useMusicSlashCommand";
import { useAttachmentRejectionToast } from "../../hooks/useAttachmentRejectionToast";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useNowTick } from "../../hooks/useNowTick";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import { composerKey, EMPTY_DRAFT, useComposerDraftStore } from "../../stores/composerDraftStore";
import { validateFiles } from "../../utils/fileValidation";
import { MAX_MESSAGE_LENGTH, MAX_FILES } from "../../utils/constants";
import { convertMentionTokens } from "../../utils/mention";
import {
  convertEmojiShortcodes,
  parseCustomEmojiToken,
  type CustomEmojiRef,
} from "../../utils/expressionTokens";
import { getMemberEmojiCatalog } from "../../hooks/useEmojiCatalog";
import { formatRelativeFuture } from "../../utils/dateFormat";
import EmojiPicker from "../shared/EmojiPicker";
import GifPicker from "../shared/GifPicker";
import StickerPicker from "../shared/StickerPicker";
import FilePreview from "./FilePreview";
import MentionAutocomplete, { type MentionSelection } from "./MentionAutocomplete";
import EmojiAutocomplete from "./EmojiAutocomplete";
import ReplyBar from "./ReplyBar";

function MessageInput() {
  const { t, i18n } = useTranslation("chat");
  const reportRejections = useAttachmentRejectionToast();
  const addToast = useToastStore((s) => s.addToast);
  const legacyComposer = useAccessibilityStore((s) => s.legacyComposer);
  // On a touch device, calling textarea.focus() summons the soft keyboard
  // uninvited (channel switch, reply, post-send restore). Gate every
  // programmatic focus below on !isTouch so mobile users decide when the
  // keyboard shows up.
  const isTouch = useIsTouch();
  const {
    mode,
    channelId,
    channelName,
    serverId,
    canSend,
    sendMessage,
    replyingTo,
    setReplyingTo,
    sendTyping,
    addFilesRef,
    selfTimeoutExpiresAt,
  } = useChatContext();
  // Refreshes the "ends in X" countdown in the timeout banner — same
  // shared-ticker pattern as MemberList's offline "last seen" labels.
  const nowTick = useNowTick(30_000);

  const accountId = useAuthStore((s) => s.user?.id);
  const draftKey = composerKey(accountId, mode, channelId, serverId);
  const draft = useComposerDraftStore((s) => s.drafts[draftKey] ?? EMPTY_DRAFT);
  const { content, files } = draft;
  const isSending = draft.sending !== null;
  const setContent = useCallback((value: string) => {
    useComposerDraftStore.getState().patch(draftKey, { content: value });
  }, [draftKey]);
  const setFiles = useCallback((update: File[] | ((previous: File[]) => File[])) => {
    const store = useComposerDraftStore.getState();
    const previous = store.drafts[draftKey]?.files ?? [];
    store.patch(draftKey, { files: typeof update === "function" ? update(previous) : update });
  }, [draftKey]);
  const activeDraftKey = useRef<string | null>(null);
  useEffect(() => {
    activeDraftKey.current = draftKey;
    return () => { activeDraftKey.current = null; };
  }, [draftKey]);

  // Emoji picker state
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // GIF picker state
  const [showGifPicker, setShowGifPicker] = useState(false);

  // Sticker picker state (Faz D2)
  const [showStickerPicker, setShowStickerPicker] = useState(false);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** Character index where the @ trigger starts */
  const mentionStartRef = useRef<number>(-1);
  /**
   * Synchronous mirror of "mention popup is actively visible" — read by the
   * Enter handler. mentionQuery (state) lags one render behind the actual
   * popup close in two paths:
   *  1. The popup auto-closes via useEffect when filtered results are empty,
   *     calling onClose() → setMentionQuery(null). React batches that update.
   *  2. handleMentionSelect / handleMentionClose call setMentionQuery(null).
   * If the user presses Enter in that one-tick window, the keydown handler
   * still sees the old non-null mentionQuery and bails before sending —
   * exactly the "first Enter does nothing, second works" symptom. A ref
   * updates synchronously and dodges the race entirely.
   */
  const mentionActiveRef = useRef(false);

  // Custom emoji `:shortcode` autocomplete — same ref-based activity pattern
  // as the mention popup (see mentionActiveRef for the Enter race).
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  /** Character index of the `:` that opened the emoji popup */
  const emojiStartRef = useRef<number>(-1);
  const emojiActiveRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useFocusComposerOnTyping(
    mode === "dm" ? { kind: "dm", id: channelId } : { kind: "channel", id: channelId, serverId: serverId ?? "" },
    textareaRef,
    (key) => {
      const input = textareaRef.current;
      if (!input || activeDraftKey.current !== draftKey) return false;
      const store = useComposerDraftStore.getState();
      const current = store.drafts[draftKey] ?? EMPTY_DRAFT;
      if (current.sending) return false;
      const start = Math.min(input.selectionStart, current.content.length);
      const end = Math.min(input.selectionEnd, current.content.length);
      const next = current.content.slice(0, start) + key + current.content.slice(end);
      if (next.length > MAX_MESSAGE_LENGTH) return false;
      store.patch(draftKey, { content: next });
      const generation = store.generation;
      const insertedRevision = useComposerDraftStore.getState().drafts[draftKey]?.revision;
      requestAnimationFrame(() => {
        const latest = useComposerDraftStore.getState().drafts[draftKey];
        if (textareaRef.current === input && input.isConnected && activeDraftKey.current === draftKey &&
            useComposerDraftStore.getState().generation === generation && useAuthStore.getState().user?.id === accountId &&
            latest?.revision === insertedRevision && latest.content === next) {
          input.setSelectionRange(start + key.length, start + key.length);
        }
      });
      return true;
    },
    !isTouch && !isSending && !selfTimeoutExpiresAt,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const togglePicker = (kind: "emoji" | "gif" | "sticker") => {
    if (!canSend || isSending) return false;
    if (kind !== "emoji") setShowEmojiPicker(false);
    if (kind !== "gif") setShowGifPicker(false);
    if (kind !== "sticker") setShowStickerPicker(false);
    if (kind === "emoji") setShowEmojiPicker((value) => !value);
    else if (kind === "gif") setShowGifPicker((value) => !value);
    else setShowStickerPicker((value) => !value);
    return true;
  };
  useConversationCommand({kind:mode === "dm" ? "dm" : "channel",id:channelId,serverId:mode === "dm" ? undefined : serverId}, (command) => {
    if (command === "emoji" || command === "gif" || command === "sticker") return togglePicker(command);
    if (command === "upload" && canSend && !isSending && fileInputRef.current) { fileInputRef.current.click(); return true; }
    return false;
  });

  /**
   * Appends newly-selected files while enforcing MAX_FILES (server:
   * LimitedParseMultipartFormN n=10 — see the constant's comment). Shared
   * by every add path (file dialog, drag-drop, paste) so the cap can't be
   * bypassed by mixing them. Overflow is silently truncated to the first
   * N slots plus a warning toast, matching the FeedbackCreateForm pattern.
   */
  const addFilesCapped = useCallback(
    (newFiles: File[]) => {
      if (newFiles.length === 0) return;
      setFiles((prev) => {
        const remaining = MAX_FILES - prev.length;
        if (remaining <= 0) {
          addToast("warning", t("tooManyFiles", { max: MAX_FILES }));
          return prev;
        }
        if (newFiles.length > remaining) {
          addToast("warning", t("tooManyFiles", { max: MAX_FILES }));
        }
        return [...prev, ...newFiles.slice(0, remaining)];
      });
    },
    [addToast, t, setFiles]
  );

  // Register callback for drag-drop file forwarding from ChatArea/DMChat
  useEffect(() => {
    addFilesRef.current = addFilesCapped;
    return () => {
      addFilesRef.current = null;
    };
  }, [addFilesRef, addFilesCapped]);

  /** Auto-focus textarea when channel changes or reply is selected */
  useEffect(() => {
    if (isTouch) return;
    textareaRef.current?.focus();
  }, [channelId, isTouch]);

  useEffect(() => {
    if (replyingTo && !isTouch) {
      textareaRef.current?.focus();
    }
  }, [replyingTo, isTouch]);

  /** Send message, passing replyToId if replying */
  const runMusicCommand = useMusicSlashCommand();

  const handleSend = useCallback(async () => {
    if (!channelId) return;
    const store = useComposerDraftStore.getState();
    const snapshot = store.drafts[draftKey] ?? EMPTY_DRAFT;
    if (!snapshot.content.trim() && snapshot.files.length === 0) return;
    // Timed-out users can't send anything — including slash commands.
    // Checked before runMusicCommand below so /play etc. can't be used to
    // bypass the composer gate while muted.
    if (selfTimeoutExpiresAt) return;
    // The synchronous store guard survives navigation/unmount, unlike a component ref.
    const ticket = store.beginSend(draftKey);
    if (!ticket) return;
    let success = false;
    let sendKind: "message" | "command" = "message";

    // try/catch/finally bracket the send so a thrown promise — slash-command
    // network failure, sendMessage exception, anything — never leaves the
    // textarea locked or the user without feedback.
    try {
      const tokenized = convertEmojiShortcodes(
        convertMentionTokens(snapshot.content.trim(), snapshot.mentions),
        snapshot.emojis, getMemberEmojiCatalog(), serverId,
      );
      // Slash-commands short-circuit before mention tokenization + chat send.
      // /play /skip /pause /resume /stop never reach the message stream — they
      // hit the music bot HTTP API. Only a confirmed success consumes text.
      const musicCommand = await runMusicCommand(snapshot.content);
      if (musicCommand.handled) {
        sendKind = "command";
        success = musicCommand.outcome === "success";
        return;
      }
      if (useComposerDraftStore.getState().generation !== ticket.generation) return;

      // Regular message send is gated on canSend (text-channel send perm).
      // Slash commands intentionally bypass this gate above — they target
      // voice state, not the message stream.
      if (!canSend) {
        return;
      }

      success = await sendMessage(tokenized, snapshot.files, snapshot.replyingTo?.id);
    } catch (err) {
      console.error("[MessageInput] send failed:", err);
    } finally {
      const cleared = useComposerDraftStore.getState().finishSend(draftKey, ticket, success, sendKind);
      if (cleared && activeDraftKey.current === draftKey && textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      // Restore focus after send. With readOnly={isSending} the textarea keeps
      // focus during the round-trip, but tapping the send button on desktop
      // still shifts focus to the button — restore it there. On touch we
      // skip: the mobile IME would either already be up (fine) or the user
      // dismissed it deliberately, and forcing focus would reopen it.
      if (!isTouch) requestAnimationFrame(() => {
        if (activeDraftKey.current === draftKey) textareaRef.current?.focus();
      });
    }
  }, [channelId, draftKey, sendMessage, runMusicCommand, canSend, isTouch, selfTimeoutExpiresAt, serverId]);

  /** Keyboard event handler */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Let mention popup handle navigation keys when open. We read the ref
    // (mentionActiveRef) rather than the state (mentionQuery) because the
    // state lags one render behind the popup's actual visibility — see the
    // comment on mentionActiveRef for the full race description.
    if (mentionActiveRef.current || emojiActiveRef.current) {
      if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) {
        return;
      }
    }

    // IME composition: when an Input Method Editor is mid-composition, the
    // first Enter commits the candidate rather than meaning "submit". Skip
    // the send so the next Enter (after composition ends) is the real one.
    // Reading nativeEvent.isComposing dodges React's SyntheticEvent quirks
    // where the React-level isComposing can be stale.
    if (e.nativeEvent.isComposing) {
      return;
    }

    // Escape — cancel reply (when mention popup is closed)
    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /** Textarea change — typing trigger + auto-resize + mention detection */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);

    if (channelId && value.length > 0) {
      sendTyping();
    }

    // Mention detection — scan backwards from cursor for @
    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      if (charBeforeAt === " " || charBeforeAt === "\n" || atIndex === 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        // Allow spaces in query (role names can contain spaces like "Level 3")
        // Only close on newline — selection via Enter/Tab/click inserts and closes
        if (!query.includes("\n")) {
          mentionStartRef.current = atIndex;
          mentionActiveRef.current = true;
          setMentionQuery(query);
        } else {
          mentionActiveRef.current = false;
          setMentionQuery(null);
        }
      } else {
        mentionActiveRef.current = false;
        setMentionQuery(null);
      }
    } else {
      mentionActiveRef.current = false;
      setMentionQuery(null);
    }

    // Custom emoji detection — `:` + 2..32 slug chars right before the
    // cursor, with the `:` at the start or after whitespace. Takes priority
    // over a (space-tolerant) mention query so only one popup owns the keys.
    const emojiMatch = /(^|\s):([a-z0-9_]{2,32})$/.exec(textBeforeCursor);
    if (emojiMatch) {
      emojiStartRef.current = emojiMatch.index + emojiMatch[1].length;
      emojiActiveRef.current = true;
      setEmojiQuery(emojiMatch[2]);
      mentionActiveRef.current = false;
      setMentionQuery(null);
    } else {
      emojiActiveRef.current = false;
      setEmojiQuery(null);
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }

  /** Insert selected mention into content and track for token conversion */
  function handleMentionSelect(mention: MentionSelection) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    useComposerDraftStore.getState().patch(draftKey, { mentions: [...draft.mentions, mention] });

    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, start);
    const after = content.slice(cursorPos);
    const displayText = `@${mention.name}`;
    const newContent = `${before}${displayText} ${after}`;

    setContent(newContent);
    mentionActiveRef.current = false;
    setMentionQuery(null);
    mentionStartRef.current = -1;

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + displayText.length + 1;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  /** Close mention popup */
  function handleMentionClose() {
    mentionActiveRef.current = false;
    setMentionQuery(null);
    mentionStartRef.current = -1;
  }

  /** Insert the autocompleted `:name:` and remember the pick for send. */
  const handleEmojiAutocompleteSelect = useCallback(
    (emoji: CustomEmojiRef) => {
      const start = emojiStartRef.current;
      if (start < 0) return;
      useComposerDraftStore.getState().patch(draftKey, { emojis: [...draft.emojis, emoji] });

      const cursorPos = textareaRef.current?.selectionStart ?? content.length;
      const insert = `:${emoji.name}: `;
      setContent(content.slice(0, start) + insert + content.slice(cursorPos));
      emojiActiveRef.current = false;
      setEmojiQuery(null);
      emojiStartRef.current = -1;

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const pos = start + insert.length;
          textareaRef.current.selectionStart = pos;
          textareaRef.current.selectionEnd = pos;
          textareaRef.current.focus();
        }
      });
    },
    [content, draft.emojis, draftKey, setContent],
  );

  const handleEmojiAutocompleteClose = useCallback(() => {
    emojiActiveRef.current = false;
    setEmojiQuery(null);
    emojiStartRef.current = -1;
  }, []);

  /** Insert emoji at cursor position (custom picks insert `:name:`) */
  function handleEmojiSelect(picked: string) {
    const custom = parseCustomEmojiToken(picked);
    if (custom) useComposerDraftStore.getState().patch(draftKey, { emojis: [...draft.emojis, custom] });
    const emoji = custom ? `:${custom.name}:` : picked;
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const newContent = content.slice(0, cursorPos) + emoji + content.slice(cursorPos);
    setContent(newContent);
    setShowEmojiPicker(false);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = cursorPos + emoji.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  /**
   * Send a picker result (GIF URL / sticker token) as the whole message
   * content immediately. Shared by the GIF and sticker pickers.
   */
  async function sendInstant(text: string) {
    if (!channelId || !canSend || selfTimeoutExpiresAt) return;
    const ticket = useComposerDraftStore.getState().beginSend(draftKey);
    if (!ticket) return;
    try {
      await sendMessage(text, [], undefined);
    } catch (err) {
      console.error("[MessageInput] picker send failed:", err);
    } finally {
      // A picker result is independent of the text/files waiting in the composer.
      useComposerDraftStore.getState().finishSend(draftKey, ticket, false);
      // Skip focus restore on touch — see handleSend for rationale.
      if (!isTouch) requestAnimationFrame(() => {
        if (activeDraftKey.current === draftKey) textareaRef.current?.focus();
      });
    }
  }

  /** Send GIF URL as message content immediately */
  function handleGifSelect(url: string) {
    setShowGifPicker(false);
    void sendInstant(url);
  }

  /** Paste handler — supports pasting images/files from clipboard */
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length > 0) {
      e.preventDefault();
      const { valid, rejected } = validateFiles(pastedFiles);
      addFilesCapped(valid);
      reportRejections(rejected);
    }
  }

  /** Add files with validation */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    const { valid, rejected } = validateFiles(e.target.files);
    addFilesCapped(valid);
    reportRejections(rejected);
    e.target.value = "";
  }

  /** Remove file by index */
  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!channelId) return null;

  // Slash commands (/play /skip ...) target voice state and bypass the
  // text-channel send permission. So the input must always render — even
  // when canSend=false — otherwise users without text-send perm can't
  // invoke the music bot at all.
  const isSlashCommand = content.trimStart().startsWith("/");

  // Placeholder: "#channel" in channel mode, "@user" in DM mode.
  // When canSend is false the user gets a hint that only slash commands
  // will go through; the textarea stays editable. A timeout takes
  // priority over the generic no-permission hint — timed-out users can't
  // use slash commands either (see handleSend), so that hint would lie.
  const placeholder = selfTimeoutExpiresAt
    ? t("timedOutPlaceholder")
    : !canSend
      ? t("noSendPermissionSlashHint")
      : mode === "dm"
        ? t("dmPlaceholder", { user: channelName })
        : t("messagePlaceholder", { channel: channelName });

  return (
    <div className="input-area">
      {/* Mention autocomplete popup — shown above textarea */}
      {!legacyComposer && mentionQuery !== null && mode === "channel" && (
        <MentionAutocomplete
          query={mentionQuery}
          serverId={serverId}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}

      {/* Custom emoji `:shortcode` autocomplete — channel and DM */}
      {!legacyComposer && emojiQuery !== null && (
        <EmojiAutocomplete
          query={emojiQuery}
          serverId={serverId}
          onSelect={handleEmojiAutocompleteSelect}
          onClose={handleEmojiAutocompleteClose}
        />
      )}

      {/* Reply bar — preview of the message being replied to */}
      {replyingTo && (
        <ReplyBar
          message={replyingTo}
          onCancel={() => setReplyingTo(null)}
        />
      )}

      {/* File previews */}
      <FilePreview files={files} onRemove={handleFileRemove} />

      {/* Self-timeout banner — replaces the normal composer affordance while
          a moderator timeout is active. Relative "ends in X" text refreshes
          off nowTick so it doesn't go stale for someone sitting on the tab. */}
      {selfTimeoutExpiresAt && (
        <div className="input-timeout-banner" role="status">
          <span>{t("common:youAreTimedOut")}</span>
          <span key={nowTick}>
            {t("common:timeoutExpiresIn", {
              rel: formatRelativeFuture(selfTimeoutExpiresAt, i18n.language),
            })}
          </span>
        </div>
      )}

      <div className={`input-box${legacyComposer ? " legacy-composer" : ""}`}>
        {/* File upload button */}
        <button
          className="input-action-btn"
          disabled={!canSend || isSending}
          onClick={() => fileInputRef.current?.click()}
          title={t("attachFile")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          /* readOnly (not disabled) so the mobile soft keyboard stays open
             during the send round-trip — disabled drops focus and collapses
             the IME, which is jarring when sending back-to-back messages.
             Edits are still blocked; handleSend also short-circuits on the
             conversation send lock so no submission slips through. */
          readOnly={isSending}
        />

        {/* Emoji button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("emoji")}
            disabled={!canSend || isSending}
            onClick={() => togglePicker("emoji")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {showEmojiPicker && (
            <div className="input-emoji-picker-wrap">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
                customEmojis
              />
            </div>
          )}
        </div>

        {/* GIF button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn input-gif-btn"
            title={t("gif")}
            disabled={!canSend || isSending}
            onClick={() => togglePicker("gif")}
          >
            GIF
          </button>
          {showGifPicker && (
            <div className="input-gif-picker-wrap">
              <GifPicker
                onSelect={handleGifSelect}
                onClose={() => setShowGifPicker(false)}
              />
            </div>
          )}
        </div>

        {/* Sticker button + picker (Faz D2) */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("expressions:stickerButton")}
            aria-label={t("expressions:stickerButton")}
            disabled={!canSend || isSending}
            onClick={() => togglePicker("sticker")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9.5L21 14.5V5a2 2 0 0 0-2-2h-3.5" />
              <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
              <path d="M8 13s1.5 2 4 2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {showStickerPicker && (
            <div className="input-gif-picker-wrap">
              <StickerPicker
                onSelect={(token) => {
                  setShowStickerPicker(false);
                  void sendInstant(token);
                }}
                onClose={() => setShowStickerPicker(false)}
              />
            </div>
          )}
        </div>

        {/* Send button — explicit click target for users who don't use Enter
            (touch devices, accessibility). Disabled when there's no content
            and no attachments, while a previous send is in flight, or while
            timed out (full send block — even slash commands). */}
        <button
          className="input-action-btn input-send-btn"
          title={t("common:sendMessage")}
          onClick={handleSend}
          disabled={
            isSending ||
            (content.trim().length === 0 && files.length === 0) ||
            // canSend=false locks regular sends; slash commands bypass the
            // text-channel send permission and stay tappable.
            (!canSend && !isSlashCommand) ||
            !!selfTimeoutExpiresAt
          }
          aria-label={t("common:sendMessage")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Character counter — visible when within 100 chars of limit */}
      {content.length > MAX_MESSAGE_LENGTH - 100 && (
        <span
          className="char-counter"
          data-warn={content.length > MAX_MESSAGE_LENGTH - 50}
          data-danger={content.length > MAX_MESSAGE_LENGTH - 20}
        >
          {MAX_MESSAGE_LENGTH - content.length}
        </span>
      )}
    </div>
  );
}

export default MessageInput;
