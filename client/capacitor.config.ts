import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "net.mqvi.app",
  appName: "mqvi",
  webDir: "dist",

  // Dev server — uncomment for live reload during development:
  // server: {
  //   url: "http://<YOUR_LOCAL_IP>:3030",
  //   cleartext: true,
  // },

  ios: {
    // WKWebView settings for WebRTC support
    contentInset: "automatic",
    allowsLinkPreview: false,
    scrollEnabled: false,
  },

  android: {
    allowMixedContent: true,
  },

  plugins: {
    Keyboard: {
      // "native" — Capacitor resizes the WebView when the soft keyboard
      // shows, matching native iOS/Android keyboard avoidance. "none"
      // (our prior value) left the WebView full-screen and forced the
      // app to handle keyboard avoidance manually, which combined with
      // sub-16px inputs to trigger Safari's auto-zoom-on-focus.
      resize: "native",
    },
  },
};

export default config;
