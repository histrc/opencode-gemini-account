import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { serviceEnv } from '../vendor/magpie/lib/studio-native.mjs';

test('backend startup explicitly disables hedge requests despite upstream env migration', () => {
  const env = serviceEnv(tmpdir(), { port: 39999, apiKey: 'fixture', adminUsername: 'fixture', adminPassword: 'fixture' });
  assert.equal(env.FIRST_EVENT_HEDGE, 'off');
  assert.equal(env.UPSTREAM_CHANNELS, 'playground');
});
