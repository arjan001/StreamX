/**
 * A text field on a television is a place you LAND before it is a place you type.
 *
 * "all the input fields on the app, make it so they click ok to search make it a
 * common thing so we can do it in one place, that way when they come over an
 * input it wont open they keyboard."
 *
 * The complaint underneath it is what the platform IME does to a D-pad. Walking
 * down a column and merely touching a field summons the on-screen keyboard: the
 * whole screen is replaced, the arrows now belong to a grid of letters, and
 * getting out means finding its close key. That happens on the way PAST the
 * field — to reach the rows under it — so a viewer pays for a keyboard they
 * never asked for, several times a minute.
 *
 * So: focus parks, OK types.
 *
 *   parked   the field is `readOnly`, which is the one thing that reliably stops
 *            an Android WebView raising the IME on focus, and it is marked
 *            `data-ok-to-type="idle"` so `lib/keys.ts` lets the arrows walk
 *            straight past it instead of handing them to a caret.
 *   typing   OK clears `readOnly` and re-focuses, which is what raises the
 *            keyboard — deliberately, once, because somebody asked for it.
 *            Escape, the IME's own action key and losing focus all park it again.
 *
 * Only where there is a remote. With a pointer, clicking a field means typing in
 * it and the hook passes everything through untouched; a pointer press on a
 * parked field also goes straight to typing, so a mouse on the TV build behaves
 * the way a mouse should.
 *
 * `<Field>` owns this for Field-based inputs. The hook remains for raw
 * `<input>`s that are styled per screen — spread `props` and they obey the rule.
 */
import { useCallback, useRef, useState } from 'react';
import { useShape } from './formFactor.ts';

/**
 * Is this the keyboard's action key — Next, Done, Go, Search — rather than a
 * key the input method is keeping for itself?
 *
 * Exported because the sign-in form needs the same answer, and two copies of
 * this test is how one of them ended up guarding on `isComposing`.
 */
export function isActionKey(e: { key: string; nativeEvent: { keyCode?: number } }): boolean {
  return e.key === 'Enter' && e.nativeEvent.keyCode !== 229;
}

export interface OkToType {
  /** Spread onto the `<input>`. */
  props: {
    readOnly?: boolean;
    'data-ok-to-type'?: 'idle' | 'typing';
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => void;
  };
  /** True while the field is really editable. */
  typing: boolean;
  /** Park it — for a caller that submits and wants the keyboard gone. */
  park: () => void;
  /**
   * Start typing in this field and raise the keyboard on it, from code.
   *
   * For a form whose keyboard action is "next": the username's Next has to land
   * the viewer IN the password field with the keyboard up, not on a parked field
   * that needs another OK. Must be called from inside a key or pointer handler —
   * Android only raises a keyboard for a focus the viewer caused.
   */
  begin: (field: HTMLInputElement | null) => void;
}

export function useOkToType(own: {
  /** The field's own key handler. Runs only while it is really being typed in. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
} = {}): OkToType {
  const shape = useShape();
  /* `remote` is the honest question: a television with a mouse plugged in is
     still a television, but it is the D-pad that this rule exists for. */
  const remote = shape.remote;
  const [typing, setTyping] = useState(false);
  const el = useRef<HTMLInputElement | null>(null);
  /**
   * The blur this hook causes itself, which must not park the field.
   *
   * Measured the moment this was first probed: OK set `typing`, the round trip
   * below blurred the field to raise the keyboard, `onBlur` parked it again, and
   * the field was read-only before the viewer could type a character.
   */
  const raising = useRef(false);

  const park = useCallback(() => setTyping(false), []);

  /* The caller's handlers, read through a ref: they are rebuilt every render and
     depending on them would rebuild these on every keystroke elsewhere. */
  const ownRef = useRef(own);
  ownRef.current = own;

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!remote) { ownRef.current.onKeyDown?.(e); return; }
    if (!typing) {
      /* OK, or the space bar a keyboard-driven test presses. Not a repeat: a
         held OK is the hold gesture, and it must not start typing four times. */
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      const field = e.currentTarget;
      el.current = field;
      setTyping(true);
      /*
       * Blur and focus again, deliberately.
       *
       * Clearing `readOnly` on a field that already has focus does not raise the
       * IME on Android — the WebView decides that at the moment focus arrives.
       * The round trip is what asks for the keyboard, and it happens exactly
       * once, on the press that meant "I want to type".
       */
      raising.current = true;
      requestAnimationFrame(() => {
        field.blur();
        field.focus();
        /* Cleared a frame later, so the focus event that follows is ours too. */
        requestAnimationFrame(() => { raising.current = false; });
      });
      return;
    }
    /* Typing: the field's own handler gets the key first — a submit on the IME's
       action key, a clear on Escape — and only what it leaves is handled below. */
    ownRef.current.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    /* Typing. Escape parks without leaving the field, so BACK out of a keyboard
       lands the viewer back on the row they were on rather than off the screen.
       Backspace is deliberately NOT here: while typing it deletes a character. */
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setTyping(false);
      return;
    }
    /*
     * The keyboard's own action key — Next, Done, Go, Search — is "I have
     * finished typing here", and a field that nobody gave a handler for used to
     * ignore it completely.
     *
     * Measured on the Google TV emulator: that key reaches the page as a plain
     * Enter keydown on the field. Chromium only advances focus itself when it
     * believes there is a next field, and it never believes that in this
     * WebView — not for our form and not for a bare two-input form injected
     * beside it (the editor flags carry IME_ACTION_NEXT but never
     * IME_FLAG_NAVIGATE_NEXT) — so it falls back to sending Enter. Every search
     * box and filter here passed that Enter to a handler that did not exist, and
     * the keyboard stayed up with no way forward but BACK.
     *
     * On a Fire TV that is the whole report: its keyboard is full screen, so the
     * results, the password field and the Sign in button are all hidden behind
     * the keyboard the viewer cannot get rid of. Parking closes it — measured:
     * making the focused field read-only drops the keyboard and keeps the
     * highlight exactly where it was — which is what Done means on every TV.
     *
     * `isComposing` is NOT the test, and that was measured too: Gboard sends
     * this Enter WHILE the word is still being composed — every username is,
     * since "cbe8a213fe" is one long word to a keyboard — so a composing guard
     * skipped exactly the press it exists for. A key the IME wants for itself
     * arrives as `Process` / keyCode 229; an Enter that says Enter is the action.
     */
    if (isActionKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      setTyping(false);
    }
  }, [remote, typing]);

  const begin = useCallback((field: HTMLInputElement | null) => {
    if (field === null) return;
    if (!remote) { field.focus(); return; }
    el.current = field;
    setTyping(true);
    raising.current = true;
    requestAnimationFrame(() => {
      field.blur();
      field.focus();
      requestAnimationFrame(() => { raising.current = false; });
    });
  }, [remote]);

  const onBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    ownRef.current.onBlur?.(e);
    if (raising.current) return;
    if (remote) setTyping(false);
  }, [remote]);

  const onPointerDown = useCallback(() => {
    /* A pointer press on a parked field is somebody choosing to type in it. */
    if (remote) setTyping(true);
  }, [remote]);

  const parked = remote && !typing;
  return {
    typing: !parked,
    park,
    begin,
    props: {
      ...(parked ? { readOnly: true, 'data-ok-to-type': 'idle' as const } : {}),
      ...(remote && typing ? { 'data-ok-to-type': 'typing' as const } : {}),
      onKeyDown,
      onBlur,
      onPointerDown,
    },
  };
}
