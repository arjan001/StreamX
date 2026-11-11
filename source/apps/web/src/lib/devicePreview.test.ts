import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DevicePreview, frameSecond } from './devicePreview.ts';

/* `blob:` URLs do not exist in Node, and what matters is that one is made per
   frame kept and given back per frame dropped — so they are counted. */
const made: string[] = [];
const revoked: string[] = [];
(globalThis as { URL: typeof URL }).URL.createObjectURL = () => {
  const u = `blob:frame-${made.length}`;
  made.push(u);
  return u;
};
(globalThis as { URL: typeof URL }).URL.revokeObjectURL = (u: string) => { revoked.push(u); };

function fake(opts: { empty?: number[]; throws?: number[] } = {}): {
  reads: number[];
  make: () => Promise<{ init: () => Promise<{}>; readKeyframe: (t: number) => Promise<ArrayBuffer>; destroy: () => void }>;
} {
  const reads: number[] = [];
  return {
    reads,
    make: async () => ({
      init: async () => ({}),
      readKeyframe: async (t: number) => {
        reads.push(t);
        if (opts.throws?.includes(t) === true) throw new Error('no keyframe there');
        if (opts.empty?.includes(t) === true) return new ArrayBuffer(0);
        return new ArrayBuffer(16);
      },
      destroy: () => undefined,
    }),
  };
}

test('a second is snapped to the grid the decoder caches on', () => {
  assert.equal(frameSecond(0), 0);
  assert.equal(frameSecond(9.9), 0);
  assert.equal(frameSecond(10), 10);
  assert.equal(frameSecond(1116), 1110);
  /* Before the film starts is the film's start, not a negative second. */
  assert.equal(frameSecond(-4), 0);
});

test('a drag across one tile is one decode, not four hundred', async () => {
  const f = fake();
  const p = new DevicePreview('http://panel/movie.mkv', 100, f.make);
  const seen = new Set<string | null>();
  for (let t = 600; t < 610; t += 0.05) seen.add(await p.frameAt(t));
  assert.equal(f.reads.length, 1);
  assert.equal(seen.size, 1);
  p.close();
});

test('and a second that has no picture is not asked about twice', async () => {
  const f = fake({ empty: [300] });
  const p = new DevicePreview('http://panel/movie.mkv', 100, f.make);
  assert.equal(await p.frameAt(300), null);
  assert.equal(await p.frameAt(305), null);
  assert.deepEqual(f.reads, [300]);
  p.close();
});

test('a decoder that throws is a card with no picture, not a failure', async () => {
  const f = fake({ throws: [10] });
  const p = new DevicePreview('http://panel/movie.mkv', 100, f.make);
  assert.equal(await p.frameAt(12), null);
  p.close();
});

test('a film that cannot be opened at all answers null and stays quiet', async () => {
  const p = new DevicePreview('http://panel/movie.mkv', 100, async () => null);
  assert.equal(await p.frameAt(10), null);
  p.close();
});

test('frames are given back when there are too many to keep', async () => {
  const f = fake();
  const p = new DevicePreview('http://panel/movie.mkv', 100, f.make);
  const before = revoked.length;
  for (let i = 0; i < 70; i += 1) await p.frameAt(i * 10);
  assert.equal(f.reads.length, 70);
  /* Sixty-four kept, so six let go of — about two megabytes held, measured at
     roughly thirty kilobytes a frame. */
  assert.equal(revoked.length - before, 6);
  p.close();
});

test('closing gives back every frame it is holding', async () => {
  const f = fake();
  const p = new DevicePreview('http://panel/movie.mkv', 100, f.make);
  await p.frameAt(10);
  await p.frameAt(20);
  const before = revoked.length;
  p.close();
  assert.equal(revoked.length - before, 2);
  /* And answers nothing afterwards rather than reopening a worker. */
  assert.equal(await p.frameAt(10), null);
});

test('one decode at a time, however fast the pointer moves', async () => {
  let inside = 0;
  let most = 0;
  const p = new DevicePreview('http://panel/movie.mkv', 100, async () => ({
    init: async () => ({}),
    readKeyframe: async () => {
      inside += 1;
      most = Math.max(most, inside);
      await new Promise((r) => { setTimeout(r, 2); });
      inside -= 1;
      return new ArrayBuffer(16);
    },
    destroy: () => undefined,
  }));
  await Promise.all([0, 10, 20, 30, 40].map((t) => p.frameAt(t)));
  assert.equal(most, 1);
  p.close();
});
