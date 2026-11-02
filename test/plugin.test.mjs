import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as exported from '../index.mjs';
import { validateSettings } from '../src/settings.mjs';
import { preparePrompt, parseReply, backendOf } from '../src/protocol.mjs';
import { hostResolverArgs } from '../src/browser.mjs';

test('plugin registers models and auth using a single module export', async () => {
  assert.deepEqual(Object.keys(exported), ['default']);
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-plugin-registration-'));
  const previous = process.env.GEMINI_ACCOUNT_DATA_DIR;
  process.env.GEMINI_ACCOUNT_DATA_DIR = directory;
  const hooks = await exported.default.server();
  try {
    const config = { provider: { existing: { name: 'preserved' } } };
    await hooks.config(config);
    assert.equal(config.provider.existing.name, 'preserved');
    const provider = config.provider['gemini-account'];
    assert.deepEqual(Object.keys(provider.models), ['studio-current', 'web-current', 'studio-gemini-3.5-flash-lite']);
    assert.equal(provider.models['studio-current'].tool_call, false);
    const disconnected = await provider.options.fetch('https://gemini-account.invalid/v1/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(disconnected.status, 401);
    assert.equal((await disconnected.json()).error.code, 'login_required');
    assert.equal((await hooks.auth.loader(async () => undefined)).fetch, undefined);
    assert.equal(typeof (await hooks.auth.loader(async () => ({ type: 'api', key: 'local-browser-session-v1' }))).fetch, 'function');
    // Some host option merges retain the config fetch. It must recognize auth
    // after loader initialization too (then reject this malformed request).
    const connected = await provider.options.fetch('https://gemini-account.invalid/v1/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(connected.status, 400);
    assert.notEqual((await connected.json()).error.code, 'login_required');
    assert.equal(hooks.auth.methods.length, 2);
  } finally {
    await hooks.dispose();
    if (previous === undefined) delete process.env.GEMINI_ACCOUNT_DATA_DIR;
    else process.env.GEMINI_ACCOUNT_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('settings reject unsafe/mistyped proxy values and support selector overrides', () => {
  for (const raw of [{ experimentalTools: 'true' }, { timeoutMs: -1 }, { browser: 'firefox' }, { proxy: 'http://user:secret@localhost:7890' }, { proxy: 'file:///tmp/a' }, { hostOverrides: { '*.google.com': '1.1.1.1' } }, { hostOverrides: { 'aistudio.google.com': 'not-an-ip' } }, { proxy: 'http://127.0.0.1:7890', hostOverrides: { 'aistudio.google.com': '1.1.1.1' } }, { selectors: { web: { url: ['https://other'] } } }]) {
    assert.throws(() => validateSettings(raw));
  }
  assert.deepEqual(validateSettings({ selectors: { web: { input: ['#new-input'] } } }).sites.web.input, ['#new-input']);
  assert.equal(validateSettings({ proxy: 'http://127.0.0.1:7890' }).proxy, 'http://127.0.0.1:7890');
  const overrides = validateSettings({ hostOverrides: { 'aistudio.google.com': '142.250.23.139' } }).hostOverrides;
  assert.deepEqual(hostResolverArgs(overrides), ['--host-resolver-rules=MAP aistudio.google.com 142.250.23.139']);
});

test('protocol rejects inherited model names, excessive context, and disabled tools', () => {
  for (const name of ['constructor', '__proto__', 'toString', null]) assert.throws(() => backendOf(name));
  assert.throws(() => preparePrompt({ model: 'web-current', messages: [{ role: 'user', content: 'x'.repeat(1000) }] }, validateSettings({ maxPromptChars: 100 })), /字符上限/);
  assert.throws(() => preparePrompt({ model: 'web-tools-experimental', messages: [{ role: 'user', content: 'x' }] }, validateSettings()), /experimentalTools/);
});

test('forced tool and required choice cannot silently become plain text', () => {
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
  const prepared = preparePrompt({ model: 'web-tools-experimental', messages: [{ role: 'user', content: 'test' }], tools, tool_choice: 'required' }, validateSettings({ experimentalTools: true }));
  assert.throws(() => parseReply('{"content":"done","tool_calls":[]}', prepared), /没有调用/);
});
