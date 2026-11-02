import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { BridgeError } from './errors.mjs';

export const EXTENSION_PORT = 37654;
const TOKEN_FILE = 'extension-token.txt';

export class ExtensionBridge {
  constructor(settings, options = {}) {
    this.settings = settings;
    this.port = options.port ?? EXTENSION_PORT;
    this.server = null;
    this.socket = null;
    this.starting = null;
    this.pending = new Map();
    this.queues = new Map();
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new BridgeError('扩展桥接已关闭', 503, 'disposed');
    if (this.server) return;
    if (!this.starting) this.starting = this.#start().catch(error => {
      this.starting = null;
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('无法启动本机扩展桥接；请检查端口 37654 是否被占用', 503, 'extension_bridge_failed');
    });
    await this.starting;
  }

  async #start() {
    const token = await extensionToken(this.settings.directory);
    const server = createServer((request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_000_000, perMessageDeflate: false });
    server.on('upgrade', (request, connection, head) => {
      let supplied = '';
      let route;
      try { route = new URL(request.url, 'http://127.0.0.1'); supplied = route.searchParams.get('token') ?? ''; } catch {}
      const origin = request.headers.origin ?? '';
      const host = request.headers.host ?? '';
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || !/^127\.0\.0\.1:\d+$/.test(host) || route?.pathname !== '/' || !safeEqual(token, supplied)) {
        connection.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      if (this.socket?.readyState === 1) {
        connection.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(request, connection, head, socket => sockets.emit('connection', socket));
    });
    sockets.on('connection', socket => {
      this.socket = socket;
      socket.on('message', data => {
        if (this.socket === socket) this.#message(data);
      });
      socket.once('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.#rejectPending(new BridgeError('Edge 扩展连接已中断；本轮未自动重发', 503, 'extension_disconnected'));
      });
      socket.once('error', () => {});
    });
    sockets.on('error', () => {});
    try { await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    }); } catch (error) { sockets.close(); server.close(); throw error; }
    if (this.closed) { sockets.close(); server.close(); throw new BridgeError('扩展桥接已关闭', 503, 'disposed'); }
    this.server = { http: server, sockets };
  }

  #message(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message || message.type !== 'result' || typeof message.id !== 'string') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.cleanup();
    if (message.ok === true && message.result && typeof message.result === 'object' && !Array.isArray(message.result)) entry.resolve(message.result);
    else entry.reject(extensionError(message.code));
  }

  async openLogin(backend) {
    if (backend !== 'studio') throw new BridgeError('扩展模式当前只支持 AI Studio', 422, 'extension_backend_unsupported');
    await this.start();
    return { backend };
  }

  async waitLogin(backend) {
    const deadline = Date.now() + this.settings.loginTimeoutMs;
    while (!this.closed && Date.now() < deadline) {
      try {
        const result = await this.request('status', { backend }, undefined, Math.max(1, deadline - Date.now()));
        if (result.ready === true) return;
      } catch (error) {
        if (!['extension_no_tab', 'extension_page_not_ready', 'extension_disconnected'].includes(error.code)) throw error;
      }
      await delay(500);
    }
    throw new BridgeError('等待扩展页面就绪超时，请在正常 Edge 中打开已登录的 AI Studio', 408, 'extension_page_not_ready');
  }

  async generate(backend, prompt, signal, options = {}) {
    if (backend !== 'studio' || options.upstreamModel || options.images?.length || options.expectImages) {
      throw new BridgeError('扩展模式当前只支持 AI Studio 默认模型的纯文本调用', 422, 'extension_feature_unsupported');
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > this.settings.maxPromptChars) throw new BridgeError('提示词为空或超过本地长度限制');
    const deadline = AbortSignal.timeout(this.settings.timeoutMs);
    const operationSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const previous = this.queues.get(backend) ?? Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => lock);
    this.queues.set(backend, tail);
    try { await waitAbortable(previous.catch(() => {}), operationSignal); }
    catch (error) {
      previous.finally(() => { release(); if (this.queues.get(backend) === tail) this.queues.delete(backend); });
      throw error;
    }
    try {
      operationSignal.throwIfAborted();
      const result = await this.request('generate', { backend, prompt, timeoutMs: this.settings.timeoutMs }, operationSignal, this.settings.timeoutMs);
      if (typeof result.text !== 'string' || !result.text.trim()) throw new BridgeError('AI Studio 页面没有返回可读取的文本', 502, 'extension_empty_reply');
      return result.text;
    } finally {
      release();
      if (this.queues.get(backend) === tail) this.queues.delete(backend);
    }
  }

  async generateImage() { throw new BridgeError('扩展模式暂不支持图片生成', 422, 'extension_feature_unsupported'); }
  async inspectQuota() { throw new BridgeError('扩展模式暂不支持用量查询', 422, 'extension_feature_unsupported'); }

  async request(action, payload, signal, timeoutMs) {
    signal?.throwIfAborted();
    await this.start();
    const deadline = Date.now() + timeoutMs;
    while (!this.socket || this.socket.readyState !== 1) {
      if (this.closed) throw new BridgeError('扩展桥接已关闭', 503, 'disposed');
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new BridgeError('Edge 扩展未连接。请安装扩展、填写配对令牌并打开 AI Studio', 408, 'extension_not_connected');
      await delay(250, undefined, signal ? { signal } : undefined);
    }
    const id = randomUUID();
    const socket = this.socket;
    const remaining = Math.max(1, deadline - Date.now());
    return await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        try { socket.send(JSON.stringify({ type: 'cancel', id })); } catch {}
        reject(signal.reason);
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        try { socket.send(JSON.stringify({ type: 'cancel', id })); } catch {}
        reject(new BridgeError('扩展页面操作超时；未自动重发', 504, 'extension_timeout'));
      }, remaining);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { socket.send(JSON.stringify({ type: 'command', id, action, payload })); }
      catch {
        clearTimeout(timer); this.pending.delete(id); cleanup();
        reject(new BridgeError('Edge 扩展连接已中断', 503, 'extension_disconnected'));
      }
    });
  }

  #rejectPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer); entry.cleanup();
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  async dispose() {
    this.closed = true;
    this.#rejectPending(new BridgeError('扩展桥接已关闭', 503, 'disposed'));
    await this.starting?.catch(() => {});
    if (this.server) {
      for (const socket of this.server.sockets.clients) socket.terminate();
      await new Promise(resolve => this.server.sockets.close(() => resolve()));
      await new Promise(resolve => this.server.http.close(() => resolve()));
    }
    this.socket = null;
    this.server = null;
  }
}

export async function extensionToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, TOKEN_FILE);
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/.test(value)) return value;
    throw new Error('invalid token');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new BridgeError('扩展配对令牌文件无效；请删除后重新生成', 500, 'extension_token_invalid');
  }
  const value = randomBytes(32).toString('hex');
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(value + '\n'); } finally { await handle.close(); }
    return value;
  } catch (error) {
    if (error.code === 'EEXIST') return extensionToken(directory);
    throw error;
  }
}

function safeEqual(expected, supplied) {
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extensionError(code) {
  const known = {
    no_tab: ['请在正常 Edge 中打开 AI Studio 页面', 401],
    page_not_ready: ['AI Studio 页面尚未就绪或尚未登录', 401],
    selector_changed: ['AI Studio 页面控件已变化，本轮未发送', 502],
    page_error: ['AI Studio 页面报告请求失败；请查看该标签页', 422],
    cancelled: ['扩展页面操作已取消', 499],
    busy: ['扩展仍在处理上一轮请求，请稍后再试', 409],
    generation_unconfirmed: ['无法确认网页已完成生成，请查看保留的页面；未自动重发', 502],
  };
  const selected = Object.hasOwn(known, code) ? code : 'error';
  const [message, status] = known[selected] ?? ['Edge 扩展页面操作失败', 502];
  return new BridgeError(message, status, `extension_${selected}`);
}

function waitAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
