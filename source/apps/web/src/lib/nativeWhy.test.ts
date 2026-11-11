import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWhy } from './nativeWhy.ts';

/**
 * "native: error" has to say which kind of failure it was.
 *
 * libVLC's `EncounteredError` carries no message, so for months the app's entire
 * account of a failed film was the word "error". That is not a diagnosis: it
 * cannot tell a stream that never delivered a byte from one the decoder refused,
 * and the two need opposite fixes. The cost was real — an ordinary 1080p H.264
 * film was chased as a 4K decoder problem because the hint said so and the log
 * could not contradict it.
 */

test('no bytes at all is a delivery failure, not a codec one', () => {
  const got = nativeWhy({ readBytes: 0, demuxReadBytes: 0, decodedVideo: 0 });
  assert.match(got, /nothing arrived/);
});

test('bytes in, no frames out, is the decoder', () => {
  const got = nativeWhy({
    readBytes: 4_194_304, demuxReadBytes: 4_100_000, decodedVideo: 0,
  });
  assert.match(got, /decoder refused it/);
  assert.match(got, /4\.0 MB read/);
});

test('bytes in and nothing demuxed is not the decoder', () => {
  const got = nativeWhy({ readBytes: 65_536, demuxReadBytes: 0, decodedVideo: 0 });
  assert.match(got, /demuxer accepted none/);
  assert.doesNotMatch(got, /decoder/);
});

test('corruption is named ahead of everything else', () => {
  /* A damaged file also demuxes nothing and decodes nothing, so the corruption
     count has to be read first or it is never reported. */
  const got = nativeWhy({
    readBytes: 1_048_576, demuxReadBytes: 0, demuxCorrupted: 7, decodedVideo: 0,
  });
  assert.match(got, /7 corrupted block/);
});

test('frames decoded and then a stop is a mid-film failure', () => {
  const got = nativeWhy({ readBytes: 20_971_520, demuxReadBytes: 20_000_000, decodedVideo: 480 });
  assert.match(got, /480 frame\(s\) decoded, then it stopped/);
});

test('an older plugin that sends no counters says so rather than guessing', () => {
  assert.match(nativeWhy({}), /older player plugin/);
});
