# Streamix Adult Section

This skill documents the Adult section architecture, patterns, and constraints. The Adult section is a distinct part of the app with its own search, filtering, and display patterns.

## 1. Navigation

### Access
- Adult is **not** in the main navigation tabs (`TABS` array in `Chrome.tsx`)
- Accessed via the heart icon (♡) in the header's right-side icon cluster
- Heart icon is positioned before the Profile/User icon
- Icon only, no text label

### Key File
- `apps/web/src/routes/Adult.tsx` — Main adult route component

## 2. Search-First Layout

### Filter Bar Structure
The filter bar in `Adult.tsx` follows a search-first pattern:

1. **Search bar** — Occupies ~75% of the row width
   - Debounced input triggers search after a short delay
   - Autocomplete dropdown shows movie titles and cast names
   - Dropdown has `data-nav-contain` attribute

2. **Gender filter** — Inline expanding chips (NOT floating dropdown)
   - Same style as genre toggle in `FilterBar.tsx`
   - Expands horizontally when clicked
   - Never uses `z-50` floating dropdown — it fails the overlay test

3. **Covers/tiles toggle** — Button on the right
   - List icon = portrait cards (2:3 aspect ratio)
   - Grid icon = landscape cards (3:2 aspect ratio)

### Below the Filter Bar
1. **Tags rail** — Horizontally scrollable tag chips
2. **Cast rail** — Horizontally scrollable cast avatars with names

## 3. Tag Extraction

### Sources
Tags are extracted from three sources:

1. **Movie titles** — Synchronous extraction from all movie titles
2. **Plot descriptions** — Asynchronous extraction from API-fetched descriptions (sampled)
3. **API genres/cast** — From movie detail API calls

### Keywords
The `extractTagsFromTitle()` and `extractTagsFromDescription()` functions in `adult.ts` use ~200+ adult-related keywords, including:

- **Body types:** blonde, brunette, milf, busty, petite, mature, curvy, skinny, athletic
- **Settings:** office, hotel, bedroom, kitchen, bathroom, shower, pool, beach, park, forest, car, taxi, club, bar, gym, street
- **Scenarios:** threesome, cuckold, gangbang, POV, amateur, public, outdoor, rough, hardcore, anal, creampie, squirt
- **Roles:** wife, husband, neighbor, teacher, nurse, maid, secretary, student, girlfriend, boyfriend
- **Attributes:** tattooed, redhead, lingerie, stockings, uniform, high heels, athletic

### Tag Filtering
When a user clicks a tag, the movies are filtered by searching for that tag name in the title and description.

### Key Files
- `apps/web/src/lib/adult.ts` — Tag extraction functions
- `apps/web/src/components/TagsRail.tsx` — Tags rail component

## 4. Cast Rail

### Design
- Rounded cast images with initials fallback
- Cast name displayed below the image
- Horizontally scrollable rail below the tags rail
- Clicking a cast member filters movies by that performer name

### Data Source
Cast images are fetched from the provider's movie detail API. If no image is available, rounded initials are shown as fallback.

### Search Integration
The search autocomplete in the adult section includes cast names. Typing a cast name shows suggestions, and clicking filters by that performer.

## 5. Covers/Tiles View Toggle

### Portrait Mode (Covers)
- Aspect ratio: 2:3 (tall cards)
- Default view for movies and series
- Card width: ~120px, height: ~180px

### Landscape Mode (Tiles)
- Aspect ratio: 3:2 (wide cards)
- Alternative view for adult section
- Card width: ~180px, height: ~120px

### Implementation
- `aspectRatio` prop threaded through `TitleGrid` → `PosterCard` → card div
- Grid metrics (card width, height, min columns) adjust per view mode
- Toggle button uses List/Grid icons from lucide-react

## 6. Search Autocomplete

### Pattern
- Synchronous search from local catalogue via `localSearchSuggestions()`
- Shows up to 8 suggestions as the user types (2+ characters)
- Suggestions include:
  - Content titles with type icons (movie, channel, series)
  - Actor names with 'actor' type icon
- Clicking a suggestion fills the search box and triggers search

### Key File
- `apps/web/src/lib/localRead.ts` — `localSearchSuggestions()` function

## 7. Error Handling

### Navy Blue Screen Prevention
The adult section must handle errors gracefully to prevent crashes:

```tsx
try {
  // Cast query, tag extraction, etc.
} catch (error) {
  // Return empty arrays or defaults
  // Never let errors propagate to the component level
}
```

**Why:** Unhandled errors in the cast query or tag extraction cause the component to crash, resulting in a navy blue screen.

## 8. Common Mistakes

### Floating Gender Dropdown
**Never do this:**
```tsx
<div className="absolute z-50 ...">  {/* WRONG — fails overlay test */}
  <GenderDropdown />
</div>
```

**Do this instead:**
```tsx
<div className="inline-flex flex-wrap gap-1 ...">  {/* Inline expanding chips */}
  <GenderChips />
</div>
```

### Missing `data-nav-contain`
The search autocomplete dropdown must have `data-nav-contain` to pass the CI test.

### Insufficient Tag Coverage
Always extract tags from both titles and descriptions. Titles alone provide limited tags; descriptions contain more context.

### Missing Cast Images
Always provide a fallback (rounded initials) when cast images are not available from the provider.
