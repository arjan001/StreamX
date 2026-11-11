/**
 * What libVLC's byte counters say went wrong, in one clause.
 *
 * `MediaPlayer.Event.EncounteredError` carries no message, so the app's whole
 * account of a failure was the word "error" — and that cannot distinguish a film
 * that never arrived from one the decoder refused. It cost an evening: the
 * owner's box reported an ordinary film failing on both the hardware and the
 * software decoder, the hint blamed 4K H.264, and measuring the file found
 * 1920x1072 H.264 High@4.1 at 2.1 Mbps — the most ordinary video in the
 * catalogue. Neither the hint nor the log had any way to be right.
 *
 * The counters answer it. Read in the order that narrows fastest, so the first
 * true clause is the most specific one available.
 */
export function nativeWhy(e: {
  readBytes?: number;
  demuxReadBytes?: number;
  demuxCorrupted?: number;
  decodedVideo?: number;
  decodedAudio?: number;
}): string {
  const read = e.readBytes;
  const demux = e.demuxReadBytes;
  const video = e.decodedVideo;
  /* An old build's plugin sends none of this, and a wrong guess about an
     unreported number would be worse than admitting the gap. */
  if (read === undefined) return 'no counters (older player plugin)';
  const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  if (read === 0) return 'nothing arrived at all — the stream never delivered a byte';
  if ((e.demuxCorrupted ?? 0) > 0) {
    return `${kb(read)} arrived but ${e.demuxCorrupted} corrupted block(s) — a damaged or truncated file`;
  }
  if ((demux ?? 0) === 0) return `${kb(read)} arrived and the demuxer accepted none of it`;
  if ((video ?? 0) === 0) {
    return `${kb(read)} read, ${kb(demux ?? 0)} demuxed, 0 video frames decoded — the decoder refused it`;
  }
  return `${kb(read)} read, ${video} frame(s) decoded, then it stopped`;
}
