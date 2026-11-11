import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, detect, touchScreenOf, type Env, type FormFactor, type LayoutPref, cannotInstallApk } from './formFactor.ts';

/**
 * The devices this app has to be right about are mostly devices nobody here owns.
 * These are their real reported numbers, so the rules can be exercised without a
 * TV, a foldable or an iPad on the desk.
 */
const UA = {
  chrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile Safari/605.1.15',
  tizen:
    'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36',
  webos:
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 WebAppManager',
  fireTv:
    'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0 Safari/537.36',
  androidTv:
    'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K GB Build/PTT1.220218.005) AppleWebKit/537.36 Chrome/104.0 Safari/537.36',
} as const;

function env(over: Partial<Env>): Env {
  return {
    width: 1440,
    height: 900,
    pointer: 'fine',
    userAgent: UA.chrome,
    pref: 'auto',
    ...over,
  };
}

/**
 * The DETECTED form factor, which is what these rules are about.
 *
 * Not `classify(...).ff`: that is pinned to `tv`. `detect` is the decision; the
 * pin is asserted separately.
 */
const ff = (over: Partial<Env>): FormFactor => {
  const e = env(over);
  return detect(e.width, e.pointer, e.userAgent);
};

test('a desktop browser is a desktop, at any window size above the phone break', () => {
  assert.equal(ff({ width: 1440, height: 900 }), 'desktop');
  assert.equal(ff({ width: 3840, height: 2160 }), 'desktop');
  assert.equal(ff({ width: 1920, height: 1080 }), 'desktop');
});

test('a narrow desktop window gets the phone layout, which is what makes this testable', () => {
  assert.equal(ff({ width: 500, height: 900 }), 'phone');
  assert.equal(ff({ width: 639, height: 900 }), 'phone');
  assert.equal(ff({ width: 640, height: 900 }), 'desktop');
});

test('a phone is a phone and a tablet is a tablet, by input rather than by width', () => {
  assert.equal(ff({ width: 390, height: 844, pointer: 'coarse', userAgent: UA.iphone }), 'phone');
  assert.equal(ff({ width: 768, height: 1024, pointer: 'coarse', userAgent: UA.ipad }), 'tablet');
  assert.equal(ff({ width: 1366, height: 1024, pointer: 'coarse', userAgent: UA.ipad }), 'tablet');
});

test('a touch-screen laptop is a desktop: its PRIMARY pointer is the cursor', () => {
  assert.equal(ff({ width: 1280, height: 800, pointer: 'fine' }), 'desktop');
});

test('every TV family is identified by user agent, whatever it claims about size', () => {
  for (const ua of [UA.tizen, UA.webos, UA.fireTv, UA.androidTv]) {
    assert.equal(ff({ width: 1920, height: 1080, pointer: 'none', userAgent: ua }), 'tv', ua);
    assert.equal(ff({ width: 960, height: 540, pointer: 'none', userAgent: ua }), 'tv', ua);
  }
});

test('an unrecognised set-top box is still a TV: no cursor, on a big screen', () => {
  assert.equal(
    ff({ width: 1920, height: 1080, pointer: 'none', userAgent: 'SomeBoxOS/2.1 (unknown)' }),
    'tv',
  );
  assert.equal(
    ff({ width: 480, height: 800, pointer: 'none', userAgent: 'SomeBoxOS/2.1 (unknown)' }),
    'phone',
  );
});

test('the pin beats the override too, and still reports what was detected', () => {
  const prefs: LayoutPref[] = ['phone', 'tablet', 'desktop', 'tv'];
  for (const pref of prefs) {
    const v = classify(env({ width: 1440, height: 900, pref }));
    assert.equal(v.ff, 'tv', `pref ${pref} must not unpin the layout`);
    assert.equal(v.detected, 'desktop', 'detection is reported unchanged, for the settings panel');
  }
});

test('panes stay on under the TV pin — stacked Live hid the rail and EPG', () => {
  assert.equal(
    classify(env({ width: 960, height: 540, pointer: 'none', userAgent: UA.tizen })).panes,
    true,
  );
  assert.equal(
    classify(env({ width: 1920, height: 1080, pointer: 'none', userAgent: UA.androidTv })).panes,
    true,
  );
  assert.equal(classify(env({ width: 844, height: 390 })).panes, true);
  assert.equal(classify(env({ width: 1280, height: 800 })).panes, true);
});

test('orientation is still measured, because a TV can report a portrait viewport', () => {
  assert.equal(classify(env({ width: 1920, height: 1080 })).orientation, 'landscape');
  assert.equal(classify(env({ width: 1080, height: 1920 })).orientation, 'portrait');
});

test('orientation comes from the measured viewport, so a fold flips it', () => {
  assert.equal(classify(env({ width: 904, height: 2208, pointer: 'coarse' })).orientation, 'portrait');
  assert.equal(classify(env({ width: 2208, height: 904, pointer: 'coarse' })).orientation, 'landscape');
  assert.equal(classify(env({ width: 800, height: 800 })).orientation, 'landscape');
});

test('classify pins the layout to tv, whatever it detected', () => {
  assert.equal(classify(env({ width: 1440, height: 900 })).ff, 'tv');
  assert.equal(classify(env({ width: 390, height: 844, pointer: 'coarse', userAgent: UA.iphone })).ff, 'tv');
  assert.equal(detect(390, 'coarse', UA.iphone), 'phone', 'detection itself is untouched');
});

/*
 * A television that cannot install an Android app should be told so, rather
 * than being handed a file and Android's "problem parsing the package" — which
 * is what a Samsung TU8075 owner saw, twice, and read as a broken download.
 */
test('the televisions that can never install the APK are named', () => {
  const cannot = [
    'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36',
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 WebAppManager',
    'Mozilla/5.0 (Linux; NetCast) AppleWebKit/537.31 (KHTML, like Gecko) Chrome/26 Safari/537.31',
    'Mozilla/5.0 (Linux; VIDAA 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69 Safari/537.36',
    'Roku4640X/DVP-7.70 (297.70E04154A)',
  ];
  for (const ua of cannot) assert.equal(cannotInstallApk(ua), true, ua.slice(0, 40));
});

test('every Android television still gets the download', () => {
  /* Fire TV, Google TV, Bravia and the generic boxes are televisions too, and
     the APK is exactly what they want — so this must not be `TV_UA`. */
  const can = [
    'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K GB) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Android TV',
    'Mozilla/5.0 (Linux; Android 11; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90 Safari/537.36 CrKey/1.54',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  ];
  for (const ua of can) assert.equal(cannotInstallApk(ua), false, ua.slice(0, 40));
});

/* ── phones and tablets: an add-on that must never reach a television ─────── */

const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const BOX = 'Mozilla/5.0 (Linux; Android 11; X96 Max Plus) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';
const hand = { pointer: 'coarse' as const, maxTouchPoints: 5, userAgent: PIXEL, hostTv: null, pref: 'auto' as const };

test('a phone and a tablet held sideways are recognised, by the short side', () => {
  assert.equal(touchScreenOf({ ...hand, width: 844, height: 390 }), 'phone');
  assert.equal(touchScreenOf({ ...hand, width: 667, height: 375 }), 'phone');
  assert.equal(touchScreenOf({ ...hand, width: 1280, height: 800 }), 'tablet');
  assert.equal(touchScreenOf({ ...hand, width: 390, height: 844 }), 'phone');
});

test('every television keeps the television layout', () => {
  /* The set-top box the app is built for: a D-pad, no touch, a plain Android UA. */
  assert.equal(touchScreenOf({ ...hand, userAgent: BOX, pointer: 'none', maxTouchPoints: 0, width: 960, height: 540 }), null);
  /* An air-mouse remote reports a fine pointer. */
  assert.equal(touchScreenOf({ ...hand, userAgent: BOX, pointer: 'fine', maxTouchPoints: 0, width: 960, height: 540 }), null);
  /* A box that fakes a touch screen is still a television when Android says LEANBACK. */
  assert.equal(touchScreenOf({ ...hand, userAgent: BOX, hostTv: true, width: 960, height: 540 }), null);
  /* A television browser by name, whatever it claims about input. */
  assert.equal(touchScreenOf({ ...hand, userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)', width: 1920, height: 1080 }), null);
});

test('a desktop browser keeps the layout it has — a mouse is not a finger', () => {
  assert.equal(touchScreenOf({ ...hand, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', pointer: 'fine', maxTouchPoints: 0, width: 1600, height: 900 }), null);
  /* A touch-screen laptop: fine primary pointer, touch points present — still a desktop. */
  assert.equal(touchScreenOf({ ...hand, pointer: 'fine', maxTouchPoints: 10, width: 1600, height: 900 }), null);
});

test('the viewer can overrule it either way, on this device', () => {
  assert.equal(touchScreenOf({ ...hand, width: 844, height: 390, pref: 'tv' }), null);
  assert.equal(touchScreenOf({ ...hand, userAgent: BOX, pointer: 'none', maxTouchPoints: 0, width: 960, height: 540, pref: 'touch' }), 'phone');
});
