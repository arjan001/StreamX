import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, Settings } from 'lucide-react';
import { allProviders, subscribeProviders, type Provider } from '../lib/providers';
import { openAddAccount } from '../lib/addAccount';
import { focusFirst } from '../lib/spatialNav';

/**
 * "Add a source to start watching" — the whole screen when there is no source.
 *
 * The player has no channels of its own, so a device with nothing saved has
 * nothing to show. This sits over the empty pages (not over Settings or the legal
 * pages, which stay reachable) and has one obvious thing to do.
 */
export function EmptySource() {
  const [list, setList] = useState<Provider[]>(allProviders);
  useEffect(() => subscribeProviders(setList), []);
  const { pathname } = useLocation();
  const nav = useNavigate();
  const panel = useRef<HTMLDivElement | null>(null);
  const aside = pathname.startsWith('/more') || pathname.startsWith('/legal') || pathname.startsWith('/admin');
  const show = list.length === 0 && !aside;
  useEffect(() => {
    if (show && panel.current !== null) focusFirst(panel.current);
  }, [show]);
  if (!show) return null;
  return (
    <div data-nav-contain className="fixed inset-0 z-[55] flex items-center justify-center bg-ground px-4 py-6">
      <div ref={panel} className="w-full max-w-[25rem] text-center">
        <h1 className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]">
          Add a source to start watching
        </h1>
        <p className="mt-2 text-[length:var(--t-sm)] leading-relaxed text-ink-2">
          Add a playlist link, a stream link, or the details your provider gave you.
        </p>
        <button
          data-nav-first
          type="button"
          onClick={openAddAccount}
          className="tap mt-5 inline-flex w-full items-center justify-center gap-2 rounded-[var(--r-full)]
                     bg-tally px-4 py-2.5 font-semibold text-ground transition-colors hover:brightness-110"
        >
          <Plus className="h-4 w-4" aria-hidden /> Add a source
        </button>
        <button
          type="button"
          onClick={() => nav('/more')}
          className="card card-hover tap mt-3 flex w-full items-center justify-center gap-2 border border-rule px-4 py-3"
        >
          <Settings className="h-4 w-4 text-ink-3" aria-hidden />
          <span className="text-[length:var(--t-md)] text-ink">Settings</span>
        </button>
      </div>
    </div>
  );
}
