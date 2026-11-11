import { useParams } from 'react-router-dom';
import { SeriesDesk } from '../components/SeriesDesk';

/**
 * `/series/:id` — and it is a desk now, not a document.
 *
 * This page used to be a scrolling article: a full-bleed hero, a strip of season
 * buttons, an episode list below the fold, a spec table under that, a related
 * rail at the bottom, and a player that appeared ABOVE the episode you had just
 * pressed — so playing something meant being scrolled away from the list you
 * were choosing from. The whole screen is `components/SeriesDesk` now: series on
 * the left, that series' episodes in the middle, the picture and the description
 * on the right, which is how the room this app is used in already works.
 *
 * The route keeps only what a route knows: which title.
 */
export function SeriesDetail() {
  const { id } = useParams<{ id: string }>();
  return <SeriesDesk routeId={id ?? ''} />;
}
