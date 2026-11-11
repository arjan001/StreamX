/**
 * A name for a thing that only has an id.
 *
 * The admin roster identifies a subscription by `sha256(host|port|username|
 * password)` and a device by a random string it invented for itself. Both are
 * deliberate — the app has no accounts and stores no credentials, and a
 * fingerprint would be a fingerprint — and both are unreadable: the console
 * showed `c8e6fba8` in a column headed ACCOUNT, which is what "instead of
 * showing name, it shows id" is about.
 *
 * So the id gets a name. Derived, not stored: the same id always produces the
 * same two words, on every screen and after every restart, with no table to keep
 * and nothing new sent from any device. That is the whole point — a roster is
 * read by a person who needs to tell two televisions apart, and "Amber Falcon"
 * and "Cobalt Heron" do that where two hex strings do not.
 *
 * The id stays visible beside the name. 1,024 pairs means two devices in a
 * fourteen-row roster collide about one time in nine, and when they do the digest
 * is right there to break the tie. A name that is merely a nickname must never be
 * the only way to identify a row.
 */

/* Colours and materials: neutral, short, and unmistakable from across a room. */
const FIRST = [
  'Amber', 'Ivory', 'Cobalt', 'Copper', 'Crimson', 'Emerald', 'Golden', 'Indigo',
  'Jade', 'Lilac', 'Maroon', 'Olive', 'Onyx', 'Opal', 'Pewter', 'Quartz',
  'Russet', 'Saffron', 'Sable', 'Scarlet', 'Silver', 'Slate', 'Steel', 'Teal',
  'Topaz', 'Umber', 'Verdant', 'Violet', 'Willow', 'Cedar', 'Coral', 'Flint',
] as const;

/* Birds and animals rather than objects: they make a phrase somebody repeats
   ("the Amber Falcon in the kitchen") instead of a label they read out. */
const SECOND = [
  'Falcon', 'Heron', 'Osprey', 'Kestrel', 'Raven', 'Swift', 'Wren', 'Finch',
  'Marten', 'Otter', 'Lynx', 'Ibex', 'Badger', 'Beacon', 'Harrier', 'Curlew',
  'Plover', 'Puffin', 'Gannet', 'Kite', 'Merlin', 'Petrel', 'Shrike', 'Skua',
  'Teal', 'Vireo', 'Warbler', 'Weasel', 'Bittern', 'Dipper', 'Egret', 'Fulmar',
] as const;

/** FNV-1a, 32-bit. Small, stable, and not a security decision. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Two words for this id, always the same two.
 *
 * Empty and the shared `anonymous` bucket answer null: those are not one thing
 * with a name, they are every guest on the installation, and giving them all the
 * same name would say something false about the roster. The caller shows the word
 * it already had.
 */
export function friendlyName(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const key = id.trim();
  if (key === '' || key === 'anonymous' || key === 'unknown') return null;
  const h = hash(key);
  /* Two independent slices of the same hash: the low bits pick the first word
     and the next five bits the second, so neighbouring ids do not share a half. */
  const a = FIRST[h % FIRST.length] ?? FIRST[0];
  const b = SECOND[(h >>> 5) % SECOND.length] ?? SECOND[0];
  return `${a} ${b}`;
}

/** The id itself, short enough to read and long enough to tell two apart. */
export function shortId(id: string | null | undefined, chars = 8): string {
  const key = (id ?? '').trim();
  return key.length <= chars ? key : key.slice(0, chars);
}
