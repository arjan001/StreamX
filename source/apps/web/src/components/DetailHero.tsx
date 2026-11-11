import { useEffect, useState } from 'react';
import { ArrowLeft, Clock, Film, Globe, Layers, Play, Star, Tag, Video, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GENRE_LABELS } from '@iptv/core-xtream';
import type { CategoryFacts } from '../lib/api';
import { artIsDead } from '../lib/deadArt';
import { Poster } from './Poster';
import { apiUrl } from '../lib/api';
import { artworkAt } from '../lib/artwork';

export interface HeroFacts {
  title: string;
  cover: string | null;
  backdrop: string | null;
  year: string | null;
  rating: number | null;
  genres: string[];
  plot: string | null;
  cast: string[];
  mpaa?: string | null;
  duration?: string | null;
  durationSecs?: number | null;
  releaseDate?: string | null;
  director?: string | null;
  country?: string | null;
  trailer?: string | null;
  container?: string | null;
  bitrate?: number | null;
  video?: { codec: string | null; width: number | null; height: number | null } | null;
  audio?: { codec: string | null; channels: number | null } | null;
  /** Provider group this title sits in, plus the facets derived from its name. */
  category?: CategoryFacts | null;
  /** Which grid the facet chips filter. */
  section: 'movies' | 'series';
}

/*
 * The badge, wearing the app's own chip geometry.
 *
 * These were hand-built `inline-flex … border` spans, which is why they stayed
 * square while everything around them turned soft: the retrofit layer in
 * index.css rounds buttons, inputs, cards and `.chip`, and a bare span is none of
 * those. `scripts/style-audit.mjs` counted 15 of them on the two detail pages
 * once those routes were added to it — it had never looked at a film page.
 */
const CHIP =
  'chip bg-ground/50 px-2 py-0.5 font-mono text-[length:var(--t-2xs)] tracking-wide text-ink-2';

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`${CHIP} ${className ?? ''}`}>{children}</span>;
}

/* GENRE_LABELS is the same map the filter bar renders from, so a chip here and a
   facet tab there can never disagree about what "fourk" is called. */
const LABELS: Record<string, string | undefined> = GENRE_LABELS;
function genreLabel(id: string) {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The panel's genre words and the derived facet ids name the same thing in
 *  different alphabets ("Sci-Fi" vs "scifi"), so fold both before deduping. */
function fold(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Panel dates arrive ISO; a month name reads faster in a spec list. */
function prettyDate(raw: string | null | undefined) {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (raw.length < 10 || Number.isNaN(t)) return raw;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t));
}

/** `durationSecs` is not always seconds — one live title reports 122 for a
 *  two-hour film — so the pre-formatted string wins whenever the panel sent one. */
function runtime(facts: HeroFacts) {
  if (facts.duration) return facts.duration;
  const secs = facts.durationSecs ?? 0;
  if (secs < 60) return null;
  const mins = Math.round(secs / 60);
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

/**
 * Provider group, derived facets and panel genres, all as filter links.
 *
 * This is the answer to "where did this come from" — the group name is the only
 * thing on the page that explains why a French 4K series sits next to an English
 * one, and it is one click from browsing the rest of it.
 */
function FacetChips({ facts }: { facts: HeroFacts }) {
  const base = facts.section === 'series' ? '/series' : '/movies';
  const cat = facts.category ?? null;
  const derived = cat?.genres ?? [];

  /* The path is market -> package -> group. Its last segment IS this category
     (the tally chip above), and the market segment usually repeats the region
     chip, so only the levels that say something new earn a chip. */
  const claimed = new Set(
    [cat?.cleanName, cat?.region, cat?.source].filter((x): x is string => !!x).map(fold),
  );
  const trail = (cat?.path ?? [])
    .slice(0, -1)
    // Each chip keeps the prefix it filters by, so dropping a level below does
    // not shift the links of the ones that stay.
    .map((seg, i, above) => ({ seg, prefix: above.slice(0, i + 1).join('/') }))
    .filter(({ seg }) => !claimed.has(fold(seg)));

  const seen = new Set(derived.map(fold));
  const panel: string[] = [];
  for (const g of facts.genres) {
    const key = fold(g);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    panel.push(g.trim());
  }

  if (!cat && panel.length === 0) return null;

  /*
   * NOTHING here is a focus stop. This page has one job and it is PLAY.
   *
   * Every one of these was a link, which on a television means every one was a
   * place the highlight had to be walked THROUGH. Reported with a photograph of
   * the ring sitting on "EN": "why am I still able to see the genres as buttons
   * — don't do that, they can just go back and filter there, so they will just
   * see the play button here." It is the same fault as the client's "I clicked 8
   * times and still didn't find PLAY", surviving in the one row nobody had
   * counted, and the arithmetic is brutal: a film in a named category with a
   * region, a source and three genres put six stops between arriving and
   * playing.
   *
   * The links were not worthless — they were a way back into a filtered grid.
   * They are just worth far less than the press they cost, because the way back
   * is BACK: the grid you came from is one press of the key that already means
   * "return", with the filter you had still on it.
   *
   * So the row keeps every word and gives up every stop. `data-nav-skip` takes
   * the whole strip out of the D-pad's reckoning rather than relying on each
   * child being unfocusable, so a chip added here later cannot quietly put a
   * stop back.
   */
  return (
    <div data-nav-skip className="mt-3 flex flex-wrap items-center gap-1.5">
      {cat && (
        <Chip className="border-tally/50 text-tally">
          <Layers className="h-2.5 w-2.5" /> {cat.cleanName}
        </Chip>
      )}
      {trail.map(({ seg, prefix }) => (
        <Chip key={prefix}>{seg}</Chip>
      ))}
      {derived.map((g) => (
        <Chip key={g}>
          <Tag className="h-2.5 w-2.5" /> {genreLabel(g)}
        </Chip>
      ))}
      {cat?.source && <Chip>{cat.source}</Chip>}
      {cat?.region && (
        <Chip>
          <Globe className="h-2.5 w-2.5" /> {cat.region}
        </Chip>
      )}
      {/*
        The panel's own genres DESCRIBE the film. They cannot filter for it.
        ── the bug this removes ──

        These used to become links whenever the word happened to be in
        `GENRE_LABELS` — so Coherence, whose panel data says Thriller, offered a
        Thriller chip that led to a grid Coherence is not in. Reported as "some
        genres are missing that are inside", which is exactly what it looks
        like: the film says Thriller, the filter has never heard of it.

        The cause is that the two lists come from different places and only one
        of them is indexed. `derived` comes from the CATEGORY NAME, which every
        row carries, so it can be filtered across 210,871 titles without asking
        the panel anything. The panel genres come from `get_vod_info`, one HTTP
        request per title, fetched when this page opened. Measured against the
        live panel: `get_vod_streams` returns 211,096 rows with sixteen fields
        and not one of them is a genre — zero rows carry one, and `category_ids`
        never holds more than a single id. So making these filterable means
        211,096 requests, which is not a thing an app does on startup.

        Anything already in `derived` was dropped from `panel` above, so by the
        time a genre reaches here it is BY DEFINITION one the filter cannot
        find. A chip that navigates somewhere its own subject is missing from is
        worse than a chip that just tells you something, so these tell you
        something. The category-derived chips above are still links, and they
        still work.
      */}
      {panel.map((g) => <Chip key={g}>{g}</Chip>)}
    </div>
  );
}

/** Panel `youtube_trailer` is usually a bare id but sometimes a whole watch URL.
 *  Ids can be framed in place; anything else can only be handed to the browser. */
function trailerId(raw: string) {
  return /^[\w-]{6,15}$/.test(raw.trim()) ? raw.trim() : null;
}

function TrailerLightbox({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — trailer`}
      onClick={onClose}
      className="anim-fade fixed inset-0 z-50 grid place-items-center bg-black/90 p-4"
    >
      {/* Stop the click here or dragging the YouTube scrubber closes the modal. */}
      <div className="anim-pop w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border border-rule border-b-0 bg-panel px-3 py-1.5">
          <span className="truncate font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">TRAILER · {title}</span>
          <button
            onClick={onClose}
            aria-label="Close trailer"
            className="text-ink-3 transition-colors hover:text-tally"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* -nocookie so a page opened for the artwork does not plant ad cookies. */}
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
          title={`${title} trailer`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          className="aspect-video w-full border border-rule bg-black"
        />
      </div>
    </div>
  );
}

/**
 * Full-bleed header for movies and series.
 *
 * Backdrop when the panel has one; otherwise the cover fills the same way
 * (`object-fit: cover` / `bg-cover`) — no small stand-in card on a tint field.
 * The DVD poster still sits in the title row for recognition.
 */
export function DetailHero({
  facts,
  onPlay,
  playLabel = 'PLAY',
  back,
  children,
  /** Parent already paints the cover/backdrop behind the whole page. */
  pageBleed = false,
}: {
  facts: HeroFacts;
  onPlay?: (() => void) | undefined;
  playLabel?: string | undefined;
  back: string;
  children?: React.ReactNode;
  pageBleed?: boolean;
}) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  /*
   * The poster, and what stands in when its host is dead.
   *
   * Measured on the live line: for thousands of titles the panel's own poster
   * (`movie_image`/`cover_big`) and the list row's icon are the SAME dead host —
   * `203.0.113.40`, which answers nothing — while the backdrop is a live tmdb
   * URL. That is the screenshot: a page with the film's backdrop filling it and
   * a two-letter monogram where the poster should be, on a title that plainly
   * has artwork.
   *
   * So when the poster is on a host this session has already given up on, the
   * backdrop is cropped to poster shape instead. It is the same film, it is
   * already downloaded, and a frame from the film beats two letters.
   */
  const cover = artIsDead(facts.cover) && facts.backdrop !== null ? facts.backdrop : facts.cover;
  const art = facts.backdrop ?? cover;
  const embeddable = facts.trailer ? trailerId(facts.trailer) : null;
  const res = facts.video?.height ? `${facts.video.height}p` : null;
  /* Hero fills the frame: ask for a wide enough rendition, not the master. */
  const heroUrl = art !== null ? apiUrl(artworkAt(art, 1280)) : null;

  return (
    <>
      {/* `no-round`: this is full-bleed against the top and sides of the page, and a
          radius on an edge that touches the viewport draws a corner of nothing. */}
      <section className="no-round anim-fade relative min-h-[56vh] w-full overflow-hidden bg-transparent tv:min-h-[42vh]">
        {/* Cover or backdrop — always fill. Skipped when the page owns the bleed
            so DETAILS sits on the same art instead of the modern plate. */}
        {!pageBleed && heroUrl !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat opacity-90"
            style={{ backgroundImage: `url("${heroUrl}")` }}
          />
        )}
        {/* Three scrims: top under the overlay nav, bottom for the title block,
            left-to-right so long text stays legible over bright artwork. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ground/90 via-transparent to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ground via-ground/85 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ground/90 via-ground/25 to-transparent"
        />

        {/* Top pad clears the absolute shell header (edge inset + bar height). */}
        <div className="relative flex min-h-[56vh] flex-col px-5 pb-7 pt-[var(--shell-overlay-pad)]
                        sm:px-8 tv:min-h-[42vh]">
          <Link
            to={back}
            className="inline-flex w-fit items-center gap-1 font-mono text-[length:var(--t-2xs)] tracking-widest
                       text-ink-3 transition-colors hover:text-tally"
          >
            <ArrowLeft className="h-3 w-3" /> BACK
          </Link>

          <div className="mt-auto flex flex-wrap items-end gap-5 pt-10 sm:flex-nowrap sm:gap-7">
            <div className="w-32 shrink-0 sm:w-40 lg:w-48">
              {/* The backdrop is the second attempt, not only a pre-emptive
                  substitution: `cover` above swaps hosts that were ALREADY
                  written off, which on a cold start is none of them, so the
                  first film of a session still failed to two grey letters. */}
              <Poster
                src={cover}
                fallback={facts.backdrop}
                alt={facts.title}
                className="shadow-[0_18px_50px_-18px_rgba(0,0,0,.95)]"
              />
            </div>

            <div className="min-w-0 flex-1">
              <h1
                className="text-[length:var(--t-lg)] font-semibold leading-[1.05] tracking-tight text-ink"
                style={{ textWrap: 'balance', textShadow: '0 2px 22px rgba(0,0,0,.55)' }}
              >
                {facts.title}
              </h1>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {facts.rating !== null && facts.rating > 0 && (
                  <span className="chip border-tally/60 bg-ground/50 px-2 py-0.5 font-mono text-[length:var(--t-2xs)] text-tally">
                    <Star className="h-2.5 w-2.5 fill-current" /> {facts.rating.toFixed(1)}
                  </span>
                )}
                {facts.year && <Chip>{facts.year.slice(0, 4)}</Chip>}
                {facts.mpaa && <Chip>{facts.mpaa}</Chip>}
                {runtime(facts) && (
                  <Chip>
                    <Clock className="h-2.5 w-2.5" /> {runtime(facts)}
                  </Chip>
                )}
                {facts.container && (
                  <Chip>
                    <Film className="h-2.5 w-2.5" /> {facts.container.toUpperCase()}
                  </Chip>
                )}
                {res && <Chip>{res}</Chip>}
                {facts.video?.codec && <Chip>{facts.video.codec}</Chip>}
                {facts.audio?.codec && (
                  <Chip>
                    {facts.audio.codec}
                    {facts.audio.channels ? ` ${facts.audio.channels}ch` : ''}
                  </Chip>
                )}
              </div>

              <FacetChips facts={facts} />

              {facts.plot && (
                <p className="mt-4 line-clamp-3 max-w-3xl text-[length:var(--t-sm)] leading-relaxed text-ink-2">
                  {facts.plot}
                </p>
              )}

              {(facts.director || facts.cast.length > 0) && (
                <dl className="mt-3 space-y-1">
                  {facts.director && (
                    <div className="flex gap-2 text-xs">
                      <dt className="w-16 shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
                        Director
                      </dt>
                      <dd className="min-w-0 text-ink-2">{facts.director}</dd>
                    </div>
                  )}
                  {facts.cast.length > 0 && (
                    <div className="flex gap-2 text-xs">
                      <dt className="w-16 shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
                        Cast
                      </dt>
                      <dd className="min-w-0 text-ink-2">{facts.cast.slice(0, 8).join(', ')}</dd>
                    </div>
                  )}
                </dl>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                {onPlay && (
                  <button
                    onClick={onPlay}
                    /*
                      Where this screen starts, declared rather than inferred.
                      
                      `focusFirst` looks for `data-nav-first` before anything
                      else, and without it a detail page opens whereever reading
                      order happens to land — which a client measured as eight
                      presses of the remote before he found PLAY, via the search
                      icon, a NETFLIX badge and a rail of similar films. Opening a
                      film has exactly one obvious next action and this is it.
                    */
                    data-nav-first
                    aria-label={playLabel}
                    className="flex items-center gap-1.5 border border-tally bg-tally/10 px-5 py-2
                               font-mono text-xs tracking-wide text-tally transition-colors
                               hover:bg-tally hover:text-ground"
                  >
                    <Play className="h-3.5 w-3.5" /> {playLabel}
                  </button>
                )}
                {facts.trailer && embeddable && (
                  <button
                    onClick={() => setTrailerOpen(true)}
                    className="flex items-center gap-1.5 border border-rule bg-ground/50 px-3 py-2 font-mono
                               text-xs text-ink-2 transition-colors hover:border-tally hover:text-tally"
                  >
                    <Video className="h-3.5 w-3.5" /> TRAILER
                  </button>
                )}
                {facts.trailer && !embeddable && (
                  <a
                    href={facts.trailer}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 border border-rule bg-ground/50 px-3 py-2 font-mono
                               text-xs text-ink-2 transition-colors hover:border-tally hover:text-tally"
                  >
                    <Video className="h-3.5 w-3.5" /> TRAILER
                  </a>
                )}
                {children}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Outside the hero: the hero clips its own overflow, and a fixed overlay
          nested in it would be painted under the sections that follow. */}
      {trailerOpen && embeddable && (
        <TrailerLightbox id={embeddable} title={facts.title} onClose={() => setTrailerOpen(false)} />
      )}
    </>
  );
}

export interface SpecRow {
  label: string;
  value: React.ReactNode;
}

/**
 * The technical block under the hero.
 *
 * Nothing is invented: a row the panel did not answer is dropped rather than
 * printed as "unknown", because on this catalogue a missing codec usually means
 * the title was never probed, not that it has none.
 */
export function DetailSpecs({ facts, extra }: { facts: HeroFacts; extra?: SpecRow[] | undefined }) {
  const v = facts.video;
  const a = facts.audio;
  const resolution = v?.width && v.height ? `${v.width}×${v.height}` : null;

  const candidates: SpecRow[] = [
    ...(extra ?? []),
    { label: 'Video', value: [v?.codec, resolution].filter(Boolean).join(' · ') },
    { label: 'Audio', value: [a?.codec, a?.channels ? `${a.channels} ch` : null].filter(Boolean).join(' · ') },
    { label: 'Container', value: facts.container ? facts.container.toUpperCase() : null },
    // A zero bitrate is the panel saying it never measured one.
    { label: 'Bitrate', value: facts.bitrate ? `${facts.bitrate.toLocaleString()} kbps` : null },
    { label: 'Duration', value: runtime(facts) },
    { label: 'Released', value: prettyDate(facts.releaseDate ?? facts.year) },
    { label: 'Country', value: facts.country },
    { label: 'Rated', value: facts.mpaa },
    // The hero shows the first eight names; the rest belong somewhere.
    { label: 'Full cast', value: facts.cast.length > 8 ? facts.cast.join(', ') : null },
  ];
  const rows = candidates.filter((r) => r.value !== null && r.value !== undefined && r.value !== '');
  if (rows.length === 0) return null;

  /*
   * `detail-facts` carries the floor, and the floor is the whole point.
   *
   * This used to be `bg-ground/55` with a `border-t` and `backdrop-blur-[2px]`,
   * and the three of them made the seam that was reported as the page "not
   * covering all the way": the hero above ends at solid ground, this band is
   * 55% over a picture at full brightness, and a hard rule runs between them.
   * So the eye sees dark, a line, then a photograph with a table of numbers on
   * top of it. The 2px blur cost a composited layer and changed nothing
   * anybody could see.
   *
   * The replacement is in `index.css`, where it can be a gradient that starts
   * where the hero left off and lets the room back in further down, and where
   * the Modern shell can make it glass without a second copy of the markup.
   */
  return (
    <section className="detail-facts relative px-5 py-6 sm:px-8">
      <h2 className="mb-2 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">DETAILS</h2>
      <dl className="grid gap-x-10 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3 border-b border-rule/50 py-2 text-xs">
            <dt className="w-24 shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
              {r.label}
            </dt>
            <dd className="min-w-0 flex-1 break-words text-ink-2">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
