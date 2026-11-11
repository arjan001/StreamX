/**
 * The floating DEBUG button and the log behind it.
 *
 * Asked for in these words: "add a debug mode, like a floating button where it
 * shows the errors or whatever, because it's impossible to read from there".
 * "There" is an emulator window on a laptop showing a television interface with
 * a spinner that never resolves; the reasons were all in memory and nowhere on
 * screen.
 *
 * The button sits in the bottom-right corner over everything, and is a real
 * control: a D-pad reaches it like any other, so a remote can open the log
 * without a mouse. It carries the error count so a failure is visible before the
 * panel is. The panel is a `Sheet` on the right — the same overlay every other
 * side panel uses, with its focus handling and BACK behaviour — holding the
 * device summary, three actions, and the log with the newest line at the foot.
 *
 * Visible only while debug mode is on (`lib/debugLog.ts`), which is OFF by
 * default everywhere and unlocked with the support PIN under More → About.
 */
import { useEffect, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Bug, Eraser, Send, X } from 'lucide-react';
import {
  clearDebug, debugEntries, debugErrorCount, deviceSummary, sendDebugReport, setDebugEnabled,
  stamp, subscribeDebug, subscribeDebugPanel, useDebugEnabled, type DebugEntry, type ReportOutcome,
} from '../lib/debugLog';
import { Sheet } from './Sheet';

const TONE: Record<DebugEntry['level'], string> = {
  info: 'text-ink-2',
  warn: 'text-tally',
  error: 'text-alert',
};

export function DebugPanel() {
  const enabled = useDebugEnabled();
  const [open, setOpen] = useState(false);
  const errors = useSyncExternalStore(subscribeDebug, debugErrorCount, () => 0);

  /* Settings can open this too — see `requestDebugPanel`. Registered whether or
     not debug is on, because the hook order must not depend on it. */
  useEffect(() => subscribeDebugPanel(() => setOpen(true)), []);

  if (!enabled) return null;
  if (open) return <DebugSheet onClose={() => setOpen(false)} />;

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Debug log"
      className="tap pill fixed bottom-[max(0.75rem,var(--edge-b))] right-[max(0.75rem,var(--edge-r))] z-[60]
                 flex items-center gap-1.5 border border-rule bg-panel/95 px-2.5 py-1.5 font-mono
                 text-[length:var(--t-2xs)] tracking-widest text-ink-2 shadow-lg
                 hover:border-tally hover:text-tally"
    >
      <Bug className="h-3.5 w-3.5" />
      DEBUG
      {errors > 0 && (
        <span className="pill bg-alert px-1.5 text-[length:var(--t-2xs)] font-semibold text-ground">{errors}</span>
      )}
    </button>
  );
}

function DebugSheet({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(subscribeDebug, debugEntries, () => debugEntries());
  const [sent, setSent] = useState<ReportOutcome | 'sending' | null>(null);
  const foot = useRef<HTMLDivElement>(null);

  /* Newest at the bottom, and keep it in view as lines arrive. */
  useEffect(() => {
    foot.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  const send = () => {
    setSent('sending');
    void sendDebugReport().then(setSent);
  };

  const sentLine =
    sent === 'sending' ? 'Sending…'
      : sent === 'sent' ? 'Sent. The server has the last lines of this log.'
        : sent === 'dropped' ? 'The server is rate-limiting this device — wait a minute.'
          : sent === 'failed' ? 'Could not reach the server.'
            : null;

  return (
    <Sheet title="Debug log" side="right" onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-rule px-3 py-2 font-mono text-[length:var(--t-2xs)]">
          {deviceSummary().map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </dl>

        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
          <Action onClick={send} disabled={sent === 'sending'} Icon={Send} label="SEND REPORT" primary />
          <Action onClick={() => { clearDebug(); setSent(null); }} Icon={Eraser} label="CLEAR" />
          <Action onClick={() => { setDebugEnabled(false); onClose(); }} Icon={X} label="HIDE DEBUG" />
          {sentLine !== null && (
            <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{sentLine}</span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[length:var(--t-2xs)] leading-snug">
          {entries.length === 0 ? (
            <p className="text-ink-3">Nothing logged yet. Open a channel and come back.</p>
          ) : (
            entries.map((e) => (
              <div key={e.id} className={`flex gap-2 border-b border-rule/40 py-0.5 ${TONE[e.level]}`}>
                <span className="shrink-0 text-ink-3">{stamp(e.t)}</span>
                <span className="shrink-0 w-14 truncate text-ink-3">{e.tag}</span>
                <span className="min-w-0 break-words">{e.text}</span>
              </div>
            ))
          )}
          <div ref={foot} />
        </div>
      </div>
    </Sheet>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-ink-3">{k}</dt>
      <dd className="min-w-0 break-words text-ink-2">{v}</dd>
    </>
  );
}

function Action({
  onClick, disabled, Icon, label, primary,
}: {
  onClick: () => void;
  disabled?: boolean;
  Icon: typeof Send;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`tap flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[length:var(--t-2xs)]
                  transition-colors disabled:opacity-50 tv:text-[length:var(--t-xs)]
                  ${primary
                    ? 'border-tally bg-tally/15 text-tally hover:bg-tally/25'
                    : 'border-rule text-ink-2 hover:border-tally hover:text-tally'}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
