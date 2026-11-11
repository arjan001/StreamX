/**
 * Which route a poster takes to the screen.
 *
 * This decision is invisible from the outside, which is why it needs pinning:
 * every wrong answer is still a perfectly well-formed URL, so nothing throws,
 * nothing logs, and the only symptom is a grey letter tile on somebody's
 * television.
 *
 * A picture goes to its own host — through the APK's native `/_img` inside the
 * app, and as itself on a web page. `safeImage` runs here under node, with no
 * `location` and no `VITE_PLATFORM`: the web page's branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeImage } from './localRead.ts';

const PICON = 'http://203.0.113.40/picons/logos/SPAINNEW/LA1.png';

/* ── which route is asked first ─────────────────────────────────────────────── */

test('https artwork is never touched', () => {
  const tmdb = 'https://image.tmdb.org/t/p/w342/abc.jpg';
  assert.equal(safeImage(tmdb), tmdb);
});

test('a measured TLS-capable host is upgraded', () => {
  /* `TLS_OK`. Upgrading costs nothing, and a secure page can then load it. */
  assert.equal(
    safeImage('http://picons.cmshulk.com/picons/netflix.png'),
    'https://picons.cmshulk.com/picons/netflix.png',
  );
});

test('plaintext artwork goes to its own host', () => {
  assert.equal(safeImage(PICON), PICON);
});

test('artwork that is neither http nor https is no artwork', () => {
  assert.equal(safeImage(null), null);
  assert.equal(safeImage(''), null);
  assert.equal(safeImage('data:image/png;base64,iVBOR'), null);
  assert.equal(safeImage('ftp://example.com/logo.png'), null);
});
