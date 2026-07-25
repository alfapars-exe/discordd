import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
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
export default defineConfig(({ command }) => ({
  plugins: [react()],
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
        target: "http://localhost:9090",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:9090",
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
    sourcemap: false,
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
}));
