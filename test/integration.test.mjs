import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText, tool, jsonSchema } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createTransport, INTERNAL_BASE } from '../src/transport.mjs';
import { validateSettings } from '../src/settings.mjs';
import { BridgeError } from '../src/protocol.mjs';

const auth = async () => ({ type: 'api', key: 'local-browser-session-v1' });
function setup(reply, settings = {}) {
  const seen = [];
  const bridge = { async generate(backend, prompt, signal, options = {}) {
    seen.push({ backend, prompt, ...options }); signal?.throwIfAborted();
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(seen.length) : reply;
  } };
  const fetch = createTransport(bridge, validateSettings(settings), auth);
  const provider = createOpenAICompatible({ name: 'gemini-account', baseURL: INTERNAL_BASE, apiKey: 'local', fetch });
  return { provider, fetch, seen };
}

test('actual AI SDK performs text generation through in-process transport', async () => {
  const { provider, seen } = setup('这是测试回复。');
  const result = await generateText({ model: provider('studio-current'), prompt: '你好', maxRetries: 0 });
  assert.equal(result.text, '这是测试回复。');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].backend, 'studio');
  assert.match(seen[0].prompt, /你好/);
  assert.equal(result.finishReason, 'stop');
});

test('SDK routes a configured model ID to its explicit Studio model without fallback', async () => {
  const { provider, seen } = setup('Pinned answer', { studioModels: ['gemini-example'] });
  const result = await generateText({ model: provider('studio-gemini-example'), prompt: 'hello', maxRetries: 0 });
  assert.equal(result.text, 'Pinned answer');
  assert.equal(seen[0].backend, 'studio');
  assert.equal(seen[0].upstreamModel, 'gemini-example');
  await assert.rejects(generateText({ model: provider('studio-gemini-other'), prompt: 'hello', maxRetries: 0 }), /尚未配置/);
  assert.equal(seen.length, 1);
});

test('SDK consumes buffered SSE without claiming token usage', async () => {
  const { provider } = setup('A complete buffered answer');
  const result = streamText({ model: provider('web-current'), prompt: 'test', maxRetries: 0 });
  const chunks = [];
  for await (const part of result.textStream) chunks.push(part);
  assert.equal(chunks.join(''), 'A complete buffered answer');
  assert.equal(await result.finishReason, 'stop');
  assert.equal((await result.usage).totalTokens, undefined);
});

const lookup = tool({
  description: 'Read a sample value',
  inputSchema: jsonSchema({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }),
});

test('SDK parses a streamed tool call; tool results survive the following turn', async () => {
  const { provider, seen } = setup(n => n === 1
    ? '{"content":null,"tool_calls":[{"name":"lookup","arguments":{"name":"motor"}}]}'
    : '{"content":"The value is 42","tool_calls":[]}', { experimentalTools: true });
  const first = streamText({ model: provider('studio-tools-experimental'), prompt: 'look up motor', tools: { lookup }, maxRetries: 0 });
  const calls = await first.toolCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'lookup');
  assert.deepEqual(calls[0].input, { name: 'motor' });
  assert.equal(await first.finishReason, 'tool-calls');
  const second = await generateText({
    model: provider('studio-tools-experimental'), tools: { lookup }, maxRetries: 0,
    messages: [
      { role: 'user', content: 'look up motor' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: calls[0].toolCallId, toolName: 'lookup', input: calls[0].input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: calls[0].toolCallId, toolName: 'lookup', output: { type: 'text', value: '42' } }] },
    ],
  });
  assert.equal(second.text, 'The value is 42');
  assert.match(seen[1].prompt, /tool_call_id/);
  assert.match(seen[1].prompt, /42/);
});

test('invalid tool output fails before any client tool can execute', async () => {
  for (const reply of [
    '{"content":null,"tool_calls":[{"name":"shell","arguments":{}}]}',
    '{"content":null,"tool_calls":[{"name":"lookup","arguments":{"name":123}}]}',
    'Here is some text instead of JSON',
  ]) {
    const { provider, seen } = setup(reply, { experimentalTools: true });
    await assert.rejects(generateText({ model: provider('web-tools-experimental'), prompt: 'test', tools: { lookup }, maxRetries: 0 }), /工具|JSON/);
    assert.equal(seen.length, 1);
  }
});

test('OpenCode 2020-12 tool schemas compile and enforce unevaluatedProperties', async () => {
  const read = tool({ inputSchema: jsonSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', properties: { filePath: { type: 'string' } },
    required: ['filePath'], unevaluatedProperties: false,
  }) });
  const valid = setup('{"content":null,"tool_calls":[{"name":"read","arguments":{"filePath":"fixture.txt"}}]}', { experimentalTools: true });
  const result = await generateText({ model: valid.provider('web-tools-experimental'), prompt: 'read fixture', tools: { read }, maxRetries: 0 });
  assert.equal(result.toolCalls[0].input.filePath, 'fixture.txt');
  const invalid = setup('{"content":null,"tool_calls":[{"name":"read","arguments":{"filePath":"fixture.txt","extra":true}}]}', { experimentalTools: true });
  await assert.rejects(generateText({ model: invalid.provider('web-tools-experimental'), prompt: 'read fixture', tools: { read }, maxRetries: 0 }), /参数未通过/);
});

test('transient webpage failure is non-retryable even with SDK default retries', async () => {
  for (const failure of [
    new BridgeError('网页生成请求中断；插件未自动重试', 502, 'generation_interrupted'),
    new BridgeError('等待前一轮超时，本轮尚未发送', 408, 'queue_timeout'),
  ]) {
    const { provider, seen } = setup(failure);
    await assert.rejects(generateText({ model: provider('web-current'), prompt: 'test' }), error => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.isRetryable, false);
      assert.doesNotMatch(error.responseBody, /429|500|502|503|504|network[-_\s]error|rate_limit/i);
      return true;
    });
    assert.equal(seen.length, 1);
  }
});

test('transport rejects wrong routes, missing auth, huge bodies, and multimodal requests before generation', async () => {
  const { fetch, seen } = setup('unused');
  const request = body => ({ method: 'POST', body: JSON.stringify(body) });
  assert.equal((await fetch('https://example.com/v1/chat/completions', request({}))).status, 400);
  assert.equal((await createTransport({}, validateSettings(), async () => undefined)(INTERNAL_BASE + '/chat/completions', request({}))).status, 401);
  assert.equal((await fetch(INTERNAL_BASE + '/chat/completions', request({ model: 'web-current', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image' } }] }] }))).status, 400);
  assert.equal((await fetch(INTERNAL_BASE + '/chat/completions', request({ data: 'a'.repeat(2_000_001) }))).status, 413);
  assert.equal(seen.length, 0);
});

test('caller cancellation propagates and does not return a fabricated completion', async () => {
  const { fetch, seen } = setup('unused');
  const controller = new AbortController(); controller.abort(new Error('user-cancelled'));
  await assert.rejects(fetch(INTERNAL_BASE + '/chat/completions', { method: 'POST', body: '{}', signal: controller.signal }), /user-cancelled/);
  assert.equal(seen.length, 0);
});
