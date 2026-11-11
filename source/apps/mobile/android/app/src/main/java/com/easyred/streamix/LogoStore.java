package com.easyred.streamix;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Every channel logo the viewer can reach, downloaded ahead of time and kept.
 *
 * "same like EPG if images can be bulk downloaded and icons and covers". The
 * guide can be, because the panel publishes it as one file. Logos cannot: each
 * is its own URL, mostly on the provider's image hosts, and most of those hosts
 * send no CORS header — so the PAGE cannot keep them (a browser counts every
 * unreadable cross-site image as ~7 MB of storage quota, and a few thousand of
 * them would read as tens of gigabytes and get the whole origin evicted, the
 * channel library with it). Natively there is no such accounting: a logo is a
 * few kilobytes in this app's own files, and nothing but this class decides when
 * it goes.
 *
 * Kept apart from {@link PosterImageCache} on purpose. That one is a 64 MB LRU
 * in the system cache directory, filled as the viewer browses — film posters,
 * mostly, at 50-150 KB each — so a logo seen once was pushed out by the next
 * grid of films, and Android may empty that directory whenever it likes. Logos
 * live in {@code files/}, are served from here BEFORE the poster cache, and are
 * removed only by {@link #retain}, which the page calls with the full list of
 * logos it still wants: a channel that has left the line takes its logo with it.
 *
 * Nothing of this touches our server. The downloads go from the television to
 * wherever the provider says each logo is.
 */
final class LogoStore {
    private static final String DIR = "logo-images";
    /** A logo is drawn at ~48 CSS px, at DPR 2 on a television. */
    private static final int MAX_EDGE = 192;
    /*
     * No refresh. A logo once stored is kept, and never downloaded again: "they
     * never change the logos and cover images, so cache them forever". It used
     * to be fetched anew every thirty days, which on a fifteen-thousand-logo
     * line was a month-long trickle of downloads for pictures that had not
     * changed. What still removes one is `retain` — a channel that has left the
     * line — and a device running out of room (`GIVE_BACK_FREE`).
     */
    /** Stop filling past this; the page's own list is ordered most-wanted first. */
    private static final long MAX_BYTES = 80L * 1024 * 1024;
    private static final int MAX_FILES = 20_000;
    /**
     * One at a time, a quarter of a second apart — a background job, not a race.
     *
     * It was two workers sixty milliseconds apart, which on a slow line is a
     * second download running beside the one the viewer is watching, for as
     * long as fifteen thousand logos take: "takes 20 seconds to start
     * streaming". Four logos a second is a few tens of kilobytes a second, and
     * the logos on screen do not wait for it — the page asks for those itself.
     */
    private static final int WORKERS = 1;
    private static final long PAUSE_MS = 250;
    private static final int CONNECT_MS = 8_000;
    private static final int READ_MS = 10_000;
    private static final int MAX_BODY = 1024 * 1024;
    /**
     * Careful with the viewer's storage: "if not enough storage should be
     * careful". Nothing is downloaded while the device has less than this free —
     * a television box ships with 8 GB and the system, the WebView and the
     * library all need theirs first.
     */
    private static final long MIN_FREE = 500L * 1024 * 1024;
    /** And below this the store gives its space back: every logo still loads
        from its own host without it. */
    private static final long GIVE_BACK_FREE = 150L * 1024 * 1024;

    private static LogoStore instance;

    static synchronized LogoStore get(Context context) {
        if (instance == null) instance = new LogoStore(context.getApplicationContext());
        return instance;
    }

    private final File dir;
    private final ArrayDeque<String> queue = new ArrayDeque<>();
    private final Set<String> queued = new HashSet<>();
    private int running = 0;
    private int done = 0;
    private int failed = 0;
    private long bytes = -1;
    /** Why the last download failed, for the debug panel — "failed" alone says nothing. */
    private volatile String lastError = "";
    /** Requests answered from the store this run — the proof it is used. */
    private volatile int hits = 0;
    /** What a worker last did, for the debug panel when the store seems stuck. */
    private volatile String step = "";

    private LogoStore(Context context) {
        dir = new File(context.getFilesDir(), DIR);
        if (!dir.exists()) dir.mkdirs();
    }

    /* ── serving ─────────────────────────────────────────────────────────── */

    /**
     * The stored copy of this image, if there is one. Null — the request goes on
     * to the poster cache and the network, exactly as before this class existed —
     * for anything it does not hold or cannot read: "always fallback".
     */
    WebResourceResponse serve(WebResourceRequest request) {
        if (request == null || request.getUrl() == null) return null;
        if (request.getMethod() != null && !"GET".equalsIgnoreCase(request.getMethod())) return null;
        final String scheme = request.getUrl().getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) return null;
        try {
            final File hit = find(request.getUrl().toString());
            if (hit == null || hit.length() == 0 || !hit.canRead()) return null;
            final WebResourceResponse out = PosterImageCache.fromFile(hit, mimeOfFile(hit.getName()));
            if (out != null) hits += 1;
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    private static final String[] EXTS = { "png", "jpg", "webp", "gif" };

    /** {@link #serve} for an address already in hand — the app's `/_img` route. */
    WebResourceResponse serveUrl(String url) {
        try {
            final File hit = find(url);
            if (hit == null || hit.length() == 0 || !hit.canRead()) return null;
            final WebResourceResponse out = PosterImageCache.fromFile(hit, mimeOfFile(hit.getName()));
            if (out != null) hits += 1;
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    private File find(String url) {
        final String key = keyOf(url);
        for (String ext : EXTS) {
            final File f = new File(dir, key + "." + ext);
            if (f.isFile()) return f;
        }
        return null;
    }

    private static String mimeOfFile(String name) {
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".gif")) return "image/gif";
        return "image/jpeg";
    }

    /** One spelling per address, whichever side asks: the page's string and the
        WebView's request both go through {@link Uri} first. */
    private static String keyOf(String url) {
        return PosterImageCache.sha256(Uri.parse(url.trim()).toString());
    }

    /* ── filling ─────────────────────────────────────────────────────────── */

    /**
     * Queue these for download; the ones already here and fresh are skipped.
     *
     * `urls` are the addresses the WebView will ASK for — the key each file is
     * kept under. `sources`, when given (same length), are where each is really
     * downloaded from: the app draws plain-http logos through a public resizer,
     * and asking a free third-party service for fifteen thousand images in a row
     * is how it stops answering (measured: it said "too many" after forty). So
     * the logo comes straight from its own host and is shrunk here instead.
     */
    synchronized int prefetch(List<String> urls, List<String> sources) {
        final long free = dir.getUsableSpace();
        if (free > 0 && free < GIVE_BACK_FREE) { clearAll(); return 0; }
        if (free > 0 && free < MIN_FREE) return 0;
        int added = 0;
        final boolean paired = sources != null && sources.size() == urls.size();
        for (int i = 0; i < urls.size(); i++) {
            final String raw = urls.get(i);
            if (raw == null) continue;
            final String url = raw.trim();
            if (!(url.startsWith("http://") || url.startsWith("https://"))) continue;
            if (queued.contains(url)) continue;
            if (find(url) != null) continue;
            String src = url;
            if (paired) {
                final String given = sources.get(i);
                if (given != null && (given.startsWith("http://") || given.startsWith("https://"))) src = given.trim();
            }
            queue.add(url);
            queued.add(url);
            sourceOf.put(url, src);
            added += 1;
        }
        while (running < WORKERS && !queue.isEmpty()) {
            running += 1;
            final Thread t = new Thread(this::work, "logo-store");
            t.setPriority(Thread.MIN_PRIORITY);
            t.setDaemon(true);
            t.start();
        }
        return added;
    }

    /**
     * Hold, wait, continue: "when limit reached hold now and wait till it resets
     * then continue".
     *
     * An image host that says "too many" (429, 503, 509, 456) or drops the
     * connection is put on hold — for as long as it asks (`Retry-After`), else
     * thirty seconds doubling to ten minutes — and every logo waiting on it goes
     * back in line instead of being counted as failed. Logos on other hosts carry
     * on meanwhile, and when the hold is up that host is asked again, one at a
     * time, and the step resets on its first success.
     */
    private void work() {
        for (;;) {
            String url = null;
            long wait = 0;
            synchronized (this) {
                if (queue.isEmpty()) { running -= 1; return; }
                if (full()) { queue.clear(); queued.clear(); sourceOf.clear(); running -= 1; return; }
                final long now = System.currentTimeMillis();
                final int n = queue.size();
                for (int i = 0; i < n; i++) {
                    final String u = queue.poll();
                    final Long until = holdUntil.get(hostOf(srcOf(u)));
                    if (until == null || until <= now) { url = u; break; }
                    queue.add(u);
                    final long w = until - now;
                    wait = wait == 0 ? w : Math.min(wait, w);
                }
            }
            if (url == null) {
                /* Every host left is on hold: sleep until the first comes back. */
                step = "holding " + Math.max(1_000, Math.min(wait, 60_000)) + " ms";
                try { Thread.sleep(Math.max(1_000, Math.min(wait, 60_000))); }
                catch (InterruptedException e) { synchronized (this) { running -= 1; } return; }
                continue;
            }
            long result = FAILED;
            final String src;
            synchronized (this) { src = srcOf(url); }
            try { result = fetch(url, src); } catch (java.io.IOException e) {
                lastError = "io: " + e.getClass().getSimpleName() + " " + e.getMessage();
                result = holdFor(hostOf(src), null);
            } catch (Throwable e) {
                lastError = "error: " + e.getClass().getSimpleName() + " " + e.getMessage();
                android.util.Log.w("LogoStore", "download failed", e);
                result = FAILED;
            }
            synchronized (this) {
                final String host = hostOf(src);
                if (result >= 0) {
                    /* By hand: Map.merge is API 24, and this app still runs on 23. */
                    final Integer had = retries.get(url);
                    final int tries = (had == null ? 0 : had) + 1;
                    retries.put(url, tries);
                    if (tries <= 6) {
                        holdUntil.put(host, System.currentTimeMillis() + result);
                        queue.add(url);
                    } else {
                        retries.remove(url);
                        queued.remove(url);
                        sourceOf.remove(url);
                        failed += 1;
                    }
                } else {
                    retries.remove(url);
                    queued.remove(url);
                    sourceOf.remove(url);
                    if (result == STORED) { done += 1; holdStep.remove(host); } else failed += 1;
                }
            }
            try { Thread.sleep(PAUSE_MS); }
            catch (InterruptedException e) { synchronized (this) { running -= 1; } return; }
        }
    }

    private static final long STORED = -1;
    private static final long FAILED = -2;
    private static final long HOLD_FIRST_MS = 30_000;
    private static final long HOLD_MAX_MS = 10 * 60_000;
    private static final long RETRY_AFTER_MAX_MS = 30 * 60_000;
    private final java.util.Map<String, Long> holdUntil = new java.util.HashMap<>();
    private final java.util.Map<String, Long> holdStep = new java.util.HashMap<>();
    private final java.util.Map<String, Integer> retries = new java.util.HashMap<>();
    /** Where each queued logo is really downloaded from; see {@link #prefetch}. */
    private final java.util.Map<String, String> sourceOf = new java.util.HashMap<>();

    private String srcOf(String key) {
        final String s2 = sourceOf.get(key);
        return s2 == null ? key : s2;
    }

    private static String hostOf(String url) {
        final String h = Uri.parse(url).getHost();
        return h == null ? "" : h.toLowerCase(Locale.ROOT);
    }

    /** How long to hold a host: what it asked for, else the next step of the backoff. */
    private synchronized long holdFor(String host, String retryAfter) {
        if (retryAfter != null) {
            try {
                final long s = Long.parseLong(retryAfter.trim());
                if (s > 0) return Math.min(s * 1000, RETRY_AFTER_MAX_MS);
            } catch (NumberFormatException ignored) { /* an HTTP date: use the step */ }
        }
        final long step = holdStep.containsKey(host) ? Math.min(holdStep.get(host) * 2, HOLD_MAX_MS) : HOLD_FIRST_MS;
        holdStep.put(host, step);
        return step;
    }

    private boolean full() {
        final long free = dir.getUsableSpace();
        if (free > 0 && free < MIN_FREE) return true;
        final File[] files = dir.listFiles();
        if (files == null) return false;
        if (files.length >= MAX_FILES) return true;
        if (bytes < 0 || done % 200 == 0) {
            long total = 0;
            for (File f : files) total += f.length();
            bytes = total;
        }
        return bytes >= MAX_BYTES;
    }

    /** STORED, FAILED, or how many milliseconds to hold this host. */
    private long fetch(String keyUrl, String start) throws Exception {
        String url = start;
        /* By hand, because HttpURLConnection will not follow http <-> https. */
        for (int hop = 0; hop < 4; hop++) {
            final HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(CONNECT_MS);
            conn.setReadTimeout(READ_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", "image/webp,image/apng,image/*,*/*;q=0.8");
            /* A fresh connection per logo. Reusing one after a refusal whose body
               was never read left the next request waiting on a socket that had
               nothing more to say — the store went quiet after its first 429. */
            conn.setRequestProperty("Connection", "close");
            try {
                step = "asking " + hostOf(url);
                final int code = conn.getResponseCode();
                if (code >= 300) drain(conn);
                if (code >= 300 && code < 400) {
                    final String next = conn.getHeaderField("Location");
                    if (next == null) return FAILED;
                    url = new URL(new URL(url), next).toString();
                    continue;
                }
                if (code == 429 || code == 503 || code == 509 || code == 456) {
                    lastError = "http " + code + " from " + hostOf(start) + " (retry-after " + conn.getHeaderField("Retry-After") + ")";
                    return holdFor(hostOf(start), conn.getHeaderField("Retry-After"));
                }
                if (code < 200 || code >= 300) { lastError = "http " + code; return FAILED; }
                final String type = conn.getContentType();
                final String mime = type == null ? "" : type.split(";")[0].trim().toLowerCase(Locale.ROOT);
                if (!mime.startsWith("image/")) { lastError = "not an image: " + mime; return FAILED; }
                final int length = conn.getContentLength();
                if (length > MAX_BODY) return FAILED;
                final byte[] body = PosterImageCache.readAll(conn.getInputStream());
                if (body.length == 0 || body.length > MAX_BODY) return FAILED;
                PosterImageCache.Encoded enc = PosterImageCache.downsample(body, mime, MAX_EDGE);
                if (enc.ext == null) {
                    /* WebP and GIF come back untouched when small: kept as they are. */
                    final String ext = mime.contains("webp") ? "webp" : mime.contains("gif") ? "gif" : null;
                    if (ext == null) { lastError = "unsupported image: " + mime; return FAILED; }
                    enc = new PosterImageCache.Encoded(enc.bytes, mime, ext);
                }
                final String key = keyOf(keyUrl);
                /* One file per logo: a PNG that became a JPEG must not leave both. */
                for (String other : EXTS) if (!other.equals(enc.ext)) new File(dir, key + "." + other).delete();
                try {
                    PosterImageCache.writeAtomic(new File(dir, key + "." + enc.ext), enc.bytes);
                } catch (Exception writeFailed) {
                    lastError = "write: " + writeFailed.getMessage();
                    /* A full disk says so here first: stop filling at once. */
                    synchronized (this) { queue.clear(); queued.clear(); }
                    return FAILED;
                }
                synchronized (this) { if (bytes >= 0) bytes += enc.bytes.length; }
                return STORED;
            } finally {
                conn.disconnect();
            }
        }
        return FAILED;
    }

    /** Read and close whatever an error or redirect sent, so the socket is done. */
    private static void drain(HttpURLConnection conn) {
        try {
            final java.io.InputStream err = conn.getErrorStream();
            if (err != null) { PosterImageCache.readAll(err); }
        } catch (Throwable ignored) { /* nothing to read */ }
    }

    /* ── cleaning ────────────────────────────────────────────────────────── */

    /** Remove every stored logo that is not one of these. Returns how many went. */
    synchronized int retain(List<String> urls) {
        final Set<String> keep = new HashSet<>();
        for (String u : urls) if (u != null) keep.add(keyOf(u));
        final File[] files = dir.listFiles();
        if (files == null) return 0;
        int removed = 0;
        for (File f : files) {
            final String name = f.getName();
            final int dot = name.indexOf('.');
            final String key = dot < 0 ? name : name.substring(0, dot);
            if (name.endsWith(".tmp") || !keep.contains(key)) {
                if (f.delete()) removed += 1;
            }
        }
        bytes = -1;
        return removed;
    }

    /** Everything, for a device that is running out of room. */
    synchronized void clearAll() {
        queue.clear();
        queued.clear();
        sourceOf.clear();
        final File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        bytes = 0;
    }

    String lastError() { return lastError; }

    synchronized String step() {
        final StringBuilder b = new StringBuilder(step);
        final long now = System.currentTimeMillis();
        for (java.util.Map.Entry<String, Long> e : holdUntil.entrySet()) {
            if (e.getValue() > now) b.append(" · held ").append(e.getKey()).append(' ').append((e.getValue() - now) / 1000).append('s');
        }
        final java.util.Map<String, Integer> byHost = new java.util.HashMap<>();
        for (String u : queue) { final String h = hostOf(srcOf(u)); final Integer c = byHost.get(h); byHost.put(h, c == null ? 1 : c + 1); }
        for (java.util.Map.Entry<String, Integer> e : byHost.entrySet()) b.append(" · queued ").append(e.getKey()).append('=').append(e.getValue());
        return b.toString();
    }

    synchronized long[] stats() {
        final File[] files = dir.listFiles();
        long total = 0;
        int n = 0;
        if (files != null) for (File f : files) { if (!f.getName().endsWith(".tmp")) { total += f.length(); n += 1; } }
        return new long[] { n, total, queue.size() + running, done, failed, hits };
    }
}
