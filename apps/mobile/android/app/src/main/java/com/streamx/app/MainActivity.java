package com.streamx.app;

import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    private PosterImageCache posterImages;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * Registered before super.onCreate, which is where Capacitor builds the
         * bridge — a plugin added afterwards is not in it, and the JS side gets
         * "not implemented" with nothing to explain why.
         */
        registerPlugin(StreamixPlayerPlugin.class);
        /* Device facts and the exit that takes the app out of memory when the
           viewer says yes to leaving. Nothing about video — see the plugin. */
        registerPlugin(StreamixDevicePlugin.class);
        /* The app listening to its own sound, so live subtitles work on a
           channel libVLC is playing — where the page has no audio to tap and
           there is no second connection to fetch it with. Registered here for
           the same reason as the rest; it does nothing until somebody switches
           subtitles on and answers two permission screens. */
        registerPlugin(StreamixListenPlugin.class);
        /* Whatever nobody catches, written down before the process goes. See
           CrashNotes: the page's own log dies with the page, so a crash used to
           leave nothing at all behind to read. */
        CrashNotes.catchEverything(getApplicationContext());
        super.onCreate(savedInstanceState);
        /*
         * BACK on Android 16 does not arrive as a key.
         *
         * An app targeting API 36 gets predictive back whether it asks or not, and
         * the system then delivers BACK to an `OnBackInvokedCallback` and never to
         * `onKeyDown`. So `askPageAboutBack` below was simply not called on an
         * Android 16 television: BACK went to Capacitor's own callback, which
         * backgrounded the app from any page that had no WebView history — the
         * legal pages, every sheet. Registered after super.onCreate so it runs
         * before Capacitor's (the dispatcher asks the newest callback first).
         * Older systems keep sending the key, which `onKeyDown` handles; the two
         * never both fire for one press.
         */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!askPageAboutBack(false)) moveTaskToBack(true);
            }
        });
        /* In the app's own files now, not the system cache it can empty at will:
           covers are kept for good — see PosterImageCache. */
        posterImages = new PosterImageCache(getFilesDir(), getCacheDir());
        bridge.setWebViewClient(new MediaFriendlyClient());
        routeServiceWorkerRequests();
        armPageWatchdog();
        immersiveUnlessTelevision();
        rehideAfterKeyboard();
    }

    /**
     * The keyboard brings the bars back, and nothing else takes them away again.
     *
     * Found on a phone: after typing a subscription link the status bar stayed,
     * over the page's header, for the rest of the session — the window keeps its
     * focus while a keyboard comes and goes, so `onWindowFocusChanged` never
     * runs. So the moment the keyboard CLOSES, the bars are hidden again. Only on
     * that edge: bars a viewer swipes in on purpose are left alone.
     */
    private boolean imeWasShowing = false;

    private void rehideAfterKeyboard() {
        if (getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)) return;
        final android.view.View decor = getWindow().getDecorView();
        decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            final WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            if (insets == null) return;
            final boolean ime = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (imeWasShowing && !ime) immersiveUnlessTelevision();
            imeWasShowing = ime;
        });
    }

    /**
     * A phone or a tablet gets the whole screen; a television is left alone.
     *
     * The app always runs sideways (`sensorLandscape` in the manifest), and on a
     * phone held that way the status bar and the navigation buttons take a
     * tenth of the height from a video app. Hidden the way video apps hide them:
     * a swipe from the edge brings them back for a moment. A television has no
     * such bars and is never touched here — LEANBACK is Android's own word for
     * "this is a TV". The notch is not drawn into (the default cutout mode keeps
     * a sideways window clear of it), so nothing sits under the camera.
     */
    private void immersiveUnlessTelevision() {
        try {
            if (getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)) return;
            final WindowInsetsControllerCompat bars =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            bars.hide(WindowInsetsCompat.Type.systemBars());
        } catch (Throwable ignored) {
            /* An odd device keeps its bars; the app works either way. */
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        /* A dialog, the keyboard or the recents screen brings the bars back;
           coming back to the app hides them again. */
        if (hasFocus) immersiveUnlessTelevision();
    }

    /**
     * The page's own requests, when its service worker is the one making them.
     *
     * Once a service worker controls the page, Android hands every request that
     * worker lets through to the ServiceWorkerClient — not to the WebViewClient
     * above — and Capacitor's client answers only its own files. So neither the
     * logo store nor the poster cache ever saw an image in this app: measured on
     * the TV emulator, fourteen logo requests on the Live list, every one of them
     * with its file already on disk, and zero answered from it — the rows drew
     * their initials instead. The same order as the WebViewClient: the app's own
     * files, the logos kept on the device, the poster cache, then the network.
     */
    /**
     * `https://localhost/_img?u=<plain-http picture>` — the page's way of showing
     * a plain-http logo or cover at all (see `nativeImage` in lib/localRead.ts:
     * the WebView blocks plain-http images on this https page, whatever the
     * mixed-content setting says). Answered here, before Capacitor's own file
     * server can take the path for a file: the logo kept on the device, else the
     * poster cache (fetching the original itself), else a quick 404 so the tile
     * falls back to its borrowed logo or its initials instead of waiting.
     * Everything from the device; nothing through our server.
     */
    private WebResourceResponse nativeImage(WebResourceRequest request) {
        if (request == null || request.getUrl() == null) return null;
        final Uri u = request.getUrl();
        if (!"localhost".equalsIgnoreCase(u.getHost()) || !"/_img".equals(u.getPath())) return null;
        final WebResourceResponse logo = LogoStore.get(getApplicationContext()).serveUrl(u.toString());
        if (logo != null) return logo;
        final WebResourceResponse poster = posterImages == null ? null : posterImages.interceptUrl(u.getQueryParameter("u"));
        if (poster != null) return poster;
        final java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
            new java.io.ByteArrayInputStream(new byte[0]));
    }

    private void routeServiceWorkerRequests() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        try {
            android.webkit.ServiceWorkerController.getInstance().setServiceWorkerClient(
                new android.webkit.ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        final WebResourceResponse picture = nativeImage(request);
                        if (picture != null) return picture;
                        final WebResourceResponse local = bridge.getLocalServer().shouldInterceptRequest(request);
                        if (local != null) return local;
                        final WebResourceResponse logo = LogoStore.get(getApplicationContext()).serve(request);
                        if (logo != null) return logo;
                        return posterImages == null ? null : posterImages.intercept(request);
                    }
                });
        } catch (Throwable ignored) {
            /* A WebView without service-worker support: the WebViewClient path is all there is. */
        }
    }

    /**
     * A page that never finishes loading is reloaded, once.
     *
     * Measured twice on the TV emulator, right after an update was installed over
     * the running app: the WebView asked for `index.html`, got part of it — enough
     * for the preload scanner to fetch every script and stylesheet — and the rest
     * never arrived. `performance` read `responseEnd: 0` a minute later, the
     * document sat at `readyState: loading` with no `<body>`, and the television
     * showed the ground colour and nothing else. No script of ours had run, so
     * nothing in the page could notice; a force-stop was the only way out, and a
     * viewer does not know to do that.
     *
     * So the activity watches: if the page has no body fifteen seconds after
     * launch, it is loaded again, and looked at again fifteen seconds later — at
     * most twice, so a page that is genuinely broken does not reload forever.
     * Fifteen rather than less because a cold start on a slow box is
     * legitimately several seconds, and a reload in the middle of a good one
     * would cost more than it saves.
     */
    private boolean pageFinished = false;
    private int pageReloads = 0;
    /** First look this long after launch; a cold start on a slow box is legitimately several seconds. */
    private static final long PAGE_CHECK_MS = 15_000;
    /** Reload at most this many times — a page that is truly broken must not loop forever. */
    private static final int PAGE_RELOADS = 2;

    /*
     * The check asks the PAGE, not the WebView's own counters.
     *
     * It used to trust `onPageFinished` and `getProgress()`, and on the TV
     * emulator (2026-09-29) the stuck page satisfied both: right after an update
     * was installed the document stayed at no `<html>` element at all for over
     * two minutes and this never reloaded. A reload fixed it in two seconds. So
     * the question is put to the document itself — has it a body yet — and a
     * page that cannot even answer in three seconds counts as stuck too.
     */
    private void armPageWatchdog() {
        final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        main.postDelayed(() -> checkPage(main), PAGE_CHECK_MS);
    }

    private void checkPage(android.os.Handler main) {
        if (isFinishing() || bridge == null || pageReloads >= PAGE_RELOADS) return;
        final WebView web = bridge.getWebView();
        if (web == null) return;
        final boolean[] answered = { false };
        final Runnable reload = () -> {
            if (isFinishing() || pageReloads >= PAGE_RELOADS) return;
            pageReloads += 1;
            CrashNotes.write(getApplicationContext(), "the page had not loaded after 15s",
                "Reloaded (" + pageReloads + " of " + PAGE_RELOADS + "). Seen right after an update was installed over the app.");
            web.reload();
            main.postDelayed(() -> checkPage(main), PAGE_CHECK_MS);
        };
        web.evaluateJavascript("document.body ? 'ok' : 'stuck'", (v) -> {
            answered[0] = true;
            if (v == null || !v.contains("ok")) reload.run();
        });
        main.postDelayed(() -> { if (!answered[0]) reload.run(); }, 3_000);
    }

    /**
     * TLS on a stream host is the stream host's problem, not the viewer's.
     *
     * Free playlists are full of hosts serving an expired or mis-named
     * certificate (`5centscdn` still serves a 2020 leaf), and a browser rightly
     * refuses them. But this is a television, not a bank: VLC, Kodi and every
     * IPTV player people compare this app with play those channels, and "the
     * certificate is wrong" is not a sentence a viewer can act on. So a
     * certificate error on a MEDIA host is accepted, and the request proceeds.
     *
     * Never for our own origins. The app's shell (`https://localhost`) and its
     * API (the box, by IP and port) carry the credentials and the code; a bad
     * certificate THERE is an attack or a misconfiguration, and either one must
     * fail loudly. The list is short and explicit rather than a pattern, so it
     * cannot accidentally widen.
     *
     * Poster grids additionally go through {@link PosterImageCache}: Capacitor's
     * local-asset intercept runs first ({@code super}), then external image
     * GETs are served from a downsampled disk cache. Stream URLs are excluded.
     */
    private final class MediaFriendlyClient extends BridgeWebViewClient {
        MediaFriendlyClient() { super(MainActivity.this.bridge); }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            pageFinished = true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            final WebResourceResponse picture = nativeImage(request);
            if (picture != null) return picture;
            final WebResourceResponse local = super.shouldInterceptRequest(view, request);
            if (local != null) return local;
            /* Logos downloaded ahead of time first (LogoStore), then the poster
               cache, then the network: each step returns null to hand on. */
            final WebResourceResponse logo = LogoStore.get(getApplicationContext()).serve(request);
            if (logo != null) return logo;
            if (posterImages == null) return null;
            return posterImages.intercept(request);
        }

        /**
         * The renderer died. Do not take the app with it.
         *
         * Chromium runs the page in its own process, and on a television that
         * process is the first thing the kernel kills when memory runs short —
         * which on this app means a catalogue, a poster grid and a video buffer
         * all in one renderer. Android's rule is explicit: if nothing overrides
         * this, **the app process is killed too**. So the failure a viewer
         * describes as "it played for ten seconds, went black, and then the app
         * closed" needs no bug of ours to produce it, and leaves nothing behind
         * to read because the log lived in the renderer that just died.
         *
         * Returning true says we have handled it. The dead WebView can never be
         * used again — every call on it from here would throw — so it is taken
         * out of the view tree and destroyed, and the activity is recreated,
         * which is what rebuilds Capacitor's bridge and loads the app again. The
         * viewer sees the app restart instead of disappear, and the next run
         * finds the note saying why.
         */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            final boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && detail != null && detail.didCrash();
            CrashNotes.write(
                getApplicationContext(),
                "the web page's renderer " + (crashed ? "crashed" : "was killed to reclaim memory"),
                "The picture and the whole interface are drawn by this process. "
                    + "Android ends it when the box runs out of memory, and the app is "
                    + "restarted here rather than left to be killed with it.");
            try {
                final ViewGroup parent = (ViewGroup) view.getParent();
                if (parent != null) parent.removeView(view);
                view.destroy();
            } catch (Throwable ignored) {
                /* Already gone. The recreate below is what matters. */
            }
            recreate();
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            /* Never proceed past a certificate error: Google Play rejects apps
               that do, and a page or image that fails TLS validation simply
               does not load. */
            handler.cancel();
        }
    }

    /**
     * Forward the remote buttons the WebView throws away.
     *
     * Chromium translates most of a handset into DOM key events — the D-pad,
     * Enter, Back, and the transport keys all arrive as `KeyboardEvent.key`. It
     * does NOT translate the ones that matter most to an IPTV app: KEYCODE_CAPTIONS
     * (the subtitle button), KEYCODE_GUIDE, KEYCODE_INFO, KEYCODE_TV_ZOOM_MODE and
     * the channel rocker on many set-top boxes reach the page as nothing at all.
     * So the raw keycode goes over to JS and `lib/remoteKeys.ts` names it. Three of the
     * numbers in THAT table were wrong — 172, 174 and 222 were each mapped to the
     * wrong intent — which is a hazard specific to this arrangement: the constants
     * here are symbolic and cannot be wrong, so nothing on this side could reveal it.
     * The values were re-derived from `javap -constants android.view.KeyEvent` and the
     * test now pins every one of them.
     *
     * Only the codes the page actually uses are forwarded, and only those are
     * consumed — returning true for everything would break D-pad focus movement,
     * volume and back, all of which the system and the WebView handle correctly.
     */
    private static final int[] FORWARDED = {
        // ── tracks: the two the WebView never translates, and the two it never will ──
        KeyEvent.KEYCODE_CAPTIONS,          // 175 — the subtitle button
        KeyEvent.KEYCODE_TV_TELETEXT,       // 233 — subtitles on European handsets
        KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK, // 222 — the audio-language button

        // ── destinations ──
        KeyEvent.KEYCODE_GUIDE,             // 172
        KeyEvent.KEYCODE_INFO,              // 165
        KeyEvent.KEYCODE_SEARCH,            // 84
        KeyEvent.KEYCODE_BOOKMARK,          // 174 — the star / favourite button
        KeyEvent.KEYCODE_DVR,               // 173 — recordings, i.e. catch-up
        KeyEvent.KEYCODE_SETTINGS,          // 176
        KeyEvent.KEYCODE_TV,                // 170 — the "live TV" button
        KeyEvent.KEYCODE_TV_CONTENTS_MENU,  // 256
        KeyEvent.KEYCODE_MEDIA_TOP_MENU,    // 226

        // ── the four coloured buttons ──
        // Nothing in a WebView has ever seen these, and they are the whole basis of
        // the on-screen legend: every TV platform expects a screen to say what its
        // colours do. See lib/keys.ts and components/HintBar.tsx.
        KeyEvent.KEYCODE_PROG_RED,          // 183
        KeyEvent.KEYCODE_PROG_GREEN,        // 184
        KeyEvent.KEYCODE_PROG_YELLOW,       // 185
        KeyEvent.KEYCODE_PROG_BLUE,         // 186

        // ── picture ──
        KeyEvent.KEYCODE_TV_ZOOM_MODE,      // 255 — "picture size"
        KeyEvent.KEYCODE_ZOOM_IN,           // 168
        KeyEvent.KEYCODE_ZOOM_OUT,          // 169
        KeyEvent.KEYCODE_WINDOW,            // 171 — PIP on Android TV handsets

        // ── channels and transport ──
        KeyEvent.KEYCODE_CHANNEL_UP,        // 166
        KeyEvent.KEYCODE_CHANNEL_DOWN,      // 167
        KeyEvent.KEYCODE_LAST_CHANNEL,      // 229 — back to the previous channel
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,  // 85
        KeyEvent.KEYCODE_MEDIA_PLAY,        // 126
        KeyEvent.KEYCODE_MEDIA_PAUSE,       // 127
        KeyEvent.KEYCODE_MEDIA_STOP,        // 86
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,// 90
        KeyEvent.KEYCODE_MEDIA_REWIND,      // 89
        KeyEvent.KEYCODE_MEDIA_NEXT,        // 87
        KeyEvent.KEYCODE_MEDIA_PREVIOUS,    // 88
        KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD,  // 272
        KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD, // 273
    };

    /**
     * Back, which nothing handled before this.
     *
     * BACK went straight to the system, so from three screens deep it left the app
     * — and with a sheet or the player open it did nothing visible at all. The page
     * knows what is open and this does not, so it asks.
     *
     * The ask is asynchronous, which is why the key is always consumed and the
     * decision made in the callback: there is no way to hand a key back to
     * `super` once a JavaScript round trip has started. `moveTaskToBack` rather
     * than `finish()` when nothing claims it — on Android, back on the first
     * screen means leave, not quit, and finishing here would throw away the whole
     * catalogue the app just built.
     *
     * Nothing claiming it is now the rare case at Home. The page claims the third
     * press of its exit gesture too and asks "are you sure you want to exit"; a
     * yes ends the app through `StreamixDevicePlugin.exitApp`, out of recents and
     * out of memory, which is a decision this method has no business making on a
     * key press. A decline still arrives from a page that cannot ask — the
     * first-run door, a retired build's screen, a page that never finished
     * booting — and backgrounding is still the right answer to that.
     *
     * Whether the press is an auto-repeat goes with it, because a held key is not
     * three presses: counted as three, one hold would open the exit question and
     * the next repeat would close it. `lib/nativeBack.ts` does not count a repeat
     * towards the gesture and the exit dialog does not close on one; a page from
     * before this change ignores the argument.
     */
    private boolean askPageAboutBack(boolean repeat) {
        if (bridge == null || bridge.getWebView() == null) return false;
        bridge.getWebView().evaluateJavascript(
            "(function(){try{return !!(window.__streamixBack && window.__streamixBack(" + repeat + "))}"
                + "catch(e){return false}})()",
            value -> {
                if (!"true".equals(value)) moveTaskToBack(true);
            });
        return true;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && askPageAboutBack(event.getRepeatCount() > 0)) return true;
        for (int code : FORWARDED) {
            if (code != keyCode) continue;
            /*
             * A CustomEvent rather than a Capacitor plugin call: a button press has
             * to reach the page in the same frame it happened, and the plugin
             * bridge is a round trip through a message queue. `bridge` is null
             * until super.onCreate has run, so an early press falls through to the
             * system rather than crashing.
             */
            if (bridge != null && bridge.getWebView() != null) {
                final String js = "window.dispatchEvent(new CustomEvent('streamix:remotekey',"
                    + "{detail:{keyCode:" + keyCode + "}}))";
                bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
                return true;
            }
            break;
        }
        return super.onKeyDown(keyCode, event);
    }
}
