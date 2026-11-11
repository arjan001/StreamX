package com.streamx.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Disk cache + downsample for WebView poster/logo loads.
 *
 * Wired from {@code MediaFriendlyClient.shouldInterceptRequest}. Capacitor's
 * local-asset handler runs first; this only sees requests that fell through —
 * external http(s) artwork, not the app shell.
 *
 * Why native: a VOD grid mounts dozens of tiles; decoding a 2000×3000 TMDB
 * master on a TV box is the jank, not the network. JS already asks for a
 * smaller TMDB rendition when it can ({@code artworkAt}); this catches what
 * still arrives oversized, and keeps a warm disk copy across scrolls.
 *
 * Never for media. A mistaken intercept of an HLS segment as {@code image/jpeg}
 * is a black screen, so video/m3u8/ts paths and non-image MIME pass through
 * with their real type (or are not intercepted at all).
 */
final class PosterImageCache {
    /** Long edge after downsample — covers a ~240 CSS-px poster at DPR 2. */
    static final int MAX_EDGE = 480;

    /*
     * Kept for good, within reason: "they never change the logos and cover
     * images, so cache them forever". It was 64 MB in the system's cache
     * folder — about fifteen hundred covers, dropped oldest-written first, and
     * a folder Android empties whenever it likes — so the same posters were
     * downloaded again every few days of browsing. Now the app's own storage,
     * up to a gigabyte (fifteen to twenty thousand covers at this size), and
     * what goes first when room is needed is what has not been LOOKED at for
     * longest, not what was fetched first.
     *
     * The device's room comes before the store's: nothing new is kept while
     * the device has less than MIN_FREE, and below GIVE_BACK_FREE the store
     * gives space back — every picture still loads from its host without it.
     * The same two numbers as {@link LogoStore}.
     */
    private static final long MAX_CACHE_BYTES = 1024L * 1024 * 1024;
    private static final long MIN_FREE = 500L * 1024 * 1024;
    private static final long GIVE_BACK_FREE = 150L * 1024 * 1024;
    /** A hit marks the file as seen at most this often — a write per paint is not free. */
    private static final long TOUCH_EVERY_MS = 24L * 3600_000;
    /*
     * Short, because these fetches happen INSIDE WebView's request handler.
     *
     * That handler runs on a small pool of threads which also answers every
     * other request the page makes — its own scripts, the panel's API, the
     * stream. A picture host that holds the connection held one of those
     * threads for as long as these allowed: 8 s to connect and 8 more to read.
     * Measured on the TV emulator, forty such pictures made the next ordinary
     * request wait 7.2 seconds. A logo is a few kilobytes; three seconds to
     * connect and five to arrive is already generous, and the page retires the
     * host after one failure (lib/deadArt.ts) and only asks three at a time
     * (lib/imageTurns.ts).
     */
    private static final int CONNECT_MS = 3_000;
    private static final int READ_MS = 5_000;
    private static final String CACHE_DIR = "poster-images";

    private final File dir;
    /** Bytes held, counted once and then kept up to date; -1 until counted. */
    private long total = -1;

    /**
     * @param filesRoot where the store lives: the app's own files, which the
     *     system does not clear to make room.
     * @param oldCacheRoot where it used to live. Whatever is there is moved
     *     over once, off the main thread, so nothing already downloaded is lost.
     */
    PosterImageCache(File filesRoot, File oldCacheRoot) {
        this.dir = new File(filesRoot, CACHE_DIR);
        if (!dir.exists()) dir.mkdirs();
        final File old = oldCacheRoot == null ? null : new File(oldCacheRoot, CACHE_DIR);
        if (old != null && old.isDirectory()) {
            final Thread t = new Thread(() -> adopt(old), "poster-cache-move");
            t.setPriority(Thread.MIN_PRIORITY);
            t.start();
        }
    }

    private void adopt(File old) {
        final File[] files = old.listFiles();
        if (files != null) {
            for (File f : files) {
                final File to = new File(dir, f.getName());
                if (f.getName().endsWith(".tmp") || to.exists() || !f.renameTo(to)) f.delete();
            }
        }
        old.delete();
        synchronized (this) { total = -1; }
    }

    /**
     * How many bytes must go: back under the cap (to nine tenths of it, so one
     * over-cap write does not mean a sort of every file on each write after it),
     * or enough to give the device back GIVE_BACK_FREE. Never more than is held.
     * {@code free} below zero means unknown. Package-visible for the tests.
     */
    static long toRemove(long total, long free, long cap, long floor) {
        final long over = total > cap ? total - cap * 9 / 10 : 0;
        final long shortBy = free >= 0 && free < floor ? floor - free : 0;
        return Math.max(0, Math.min(total, Math.max(over, shortBy)));
    }

    /** A cover on screen is a cover worth keeping: its age is its last look. */
    private static void touch(File f) {
        final long now = System.currentTimeMillis();
        if (now - f.lastModified() > TOUCH_EVERY_MS) f.setLastModified(now);
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        if (request == null) return null;
        final Uri uri = request.getUrl();
        if (uri == null) return null;
        if (!shouldHandle(
                uri.getScheme(),
                uri.getHost(),
                uri.getPath(),
                request.getMethod(),
                acceptOf(request))) {
            return null;
        }
        /* Range requests are for media progressive download — leave them alone. */
        if (hasHeader(request, "Range")) return null;

        final String url = uri.toString();
        final File hit = findCached(url);
        if (hit != null) {
            touch(hit);
            return fromFile(hit, mimeForExt(extOf(hit.getName())));
        }

        try {
            return fetchAndCache(url);
        } catch (Exception e) {
            /* Let the WebView retry / surface the failure itself. */
            return null;
        }
    }

    /**
     * A picture by its address, for the app's same-origin `/_img` route: the
     * disk copy if there is one, else fetched, shrunk and kept. Null when it
     * cannot be had — the caller answers 404 so the tile falls back at once.
     */
    WebResourceResponse interceptUrl(String url) {
        if (url == null) return null;
        final Uri uri = Uri.parse(url);
        final String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) return null;
        if (isOurOrigin(uri.getHost()) || isMediaPath(uri.getPath() == null ? "" : uri.getPath())) return null;
        final File hit = findCached(url);
        if (hit != null) {
            touch(hit);
            return fromFile(hit, mimeForExt(extOf(hit.getName())));
        }
        try {
            final WebResourceResponse fetched = fetchAndCache(url);
            if (fetched == null || fetched.getMimeType() == null || !fetched.getMimeType().startsWith("image/")) return null;
            return fetched;
        } catch (Exception e) {
            return null;
        }
    }

    /** The Capacitor shell's own origin. Nothing else. */
    static boolean isOurOrigin(String host) {
        if (host == null || host.isEmpty()) return false;
        final String h = host.toLowerCase(Locale.ROOT);
        return h.equals("localhost");
    }

    /**
     * GET http(s) that look like artwork, and are not stream/media URLs.
     * Package-visible for unit tests.
     */
    static boolean shouldHandle(
            String scheme, String host, String path, String method, String accept) {
        if (method != null && !"GET".equalsIgnoreCase(method)) return false;
        if (scheme == null) return false;
        if (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https")) {
            return false;
        }
        if (host == null || host.isEmpty()) return false;
        /* App shell / API — Capacitor already owns these; never re-fetch here. */
        if (isOurOrigin(host)) return false;

        final String p = path == null ? "" : path;
        if (isMediaPath(p)) return false;

        if (isImageHost(host)) return true;
        if (isImagePath(p)) return true;
        /* <img> requests send Accept: image/...; XHR for streams usually does not. */
        return accept != null && accept.toLowerCase(Locale.ROOT).contains("image/");
    }

    static boolean isMediaPath(String path) {
        final String p = path.toLowerCase(Locale.ROOT);
        return p.contains(".m3u8")
                || p.endsWith(".ts")
                || p.contains(".ts?")
                || p.endsWith(".m4s")
                || p.endsWith(".mpd")
                || p.endsWith(".mp4")
                || p.endsWith(".mkv")
                || p.endsWith(".webm")
                || p.endsWith(".aac")
                || p.endsWith(".m4a")
                || p.endsWith(".mp3")
                || p.endsWith(".flac");
    }

    static boolean isImagePath(String path) {
        final String p = path.toLowerCase(Locale.ROOT);
        return p.endsWith(".jpg")
                || p.endsWith(".jpeg")
                || p.endsWith(".png")
                || p.endsWith(".webp")
                || p.endsWith(".gif")
                || p.endsWith(".svg")
                || p.endsWith(".avif");
    }

    static boolean isImageHost(String host) {
        final String h = host.toLowerCase(Locale.ROOT);
        return h.equals("image.tmdb.org")
                || h.equals("www.themoviedb.org")
                || h.equals("wsrv.nl")
                || h.endsWith(".tmdb.org");
    }

    /** Power-of-two {@code inSampleSize} so the long edge is ≤ maxEdge. */
    static int sampleSize(int width, int height, int maxEdge) {
        if (width <= 0 || height <= 0 || maxEdge <= 0) return 1;
        int sample = 1;
        int w = width;
        int h = height;
        while (w / 2 >= maxEdge || h / 2 >= maxEdge) {
            w /= 2;
            h /= 2;
            sample *= 2;
        }
        return sample;
    }

    private WebResourceResponse fetchAndCache(String url) throws Exception {
        final HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_MS);
        conn.setReadTimeout(READ_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Accept", "image/webp,image/apng,image/*,*/*;q=0.8");
        conn.connect();

        final int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            conn.disconnect();
            return null;
        }

        final String rawType = conn.getContentType();
        final String mime = mimeOf(rawType);
        if (!isImageMime(mime)) {
            /*
             * Not an image — return the real body with the real type so the
             * WebView does not get a silent wrong Content-Type. Do not cache.
             */
            final byte[] body = readAll(conn.getInputStream());
            conn.disconnect();
            return response(mime == null ? "application/octet-stream" : mime, body);
        }

        final byte[] body = readAll(conn.getInputStream());
        conn.disconnect();

        final Encoded encoded = downsample(body, mime);
        final long free = dir.getUsableSpace();
        if (encoded.ext != null && !(free > 0 && free < MIN_FREE)) {
            writeAtomic(cacheFile(url, encoded.ext), encoded.bytes);
            trimCache(encoded.bytes.length);
        } else if (free > 0 && free < GIVE_BACK_FREE) {
            /* Nothing is being kept, so nothing else would ever give room back. */
            trimCache(0);
        }
        return response(encoded.mime, encoded.bytes);
    }

    private static Encoded downsample(byte[] body, String mime) {
        return downsample(body, mime, MAX_EDGE);
    }

    /** Shared with {@link LogoStore}, which shrinks logos further. */
    static Encoded downsample(byte[] body, String mime, int maxEdge) {
        /* Vector / formats BitmapFactory will not shrink — keep bytes and type. */
        if (mime.contains("svg") || mime.contains("gif")) {
            return Encoded.passthrough(body, mime);
        }

        final BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(body, 0, body.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return Encoded.passthrough(body, mime);
        }

        final int sample = sampleSize(bounds.outWidth, bounds.outHeight, maxEdge);
        if (sample == 1
                && bounds.outWidth <= maxEdge
                && bounds.outHeight <= maxEdge
                && body.length < 128 * 1024) {
            return Encoded.passthrough(body, mime);
        }

        final boolean wantAlpha = mime.contains("png") || mime.contains("webp");
        final BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = wantAlpha ? Bitmap.Config.ARGB_8888 : Bitmap.Config.RGB_565;
        final Bitmap bmp = BitmapFactory.decodeByteArray(body, 0, body.length, opts);
        if (bmp == null) return Encoded.passthrough(body, mime);

        final ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        if (wantAlpha) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            bmp.recycle();
            return new Encoded(out.toByteArray(), "image/png", "png");
        }
        bmp.compress(Bitmap.CompressFormat.JPEG, 82, out);
        bmp.recycle();
        return new Encoded(out.toByteArray(), "image/jpeg", "jpg");
    }

    private File findCached(String url) {
        final File jpg = cacheFile(url, "jpg");
        if (jpg.isFile()) return jpg;
        final File png = cacheFile(url, "png");
        if (png.isFile()) return png;
        return null;
    }

    private static String extOf(String name) {
        final int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1);
    }

    private static String mimeForExt(String ext) {
        if ("png".equals(ext)) return "image/png";
        return "image/jpeg";
    }

    static void writeAtomic(File dest, byte[] bytes) throws Exception {
        final File tmp = new File(dest.getPath() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(bytes);
            fos.getFD().sync();
        }
        if (!tmp.renameTo(dest)) {
            if (dest.exists()) dest.delete();
            if (!tmp.renameTo(dest)) {
                tmp.delete();
                throw new IllegalStateException("cache rename failed");
            }
        }
    }

    private synchronized void trimCache(long added) {
        if (total < 0) {
            final File[] files = dir.listFiles();
            long sum = 0;
            if (files != null) for (File f : files) sum += f.length();
            total = sum;
        } else {
            total += added;
        }
        final long need = toRemove(total, dir.getUsableSpace(), MAX_CACHE_BYTES, GIVE_BACK_FREE);
        if (need <= 0) return;
        final File[] files = dir.listFiles();
        if (files == null || files.length == 0) { total = 0; return; }
        /* Least recently looked at first — `touch` keeps a watched cover young. */
        java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        long freed = 0;
        long kept = 0;
        for (File f : files) {
            final long n = f.length();
            if (freed < need && f.delete()) { freed += n; continue; }
            kept += n;
        }
        /* Counted afresh from what is left, so the running figure cannot drift. */
        total = kept;
    }

    private File cacheFile(String url, String ext) {
        return new File(dir, sha256(url) + "." + ext);
    }

    static WebResourceResponse fromFile(File file, String mime) {
        try {
            final Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "max-age=31536000");
            return new WebResourceResponse(
                    mime,
                    null,
                    200,
                    "OK",
                    headers,
                    new BufferedInputStream(new FileInputStream(file)));
        } catch (Exception e) {
            return null;
        }
    }

    private static WebResourceResponse response(String mime, byte[] body) {
        final Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "max-age=31536000");
        headers.put("Content-Length", String.valueOf(body.length));
        return new WebResourceResponse(
                mime,
                null,
                200,
                "OK",
                Collections.unmodifiableMap(headers),
                new ByteArrayInputStream(body));
    }

    private static String acceptOf(WebResourceRequest request) {
        return headerOf(request, "Accept");
    }

    private static boolean hasHeader(WebResourceRequest request, String name) {
        return headerOf(request, name) != null;
    }

    private static String headerOf(WebResourceRequest request, String name) {
        final Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        }
        return null;
    }

    private static String mimeOf(String contentType) {
        if (contentType == null) return null;
        final int semi = contentType.indexOf(';');
        final String type = (semi < 0 ? contentType : contentType.substring(0, semi)).trim();
        return type.isEmpty() ? null : type.toLowerCase(Locale.ROOT);
    }

    private static boolean isImageMime(String mime) {
        return mime != null && mime.startsWith("image/");
    }

    static byte[] readAll(InputStream in) throws Exception {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream(32 * 1024)) {
            final byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = stream.read(buf)) >= 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    static String sha256(String s) {
        try {
            final MessageDigest md = MessageDigest.getInstance("SHA-256");
            final byte[] dig = md.digest(s.getBytes(StandardCharsets.UTF_8));
            final StringBuilder sb = new StringBuilder(dig.length * 2);
            for (byte b : dig) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    static final class Encoded {
        final byte[] bytes;
        final String mime;
        /** Cache filename extension, or null when the payload must not be cached. */
        final String ext;

        Encoded(byte[] bytes, String mime, String ext) {
            this.bytes = bytes;
            this.mime = mime;
            this.ext = ext;
        }

        static Encoded passthrough(byte[] bytes, String mime) {
            final String ext = cacheExtForMime(mime);
            return new Encoded(bytes, mime, ext);
        }
    }

    /** Only formats we re-serve from disk; others pass through once and skip cache. */
    private static String cacheExtForMime(String mime) {
        if (mime == null) return null;
        if (mime.contains("png")) return "png";
        if (mime.contains("jpeg") || mime.contains("jpg")) return "jpg";
        return null;
    }
}
