/**
 * Every button, in one place, generated from the keymap.
 *
 * Written by hand, a list like this is wrong within a month — the honest version
 * is derived, so the sheet cannot claim a key that is not wired and cannot omit
 * one that is. `SHORTCUT_GROUPS` decides the order and the grouping;
 * `remoteKeys.keysFor` supplies the caps; `lib/keys.ts` supplies what is live on
 * the screen underneath, which is the part people actually came for.
 *
 * The groups are the parts of a remote people think in — watching, channels,
 * sound, picture, getting around — rather than alphabetical or by keycode.
 */
import { useShape } from '../lib/formFactor';
import { useBindings } from '../lib/keys';
import { ACTION_LABEL, SHORTCUT_GROUPS, type RemoteIntent } from '../lib/remoteKeys';
import { KeyCap, pressable } from './KeyCap';
import { Sheet } from './Sheet';

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const shape = useShape();
  const bindings = useBindings();
  const remote = shape.remote;
  const here = new Set(bindings.map((b) => b.intent));

  const row = (intent: RemoteIntent, label: string) => (
    <div
      key={intent}
      className={`flex items-center gap-2 px-2 py-1 ${here.has(intent) ? 'bg-tally/8' : ''}`}
    >
      <span className="flex w-[5.5rem] shrink-0 justify-start">
        <KeyCap intent={intent} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--t-sm)] text-ink-2">{label}</span>
      {here.has(intent) && (
        <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tracking-wider text-tally">HERE</span>
      )}
    </div>
  );

  return (
    <Sheet title="Buttons" side={shape.panes ? 'right' : 'bottom'} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-2 px-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
          {remote
            ? 'The buttons on your remote. HERE marks the ones that do something on the screen behind this one — the coloured buttons change with the screen, which is why the strip along the bottom always names them.'
            : 'Keyboard shortcuts. HERE marks the ones the screen behind this one is listening for.'}
        </p>

        {/* What this screen has claimed, first — including the coloured buttons,
            whose labels exist nowhere else. */}
        {bindings.length > 0 && (
          <section className="mb-3">
            <h3 className="mb-1 px-2 font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-tally">
              On this screen
            </h3>
            <div className="space-y-px">
              {bindings
                .filter((b) => pressable(b.intent, remote))
                .map((b) => row(b.intent, b.label))}
            </div>
          </section>
        )}

        {SHORTCUT_GROUPS.map((g) => {
          const rows = g.intents.filter((i) => pressable(i, remote));
          if (rows.length === 0) return null;
          return (
            <section key={g.title} className="mb-3">
              <h3 className="mb-1 px-2 font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3">
                {g.title}
              </h3>
              <div className="space-y-px">
                {rows.map((i) => row(i, ACTION_LABEL[i] ?? i))}
              </div>
            </section>
          );
        })}

        <p className="px-2 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
          {remote
            ? 'Arrows move between things; OK opens what is highlighted; BACK goes up one level. Number buttons type a channel number.'
            : 'Arrow keys move between things, Enter opens, Escape goes back. Numbers type a channel number.'}
        </p>
      </div>
    </Sheet>
  );
}
