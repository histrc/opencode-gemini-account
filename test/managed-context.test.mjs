import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { compactManagedPayload, compactManagedRequest, validateManagedContext } from '../src/managed-context.mjs';

const settings = validateManagedContext({ enabled: true, triggerMessages: 20, keepRecentMessages: 10, summaryMaxChars: 4000, messageExcerptChars: 200, toolDescriptionMaxChars: 100, schemaDescriptionMaxChars: 50 });

test('managed context compacts old turns and keeps the recent tool chain intact', () => {
  const messages = [{ role: 'system', content: 'KEEP SYSTEM' }];
  for (let i = 0; i < 24; i++) messages.push({ role: 'user', content: `request ${i} ` + 'x'.repeat(300) }, { role: 'assistant', content: `answer ${i}` });
  messages.push({ role: 'user', content: 'recent task' });
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.c"}' } }] });
  messages.push({ role: 'tool', tool_call_id: 'call-1', content: 'recent file contents' });
  const result = compactManagedPayload({ messages }, settings);
  assert.equal(result.changed, true);
  assert.equal(result.body.messages[0].content, 'KEEP SYSTEM');
  assert.match(result.body.messages[1].content, /本地确定性压缩/);
  assert.deepEqual(result.body.messages.slice(-3), messages.slice(-3));
  assert.ok(result.body.messages.length < messages.length);
});

test('managed context shortens descriptions without changing tool schemas', () => {
  const tool = { type: 'function', function: { name: 'read', description: 'a'.repeat(500), parameters: { type: 'object', properties: { path: { type: 'string', description: 'b'.repeat(200) } }, required: ['path'] } } };
  const result = compactManagedPayload({ messages: [{ role: 'user', content: 'hello' }], tools: [tool] }, settings);
  assert.equal(result.body.tools[0].function.name, 'read');
  assert.deepEqual(result.body.tools[0].function.parameters.required, ['path']);
  assert.ok(result.body.tools[0].function.description.length < 200);
  assert.ok(result.body.tools[0].function.parameters.properties.path.description.length < 120);
});

test('managed context stays disabled unless explicitly enabled', () => {
  const body = { messages: Array.from({ length: 130 }, () => ({ role: 'user', content: 'x' })) };
  assert.equal(compactManagedPayload(body, validateManagedContext()).body, body);
});

test('managed context refuses an unsafe boundary without a recent user turn', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'tool' : 'assistant', content: 'x' }));
  assert.equal(compactManagedPayload({ messages }, settings).body.messages, messages);
});

test('managed request removes a stale content length after rewriting the body', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-context-'));
  try {
    await writeFile(path.join(directory, 'managed-context.json'), JSON.stringify({ ...settings, enabled: true }));
    const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
    const result = await compactManagedRequest({ method: 'POST', headers: { 'content-length': '99999' }, body: JSON.stringify({ messages }) }, directory);
    assert.equal(result.headers.has('content-length'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

