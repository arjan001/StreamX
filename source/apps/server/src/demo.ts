/**
 * The demo playlist: a few Creative Commons films, for a store reviewer who has
 * no provider of their own to add.
 *
 * Off unless `DEMO_ENABLED=1`. The entries come from a JSON file the publisher
 * controls (`DEMO_STREAMS_FILE`), and every name carries its attribution, because
 * CC BY asks for exactly that wherever the work is shown. The files themselves
 * are hosted by the publisher (or Blender); this server only lists them.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DemoEntry { name: string; url: string; logo?: string }

const here = dirname(fileURLToPath(import.meta.url));

export const demoEnabled = (): boolean => (process.env['DEMO_ENABLED'] ?? '').trim() === '1';

export function demoFile(): string {
  const given = (process.env['DEMO_STREAMS_FILE'] ?? '').trim();
  return given === '' ? resolve(here, '../demo/streams.json') : resolve(given);
}

/** A name or attribute fit for one M3U line: no line breaks, no double quotes. */
const clean = (s: unknown): string => String(s ?? '').replace(/[\r\n"]+/g, ' ').trim();

export function demoEntries(file = demoFile()): { group: string; entries: DemoEntry[] } {
  let raw: { group?: unknown; entries?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { group: '', entries: [] };
  }
  const entries: DemoEntry[] = [];
  if (Array.isArray(raw.entries)) {
    for (const e of raw.entries as Record<string, unknown>[]) {
      const url = clean(e['url']);
      const name = clean(e['name']);
      /* http(s) only, and an empty url is a film the publisher has not hosted yet. */
      if (name === '' || !/^https?:\/\/\S+$/.test(url)) continue;
      const logo = clean(e['logo']);
      entries.push({ name, url, ...(/^https?:\/\/\S+$/.test(logo) ? { logo } : {}) });
    }
  }
  return { group: clean(raw.group) || 'Demo films', entries };
}

export function demoPlaylist(file = demoFile()): string | null {
  const { group, entries } = demoEntries(file);
  if (entries.length === 0) return null;
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    const logo = e.logo === undefined ? '' : ` tvg-logo="${e.logo}"`;
    lines.push(`#EXTINF:-1${logo} group-title="${group}",${e.name}`, e.url);
  }
  return lines.join('\n') + '\n';
}
