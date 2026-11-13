# Release Commands Guide

This guide explains how to handle version bumps and releases for the app. Use these commands when asking the AI to update versions.

## Version vs Build Number

The app uses two version numbers in `version.json`:

```json
{
  "version": "1.64.1",
  "build": 203
}
```

- **`version`** — The human-readable semantic version (MAJOR.MINOR.PATCH). This is what users see. Changing this means a **new release** with new features or fixes.
- **`build`** — A monotonic number that always increases. Android requires this to be higher than the previous APK. Changing only the build number means a **minor fix** without a new release version.

## Commands

### Build Bump (Minor Fix)

Use when: pushing small changes, bug fixes, or internal improvements that don't warrant a new release version.

**Say to the AI:** *"Build bump"*

**What happens:**
- Runs `pnpm version:bump build`
- Only the `build` number increases (e.g., `1.64.1` build `203` → `204`)
- The `version` stays the same
- CI creates a git tag and GitHub **pre-release** (grey, not prominent)
- No in-app update notification for users

### Patch Release (Bug Fix Release)

Use when: pushing a bug fix that users should update to.

**Say to the AI:** *"Major release"* (or *"This is a major release"*)

**What happens:**
- Runs `pnpm version:bump patch`
- The patch number increases (e.g., `1.64.1` → `1.64.2`)
- The `build` number also increases automatically
- CI creates a git tag and GitHub **stable release**
- Users will see the "What's New" update modal

### Minor Release (New Features)

Use when: pushing new features or significant improvements.

**Say to the AI:** *"Major release"* (or *"This is a major release"*)

**What happens:**
- Runs `pnpm version:bump minor`
- The minor number increases (e.g., `1.64.1` → `1.65.0`)
- The `build` number also increases automatically
- CI creates a git tag and GitHub **stable release**
- Users will see the "What's New" update modal

### Major Release (Breaking Changes)

Use when: pushing breaking changes or major version upgrades.

**Say to the AI:** *"Major release"* (or *"This is a major release"*)

**What happens:**
- Runs `pnpm version:bump major`
- The major number increases (e.g., `1.64.1` → `2.0.0`)
- The `build` number also increases automatically
- CI creates a git tag and GitHub **stable release**
- Users will see the "What's New" update modal

## How GitHub Releases Work

The CI workflow (`build-android-apk.yml`) runs on every push to `main`:

1. Builds all 4 APK variants (ARM64, ARMv7, x86_64, Universal)
2. Creates a git tag from the current version
3. Creates a GitHub Release with APKs attached
4. If only the build number changed → **Pre-release** (grey, less prominent)
5. If the version number changed → **Stable release** (highlighted)

## In-App Update Modal

When a user opens the app:

1. The app checks `api.github.com/repos/arjan001/StreamX/releases/latest`
2. Compares the latest stable release version with the current app version
3. If a newer stable release exists and hasn't been dismissed:
   - Shows "What's New in v1.x.x" modal on the landing page
   - Shows a "New release available" banner in Settings → About
4. The user can:
   - **Download** — opens the GitHub release page to download the new APK
   - **Dismiss** — closes the modal and remembers this version (won't nag again)

## Quick Reference

| What you say | Command run | Version change | Build change | GitHub Release type | User sees update? |
|---|---|---|---|---|---|
| "Build bump" | `pnpm version:bump build` | No | Yes | Pre-release | No |
| "Major release" | `pnpm version:bump minor` | Yes (minor) | Yes | Stable | Yes |
| "Major release" | `pnpm version:bump patch` | Yes (patch) | Yes | Stable | Yes |
