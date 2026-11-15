/**
 * Switches an operator sets once, for every television on the installation.
 *
 * The value comes from the config document that `UpdateGate` reads
 * (lib/appConfig.ts): fetched at boot, and again when the app comes back to
 * the front after six hours, so a change reaches a television that is already
 * switched on without waiting for a restart it may not get for weeks.
 */
import { subscribeAppConfig } from './appConfig.ts';

/* See `deviceRelayOff` in apps/server/src/admin.ts. On unless the operator
   says otherwise, including before any config has arrived. */
let relayOff = false;

/** Read the flags out of a config body. Exported for the tests. */
export function readOperatorFlags(raw: unknown): { deviceRelayOff: boolean } {
  if (raw === null || typeof raw !== 'object') return { deviceRelayOff: false };
  const r = raw as { deviceRelayOff?: unknown };
  return { deviceRelayOff: r.deviceRelayOff === true };
}

/** May the native player route films through the device's own relay? */
export function deviceRelayAllowed(): boolean {
  return !relayOff;
}

/** Apply a config body. Read on the next load; nothing on screen depends on it. */
export function applyOperatorConfig(raw: unknown): void {
  relayOff = readOperatorFlags(raw).deviceRelayOff;
}

let listening = false;

/** Start following the config document. Idempotent; safe to call from anywhere. */
export function watchOperatorFlags(): void {
  if (listening) return;
  listening = true;
  subscribeAppConfig(applyOperatorConfig);
}

/** For tests only — a module-level flag must not leak between them. */
export function resetOperatorFlags(): void {
  relayOff = false;
}
