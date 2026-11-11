/**
 * The download page's files.
 *
 * `DOWNLOAD_DIR` holds whatever packages the operator has dropped in: Android
 * `.apk`, Samsung `.wgt`, LG `.ipk`. This module lists them (name, platform,
 * Android ABI, version, size, SHA-256) and serves them with range support. It
 * only ever reads that one directory, one level deep, and only files whose name
 * is plain and whose extension is one of the three; nothing else is addressable.
 *
 * A website page only. The apps have no update check and fetch nothing from here.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { downloadDir } from './paths.ts';

export type Platform = 'android' | 'samsung' | 'lg';

export interface DownloadFile {
  name: string;
  platform: Platform;
  /** Android only: arm64-v8a, armeabi-v7a, x86_64, x86 or universal. */
  abi: string | null;
  version: string | null;
  size: number;
  sha256: string;
}

const EXT: Record<string, Platform> = { apk: 'android', wgt: 'samsung', ipk: 'lg' };
const TYPES: Record<Platform, string> = {
  android: 'application/vnd.android.package-archive',
  samsung: 'application/octet-stream',
  lg: 'application/octet-stream',
};
/** A plain file name: no separator, no leading dot, nothing a path could hide in. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal'];
const VERSION = /(?:^|[-_])v?(\d+\.\d+\.\d+(?:\.\d+)?)(?=[-_.]|$)/;

export function platformOf(name: string): Platform | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === undefined ? null : EXT[ext] ?? null;
}

export function abiOf(name: string): string | null {
  const lower = name.toLowerCase();
  for (const a of ABIS) if (new RegExp(`(?:^|[-_.])${a}(?=[-_.]|$)`).test(lower)) return a;
  return null;
}

export function versionOf(name: string, fallback: string | null): string | null {
  const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
  return VERSION.exec(stem)?.[1] ?? fallback;
}

/** `version.json` in the folder: `{ "version": "1.2.3" }`, for names without one. */
function folderVersion(dir: string): string | null {
  try {
    const p = join(dir, 'version.json');
    if (!existsSync(p)) return null;
    const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : null;
  } catch { return null; }
}

const hashes = new Map<string, Promise<string>>();
function sha256Of(path: string, key: string): Promise<string> {
  let hit = hashes.get(key);
  if (hit === undefined) {
    hit = new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
    hit.catch(() => hashes.delete(key));
    hashes.set(key, hit);
  }
  return hit;
}

const ORDER: Platform[] = ['android', 'samsung', 'lg'];
const cmpVersion = (a: string | null, b: string | null): number =>
  (b ?? '').localeCompare(a ?? '', undefined, { numeric: true });

export async function listDownloads(dir = downloadDir()): Promise<DownloadFile[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const fallback = folderVersion(dir);
  const out: DownloadFile[] = [];
  for (const name of names) {
    const platform = platformOf(name);
    if (platform === null || !SAFE_NAME.test(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = await lstat(full); } catch { continue; }
    /* A symlink could lead anywhere; only real files in the folder are offered. */
    if (!st.isFile()) continue;
    let sha256: string;
    try { sha256 = await sha256Of(full, `${full}:${st.size}:${st.mtimeMs}`); } catch { continue; }
    out.push({ name, platform, abi: platform === 'android' ? abiOf(name) : null, version: versionOf(name, fallback), size: st.size, sha256 });
  }
  return out.sort((a, b) =>
    ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform)
    || cmpVersion(a.version, b.version)
    || a.name.localeCompare(b.name));
}

/** One `Range` header against a size: [start, end] inclusive, null for none, 'bad' for unsatisfiable. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  if (header === undefined || header === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null; // not a form we honour (or multi-range): send the whole file
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return 'bad';
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'bad';
  return [start, end];
}

export async function serveDownload(req: FastifyRequest, reply: FastifyReply, name: string): Promise<FastifyReply> {
  const notFound = () => reply.code(404).type('application/json').send({ error: 'not found' });
  const platform = platformOf(name);
  if (platform === null || !SAFE_NAME.test(name)) return notFound();
  const full = join(downloadDir(), name);
  let size: number;
  try {
    const st = await lstat(full);
    if (!st.isFile()) return notFound();
    size = st.size;
  } catch { return notFound(); }

  reply
    .header('content-type', TYPES[platform])
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'no-cache')
    .header('x-content-type-options', 'nosniff');

  const range = parseRange(req.headers['range'], size);
  if (range === 'bad') return reply.code(416).header('content-range', `bytes */${size}`).send();
  if (range === null) {
    reply.header('content-length', size);
    return reply.send(createReadStream(full));
  }
  const [start, end] = range;
  reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
  return reply.send(createReadStream(full, { start, end }));
}
