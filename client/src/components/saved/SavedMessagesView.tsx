/** SavedMessagesView — full-tab list of the user's bookmarks, newest first. */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSavedStore } from "../../stores/savedStore";
import SavedMessageItem from "./SavedMessageItem";

function SavedMessagesView() {
  const { t } = useTranslation("saved");
  const { t: tInbox } = useTranslation("inbox");
  const items = useSavedStore((s) => s.items);
  const hasMore = useSavedStore((s) => s.hasMore);
  const isLoading = useSavedStore((s) => s.isLoading);
  const loadError = useSavedStore((s) => s.loadError);
  const fetchInitial = useSavedStore((s) => s.fetchInitial);
  const fetchMore = useSavedStore((s) => s.fetchMore);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  return (
    <div className="inbox-view saved-view">
      <div className="inbox-view-header">
        <h2 className="inbox-view-title">{t("title")}</h2>
      </div>
      <div className="inbox-view-content">
        {loadError && items.length === 0 ? (
          <div className="inbox-empty">{t("loadError")}</div>
        ) : items.length === 0 && !isLoading && !hasMore ? (
          <div className="inbox-empty">{t("empty")}</div>
        ) : (
          <div className="saved-list">
            {items.map((item) => (
              <SavedMessageItem key={item.id} item={item} />
            ))}
            {hasMore && (
              <button
                type="button"
                className="inbox-link-btn saved-load-more"
                onClick={() => void fetchMore()}
                disabled={isLoading}
              >
                {tInbox("loadMore")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default SavedMessagesView;
