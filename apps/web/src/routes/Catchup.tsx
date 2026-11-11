import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RailToggle } from '../components/RailToggle';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Play, RotateCcw, Search } from 'lucide-react';
import { VideoPlayer } from '../components/VideoPlayer';
import { Poster } from '../components/Poster';
import { Chip, Field, Select } from '../components/ui';
import { VirtualList } from '../components/VirtualList';
import { api, linkId, type EpgSlot } from '../lib/api';

import { useShape } from '../lib/formFactor';
import { showDiagnostics } from '../lib/direct';
import { noteLastPlayed } from '../lib/resume';
import { useScope } from '../lib/scope';
import { useMarkets } from '../lib/groups';
import { useInventory } from '../lib/sections';
import { displayName } from '../lib/displayName';
import { player } from '../lib/playerCore';
import { DAY, HOUR, clockOf, dayChips, isPlayable, slotState } from '../lib/guide';

/**
 * Catch-up.
 *
 * The provider keeps a recording of the last few days for 2,196 of its channels
 * — 97.7% of them for three days or fewer — and until now there was no way to
 * reach any of it. This page is that way: pick a channel that has an archive,
 * pick a day, pick a programme.
 *
 * Two things make it correct rather than merely present. The day strip is bounded
 * by the channel's OWN retention, so it never offers a recording that no longer
 * exists; and the stream is loaded as a finite asset rather than as live, because
 * a recording that cannot be seeked is not much of a recording. The player's raw
 * TS path defaults to live, which is right for a channel and wrong for this.
 */
export function Catchup() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const shape = useShape();
  const { scope } = useScope();
  const { markets } = useMarkets('live', scope, [], []);

  /**
   * A stable ref, kept as a string.
   *
   * `?ch=` used to be a row id, so a catch-up link shared with someone — or just
   * reopened after the next refresh — pointed at whatever row had inherited that
   * number. See `linkId`.
   */
  const chId = params.get('ch') || null;
  const market = params.get('market') ?? '';
  const q = params.get('q') ?? '';
  const wantStart = Number(params.get('start') ?? 0) || null;
  const wantStop = Number(params.get('stop') ?? 0) || null;

  const patch = useCallback(
    (next: Record<string, string | null>) => {
      const p = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '') p.delete(k);
        else p.set(k, v);
      }
      setParams(p, { replace: true });
    },
    [params, setParams],
  );

  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => () => player.teardown(), []);

  /* Only channels that actually keep something. `archiveOnly` has existed in the
     API and in the client query type since the beginning with no caller; this and
     the guide are its first two. */
  const channels = useQuery({
    queryKey: ['catchup', 'channels', market, q, scope],
    queryFn: () => api.items('live', {
      archiveOnly: true,
      limit: 200,
      sort: 'epg',
      ...(market ? { markets: [market] } : {}),
      ...(q.trim().length >= 2 ? { q: q.trim() } : {}),
      ...scope,
    }),
    staleTime: 300_000,
  });
  const rows = channels.data?.rows ?? [];
  const selected = rows.find((r) => linkId(r) === chId) ?? null;

  const epg = useQuery({
    queryKey: ['epg', chId],
    queryFn: () => api.epg(chId!),
    enabled: chId !== null,
    staleTime: 300_000,
    retry: false,
  });

  const channelFacts = {
    archive: epg.data?.channel.archive ?? selected?.archive ?? false,
    archiveDays: epg.data?.channel.archiveDays ?? selected?.archiveDays ?? 0,
  };

  /* The day strip stops where the recordings do. A channel keeping three days
     must not offer a fourth, or every programme on it fails at play time. */
  const days = useMemo(
    () => dayChips(Date.now(), { back: Math.max(0, channelFacts.archiveDays), forward: 0 }),
    [channelFacts.archiveDays],
  );
  const [day, setDay] = useState<number | null>(null);
  const activeDay = day ?? days[days.length - 1]?.ts ?? 0;

  const slots = useMemo(() => {
    const all = epg.data?.slots ?? [];
    return all.filter((s): s is EpgSlot & { startTs: number } =>
      s.startTs !== null && s.startTs >= activeDay && s.startTs < activeDay + DAY);
  }, [epg.data, activeDay]);

  /* Land on something. With a pane layout there is a schedule column sitting
     empty otherwise, and the first channel of the list is a reasonable guess —
     on a phone the list IS the page, so it stays as it is. */
  useEffect(() => {
    if (chId !== null || !shape.panes || rows.length === 0) return;
    patch({ ch: String(rows[0]!.id) });
  }, [chId, shape.panes, rows, patch]);

  const [playing, setPlaying] = useState<{ start: number; stop: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);

  const play = useCallback(
    async (slot: { startTs: number; stopTs: number | null }, label: string) => {
      if (chId === null) return;
      const stop = slot.stopTs ?? slot.startTs + HOUR;
      const mine = ++gen.current;
      setPlaying({ start: slot.startTs, stop });
      setNote(null);
      patch({ start: String(slot.startTs), stop: String(stop) });
      /* The line allows ONE connection. A programme already playing (or a live
         channel that opened this route) still holds it, and without releasing
         it first the archive probe/play call for the NEXT one is refused. */
      player.teardown();
      player.opening(label);
      try {
        noteLastPlayed({
          route: `/catchup?ch=${chId}&start=${slot.startTs}&stop=${stop}`,
          label,
          logo: null,
          kind: 'archive',
          key: `1.${chId}:${slot.startTs}`,
        });
        const target = await api.archivePlay(chId, slot.startTs, stop);
        if (gen.current !== mine) return;
        setNote(target.notes.join(' · '));
        // live: false is the whole point — a recording has a duration and a
        // seek bar, and the TS engine would otherwise treat it as endless.
        // The panel was asked for a specific number of minutes, so the player is
        // told the same thing: TS declares no duration and the seek bar needs one.
        await player.load(target, label, { live: false, durationS: target.minutes * 60, key: `1.${chId}:${slot.startTs}` });
      } catch (err) {
        if (gen.current !== mine) return;
        setNote(err instanceof Error ? err.message : String(err));
        setPlaying(null);
      }
    },
    [chId, patch],
  );

  /* Arriving from the guide with a programme already chosen. Fires once, after
     the channel's schedule is known so the label is right. */
  const autoplayed = useRef<string>('');
  useEffect(() => {
    if (chId === null || wantStart === null || wantStop === null) return;
    const key = `${chId}:${wantStart}`;
    if (autoplayed.current === key) return;
    autoplayed.current = key;
    const slot = (epg.data?.slots ?? []).find((s) => s.startTs === wantStart);
    void play(
      { startTs: wantStart, stopTs: wantStop },
      slot?.title ?? displayName(selected?.name ?? 'Catch-up'),
    );
  }, [chId, wantStart, wantStop, epg.data, play, selected]);

  /* How many channels in the WHOLE library record, regardless of the filter —
     which is the number the empty state needs and the filtered list cannot know. */
  const archived = useInventory()?.archive ?? 0;

  const dest =
    'dest tap flex shrink-0 items-center gap-1.5 border border-rule px-2 py-1 font-mono'
    + ' text-[length:var(--t-2xs)] tracking-wider text-ink-2 transition-colors'
    + ' hover:border-tally hover:text-tally focus-visible:border-focus focus-visible:text-focus';

  const channelList = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-nowrap items-center gap-1.5 border-b border-rule px-2 py-1.5">
        <Field
          value={q}
          onValue={(v) => patch({ q: v })}
          placeholder="find a channel…"
          icon={<Search className="h-3 w-3" />}
          className="min-w-0 flex-1"
        />
        <Select
          label="Country"
          value={market}
          onChange={(v) => patch({ market: v })}
          options={[
            { value: '', label: 'All countries' },
            ...markets.map((m) => ({ value: m.id, label: m.label })),
          ]}
        />
      </div>

      {channels.isLoading ? (
        <div className="space-y-1 p-2">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton h-11" />)}
        </div>
      ) : rows.length === 0 ? (
        /*
         * The count here used to be the literal number 2,062, typed into the
         * sentence. It was true of one subscription on one day, and it was being
         * read by devices holding free channels with no archive anywhere in the
         * library — told, in the app's own voice, about two thousand recordings
         * they could not reach. The whole-library figure is a real number the
         * inventory already knows, so it is asked for; and when the library has
         * no archive at all the answer is not a filter tip.
         */
        archived === 0 ? (
          <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">
            No archive channels in this library.
          </p>
        ) : (
          <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">
            No match — {archived.toLocaleString()} archive {archived === 1 ? 'channel' : 'channels'} total.
          </p>
        )
      ) : (
        <VirtualList
          count={rows.length}
          rowHeight={shape.touch ? 60 : 52}
          className="min-h-0 flex-1 overflow-y-auto"
          render={(i) => {
            const ch = rows[i];
            if (!ch) return null;
            const on = linkId(ch) === chId;
            return (
              <button
                type="button"
                onClick={() => {
                  setDay(null);
                  patch({ ch: linkId(ch), start: null, stop: null });
                }}
                className={`row-hover flex h-full w-full items-center gap-2 border-b border-rule/40 px-2 text-left
                  ${on ? 'bg-panel-2 shadow-[inset_2px_0_0_var(--color-tally)]' : 'hover:bg-panel'}`}
              >
                <Poster src={ch.logo} alt={displayName(ch.name)} ratio="logo" fit="contain" />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[length:var(--t-sm)] ${on ? 'text-tally' : 'text-ink'}`}>
                    {displayName(ch.name)}
                  </span>
                  <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{ch.archiveDays}d archive</span>
                </span>
              </button>
            );
          }}
        />
      )}
    </div>
  );

  const schedule = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-nowrap items-center gap-1.5 border-b border-rule px-3 py-1.5">
        {selected && (
          <span className="min-w-0 truncate font-mono text-[length:var(--t-xs)] text-ink-2">
            {displayName(selected.name)}
          </span>
        )}
        <div className="flex-1" />
        <Link to="/guide" className={dest} aria-label="Full guide" title="Full guide">
          <CalendarClock className="h-3.5 w-3.5" />
          <span className="dest-label">GUIDE</span>
        </Link>
        {selected && (
          <Link to={`/live?ch=${selected.id}`} className={dest} aria-label="Live" title="Live">
            <Play className="h-3.5 w-3.5" />
            <span className="dest-label">LIVE</span>
          </Link>
        )}
      </div>

      {selected === null ? (
        <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">
          Pick a channel to browse its archive.
        </p>
      ) : (
        <>
          <div className="flex shrink-0 flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-rule px-3 py-1.5">
            {days.map((d) => (
              <Chip
                key={d.ts}
                onClick={() => setDay(d.ts)}
                className="shrink-0" on={d.ts === activeDay}
              >
                {d.label}
              </Chip>
            ))}
            <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">
              {channelFacts.archiveDays}d kept
            </span>
          </div>

          {epg.isLoading ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton h-12" />)}
            </div>
          ) : slots.length === 0 ? (
            <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">
              No listings for this day.
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {slots.map((s) => {
                const stop = s.stopTs ?? s.startTs + HOUR;
                const state = slotState({ startTs: s.startTs, stopTs: s.stopTs }, nowS);
                const can = isPlayable(
                  { startTs: s.startTs, stopTs: s.stopTs, hasArchive: s.hasArchive },
                  channelFacts, nowS,
                );
                const on = playing?.start === s.startTs;
                return (
                  <div
                    key={s.startTs}
                    className={`flex items-start gap-3 border-b border-rule/40 px-3 py-2
                      ${on ? 'bg-panel-2' : ''}`}
                  >
                    <span className="w-24 shrink-0 pt-0.5 font-mono text-[length:var(--t-xs)] tabular-nums text-ink-3">
                      {clockOf(s.startTs)}–{clockOf(stop)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[length:var(--t-sm)] leading-snug ${on ? 'text-tally' : 'text-ink'}`}>
                        {s.title ?? 'No title'}
                      </span>
                      {s.description && (
                        <span className="line-clamp-2 block text-[length:var(--t-xs)] leading-relaxed text-ink-3">
                          {s.description}
                        </span>
                      )}
                    </span>
                    {can ? (
                      <button
                        type="button"
                        onClick={() => void play(s, `${displayName(selected.name)} — ${s.title ?? clockOf(s.startTs)}`)}
                        className="btn pill shrink-0 px-3 py-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> PLAY
                      </button>
                    ) : (
                      <span className="shrink-0 pt-1 font-mono text-[length:var(--t-2xs)] uppercase tracking-wide text-ink-3">
                        {state === 'live' ? 'on air' : state === 'future' ? 'later' : 'expired'}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );

  const surface = (
    <div className="flex flex-col gap-2">
      <VideoPlayer
        allowCaptions={false}
        {...(playing
          ? {
              onClose: () => {
                player.teardown();
                setPlaying(null);
                setNote(null);
                patch({ start: null, stop: null });
              },
            }
          : {})}
        {...(chId !== null ? { onGuide: () => nav(`/guide?ch=${chId}`) } : {})}
      />
      {note !== null && (showDiagnostics() || note.startsWith('archive')) && (
        <p className="px-1 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">{note}</p>
      )}
    </div>
  );

  return (
    /*
      `catchup-room` and the two pane names below are what the Modern shell
      reaches for. Catch-up has the same shape as Live and had none of its
      surfaces: a rail and a desk flush against each other on a photographic
      plate, with nothing between the schedule and the picture behind it. The
      classes do nothing in Classic — every rule that spends them is under
      `html[data-shell='modern']`.
    */
    <div className="catchup-room flex h-full min-h-0">
      {/*
        Three areas, three sections — the same shape as Live, and until now with
        none of its guards. The player is capped at 42vh, so the schedule beneath
        it starts roughly level with the MIDDLE of the channel rail: RIGHT from a
        channel near the top landed in the player and RIGHT from one two thirds
        down landed in the schedule, which is the same press doing two different
        things depending on where the list happened to be scrolled. See
        `clearsSection`.
      */}
      <aside
        data-nav-scope
        className="catchup-rail glass-float flex h-full w-[28%] min-w-[18rem] max-w-[32rem]
                   shrink-0 flex-col overflow-hidden border-r border-rule bg-panel"
      >
        {channelList}
      </aside>
      <section data-nav-scope className="catchup-desk glass-float flex min-w-0 flex-1 flex-col">
        {/* Capped: a 16:9 player in a 1600px pane is 900px tall, which would
            leave the schedule — the actual content of this page — off screen. */}
        <div data-nav-scope className="no-round shrink-0 border-b border-rule bg-black p-2">
          {/* On a phone the channel list is a drawer, opened from here. Null on a TV. */}
          <RailToggle label="Channels" />
          <div className="mx-auto max-h-[42vh] w-full max-w-3xl overflow-hidden">{surface}</div>
        </div>
        {schedule}
      </section>
    </div>
  );
}
