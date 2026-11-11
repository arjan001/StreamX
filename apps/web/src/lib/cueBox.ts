/**
 * Where a default (bottom) subtitle cue should sit inside the video.
 *
 * Native WebVTT rendering pins `line: auto` to the bottom edge of the element.
 * That is behind the player chrome, and on Chromium the cue box can overflow
 * the shell and paint under the player. The control bar clears at ~3.5rem
 * (`bottom-14`); keep a 4.25rem band so cues sit low but stay above it.
 * Cues are end-aligned on a line that leaves that band empty.
 */

export const CUE_CHROME_REM = 4.25;

export function cueBottomPercent(videoHeight: number, remPx: number): number {
  if (videoHeight <= 0 || remPx <= 0) return 80;
  const pad = Math.min(videoHeight * 0.38, CUE_CHROME_REM * remPx);
  return ((videoHeight - pad) / videoHeight) * 100;
}

export function liftDefaultCue(cue: TextTrackCue, videoHeight: number, remPx: number): boolean {
  if (!(cue instanceof VTTCue)) return false;
  if (cue.line !== 'auto') return false;
  cue.snapToLines = false;
  cue.lineAlign = 'end';
  cue.line = cueBottomPercent(videoHeight, remPx);
  return true;
}
