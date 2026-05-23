import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
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
