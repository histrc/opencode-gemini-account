import test from 'node:test';
import assert from 'node:assert/strict';
import { compareToolRequests, diagnosticRequest, managedFailureMessage, readBoundedJSON } from '../src/managed-diagnostics.mjs';

test('diagnostic changes only the tool declaration, sends once per case, and does not echo private bodies', async () => {
  const calls = [];
  const manager = { async fetch(_backend, _url, init) {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? Response.json({ choices: [{ message: { content: 'private output' } }] })
      : Response.json({ error: { message: 'AI Studio GenerateContent 返回 HTTP 403、协议错误码 7: The caller does not have permission; secret@example.invalid Bearer private-key' } }, { status: 403 });
  } };
  const report = await compareToolRequests(manager, 'gemini-test');
  assert.equal(calls.length, 2);
  const { tools, ...withoutTools } = calls[1];
  assert.deepEqual(withoutTools, calls[0]);
  assert.equal(tools[0].function.name, 'diagnostic_echo');
  assert.equal(report.conclusion, 'TOOLS_REQUEST_REJECTED');
  assert.doesNotMatch(JSON.stringify(report), /private|secret|Bearer/);
});

test('other 403s are not labelled as Google tool permissions and accepted requests do not claim a tool loop', async () => {
  for (const [response, conclusion, result] of [
    [() => Response.json({ error: { message: 'local key refused secret@example.invalid' } }, { status: 403 }), 'INCONCLUSIVE', 'HTTP_ERROR'],
    [() => Response.json({ choices: [{ message: { content: 'OK' } }] }), 'DECLARATIONS_ACCEPTED_TOOL_LOOP_NOT_TESTED', 'ACCEPTED'],
    [() => Response.json({ error: { message: 'unexpected success error' } }), 'INCONCLUSIVE', 'INVALID_RESPONSE'],
  ]) {
    const report = await compareToolRequests({ fetch: async () => response() }, 'gemini-test');
    assert.equal(report.conclusion, conclusion);
    assert.equal(report.results[1].result, result);
  }
  assert.throws(() => diagnosticRequest('gemini-test?apiKey=secret', true));
});

test('runtime error uses fixed safe guidance without exposing upstream contents', async () => {
  const text = await managedFailureMessage(Response.json({ error: { message: 'The caller does not have permission; Bearer secret@example.invalid' } }, { status: 403 }));
  assert.match(text, /PERMISSION_DENIED/);
  assert.match(text, /不能仅据此判断为工具权限/);
  assert.doesNotMatch(text, /Bearer|example/);
  assert.match(await managedFailureMessage(new Response('private raw body', { status: 403 })), /检查账号和后端状态/);
});

test('error inspection cancels oversized and stalled streams', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } }));
  assert.equal(await readBoundedJSON(response, 20), null);
  assert.equal(cancelled, true);
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  cancelled = false;
  assert.equal(await readBoundedJSON(stalled, 20, 10), null);
  assert.equal(cancelled, true);
});
