/**
 * What clients reported going wrong.
 *
 * The server has carried these in its overview response for as long as the table
 * has existed and nothing ever drew them. The first row it showed when it finally
 * did was the tester's own `MediaMSEError` from 1.6.19+36 — a bug that had been
 * found, fixed and shipped by hand, sitting unread in the box's own log the whole
 * time.
 *
 * Grouped first, because forty rows of one television in a crash loop is one
 * problem and the ungrouped list makes it look like forty.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Field } from '../../components/ui';
import { adminGet, qs, type LogGroup, type LogRow } from './api';
import { count, Empty, Pager, Panel, Picker, Table, when } from './parts';

const SIZE = 50;
const LEVELS = [
  { value: 'all', label: 'Everything' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Reports' },
] as const;

interface Answer { total: number; page: number; size: number; rows: LogRow[]; groups: LogGroup[] }

export function Errors() {
  const [level, setLevel] = useState<string>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);

  const logs = useQuery({
    queryKey: ['admin', 'logs', level, q, page],
    queryFn: () => adminGet<Answer>(`/api/admin/logs${qs({ level, q, page, size: SIZE })}`),
    staleTime: 10_000,
  });
  const data = logs.data;

  return (
    <>
      <section data-nav-scope className="mt-2 grid gap-3 lg:grid-cols-2">
        <Field
          value={q}
          onValue={(v: string) => { setQ(v); setPage(0); }}
          placeholder="search the messages"
          icon={<Search className="h-3.5 w-3.5" />}
        />
        <Picker label="Level" value={level} options={[...LEVELS]}
          onPick={(v) => { setLevel(v); setPage(0); }} />
      </section>

      <Panel title="By message" note="the same failure, however many times it arrived">
        {logs.isError ? <Empty tone="alert">{(logs.error as Error).message}</Empty> : null}
        <Table
          rows={data?.groups ?? []}
          rowKey={(g, i) => `${i}-${g.message}`}
          empty="Nothing reported. Which is the good outcome."
          columns={[
            {
              key: 'msg',
              head: 'Message',
              cell: (g) => (
                <span className="flex items-start gap-2">
                  <span className={`mt-1 block h-2 w-2 shrink-0 rounded-full ${
                    g.level === 'error' ? 'bg-alert' : g.level === 'warn' ? 'bg-tally' : 'bg-rule'}`}
                  />
                  <span className="line-clamp-2 max-w-[42rem] text-ink-2">{g.message}</span>
                </span>
              ),
            },
            { key: 'n', head: 'Times', num: true, cell: (g) => count(g.n) },
            { key: 'devices', head: 'Devices', num: true, cell: (g) => count(g.devices) },
            {
              key: 'builds',
              head: 'Builds',
              cell: (g) => (
                <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">
                  {(g.builds ?? []).slice(0, 3).join(' · ')}
                  {(g.builds ?? []).length > 3 ? ` +${(g.builds ?? []).length - 3}` : ''}
                </span>
              ),
            },
            { key: 'newest', head: 'Newest', cell: (g) => when(g.newest) },
          ]}
        />
      </Panel>

      <Panel
        title="Every report"
        note={data === undefined ? 'reading…' : `${count(data.total)} held · kept for a week, then swept`}
      >
        {data === undefined ? <Empty>reading…</Empty> : (
          <>
            <Table
              rows={data.rows ?? []}
              rowKey={(l) => String(l.id)}
              empty="Nothing at this level."
              onRow={(l) => setOpen(open === l.id ? null : l.id)}
              columns={[
                { key: 'at', head: 'When', cell: (l) => when(l.at) },
                {
                  key: 'level',
                  head: 'Level',
                  cell: (l) => (
                    <span className={`font-mono text-[length:var(--t-2xs)] uppercase ${
                      l.level === 'error' ? 'text-alert' : l.level === 'warn' ? 'text-tally' : 'text-ink-3'}`}
                    >
                      {l.level}
                    </span>
                  ),
                },
                {
                  key: 'device',
                  head: 'Device',
                  cell: (l) => (
                    <span className="font-mono text-[length:var(--t-2xs)] text-ink-2">
                      {(l.device_id ?? '—').slice(0, 10)}
                    </span>
                  ),
                },
                {
                  key: 'build',
                  head: 'Build',
                  cell: (l) => (
                    <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">
                      {l.app_version ?? '—'}{l.platform === null ? '' : ` · ${l.platform}`}
                    </span>
                  ),
                },
                {
                  key: 'msg',
                  head: 'Message',
                  cell: (l) => (
                    <span className={`${open === l.id ? '' : 'line-clamp-2 '}max-w-[42rem] break-words`}>
                      {l.message}
                      {/* The debug report a television sends carries its whole
                          boot log in `context`. Behind a click, because it is a
                          hundred lines and this is a table. */}
                      {open === l.id && l.context !== null && l.context !== undefined ? (
                        <span className="mt-2 block max-h-64 overflow-auto whitespace-pre-wrap
                                         border border-rule bg-ground p-2 font-mono text-[length:var(--t-2xs)] text-ink-3">
                          {JSON.stringify(l.context, null, 1)}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
            <Pager page={data.page ?? 0} size={data.size ?? SIZE} total={data.total ?? 0} onPage={setPage} />
          </>
        )}
      </Panel>
    </>
  );
}
