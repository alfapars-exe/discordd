/** Send friend request by username (+ optional intro DM). Shows inline success/error result. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import { sendIntroMessage, INTRO_MAX_LENGTH } from "./sendIntroMessage";
import { usePreferencesStore } from "../../stores/preferencesStore";

function FriendRequestForm() {
  const { t } = useTranslation("common");
  const [username, setUsername] = useState("");
  const [intro, setIntro] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const sendRequest = useFriendStore((s) => s.sendRequest);
  const allowPersonalizedMessage = usePreferencesStore((s) => s.get<{ personalizedFriendMessages?: boolean }>("privacy")?.personalizedFriendMessages !== false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setResult(null);

    const introTrimmed = allowPersonalizedMessage ? intro.trim() : "";
    const res = await sendRequest(trimmed);

    if (res.success) {
      setResult({ success: true, message: t("friendRequestSent", { username: trimmed }) });
      setUsername("");
      // Intro DM is best-effort and must not block the form: the request is
      // already sent (also on mutual auto-accept). sendIntroMessage handles
      // its own toasts.
      if (introTrimmed && res.friendship) {
        setIntro("");
        void sendIntroMessage(res.friendship.user_id, introTrimmed);
      }
    } else {
      setResult({ success: false, message: res.error ?? t("somethingWentWrong") });
    }

    setIsSubmitting(false);
  }

  return (
    <div className="frf-container">
      <h3 className="frf-title">{t("addFriend")}</h3>
      <p className="frf-desc">{t("addFriendDesc")}</p>

      <form className="frf-form" onSubmit={handleSubmit}>
        <input
          className="frf-input"
          type="text"
          placeholder={t("addFriendPlaceholder")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={isSubmitting}
          autoFocus
        />
        {allowPersonalizedMessage && <textarea
          className="frf-input frf-intro"
          maxLength={INTRO_MAX_LENGTH}
          rows={2}
          placeholder={t("friendIntroPlaceholder")}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          disabled={isSubmitting}
        />}
        {allowPersonalizedMessage && <span className="frf-desc">{intro.length}/{INTRO_MAX_LENGTH}</span>}
        <button
          className="frf-btn"
          type="submit"
          disabled={isSubmitting || username.trim().length === 0}
        >
          {isSubmitting ? t("loading") : t("friendSendRequest")}
        </button>
      </form>

      {result && (
        <div className={`frf-result ${result.success ? "frf-success" : "frf-error"}`}>
          {result.message}
        </div>
      )}
    </div>
  );
}

export default FriendRequestForm;
