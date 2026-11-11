# Streamix - IPTV Player

A neutral IPTV player for live TV, movies, and series from user-provided sources.

## Latest Release

### Version 1.64.1

**Release Date:** 2024
**Build Code:** 203

### Downloads

<div style="background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
  <a href="https://github.com/arjan001/StreamX/actions/workflows/build-android-apk.yml" style="display: inline-block; background: #f09018; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 18px;">
    📥 Download Latest APK from GitHub Actions
  </a>
  <p style="color: #888; margin-top: 10px; font-size: 14px;">
    Click the link above, then go to the latest workflow run and download the APK from the Artifacts section.
  </p>
</div>

| Platform | Download | Size |
|----------|----------|------|
| Android (arm64-v8a) | [Get from Actions](https://github.com/arjan001/StreamX/actions/workflows/build-android-apk.yml) | ~51 MB |
| Android (armeabi-v7a) | [Get from Actions](https://github.com/arjan001/StreamX/actions/workflows/build-android-apk.yml) | ~46 MB |
| Android (Universal) | [Get from Actions](https://github.com/arjan001/StreamX/actions/workflows/build-android-apk.yml) | ~91 MB |

### New Features

- ✅ Adult content section with bunny icon (top right)
- ✅ Tags rail with content counts
- ✅ Cast rail with avatars and initials fallback
- ✅ Sex filter (straight, gay, bisexual, lesbian, transgender)
- ✅ Purple/pink hover effects on adult cards
- ✅ 15 sports categories (Football, Basketball, Tennis, F1, etc.)
- ✅ EPG integration with Now/Next display
- ✅ On-device catalogue with search and filtering

### Supported Sources

- Xtream-style servers (address, username, password)
- M3U/M3U8 playlists with optional XMLTV guide
- Single stream links
- Stalker/MAC portals (Android and iOS)

## Features

### Core
- **No built-in content** - Users add their own sources
- **On-device catalogue** - Downloaded and indexed locally
- **Multiple source types** - Xtream, M3U, Stalker, single streams
- **Encrypted credentials** - Stored securely on-device
- **Cross-platform** - Android, iOS, Samsung Tizen, LG webOS

### Sports
- 15 sports categories with dedicated icons
- Sports rail with channel counts
- EPG integration for live events
- "Now" sorting for live matches

### Adult Content
- Dedicated adult section accessible via bunny icon
- Tags and cast filtering
- Sex/orientation filters
- VOD-focused with movie/series grid

### Player
- libVLC native playback (Android)
- HLS.js and mpegts.js (web)
- Live captions via Soniox
- Catch-up TV support
- Multi-quality streaming

## Installation

### Android
1. Download the APK for your device architecture
2. Enable "Install from unknown sources" in settings
3. Open the APK file to install

### iOS
Coming soon - TestFlight required

### Samsung Tizen
Download from Samsung Apps (sideload via USB)

### LG webOS
Download from LG Content Store (sideload via USB)

## Documentation

- [Playlist Formats](./internal-docs/01-playlist-formats.md)
- [Xtream API](./internal-docs/02-xtream-api.md)
- [Catch-up & EPG](./internal-docs/03-catchup-epg.md)
- [Stalker Portals](./internal-docs/04-stalker-portals.md)
- [Platform Engines](./internal-docs/05-platform-engines.md)
- [Architecture](./internal-docs/06-architecture.md)

## Build Status

| Workflow | Status |
|----------|--------|
| Unit Tests | ![Tests](https://github.com/arjan001/StreamX/workflows/Build%20Android%20APK/badge.svg) |
| Type Check | ![TypeCheck](https://github.com/arjan001/StreamX/workflows/Build%20Android%20APK/badge.svg) |
| Debug APK | ![Debug](https://github.com/arjan001/StreamX/workflows/Build%20Android%20APK/badge.svg) |
| Release APK | ![Release](https://github.com/arjan001/StreamX/workflows/Build%20Android%20APK/badge.svg) |

## Development

### Prerequisites
- Node.js >= 22
- pnpm 9
- JDK 17 (for Android builds)

### Setup
```bash
cd source
pnpm install --frozen-lockfile
```

### Development
```bash
pnpm web              # Start web dev server
pnpm typecheck        # TypeScript type checking
pnpm test             # Run unit tests
pnpm build            # Build for production
```

### Android Build
```bash
pnpm --filter @iptv/mobile apk       # Debug APK
pnpm --filter @iptv/mobile bundle    # Release AAB
pnpm --filter @iptv/mobile build:android  # Both
```

## License

Streamix is available under the [license specified in the repository](./legal/licenses.md).

## Privacy

See our [Privacy Policy](./legal/privacy.md).

## Terms of Service

See our [Terms of Service](./legal/terms.md).

## Support

For support, visit [streamix24.com](https://streamix24.com).
