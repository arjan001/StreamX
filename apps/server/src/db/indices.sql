/*
 * Empty on purpose.
 *
 * Every index here was on `item`, `series` or `category` — trigram indexes for
 * search, an expression index for the alphabetical sort key, and `ix_item_family`
 * for the live variant collapse. Those tables are gone, and the three that remain
 * carry their own indexes beside their definitions in alters.sql because they are
 * small enough that keeping them in one place is worth more than the symmetry.
 *
 * Kept rather than deleted so `migrate.ts` does not need a special case, and so
 * the next index has an obvious home.
 */
SELECT 1;
