/**
 * The bridge to `StreamixDevicePlugin` — things about the SET.
 *
 * Two questions so far: which device this is, and how to stop the app outright
 * when the viewer says they want out.
 * Its own module for the same reason the plugin is its own class — neither has
 * anything to do with video, and `nativePlayer.ts` is 400 lines about libVLC.
 *
 * Loaded through Capacitor's registry rather than imported, so the web build
 * neither bundles it nor fails when it is absent — the same shape as
 * `nativeEngine` in `lib/nativePlayer.ts`, and for the same reasons, including
 * the proxy trap: `registerPlugin` hands back an object whether or not the Java
 * class exists, so the only honest test is a call the native side has to answer.
 */
import { unthenable } from './unthenable.ts';
import { dlog } from './debugLog.ts';
import { nativePluginsPossible } from './platform.ts';

export interface DevicePlugin {
  /**
   * End the app: out of recents, and the process gone.
   *
   * Resolves once the native side has written the preferences file out and
   * committed to leaving; the process ends a moment later, so nothing after the
   * await is guaranteed to run. Rejects on an APK built before the method existed
   * — live-reloaded JavaScript can be newer than the Java it is talking to — and
   * the caller has to say so rather than wait on a promise that means nothing.
   * Only from `ExitDialog`, and only after the page has shut itself down.
   */
  exitApp(): Promise<void>;
  /** Channel logos kept on the device — see LogoStore.java and lib/logoCache.ts. */
  logoPrefetch?(o: { urls: string[]; sources?: string[] }): Promise<{ queued: number }>;
  logoRetain?(o: { urls: string[] }): Promise<{ removed: number }>;
  logoStats?(): Promise<{ files: number; bytes: number; pending: number; done: number; failed: number }>;
  /**
   * Why the app went away last time, if it did.
   *
   * Empty on a healthy boot and on an APK built before this existed. Reading it
   * takes it — see `CrashNotes` — so the same death is never reported twice.
   */
  lastCrash?: () => Promise<{ note: string }>;
  /**
   * Which television this is — maker, model, Android version.
   *
   * Optional, because an install running an older APK does not have it and a
   * diagnostic that throws on old builds is worse than one that says less.
   * Nothing here identifies a person: it describes a product line, which is
   * exactly the granularity a "this brand refuses this stream" report needs.
   */
  hardware?: () => Promise<HardwareInfo>;
}

export interface HardwareInfo {
  manufacturer?: string;
  brand?: string;
  model?: string;
  device?: string;
  android?: string;
  sdk?: number;
  tv?: boolean;
}

/**
 * The box, in one line, for a report: `Hisense HE55A6000 (Android 11, TV)`.
 *
 * Pure so it can be pinned without a device — every branch here was a real shape
 * from some box or other: a maker that repeats itself in the model string
 * (`Xiaomi Xiaomi TV`), a model with no maker at all, a phone rather than a
 * television. Returns null when there is nothing worth printing, so a caller can
 * leave the row out rather than print "unknown".
 */
export function describeHardware(h: HardwareInfo | null): string | null {
  if (h === null) return null;
  const maker = (h.manufacturer ?? h.brand ?? '').trim();
  const model = (h.model ?? h.device ?? '').trim();
  /* A model that already begins with the maker's name reads as "Xiaomi Xiaomi
     TV A2" otherwise — several brands ship it that way. */
  const name = maker === '' ? model
    : model === '' ? maker
    : model.toLowerCase().startsWith(maker.toLowerCase()) ? model
    : `${maker} ${model}`;
  if (name === '') return null;
  const bits: string[] = [];
  if ((h.android ?? '') !== '') bits.push(`Android ${h.android}`);
  if (h.tv === true) bits.push('TV');
  return bits.length === 0 ? name : `${name} (${bits.join(', ')})`;
}

/**
 * The hardware line, remembered once so a sync caller can print it.
 *
 * `deviceSummary()` is synchronous — it is read while building an error card and
 * while drawing the debug panel — and this answer never changes for the life of
 * the install. Asked once on boot by `installDebugLog`, held here.
 */
let hardwareLine: string | null = null;

export function knownHardware(): string | null { return hardwareLine; }

export async function askHardware(): Promise<string | null> {
  if (hardwareLine !== null) return hardwareLine;
  const dev = await deviceInfo();
  if (dev?.hardware === undefined) return null;
  try {
    hardwareLine = describeHardware(await dev.hardware());
  } catch { /* an old plugin, or a box that refuses — the report says less */ }
  return hardwareLine;
}

let plugin: DevicePlugin | null = null;
let looked = false;

export async function deviceInfo(): Promise<DevicePlugin | null> {
  if (looked) return plugin;
  looked = true;
  if ((import.meta.env?.VITE_PLATFORM as string | undefined) !== 'capacitor') return null;
  /* iOS has no StreamixDevice; every method here is Android-only. */
  if (!nativePluginsPossible()) return null;
  try {
    const core = await import('@capacitor/core');
    if (!core.Capacitor.isNativePlatform()) return null;
    const candidate = core.registerPlugin<DevicePlugin>('StreamixDevice');
    /*
     * `hardware()` is the probe as well as the feature: it is a cheap read that
     * prompts nothing, and an APK built before this plugin existed rejects it.
     */
    await candidate.hardware?.();
    plugin = unthenable(candidate, METHODS);
    return plugin;
  } catch {
    /* No plugin, or an older APK without it. */
    return null;
  }
}

/* Only what is listed here is reachable through the wrapper: `hardware` was
   missing, so the report's device line was never filled in on any television. */
const METHODS = [
  'exitApp', 'lastCrash', 'hardware', 'logoPrefetch', 'logoRetain', 'logoStats',
] as const;

/**
 * Put the last death in this run's log, once.
 *
 * The debug log is the page's memory, so the run that crashed cannot report
 * itself — its report is this one, and without this it starts blank. Asked for
 * in those words after a television went black and closed: "i think there is not
 * enough logging in it as well".
 *
 * `error` rather than `warn`: a crash is the most important line in any report
 * that has one, and the panel counts errors on its badge.
 */
export async function reportLastCrash(): Promise<void> {
  try {
    const dev = await deviceInfo();
    const note = (await dev?.lastCrash?.())?.note ?? '';
    if (note.trim() === '') return;
    dlog.error('native', `last run ended: ${note.replace(/\s+/g, ' ').trim()}`);
  } catch {
    /* An older APK has no such method, and a boot must not fail over a
       diagnostic. */
  }
}
