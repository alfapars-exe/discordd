/**
 * deepfilterAssets — resolves where the DeepFilterNet3 WASM + ONNX model are
 * served from.
 *
 * The deepfilternet3-noise-filter package's AssetLoader appends
 * `/v2/pkg/df_bg.wasm` and `/v2/models/DeepFilterNet3_onnx.tar.gz` to a base
 * URL and passes the result STRAIGHT TO fetch(). fetch() resolves a relative
 * base against `document.baseURI` (the live SPA URL), NOT against the JS
 * module — so the base must be chosen with the routing model in mind.
 */

/**
 * Returns the base URL for the DeepFilterNet3 assets.
 *
 * Web (BrowserRouter, deep paths like `/channels/<id>`): an ORIGIN-ABSOLUTE
 * `/deepfilter`. The assets live at the origin root — Vite copies
 * `client/public/deepfilter` → `dist/deepfilter`, which the Go server embeds
 * (`//go:embed all:dist`) and serves. A relative `./deepfilter` would resolve
 * against the current deep route (`/channels/<id>/deepfilter/…`) → 404 → SPA
 * fallback returns `index.html` → `WebAssembly.compile(HTML)` throws → the
 * engine silently falls back to RNNoise.
 *
 * Native (Electron `file://`, Capacitor `capacitor://`): the app uses
 * HashRouter, so `document.baseURI` stays pinned at `index.html` and Vite's
 * `base` is `./`. The relative `${baseUrl}deepfilter` resolves next to
 * `index.html`, where the bundled assets actually sit; an origin-absolute
 * `/deepfilter` would hit the scheme/filesystem root and 404.
 *
 * @param native  true for Electron/Capacitor shells (see utils/constants.isNativeApp)
 * @param baseUrl  import.meta.env.BASE_URL ("/" in dev, "./" in prod builds)
 */
export function resolveDeepFilterBase(native: boolean, baseUrl: string): string {
  return native ? `${baseUrl}deepfilter` : "/deepfilter";
}
