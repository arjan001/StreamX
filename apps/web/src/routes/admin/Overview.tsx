/**
 * What is happening on the box, in the order an operator asks it.
 *
 * The box keeps nothing about who is watching or who is signed in, so there is
 * nothing of that kind here: the errors clients
 * reported, the config revision, and whether the process and its database are
 * well.
 *
 * Every field is read with a default. A field the server stops sending must cost
 * one number on this page, not the page.
 */
import type { Overview as Data } from './api';
import { bytes, count, Panel, Stat, Table, when } from './parts';

export function Overview({ data, onGo }: {
  data: Data;
  onGo: (tab: string) => void;
}) {
  const logs = data.logs;
  const health = data.health;
  const uptime = health?.process?.uptimeSec ?? 0;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Client errors"
          value={count(logs?.errors_day ?? 0)}
          tone={(logs?.errors_day ?? 0) > 0 ? 'alert' : 'default'}
          hint={`last 24 h · ${count(logs?.errors_week ?? 0)} in 7 days · ${count(logs?.held ?? 0)} reports held`}
        />
        <Stat
          label="Config"
          value={`rev ${count(data.config?.revision ?? 0)}`}
          hint={data.config?.updatedAt ? `saved ${when(data.config.updatedAt)}` : 'never saved'}
        />
        <Stat
          label="Box uptime"
          value={`${Math.floor(uptime / 3600)}h ${Math.round((uptime % 3600) / 60)}m`}
          hint={`database ${bytes(health?.db?.db_bytes)} · ${health?.db?.roundTripMs ?? '—'} ms round trip`}
        />
      </div>

      <Panel
        title="Reports by level"
        note="the last seven days"
        actions={(
          <button type="button" className="chip" onClick={() => onGo('errors')}>Open Errors</button>
        )}
      >
        <Table
          rows={logs?.levels ?? []}
          rowKey={(l) => l.level}
          empty="Nothing reported in the last seven days."
          columns={[
            { key: 'level', head: 'Level', cell: (l) => (
              <span className={`font-mono text-[length:var(--t-2xs)] uppercase ${
                l.level === 'error' ? 'text-alert' : l.level === 'warn' ? 'text-tally' : 'text-ink-3'}`}
              >
                {l.level}
              </span>) },
            { key: 'n', head: 'Reports', num: true, cell: (l) => count(l.n) },
          ]}
        />
      </Panel>

      <Panel title="This box" note="the process and its database">
        <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact k="Database" v={bytes(health?.db?.db_bytes)} hint={`${count(health?.db?.logs ?? 0)} reports`} />
          <Fact k="Query round trip" v={`${health?.db?.roundTripMs ?? '—'} ms`} hint={`${count(health?.db?.connections ?? 0)} connections`} />
          <Fact k="Memory" v={bytes(health?.process?.rssBytes)} hint={`heap ${bytes(health?.process?.heapBytes)} · node ${health?.process?.node ?? '—'}`} />
          <Fact k="Newest report" v={when(logs?.newest)} />
        </dl>
      </Panel>
    </>
  );
}

function Fact({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div>
      <dt className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">{k}</dt>
      <dd className="mt-0.5 text-lg text-ink">{v}</dd>
      {hint === undefined ? null : (
        <dd className="font-mono text-[length:var(--t-2xs)] text-ink-3">{hint}</dd>
      )}
    </div>
  );
}
