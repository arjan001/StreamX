/**
 * Which origins may call the API from a browser.
 *
 * The app reaches this server from a handful of places and nowhere else:
 *
 *   capacitor://localhost, http(s)://localhost   the Capacitor shells (iOS, Android)
 *   null                                         a page loaded from file:// — the
 *                                                Samsung Tizen and LG webOS packages
 *   this site's own address                      the web build served from here
 *
 * Anything else is a website that has no business reading a caption key, so it
 * gets no CORS headers and the browser refuses to hand it the answer. (CORS does
 * not stop a non-browser client; the routes themselves are rate limited for that.)
 * A request with no Origin header is a same-origin or non-browser call and passes.
 */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): Set<string> {
  const set = new Set<string>([
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost',
    'null',
  ]);
  const add = (v: string | undefined) => {
    const t = (v ?? '').trim().replace(/\/+$/, '');
    if (t !== '') set.add(t);
  };
  add(env['PUBLIC_SITE_ORIGIN']);
  for (const e of extra) {
    try { add(new URL(e).origin); } catch { /* not a URL: ignore */ }
  }
  for (const o of (env['CORS_ORIGINS'] ?? '').split(',')) add(o);
  return set;
}

export function originAllowed(origin: string | undefined, allowed: Set<string>, dev = false): boolean {
  if (origin === undefined || origin === '') return true;
  if (allowed.has(origin)) return true;
  /* Dev servers (Vite on 5173 and friends) only when not in production. */
  return dev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
