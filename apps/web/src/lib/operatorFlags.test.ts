import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyOperatorConfig, deviceRelayAllowed, readOperatorFlags, resetOperatorFlags,
} from './operatorFlags.ts';

test('the relay is allowed until an operator says otherwise', () => {
  resetOperatorFlags();
  assert.equal(deviceRelayAllowed(), true);
  /* A config body that never arrived, or arrived empty, must not switch it off. */
  applyOperatorConfig(null);
  assert.equal(deviceRelayAllowed(), true);
  applyOperatorConfig({});
  assert.equal(deviceRelayAllowed(), true);
});

test('only a real true switches it off', () => {
  assert.equal(readOperatorFlags({ deviceRelayOff: true }).deviceRelayOff, true);
  /* Strict, because a config document is hand-edited and a stray "false"
     string is truthy. */
  for (const v of ['true', 1, {}, 'false', 0, null, undefined]) {
    assert.equal(readOperatorFlags({ deviceRelayOff: v }).deviceRelayOff, false, JSON.stringify(v));
  }
  assert.equal(readOperatorFlags('not an object').deviceRelayOff, false);
});

test('a saved config reaches the running app', () => {
  resetOperatorFlags();
  applyOperatorConfig({ deviceRelayOff: true });
  assert.equal(deviceRelayAllowed(), false);
  applyOperatorConfig({ deviceRelayOff: false });
  assert.equal(deviceRelayAllowed(), true);
  resetOperatorFlags();
});
