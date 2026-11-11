import type { EpgResponse, Item } from '../lib/api';
import { displayName } from '../lib/displayName';
import { useDebugEnabled } from '../lib/debugLog';
import type { PlayerSnapshot } from '../lib/playerCore';

/** One labelled fact. Absent values are omitted rather than shown empty. */
function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  if (v === null || v === undefined || v === '' || v === false) return null;
  return (
    <div className="flex gap-2 py-1 text-xs">
      <span className="w-28 shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">{k}</span>
      <span className="min-w-0 flex-1 break-words text-ink-2">{v}</span>
    </div>
  );
}

/**
 * What is on this channel — the guide first.
 *
 * Stream id, transport, latency and the rest are diagnostics. They belong in
 * debug mode, not on a living-room remote press.
 */
export function DetailSheet({
  item,
  epg,
  snapshot,
}: {
  item: Item;
  epg?: EpgResponse | undefined;
  snapshot: PlayerSnapshot;
}) {
  const debug = useDebugEnabled();
  const st = snapshot.stats;
  return (
    <div className="anim-rise space-y-4">
      <div>
        <h2 className="text-base leading-tight text-ink">{displayName(item.name)}</h2>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {item.archive && (
            <span className="border border-tally/60 px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-tally">
              CATCH-UP {item.archiveDays}d
            </span>
          )}
          {item.tvgId ? (
            <span className="border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
              GUIDE
            </span>
          ) : (
            <span className="border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
              NO GUIDE
            </span>
          )}
          {debug && item.direct && (
            <span className="border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
              PROVIDER URL
            </span>
          )}
          {item.rating !== null && (
            <span className="border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
              ★ {item.rating}
            </span>
          )}
        </div>
      </div>

      {debug && (
        <section className="border-t border-rule pt-2">
          <p className="mb-1 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">STREAM</p>
          <Fact k="stream id" v={item.streamId} />
          <Fact
            k="transport"
            v={
              snapshot.transport === 'mpegts'
                ? 'MPEG-TS (low latency)'
                : snapshot.transport === 'hls'
                  ? 'HLS (compatible)'
                  : snapshot.transport === 'native'
                    ? 'native media element'
                    : null
            }
          />
          <Fact k="container" v={item.ext} />
          <Fact k="resolution" v={st.resolution} />
          <Fact k="bitrate" v={st.bitrateKbps ? `${st.bitrateKbps} kbps` : null} />
          <Fact k="codec" v={st.codec} />
          <Fact k="latency" v={st.latencyS !== null ? `${st.latencyS.toFixed(1)} s behind live` : null} />
          <Fact k="dropped" v={st.droppedFrames > 0 ? `${st.droppedFrames} frames` : null} />
          <Fact k="audio tracks" v={snapshot.audioTracks.length || null} />
          <Fact k="qualities" v={snapshot.levels.length > 1 ? snapshot.levels.length - 1 : null} />
          <Fact k="subtitles" v={snapshot.subtitleTracks.length > 1 ? snapshot.subtitleTracks.length - 1 : null} />
          {item.tvgId && <Fact k="guide id" v={item.tvgId} />}
        </section>
      )}

      {epg && (
        <section className={debug ? 'border-t border-rule pt-2' : ''}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <p className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">GUIDE</p>
            {epg.archive > 0 && (
              <span className="font-mono text-[length:var(--t-2xs)] text-tally">{epg.archive} replayable</span>
            )}
          </div>
          {epg.now ? (
            <div className="mb-2">
              <p className="text-sm text-ink">{epg.now.title}</p>
              <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">
                {fmt(epg.now.startTs)}–{fmt(epg.now.stopTs)} · on now
              </p>
              {epg.now.description && (
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-2">
                  {epg.now.description}
                </p>
              )}
            </div>
          ) : (
            <p className="mb-2 font-mono text-[length:var(--t-xs)] text-ink-3">
              {epg.channel.tvgId ? 'nothing scheduled right now' : 'this channel has no guide id'}
            </p>
          )}
          <ul className="space-y-1">
            {epg.upcoming.slice(0, 6).map((u) => (
              <li key={u.startTs} className="flex gap-2 text-xs">
                <span className="pt-0.5 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">{fmt(u.startTs)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{u.title}</span>
                {u.hasArchive && <span className="font-mono text-[length:var(--t-2xs)] text-tally">↺</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function fmt(ts: number | null): string {
  return ts
    ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';
}
