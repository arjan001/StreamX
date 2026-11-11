/**
 * How long to wait after a keystroke before asking the question.
 *
 * Every field in this app that filters as you type holds the keystroke for a
 * moment first, and the number was the same everywhere: a few hundred
 * milliseconds, chosen when the catalogue lived on a server and each letter was
 * an HTTP request somebody else had to answer.
 *
 * The catalogue has been on the device since 2026-09-03. `docs/07-architecture.md`
 * §1 measured it: 2.1 ms to search 124,157 items. So on a signed-in television
 * the wait is now the whole of the delay — the owner, on the search screen: "in
 * general it's a bit too slow I mean the searching and everything ... it is
 * everything local then why does it take this long to load things". Profiled on
 * the built site, typing "john": 2.4 seconds wall, of which 2.1 were idle and 48
 * ms were actual work.
 *
 * So the delay follows where the answer comes from. Local: long enough to
 * coalesce the letters of a word typed at speed and nothing more. Remote: the
 * old number, because there the cost is somebody else's server and a request per
 * letter is exactly what this is for.
 */
import { localEnabled } from './localCatalogue.ts';

/** Coalesces a fast typist's letters; below what anybody perceives as a wait. */
export const LOCAL_TYPING_MS = 120;
/** One request per word rather than per letter, when a request is involved. */
export const REMOTE_TYPING_MS = 400;

export function typingDelay(): number {
  return localEnabled() ? LOCAL_TYPING_MS : REMOTE_TYPING_MS;
}
