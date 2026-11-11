/**
 * "Turn your phone sideways."
 *
 * The app is a television app and always runs landscape: "I'd like to always
 * open it in a horizontal and it should adapt to the screen". The APK locks the
 * orientation (AndroidManifest `sensorLandscape`) and the installed web app asks
 * for it in its manifest; a phone or tablet in a plain browser tab cannot be
 * made to turn, so it is asked, over the page, until it does.
 *
 * Where the browser allows it (Android Chrome), one press goes full screen and
 * locks the screen sideways — orientation lock only works in full screen.
 * Only ever on a phone or a tablet (`touchScreen`): a television and a desktop
 * never see it, whatever shape their window is.
 */
import { useState } from 'react';
import { Maximize2, Smartphone } from 'lucide-react';
import { useShape } from '../lib/formFactor';

interface LockableOrientation { lock?: (o: string) => Promise<void> }

function canLock(): boolean {
  if (typeof document === 'undefined' || typeof screen === 'undefined') return false;
  const o = (screen as unknown as { orientation?: LockableOrientation }).orientation;
  return typeof document.documentElement.requestFullscreen === 'function' && typeof o?.lock === 'function';
}

async function goSideways(): Promise<boolean> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const o = (screen as unknown as { orientation?: LockableOrientation }).orientation;
    await o?.lock?.('landscape');
    return true;
  } catch {
    return false;
  }
}

export function RotatePrompt() {
  const { touchScreen, orientation } = useShape();
  const [failed, setFailed] = useState(false);
  if (touchScreen === null || orientation !== 'portrait') return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Turn your screen sideways"
      className="rotate-prompt fixed inset-0 z-[200] flex flex-col items-center justify-center gap-5
                 bg-ground px-8 text-center"
    >
      <Smartphone className="rotate-prompt-phone h-16 w-16 text-tally" strokeWidth={1.5} />
      <div className="space-y-2">
        <p className="text-[1.35rem] font-semibold text-ink">Turn your {touchScreen} sideways</p>
        <p className="text-[1rem] leading-relaxed text-ink-2">
          Streamix is made for a wide screen, like your TV.
        </p>
      </div>
      {canLock() && !failed && (
        <button
          type="button"
          onClick={() => { void goSideways().then((ok) => { if (!ok) setFailed(true); }); }}
          className="tap flex items-center gap-2 border border-tally px-5 py-3 text-[1rem] text-tally"
        >
          <Maximize2 className="h-5 w-5" />
          Full screen, sideways
        </button>
      )}
    </div>
  );
}
