import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android and iOS wrapper around the same web bundle the site serves.
 *
 * `webDir` deliberately points at `dist-app`, not `dist`: the Fastify process
 * serves `dist` directly, and the wrapper build differs from it in two ways that
 * would break the website — relative asset paths and the hash router.
 */
const config: CapacitorConfig = {
  /* Written by scripts/brand-apply.mjs from brand.config.json, together with
     `applicationId` in android/app/build.gradle, so the two cannot disagree. */
  // brand:appId:start
  appId: 'com.easyred.streamix',
  // brand:appId:end
  appName: 'Streamix',
  webDir: '../web/dist-app',

  android: {
    /**
     * The servers people add are their own and many are plaintext-only. Native
     * HTTP has no mixed-content policy, so direct playback and `http://` logos
     * work — but Android still needs cleartext permitted, and it has to be
     * app-wide rather than domain-scoped because users choose the hosts and
     * streams may 302 to a bare IP that changes.
     */
    allowMixedContent: true,

    /**
     * The brand ground behind the page, matching `res/values/brand.xml`.
     *
     * Unset, the WebView keeps AppCompat's DayNight window background, which on
     * this app is a light flash between the launch theme being dropped and the
     * page's first paint. It costs nothing and it is the first thing anyone sees.
     */
    backgroundColor: '#0b1013',
  },

  ios: {
    /** The brand ground behind the page, so there is no white flash before first paint. */
    backgroundColor: '#0b1013',
    /* The page lays itself out under the notch and home indicator with
       `viewport-fit=cover` and `env(safe-area-inset-*)`; a native inset on top of
       that would count the margin twice. */
    contentInset: 'never',
    allowsLinkPreview: false,
  },

  server: {
    /**
     * `https` scheme for the app's own origin, which is what makes the WebView a
     * secure context — `crypto.subtle`, `AudioWorklet` and persistent storage all
     * require one, and the standalone catalogue depends on the first of those.
     * Android only: iOS serves the app from `capacitor://localhost`, which WebKit
     * already treats as secure.
     */
    androidScheme: 'https',

    /**
     * Live reload against the Vite dev server, when asked for.
     *
     * Set `STREAMIX_DEV_SERVER` before `cap sync` and the WebView loads the dev
     * server instead of the bundle baked into the APK — edit a .tsx, see it on
     * the television. Unset, this is `undefined` and the build is exactly the
     * shipping one, which is why it is safe to leave here.
     *
     * The value must be `http://localhost:PORT`, NOT the host's LAN address or
     * the emulator's 10.0.2.2 alias, and the port must be bridged with
     *     adb reverse tcp:PORT tcp:PORT
     * Reason: a WebView loading `http://10.0.2.2:5183` is an INSECURE origin, so
     * `crypto.subtle` is undefined there — and the standalone catalogue needs it,
     * so the app would come up broken in a way that has nothing to do with the
     * code being debugged. `http://localhost` is trusted by Chromium regardless
     * of scheme, and `adb reverse` is what makes the device's localhost be this
     * machine's.
     */
    ...(process.env.STREAMIX_DEV_SERVER
      ? { url: process.env.STREAMIX_DEV_SERVER, cleartext: true }
      : {}),
  },

  plugins: {
    /**
     * Deliberately NOT `CapacitorHttp.enabled: true`: that patches `fetch` to go
     * through native code, which buffers whole responses — it would destroy the
     * byte-level download progress the catalogue ingest reports, and reinstate
     * the memory profile the columnar design exists to avoid.
     */
    CapacitorHttp: { enabled: false },
  },

  /*
   * No `overrideUserAgent`: the WebView identifies as the browser it is. A fake
   * VLC string made CDN fronts (Cloudflare, Akamai) hand it challenge pages.
   * libVLC still sends its own VLC string for the streams it plays
   * (`nativeBridge.ts`), which is honest, because it is VLC.
   */
};

export default config;
