package com.streamx.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.PixelCopy;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The reason the app is not just the website in a box.
 *
 * A WebView plays what Chromium can decode, which on this catalogue leaves out
 * the interesting parts: HEVC is patent-encumbered and absent from many builds,
 * AC-3 and E-AC-3 are what European broadcast channels carry and are almost never
 * present, MP2 audio is on older DVB channels, and MKV is not a browser container
 * at all. libVLC decodes all of them — in hardware through MediaCodec where the
 * device has a decoder, and in software where it does not.
 *
 * Two decisions worth stating, because both are one-way doors:
 *
 * 1. **Hole punching.** The video is a real Android surface sitting BEHIND a
 *    transparent WebView, not a `<video>` element. That is what makes hardware
 *    decoding possible, and it means CSS can no longer composite over the
 *    picture: the page draws the controls above it, the surface draws the frames,
 *    and the two only meet in the compositor. Subtitles rendered by libVLC are
 *    drawn on the surface; anything the page wants over the video has to be page
 *    chrome.
 * 2. **The web player stays.** This plugin is chosen per stream, not globally —
 *    see `nativePlayer.ts`. H.264/AAC over HLS is perfectly happy in the WebView
 *    and keeps working there, which means one code path is not carrying the whole
 *    app's playback on a platform nobody can debug remotely.
 */
@CapacitorPlugin(name = "StreamixPlayer")
public class StreamixPlayerPlugin extends Plugin {

    private LibVLC libVlc;
    private MediaPlayer player;
    /** See OneConnectionRelay — created on first use, kept for the plugin's life. */
    private OneConnectionRelay relay;
    private VLCVideoLayout videoLayout;
    private FrameLayout host;
    private boolean transparentWebView = false;

    /**
     * What the WebView is painted with when it is NOT a window onto the video.
     *
     * The brand ground, matching `res/values/brand.xml`. Anything else — white,
     * which is the WebView's default — is a flash on a dark app.
     */
    private static final int OPAQUE_BG = 0xFF0B1013;
    /** Held while something is playing, so the audio stack knows we exist. */
    private AudioFocusRequest focusRequest;
    private boolean hasFocus = false;
    /** True while playback was interrupted by something else taking the audio. */
    private boolean pausedByFocusLoss = false;
    /** True while playback was interrupted by the app going to the background. */
    private boolean pausedByBackground = false;

    /* ── the four things a video app on Android has to do, and did not ──────────
       None of these are about decoding, which is why they were missing: the plugin
       was built to answer "can this device play the stream" and nothing else. All
       four are visible to anyone actually watching something.
    */

    /**
     * Keep the screen on while there is a picture.
     *
     * The single most visible omission. Android dims and locks on its own timer,
     * and a film watched without touching the screen goes dark after thirty
     * seconds — which reads as the app crashing. The flag belongs to the WINDOW,
     * not to the player, so it is also correct for the WebView playback path: the
     * page asks for it whenever anything is playing, native engine or not.
     */
    private void keepScreenOn(boolean on) {
        getActivity().runOnUiThread(() -> {
            if (on) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    /**
     * Ask for the audio, and give it back.
     *
     * Without this, a phone call, a navigation prompt or another video app plays
     * OVER the stream — both at once, with no way to stop either. Android has
     * required an explicit request for this since 8.0, and the request is also how
     * we learn to pause: `AUDIOFOCUS_LOSS` means something else took over for good,
     * `LOSS_TRANSIENT` means a notification is speaking.
     *
     * Transient loss pauses rather than ducks. Ducking is right for music; for a
     * live channel, quietly continuing through a phone call means missing that part
     * of the programme, and a channel cannot be rewound.
     */
    private void requestAudioFocus() {
        if (hasFocus) return;
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(this::onAudioFocusChange)
                .build();
            hasFocus = am.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else {
            hasFocus = am.requestAudioFocus(this::onAudioFocusChange,
                AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
                == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
    }

    private void abandonAudioFocus() {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(this::onAudioFocusChange);
        }
        hasFocus = false;
        focusRequest = null;
    }

    private void onAudioFocusChange(int change) {
        if (player == null) return;
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                if (player.isPlaying()) {
                    pausedByFocusLoss = true;
                    player.pause();
                }
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                // Only resume what WE paused. Resuming something the viewer paused
                // themselves, because a notification finished, is worse than not
                // resuming at all.
                if (pausedByFocusLoss) {
                    pausedByFocusLoss = false;
                    player.play();
                }
                break;
            default:
                break;
        }
    }

    /**
     * Hide the system bars while the picture owns the screen.
     *
     * Android draws the status and navigation bars over a fullscreen surface, so a
     * 16:9 frame ends up with a clock on it and a translucent bar across the
     * bottom third of the subtitles. `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` is
     * the important half: the bars come back on a swipe, so hiding them never
     * traps anyone — which is why the older `setSystemUiVisibility` path asks for
     * IMMERSIVE_STICKY rather than plain IMMERSIVE.
     */
    private void applyImmersive(boolean on) {
        getActivity().runOnUiThread(() -> {
            android.view.Window w = getActivity().getWindow();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowInsetsController c = w.getInsetsController();
                if (c == null) return;
                if (on) {
                    c.hide(android.view.WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(android.view.WindowInsets.Type.systemBars());
                }
            } else {
                View d = w.getDecorView();
                d.setSystemUiVisibility(on
                    ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                    : View.SYSTEM_UI_FLAG_VISIBLE);
            }
        });
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        applyImmersive(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    /**
     * Let the page ask for the screen to stay awake.
     *
     * Separate from `load`, because the WebView path needs it too and that path
     * never touches this plugin otherwise.
     */
    @PluginMethod
    public void setAwake(PluginCall call) {
        keepScreenOn(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    /* ── lifecycle ─────────────────────────────────────────────────────────────
       This account allows ONE connection. A stream left running while the app is
       in the background holds it, so the next play — or the same stream after
       coming back — is refused by the panel for up to two minutes. Pausing on
       background is therefore not politeness, it is what makes the app usable at
       all after a phone call.
    */

    @Override
    protected void handleOnPause() {
        if (player != null && player.isPlaying()) {
            pausedByBackground = true;
            player.pause();
        }
        keepScreenOn(false);
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pausedByBackground && player != null) {
            pausedByBackground = false;
            player.play();
            keepScreenOn(true);
        }
    }

    @Override
    protected void handleOnDestroy() {
        // Order matters, and it is the same order the web player's teardown uses:
        // stop the transport first so the panel releases the session, then let go
        // of the decoder.
        if (player != null) {
            player.stop();
            player.detachViews();
            player.release();
            player = null;
        }
        if (libVlc != null) {
            libVlc.release();
            libVlc = null;
        }
        if (relay != null) {
            relay.shutdown();
            relay = null;
        }
        abandonAudioFocus();
        super.handleOnDestroy();
    }

    private synchronized OneConnectionRelay relay() {
        if (relay == null) relay = new OneConnectionRelay();
        return relay;
    }

    private static Map<String, String> headerMap(JSObject headers) {
        Map<String, String> out = new LinkedHashMap<>();
        if (headers == null) return out;
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try { out.put(key, headers.getString(key)); } catch (Exception ignored) { /* not a string */ }
        }
        return out;
    }

    /** Options every stream needs and the panel insists on. */
    private ArrayList<String> vlcOptions(String userAgent) {
        ArrayList<String> options = new ArrayList<>();
        /*
         * The LIVE tuning, and it is only the default now.
         *
         * 2500ms was chosen for live TS feeds, which arrive in bursts
         * a smaller cache stutters on. It was applied to everything, and a FILM
         * is nothing like a live feed: it is a seekable file, delivered far
         * faster than real time, so the same number is 2.5 seconds of video
         * fetched before the first frame for no benefit at all. `load` overrides
         * it per media for video on demand — see VOD_CACHING_MS.
         */
        options.add("--network-caching=2500");
        options.add("--file-caching=1500");
        // Some servers gate on the User-Agent, as they do for the relay, so the
        // native player sends the same one.
        if (userAgent != null && !userAgent.isEmpty()) {
            options.add("--http-user-agent=" + userAgent);
        }
        // Follow cross-protocol redirects: a live URL often 302s to a different
        // host with a minted token path, which is how servers load-balance.
        options.add("--http-reconnect");
        options.add("--no-video-title-show");
        /* Verbose libVLC costs CPU and log churn on every frame of every stream,
           and nothing reads it on a customer's box. Debug builds keep it. */
        if ((getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            /*
         * Quiet, not verbose.
         *
         * `-vv` makes libVLC write a line to logcat for essentially every packet
         * it demuxes. That is the right setting while bringing a player up and
         * the wrong one to ship: on a TV box it is a continuous string write and
         * a logcat flush underneath a hardware decoder, for output nobody
         * collects. Errors still come through — `-q` silences info and debug,
         * not failures — and the app's own diagnostics come from the event
         * stream, which is what the debug overlay reads.
         */
        options.add("-q");
        }
        return options;
    }

    /**
     * libVLC's own byte counters, if it will give them.
     *
     * Defensive throughout: `getMedia()` hands back a reference-counted object
     * that is null once the media is released, `getStats()` can answer null
     * before anything has been read, and this runs on the event thread during a
     * failure — the one moment when throwing would replace a diagnosable error
     * with a crash.
     */
    private void attachStats(JSObject data) {
        try {
            org.videolan.libvlc.interfaces.IMedia m = player == null ? null : player.getMedia();
            if (m == null) return;
            try {
                org.videolan.libvlc.interfaces.IMedia.Stats st = m.getStats();
                if (st != null) {
                    data.put("readBytes", st.readBytes);
                    data.put("demuxReadBytes", st.demuxReadBytes);
                    data.put("demuxCorrupted", st.demuxCorrupted);
                    data.put("decodedVideo", st.decodedVideo);
                    data.put("decodedAudio", st.decodedAudio);
                    data.put("displayedPictures", st.displayedPictures);
                    data.put("inputBitrate", st.inputBitrate);
                }
            } finally {
                /* `getMedia()` took a reference; not releasing it leaks the
                   media for the life of the player. */
                m.release();
            }
        } catch (Throwable ignored) {
            // A missing diagnostic must never be worse than the failure it describes.
        }
    }

    /** How often the picture counters ride along with a time event. */
    private static final long STATS_EVERY_MS = 1000;
    private long lastStatsAt = 0;
    /*
     * The clock, at most once a second — the page shows whole seconds.
     *
     * libVLC raises TimeChanged about four times a second and every one crossed
     * the bridge into the page, which patched the player and redrew its bar.
     * Measured on the TV emulator with a live channel on and nothing pressed:
     * five bridge messages a second, a fifth of what a MediaTek box's main
     * thread can do, spent keeping a clock current that changes once a second.
     * Reset on load and seek, so the first position after a jump is not held.
     */
    private static final long TIME_EVERY_MS = 1000;
    private volatile long lastTimeAt = 0;

    private synchronized void ensurePlayer(String userAgent) {
        if (player != null) return;
        /*
         * Log initialization for diagnostics, especially on Fire OS where
         * libVLC native library loading is the most common failure point.
         */
        Log.i("StreamixPlayer", "Initializing libVLC on " + Build.MANUFACTURER + " "
                + Build.MODEL + " (API " + Build.VERSION.SDK_INT + ")");
        libVlc = new LibVLC(getContext(), vlcOptions(userAgent));
        player = new MediaPlayer(libVlc);
        Log.i("StreamixPlayer", "libVLC initialized successfully");
        player.setEventListener(event -> {
            JSObject data = new JSObject();
            switch (event.type) {
                case MediaPlayer.Event.Playing:
                    data.put("state", "playing");
                    break;
                case MediaPlayer.Event.Paused:
                    data.put("state", "paused");
                    break;
                case MediaPlayer.Event.Buffering:
                    data.put("state", "buffering");
                    data.put("buffered", event.getBuffering());
                    break;
                case MediaPlayer.Event.EndReached:
                    data.put("state", "ended");
                    break;
                case MediaPlayer.Event.EncounteredError:
                    data.put("state", "error");
                    /* WHY it failed, as far as libVLC will say.
                     *
                     * `EncounteredError` carries no message — that is the whole
                     * of the libVLC API here — so "native: error" was the entire
                     * diagnosis the app could offer, and it is not one. A film
                     * that fails is then indistinguishable from a film that
                     * never arrived, which cost a whole evening of chasing the
                     * wrong thing: a test box reported an ordinary 1080p
                     * H.264 High@4.1 film failing on both the hardware and the
                     * software decoder, the app's hint blamed 4K H.264, and
                     * measuring the file found 1920x1072 at 2.1 Mbps — the most
                     * ordinary video in the catalogue.
                     *
                     * The byte counters answer the question the state cannot:
                     *
                     *   read 0                  nothing arrived — network, not codec
                     *   read > 0, demux 0       arrived and the demuxer refused it
                     *   demux > 0, decoded 0    demuxed fine, the DECODER failed
                     *   corrupted > 0           it arrived damaged
                     *
                     * One line, and the next failure report says which. */
                    attachStats(data);
                    break;
                case MediaPlayer.Event.TimeChanged: {
                    long at = android.os.SystemClock.uptimeMillis();
                    if (lastTimeAt != 0 && at - lastTimeAt < TIME_EVERY_MS) return;
                    lastTimeAt = at;
                }
                    data.put("state", "time");
                    data.put("timeMs", event.getTimeChanged());
                    /*
                     * The picture counters, about once a second, while playing.
                     *
                     * "some videos just play for a few 2nd and then goes black and
                     * only audio comes" — the failure that raises no error at all.
                     * A hardware decoder that chokes mid-stream stops producing
                     * pictures and says nothing: libVLC is still Playing, the clock
                     * still advances, the audio still comes out, and the surface
                     * keeps showing the last frame or nothing.
                     *
                     * `displayedPictures` is the fact itself — pictures that
                     * reached the surface — so a web layer that watches it advance
                     * against the clock can see the freeze with no error to wait
                     * for. Throttled because TimeChanged fires four times a second
                     * and `getStats()` crosses into native each time.
                     */
                    long now = android.os.SystemClock.uptimeMillis();
                    if (now - lastStatsAt >= STATS_EVERY_MS) {
                        lastStatsAt = now;
                        attachStats(data);
                    }
                    break;
                case MediaPlayer.Event.LengthChanged:
                    data.put("state", "length");
                    data.put("lengthMs", event.getLengthChanged());
                    break;
                default:
                    return;
            }
            notifyListeners("playerEvent", data);
        });
    }

    /**
     * Put a video surface behind the WebView.
     *
     * Index 0 of the activity's root, so it is drawn first and everything the
     * page renders lands on top of it; the WebView's own background has to become
     * transparent or it paints an opaque sheet over the frames.
     */
    private void ensureSurface() {
        if (videoLayout != null) return;
        getActivity().runOnUiThread(() -> {
            if (videoLayout != null) return;
            ViewGroup root = (ViewGroup) getBridge().getWebView().getParent();
            videoLayout = new VLCVideoLayout(getContext());
            videoLayout.setBackgroundColor(Color.BLACK);
            host = new FrameLayout(getContext());
            host.setBackgroundColor(Color.TRANSPARENT);
            host.addView(videoLayout, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(host, 0, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            host.setVisibility(View.GONE);
        });
    }

    /**
     * A transparent WebView is a WINDOW, and a window costs a frame.
     *
     * libVLC draws onto a SurfaceView BEHIND the page, so while video is playing
     * the page has to be see-through or it covers the picture. That part was
     * right. What was wrong is that nothing ever turned it back: the flag was set
     * once, on the first `ensureSurface()` — which `setBounds` also calls, so it
     * could happen before anything ever played — and never cleared for the life
     * of the process.
     *
     * The cost is not subtle. A transparent WebView cannot be composited as an
     * opaque layer, so every frame of the poster grid is alpha-blended against
     * whatever is behind it, for ever, on a box with a weak GPU. It matches the
     * report exactly: "once I am inside the TV box for full screen the behaviour
     * of the app comes very slow", and then everything after it being "laggy and
     * choppy" — including screens with no video on them at all.
     *
     * So it is a mode now, entered when the surface is shown and left when it is
     * hidden, which is what `stop()` does.
     */
    private void webViewIsWindow(boolean windowed) {
        if (transparentWebView == windowed) return;
        transparentWebView = windowed;
        getBridge().getWebView().setBackgroundColor(windowed ? Color.TRANSPARENT : OPAQUE_BG);
    }

    /**
     * What this DEVICE can decode, which is a different question from what the
     * WebView will play.
     *
     * Read from `MediaCodecList`, which is the platform's own register of
     * hardware and software decoders. This is the answer the app could not get
     * from inside a WebView, and it is usually much better news: a phone that
     * refuses HEVC in Chromium almost always has an HEVC decoder sitting right
     * here.
     */
    @PluginMethod
    public void capabilities(PluginCall call) {
        Map<String, JSObject> byMime = new LinkedHashMap<>();
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
            for (MediaCodecInfo info : list.getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    String mime = type.toLowerCase();
                    JSObject entry = byMime.get(mime);
                    if (entry == null) {
                        entry = new JSObject();
                        entry.put("mime", mime);
                        entry.put("hardware", false);
                        entry.put("decoders", new JSArray());
                        byMime.put(mime, entry);
                    }
                    // "OMX.google." and "c2.android." are the software fallbacks;
                    // anything else is the vendor's, which means hardware.
                    boolean software = info.getName().startsWith("OMX.google.")
                            || info.getName().startsWith("c2.android.");
                    if (!software) entry.put("hardware", true);
                    try {
                        ((JSArray) entry.get("decoders")).put(info.getName());
                    } catch (JSONException ignored) {
                        // A decoder we cannot name is still a decoder we counted.
                    }
                }
            }
        } catch (Exception e) {
            call.reject("could not read the platform codec list: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        JSArray codecs = new JSArray();
        for (JSObject entry : byMime.values()) codecs.put(entry);
        ret.put("codecs", codecs);
        /* libVLC decodes AC-3, E-AC-3, MP2, DTS, MKV and much else in software
           whatever the platform register says, so its presence is itself a
           capability and the JS side treats it as one. */
        ret.put("engine", "libvlc");
        ret.put("softwareFallback", true);
        call.resolve(ret);
    }

    /**
     * How much of a FILM to fetch before showing the first frame.
     *
     * libVLC's own default for network access, and the right number here for a
     * reason that was measured rather than assumed: on-demand files are
     * typically served faster than real time, so a film refills a small buffer
     * long before it can run dry, and the 2.5 seconds the live path needs buys
     * nothing here and costs a second of staring at black on a modest line.
     *
     * Live keeps 2500. There is no headroom there: a channel arrives at exactly
     * the rate it plays, so the buffer IS the protection.
     */
    private static final int VOD_CACHING_MS = 1000;

    /** A channel's cache when the page names no buffer — Balanced, three seconds. */
    private static final long LIVE_CACHING_MS = 3000;

    @PluginMethod
    public void load(PluginCall call) {
        lastTimeAt = 0;
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        String userAgent = call.getString("userAgent", "VLC/3.0.20 LibVLC/3.0.20");
        long startAtMs = PluginArgs.longOf(call, "startAtMs", 0L);
        /* The page has always sent this and this method has never read it. */
        final boolean live = Boolean.TRUE.equals(call.getBoolean("live", false));
        /* Set by the page's retry after a hardware attempt has already failed —
           see the decoder note below. */
        final boolean software = Boolean.TRUE.equals(call.getBoolean("software", false));
        /* The viewer's buffer setting, for a channel. Read with `longOf` — see
           PluginArgs for why `getLong` would have read every value as zero. */
        final long bufferMs = PluginArgs.longOf(call, "bufferMs", LIVE_CACHING_MS);
        JSObject headers = call.getObject("headers", new JSObject());
        /* On unless the page says otherwise — the escape hatch if the relay
           itself is ever the thing that fails. */
        final boolean viaRelay = !Boolean.FALSE.equals(call.getBoolean("relay", true));

        try {
            ensurePlayer(userAgent);
        } catch (Throwable t) {
            // `UnsatisfiedLinkError` is an Error, not an Exception: on a device
            // whose ABI has no libvlc.so in this APK (an x86 emulator running an
            // ARM-only build) it used to escape the plugin call and take the whole
            // app down. Refuse the call instead — the page falls back to the
            // WebView engine and says why in its debug log.
            Log.e("StreamixPlayer", "libVLC initialization failed on " + Build.MANUFACTURER
                    + " " + Build.MODEL + " (API " + Build.VERSION.SDK_INT + "): "
                    + t.getClass().getSimpleName() + ": " + t.getMessage(), t);
            call.reject("libVLC could not be loaded on this device: " + t);
            return;
        }
        ensureSurface();

        getActivity().runOnUiThread(() -> {
            try {
                if (host != null) host.setVisibility(View.VISIBLE);
                /* The page becomes a window only now — when there is actually
                   something behind it to see. See `webViewIsWindow`. */
                webViewIsWindow(true);
                player.detachViews();
                player.attachViews(videoLayout, null, /* subtitles */ true, /* textureView */ false);

                /*
                 * Through the device's own loopback relay when it is a single
                 * file — see OneConnectionRelay for the measurement. The relay
                 * carries the headers itself, so libVLC is not given them twice.
                 */
                String playUrl = url;
                if (viaRelay && OneConnectionRelay.eligible(url)) {
                    try {
                        playUrl = relay().wrap(url, userAgent, headerMap(headers));
                    } catch (Throwable t) {
                        playUrl = url;
                    }
                } else if (relay != null) {
                    relay.release();
                }
                final boolean relayed = !playUrl.equals(url);
                Media media = new Media(libVlc, android.net.Uri.parse(playUrl));
                /*
                 * A channel's cache is the viewer's buffer, and it is set FIRST.
                 *
                 * `setHWDecoderEnabled` below writes `:network-caching=1500` on
                 * any media that has none yet, so a live channel always ended up
                 * with 1.5 seconds whatever the instance was built with — and
                 * until the page sent `live` at all, with the film's one second.
                 * Set here, before it, the setting is what libVLC holds.
                 */
                if (live) {
                    media.addOption(":network-caching=" + Math.max(1500L, Math.min(60_000L, bufferMs)));
                }
                if (!live) {
                    media.addOption(":network-caching=" + VOD_CACHING_MS);
                    /*
                     * OPEN at the resume point rather than opening at zero and
                     * then seeking.
                     *
                     * `player.setTime()` after `play()` — which is what this did
                     * — makes libVLC do the whole job twice: connect, probe the
                     * container, fill the buffer from the start of the film, and
                     * only then jump, which throws that buffer away and fills it
                     * again from the new offset. Two buffer fills and two range
                     * requests for one press, on the commonest case there is,
                     * because carrying on from where you stopped is what a series
                     * viewer does every single time.
                     *
                     * As a media option it is part of opening the file, so there
                     * is one connection, one probe and one fill. Seconds, not
                     * milliseconds, and only ever on a resumed title.
                     */
                    if (startAtMs > 0) media.addOption(":start-time=" + (startAtMs / 1000));
                }
                /*
                 * Hardware where the device has it, SOFTWARE WHERE IT DOES NOT —
                 * which is what the comment here always claimed and what the code
                 * forbade.
                 *
                 * `setHWDecoderEnabled(enabled, force)`: the second argument is
                 * not "try hard", it is "and do not fall back". With it true,
                 * MediaCodec failing to open is the end of the road, so any file
                 * the device's decoder will not take errors instead of decoding
                 * in software — and the whole reason libVLC is in this APK is
                 * that it decodes what MediaCodec will not.
                 *
                 * Measured on a 4.13GB Matroska carrying H.264 High@5.1 at
                 * 3840x2160/30 with AAC LC. 4K H.264 is the awkward case — boxes ship 4K decoders
                 * for HEVC and cap H.264 at Level 4.2/1080p — so MediaCodec
                 * refused it and the viewer got "the native engine could not open
                 * this stream" for a file that is perfectly decodable, just not
                 * in silicon.
                 *
                 * `force` is false in BOTH directions now: libVLC picks hardware
                 * when it can and drops to software when it cannot, per stream.
                 * `software` is the caller insisting, which is what playerCore's
                 * retry does after a first attempt has already failed.
                 */
                if (software) {
                    media.setHWDecoderEnabled(false, false);
                    media.addOption(":avcodec-hw=none");
                    /* Every core, because 4K in software needs all of them. 0 is
                       libVLC's "decide from the CPU". */
                    media.addOption(":avcodec-threads=0");
                } else {
                    media.setHWDecoderEnabled(true, false);
                }
                if (headers != null && !relayed) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headers.getString(key);
                        /* libVLC has dedicated options for these two and does not
                           reliably honour them as free-form header lines. */
                        if (key.equalsIgnoreCase("User-Agent")) {
                            media.addOption(":http-user-agent=" + value);
                        } else if (key.equalsIgnoreCase("Referer") || key.equalsIgnoreCase("Referrer")) {
                            media.addOption(":http-referrer=" + value);
                        } else {
                            media.addOption(":http-header=" + key + ": " + value);
                        }
                    }
                }
                player.setMedia(media);
                media.release();
                requestAudioFocus();
                keepScreenOn(true);
                player.play();
                /* Live only: VOD opened AT the resume point (`:start-time`), and
                   asking again here would throw away the buffer it just filled. */
                if (live && startAtMs > 0) player.setTime(startAtMs);
                call.resolve();
            } catch (Exception e) {
                call.reject("native playback failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        requestAudioFocus();
        keepScreenOn(true);
        pausedByFocusLoss = false;
        if (player != null) player.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        // The screen may stay awake while paused: someone reading a paused frame
        // has not stopped watching, and Android's own timer is short.
        if (player != null) player.pause();
        call.resolve();
    }

    /**
     * Seek, on the same thread as everything else that touches the player.
     *
     * This called {@code player.setTime} straight from the plugin's call thread,
     * while {@code load}, {@code stop} and the surface work all run on the UI
     * thread through {@code runOnUiThread}. libVLC's MediaPlayer is not safe to
     * drive from two threads at once, and a burst of seeks is exactly when it was:
     * "it still crashes once I move forward or backwards like a few times". The
     * seeks landed on one thread while the recovery that a broken seek triggers
     * was stopping and reloading the same player on the other.
     *
     * The page now coalesces a burst into one seek (see SEEK_SETTLE_MS in
     * playerCore.ts), which makes the race rare; this makes it impossible. A seek
     * on a stream libVLC reports as not seekable is dropped rather than issued —
     * a live stream, or a film whose server does not honour ranges — because
     * setTime on one of those is undefined, and undefined in native code is a
     * crash rather than an error.
     */
    @PluginMethod
    public void seek(PluginCall call) {
        lastTimeAt = 0;
        final long ms = Math.max(0L, PluginArgs.longOf(call, "timeMs", 0L));
        getActivity().runOnUiThread(() -> {
            if (player != null && player.isSeekable()) player.setTime(ms);
        });
        call.resolve();
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Double rate = call.getDouble("rate", 1.0);
        if (player != null) player.setRate(rate.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) {
                player.stop();
                player.detachViews();
            }
            /* Let go of the line's one connection now, so whatever is opened
               next is not waiting for the panel to notice this one ended. */
            if (relay != null) relay.release();
            if (host != null) host.setVisibility(View.GONE);
            /* Opaque again. See `webViewIsWindow` — this is the half that was
               missing, and it is why the app stayed slow after watching. */
            webViewIsWindow(false);
            keepScreenOn(false);
            abandonAudioFocus();
            call.resolve();
        });
    }

    /**
     * Where the picture goes, in CSS pixels from the page.
     *
     * The page knows the layout and the surface knows nothing, so the page sends
     * a rectangle. CSS pixels are density-independent and Android layout params
     * are not, hence the multiply — getting this wrong puts the video off screen
     * on a 3x phone, which looks exactly like the plugin not working.
     */
    @PluginMethod
    public void setBounds(PluginCall call) {
        final double x = call.getDouble("x", 0.0);
        final double y = call.getDouble("y", 0.0);
        final double w = call.getDouble("width", 0.0);
        final double h = call.getDouble("height", 0.0);
        ensureSurface();
        getActivity().runOnUiThread(() -> {
            if (host == null) return;
            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            float d = dm.density;
            final int pw = Math.max(1, (int) (w * d));
            final int ph = Math.max(1, (int) (h * d));
            /*
             * Plus wherever the WebView itself starts.
             *
             * The page measures from ITS OWN top-left; this view is a sibling of
             * the WebView filling their shared parent, so the two agree only
             * while the WebView sits at the parent's origin. It does not always:
             * a status-bar inset, a display cutout or any padding Capacitor's
             * root applies moves the WebView down and leaves the surface where
             * it was — the picture then sits that many pixels HIGH, with its top
             * band hidden behind the app's own header and the same amount
             * missing off the bottom. Reported exactly that way: "i think the
             * player goes under the header".
             *
             * `getLeft`/`getTop` are the WebView's position inside that parent,
             * which is the term that was missing. Zero when nothing is inset, so
             * this changes nothing on a box that never had the problem.
             */
            final View web = getBridge().getWebView();
            final int offX = web == null ? 0 : web.getLeft();
            final int offY = web == null ? 0 : web.getTop();
            final int px = (int) (x * d) + offX;
            final int py = (int) (y * d) + offY;
            /*
             * Edit the params the parent already gave this view; never swap in a
             * type of our own.
             *
             * This tested `instanceof FrameLayout.LayoutParams` and Capacitor's
             * root is a `CoordinatorLayout` — so the test NEVER passed, every
             * call fell to the padding branch, and the video surface was never
             * actually sized. `MarginLayoutParams` is the common ancestor of both
             * and of every other sensible root, so this asks the question that
             * can be answered instead of the one that happened to be true once.
             */
            ViewGroup.LayoutParams current = host.getLayoutParams();
            if (current instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) current;
                lp.width = pw;
                lp.height = ph;
                lp.leftMargin = px;
                lp.topMargin = py;
                host.setPadding(0, 0, 0, 0);
                host.setLayoutParams(lp);
            } else {
                current.width = pw;
                current.height = ph;
                host.setLayoutParams(current);
                host.setPadding(px, py, 0, 0);
            }
            host.requestLayout();
            call.resolve();
        });
    }

    /**
     * Audio and subtitle tracks the container actually carries.
     *
     * The libVLC 3.x shape, not the 4.x one: `getAudioTracks()` /
     * `getSpuTracks()` returning `TrackDescription` with an int id, rather than
     * `getTracks(Type)` with string ids. 4.0 is EAP-only on Maven, and an engine
     * that ships decoders is not something to run a preview of.
     */
    @PluginMethod
    public void tracks(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray audio = new JSArray();
        JSArray subs = new JSArray();
        if (player != null) {
            MediaPlayer.TrackDescription[] a = player.getAudioTracks();
            if (a != null) {
                for (MediaPlayer.TrackDescription t : a) {
                    JSObject o = new JSObject();
                    o.put("id", t.id);
                    o.put("label", t.name != null ? t.name : String.valueOf(t.id));
                    audio.put(o);
                }
            }
            MediaPlayer.TrackDescription[] sp = player.getSpuTracks();
            if (sp != null) {
                for (MediaPlayer.TrackDescription t : sp) {
                    JSObject o = new JSObject();
                    o.put("id", t.id);
                    o.put("label", t.name != null ? t.name : String.valueOf(t.id));
                    subs.put(o);
                }
            }
            ret.put("audioSelected", player.getAudioTrack());
            ret.put("subtitleSelected", player.getSpuTrack());
        }
        ret.put("audio", audio);
        ret.put("subtitles", subs);
        call.resolve(ret);
    }

    /**
     * The colour of the frame libVLC is showing, read off the actual surface.
     *
     * ── why this is here and not in the page ──
     *
     * The ambient glow samples the video onto a tiny canvas and reads its edges.
     * That works for a `<video>` element and cannot work for this path, and the
     * reason was written down as if it settled the matter: libVLC draws on an
     * Android SurfaceView BEHIND a transparent WebView, so there are no pixels
     * in the document to sample. True, and not an excuse — the pixels exist,
     * they are just on this side of the bridge. This app is native.
     *
     * `PixelCopy.request(SurfaceView, Bitmap, …)` reads back a SurfaceView's
     * buffer, which is the one platform API that can. API 24, against a minSdk
     * of 23, so the one release below it degrades to no glow rather than to a
     * crash — and it scales into whatever size the destination bitmap is, so
     * asking for 32x18 costs one downscale in the compositor rather than a
     * full-resolution copy and a resize.
     *
     * ── what it deliberately does NOT do ──
     *
     * It does not touch the video path. The obvious alternative was
     * `attachViews(…, textureView: true)`, because a TextureView's pixels can be
     * read with `getBitmap()`. That means routing every frame of every stream
     * through the view hierarchy instead of a dedicated surface, on boxes whose
     * playback is already the thing most worth protecting — changing how the
     * picture is composited to light up a decoration is the wrong trade, and the
     * standing instruction covers it: if an idea would ruin things, do not
     * implement it.
     *
     * One shot per call, and the page decides the rate. The smoothing, the
     * floor, the ceiling and the saturation pull all stay in `lib/ambient.ts`
     * where they are tested; this answers only the question that cannot be asked
     * from JavaScript — what colour is around the edge of the picture right now.
     * The edge average is computed here rather than shipping 576 pixels over the
     * bridge every 600ms; it is the same two-strip average as `edgeShade`, and
     * the two are meant to agree.
     */
    @PluginMethod
    public void ambient(PluginCall call) {
        if (Build.VERSION.SDK_INT < 24) {
            call.resolve(unlit("api"));
            return;
        }
        final MediaPlayer p = player;
        final VLCVideoLayout layout = videoLayout;
        if (p == null || layout == null || !p.isPlaying()) {
            call.resolve(unlit("idle"));
            return;
        }
        if (host == null || host.getVisibility() != View.VISIBLE) {
            call.resolve(unlit("hidden"));
            return;
        }
        getActivity().runOnUiThread(() -> {
            SurfaceView sv = findSurface(layout);
            if (sv == null || sv.getHolder().getSurface() == null
                    || !sv.getHolder().getSurface().isValid()
                    || sv.getWidth() == 0 || sv.getHeight() == 0) {
                call.resolve(unlit("nosurface"));
                return;
            }
            /* 32x18 — 576 pixels, the same grid the page uses for a `<video>`. */
            final Bitmap shot = Bitmap.createBitmap(32, 18, Bitmap.Config.ARGB_8888);
            try {
                PixelCopy.request(sv, shot, (int result) -> {
                    try {
                        if (result != PixelCopy.SUCCESS) {
                            call.resolve(unlit("copy" + result));
                            return;
                        }
                        call.resolve(edgeShade(shot));
                    } catch (Throwable t) {
                        call.resolve(unlit("read"));
                    } finally {
                        shot.recycle();
                    }
                }, new Handler(Looper.getMainLooper()));
            } catch (Throwable t) {
                /*
                 * Some boxes refuse a read of a secure or hardware-protected
                 * buffer and throw rather than reporting a failure code. One
                 * refusal is permanent for the stream, and the page stops asking
                 * on the first unlit answer that names a reason it cannot fix.
                 */
                shot.recycle();
                call.resolve(unlit("refused"));
            }
        });
    }

    /** No colour, and why — so a bug report says which branch it took. */
    private static JSObject unlit(String why) {
        JSObject o = new JSObject();
        o.put("lit", false);
        o.put("why", why);
        return o;
    }

    /**
     * The average of the frame's left and right strips.
     *
     * Deliberately the same shape as `edgeShade` in lib/ambient.ts — an eighth of
     * the width from each side — because the glow must not change character when
     * a film switches engine mid-catalogue. The middle of the shot is ignored:
     * what belongs beside an edge is the colour of that edge.
     */
    private static JSObject edgeShade(Bitmap bm) {
        final int w = bm.getWidth();
        final int h = bm.getHeight();
        final int band = Math.max(1, Math.round(w / 8f));
        long r = 0;
        long g = 0;
        long b = 0;
        int n = 0;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < band; x++) {
                for (int px : new int[] { x, w - 1 - x }) {
                    int c = bm.getPixel(px, y);
                    r += (c >> 16) & 0xFF;
                    g += (c >> 8) & 0xFF;
                    b += c & 0xFF;
                    n += 1;
                }
            }
        }
        if (n == 0) return unlit("empty");
        JSObject o = new JSObject();
        o.put("lit", true);
        o.put("r", (int) (r / n));
        o.put("g", (int) (g / n));
        o.put("b", (int) (b / n));
        return o;
    }

    /**
     * The SurfaceView inside `VLCVideoLayout`.
     *
     * Found by walking rather than by id: the id belongs to libVLC's own layout
     * resource, so naming it here would tie this file to a version of that
     * library. There is exactly one SurfaceView under it.
     */
    private static SurfaceView findSurface(View v) {
        if (v instanceof SurfaceView) return (SurfaceView) v;
        if (!(v instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) v;
        for (int i = 0; i < group.getChildCount(); i++) {
            SurfaceView found = findSurface(group.getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }

    @PluginMethod
    public void selectTrack(PluginCall call) {
        String type = call.getString("type", "audio");
        Integer id = call.getInt("id", -1);
        if (player != null && id != null) {
            if ("subtitle".equals(type)) player.setSpuTrack(id);
            else player.setAudioTrack(id);
        }
        call.resolve();
    }
}
