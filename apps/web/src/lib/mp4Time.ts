/**
 * Where a fragment says it belongs, read out of the fragment itself.
 *
 * The remuxer on the device hands back pieces of fragmented mp4 and tells us,
 * separately, the film timestamp each piece came from. Those two numbers are
 * not the same number, and the difference is the whole reason a seek showed no
 * picture.
 *
 * Measured against the owner's own panel on 2026-09-23, dragging to 1116 s:
 *
 *     [df] seek ok 1116
 *     [df] chunk pts 1140 …   [df] held 0.0-40.0
 *     [df] chunk pts 1250 …   [df] held 0.0-149.9
 *
 * The muxer's clock is CONTIGUOUS. It does not jump when the input does: it
 * carries on from wherever it had written to, so film-second 1140 was written
 * as output-second 40 — `output = input - 1100` for that whole pass. Handed
 * straight to a `SourceBuffer` those pieces do not merely miss the mark, they
 * land on top of the film's opening and overwrite it. The buffer grows as if
 * everything were fine, `readyState` stays at 1, and nothing anywhere throws.
 *
 * `MediaSource` has exactly the right lever for this — `timestampOffset`, which
 * shifts every frame in a piece as it is taken in — and setting it needs one
 * number: where in its own clock this piece starts. That number is written in
 * the piece, in `moof/traf/tfdt`, in the track's own timescale. So:
 *
 *     timestampOffset = the film second the library reports
 *                     - the second the fragment says it is
 *
 * which is zero whenever the two agree, and this whole file costs nothing on a
 * player whose muxer keeps film time. It is read rather than assumed for the
 * same reason the length is asked for rather than assumed: a number derived
 * from a theory about someone else's muxer is a number that goes wrong on the
 * next release of it.
 *
 * Only two boxes are actually needed — `tfdt` for the time and `mdhd` for the
 * timescale to divide it by — but both are buried, so this walks the tree.
 */

/** An mp4 box: four bytes of length, four of name, then either payload or more boxes. */
type Box = { type: string; start: number; end: number };

const HEADER = 8;

/** Every box at one level. Sizes are trusted only as far as the buffer goes. */
function boxes(v: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + HEADER <= to) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(
      v.getUint8(at + 4), v.getUint8(at + 5), v.getUint8(at + 6), v.getUint8(at + 7),
    );
    let body = at + HEADER;
    if (size === 1) {
      /* A 64-bit length, which a film big enough to need one does carry. The
         high word is ignored on purpose: a single box over 4 GB cannot be in
         a buffer we are holding in memory anyway. */
      if (at + 16 > to) break;
      size = v.getUint32(at + 12);
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < HEADER) break;
    const end = Math.min(at + size, to);
    if (body > end) break;
    out.push({ type, start: body, end });
    at += size;
  }
  return out;
}

function child(v: DataView, box: Box, type: string): Box | null {
  for (const b of boxes(v, box.start, box.end)) if (b.type === type) return b;
  return null;
}

/** version and flags, which every one of these boxes opens with. */
function version(v: DataView, box: Box): number {
  return v.getUint8(box.start);
}

/** A 64-bit field, read as a double — exact to 2^53, and these are frame counts. */
function big(v: DataView, at: number): number {
  return v.getUint32(at) * 4294967296 + v.getUint32(at + 4);
}

/**
 * How many units of each track's clock make a second, by track id.
 *
 * From `moov/trak/{tkhd,mdia/mdhd}`: the id and the timescale live in
 * different boxes of the same track, so both have to be walked together.
 */
export function trackTimescales(init: ArrayBuffer | Uint8Array): Map<number, number> {
  const u = init instanceof Uint8Array ? init : new Uint8Array(init);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const found = new Map<number, number>();
  const top = boxes(v, 0, u.byteLength);
  const moov = top.find((b) => b.type === 'moov');
  if (moov === undefined) return found;
  for (const trak of boxes(v, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(v, trak, 'tkhd');
    const mdia = child(v, trak, 'mdia');
    const mdhd = mdia === null ? null : child(v, mdia, 'mdhd');
    if (tkhd === null || mdhd === null) continue;
    const id = version(v, tkhd) === 1 ? v.getUint32(tkhd.start + 20) : v.getUint32(tkhd.start + 12);
    const scale = version(v, mdhd) === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
    if (scale > 0) found.set(id, scale);
  }
  return found;
}

/**
 * The second, on the muxer's own clock, that this fragment starts at.
 *
 * `null` when the piece does not say — a piece with no `moof`, a `tfdt` the
 * muxer left out, or a track whose timescale we never saw. The caller shifts
 * nothing in that case, which is the behaviour this code replaced and so can
 * be no worse than it.
 *
 * A fragment that carries a fresh `moov` — which a rebuilt muxer emits — has
 * its timescales taken from that, since they are the ones now in force.
 */
export function fragmentStart(
  data: ArrayBuffer | Uint8Array,
  scales: Map<number, number>,
): { seconds: number; scales: Map<number, number> } | null {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const top = boxes(v, 0, u.byteLength);
  let use = scales;
  if (top.some((b) => b.type === 'moov')) {
    const fresh = trackTimescales(u);
    if (fresh.size > 0) use = fresh;
  }
  const moof = top.find((b) => b.type === 'moof');
  if (moof === undefined) return null;
  for (const traf of boxes(v, moof.start, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(v, traf, 'tfhd');
    const tfdt = child(v, traf, 'tfdt');
    if (tfhd === null || tfdt === null) continue;
    const id = v.getUint32(tfhd.start + 4);
    const scale = use.get(id);
    if (scale === undefined || scale <= 0) continue;
    const base = version(v, tfdt) === 1 ? big(v, tfdt.start + 4) : v.getUint32(tfdt.start + 4);
    return { seconds: base / scale, scales: use };
  }
  return null;
}
