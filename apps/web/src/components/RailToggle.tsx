/**
 * The button that opens the category rail on a phone.
 *
 * Nothing at all anywhere else: a television and a tablet keep the rail beside
 * the list, so this renders null there and adds no element to the page. The
 * shade behind an open drawer is the drawer's own shadow (index.css).
 * See lib/railDrawer.ts.
 */
import { PanelLeftOpen } from 'lucide-react';
import { useShape } from '../lib/formFactor';
import { setRailOpen, useRailOpen } from '../lib/railDrawer';

export function RailToggle({ label = 'Categories' }: { label?: string }) {
  const { touchScreen } = useShape();
  const open = useRailOpen();
  if (touchScreen !== 'phone') return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setRailOpen(!open)}
      className="rail-toggle tap flex shrink-0 items-center gap-1.5 border border-rule px-2 py-1
                 text-[length:var(--t-xs)] text-ink-2 hover:text-ink"
    >
      <PanelLeftOpen className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}
