import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuideCollector, SHARDS, canHaveGuide, guideFreshness, guideKey, shardOf } from './bulkGuide.ts';

const NOW = 1_790_600_000;
const prog = (channel: string, start: number, stop: number | null, title = 'Match', desc: string | null = null) =>
  ({ channel, start, stop, title, desc });

test('a guide id always lands in the same shard, and the shards are all used', () => {
  assert.equal(shardOf('BBCOne.uk'), shardOf('BBCOne.uk'));
  const used = new Set<number>();
  for (let i = 0; i < 2000; i++) used.add(shardOf(`Channel${i}.xx`));
  assert.equal(used.size, SHARDS);
  for (const s of used) assert.ok(s >= 0 && s < SHARDS);
});

test('only what can still be shown is kept: ended programmes go, the evening stays', () => {
  const c = new GuideCollector(NOW, null);
  c.add(prog('a', NOW - 6 * 3600, NOW - 5 * 3600));   // ended five hours ago
  c.add(prog('a', NOW - 3600, NOW + 3600));           // on now
  c.add(prog('a', NOW + 3600, NOW + 7200));           // next
  c.add(prog('a', NOW - 7000, NOW - 3700));           // ended an hour ago: kept
  assert.equal(c.kept, 3);
  assert.equal(c.until, NOW + 7200);
});

test('channels this catalogue does not carry are not kept at all', () => {
  const c = new GuideCollector(NOW, new Set(['wanted.uk']));
  c.add(prog('wanted.uk', NOW, NOW + 60));
  c.add(prog('elsewhere.pl', NOW, NOW + 60));
  assert.deepEqual([...c.byChannel.keys()], ['wanted.uk']);
});

test('shards hold each channel in time order, a repeated start once, and short descriptions', async () => {
  const c = new GuideCollector(NOW, null);
  const long = 'x'.repeat(500);
  c.add(prog('b', NOW + 7200, NOW + 9000, 'Later'));
  c.add(prog('b', NOW, NOW + 3600, 'First', long));
  c.add(prog('b', NOW, NOW + 3600, 'First again'));
  const rows = (await c.shards())[shardOf('b')]!['b']!;
  assert.deepEqual(rows.map((r) => r[2]), ['First', 'Later']);
  assert.equal(rows[0]![3]!.length, 160);
  assert.ok(rows[0]![3]!.endsWith('…'));
});

test('a channel name and its guide file name meet on the same key', () => {
  assert.equal(guideKey('BE| VRT 1 ᴿᴬᵂ'), guideKey('BE| VRT 1'));
  assert.equal(guideKey('BE| RTL TVI (13) ᴿᴬᵂ'), guideKey('BE| RTL TVI'));
  assert.equal(guideKey('UK| BBC ONE FHD'), guideKey('uk| bbc one hd'));
  assert.equal(guideKey('ES| Telecinco [LIVEEVENT]'), guideKey('ES| TELECINCO'));
  /* The country stays: the same channel name in two markets is two guides. */
  assert.notEqual(guideKey('BE| BBC ONE'), guideKey('UK| BBC ONE'));
});

test('the banner rule: a morning guide that covers until 03:30 is fresh, not "running out"', () => {
  /* The owner's line publishes about a day ahead. The old rule — refresh when it
     runs out within 18 h — called that stale at breakfast and downloaded 17 MB
     every hour. Now nothing downloads; the banner speaks when it matters. */
  const h = 3600;
  const now = Date.UTC(2026, 8, 30, 10, 0);
  const nowS = now / 1000;
  const fetched = now - 2 * h * 1000;
  assert.equal(guideFreshness({ until: nowS + 17.5 * h, fetchedAt: fetched }, now), 'fresh');
  assert.equal(guideFreshness({ until: nowS + 2 * h, fetchedAt: fetched }, now), 'soon');
  assert.equal(guideFreshness({ until: nowS - 60, fetchedAt: fetched }, now), 'expired');
  /* A panel that publishes a week ahead still gets a nudge after two days. */
  assert.equal(guideFreshness({ until: nowS + 5 * 24 * h, fetchedAt: now - 49 * h * 1000 }, now), 'old');
  assert.equal(guideFreshness(null, now), 'missing');
});

test('only a source that can have a guide is ever asked about one', () => {
  const base = { id: 1, addedAt: 0, enabled: true, name: 'x', url: 'http://panel.example.com/a' } as const;
  assert.equal(canHaveGuide(null), false);
  assert.equal(canHaveGuide({ ...base, kind: 'stream' }), false);
  assert.equal(canHaveGuide({ ...base, kind: 'stalker', mac: '00:1A:79:00:00:01' }), false);
  assert.equal(canHaveGuide({ ...base, kind: 'm3u' }), false, 'a playlist with no guide link');
  assert.equal(canHaveGuide({ ...base, kind: 'm3u', epgUrl: 'http://guide.example.com/g.xml' }), true);
});
