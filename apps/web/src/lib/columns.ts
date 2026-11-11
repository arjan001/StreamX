/**
 * Columns, and the arrows that join them.
 *
 * Written once because it is now needed on four screens — settings, the player
 * menu, organise, and organise's own two-grid inside it — and because getting it
 * wrong is the single most-reported navigation complaint in this app: "when you
 * scroll around it suddenly goes from one menu to another, there is no ordering
 * properly".
 *
 * ── why the general geometry cannot answer this ──
 *
 * `spatialNav` has two rules that are right for content and wrong for a list
 * beside its contents:
 *
 *   **A sideways move must stay in its row.** Without it, Right at the end of a
 *   channel row lands on whatever happens to be diagonally beyond it. With it,
 *   Right from a section reaches nothing at all when that section's first
 *   control sits lower down the next column — which is most of them.
 *
 *   **A vertical move escalates outwards.** That is what carries focus from the
 *   end of one poster rail to the next. Between columns it walks out of one and
 *   into the middle of its neighbour.
 *
 * So a screen made of columns owns its own arrows: each press is answered inside
 * the column that has focus, and only Right and Left cross — to the next column
 * along, at its entry point. Up is the deliberate exception: from the top of a
 * column it is allowed to escalate, because that is how the header above is
 * reached, and a dead key at the top of a screen is worse than a long way round.
 *
 * A column with nothing focusable in it — a page of text — is handed focus on
 * the container itself (give it `tabIndex={-1}`, which keeps it out of the
 * geometry) and then Up and Down scroll it. Without that, Right is a dead key on
 * exactly the sections people read rather than press.
 */
import { focusFirst, moveWithin } from './spatialNav.ts';

export type ColumnDir = 'up' | 'down' | 'left' | 'right';

export interface Column {
  /** The column itself. Null while it is not on screen. */
  el: HTMLElement | null;
  /**
   * Where focus lands when arriving from a neighbour.
   *
   * The open section, the selected row — whatever "you were here" means for this
   * column. Falls back to its first focusable item, and then, for a column with
   * no controls at all, to the column itself.
   */
  entry?: HTMLElement | null;
  /** Whether the column may take focus itself and scroll. Default true. */
  scroll?: boolean;
}

/** Extra behaviour a full page wants and an overlay does not. */
export interface ColumnOpts {
  /**
   * A press arriving from above the columns enters the FIRST one.
   *
   * For a page with a header over it. Without this, focus in the header is
   * outside every column, the press is not ours, and the ordinary geometry
   * answers it — which on the settings screen meant one press of DOWN from the
   * header landed in the password field of the pane, with the entire section
   * list to its left never visited. Measured: a viewer coming down from the
   * header reached four controls out of eighteen and had to guess at LEFT to
   * find the settings at all.
   *
   * Off by default, and never for an overlay: the player's menu also uses
   * columns, and an overlay that grabs a press from outside itself is a trap.
   */
  entryFromAbove?: boolean;
}

/** Focus a column, honouring its entry point. */
function enter(col: Column): boolean {
  const el = col.el;
  if (el === null) return false;
  const target = col.entry ?? null;
  if (target !== null && target.isConnected) {
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (focusFirst(el)) return true;
  if (col.scroll !== false) {
    el.focus();
    return true;
  }
  return false;
}

/**
 * Answer one arrow press across an ordered list of columns, left to right.
 *
 * Returns false when the press is not ours — focus is outside every column, or
 * it is an Up with nowhere to go — and the caller should let the app's ordinary
 * navigation have it.
 */
export function columnArrow(dir: ColumnDir, cols: Column[], opts?: ColumnOpts): boolean {
  const el = document.activeElement;
  const at = cols.findIndex((c) => c.el !== null && c.el.contains(el));
  if (at < 0) {
    /* Coming down from the header onto a screen made of columns: the first
       column is the answer, not whatever the geometry finds. Never from inside
       an overlay — that press belongs to the overlay. */
    if (dir !== 'down' || opts?.entryFromAbove !== true) return false;
    if (!(el instanceof Element)) return false;
    if (el.closest('[data-nav-contain]') !== null) return false;
    /*
     * And only from something genuinely ABOVE the columns.
     *
     * "Outside every column" is not the same fact as "above them". The Organise
     * screen has an action bar that sits INSIDE the pane but is not one of the
     * registered columns, and treating a press there as an arrival from the
     * header teleported focus across the screen into the section list — one
     * press of DOWN from HIDE landed on the leftmost rail. A row that is level
     * with the columns is beside them, not over them, and its press is not ours.
     */
    const here = el.getBoundingClientRect();
    const top = Math.min(...cols.filter((c) => c.el !== null)
      .map((c) => c.el!.getBoundingClientRect().top));
    if (!Number.isFinite(top) || here.bottom > top + 4) return false;
    for (const col of cols) if (enter(col)) return true;
    return false;
  }
  const here = cols[at]!;
  const col = here.el!;

  const onSelf = here.scroll !== false && el === col;
  const scroll = (by: number): boolean => {
    col.scrollBy({ top: by, behavior: 'smooth' });
    return true;
  };

  switch (dir) {
    case 'up':
      if (onSelf) return scroll(-Math.round(col.clientHeight * 0.4));
      /* NOT consumed when there is nothing above: the header is up there. */
      return moveWithin('up', col);
    case 'down':
      if (onSelf) return scroll(Math.round(col.clientHeight * 0.4));
      /* Consumed either way — the bottom of a column is the bottom. */
      return moveWithin('down', col) || true;
    case 'right': {
      if (moveWithin('right', col)) return true;
      /* The next column that is actually on screen: a pane can be absent. */
      for (let i = at + 1; i < cols.length; i += 1) if (enter(cols[i]!)) return true;
      return true;
    }
    case 'left': {
      if (moveWithin('left', col)) return true;
      for (let i = at - 1; i >= 0; i -= 1) if (enter(cols[i]!)) return true;
      /* Left out of the first column is nothing, not an escape into the page
         behind: this is a screen made of columns and there is nothing further
         left than the leftmost one. */
      return true;
    }
    default:
      return false;
  }
}
