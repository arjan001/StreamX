/**
 * What the television area opens ON.
 *
 * It opened on everything: "All countries", every channel in the subscription
 * under it, and a rail of seventy-nine countries down the left — a wall, on the
 * one screen a viewer arrives at most often and with a remote in their hand. The
 * list they actually want is usually already known, and the app already knows
 * it: a profile with starred channels has said which channels matter, and a
 * profile whose countries have been narrowed has said which country matters. Opening on a list the
 * viewer built is not a shortcut round the tree — the tree is one press away, at
 * the top of the same sidebar, and nothing is hidden from anybody.
 *
 * ── why the second answer is one country and not several ────────────────────
 *
 * `Profile.markets` already scopes every list on the screen, so a profile that
 * allows three countries IS a three-row sidebar with "All countries" meaning
 * exactly those three: the wall is already gone and there is nothing to fix.
 * What the screen cannot say honestly is a selection of several at once — the
 * heading names `markets[0]` and the sidebar opens `markets[0]`'s groups
 * underneath it — so a narrowing worth opening on is a narrowing down to ONE
 * television country, which is the case the sidebar and the heading can both
 * tell the truth about.
 *
 *  * A pure decision, and out here rather than in the route, because this is the
 * whole rule and none of it needs a renderer to pin.
 */
/** A market and what it carries, as `localMarkets('live')` reports it. */
export interface LiveMarket { id: string; count: number }

/** The filter Live opens with — a patch over the empty set. */
export interface Opening { favs: boolean; markets: string[] }

/**
 * @param favourites how many starred channels this device can actually SHOW.
 *                   Not how many are stored: favourites survive a change of
 *                   provider, and opening on a list of channels that no longer
 *                   exist would answer the wall with an empty screen.
 * @param allowed    `Profile.markets` — the countries the profile permits,
 *                   empty when it permits everything.
 * @param live       every market that carries channels here, or null while the
 *                   catalogue is still building, where nothing is decidable.
 * @returns the filter to open with, or null to open the way it always has.
 */
export function openingScope(
  favourites: number,
  allowed: readonly string[],
  live: readonly LiveMarket[] | null,
): Opening | null {
  if (favourites > 0) return { favs: true, markets: [] };
  if (live === null || allowed.length === 0) return null;
  const carried = live.filter((m) => m.count > 0);
  const has = new Set(carried.map((m) => m.id.toUpperCase()));
  const mine = allowed.filter((id) => has.has(id.toUpperCase()));
  /* `allowed` also carries the film and series markets — languages and packages
     with no channel under them (`EN`, `MULTI`, `OTHER`) — which is why this
     counts what the television library actually holds rather than the length of
     the profile's own list. */
  if (mine.length !== 1) return null;
  return { favs: false, markets: [mine[0]!] };
}
