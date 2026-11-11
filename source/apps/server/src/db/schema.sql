/*
 * Everything this box still stores.
 *
 * There used to be ten tables here and 383MB in them: a subscription's
 * credentials, a generational catalogue of 150,786 items and 41,029 series, 962
 * categories, cached panel replies and a guide. All of it existed so the server
 * could answer questions about a provider on a client's behalf — and the client
 * asks the provider itself now.
 *
 * What is left is what a device cannot know about itself: what has gone wrong
 * out there, and what an operator has decided since the APK was signed. Two
 * tables, well under a megabyte.
 *
 * The definitions live in alters.sql, which is applied after this file and is
 * written to be re-runnable. This file exists to say what is gone.
 */

/*
 * Dropped, deliberately and in order.
 *
 * `item` and `series` cascade from `generation`, which cascades from `source`, so
 * dropping the parent is enough — but naming every one of them is the point: an
 * installation upgrading from the old shape should end up with the same schema as
 * a fresh one, and a table left behind is 321MB of disk nobody will think to look
 * for again.
 */
DROP TABLE IF EXISTS epg_programme  CASCADE;
DROP TABLE IF EXISTS epg_fetch      CASCADE;
DROP TABLE IF EXISTS epg_override   CASCADE;
DROP TABLE IF EXISTS series_detail  CASCADE;
DROP TABLE IF EXISTS item           CASCADE;
DROP TABLE IF EXISTS series         CASCADE;
DROP TABLE IF EXISTS category       CASCADE;
DROP TABLE IF EXISTS generation     CASCADE;
DROP TABLE IF EXISTS source         CASCADE;
/* The settings backup. Settings are device-local now — see the note in main.tsx. */
DROP TABLE IF EXISTS viewer_state   CASCADE;
/* Already dropped once, before any of this; named again so one file is the whole
   story of what this database used to be. */
DROP TABLE IF EXISTS user_pref      CASCADE;
DROP TABLE IF EXISTS watch_position CASCADE;
/*
 * Presence, dropped 2026-10-01 at the owner's word: "remove the watch … where it
 * shows who is watching, who is logged in … you are not allowed to send it to the
 * server any longer", and, asked what to do with what had been collected, "delete
 * it all". The roster of devices, thirty days of what each account watched, and
 * every change of plan. No backup was taken; that was the point.
 */
DROP TABLE IF EXISTS watch_session   CASCADE;
DROP TABLE IF EXISTS plan_transition CASCADE;
DROP TABLE IF EXISTS viewer_device   CASCADE;
