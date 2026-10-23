package com.yeylandwutani.kitchenboard;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * Kitchen Board: a full-screen WebView.
 *
 * Standalone mode serves the bundled web/ folder from the APK under a fixed https origin, so the
 * board's data (browser storage) survives between launches. Home-server mode loads the board from
 * the Docker server instead, so every screen shares one board.
 *
 * Only the bundled origin, the weather API and the configured home server are reachable.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.kitchenboard.local";
    private static final String APP_URL = "https://" + HOST + "/index.html";
    private static final String[] NET_HOSTS = {"api.open-meteo.com", "geocoding-api.open-meteo.com"};
    private static final int REQ_FILE = 71;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> chooser;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("kb", MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " KitchenBoardApp/1.0");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.addJavascriptInterface(new Bridge(), "KBApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                if (HOST.equals(host)) return asset(u.getPath());
                if (networkAllowed(host)) return null; // let the WebView fetch it
                return blocked();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                return !(HOST.equals(host) || networkAllowed(host));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(i, "Choose photos"), REQ_FILE);
                } catch (Exception e) {
                    chooser = null;
                    cb.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        applyBars();
        web.loadUrl(startUrl());
    }

    /* ---------- loading ---------- */

    private String server() { return prefs.getString("server", ""); }

    private String startUrl() {
        String sv = server();
        return sv.isEmpty() ? APP_URL : sv;
    }

    private boolean networkAllowed(String host) {
        for (String h : NET_HOSTS) if (h.equals(host)) return true;
        String sv = server();
        if (!sv.isEmpty()) {
            String sh = Uri.parse(sv).getHost();
            if (sh != null && sh.toLowerCase(Locale.ROOT).equals(host)) return true;
        }
        return false;
    }

    private WebResourceResponse asset(String path) {
        if (path == null || path.equals("/")) path = "/index.html";
        try {
            InputStream in = getAssets().open(path.substring(1));
            WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
            r.setResponseHeaders(java.util.Collections.singletonMap("Cache-Control", "no-cache"));
            return r;
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, new ByteArrayInputStream(new byte[0]));
        }
    }

    private WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Blocked", null, new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /* ---------- system bars, back button, file picker ---------- */

    private boolean immersive() { return prefs.getBoolean("immersive", true); }

    @SuppressWarnings("deprecation")
    private void applyBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(!immersive());
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (immersive()) {
                    c.hide(WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(WindowInsets.Type.systemBars());
                }
            }
        } else {
            int f = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            if (immersive()) {
                f |= View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            }
            getWindow().getDecorView().setSystemUiVisibility(f);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        applyBars();
        web.postDelayed(() -> web.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null), 400);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyBars();
    }

    /** Back closes an open sheet first, then leaves the app. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.__back && window.__back()) ? 'handled' : 'no'", value -> {
            if (value == null || !value.contains("handled")) MainActivity.super.onBackPressed();
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, res, data); return; }
        if (chooser == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        chooser.onReceiveValue(out);
        chooser = null;
    }

    @Override
    protected void onDestroy() {
        if (chooser != null) { chooser.onReceiveValue(null); chooser = null; }
        super.onDestroy();
    }

    /* ---------- bridge the page calls as window.KBApp ---------- */

    private class Bridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public boolean isLarge() {
            return getResources().getConfiguration().smallestScreenWidthDp >= 600;
        }

        @JavascriptInterface
        public boolean immersive() { return MainActivity.this.immersive(); }

        @JavascriptInterface
        public void setImmersive(final boolean on) {
            prefs.edit().putBoolean("immersive", on).apply();
            runOnUiThread(MainActivity.this::applyBars);
        }

        @JavascriptInterface
        public String getServer() { return server(); }

        /** Empty string goes back to the standalone board stored on this device. */
        @JavascriptInterface
        public void setServer(String url) {
            String u = url == null ? "" : url.trim();
            if (!u.isEmpty()) {
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
                if (Uri.parse(u).getHost() == null) u = "";
                else if (!u.endsWith("/")) u += "/";
            }
            prefs.edit().putString("server", u).apply();
            runOnUiThread(() -> web.loadUrl(startUrl()));
        }

        /** Screen pinning, so a kid cannot swipe out of the board. Android asks for confirmation. */
        @JavascriptInterface
        public void pin() {
            runOnUiThread(() -> { try { startLockTask(); } catch (Exception ignored) { } });
        }
    }
}
