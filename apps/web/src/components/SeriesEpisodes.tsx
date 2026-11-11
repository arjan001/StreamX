import { useEffect, useRef } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Episode } from '../lib/api';
import {
  seasonProgress, type EpisodeProgress, type SeasonState,
} from '../lib/seriesProgress';

/**
 * The episodes of the open series, season by season — under its hero.
 *
 * "Below it will be episodes and everything", and then the half of the request
 * that is about colour: "add the progress and if they already watched it, like
 * all those kinds of things highlighted in a different color, they already
 * watched a season or an episode."
 *
 * ── two colours, and only two ──
 *
 * The palette has one attention colour (`tally`) and one affirmative
 * (`live` — the green behind the LIVE badge and the online dots), and this
 * screen needs exactly those two meanings:
 *
 *   tally   where you are. The open series, the open season, the row playing,
 *           and the bar under a part-watched episode.
 *   live    behind you. A finished episode, a finished season.
 *
 * They must not be the same colour. Marking watched episodes in tally as well
 * would put twenty rows of highlight around the one row that is actually
 * highlighted, which is the "I can't tell what is selected" report in advance.
 * A watched row also drops its title to `ink-2`: colour says what happened,
 * weight says what is still ahead.
 *
 * ── one season open at a time ──
 *
 * A series here can carry 22 seasons and several hundred episodes, and putting
 * all of them in one scroller is both a long walk on a D-pad and a lot of DOM on
 * a television — and this column is half a screen tall, not a whole one. So the seasons are the `LiveSidebar` country tree's grammar,
 * with its exact behaviour: pressing a season opens it, pressing the one already
 * open folds it, and the chevron is a SIGN of what will happen rather than a
 * target of its own. A single-season series shows no header at all — a control
 * whose only outcome is hiding the thing you came for.
 */
export function SeriesEpisodes({
  seriesKey,
  groups,
  marks,
  activeSeason,
  onSeason,
  playingId,
  onPlay,
  loading,
  error,
}: {
  /** Which series these belong to — only ever compared, never displayed. */
  seriesKey: string;
  /** Seasons in order, each with its episodes in order. See `bySeason`. */
  groups: { season: number; episodes: Episode[] }[];
  marks: Map<number, EpisodeProgress>;
  activeSeason: number | null;
  onSeason: (season: number | null) => void;
  playingId: number | null;
  onPlay: (episode: Episode) => void;
  loading: boolean;
  error: string | null;
}) {
  /*
   * Bring the open season's first episode into view when the series changes.
   *
   * A pane keeps the scroll offset of the title before it, so on a series with
   * fewer episodes than the last one this column opened part-way down an empty
   * scroller. Keyed on the series rather than on its NAME: two titles can share
   * a display name, and a name arrives a moment after the id does.
   */
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [seriesKey]);

  const multi = groups.length > 1;
  const episodeCount = groups.reduce((n, g) => n + g.episodes.length, 0);

  /*
   * The doorway hands over as soon as it has something to hand over.
   *
   * The `onFocus` below only fires when focus ARRIVES, and the common case on
   * this screen is that it arrives first: a viewer presses RIGHT while the
   * detail request is still out, the column is legitimately empty, and the
   * container keeps the highlight. Then the episodes land underneath it and the
   * focus ring is still drawn around the whole 460x667 pane — screenshotted at
   * both sizes, and it is precisely the "it selects windows instead of the item"
   * report the doorway rule exists to prevent.
   *
   * Only when the CONTAINER itself is what holds focus: if the viewer has since
   * moved anywhere else, this must not reach across the screen and take the
   * highlight off whatever they are on.
   */
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    if (episodeCount === 0) return;
    if (document.activeElement !== pane.current) return;
    const first = pane.current?.querySelector<HTMLElement>('[data-nav-group="episodes"] button');
    if (first) first.focus();
  }, [episodeCount, activeSeason]);

  return (
    <section
      ref={pane}
      /*
        A section, so a press cannot fall out of it sideways into the picture —
        see `clearsSection`: a move that leaves a section has to land beyond it.
        The scope on the column around this one carries the same rule for the
        hero, and the grid a screen below is a scope of its own, so DOWN out of
        the last episode row lands there rather than beside it.
      */
      data-nav-scope
      /*
        Where the remote starts on this screen.

        `focusFirst` looks for this before it falls back to reading order, and
        reading order here is the hero's star — a viewer arriving at a series
        wants the list, not the bookmark. Landing on the pane rather than on a
        row is deliberate and is the same doorway described below: the episodes
        may still be loading, and the `onFocus` handler hands off to the first
        row the moment there is one.
      */
      data-nav-first
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      /*
        The DOORWAY into this column, and it has to be the column itself.
        ────────────────────────────────────────────────────────────────────
        "i cannot go right, bcs there is nothing, so it doesnt navigate so i can
        see the eps." Measured: on arrival nothing here is focusable — no series
        chosen, or its episodes still loading — so RIGHT out of the rail found no
        candidate level with the row it was on and did nothing at all. The middle
        of a three-column screen was unreachable from the first press.

        `spatialNav.move()` already has the answer and the player column beside
        this one already uses it: a focusable container that is FULL of focusable
        things is dropped as a candidate (`dropDoorways`), so the highlight lands
        on an episode rather than on the box around it — but the second walk in
        `move()` offers those containers again when the first walk found nothing
        reachable. So this is a target only while there is nothing better inside
        it, which is exactly when it is needed.

        `tabIndex` is unconditional, unlike the player column's, and the
        difference is honest rather than sloppy: the player pane is a doorway to
        a PICTURE that may not exist yet, so it takes its tabIndex only when
        something is playing; this pane always holds a list, even when the list
        is a skeleton or a sentence, and the viewer must always be able to get to
        it. The rules that make that safe are `dropDoorways` and the two-pass
        walk, not the presence of the attribute.
      */
      tabIndex={0}
      onFocus={(e) => {
        /* Only when the COLUMN itself was landed on: a bubbled focus event from
           an episode row must not be answered by moving focus somewhere else,
           which would be an infinite ping-pong between two rows. */
        if (e.target !== e.currentTarget) return;
        const first = e.currentTarget.querySelector<HTMLElement>(
          '[data-nav-group="episodes"] button',
        );
        /* Belt and braces over `dropDoorways`: if rows exist by the time focus
           actually arrives — a race the virtual list can lose by a frame — the
           highlight ends up on a row rather than on a full-height container,
           which is what "it selects windows instead of the item" meant. */
        if (first !== null) first.focus();
      }}
    >
      {/*
        No head above the list.

        There was a one-word EPISODES label here, as a boundary between the
        description and the list. It cost 23px of a column that has under 200 for
        rows — half an episode — and the boundary is already drawn: the hero above
        has a rule under it, and the first row of a multi-season series is its
        season header. A label that costs a row to say what the rows obviously
        are is furniture.
      */}
      <div
        ref={scroller}
        /* Named for the D-pad, so leaving for the picture and coming back lands
           on the episode you left rather than on whatever is nearest. */
        data-nav-group="episodes"
        data-nav-memory
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {error !== null ? (
          <p className="p-6 font-mono text-[length:var(--t-xs)] leading-relaxed text-alert">{error}</p>
        ) : loading ? (
          <div className="space-y-px p-3">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton h-11" />)}
          </div>
        ) : episodeCount === 0 ? (
          <p className="p-6 font-mono text-[length:var(--t-xs)] leading-relaxed text-ink-3">
            the panel returned no episodes for this series.
          </p>
        ) : (
          groups.map(({ season, episodes }) => {
            const roll = seasonProgress(episodes, marks);
            const open = !multi || season === activeSeason;
            return (
              <div key={season}>
                {multi && (
                  <button
                    type="button"
                    onClick={() => onSeason(open ? null : season)}
                    aria-expanded={open}
                    className={`pick tap w-full gap-3 border-b border-rule/60 px-4 py-2.5
                      ${open ? 'is-on' : ''}`}
                  >
                    <span className="pick-title min-w-0 flex-1 truncate text-[length:var(--t-md)]">
                      Season {season}
                    </span>
                    <SeasonMark state={roll.state} fraction={roll.fraction} />
                    <span
                      aria-hidden
                      className={`grid w-6 shrink-0 place-items-center ${open ? 'text-tally' : 'text-ink-3'}`}
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
                      />
                    </span>
                  </button>
                )}
                {open && episodes.map((e) => (
                  <EpisodeRow
                    key={e.episodeId}
                    episode={e}
                    mark={marks.get(e.episodeId) ?? { state: 'unseen', fraction: 0 }}
                    playing={e.episodeId === playingId}
                    onPlay={onPlay}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function EpisodeRow({
  episode,
  mark,
  playing,
  onPlay,
}: {
  episode: Episode;
  mark: EpisodeProgress;
  playing: boolean;
  onPlay: (episode: Episode) => void;
}) {
  const watched = mark.state === 'watched';
  const started = mark.state === 'started';
  const mins = episode.durationSecs !== null && episode.durationSecs >= 60
    ? `${Math.round(episode.durationSecs / 60)} min`
    : null;
  return (
    <button
      type="button"
      onClick={() => onPlay(episode)}
      className={`pick row-hover w-full gap-3 border-b border-rule/25 px-4 py-2.5
        ${playing ? 'is-on' : ''}`}
    >
      {/*
        The number carries the state, because it is the one part of the row that
        is the same width on every row: a column of numbers where the ones behind
        you are green reads as progress from across a room, and a coloured title
        does not — titles are ragged, and half of them are "Episode 12".
      */}
      <span
        className={`w-8 shrink-0 font-mono text-[length:var(--t-sm)] tabular-nums
          ${watched ? 'text-live' : started ? 'text-tally' : 'text-ink-3'}`}
      >
        {String(episode.episodeNumber ?? 0).padStart(2, '0')}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[length:var(--t-md)]
            ${playing ? 'text-tally' : watched ? 'text-ink-2' : 'text-ink'}`}
        >
          {episodeTitle(episode.title, episode.episodeNumber)}
        </span>
        {started && <Meter fraction={mark.fraction} className="mt-1.5 max-w-56" />}
      </span>
      {watched && <Check aria-hidden className="h-4 w-4 shrink-0 text-live" />}
      {mins !== null && (
        <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
          {mins}
        </span>
      )}
    </button>
  );
}

/**
 * What a season header says about itself, without saying a number.
 *
 * "6 of 10" is a tally beside a label, and this app's tallies are off by default
 * for a reason that applies here twice over — see lib/tally. A bar is the same
 * fact in a form that is legible at three metres and takes no reading.
 */
function SeasonMark({ state, fraction }: { state: SeasonState; fraction: number }) {
  if (state === 'watched') return <Check aria-hidden className="h-4 w-4 shrink-0 text-live" />;
  if (state === 'partial') return <Meter fraction={fraction} className="w-16 shrink-0" />;
  /* Nothing at all for a season nobody has started. An empty bar on every row of
     an untouched series is twenty pieces of furniture saying "no". */
  return null;
}

function Meter({ fraction, className }: { fraction: number; className?: string }) {
  return (
    <span aria-hidden className={`meter block h-1 overflow-hidden bg-rule ${className ?? 'w-full'}`}>
      <span
        className="block h-full bg-tally"
        style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
      />
    </span>
  );
}

/**
 * Panel episode titles are the series name plus the SxxExx code the row already
 * shows — "4K - 1883 (2021) - S01E01 - Le fleuve", or nothing but that code on
 * the many series with no per-episode titles at all. Keep whatever follows it.
 */
export function episodeTitle(raw: string, episodeNumber: number | null) {
  const code = /\bS?\d{1,3}\s*E\s*\d{1,4}\b\s*[-–·|:]*\s*/i.exec(raw);
  const tail = (code ? raw.slice(code.index + code[0].length) : raw).trim();
  if (tail.length > 0) return tail;
  return episodeNumber === null ? raw.trim() : `Episode ${episodeNumber}`;
}
