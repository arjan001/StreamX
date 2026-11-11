/**
 * Has the picture stopped while the sound carried on?
 *
 * The failure this exists for was reported from the sofa as the most important
 * one open: "some videos just play for a few 2nd and then goes black and only
 * audio comes". Nothing reports it. libVLC stays `Playing`, the `<video>`
 * element stays `playing`, the clock advances, the audio keeps coming out, and
 * the only thing missing is the picture — so there is no error to catch and no
 * event to listen for. The evidence has to be assembled from counters.
 *
 * Both engines can count something: the WebView publishes `totalVideoFrames`
 * through `getVideoPlaybackQuality`, and libVLC publishes `displayedPictures`
 * in its media stats. One rule reads either — a counter that has not moved
 * across `windowS` of ADVANCING media time is a decoder that has stopped.
 *
 * Media time rather than wall clock, for the same reason `watchPicture` uses it:
 * a stall, a slow line or a paused player spends none of the deadline, so
 * nothing but real playback can ever condemn a stream.
 *
 * Pure, and tested, because the alternative is a rule that can only be exercised
 * by finding a television that reproduces the fault.
 */

/** What the watcher remembers between samples. */
export interface FreezeWatch {
  /** The last counter seen. `-1` before anything has been sampled. */
  count: number;
  /** The media time at which that counter last CHANGED. */
  at: number;
  /**
   * Has this counter EVER moved?
   *
   * The rule that keeps this watchdog from becoming the fault it looks for.
   * A decoder that gives up mid-film has a counter that ran for ten seconds and
   * then stopped — that is evidence. A counter that has never moved at all is
   * not evidence of anything: it is an engine that does not report pictures, and
   * libVLC is entitled to be one of them. With MediaCodec rendering straight to
   * the surface, `displayedPictures` can legitimately stay at zero for a stream
   * that is playing perfectly.
   *
   * Without this, every native stream on such a box would be condemned three
   * seconds in, retried in software, condemned again, and left under a black
   * error card with the sound still playing — which is indistinguishable from
   * the bug, arrives at the same ten-to-fifteen seconds, and would have been
   * caused by the thing meant to catch it.
   */
  moved: boolean;
}

export function freshWatch(): FreezeWatch {
  return { count: -1, at: 0, moved: false };
}

export type FreezeVerdict = 'moving' | 'waiting' | 'frozen';

/**
 * Fold one sample into the watch, and say what it means.
 *
 * `moving`  the counter advanced: the picture is alive, the clock restarts.
 * `waiting` it has not advanced yet, but not for long enough to be a verdict —
 *           or it has never advanced at all, which is never a verdict. See
 *           `moved`.
 * `frozen`  `windowS` of media time with no new picture, from a counter that had
 *           been producing them.
 *
 * A clock that goes BACKWARDS — a seek, a reload, a live stream jumping to the
 * edge — restarts the measurement rather than counting as elapsed time, which
 * is the difference between a watchdog and a seek detector.
 */
export function judgeFrozen(
  watch: FreezeWatch,
  count: number,
  mediaTime: number,
  windowS: number,
): { verdict: FreezeVerdict; next: FreezeWatch } {
  if (count !== watch.count) {
    /* The first sample is not a movement — there was nothing to move from. */
    return { verdict: 'moving', next: { count, at: mediaTime, moved: watch.count !== -1 } };
  }
  if (mediaTime < watch.at) {
    return { verdict: 'waiting', next: { ...watch, count, at: mediaTime } };
  }
  if (mediaTime - watch.at < windowS) {
    return { verdict: 'waiting', next: watch };
  }
  /* Never moved = never reported. Say nothing, for ever, about this stream. */
  if (!watch.moved) return { verdict: 'waiting', next: watch };
  return { verdict: 'frozen', next: freshWatch() };
}
