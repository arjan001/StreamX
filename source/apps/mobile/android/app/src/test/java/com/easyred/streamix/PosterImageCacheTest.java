package com.easyred.streamix;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Classification rules for the WebView image intercept — wrong positives here
 * would feed an HLS segment as image/jpeg.
 */
public class PosterImageCacheTest {

    private static final long MB = 1024L * 1024;

    @Test
    public void keepsEverythingUnderTheCapWhileTheDeviceHasRoom() {
        assertEquals(0, PosterImageCache.toRemove(900 * MB, 4000 * MB, 1024 * MB, 150 * MB));
        /* Unknown free space is not a reason to delete anything. */
        assertEquals(0, PosterImageCache.toRemove(900 * MB, -1, 1024 * MB, 150 * MB));
    }

    @Test
    public void overTheCapTrimsToNineTenthsOnce() {
        final long need = PosterImageCache.toRemove(1025 * MB, 4000 * MB, 1024 * MB, 150 * MB);
        assertEquals(1025 * MB - 1024 * MB * 9 / 10, need);
    }

    @Test
    public void aFullDeviceGetsItsRoomBackButNeverMoreThanIsHeld() {
        assertEquals(50 * MB, PosterImageCache.toRemove(300 * MB, 100 * MB, 1024 * MB, 150 * MB));
        assertEquals(20 * MB, PosterImageCache.toRemove(20 * MB, 10 * MB, 1024 * MB, 150 * MB));
    }

    @Test
    public void sampleSize_powersOfTwoUntilEdgeFits() {
        assertEquals(1, PosterImageCache.sampleSize(200, 300, 480));
        assertEquals(2, PosterImageCache.sampleSize(960, 1440, 480));
        assertEquals(4, PosterImageCache.sampleSize(2000, 3000, 480));
        assertEquals(1, PosterImageCache.sampleSize(480, 720, 480));
    }

    @Test
    public void rejectsMediaPaths() {
        assertTrue(PosterImageCache.isMediaPath("/live/1/2/3.m3u8"));
        assertTrue(PosterImageCache.isMediaPath("/segment/123.ts"));
        assertTrue(PosterImageCache.isMediaPath("/movie/1.mp4"));
        assertTrue(PosterImageCache.isMediaPath("/vod/title.mkv"));
        assertFalse(PosterImageCache.isMediaPath("/t/p/w342/abc.jpg"));
    }

    @Test
    public void handlesTmdbAndWsrv() {
        assertTrue(PosterImageCache.shouldHandle(
                "https", "image.tmdb.org", "/t/p/original/abc.jpg",
                "GET", "image/webp,image/*,*/*;q=0.8"));
        assertTrue(PosterImageCache.shouldHandle(
                "https", "wsrv.nl", "/",
                "GET", "*/*"));
    }

    @Test
    public void rejectsStreamsEvenWithLooseAccept() {
        assertFalse(PosterImageCache.shouldHandle(
                "https", "cdn.example", "/live/index.m3u8",
                "GET", "*/*"));
        assertFalse(PosterImageCache.shouldHandle(
                "https", "cdn.example", "/seg/0001.ts",
                "GET", "image/*,*/*"));
    }

    @Test
    public void rejectsAppOrigins() {
        assertFalse(PosterImageCache.shouldHandle(
                "https", "localhost", "/assets/logo.png",
                "GET", "image/*"));
        /* Only the app's own origin is ours: any other host, however plausible
           it looks, is a picture's own host and is cached like one. */
        assertTrue(PosterImageCache.shouldHandle(
                "http", "img.example.com", "/a.png",
                "GET", "image/*"));
    }

    @Test
    public void rejectsNonGet() {
        assertFalse(PosterImageCache.shouldHandle(
                "https", "image.tmdb.org", "/t/p/w185/x.jpg",
                "POST", "image/*"));
    }

    @Test
    public void acceptsImgAcceptOnPiconPath() {
        assertTrue(PosterImageCache.shouldHandle(
                "http", "portal.example.com", "/stalker_portal/misc/logos/320/1.png",
                "GET",
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"));
    }
}
