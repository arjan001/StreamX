import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateOnce } from './logRotate.ts';

const dir = mkdtempSync(join(tmpdir(), 'rot-'));
const lines = (n: number): string =>
  `${Array.from({ length: n }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(180)}"}`).join('\n')}\n`;

function fixture(name: string, n: number): string {
  const p = join(dir, name);
  writeFileSync(p, lines(n));
  return p;
}

test('a log under the ceiling is left completely alone', async () => {
  const p = fixture('small.log', 10);
  const before = readFileSync(p, 'utf8');
  assert.equal(await rotateOnce(p, 1_000_000, 1_000), null);
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('a log over the ceiling is cut down to its tail', async () => {
  const p = fixture('big.log', 5_000);
  const was = statSync(p).size;
  const did = await rotateOnce(p, 100_000, 20_000);
  assert.ok(did !== null);
  assert.equal(did.was, was);
  assert.ok(statSync(p).size <= 20_000, 'still over the keep size');
  assert.ok(statSync(p).size > 10_000, 'cut far more than it was asked to');
});

test('and what is left is the END of it, not the beginning', async () => {
  const p = fixture('tail.log', 5_000);
  await rotateOnce(p, 100_000, 20_000);
  const txt = readFileSync(p, 'utf8');
  assert.ok(txt.includes('"n":4999'), 'the newest line is gone');
  assert.ok(!txt.includes('"n":0,'), 'the oldest line survived');
});

/**
 * The property that matters to anything reading the file: a log that begins
 * halfway through a JSON object makes the first line unparseable, and the
 * tools that read these logs parse line by line.
 */
test('it never leaves the file opening mid-line', async () => {
  const p = fixture('whole.log', 5_000);
  await rotateOnce(p, 100_000, 20_003);
  const txt = readFileSync(p, 'utf8');
  assert.equal(txt[0], '{');
  for (const line of txt.split('\n').filter((l) => l !== '')) JSON.parse(line);
});

test('a file that is not there is not an error', async () => {
  assert.equal(await rotateOnce(join(dir, 'nothing.log'), 10, 5), null);
});

/**
 * The reason this truncates instead of renaming: pm2 holds the file open in
 * append mode, and an `O_APPEND` write goes to the current end whatever has
 * happened to the file underneath. A rename would leave pm2 writing to an
 * inode nobody can find and the new file empty until the next restart.
 */
test('a writer holding it open keeps writing to the same file', async () => {
  const p = fixture('held.log', 5_000);
  const fd = openSync(p, 'a');
  try {
    await rotateOnce(p, 100_000, 20_000);
    writeSync(fd, '{"after":true}\n');
  } finally {
    closeSync(fd);
  }
  const txt = readFileSync(p, 'utf8');
  assert.ok(txt.endsWith('{"after":true}\n'), 'the writer lost the file');
  assert.ok(txt.includes('"n":4999'), 'the tail it kept was thrown away');
});
