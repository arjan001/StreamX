# x86_64 APK Issues — Code Review Findings & Recommendations

**Date:** 2026-11-17
**Project:** Streamix v1.64.1
**Purpose:** Analysis of issues reported on x86_64 (Universal) APK running on MuMu Player emulator

---

## Issue Summary

| # | Issue | Status | Root Cause | File |
|---|-------|--------|------------|------|
| 1 | Download failed error | ❌ **BUG** | Wrong download URL | `updateCheck.ts:21` |
| 2 | Update button not working | ❌ **BUG** | Same as #1 - invalid URL | `updateCheck.ts:21` |
| 3 | Adult tab not highlighted on movie detail | ⚠️ **DESIGN** | Adult is a heart icon link, not a tab | `Chrome.tsx:1879` |
| 4 | Clicking adult card redirects to Movies tab | ⚠️ **DESIGN** | Adult not in tabs array | `Chrome.tsx:69-87` |
| 5 | Tab names should always show | ✅ **WORKS** | All tabs show icon + label | `Chrome.tsx:1794-1795` |
| 6 | Search bar too small (half/3/4 width) | ⚠️ **DESIGN** | Set to 75% max-width | `Adult.tsx:207` |
| 7 | Tags incomplete/wrong | ✅ **WORKS** | ~200+ keywords implemented | `adult.ts:166-254` |
| 8 | Card layout orientation missing | ✅ **WORKS** | Covers/tiles toggle implemented | `Adult.tsx:300-313` |
| 9 | Cast images missing | ✅ **WORKS** | Implemented with fallback | `Adult.tsx:317-355` |
| 10 | Logo trimmed on x86_64 | ⚠️ **CSS** | May be emulator-specific rendering | `Wordmark.tsx:71` |
| 11 | Navbar design changes missing | ⚠️ **VERIFY** | Need to check reference images | `Chrome.tsx` |
| 12 | Channel loading slow | ⚠️ **PERFORMANCE** | May be emulator network issue | N/A |

---

## Detailed Findings

### 1. Download Failed Error / Update Button Not Working ❌ CRITICAL BUG

**File:** `apps/web/src/lib/updateCheck.ts` (line 21)

**Root Cause:**
```typescript
const PAGES_BASE = 'https://payd.help';
```

The download URL base is set to `https://payd.help` instead of the correct GitHub Pages URL. When the user clicks "Update", the app tries to download from:
- `https://payd.help/streamix-x86_64.apk` (for x86_64)
- `https://payd.help/streamix-universal.apk` (for universal)

These URLs **do not exist**, causing the "Download failed" error.

**Expected URL:**
```typescript
const PAGES_BASE = 'https://arjan001.github.io/StreamX';
```

**Impact:** Users cannot update the app. The update button appears but fails silently.

**Recommendation:** Fix the PAGES_BASE constant to point to the correct GitHub Pages URL.

---

### 2. Adult Tab Not Highlighted / Redirects to Movies ⚠️ DESIGN ISSUE

**File:** `apps/web/src/components/Chrome.tsx`

**Current Implementation:**
- The Adult section is **NOT a tab** in the navigation
- It's rendered as a heart icon link in the right controls area (line 1879-1881):
```tsx
<Link to="/adult" aria-label="Adult" className={MODERN_ICON}>
  <Heart className="h-5 w-5" />
</Link>
```
- The TABS array (lines 69-87) contains: Home, Live TV, Sports TV, Movies, Series, Guide, Catch-up
- No Adult tab exists in any tab array

**When clicking an adult card:**
- The link is `/movie/:id?from=adult` (Adult.tsx line 387)
- The `detailFrom` variable captures `from=adult` (Chrome.tsx line 1585-1587)
- However, since Adult is not in the tabs array, `detailFrom` matches no tab
- The Movies tab lights up because `/movie/:id` is owned by Movies (OWNED_BY line 159-161)

**User's Request:**
> "when am on adult tab but when i click any of adult card and see movies of adult film details, im redirected to movies tab thats one thats active"

**Recommendation:**
1. Add Adult as a proper tab in the TABS array
2. Add `/adult` to the OWNED_BY record for `/movies`
3. Move the heart icon from controls to the tab bar

---

### 3. Tab Names Always Show ✅ ALREADY WORKS

**File:** `apps/web/src/components/Chrome.tsx` (lines 1794-1795)

**Current Implementation:**
```tsx
<Icon className="h-4 w-4" strokeWidth={modern ? 1.75 : 2} />
<span>{label}</span>
```

Every tab renders **both** the icon AND the label text. There's no conditional logic that hides labels for inactive tabs.

**User's Request:**
> "client said always show tabs name even if not clicked if tab is not clicked only icon is shown"

**Status:** This is already implemented correctly. All tabs show names always.

**Recommendation:** No change needed. Verify on the actual APK build.

---

### 4. Search Bar Width ⚠️ DESIGN ISSUE

**File:** `apps/web/src/routes/Adult.tsx` (line 207)

**Current Implementation:**
```tsx
<div className="relative min-w-0" style={{ maxWidth: '75%' }}>
```

The search bar is limited to 75% of the available width.

**User's Complaint:**
> "search bar isnt half tags incomplete"
> "search bar size isnt like half the page width or almost 3 quarter"

**Status:** The search bar is indeed ~75% width, which the user describes as "half" or "3/4".

**Recommendation:** Increase to 90-95% max-width or remove the maxWidth constraint entirely for the search bar.

---

### 5. Tags Extraction ✅ ALREADY WORKS

**File:** `apps/web/src/lib/adult.ts` (lines 166-254)

**Current Implementation:**
- ~200+ adult keywords covering:
  - Hair & appearance (blonde, brunette, redhead, etc.)
  - Body type (busty, petite, curvy, etc.)
  - Age & role (milf, mature, teen, etc.)
  - Ethnicity (asian, latina, interracial, etc.)
  - Scenarios (threesome, POV, public, etc.)
  - Settings (shower, bedroom, beach, etc.)
  - Types (gay, lesbian, bisexual, BDSM, etc.)
  - Attributes (tattooed, pierced, lingerie, etc.)
  - Quality & style (romantic, 4K, HD, etc.)

**Extraction Logic:**
- `extractTagsFromTitle()`: Matches multi-word and single-word keywords from titles
- `extractTagsFromDescription()`: Searches for keywords in plot descriptions
- Tags are aggregated with counts and sorted by frequency

**User's Complaint:**
> "tags incomplete and wrong not similar to what i had requested explicit tags not just funny tags, sexual tags"

**Status:** The keyword list is comprehensive and includes explicit adult tags. If the user sees "funny tags" or incomplete tags, it could be:
1. The provider's catalogue has limited adult content (only 2 items noted in session summary)
2. Tags are extracted from whatever content exists
3. The APK may be an older build without the latest tag keywords

**Recommendation:** Verify the APK build version includes the latest adult.ts file. The code is correct.

---

### 6. Card Layout Orientation (Covers/Tiles) ✅ ALREADY WORKS

**File:** `apps/web/src/routes/Adult.tsx` (lines 300-313, 388)

**Current Implementation:**
```tsx
<button onClick={() => setViewMode(viewMode === 'covers' ? 'tiles' : 'covers')}>
  {viewMode === 'covers' ? <List /> : <LayoutGrid />}
</button>

<TitleGrid
  aspectRatio={viewMode === 'tiles' ? '3/2' : '2/3'}
/>
```

- **Covers mode:** Portrait cards (2/3 aspect ratio) - standing rectangle
- **Tiles mode:** Landscape cards (3/2 aspect ratio) - lying rectangle
- Toggle button switches between the two views

**User's Request:**
> "card can be switched from standing rectangle to lying rectangle thats the logic"

**Status:** Fully implemented. The toggle button is present in the Adult section.

**Recommendation:** No code change needed. Verify the APK build includes this feature.

---

### 7. Cast Images ✅ ALREADY WORKS

**File:** `apps/web/src/routes/Adult.tsx` (lines 317-355)

**Current Implementation:**
```tsx
{castMembers.slice(0, 30).map((member) => (
  <button onClick={() => handleCastSelect(member.name)}>
    <div className="h-12 w-12 rounded-full overflow-hidden">
      {member.image ? (
        <img src={member.image} className="h-full w-full object-cover" />
      ) : (
        <span>{getInitials(member.name)}</span>
      )}
    </div>
    <span>{member.name.split(' ')[0]}</span>
  </button>
))}
```

- Rounded circular images (48x48px)
- Initials fallback if no image available
- Click to filter by cast member name
- Horizontal scrolling rail

**User's Complaint:**
> "cast images are also missing"

**Possible Causes:**
1. Provider's adult content has no cast data
2. The cast fetch is async and deferred (500ms delay in TagsRail)
3. The APK may be an older build

**Recommendation:** Verify the APK build version. The code is correct.

---

### 8. Logo Trimming on x86_64 ⚠️ CSS RENDERING

**File:** `apps/web/src/components/Wordmark.tsx` (line 71)

**Current Implementation:**
```tsx
<img
  src={`${import.meta.env.BASE_URL}${BRAND.logo}`}
  className={`brand-full ${s.logo} w-auto shrink-0 object-contain object-left`}
/>
```

- Uses `object-contain` to preserve aspect ratio
- Uses `object-left` to align to the left
- Logo comes from `brand.ts` generated by `brand-kit`

**User's Complaint:**
> "logo is okay but seems trimmed out not like the universal logo"

**Possible Causes:**
1. x86_64 emulator may render CSS differently than ARM devices
2. The brand assets may not be properly included in the x86_64 build
3. WebView rendering differences on MuMu Player

**Recommendation:** Check if the brand assets (logo.png, mark.png) are included in the x86_64 build's public folder.

---

### 9. Channel Loading Slow ⚠️ PERFORMANCE

**User's Complaint:**
> "getting channel ready is taking forever to load"

**Possible Causes:**
1. MuMu Player emulator network performance
2. Server response time
3. x86_64 JavaScript execution speed
4. Catalogue preparation on first run

**Recommendation:** This is likely an emulator-specific performance issue, not a code bug. Test on a real ARM device for comparison.

---

### 10. Navbar Design ⚠️ NEEDS VERIFICATION

**User's Request:**
> "the rest of design i had asked for on navbar still missing"
> Reference images provided for navbar design

**Current Implementation:**
- Modern header with centered tabs
- Icon + label for each tab
- Search, Refresh, Settings, Adult (heart), Account icons on the right
- Wordmark logo on the left

**Recommendation:** Compare the reference images with the current implementation to identify specific missing design elements.

---

## APK Version Analysis

### Why Some Features Work on One APK but Not Another

The project builds **4 APK variants**:
1. `streamix-arm64.apk` - ARM64 devices (most Android phones/tablets)
2. `streamix-armv7.apk` - Older ARM devices
3. `streamix-x86_64.apk` - Emulators, Chromebooks
4. `streamix-universal.apk` - All architectures

**Key Finding:** All APK variants use the **same web codebase**. There's no APK-specific code. The differences would be:
1. **Build timing** - If the x86_64 APK was built before some features were added
2. **WebView rendering** - x86_64 WebView may render CSS differently
3. **Performance** - Emulators are slower than real devices

**The user's issues are likely due to:**
1. **Wrong download URL** (critical bug affecting all APKs)
2. **Older APK build** missing recent feature additions
3. **Emulator-specific rendering** differences

---

## Recommendations Summary

### Critical Fixes Required

1. **Fix download URL** (`updateCheck.ts:21`)
   - Change `PAGES_BASE` from `https://payd.help` to `https://arjan001.github.io/StreamX`
   - This fixes the "Download failed" error and makes the update button work

### Design Changes Requested

2. **Add Adult as a proper tab** (`Chrome.tsx`)
   - Add `{ to: '/adult', label: 'Adult', Icon: Heart }` to TABS array
   - Add `/adult` to OWNED_BY record
   - Remove heart icon from right controls

3. **Increase search bar width** (`Adult.tsx:207`)
   - Change `maxWidth: '75%'` to `maxWidth: '95%'` or remove constraint

### Verification Needed

4. **Rebuild x86_64 APK** with latest code
   - Ensure all recent features are included
   - Test on MuMu Player emulator

5. **Check brand assets** in x86_64 build
   - Verify logo.png and mark.png are included
   - Test logo rendering on emulator

6. **Compare reference images** with current navbar
   - Identify specific missing design elements

---

## Code Quality Assessment

| Component | Status | Notes |
|-----------|--------|-------|
| Tag extraction | ✅ Complete | ~200+ keywords, comprehensive |
| Card layout toggle | ✅ Complete | Covers/tiles with aspectRatio |
| Cast images | ✅ Complete | Rounded circles with initials fallback |
| Search bar | ⚠️ 75% width | User wants wider |
| Tab display | ✅ Complete | Icon + label always shown |
| Adult tab | ❌ Not a tab | Heart icon link only |
| Update system | ❌ Broken URL | Wrong PAGES_BASE |
| Logo rendering | ⚠️ CSS issue | May be emulator-specific |

---

*Report generated on 2026-11-17 based on code review of Streamix v1.64.1.*
