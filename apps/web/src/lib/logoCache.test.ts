import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logoSource } from './logoCache.ts';

test('a logo drawn through the resizer is downloaded from its own host', () => {
  assert.equal(logoSource('https://wsrv.nl/?url=http%3A%2F%2F203.0.113.10%2Fimages%2F978715.png&w=112&we'),
    'http://203.0.113.10/images/978715.png');
  assert.equal(logoSource('https://wsrv.nl/?url=cdn.example.com/a.png&w=112'), 'http://cdn.example.com/a.png');
  assert.equal(logoSource('https://wsrv.nl/?url=//cdn.example.com/a.png'), 'http://cdn.example.com/a.png');
  /* The app's own native address for a plain-http picture. */
  assert.equal(logoSource('https://localhost/_img?u=http%3A%2F%2F172.17.0.1%3A7531%2Flogo%2F1.png'), 'http://172.17.0.1:7531/logo/1.png');
  /* Anything else is fetched as it is asked for. */
  assert.equal(logoSource('https://image.tmdb.org/t/p/w92/x.png'), 'https://image.tmdb.org/t/p/w92/x.png');
  assert.equal(logoSource('not a url'), 'not a url');
});
