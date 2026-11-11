import { useRef, useState } from 'react';
import { startPreparing } from '../lib/firstCatalogue';
import { Lock, Server, User } from 'lucide-react';
import { parseLineCredentials } from '@iptv/core-xtream';
import { signIn } from '../lib/session';
import { attachSubscription } from '../lib/localCatalogue';
import { isActionKey, useOkToType } from '../lib/okToType';

/**
 * The three fields and the button, on their own, so two screens can ask the same
 * question.
 *
 * Asked for as "for the login area you can make that login area component and
 * you just show the log username and password area and they can enter it and
 * then continue". It was inside `SourcesSheet`'s add-a-line form, which is a
 * settings panel — and the first run now needs the identical question with a
 * completely different frame around it.
 *
 * What is NOT in here is everything that happens afterwards. Settings wants to
 * say "signed in, the catalogue is building" and stay put; the first run wants
 * to ask whether to personalise and then leave. So this owns the fields, the
 * validation, the call and the error, and hands the result up — which is the
 * only split that lets both callers keep their own ending.
 */
export function SignInFields({
  onSignedIn,
  /** Autofocus the first field. The first run wants it; a settings panel does not. */
  autoFocus = false,
  /** Shown right under the server address: the Terms line from AddSource. */
  belowAddress = null,
  /** False until the Terms are accepted; the button stays disabled. */
  agreed = true,
}: {
  onSignedIn: (message: string) => void;
  autoFocus?: boolean;
  belowAddress?: React.ReactNode;
  agreed?: boolean;
}) {
  /* Focus parks, OK types — one hook per field, see `lib/okToType.ts`. */
  /*
   * The keyboard's action key, handled here because nothing else will.
   *
   * On a television that key — Next on the username, Go on the password —
   * reaches the page as an Enter on the field (see `okToType.ts` for the
   * measurement). The form never handled it, and the browser's own "Enter
   * submits the form" was no help either: it presses the default button, and
   * Sign in is disabled until there is something to sign in with. So Next did
   * nothing, on every TV keyboard, and on a Fire TV — whose keyboard fills the
   * screen — the viewer was left looking at a username and a keyboard with no
   * way on. Reported with a photograph.
   *
   * Enter only counts once something has been typed. A remote whose OK button
   * sends ENTER rather than DPAD_CENTER delivers the same keydown to an empty
   * field, and jumping that viewer to the password would be a new bug.
   */
  const passRef = useRef<HTMLInputElement | null>(null);
  const userRef = useRef<HTMLInputElement | null>(null);
  const onAction = (e: React.KeyboardEvent<HTMLInputElement>, from: 'user' | 'pass' | 'host') => {
    if (!isActionKey(e)) return;
    e.preventDefault();
    if (from === 'host') {
      if (host.trim() === '') return;
      okHost.park();
      okUser.begin(userRef.current);
      return;
    }
    if (from === 'user') {
      if (user.trim() === '') return;
      /* A whole playlist link carries its own password: nothing to go on to. */
      if (ready) { void submit(); return; }
      okUser.park();
      okPass.begin(passRef.current);
      return;
    }
    if (ready) { void submit(); return; }
    if (user.trim() === '') { okPass.park(); okUser.begin(userRef.current); }
  };
  const okUser = useOkToType({ onKeyDown: (e) => onAction(e, 'user') });
  const okPass = useOkToType({ onKeyDown: (e) => onAction(e, 'pass') });
  const okHost = useOkToType({ onKeyDown: (e) => onAction(e, 'host') });
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Sign in lights up exactly when sign-in would ACCEPT what is typed.
   *
   * Asking the same question twice in two different ways is how the button
   * ended up dark over input the app was perfectly happy with. This tested for
   * `username=` and `password=` in the text — the `get.php?username=…&password=…`
   * shape — and `parseLineCredentials`, which is what `signIn` actually uses,
   * also accepts `http://user:pass@host:port`. That is the form the fake panel
   * prints, the form a provider hands out as often as the other one, and with it
   * pasted the button stayed disabled while the password field directly beneath
   * said "not needed if the link already has it". Found by driving the sign-in
   * screen on a television rather than by reading it.
   *
   * So it asks the parser. One answer, no second implementation to drift from
   * it, and the button can no longer disagree with the form it submits. The
   * server address is part of that answer: it is required, unless the pasted
   * link carries it.
   */
  const cred = parseLineCredentials(user.trim(), pass);
  /* The server address is required unless the pasted link already names one. */
  const ready = agreed && cred !== null && (host.trim() !== '' || cred.url !== null);

  const submit = async () => {
    if (busy || !ready) return;
    /* Keyboard away first. On a Fire TV it covers the whole screen, so the
       progress — and, more to the point, any error — would be behind it. */
    okUser.park();
    okPass.park();
    okHost.park();
    setBusy(true);
    setError(null);
    const res = await signIn(user.trim(), pass, host.trim() === '' ? undefined : host.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? 'Sign-in failed.');
      return;
    }
    setUser('');
    setPass('');
    setHost('');
    /* Fold the subscription into whatever this device already holds — free
       channels stay, films and series arrive. Nothing is replaced. */
    void attachSubscription();
    /* The catalogue is the app: until it lands there is nothing to browse, so
       the viewer gets a screen that says so rather than an empty one that does
       not. See `lib/firstCatalogue.ts`. */
    if (res.building === true) startPreparing();
    onSignedIn(res.building === true
      ? 'Added. Getting your channels ready\u2026'
      : 'Added.');
  };

  /*
   * `pl-8` leaves room for the leading icon, which is decorative and NOT a
   * button.
   *
   * The mockup also shows an eye inside the password field. It is deliberately
   * not here: on a remote every control in the form is a stop on the way down,
   * and an extra one between the password and Sign in costs a press on every
   * sign-in to save a press for the few people who mistype. Navigation is the
   * thing this app is judged on.
   */
  const field = 'w-full border border-rule bg-ground py-2 pl-8 pr-2 text-sm text-ink'
    + ' outline-none transition-colors focus:border-focus';
  const icon = 'pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3';

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="block">
        <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
          Server address
        </span>
        <span className="relative mt-1 block">
          <Server className={icon} aria-hidden />
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label="Server address"
            autoComplete="off"
            {...okHost.props}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            enterKeyHint="next"
            /*
              The screen's declared entry point, when it is the whole screen.
              `autoFocus` alone was not enough: an overlay runs the app's own
              arrival ladder on mount (`focusFirst`), and with nothing declared it
              answers "what is topmost in reading order" — which on the first-run
              sign-in step landed the highlight on "Back — watch for free instead",
              one press away from abandoning the form.
            */
            {...(autoFocus ? { 'data-nav-first': true } : {})}
            /* eslint-disable-next-line jsx-a11y/no-autofocus -- the first run is a
               form and nothing else; a remote should not have to travel to it. */
            autoFocus={autoFocus}
            placeholder="http://host:port"
            className={field}
          />
        </span>
      </label>
      {belowAddress}
      <label className="mt-2 block">
        <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
          Username
        </span>
        <span className="relative mt-1 block">
        <User className={icon} aria-hidden />
        <input
          ref={userRef}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          aria-label="Username"
          {...okUser.props}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          /* The next stop is the password, not a submit — there is nothing
             to go on with a username alone. */
          enterKeyHint="next"
          placeholder="username, or a full get.php link"
          className={field}
        />
        </span>
      </label>
      <label className="mt-2 block">
        <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
          Password
        </span>
        <span className="relative mt-1 block">
        <Lock className={icon} aria-hidden />
        <input
          ref={passRef}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          aria-label="Password"
          type="password"
          autoComplete="current-password"
          {...okPass.props}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="not needed if the link has it"
          className={field}
        />
        </span>
      </label>

      {error !== null && (
        <p role="alert" className="mt-2 border border-alert/60 bg-alert/10 p-2 text-[length:var(--t-xs)] text-alert">
          {error}
        </p>
      )}

      {/*
        The primary action, and it now looks like one.
        
        This was `btn pill` — an outlined button that, sitting above a filled
        "Continue for free" card and greyed to 40% until both fields have
        something in them, read as permanently disabled. So the screen offered
        one obvious action and it was the wrong one for anybody holding a
        subscription. Filled in the accent when it is usable, outlined when it is
        not, which is the same information the opacity was carrying and is legible
        from a sofa.
      */}
      <button
        type="submit"
        disabled={!ready || busy}
        className={`tap mt-3 w-full justify-center rounded-[var(--r-full)] px-4 py-2.5 text-center
                    font-semibold transition-colors ${
          ready && !busy
            ? 'bg-tally text-ground hover:brightness-110'
            : 'border border-rule text-ink-3'
        }`}
      >
        {busy ? 'Adding…' : 'Add server'}
      </button>
    </form>
  );
}
