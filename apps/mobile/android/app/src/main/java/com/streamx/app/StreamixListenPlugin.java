package com.streamx.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The app listening to its own sound, so the page can write down what is said.
 *
 * ── the problem, photographed off a television ──
 *
 *     Closed captions
 *     This channel is playing on the television's own video engine, which the
 *     captions cannot listen to.
 *
 * Live captions work by tapping the `<video>` element's audio and streaming PCM
 * to a transcriber. The whole reason this app is not just the website in a box
 * is that libVLC plays what Chromium cannot — and it plays it onto a surface
 * behind the WebView, so there is no element and no audio in the page. Every
 * live channel on this catalogue is a raw MPEG-TS, which is exactly what libVLC
 * is here for, so "no captions" was all of live television.
 *
 * ── the two ways not to fix it ──
 *
 * **Fetch the audio separately.** `max_connections` on these lines is 1: the
 * second connection is refused, and some panels evict the viewer's own picture
 * to make room for it.
 *
 * **Ask libVLC for the samples.** libvlc-all 3.6.5's Java bindings were read
 * rather than guessed at: `MediaPlayer` exposes `setAudioOutput(String)`,
 * `setAudioTrack`, `setAudioDelay` and nothing that hands back a buffer. The
 * `amem` output module needs `libvlc_audio_set_callbacks`, which is C and is not
 * bound. There is no seam there.
 *
 * ── so: capture what already came out ──
 *
 * `AudioPlaybackCapture` (Android 10) records the audio a set of apps is
 * playing. Scoped with `addMatchingUid(myUid())` it records THIS app and nothing
 * else — not the microphone, not another app, not the room. That is the whole
 * trick, and its properties are the ones this needs:
 *
 *   - it is the DECODED output, so AC-3, E-AC-3, MP2, DTS and HEVC channels are
 *     all just sound by the time it sees them. No codec matters here.
 *   - libVLC is untouched. The picture keeps hardware decoding onto its own
 *     surface and nothing about playback changes, which is the part that must
 *     not be risked.
 *   - nothing is downloaded twice and nobody's bandwidth is spent.
 *
 * What it costs is honesty with the viewer: Android requires the microphone
 * permission (the same API records both), a MediaProjection consent screen, and
 * a notification for as long as it runs. All three are correct — an app that can
 * hear itself should have to say so — and all three are asked for at the moment
 * captions are switched on, never on boot.
 *
 * Android 9 and older have no such API. They get the browser-engine offer the
 * page already makes, which is why `available()` answers honestly instead of
 * this plugin being assumed present.
 */
@CapacitorPlugin(
    name = "StreamixListen",
    permissions = {
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }),
        /* Android 13+. Without it the foreground service still runs, but its ongoing
           notice is hidden — and the notice is the viewer's way to see (and stop)
           that something is capturing sound. */
        @Permission(alias = "notif", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class StreamixListenPlugin extends Plugin {

    /** What the transcriber wants, and what `AudioRecord` will resample to. */
    private static final int RATE = 16000;
    /**
     * A tenth of a second per frame — 3,200 bytes, about 4.3 KB once base64'd.
     *
     * Small enough that a sentence is never held back waiting for a buffer to
     * fill, large enough that the bridge is crossed ten times a second rather
     * than a hundred. The bridge is JSON, so the frame size IS the cost.
     */
    private static final int FRAME_BYTES = RATE / 10 * 2;

    private MediaProjection projection;
    private AudioRecord record;
    private Thread pump;
    private volatile boolean running;

    @PluginMethod
    public void available(PluginCall call) {
        final JSObject out = new JSObject();
        final boolean ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        out.put("available", ok);
        out.put("why", ok ? "" : "Android 10 or newer is needed to capture an app's own sound");
        out.put("listening", running);
        call.resolve(out);
    }

    /**
     * Ask for everything, in the order Android insists on, then start.
     *
     * Microphone permission first: `AudioPlaybackCapture` is built on
     * `AudioRecord` and the platform gates it on RECORD_AUDIO even though no
     * microphone is opened. Then the projection consent screen. Then — and only
     * then — the foreground service, because from Android 14 a projection token
     * used by a process without one throws the moment it is redeemed.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(no("Android 10 or newer is needed to capture an app's own sound"));
            return;
        }
        if (running) {
            call.resolve(yes());
            return;
        }
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "afterMic");
            return;
        }
        askNotifications(call);
    }

    @PermissionCallback
    private void afterMic(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            call.resolve(no("Android needs the microphone permission to let an app record "
                + "its own sound. Nothing from the microphone is used or sent."));
            return;
        }
        askNotifications(call);
    }

    /**
     * Android 13+: ask to show notices, just before the service that posts one.
     *
     * Asked here rather than at launch so the viewer meets the question in front of
     * the feature that needs it. A refusal does NOT stop captions — the service
     * runs either way, only its notice is hidden — so the flow carries on.
     */
    private void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notif") != PermissionState.GRANTED) {
            requestPermissionForAlias("notif", call, "afterNotifications");
            return;
        }
        askProjection(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        askProjection(call);
    }

    /**
     * The consent screen, asking for the display rather than for an app.
     *
     * From Android 14 the plain intent offers "Share one app", and choosing it
     * asks the viewer WHICH app — photographed on a Google TV image while
     * testing this: a chooser listing Streamix, Live TV and the Play Store,
     * shown to somebody who pressed a subtitles button. Anything but Streamix
     * would capture nothing, because the recorder is scoped to our own uid, and
     * the failure would look like silence.
     *
     * `createConfigForDefaultDisplay` asks for the display outright, so the
     * chooser never appears. We never create a virtual display and never read a
     * pixel; the projection exists only because Android gates audio capture
     * behind one.
     */
    private Intent captureIntent(MediaProjectionManager mgr) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                return mgr.createScreenCaptureIntent(
                    MediaProjectionConfig.createConfigForDefaultDisplay());
            } catch (Throwable t) {
                /* A vendor build that does not know the overload. */
            }
        }
        return mgr.createScreenCaptureIntent();
    }

    private void askProjection(PluginCall call) {
        final Activity activity = getActivity();
        final MediaProjectionManager mgr = activity == null ? null
            : (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mgr == null) {
            call.resolve(no("this device has no media projection service"));
            return;
        }
        try {
            startActivityForResult(call, captureIntent(mgr), "afterProjection");
        } catch (Throwable t) {
            call.resolve(no("this device would not show the permission screen"));
        }
    }

    @ActivityCallback
    private void afterProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK
                || result.getData() == null) {
            call.resolve(no("declined"));
            return;
        }
        final int code = result.getResultCode();
        final Intent data = result.getData();

        ListenService.arm();
        try {
            getContext().startForegroundService(new Intent(getContext(), ListenService.class));
        } catch (Throwable t) {
            call.resolve(no("this device would not start the listening notice"));
            return;
        }

        /*
         * Waited for, on a thread that is allowed to wait.
         *
         * `startForegroundService` returns before the service exists, and a
         * projection token redeemed too early throws on Android 14 and newer —
         * only there, which is the worst possible place for a race to live. The
         * work then goes back to the main thread because `registerCallback`
         * wants a looper and `AudioRecord` is happier built on one.
         */
        new Thread(() -> {
            final boolean up = ListenService.awaitForeground(5000);
            new Handler(Looper.getMainLooper()).post(() -> {
                if (!up) {
                    stopService();
                    call.resolve(no("the listening notice would not start"));
                    return;
                }
                try {
                    final MediaProjectionManager mgr = (MediaProjectionManager)
                        getActivity().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                    projection = mgr.getMediaProjection(code, data);
                    if (projection == null) throw new IllegalStateException("no projection");
                    /* Required from Android 14 before the projection is used, and
                       the only warning we get when the system takes it back —
                       the viewer stopping it from the notification shade, or
                       another app claiming it. */
                    projection.registerCallback(new MediaProjection.Callback() {
                        @Override
                        public void onStop() {
                            release();
                            notifyListeners("listenLost", new JSObject());
                        }
                    }, new Handler(Looper.getMainLooper()));
                    open();
                    call.resolve(yes());
                } catch (Throwable t) {
                    release();
                    call.resolve(no(String.valueOf(t.getMessage())));
                }
            });
        }, "streamix-listen-start").start();
    }

    private void stopService() {
        try {
            getContext().stopService(new Intent(getContext(), ListenService.class));
        } catch (Throwable ignored) {
            /* nothing to stop */
        }
    }

    /**
     * One recorder, scoped to this app's own uid, and a thread that drains it.
     *
     * `addMatchingUid(myUid())` is the entire privacy story and it is worth being
     * explicit about: with it, this records what THIS app plays. Without it, the
     * same four lines record every other app on the device. It is not an
     * optimisation.
     *
     * And it is the ONLY filter. `addMatchingUsage(USAGE_MEDIA)` was here and
     * came out: it narrows nothing that matters for privacy — the uid has
     * already done that — while silently dropping everything libVLC plays if
     * libVLC labels its AudioTrack with any other usage. A filter that can only
     * ever lose the audio this feature exists to capture, in a way that looks
     * like silence rather than an error, is not worth the line it is written on.
     */
    private void open() throws Exception {
        final AudioPlaybackCaptureConfiguration config =
            new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUid(android.os.Process.myUid())
                .build();

        final AudioFormat format = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build();

        /* Four frames of slack. The pump reads faster than real time, so this is
           headroom for a scheduling hiccup, not a buffer to work through. */
        final int min = AudioRecord.getMinBufferSize(
            RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final int buffer = Math.max(min, FRAME_BYTES * 4);

        record = new AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(buffer)
            .setAudioPlaybackCaptureConfig(config)
            .build();

        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            throw new IllegalStateException("the recorder would not initialise");
        }
        record.startRecording();
        running = true;

        pump = new Thread(this::drain, "streamix-listen");
        pump.setDaemon(true);
        pump.start();
    }

    private void drain() {
        final byte[] buf = new byte[FRAME_BYTES];
        while (running) {
            final AudioRecord r = record;
            if (r == null) break;
            int read;
            try {
                read = r.read(buf, 0, buf.length);
            } catch (Throwable t) {
                break;
            }
            if (read <= 0) {
                /* ERROR_INVALID_OPERATION and friends mean the recorder is gone;
                   a zero read is a stopped stream. Either way, stop pumping
                   rather than spinning a core on it. */
                if (read < 0) break;
                continue;
            }
            final JSObject frame = new JSObject();
            frame.put("pcm", Base64.encodeToString(buf, 0, read, Base64.NO_WRAP));
            notifyListeners("listenAudio", frame);
        }
        if (running) {
            running = false;
            notifyListeners("listenLost", new JSObject());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        release();
        call.resolve(yes());
    }

    @Override
    protected void handleOnDestroy() {
        release();
        super.handleOnDestroy();
    }

    private void release() {
        running = false;
        final Thread t = pump;
        pump = null;
        if (t != null) {
            try { t.join(400); } catch (InterruptedException ignored) { /* going anyway */ }
        }
        final AudioRecord r = record;
        record = null;
        if (r != null) {
            try { r.stop(); } catch (Throwable ignored) { /* already stopped */ }
            try { r.release(); } catch (Throwable ignored) { /* already released */ }
        }
        final MediaProjection p = projection;
        projection = null;
        if (p != null) {
            try { p.stop(); } catch (Throwable ignored) { /* already stopped */ }
        }
        stopService();
    }

    private JSObject yes() {
        final JSObject out = new JSObject();
        out.put("started", true);
        out.put("rate", RATE);
        out.put("channels", 1);
        out.put("why", "");
        return out;
    }

    private JSObject no(String why) {
        final JSObject out = new JSObject();
        out.put("started", false);
        out.put("why", why == null ? "" : why);
        return out;
    }
}
