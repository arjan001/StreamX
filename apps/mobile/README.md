# @iptv/mobile — the Android and iOS apps

A Capacitor shell around the web bundle. Android adds native plugins (libVLC player,
channel-logo store, live captions); iOS plays through the web layer only. Package /
bundle id: `com.streamx.app`. Android is documented first; see "iOS" below.

## Build

```sh
pnpm --filter @iptv/mobile build:android   # release bundle (.aab) + debug APK
pnpm --filter @iptv/mobile bundle          # release bundle only (for Google Play)
pnpm --filter @iptv/mobile apk             # debug APK only (for testing)
```

Each runs `build:web`, `cap sync android`, then `./gradlew --no-daemon ...` with the
JDK/SDK environment from `scripts/android-env.sh`. Outputs stay in Gradle's folder:

- `android/app/build/outputs/bundle/release/app-release.aab`
- `android/app/build/outputs/apk/debug/app-universal-debug.apk` (plus per-ABI APKs)

`STREAMIX_API_ORIGIN` (optional) sets the server origin baked into the web bundle.

The application id is written by `pnpm brand` (`scripts/brand-apply.mjs`, from
`brand.config.json`) into `app/build.gradle` and `capacitor.config.ts` between
`brand:` fences. Do not edit those lines by hand.

Targets: `compileSdk`/`targetSdk` 36, `minSdk` 23 (`android/variables.gradle`).

## Signing

No keys live in the repository. `app/build.gradle` reads a `keystore.properties`
file from `$STREAMIX_KEYSTORE_PROPS`, else `~/.streamix-signing/keystore.properties`:

```properties
storeFile=/absolute/path/to/upload-key.jks
storePassword=...
keyAlias=...
keyPassword=...
```

With no such file (or a `storeFile` that does not exist) the release build still
succeeds and is left unsigned, so a fresh checkout is never broken by a missing
secret. The debug APK is signed with the SDK debug key and installs next to a
release build (its id has a `.debug` suffix).

Use Play App Signing: create a NEW upload key for `com.streamx.app`, sign the
bundle with it, and let Google hold the app signing key. Do not reuse a key from
any earlier package.

## Play Console declarations

- **Foreground service** (`FOREGROUND_SERVICE_MEDIA_PROJECTION`, service type
  `mediaProjection`): used only while the viewer has switched live captions on.
  The service shows an ongoing notice, is not sticky, and is stopped when captions
  stop. Play asks for a description of the feature and a short video of it
  (switch captions on, the system capture consent, the notice, captions appearing).
- **Sensitive permission `RECORD_AUDIO`**: required by the platform for audio
  playback capture of the app's OWN sound; the microphone is never opened. It is
  requested only when captions are switched on.
- **Data safety**: provider credentials are stored on the device only
  (`allowBackup=false`); error reports go to the app's server.
- Cleartext HTTP is allowed on purpose: users add their own servers, many plain http.
- TV: declares `LEANBACK_LAUNCHER`, a 320x180 banner, and `touchscreen` /
  `leanback` as not required.

## iOS

`ios/` is the Capacitor 7 Xcode project (CocoaPods; `ios/App/App.xcworkspace`). It
cannot be built on this Linux box: Xcode and CocoaPods are macOS only. Everything
under "On a Mac" needs one (or a cloud Mac, see "Cloud build").

A **paid Apple Developer Program account** (US$99/year) is required to sign, put a
build on TestFlight and publish to the App Store; the free tier can only run on your
own device for seven days.

### What the project contains

- `Info.plist`: display name Streamix; `ITSAppUsesNonExemptEncryption=false` (the app
  only uses the system's HTTPS/TLS, so no export-compliance questionnaire per build);
  no camera, location, microphone or photo strings — iOS uses none of them.
  No `UIBackgroundModes`: the app does not play audio in the background and has no
  Picture in Picture or media-session code, and App Review rejects the entitlement
  when it is unused.
- **Orientation**: landscape only (the product rule). iPhone lists
  LandscapeLeft/Right. iPad does the same with `UIRequiresFullScreen=true`: Apple
  requires an iPad app to support all four orientations *unless* it opts out of
  multitasking with that key, so landscape-only on iPad is valid and accepted. Apple
  has marked `UIRequiresFullScreen` deprecated from iOS 26; it still works, and if a
  later review objects, the fallback is to list all four iPad orientations and let
  the web layout rotate.
- **App Transport Security**: `NSAllowsArbitraryLoads`, plus
  `NSAllowsArbitraryLoadsInWebContent` and `NSAllowsArbitraryLoadsForMedia`. Users add
  their own servers and many are plain `http://`. The last two lift ATS for what the
  WKWebView loads (fetch/XHR to the panel, images, the `<video>` element's HLS
  segments) and for AVFoundation media loads. Neither covers a request made by native
  code (`URLSession`), and Stalker portals are reached exactly that way:
  `CapacitorHttp.request` (`lib/providers/stalker.ts`), because a browser cannot send
  the `Cookie` and `User-Agent` a portal requires. So `NSAllowsArbitraryLoads` is on
  as well, for plain-http portals. Review justification, to paste into App Store
  Connect if asked: *"Streamix is a media player. The user types in the address of
  their own streaming server, playlist or portal; many home and provider servers only
  offer plain HTTP and cannot be given HTTPS certificates, and the app has to contact
  them where they are. The app ships no servers of its own, and everything it contacts
  that it controls uses HTTPS."*
- **Icon and launch screen**, from `brand/logo.png` and `brand.config.json`:
  `node apps/mobile/scripts/brand-assets-ios.mjs` (opaque 1024 px icon, because App
  Store Connect rejects icons with an alpha channel; plain brand-colour launch
  screen with the logo).
- **Version**: `node apps/mobile/scripts/ios-stamp.mjs` copies `version.json`
  (`version` → MARKETING_VERSION, `build` → CURRENT_PROJECT_VERSION) into the Xcode
  project. App Store Connect needs the build number to rise on every upload.
- **Not committed**: `Pods/`, `App/App/public` (the web bundle), `capacitor.config.json`,
  `DerivedData`, `.xcarchive`, `.ipa`, certificates and profiles (see `.gitignore`).

### How the player works on iOS

There is no libVLC and no `Streamix*` native plugin on iOS (those are Android Java);
every call to them is guarded by `lib/platform.ts` and returns "not available".

- **Live**: the app always asks an Xtream panel for `.m3u8` and plays it with the
  element's built-in HLS (no hls.js). An account that only offers `.ts` cannot be
  played — WKWebView has no MediaSource on iPhone before iOS 17.1 and only
  `ManagedMediaSource` after — and the player says so in plain words.
- **Films**: MP4, M4V, MOV natively. MKV, AVI and similar are refused with "This file
  format cannot be played on iPhone or iPad". The device-side remuxer (libav.js)
  is deliberately not shipped in packaged builds, and `MediaSource` is missing on
  iPhone anyway.
- **Live captions are hidden on iOS**: they transcribe the `<video>` element's audio
  through `captureStream()`, which WebKit does not have.

### On a Mac

```sh
pnpm install --frozen-lockfile
cd apps/mobile
pnpm run build:web          # the web bundle for the app (dist-app)
npx cap sync ios            # copies it, updates the Podfile, runs `pod install`
node scripts/ios-stamp.mjs  # version from version.json
open ios/App/App.xcworkspace
```

`pod install` needs CocoaPods (`brew install cocoapods`). In Xcode choose the **App**
target, Signing & Capabilities: your team, bundle id `com.streamx.app`
(automatic signing is fine), then Product > Archive > Distribute App > App Store
Connect. The first upload needs the app record created in App Store Connect.

### Cloud build (no Mac of your own)

- `codemagic.yaml` (preferred): in Codemagic add an App Store Connect API key as the
  integration `streamix_app_store_connect`; it creates the certificate and profile and
  publishes to TestFlight. Start the `ios-app-store` workflow.
- `.github/workflows/ios.yml`: GitHub Actions macOS runner, signs with a distribution
  certificate and profile kept in repository secrets (listed at the top of the file).
  Run it from the Actions tab; tick *upload* to send the build to TestFlight.

Secrets (App Store Connect API key, `.p12`, profile, team id) live only in the
service's secret store, never in the repository.
