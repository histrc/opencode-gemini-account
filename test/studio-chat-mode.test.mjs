import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { make } from '@opencode/ai';
import { studioChatMode, saveStudioChatMode, nonstreamRequest, completionAsSSE } from '../src/studio-chat-mode.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { model, registerManagedTransport } from '../src/managed-runtime.mjs';

const completion = message => Response.json({ id: 'completion-fixture', model: 'gemini-test', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });

test('nonstream mode is explicit, reversible, and independent of proxy configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-mode-'));
  try {
    const proxy = '{"proxy":"http://127.0.0.1:7897","studioIPv4":true}';
    await writeFile(path.join(directory, 'managed-network.json'), proxy);
    assert.equal(await studioChatMode(directory, {}), 'stream');
    await saveStudioChatMode(directory, 'nonstream');
    assert.equal(await studioChatMode(directory, {}), 'nonstream');
    assert.equal(await studioChatMode(directory, { GEMINI_ACCOUNT_STUDIO_CHAT_MODE: 'stream' }), 'stream');
    await saveStudioChatMode(directory, 'stream');
    assert.equal(await studioChatMode(directory, {}), 'stream');
    assert.equal(await readFile(path.join(directory, 'managed-network.json'), 'utf8'), proxy);
    await assert.rejects(saveStudioChatMode(directory, false));
    await writeFile(path.join(directory, 'managed-chat.json'), 'invalid json');
    await assert.rejects(studioChatMode(directory, {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('request conversion changes only streaming fields and preserves native tool history', () => {
  const payload = { model: 'gemini-test', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 65536, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], messages: [{ role: 'tool', tool_call_id: 'call-fixture', content: 'file contents' }] };
  const init = { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } };
  const converted = nonstreamRequest(init);
  const body = JSON.parse(converted.body);
  const { stream_options, ...expected } = payload;
  assert.deepEqual(body, { ...expected, stream: false });
  assert.equal(converted.headers.has('content-length'), false);
  assert.equal(converted.headers.get('accept'), 'application/json');
  assert.equal(JSON.parse(init.body).stream, true);
  assert.equal(nonstreamRequest({ body: JSON.stringify({ stream: false }) }), null);
});

test('native SDK decodes buffered text and tool IDs, arguments and Google signatures', async () => {
  const ai = make(), key = randomUUID();
  let calls = 0;
  const unregister = registerManagedTransport(key, async () => {
    calls++;
    return completionAsSSE(calls === 1 ? completion({ content: 'BUFFERED_TEXT' }) : completion({ content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.cjs"}' }, extra_content: { google: { thought_signature: 'fixture-signature' } } }] }));
  });
  try {
    const route = model('gemini-test', { transportKey: key, providerID: 'aistudio-account' });
    const text = await ai.generate({ model: route, prompt: 'hello' });
    assert.equal(text.message.content[0].text, 'BUFFERED_TEXT');
    assert.equal(text.usage, undefined);
    const result = await ai.generate({ model: route, prompt: 'Read fixture.cjs', tools: [{ name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
    const call = result.message.content.find(part => part.type === 'tool-call');
    assert.equal(call.id, 'call-fixture');
    assert.equal(call.name, 'read');
    assert.deepEqual(call.input, { path: 'fixture.cjs' });
    assert.equal(call.providerMetadata['aistudio-account'].extraContent.google.thought_signature, 'fixture-signature');
    assert.equal(calls, 2);
  } finally { unregister(); await ai.dispose(); }
});

test('manager uses one nonstream generation only when Studio compatibility mode is selected', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-managed-mode-'));
  let calls = 0;
  const manager = new ManagedBackends({ directory }, { forward: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).stream, calls === 1);
    return calls === 1 ? new Response('original SSE') : completion({ content: 'OK' });
  } });
  manager.ensure = async () => ({ baseURL: 'http://127.0.0.1:39999/v1', apiKey: 'fixture' });
  const init = { method: 'POST', body: JSON.stringify({ model: 'gemini-test', stream: true, messages: [] }) };
  try {
    assert.equal(await (await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', init)).text(), 'original SSE');
    await saveStudioChatMode(directory, 'nonstream');
    const response = await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', init);
    assert.equal(response.headers.get('X-Gemini-Account-Chat-Mode'), 'nonstream');
    assert.equal(response.headers.get('X-Gemini-Account-Request-Mode'), 'nonstream');
    assert.match(await response.text(), /OK/);
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('errors and malformed completions never become executable tools or trigger a retry', async () => {
  const denied = Response.json({ error: { message: 'The caller does not have permission' } }, { status: 403 });
  assert.equal(await completionAsSSE(denied), denied);
  for (const response of [new Response('not json'), completion({ content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'read', arguments: 'bad json' } }] }), Response.json({ id: 'fixture', model: 'gemini-test', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'network_error' }] })]) {
    const output = await completionAsSSE(response);
    assert.equal(output.status, 502);
    assert.doesNotMatch(await output.text(), /bad json|not json|call-fixture/);
  }
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = completionAsSSE(response, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('diagnostic sender can preserve stream fields despite a saved nonstream setting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'diagnostic-mode-'));
  try {
    await saveStudioChatMode(directory, 'nonstream');
    const manager = new ManagedBackends({ directory }, { chatMode: async () => 'stream', forward: async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response('original stream');
    } });
    manager.ensure = async () => ({ baseURL: 'http://127.0.0.1:39999/v1', apiKey: 'fixture' });
    const response = await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gemini-test', stream: true, messages: [] }) });
    assert.equal(response.headers.get('X-Gemini-Account-Request-Mode'), 'stream');
    assert.equal(await response.text(), 'original stream');
    assert.equal(await studioChatMode(directory, {}), 'nonstream');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
