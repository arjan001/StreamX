package com.easyred.streamix;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The relay against a panel that allows one connection, the way XUI does it.
 *
 * On the TV emulator a seek froze the picture and a burst of seeks restarted the
 * film, because libVLC opens the new ranged request before closing the old one
 * and the panel refuses the second connection — with a 200 and the words MAX
 * CONNECTIONS REACHED. These drive the relay with plain sockets against a fake
 * panel that does exactly that, including freeing the slot a little AFTER the
 * client has gone, which is the part that bites.
 */
public class OneConnectionRelayTest {

    /** A one-connection panel serving one file, with byte ranges. */
    private static final class Panel {
        final ServerSocket server;
        final byte[] film;
        final long releaseMs;
        final AtomicInteger held = new AtomicInteger();
        final List<String> log = Collections.synchronizedList(new ArrayList<>());

        Panel(byte[] film, long releaseMs) throws IOException {
            this.film = film;
            this.releaseMs = releaseMs;
            this.server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket s = server.accept();
                        new Thread(() -> serve(s)).start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            t.setDaemon(true);
            t.start();
        }

        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/movie/u/p/1.mp4"; }

        void serve(Socket s) {
            boolean took = false;
            try {
                InputStream in = new BufferedInputStream(s.getInputStream());
                String requestLine = readLine(in);
                String path = requestLine == null ? "" : requestLine.split(" ")[1];
                String range = null;
                String line;
                while ((line = readLine(in)) != null && !line.isEmpty()) {
                    if (line.toLowerCase(Locale.ROOT).startsWith("range:")) range = line.substring(6).trim();
                }
                OutputStream out = s.getOutputStream();
                /* A panel's redirector: to the film, or to a playlist. */
                if (path.startsWith("/redirect/")) {
                    String to = path.endsWith(".m3u8") ? "/hls/index.m3u8" : "/movie/u/p/1.mp4";
                    log.add("302 " + path);
                    out.write(("HTTP/1.1 302 Found\r\nLocation: " + to + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    return;
                }
                if (held.get() >= 1) {
                    log.add("REFUSED " + range);
                    byte[] body = "MAX CONNECTIONS REACHED\n".getBytes(StandardCharsets.US_ASCII);
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + body.length
                        + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.write(body);
                    out.flush();
                    return;
                }
                held.incrementAndGet();
                took = true;
                long from = OneConnectionRelay.rangeStart(range);
                if (from >= film.length) {
                    log.add("416 " + range);
                    out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + film.length
                        + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    return;
                }
                log.add("served " + range);
                out.write(("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\n"
                    + "Content-Range: bytes " + from + "-" + (film.length - 1) + "/" + film.length + "\r\n"
                    + "Content-Length: " + (film.length - from) + "\r\nConnection: close\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
                /* Slowly, like a line shaped to its bitrate, so a reader can still be
                   mid-stream when the next request arrives. */
                for (long at = from; at < film.length; at += 4096) {
                    out.write(film, (int) at, (int) Math.min(4096, film.length - at));
                    out.flush();
                    Thread.sleep(5);
                }
            } catch (IOException | InterruptedException ignored) {
                /* the client went away: a seek, or the test ending */
            } finally {
                try { s.close(); } catch (IOException ignored) { /* closing */ }
                if (took) {
                    /* The panel notices the client has gone a little after it has. */
                    new Thread(() -> {
                        try { Thread.sleep(releaseMs); } catch (InterruptedException ignored) { /* test over */ }
                        held.decrementAndGet();
                    }).start();
                }
            }
        }

        void close() throws IOException { server.close(); }
    }

    private Panel panel;
    private OneConnectionRelay relay;
    private final byte[] film = new byte[400_000];

    @Before
    public void setUp() throws IOException {
        for (int i = 0; i < film.length; i++) film[i] = (byte) (i * 31 + 7);
        panel = new Panel(film, 300);
        relay = new OneConnectionRelay();
    }

    @After
    public void tearDown() throws IOException {
        relay.shutdown();
        panel.close();
    }

    /** One request through the relay, as libVLC makes it. */
    private static final class Reader {
        final Socket s;
        final InputStream in;
        final int status;

        Reader(String relayUrl, String range) throws IOException {
            URL u = new URL(relayUrl);
            s = new Socket("127.0.0.1", u.getPort());
            s.setSoTimeout(30_000);
            OutputStream out = s.getOutputStream();
            out.write(("GET " + u.getPath() + " HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                + (range == null ? "" : "Range: " + range + "\r\n") + "\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            in = new BufferedInputStream(s.getInputStream());
            String statusLine = readLine(in);
            status = Integer.parseInt(statusLine.split(" ")[1]);
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) { /* headers */ }
        }

        byte[] read(int n) throws IOException {
            ByteArrayOutputStream got = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            while (got.size() < n) {
                int r = in.read(buf, 0, Math.min(buf.length, n - got.size()));
                if (r == -1) break;
                got.write(buf, 0, r);
            }
            return got.toByteArray();
        }

        void close() throws IOException { s.close(); }
    }

    private byte[] slice(int from, int n) {
        byte[] out = new byte[n];
        System.arraycopy(film, from, out, 0, n);
        return out;
    }

    @Test
    public void aSeekWaitsForTheSlotInsteadOfFailing() throws IOException {
        String url = relay.wrap(panel.url(), "VLC/3", new HashMap<>());
        Reader playing = new Reader(url, "bytes=0-");
        assertEquals(206, playing.status);
        assertArrayEquals(slice(0, 8192), playing.read(8192));

        /* What libVLC does on a seek: the new request BEFORE the old one closes.
           With no relay this is refused outright and the seek silently fails. */
        Reader seek = new Reader(url, "bytes=200000-");
        assertEquals("the seek is answered with the film, not a refusal", 206, seek.status);
        assertArrayEquals("from where it was asked for", slice(200_000, 8192), seek.read(8192));
        playing.close();
        seek.close();

        boolean refusedFirst = false;
        boolean servedAfter = false;
        synchronized (panel.log) {
            for (String l : panel.log) {
                if (l.equals("REFUSED bytes=200000-")) refusedFirst = true;
                if (l.equals("served bytes=200000-") && refusedFirst) servedAfter = true;
            }
        }
        assertTrue("the panel refused it while the old slot was being released: " + panel.log, refusedFirst);
        assertTrue("and served it once the slot was free: " + panel.log, servedAfter);
    }

    @Test
    public void aLookPastTheEndLeavesThePlayingStreamAlone() throws IOException {
        String url = relay.wrap(panel.url(), "VLC/3", new HashMap<>());
        Reader playing = new Reader(url, "bytes=0-");
        assertArrayEquals(slice(0, 4096), playing.read(4096));

        /* libVLC's MP4 reader asks for the end of the file while the film plays
           from the front. Superseding the stream for it killed a playing film. */
        Reader probe = new Reader(url, "bytes=" + film.length + "-");
        assertEquals(503, probe.status);
        probe.close();

        assertArrayEquals("the film carries on from where it was", slice(4096, 8192), playing.read(8192));
        playing.close();
        synchronized (panel.log) {
            for (String l : panel.log) assertFalse("the panel was never asked: " + panel.log, l.contains("bytes=" + film.length));
        }
    }

    @Test
    public void aSlotThatNeverFreesIsReportedNotHeldForever() throws IOException {
        /* Somebody else is watching on this line and never stops. */
        Panel busy = new Panel(film, 60_000);
        busy.held.set(1);
        String url = relay.wrap(busy.url(), "VLC/3", new HashMap<>());
        long start = System.currentTimeMillis();
        Reader r = new Reader(url, "bytes=0-");
        long took = System.currentTimeMillis() - start;
        assertEquals(503, r.status);
        assertTrue("gave up in time for the page to explain it (" + took + "ms)", took < 25_000);
        r.close();
        busy.close();
    }

    @Test
    public void aRedirectIsFollowedToTheFilm() throws IOException {
        String url = relay.wrap(panel.url().replace("/movie/u/p/1.mp4", "/redirect/1.mp4"), "VLC/3", new HashMap<>());
        Reader r = new Reader(url, "bytes=1000-");
        assertEquals(206, r.status);
        assertArrayEquals(slice(1000, 4096), r.read(4096));
        r.close();
    }

    @Test
    public void aRedirectToAPlaylistIsHandedBackToThePlayer() throws IOException {
        /* Its segments are named relative to its own address; relayed, every one
           of them would come here with nowhere to go. */
        String url = relay.wrap(panel.url().replace("/movie/u/p/1.mp4", "/redirect/1.m3u8"), "VLC/3", new HashMap<>());
        Reader r = new Reader(url, null);
        assertEquals(302, r.status);
        r.close();
        synchronized (panel.log) {
            for (String l : panel.log) assertFalse("the playlist itself was never fetched here: " + panel.log, l.contains("index.m3u8"));
        }
    }

    @Test
    public void onlySingleFilesGoThroughIt() {
        assertTrue(OneConnectionRelay.eligible("http://h/movie/u/p/1.mkv"));
        assertTrue(OneConnectionRelay.eligible("http://h/live/u/p/1.ts"));
        /* A playlist names its segments relative to itself. */
        assertFalse(OneConnectionRelay.eligible("http://h/live/u/p/1.m3u8"));
        assertFalse(OneConnectionRelay.eligible("http://h/play/1.m3u8?token=x"));
        assertFalse(OneConnectionRelay.eligible("file:///sdcard/x.mkv"));
    }

    @Test
    public void rangesAreRead() {
        assertEquals(0, OneConnectionRelay.rangeStart(null));
        assertEquals(0, OneConnectionRelay.rangeStart("bytes=0-"));
        assertEquals(47985136L, OneConnectionRelay.rangeStart("bytes=47985136-"));
        assertEquals(100L, OneConnectionRelay.rangeStart("bytes=100-199"));
        assertEquals(0, OneConnectionRelay.rangeStart("items=5-"));
    }

    static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
        }
        return b == -1 && sb.length() == 0 ? null : sb.toString();
    }
}
