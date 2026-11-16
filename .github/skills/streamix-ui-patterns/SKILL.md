# Streamix UI Patterns

This skill documents the UI patterns used throughout the Streamix app. Follow these patterns to maintain consistency and pass CI tests.

## 1. Overlay Focus Behavior (MANDATORY)

**Rule:** Every floating element (`z-40`, `z-50`, `z-[80]`, etc.) must declare its focus behavior.

**Why:** The CI test (`overlays.test.ts`) scans all components and fails the build if any floating element lacks this attribute.

**How:** Add one of these attributes to the floating element:

```tsx
// For menus, dialogs, dropdowns that trap focus
<div data-nav-contain className="absolute z-50 ...">

// For sections with internal navigation
<div data-nav-scope className="absolute z-50 ...">

// For decorative overlays
<div data-nav-skip className="absolute z-50 ...">
```

**Common mistakes:**
- Forgetting `data-nav-contain` on autocomplete dropdowns
- Forgetting `data-nav-contain` on modal backdrops
- Using `z-50` without any navigation attribute

**Examples from the codebase:**
- `Search.tsx` autocomplete dropdown: `data-nav-contain`
- `UpdateModal.tsx` modal: `data-nav-contain`
- `More.tsx` changelog modal: `data-nav-contain`

## 2. Card Layouts

### Home Page Cards
- 5 cards: Live TV, Sports TV, Movies, Series, Replay
- Centered in one horizontal row using flex layout
- Consistent dimensions and spacing
- Grid gap: `gap-3 tv:gap-4` (reduced from `gap-4 tv:gap-5`)

### Continue Watching Tiles
- Horizontal scrolling with `See All` button on the right
- Progress bar at the bottom showing watch fraction
- Uses `WatchTile.tsx` component with `watchFraction(rec)`

### Title Grid (Movies, Series, Adult)
- Uses `TitleGrid.tsx` with configurable metrics
- Card width, height, and min columns adjust per section
- Supports two view modes via `aspectRatio` prop:
  - Portrait (2:3) — default for movies, series
  - Landscape (3:2) — "tiles" mode for adult section

## 3. Filter Bars

### Movies/Series FilterBar
- Genre toggle as inline expanding chips row
- Tags rail below the filter bar
- Quick filters (Just Added, Top Rated)

### Adult Section Filter Bar
- Search bar occupies ~75% of the row width
- Gender filter as inline expanding chips (NOT floating dropdown)
- Covers/tiles view toggle button on the right
- Tags rail below the search row
- Cast rail below the tags rail

**Key pattern:** The gender filter uses the same inline expanding chips style as the genre toggle in `FilterBar.tsx`. Never use a floating `z-50` dropdown for the gender filter — it fails the overlay test.

## 4. Navigation Bar

### Structure
- Header with brand logo on the left
- Tab links in the center
- Icon cluster on the right: Heart (adult), Profile/User

### Tabs
- `TABS` array defines the main navigation tabs
- `MODERN_HEADER_TABS` for the modern header style
- Adult is NOT in the tabs array — it's accessed via the heart icon

### Heart Icon
- Links to `/adult`
- Icon only, no text label
- Positioned before the Profile icon
- Matches existing icon styling

## 5. Search Patterns

### General Search (`Search.tsx`)
- Debounced input triggers search after a short delay
- Autocomplete dropdown shows up to 8 suggestions
- Suggestions include content titles AND actor names
- Clicking an actor suggestion filters by `?person=` parameter
- Dropdown has `data-nav-contain` attribute

### Adult Search (`Adult.tsx`)
- Wide search bar with debounced input
- Autocomplete shows movie titles and cast names
- Tags are extracted from titles and descriptions
- Clicking a tag filters movies by that tag name

## 6. Modal Patterns

### Update Modal
- Responsive sizing: `max-w-[26rem]` mobile, `tv:max-w-[36rem]` TV
- Uses `data-nav-contain` for overlay test
- Shows changelog body from GitHub release

### Changelog Modal
- Bundled from `CHANGELOG.md` via raw string import
- `getChangelogForVersion()` extracts the section for any version
- Responsive sizing matching system theme

## 7. Video Player

### Sports Force Cover
- `forceCover={true}` prop on `VideoPlayer` for sports content
- Eliminates grey letterbox bars by forcing `object-fit: cover`
- Live TV, Movies, Series keep normal `contain` behavior

### Progress Bars
- Continue watching tiles show progress at the bottom
- Uses `watchFraction(rec)` to calculate the fraction watched
- Tally-colored bar indicates completion

## 8. Error Display

### Login Errors
- Expandable "Error details" section
- Structured error codes: E001-E006 for Xtream, N001-N003 for playlist
- Troubleshooting hints for each error code

### Refresh Messages
- Phase-specific labels: "Downloading channels", "Downloading movies", etc.
- Maps all `IngestStatus` phase values
