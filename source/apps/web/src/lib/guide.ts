/**
 * Guide arithmetic: windows, blocks, and what is playable.
 *
 * All of it pure, because every bug this feature can have is an arithmetic bug —
 * a block one column out, a day chip that offers a recording the panel no longer
 * keeps, a duration in the wrong unit. Those are cheap to test and expensive to
 * find by looking at a grid.
 *
 * Times are epoch SECONDS throughout, because that is the only thing the panel
 * gives that can be trusted: `start`/`end` are server-local strings with no
 * marker, while `start_timestamp`/`stop_timestamp` are correct epochs.
 */

export interface Slot {
  title: string | null;
  description: string | null;
  startTs: number;
  stopTs: number | null;
}

export const HOUR = 3600;
export const DAY = 86_400;

/** Round down to a slot boundary, so columns line up across every channel. */
export function floorTo(ts: number, stepS: number): number {
  return Math.floor(ts / stepS) * stepS;
}

/**
 * Where a programme sits in the window, as percentages.
 *
 * Clamped to the window rather than dropped: a film that started two hours before
 * the window still occupies the left edge, and a viewer needs to see that it is
 * already running rather than see an empty cell.
 */
export function blockGeometry(
  slot: { startTs: number; stopTs: number | null },
  from: number,
  spanS: number,
  /**
   * When the next programme on this channel begins, if it is known.
   *
   * A listing with no `stopTs` used to be assumed an hour long, and on a panel
   * that omits stop times — several do — that put an hour-wide block over every
   * neighbour that started sooner. That is the overlap in the guide: two titles
   * painted on top of each other, both unreadable. The next start is the real
   * end of this programme, so it wins over the assumption whenever it is there.
   */
  nextStartTs?: number | null,
): { leftPct: number; widthPct: number } | null {
  const stop = slot.stopTs
    /* Still capped at an hour: a channel with one listing and then a six-hour
       gap must not draw a six-hour block, which is the opposite failure. */
    ?? Math.min(nextStartTs ?? slot.startTs + HOUR, slot.startTs + HOUR);
  const to = from + spanS;
  if (stop <= from || slot.startTs >= to) return null;
  const start = Math.max(slot.startTs, from);
  const end = Math.min(stop, to);
  return {
    leftPct: ((start - from) / spanS) * 100,
    /*
     * The true width, with no floor.
     *
     * There was a 0.4% minimum, which at a six-hour span is about six pixels —
     * and those six pixels came out of the NEXT programme, because a block
     * inflated past its own end still starts where the next one does. So the
     * floor that existed to keep short programmes visible was itself a second
     * source of overlap, and what it made visible was a sliver too narrow to
     * hold a character: the "S", "S2", "RG", "V" column at the right of the
     * grid. Visibility is the renderer's job now — a hairline minimum in CSS,
     * which cannot overlap anything — and legibility is what the zoom control
     * is for.
     */
    widthPct: Math.max(((end - start) / spanS) * 100, 0),
  };
}

/**
 * How wide a minute should be, chosen from what is actually in the guide.
 *
 * The scale was a constant — four pixels a minute, whatever the listings looked
 * like. On a channel of half-hour programmes that is a comfortable 120px a
 * block; on one running five-minute segments it is twenty pixels and a column of
 * clipped single letters, which is what "everything gets cramped" was. The right
 * number is not a constant, it is a function of the content: pick the zoom that
 * makes a TYPICAL programme readable.
 *
 * The median, not the mean. A guide is full of outliers in both directions — a
 * one-minute filler, an eight-hour overnight loop — and a mean chases them,
 * which is how one weird row would decide the zoom for the whole grid.
 *
 * ── Why it snaps to steps ───────────────────────────────────────────────────
 * A continuous answer moves every time a row finishes loading, and a grid that
 * re-scales under the pointer while you are reading it is worse than one that is
 * slightly too tight. Seven steps are enough to cover a fifty-fold range, and
 * landing on one of them is stable: the median has to move a long way to change
 * the answer.
 *
 * The clamp at both ends is the "min and max" of it. Below 1.5 the hour ticks
 * collide; above 12 a six-hour span is a five-metre-wide track nobody can
 * navigate with a D-pad.
 */
export const PPM_STEPS = [1.5, 2, 3, 4, 6, 9, 12] as const;
/** How wide the typical programme should come out. */
const TARGET_PX = 120;
/** The step used when there is nothing to measure — the old constant. */
export const PPM_DEFAULT = 4;

export function autoPxPerMin(
  durationsS: readonly number[],
  targetPx: number = TARGET_PX,
): number {
  const mins = durationsS
    .filter((d) => Number.isFinite(d) && d > 0)
    .map((d) => d / 60)
    .sort((a, b) => a - b);
  if (mins.length === 0) return PPM_DEFAULT;
  const mid = Math.floor(mins.length / 2);
  const median = mins.length % 2 === 0
    ? ((mins[mid - 1] ?? 0) + (mins[mid] ?? 0)) / 2
    : mins[mid] ?? 0;
  if (median <= 0) return PPM_DEFAULT;
  const ideal = targetPx / median;
  /* Nearest step in RATIO, not in difference: 1.5 and 2 are as far apart to the
     eye as 9 and 12 are, and a linear nearest would crowd every answer into the
     top of the range. */
  let best = PPM_STEPS[0] as number;
  let bestErr = Infinity;
  for (const step of PPM_STEPS) {
    const err = Math.abs(Math.log(step / ideal));
    if (err < bestErr) { bestErr = err; best = step; }
  }
  return best;
}

/** How far through a programme "now" is, or null when it is not on air. */
export function progress(slot: { startTs: number; stopTs: number | null }, nowS: number): number | null {
  const stop = slot.stopTs ?? slot.startTs + HOUR;
  if (nowS < slot.startTs || nowS >= stop) return null;
  return (nowS - slot.startTs) / Math.max(1, stop - slot.startTs);
}

export function slotAt(slots: readonly Slot[], ts: number): Slot | null {
  return slots.find((s) => s.startTs <= ts && ts < (s.stopTs ?? s.startTs + HOUR)) ?? null;
}

export type SlotState = 'past' | 'live' | 'future';

export function slotState(slot: { startTs: number; stopTs: number | null }, nowS: number): SlotState {
  const stop = slot.stopTs ?? slot.startTs + HOUR;
  if (stop <= nowS) return 'past';
  if (slot.startTs <= nowS) return 'live';
  return 'future';
}

/**
 * Is this programme actually recoverable?
 *
 * Three independent conditions, and all of them have to hold, which is why this
 * is one function rather than three checks scattered through a component:
 *
 * - it has finished (a programme still on air is live, not catch-up)
 * - the panel flagged an archive for it, or the channel has one at all
 * - it started inside the channel's retention window — 97.7% of archive channels
 *   here keep three days or fewer, so this is the condition that fails most
 *
 * The window is measured from the START of the programme, not its end: a panel
 * that keeps three days has nothing before that point, however recently the
 * programme finished.
 */
export function isPlayable(
  slot: { startTs: number; stopTs: number | null; hasArchive?: boolean },
  channel: { archive: boolean; archiveDays: number },
  nowS: number,
): boolean {
  if (!channel.archive) return false;
  if (slotState(slot, nowS) !== 'past') return false;
  if (slot.hasArchive === false && !channel.archive) return false;
  const days = channel.archiveDays > 0 ? channel.archiveDays : 1;
  return nowS - slot.startTs <= days * DAY;
}

/**
 * A channel's own retention, in days — zero when it keeps nothing.
 *
 * Narrower than `isPlayable`'s own reading, which still allows one day when the
 * panel reports archive with `archiveDays` 0 — that leniency is about whether one
 * FINISHED programme can be replayed. This is about whether a whole TRACK of
 * history is worth drawing at all, and a channel reporting zero days is not
 * something to draw a day of blocks over: "for channels that have no catch-up it
 * makes no sense to show historic EPG data" was the partner's own framing.
 */
export function effectiveArchiveDays(channel: { archive: boolean; archiveDays: number }): number {
  return channel.archive ? Math.max(0, channel.archiveDays) : 0;
}

/**
 * How far back a channel's row may show programmes, epoch seconds.
 *
 * A channel with no catch-up has nothing before now, so its floor IS now — every
 * finished programme on it is excluded. A channel that keeps N days has a floor N
 * days back and no further, the same window `isPlayable` measures a single slot
 * against.
 */
export function archiveFloor(channel: { archive: boolean; archiveDays: number }, nowS: number): number {
  const days = effectiveArchiveDays(channel);
  return days > 0 ? nowS - days * DAY : nowS;
}

/**
 * How far into the past the guide's window may open, across a page of channels.
 *
 * The window is one shared strip of time for every row in it, so this is the
 * DEEPEST archive on screen — a channel with less retention just goes quiet past
 * its own floor (`visibleSlots`), but nothing needs the window to stop short of
 * whatever any visible channel can still show. No archive anywhere on screen
 * means there is nothing to travel back to: the window opens at now.
 */
export function guideMinTs(
  channels: readonly { archive: boolean; archiveDays: number }[],
  nowS: number,
): number {
  if (channels.length === 0) return nowS;
  return Math.min(...channels.map((c) => archiveFloor(c, nowS)));
}

/** Local midnight, epoch seconds — the same boundary `dayChips` counts from. */
function localMidnight(nowS: number): number {
  const d = new Date(nowS * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * How far into the future the guide's window may open.
 *
 * There is no recording here, so a schedule for next week is a schedule for
 * nothing the app can ever set to record. "Maybe what's on the next day, at
 * most" was the partner's own ceiling — the end of TOMORROW, measured from local
 * midnight so the cap does not creep earlier as the evening goes on. It is always
 * two local days away, whatever time it is right now.
 */
export function guideMaxTs(nowS: number): number {
  return localMidnight(nowS) + 2 * DAY;
}

/**
 * The slots a channel's row is actually allowed to show.
 *
 * A finished programme older than the channel's own floor is dropped before it
 * ever reaches the renderer — not merely marked unplayable, per the partner's own
 * framing above. Live and future slots are never affected; only something that
 * has already finished can be too old.
 */
export function visibleSlots<S extends { startTs: number; stopTs: number | null }>(
  slots: readonly S[],
  channel: { archive: boolean; archiveDays: number },
  nowS: number,
): S[] {
  const floor = archiveFloor(channel, nowS);
  return slots.filter((s) => slotState(s, nowS) !== 'past' || s.startTs >= floor);
}

export interface DayChip {
  /** Midnight local, epoch seconds. */
  ts: number;
  label: string;
  offset: number;
}

/**
 * The day strip.
 *
 * Bounded by what exists in both directions: the panel hands over seven days of
 * schedule, and the channel keeps `archiveDays` of recordings — so offering a day
 * outside either is offering something that cannot be shown. Local midnights,
 * because a day boundary is a local idea.
 */
export function dayChips(
  nowMs: number,
  opts: { back: number; forward: number },
): DayChip[] {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const out: DayChip[] = [];
  const back = Math.max(0, Math.floor(opts.back));
  const forward = Math.max(0, Math.floor(opts.forward));
  for (let d = -back; d <= forward; d++) {
    const day = new Date(today.getTime() + d * DAY * 1000);
    out.push({
      ts: Math.floor(day.getTime() / 1000),
      // `-back` with back = 0 is negative zero, which is not -0 === 0 to a deep
      // equality check and would make "today" compare unequal to itself.
      offset: d === 0 ? 0 : d,
      label:
        d === 0 ? 'Today'
        : d === -1 ? 'Yesterday'
        : d === 1 ? 'Tomorrow'
        : day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    });
  }
  return out;
}

/** Hour labels across a window, for the timeline header. */
export function hourTicks(from: number, spanS: number, stepS = HOUR): { ts: number; leftPct: number }[] {
  const out: { ts: number; leftPct: number }[] = [];
  const first = Math.ceil(from / stepS) * stepS;
  for (let ts = first; ts < from + spanS; ts += stepS) {
    out.push({ ts, leftPct: ((ts - from) / spanS) * 100 });
  }
  return out;
}

export function clockOf(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
