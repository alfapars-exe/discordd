import { useEffect } from "react";
import { startPreferenceTask } from "../stores/preferenceTask";
import { logToServer } from "../api/clientLog";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useToastStore } from "../stores/toastStore";

/** Reconcile on return/online without polling; warn before abandoning unsaved edits. */
export function usePreferencesSync() {
  const userId = useAuthStore((s) => s.user?.id);
  const { t } = useTranslation("settings");
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") startPreferenceTask(
        () => usePreferencesStore.getState().fetchAndApply(),
        () => { void logToServer("error", "preferences_background_failed", { source: "focus" }); },
      );
    };
    const retry = () => startPreferenceTask(
      () => usePreferencesStore.getState().retrySync(),
      () => { void logToServer("error", "preferences_background_failed", { source: "online" }); },
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (usePreferencesStore.getState().hasPendingChanges) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
      if (state.syncStatus === "error" && previous.syncStatus !== "error") {
        useToastStore.getState().addToast("warning", t("preferencesSync.error"), 6000);
      }
    });
    window.addEventListener("online", retry);
    window.addEventListener("focus", refresh);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unsubscribe();
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [userId, t]);
}
