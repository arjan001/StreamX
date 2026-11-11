import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, readSkin, readTint, resolveMode,
} from './skin.ts';

test('a fresh install is soft, Midnight, DARK, the showcase home and the MODERN shell', () => {
  // Dark rather than `system`: this is a video app, and a white chrome washes the
  // picture out. `Auto` is offered, not assumed.
  assert.deepEqual(readSkin(null), {
    ui: 'soft', theme: 'midnight', mode: 'dark', home: 'showcase',
    /* Modern, asked for once it had been seen on a real television. This was
       `classic` while the second shell was new, on the rule that adding an option
       must not change a set that already works; that rule has now been
       deliberately spent, and this assertion is the record of it. */
    shell: 'modern',
    /* No overrides until the viewer picks one — see `Tint`. */
    tint: {},
  });
});

test('the shell round-trips, a chosen classic survives, and anything else reads as modern', () => {
  assert.equal(readSkin('{"shell":"modern"}').shell, 'modern');
  /*
   * The one that matters after the default changed. Somebody who went into
   * Settings and chose classic must keep it — a default is what happens when
   * nobody has said anything, never an override of somebody who has.
   */
  assert.equal(readSkin('{"shell":"classic"}').shell, 'classic');
  /*
   * A value from a future build, a hand-edited one, or the wrong type at all —
   * and `{}`, which is every television whose skin was stored before this
   * setting existed. Every one of these has to land on a shell the stylesheet
   * has rules for: an unknown `data-shell` is a document with no layout rules
   * matching it, which is the "no styling at all" failure in miniature.
   */
  for (const raw of ['{"shell":"launcher"}', '{"shell":42}', '{"shell":null}', '{}']) {
    assert.equal(readSkin(raw).shell, 'modern', raw);
  }
});

test('an unknown mode falls back to dark, and `system` is still storable', () => {
  assert.equal(readSkin('{"mode":"sepia"}').mode, 'dark');
  assert.equal(readSkin('{"mode":"system"}').mode, 'system');
});

test('corrupt or hostile storage falls back rather than throwing', () => {
  for (const raw of ['', '{', 'null', '"soft"', '[]', '{"ui":42}']) {
    assert.equal(readSkin(raw).ui, 'soft', raw);
    assert.equal(readSkin(raw).theme, 'midnight', raw);
  }
});

test('an unknown palette does not leave the app with no colours at all', () => {
  /* Was `neon`, which is a real palette now — the six specified ones landed. An
     id that will never exist keeps the test testing the fallback. */
  assert.equal(readSkin('{"theme":"chartreuse"}').theme, 'midnight');
  assert.equal(readSkin('{"theme":"forest"}').theme, 'forest');
});

test('every stored choice round-trips', () => {
  const raw = '{"ui":"square","theme":"plum","mode":"light","home":"showcase","shell":"modern"}';
  assert.deepEqual(
    readSkin(raw),
    { ui: 'square', theme: 'plum', mode: 'light', home: 'showcase', shell: 'modern', tint: {} },
  );
});

test('system mode follows the OS; an explicit choice never does', () => {
  assert.equal(resolveMode('system', true), 'dark');
  assert.equal(resolveMode('system', false), 'light');
  assert.equal(resolveMode('dark', false), 'dark');
  assert.equal(resolveMode('light', true), 'light');
});

test('every palette in the picker has both swatches', () => {
  assert.ok(THEMES.length >= 4);
  for (const t of THEMES) {
    assert.match(t.ground, /^#[0-9a-f]{6}$/);
    assert.match(t.accent, /^#[0-9a-f]{6}$/);
    assert.ok(t.label.length > 2);
  }
});

test('a start page from the days when there were three collapses to the one', () => {
  // `classic` and `profiles` were real choices and are stored on real devices.
  // They must read back as the only style there is rather than as themselves,
  // or an existing install lands on a route that no longer exists.
  assert.equal(readSkin('{"home":"profiles"}').home, 'showcase');
  assert.equal(readSkin('{"home":"classic"}').home, 'showcase');
});

test('an unknown start page falls back rather than throwing', () => {
  // A value written by a newer build, or a hand-edited store.
  assert.equal(readSkin('{"home":"carousel"}').home, 'showcase');
});

/* ── roundness, the six new palettes, and a viewer's own colours ───────────── */

test('every roundness level survives a round trip', () => {
  for (const ui of ['square', 'soft', 'round', 'pill'] as const) {
    assert.equal(readSkin(JSON.stringify({ ui })).ui, ui);
  }
});

test('an unknown roundness falls back to soft rather than breaking the corners', () => {
  assert.equal(readSkin(JSON.stringify({ ui: 'blob' })).ui, 'soft');
  assert.equal(readSkin(JSON.stringify({ ui: 7 })).ui, 'soft');
});

test('the six specified palettes are all selectable', () => {
  for (const theme of ['gold', 'neon', 'pop', 'cinema', 'summer', 'winter'] as const) {
    assert.equal(readSkin(JSON.stringify({ theme })).theme, theme);
  }
});

test('every theme in the picker has a ground and an accent to draw', () => {
  /* The picker renders these directly as inline styles, so a missing one is a
     transparent swatch rather than an error. */
  for (const t of THEMES) {
    assert.match(t.ground, /^#[0-9a-f]{6}$/i, t.id);
    assert.match(t.accent, /^#[0-9a-f]{6}$/i, t.id);
  }
});

test('a stored colour that is not a colour is dropped, not sanitised', () => {
  /*
   * These end up in `style.setProperty('--color-ground', value)`, so a value
   * carrying a `;` is a CSS injection into the document root. Storage is
   * writable by anything running on the device, so this is a real boundary and
   * not a formality. Anything that is not plainly a hex colour is refused
   * outright — a colour picker has no legitimate way to produce one.
   */
  const bad = {
    body: 'red;background:url(http://evil.example/x)',
    bars: 'var(--color-ink)',
    raised: 'expression(alert(1))',
    accent: '#12345',
    focus: 'rgb(0,0,0)',
  };
  assert.deepEqual(readTint(bad), {});
});

test('hex colours in every accepted length are kept and normalised', () => {
  assert.deepEqual(
    readTint({ body: '#FFF', bars: '#0A1B2C', raised: '#0a1b2cff' }),
    { body: '#fff', bars: '#0a1b2c', raised: '#0a1b2cff' },
  );
});

test('a key nobody defined is ignored', () => {
  assert.deepEqual(readTint({ nonsense: '#ffffff', body: '#000000' }), { body: '#000000' });
});

test('rubbish where the tint should be is an empty tint, not a throw', () => {
  for (const raw of [null, undefined, 'nope', 42, []]) {
    assert.deepEqual(readTint(raw), {});
  }
});

test('a skin with no tint stored reads as no overrides', () => {
  assert.deepEqual(readSkin(null).tint, {});
  assert.deepEqual(readSkin('{}').tint, {});
});
