import test from 'node:test';
import assert from 'node:assert/strict';
import { waitStudioReady } from '../scripts/wait-studio-ready.mjs';

test('readiness wait does not treat a responding or occupied launching backend as generation-ready', async () => {
  let clock = 0, calls = 0;
  const progress = [];
  const manager = { status: async () => ++calls < 3 ? { status: 'running', state: 'LAUNCHING', accounts: { ready: 0, busy: 1 } } : { status: 'running', state: 'RUNNING', accounts: { ready: 1, busy: 0 } } };
  assert.equal(await waitStudioReady(manager, { now: () => clock, sleep: async ms => { clock += ms; }, onProgress: row => progress.push(JSON.parse(row)) }), true);
  assert.equal(calls, 3); assert.equal(progress[0].state, 'LAUNCHING'); assert.equal(progress.length, 2);
});

test('readiness wait stops on timeout or authentication failure without starting or probing a model', async () => {
  for (const auth of [0, 1]) {
    let clock = 0, calls = 0;
    const manager = { status: async () => { calls++; return { status: 'running', state: 'LAUNCHING', accounts: { ready: 0, busy: 1, auth_required: auth } }; } };
    assert.equal(await waitStudioReady(manager, { timeoutMs: 100, now: () => clock, sleep: async ms => { clock += ms; } }), false);
    assert.equal(calls, auth ? 1 : 2);
  }
});
