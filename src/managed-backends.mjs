import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ensureStudio, localStudio, studioAdmin, studioAccounts, studioStatus, pickStudioPort } from '../vendor/magpie/lib/studio-native.mjs';
import { ensureBackend, localBackend } from '../vendor/magpie/lib/native.mjs';
import { settings as webSettings, listModels, forward } from '../vendor/magpie/lib/backend.mjs';
import { studioSettings, listStudioModels } from '../vendor/magpie/lib/studio.mjs';
import { importCookie, parseCookieInput, validateProxyURL } from '../vendor/magpie/lib/setup.mjs';
import { prepareCamoufox } from './camoufox-install.mjs';
import { managedStudioProxy } from './studio-network.mjs';

export const MANAGED_PROVIDERS = { studio: 'aistudio-account', web: 'gemini-web-account' };

export function studioConnectionError(error) {
  if (error?.code === 'STUDIO_ACCOUNT_BUSY') return error;
  if (/WAA runtime[^\n]*由其他进程占用|已由另一个 AIStudio2API runtime 使用/.test(String(error?.message))) {
    return Object.assign(new Error('此账号正由另一个 AIStudio2API 服务使用。请停止旧服务后重试连接；已保存的登录状态会保留，无需重复登录。'), { code: 'STUDIO_ACCOUNT_BUSY' });
  }
  return error;
}

export class ManagedBackends {
  constructor(settings, studio = {}) {
    this.settings = settings;
    this.studio = { accounts: studioAccounts, admin: studioAdmin, prepareBrowser: prepareCamoufox, fetch: globalThis.fetch, ...studio };
    // These optional overrides are for explicit migrations and acceptance tests.
    // A fresh installation always owns both directories below its own data root.
    this.directories = {
      studio: process.env.GEMINI_ACCOUNT_STUDIO_DATA_DIR || path.join(settings.directory, 'backends', 'studio'),
      web: process.env.GEMINI_ACCOUNT_WEB_DATA_DIR || path.join(settings.directory, 'backends', 'web'),
    };
    this.pending = new Map();
  }

  existing(backend) {
    return backend === 'studio' ? localStudio({ dataDir: this.directories.studio }) : localBackend({ dataDir: this.directories.web });
  }

  async proxy() {
    try { return validateProxyURL(JSON.parse(await readFile(path.join(this.settings.directory, 'managed-network.json'), 'utf8')).proxy); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('本机后端网络设置无效'); }
    return this.settings.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
  }

  async ensure(backend, managementOnly = false) {
    if (!Object.hasOwn(MANAGED_PROVIDERS, backend)) throw new Error('未知后端');
    const key = backend + ':' + managementOnly;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      let proxy = await this.proxy();
      const dataDir = this.directories[backend];
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      if (backend === 'studio') proxy = await managedStudioProxy(this.settings.directory, dataDir, proxy);
      if (backend === 'web') {
        try { await readFile(path.join(dataDir, 'config.json')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const port = await pickStudioPort(8083);
          try { await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, log_requests: false, multi_turn: false, temporary_chat: true }), { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      }
      return backend === 'studio'
        ? await ensureStudio({ dataDir, proxy, managementOnly })
        : await ensureBackend({ dataDir, proxy });
    })().catch(error => { throw backend === 'studio' ? studioConnectionError(error) : error; }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async catalog(backend, { install = false } = {}) {
    if (!install && !this.existing(backend)) return {};
    const local = await this.ensure(backend, backend === 'studio');
    const credential = { baseURL: local.baseURL, key: local.apiKey };
    const models = await (backend === 'studio'
      ? listStudioModels(credential, studioSettings({ studio: { imageModels: true } }))
      : listModels(credential, webSettings({ allowImages: true, allowTools: true })));
    await mkdir(this.settings.directory, { recursive: true });
    await writeFile(path.join(this.settings.directory, `managed-catalog-${backend}.json`), JSON.stringify({ directory: this.directories[backend], models }), { mode: 0o600 });
    return models;
  }

  async cachedCatalog(backend) {
    try {
      const cache = JSON.parse(await readFile(path.join(this.settings.directory, `managed-catalog-${backend}.json`), 'utf8'));
      return cache.directory === this.directories[backend] && cache.models && typeof cache.models === 'object' ? cache.models : {};
    } catch { return {}; }
  }

  async connectStudio(onProgress = () => {}) {
    try {
      onProgress({ phase: 'service', detail: '正在准备本机 AI Studio 后端' });
      const local = await this.ensure('studio', true);
      const accounts = await this.studio.accounts({ dataDir: this.directories.studio });
      // A saved account can be unavailable because another runtime holds its lease.
      // Only a missing or explicitly expired login requires the login browser.
      if (!accounts.some(account => account.state !== 'auth_required')) {
        await this.studio.prepareBrowser(this.directories.studio, { proxy: await this.proxy(), onProgress });
        const expired = accounts.find(account => account.state === 'auth_required');
        onProgress({ phase: 'login', detail: '请在弹出的登录窗口本人完成 Google 登录；此时不再下载浏览器' });
        await this.studio.admin(local, 'POST', expired ? `/api/accounts/${encodeURIComponent(expired.id)}/login` : '/api/accounts', {}, { timeoutMs: this.settings.loginTimeoutMs });
      }
      const checked = await this.studio.accounts({ dataDir: this.directories.studio });
      if (!checked.some(account => account.state !== 'auth_required')) throw new Error('AI Studio 登录尚未完成');
      onProgress({ phase: 'generation', detail: '账号已确认，正在启动模型服务' });
      await this.ensure('studio');
    } catch (error) { throw studioConnectionError(error); }
  }

  async connectWeb(code) {
    const cookie = parseCookieInput(code);
    const local = await this.ensure('web');
    await importCookie(local, cookie, { proxy: await this.proxy(), label: 'OpenCode', dataDir: this.directories.web });
  }

  async fetch(backend, input, init) {
    const proxyURL = new URL(typeof input === 'string' ? input : input.url);
    if (proxyURL.origin !== 'https://managed-gemini.invalid' || proxyURL.username || proxyURL.password || proxyURL.search || proxyURL.hash) throw new Error('不支持的模型调用路径');
    const image = /^\/v1beta\/models\/(gemini-[a-zA-Z0-9._-]+):generateContent$/.exec(proxyURL.pathname);
    if (image && backend === 'studio') return this.fetchImage(image[1], init);
    if (proxyURL.pathname !== '/v1/chat/completions') throw new Error('不支持的模型调用路径');
    const local = await this.ensure(backend);
    const auth = { type: 'api', key: local.apiKey, metadata: { baseURL: local.baseURL, ...(backend === 'studio' ? { mode: 'studio' } : {}) } };
    const options = backend === 'studio'
      ? studioSettings({ studio: { baseURL: local.baseURL } })
      : webSettings({ baseURL: local.baseURL, allowTools: true, allowImages: true });
    // Reuse upstream's request, tool, image and citation conversion. Its response
    // body remains a stream; do not serialize website prompts or buffer SSE.
    return await forward(local.baseURL + '/chat/completions', init, async () => auth, options);
  }

  async fetchImage(modelID, init) {
    if (init?.method !== 'POST') throw new Error('生图仅支持 POST');
    const body = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
    if (Buffer.byteLength(body) > 40 * 1024 * 1024) throw new Error('生图请求超过大小限制');
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.contents)) throw new Error('生图请求格式无效');
    let catalog = await this.cachedCatalog('studio');
    if (!catalog[modelID]?.capabilities?.output?.image) catalog = await this.catalog('studio', { install: true });
    if (!catalog[modelID]?.capabilities?.output?.image) throw new Error('该型号未被后端列为可用生图模型');
    const local = await this.ensure('studio');
    const root = local.baseURL.replace(/\/v1\/?$/, '');
    return this.studio.fetch(`${root}/v1beta/models/${encodeURIComponent(modelID)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${local.apiKey}` },
      body, signal: init.signal, redirect: 'error', timeout: false,
    });
  }

  async status(backend) {
    if (backend === 'studio') {
      const status = await studioStatus({ dataDir: this.directories.studio });
      return { backend, status: status.status, state: status.state, version: status.version, accounts: status.accounts };
    }
    return { backend, installed: Boolean(this.existing(backend)), directory: this.directories.web };
  }
}
