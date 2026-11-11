/**
 * A request URL fit for a log file.
 *
 * The routes that carry somebody else's address — the sign-in rescue, the old
 * relay and film routes, the image proxy — keep their path and lose their query,
 * which is where the subscription lives. Everywhere else a `username` or
 * `password` parameter, and the `/<kind>/<user>/<pass>/` segments of an Xtream
 * stream path, are masked. Exported for the test.
 */
export function logUrl(url: string): string {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const masked = path.replace(/\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\//i, '/$1/<user>/<pass>/');
  if (q < 0) return masked;
  if (/^\/api\/(panel|relay|img|film)\b/.test(path)) return `${masked}?[redacted]`;
  const query = url.slice(q + 1).replace(/((?:^|&)(?:username|password|pass|user|token)=)[^&]*/gi, '$1[redacted]');
  return `${masked}?${query}`;
}

/**
 * An address cut down to its network: `203.0.113.57` → `203.0.113.0/24`, and an
 * IPv6 address to its /48. The same cut the presence roster used to store —
 * enough to tell a flood from one client, not enough to name a household.
 * Anything that is not an address comes back empty rather than verbatim.
 */
export function maskIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4 !== null) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(':')) return '';
  const [head = ''] = ip.split('::');
  const groups = head.split(':').filter((g) => g !== '').slice(0, 3);
  while (groups.length < 3) groups.push('0');
  return `${groups.join(':')}::/48`;
}
