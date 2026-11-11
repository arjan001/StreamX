/**
 * The identifiers and version that `config.xml` takes from the brand and from
 * `version.json`, in one place so a test can pin them and the build cannot drift.
 */

/**
 * Tizen's package id is exactly ten alphanumeric characters and the application
 * id is `<package>.<name>`. Derived from the brand name, padded with `TV`, so a
 * rename in `brand.config.json` carries through: "Streamix" -> `StreamixTV` and
 * `StreamixTV.Streamix`. Samsung's Seller Office issues its own application id at
 * submission; this one only has to be valid in the package.
 */
export function tizenIds(brandName) {
  const base = String(brandName).replace(/[^A-Za-z0-9]/g, '');
  if (base === '') throw new Error('brand name has no alphanumeric characters');
  const pkg = `${base}TVTVTVTVTV`.slice(0, 10);
  return { pkg, appId: `${pkg}.${base}`, name: base };
}

/** Three numbers, which is what a widget `version` attribute carries. */
export function widgetVersion(raw) {
  const parts = String(raw).split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.');
}
