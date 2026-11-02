// Only fixed classifications leave this module. Never echo upstream bodies:
// they may include prompts, account identifiers, credentials or service URLs.
export async function readBoundedJSON(response, limit = 65536, timeoutMs = 5000) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
    ? 'Google 拒绝了当前请求（PERMISSION_DENIED）；不能仅据此判断为工具权限。请运行工具对照诊断，保留模型 ID 和两组结果'
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
