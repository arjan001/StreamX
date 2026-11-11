/**
 * Adult content section logic.
 *
 * This module handles:
 * - Fetching and aggregating tags from adult VOD content
 * - Fetching and deduplicating cast members (actors/performers)
 * - Sex filtering for cast members
 * - Bypassing the adult filter when accessing via the adult section
 */

import { useLocation } from 'react-router-dom';

export interface AdultTag {
  id: string;
  name: string;
  count: number;
}

export interface AdultCast {
  id: string;
  name: string;
  image: string | null;
  sex?: string;
}

export interface SexFilter {
  id: string;
  name: string;
  count: number;
}

/**
 * Check if the current route is the adult section.
 *
 * Used to determine whether to bypass the adult filter.
 */
export function isAdultRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/adult');
}

/**
 * Determine if the adult filter should be applied.
 *
 * The filter is bypassed when accessing the adult section via the bunny icon.
 */
export function shouldApplyAdultFilter(): boolean {
  return !isAdultRoute();
}

/**
 * Aggregate tags from adult VOD content.
 *
 * Groups tags by name and counts how many items have each tag.
 * Tags are normalized to lowercase for deduplication.
 */
export function aggregateTags(items: Array<{ tags?: readonly string[] }>): AdultTag[] {
  const tagCounts = new Map<string, number>();

  for (const item of items) {
    if (!item.tags) continue;
    for (const tag of item.tags) {
      const normalized = tag.toLowerCase().trim();
      if (normalized === '') continue;
      tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
    }
  }

  return [...tagCounts.entries()]
    .map(([name, count]) => ({
      id: name,
      name: capitalizeWords(name),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Aggregate cast members from adult VOD content.
 *
 * Deduplicates cast by name (case-insensitive).
 * Falls back to initials if no image is available.
 */
export function aggregateCast(items: Array<{ cast?: ReadonlyArray<{ name: string; image?: string | null; sex?: string }> }>): AdultCast[] {
  const castMap = new Map<string, AdultCast>();

  for (const item of items) {
    if (!item.cast) continue;
    for (const member of item.cast) {
      const normalizedName = member.name.toLowerCase().trim();
      if (normalizedName === '') continue;

      const existing = castMap.get(normalizedName);
      if (existing) {
        // Keep the image if the existing one doesn't have one
        if (!existing.image && member.image) {
          castMap.set(normalizedName, {
            ...existing,
            image: member.image,
          });
        }
        // Keep sex info if the existing one doesn't have it
        if (!existing.sex && member.sex) {
          castMap.set(normalizedName, {
            ...existing,
            sex: member.sex,
          });
        }
      } else {
        castMap.set(normalizedName, {
          id: normalizedName,
          name: member.name,
          image: member.image ?? null,
          sex: member.sex,
        });
      }
    }
  }

  return [...castMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate sex filters from cast data.
 *
 * Common variants: straight, gay, bisexual, lesbian, transgender, etc.
 * Each filter has a count of cast members with that sex/orientation.
 */
export function generateSexFilters(cast: readonly AdultCast[]): SexFilter[] {
  const sexCounts = new Map<string, number>();

  for (const member of cast) {
    if (!member.sex) continue;
    const normalized = member.sex.toLowerCase().trim();
    if (normalized === '') continue;
    sexCounts.set(normalized, (sexCounts.get(normalized) ?? 0) + 1);
  }

  const commonVariants = ['straight', 'gay', 'bisexual', 'lesbian', 'transgender'];

  return commonVariants
    .map((id) => ({
      id,
      name: capitalizeWords(id),
      count: sexCounts.get(id) ?? 0,
    }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * Capitalize the first letter of each word.
 */
function capitalizeWords(str: string): string {
  return str
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Get initials from a name (e.g., "John Doe" -> "JD").
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
