/**
 * What `XtreamClient` puts on the wire: the panel url exactly as `apiUrl`
 * builds it, fetched directly, and error labels that name the real panel path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XtreamClient } from '../src/client.ts';

type Fetch = typeof globalThis.fetch;

async function withFetch(stub: Fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    /* In a `finally` so a leaked stub fails the next test to run, not this one
       — same reasoning as `hosts.test.ts`'s copy of this helper. */
    globalThis.fetch = real;
  }
}

const AUTH_OK = JSON.stringify({
  user_info: { auth: 1, status: 'Active', active_cons: 0, max_connections: 1 },
  server_info: { url: 'panel.test', timezone: 'UTC' },
});

function okResponse(): Response {
  return { ok: true, status: 200, text: () => Promise.resolve(AUTH_OK) } as unknown as Response;
}

test('the client fetches the panel url directly', async () => {
  const requested: string[] = [];
  const f = ((url: string | URL) => {
    requested.push(String(url));
    return Promise.resolve(okResponse());
  }) as unknown as Fetch;

  await withFetch(f, async () => {
    const client = new XtreamClient({ serverUrl: 'http://panel.test', username: 'alice', password: 'p@ss' });
    await client.authenticate();
    assert.equal(requested.length, 1);
    assert.equal(requested[0], 'http://panel.test/player_api.php?username=alice&password=p%40ss');
  });
});

test('an HTTP error label names the real panel path', async () => {
  const f = (() => Promise.resolve({
    ok: false,
    status: 404,
    text: () => Promise.resolve('<html>not json</html>'),
  } as unknown as Response)) as unknown as Fetch;

  await withFetch(f, async () => {
    const client = new XtreamClient({
      serverUrl: 'http://panel.test',
      username: 'alice',
      password: 'pass',
      maxRetries: 0,
    });
    await assert.rejects(
      () => client.authenticate(),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        /* The path a viewer or a log sees says what actually failed. */
        assert.match(msg, /\/player_api\.php/);
        return true;
      },
    );
  });
});
