import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../src/browser.mjs';
import { validateSettings } from '../src/settings.mjs';

test('failed login navigation keeps the window available without retrying or accepting a session', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-login-'));
  let navigations = 0, front = 0;
  const page = { async goto() { navigations++; throw new Error('network failure'); },
    isClosed: () => false, async bringToFront() { front++; }, url: () => 'chrome-error://chromewebdata/' };
  const context = { setDefaultTimeout() {}, once() {}, async newPage() { return page; }, async close() {} };
  const bridge = new BrowserBridge(validateSettings({ loginTimeoutMs: 50 }, directory), { async launchPersistentContext() { return context; } });
  try {
    assert.equal(await bridge.openLogin('studio'), page);
    assert.equal(navigations, 1); assert.equal(front, 1);
    await assert.rejects(bridge.waitLogin('studio', page), error => error.code === 'login_timeout');
    assert.equal(navigations, 1);
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});
