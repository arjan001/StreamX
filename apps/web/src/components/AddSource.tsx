import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Cpu, KeyRound, Link2, ListVideo, Radio, Server, Square, CheckSquare, Tv, User, type LucideIcon } from 'lucide-react';
import { BRAND } from '../brand';
import { SignInFields } from './SignInFields';
import { addPlaylistSource, addStalkerSource, addStreamSource, sourceTypesOffered, type AddResult, type SourceTypeId } from '../lib/sources';
import { MAC_EXAMPLE, macProblem } from '../lib/providers/stalker';
import { acceptRights, rightsAccepted } from '../lib/rights';
import { localStatus, subscribeLocal, type IngestStatus } from '../lib/localCatalogue';
import { useOkToType, isActionKey } from '../lib/okToType';
import { focusFirst } from '../lib/spatialNav';
import { pushBackHandler } from '../lib/nativeBack';

/**
 * Adding a source: "what are you adding", then the form for that type, with the
 * Terms as one line under the address (a box to tick the first time).
 *
 * The first run, Add account and the Sources sheet all come through here, so the
 * Terms line and the list of types exist once. A new source type is one entry
 * in `SOURCE_TYPES` (lib/sources.ts), one icon below and one form in `FORMS`.
 */

const ICONS: Record<SourceTypeId, LucideIcon> = {
  xtream: Server,
  m3u: ListVideo,
  stream: Radio,
  stalker: Cpu,
};

/** The legal pages are ordinary routes; a sheet that opened them must get out of the way. */
export function useHiddenOnLegal(): boolean {
  return useLocation().pathname.startsWith('/legal/');
}

/**
 * The Terms, where other apps put them: one line under the address.
 *
 * Until this device has accepted the current Terms (lib/rights.ts) it is a box
 * to tick, and the form's button stays disabled; after that it is a reminder.
 */
function TermsLine({ accepted, ticked, onTick, onLegal }: {
  accepted: boolean;
  ticked: boolean;
  onTick: () => void;
  onLegal: (to: string) => void;
}) {
  const link = 'text-tally underline underline-offset-2 hover:brightness-110';
  const links = (
    <>
      <button type="button" className={link} onClick={() => onLegal('/legal/terms')}>Terms of Use</button>
      {' and '}
      <button type="button" className={link} onClick={() => onLegal('/legal/privacy')}>Privacy Policy</button>
    </>
  );
  if (accepted) {
    return (
      <p className="mt-2 text-[length:var(--t-2xs)] leading-snug text-ink-3">
        By adding a source you accept the {links}.
      </p>
    );
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={ticked}
        onClick={onTick}
        className="tap flex w-full items-start gap-2 py-1 text-left"
      >
        {ticked
          ? <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-tally" aria-hidden />
          : <Square className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />}
        <span className="text-[length:var(--t-xs)] leading-snug text-ink-2">
          I accept the Terms of Use and Privacy Policy, and I only add sources I have the right to use.
        </span>
      </button>
      <p className="ml-6 text-[length:var(--t-2xs)] text-ink-3">Read the {links}.</p>
    </div>
  );
}

interface RowHandle { begin: () => void }

const fieldClass = 'w-full border border-rule bg-ground py-2 pl-8 pr-2 text-sm text-ink'
  + ' outline-none transition-colors focus:border-focus';
const iconClass = 'pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3';
const labelClass = 'font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3';

/** One text field with the remote's focus-parks-OK-types rule and the keyboard's action key. */
const TextRow = forwardRef<RowHandle, {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  Icon: LucideIcon;
  first?: boolean;
  /** The keyboard's action key with something typed: go on, or submit. */
  onAction: () => void;
  last?: boolean;
  /** A password-type field: masked, and never offered for autofill. */
  secret?: boolean;
  /** Not an address: the soft keyboard should not be the URL one. */
  plain?: boolean;
}>(function TextRow({
  label, value, onChange, placeholder, Icon, first = false, onAction, last = false, secret = false, plain = false,
}, ref) {
  const input = useRef<HTMLInputElement | null>(null);
  const ok = useOkToType({
    onKeyDown: (e) => {
      if (!isActionKey(e)) return;
      e.preventDefault();
      if (value.trim() === '') return;
      ok.park();
      onAction();
    },
  });
  useImperativeHandle(ref, () => ({ begin: () => ok.begin(input.current) }));
  return (
    <label className="mt-2 block first:mt-0">
      <span className={labelClass}>{label}</span>
      <span className="relative mt-1 block">
        <Icon className={iconClass} aria-hidden />
        <input
          ref={input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          autoComplete="off"
          {...ok.props}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode={plain ? 'text' : 'url'}
          {...(secret ? { type: 'password' } : {})}
          enterKeyHint={last ? 'go' : 'next'}
          {...(first ? { 'data-nav-first': true } : {})}
          placeholder={placeholder}
          className={fieldClass}
        />
      </span>
    </label>
  );
});

/** What the load is doing, in plain words, while the form waits. */
function Progress({ busy, what = 'playlist' }: { busy: boolean; what?: 'playlist' | 'portal' }) {
  const [st, setSt] = useState<IngestStatus>(localStatus);
  useEffect(() => subscribeLocal(setSt), []);
  if (!busy) return null;
  return (
    <p role="status" className="mt-2 font-mono text-[length:var(--t-2xs)] text-tally">
      {st.rows > 0
        ? `Reading the ${what}… ${st.rows.toLocaleString()} titles`
        : what === 'portal' ? 'Contacting the portal…' : 'Reading the link…'}
    </p>
  );
}

/** What every form is handed: the Terms line to show under its address, and whether they are accepted. */
interface FormProps {
  onAdded: (message: string) => void;
  terms: React.ReactNode;
  agreed: boolean;
}

/** Shared by the two link forms: run an add, show the error, hand a success up. */
function useAdd(onAdded: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (go: () => Promise<AddResult>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let res: AddResult;
    try { res = await go(); } catch (e) { res = { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    setBusy(false);
    if (res.ok) onAdded(res.message); else setError(res.message);
  };
  return { busy, error, run };
}

function Submit({ ready, busy, label }: { ready: boolean; busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={!ready || busy}
      className={`tap mt-3 w-full justify-center rounded-[var(--r-full)] px-4 py-2.5 text-center
                  font-semibold transition-colors ${
        ready && !busy ? 'bg-tally text-ground hover:brightness-110' : 'border border-rule text-ink-3'
      }`}
    >
      {busy ? 'Adding…' : label}
    </button>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  if (text === null) return null;
  const code = getAddSourceCode(text);
  return (
    <div>
      <p role="alert" className="mt-2 border border-alert/60 bg-alert/10 p-2 text-[length:var(--t-xs)] text-alert">
        {text}
      </p>
      <details className="mt-1 rounded border border-rule/50 bg-panel/50">
        <summary className="cursor-pointer px-2 py-1 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-ink">
          Error details
        </summary>
        <div className="px-2 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-2">
          {code}
        </div>
      </details>
    </div>
  );
}

function getAddSourceCode(message: string): React.ReactNode {
  const msg = message.toLowerCase();
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('reach')) {
    return <div><strong>Code: N001</strong> — Network error. Check your internet connection and the URL.</div>;
  }
  if (msg.includes('parse') || msg.includes('format') || msg.includes('invalid')) {
    return <div><strong>Code: N002</strong> — Invalid format. The URL may not point to a valid playlist or stream.</div>;
  }
  if (msg.includes('timeout')) {
    return <div><strong>Code: N003</strong> — Request timed out. The server is slow to respond; try again.</div>;
  }
  return <div><strong>Code: N999</strong> — Unknown error. Check the URL and try again.</div>;
}

function PlaylistForm({ onAdded, terms, agreed }: FormProps) {
  const [url, setUrl] = useState('');
  const [guide, setGuide] = useState('');
  const [name, setName] = useState('');
  const guideRef = useRef<RowHandle>(null);
  const nameRef = useRef<RowHandle>(null);
  const { busy, error, run } = useAdd(onAdded);
  const ready = agreed && url.trim() !== '';
  const submit = () => { if (ready) void run(() => addPlaylistSource({ url, epgUrl: guide, name })); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <TextRow label="Playlist link" value={url} onChange={setUrl} first Icon={Link2}
        placeholder="http://… .m3u or .m3u8" onAction={() => guideRef.current?.begin()} />
      {terms}
      <TextRow ref={guideRef} label="TV guide link (XMLTV), optional" value={guide} onChange={setGuide} Icon={Tv}
        placeholder=".xml or .xml.gz — leave empty to use the playlist's own"
        onAction={() => nameRef.current?.begin()} />
      <TextRow ref={nameRef} label="Name, optional" value={name} onChange={setName} Icon={ListVideo}
        placeholder="Optional — defaults to the address" onAction={submit} last />
      <Progress busy={busy} />
      <ErrorLine text={error} />
      <Submit ready={ready} busy={busy} label="Add playlist" />
    </form>
  );
}

function StreamForm({ onAdded, terms, agreed }: FormProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const nameRef = useRef<RowHandle>(null);
  const { busy, error, run } = useAdd(onAdded);
  const ready = agreed && url.trim() !== '';
  const submit = () => { if (ready) void run(() => addStreamSource({ url, name })); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <TextRow label="Stream link" value={url} onChange={setUrl} first Icon={Link2}
        placeholder="http://… .m3u8, .ts, .mp4 or .mpd" onAction={() => nameRef.current?.begin()} />
      {terms}
      <TextRow ref={nameRef} label="Name, optional" value={name} onChange={setName} Icon={Radio}
        placeholder="Optional — defaults to the stream" onAction={submit} last />
      <ErrorLine text={error} />
      <Submit ready={ready} busy={busy} label="Add stream" />
    </form>
  );
}

function StalkerForm({ onAdded, terms, agreed }: FormProps) {
  const [portal, setPortal] = useState('');
  const [mac, setMac] = useState('');
  const [more, setMore] = useState(false);
  const [serial, setSerial] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [login, setLogin] = useState('');
  const [secret, setSecret] = useState('');
  const macRef = useRef<RowHandle>(null);
  const serialRef = useRef<RowHandle>(null);
  const deviceRef = useRef<RowHandle>(null);
  const loginRef = useRef<RowHandle>(null);
  const secretRef = useRef<RowHandle>(null);
  const { busy, error, run } = useAdd(onAdded);
  const macWrong = mac.trim() !== '' ? macProblem(mac) : null;
  const ready = agreed && portal.trim() !== '' && macProblem(mac) === null;
  const submit = () => {
    if (!ready) return;
    void run(() => addStalkerSource({
      portal, mac, serial, deviceId, username: login, password: secret,
    }));
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <TextRow label="Portal address" value={portal} onChange={setPortal} first Icon={Link2}
        placeholder="http://portal.example.com/c/" onAction={() => macRef.current?.begin()} />
      {terms}
      <TextRow ref={macRef} label="MAC address" value={mac} onChange={setMac} Icon={Cpu} plain
        placeholder={MAC_EXAMPLE}
        onAction={() => (more ? serialRef.current?.begin() : submit())} last={!more} />
      <p className={`mt-1 text-[length:var(--t-2xs)] ${macWrong === null ? 'text-ink-3' : 'text-alert'}`}>
        {macWrong ?? `The MAC your provider registered, like ${MAC_EXAMPLE}.`}
      </p>
      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
        className="card card-hover tap mt-3 flex w-full items-center gap-2 border border-rule px-3 py-2 text-left"
      >
        <ChevronDown className={`h-4 w-4 shrink-0 text-ink-3 transition-transform ${more ? 'rotate-180' : ''}`} aria-hidden />
        <span className="text-[length:var(--t-sm)] text-ink">Advanced</span>
        <span className="text-[length:var(--t-xs)] text-ink-3">serial number, device id, login</span>
      </button>
      {more && (
        <div className="mt-2">
          <TextRow ref={serialRef} label="Serial number, optional" value={serial} onChange={setSerial} Icon={KeyRound} plain
            placeholder="Only if your provider gave you one" onAction={() => deviceRef.current?.begin()} />
          <TextRow ref={deviceRef} label="Device id, optional" value={deviceId} onChange={setDeviceId} Icon={KeyRound} plain
            placeholder="Only if your provider gave you one" onAction={() => loginRef.current?.begin()} />
          <TextRow ref={loginRef} label="Login, optional" value={login} onChange={setLogin} Icon={User} plain
            placeholder="Username, if the portal asks for one" onAction={() => secretRef.current?.begin()} />
          <TextRow ref={secretRef} label="Password, optional" value={secret} onChange={setSecret} Icon={KeyRound} plain secret
            placeholder="Password for that login" onAction={submit} last />
        </div>
      )}
      <Progress busy={busy} what="portal" />
      <ErrorLine text={error} />
      <Submit ready={ready} busy={busy} label="Add portal" />
    </form>
  );
}

/** The form for each type. Adding a source type: one more entry here. */
const FORMS: Record<SourceTypeId, (p: FormProps) => React.ReactElement> = {
  xtream: ({ onAdded, terms, agreed }) => <SignInFields autoFocus onSignedIn={onAdded} belowAddress={terms} agreed={agreed} />,
  m3u: (p) => <PlaylistForm {...p} />,
  stream: (p) => <StreamForm {...p} />,
  stalker: (p) => <StalkerForm {...p} />,
};

export function AddSource({
  onAdded,
}: {
  /** The kind is passed so the caller can offer what only some kinds have (packages). */
  onAdded: (message: string, kind: SourceTypeId) => void;
}) {
  const nav = useNavigate();
  const [accepted] = useState(rightsAccepted);
  const [ticked, setTicked] = useState(false);
  const [type, setType] = useState<SourceTypeId | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  /* Land on the first thing of each step; the remote must not be left behind it. */
  useEffect(() => {
    const el = box.current;
    if (el !== null) focusFirst(el);
  }, [type]);

  /* BACK and Escape step back from a form before they leave the dialog. */
  useEffect(() => {
    if (type === null) return undefined;
    const off = pushBackHandler(() => { setType(null); return true; });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); setType(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => { off(); window.removeEventListener('keydown', onKey); };
  }, [type]);

  if (type === null) {
    return (
      <div ref={box}>
        <p className="text-[length:var(--t-sm)] leading-relaxed text-ink-2">What are you adding?</p>
        <div className="mt-2 space-y-2">
          {sourceTypesOffered().map((t, i) => {
            const Icon = ICONS[t.id];
            return (
              <button
                key={t.id}
                type="button"
                {...(i === 0 ? { 'data-nav-first': true } : {})}
                onClick={() => setType(t.id)}
                className="card card-hover tap flex w-full items-center gap-3 border border-rule px-3 py-3 text-left"
              >
                <Icon className="h-5 w-5 shrink-0 text-tally" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--t-md)] text-ink">{t.label}</span>
                  <span className="block text-[length:var(--t-xs)] text-ink-3">{t.hint}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const Form = FORMS[type];
  const label = sourceTypesOffered().find((t) => t.id === type)?.label ?? '';
  return (
    <div ref={box}>
      <p className="mb-3 flex items-center gap-2 text-[length:var(--t-sm)] text-ink-2">
        <Check className="h-4 w-4 text-tally" aria-hidden /> {label}
      </p>
      <Form
        terms={<TermsLine accepted={accepted} ticked={ticked} onTick={() => setTicked((v) => !v)} onLegal={(to) => nav(to)} />}
        agreed={accepted || ticked}
        onAdded={(m) => {
          /* The yes is recorded when it is acted on: the first source added. */
          if (!accepted) acceptRights();
          onAdded(m, type);
        }}
      />
      <button
        type="button"
        onClick={() => setType(null)}
        className="card card-hover tap mt-3 flex w-full items-center justify-center border border-rule px-4 py-3 text-center"
      >
        <span className="text-[length:var(--t-md)] text-ink">Back</span>
      </button>
    </div>
  );
}
