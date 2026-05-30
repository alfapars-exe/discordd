/**
 * publicAssetBase — resolves the base URL for an asset directory shipped under
 * client/public/<dir>/ (e.g. public/dtln, public/deepfilter), used by audio
 * engines whose loader appends filenames to a base and passes the result
 * straight to fetch().
 *
 * fetch() resolves a relative base against document.baseURI (the live SPA URL),
 * so the base must account for the routing model:
 *
 *  - Web (BrowserRouter, deep paths like /channels/<id>): an ORIGIN-ABSOLUTE
 *    "/<dir>". The assets sit at the origin root — Vite copies
 *    client/public/<dir> → dist/<dir>, embedded (`//go:embed all:dist`) and
 *    served by the Go server — so "/<dir>" is correct on every route. A relative
 *    "./<dir>" would resolve against the current deep route (/channels/<id>/<dir>/…)
 *    → 404 → SPA fallback returns index.html → asset load throws → the engine
 *    silently falls back to RNNoise.
 *  - Native (Electron file://, Capacitor capacitor://): the app uses HashRouter,
 *    so document.baseURI stays pinned at index.html and Vite's base is "./". The
 *    relative "${baseUrl}<dir>" resolves next to index.html where the bundled
 *    assets sit; an origin-absolute "/<dir>" would hit the scheme/filesystem
 *    root → 404.
 *
 * Pure (no import.meta / window access) so it is unit-testable in isolation.
 *
 * @param dir      public/ subdirectory name, no slashes (e.g. "dtln", "deepfilter")
 * @param native   true for Electron/Capacitor shells (see utils/constants.isNativeApp)
 * @param baseUrl  import.meta.env.BASE_URL ("/" in dev, "./" in prod builds)
 */
export function resolvePublicAssetBase(dir: string, native: boolean, baseUrl: string): string {
  return native ? `${baseUrl}${dir}` : `/${dir}`;
}
