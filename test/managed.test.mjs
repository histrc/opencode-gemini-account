import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { make } from '@opencode/ai';
import { ManagedBackends, studioConnectionError } from '../src/managed-backends.mjs';
import { validateSettings } from '../src/settings.mjs';
import { model, registerManagedTransport } from '../src/managed-runtime.mjs';

test('new installation uses plugin-owned data directories, with no legacy Magpie discovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-empty-'));
  try {
    const manager = new ManagedBackends(validateSettings({}, directory));
    assert.equal(manager.directories.studio, path.join(directory, 'backends', 'studio'));
    assert.equal(manager.directories.web, path.join(directory, 'backends', 'web'));
    assert.deepEqual(await manager.catalog('studio'), {});
    assert.deepEqual(await manager.catalog('web'), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime lease conflict gives actionable guidance without exposing account identifiers', () => {
  const raw = new Error('没有可预热的账户: fixture@example.invalid: WAA runtime 由其他进程占用: 已由另一个 AIStudio2API runtime 使用');
  const error = studioConnectionError(raw);
  assert.equal(error.code, 'STUDIO_ACCOUNT_BUSY');
  assert.match(error.message, /停止旧服务/);
  assert.match(error.message, /无需重复登录/);
  assert.ok(!error.message.includes('fixture@example.invalid'));
  assert.equal(studioConnectionError(error), error);
  const unrelated = new Error('TLS connection failed');
  assert.equal(studioConnectionError(unrelated), unrelated);
});

test('saved unavailable account reconnects without opening a browser or starting another login', async () => {
  const calls = [];
  let conflict = true;
  const manager = new ManagedBackends(validateSettings({}, tmpdir()), {
    accounts: async () => [{ id: 'fixture', state: 'unavailable' }],
    prepareBrowser: async () => assert.fail('saved account must not prepare a login browser'),
    admin: async () => assert.fail('saved account must not log in again'),
  });
  manager.ensure = async (backend, managementOnly = false) => {
    calls.push({ backend, managementOnly });
    if (!managementOnly && conflict) throw new Error('WAA runtime 由其他进程占用');
    return {};
  };
  await assert.rejects(manager.connectStudio(), error => error.code === 'STUDIO_ACCOUNT_BUSY');
  conflict = false;
  await manager.connectStudio();
  assert.deepEqual(calls.map(call => call.managementOnly), [true, false, true, false]);
});

test('missing or expired account still requires login and verifies the saved result', async () => {
  for (const initial of [[], [{ id: 'expired/account', state: 'auth_required' }]]) {
    let accounts = initial, prepared = 0, loginPath;
    const manager = new ManagedBackends(validateSettings({}, tmpdir()), {
      accounts: async () => accounts,
      prepareBrowser: async () => { prepared++; },
      admin: async (_local, method, url) => { assert.equal(method, 'POST'); loginPath = url; accounts = [{ id: 'saved', state: 'ready' }]; },
    });
    manager.ensure = async () => ({});
    manager.proxy = async () => undefined;
    await manager.connectStudio();
    assert.equal(prepared, 1);
    assert.equal(loginPath, initial.length ? '/api/accounts/expired%2Faccount/login' : '/api/accounts');
  }
});

test('managed native protocol delivers incremental text before the SSE body ends', async () => {
  const key = randomUUID();
  const ai = make();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let bodyFinished = false;
  const encode = new TextEncoder();
  const frame = value => encode.encode('data: ' + JSON.stringify(value) + '\n\n');
  const unregister = registerManagedTransport(key, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].content, 'hello');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(frame({ id: 'native', model: 'gemini-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'PART' }, finish_reason: null }] }));
      await gate;
      controller.enqueue(frame({ id: 'native', model: 'gemini-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'IAL' }, finish_reason: 'stop' }] }));
      controller.enqueue(encode.encode('data: [DONE]\n\n'));
      bodyFinished = true; controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const events = [];
    const receiving = (async () => {
      for await (const event of ai.stream({ model: model('gemini-test', { transportKey: key, providerID: 'aistudio-account' }), prompt: 'hello' })) {
        events.push(event);
        if (JSON.stringify(event).includes('PART')) { assert.equal(bodyFinished, false); release(); }
      }
    })();
    const timeout = setTimeout(release, 1000);
    await receiving; clearTimeout(timeout);
    assert.equal(bodyFinished, true);
    assert.ok(events.some(event => JSON.stringify(event).includes('IAL')));
  } finally { release(); unregister(); await ai.dispose(); }
});

test('managed permission errors stay non-retryable and expose no upstream account data', async () => {
  const key = randomUUID();
  const ai = make();
  let calls = 0;
  const unregister = registerManagedTransport(key, async () => {
    calls++;
    return Response.json({ error: { message: 'The caller does not have permission: private@example.invalid Bearer fixture-secret' } }, { status: 403 });
  });
  try {
    await assert.rejects(async () => {
      for await (const _event of ai.stream({ model: model('gemini-test', { transportKey: key, providerID: 'aistudio-account' }), prompt: 'hello' })) {}
    }, error => {
      const text = String(error);
      assert.match(text, /PERMISSION_DENIED/);
      assert.doesNotMatch(text, /private@|fixture-secret/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { unregister(); await ai.dispose(); }
});
