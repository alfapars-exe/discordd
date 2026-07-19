package net.mqvi.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.util.List;

public class MainActivity extends BridgeActivity {

    // Track the last emitted keyboard inset so per-frame animation callbacks
    // don't spam evaluateJavascript with duplicates (WebView IPC is not free).
    private float lastKeyboardInsetDp = -1f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallPlugin.class);
        registerPlugin(ScreenSharePlugin.class);
        super.onCreate(savedInstanceState);

        // Inject real safe area inset values as CSS custom properties on <html>.
        // Android WebView's env(safe-area-inset-*) returns 0 (Chromium < 140 bug),
        // so we read WindowInsets natively and set --safe-area-inset-* via JS.
        // Ref: https://medium.com/androiddevelopers/make-webviews-edge-to-edge-a6ef319adfac
        ViewCompat.setOnApplyWindowInsetsListener(
            getBridge().getWebView(),
            (view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                );
                float density = getResources().getDisplayMetrics().density;
                float top = insets.top / density;
                float bottom = insets.bottom / density;
                float left = insets.left / density;
                float right = insets.right / density;

                String js = String.format(
                    "document.documentElement.style.setProperty('--safe-area-inset-top','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-bottom','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-left','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-right','%.1fpx');",
                    top, bottom, left, right
                );
                getBridge().getWebView().evaluateJavascript(js, null);

                return windowInsets;
            }
        );

        installKeyboardInsetTracking();
    }

    /**
     * Push live IME (soft keyboard) height into a CSS var so the layout can
     * lift the composer/message list above it. The manifest uses adjustNothing,
     * meaning Android won't resize the window on keyboard open — we do it in
     * CSS via --keyboard-inset (see globals.css :root and #root).
     */
    private void installKeyboardInsetTracking() {
        WebView webView = getBridge().getWebView();
        ViewCompat.setWindowInsetsAnimationCallback(
            webView,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                @NonNull
                @Override
                public WindowInsetsCompat onProgress(
                    @NonNull WindowInsetsCompat insets,
                    @NonNull List<WindowInsetsAnimationCompat> runningAnimations
                ) {
                    emitKeyboardInset(webView, insets);
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    // Capture the authoritative resting state — onProgress can
                    // finish a frame short of the true end value on some devices.
                    WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(webView);
                    if (rootInsets != null) emitKeyboardInset(webView, rootInsets);
                }
            }
        );
    }

    private void emitKeyboardInset(WebView webView, WindowInsetsCompat windowInsets) {
        Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
        Insets navBar = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
        // Only report the portion of the IME that overlaps content ABOVE the
        // nav bar — the nav-bar area is already covered by safe-area-inset-bottom.
        int keyboardPx = Math.max(0, ime.bottom - navBar.bottom);
        float density = getResources().getDisplayMetrics().density;
        float keyboardDp = keyboardPx / density;

        // Perf: skip the WebView IPC if the value hasn't moved. WindowInsets
        // animation callbacks fire every VSYNC (~16ms) so duplicates are common.
        if (Math.abs(keyboardDp - lastKeyboardInsetDp) < 0.5f) return;
        lastKeyboardInsetDp = keyboardDp;

        String js = String.format(
            "document.documentElement.style.setProperty('--keyboard-inset','%.1fpx');",
            keyboardDp
        );
        webView.evaluateJavascript(js, null);
    }
}
