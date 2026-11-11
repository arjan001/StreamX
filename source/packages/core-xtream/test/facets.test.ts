import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFacets } from '../src/facets.ts';

/** Every name here is a real category from the reference provider. */
describe('facet derivation', () => {
  test('English genres', () => {
    assert.deepEqual(deriveFacets('|EN| ACTION/THRILLER').genres.sort(), ['action', 'thriller']);
    assert.ok(deriveFacets('|EN| COMEDY').genres.includes('comedy'));
    assert.ok(deriveFacets('|EN| HORROR/THRILLER').genres.includes('horror'));
    assert.ok(deriveFacets('|EN| SCIENCE FICTION/FANTASTY').genres.includes('scifi'));
    assert.ok(deriveFacets('|EN| WESTERNS').genres.includes('western'));
  });

  test('French genres fold accents', () => {
    // COMÉDIE must match the same rule as COMEDIE.
    assert.ok(deriveFacets('|FR| COMÉDIE/DRAME').genres.includes('comedy'));
    assert.ok(deriveFacets('|FR| COMÉDIE/DRAME').genres.includes('drama'));
    assert.ok(deriveFacets('|FR| HORREUR/EPOUVANTE').genres.includes('horror'));
    assert.ok(deriveFacets('|FR| ACTION/AVENTURE').genres.includes('adventure'));
    assert.ok(deriveFacets('|FR| DOCUMENTAIRE').genres.includes('documentary'));
  });

  test('Dutch genres', () => {
    assert.ok(deriveFacets('|NL| KINDEREN').genres.includes('family'));
    assert.ok(deriveFacets('|NL| HORROR').genres.includes('horror'));
  });

  test('region prefix extracted and stripped from the label', () => {
    const f = deriveFacets('|EN| ACTION/THRILLER');
    assert.equal(f.region, 'EN');
    assert.equal(f.cleanName, 'ACTION/THRILLER');
  });

  test('streaming source recognised', () => {
    assert.equal(deriveFacets('NETFLIX MOVIES').source, 'Netflix');
    assert.equal(deriveFacets('|FR| DISNEY').source, 'Disney+');
    assert.equal(deriveFacets('|NL| AMAZON PRIME').source, 'Amazon Prime');
    assert.equal(deriveFacets('|FR| MyCANAL').source, 'Canal+');
  });

  test('anime implies animation, stand-up implies comedy', () => {
    assert.ok(deriveFacets('|FR| MANGA').genres.includes('animation'));
    assert.ok(deriveFacets('|EN| ANIME').genres.includes('anime'));
    assert.ok(deriveFacets('|EN| STAND-UP COMEDY').genres.includes('comedy'));
  });

  test('a category with no recognisable genre yields none rather than guessing', () => {
    assert.deepEqual(deriveFacets('|NL| OVERIGE').genres, []);
    assert.deepEqual(deriveFacets('|EN| COLLECTIONS').genres, []);
  });

  /*
   * Spanish, which the rules claimed to cover and did not.
   *
   * `ES` has always been in the region list and the catalogue is full of `|ES|`
   * packages, but not one Spanish keyword was in the table — so every Spanish
   * package derived nothing, and pressing Comedy showed five packages out of a
   * hundred and forty-nine with none of the Spanish ones among them.
   */
  test('Spanish names derive genres, not silence', () => {
    assert.deepEqual(deriveFacets('|ES| COMEDIA').genres, ['comedy']);
    assert.deepEqual(deriveFacets('|ES| ACCION/CRIMEN').genres.sort(), ['action', 'crime']);
    assert.deepEqual(deriveFacets('|ES| CIENCIA FICCION/FANTASIA').genres.sort(), ['fantasy', 'scifi']);
    assert.deepEqual(deriveFacets('|ES| NIÑOS/ANIMACION').genres.sort(), ['animation', 'family']);
    assert.deepEqual(deriveFacets('|ES| BELICO').genres, ['war']);
    assert.deepEqual(deriveFacets('|ES| TERROR').genres, ['horror']);
  });

  /*
   * `\b` at the end of a stem loses the plural and every compound. Three real
   * category names that derived nothing because of it.
   */
  test('a plural or a compound is still the genre', () => {
    assert.ok(deriveFacets('|NL| JAREN 90 THRILLERS').genres.includes('thriller'));
    assert.ok(deriveFacets('|EN| BROADWAY/MUSICAL').genres.includes('music'));
    assert.ok(deriveFacets('|NL| KERSTFILMS').genres.includes('christmas'));
  });

  /*
   * The other half of that fix: the stems that must NOT take a suffix.
   *
   * Half of this catalogue's packages are studio and brand names, so a rule that
   * grows loosely files them under a genre nobody will look for them in — which
   * is worse than leaving them unfiled, because browsing still finds an unfiled
   * package and nothing finds a misfiled one.
   */
  test('a loose stem does not claim a studio, a strand or a channel', () => {
    assert.deepEqual(deriveFacets('WARNER MOVIES').genres, []);          // not war
    assert.deepEqual(deriveFacets('|EN| SCIENCE AND NATURE').genres, []); // not sci-fi
    assert.deepEqual(deriveFacets('4KIDS TV').genres, []);                // not 4K
    assert.deepEqual(deriveFacets('NETFLIX MOVIES').genres, []);
  });

  test('bare DOC packages are documentaries', () => {
    assert.deepEqual(deriveFacets('NETFLIX DOC').genres, ['documentary']);
    assert.ok(deriveFacets('|EN| DOCS').genres.includes('documentary'));
  });
});

test('a free country prefix is stripped for display like a provider one', () => {
  assert.equal(deriveFacets('USF| General').cleanName, 'General');
  assert.equal(deriveFacets('NL| NEWS').cleanName, 'NEWS');
  // Not everything two letters and an F: only the delimiter form is a market.
  assert.equal(deriveFacets('SF| X').cleanName, 'SF| X');
});
