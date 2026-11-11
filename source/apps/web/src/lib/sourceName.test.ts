import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceName } from './sourceName.ts';

test('a typed name is kept', () => {
  assert.equal(sourceName('  Living room ', 'http://panel.example.com/', 'xtream'), 'Living room');
});

test('no name: the host, never the query', () => {
  assert.equal(sourceName('', 'http://panel.example.com:8080/get.php?username=a&password=SECRET', 'm3u'), 'panel.example.com:8080');
  assert.equal(sourceName(undefined, 'https://www.panel.example.com', 'xtream'), 'panel.example.com');
  assert.equal(sourceName('', 'http://portal.example.com/c/', 'stalker'), 'portal.example.com');
});

test('a single stream is named by its last path segment, else its host', () => {
  assert.equal(sourceName('', 'http://stream.example.com/live/news-one.m3u8?token=x', 'stream'), 'news-one');
  assert.equal(sourceName('', 'http://stream.example.com/live/index.m3u8', 'stream'), 'stream.example.com');
  assert.equal(sourceName('', 'http://stream.example.com/', 'stream'), 'stream.example.com');
});

test('a repeat gets a number, and junk falls back to the type', () => {
  assert.equal(sourceName('', 'http://panel.example.com/a.m3u', 'm3u', ['panel.example.com']), 'panel.example.com 2');
  assert.equal(sourceName('', 'http://panel.example.com/a.m3u', 'm3u', ['panel.example.com', 'Panel.example.com 2']), 'panel.example.com 3');
  assert.equal(sourceName('', 'not an address', 'm3u'), 'Playlist');
});
