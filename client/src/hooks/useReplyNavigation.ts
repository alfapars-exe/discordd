import { useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../stores/toastStore";

export function useReplyNavigation(
  conversationKey: string,
  contains: (id: string) => boolean,
  loadAround: (id: string, context: { isCurrent: () => boolean }) => Promise<boolean>,
  scroll: (id: string | null) => void,
) {
  const generation = useRef(0);
  const { t } = useTranslation("chat");
  useLayoutEffect(() => () => { generation.current++; }, [conversationKey]);

  return useCallback((id: string | null) => {
    const request = ++generation.current;
    if (id === null || contains(id)) {
      scroll(id);
      return;
    }
    const isCurrent = () => request === generation.current;
    const unavailable = () => {
      if (isCurrent()) useToastStore.getState().addToast("info", t("replyTargetUnavailable"));
    };
    void loadAround(id, { isCurrent }).then(found => {
      if (found && isCurrent()) scroll(id);
      else unavailable();
    }, unavailable);
  }, [contains, loadAround, scroll, t]);
}
