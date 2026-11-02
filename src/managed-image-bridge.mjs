import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// OpenCode 2.2.5 checks image models against its bundled class. Use its built-in
// Google image package over this short-lived loopback adapter, keeping the real
// backend credentials inside ManagedBackends. No user configuration is needed.
export async function createManagedImageBridge(manager) {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set(), requests = new Set();
  let closing = false;
  const server = http.createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}` || request.headers.origin || request.method !== 'POST' ||
        !new RegExp(`^/${token}/v1beta/models/gemini-[a-zA-Z0-9._-]+:generateContent$`).test(request.url ?? '')) {
      response.writeHead(404); response.end(); return;
    }
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 40 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const url = 'https://managed-gemini.invalid' + request.url.slice(token.length + 1);
      const result = await manager.fetch('studio', url, { method: 'POST', body: Buffer.concat(chunks), signal: controller.signal });
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (!result.ok) {
        await result.body?.cancel();
        response.end(JSON.stringify({ error: { code: 'managed_image_failed', message: `生图请求失败（HTTP ${result.status}）；请检查账号、型号和图片参数。本轮未自动重新生成。` } }));
        return;
      }
      if (result.body) {
        const body = Readable.fromWeb(result.body);
        body.once('error', () => { controller.abort(); response.destroy(); });
        body.pipe(response);
        await new Promise(resolve => { response.once('finish', resolve); response.once('close', resolve); });
      } else response.end();
    } catch {
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { message: 'AI Studio 生图未完成；请检查账号、型号和图片参数。本轮未自动重新生成。', code: 'managed_image_failed' } }));
      } else response.destroy();
    } finally { clearTimeout(timer); requests.delete(controller); }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/${token}/v1beta`,
    close() {
      if (closing) return;
      closing = true;
      for (const controller of requests) controller.abort();
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
