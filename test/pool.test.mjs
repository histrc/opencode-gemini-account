import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireBridge } from '../src/bridge-pool.mjs';
import { validateSettings } from '../src/settings.mjs';

test('projects share a profile owner; only the last disposal closes it', async () => {
  const settings = validateSettings({}, path.join(tmpdir(), randomUUID()));
  let launches = 0, closes = 0;
  const create = () => { launches++; return { async dispose() { closes++; } }; };
  const first = acquireBridge(settings, create);
  const second = acquireBridge(structuredClone(settings), create);
  assert.equal(launches, 1);
  assert.equal(first.bridge, second.bridge);
  await first.release(); await first.release();
  assert.equal(closes, 0);
  assert.throws(() => acquireBridge({ ...settings, timeoutMs: 1234 }, create), e => e.code === 'settings_conflict');
  await second.release();
  assert.equal(closes, 1);
  const third = acquireBridge({ ...settings, timeoutMs: 1234 }, create);
  assert.equal(launches, 2);
  await third.release();
});
