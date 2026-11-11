package com.streamx.app;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;

/**
 * What the app leaves behind when it dies.
 *
 * The debug log a viewer can show you lives in the page's memory, which is
 * exactly the memory that goes away in the two failures worth chasing: the
 * renderer being killed, and the process crashing. So the report from a
 * television that fell over is the report of the run AFTER it, and it starts
 * empty — "there is not enough logging in it as well", and that is the whole of
 * why.
 *
 * This is one file, written at the moment of death and read on the next launch.
 * Not a log: a NOTE. One paragraph saying what happened, when, and on what, which
 * is the part nobody can reconstruct afterwards. Everything else the page already
 * records for itself.
 *
 * ── what must never be in it ──
 *
 * A stack trace is code, not content, so nothing a subscription owns can reach
 * this file by accident — but a message CAN carry a URL, and a provider URL
 * carries a username and a password. So anything that looks like credentials in a
 * path or a query is stripped here, the way `lib/debugLog.ts` strips it on the
 * page's side and `apps/server/src/log.ts` strips it again on arrival. Three
 * times, because one of them will be wrong eventually.
 */
final class CrashNotes {
    private static final String TAG = "StreamixCrash";
    private static final String FILE = "last-crash.txt";
    /** A note is a paragraph. A 200KB stack trace helps nobody and fills a disk. */
    private static final int MAX = 4000;

    private CrashNotes() { }

    private static File fileIn(Context ctx) {
        return new File(ctx.getFilesDir(), FILE);
    }

    /**
     * Write a note, replacing any older one.
     *
     * Deliberately silent on failure. This runs while the app is already dying;
     * an exception thrown here would replace a diagnosable crash with an
     * undiagnosable one.
     */
    static void write(Context ctx, String kind, String detail) {
        if (ctx == null) return;
        final String body = redact(
            kind + " · " + Build.MANUFACTURER + " " + Build.MODEL
                + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")"
                + " · " + System.currentTimeMillis() + "\n" + (detail == null ? "" : detail));
        final String cut = body.length() > MAX ? body.substring(0, MAX) + "\n… trimmed" : body;
        try (FileOutputStream out = new FileOutputStream(fileIn(ctx), false)) {
            out.write(cut.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            Log.w(TAG, "could not keep the crash note", t);
        }
    }

    static void write(Context ctx, String kind, Throwable t) {
        final StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        write(ctx, kind, sw.toString());
    }

    /** The note from the last death, or null. Reading it takes it. */
    static String take(Context ctx) {
        if (ctx == null) return null;
        final File f = fileIn(ctx);
        if (!f.exists()) return null;
        String text = null;
        try {
            final byte[] buf = new byte[(int) Math.min(f.length(), MAX + 64L)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                final int n = in.read(buf);
                if (n > 0) text = new String(buf, 0, n, StandardCharsets.UTF_8);
            }
        } catch (Throwable t) {
            Log.w(TAG, "could not read the crash note", t);
        }
        /* Taken either way: a note that cannot be read is a note that will never
           be readable, and leaving it would report the same death for ever. */
        if (!f.delete()) Log.w(TAG, "crash note stayed on disk");
        return text;
    }

    /**
     * Anything shaped like a subscription, removed.
     *
     * Provider URLs put the username and password in the PATH
     * (`/live/<user>/<pass>/1234.ts`) as well as in a query string, so both
     * shapes are covered. Same rule, same words, as the page's own redaction.
     */
    static String redact(String text) {
        if (text == null) return "";
        String out = text;
        out = out.replaceAll("(?i)\\b(username|password|user|pass)=([^&\\s\"']+)", "$1=<redacted>");
        out = out.replaceAll("(?i)(://[^/\\s]+/(?:live|movie|series)/)[^/\\s]+/[^/\\s]+/",
                             "$1<redacted>/<redacted>/");
        return out;
    }

    /** Install the handler that catches whatever nobody caught. */
    static void catchEverything(final Context ctx) {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, thrown) -> {
            try {
                write(ctx, "crash on thread " + thread.getName(), thrown);
            } catch (Throwable ignored) {
                /* Nothing useful left to do while the process is going down. */
            }
            /* And then let Android do what it was going to do. Swallowing this
               would leave a half-dead process with no window, which is worse than
               a crash: the viewer gets a black screen and no way back. */
            if (previous != null) previous.uncaughtException(thread, thrown);
        });
    }
}
