import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Button } from './ui';

/**
 * The screen that says why there is nothing here.
 *
 * Every section in this app could be empty, and each one used to say so in its
 * own words or not at all. The films grid said "nothing here. loosen a filter, or
 * check the Hidden list" to a device that had never had a film on it — advice
 * that cannot work, about a cause that is not the cause. The catch-up page
 * announced that "the provider publishes 2,062 of them in total", a number typed
 * into the sentence, describing a subscription the reader may not have.
 *
 * So there are exactly two empty states in this app and they must never be
 * confused, because the reader can act on one and not on the other:
 *
 *   - **Nothing matched** — the library HAS these, the current filter excludes
 *     them. Say which filter, and offer to clear it.
 *   - **Nothing exists** — the library has none of this at all. Say that plainly,
 *     say why, and point at the thing that would change it. Never suggest
 *     loosening a filter that is not the reason.
 *
 * `Nothing` renders the second. It is deliberately a whole-screen statement with
 * at most two buttons rather than a line of grey text under a toolbar: a toolbar
 * offering to sort and filter nothing is the clutter this was asked to remove.
 */
export function Nothing({
  Icon,
  title,
  body,
  actions = [],
}: {
  Icon: LucideIcon;
  /** One short sentence. What is missing, from the reader's point of view. */
  title: string;
  /** Why, and what would change it. Two sentences at most. */
  body: string;
  /** At most two. The first is the one most people want. */
  /*
     An action is a place to go OR a thing to do, and both belong here.

     Adding a source is not a place but a dialog: pointing at `/more?s=accounts`
     would land a viewer on a settings page with one more press to find. `act`
     lets these empty states open the same dialog every other entry point opens.
  */
  actions?: { to?: string; act?: () => void; label: string; primary?: boolean }[];
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <Icon className="h-10 w-10 text-ink-3" strokeWidth={1.3} aria-hidden />
      <div className="max-w-sm space-y-2">
        <p className="font-mono text-[length:var(--t-md)] tracking-wide text-ink">{title}</p>
        <p className="text-[length:var(--t-sm)] leading-relaxed text-ink-2">{body}</p>
      </div>
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions.slice(0, 2).map((a) => (
            a.to === undefined ? (
              <Button
                key={a.label}
                onClick={a.act}
                variant={a.primary === true ? 'primary' : 'default'}
                className="px-4 py-2 text-[length:var(--t-sm)]"
              >
                {a.label}
              </Button>
            ) : (
              <Button
                key={a.label}
                as={Link}
                to={a.to}
                variant={a.primary === true ? 'primary' : 'default'}
                className="px-4 py-2 text-[length:var(--t-sm)]"
              >
                {a.label}
              </Button>
            )
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The other empty state: the library has these, this filter does not.
 *
 * Kept beside `Nothing` so the difference between them is impossible to miss when
 * reading either one.
 */
export function NothingMatched({
  what,
  query,
  onClear,
  hiddenCount = 0,
}: {
  /** Plural noun for the section: "films", "channels", "shows". */
  what: string;
  /** The search term, when there was one. */
  query?: string;
  onClear?: () => void;
  hiddenCount?: number;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p className="text-[length:var(--t-md)] text-ink-2">
        No {what} match{query !== undefined && query !== '' ? <> “<span className="text-ink">{query}</span>”</> : ' these filters'}.
      </p>
      {hiddenCount > 0 && (
        <p className="font-mono text-[length:var(--t-xs)] text-ink-3">
          {hiddenCount.toLocaleString()} {hiddenCount === 1 ? 'group is' : 'groups are'} hidden by this profile.
        </p>
      )}
      {onClear && (
        <Button onClick={onClear} className="px-4 py-2 text-[length:var(--t-sm)]">
          Clear filters
        </Button>
      )}
    </div>
  );
}
