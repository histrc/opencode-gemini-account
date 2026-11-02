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

export async function managedFailureMessage(response) {
  const kind = classifyFailure(response.status, await readBoundedJSON(response));
  const detail = kind === 'GOOGLE_PERMISSION_DENIED'
    ? 'Google 拒绝了当前请求（PERMISSION_DENIED）；不能仅据此判断为工具权限。最小工具对照已通过时，请运行原生请求差异诊断'
    : kind === 'AUTHENTICATION_REQUIRED' ? '请检查账号登录状态'
    : kind === 'RATE_LIMITED' ? '请求受到限流，请检查后端状态后稍后重试'
    : '请检查账号和后端状态';
  return `本机模型请求失败（HTTP ${response.status}）；${detail}。插件未自动重发。`;
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

export async function compareNativeRequest(manager, request, onResult = () => {}) {
  const variants = nativeRequestVariants(request);
  const results = [];
  for (const { name, body } of variants) {
    const started = Date.now();
    let row;
    try {
      const response = await manager.fetch('studio', 'https://managed-gemini.invalid/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      });
      row = { variant: name, http: response.status, result: await diagnosticResponse(response) };
    } catch (error) { row = { variant: name, result: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'LOCAL_OR_CONNECTION_ERROR' }; }
    row.elapsedMs = Date.now() - started;
    results.push(row); onResult(row);
    // A passing original means no request difference has been isolated. Otherwise
    // stop at the first accepted variant to avoid unnecessary quota consumption.
    if (row.result === 'ACCEPTED') break;
    if (row.result !== 'GOOGLE_PERMISSION_DENIED') break;
  }
  const accepted = results.find(row => row.result === 'ACCEPTED');
  return { model: request.model, results, conclusion: accepted?.variant === 'original' ? 'ORIGINAL_ACCEPTED_TOOL_LOOP_NOT_TESTED'
    : accepted ? 'ACCEPTED_VARIANT_REQUIRES_CONFIRMATION' : 'NO_ACCEPTED_VARIANT',
    ...(accepted && accepted.variant !== 'original' ? { candidateDifference: accepted.variant } : {}) };
}
