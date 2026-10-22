/**
 * CosmeticsSettings — user settings tab "Cosmetics" (Faz G).
 *
 * Sections:
 *   1. Scope — global, or one of your servers (a server scope only overrides
 *      the slots you fill; empty slots inherit global). In a server scope the
 *      "appear plain here" switch hides all your cosmetics for that server.
 *   2. Currently equipped — one line per slot (item name or "None").
 *   3. Picker — one tab per slot type, "None" + item tiles (radio group).
 *      Changes are a draft until a single "Save" sends ONE equip request
 *      with only the changed slots ("None" → null). "Reset" drops the draft.
 *   4. Live preview — profile card (ProfilePreviewCard, NOT .member-card,
 *      §4 #236), a sample member row and a sample message header.
 *   5. Viewing others — "plain view" (preferences, Karar G-17).
 *   6. Granted cosmetics (hidden while empty — G1 never has any).
 * Every check here is UX only; the server is authoritative. Assets are
 * always rendered through the validating components (parseCosmeticAsset).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useCosmeticsStore } from "../../stores/cosmeticsStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useCosmeticsViewPrefs } from "../../hooks/useCosmeticsViewPrefs";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useThemeBackground } from "../../hooks/useThemeBackground";
import { cosmeticsErrorKey } from "../../api/cosmetics";
import {
  COSMETIC_TYPES,
  EMPTY_SLOTS,
  cssVarsForTheme,
  nameStyleOf,
  themeOf,
} from "../../utils/cosmetics";
import { nameStyleReadable } from "../../utils/cosmeticContrast";
import { formatDate } from "../../utils/dateFormat";
import DecoratedAvatar from "../cosmetics/DecoratedAvatar";
import Nameplate from "../cosmetics/Nameplate";
import StyledName from "../cosmetics/StyledName";
import ProfileEffectLayer from "../cosmetics/ProfileEffectLayer";
import ProfilePreviewCard from "./ProfilePreviewCard";
import type {
  CosmeticItem,
  CosmeticSlots,
  CosmeticType,
  EquippedCosmetic,
  EquipRequest,
} from "../../types/cosmetics";
import "../../styles/cosmetics.css";

const GLOBAL_SCOPE = "global";

type Draft = Partial<Record<CosmeticType, string | null>>;

function toEquipped(item: CosmeticItem): EquippedCosmetic {
  return { item_id: item.id, format: item.format, animated: item.animated, asset: item.asset };
}

/** Display name: built-in items use the `builtin.<id>` translation (#212/G-18). */
function useItemName() {
  const { t } = useTranslation("cosmetics");
  return (item: CosmeticItem | undefined, fallbackId?: string): string => {
    if (!item) return fallbackId ?? t("none");
    if (item.server_id === null) return String(t(`builtin.${item.id}`, { defaultValue: item.name }));
    return item.name;
  };
}

// ─── One item tile (mini preview per type) ───

type TileProps = {
  type: CosmeticType;
  item: CosmeticItem | null;
  checked: boolean;
  tabIndex: number;
  sampleName: string;
  avatarUrl: string | null;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
};

function TilePreview({ type, item, sampleName, avatarUrl }: Pick<TileProps, "type" | "item" | "sampleName" | "avatarUrl">) {
  const reduceMotion = useReducedMotion();
  const bg = useThemeBackground();
  const { t } = useTranslation("cosmetics");
  const eq = item ? toEquipped(item) : undefined;

  switch (type) {
    case "avatar_frame":
      return <DecoratedAvatar name={sampleName} avatarUrl={avatarUrl} size={40} isCircle frame={eq} animateFrame="hover" />;
    case "nameplate":
      return (
        <div className="cos-tile-row cos-np-host">
          <Nameplate nameplate={eq} />
        </div>
      );
    case "name_style": {
      const asset = nameStyleOf(eq);
      const unreadable = !!asset && !nameStyleReadable(asset.stops, bg);
      return (
        <>
          {unreadable && (
            <span className="cos-tile-warn" title={t("lightThemeNote")} aria-label={t("lightThemeNote")}>
              ⚠
            </span>
          )}
          <StyledName name={sampleName} style={eq} />
        </>
      );
    }
    case "profile_theme": {
      const asset = themeOf(eq);
      return (
        <div
          className={`cos-tile-theme${asset ? " cos-hero-theme" : ""}`}
          style={asset ? cssVarsForTheme(asset) : undefined}
        />
      );
    }
    case "profile_effect":
      return (
        <div className="cos-tile-effect">
          {reduceMotion && item ? (
            <span className="cos-tile-effect-static">{t("animated")}</span>
          ) : (
            <ProfileEffectLayer effect={eq} active />
          )}
        </div>
      );
    default:
      return null;
  }
}

function Tile(props: TileProps) {
  const { t } = useTranslation("cosmetics");
  const itemName = useItemName();
  const { item, checked, tabIndex, onSelect, onKeyDown } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={tabIndex}
      className="cos-tile"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      data-testid={`cos-tile-${item?.id ?? "none"}`}
    >
      {item?.server_id && <span className="cos-tile-badge">{t("serverItemBadge")}</span>}
      <span className="cos-tile-preview">
        <TilePreview type={props.type} item={item} sampleName={props.sampleName} avatarUrl={props.avatarUrl} />
      </span>
      <span>{item ? itemName(item) : t("none")}</span>
    </button>
  );
}

// ─── Scope editor (keyed by scope → draft resets on scope change) ───

type EditorProps = {
  scope: string;
  items: CosmeticItem[];
  equipped: CosmeticSlots;
  globalSlots: CosmeticSlots;
};

function ScopeEditor({ scope, items, equipped, globalSlots }: EditorProps) {
  const { t } = useTranslation("cosmetics");
  const itemName = useItemName();
  const user = useAuthStore((s) => s.user);
  const equip = useCosmeticsStore((s) => s.equip);
  const addToast = useToastStore((s) => s.addToast);

  const [activeType, setActiveType] = useState<CosmeticType>("avatar_frame");
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isServer = scope !== GLOBAL_SCOPE;
  const itemsById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  const current = (type: CosmeticType): string | null => equipped[type]?.item_id ?? null;
  const selected = (type: CosmeticType): string | null => (type in draft ? (draft[type] ?? null) : current(type));

  const changed = COSMETIC_TYPES.filter((type) => type in draft && (draft[type] ?? null) !== current(type));

  // Preview: draft selection, else (server scope) the inherited global slot.
  const previewSlots = useMemo(() => {
    const out: CosmeticSlots = {};
    for (const type of COSMETIC_TYPES) {
      const id = type in draft ? (draft[type] ?? null) : (equipped[type]?.item_id ?? null);
      const item = id ? itemsById.get(id) : undefined;
      const value = item ? toEquipped(item) : id ? equipped[type] : undefined;
      const resolved = value ?? (isServer ? globalSlots[type] : undefined);
      if (resolved) out[type] = resolved;
    }
    return out;
  }, [draft, equipped, globalSlots, isServer, itemsById]);

  // Server items are listed only in their own server's scope (G2).
  const typeItems = items.filter(
    (it) => it.type === activeType && (it.server_id === null || it.server_id === scope),
  );
  const options: Array<CosmeticItem | null> = [null, ...typeItems];
  const selectedId = selected(activeType);
  const checkedIndex = Math.max(
    0,
    options.findIndex((it) => (it?.id ?? null) === selectedId),
  );

  const pick = (id: string | null) => setDraft((d) => ({ ...d, [activeType]: id }));

  const handleTileKey = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    if (next < 0) return;
    e.preventDefault();
    pick(options[next]?.id ?? null);
    tileRefs.current[next]?.focus();
  };

  const save = async () => {
    if (changed.length === 0 || busy) return;
    const slots: EquipRequest["slots"] = {};
    for (const type of changed) slots[type] = draft[type] ?? null;
    setBusy(true);
    const res = await equip({ scope, slots });
    setBusy(false);
    if (res.success) {
      setDraft({});
      addToast("success", t("saved"));
    } else {
      addToast("error", t(cosmeticsErrorKey(res)));
    }
  };

  const sampleName = user?.display_name || user?.username || "HiChat";
  const avatarUrl = user?.avatar_url ?? null;

  return (
    <>
      {/* Currently equipped */}
      <div className="vs-section">
        <div className="vs-label">{t("equipped")}</div>
        <ul className="cos-equipped-list">
          {COSMETIC_TYPES.map((type) => {
            const id = current(type);
            return (
              <li key={type}>
                <span>{t(`types.${type}`)}</span>
                <strong>{id ? itemName(itemsById.get(id), id) : t("none")}</strong>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Picker */}
      <div className="vs-section">
        <div className="cos-type-tabs" role="tablist">
          {COSMETIC_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={type === activeType}
              className="cos-type-tab"
              onClick={() => setActiveType(type)}
            >
              {t(`types.${type}`)}
              {type in draft && (draft[type] ?? null) !== current(type) ? " •" : ""}
            </button>
          ))}
        </div>
        <div className="cos-tiles" role="radiogroup" aria-label={t(`types.${activeType}`)}>
          {options.map((item, index) => (
            <Tile
              key={item?.id ?? "none"}
              type={activeType}
              item={item}
              checked={index === checkedIndex}
              tabIndex={index === checkedIndex ? 0 : -1}
              sampleName={sampleName}
              avatarUrl={avatarUrl}
              onSelect={() => pick(item?.id ?? null)}
              onKeyDown={handleTileKey(index)}
            />
          ))}
        </div>
        <div className="cos-actions">
          <button
            type="button"
            className="settings-btn"
            disabled={changed.length === 0 || busy}
            onClick={() => void save()}
          >
            {t("save")}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            disabled={Object.keys(draft).length === 0 || busy}
            onClick={() => setDraft({})}
          >
            {t("reset")}
          </button>
        </div>
      </div>

      {/* Live preview */}
      <div className="vs-section">
        <div className="vs-label">{t("preview")}</div>
        {user && (
          <div className="cos-preview-grid">
            <ProfilePreviewCard
              cosmetics={previewSlots}
              username={user.username}
              displayName={user.display_name ?? ""}
              avatarUrl={user.avatar_url}
              animatedUrl={user.avatar_animated_url ?? null}
              bannerUrl={user.banner_url ?? null}
              accentColor={user.accent_color ?? ""}
              bio={user.bio ?? ""}
              pronouns={user.pronouns ?? ""}
              customStatus={user.custom_status ?? ""}
            />
            <div className="cos-preview-side">
              <div className="cos-preview-member cos-np-host" data-testid="cos-preview-member">
                <Nameplate nameplate={previewSlots.nameplate} />
                <DecoratedAvatar
                  name={sampleName}
                  avatarUrl={avatarUrl}
                  size={32}
                  isCircle
                  frame={previewSlots.avatar_frame}
                  animateFrame="hover"
                />
                <span>{sampleName}</span>
              </div>
              <div className="cos-preview-msg">
                <DecoratedAvatar
                  name={sampleName}
                  avatarUrl={avatarUrl}
                  size={30}
                  frame={previewSlots.avatar_frame}
                  animateFrame={false}
                />
                <div className="cos-preview-msg-body">
                  <StyledName name={sampleName} style={previewSlots.name_style} />
                  <span className="cos-preview-msg-text">{t("previewMessage")}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Tab root ───

function CosmeticsSettings() {
  const { t } = useTranslation("cosmetics");
  const itemName = useItemName();
  const mine = useCosmeticsStore((s) => s.mine);
  const mineStatus = useCosmeticsStore((s) => s.mineStatus);
  const loadMine = useCosmeticsStore((s) => s.loadMine);
  const setPlainServer = useCosmeticsStore((s) => s.setPlainServer);
  const servers = useServerStore((s) => s.servers);
  const addToast = useToastStore((s) => s.addToast);
  const reduceMotion = useReducedMotion();
  const { prefs, update } = useCosmeticsViewPrefs();

  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [plainBusy, setPlainBusy] = useState(false);

  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  // A server you left disappears from the list → back to global.
  const effectiveScope = scope === GLOBAL_SCOPE || servers.some((s) => s.id === scope) ? scope : GLOBAL_SCOPE;
  const isServer = effectiveScope !== GLOBAL_SCOPE;

  const items = mine?.items ?? [];
  const globalSlots = mine?.equipped.global ?? EMPTY_SLOTS;
  const equipped = isServer ? (mine?.equipped.servers[effectiveScope] ?? EMPTY_SLOTS) : globalSlots;
  const plainHere = isServer && !!mine?.plain_server_ids.includes(effectiveScope);
  const grants = mine?.grants ?? [];
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const itemsById = new Map(items.map((it) => [it.id, it]));

  const togglePlain = async (plain: boolean) => {
    if (!isServer || plainBusy) return;
    setPlainBusy(true);
    const res = await setPlainServer(effectiveScope, plain);
    setPlainBusy(false);
    if (!res.success) addToast("error", t(cosmeticsErrorKey(res)));
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("title")}</h2>
      <p className="vs-desc" style={{ marginBottom: 16 }}>
        {t("subtitle")}
      </p>
      {reduceMotion && <p className="cos-note">{t("reducedMotionNote")}</p>}

      {/* Scope */}
      <div className="vs-section">
        <div className="cos-settings-scope">
          <label className="settings-label" htmlFor="cosmetics-scope">
            {t("scope")}
          </label>
          <select
            id="cosmetics-scope"
            className="vs-select"
            value={effectiveScope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value={GLOBAL_SCOPE}>{t("scopeGlobal")}</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {t("scopeServer", { server: s.name })}
              </option>
            ))}
          </select>
        </div>
        {isServer && (
          <>
            <p className="cos-note">{t("scopeHint")}</p>
            <div className="vs-toggle-row">
              <div>
                <div className="vs-desc" id="cosmetics-plain-here-label">
                  {t("plainHere")}
                </div>
                <div className="cos-note">{t("plainHereHint")}</div>
              </div>
              <label className="vs-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-labelledby="cosmetics-plain-here-label"
                  aria-checked={plainHere}
                  checked={plainHere}
                  disabled={!mine || plainBusy}
                  onChange={(e) => void togglePlain(e.target.checked)}
                />
                <span className="vs-switch-slider" />
              </label>
            </div>
          </>
        )}
      </div>

      {!mine ? (
        <p className="vs-desc">{mineStatus === "error" ? t("errors.generic") : t("common:loading")}</p>
      ) : (
        <ScopeEditor
          key={effectiveScope}
          scope={effectiveScope}
          items={items}
          equipped={equipped}
          globalSlots={globalSlots}
        />
      )}

      {/* Viewing others */}
      <div className="vs-section">
        <div className="vs-label">{t("viewerTitle")}</div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-desc" id="cosmetics-viewer-plain-label">
              {t("viewerPlain")}
            </div>
            <div className="cos-note">{t("viewerPlainHint")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby="cosmetics-viewer-plain-label"
              aria-checked={prefs.plain}
              checked={prefs.plain}
              onChange={(e) => update({ plain: e.target.checked })}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* Granted cosmetics (hidden while empty) */}
      {grants.length > 0 && (
        <div className="vs-section">
          <div className="vs-label">{t("grantsTitle")}</div>
          <ul className="cos-grants">
            {grants.map((g) => (
              <li key={`${g.server_id}:${g.item_id}`}>
                <strong>{itemName(itemsById.get(g.item_id), g.item_id)}</strong> · {serverName(g.server_id)}
                <div className="cos-note">
                  {g.granted_by
                    ? t("grantedBy", { name: g.granted_by.display_name || g.granted_by.username })
                    : t("grantedByDeleted")}
                  {" · "}
                  {g.reason}
                  {" · "}
                  {formatDate(g.granted_at)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default CosmeticsSettings;
