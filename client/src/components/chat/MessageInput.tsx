/** MessageInput — Message compose area. Works in both channel and DM via ChatContext. */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useMusicSlashCommand } from "../../hooks/useMusicSlashCommand";
import { useAttachmentRejectionToast } from "../../hooks/useAttachmentRejectionToast";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useNowTick } from "../../hooks/useNowTick";
import { validateFiles } from "../../utils/fileValidation";
import { MAX_MESSAGE_LENGTH } from "../../utils/constants";
import { convertMentionTokens } from "../../utils/mention";
import { formatRelativeFuture } from "../../utils/dateFormat";
import EmojiPicker from "../shared/EmojiPicker";
import GifPicker from "../shared/GifPicker";
import FilePreview from "./FilePreview";
import MentionAutocomplete, { type MentionSelection } from "./MentionAutocomplete";
import ReplyBar from "./ReplyBar";

function MessageInput() {
  const { t, i18n } = useTranslation("chat");
  const reportRejections = useAttachmentRejectionToast();
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

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  // Synchronous mirror of isSending — read inside handleSend BEFORE React
  // has flushed setIsSending(true). Without this, hammering Enter (or a
  // user double-tap on the send button) fires handleSend twice in the same
  // tick because both invocations see the stale state-level isSending=false
  // and pass the guard, posting the same message to the API twice.
  // The state is still kept for `disabled={isSending}` / button styling.
  const isSendingRef = useRef(false);

  // Emoji picker state
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // GIF picker state
  const [showGifPicker, setShowGifPicker] = useState(false);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** Character index where the @ trigger starts */
  const mentionStartRef = useRef<number>(-1);
  /** Tracked mention selections for token conversion on send */
  const mentionSelectionsRef = useRef<MentionSelection[]>([]);
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Register callback for drag-drop file forwarding from ChatArea/DMChat
  useEffect(() => {
    addFilesRef.current = (newFiles: File[]) => {
      setFiles((prev) => [...prev, ...newFiles]);
    };
    return () => {
      addFilesRef.current = null;
    };
  }, [addFilesRef]);

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

  // Single source of truth for "send succeeded — wipe the composer". Both
  // the slash-command path and the regular-message path call this so future
  // additions (new state, draft persistence, etc.) only need one update.
  const resetInputAfterSend = useCallback(() => {
    setContent("");
    setFiles([]);
    setReplyingTo(null);
    mentionSelectionsRef.current = [];
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [setReplyingTo]);

  const handleSend = useCallback(async () => {
    if (!channelId) return;
    if (!content.trim() && files.length === 0) return;
    // Timed-out users can't send anything — including slash commands.
    // Checked before runMusicCommand below so /play etc. can't be used to
    // bypass the composer gate while muted.
    if (selfTimeoutExpiresAt) return;
    // Ref-based guard runs BEFORE React batches the state update — closes
    // the same-tick double-fire race that the previous `isSending` state
    // guard could not (state hadn't propagated by the second handleSend).
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    setIsSending(true);

    // try/catch/finally bracket the send so a thrown promise — slash-command
    // network failure, sendMessage exception, anything — never leaves the
    // textarea locked or the user without feedback.
    try {
      // Slash-commands short-circuit before mention tokenization + chat send.
      // /play /skip /pause /resume /stop never reach the message stream — they
      // hit the music bot HTTP API and clear the input.
      const wasMusicCommand = await runMusicCommand(content);
      if (wasMusicCommand) {
        resetInputAfterSend();
        return;
      }

      // Regular message send is gated on canSend (text-channel send perm).
      // Slash commands intentionally bypass this gate above — they target
      // voice state, not the message stream.
      if (!canSend) {
        return;
      }

      const replyToId = replyingTo?.id;
      const tokenized = convertMentionTokens(content.trim(), mentionSelectionsRef.current);
      const success = await sendMessage(tokenized, files, replyToId);
      if (success) {
        resetInputAfterSend();
      }
    } catch (err) {
      console.error("[MessageInput] send failed:", err);
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
      // Restore focus after send. With readOnly={isSending} the textarea keeps
      // focus during the round-trip, but tapping the send button on desktop
      // still shifts focus to the button — restore it there. On touch we
      // skip: the mobile IME would either already be up (fine) or the user
      // dismissed it deliberately, and forcing focus would reopen it.
      if (!isTouch) requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [channelId, content, files, sendMessage, replyingTo, runMusicCommand, canSend, resetInputAfterSend, isTouch, selfTimeoutExpiresAt]);

  /** Keyboard event handler */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Let mention popup handle navigation keys when open. We read the ref
    // (mentionActiveRef) rather than the state (mentionQuery) because the
    // state lags one render behind the popup's actual visibility — see the
    // comment on mentionActiveRef for the full race description.
    if (mentionActiveRef.current) {
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

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }

  /** Insert selected mention into content and track for token conversion */
  function handleMentionSelect(mention: MentionSelection) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    mentionSelectionsRef.current.push(mention);

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

  /** Insert emoji at cursor position */
  function handleEmojiSelect(emoji: string) {
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

  /** Send GIF URL as message content immediately */
  async function handleGifSelect(url: string) {
    if (!channelId) return;
    // Same ref-based guard as handleSend — a fast double-click on a GIF
    // tile used to fire two API requests because the state-based check
    // only saw isSending=false until React flushed the next render.
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setShowGifPicker(false);
    setIsSending(true);
    try {
      const success = await sendMessage(url, [], undefined);
      if (success) {
        setContent("");
        setFiles([]);
        setReplyingTo(null);
      }
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
      // Skip focus restore on touch — see handleSend for rationale.
      if (!isTouch) requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
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
      if (valid.length > 0) {
        setFiles((prev) => [...prev, ...valid]);
      }
      reportRejections(rejected);
    }
  }

  /** Add files with validation */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    const { valid, rejected } = validateFiles(e.target.files);
    if (valid.length > 0) {
      setFiles((prev) => [...prev, ...valid]);
    }
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
      {mentionQuery !== null && mode === "channel" && (
        <MentionAutocomplete
          query={mentionQuery}
          serverId={serverId}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
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

      <div className="input-box">
        {/* File upload button */}
        <button
          className="input-action-btn"
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
             isSendingRef guard so no submission slips through. */
          readOnly={isSending}
        />

        {/* Emoji button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("emoji")}
            onClick={() => {
              setShowGifPicker(false);
              setShowEmojiPicker((prev) => !prev);
            }}
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
              />
            </div>
          )}
        </div>

        {/* GIF button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn input-gif-btn"
            title={t("gif")}
            onClick={() => {
              setShowEmojiPicker(false);
              setShowGifPicker((prev) => !prev);
            }}
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

        {/* Send button — explicit click target for users who don't use Enter
            (touch devices, accessibility). Disabled when there's no content
            and no attachments, while a previous send is in flight, or while
            timed out (full send block — even slash commands). */}
        <button
          className="input-action-btn input-send-btn"
          title={t("sendMessage")}
          onClick={handleSend}
          disabled={
            isSending ||
            (content.trim().length === 0 && files.length === 0) ||
            // canSend=false locks regular sends; slash commands bypass the
            // text-channel send permission and stay tappable.
            (!canSend && !isSlashCommand) ||
            !!selfTimeoutExpiresAt
          }
          aria-label={t("sendMessage")}
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
