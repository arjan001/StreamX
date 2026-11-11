import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { LEGAL_TITLES, isLegalPage, legalHtml } from '../legal';

/**
 * Terms, Privacy, Copyright and the open-source licences, as a screen.
 *
 * The text is bundled with the app (`src/legal`), so it opens offline and on a
 * platform with no server, and it is the same wording the website serves.
 *
 * Built for a remote. The page is cut into blocks at its headings and each block
 * is a focus stop, so DOWN walks the text and scrolls it into view — a long
 * document in a scroller with nothing focusable in it does not move on a D-pad.
 * It is a route of its own, outside the first-run gate, because the first-run
 * screen links here and must not be covered by itself.
 */
export function Legal() {
  const { doc } = useParams();
  const nav = useNavigate();
  const page = isLegalPage(doc) ? doc : null;

  const blocks = useMemo(
    () => (page === null ? [] : legalHtml(page).split(/(?=<h[23]>)/).filter((b) => b.trim() !== '')),
    [page],
  );

  useEffect(() => {
    if (page !== null) document.title = `${LEGAL_TITLES[page]} — ${document.title.split(' — ').pop() ?? ''}`;
  }, [page]);

  /* Back goes where the viewer came from, or to the About list when this was
     the first screen (a link from the first-run screen opens it fresh). */
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav('/more?s=legal', { replace: true });
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto px-5 py-4 tv:px-10 tv:py-7">
      <div className="mx-auto w-full max-w-2xl tv:max-w-3xl">
        <button
          type="button"
          onClick={back}
          data-nav-first
          className="tap pick mb-3 inline-flex w-auto items-center gap-2 px-3 py-2 font-mono text-[length:var(--t-xs)] uppercase tracking-wider"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        {page === null ? (
          <p className="text-ink-2">That page does not exist.</p>
        ) : (
          <article className="legal-text">
            {blocks.map((html, i) => (
              <div
                key={i}
                tabIndex={0}
                className="tap legal-block"
                /* Our own bundled text; publisher values were escaped when it was rendered. */
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ))}
          </article>
        )}
      </div>
    </div>
  );
}
