/**
 * The category rail as a drawer, on a phone.
 *
 * A television and a tablet show the rail beside the list, always — this is
 * only for a phone held sideways, where three columns (countries, channels,
 * picture) leave each one too narrow to read. There the rail slides in over the
 * page from the left and goes away again once a row in it is chosen.
 *
 * The state is one attribute on <html> (`data-rail-open`), because the drawer is
 * pure CSS (`index.css`, the phone block): the rails themselves are not touched,
 * so the television layout cannot be.
 */
import { useEffect, useState } from 'react';

const RAILS = '.live-sidebar, .vod-sidebar, .catchup-rail';

let open = false;
const subs = new Set<(v: boolean) => void>();

function publish(): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (open) root.dataset['railOpen'] = '';
    else delete root.dataset['railOpen'];
  }
  for (const fn of subs) fn(open);
}

/**
 * A choice made in the drawer closes it — after the press has done its work, so
 * the list behind updates first. Typing in the rail's search field does not.
 * A tap anywhere outside the drawer only closes it: the page behind is dimmed,
 * and a tap on something dim should not also press it.
 */
function onChoose(e: Event): void {
  const t = e.target as Element | null;
  if (t === null) return;
  if (t.closest('.rail-toggle') !== null) return;
  if (t.closest(RAILS) === null) {
    e.preventDefault();
    e.stopPropagation();
    setRailOpen(false);
    return;
  }
  if (t.closest('input, textarea, select') !== null) return;
  if (t.closest('.pick-row, .pick, a[href]') === null) return;
  window.setTimeout(() => setRailOpen(false), 0);
}

export function setRailOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  if (typeof document !== 'undefined') {
    if (open) document.addEventListener('click', onChoose, true);
    else document.removeEventListener('click', onChoose, true);
  }
  publish();
}

export function railOpen(): boolean {
  return open;
}

export function useRailOpen(): boolean {
  const [v, setV] = useState(open);
  useEffect(() => {
    subs.add(setV);
    setV(open);
    return () => { subs.delete(setV); };
  }, []);
  return v;
}
