import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragmentStart, trackTimescales } from './mp4Time.ts';

/** Build one box: four bytes of length, four of name, then the payload. */
function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.flatMap((p) => Array.from(p));
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number): number[] => [...u32(Math.floor(n / 4294967296)), ...u32(n >>> 0)];
const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);

/** A moov naming one track: id 1, ninety thousand units to the second. */
function init(id = 1, scale = 90_000): Uint8Array {
  const tkhd = box('tkhd', [0, 0, 0, 0], zeros(8), u32(id), zeros(60));
  const mdhd = box('mdhd', [0, 0, 0, 0], zeros(8), u32(scale), zeros(8));
  return box('moov', box('trak', tkhd, box('mdia', mdhd)));
}

/** A fragment claiming to start at `units` on that track's own clock. */
function frag(units: number, id = 1, version = 1): Uint8Array {
  const tfhd = box('tfhd', [0, 0, 0, 0], u32(id));
  const tfdt = version === 1
    ? box('tfdt', [1, 0, 0, 0], u64(units))
    : box('tfdt', [0, 0, 0, 0], u32(units));
  return new Uint8Array([...box('moof', box('traf', tfhd, tfdt)), ...box('mdat', zeros(4))]);
}

test('reads a track id and its timescale out of the init segment', () => {
  const scales = trackTimescales(init(2, 48_000));
  assert.deepEqual([...scales.entries()], [[2, 48_000]]);
});

test('a fragment says which second of its own clock it starts at', () => {
  const found = fragmentStart(frag(90_000 * 40), trackTimescales(init()));
  assert.equal(found?.seconds, 40);
});

test('and says it the same way when the time is only 32 bits', () => {
  const found = fragmentStart(frag(90_000 * 40, 1, 0), trackTimescales(init()));
  assert.equal(found?.seconds, 40);
});

/**
 * The measurement this file exists for: film-second 1140 arriving as
 * output-second 40, which without a shift is written over the film's opening.
 */
test('the shift is the difference between the two clocks', () => {
  const found = fragmentStart(frag(90_000 * 40), trackTimescales(init()));
  assert.equal(1140 - (found?.seconds ?? 0), 1100);
});

test('a clock that already agrees needs no shift at all', () => {
  const found = fragmentStart(frag(90_000 * 1140), trackTimescales(init()));
  assert.equal(1140 - (found?.seconds ?? 0), 0);
});

test('a fragment carrying a fresh moov brings its own timescales', () => {
  const rebuilt = new Uint8Array([...init(1, 1_000), ...frag(1_000 * 40)]);
  const found = fragmentStart(rebuilt, new Map());
  assert.equal(found?.seconds, 40);
  assert.equal(found?.scales.get(1), 1_000);
});

test('a piece that does not say comes back as nothing, not as zero', () => {
  assert.equal(fragmentStart(box('mdat', zeros(8)), trackTimescales(init())), null);
  /* A track the init segment never named: a timescale guessed here would put
     the film at the wrong second, which is the bug this replaced. */
  assert.equal(fragmentStart(frag(90_000, 9), trackTimescales(init())), null);
});

test('a truncated box stops the walk instead of reading past it', () => {
  const short = frag(90_000 * 40).slice(0, 20);
  assert.equal(fragmentStart(short, trackTimescales(init())), null);
  assert.deepEqual([...trackTimescales(init().slice(0, 12)).entries()], []);
});

test('a sixty-four bit box length is read from the right place', () => {
  const inner = box('mdat', zeros(4));
  const large = new Uint8Array(16 + inner.length);
  const v = new DataView(large.buffer);
  v.setUint32(0, 1);
  for (let i = 0; i < 4; i += 1) large[4 + i] = 'free'.charCodeAt(i);
  v.setUint32(8, 0);
  v.setUint32(12, large.length);
  large.set(inner, 16);
  const stream = new Uint8Array([...large, ...frag(90_000 * 40)]);
  assert.equal(fragmentStart(stream, trackTimescales(init()))?.seconds, 40);
});
