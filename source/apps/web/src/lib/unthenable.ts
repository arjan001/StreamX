/**
 * A plain object over a Capacitor plugin proxy, because the proxy is a thenable
 * by accident.
 *
 * `registerPlugin` returns a Proxy whose `get` turns EVERY property into a
 * native method call — `then` included. Return that proxy from an async
 * function, or `await` it, and the promise machinery does what it does with
 * anything carrying a `then`: it calls `proxy.then(resolve, reject)`. That
 * becomes a native call to a method named `then`, which no plugin implements, so
 * it rejects with "<Plugin>.then() is not implemented on android" — as an
 * UNHANDLED rejection, with `resolve` never called. Whoever was awaiting waits
 * for ever, and the failure names a method nobody wrote.
 *
 * ── it has now cost two features, which is why it lives here ──
 *
 * Measured 2026-09-05: every channel in the APK sat on "opening…" because
 * `tryNative` awaited `nativeEngine()` and it never came back. Fixed there, in
 * `nativePlayer.ts`, where the helper then stayed — private to the player.
 *
 * Measured again 2026-09-08, from the owner's own debug overlay:
 *
 *   03:34:32.426  page    unhandled rejection: Error:
 *                         "StreamixListen.then() is not implemented on android"
 *   03:34:33.954  native  plugin answered — libVLC available
 *
 * The same trap applies to any plugin proxy written the obvious way — `await
 * candidate.info(); return candidate;` — because returning a proxy from an async
 * function is the trap itself.
 *
 * A shared module rather than a copy, so the next plugin cannot rediscover it.
 * The proxy never leaves this function: callers get an ordinary object whose
 * methods forward to it, and `then` is not one of them.
 */
export function unthenable<T extends object>(p: T, methods: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const m of methods) {
    /* Read at CALL time, not now: the proxy manufactures a fresh function per
       access, and capturing one here would pin whatever the first read returned. */
    out[m] = (...args: unknown[]) =>
      (p as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!(...args);
  }
  return out as unknown as T;
}
