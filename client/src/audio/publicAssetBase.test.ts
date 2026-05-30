import { describe, it, expect } from "vitest";
import { resolvePublicAssetBase } from "./publicAssetBase";

describe("resolvePublicAssetBase", () => {
  // Regression guard for the silent "engine fails to load → RNNoise fallback"
  // class of bug. DeepFilter hit the web side (relative base 404'd on deep
  // routes); DTLN hits the native side (origin-absolute "/dtln/" 404s under
  // file://). Both must resolve correctly per environment.
  it("returns an origin-absolute base on web, independent of Vite base", () => {
    expect(resolvePublicAssetBase("dtln", false, "./")).toBe("/dtln");
    expect(resolvePublicAssetBase("dtln", false, "/")).toBe("/dtln");
    expect(resolvePublicAssetBase("deepfilter", false, "./")).toBe("/deepfilter");
  });

  it("never returns a route-relative base on web", () => {
    const base = resolvePublicAssetBase("dtln", false, "./");
    expect(base.startsWith("/")).toBe(true);
    expect(base.startsWith("./")).toBe(false);
  });

  it("keeps the Vite-relative base for native shells (Electron/Capacitor)", () => {
    // Native uses HashRouter + Vite base "./" → document.baseURI stays at
    // index.html, so a relative base resolves next to the bundled assets.
    expect(resolvePublicAssetBase("dtln", true, "./")).toBe("./dtln");
    expect(resolvePublicAssetBase("deepfilter", true, "./")).toBe("./deepfilter");
  });

  it("honours a non-default native base", () => {
    expect(resolvePublicAssetBase("dtln", true, "/app/")).toBe("/app/dtln");
  });

  it("stays consistent with the DeepFilter wrapper for the deepfilter dir", () => {
    // resolveDeepFilterBase delegates here; both arms must match the old inline
    // behaviour `native ? `${baseUrl}deepfilter` : "/deepfilter"`.
    expect(resolvePublicAssetBase("deepfilter", false, "./")).toBe("/deepfilter");
    expect(resolvePublicAssetBase("deepfilter", true, "./")).toBe("./deepfilter");
  });
});
