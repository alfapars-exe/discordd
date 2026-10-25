import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";
import { resolveContextShortcut } from "../../utils/shortcutRegistry";

export type ReorderItem = { id: string; label: string; groupId?: string };

export function moveReorderItem(ids: string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const result = [...ids];
  result.splice(from, 1);
  result.splice(to, 0, id);
  return result;
}

export function moveWithinGroup(ids: string[], id: string, delta: -1 | 1, items: ReorderItem[]): string[] {
  const groupId = items.find((item) => item.id === id)?.groupId;
  if (groupId === undefined) return moveReorderItem(ids, id, delta);
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  let target = index + delta;
  while (target >= 0 && target < ids.length && items.find((item) => item.id === ids[target])?.groupId !== groupId) target += delta;
  if (target < 0 || target >= ids.length) return ids;
  const result = [...ids];
  result.splice(index, 1);
  result.splice(target, 0, id);
  return result;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [data-shortcut-capture='true']"));
}

export function useKeyboardReorder(items: ReorderItem[], enabled: boolean, commit: (orderedIds: string[]) => Promise<boolean>, scopeKey = "") {
  const { t } = useTranslation("common");
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const retryIds = useRef<string[] | null>(null);
  const savingRef = useRef(false);
  const dragScope = useRef<string | null>(null);
  const currentScopeRef = useRef("");
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(false);
  const attemptRef = useRef(0);
  const currentScope = `${scopeKey}|${JSON.stringify(items.map(({ id, groupId }) => [id, groupId ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b))))}`;

  useLayoutEffect(() => {
    currentScopeRef.current = currentScope;
    enabledRef.current = enabled;
  }, [currentScope, enabled]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
    };
  }, []);

  const finish = useCallback((message: string) => {
    attemptRef.current += 1;
    setPreviewIds(null);
    setFailed(false);
    setSaving(false);
    savingRef.current = false;
    activeId.current = null;
    setActiveItemId(null);
    retryIds.current = null;
    dragScope.current = null;
    setAnnouncement(message);
    focusOrigin.current?.focus();
    focusOrigin.current = null;
  }, []);

  const persist = useCallback(async (idsToSave: string[] | null = previewIds) => {
    if (!idsToSave || savingRef.current) return;
    if (!enabled || dragScope.current !== currentScope) {
      finish(t("reorderCancelled"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    const attempt = ++attemptRef.current;
    const submittedScope = currentScope;
    let ok: boolean;
    try { ok = await commit(idsToSave); } catch { ok = false; }
    if (!mountedRef.current || attemptRef.current !== attempt || currentScopeRef.current !== submittedScope || !enabledRef.current) {
      if (mountedRef.current && attemptRef.current === attempt) {
        savingRef.current = false;
        setSaving(false);
        setPreviewIds(null);
        setFailed(false);
        activeId.current = null;
        setActiveItemId(null);
        retryIds.current = null;
        dragScope.current = null;
        focusOrigin.current = null;
      }
      return;
    }
    if (ok) finish(t("reorderSaved"));
    else {
      retryIds.current = idsToSave;
      setPreviewIds(null);
      activeId.current = null;
      setActiveItemId(null);
      savingRef.current = false;
      setSaving(false);
      setFailed(true);
      setAnnouncement(t("reorderSaveFailed"));
      focusOrigin.current?.focus();
    }
  }, [commit, currentScope, enabled, finish, previewIds, t]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>, id: string) => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || isEditingTarget(event.target)) return;
    if (useShortcutCaptureStore.getState().active) return;
    const action = resolveContextShortcut(event.nativeEvent, "drag", useShortcutBindingsStore.getState().bindings);

    if (dragScope.current && dragScope.current !== currentScope) {
      finish(t("reorderCancelled"));
      return;
    }

    if (previewIds && (previewIds.length !== ids.length || previewIds.some((candidate) => !ids.includes(candidate)))) {
      finish(t("reorderCancelled"));
      return;
    }

    if (!previewIds) {
      if (!enabled || action !== "start" || ids.length < 2) return;
      event.preventDefault();
      event.stopPropagation();
      activeId.current = id;
      setActiveItemId(id);
      focusOrigin.current = event.currentTarget;
      dragScope.current = currentScope;
      retryIds.current = null;
      setFailed(false);
      const item = items.find((entry) => entry.id === id);
      setAnnouncement(t("reorderPickedUp", { label: item?.label ?? "item", position: positionOf(ids, items, id), size: groupSize(items, id) }));
      setPreviewIds(ids);
      return;
    }

    if (saving || !activeId.current) return;
    if (action === "cancel") {
      event.preventDefault();
      event.stopPropagation();
      finish(t("reorderCancelled"));
    } else if (action === "drop" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      void persist();
    } else if (action === "up" || action === "down") {
      event.preventDefault();
      event.stopPropagation();
      const next = moveWithinGroup(previewIds, activeId.current, action === "up" ? -1 : 1, items);
      if (next !== previewIds) {
        setPreviewIds(next);
        const label = items.find((entry) => entry.id === activeId.current)?.label ?? "Item";
        setAnnouncement(t("reorderMoving", { label, position: positionOf(next, items, activeId.current), size: groupSize(items, activeId.current) }));
      }
    }
  }, [currentScope, enabled, finish, ids, items, persist, previewIds, saving, t]);

  const order = previewIds && previewIds.length === ids.length && previewIds.every((id) => ids.includes(id)) ? previewIds : ids;

  const orderedItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return order.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [items, order]);

  return {
    orderedItems,
    onKeyDown,
    isActive: previewIds !== null,
    activeItemId,
    announcement,
    failed,
    saving,
    retry: () => {
      if (retryIds.current?.length === ids.length && retryIds.current.every((id) => ids.includes(id))) void persist(retryIds.current);
      else finish(t("reorderCancelled"));
    },
    cancel: () => finish(t("reorderCancelled")),
    positionOf: (id: string) => positionOf(order, items, id),
    liveRegion: (
      <>
        <span aria-live="polite" aria-atomic="true" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>{announcement}</span>
        {failed && (
          <div className="keyboard-reorder-error" role="alert">
            <span>{announcement}</span>
            <button type="button" onClick={() => {
              if (retryIds.current?.length === ids.length && retryIds.current.every((id) => ids.includes(id))) void persist(retryIds.current);
              else finish(t("reorderCancelled"));
            }} disabled={saving}>{t("reorderRetry")}</button>
            <button type="button" onClick={() => finish(t("reorderCancelled"))}>{t("reorderCancel")}</button>
          </div>
        )}
      </>
    ),
  };
}

function positionOf(ids: string[], items: ReorderItem[], id: string): number {
  const index = ids.indexOf(id);
  const groupId = items.find((item) => item.id === id)?.groupId;
  return groupId === undefined
    ? index + 1
    : ids.slice(0, index).filter((candidateId) => items.find((item) => item.id === candidateId)?.groupId === groupId).length + 1;
}

function groupSize(items: ReorderItem[], id: string): number {
  const groupId = items.find((item) => item.id === id)?.groupId;
  return groupId === undefined ? items.length : items.filter((item) => item.groupId === groupId).length;
}
