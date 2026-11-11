# Screenshots and artwork rules

Applies to every store.

## What may appear

- **Only** the Creative Commons demo films (the Blender open movies from the server's demo
  playlist) and the app's own interface.
- Settings, Add a source, the library, the guide, the player controls and the empty state are
  all good subjects. Show the "Add a source" step: it tells a reviewer the app has no
  content of its own.

## What must never appear

- Real channel names or logos, broadcaster branding, sports (matches, teams, leagues,
  tournaments), film or series artwork, actor faces from real productions.
- Any real provider's address, username, password or playlist link. Use obviously fake ones
  (`panel.example.com`) or the demo source.
- Prices, "free", "premium", "all channels", "thousands of channels", "no subscription",
  "watch anything". Also no claims that imply content is included.
- Other brands' logos (Samsung, LG, Apple, Google) other than the required badge.
- Adult material, even blurred.
- Your own device's real data (email, notifications, other apps).

The previous captures in `apps/tizen/store/` should be checked or retaken if they contain
any of the above. `scripts/fake-panel.mjs` and `scripts/fake-stalker.mjs` produce fixture
sources with neutral content; the demo playlist gives real, free-to-use films.

## How to capture

1. Serve or install the production-like build.
2. Add the demo playlist as the source (or use a fake panel built from the fixtures).
3. Capture at the store's native size. Do not upscale. Do not add device frames or text
   overlays unless the store allows them; if you add captions, they must describe features
   truthfully.
4. Re-take them whenever the interface changes noticeably (stores compare screenshots with
   the app).

## Sizes

Always confirm the current numbers in the console; they change with device generations.

| Store | Asset | Size |
|---|---|---|
| Google Play | App icon | 512x512 PNG, 32-bit, under 1 MB |
| Google Play | Feature graphic | 1024x500 PNG/JPG |
| Google Play | Phone screenshots | 2 to 8; 16:9 or 9:16; each side 320 to 3840 px |
| Google Play | 7-inch and 10-inch tablet | up to 8 each, same rules |
| Google Play | Android TV screenshots | 1920x1080 landscape (2 to 8) |
| Google Play | Android TV banner | 1280x720 PNG for the listing; the in-app launcher banner is 320x180 |
| Apple | iPhone 6.9-inch | 1320x2868 portrait or 2868x1320 landscape (others scale down) |
| Apple | iPad 13-inch | 2064x2752 portrait or 2752x2064 landscape |
| Apple | Count | 1 to 10 per size |
| Samsung TV | Screenshots | exactly 4, JPEG, 1280x720 or 1920x1080, under 500 kB each |
| Samsung TV | Logo | 1920x1080 PNG with transparency, up to 300 kB |
| Samsung TV | Background | 1920x1080 JPG or PNG, up to 300 kB |
| Samsung TV | Icon | 512x423 PNG, up to 300 kB |
| LG webOS | App icons | 80x80 and 130x130 (in the package) |
| LG webOS | Store artwork and screenshots | see the Seller Lounge upload form |
