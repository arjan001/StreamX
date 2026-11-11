/**
 * Warm a route chunk while the viewer is still on the tab that leads there.
 *
 * Borrowed from a reference IPTV app's `preloadNavigationPage`: lazy routes keep
 * first paint small, but a D-pad press should not wait on the network. Focus /
 * pointer on a nav item starts the import; navigating a beat later hits cache.
 */

const loaders: Record<string, () => Promise<unknown>> = {
  '/live': () => import('../routes/Live'),
  '/movies': () => import('../routes/Grid'),
  '/series': () => import('../routes/Grid'),
  '/search': () => import('../routes/Search'),
  '/guide': () => import('../routes/Guide'),
  '/more': () => import('../routes/More.tsx'),
  '/organise': () => import('../routes/Organise.tsx'),
  '/catchup': () => import('../routes/Catchup'),
};

const started = new Set<string>();

export function preloadRoute(path: string): void {
  const key = path.split('?')[0] ?? path;
  if (started.has(key)) return;
  const load = loaders[key];
  if (load === undefined) return;
  started.add(key);
  void load();
}
