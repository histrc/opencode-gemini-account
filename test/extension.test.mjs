import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ExtensionBridge, extensionToken } from '../src/extension-bridge.mjs';
import { validateSettings } from '../src/settings.mjs';
import { modelCatalog } from '../src/models.mjs';

test('extension bridge authenticates a loopback client and round-trips status and text', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-extension-'));
  const settings = validateSettings({ connectionMode: 'extension', loginTimeoutMs: 5000 }, directory);
  const bridge = new ExtensionBridge(settings, { port: 0 });
  let client;
  try {
    await bridge.start();
    const token = await extensionToken(directory);
    const port = bridge.server.http.address().port;
    assert.equal(bridge.server.http.address().address, '127.0.0.1');
    client = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { origin: `chrome-extension://${'a'.repeat(32)}` });
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    client.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'command') return;
      const result = message.action === 'status' ? { ready: true } : { text: 'OK' };
      client.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result }));
    });
    await bridge.waitLogin('studio');
    assert.equal(await bridge.generate('studio', 'Reply only OK.'), 'OK');
    await assert.rejects(bridge.generate('web', 'x'), /只支持 AI Studio/);
  } finally {
    client?.close();
    await bridge.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('extension mode exposes only the minimal text model and rejects tool mode', () => {
  const settings = validateSettings({ connectionMode: 'extension' });
  assert.equal(settings.connectionMode, 'extension');
  assert.deepEqual(Object.keys(modelCatalog(settings)), ['studio-current']);
  assert.throws(() => validateSettings({ connectionMode: 'extension', experimentalTools: true }));
});

test('extension bridge rejects websites and invalid tokens before WebSocket upgrade', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-extension-deny-'));
  const bridge = new ExtensionBridge(validateSettings({}, directory), { port: 0 });
  try {
    await bridge.start();
    const token = await extensionToken(directory);
    const port = bridge.server.http.address().port;
    for (const [origin, key] of [['https://attacker.example', token], [`chrome-extension://${'a'.repeat(32)}`, 'bad']]) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/?token=${key}`, { origin });
      const error = await new Promise(resolve => { client.once('error', resolve); });
      assert.match(error.message, /401/);
      assert.equal(bridge.socket, null);
    }
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('cancellation cleans pending timers and disconnect fails without resubmission', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-extension-cancel-'));
  const bridge = new ExtensionBridge(validateSettings({ timeoutMs: 3000 }, directory), { port: 0 });
  let client;
  try {
    await bridge.start();
    const port = bridge.server.http.address().port;
    client = new WebSocket(`ws://127.0.0.1:${port}/?token=${await extensionToken(directory)}`, { origin: `chrome-extension://${'b'.repeat(32)}` });
    await new Promise(resolve => client.once('open', resolve));
    const controller = new AbortController();
    const sent = new Promise(resolve => client.once('message', resolve));
    const generation = bridge.generate('studio', 'cancel test', controller.signal);
    const rejected = assert.rejects(generation, /cancelled-test/);
    await sent;
    controller.abort(new Error('cancelled-test'));
    await rejected;
    assert.equal(bridge.pending.size, 0);
    const next = bridge.generate('studio', 'disconnect test');
    const disconnected = assert.rejects(next, e => e.code === 'extension_disconnected');
    await new Promise(resolve => setTimeout(resolve, 20));
    client.terminate();
    await disconnected;
    assert.equal(bridge.pending.size, 0);
  } finally { client?.terminate(); await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});
