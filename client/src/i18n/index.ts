import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import trCommon from "./locales/tr/common.json";
import trAuth from "./locales/tr/auth.json";
import trErrors from "./locales/tr/errors.json";

export const SUPPORTED_LANGUAGES = {
  en: "English",
  tr: "Türkçe",
} as const;

export type Language = keyof typeof SUPPORTED_LANGUAGES;

/**
 * Default language for fresh installs (no language stored in localStorage yet).
 * Türkçe — the app's primary user base. Existing users who previously picked a
 * language keep their choice via localStorage detection.
 */
export const DEFAULT_LANGUAGE: Language = "tr";

export const ALL_NAMESPACES = ["common", "auth", "channels", "chat", "settings", "voice", "landing", "privacy", "terms", "servers", "dm", "e2ee", "soundboard", "music", "audit", "errors", "inbox", "saved", "expressions", "entrance", "cosmetics"] as const;
type Namespace = typeof ALL_NAMESPACES[number];
const modules = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");
const pending = new Map<string, Promise<Record<string, unknown>>>();
const active = new Set<Namespace>(["common", "auth", "errors", "settings"]);
let languageRequest = 0;

void i18n.use(initReactI18next).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
  resources: { tr: { common: trCommon, auth: trAuth, errors: trErrors } },
  defaultNS: "common", ns: ["common", "auth", "errors"],
  interpolation: { escapeValue: false },
  initAsync: false,
});

async function load(lng: Language, namespaces: readonly Namespace[]): Promise<void> {
  const requests = [...new Set([DEFAULT_LANGUAGE, lng])].flatMap(language => namespaces.map(async ns => {
    if (i18n.hasResourceBundle(language, ns)) return;
    const key = `${language}/${ns}`;
    let request = pending.get(key);
    if (!request) {
      const importer = modules[`./locales/${key}.json`];
      if (!importer) throw new Error("Translation resource unavailable");
      request = importer().then(result => result.default).catch(error => { pending.delete(key); throw error; });
      pending.set(key, request);
    }
    return { language, ns, data: await request };
  }));
  // Only expose bundles after the entire requested set is available.
  for (const bundle of await Promise.all(requests)) if (bundle) i18n.addResourceBundle(bundle.language, bundle.ns, bundle.data, true, true);
}

export async function ensureNamespaces(namespaces: readonly Namespace[]): Promise<void> {
  namespaces.forEach(ns => active.add(ns));
  await load(i18n.language === "en" ? "en" : "tr", namespaces);
}

/** Keep the previous language and persisted preference if loading fails. */
export async function changeLanguage(lng: string): Promise<boolean> {
  if (!(lng in SUPPORTED_LANGUAGES)) return false;
  const request = ++languageRequest;
  try {
    let requested: Namespace[];
    do { requested = [...active]; await load(lng as Language, requested); } while (requested.length !== active.size);
    if (request !== languageRequest) return false;
    await i18n.changeLanguage(lng);
    try { localStorage.setItem("language", lng); } catch { /* storage is optional */ }
    return true;
  } catch { return false; }
}

let saved: string | null = null;
try { saved = localStorage.getItem("language"); } catch { /* use Turkish */ }
export const i18nReady = changeLanguage(saved === "en" ? "en" : DEFAULT_LANGUAGE);
export default i18n;
