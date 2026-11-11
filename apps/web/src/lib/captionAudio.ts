/**
 * Where the captions get their audio from — the whole decision, as one function.
 *
 * Live captions transcribe what the `<video>` element is playing. When libVLC or
 * a television's own player owns the picture, the sound comes out of a native
 * surface behind the page and that element is empty, so there is nothing to
 * transcribe. `chooseEngine` sends every raw MPEG-TS to the native engine on
 * purpose, and every live channel on this line is a raw MPEG-TS — so this is not
 * an edge case, it is live television.
 *
 * ── the two answers that were rejected, and why ──
 *
 * The audio cannot be FETCHED. `max_connections` on these lines is 1: a second
 * connection is refused, and on some panels it evicts the viewer's own picture
 * to make room.
 *
 * It also cannot be lifted out of the stream by our own server, which would mean
 * routing the picture through a box that exists to keep logs, and paying for
 * every viewer's video out of our own bandwidth. That version was built and
 * taken out again. The rule it broke is worth writing down: a feature that
 * charges the operator per viewer-hour is not a feature, it is a bill.
 *
 * ── so it has to come off the device ──
 *
 * Two ways, and the first is much better where it exists.
 *
 * **Native.** On Android 10 and newer the app can record its OWN audio output
 * (`AudioPlaybackCapture`, scoped by uid — see `nativeListen.ts`). That is the
 * sound after libVLC has decoded it, so AC-3, E-AC-3, MP2, DTS and HEVC channels
 * are all just sound by then; libVLC keeps the picture and nothing about
 * playback changes. It costs three prompts the viewer has to answer, which is
 * correct: an app that can hear itself should have to say so.
 *
 * **The offer.** Everywhere else — Android 9, a Samsung or LG set, the website —
 * the only audio reachable for nothing is the audio already in the page. So the
 * page is offered the chance to be the one playing it: play THIS channel in the
 * browser engine, where the sound is in the element and the existing tap works
 * unchanged.
 *
 * The offer is offered and never taken. The native engine is the default because
 * a debug log off a real television showed MSE demuxing MPEG-TS going black
 * after ten seconds — so the viewer chooses, it applies to one channel, and
 * nothing happens behind their back. That is also why there is no latch here and
 * no risk of a loop: nothing in this path reloads anything on its own.
 */
export function audioRoute(o: {
  /** The `<video>` has nothing in it — a native engine is painting behind it. */
  silent: boolean;
  /** The viewer has already asked for this stream in the browser engine. */
  pinned: boolean;
  /** This build can record its own audio output. Android 10+, APK only. */
  nativeAudio: boolean;
}): 'element' | 'native' | 'offer' | 'refuse' {
  if (!o.silent) return 'element';
  /* Preferred over the offer whenever it exists: it keeps libVLC's picture,
     works on codecs no browser decodes, and asks the viewer for permission
     rather than for a compromise. */
  if (o.nativeAudio) return 'native';
  /* Pinned and STILL silent means the switch did not help: a Samsung or LG set,
     where the browser engine cannot demux a transport stream either and there is
     no libVLC to swap in. Offering it again would be offering something that has
     already been tried and watched to fail. */
  return o.pinned ? 'refuse' : 'offer';
}
