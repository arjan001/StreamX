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
 * Known adult-related keywords to extract as tags from titles and descriptions.
 * These are common words found in adult content metadata that serve as useful
 * filter tags for users browsing the adult section.
 */
const ADULT_KEYWORDS = [
  // Hair & appearance
  'blonde', 'brunette', 'redhead', 'black hair', 'dye', 'dye hair', 'pixie cut',
  'bald', 'shaved', 'dreadlocks', 'braids', 'ponytail', 'bangs',
  // Body type
  'busty', 'petite', 'curvy', 'skinny', 'athletic', 'thick', 'slim', 'voluptuous', 'bbw',
  'chubby', 'plus size', 'muscular', 'toned', 'fit', 'hourglass', 'flat chest',
  'big ass', 'small tits', 'big tits', 'natural tits', 'fake tits', 'tits job',
  'tight', 'flexible', 'yoga',
  // Age & role
  'milf', 'mature', 'cougar', 'teen', 'young', 'older', 'amateur',
  'grandma', 'college', 'freshman', 'sophomore', 'junior', 'senior',
  'virgin', 'experienced', 'newbie', 'rookie',
  // Ethnicity
  'asian', 'latina', 'black', 'white', 'interracial', 'ebony', 'hispanic',
  'korean', 'japanese', 'chinese', 'indian', 'arab', 'african', 'european',
  'mixed race', 'mixed', 'creole', 'mulatto',
  // Scenarios
  'threesome', 'cuckold', 'gangbang', 'pov', 'public', 'outdoor', 'office',
  'hotel', 'massage', 'casting', 'cosplay', 'fetish', 'hardcore', 'rough',
  'creampie', 'squirt', 'anal', 'oral', 'facial', 'fisting',
  'first time', 'neighbor', 'teacher', 'nurse', 'maid', 'secretary',
  'student', 'boss', 'wife', 'husband', 'girlfriend', 'boyfriend',
  'stepmom', 'stepdad', 'mom', 'dad', 'step sister', 'step brother',
  'aunt', 'uncle', 'cousin', 'in laws',
  'doctor', 'dentist', 'therapist', 'personal trainer', 'receptionist',
  'waitress', 'barmaid', 'flight attendant', 'police', 'firefighter',
  'librarian', 'professor', 'coach', 'mechanic', 'chef',
  // Settings
  'shower', 'bedroom', 'kitchen', 'bathroom', 'pool', 'beach', 'park',
  'car', 'taxi', 'bus', 'elevator', 'gym', 'club', 'bar', 'garage',
  'motel', 'boat', 'forest', 'garden', 'street', 'vacation',
  'wedding', 'party', 'christmas', 'halloween',
  'sauna', 'spa', 'poolside', 'rooftop', 'balcony', 'terrace',
  'basement', 'attic', 'closet', 'barn', 'church', 'school',
  'restaurant', 'cafe', 'supermarket', 'gas station', 'train',
  'airplane', 'helicopter', 'yacht', 'cruise', 'cabin', 'tent',
  // Types
  'gay', 'lesbian', 'bisexual', 'trans', 'swinger', 'orgy', 'foursome',
  'mmf', 'ffm', 'group', 'solo', 'webcam', 'homemade', 'voyeur',
  'selfie', 'roleplay', 'incest', 'family',
  'bdsm', 'bondage', 'domination', 'submission', 'sadism', 'masochism',
  'latex', 'leather', 'rubber', 'panties', 'stockings', 'garters',
  'collar', 'leash', 'whip', 'chain', 'rope', 'blindfold',
  'wax', 'ice', 'feet', 'foot job', 'toe sucking', 'nails',
  'latex suit', 'pantyhose', 'tights', 'corset', 'bodysuit',
  // Attributes
  'tattooed', 'pierced', 'lingerie', 'stockings', 'uniform', 'high heels',
  'naked', 'barefoot', 'glasses', 'big tits', 'small tits',
  'long hair', 'short hair',
  'hairy', 'shaved pussy', 'landing strip', 'wax',
  'nipples', 'areola', 'tattoo', 'piercing', 'navel',
  'pale skin', 'tanned', 'tan lines', 'freckles',
  // Quality & style
  'romantic', 'slow', 'fast', 'intense', 'passionate', 'tender',
  'dirty talk', 'creampie', 'cumshot', 'deepthroat',
  'whispering', 'moaning', 'screaming', 'quiet', 'loud',
  'slow motion', 'close up', 'wide angle', 'hidden cam',
  '4k', 'hd', '4k ultra', 'ultra hd',
  // Additional popular tags
  'cheating', 'cheat', 'affair', 'betrayal', 'secret',
  'hidden', 'secretly', 'sneaky', 'stealth',
  'confession', 'admission', 'guilty', 'caught',
  'jealous', 'jealousy', 'possessive', 'obsessed',
  'taboo', 'forbidden', 'illegal', 'wrong',
  'naughty', 'wild', 'crazy', 'kinky',
  'exhibitionist', 'flasher', 'strip', 'striptease',
  'dildo', 'vibrator', 'toy', 'sex toy', 'ring',
  'double penetration', 'dp', 'double anal',
  'breast job', 'tits job', 'boob job',
  'ass to mouth', 'atm', 'bukkake', 'cum swap',
  'milf son', 'milf daughter', 'milf stepson',
  'teen milf', 'young milf', 'hot milf',
  'big cock', 'small cock', 'long cock', 'thick cock',
  'big dick', 'small dick', 'long dick',
  'black cock', 'white cock', 'latina cock',
  'big black', 'bbc', 'wbw', 'bwb',
  'shemale', 'transsexual', ' Shemale', ' shemale',
  'crossdresser', 'drag queen', 'tranny',
  'bear', 'otter', 'cube', 'twink', 'jock',
  'hunk', 'stud', 'daddy', 'papa',
  'mommy', 'mama', 'sissy', 'femboy',
  'latex', 'pvc', 'shiny', 'glossy',
  'animal', 'pet play', 'pet', 'kennel',
  'breeding', 'pregnant', 'pregnancy', 'lactation', 'milk',
  'cfnm', 'nfcb', 'clothed', 'nude',
  'massage oil', 'oil', 'oiled', 'slippery',
  'water', 'underwater', 'submarine', 'aquatic',
];

/**
 * Extract adult-related tags from a movie title string.
 * Splits the title into words and matches against known adult keywords.
 */
export function extractTagsFromTitle(title: string): string[] {
  if (!title) return [];
  const lower = title.toLowerCase();
  const tags = new Set<string>();

  // Check multi-word keywords first (longer matches take priority)
  for (const keyword of ADULT_KEYWORDS) {
    if (keyword.includes(' ') && lower.includes(keyword)) {
      tags.add(keyword);
    }
  }

  // Then check single-word keywords
  const words = lower.split(/[\s\-_(),.]+/);
  for (const word of words) {
    const clean = word.trim();
    if (clean.length < 3) continue;
    for (const keyword of ADULT_KEYWORDS) {
      if (!keyword.includes(' ') && clean === keyword) {
        tags.add(keyword);
      }
    }
  }

  return [...tags];
}

/**
 * Extract adult-related tags from a movie plot/description string.
 * Searches for known adult keywords in the description text.
 */
export function extractTagsFromDescription(description: string): string[] {
  if (!description) return [];
  const lower = description.toLowerCase();
  const tags = new Set<string>();

  for (const keyword of ADULT_KEYWORDS) {
    if (lower.includes(keyword)) {
      tags.add(keyword);
    }
  }

  return [...tags];
}

/**
 * Extract all adult-related tags from a movie's title and description.
 * Combines tags from both sources, deduplicating and returning a sorted list.
 */
export function extractAllTags(title: string, description?: string): string[] {
  const titleTags = extractTagsFromTitle(title);
  const descTags = description ? extractTagsFromDescription(description) : [];
  const all = new Set([...titleTags, ...descTags]);
  return [...all].sort();
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
