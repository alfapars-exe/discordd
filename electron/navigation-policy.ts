/**
 * navigation-policy — Decides which URLs the renderer may navigate to
 * in-place. Pure function, no Electron import, so it is unit-testable under
 * plain node (see navigation-policy.test.ts), mirroring resolve-path.ts.
 *
 * Anything this rejects is opened in the user's default browser instead of
 * being rendered inside the chromeless Electron window — where the URL bar
 * is hidden and a malicious site could impersonate the app convincingly.
 *
 * Security bar: matching is done on PARSED URL components, not string
 * prefixes. A `startsWith` allowlist silently accepts prefix-extension
 * impersonation — "app://hichat.evil.example" and "http://localhost:30300"
 * both start with an allowed prefix while pointing somewhere else entirely.
 */

/**
 * An allowed navigation target. `hostname`/`port` omitted means "don't
 * care" — used only for file:, which has no meaningful host.
 */
type AllowedOrigin = {
  protocol: string;
  hostname?: string;
  port?: string;
};

const allowedNavigationOrigins: ReadonlyArray<AllowedOrigin> = [
  // Packaged production renderer. Served by the app:// protocol handler
  // registered in main.ts (setupAppProtocol) out of client/dist.
  //
  // This entry was MISSING, which meant that in a packaged build every real
  // navigation event was classified as external: will-navigate cancelled it
  // and tried to hand the app:// URL to the OS browser (which silently drops
  // unknown schemes). Any flow that performed a genuine document navigation
  // rather than a React Router push therefore dead-ended inside the .exe.
  { protocol: "app:", hostname: "hichat", port: "" },

  // Legacy production bundle path. loadFile()/file:// is no longer used for
  // the main window (file:// is a null origin, which breaks the cookie and
  // CORS flow — see main.ts), but keeping it allowed preserves current
  // behavior for any lingering absolute-file asset navigation.
  { protocol: "file:" },

  // Local dev server (electron:dev runs Vite on 3030).
  { protocol: "http:", hostname: "localhost", port: "3030" },
];

/**
 * True when `target` is one of our own origins and may be loaded inside the
 * app window. Malformed input, unknown schemes (javascript:, data:, about:),
 * and look-alike hosts all return false.
 */
export function isInternalNavigation(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    // Unparseable input is never a legitimate in-app navigation. This also
    // catches look-alikes whose port segment is non-numeric, e.g.
    // "http://localhost:3030.evil.example".
    return false;
  }

  return allowedNavigationOrigins.some(
    (allowed) =>
      allowed.protocol === url.protocol &&
      (allowed.hostname === undefined || allowed.hostname === url.hostname) &&
      (allowed.port === undefined || allowed.port === url.port),
  );
}
