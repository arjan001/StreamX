# Apple App Store

Copy-ready answers for App Store Connect. Placeholders in `<angle brackets>` come from the
publisher block in `brand.config.json` or from your deployed server.

Bundle ID: `com.streamx.app`. Free. No ads. No in-app purchases. No accounts.

Needs a paid Apple Developer Program account (individual or organisation; an organisation
also needs a D-U-N-S number). The iOS app is built from the Capacitor project on a Mac: a
local Mac, or a cloud Mac such as Codemagic or GitHub Actions macOS runners. It cannot be
built on Linux.

Rules this kit was written against (opened and checked 2026-10-01):

- App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/ :
  2.1 (demo info), 2.3.1/2.3.3/2.3.7 (metadata, screenshots, keywords), 2.5.2 (no downloaded
  code), 3.1.1 (in-app purchase), 4.2 and 4.2.2 (minimum functionality, content aggregators),
  4.3(b) (indistinguishable apps), 5.1.1(i) (privacy policy), 5.2.1/5.2.2/5.2.3 (intellectual
  property, third-party services, downloading).
- Updated age ratings: https://developer.apple.com/news/?id=ks775ehf

## 1. App information

| Field | Limit | Text |
|---|---|---|
| Name | 30 | `Streamix Player` |
| Subtitle | 30 | `Play your own IPTV sources` |
| Primary category | | Entertainment (Photo & Video is also reasonable) |
| Keywords | 100, comma-separated, no spaces after commas | `iptv,m3u,xtream,playlist,player,stream,epg,live tv,tv guide,hls,video player,media player` |
| Support URL | | `<site>` |
| Marketing URL | optional | `<site>` |
| Privacy policy URL | required | `<site>/privacy` |
| Copyright | | `<year> <publisher name>` |

Keyword rules (2.3.7): no other company's or app's name, no trademarks, no prices, no "free",
no terms for content you do not provide (no sport names, no channel names, no "netflix").

### Promotional text (170, can change without a new review)

```
A player for the sources you add yourself. Xtream, M3U playlists, single streams and portals, with a TV guide. No channels included.
```

### Description (4000)

```
Streamix is a media player for television, movies and series from sources you add yourself.

IMPORTANT: Streamix contains no channels, films, series or playlists. It does not provide, host or sell any content. You add a source from a provider you already use, and the app plays what that source gives you. Only add sources you have the right to use. What you can watch depends on your provider and the laws of your country.

ADD YOUR OWN SOURCE
- Xtream-style server: server address, username and password from your provider
- M3U / M3U8 playlist link, with an optional XMLTV guide link
- A single stream link
- Stalker / MAC portal, where your provider uses one
Save several sources and switch between them.

WHAT YOU GET
- Live TV, movies and series from your source in one fast, searchable library
- A TV guide with now-and-next and a full timeline, when your source provides one
- Catch-up and replay where your provider offers it
- Favourites, recently watched and continue watching
- Designed for iPhone and iPad. Plays MP4, M4V, MOV and HLS; MKV and AVI files cannot be opened on iPhone or iPad

YOUR DATA STAYS WITH YOU
- No account, no ads, no analytics, no tracking
- Your sources, settings and favourites are stored on your device only
- Optional error reports are off by default and contain no login details
- Free, with no in-app purchases

CONTENT FROM YOUR SOURCES
ADULT CONTENT
Streamix always hides adult categories and titles from lists, search and the guide. There is no setting to show them.

Streamix is not affiliated with any content provider, broadcaster or channel. Names and logos that appear through your own source belong to their owners.
```

### What's New (first release)

```
First release.
```

## 2. App Privacy ("nutrition label")

Match the Privacy Policy. Apple's definition of "collect" is data sent off the device in a
way that lets you or your partners keep it longer than needed to answer the request.

**Default configuration (error reports off):**

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **No: "Data Not Collected"** |
| Tracking (linking data with other companies' data, or sharing with data brokers) | No |

Why: live captions are hidden on iOS (WebKit cannot hand the playing audio to the speech
service), so no audio ever leaves an iPhone or iPad. The remote-config request (version,
build, IP) is processed only to answer it, and the server keeps an address only as its
network. If captions are ever enabled on iOS, the label becomes **Yes, Audio Data** (not
linked, no tracking, App Functionality) and the review notes below need the captions
paragraph back; keep this consistent with Privacy Policy section 3.

Sources, credentials, favourites, history and downloaded catalogues stay on the device and are
not "collected". Data sent directly to the user's own provider is the user's own connection.

**If error reports are switched on by default (or you decide to ask users to turn them on):**
add

| Data type | Linked to user | Tracking | Purpose |
|---|---|---|---|
| Diagnostics: Crash Data / Performance Data / Other Diagnostic Data | No | No | App Functionality |

Reports hold the app version, device model, system version, a random launch number and a
redacted problem description, kept 7 days.

Guideline 5.1.1(i): the privacy policy must be linked in App Store Connect and reachable
inside the app (Settings > About & legal).

## 3. Age rating

Apple's updated system (13+, 16+, 18+ added; new questions on in-app controls, capabilities,
medical topics and violent themes) assigns the rating from your answers, and lets you set a
higher minimum age than Apple calculates. Answer honestly:

| Topic | Answer |
|---|---|
| Violence, sexual content, nudity, profanity, drugs, gambling, horror: content the app contains | None |
| Capabilities: user-generated content, messaging, unrestricted web or content access | Answer **Yes** wherever the question covers the user being able to open arbitrary third-party content (the user adds any source) |
| In-app controls (parental controls, age assurance) | The app has none; the permanent adult filter is not a parental control |
| Medical or wellness topics | None |

User-supplied sources may contain mature content, so answer the questionnaire accordingly
(the unrestricted web or content access style answers). Apple will likely calculate 18+ or
close to it. Accept it, or set the minimum age to **18+** yourself, which is consistent with the Google Play
target audience (18+). Do not answer "None" to obtain 4+.

## 4. App Review information

**Sign-in required:** No. The app has no accounts.

**Demo source:** the app is empty until a source is added, so give reviewers one (Guideline 2.1).

### Notes for review (paste, then fill in `<site>`)

```
Streamix is a neutral media player. It contains no channels, films, series or playlists and has no built-in servers. The user adds their own source (an Xtream-style server, an M3U playlist link, a single stream link, or a portal). Nothing is hosted, sold, downloaded or unlocked by us. There are no accounts, no in-app purchases and no ads.

TO TEST (no login):
1. Launch the app, tick the box on the first notice and tap Continue.
2. Tap "Add a source", choose "Playlist link (M3U/M3U8)" and enter:
   <site>/demo/playlist.m3u
3. Tap "Add playlist". A few Creative Commons (Blender Foundation) films appear under Live TV; tap one to play it.

The demo playlist is operated by us and contains only Creative Commons licensed films.

Rights: on first run the user must confirm they have the right to use the sources they add and accept our Terms. We do not provide, recommend or link to any provider.

Adult content: the app permanently filters adult categories and titles from every list, search and guide; there is no setting to show them. It ships no content. For review use only the Creative Commons demo playlist.

Data: sources and credentials are stored on the device only. Optional error reports are off by default. Live captions are not offered on iOS.

Network: many users' own servers only support plain http, so the app has an App Transport Security exception (NSAllowsArbitraryLoads); see below.

Contact for questions or rights notices: <publisher email>
```

### Reply for a 5.2.3 / "unauthorized access to third-party streaming" rejection

Apple may ask whether the app provides "potentially unauthorized access to third-party
streaming services". 5.2.3 is about saving, converting or downloading media from third-party
sources and about facilitating illegal file sharing; the app does none of that. Reply in
Resolution Center, and offer a call if it is not accepted:

```
Hello,

Thank you for the review. Streamix is a general-purpose media player, like a browser or a file player. It does not include, host, link to, recommend or sell any content, and it does not connect to any third-party service by default. There are no channels, playlists or servers inside the app.

Guideline 5.2.3: the app has no feature to save, download, record, convert or share media. It only plays a stream the user chooses, and it does not facilitate file sharing.

Guideline 5.2.2: the app does not access any particular third-party service. A user may add a source address from a provider with whom they have their own arrangement; the first-run screen requires them to confirm they have the right to use the sources they add and to accept our Terms, which say the same. Content availability is entirely the user's and their provider's responsibility.

To review the app without any third-party source we provide a demo playlist of Creative Commons licensed films (Blender Foundation open movies) that we host ourselves: <site>/demo/playlist.m3u. Steps are in the Review Notes.

We also provide a copyright contact (<publisher email>) and act promptly on any rights-holder notice about the app or its listing. We are happy to adjust the metadata if any wording is a concern.

Regards,
<publisher name>
```

Do not say "free TV", "all channels" or "premium" anywhere in the listing, notes or reply:
that is what produces these rejections.

## 5. Export compliance

The app uses only the encryption built into iOS (HTTPS/TLS for network traffic). Set
`ITSAppUsesNonExemptEncryption` to `NO` in `Info.plist` so App Store Connect does not ask on
every build. In the export compliance questions: "Does your app use encryption? Yes
(standard HTTPS only)" and "exempt: Yes". Verify the key is present in the generated
`Info.plist` before every upload. If you ever add your own cryptography (for example a
custom stream decryption), re-answer this.

## 6. App Transport Security (ATS) justification

The app sets `NSAllowsArbitraryLoads` because the servers users add are their own and many of
them speak plain http only; the address is not known at build time, streams redirect between
hosts and bare IP addresses, and a per-domain exception is impossible. If App Review asks:

```
Streamix plays media from servers chosen by the user, and many such servers only support plain http. Their addresses are entered by the user at run time and cannot be listed in advance, so a per-domain exception is not possible. Our own server and every service we operate use HTTPS only. The exception is used only for media and listing requests to the source the user entered.
```

The app does not show a notice for unencrypted sources, so the justification must not
claim one.

## 7. iPad

- Submit iPad screenshots (the app runs on iPad; 2.4.1 expects iPhone apps to work there).
- The app is designed for landscape. If you restrict the iPad to landscape only, Apple
  requires opting out of iPad multitasking (`UIRequiresFullScreen`) and the supported
  orientation lists in `Info.plist` must be consistent for iPhone and iPad. Check the
  generated `Info.plist` and test split-view/slide-over behaviour on a real iPad or simulator
  before submission.

## 8. Screenshots

Rules (2.3.3): show the app in use, not just a splash screen or login page. Content rules:
[screenshots.md](screenshots.md): only the Creative Commons demo films and the app's own UI.
Sizes change with device generations; confirm in App Store Connect which are required. At the
time of writing a 6.9-inch iPhone set and a 13-inch iPad set are required, and smaller
sizes scale from them. In landscape these are 2868x1320 (iPhone) and 2752x2064 (iPad).
Up to 10 screenshots per size; an app preview video is optional.

## 9. Pre-submission checklist (Apple-specific)

- [ ] Paid developer account active; app record created with bundle ID `com.streamx.app`.
- [ ] Built and uploaded from a Mac (cloud or local); processed build selected.
- [ ] Tested on a real iPhone and a real iPad, including a plain-http source and the demo
  playlist; test the web layer in WebKit too.
- [ ] `Info.plist`: ATS exception present, `ITSAppUsesNonExemptEncryption` = NO, usage
  descriptions only for permissions actually used.
- [ ] No code is downloaded and executed (2.5.2): the web bundle ships inside the app.
- [ ] Privacy policy URL live and linked in-app; nutrition label matches section 2.
- [ ] Age rating questionnaire answered, 18+ minimum set if you choose.
- [ ] Review notes and demo playlist in place; demo server up for the whole review.
- [ ] Listing text and screenshots checked against screenshots.md.
- [ ] 4.3(b) and 4.2: be ready to explain what Streamix does that a browser cannot (guide,
  catch-up, library, remote-friendly playback).
