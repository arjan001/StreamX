/**
 * The identity a MAG set-top box presents: MAC address plus the optional serial
 * number, device ids and signature some portals bind an account to.
 */
import { StalkerError } from './errors.ts';

/**
 * `00:1a:79:ab:cd:ef` | `00-1A-79-AB-CD-EF` | `001a79abcdef` -> `00:1A:79:AB:CD:EF`.
 * Throws `StalkerError('bad_mac')` for anything that is not 12 hex digits, and for
 * the all-zero / all-FF addresses no real box has. The `00:1A:79` prefix is the
 * usual MAG one but other vendors' prefixes are accepted: portals decide.
 */
export function normaliseMac(input: string): string {
  const hex = input.trim().replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex) || /^0{12}$/.test(hex) || /^F{12}$/.test(hex)) {
    throw new StalkerError('bad_mac', 'MAC address must be 12 hex digits, e.g. 00:1A:79:00:00:01');
  }
  return hex.match(/../g)!.join(':');
}

export function isValidMac(input: string): boolean {
  try {
    normaliseMac(input);
    return true;
  } catch {
    return false;
  }
}

/** True for the `00:1A:79` block Infomir assigns to MAG boxes (a hint, not a rule). */
export function hasMagPrefix(mac: string): boolean {
  return normaliseMac(mac).startsWith('00:1A:79:');
}

export interface DeviceInput {
  mac: string;
  serial?: string | undefined;
  deviceId?: string | undefined;
  deviceId2?: string | undefined;
  signature?: string | undefined;
}

export interface DeviceIdentity {
  readonly mac: string;
  readonly serial: string;
  readonly deviceId: string;
  readonly deviceId2: string;
  readonly signature: string;
}

/**
 * Blank fields are filled the way player apps do: deterministically from the MAC,
 * so the same user always presents the same box. `signature` stays empty unless
 * given, portals that enforce it will say so with an auth failure.
 */
export function makeDevice(input: DeviceInput): DeviceIdentity {
  const mac = normaliseMac(input.mac);
  const serial = input.serial?.trim() || sha1Hex(mac).slice(0, 13).toUpperCase();
  const id = (sha1Hex(`${mac}|id`) + sha1Hex(`${mac}|${serial}`)).slice(0, 64).toUpperCase();
  return {
    mac,
    serial,
    deviceId: input.deviceId?.trim() || id,
    deviceId2: input.deviceId2?.trim() || id,
    signature: input.signature?.trim() ?? '',
  };
}

/** Synchronous SHA-1 (hex). Web Crypto is async and absent on insecure origins. */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] ?? 0) | (bytes[i]! << (24 - (i % 4) * 8));
  const bitLen = bytes.length * 8;
  words[bitLen >> 5] = (words[bitLen >> 5] ?? 0) | (0x80 << (24 - (bitLen % 32)));
  const total = (((bitLen + 64) >> 9) << 4) + 15;
  for (let i = 0; i <= total; i++) words[i] ??= 0;
  words[total] = bitLen;
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  const rol = (n: number, s: number) => (n << s) | (n >>> (32 - s));
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 80; t++) {
      w[t] = t < 16 ? words[off + t]! | 0 : rol(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const [f, k] =
        t < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : t < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rol(a, 5) + f! + e + k! + w[t]!) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
