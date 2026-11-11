import { Live } from './Live';

/**
 * Sports TV is Live TV with the sports in its first column.
 *
 * It was a screen of its own for one release — grouped by country, its own
 * player, its own rows — and the owner's answer was to "use the same concept and
 * components and layouts and settings". Everything Live has, Sports has, because
 * it is the same component; see `sports` in routes/Live.tsx.
 */
export function Sports() {
  return <Live sports />;
}
