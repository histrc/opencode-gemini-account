import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { make, isRetryable } from '@opencode/ai';
import { model, registerTransport } from '../src/runtime-v2.mjs';
import { createTransport } from '../src/transport.mjs';
import { validateSettings } from '../src/settings.mjs';
import { BridgeError } from '../src/errors.mjs';

async function withRoute(bridge, settings, auth, check) {
  const transportKey = randomUUID();
  const unregister = registerTransport(transportKey, createTransport(bridge, settings, async () => auth));
  const ai = make();
  try { await check(ai, id => model(id, { transportKey }), unregister); }
  finally { unregister(); await ai.dispose(); }
}
const connected = { type: 'api', key: 'local-browser-session-v1' };

test('OpenCode 2 native protocol returns text and never invokes the HTTP executor', async () => {
  let calls = 0;
  await withRoute({ async generate(backend, prompt) {
    calls++; assert.equal(backend, 'web'); assert.match(prompt, /hello/); return 'V2_OK';
  } }, validateSettings(), connected, async (ai, route, unregister) => {
    const result = await ai.generate({ model: route('web-current'), prompt: 'hello' });
    assert.equal(result.message.content[0].text, 'V2_OK');
    assert.equal(result.usage, undefined);
    assert.equal(calls, 1);
    unregister();
    await assert.rejects(ai.generate({ model: route('web-current'), prompt: 'hello' }), /插件已卸载/);
    assert.equal(calls, 1);
  });
});

test('OpenCode 2 native route rejects missing login and fails uncertain submissions without retries', async () => {
  let calls = 0;
  const bridge = { async generate() { calls++; throw new BridgeError('生成中断', 502, 'generation_interrupted'); } };
  await withRoute(bridge, validateSettings(), undefined, async (ai, route) => {
    await assert.rejects(ai.generate({ model: route('web-current'), prompt: 'hello' }), /login_required/);
    assert.equal(calls, 0);
  });
  await withRoute(bridge, validateSettings(), connected, async (ai, route) => {
    await assert.rejects(ai.generate({ model: route('web-current'), prompt: 'hello' }), error => {
      assert.match(error.message, /generation_interrupted/);
      assert.equal(isRetryable(error), false); return true;
    });
    assert.equal(calls, 1);
  });
});

test('OpenCode 2 native route round-trips declared tool calls', async () => {
  await withRoute({ async generate() { return JSON.stringify({ content: null, tool_calls: [{ name: 'read', arguments: { path: 'calculator.cjs' } }] }); } },
    validateSettings({ experimentalTools: true }), connected, async (ai, route) => {
      const result = await ai.generate({ model: route('web-tools-experimental'), prompt: 'Read calculator.cjs',
        tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] });
      const call = result.message.content.find(part => part.type === 'tool-call');
      assert.equal(call.name, 'read');
      assert.deepEqual(call.input, { path: 'calculator.cjs' });
    });
});
