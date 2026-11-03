import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyStudioProxy } from '../scripts/apply-studio-proxy.mjs';

test('proxy application stops only the owned backend before saving, preserves settings and verifies active proxy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'apply-studio-proxy-'));
  const dataDir = path.join(directory, 'backends', 'studio');
  const calls = [];
  const manager = { settings: { directory }, directories: { studio: dataDir },
    status: async () => ({ status: 'running', state: 'LAUNCHING', accounts: { busy: 0 }, chatMode: 'nonstream' }),
    ensure: async (backend, managementOnly) => {
      calls.push('start'); assert.equal(backend, 'studio');
      assert.equal(managementOnly, true);
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'managed-network.json'), 'utf8')), { proxy: 'http://127.0.0.1:7897', studioIPv4: false, custom: 'preserved' });
      return {};
    } };
  const original = '{"proxy":"http://127.0.0.1:7890","studioIPv4":false,"custom":"preserved"}';
  try {
    await mkdir(dataDir, { recursive: true }); await writeFile(path.join(dataDir, 'account-fixture'), 'preserved');
    await writeFile(path.join(directory, 'managed-network.json'), original);
    const result = await applyStudioProxy(manager, 'http://127.0.0.1:7897', {
      probe: async () => calls.push('probe'), stop: async options => { calls.push('stop'); assert.equal(options.dataDir, dataDir); assert.equal(await readFile(path.join(directory, 'managed-network.json'), 'utf8'), original); return { stopped: true }; },
      resolveProxy: async (_dir, _data, proxy) => proxy,
      admin: async (_local, method, url) => { assert.equal(method, 'GET'); assert.equal(url, '/api/config'); return { active_proxy: 'http://127.0.0.1:7897' }; },
    });
    assert.equal(result.proxyApplied, true); assert.deepEqual(calls, ['probe', 'stop', 'start']);
    assert.equal(result.generationReady, false);
    assert.equal(await readFile(path.join(dataDir, 'account-fixture'), 'utf8'), 'preserved');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('busy or unverified backends and failed stops cannot change proxy configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reject-studio-proxy-'));
  try {
    const file = path.join(directory, 'managed-network.json'), original = '{"proxy":"http://127.0.0.1:7890"}';
    await writeFile(file, original);
    for (const [status, busy, stops] of [['running', 1, false], ['foreign', 0, false], ['running', 0, true]]) {
      let stopCalled = false;
      const manager = { settings: { directory }, directories: { studio: directory }, status: async () => ({ status, accounts: { busy } }), ensure: () => assert.fail('must not restart') };
      await assert.rejects(applyStudioProxy(manager, 'http://127.0.0.1:7897', { probe: async () => {}, stop: async () => { stopCalled = true; return { stopped: false }; } }));
      assert.equal(stopCalled, stops); assert.equal(await readFile(file, 'utf8'), original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
