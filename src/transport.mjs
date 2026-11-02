import { BridgeError, preparePrompt, parseReply, completion, bufferedSSE } from './protocol.mjs';
import { MAX_REQUEST_BYTES } from './media.mjs';

// This URL is an in-memory SDK routing marker. It is never fetched or resolved.
export const INTERNAL_BASE = 'https://gemini-account.invalid/v1';
export function createTransport(bridge, settings, getAuth) {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    try {
      const url = new URL(request.url);
      if (url.origin !== new URL(INTERNAL_BASE).origin || url.pathname !== '/v1/chat/completions' || request.method !== 'POST') throw new BridgeError('插件只处理内部 chat/completions 请求');
      const auth = await getAuth();
      if (auth?.type !== 'api' || auth.key !== 'local-browser-session-v1') throw new BridgeError('请先在 /connect 连接 Gemini Account', 401, 'login_required');
      if (Number(request.headers.get('content-length') || 0) > MAX_REQUEST_BYTES) throw new BridgeError('请求过大', 413);
      // Bound streamed bodies too. No body text, headers, or cookies are logged.
      let size = 0;
      const chunks = [];
      const reader = request.body?.getReader();
      if (!reader) throw new BridgeError('请求缺少正文');
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_REQUEST_BYTES) throw new BridgeError('请求过大', 413);
          chunks.push(Buffer.from(value));
        }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; }
      finally { reader.releaseLock(); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError('请求不是合法 JSON'); }
      if (size > 2_000_000 && !(Array.isArray(body.messages) && body.messages.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'image_url')))) throw new BridgeError('纯文本请求过大', 413);
      const prepared = preparePrompt(body, settings);
      const reply = await bridge.generate(prepared.backend, prepared.prompt, signal, { upstreamModel: prepared.upstreamModel, images: prepared.images, captureImages: !prepared.usesTools });
      signal.throwIfAborted();
      const replyText = typeof reply === 'string' ? reply : [reply.text, ...(reply.images ?? []).map(im => `![${im.filename}](${im.url})`)].filter(Boolean).join('\n\n');
      const result = completion(body, parseReply(replyText, prepared));
      return body.stream ? bufferedSSE(result) : Response.json(result);
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      const known = e instanceof BridgeError;
      return Response.json({ error: {
        message: known ? e.message : '插件内部错误；请运行 doctor 检查安装',
        type: known ? e.code : 'bridge_error', code: known ? e.code : 'bridge_error',
      // OpenCode has its own session retries outside the SDK. Report transient
      // webpage failures as non-retryable 422, so an uncertain submission is not
      // automatically sent again. The code retains the actionable cause.
      } }, { status: known && e.status < 429 && e.status !== 408 ? e.status : 422 });
    }
  };
}
