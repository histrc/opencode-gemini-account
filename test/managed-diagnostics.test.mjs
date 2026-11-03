import test from 'node:test';
import assert from 'node:assert/strict';
import { compareToolRequests, compareNativeRequest, nativeRequestVariants, diagnosticRequest, managedFailureMessage, readBoundedJSON } from '../src/managed-diagnostics.mjs';

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
  const text = await managedFailureMessage(Response.json({ error: { message: 'AI Studio GenerateContent 返回 HTTP 403、协议错误码 7: The caller does not have permission; Bearer secret@example.invalid' } }, { status: 403, headers: { 'X-Gemini-Account-Request-Mode': 'nonstream' } }), { modelID: 'gemini-test' });
  assert.match(text, /PERMISSION_DENIED/);
  assert.match(text, /协议码 7/);
  assert.match(text, /型号 gemini-test/);
  assert.match(text, /实际请求 nonstream/);
  assert.doesNotMatch(text, /请运行|对照诊断/);
  assert.doesNotMatch(text, /Bearer|example/);
  assert.match(await managedFailureMessage(new Response('private raw body', { status: 403 })), /后端未完成当前请求/);
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

const native = () => ({ ...diagnosticRequest('gemini-test', true), stream: true, stream_options: { include_usage: true }, max_completion_tokens: 65536 });
const denied = () => Response.json({ error: { message: 'The caller does not have permission secret@example.invalid' } }, { status: 403 });
const accepted = () => Response.json({ choices: [{ message: { content: 'private response' } }] });

test('native comparisons preserve captured requests and require a repeated paired observation', async () => {
  const original = native(), snapshot = structuredClone(original), calls = [];
  const report = await compareNativeRequest({ fetch: async (_backend, _url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    return [1, 2, 4].includes(calls.length) ? denied() : accepted();
  } }, original);
  assert.deepEqual(original, snapshot);
  assert.equal(calls.length, 5);
  assert.equal(report.conclusion, 'REPEATED_VARIANT_ACCEPTED');
  assert.equal(report.candidateDifference, 'without_output_limit');
  assert.equal(calls[0].stream, true);
  assert.equal(calls[1].stream, false);
  assert.equal(calls[1].stream_options, undefined);
  const { max_completion_tokens, ...withoutLimit } = snapshot;
  assert.deepEqual(calls[2], withoutLimit);
  assert.doesNotMatch(JSON.stringify(report), /private|secret/);
  const variants = nativeRequestVariants(original);
  assert.equal(variants[3].body.tools[0].function.name, original.tools[0].function.name);
  assert.deepEqual(variants[3].body.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.equal(variants[5].body.tools, undefined);
});

test('native diagnostics require a completed SSE response and never execute returned functions', async () => {
  for (const [data, expected] of [
    ['data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"diagnostic_echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', 'ACCEPTED'],
    ['data: {"choices":[{"delta":{"content":"private"},"finish_reason":null}]}\n\n', 'INCOMPLETE_STREAM'],
    ['data: {"error":{"message":"The caller does not have permission private@example.invalid"}}\n\n', 'GOOGLE_PERMISSION_DENIED'],
  ]) {
    let calls = 0;
    const report = await compareNativeRequest({ fetch: async () => {
      calls++;
      return calls > 1 ? accepted() : new Response(new ReadableStream({ start(controller) {
        const bytes = new TextEncoder().encode(data);
        controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    } }, native());
    assert.equal(report.results[0].result, expected);
    assert.equal(calls, expected === 'GOOGLE_PERMISSION_DENIED' ? 3 : 1);
    assert.doesNotMatch(JSON.stringify(report), /private|arguments/);
  }
});

test('intermittent 403s cannot be presented as a streaming workaround', async () => {
  for (const pattern of [[403, 200, 403, 403], [403, 200, 200]]) {
    let calls = 0;
    const report = await compareNativeRequest({ fetch: async (_backend, _url, init) => {
      const status = pattern[calls++];
      assert.ok(status !== undefined, 'must stop when results become unstable');
      if (calls === 2) assert.equal(new Headers(init.headers).get('accept'), 'application/json');
      return status === 403 ? denied() : accepted();
    } }, native(), () => {}, { Accept: 'text/event-stream', 'Content-Type': 'application/json' });
    assert.equal(report.conclusion, 'UNSTABLE_PERMISSION_RESULT');
    assert.equal(report.candidateDifference, undefined);
    assert.equal(calls, pattern.length);
  }
});
