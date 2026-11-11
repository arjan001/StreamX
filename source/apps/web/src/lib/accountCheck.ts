/**
 * Is the subscription on this device still a subscription?
 *
 * Asked for as "a really big mistake": "on each visit should check if there are
 * authentication or accounts are correct if not you show the dialog again
 * otherwise they can continue for free if they don't log in again. That way
 * people cannot abuse the system."
 *
 * It was a real hole, not a missing nicety. A device signed in once and was never
 * asked again: `refreshSubscription` existed and nothing called it, and even if
 * something had, it returned the cached subscription whenever no door answered.
 * An expired line, a revoked one, a password the reseller had changed — all of
 * them went on looking signed in, with a badge, a catalogue from the last
 * download and a player that failed on every channel.
 *
 * ── the one thing this must never do ──
 *
 * Throw a paying household out because the network hiccuped. A television that
 * boots before its Wi-Fi, a Cloudflare door that is busy, a panel answering 513
 * for a moment — none of those is a verdict on the account, and treating them as
 * one would sign somebody out of a line they paid for, at the moment they sat
 * down to use it. So only two things count as a verdict, and everything else is
 * `unknown`, which does nothing at all:
 *
 *   the panel said so     a door authenticated and reported the line Expired,
 *                         Banned or Disabled, or an expiry date in the past.
 *                         (An expired line still authenticates — gotcha 99 — so
 *                         `auth: 1` alone is not "valid".)
 *   the panel refused     a door parsed the credentials and answered `auth: 0`,
 *                         and did it again on a second ask a few seconds later.
 *
 * `auth: 0` is documented by `core-xtream` as "bad credentials OR connection limit
 * reached", which would be exactly the false eviction above. It was measured on
 * this provider instead of believed: with a stream held open, authentication
 * answered normally at `active_cons=1 max=1` — the limit refuses the STREAM, not
 * the login. So a refusal here means the credentials. The second ask is for the
 * fluke, not for that.
 */
import {
  activeProvider, recheckSubscription, subscribeProviders,
  type HostProbe,
} from './providers/index.ts';
import { kv } from './kv.ts';
import { dlog } from './debugLog.ts';

export type AccountVerdict =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: 'expired' | 'disabled' | 'refused' }
  | { kind: 'unknown' };

const DEAD_STATUS: Record<string, 'expired' | 'disabled'> = {
  expired: 'expired',
  banned: 'disabled',
  disabled: 'disabled',
};

/**
 * The verdict, from the evidence alone. Pure, because this is the part that must
 * not be wrong and must not need a panel to prove it.
 */
export function judgeAccount(
  r: { chosen: HostProbe | null; tried: readonly HostProbe[] },
  now: number,
): AccountVerdict {
  if (r.chosen !== null) {
    const status = (r.chosen.info?.status ?? '').trim().toLowerCase();
    const dead = DEAD_STATUS[status];
    if (dead !== undefined) return { kind: 'invalid', reason: dead };
    const exp = r.chosen.info?.expDate;
    if (exp instanceof Date && exp.getTime() < now) return { kind: 'invalid', reason: 'expired' };
    return { kind: 'valid' };
  }
  if (r.tried.some((t) => t.verdict === 'refused')) return { kind: 'invalid', reason: 'refused' };
  /* Unreachable, busy, blocked, not-here: a statement about doors and networks.
     Not one of them is allowed to cost somebody their line. */
  return { kind: 'unknown' };
}

/** How long to wait before asking a refusing panel a second time. */
const CONFIRM_MS = 8_000;
/** At most this often while the app stays open — a television can run for days. */
const EVERY_MS = 12 * 3600_000;

let lastAt = 0;
let running: Promise<AccountVerdict> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Check the active subscription, and act on a definite answer.
 *
 * `force` is for a launch — "each visit" — and skips the twelve-hour spacing that
 * applies while the app simply stays open. Concurrent calls share one check.
 */
export function checkAccount(force = false): Promise<AccountVerdict> {
  if (running !== null) return running;
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return Promise.resolve({ kind: 'unknown' });
  if (!force && Date.now() - lastAt < EVERY_MS) return Promise.resolve({ kind: 'unknown' });

  running = (async (): Promise<AccountVerdict> => {
    try {
      lastAt = Date.now();
      const id = p.id;
      let evidence = await recheckSubscription(id);
      if (evidence === null) return { kind: 'unknown' };
      let verdict = judgeAccount(evidence, Date.now());
      if (verdict.kind === 'invalid' && verdict.reason === 'refused') {
        await sleep(CONFIRM_MS);
        evidence = await recheckSubscription(id);
        if (evidence === null) return { kind: 'unknown' };
        verdict = judgeAccount(evidence, Date.now());
      }
      /*
       * The number that tells the rest of the story.
       *
       * A customer's debug log shows this check running, and a player error a few
       * lines later reading a flood status (456/509/511/513) off the same account
       * — and the one question that answers is whether OUR app took the slot or
       * found it already gone. `active_cons/max_connections` from the very probe
       * that produced this verdict is that answer, sitting right here for free;
       * without it, "check: valid" and "the panel refused another connection"
       * look unrelated instead of the same event seen twice.
       */
      const conn = evidence?.chosen?.info;
      const connSuffix = conn === undefined || conn.maxConnections === null
        ? ''
        : ` · connections ${conn.activeCons}/${conn.maxConnections}`;
      dlog.info(
        'account',
        `check: ${verdict.kind}${verdict.kind === 'invalid' ? ` (${verdict.reason})` : ''}${connSuffix}`,
      );
      if (verdict.kind === 'invalid' && activeProvider()?.id === id) setProblem({ id, reason: verdict.reason });
      else if (verdict.kind === 'valid' && problem?.id === id) setProblem(null);
      return verdict;
    } catch {
      /* A check that could not complete is `unknown`, never an eviction. */
      return { kind: 'unknown' };
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * A dead line is SAID, not quietly removed.
 *
 * It used to be evicted: the account deleted, its library forgotten, the sign-in
 * door reopened. Correct about nothing playing, and wrong about everything else —
 * somebody who renews tonight had to type the whole subscription in again, and
 * the screen never said why it had asked. "When their subscription expires, just
 * force a popup because nothing will work anyways, and give option if want to use
 * free version" — "either add new account or like refresh or use free version".
 *
 * So the verdict is kept (per account, and across launches, because the check
 * runs once per launch and the popup must not wait for it) and `ExpiredDialog`
 * shows it over the whole app for as long as that account is the active one.
 * Nothing behind it is usable, which keeps the rule this check was built for.
 */
export interface AccountProblem { id: number; reason: 'expired' | 'disabled' | 'refused' }

const PROBLEM_KEY = 'iptv.account.problem';
let problem: AccountProblem | null = (() => {
  try {
    const v: unknown = JSON.parse(kv.get(PROBLEM_KEY) ?? 'null');
    if (v !== null && typeof v === 'object' && typeof (v as AccountProblem).id === 'number') return v as AccountProblem;
  } catch { /* nothing kept */ }
  return null;
})();
const problemSubs = new Set<() => void>();

function setProblem(next: AccountProblem | null): void {
  problem = next;
  try {
    if (next === null) kv.remove(PROBLEM_KEY);
    else kv.set(PROBLEM_KEY, JSON.stringify(next));
  } catch { /* private mode: this launch still knows */ }
  for (const fn of [...problemSubs]) fn();
}

/** The problem with the ACTIVE account, or null — switching account clears it from view. */
export function activeAccountProblem(): AccountProblem | null {
  return problem !== null && activeProvider()?.id === problem.id ? problem : null;
}

/** Told when the verdict changes AND when the active account does. */
export function subscribeAccountProblem(fn: () => void): () => void {
  problemSubs.add(fn);
  const off = subscribeProviders(() => fn());
  return () => { problemSubs.delete(fn); off(); };
}

/**
 * Check now, and again whenever the app comes back to the front after long
 * enough. Returns the function that stops it. Call once, at boot.
 */
export function startAccountChecks(): () => void {
  void checkAccount(true);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void checkAccount(false);
  };
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => { void checkAccount(false); }, EVERY_MS);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
  };
}
