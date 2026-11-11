import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLegal, renderMarkdown, TODO_MARK, IMAGE_PROXY_SENTENCE } from '../../../legal/render.ts';

const dir = new URL('../../../legal/', import.meta.url);
const text = (f: string) => readFileSync(new URL(f, dir), 'utf8');

const empty = { name: 'Streamix' };
const filled = {
  name: 'Streamix',
  publisher: {
    name: 'Example Ltd', email: 'legal@example.com', address: '1 High Street, London',
    website: 'https://streamix.example.com/', governingLaw: 'England and Wales',
    termsEffectiveDate: '1 October 2026', privacyEffectiveDate: '2 October 2026',
  },
  captions: { provider: 'Soniox', privacyUrl: 'https://soniox.com/policies/privacy-policy' },
};

test('no template ever leaves raw braces behind, filled in or not', () => {
  for (const doc of ['terms', 'privacy', 'copyright'] as const) {
    for (const b of [empty, filled]) {
      const html = renderLegal(text(`${doc}.md`), b, doc);
      assert.equal(/\{\{|\}\}/.test(html), false, `${doc} still has a placeholder`);
    }
  }
});

test('missing publisher values show a visible marker', () => {
  const html = renderLegal(text('terms.md'), empty, 'terms');
  assert.match(html, new RegExp(`<mark class="todo">\\${TODO_MARK.replace(']', '\\]')}</mark>`));
  assert.equal(renderLegal(text('copyright.md'), empty, 'copyright').includes(TODO_MARK), true);
});

test('optional fields never show the marker: no address line, a general law clause', () => {
  const b = { name: 'Streamix', publisher: { name: 'Example Ltd', email: 'a@b.example', website: 'https://x.example', termsEffectiveDate: '2026-10-01', privacyEffectiveDate: '2026-10-01' },
    captions: { provider: 'Soniox', privacyUrl: 'https://soniox.com/policies/privacy-policy' } };
  for (const doc of ['terms', 'privacy', 'copyright'] as const) {
    const html = renderLegal(text(`${doc}.md`), b, doc);
    assert.equal(html.includes(TODO_MARK), false, `${doc} still shows a marker`);
  }
  const t = renderLegal(text('terms.md'), b, 'terms');
  assert.match(t, /governed by the law that applies where you use the App\. Nothing in them limits rights you have under the law of the country where you live\. If a court finds part of these terms unenforceable, the rest still applies\./);
  assert.match(t, /Example Ltd<br><a href="mailto:a@b\.example">/, 'the contact block has no gap where the address was');
  const named = renderLegal(text('terms.md'), { ...b, publisher: { ...b.publisher, governingLaw: 'England and Wales', address: '1 High Street' } }, 'terms');
  assert.match(named, /governed by the laws of England and Wales/);
  assert.match(named, /Example Ltd<br>1 High Street<br>/);
});

test('filled values appear, escaped, and the right date goes in the right text', () => {
  const t = renderLegal(text('terms.md'), filled, 'terms');
  const p = renderLegal(text('privacy.md'), filled, 'privacy');
  assert.match(t, /Effective date: 1 October 2026/);
  assert.match(p, /Effective date: 2 October 2026/);
  assert.match(t, /England and Wales/);
  assert.match(p, /<a href="mailto:legal@example.com">legal@example.com<\/a>/);
  assert.match(p, /Soniox/);
  assert.match(p, /soniox\.com\/policies\/privacy-policy/);
  const evil = renderLegal('{{PUBLISHER_NAME}}', { name: 'X', publisher: { name: '<script>alert(1)</script>' } }, 'terms');
  assert.equal(evil.includes('<script>'), false);
});

test('the privacy text names the image service the app can contact', () => {
  const p = renderLegal(text('privacy.md'), filled, 'privacy');
  assert.equal(p.includes('wsrv.nl'), true);
  assert.equal(IMAGE_PROXY_SENTENCE.includes('wsrv.nl'), true);
});

test('a contact block keeps its lines apart', () => {
  const html = renderMarkdown('{{PUBLISHER_NAME}}\n{{PUBLISHER_EMAIL}}', { PUBLISHER_NAME: ['A', 'text'], PUBLISHER_EMAIL: ['b@c.d', 'email'] });
  assert.match(html, /A<br>/);
});

test('the bundled licence notice names the components the tree cannot see', () => {
  const l = text('licenses.md');
  for (const needle of ['libVLC', 'LGPL', 'libav.js', 'FFmpeg', 'hls.js', 'mpegts.js', 'Capacitor', 'Unsplash', 'Big Buck Bunny', 'Sintel', 'Tears of Steel']) {
    assert.equal(l.includes(needle), true, needle);
  }
  assert.equal(readFileSync(new URL('../THIRD_PARTY_NOTICES.md', dir), 'utf8'), l);
});
