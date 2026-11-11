import { useMemo, useState } from 'react';
import {
  BUFFER_CUSTOM_MAX, BUFFER_CUSTOM_MIN, BUFFER_PROFILES, clampBufferSeconds,
  getGlobalBufferChoice, setGlobalBufferChoice,
  type BufferChoice, type BufferMode,
} from '../lib/liveBuffer';

/** Step for the counter — five presses cover a useful range on a remote. */
export const BUFFER_STEP_S = 5;

/**
 * Seconds held ahead — minus / value / plus, not a range input.
 *
 * A focused `<input type="range">` eats Left/Right on a D-pad; a pair of
 * buttons does not.
 */
export function BufferSecondsCounter({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const s = clampBufferSeconds(seconds);
  const bump = (delta: number) => onChange(clampBufferSeconds(s + delta));
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Less buffer"
        disabled={s <= BUFFER_CUSTOM_MIN}
        onClick={() => bump(-BUFFER_STEP_S)}
        className="tap flex h-8 w-8 shrink-0 items-center justify-center border border-rule
                   font-mono text-[length:var(--t-sm)] text-ink-2
                   hover:border-tally hover:text-tally disabled:opacity-30"
      >
        −
      </button>
      <span
        className="min-w-[3.5rem] text-center font-mono text-[length:var(--t-sm)] tabular-nums text-ink"
        aria-live="polite"
      >
        {s}s
      </span>
      <button
        type="button"
        aria-label="More buffer"
        disabled={s >= BUFFER_CUSTOM_MAX}
        onClick={() => bump(BUFFER_STEP_S)}
        className="tap flex h-8 w-8 shrink-0 items-center justify-center border border-rule
                   font-mono text-[length:var(--t-sm)] text-ink-2
                   hover:border-tally hover:text-tally disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

/**
 * Preset rows + optional custom seconds counter.
 *
 * Used for the global default (Settings) and the per-channel override (player).
 * When `allowDefault` is on, the first row clears the override so the channel
 * inherits Settings.
 */
export function BufferChoiceControls({
  value,
  onChange,
  allowDefault = false,
  defaultLabel,
}: {
  value: BufferChoice | null;
  onChange: (next: BufferChoice | null) => void;
  allowDefault?: boolean;
  /** Shown on the Default row — usually the current global label. */
  defaultLabel?: string;
}) {
  const customSeconds = value?.kind === 'custom'
    ? value.seconds
    : BUFFER_PROFILES.balanced.maxBufferS;

  return (
    <>
      {allowDefault && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`menu-row ${value === null ? 'is-on' : ''}`}
        >
          <span className="dot" />
          <span>Default</span>
          {defaultLabel !== undefined && defaultLabel !== '' && (
            <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">
              {defaultLabel}
            </span>
          )}
        </button>
      )}
      {(Object.keys(BUFFER_PROFILES) as BufferMode[]).map((m) => (
        <button
          type="button"
          key={m}
          onClick={() => onChange({ kind: 'preset', mode: m })}
          className={`menu-row ${value?.kind === 'preset' && value.mode === m ? 'is-on' : ''}`}
        >
          <span className="dot" />
          <span>{BUFFER_PROFILES[m].label}</span>
          <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">
            ~{BUFFER_PROFILES[m].maxBufferS}s
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange({ kind: 'custom', seconds: customSeconds })}
        className={`menu-row ${value?.kind === 'custom' ? 'is-on' : ''}`}
      >
        <span className="dot" />
        <span>Custom</span>
        <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">
          {value?.kind === 'custom' ? `${value.seconds}s` : 'set'}
        </span>
      </button>
      {value?.kind === 'custom' && (
        <div className="flex items-center justify-between gap-3 px-3 pb-2">
          <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">Forward buffer</span>
          <BufferSecondsCounter
            seconds={value.seconds}
            onChange={(seconds) => onChange({ kind: 'custom', seconds })}
          />
        </div>
      )}
    </>
  );
}

/** Settings pane: global default for every live channel. */
export function LiveBufferSetting() {
  const [tick, setTick] = useState(0);
  const choice = useMemo(() => getGlobalBufferChoice(), [tick]);
  const set = (next: BufferChoice | null) => {
    if (next === null) return;
    setGlobalBufferChoice(next);
    setTick((n) => n + 1);
  };

  return (
    <div className="border-t border-rule p-3">
      <p className="mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        Live buffer
      </p>
      <div className="space-y-px">
        <BufferChoiceControls value={choice} onChange={set} />
      </div>
    </div>
  );
}
