import { test } from 'node:test';
import { doorIsAnswering } from './playerCore.ts';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DeviceFilm, deviceFilmPossible, libavWorkerUrl, readRange } from './deviceFilm.ts';

/*
 * The arithmetic that decided whether a film had a seek bar.
 *
 * `output.duration ?? input.duration` reads as "the output's, or the input's",
 * and is not: `??` falls through on null and undefined, and the remuxer
 * reports the OUTPUT duration as 0 — a fragmented mp4 does not know its own
 * length until it ends — while the input carries the container's real one.
 * Zero is not null, so the expression took zero, the snapshot got no length,
 * and a film played with no way to move inside it.
 */
const pick = (out: number | undefined, input: number | undefined): number =>
  Math.max(out ?? 0, input ?? 0);

test('a zero from the muxer does not beat a real length from the file', () => {
  assert.equal(pick(0, 1800), 1800);
});

test('and the wrong operator would have', () => {
  /* Kept as a test rather than a comment: it is the exact shape of the bug,
     and it reads as correct to anyone who has not seen the measurement. */
  assert.equal(0 ?? 1800, 0);
});

test('either one alone is taken', () => {
  assert.equal(pick(2612, 0), 2612);
  assert.equal(pick(undefined, 990), 990);
  assert.equal(pick(0, 0), 0);
  assert.equal(pick(undefined, undefined), 0);
});

test('a browser without the pieces is not offered the path', () => {
  /* Node has WebAssembly but neither MediaSource nor a DOM Worker, which is
     the same shape as a 2020 television browser: the check must say no rather
     than throw on a missing global. */
  assert.equal(deviceFilmPossible(), false);
});

/* ── who may even try ──────────────────────────────────────────────────── */

/**
 * The detect that keeps a 2020 television out of this path.
 *
 * A browser without module workers IGNORES `{ type: 'module' }` rather than
 * refusing it, so the only signal is whether it LOOKS at the option. Both
 * halves are asserted, because the failure mode of getting this backwards is
 * silent: a worker that loads an ES module as a classic script never answers
 * and never throws.
 */
test('module-worker support is read from whether the option is looked at', () => {
  const asked = { modern: false, old: false };
  /* A modern engine reads `type`. */
  class Modern {
    constructor(_url: string, opts?: WorkerOptions) { void opts?.type; }
    terminate(): void {}
  }
  /* Chromium 68 does not know the option exists. */
  class Old {
    constructor(_url: string, _opts?: WorkerOptions) {}
    terminate(): void {}
  }
  const detect = (W: unknown): boolean => {
    let read = false;
    const opts = { get type() { read = true; return 'module'; } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = new (W as any)('data:text/javascript,', opts);
    w.terminate();
    return read;
  };
  asked.modern = detect(Modern);
  asked.old = detect(Old);
  assert.equal(asked.modern, true);
  assert.equal(asked.old, false, 'an engine that ignores the option was read as supporting it');
});

test('a packaged build never chooses this path', () => {
  /* Tizen, webOS and the Android app do not carry the wasm — see
     `scripts/libav-assets.mjs`. Choosing the path there would fail on a chunk
     that is not in the bundle and tell somebody in front of a television that
     the film needs the TV app. */
  const src = readFileSync(new URL('./deviceFilm.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function deviceFilmPossible'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /VITE_PACKAGED/);
  assert.ok(
    body.indexOf('VITE_PACKAGED') < body.indexOf('WebAssembly'),
    'the package check must come first — the others all pass on a television',
  );
});

/* ── the page downloads, so the page has to say so ──────────────────────── */

/**
 * The watchdog that walked away from a working film.
 *
 * `doorIsAnswering` is the player's rule for "is this server saying anything",
 * and it was written for the element: `lastByteAt` is the element's `progress`
 * event. On the device path the element loads nothing, so all three of its
 * inputs stay at zero however much the page is downloading — and the player
 * concludes the door is dead, walks to the next one, and tears down the worker
 * mid-read. Measured against the owner's line: the remuxer read 7.5 MB and
 * opened a 2.38 GB film on the very doors the app then called dead.
 */
test('a door the PAGE is downloading from counts as answering', () => {
  const now = 10_000;
  /* What the device path looks like before anything is appended: no readyState,
     no buffered range, and bytes that arrived a moment ago. */
  assert.equal(doorIsAnswering(0, 0, now - 500, now), true);
  /* And what it looked like before `onBytes` existed — the bug. */
  assert.equal(doorIsAnswering(0, 0, 0, now), false);
});

test('bytes that stopped arriving still fail the door', () => {
  const now = 100_000;
  assert.equal(doorIsAnswering(0, 0, now - 60_000, now), false);
});


/* ── progress has to arrive at the rate the watchdog expects ────────────── */

/**
 * The door watchdog asks "has anything arrived lately". For the `<video>`
 * element that is `progress`, which fires continuously while bytes land. This
 * path reported ONCE per read, and a read is 2.5 MB — measured at 8.74s on the
 * owner's connection, against a nine-second deadline. The player abandoned a
 * door that was downloading perfectly and pulled the same 2.5 MB from the next
 * one, three times over.
 */
test('a read says so on every piece that lands, not once at the end', async () => {
  const chunks = [64_000, 64_000, 64_000, 64_000, 12_345];
  const had = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ 'content-type': 'video/x-matroska' }),
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => (i < chunks.length
            ? { done: false, value: new Uint8Array(chunks[i++] ?? 0) }
            : { done: true, value: undefined }),
        };
      },
    },
  })) as unknown as typeof fetch;
  try {
    let told = 0;
    const film = new DeviceFilm({
      url: 'http://panel.example/movie.mkv',
      note: () => undefined,
      onBytes: () => { told += 1; },
      onRefused: () => undefined,
      onRanges: () => undefined,
      onDuration: () => undefined,
      onTracks: () => undefined,
      onImpossible: () => undefined,
    });
    const got = await (film as unknown as {
      readOnce: (o: number, s: number) => Promise<ArrayBuffer>;
    }).readOnce(0, 2_621_440);
    assert.equal(got.byteLength, chunks.reduce((a, b) => a + b, 0), 'the pieces were not joined');
    assert.equal(told, chunks.length, `told ${told} times for ${chunks.length} pieces`);
    /* A fresh buffer: the library TRANSFERS what it is handed, so a view onto
       anything we keep would be detached under us. */
    assert.ok(got instanceof ArrayBuffer);
  } finally {
    globalThis.fetch = had;
  }
});

test('and a door that answers with nothing is never called progress', async () => {
  const had = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ 'content-type': 'video/x-matroska' }),
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  })) as unknown as typeof fetch;
  try {
    let told = 0;
    const film = new DeviceFilm({
      url: 'http://panel.example/movie.mkv',
      note: () => undefined,
      onBytes: () => { told += 1; },
      onRefused: () => undefined,
      onRanges: () => undefined,
      onDuration: () => undefined,
      onTracks: () => undefined,
      onImpossible: () => undefined,
    });
    const got = await (film as unknown as {
      readOnce: (o: number, s: number) => Promise<ArrayBuffer>;
    }).readOnce(0, 1024);
    assert.equal(got.byteLength, 0);
    assert.equal(told, 0, 'an empty answer was reported as progress');
  } finally {
    globalThis.fetch = had;
  }
});

/**
 * A short read is the transport's problem to finish.
 *
 *     [mov,mp4,m4a] stream 0, offset 0x2800221: partial file
 *     [mov,mp4,m4a] reached eof, corrupted STTS atom
 *
 * Forty megabytes into the owner's film: an edge closed early, the read came
 * back short, and ffmpeg — which cannot tell a dropped connection from the end
 * of a file — called a perfectly good film corrupt.
 */
test('a read that comes back short is finished, not handed on', async () => {
  const served: { offset: number; size: number }[] = [];
  const had = globalThis.fetch;
  /* The line gives 1000 bytes at a time however much is asked for. */
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range ?? '');
    const from = Number(m?.[1] ?? 0);
    const to = Number(m?.[2] ?? 0);
    served.push({ offset: from, size: to - from + 1 });
    const give = Math.min(1000, to - from + 1);
    let sent = false;
    return {
      ok: true,
      status: 206,
      headers: new Headers({ 'content-type': 'video/x-matroska' }),
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true, value: undefined }
            : ((sent = true), { done: false, value: new Uint8Array(give) })),
        }),
      },
    };
  }) as unknown as typeof fetch;
  try {
    const film = new DeviceFilm({
      url: 'http://panel.example/movie.mkv',
      note: () => undefined,
      onBytes: () => undefined,
      onRefused: () => undefined,
      onRanges: () => undefined,
      onDuration: () => undefined,
      onTracks: () => undefined,
      onImpossible: () => undefined,
    });
    const got = await (film as unknown as {
      read: (o: number, s: number) => Promise<ArrayBuffer>;
    }).read(5000, 3000);
    assert.equal(got.byteLength, 3000, 'the caller was handed a short buffer');
    /* Each continuation asks for exactly what is still missing, from where it
       stopped — not the whole range again. */
    assert.deepEqual(served, [
      { offset: 5000, size: 3000 },
      { offset: 6000, size: 2000 },
      { offset: 7000, size: 1000 },
    ]);
  } finally {
    globalThis.fetch = had;
  }
});

test('and a line that answers with nothing stops rather than looping', async () => {
  let asked = 0;
  const had = globalThis.fetch;
  globalThis.fetch = (async () => {
    asked += 1;
    return {
      ok: true,
      status: 206,
      headers: new Headers({ 'content-type': 'video/x-matroska' }),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  }) as unknown as typeof fetch;
  try {
    let warned = '';
    const film = new DeviceFilm({
      url: 'http://panel.example/movie.mkv',
      note: (t) => { warned = t; },
      onBytes: () => undefined,
      onRefused: () => undefined,
      onRanges: () => undefined,
      onDuration: () => undefined,
      onTracks: () => undefined,
      onImpossible: () => undefined,
    });
    const got = await (film as unknown as {
      read: (o: number, s: number) => Promise<ArrayBuffer>;
    }).read(0, 4096);
    assert.equal(got.byteLength, 0);
    assert.equal(asked, 1, 'an empty answer was retried instead of stopping');
    assert.match(warned, /0 of 4096/);
  } finally {
    globalThis.fetch = had;
  }
});

/**
 * A refusal is not a piece of the film.
 *
 * XUI turns down an over-limit range with a 200 and a sentence. Taken as data,
 * that sentence went to ffmpeg as the film at that offset — "Packet corrupt",
 * "Invalid NAL unit size" — and the rest of the read was asked for at once,
 * over and over: seven hundred requests in three seconds on the rig.
 */
function lineThatRefuses(refusals: number, how: 'sentence' | 509) {
  const seen: number[] = [];
  const fake = (async (_url: string, init: { headers: Record<string, string> }) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range ?? '');
    const size = Number(m?.[2] ?? 0) - Number(m?.[1] ?? 0) + 1;
    seen.push(Date.now());
    if (seen.length <= refusals) {
      return how === 509
        ? new Response('', { status: 509 })
        : new Response('MAX CONNECTIONS REACHED\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(new Uint8Array(size), { status: 206, headers: { 'content-type': 'video/mp4' } });
  }) as unknown as typeof fetch;
  return { fake, seen };
}

for (const how of ['sentence', 509] as const) {
  test(`a refused read (${how}) waits and asks again, and hands on only the film`, async () => {
    const had = globalThis.fetch;
    const { fake, seen } = lineThatRefuses(2, how);
    globalThis.fetch = fake;
    try {
      const got = await readRange('http://panel.example/movie.mp4', 4096, 1000);
      assert.equal(got.byteLength, 1000);
      assert.ok(new Uint8Array(got).every((b) => b === 0), 'the refusal text was handed on as film');
      assert.equal(seen.length, 3);
      /* Paused between asks rather than asking again at once. */
      assert.ok(seen[1]! - seen[0]! >= 350, `asked again after ${seen[1]! - seen[0]!} ms`);
    } finally {
      globalThis.fetch = had;
    }
  });
}

test('a 200 for the first byte is the whole file, and only what was asked for is kept', async () => {
  const had = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(50_000).fill(7), {
    status: 200, headers: { 'content-type': 'video/mp4' },
  })) as unknown as typeof fetch;
  try {
    const got = await readRange('http://panel.example/movie.mp4', 0, 1000);
    assert.equal(got.byteLength, 1000);
  } finally {
    globalThis.fetch = had;
  }
});

test('one request asks for about a second and a half of the line, not 2.5 MB regardless', async () => {
  const sizes: number[] = [];
  const had = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range ?? '');
    const size = Number(m?.[2] ?? 0) - Number(m?.[1] ?? 0) + 1;
    sizes.push(size);
    return new Response(new Uint8Array(size), { status: 206, headers: { 'content-type': 'video/mp4' } });
  }) as unknown as typeof fetch;
  try {
    const film = new DeviceFilm({
      url: 'http://panel.example/movie.mp4',
      note: () => undefined, onBytes: () => undefined, onRefused: () => undefined, onRanges: () => undefined,
      onDuration: () => undefined, onTracks: () => undefined, onImpossible: () => undefined,
    });
    const f = film as unknown as { read: (o: number, s: number) => Promise<ArrayBuffer>; rate: number; seeksWaiting: number };
    /* The owner's measured line: 300 kB a second. */
    f.rate = 300_000;
    const got = await f.read(0, 2_621_440);
    assert.equal(sizes[0], 450_000);
    /* Short, and legal: ffmpeg asks again for the rest. */
    assert.equal(got.byteLength, 450_000);
    /* A seek waiting behind this pass: sips. */
    f.seeksWaiting = 1;
    await f.read(0, 2_621_440);
    assert.equal(sizes[1], 64 * 1024);
  } finally {
    globalThis.fetch = had;
  }
});

/* ── the libav.js worker the page starts ────────────────────────────────── */

test('the worker address carries the build, so a stale copy is never reused', () => {
  const a = libavWorkerUrl('https://app.example', '1.62.0');
  const b = libavWorkerUrl('https://app.example', '1.63.0');
  assert.equal(a, 'https://app.example/libav/libav-streamix.wasm.mjs?v=1.62.0');
  assert.notEqual(a, b);
});

test('the shipped files are the ones the page asks for', () => {
  /* The page imports the front end, starts the worker and fetches the wasm by
     these names; the asset copier ships exactly these. */
  const copier = readFileSync(new URL('../../scripts/libav-assets.mjs', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./deviceFilm.ts', import.meta.url), 'utf8');
  for (const name of ['libav-streamix.mjs', 'libav-streamix.wasm.mjs', 'libav-streamix.wasm.wasm']) {
    assert.ok(copier.includes(`'${name}'`), `${name} is not copied`);
    assert.ok(page.includes(name), `${name} is not used by the page`);
  }
});

test('nothing in the player still reaches for the unlicensed remuxer', () => {
  for (const file of ['deviceFilm.ts', 'devicePreview.ts', 'filmSubs.ts', 'libavRemux.ts', 'libavThumb.ts']) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(!/libav-wasm/.test(src), `${file} still mentions libav-wasm`);
  }
});
