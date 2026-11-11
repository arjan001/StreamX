import { Link } from 'react-router-dom';
import { CalendarClock, Clock, History } from 'lucide-react';
import type { EpgResponse, EpgSlot, Item } from '../lib/api';
import { displayName } from '../lib/displayName';

/**
 * What is on this channel now, and what is on next.
 *
 * This replaces the technical sheet that used to sit under the picture — stream
 * id, transport, resolution, bitrate. Those explain why a channel misbehaves,
 * which is worth having, but they are not what anybody wants under a television
 * picture. They now live behind an info button; this is what takes their place.
 *
 * Three honest states, because a live catalogue has all three:
 *   - listings, so show now and next with the elapsed bar
 *   - a channel the guide does not cover, which is most free channels
 *   - listings AND an archive, which is the one case where catch-up is real
 */
export function NowNext({
  item,
  epg,
  guideLink = true,
}: {
  item: Item;
  epg?: EpgResponse | undefined;
  /**
   * Offer FULL GUIDE beside the title. Off where the page already offers the
   * guide one row up — the modern Live action row's EPG goes to the same place,
   * and two doors to one room, side by side, is the duplication the owner
   * photographed.
   */
  guideLink?: boolean;
}) {
  const now = epg?.now ?? null;
  const next = (epg?.upcoming ?? []).filter((s) => s !== now).slice(0, 3);
  const archiveDays = epg?.channel.archiveDays ?? 0;
  const hasArchive = (epg?.channel.archive ?? false) && archiveDays > 0;

  /* One treatment for both, so a channel with an archive and a channel without
     do not offer two differently-shaped ways out of the same row. */
  const pill = 'tap pill flex shrink-0 items-center gap-1.5 border border-rule px-2.5 py-1'
    + ' font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2'
    + ' hover:border-tally hover:text-tally'
    + ' focus-visible:border-focus focus-visible:text-focus';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="min-w-0 truncate text-[length:var(--t-lg)] font-semibold tracking-tight text-ink tv:text-[1.3rem]">
          {displayName(item.name)}
        </h2>
        {/*
          Where the guide is reached from now.

          It used to be a destination in the shell's top bar and was taken out of
          it — "the guide, we dont need that here, bcs we have it under the
          player, that way its great" — and that is right, but only as long as
          "under the player" actually offers the whole schedule. This is that
          offer: the viewer is already looking at now-and-next for the channel
          that is playing, and the full grid is the same question asked wider.

          Only when there ARE listings. A channel the guide does not cover would
          otherwise offer a grid with nothing of its own in it.
        */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {hasArchive && (
            <Link
              to={`/catchup?ch=${item.id}`}
              className={pill}
            >
              <History className="h-3 w-3" />
              Catch-up · {archiveDays}d
            </Link>
          )}
          {guideLink && now !== null && (
            <Link to="/guide" className={pill} aria-label="Full programme guide">
              <CalendarClock className="h-3 w-3" />
              Full guide
            </Link>
          )}
        </span>
      </div>

      {now !== null ? (
        <>
          <Slot slot={now} kind="now" />
          {next.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-rule/50 pt-2">
              {next.map((s, i) => (
                <li key={`${s.startTs ?? i}`}>
                  <Slot slot={s} kind="next" />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="flex items-center gap-2 font-mono text-[length:var(--t-xs)] leading-relaxed text-ink-3">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {/*
            Named precisely. "No programme information" invites a bug report; the
            reason is that this channel carries no guide id, which the viewer can
            neither see nor fix, and the guide cannot invent listings for it.
          */}
          {item.tvgId
            ? 'The guide has no listings for this channel yet.'
            : 'This channel carries no guide id, so it has no listings.'}
        </p>
      )}
    </div>
  );
}

/** One programme. `now` gets the time bar; `next` is a single quiet line. */
function Slot({ slot, kind }: { slot: EpgSlot; kind: 'now' | 'next' }) {
  const title = slot.title ?? 'Unnamed programme';
  const from = fmt(slot.startTs);
  const to = fmt(slot.stopTs);
  const pct = progress(slot);

  if (kind === 'next') {
    return (
      <div className="flex items-baseline gap-3 text-[length:var(--t-sm)]">
        {/* One line and one width. `w-11` held "20:00" and wrapped "08:00 PM" onto
            two lines in every 12-hour locale. 9ch holds the 12-hour label with
            room — measured at the box's type, "08:00 PM" is 45px and 8ch 44.6 —
            so a column of start times lines up whichever clock the viewer reads. */}
        <span className="w-[9ch] shrink-0 whitespace-nowrap font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">{from}</span>
        <span className="min-w-0 flex-1 truncate text-ink-2">{title}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3">
        <span className="pill shrink-0 border border-tally/50 px-1.5 font-mono text-[length:var(--t-2xs)]
                         uppercase tracking-widest text-tally">
          Now
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--t-md)] font-medium text-ink tv:text-[length:var(--t-lg)]">
          {title}
        </span>
        {from !== '' && (
          <span className="shrink-0 whitespace-nowrap font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
            {from}{to !== '' ? `–${to}` : ''}
          </span>
        )}
      </div>

      {/* How far through, which is the one thing a still title cannot say. */}
      {pct !== null && (
        <div className="meter h-[3px] w-full overflow-hidden bg-rule">
          <div className="h-full bg-tally transition-[width] duration-1000" style={{ width: `${pct}%` }} />
        </div>
      )}

      {slot.description !== null && slot.description !== '' && (
        <p className="line-clamp-2 text-[length:var(--t-sm)] leading-relaxed text-ink-3">{slot.description}</p>
      )}
    </div>
  );
}

/**
 * Times come from the panel as unix seconds. Rendered in the viewer's own
 * locale and 24-hour where that locale uses it — a television clock is not the
 * place to argue about am/pm.
 */
function fmt(ts: number | null): string {
  if (ts === null) return '';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Percentage elapsed, or null when the slot has no usable bounds. */
function progress(slot: EpgSlot): number | null {
  const { startTs, stopTs } = slot;
  if (startTs === null || stopTs === null || stopTs <= startTs) return null;
  const span = stopTs - startTs;
  const done = Date.now() / 1000 - startTs;
  // Clamped: a panel whose clock disagrees with ours should not render a bar
  // that is negative or longer than its track.
  return Math.max(0, Math.min(100, Math.round((done / span) * 100)));
}
