import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LABEL, COLOUR_INTENTS, REMOTE_BUTTON, SHORTCUT_GROUPS,
  digitOf, intentFor, intentForAndroidCode, intentForTizenCode, keyIsTextInput, keysFor,
} from './remoteKeys.ts';

test('keyboard shortcuts keep working', () => {
  assert.equal(intentFor(' '), 'playPause');
  assert.equal(intentFor('K'), 'playPause', 'case does not matter');
  assert.equal(intentFor('f'), 'fullscreen');
  assert.equal(intentFor('c'), 'subtitles');
  assert.equal(intentFor('q'), null, 'an unmapped key means nothing');
});

test('a TV remote reaches the same intents', () => {
  assert.equal(intentFor('MediaPlayPause'), 'playPause');
  assert.equal(intentFor('ChannelUp'), 'channelUp');
  assert.equal(intentFor('MediaFastForward'), 'forward');
  assert.equal(intentFor('Subtitle'), 'subtitles');
  assert.equal(intentFor('Info'), 'info');
});

test('both spellings of the track keys are in the wild', () => {
  // Chromium emits one, some Android TV builds emit the other. Neither is wrong.
  assert.equal(intentFor('MediaTrackNext'), 'nextTrack');
  assert.equal(intentFor('MediaNextTrack'), 'nextTrack');
  assert.equal(intentFor('MediaTrackPrevious'), 'prevTrack');
  assert.equal(intentFor('MediaPreviousTrack'), 'prevTrack');
});

test('digits are channel numbers, and carry their value', () => {
  const i = intentFor('7');
  assert.equal(i, 'digit7');
  assert.equal(digitOf(i), 7);
  assert.equal(digitOf('playPause'), null);
});

test('forwarded Android keycodes land on intents', () => {
  // The buttons a WebView does not translate: this is the whole reason
  // MainActivity forwards raw codes.
  //
  // The second line used to read `174 → guide, 'KEYCODE_GUIDE'` and it PASSED,
  // because the test and the table were written from the same wrong memory. A test
  // that agrees with the code proves only that they agree. The list below is now
  // checked against `javap -constants android.view.KeyEvent` — see the exhaustive
  // test at the bottom of this file.
  assert.equal(intentForAndroidCode(175), 'subtitles', 'KEYCODE_CAPTIONS');
  assert.equal(intentForAndroidCode(174), 'favourite', 'KEYCODE_BOOKMARK');
  assert.equal(intentForAndroidCode(172), 'guide', 'KEYCODE_GUIDE');
  assert.equal(intentForAndroidCode(166), 'channelUp', 'KEYCODE_CHANNEL_UP');
  assert.equal(intentForAndroidCode(4), 'exit', 'KEYCODE_BACK');
  assert.equal(intentForAndroidCode(999), null);
});

test('Android number keys, both banks', () => {
  assert.equal(intentForAndroidCode(7), 'digit0', 'KEYCODE_0');
  assert.equal(intentForAndroidCode(16), 'digit9', 'KEYCODE_9');
  assert.equal(intentForAndroidCode(144), 'digit0', 'KEYCODE_NUMPAD_0');
  assert.equal(intentForAndroidCode(153), 'digit9', 'KEYCODE_NUMPAD_9');
});

/**
 * A Samsung Tizen remote's own keyCodes, the ones a Tizen WebView's `keydown`
 * carries and no bridge translates — see the comment above `BY_TIZEN_CODE` in
 * `remoteKeys.ts` for the two sources these were cross-checked against, and
 * `tizenKeys.test.ts` for the platform-detection and dispatch side of this.
 * This is the one place these numbers are pinned, and neither of us has run
 * them on a real Samsung TV — see that file's report for what is unverified.
 */
test('Tizen keyCodes reach the intents Samsung documents them as', () => {
  assert.equal(intentForTizenCode(10009), 'exit', 'Return/Back — no registerKey needed');
  assert.equal(intentForTizenCode(403), 'red', 'ColorF0Red');
  assert.equal(intentForTizenCode(404), 'green', 'ColorF1Green');
  assert.equal(intentForTizenCode(405), 'yellow', 'ColorF2Yellow');
  assert.equal(intentForTizenCode(406), 'blue', 'ColorF3Blue');
  assert.equal(intentForTizenCode(10252), 'playPause', 'MediaPlayPause');
  assert.equal(intentForTizenCode(415), 'play', 'MediaPlay');
  assert.equal(intentForTizenCode(19), 'pause', 'MediaPause');
  assert.equal(intentForTizenCode(413), 'stop', 'MediaStop');
  assert.equal(intentForTizenCode(417), 'forward', 'MediaFastForward');
  assert.equal(intentForTizenCode(412), 'back', 'MediaRewind');
  assert.equal(intentForTizenCode(427), 'channelUp', 'ChannelUp');
  assert.equal(intentForTizenCode(428), 'channelDown', 'ChannelDown');
  assert.equal(intentForTizenCode(447), 'volumeUp', 'VolumeUp');
  assert.equal(intentForTizenCode(448), 'volumeDown', 'VolumeDown');
  assert.equal(intentForTizenCode(449), 'mute', 'VolumeMute');
  assert.equal(intentForTizenCode(457), 'info', 'Info');
  assert.equal(intentForTizenCode(999999), null, 'an unmapped Tizen code means nothing');
});

test('Tizen digits, by the standard ASCII codes a keyboard also uses', () => {
  assert.equal(intentForTizenCode(48), 'digit0');
  assert.equal(intentForTizenCode(57), 'digit9');
  assert.equal(digitOf(intentForTizenCode(55)!), 7);
});

/**
 * `19` is a collision worth naming out loud: Android's KEYCODE_DPAD_UP is also
 * 19 (see `BY_ANDROID_CODE` above), but Tizen's MEDIA_PAUSE is 19 too — two
 * platforms, two completely different buttons, the same number. This is
 * exactly why `tizenKeys.ts` has its own dispatch path rather than reusing
 * Android's `streamix:remotekey` bridge: feeding a Tizen code through
 * `intentForAndroidCode` would turn Pause into the up arrow.
 */
test('Tizen 19 and Android 19 are different buttons, on purpose', () => {
  assert.equal(intentForTizenCode(19), 'pause');
  assert.equal(intentForAndroidCode(19), 'up');
  assert.notEqual(intentForTizenCode(19), intentForAndroidCode(19));
});

test('a focused text field keeps its own keys and nothing else', () => {
  // The distinction that matters: `c` is a letter being typed, MediaPlayPause
  // never is, so pause still works while the search box has focus.
  assert.equal(keyIsTextInput('c'), true);
  assert.equal(keyIsTextInput('7'), true);
  assert.equal(keyIsTextInput('ArrowLeft'), true);
  assert.equal(keyIsTextInput('Enter'), true);
  assert.equal(keyIsTextInput('MediaPlayPause'), false);
  assert.equal(keyIsTextInput('ChannelUp'), false);
  assert.equal(keyIsTextInput('Subtitle'), false);
});

/**
 * Every Android keycode, against the name of the constant it is.
 *
 * This test exists because three of them were wrong — 172, 174 and 222 — and the
 * shape of the bug is worth remembering: `MainActivity` forwards
 * `KeyEvent.KEYCODE_GUIDE`, which the compiler resolves, so the Java side could
 * not be wrong. The numbers exist only on this side, written from memory, each
 * with a confident and incorrect comment beside it. Nothing in the app could
 * surface it and no test covered it, so the guide button changed the aspect ratio
 * on every remote in the world.
 *
 * The values below were read from `javap -constants android.view.KeyEvent` in the
 * installed android-35 platform. Anything added to the table belongs here too.
 */
test('the Android keycodes are the ones Android actually sends', () => {
  const expected: [number, string, string][] = [
    [85, 'MEDIA_PLAY_PAUSE', 'playPause'],
    [126, 'MEDIA_PLAY', 'play'],
    [127, 'MEDIA_PAUSE', 'pause'],
    [86, 'MEDIA_STOP', 'stop'],
    [90, 'MEDIA_FAST_FORWARD', 'forward'],
    [89, 'MEDIA_REWIND', 'back'],
    [87, 'MEDIA_NEXT', 'nextTrack'],
    [88, 'MEDIA_PREVIOUS', 'prevTrack'],
    [272, 'MEDIA_SKIP_FORWARD', 'skipForward'],
    [273, 'MEDIA_SKIP_BACKWARD', 'skipBackward'],
    [166, 'CHANNEL_UP', 'channelUp'],
    [167, 'CHANNEL_DOWN', 'channelDown'],
    [229, 'LAST_CHANNEL', 'lastChannel'],
    [175, 'CAPTIONS', 'subtitles'],
    [233, 'TV_TELETEXT', 'subtitles'],
    [222, 'MEDIA_AUDIO_TRACK', 'audioTrack'],
    [172, 'GUIDE', 'guide'],
    [165, 'INFO', 'info'],
    [84, 'SEARCH', 'search'],
    [82, 'MENU', 'menu'],
    [176, 'SETTINGS', 'settings'],
    [174, 'BOOKMARK', 'favourite'],
    [173, 'DVR', 'catchup'],
    [170, 'TV', 'live'],
    [255, 'TV_ZOOM_MODE', 'aspect'],
    [171, 'WINDOW', 'pip'],
    [183, 'PROG_RED', 'red'],
    [184, 'PROG_GREEN', 'green'],
    [185, 'PROG_YELLOW', 'yellow'],
    [186, 'PROG_BLUE', 'blue'],
    [4, 'BACK', 'exit'],
    [23, 'DPAD_CENTER', 'select'],
    [19, 'DPAD_UP', 'up'],
    [20, 'DPAD_DOWN', 'down'],
  ];
  for (const [code, constant, intent] of expected) {
    assert.equal(intentForAndroidCode(code), intent, `KEYCODE_${constant} (${code})`);
  }
});

/**
 * `back` is REWIND, and BACK is `exit`. They are two buttons and one word.
 *
 * The player binds `back` to "earlier": thirty seconds on a film, and on a live
 * channel — which has nowhere earlier to go — the PREVIOUS CHANNEL
 * (`VideoPlayer.act`, case 'back' → `onPrev`). So anything that lands the back
 * BUTTON on the `back` intent turns leaving a screen into changing channel, which
 * is a report this app has already had once ("when you go back instead of going
 * back it goes to another channel"; the cause that time was a race in Live's
 * restore effect, see `liveRestore.ts` — the keymap was measured and was right).
 *
 * Pinned in both directions because the names invite the mistake: a reader who
 * meets `back` next to KEYCODE_BACK will not assume they are different buttons.
 */
test('the back BUTTON leaves; the back INTENT rewinds', () => {
  assert.equal(intentForAndroidCode(4), 'exit', 'KEYCODE_BACK leaves the screen');
  assert.notEqual(intentForAndroidCode(4), 'back', 'KEYCODE_BACK is not REWIND');
  assert.notEqual(intentForAndroidCode(4), 'channelDown', 'nor the channel rocker');
  // Chromium hands the WebView's page a back press as this key name; Escape is
  // the desktop spelling of the same question. Both mean leave, neither rewinds.
  assert.equal(intentFor('BrowserBack'), 'exit');
  assert.equal(intentFor('Escape'), 'exit');
  assert.equal(intentFor('Backspace'), 'exit');
  // And the ones that DO rewind or change channel are the transport buttons,
  // which is the whole distinction.
  assert.equal(intentForAndroidCode(89), 'back', 'KEYCODE_MEDIA_REWIND');
  assert.equal(intentFor('MediaRewind'), 'back');
  assert.equal(intentForAndroidCode(167), 'channelDown', 'KEYCODE_CHANNEL_DOWN');
  assert.equal(intentForAndroidCode(88), 'prevTrack', 'KEYCODE_MEDIA_PREVIOUS');
});

test('the three that were wrong stay fixed', () => {
  // Each of these was mapped to the intent of a DIFFERENT button, so pressing
  // one did something plausible and wrong.
  assert.notEqual(intentForAndroidCode(172), 'aspect', '172 is GUIDE, not TV_ZOOM_MODE');
  assert.notEqual(intentForAndroidCode(174), 'guide', '174 is BOOKMARK, not GUIDE');
  assert.notEqual(intentForAndroidCode(222), 'live', '222 is MEDIA_AUDIO_TRACK, not TV');
});

test('a legend can only advertise a key that is wired', () => {
  // keysFor is derived from the keymap, which is the whole point: the shortcuts
  // sheet and the hint bar cannot name a key that does nothing.
  assert.deepEqual(keysFor('fullscreen'), ['F']);
  assert.ok(keysFor('playPause').includes('Space'));
  assert.ok(keysFor('playPause').includes('K'));
  assert.deepEqual(keysFor('red'), [], 'a coloured button is not on a keyboard');
  // …and the names only a remote has are not offered as key caps.
  assert.ok(!keysFor('subtitles').includes('CAPTIONS'));
  assert.ok(keysFor('subtitles').includes('C'));
});

test('every intent a screen can bind has a name to show', () => {
  for (const group of SHORTCUT_GROUPS) {
    for (const intent of group.intents) {
      assert.ok(ACTION_LABEL[intent] !== undefined, `${intent} has no label`);
    }
  }
  for (const colour of COLOUR_INTENTS) {
    assert.ok(REMOTE_BUTTON[colour] !== undefined, `${colour} has no button name`);
  }
});
