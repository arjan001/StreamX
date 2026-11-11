package com.easyred.streamix;

import android.app.Activity;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Things about the SET that a WebView cannot answer: which box it is, why the
 * app died last time, the channel-logo store and how to take the app off the
 * device entirely when the viewer says so ({@link #exitApp}). It is its own
 * plugin rather than more methods on the player because none of it has anything
 * to do with video.
 */
@CapacitorPlugin(name = "StreamixDevice")
public class StreamixDevicePlugin extends Plugin {

    /**
     * Why the app went away last time, if it did.
     *
     * The page asks this once on boot and puts the answer in its own debug log,
     * so a report from a television that fell over finally contains the fall.
     * Reading takes it: the same death must not be reported for ever.
     *
     * Always resolves. "Nothing happened" is an answer, and a rejection here
     * would put a red line in the log of every healthy boot.
     */
    /**
     * Which television this actually is.
     *
     * A playback failure report used to say "installed app" and the Chromium
     * version, which is true of ten thousand different boxes. The question that
     * matters when a brand misbehaves — a decoder that refuses a profile it
     * advertises is a vendor fault, not an Android one — is WHICH box, and
     * nothing in the page can answer it: a WebView user agent on Android TV
     * names Chromium and the Android version and never the maker.
     *
     * Read from `android.os.Build`, which costs nothing and cannot fail. No
     * identifier of any kind is included: the manufacturer, the model and the
     * Android version describe a product line, not a person.
     */
    @PluginMethod
    public void hardware(PluginCall call) {
        final JSObject out = new JSObject();
        try {
            out.put("manufacturer", android.os.Build.MANUFACTURER);
            out.put("brand", android.os.Build.BRAND);
            out.put("model", android.os.Build.MODEL);
            out.put("device", android.os.Build.DEVICE);
            out.put("android", android.os.Build.VERSION.RELEASE);
            out.put("sdk", android.os.Build.VERSION.SDK_INT);
            out.put("tv", getContext().getPackageManager()
                .hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK));
        } catch (Throwable ignored) {
            /* A diagnostic must never be the thing that breaks a boot. */
        }
        call.resolve(out);
    }

    @PluginMethod
    public void lastCrash(PluginCall call) {
        final JSObject out = new JSObject();
        String note = null;
        try {
            note = CrashNotes.take(getContext());
        } catch (Throwable ignored) {
            /* A diagnostic must never be the thing that breaks a boot. */
        }
        out.put("note", note == null ? "" : note);
        call.resolve(out);
    }

    /* ── leaving ─────────────────────────────────────────────────────────────── */

    /**
     * The file `@capacitor/preferences` keeps everything in.
     *
     * Its default group, `PreferencesConfiguration.DEFAULTS.group`, which
     * `lib/kv.ts` never changes with `configure`. Spelled out rather than read
     * from there because that field is package-private to the plugin.
     */
    private static final String CAPACITOR_PREFERENCES = "CapacitorStorage";

    /**
     * Stop the app — not background it — once the viewer has said yes.
     *
     * "when they say yes you force to stop the whole app so it's out of the memory
     * and doesn't clog the memory". Backgrounding, which is what BACK at Home did
     * until now, keeps all of it resident: the WebView and the catalogue in its
     * heap, libVLC paused but never released. And `@capacitor/app`'s `exitApp` is
     * not this either: it ends in {@code finish()}, so the task stays in recents
     * and the process stays exactly where it was.
     *
     * Reached from `components/ExitDialog.tsx` only, and only after the page has
     * shut itself down: the player paused so both playhead writers record where
     * it stopped, torn down, and the preferences store written out whole. The
     * three steps here are in the order they are for a reason each.
     *
     * 1. The preferences file, on disk. `@capacitor/preferences` writes with
     *    {@code apply()}, which updates memory at once and the file later, on a
     *    thread of its own — and a killed process never gets to later. A
     *    {@code commit()} on the same file "will block until all async commits
     *    are completed as well as the commit itself" (the documented contract of
     *    {@code SharedPreferences.Editor.apply}), and an empty one changes
     *    nothing else. And the page's last writes have already reached
     *    {@code apply()} by the time this runs: plugin calls run one at a time on
     *    Capacitor's single `CapacitorPlugins` thread, in the order the page sent
     *    them, and the page sends this call after its last write.
     *
     * 2. Answer the call. After step 3 there is nobody to answer it, and a call
     *    left pending is a page waiting on nothing.
     *
     * 3. On the UI thread, {@code finishAndRemoveTask()} and only then the kill.
     *    Killed with its task still in place, the app is just another process
     *    that died: the task stays in recents and choosing it relaunches the app
     *    from saved state, which is a lingering app by another name. With the
     *    task gone first there is nothing left for Android to bring back, and
     *    {@code killProcess} is what actually frees the memory — the WebView's
     *    renderer is bound to this process and goes with it, and the one
     *    connection the panel allows is closed by the kernel with the socket.
     *
     * Not deferred to {@code onDestroy}, which would look gentler. Android
     * destroys a finishing activity only once the launcher that replaced it has
     * gone idle, which a television launcher with a moving row can put off for
     * seconds — long enough to relaunch the app into a process that is about to
     * be killed underneath it.
     */
    /**
     * Channel logos, downloaded ahead of time and kept on the device — see
     * {@link LogoStore}. The page decides WHICH (the channels this viewer can
     * reach); this only fetches, keeps and serves them.
     */
    @PluginMethod
    public void logoPrefetch(PluginCall call) {
        final List<String> sources = stringsOf(call, "sources");
        final List<String> urls = stringsOf(call, "urls");
        final int queued = LogoStore.get(getContext()).prefetch(urls, sources.size() == urls.size() ? sources : null);
        final JSObject out = new JSObject();
        out.put("queued", queued);
        call.resolve(out);
    }

    /**
     * Keep only these logos; everything else stored goes. An empty list removes
     * nothing — a page that sent nothing by mistake must not empty the store.
     */
    @PluginMethod
    public void logoRetain(PluginCall call) {
        final List<String> urls = stringsOf(call, "urls");
        final int removed = urls.isEmpty() ? 0 : LogoStore.get(getContext()).retain(urls);
        final JSObject out = new JSObject();
        out.put("removed", removed);
        call.resolve(out);
    }

    @PluginMethod
    public void logoStats(PluginCall call) {
        final long[] s = LogoStore.get(getContext()).stats();
        final JSObject out = new JSObject();
        out.put("files", s[0]);
        out.put("bytes", s[1]);
        out.put("pending", s[2]);
        out.put("done", s[3]);
        out.put("failed", s[4]);
        out.put("hits", s[5]);
        out.put("lastError", LogoStore.get(getContext()).lastError());
        out.put("step", LogoStore.get(getContext()).step());
        call.resolve(out);
    }

    private static List<String> stringsOf(PluginCall call, String name) {
        final List<String> out = new java.util.ArrayList<>();
        final org.json.JSONArray a = call.getData().optJSONArray(name);
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            final String v = a.optString(i, null);
            if (v != null && !v.isEmpty()) out.add(v);
        }
        return out;
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity to finish");
            return;
        }

        try {
            getContext().getSharedPreferences(CAPACITOR_PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .commit();
        } catch (Throwable ignored) {
            /* Storage refusing a write is not a reason to refuse to leave. The
               apply() queue is still running; this only gave up waiting on it. */
        }

        call.resolve();

        activity.runOnUiThread(() -> {
            activity.finishAndRemoveTask();
            android.os.Process.killProcess(android.os.Process.myPid());
        });
    }
}
