import { defineConfig, loadEnv, type ResolvedConfig } from "vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";

// Single source of truth for the shipped version: root package.json. Both
// Electron (which uses this version for the installer + autoUpdater) and
// the web bundle (where users may run an out-of-date client because the
// browser cached JS) read the same string via __APP_VERSION__.
//
// Surfaces server-side: clientLog attaches it to every diagnostic event,
// so logs can be filtered by version to find users stuck on stale builds.
//
// Read defensively: HF Space's Docker build copies only client/, so the
// root package.json isn't always reachable from this file's directory.
// First try ../package.json (local dev + Dockerfile's symlinked /app/
// package.json), then HICHAT_APP_VERSION env (set in the Dockerfile),
// finally fall back to "0.0.0" so the build never explodes — appVersion
// will still appear in logs, just as "0.0.0" for builds that lost the
// chain. Never broken, possibly imprecise.
function resolveAppVersion(): string {
  try {
    const txt = readFileSync(resolve(__dirname, "../package.json"), "utf8");
    const parsed = JSON.parse(txt) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    /* fall through */
  }
  if (process.env.HICHAT_APP_VERSION) return process.env.HICHAT_APP_VERSION;
  return "0.0.0";
}
const APP_VERSION = resolveAppVersion();
// Isolated local acceptance backends must not reuse an existing developer DB.
// This variable only configures the dev proxy; it is not exposed to the client.
const DEV_API_TARGET = process.env.HICHAT_DEV_API_TARGET || "http://localhost:9090";

// https://vite.dev/config/
// command: "serve" → dev server (vite dev), "build" → production build (vite build)
//
// Why does base differ between dev and build?
// - Dev (serve): base "/" → script src="/src/main.tsx" (absolute)
//   With SPA routing, nested paths like /invite/abc resolve JS modules correctly.
//   If "./" → browser resolves ./src/main.tsx as /invite/src/main.tsx → 404.
//
// - Build: base "./" → script src="./assets/index-xxx.js" (relative)
//   Electron file:// and Capacitor capacitor:// use relative paths.
//   Absolute "/" → wrong path resolution. Relative "./" works correctly.
export default defineConfig(({ command, mode }) => {
  const enabled = command === "build" && Boolean(loadEnv(mode, process.cwd(), "VITE_").VITE_SENTRY_DSN || process.env.VITE_SENTRY_DSN);
  const secret = (name: string) => process.env[name] || (existsSync(`/run/secrets/${name}`) ? readFileSync(`/run/secrets/${name}`, "utf8").trim() : "");
  const authToken = enabled ? secret("SENTRY_AUTH_TOKEN") : "";
  const org = enabled ? secret("SENTRY_ORG") : "";
  const project = enabled ? secret("SENTRY_PROJECT") : "";
  if (enabled && (!authToken || !org || !project)) throw new Error("Sentry production build requires SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT");
  let outputDirectory = resolve(__dirname, "dist");
  return {
  plugins: [react(), ...(enabled ? [sentryVitePlugin({
    authToken, org, project, telemetry: false,
    release: { name: APP_VERSION, create: false, finalize: false },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
    errorHandler: () => { throw new Error("Sentry source-map upload failed; release refused"); },
  })] : []), {
    name: "verify-private-sentry-maps",
    apply: "build" as const,
    configResolved(config: ResolvedConfig) { outputDirectory = resolve(config.root, config.build.outDir); },
    closeBundle: { order: "post" as const, sequential: true, handler() {
      const maps = readdirSync(outputDirectory, { recursive: true }).map(String).filter(name => name.endsWith(".map"));
      // With sourcemaps disabled these are only copied public vendor maps.
      if (!enabled) for (const name of maps) unlinkSync(resolve(outputDirectory, name));
      else if (maps.length) throw new Error("Source maps remain in release output");
    } },
  }],
  clearScreen: false,
  define: {
    // Inlined into the bundle at build time. Survives even when the
    // browser/Electron renderer is offline at log-emit time (the value
    // is a string constant in the compiled JS, not an env lookup).
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 3030,
    strictPort: true, // Fail if port is taken — Electron dev expects a fixed port
    // Backend API proxy — routes /api/* and /ws/* to the Go backend in development.
    proxy: {
      "/api": {
        target: DEV_API_TARGET,
        changeOrigin: true,
      },
      "/ws": {
        target: DEV_API_TARGET.replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
  envPrefix: ["VITE_"],
  base: command === "serve" ? "/" : "./",
  build: {
    // Electron (Chromium) and Capacitor (WKWebView/Android WebView) both support modern JS
    target: "chrome120",
    minify: true,
    sourcemap: enabled ? "hidden" : false,
    rollupOptions: {
      output: {
        // Manual chunk strategy — without this, the bundler stuffs every
        // shared dependency into AppLayout (1.45 MB) and the entry index
        // (1.77 MB), producing two long-poll JS files on first load.
        // Splitting heavy vendor groups lets the browser parallel-download
        // them and lets the CDN cache vendor chunks across deploys (only
        // the app chunks rotate on most releases).
        //
        // Boundaries:
        //  - vendor: React + router + state (loaded on every page, very stable)
        //  - livekit: voice/screen-share runtime (loaded only when joining
        //    a voice channel — but currently statically imported; the chunk
        //    still ships eagerly until VoiceProvider becomes lazy)
        //
        // emoji-mart is intentionally NOT in manualChunks: forcing it into a
        // named chunk made Vite treat it as a static dep of the entry and
        // inserted <link rel="modulepreload"> into index.html, even when the
        // only callers (EmojiPicker.tsx) dynamic-imported it. Letting Vite
        // auto-split it on dynamic-import boundaries keeps the ~500 KiB off
        // the /login critical path. (Mayıs 28 2026 Lighthouse follow-up.)
        //
        // Anything not matched here stays in the per-route chunks Vite
        // auto-splits via dynamic import.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/zustand/")
          ) {
            return "vendor";
          }
          // krisp-noise-filter is dynamic-imported from useAudioProcessor
          // only when the user opts into the Krisp engine — keep it OUT
          // of the livekit chunk so it splits naturally and isn't
          // downloaded by users sticking with the RNNoise default.
          if (id.includes("@livekit/krisp-noise-filter")) {
            return "krisp";
          }
          if (
            id.includes("livekit-client") ||
            id.includes("@livekit/components-react")
          ) {
            return "livekit";
          }
          return undefined;
        },
      },
      input: { index: resolve(__dirname, "index.html"), overlay: resolve(__dirname, "overlay.html") },
      onwarn(warning, defaultHandler) {
        // Suppress the "dynamic import will not move module into another
        // chunk" warning for our intentional circular-dep-avoidance pattern
        // in preferencesStore.ts. That store dynamic-imports settingsStore,
        // sidebarStore, and voiceStore because those three stores also import
        // preferencesStore (settings→prefs→settings cycle). Going static
        // would create a circular dep at module-load time where one side
        // would read `undefined`. Vite's warning is technically correct —
        // the split has no chunking benefit — but the import STYLE breaks
        // the cycle. We accept the single-chunk outcome and silence the
        // noise so real warnings stay visible.
        //
        // The warning is plugin-emitted (vite:reporter) with no stable
        // `code`, so match on message text + path. Conservative on both
        // sides — only the three known cycle-breaking dynamics are silenced.
        const msg = warning.message ?? "";
        if (
          /dynamic import will not move module into another chunk/i.test(msg) &&
          /preferencesStore\.ts/.test(msg) &&
          /(settingsStore|sidebarStore|voiceStore)\.ts/.test(msg)
        ) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
};
});
