# Google Play

Copy-ready answers for Play Console. Placeholders in `<angle brackets>` come from the
publisher block in `brand.config.json` or from your deployed server. Where an answer
depends on Google's current form wording, re-read the linked page: Play changes these forms.

Package name: `com.easyred.streamix`. Free. No ads. No in-app purchases. No accounts.

Policy pages this kit was written against (all opened and checked 2026-10-01):

- Intellectual property: https://support.google.com/googleplay/android-developer/answer/9888072
- Metadata: https://support.google.com/googleplay/android-developer/answer/9898842
- Device and network abuse (no self-update): https://support.google.com/googleplay/android-developer/answer/9888379
- Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469
- Target API level: https://support.google.com/googleplay/android-developer/answer/11926878
- Foreground service declarations: https://support.google.com/googleplay/android-developer/answer/13392821
- Prepare your app for review (app access): https://support.google.com/googleplay/android-developer/answer/9859455
- TV app quality: https://developer.android.com/docs/quality-guidelines/tv-app-quality

Account deletion (https://support.google.com/googleplay/android-developer/answer/13327111) does
not apply: the app has no accounts. In the Data safety form, "Account creation: not
supported" is the true answer.

## 1. Store listing

| Field | Limit | Text |
|---|---|---|
| App name | 30 | `Streamix Player` |
| Short description | 80 | `A player for your own IPTV sources. It contains no channels.` |
| Category | | Video Players & Editors |
| Tags | pick from Play's list | Video player (and the nearest "media player" tags Play offers) |
| Contact email | | `<publisher email>` |
| Website | | `<site>` (the deployed server's home page) |
| Privacy policy URL | | `<site>/privacy` |

Metadata policy reminders: no emoji spam, no repeated keywords, no "free TV / free channels /
Netflix / sports" claims, no other company's name, no unverified superlatives ("best",
"#1"), no reviews or ratings text in the description.

### Full description (max 4000 characters)

```
Streamix is a media player for television, movies and series from sources you add yourself.

IMPORTANT: Streamix contains no channels, films, series or playlists. It does not provide, host or sell any content. To use it you add a source from a provider you already use, and the app plays what that source gives you. Only add sources you have the right to use. What you can watch depends on your provider and the laws of your country.

ADD YOUR OWN SOURCE
- Xtream-style server: server address, username and password from your provider
- M3U / M3U8 playlist link, with an optional XMLTV guide link
- A single stream link
- Stalker / MAC portal, where your provider uses one (Android phones, tablets and TV only)
Save several sources and switch between them.

WHAT YOU GET
- Live TV, movies and series from your source, in one fast, searchable library
- A TV guide (EPG) with now-and-next and a full timeline, when your source provides one
- Catch-up and replay where your provider offers it
- Favourites, recently watched and continue watching
- Picks the right video engine for each stream, including audio formats many players cannot play
- Optional live captions that turn the sound of what is playing into subtitles (you choose when to turn them on; not available on iPhone and iPad)
- Built for the remote: full D-pad control on Android TV and TV boxes, and comfortable touch controls on phones and tablets

YOUR DATA STAYS WITH YOU
- No account, no ads, no analytics, no tracking
- Your sources, settings and favourites are stored on your device only
- Optional error reports are off by default and contain no login details
- The app is free, with no in-app purchases

CONTENT FROM YOUR SOURCES
ADULT CONTENT
Streamix always hides adult categories and titles from lists, search and the guide. There is no setting to show them.

Streamix is not affiliated with any content provider, broadcaster or channel. Names and logos that appear through your own source belong to their owners.

Copyright concerns about the app itself: <publisher email>.
```

The block above is about 1,950 characters, well inside the limit.

### Graphics

Icon 512x512 PNG, feature graphic 1024x500, phone screenshots (min 2, max 8), 7-inch and
10-inch tablet screenshots, and Android TV screenshots plus the 320x180 TV banner. Content
rules and sizes: [screenshots.md](screenshots.md).

## 2. App content

### Ads
**No, the app does not contain ads.**

### App access
Select **"All or some functionality is restricted"** because the app shows nothing until a
source is added. Provide these instructions (replace `<site>`):

```
No login or account is needed. The app has no built-in channels, so a reviewer must add a source.
A demo source is provided: a playlist of Creative Commons (Blender Foundation) films.

1. Open the app and accept the first-run notice (tick the box, tap Continue).
2. Tap "Add a source" and choose "Playlist link (M3U/M3U8)".
3. Enter this playlist link:  <site>/demo/playlist.m3u
4. Tap "Add playlist". The demo channels appear under Live TV; tap one to play.

To test live captions: during playback open the subtitles menu in the player and turn on Live captions.
Android shows a screen-capture consent; accept it. This captures only the app's own sound.
```

Before you submit: the demo route must be switched on in the server (see `docs/SERVER.md`),
the playlist URL must open in a browser, and every film in it must still play. Keep it on for
as long as the app is in review and is likely to be re-reviewed.

### Content rating (IARC questionnaire)
Answer honestly. The app is a player for content the user brings, so Play's questions about
violence, sex, language and drugs have a true answer of **"No" for what the app itself
contains**, but the app can display unrestricted third-party content.

| Question area | Answer | Why |
|---|---|---|
| Category | The one that fits a media player (Entertainment, or Utility if that is what Play offers) | Not a game, not social |
| Violence, sexual content, profanity, controlled substances, gambling | No (for content the app contains) | The app ships no content |
| Does the app let users interact or share content with each other? | No | No accounts, no sharing |
| Does the app share the user's location with others? | No | Location was removed |
| Does the app provide unrestricted access to the internet or user-supplied content? | **Yes**, if the form asks about user-provided or unrestricted content | A user can add any source |
| Digital purchases, in-app purchases | No | |

Expect a high rating (for example Mature 17+ / PEGI 18 / USK 18 in some regions) once the
unrestricted-content answer is given. That is the honest outcome; do not answer "No" to get a
lower rating. The permanent adult filter lowers the risk but does not guarantee zero adult
items, so do not claim "no adult content": the listing says adult categories are hidden.
Reviewer notes use only the Creative Commons demo playlist.

### Target audience and content
**18 and over.** The app is not for children; do not select any age band under 18. Answer
"No" to "Is your app appealing to children". This matches the Privacy text ("not directed
at children under 13") and avoids the Families policy.

### Government, financial, health, news apps
None of them apply. Answer No to all.

### Data safety

Re-open https://support.google.com/googleplay/android-developer/answer/10787469 and check
each data type against the form in front of you. The answers below match the Privacy
Policy (drafted from the same facts) and must stay in sync with it.

**Top-level questions**

| Question | Answer |
|---|---|
| Does the app collect or share any required user data types? | Yes, only the optional items below |
| Is all collected data encrypted in transit? | Yes (HTTPS to the publisher's server and to the captions provider) |
| Do you provide a way for users to request data deletion? | Yes: email `<publisher email>`; error reports are also deleted automatically after 7 days |
| Account creation | Not supported (no accounts) |

**Default configuration (error reports off, captions optional)**

| Data type | Collected | Shared | Optional | Purpose |
|---|---|---|---|---|
| Audio: Voice or sound recordings | Yes, only while the user switches live captions on (the sound of what is playing is streamed to the speech-recognition provider; the publisher stores nothing) | No: the provider acts as a service provider processing on the publisher's behalf with the publisher's own key, which Google lists as not "sharing" | Yes, optional | App functionality |
| Everything else (name, email, user IDs, contacts, location, photos, files, messages, purchase history, health, financial, web history, calendar) | No | No | | |
| Device or other IDs | No: the per-launch random number is not persistent and is not an advertising or device ID | | | |
| App activity (what the user watches, search history, in-app history) | No: stays on the device | | | |

Notes on judgement calls, so you can defend them to Play:

- **Sources, credentials, favourites, history, downloaded catalogues**: kept only on the
  device. Data that never leaves the device is not "collected" under the form. The
  credentials are sent to the provider the user chose, which is the user's own action and
  is not the publisher collecting anything.
- **Remote config request** (version, build, and the connection's IP address): the server
  sees the IP address in order to answer; it stores it only shortened to its network. Google's
  form says approximate location *inferred* from an IP must be disclosed. The server does not
  derive any location, so the answer above is "not collected". If you ever add geo-IP
  lookups, or prefer to be cautious, declare "Approximate location", Optional: No, purpose App
  functionality, and tell the lawyer.
- **Captions audio** is the one data type that leaves the device with the publisher's
  involvement. If the speech provider's terms let it keep audio, you cannot claim the
  service-provider exemption for retention: re-read the provider's current data terms
  before submitting, and if in doubt answer Shared: Yes.
- **Captions access key**: the app asks the server for a temporary key. No user data goes
  with the request beyond the connection itself.

**If error reports are turned on by default or by a server setting**

Error reports are off unless the user switches them on. If you ever enable them for everyone,
the form must also declare:

| Data type | Collected | Shared | Optional | Purpose |
|---|---|---|---|---|
| App info and performance: Crash logs | Yes | No | Yes if the user can turn it off, otherwise No | App functionality |
| App info and performance: Diagnostics | Yes | No | same | App functionality |
| Device or other IDs | No (random per-launch number only) | | | |

Reports contain: app version, device model, system version, the random launch number and a
short problem description with usernames and passwords stripped from addresses. They are
retained 7 days. State that in the Privacy Policy before you change the default.

Declare the form answers per release: the answers apply to the latest production release.

### Permissions declarations

The app declares: `INTERNET`, `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`. The last four exist only for
live captions.

**Foreground service (`mediaProjection`) declaration.** Play Console > App content >
Foreground service permissions. Choose type **Media projection** and the use case **"Media or content projection and streaming or recording with MediaProjection API"**, then paste:

```
Streamix is a video player. The optional "Live captions" feature turns the sound of the video currently playing inside Streamix into subtitles. Android only allows an app to capture its own audio output through the MediaProjection / AudioPlaybackCapture APIs, which require a foreground service of type mediaProjection. The service is started only when the user switches Live captions on and accepts the system screen-capture consent. It shows a persistent notification, captures only audio played by Streamix itself (capture is restricted to the app's own UID, so no other app's sound and no microphone are captured), and is stopped as soon as the user turns captions off or leaves playback. It does not record or store audio and does not capture the screen. Without the service the feature cannot work, so it cannot be replaced by a shorter-running API.

User impact if the system defers the service: captions do not start, and the video keeps playing normally. If the system interrupts it: captions stop, the notification disappears, and the user can turn captions on again; playback is unaffected.
```

**Demo video for the declaration** (Play asks for a link to a video of each foreground service feature, showing the steps a user takes to trigger it; upload to YouTube as unlisted and
paste the link). It must show, in one continuous take, with the device language in English:

1. The app playing a Creative Commons demo film.
2. The player's subtitles menu, Live captions: the first-time explanation dialog, then turning captions on.
3. Android's system capture consent dialog, accepted.
4. The ongoing notification in the shade while captions run.
5. Captions appearing over the video.
6. Turning captions off and the notification disappearing.

**`RECORD_AUDIO` (sensitive permission) justification:**

```
RECORD_AUDIO is required by Android for the AudioPlaybackCapture API that lets Streamix capture its OWN audio output for the optional Live captions feature. The microphone is never opened and no other app's sound is captured. The permission is requested only when the user turns Live captions on.
```

**`POST_NOTIFICATIONS`**: requested at the same moment, so the foreground service's
notice is visible on Android 13+. If the user declines, the feature does not start.

Also confirm in the console that the manifest has no `MANAGE_EXTERNAL_STORAGE`, install-packages,
location or SMS permissions (none are declared).

### No self-update
The Device and Network Abuse policy forbids apps that modify or update themselves outside
Play. Streamix has no downloader or installer: updates come from Play only. The server's
remote config can only show a notice and send old versions to the store.

## 3. Release setup

| Item | Value |
|---|---|
| Format | Android App Bundle (`.aab`). Build: `pnpm --filter @iptv/mobile bundle` |
| Output | `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab` |
| Target / compile SDK | 36 (Play requires a recent API level for new apps; confirm the current number at the Target API page above) |
| minSdk | 23 |
| Native libraries | 64-bit, 16 KB page-size compliant (libVLC 3.6.5) |
| Signing | Play App Signing. Create a NEW upload key for `com.easyred.streamix`; do not reuse a key from any earlier app |
| Version | version name from `version.json`, version code from the build number. The code must increase on every upload |
| Cleartext traffic | Allowed on purpose: users' servers are often plain http. If a reviewer asks, say so |
| Backup | `allowBackup=false` |

Signing set-up (no keys are stored in the repository):

```properties
# ~/.streamix-signing/keystore.properties   (or point STREAMIX_KEYSTORE_PROPS at it)
storeFile=/absolute/path/to/upload-key.jks
storePassword=...
keyAlias=...
keyPassword=...
```

With no such file the release bundle is built unsigned. Back up the upload key and its
passwords somewhere other than the build machine. If it is lost, Google can reset an upload
key, but only through support.

## 4. Android TV submission notes

- The manifest declares the leanback launcher category, a 320x180 banner and
  `touchscreen`/`leanback` as not required. In Play Console, tick **Android TV** under
  Advanced settings > Form factors, and upload TV screenshots and the banner.
- Run through https://developer.android.com/docs/quality-guidelines/tv-app-quality: every
  screen reachable with D-pad only, Back always reaches the launcher, focus is always visible,
  text readable at 10 feet, no landscape/portrait lock problems (the app is landscape only).
- Test on a real Android TV or Google TV device (or the Google TV emulator) and on a
  non-touch box with a basic remote.
- Mention in the "TV" review notes the demo playlist, since a TV reviewer has the same
  empty-app problem.

## 5. Pre-launch checklist (Play-specific)

- [ ] Developer account created and identity verified. **New personal accounts** (created
  after 13 November 2023) must run a closed test with at least 12 testers opted in for 14
  continuous days before applying for production access:
  https://support.google.com/googleplay/android-developer/answer/14151465
- [ ] **Organisation account**: needs a D-U-N-S number (free, can take weeks to be issued):
  https://support.google.com/googleplay/android-developer/answer/13634885 . Decide the account
  type before you start; an organisation account avoids the 12-tester rule.
- [ ] Play App Signing enrolled, new upload key created and backed up.
- [ ] `.aab` built from a clean checkout with the release version and uploaded to internal
  testing first.
- [ ] Privacy policy URL live, HTTPS, and matches the Data safety answers.
- [ ] Listing text reviewed against section 1; no trademarks, no "free TV".
- [ ] Content rating questionnaire done honestly; target audience 18+.
- [ ] Data safety form submitted; foreground service declaration and demo video submitted;
  `RECORD_AUDIO` declaration submitted.
- [ ] App access instructions entered, demo playlist reachable.
- [ ] Android TV form factor and banner added.
- [ ] A named person watches the contact mailbox and the Play Console inbox (see
  [takedown-process.md](takedown-process.md)).
