import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { aacConfig, av1Codec, avcCodec, hevcCodec, makeRemuxer } from './libavRemux.ts';
import { trackTimescales } from './mp4Time.ts';

/*
 * The codec strings handed to the Media Source, and the whole remux run for
 * real: libav.js is loaded in Node without a worker, from the same files the
 * page serves, and given a four-second Matroska (H.264 + 5.1 AC-3 + an SRT
 * track, 160x90) as a ranged reader.
 */

test('an avcC record names its codec as avc1.PPCCLL', () => {
  assert.equal(avcCodec(new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff]), 0, 0), 'avc1.64001f');
});

test('Annex B parameter sets are read for their profile and level', () => {
  const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x28, 0xaa]);
  assert.equal(avcCodec(sps, 0, 0), 'avc1.4d4028');
});

test('with nothing to read, the container profile and level stand in', () => {
  assert.equal(avcCodec(null, 100, 31), 'avc1.64001f');
});

test('an hvcC record becomes an hvc1 string', () => {
  /* Main profile, level 4.0 (120), the usual compatibility flags. */
  const hvcc = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120]);
  assert.equal(hevcCodec(hvcc, 0, 0), 'hvc1.1.6.L120.90');
});

test('an av1C record becomes an av01 string', () => {
  assert.equal(av1Codec(new Uint8Array([0x81, 0x08, 0x0c, 0])), 'av01.0.08M.08');
});

test('the AAC-LC config for 48 kHz stereo is the two bytes everyone knows', () => {
  assert.deepEqual([...aacConfig(48000, 2)], [0x11, 0x90]);
  assert.deepEqual([...aacConfig(44100, 6)], [0x12, 0x30]);
});

async function boot(bytes: Uint8Array) {
  const dist = new URL('../../libav/dist/', import.meta.url);
  const { default: LibAV } = await import(new URL('libav-streamix.mjs', dist).href) as { default: any };
  const libav = await LibAV.LibAV({
    noworker: true,
    toImport: new URL('libav-streamix.wasm.mjs', dist).href,
    wasmurl: pathToFileURL(new URL('libav-streamix.wasm.wasm', dist).pathname).href,
  });
  const reads: [number, number][] = [];
  const remuxer = await makeRemuxer({
    libav,
    length: bytes.length,
    bufferSize: 64 * 1024,
    read: async (offset, size) => {
      reads.push([offset, size]);
      return bytes.slice(offset, Math.min(bytes.length, offset + size)).buffer;
    },
  });
  return { remuxer, reads };
}

test('a Matroska with AC-3 comes out as fragmented MP4 with AAC, and seeks', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tiny-h264-ac3.mkv', import.meta.url)));
  const { remuxer, reads } = await boot(bytes);
  try {
    const init = await remuxer.init();
    assert.match(init.info.output.videoMimeType, /^avc1\.[0-9a-f]{6}$/);
    assert.equal(init.info.output.audioMimeType, 'mp4a.40.2', 'AC-3 must leave as AAC');
    assert.ok(init.info.input.duration > 3.5 && init.info.input.duration < 4.5);
    assert.deepEqual(init.audioStreams.map((a) => a.language), ['eng']);
    assert.deepEqual(init.subtitles.map((s) => s.language), ['eng']);
    const scales = trackTimescales(init.data);
    assert.equal(scales.size, 2, 'the init segment should carry a video and an audio track');
    assert.equal(String.fromCharCode(...init.data.slice(4, 8)), 'ftyp');

    const seen: string[] = [];
    const lines: string[] = [];
    let n = 0;
    for (;;) {
      const c = await remuxer.read();
      if (c === null || c.finished === true) break;
      n += 1;
      if (n === 1) assert.equal(c.restart, true, 'the first fragment of a pass says so');
      else assert.notEqual(c.restart, true);
      seen.push(String.fromCharCode(...c.data.slice(4, 8)));
      for (const s of c.subtitles ?? []) lines.push(s.content.trim());
    }
    assert.ok(n >= 1, `expected a fragment, got ${n}`);
    assert.ok(seen.every((t) => t === 'moof'), `a fragment began with ${seen.join(',')}`);
    assert.ok(lines.some((l) => l.includes('Hello')), `subtitle lines: ${JSON.stringify(lines)}`);
    /* Only what was asked for was read: nothing past the end of the file. */
    assert.ok(reads.every(([o]) => o < bytes.length));

    const moved = await remuxer.seek(2.2);
    assert.ok(moved !== null && moved.finished !== true);
    assert.equal(moved.restart, true, 'a seek starts a new pass');
    /* A keyframe at or before the target, and not the film's start. */
    assert.ok(moved.pts > 0.5 && moved.pts <= 2.2, `seek landed at ${moved.pts}`);
  } finally {
    await remuxer.destroy();
  }
});

test('a picture no browser decodes is refused by name, from init', async () => {
  /* Matroska with MPEG-4 part 2, made by hand: only the header is read. */
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tiny-mpeg4.mkv', import.meta.url)));
  const { remuxer } = await boot(bytes);
  try {
    await assert.rejects(() => remuxer.init(), /mpeg4/);
  } finally {
    await remuxer.destroy();
  }
});
