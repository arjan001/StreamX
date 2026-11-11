/**
 * The permanent adult filter's client side.
 *
 * Adult items never reach a list, row, search or guide: core-store always
 * excludes them. This module only names the category market the panels use
 * for them, so the app can also keep that market out of its own sidebars.
 */
export const ADULT_PATH = '18';

export function isAdultPath(id: string): boolean {
  return id.split('/')[0]!.toUpperCase() === ADULT_PATH;
}
