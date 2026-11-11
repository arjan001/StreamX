/**
 * The name of a button, drawn the way the person's hand will find it.
 *
 * The same action is `f` on a keyboard, a labelled button on a TV remote, and
 * nothing at all on a phone — so a legend that hardcodes one of the three is
 * wrong on the other two. This asks `formFactor` which kind of input is in front
 * of it and asks `remoteKeys` what that input calls the intent.
 *
 * Kept as its own component because three surfaces draw these — the hint bar, the
 * tooltips, and the shortcuts sheet — and a key cap that differs between them
 * reads as three different systems.
 */
import { useShape } from '../lib/formFactor';
import {
  COLOUR_HEX, COLOUR_INTENTS, REMOTE_BUTTON, keysFor, type ColourIntent, type RemoteIntent,
} from '../lib/remoteKeys';

function isColour(intent: RemoteIntent): intent is ColourIntent {
  return (COLOUR_INTENTS as readonly string[]).includes(intent);
}

/** Does this device have a way to press this at all? */
export function pressable(intent: RemoteIntent, remote: boolean): boolean {
  if (isColour(intent)) return remote;
  return remote ? REMOTE_BUTTON[intent] !== undefined : keysFor(intent).length > 0;
}

/**
 * One cap. Returns null when the current input cannot press it, which is what
 * keeps `f` off a television and RED off a laptop.
 */
export function KeyCap({ intent, className }: { intent: RemoteIntent; className?: string }) {
  const remote = useShape().remote;

  if (isColour(intent)) {
    if (!remote) return null;
    return (
      <span
        className={`pill inline-flex items-center gap-1 border border-rule px-1.5 py-0.5
                    font-mono text-[length:var(--t-2xs)] text-ink-2${className ? ` ${className}` : ''}`}
      >
        <span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{ background: COLOUR_HEX[intent] }}
        />
        {REMOTE_BUTTON[intent]}
      </span>
    );
  }

  const cap = remote
    ? REMOTE_BUTTON[intent] ?? keysFor(intent)[0]
    : keysFor(intent)[0] ?? REMOTE_BUTTON[intent];
  if (cap === undefined) return null;

  return (
    <kbd
      className={`pill inline-flex min-w-[1.4rem] items-center justify-center border border-rule
                  bg-panel-2 px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] leading-none text-ink-2
                  ${className ?? ''}`}
    >
      {cap}
    </kbd>
  );
}
