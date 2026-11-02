import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtensionBridge } from '../../src/extension-bridge.mjs';
import { validateSettings } from '../../src/settings.mjs';
import { extensionBrowser } from '../fixtures/extension-browser.mjs';

test('production extension worker + content + loopback: fresh tab, complete text, code fences and scoped cancellation', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'extension-browser-'));
  const bridge = new ExtensionBridge(validateSettings({ connectionMode: 'extension', timeoutMs: 15000, loginTimeoutMs: 10000 }, directory), { port: 0 });
  let fixture;
  try {
    await bridge.start();
    fixture = await extensionBrowser({ directory, port: bridge.server.http.address().port });
    await bridge.waitLogin('studio');
    const text = await bridge.generate('studio', 'Reply with OK and code.');
    assert.equal(text, 'OK\n\n```js\nconst value = 1;\n```');
    assert.equal(fixture.observed.submissions, 1);
    assert.equal(await fixture.pages.get(fixture.homeID).locator('textarea').inputValue(), '');
    const controller = new AbortController();
    const pending = bridge.generate('studio', 'cancel me', controller.signal);
    const rejected = assert.rejects(pending, /test-cancel/);
    while (fixture.observed.submissions < 2) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort(new Error('test-cancel'));
    await rejected;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fixture.observed.closed.includes(fixture.homeID), false);
    assert.equal(fixture.observed.closed.length, 1);
    assert.equal(fixture.pages.get(fixture.homeID).isClosed(), false);
  } finally { await fixture?.close(); await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('extension refuses text completion without an observed generation state', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'extension-unconfirmed-'));
  const bridge = new ExtensionBridge(validateSettings({ connectionMode: 'extension', timeoutMs: 2500 }, directory), { port: 0 });
  let fixture;
  try {
    await bridge.start();
    fixture = await extensionBrowser({ directory, port: bridge.server.http.address().port, scenario: 'unconfirmed' });
    await assert.rejects(bridge.generate('studio', 'Must not return partial text.'));
    assert.equal(fixture.observed.submissions, 1);
  } finally { await fixture?.close(); await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});
