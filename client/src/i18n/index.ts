/**
 * i18n configuration — i18next + react-i18next setup.
 *
 * Namespaces: common, auth, channels, chat, settings, voice, landing, privacy,
 *             servers, dm, e2ee, soundboard, music, terms, audit.
 * Supported languages: EN (fallback), TR.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// ─── EN Translation Files ───
import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enChannels from "./locales/en/channels.json";
import enChat from "./locales/en/chat.json";
import enSettings from "./locales/en/settings.json";
import enVoice from "./locales/en/voice.json";
import enLanding from "./locales/en/landing.json";
import enServers from "./locales/en/servers.json";
import enDM from "./locales/en/dm.json";
import enE2EE from "./locales/en/e2ee.json";
import enSoundboard from "./locales/en/soundboard.json";
import enMusic from "./locales/en/music.json";
import enPrivacy from "./locales/en/privacy.json";
import enTerms from "./locales/en/terms.json";
import enAudit from "./locales/en/audit.json";

// ─── TR Translation Files ───
import trCommon from "./locales/tr/common.json";
import trAuth from "./locales/tr/auth.json";
import trChannels from "./locales/tr/channels.json";
import trChat from "./locales/tr/chat.json";
import trSettings from "./locales/tr/settings.json";
import trVoice from "./locales/tr/voice.json";
import trLanding from "./locales/tr/landing.json";
import trServers from "./locales/tr/servers.json";
import trDM from "./locales/tr/dm.json";
import trE2EE from "./locales/tr/e2ee.json";
import trSoundboard from "./locales/tr/soundboard.json";
import trMusic from "./locales/tr/music.json";
import trPrivacy from "./locales/tr/privacy.json";
import trTerms from "./locales/tr/terms.json";
import trAudit from "./locales/tr/audit.json";

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

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        auth: enAuth,
        channels: enChannels,
        chat: enChat,
        settings: enSettings,
        voice: enVoice,
        landing: enLanding,
        servers: enServers,
        dm: enDM,
        e2ee: enE2EE,
        soundboard: enSoundboard,
        music: enMusic,
        privacy: enPrivacy,
        terms: enTerms,
        audit: enAudit,
      },
      tr: {
        common: trCommon,
        auth: trAuth,
        channels: trChannels,
        chat: trChat,
        settings: trSettings,
        voice: trVoice,
        landing: trLanding,
        servers: trServers,
        dm: trDM,
        e2ee: trE2EE,
        soundboard: trSoundboard,
        music: trMusic,
        privacy: trPrivacy,
        terms: trTerms,
        audit: trAudit,
      },
    },

    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),

    defaultNS: "common",
    ns: ["common", "auth", "channels", "chat", "settings", "voice", "landing", "privacy", "terms", "servers", "dm", "e2ee", "soundboard", "music", "audit"],

    interpolation: {
      // React already handles XSS protection
      escapeValue: false,
    },

    detection: {
      // Only localStorage — we deliberately do NOT fall through to the
      // browser's navigator language. A fresh install always lands on
      // DEFAULT_LANGUAGE (Türkçe) regardless of OS/browser locale; users
      // can switch via Settings → Language and that choice is persisted.
      order: ["localStorage"],
      lookupLocalStorage: "language",
      caches: ["localStorage"],
    },
  });

/** Changes language and persists to localStorage. */
export function changeLanguage(lng: Language): void {
  i18n.changeLanguage(lng);
  localStorage.setItem("language", lng);
}

export default i18n;
