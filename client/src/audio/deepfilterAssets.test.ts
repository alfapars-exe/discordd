import { describe, it, expect } from "vitest";
import { resolveDeepFilterBase } from "./deepfilterAssets";

describe("resolveDeepFilterBase", () => {
  // Regression guard for the "DeepFilterNet3 yüklenemedi, RNNoise'a geçildi"
  // bug: on web the base MUST be origin-absolute, otherwise fetch() resolves
  // it against the current deep BrowserRouter route (e.g. /channels/<id>) and
  // 404s → SPA fallback returns index.html → WebAssembly.compile(HTML) throws.
  it("returns an origin-absolute base on web, independent of Vite base", () => {
    // Production web build ships with import.meta.env.BASE_URL === "./".
    expect(resolveDeepFilterBase(false, "./")).toBe("/deepfilter");
    // Dev server ships with "/".
    expect(resolveDeepFilterBase(false, "/")).toBe("/deepfilter");
  });

  it("never returns a route-relative base on web", () => {
    const base = resolveDeepFilterBase(false, "./");
    expect(base.startsWith("/")).toBe(true);
    expect(base.startsWith("./")).toBe(false);
  });

  it("keeps the Vite-relative base for native shells (Electron/Capacitor)", () => {
    // Native uses HashRouter + Vite base "./", so the relative base resolves
    // next to index.html where the bundled assets sit.
    expect(resolveDeepFilterBase(true, "./")).toBe("./deepfilter");
  });

  it("honours a non-default native base", () => {
    expect(resolveDeepFilterBase(true, "/")).toBe("/deepfilter");
    expect(resolveDeepFilterBase(true, "/app/")).toBe("/app/deepfilter");
  });
});
