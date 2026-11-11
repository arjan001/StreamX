import { useEffect, useState } from 'react';
import { ArrowUpCircle, ExternalLink } from 'lucide-react';
import { subscribeAppConfig } from '../lib/appConfig';
import { storeUrl } from '../lib/storeLink';

/**
 * The operator's remote config, shown: a notice bar and a minimum-version gate.
 *
 * The operator sets a minimum version in the admin area and every older client
 * stops here with a screen that sends the viewer to the store. The app never
 * downloads or installs anything itself.
 *
 * ── the rules that keep this from being a way to brick everybody ──
 *
 * **A client that does not report a version is never blocked.** An unknown version
 * cannot satisfy a minimum, and locking out the case you did not think of is how a
 * remote kill switch happens by accident. The check lives on the server
 * (`compareVersions` in apps/server/src/admin.ts) and returns `mustUpdate: false`
 * for anything it cannot parse.
 *
 * **It fails open.** If `/api/app-config` cannot be reached, nothing is shown. An
 * app that refuses to work when its config server is down is worse than an app
 * running a version somebody wanted retired.
 *
 * **It is genuinely not closable.** No close button, no escape key, no
 * click-outside, and it renders instead of the app rather than over it.
 */

interface Config {
  mustUpdate: boolean;
  updateMessage: string | null;
  minVersion: string | null;
  notice: string | null;
}

/** This build's version, stamped at build time. Absent means never blocked. */
const VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';

function asConfig(raw: unknown): Config | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['mustUpdate'] !== 'boolean') return null;
  if (o['updateMessage'] !== null && typeof o['updateMessage'] !== 'string') return null;
  if (o['minVersion'] !== null && typeof o['minVersion'] !== 'string') return null;
  if (o['notice'] !== null && typeof o['notice'] !== 'string') return null;
  return {
    mustUpdate: o['mustUpdate'],
    updateMessage: o['updateMessage'] as string | null,
    minVersion: o['minVersion'] as string | null,
    notice: o['notice'] as string | null,
  };
}

export function UpdateGate({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<Config | null>(null);

  useEffect(() => {
    let alive = true;
    /* One document for every reader — see lib/appConfig.ts. Fetched at boot and
       again when the app returns to the front after six hours. */
    const off = subscribeAppConfig((raw) => {
      const body = asConfig(raw);
      if (alive && body !== null) setCfg(body);
    });
    return () => { alive = false; off(); };
  }, []);

  if (cfg?.mustUpdate !== true) {
    return (
      <>
        {cfg?.notice ? <Notice text={cfg.notice} /> : null}
        {children}
      </>
    );
  }

  const store = storeUrl();
  return (
    <div className="grid min-h-full place-items-center bg-ground p-6">
      <div className="w-full max-w-md text-center">
        <ArrowUpCircle className="mx-auto h-12 w-12 text-tally" />
        <h1 className="mt-5 text-2xl font-semibold text-ink tv:text-4xl">Update required</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2 tv:text-lg">
          {cfg.updateMessage
            ?? 'This version is no longer supported. Update the app from the store to carry on watching.'}
        </p>
        <p className="mt-2 font-mono text-[length:var(--t-2xs)] text-ink-3">
          You have {VERSION || 'an unknown version'}
          {cfg.minVersion ? ` · ${cfg.minVersion} or newer is required` : ''}
        </p>
        {store !== null ? (
          <a
            href={store}
            data-nav-first
            className="mt-8 flex w-full items-center justify-center gap-2 border border-tally bg-tally
                       px-4 py-3 text-base font-semibold text-ground tv:py-5 tv:text-xl"
          >
            <ExternalLink className="h-5 w-5" /> Open the store
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** An operator's message to everyone. A strip, not a dialog — it interrupts nothing. */
function Notice({ text }: { text: string }) {
  return (
    <p className="shrink-0 border-b border-tally/40 bg-tally/10 px-3 py-1.5 text-center text-xs text-ink">
      {text}
    </p>
  );
}
