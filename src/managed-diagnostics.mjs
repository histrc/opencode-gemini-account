// Only fixed classifications leave this module. Never echo upstream bodies:
// they may include prompts, account identifiers, credentials or service URLs.
async function readBoundedText(response, limit = 65536, timeoutMs = 5000, signal) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let cancelled = false;
  const cancel = () => { cancelled = true; void reader.cancel().catch(() => {}); };
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
    return cancelled ? null : Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function readBoundedJSON(response, limit = 65536, timeoutMs = 5000, signal) {
  try { return JSON.parse(await readBoundedText(response, limit, timeoutMs, signal)); } catch { return null; }
}

export function classifyFailure(status, body) {
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  if (status === 403 && /The caller does not have permission|PERMISSION_DENIED/.test(message)) {
    return 'GOOGLE_PERMISSION_DENIED';
  }
  if (status === 401) return 'AUTHENTICATION_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  return 'HTTP_ERROR';
}

export async function managedFailureMessage(response, context = {}) {
  const body = await readBoundedJSON(response);
  const kind = classifyFailure(response.status, body);
  const raw = typeof body?.error?.message === 'string' ? body.error.message : '';
  const protocol = /协议错误码\s*(\d{1,3})/.exec(raw)?.[1];
  const model = typeof context.modelID === 'string' && /^gemini-[a-zA-Z0-9._-]{1,120}$/.test(context.modelID) ? context.modelID : undefined;
  const mode = response.headers.get('X-Gemini-Account-Request-Mode');
  const facts = [protocol && `协议码 ${Number(protocol)}`, model && `型号 ${model}`, ['stream', 'nonstream'].includes(mode) && `实际请求 ${mode}`].filter(Boolean).join('，');
  const detail = kind === 'GOOGLE_PERMISSION_DENIED'
    ? 'Google 拒绝了当前请求（PERMISSION_DENIED）；账号就绪不代表此请求已获准'
    : kind === 'AUTHENTICATION_REQUIRED' ? '本机接口或账号认证未通过'
    : kind === 'RATE_LIMITED' ? '请求受到限流'
    : '后端未完成当前请求';
  return `本机模型请求失败（HTTP ${response.status}）；${detail}${facts ? `；${facts}` : ''}。插件未自动重发。`;
}

export function diagnosticRequest(model, withTools) {
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error('请提供实际模型 ID，例如 gemini-3.5-flash-lite');
  return {
    model, stream: false, messages: [{ role: 'user', content: 'Reply only OK.' }],
    ...(withTools ? { tools: [{ type: 'function', function: {
      name: 'diagnostic_echo', description: 'Return the supplied text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    } }] } : {}),
  };
}

export async function compareToolRequests(manager, model, onResult = () => {}) {
  const results = [];
  for (const withTools of [false, true]) {
    const started = Date.now();
    let result;
    try {
      const response = await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diagnosticRequest(model, withTools)), signal: AbortSignal.timeout(180000),
      });
      const body = await readBoundedJSON(response, 65536, 180000);
      const valid = response.ok && !body?.error && Array.isArray(body?.choices) && body.choices.length > 0;
      result = { withTools, http: response.status, result: valid ? 'ACCEPTED' : response.ok ? 'INVALID_RESPONSE' : classifyFailure(response.status, body) };
    } catch (error) {
      result = { withTools, result: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'LOCAL_OR_CONNECTION_ERROR' };
    }
    result.elapsedMs = Date.now() - started;
    results.push(result);
    onResult(result);
  }
  const [plain, tools] = results;
  return { model, results, conclusion: plain.result === 'ACCEPTED' && tools.result === 'GOOGLE_PERMISSION_DENIED'
    ? 'TOOLS_REQUEST_REJECTED' : results.every(r => r.result === 'ACCEPTED')
      ? 'DECLARATIONS_ACCEPTED_TOOL_LOOP_NOT_TESTED' : 'INCONCLUSIVE' };
}

export function nativeRequestVariants(request) {
  if (!request || !/^gemini-[a-zA-Z0-9._-]+$/.test(request.model) || !Array.isArray(request.messages) || !Array.isArray(request.tools)) throw new Error('无效的原生诊断请求');
  const make = (name, edit) => { const body = structuredClone(request); edit(body); return { name, body }; };
  return [
    make('original', () => {}),
    make('nonstream', body => { body.stream = false; delete body.stream_options; }),
    make('without_output_limit', body => { delete body.max_completion_tokens; delete body.max_tokens; }),
    make('simple_tool_schemas', body => {
      for (const tool of body.tools) if (tool.type === 'function') tool.function.parameters = { type: 'object', properties: {} };
    }),
    make('short_messages', body => { body.messages = [{ role: 'user', content: 'Reply only OK.' }]; }),
    make('without_tools', body => { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }),
  ];
}

async function diagnosticResponse(response) {
  const text = await readBoundedText(response, 1024 * 1024, 180000);
  if (text === null) return 'RESPONSE_LIMIT_OR_TIMEOUT';
  let body; try { body = JSON.parse(text); } catch {}
  if (!response.ok) return classifyFailure(response.status, body);
  if (body) return !body.error && Array.isArray(body.choices) && body.choices.length ? 'ACCEPTED' : 'INVALID_RESPONSE';
  let choices = false, finished = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { finished = true; continue; }
    let frame; try { frame = JSON.parse(data); } catch { return 'INVALID_RESPONSE'; }
    if (frame.error) return classifyFailure(403, frame) === 'GOOGLE_PERMISSION_DENIED' ? 'GOOGLE_PERMISSION_DENIED' : 'STREAM_ERROR';
    if (Array.isArray(frame.choices) && frame.choices.length) {
      choices = true;
      finished ||= frame.choices.some(choice => choice.finish_reason != null);
    }
  }
  return choices && finished ? 'ACCEPTED' : 'INCOMPLETE_STREAM';
}

export async function compareNativeRequest(manager, request, onResult = () => {}, headers = { 'Content-Type': 'application/json' }) {
  const variants = nativeRequestVariants(request);
  const results = [];
  async function send(name, body) {
    const started = Date.now();
    let row;
    try {
      const requestHeaders = new Headers(headers);
      if (name === 'nonstream' || name === 'nonstream_confirm') requestHeaders.set('accept', 'application/json');
      const response = await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', {
        method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      });
      row = { variant: name, http: response.status, result: await diagnosticResponse(response) };
    } catch (error) { row = { variant: name, result: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'LOCAL_OR_CONNECTION_ERROR' }; }
    row.elapsedMs = Date.now() - started;
    results.push(row); onResult(row);
    return row;
  }
  for (const { name, body } of variants) {
    const row = await send(name, body);
    if (row.result === 'ACCEPTED') {
      if (name === 'original') return { model: request.model, results, conclusion: 'ORIGINAL_ACCEPTED_TOOL_LOOP_NOT_TESTED' };
      // Recheck A then B. A single denied/accepted pair is not enough to ascribe
      // transient Google errors to a changed parameter or recommend a workaround.
      const originalAgain = await send('original_confirm', variants[0].body);
      if (originalAgain.result !== 'GOOGLE_PERMISSION_DENIED') return { model: request.model, results, conclusion: originalAgain.result === 'ACCEPTED' ? 'UNSTABLE_PERMISSION_RESULT' : 'INCONCLUSIVE' };
      const variantAgain = await send(name + '_confirm', body);
      if (variantAgain.result === 'ACCEPTED') return { model: request.model, results, conclusion: 'REPEATED_VARIANT_ACCEPTED', candidateDifference: name };
      return { model: request.model, results, conclusion: variantAgain.result === 'GOOGLE_PERMISSION_DENIED' ? 'UNSTABLE_PERMISSION_RESULT' : 'INCONCLUSIVE' };
    }
    if (row.result !== 'GOOGLE_PERMISSION_DENIED') break;
  }
  return { model: request.model, results, conclusion: 'NO_ACCEPTED_VARIANT' };
}
