import { isNativeApp } from "./constants";

export const RELEASE_BASE = "https://huggingface.co/datasets/infinayazilim/hichat-releases/resolve/main";

export type OSInfo = {
  os: "windows" | "macos" | "linux" | "mobile";
  url: string;
  i18nKey: string;
};

export function detectOS(): OSInfo {
  const ua = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/i.test(ua)) {
    return { os: "mobile", url: `${RELEASE_BASE}/hichat-setup.exe`, i18nKey: "hero_download_desktop" };
  }
  if (ua.includes("mac")) {
    return { os: "macos", url: `${RELEASE_BASE}/hichat-setup.dmg`, i18nKey: "hero_download_macos" };
  }
  if (ua.includes("linux")) {
    return { os: "linux", url: `${RELEASE_BASE}/hichat-setup.AppImage`, i18nKey: "hero_download_linux" };
  }
  return { os: "windows", url: `${RELEASE_BASE}/hichat-setup.exe`, i18nKey: "hero_download_windows" };
}

/** Returns true if running on desktop OS in a web browser (not Electron/Capacitor, not mobile) */
export function shouldShowDownloadPrompt(): boolean {
  if (isNativeApp()) return false;
  const { os } = detectOS();
  return os === "windows" || os === "macos" || os === "linux";
}
