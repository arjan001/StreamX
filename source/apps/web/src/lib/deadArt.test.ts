import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artIsDead, deadArtHosts, forgetDeadArt, noteArtFailure, noteArtSuccess } from './deadArt.ts';

/**
 * The rule these guard is the one that broke a working app.
 *
 * Giving up on a host after two failures replaced every remaining picture from
 * `image.tmdb.org` — 27,537 of this catalogue's posters — with a monogram for
 * the rest of the session, off the back of two tiles that were never even
 * requested. Reported as "when i navigate i lose images".
 */

test('a host that has answered once is never given up on', () => {
  forgetDeadArt();
  noteArtSuccess('https://image.tmdb.org/t/p/w300/a.jpg');
  for (let i = 0; i < 20; i += 1) noteArtFailure(`https://image.tmdb.org/t/p/w300/${i}.jpg`);
  assert.equal(artIsDead('https://image.tmdb.org/t/p/w300/z.jpg'), false);
  assert.deepEqual(deadArtHosts(), []);
});

test('a host that has never answered is given up on at the first strike', () => {
  /*
    This asserted that two failures were "not enough" and four were. That was a
    fair rule for a flaky host and the wrong one for a dead one: the host in this
    very test accepts no connection at all and carries ~82% of the proxied
    artwork, so four tiles had to each hold a browser connection for the full
    slow-host deadline before the fifth was spared. What makes one strike safe is
    `wins`, not the count — see the test below, where a single late success brings
    a condemned host back and keeps it back.
  */
  forgetDeadArt();
  assert.equal(artIsDead('http://203.0.113.40/picon/a.png'), false, 'unproven is not dead');
  noteArtFailure('http://203.0.113.40/picon/a.png');
  assert.equal(artIsDead('http://203.0.113.40/picon/b.png'), true, 'one strike is enough');
  assert.deepEqual(deadArtHosts(), [{ host: '203.0.113.40', failures: 1 }]);
});

test('one late success brings a condemned host back', () => {
  forgetDeadArt();
  for (let i = 0; i < 6; i += 1) noteArtFailure(`https://slow.example/${i}.jpg`);
  assert.equal(artIsDead('https://slow.example/x.jpg'), true);
  noteArtSuccess('https://slow.example/y.jpg');
  assert.equal(artIsDead('https://slow.example/x.jpg'), false);
});

test('hosts are judged separately, and a path naming no origin not at all', () => {
  forgetDeadArt();
  for (let i = 0; i < 6; i += 1) noteArtFailure(`https://dead.example/${i}.jpg`);
  assert.equal(artIsDead('https://alive.example/a.jpg'), false);
  /* A relative path of ours with nothing to unwrap: no origin is named, so there
     is no host to blame however often it fails. */
  for (let i = 0; i < 6; i += 1) noteArtFailure('/assets/placeholder.png');
  assert.equal(artIsDead('/assets/placeholder.png'), false);
  assert.equal(artIsDead(null), false);
  assert.equal(artIsDead(''), false);
});

/** The APK's own same-origin route for a plaintext picture, read the same way. */
function onDevice(originPath: string): string {
  return `https://localhost/_img?u=${encodeURIComponent(`http://${originPath}`)}`;
}

test('a failure through the on-device image route is charged to the origin behind it', () => {
  forgetDeadArt();
  for (let i = 0; i < 4; i += 1) noteArtFailure(onDevice(`203.0.113.40/picon/${i}.png`));
  assert.equal(artIsDead(onDevice('203.0.113.40/picon/z.png')), true);
  assert.equal(artIsDead(onDevice('203.0.113.10/images/1.png')), false);
  assert.deepEqual(deadArtHosts(), [{ host: '203.0.113.40', failures: 4 }]);
});

test('one picture through that route clears the origin, as a direct one would', () => {
  forgetDeadArt();
  noteArtSuccess(onDevice('203.0.113.10/picons/a.png'));
  for (let i = 0; i < 8; i += 1) noteArtFailure(onDevice(`203.0.113.10/picons/${i}.png`));
  assert.equal(artIsDead(onDevice('203.0.113.10/picons/z.png')), false);
});

function wsrv(originPath: string): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(originPath)}`;
}

test('a wsrv 404 is charged to the origin, not to the CDN', () => {
  forgetDeadArt();
  for (let i = 0; i < 4; i += 1) noteArtFailure(wsrv(`203.0.113.40/picon/${i}.png`));
  assert.equal(artIsDead(wsrv('203.0.113.40/picon/z.png')), true);
  assert.equal(artIsDead(wsrv('203.0.113.10/images/1.png')), false);
  assert.equal(artIsDead('https://wsrv.nl/?url=whatever'), false);
  assert.deepEqual(deadArtHosts(), [{ host: '203.0.113.40', failures: 4 }]);
});

test('a wsrv success keeps that origin alive', () => {
  forgetDeadArt();
  noteArtSuccess(wsrv('203.0.113.10/picons/a.png'));
  for (let i = 0; i < 8; i += 1) noteArtFailure(wsrv(`203.0.113.10/picons/${i}.png`));
  assert.equal(artIsDead(wsrv('203.0.113.10/picons/z.png')), false);
});
