/**
 * One fresh link per open.
 *
 * A source whose links expire (a Stalker portal) hands the player a way to ask
 * for another. The player uses it ONCE when the first link will not open, and
 * not again until something has played — so a channel that is genuinely down is
 * asked about twice, not for ever.
 */
export class FreshLink {
  private spent = '';

  /** The ask, or null when this stream's one fresh link is already used (or there is no way to ask). */
  take<T>(key: string, ask: (() => Promise<T>) | undefined): (() => Promise<T>) | null {
    if (ask === undefined || this.spent === key) return null;
    this.spent = key;
    return ask;
  }

  /** Something played: the next failure of this stream earns a fresh link again. */
  reset(): void {
    this.spent = '';
  }
}
