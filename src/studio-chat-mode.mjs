import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readBoundedJSON } from './managed-diagnostics.mjs';

function mode(value) {
  if (!['stream', 'nonstream'].includes(value)) throw new Error('AI Studio 对话模式必须为 stream 或 nonstream');
  return value;
}

export async function studioChatMode(directory, env = process.env) {
  if (env.GEMINI_ACCOUNT_STUDIO_CHAT_MODE !== undefined) return mode(env.GEMINI_ACCOUNT_STUDIO_CHAT_MODE);
  let config;
  try { config = JSON.parse(await readFile(path.join(directory, 'managed-chat.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 'stream'; throw new Error('本机 AI Studio 对话模式配置无效'); }
  return mode(config?.mode);
}

export async function saveStudioChatMode(directory, value) {
  mode(value);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'managed-chat.json'), JSON.stringify({ mode: value }) + '\n', { mode: 0o600 });
}

export function nonstreamRequest(init) {
  const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
  if (body?.stream !== true) return null;
  body.stream = false;
  delete body.stream_options;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  headers.set('accept', 'application/json');
  return { ...init, headers, body: JSON.stringify(body) };
}

const invalid = () => Response.json({ error: { code: 'invalid_backend_response', message: '非流式兼容模式未收到完整有效的回复；插件未自动重发。' } }, { status: 502 });

export async function completionAsSSE(response, signal) {
  if (signal?.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
  // Error statuses must remain errors, never trigger another generation.
  if (!response.ok) return response;
  signal?.throwIfAborted();
  const body = await readBoundedJSON(response, 16 * 1024 * 1024, 600000, signal);
  signal?.throwIfAborted();
  if (!body || body.error || typeof body.id !== 'string' || !body.id || typeof body.model !== 'string' || !body.model || !Array.isArray(body.choices) || !body.choices.length) return invalid();
  const chunks = [], ends = [];
  for (const [index, choice] of body.choices.entries()) {
    const message = choice?.message;
    if (!message || message.role !== 'assistant' || message.function_call || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) ||
        (message.content != null && typeof message.content !== 'string')) return invalid();
    const delta = { role: 'assistant', content: message.content ?? null };
    for (const field of ['refusal', 'reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details']) {
      if (message[field] !== undefined) delta[field] = message[field];
    }
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) return invalid();
      delta.tool_calls = [];
      for (const [toolIndex, call] of message.tool_calls.entries()) {
        if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') return invalid();
        try { JSON.parse(call.function.arguments); } catch { return invalid(); }
        delta.tool_calls.push({ ...call, index: toolIndex });
      }
    }
    const number = choice.index ?? index;
    if (!Number.isInteger(number) || number < 0 || (choice.finish_reason === 'tool_calls' && !delta.tool_calls?.length)) return invalid();
    chunks.push({ index: number, delta, finish_reason: null });
    ends.push({ index: number, delta: {}, finish_reason: choice.finish_reason });
  }
  const base = { id: body.id, model: body.model, object: 'chat.completion.chunk', ...(typeof body.created === 'number' ? { created: body.created } : {}) };
  const frame = data => 'data: ' + JSON.stringify(data) + '\n\n';
  // These are completed-response frames, not incremental model tokens. Forward
  // real usage only; IDs and provider tool metadata survive subsequent turns.
  return new Response(frame({ ...base, choices: chunks }) + frame({ ...base, choices: ends, ...(body.usage ? { usage: body.usage } : {}) }) + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Gemini-Account-Chat-Mode': 'nonstream' },
  });
}
