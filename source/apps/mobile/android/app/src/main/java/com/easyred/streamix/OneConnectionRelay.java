package com.easyred.streamix;

import android.util.Log;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A loopback relay between libVLC and a panel that allows one connection.
 *
 * ── what it is for ──
 *
 * Measured on the TV emulator against a one-connection panel: a seek in a film
 * froze the picture on the frame it was showing (00:02:41.640 on the burned-in
 * clock), the clock on screen stopped, and the panel's log said why — libVLC
 * had closed its connection and asked for the new position twice, and both
 * requests were refused, MAX CONNECTIONS REACHED. A burst of seeks did worse:
 * the film started again from the beginning.
 *
 * That is not a libVLC bug, and it is not avoidable inside libVLC. Every seek
 * over HTTP/1.1 is a new ranged request, and a panel frees the slot when its
 * own handler notices the previous client has gone — not when the client
 * closes. An IPTV proxy measured superseded connections lingering fifteen to
 * twenty-four seconds (tuliprox issue 866). Until then, on a line that allows
 * one connection, every new request is refused: a seek, the reconnect after a
 * pause long enough for the panel to hang up on an idle player, the index read
 * a demuxer makes at the end of a file. XUI refuses with a 200 and a sentence
 * where the video should be, which libVLC takes as the start of the file.
 * Those are the three reports this exists for: "cannot go backwards and
 * forwards — it just starts from the beginning", "pause a show and restart, it
 * goes back to the beginning", and a picture that is "just stuck".
 *
 * ── what it does ──
 *
 * libVLC talks to this, on 127.0.0.1, and this talks to the panel. When the
 * panel refuses because the old connection is still being counted, this does
 * not pass the refusal on: it waits and asks again, with the viewer's request
 * held open, until the slot is free or `GIVE_UP_MS` has passed. The viewer sees
 * a few seconds of buffering instead of a frozen frame or a film starting
 * over. Nothing leaves the device — it is the device's own connection, relayed
 * through its own loopback.
 *
 * ── how libVLC seeks, and why that needs this ──
 *
 * VLC 3's HTTP reader (`vlc_http_file_seek`) opens the NEW ranged request while
 * the old response is still open, and drops the old one only if the new one
 * comes back 206. On a line that allows one connection the new request is
 * therefore always refused — libVLC itself is holding the slot — and the seek
 * quietly fails: playback carries on from where it was while the page's bar
 * has already jumped. That is "the progress bar goes back to where it was".
 *
 * So a new request SUPERSEDES the current one: the old upstream connection is
 * dropped at once, which is what lets the panel free the slot, and the new
 * request waits for it. libVLC was about to drop the old response anyway.
 *
 * The one exception is a read at or past the end of the file. libVLC's MP4
 * reader asks for that while the film plays from the front, looking for a
 * trailing index this kind of file does not have. Superseding the stream for it
 * killed a playing film — measured, in the first version of this — so it is
 * answered at once with a refusal, which makes libVLC keep the stream it has:
 * exactly what happened with no relay at all.
 *
 * ── what it deliberately does not do ──
 *
 * It proxies only single-file streams. An HLS playlist names its segments
 * relative to itself, so a relayed playlist would send every segment here with
 * nowhere to go; those stay direct. And it never retries anything but a
 * refusal — a 404 is an answer, not a busy signal.
 */
final class OneConnectionRelay {
    private static final String TAG = "StreamixRelay";

    /**
     * How long a refused request keeps being asked again before libVLC is told.
     *
     * Under the page's own first-frame watchdog (`NATIVE_WAIT_MS`, 25s), so a
     * slot that never frees arrives as a failure the page can explain rather
     * than as the page giving up on a request that is still being retried.
     */
    private static final long GIVE_UP_MS = 20_000;
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    /** A refusal is a short page; a film is not. Enough to read the whole sentence. */
    private static final int REFUSAL_MAX_BYTES = 8_192;

    private static final class Target {
        final String url;
        final String userAgent;
        final Map<String, String> headers;
        /** Where the panel's redirect led last time — see `open`. */
        volatile String resolved;
        /** The file's length, once a response has said it; -1 until then. */
        volatile long total = -1;

        Target(String url, String userAgent, Map<String, String> headers) {
            this.url = url;
            this.userAgent = userAgent;
            this.headers = headers;
        }
    }

    /** One viewer request and the upstream connection serving it. */
    private static final class Exchange {
        final Socket client;
        volatile HttpURLConnection upstream;
        volatile boolean aborted;

        Exchange(Socket client) { this.client = client; }

        void abort() {
            aborted = true;
            HttpURLConnection c = upstream;
            if (c != null) {
                try { c.disconnect(); } catch (Throwable ignored) { /* already gone */ }
            }
            try { client.close(); } catch (IOException ignored) { /* already gone */ }
        }
    }

    private final Object lock = new Object();
    private final Map<String, Target> targets = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "streamix-relay");
        t.setDaemon(true);
        return t;
    });
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;
    /** The request that is the stream — see "two kinds of request". */
    private Exchange current;
    /** Every request in flight, so `release` drops them all. */
    private final java.util.Set<Exchange> live = java.util.Collections.newSetFromMap(new ConcurrentHashMap<>());

    /** Should this URL go through the relay at all? */
    static boolean eligible(String url) {
        if (url == null) return false;
        String u = url.toLowerCase(Locale.ROOT);
        if (!u.startsWith("http://") && !u.startsWith("https://")) return false;
        /* A playlist's segments resolve against the playlist's own address. */
        return !u.contains(".m3u8") && !u.contains(".m3u?") && !u.endsWith(".m3u");
    }

    /**
     * Register a stream and return the loopback address libVLC should open.
     *
     * One stream at a time, like the line itself: registering a new one
     * forgets the last and drops whatever upstream connection it still held, so
     * the panel starts counting the old slot down as early as possible.
     */
    String wrap(String url, String userAgent, Map<String, String> headers) throws IOException {
        synchronized (lock) {
            ensureStarted();
            if (current != null) { current.abort(); current = null; }
            targets.clear();
            String id = Long.toHexString(random.nextLong()) + Long.toHexString(random.nextLong());
            targets.put(id, new Target(url, userAgent, headers == null ? new HashMap<>() : headers));
            return "http://127.0.0.1:" + server.getLocalPort() + "/s/" + id;
        }
    }

    /** Drop the upstream connection now — playback stopped. */
    void release() {
        synchronized (lock) {
            if (current != null) { current.abort(); current = null; }
            for (Exchange e : live) e.abort();
            live.clear();
            targets.clear();
        }
    }

    void shutdown() {
        synchronized (lock) {
            release();
            if (server != null) {
                try { server.close(); } catch (IOException ignored) { /* closing anyway */ }
                server = null;
            }
        }
        pool.shutdownNow();
    }

    private void ensureStarted() throws IOException {
        if (server != null && !server.isClosed()) return;
        /* Loopback only. Anything else on the network reaching this would be a
           way to make the television fetch arbitrary addresses. */
        server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        final ServerSocket listening = server;
        Thread accept = new Thread(() -> {
            while (!listening.isClosed()) {
                try {
                    Socket s = listening.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    if (listening.isClosed()) return;
                } catch (Throwable t) {
                    log("accept failed: " + t);
                }
            }
        }, "streamix-relay-accept");
        accept.setDaemon(true);
        accept.start();
    }

    private void handle(Socket client) {
        Exchange mine = new Exchange(client);
        try {
            client.setSoTimeout(15_000);
            InputStream in = new BufferedInputStream(client.getInputStream());
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { respond(client, 400, "Bad Request"); return; }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String path = parts[1];
            Map<String, String> requestHeaders = readHeaders(in);
            client.setSoTimeout(0);

            Target target = path.startsWith("/s/") ? targets.get(path.substring(3)) : null;
            if (target == null || !(method.equals("GET") || method.equals("HEAD"))) {
                respond(client, 404, "Not Found");
                return;
            }
            String range = requestHeaders.get("range");
            long from = rangeStart(range);
            if (target.total > 0 && from >= target.total) {
                /* A look past the end — see "how libVLC seeks". Refused at once,
                   and the playing stream is left exactly as it is. */
                log("past the end (" + range + ") -> 503, stream untouched");
                respond(client, 503, "Service Unavailable");
                return;
            }
            synchronized (lock) {
                /* This request is the stream now. Dropping the old upstream here,
                   before asking for the new one, is what starts the panel's
                   release clock. */
                if (current != null) current.abort();
                current = mine;
            }
            live.add(mine);
            log("stream " + method + " " + (range == null ? "(whole)" : range));
            relay(target, method, range, mine);
        } catch (IOException e) {
            /* libVLC hung up — a seek, a stop, a channel change. Normal. */
        } catch (Throwable t) {
            log("relay failed: " + t);
        } finally {
            synchronized (lock) { if (current == mine) current = null; }
            live.remove(mine);
            mine.abort();
        }
    }

    private void relay(Target target, String method, String range, Exchange ex) throws IOException {
        final long deadline = System.currentTimeMillis() + GIVE_UP_MS;
        long wait = 250;
        int refusals = 0;
        while (!ex.aborted) {
            HttpURLConnection c = null;
            try {
                c = open(target, method, range);
                ex.upstream = c;
                int code = c.getResponseCode();
                /*
                 * Redirects, followed here rather than by HttpURLConnection,
                 * which will not cross from http to https — and a panel that
                 * sends a channel to an HTTPS playlist is real. A playlist is handed back to libVLC as a
                 * redirect: its segments are named relative to its own address,
                 * so it must be fetched from there, not from here.
                 */
                int hops = 0;
                while (code >= 300 && code < 400 && hops++ < 5) {
                    String location = c.getHeaderField("Location");
                    if (location == null) break;
                    String next = new URL(c.getURL(), location).toString();
                    c.disconnect();
                    if (isPlaylist(next, null)) {
                        log("  -> playlist, handed back to the player");
                        redirect(ex.client, next);
                        return;
                    }
                    target.resolved = next;
                    c = open(target, method, range);
                    ex.upstream = c;
                    code = c.getResponseCode();
                }
                if (isPlaylist(c.getURL().toString(), c.getContentType())) {
                    String at = c.getURL().toString();
                    c.disconnect();
                    log("  -> playlist, handed back to the player");
                    redirect(ex.client, at);
                    return;
                }
                if (isRefusal(code, c)) {
                    refusals++;
                    c.disconnect();
                    ex.upstream = null;
                    if (System.currentTimeMillis() + wait > deadline) {
                        log("  -> refused " + refusals + "x, answering 503 (the slot never freed)");
                        respond(ex.client, 503, "Service Unavailable");
                        return;
                    }
                    sleep(wait);
                    wait = Math.min(wait * 2, 2_000);
                    continue;
                }
                log("  -> " + code + (refusals > 0 ? " after " + refusals + " refusals" : ""));
                /* Reuse where the redirect led: one request to the panel's
                   redirector fewer per seek, and the redirector is a connection
                   the panel counts too. */
                String landed = c.getURL().toString();
                if (!landed.equals(target.url)) target.resolved = landed;
                long total = totalOf(c, rangeStart(range));
                if (total > 0) target.total = total;
                writeHead(ex.client, code, c);
                if (!method.equals("HEAD")) pump(c, ex);
                return;
            } catch (IOException e) {
                if (c != null) c.disconnect();
                ex.upstream = null;
                if (ex.aborted) return;
                /* A minted token that expired: back to the panel's own address. */
                if (target.resolved != null) { target.resolved = null; continue; }
                if (System.currentTimeMillis() + wait > deadline) {
                    respond(ex.client, 502, "Bad Gateway");
                    return;
                }
                sleep(wait);
                wait = Math.min(wait * 2, 2_000);
            }
        }
    }

    private HttpURLConnection open(Target target, String method, String range) throws IOException {
        String address = target.resolved != null ? target.resolved : target.url;
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setRequestMethod(method);
        /* By hand, in `relay` — see the note there. */
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(CONNECT_TIMEOUT_MS);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setUseCaches(false);
        /* Closed when we are done with it, not parked in a keep-alive pool
           where the panel would go on counting it. */
        c.setRequestProperty("Connection", "close");
        c.setRequestProperty("Accept-Encoding", "identity");
        if (target.userAgent != null) c.setRequestProperty("User-Agent", target.userAgent);
        for (Map.Entry<String, String> h : target.headers.entrySet()) {
            c.setRequestProperty(h.getKey(), h.getValue());
        }
        if (range != null && !range.isEmpty()) c.setRequestProperty("Range", range);
        return c;
    }

    /**
     * Is this the panel saying "not now", rather than an answer?
     *
     * The flood codes, or a short text page where a video was asked for — XUI's
     * MAX CONNECTIONS REACHED arrives as a 200. A film is never a few kilobytes
     * of text/html, so reading that much to be sure costs nothing real.
     */
    private static boolean isRefusal(int code, HttpURLConnection c) {
        if (code == 429 || code == 456 || code == 509 || code == 511 || code == 513) return true;
        if (code != 200 && code != 206) return false;
        String type = c.getContentType();
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (!(t.startsWith("text/") || t.contains("html"))) return false;
        long length = c.getContentLengthLong();
        return length < 0 || length <= REFUSAL_MAX_BYTES;
    }

    /** An HLS playlist, by its address or by what the server says it is. */
    static boolean isPlaylist(String url, String contentType) {
        String u = url == null ? "" : url.toLowerCase(Locale.ROOT);
        String t = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        return u.contains(".m3u8") || t.contains("mpegurl");
    }

    private static void redirect(Socket client, String location) {
        try {
            OutputStream out = client.getOutputStream();
            out.write(("HTTP/1.1 302 Found\r\nLocation: " + location
                + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException ignored) {
            /* the player hung up first */
        }
    }

    /** Where a `Range: bytes=N-` begins; 0 for no range or one we do not parse. */
    static long rangeStart(String range) {
        if (range == null) return 0;
        String r = range.trim().toLowerCase(Locale.ROOT);
        if (!r.startsWith("bytes=")) return 0;
        int dash = r.indexOf('-', 6);
        if (dash <= 6) return 0;
        try { return Long.parseLong(r.substring(6, dash).trim()); } catch (NumberFormatException e) { return 0; }
    }

    /** The whole file's length, from `Content-Range: bytes a-b/TOTAL` or a whole-file length. */
    private static long totalOf(HttpURLConnection c, long from) {
        String cr = c.getHeaderField("Content-Range");
        if (cr != null) {
            int slash = cr.lastIndexOf('/');
            if (slash >= 0) {
                try { return Long.parseLong(cr.substring(slash + 1).trim()); } catch (NumberFormatException ignored) { /* "*" */ }
            }
        }
        long len = c.getContentLengthLong();
        return from == 0 && len > 0 ? len : -1;
    }

    private static void writeHead(Socket client, int code, HttpURLConnection c) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        copyHeader(head, c, "Content-Type");
        copyHeader(head, c, "Content-Length");
        copyHeader(head, c, "Content-Range");
        copyHeader(head, c, "Accept-Ranges");
        copyHeader(head, c, "Last-Modified");
        head.append("Connection: close\r\n\r\n");
        OutputStream out = client.getOutputStream();
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static void copyHeader(StringBuilder head, HttpURLConnection c, String name) {
        String v = c.getHeaderField(name);
        if (v != null) head.append(name).append(": ").append(v).append("\r\n");
    }

    private static void pump(HttpURLConnection c, Exchange ex) throws IOException {
        byte[] buf = new byte[64 * 1024];
        try (InputStream up = c.getInputStream()) {
            OutputStream down = ex.client.getOutputStream();
            int n;
            while (!ex.aborted && (n = up.read(buf)) != -1) {
                down.write(buf, 0, n);
            }
            down.flush();
        } finally {
            c.disconnect();
        }
    }

    private static void respond(Socket client, int code, String reason) {
        try {
            OutputStream out = client.getOutputStream();
            out.write(("HTTP/1.1 " + code + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException ignored) {
            /* the client is gone; so is the point of telling it */
        }
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 404: return "Not Found";
            case 416: return "Range Not Satisfiable";
            default: return "Status";
        }
    }

    /**
     * logcat when there is one. Through here so the relay also runs under a
     * plain JVM — the unit test drives it against a fake one-connection panel,
     * where `android.util.Log` is a stub that throws.
     */
    private static void log(String line) {
        try { Log.i(TAG, line); } catch (RuntimeException notOnAndroid) { /* unit test */ }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
            if (sb.length() > 8_192) throw new IOException("header line too long");
        }
        if (b == -1 && sb.length() == 0) return null;
        return sb.toString();
    }

    private static Map<String, String> readHeaders(InputStream in) throws IOException {
        Map<String, String> headers = new HashMap<>();
        String line;
        int count = 0;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            if (++count > 100) throw new IOException("too many headers");
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
        }
        return headers;
    }
}
