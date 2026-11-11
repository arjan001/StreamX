// @ts-ignore -- plain .mjs without types
import { startFakePortal as start, FAKE_MAC as mac } from '../../../scripts/fake-stalker.mjs';
import { StalkerClient, type StalkerOptions } from '../src/index.ts';

export interface FakePortal {
  url: string;
  log: { path: string; query: Record<string, string>; headers: Record<string, string> }[];
  revokeTokens(): void;
  close(): Promise<void>;
}
export const FAKE_MAC: string = mac;
export const startFakePortal = start as (o?: Record<string, unknown>) => Promise<FakePortal>;

export async function withPortal(
  portalOpts: Record<string, unknown>,
  clientOpts: Partial<StalkerOptions>,
  body: (c: StalkerClient, p: FakePortal) => Promise<void>,
): Promise<void> {
  const p = await startFakePortal(portalOpts);
  try {
    const c = new StalkerClient({ portalUrl: p.url, device: { mac: FAKE_MAC }, ...clientOpts });
    await body(c, p);
  } finally {
    await p.close();
  }
}
