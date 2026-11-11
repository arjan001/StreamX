/**
 * Search, for somebody holding a remote control.
 *
 * Asked for as: "allow searching based on cast as well, and please make an
 * advanced searching logic, like mispelling, and each space and so on". Three
 * requests, and the third one — the spaces — is the one that was most broken.
 *
 * ── what search did before this file ───────────────────────────────────────
 *
 * `matchRows` compacted the query ("dark knight" -> "darkknight") and asked for a
 * substring of the compacted title. That is a good, cheap rule with two holes
 * that are obvious the moment you type into it on a television:
 *
 *   * the words have to be adjacent and in order. "knight dark" finds nothing,
 *     "dark rises" finds nothing, and "the office uk" finds nothing because the
 *     panel writes "The Office (US)" with the country AFTER the year.
 *   * a single wrong letter finds nothing at all. On an on-screen keyboard each
 *     letter is three or four D-pad presses, so "avengrs" is around twenty-five
 *     presses spent to be told the catalogue has no Avengers film in it.
 *
 * ── what this does instead ─────────────────────────────────────────────────
 *
 * Three stages, in cost order, and nothing expensive runs until something cheap
 * has already narrowed the field:
 *
 *   1. TOKENISE. The query splits on anything that is not a letter or a digit.
 *      Every token must be found, in any order, anywhere in the row's title or
 *      cast. "dark knight" finds "The Dark Knight Rises"; so does "knight dark".
 *   2. CANDIDATES. One `indexOf` sweep over the compact blob for the LONGEST
 *      token, which is the most selective one, giving a row set. Measured on
 *      this provider's 266,141-row catalogue: a full sweep of the 5.76MB blob is
 *      3.8ms, against 14-18ms for the old per-row `readText` + `includes` loop
 *      that `matchRows` runs — so the multi-token search is FASTER than the
 *      substring search it replaces, not slower. Remaining tokens are verified
 *      per candidate, which is a few thousand string reads rather than 266,141.
 *   3. FUZZY, only when stage 2 came back thin AND the word is one this
 *      catalogue has never seen. A full Damerau-Levenshtein scan over 266,141
 *      titles per keystroke is not affordable on a television and is not what
 *      happens here: the typed word is corrected against a dictionary of the
 *      115,732 distinct words this catalogue actually contains, and the
 *      corrections are then searched exactly. Measured on the live catalogue:
 *      0.2-4.7ms per token to correct, against 8-16ms for the same correction
 *      before the length / letter-mask / bigram prefilters in `WordIndex`.
 *
 * ── and the cast, which the panel only half provides ───────────────────────
 *
 * Measured against this panel on 2026-09-07, and it decides what this can
 * honestly claim. `get_series` — the BULK series list the ingest already
 * downloads — carries `cast` on all 45,140 rows, 33,636 of them non-empty:
 * 203,540 credits over 49,438 distinct people, for no extra request. It was
 * being parsed and thrown away. `get_vod_streams` carries sixteen fields over
 * 211,168 films and not one of them is a cast, a genre or a plot, so a film's
 * cast comes only from `get_vod_info`, one HTTP request per title, against an
 * account whose `max_connections` is 1.
 *
 * So: series are searchable by their real cast, and films are searchable by
 * whichever names the panel wrote into the TITLE — 4,523 with a shouted lead
 * actor, 14,839 adult rows in `[X][Studio] Performer - Title` form. Those are
 * already in `compact`, so they need no column and no second parser. What is
 * NOT here is a film cast index; 179,667 of 211,168 films (85.1%) carry a
 * `tmdb` id, which is the route to one, and it is a separate piece of work.
 *
 * ── ranking, in one sentence ───────────────────────────────────────────────
 *
 * A title that begins with the whole word beats a title that contains the whole
 * word beats a title that begins with a fragment of it beats a cast credit beats
 * a mid-word hit; anything typed correctly beats anything corrected; and every
 * tie is broken deterministically. See `EVIDENCE` for the ladder, `scoreRow` for
 * how a row's tokens are summed, and `compareHits` for the tie-breaks. Ranking
 * rather than filtering is the point: a search that returns the right row 30
 * places down has failed on a screen showing twelve.
 *
 * ── the rule that outranks all of the above ────────────────────────────────
 *
 * The order must not change while somebody is still typing. Every comparison
 * here ends in the row index, so one query has exactly one ordering — there is
 * no "stable enough" sort, no `Map` iteration order, and no clock. The web layer
 * keys its cache on the query text for the same reason.
 */
import {
  FLAG, castText, foldText, readText, viewItem,
  type Catalogue, type CastColumn, type ItemColumns, type ItemView, type TextColumn,
} from './columns.ts';
import { adultCategoryIds } from './adult.ts';
import { KIND, cmpKey, collapseFamilies, compactQuery } from './query.ts';

/* ── tokens ────────────────────────────────────────────────────────────────── */

/**
 * The words a query is asking for, longest first.
 *
 * Longest first is not cosmetic: `collect` drives its one blob sweep off
 * `tokens[0]`, and the longest token is the most selective one available without
 * measuring. Sweeping for "the" and then verifying "shawshank" over 46,744
 * candidates does the same work as sweeping for "shawshank" and verifying "the"
 * over eleven, in the wrong order.
 *
 * Deduplicated, because "the the" is a typo rather than a stronger request, and
 * a duplicate token would be swept for twice and scored twice.
 *
 * Digits are kept as tokens ("24", "1883", "2024"): the panel writes years into
 * titles and people search for them.
 */
export function tokenise(raw: string): string[] {
  const folded = foldText(raw);
  if (folded === '') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of folded.split(' ')) {
    if (word === '' || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  /* Length descending, then alphabetical. The alphabetical half only decides
     ties, and it exists so that two equally long tokens always drive the same
     sweep — an unspecified order here would make one query rank two ways. */
  return out.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * How many edits a token of this length is allowed to be wrong by.
 *
 * The shape of the curve is forced by what a short word costs: at three letters,
 * a budget of one turns "cat" into "car", "cut", "bat", "cats" and "at", and the
 * catalogue contains all of them. Every one of those is a DIFFERENT search, and
 * offering them all is not tolerance, it is noise. So:
 *
 *     1-3 letters   0    exact only. "dr", "cnn", "24" mean what they say.
 *     4-6 letters   1    "darck" -> "dark", "breking" -> "breaking".
 *     7+ letters    2    "shwshank" -> "shawshank", "aniston" from "anistn".
 *
 * Two edits on a seven-letter word is a 29% error rate, which sounds generous
 * until you count the presses: seven letters on a D-pad keyboard is roughly
 * twenty-five presses, and two of them going astray is one bad afternoon rather
 * than a spelling problem.
 */
export function editBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/**
 * Damerau-Levenshtein, banded and abandoned early.
 *
 * Damerau rather than plain Levenshtein because the transposition is the whole
 * point on a remote: "knight" typed as "kngiht" is ONE edit to Damerau and TWO
 * to Levenshtein, and two is outside a six-letter word's budget. Adjacent
 * transposition is also the single commonest typing error there is.
 *
 * Optimal String Alignment, not unrestricted Damerau — a substring is never
 * edited twice here, which makes the recurrence three rolling rows instead of an
 * alphabet-sized table, and the difference between the two only shows up on
 * strings needing three or more edits. The budget stops at two.
 *
 * Two things make this cheap enough to call tens of thousands of times per
 * query. The band: a cell more than `max` away from the diagonal cannot lead to
 * an accepted answer, so only `2*max+1` cells per row are computed, and the two
 * cells either side of the band are pinned above the budget so the next row
 * reads a wall rather than a stale value from three rows ago. And the early
 * abandon: if every cell in a row already exceeds the budget, no continuation
 * can come back under it.
 *
 * @returns the distance, or `max + 1` for anything beyond the budget. Never the
 *          true distance above `max` — callers only ever compare against `max`,
 *          and computing more than that is work nobody reads.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (a === b) return 0;
  if (max <= 0) return 1;
  // A length gap wider than the budget cannot be closed: every extra character
  // is at least one insertion.
  if (al - bl > max || bl - al > max) return max + 1;

  const over = max + 1;
  let prev2 = new Int32Array(bl + 2).fill(over);
  let prev = new Int32Array(bl + 2).fill(over);
  let cur = new Int32Array(bl + 2).fill(over);
  for (let j = 0; j <= Math.min(bl, max); j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const lo = Math.max(1, i - max);
    const hi = Math.min(bl, i + max);
    cur[0] = i <= max ? i : over;
    // The walls. Without them the next row reads whichever value this buffer
    // held two rows ago, which is a real number and quietly wrong.
    if (lo - 1 >= 1) cur[lo - 1] = over;
    if (hi + 1 <= bl + 1) cur[hi + 1] = over;
    let best = cur[0]!;
    const ai = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1]! + cost;
      const del = prev[j]! + 1;
      if (del < v) v = del;
      const ins = cur[j - 1]! + 1;
      if (ins < v) v = ins;
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        const swap = prev2[j - 2]! + 1;
        if (swap < v) v = swap;
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return over;
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  const d = prev[bl]!;
  return d > max ? over : d;
}

/* ── the word dictionary ───────────────────────────────────────────────────── */

/**
 * Every distinct word in the catalogue, arranged so a typo can find its way home.
 *
 * ── why a dictionary and not a scan ──
 *
 * The obvious implementation of fuzzy search is to walk 266,141 titles per
 * keystroke computing an edit distance. Measured, a bare full sweep of the
 * compact blob is already 3.8ms with `indexOf` doing the work in C++; a
 * JavaScript distance function per row is two orders of magnitude worse, and
 * this runs on a television. So the distance is computed against the VOCABULARY
 * instead — 83,767 distinct words rather than 266,141 titles — and the words it
 * returns are then searched with the same cheap `indexOf` sweep as any other
 * query. Correcting a typo and searching for a word are separate problems, and
 * only the first one needs arithmetic.
 *
 * ── where the words come from ──
 *
 * `norm` and `cast`, both of which are already folded and already
 * space-separated on the device, so building this costs a scan and no
 * `normalize()` calls. `compact` is useless here: it has no spaces, so its
 * "words" would be whole titles. Measured on this provider — 115,732 distinct
 * words from the two columns together (83,767 from the titles alone), about
 * 1.5MB of strings and typed arrays, and the build is a ~500ms one-off (see
 * `buildWordIndex`).
 *
 * ── the three prefilters, and what each one is worth ──
 *
 * Before any distance is computed a candidate word has to survive:
 *
 *   LENGTH   only buckets within `max` of the token's length are visited, because
 *            a wider gap needs more insertions than the budget allows. This is
 *            free — the buckets are the storage.
 *   LETTERS  a 26-bit mask of which a-z letters the word contains. `k` edits can
 *            change at most `2k` bits, so `popcount(xor) > 2k` is a proof of
 *            non-match. Cheap, and it catches the common case of two words that
 *            merely happen to be the same length. (A transposition changes no
 *            bits at all, which is why this filter alone was not enough.)
 *   BIGRAMS  a 32-bit Bloom-ish mask of the word's adjacent letter pairs. A word
 *            of length L has L-1 bigrams and `k` edits destroy at most `2k` of
 *            them, so fewer than `L-1-2k` shared bits is a proof of non-match.
 *            This is the filter that makes a budget of two affordable: without
 *            it "shwshank" cost 16.1ms to correct, with it 2.6ms.
 *
 * All three are one-sided — they reject, they never accept — so nothing here can
 * hide a real correction. The distance function still has the last word.
 */
export interface WordIndex {
  /** Words of length L, and their masks and counts in the same order. */
  byLength: Map<number, WordBucket>;
  /** Distinct words held. Reported by the tests as a sanity floor. */
  size: number;
}

export interface WordBucket {
  words: string[];
  /** Bit `n` set when the word contains the letter `a + n`. */
  letters: Int32Array;
  /** A 32-bit hash of the word's adjacent character pairs. */
  bigrams: Int32Array;
  /** How many times the word occurs. A word seen once is likely a typo in the DATA. */
  counts: Int32Array;
}

/**
 * Words shorter than this are never indexed.
 *
 * `editBudget` gives a 4-letter token a budget of 1, so the shortest word it can
 * reach is 3 letters, and nothing below that can ever be a correction of
 * anything. Indexing 622 two-letter words to never look at them is 622 words of
 * scan on every correction.
 */
const MIN_WORD = 3;
/** Beyond this a "word" is a run-together title, not something anyone typed. */
const MAX_WORD = 24;

function lettersOf(word: string): number {
  let m = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i) - 97;
    if (c >= 0 && c < 26) m |= 1 << c;
  }
  return m;
}

/**
 * A 32-bit set of the word's adjacent character pairs.
 *
 * Collisions are fine and expected — this is a Bloom filter, and a collision can
 * only make the filter more permissive, which costs a distance computation and
 * never a missed correction. The multiplier is odd so that the low bits of the
 * product depend on the whole pair rather than on the second character alone.
 */
function bigramsOf(word: string): number {
  let m = 0;
  for (let i = 1; i < word.length; i++) {
    const h = (word.charCodeAt(i - 1) * 131 + word.charCodeAt(i)) >>> 0;
    m |= 1 << (h & 31);
  }
  return m;
}

function popcount(x: number): number {
  let v = x - ((x >> 1) & 0x5555_5555);
  v = (v & 0x3333_3333) + ((v >> 2) & 0x3333_3333);
  v = (v + (v >> 4)) & 0x0f0f_0f0f;
  return Math.imul(v, 0x0101_0101) >> 24;
}

/**
 * Split a folded, space-separated blob into the word counter.
 *
 * A hand-rolled character loop rather than `split(/[^a-z0-9]+/)`: measured on
 * this provider's 8.4MB name blob, the loop is 361ms and the regex split of the
 * same data — after the `normalize('NFD')` the regex path also needs — is over
 * 900ms. The blobs read here are ALREADY folded, which is why this can look at
 * character codes and skip Unicode entirely.
 */
function harvest(blob: string, into: Map<string, number>): void {
  harvestRange(blob, into, 0, blob.length);
}

/**
 * The same scan, over one slice of the blob.
 *
 * `from` and `to` are byte-ish offsets into an already-folded blob, and the
 * caller is responsible for cutting only on a NON-alphanumeric character —
 * `sliceEnd` below does that. Cutting mid-word would invent two short words
 * where there was one long one, which is the kind of corruption that shows up
 * months later as one channel that cannot be found by name.
 *
 * The loop still reads one character past `to`, exactly as the whole-blob
 * version reads one past the end: that is what flushes the last word.
 */
function harvestRange(blob: string, into: Map<string, number>, from: number, to: number): void {
  let start = -1;
  for (let i = from; i <= to; i++) {
    const ch = i === blob.length ? 32 : blob.charCodeAt(i);
    const alnum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
    if (alnum) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const len = i - start;
      if (len >= MIN_WORD && len <= MAX_WORD) {
        const w = blob.slice(start, i);
        into.set(w, (into.get(w) ?? 0) + 1);
      }
      start = -1;
    }
  }
}

/**
 * A cut that never lands inside a word.
 *
 * Walks forward from the wanted length to the first character that cannot be
 * part of a word. `MAX_WORD` bounds the walk, so a pathological blob with no
 * separators cannot turn this into a second full scan.
 */
function sliceEnd(blob: string, want: number): number {
  if (want >= blob.length) return blob.length;
  for (let i = want; i < Math.min(blob.length, want + MAX_WORD + 1); i++) {
    const ch = blob.charCodeAt(i);
    if (!((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57))) return i;
  }
  return Math.min(blob.length, want + MAX_WORD + 1);
}

/**
 * Build the dictionary. One pass over two blobs.
 *
 * Measured on this provider (266,141 rows, 8.4MB of names, 2.9MB of cast) on the
 * development box: 512ms, producing 83,767 distinct words and about 1.5MB of
 * strings and typed arrays. A cheap television box is three to five times slower
 * than that box on single-threaded JavaScript, so budget one and a half to two
 * and a half seconds there.
 *
 * That is far too long to spend on a keystroke, and it is never spent on one.
 * The caller builds this ONCE and holds it: `apps/web/src/lib/searchIndex.ts`
 * starts the build when the search screen mounts, which is several seconds
 * before anyone has finished pressing their way to the third letter, and the
 * exact search — which needs no dictionary at all — answers every keystroke
 * whether it has arrived or not. A search that would have been corrected simply
 * is not, until it is.
 *
 * Deliberately NOT persisted alongside the columns. It is derivable from two
 * columns that are already stored, so persisting it would trade a rebuildable
 * 1.5MB for a second thing that can be stale, a second thing to version, and a
 * second reason `loadCatalogue` can return null.
 */
export function buildWordIndex(cat: Catalogue): WordIndex {
  const steps = buildWordIndexSteps(cat);
  let r = steps.next();
  while (r.done !== true) r = steps.next();
  return r.value;
}

/**
 * The same build, in slices, so it can be spread across idle callbacks.
 *
 * The comment above says this cost "is never spent on a keystroke". That was
 * the intent and it was not what happened: `searchIndex.ts` asks for it with
 * `requestIdleCallback(fn, { timeout: 2000 })`, and a viewer who presses SEARCH
 * and starts typing — which is everybody, that is what the screen is for — is
 * still typing when the deadline fires. It then runs to completion with the main
 * thread held, because a plain function has nowhere to stop. `search-probe`
 * measured the result and has been printing SEARCH SLOW over it: median
 * keystroke echo around 20ms, and one keystroke at **4302ms**. On a television
 * that is the keyboard dying mid-word, which the probe's own header calls the
 * one unforgivable outcome.
 *
 * So the loop yields. Each `next()` does at most `sliceChars` of blob and then
 * hands the thread back; the caller decides when to resume. Yields the fraction
 * done, for a caller that wants to show it, and returns the finished index.
 *
 * The default slice is sized backwards from the bar the probe holds, on the
 * hardware that actually struggles. From the measurement above: 11.3MB of blob
 * in about 512ms here, so a megabyte is roughly 45ms — and a cheap television
 * box is three to five times slower, which makes a megabyte 135-225ms there and
 * a visible hitch. Half a megabyte is about 22ms here and 66-110ms on that box,
 * under `search-probe`'s 120ms keystroke bar with room to spare. Twenty-odd
 * slices to build the whole thing is not a cost anybody can perceive; one slice
 * somebody CAN perceive is the entire bug.
 */
export function* buildWordIndexSteps(
  cat: Catalogue,
  sliceChars = 500_000,
): Generator<number, WordIndex> {
  const counts = new Map<string, number>();
  /* `norm`, not `names`: it is already lowercase, accent-folded and
     space-separated, so harvesting it needs no Unicode work at all. What it
     drops — the market prefix and the quality tokens — is exactly the vocabulary
     nobody fuzzy-searches. */
  const blobs = [cat.items.norm.blob, cat.items.cast.text.blob];
  const total = blobs.reduce((n, b) => n + b.length, 0) || 1;
  let done = 0;
  for (const blob of blobs) {
    let at = 0;
    while (at < blob.length) {
      const end = sliceEnd(blob, Math.min(blob.length, at + sliceChars));
      harvestRange(blob, counts, at, end);
      done += end - at;
      at = end;
      /* Deliberately after the slice and not before: a generator that yields
         first would hand back a thread it had not yet used, and the whole point
         is to give one back having done a bounded amount of work. */
      yield Math.min(0.95, done / total);
    }
  }

  const grouped = new Map<number, string[]>();
  for (const word of counts.keys()) {
    const list = grouped.get(word.length);
    if (list === undefined) grouped.set(word.length, [word]);
    else list.push(word);
  }

  const byLength = new Map<number, WordBucket>();
  /* The second phase is far smaller than the first — 83,767 words against 11MB
     of blob — but it sorts and fills three typed arrays per bucket, so it gets
     the same courtesy: one yield per length bucket. */
  for (const [len, words] of grouped) {
    yield 0.95;
    /* Sorted, so the bucket — and therefore the order corrections come out in
       before scoring — is the same on every build of the same catalogue. A Map's
       insertion order depends on blob order, which is stable, but sorting says
       so out loud and costs nothing at 83,767 words total. */
    words.sort();
    const letters = new Int32Array(words.length);
    const bigrams = new Int32Array(words.length);
    const freq = new Int32Array(words.length);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      letters[i] = lettersOf(w);
      bigrams[i] = bigramsOf(w);
      freq[i] = counts.get(w) ?? 1;
    }
    byLength.set(len, { words, letters, bigrams, counts: freq });
  }
  return { byLength, size: counts.size };
}

export interface Correction {
  word: string;
  distance: number;
}

/**
 * Does this catalogue contain this word, spelled exactly like that?
 *
 * The question that decides whether a query has a typo in it at all, and the
 * bug it exists to prevent reached the screen. "sky news" matches 38 rows on
 * this catalogue — three real Sky News channels and a scatter of others — which
 * is under the thin-answer floor, so the correction pass ran, decided "news"
 * could have been "new", and filled the MOVIES block with two dozen films whose
 * titles contain the words "new" and "sky". A search for a news channel
 * answered with adult films, because the answer it already had was SMALL rather
 * than WRONG.
 *
 * A typo is a word the catalogue has never seen. "avengrs", "shwshank",
 * "kngiht" and "emliy" are not in this vocabulary; "sky", "news", "walter" and
 * "white" are, and a query made of words the catalogue knows is spelled
 * correctly however few rows it happens to match. So a small answer to a
 * correctly-spelled query stays small, which is the honest reply.
 *
 * Binary search over the length bucket, which `buildWordIndex` sorts.
 */
export function knowsWord(index: WordIndex, word: string): boolean {
  const bucket = index.byLength.get(word.length);
  if (bucket === undefined) return false;
  const { words } = bucket;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = words[mid]!;
    if (at === word) return true;
    if (at < word) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Real words this token might have been.
 *
 * Ordered by distance first and then by how often the word occurs in the
 * catalogue, which is the tie-break that matters: "darck" is one edit from
 * "dark" (2,411 rows), "darcy" (38 rows) and "darc" (4 rows), and only one of
 * those is what somebody meant. Frequency is a better signal than alphabetical
 * order and a much better one than whatever order a hash map hands back.
 *
 * Capped, because the cap is a performance guard and not a taste judgement:
 * every correction returned becomes another full sweep of the compact blob in
 * `candidateRows`, so an uncapped list of forty near-misses turns a 4ms search
 * into a 160ms one. Six is enough to cover the plausible readings of a typo and
 * short enough that the worst case stays inside the budget.
 */
export function correctToken(
  index: WordIndex,
  token: string,
  max: number,
  limit = 6,
): Correction[] {
  if (max <= 0 || token.length < MIN_WORD) return [];
  const tLetters = lettersOf(token);
  const tBigrams = bigramsOf(token);
  const doubleBudget = 2 * max;
  const out: Array<Correction & { count: number }> = [];

  for (let len = token.length - max; len <= token.length + max; len++) {
    const bucket = index.byLength.get(len);
    if (bucket === undefined) continue;
    /*
     * The shorter of the two words bounds how many bigrams they can share, so
     * the floor is computed from it rather than from the token.
     *
     * THREE per edit, not two, and the third one is not slack — it is the
     * transposition. A substitution breaks the two bigrams either side of it, a
     * deletion breaks two and makes one, an insertion breaks one and makes two,
     * but swapping two adjacent characters breaks all THREE bigrams that touch
     * them. At two per edit this filter rejected "kngiht" against "knight" —
     * one transposition, sharing only `kn` and `ht` where the bound demanded
     * three — so the commonest typing mistake there is was the one correction
     * the fast path could not make.
     */
    const shorter = len < token.length ? len : token.length;
    const bigramFloor = shorter - 1 - 3 * max;
    const { words, letters, bigrams, counts } = bucket;
    for (let i = 0; i < words.length; i++) {
      if (popcount(tLetters ^ letters[i]!) > doubleBudget) continue;
      if (bigramFloor > 0 && popcount(tBigrams & bigrams[i]!) < bigramFloor) continue;
      const w = words[i]!;
      const d = boundedDistance(token, w, max);
      if (d > max) continue;
      out.push({ word: w, distance: d, count: counts[i]! });
    }
  }
  out.sort((a, b) => a.distance - b.distance || b.count - a.count
    || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return out.slice(0, limit).map(({ word, distance }) => ({ word, distance }));
}

/* ── candidate rows ────────────────────────────────────────────────────────── */

/**
 * Which row a position in a text blob belongs to.
 *
 * Binary search over the offsets, with the previous answer as a starting hint —
 * a blob sweep produces hits in ascending position order, so the row is almost
 * always the previous row or a little after it, and the hint turns most of these
 * into a single comparison.
 */
export function rowAtOffset(offsets: Int32Array, pos: number, hint: number): number {
  const last = offsets.length - 2;
  if (hint >= 0 && hint <= last && pos >= offsets[hint]! && pos < offsets[hint + 1]!) return hint;
  let lo = 0;
  let hi = last;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < offsets[mid]!) hi = mid - 1;
    else if (pos >= offsets[mid + 1]!) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Every row whose text blob contains `needle`, via one `indexOf` sweep.
 *
 * `indexOf` on a 5.76MB string is a native substring search; the JavaScript here
 * only converts a position into a row. Measured on this provider: 3.8ms for a
 * ten-character needle over the whole compact blob against 14-18ms for the
 * per-row `readText` + `includes` loop over the same data.
 *
 * A needle can occur twice in one row, so `emit` is guarded by the ascending row
 * cursor rather than by a Set — a Set of up to 46,744 numbers per token, three
 * times per query, is the allocation this loop exists to avoid.
 */
function sweep(col: TextColumn, needle: string, emit: (row: number) => void): void {
  if (needle === '') return;
  const { blob, offsets } = col;
  let at = blob.indexOf(needle);
  let row = 0;
  let last = -1;
  while (at >= 0) {
    row = rowAtOffset(offsets, at, row);
    if (row < 0) break;
    if (row !== last) {
      emit(row);
      last = row;
    }
    /* Jump to the start of the next row rather than to `at + 1`. A row cannot
       match twice usefully, and skipping the rest of it turns the pathological
       case — "aaa" against a title of a hundred a's — from quadratic into one
       step. */
    at = blob.indexOf(needle, offsets[row + 1]!);
  }
}

/* ── the section predicate ─────────────────────────────────────────────────── */

/**
 * What `matchRows` would keep for this section, minus the text test.
 *
 * `search` only ever varies one thing — the section (adult content is always
 * hidden) — so this is deliberately a small, explicit re-statement rather than
 * a call into `matchRows`, which would rescan all 266,141 rows once per section
 * and undo the entire point of the candidate sweep.
 *
 * The asymmetry it must preserve is the one `CategoryScope` documents: a row
 * with no category fails an INCLUDE and survives an EXCLUDE. Here only the
 * exclude side is ever populated (there is no include for a plain search), so
 * the practical rule is "an uncategorised row survives", and it matters — 194
 * uncategorised films on this catalogue would otherwise be unfindable by name.
 *
 * `query.test.ts` pins this against `matchRows` on a plain query so the two
 * cannot drift apart in silence, which is the failure this shape invites.
 */
function sectionFilter(cat: Catalogue, kind: number): (row: number) => boolean {
  const cols = cat.items;
  const exclude = adultCategoryIds(cat);
  return (row) => {
    if (cols.kind[row] !== kind) return false;
    if (((cols.flags[row] ?? 0) & FLAG.adult) !== 0) return false;
    const cid = cols.categoryId[row] ?? 0;
    return cid === 0 || !exclude.has(cid);
  };
}

/* ── scoring ───────────────────────────────────────────────────────────────── */

/**
 * What one token's best evidence on one row is worth.
 *
 * The ladder, strongest first, and each rung answers a question somebody
 * actually asked with their thumb:
 *
 *   TITLE_HEAD       8  the title BEGINS with the token and the token is a whole
 *                       word there. "grey" against "Grey's Anatomy". Nothing
 *                       beats this and nothing needs to.
 *   TITLE_WORD_WHOLE 7  a whole word of the title IS the token, further in.
 *                       "grey" against "The Grey".
 *   TITLE_HEAD_PART  6  the title begins with the token, part-way into a longer
 *                       word. "grey" against "Greyhound". This is what typing
 *                       towards a longer title looks like, so it has to score
 *                       well — and it has to score BELOW a title that contains
 *                       the finished word, which is the correction the
 *                       conformance diff forced: ranked above, a search for
 *                       "grey" answered with five Greyhounds and put "The Grey"
 *                       eighth.
 *   TITLE_WORD       5  a word of the title starts with the token. The ordinary
 *                       hit while somebody is still typing — "kni" in "The Dark
 *                       Knight".
 *   CAST_WORD        4  a cast member's name begins with the token. One rung
 *                       rather than two, because a cast list is a list of names
 *                       and "is a whole name" barely differs from "starts one" —
 *                       "Tom" is a whole word in both Tom Cruise and Tom Hanks.
 *                       Below every title match and above every mid-word one: an
 *                       actor named Aniston is a stronger answer than "aniston"
 *                       buried inside a title and a weaker one than a series
 *                       actually CALLED that.
 *   TITLE_MID        3  the token is inside a word of the title, not at its
 *                       start. "night" matching "Knight" is a real hit and
 *                       rarely the intended one.
 *   CAST_MID         2  the token is inside a cast member's name. The weakest
 *                       thing that still counts as a match.
 *
 * A gap of one between rungs, so that summing across tokens compares like with
 * like: two word-starts outrank one title-head plus one mid-word, which is the
 * right answer for "dark knight".
 */
export const EVIDENCE = {
  titleHead: 8,
  titleWordWhole: 7,
  titleHeadPart: 6,
  titleWord: 5,
  castWord: 4,
  titleMid: 3,
  castMid: 2,
  none: 0,
} as const;

/** Is the character at `at` the end of the string or a word boundary? */
function endsWord(text: string, at: number): boolean {
  return at >= text.length || text.charCodeAt(at) === 32;
}

/**
 * The best title evidence for one term, over the space-separated `norm` form.
 *
 * Walks every occurrence rather than stopping at the first, because one title
 * can hold the token both ways — "Greyhound Grey" begins with a partial and
 * contains a whole word — and taking the first would score it on whichever came
 * earlier in the string rather than on the better of the two. It stops as soon
 * as it hits the top rung, which nothing can beat.
 */
function titleEvidence(norm: string, term: string): number {
  let best: number = EVIDENCE.none;
  if (norm.startsWith(term)) {
    if (endsWord(norm, term.length)) return EVIDENCE.titleHead;
    best = EVIDENCE.titleHeadPart;
  }
  const spaced = ` ${term}`;
  for (let at = norm.indexOf(spaced); at >= 0; at = norm.indexOf(spaced, at + 1)) {
    const value = endsWord(norm, at + spaced.length) ? EVIDENCE.titleWordWhole : EVIDENCE.titleWord;
    if (value > best) best = value;
    if (best === EVIDENCE.titleWordWhole) break;
  }
  return best;
}

/**
 * What a corrected token loses against a typed one.
 *
 * Three per edit, so one wrong letter costs more than the entire distance
 * between a word-start and a mid-word hit. A one-edit correction landing on the
 * very front of a title scores 8 - 3 = 5, no better than an exact word-start,
 * and a two-edit one drops to the floor.
 *
 * This is not what makes an exact match beat a corrected one — the exact/fuzzy
 * band in `scoreRow` does that, absolutely and at every score. This orders rows
 * WITHIN the corrected set, where the question is only "which reading of the
 * typo landed better", and there a closer reading should win.
 */
const EDIT_PENALTY = 3;
/** A corrected token that matched at all is worth something. Never zero. */
const FUZZY_FLOOR = 1;

/**
 * The evidence one term gives on one row.
 *
 * `norm` supplies the word boundaries and `compact` supplies the substring test,
 * and using both is not redundancy — `compact` has no spaces at all, so it can
 * never answer "does a word start here", and `norm` has had the quality tokens
 * and market prefix stripped, so it can never be trusted to answer "is this
 * anywhere in the title". Between them they answer both without adding a column
 * or folding a string at query time.
 */
function evidenceFor(
  cols: ItemColumns,
  row: number,
  term: string,
  cache: { norm: string | null; compact: string | null; cast: string | null },
): number {
  cache.norm ??= readText(cols.norm, row);
  const title = titleEvidence(cache.norm, term);
  /* Nothing outranks a title that begins with the whole word, so the cast column
     is never even looked at for those rows — which is most of them. */
  if (title === EVIDENCE.titleHead) return title;

  cache.cast ??= cols.cast.rows.length === 0 ? '' : castText(cols.cast, row);
  const cast = cache.cast;
  const named = cast !== '' && (cast.startsWith(term) || cast.includes(` ${term}`));
  if (title >= EVIDENCE.titleWord) return named && EVIDENCE.castWord > title ? EVIDENCE.castWord : title;
  if (named) return EVIDENCE.castWord;

  cache.compact ??= readText(cols.compact, row);
  if (cache.compact.includes(term)) return EVIDENCE.titleMid;
  if (cast !== '' && cast.includes(term)) return EVIDENCE.castMid;
  return EVIDENCE.none;
}

export interface SearchHit {
  row: number;
  score: number;
  /** True when every token was found as typed. Drives the primary sort band. */
  exact: boolean;
  /**
   * The row's raw name, read once when the hit is made.
   *
   * Carried on the hit rather than read inside the comparator, and the reason is
   * a measurement: a two-letter query produces 20,636 candidates on this
   * catalogue, sorting them is about 286,000 comparisons, and two `readText`
   * calls per comparison is 572,000 blob reads to answer a question 20,636 reads
   * already answer. That difference was 30ms of a 65ms query — the single
   * largest cost in the whole engine, spent entirely on re-reading the same
   * strings.
   */
  name: string;
}

/**
 * Score one row against the whole query, or reject it.
 *
 * Rejection is AND across tokens — "each space" means every word has to be
 * somewhere in the row — and it is why this returns null rather than a zero: a
 * row missing one token of three is not a weak answer, it is not an answer.
 *
 * @param terms  one entry per token: the token itself first, then whatever
 *               `correctToken` offered for it, each with the edit distance that
 *               produced it. A token nobody corrected has a single entry at
 *               distance 0.
 */
export function scoreRow(
  cols: ItemColumns,
  row: number,
  terms: readonly (readonly Correction[])[],
  phrase: string,
): SearchHit | null {
  const cache = { norm: null as string | null, compact: null as string | null, cast: null as string | null };
  let total = 0;
  let exact = true;
  for (const alternatives of terms) {
    let best = 0;
    let bestExact = false;
    for (const alt of alternatives) {
      const raw = evidenceFor(cols, row, alt.word, cache);
      if (raw === EVIDENCE.none) continue;
      const value = alt.distance === 0
        ? raw
        : Math.max(FUZZY_FLOOR, raw - EDIT_PENALTY * alt.distance);
      if (value > best) {
        best = value;
        bestExact = alt.distance === 0;
      } else if (value === best && alt.distance === 0) {
        bestExact = true;
      }
    }
    if (best === 0) return null;
    total += best;
    if (!bestExact) exact = false;
  }

  /*
   * The phrase bonus, and the reason it is worth its own pass.
   *
   * Token AND-matching alone cannot tell "The Dark Knight" from a film that
   * happens to contain "dark" in its title and "Knight" in its cast. The
   * compacted query — the exact thing the OLD search looked for — is still the
   * strongest signal there is when it is present, so it is added on top rather
   * than replaced: 40 for the words appearing together anywhere, 90 for the
   * title starting with them. Both are larger than any single rung and smaller
   * than the exact/fuzzy band below, so a phrase hit reorders within a band and
   * never jumps one.
   *
   * ── and only for a query that HAS a phrase ──
   *
   * With one token the phrase and the token are the same string, so the bonus
   * scores the same fact twice at fourteen times the weight, and the ladder
   * above stops deciding anything. Concretely: "grey" against "Greyhound"
   * (starts with it, 6 + 90) beat "The Grey" (holds the whole word, 7 + 40), so
   * the rung that exists to prefer the finished word was worth six points
   * against ninety. On the live catalogue the market prefix in `compact`
   * ("nlgreyhound2020") hid it, which is the worst way for a scoring bug to
   * survive — invisible on real data and wrong on the next provider that files
   * titles without one.
   *
   * Adjacency is a fact about two or more words. There is nothing for it to say
   * about one.
   */
  if (terms.length > 1 && phrase.length >= 2) {
    const compact = (cache.compact ??= readText(cols.compact, row));
    if (compact.startsWith(phrase)) total += 90;
    else if (compact.includes(phrase)) total += 40;
  }

  /* Everything typed correctly outranks anything corrected, whatever the
     evidence — 1,000 is above any reachable sum of rungs and bonuses. */
  return {
    row,
    score: (exact ? 1000 : 0) + total,
    exact,
    name: readText(cols.names, row),
  };
}

/**
 * Best first, and the same order every time.
 *
 * After the score, the tie-breaks are the ones `search` has always used and they
 * are kept verbatim: shortest name first, so "TF1" beats "TF1 Series Movies" and
 * a search for a channel finds the channel rather than the package named after
 * it; then code-point order, matching the server's `name COLLATE "C"`, because
 * `localeCompare` put "AR| I24 NEWS" above "ALB| NEWS 24" and byte order does
 * not; then the row index, which is the provider's own order.
 *
 * The row index at the end is not decoration. It is what makes the order TOTAL,
 * and a total order is what stops the results reshuffling under the highlight
 * between one keystroke and the next.
 */
export function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.name.length - b.name.length || cmpKey(a.name, b.name) || a.row - b.row;
}

/* ── the engine ────────────────────────────────────────────────────────────── */

export interface SearchOptions {
  limit?: number;
  /**
   * The dictionary, when one has been built.
   *
   * Absent means "no fuzzy this time", not "fail" — see `buildWordIndex`. Every
   * other stage works without it.
   */
  index?: WordIndex | null;
}

/**
 * Below this many hits, a query is thin enough to be worth correcting.
 *
 * Not zero. "shawshank redemtion" finds the one film whose title carries the
 * typo'd word anyway and would look answered, while the actual Shawshank sits
 * unfound — so the trigger is "did this produce a page worth looking at", not
 * "did this produce anything". Twelve is the number of posters a secondary block
 * on the search screen draws (`SECONDARY` in `routes/Search.tsx`).
 */
export const CORRECTION_FLOOR = 12;

export interface SearchAnswer {
  live: SearchHit[];
  movies: SearchHit[];
  series: SearchHit[];
  /** True when a spelling correction is what produced these rows. */
  corrected: boolean;
  /**
   * How many rows matched BEFORE the per-section cap.
   *
   * The caller needs this to decide whether the answer was worth showing, and it
   * cannot work it out from the lists: three sections capped at 24 look
   * identical whether they came from 72 matches or 20,000. `localSearch` uses it
   * to decide whether to wait for the spelling dictionary — see
   * `CORRECTION_FLOOR`.
   */
  total: number;
}

/**
 * Rows matching the query, ranked, across every section at once.
 *
 * One sweep answers all three sections: the old `search` called `matchRows`
 * three times and paid for three full scans of 266,141 rows to fill three lists
 * of 24. The kind test is a `Uint8Array` read, so splitting the candidates
 * afterwards is free.
 */
export function searchAll(
  cat: Catalogue,
  raw: string,
  opts: SearchOptions = {},
): SearchAnswer {
  const empty: SearchAnswer = { live: [], movies: [], series: [], corrected: false, total: 0 };
  const tokens = tokenise(raw);
  const phrase = compactQuery(raw);
  /* The same floor the old search used: two characters of substance. One letter
     matches a third of the catalogue and ranks it arbitrarily. */
  if (tokens.length === 0 || phrase.length < 2) return empty;

  const exactTerms: Correction[][] = tokens.map((t) => [{ word: t, distance: 0 }]);
  let hits = collect(cat, tokens, exactTerms, phrase, opts);
  let corrected = false;

  /*
   * The fuzzy pass, and why it is a SECOND pass rather than a wider first one.
   *
   * Correcting every token up front would run the dictionary scan on every
   * keystroke of every correctly-spelled query — the overwhelming majority — to
   * benefit the minority that need it, and would widen the candidate set for all
   * of them. Running it only when the exact answer is thin means a search that
   * was already going to succeed pays nothing at all, and the one that was going
   * to fail pays a few milliseconds it had to spare.
   */
  const index = opts.index ?? null;
  if (index !== null && total(hits) < CORRECTION_FLOOR) {
    /**
     * Widen the query and search again, or return null if nothing widened.
     *
     * @param anyWord  correct even words the catalogue DOES contain. See the two
     *                 rounds below.
     */
    const widen = (anyWord: boolean): SectionHits | null => {
      const terms = tokens.map((token, i) => {
        const budget = editBudget(token.length);
        if (budget === 0) return exactTerms[i]!;
        /* A word this catalogue contains is not a typo — see `knowsWord`, and
           the "sky news" answer it was giving before that check existed. */
        if (!anyWord && knowsWord(index, token)) return exactTerms[i]!;
        const fixes = nearestTier(correctToken(index, token, budget), token);
        return fixes.length === 0 ? exactTerms[i]! : [...exactTerms[i]!, ...fixes];
      });
      if (!terms.some((t, i) => t.length > exactTerms[i]!.length)) return null;
      return collect(cat, tokens, terms, phrase, opts);
    };

    /*
     * Round one: only the words this catalogue has never heard of.
     *
     * This is the ordinary case and it is the one that has to stay quiet. A
     * query made of real words is spelled correctly however few rows it
     * matches, and widening it is how "sky news" — three real channels and
     * under the thin floor — came back with two dozen films containing "new"
     * and "sky".
     */
    const first = widen(false);
    if (first !== null && total(first) > total(hits)) {
      hits = first;
      corrected = true;
    }

    /*
     * Round two: everything, and only when round one found NOTHING.
     *
     * The case this exists for is a mistyped name that happens to be spelled
     * some other way somewhere in a 266,141-row catalogue: "jenifer" is a real
     * word here, so round one leaves it alone, and "jenifer anistn" corrects
     * only the surname and still matches no row at all. Zero results is the one
     * state where guessing at a word the catalogue does know cannot make the
     * answer worse, because there is no answer to spoil — and `corrected` says
     * on screen that this is what happened.
     */
    if (total(hits) === 0) {
      const second = widen(true);
      if (second !== null && total(second) > 0) {
        hits = second;
        corrected = true;
      }
    }
  }

  const limit = opts.limit ?? 24;
  return {
    live: hits.live.slice(0, limit),
    movies: hits.movies.slice(0, limit),
    series: hits.series.slice(0, limit),
    corrected,
    total: total(hits),
  };
}

/**
 * Keep only the closest readings of a typo, and never the token itself.
 *
 * Every extra correction is another full sweep of a 5.76MB blob plus its
 * candidates, so the cost of being generous here is linear and immediate:
 * "avengrs" corrects to "avengers" at one edit and to "avenger", "avenir",
 * "avangers", "avenged" and "avenues" at two, and searching all six took 64ms
 * against 8ms for the one that is obviously what was meant. Measured on this
 * catalogue.
 *
 * It is also better ANSWERS, not only a cheaper query. A word one edit away is a
 * closer reading of what somebody typed than a word two edits away, and mixing
 * the tiers puts "Avenues" beside "Avengers" as though the engine had no opinion.
 * If the closest tier finds nothing the query simply comes back empty, which is
 * the honest reply — it does not then go fishing in the next tier.
 *
 * The token itself is dropped because the exact pass already searched it; the
 * only reason it appears in a correction list at all is that a typo can be a
 * real word somewhere else in a 266,141-row catalogue.
 */
function nearestTier(fixes: readonly Correction[], token: string, cap = MAX_FIXES): Correction[] {
  let best = Infinity;
  for (const f of fixes) if (f.word !== token && f.distance < best) best = f.distance;
  if (best === Infinity) return [];
  /* `correctToken` already ordered the tier by how often each word occurs in
     this catalogue, so slicing keeps the readings somebody is most likely to
     have meant. */
  return fixes.filter((f) => f.word !== token && f.distance === best).slice(0, cap);
}

/**
 * How many readings of one mistyped word are searched.
 *
 * Each one is a full `indexOf` pass over the 5.76MB compact blob, measured at
 * about 4ms on the development box, so this number is a direct multiplier on the
 * worst case: "jenifer" has four one-edit neighbours in this catalogue
 * ("jennifer", "jeniffer", "renifer", "yenifer") and searching all of them plus
 * the original took 49ms against 22ms for the three commonest. Three is where
 * the tail stops being plausible — past the third most frequent reading of a
 * typo the words are ones nobody was reaching for.
 */
const MAX_FIXES = 3;

function total(h: SectionHits): number {
  return h.live.length + h.movies.length + h.series.length;
}

/**
 * Sweep, verify, score and rank — the part that runs once per pass.
 *
 * `terms[0]` drives the sweep because `tokenise` sorted the longest token first.
 * Every alternative for that token gets its own sweep, which is why
 * `correctToken` is capped: each one is a full pass over the blob.
 *
 * The cast blob is swept too, and separately, because a row can carry a token in
 * its cast and nowhere in its title — "aniston" is in nobody's title. Sweeping
 * the compact blob alone made cast search look like it worked on the rows that
 * happened to name the actor in the title, which is the most confusing possible
 * outcome: it works often enough to be trusted and fails without a signal.
 */
interface SectionHits { live: SearchHit[]; movies: SearchHit[]; series: SearchHit[] }

function collect(
  cat: Catalogue,
  tokens: readonly string[],
  terms: readonly (readonly Correction[])[],
  phrase: string,
  opts: SearchOptions,
): SectionHits {
  const cols = cat.items;
  const keep = {
    [KIND.Live]: sectionFilter(cat, KIND.Live),
    [KIND.Movie]: sectionFilter(cat, KIND.Movie),
    [KIND.Series]: sectionFilter(cat, KIND.Series),
  } as Record<number, (row: number) => boolean>;

  const live: SearchHit[] = [];
  const movies: SearchHit[] = [];
  const series: SearchHit[] = [];
  /* A row can be reached through the title sweep AND the cast sweep, and through
     more than one correction of the same token. Seen once, scored once. */
  const seen = new Set<number>();

  const consider = (row: number): void => {
    if (seen.has(row)) return;
    seen.add(row);
    const kind = cols.kind[row] ?? 0;
    const bucket = kind === KIND.Live ? live : kind === KIND.Movie ? movies : kind === KIND.Series ? series : null;
    if (bucket === null) return;
    if (!keep[kind]!(row)) return;
    const hit = scoreRow(cols, row, terms, phrase);
    if (hit !== null) bucket.push(hit);
  };

  for (const alt of terms[0] ?? []) {
    sweep(cols.compact, alt.word, consider);
    /*
     * The cast sweep starts at three characters, and the threshold is a
     * measurement rather than taste.
     *
     * "da" occurs in 20,636 titles and in roughly half of the 33,636 cast lines
     * on this catalogue — every Daniel, David, Amanda and Dakota — so sweeping
     * the cast for it added about 10,000 candidates and 25ms to a query that
     * cannot use them: a two-letter fragment of somebody's name is not a search
     * for a person, and none of those rows can outrank a title that starts with
     * the same two letters. Three is the same floor `editBudget` uses to decide
     * a word is a word at all.
     */
    if (cols.cast.rows.length > 0 && alt.word.length >= MIN_WORD) {
      sweepCast(cols.cast, alt.word, consider);
    }
  }

  /*
   * Live channels collapse into families, exactly as `matchRows` does.
   *
   * Without this a search for "bbc one" answers with the FHD, HD, HEVC and RAW
   * feeds of the same channel filling the row — 5,585 alternative feeds across
   * this catalogue, and a search screen is the worst place to spend twelve tiles
   * on four copies of one thing. `collapseFamilies` picks the best feed by the
   * same quality ladder the channel list uses, so the row that appears here is
   * the row that would be played.
   */
  const liveRows = new Set(collapseFamilies(cat, live.map((h) => h.row)));
  const collapsed = live.filter((h) => liveRows.has(h.row));

  return {
    live: collapsed.sort(compareHits),
    movies: movies.sort(compareHits),
    series: series.sort(compareHits),
  };
}

/**
 * The cast sweep, which is the same idea one indirection further out.
 *
 * `CastColumn` is indexed by ENTRY rather than by row, so a blob position
 * resolves to an entry and the entry resolves to a catalogue row through
 * `rows`. That indirection is the price of not spending 1.06MB of offsets on the
 * 87.4% of rows that have no cast — see `CastColumn`.
 */
function sweepCast(col: CastColumn, needle: string, emit: (row: number) => void): void {
  sweep(col.text, needle, (entry) => {
    const row = col.rows[entry];
    if (row !== undefined) emit(row);
  });
}

/**
 * Search across all three sections, as the app asks for it.
 *
 * The signature and the shape of the answer are unchanged from the version that
 * lived in `query.ts`, because thirty call sites and a conformance snapshot
 * depend on both. What changed is everything behind it — see the file header.
 */
export function search(
  cat: Catalogue,
  raw: string,
  opts: SearchOptions = {},
): {
  live: ItemView[];
  movies: ItemView[];
  series: ItemView[];
  /** True when a spelling correction produced these rows. See `SearchAnswer`. */
  corrected: boolean;
  /** Matches before the per-section cap. See `SearchAnswer.total`. */
  total: number;
} {
  const found = searchAll(cat, raw, opts);
  const rows = (hits: SearchHit[]): ItemView[] => hits.map((h) => viewItem(cat.items, h.row));
  return {
    live: rows(found.live),
    movies: rows(found.movies),
    series: rows(found.series),
    corrected: found.corrected,
    total: found.total,
  };
}
