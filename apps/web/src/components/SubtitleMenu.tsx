import { useRef } from 'react';
import { FileUp, Minus, Plus, Subtitles } from 'lucide-react';
import { CaptionLook } from './CaptionOverlay';
import { player, type PlayerSnapshot } from '../lib/playerCore';

/**
 * Subtitle sourcing.
 *
 * Most of this catalogue ships no subtitle track at all, so two routes are
 * offered: whatever the stream embeds, and a file from disk, which always works,
 * needs no key and no network.
 *
 * There was a third — a search against OpenSubtitles, through our box, because
 * the key must not ship in a download. On 2026-10-01 the box stopped answering
 * anything but logs, updates, config and captions ("detach everything of my
 * server"), and the search went with it. Live captions (CaptionOverlay) are the
 * route for a stream with nothing to read.
 */

const TS_COMMA = /(\d\d:\d\d:\d\d),(\d{1,3})/g;

/** A <track> handed SRT shows nothing at all and reports no error, so convert. */
function srtToVtt(text: string): string {
  let body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(body.trimStart())) return body;
  body = body.replace(TS_COMMA, (_m, hms: string, ms: string) => `${hms}.${ms.padEnd(3, '0')}`);
  return `WEBVTT\n\n${body}`;
}

export interface SubtitleContext {
  title: string;
  year: string | null;
  season?: number | null;
  episode?: number | null;
}

/**
 * `context` names what is playing. It used to seed the OpenSubtitles search;
 * the callers still pass it because it is also what tells the player a title is
 * on screen (see `hasSubs` in VideoPlayer), and the menu itself no longer reads it.
 */
export function SubtitleMenu({
  snap,
}: {
  snap: PlayerSnapshot;
  context: SubtitleContext | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadFile(file: File) {
    const key = `file:${file.name}:${file.size}`;
    const existing = snap.externalSubs.find((s) => s.key === key);
    if (existing) {
      player.showExternal(existing.id);
      return;
    }
    const text = await file.text();
    const blob = new Blob([srtToVtt(text)], { type: 'text/vtt' });
    player.addExternalSub(
      URL.createObjectURL(blob),
      file.name.replace(/\.(srt|vtt|ass|ssa)$/i, ''),
      'und',
      key,
    );
  }

  const loaded = snap.externalSubs;
  const active = loaded.find((s) => s.active) ?? null;

  return (
    <div className="space-y-2">
      {/* embedded tracks, when the stream has any */}
      {snap.subtitleTracks.length > 1 && (
        <div>
          <p className="menu-label">In this stream</p>
          {snap.subtitleTracks.map((t) => (
            <button
              key={t.id}
              onClick={() => player.setSubtitle(t.id)}
              className={`menu-row ${t.active && !active ? 'is-on' : ''}`}
            >
              <span className="dot" />
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>
      )}

      {loaded.length > 0 && (
        <div>
          <p className="menu-label">Loaded</p>
          <button
            onClick={() => player.showExternal(null)}
            className={`menu-row ${active === null ? 'is-on' : ''}`}
          >
            <span className="dot" />Off
          </button>
          {loaded.map((s) => (
            <button
              key={s.id}
              onClick={() => player.showExternal(s.id)}
              className={`menu-row ${s.active ? 'is-on' : ''}`}
            >
              <span className="dot" />
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {/*
        Sync belongs to whatever is on screen, not to the "Loaded" list.

        A subtitle file is cut for a specific release and a second or two of
        drift is normal.
      */}
      {snap.externalSubs.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Sync</span>
            <button
              onClick={() => player.setSubtitleOffset(snap.subtitleOffset - 0.25)}
              className="border border-rule p-0.5 text-ink-2 hover:border-tally hover:text-tally"
              aria-label="Subtitles earlier"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="w-14 text-center font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-2">
              {snap.subtitleOffset > 0 ? '+' : ''}{snap.subtitleOffset.toFixed(2)}s
            </span>
            <button
              onClick={() => player.setSubtitleOffset(snap.subtitleOffset + 0.25)}
              className="border border-rule p-0.5 text-ink-2 hover:border-tally hover:text-tally"
              aria-label="Subtitles later"
            >
              <Plus className="h-3 w-3" />
            </button>
            {snap.subtitleOffset !== 0 && (
              <button
                onClick={() => player.setSubtitleOffset(0)}
                className="font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
              >
                reset
              </button>
            )}
          </div>
        </div>
      )}

      <div>
        <p className="menu-label">Add subtitles</p>
        <button
          onClick={() => fileRef.current?.click()}
          className="menu-row text-ink-2"
        >
          <FileUp className="h-3 w-3 shrink-0" />
          Load .srt / .vtt from disk
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {snap.subtitleTracks.length <= 1 && snap.externalSubs.length === 0 && (
        <p className="flex items-start gap-1.5 px-3 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
          <Subtitles className="mt-0.5 h-3 w-3 shrink-0" />
          This stream carries no subtitle track. Load a file, or turn on live
          captions to have the audio transcribed as it plays.
        </p>
      )}

      {/*
        How the captions look, at the bottom and folded shut.

        It is here as well as in the CC popover because this is the section
        somebody opens when they are thinking about subtitles, and "subtitles
        settings are gone" was reported by somebody who went looking. The note
        says what it covers, because these two lists are two different renderers:
        a track picked above is drawn by the BROWSER, which sizes its own cues
        against the picture, while everything under this row styles the overlay
        this app paints — live captions and the transcript.
      */}
      <CaptionLook
        label="Caption look"
        note={'Size, plate, place and how many lines stay up. These style the captions '
          + 'this app draws over the picture; a subtitle file is drawn by the browser '
          + 'and sizes itself to the video.'}
      />
    </div>
  );
}
