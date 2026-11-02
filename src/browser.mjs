import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, classifyPageError } from './errors.mjs';
import { siteForModel } from './models.mjs';
import { uploadImages, generatedImageSources, savePageImages, checkMediaConsent } from './image-browser.mjs';
import { readQuotaPage } from './quota.mjs';
import { selectWebVisionMode } from './web-mode.mjs';

// Normal visible browser, isolated profile. No cookies from the user's daily browser,
// stealth patches, challenge handling, credential export, or HTTP listening socket.
export class BrowserBridge {
  constructor(settings, engine = chromium) {
    this.settings = settings;
    this.engine = engine;
    this.contexts = new Map();
    this.queues = new Map();
    this.loginPages = new Map();
    this.lastPages = new Map();
    this.closed = false;
  }

  async context(backend) {
    if (this.closed) throw new BridgeError('插件已关闭', 503, 'disposed');
    if (!Object.hasOwn(this.settings.sites, backend)) throw new BridgeError('未知网页入口');
    if (!this.contexts.has(backend)) {
      const pending = (async () => {
        const profile = path.join(this.settings.directory, 'profiles', backend);
        await mkdir(profile, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(profile, 0o700);
        const opts = {
          headless: false,
          ...(this.settings.browser === 'chromium' ? {} : { channel: this.settings.browser }),
          ...(this.settings.executablePath ? { executablePath: this.settings.executablePath } : {}),
          ...(this.settings.proxy ? { proxy: { server: this.settings.proxy } } : {}),
          ...(Object.keys(this.settings.hostOverrides).length ? { args: hostResolverArgs(this.settings.hostOverrides) } : {}),
          viewport: { width: 1200, height: 850 },
          timeout: 30000,
        };
        const ctx = await this.engine.launchPersistentContext(profile, opts);
        ctx.setDefaultTimeout(10000);
        ctx.once('close', () => {
          if (this.contexts.get(backend) === pending) this.contexts.delete(backend);
          this.loginPages.delete(backend);
          this.lastPages.delete(backend);
        });
        return ctx;
      })();
      this.contexts.set(backend, pending);
      pending.catch(() => { if (this.contexts.get(backend) === pending) this.contexts.delete(backend); });
    }
    try { return await this.contexts.get(backend); }
    catch {
      throw new BridgeError('无法打开独立浏览器。请确认已安装 Chrome/Edge，或在 settings.json 修改 browser。若已打开另一 OpenCode 实例，请先关闭该实例。', 503, 'browser_launch_failed');
    }
  }

  async openLogin(backend) {
    const ctx = await this.context(backend);
    let page = this.loginPages.get(backend);
    if (!page || page.isClosed()) {
      page = await ctx.newPage();
      this.loginPages.set(backend, page);
    }
    try {
      await page.goto(this.settings.sites[backend].url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      // A failed navigation must not destroy the user's login window. They can
      // repair the network and reload it; waitLogin still verifies origin,
      // session cookie and the actual input before accepting authentication.
      if (page.isClosed()) throw new BridgeError('登录窗口已关闭，请重新连接', 401, 'login_closed');
    }
    await page.bringToFront();
    return page;
  }

  async waitLogin(backend, page) {
    const signal = AbortSignal.timeout(this.settings.loginTimeoutMs);
    try {
      while (!signal.aborted) {
        if (page.isClosed()) throw new BridgeError('登录窗口已关闭，请重新连接', 401, 'login_closed');
        if (await this.signedIn(backend, page)) return;
        await delay(500, undefined, { signal });
      }
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      if (!signal.aborted) throw new BridgeError('登录页面不可用，请重新连接', 401, 'login_failed');
    }
    throw new BridgeError('等待登录超时，请重新连接', 408, 'login_timeout');
  }

  async signedIn(backend, page) {
    const site = this.settings.sites[backend];
    if (new URL(page.url()).origin !== new URL(site.url).origin) return false;
    const ctx = await this.context(backend);
    const cookies = await ctx.cookies(site.url);
    const hasSession = cookies.some(c => ['__Secure-1PSID', 'SID'].includes(c.name) && c.value && (c.expires === -1 || c.expires > Date.now() / 1000));
    return hasSession && Boolean(await visibleTarget(page, site.input));
  }

  async generate(backend, prompt, signal, options = {}) {
    // Include queueing and browser startup in the deadline. A queued request
    // that has timed out must never submit later when the preceding turn ends.
    const deadline = AbortSignal.timeout(this.settings.timeoutMs);
    const operationSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const previous = this.queues.get(backend) ?? Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => lock);
    this.queues.set(backend, tail);
    // An aborted waiter must not release the queue ahead of the preceding operation.
    try { await abortable(previous, operationSignal); operationSignal.throwIfAborted(); }
    catch (e) {
      previous.finally(() => { release(); if (this.queues.get(backend) === tail) this.queues.delete(backend); });
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new BridgeError('等待前一轮网页请求超时，本轮尚未发送', 408, 'queue_timeout');
      throw e;
    }
    try { return await this.generatePage(backend, prompt, operationSignal, options); }
    catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new BridgeError('网页生成超时，未自动重发，避免重复消耗额度', 504, 'generation_timeout');
      throw e;
    }
    finally { release(); if (this.queues.get(backend) === tail) this.queues.delete(backend); }
  }

  async generatePage(backend, prompt, signal, options = {}) {
    const site = siteForModel(this.settings, backend, options.upstreamModel);
    const ctx = await this.context(backend);
    signal?.throwIfAborted();
    const page = await ctx.newPage();
    const combined = signal ?? AbortSignal.timeout(this.settings.timeoutMs);
    const closeOnAbort = () => { void page.close().catch(() => {}); };
    combined.addEventListener('abort', closeOnAbort, { once: true });
    try {
      if (combined.aborted) { closeOnAbort(); combined.throwIfAborted(); }
      const result = await runPage(page, site, backend, prompt, combined, () => this.signedIn(backend, page), options);
      if (typeof result === 'object') return { text: result.text, images: await savePageImages(page, this.settings, result.sources, combined) };
      return result;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (combined.aborted) throw new BridgeError('网页生成超时，未自动重发，避免重复消耗额度', 504, 'generation_timeout');
      if (e instanceof BridgeError) throw e;
      // Playwright errors can include the entire prompt in an action log. Never expose them.
      throw new BridgeError('网页操作失败。请查看独立浏览器是否需要登录、存在弹窗，或更新 selectors 设置。', 502, 'page_operation_failed');
    } finally {
      combined.removeEventListener('abort', closeOnAbort);
      if (this.settings.keepLastPage && !this.closed && !combined.aborted && !page.isClosed()) {
        const previous = this.lastPages.get(backend);
        this.lastPages.set(backend, page);
        if (previous && previous !== page) await previous.close().catch(() => {});
      } else await page.close().catch(() => {});
    }
  }

  async generateImage(backend, prompt, signal, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > this.settings.maxPromptChars) throw new BridgeError('生图提示词为空或超过本地长度限制');
    const request = 'Generate an actual image using the website image-generation feature. Do not return code, SVG source, a data URL, or a description in place of the image.\n' + prompt;
    return this.generate(backend, request, signal, { ...options, expectImages: true });
  }

  async inspectQuota(backend, signal) {
    const site = siteForModel(this.settings, backend);
    const combined = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    const ctx = await this.context(backend), page = await ctx.newPage();
    const abort = () => { void page.close().catch(() => {}); };
    combined.addEventListener('abort', abort, { once: true });
    try {
      combined.throwIfAborted();
      return await readQuotaPage(page, backend, site, combined, () => this.signedIn(backend, page));
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (e instanceof BridgeError) throw e;
      throw new BridgeError('使用限额查询未完成；没有发送生成请求，也没有推测剩余额度', 422, 'quota_ui_unavailable');
    } finally { combined.removeEventListener('abort', abort); await page.close().catch(() => {}); }
  }

  async dispose() {
    this.closed = true;
    await Promise.allSettled([...this.contexts.values()].map(async p => (await p).close()));
    this.contexts.clear();
    this.lastPages.clear();
  }
}

export function hostResolverArgs(overrides) {
  const rules = Object.entries(overrides).map(([hostname, ip]) => `MAP ${hostname} ${ip}`).join(', ');
  return [`--host-resolver-rules=${rules}`];
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function visibleTarget(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    let chosen;
    for (let i = 0, count = await candidates.count(); i < count; i++) {
      const target = candidates.nth(i);
      if (await target.isVisible()) {
        if (chosen) throw new BridgeError('页面出现多个匹配控件，请更新 selectors 设置', 502, 'ambiguous_selector');
        chosen = target;
      }
    }
    if (chosen) return chosen;
  }
  return null;
}

export function isGenerationURL(url, backend) {
  try {
    const u = new URL(url);
    if (backend === 'studio') return /(^|\.)(clients6\.google\.com|googleapis\.com)$/.test(u.hostname) && /\/(?:GenerateContent|GenerateContentStream)$/.test(u.pathname);
    return u.hostname === 'gemini.google.com' && /\/StreamGenerate$/.test(u.pathname);
  } catch { return false; }
}

// Completion is based on the observed generation request finishing, never on a
// guessed typing pause. A request is sent once; this function has no retry loop.
export async function runPage(page, site, backend, prompt, signal, signedIn, options = {}) {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 30000;
  let input;
  while (!(input = await visibleTarget(page, site.input))) {
    signal.throwIfAborted();
    await throwPageError(page, site);
    if (Date.now() >= deadline || new URL(page.url()).hostname === 'accounts.google.com') throw new BridgeError('网页未就绪，请在 /connect 登录并完成网页提示', 401, 'login_required');
    await delay(200, undefined, { signal });
  }
  if (!(await signedIn())) throw new BridgeError('Google 会话已过期，请在 /connect 重新登录', 401, 'login_required');
  if (options.images?.length) await checkMediaConsent(page, site, visibleTarget);
  if (site.expectedModel) await verifyPageModel(page, site, signal);
  if (site.disableSearch) await disableStudioSearch(page, signal);
  if (backend === 'web' && site.visionMode === 'flash-lite' && options.images?.length && !options.expectImages) await selectWebVisionMode(page, signal, visibleTarget);
  await uploadImages(page, site, options.images, signal, visibleTarget);
  await input.fill(prompt);
  // The current Gemini UI creates the Send button asynchronously after input.
  // Wait for its appearance and enabled state; this does not resend a request.
  const submitDeadline = Date.now() + 10000;
  let submit;
  while (!(submit = await visibleTarget(page, site.submit)) || !(await submit.isEnabled())) {
    signal.throwIfAborted();
    if (Date.now() >= submitDeadline) throw new BridgeError('找不到可用的网页发送按钮，请更新 selectors.submit 或检查页面提示', 502, 'selector_changed');
    await delay(100, undefined, { signal });
  }

  const waitAbort = new AbortController();
  const waitSignal = AbortSignal.any([signal, waitAbort.signal]);
  const finished = waitGeneration(page, backend, waitSignal);
  const uiError = watchPageError(page, site, waitSignal);
  finished.catch(() => {});
  uiError.catch(() => {});
  try {
    await submit.click();
    await Promise.race([finished, uiError]);
  } finally { waitAbort.abort(); }

  // Let the UI commit the final DOM after network completion. Stop buttons must
  // also be absent, so an outstanding continuation cannot appear finished.
  let last = '';
  let same = 0;
  while (true) {
    signal.throwIfAborted();
    await throwPageError(page, site);
    const stop = await visibleTarget(page, site.stop);
    const text = await readReply(page, site.reply);
    const sources = options.expectImages || options.captureImages ? await generatedImageSources(page, site) : [];
    const imageReply = sources.length > 0;
    const value = imageReply ? JSON.stringify({ text, sources }) : text;
    if ((options.expectImages ? imageReply : text || imageReply) && value === last && !stop) same++; else same = 0;
    if (same >= 2) return imageReply ? { text, sources } : text;
    last = value;
    await delay(150, undefined, { signal });
  }
}

function waitGeneration(page, backend, signal) {
  return new Promise((resolve, reject) => {
    let observed;
    let settled = false;
    const cleanup = () => {
      page.off('request', request); page.off('requestfinished', done); page.off('requestfailed', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(); };
    const request = req => { if (!observed && req.method() === 'POST' && isGenerationURL(req.url(), backend)) observed = req; };
    const done = async req => {
      if (req !== observed) return;
      try {
        const response = await req.response();
        if (!response || !response.ok()) {
          const status = response?.status() ?? 502;
          if (status === 429) finish(classifyPageError('quota'));
          else if (status === 401) finish(new BridgeError('网页登录状态无效，请在 /connect 重新登录', 401, 'login_required'));
          else if (status === 403) finish(new BridgeError('网页请求被拒绝，请检查账号、模型权限和页面提示', 403, 'permission_denied'));
          else finish(new BridgeError('网页生成请求失败；请检查保留的页面', status >= 400 ? status : 502, 'upstream_error'));
        } else finish();
      } catch { finish(new BridgeError('网页请求状态无法读取', 502, 'upstream_error')); }
    };
    const failed = req => { if (req === observed) finish(new BridgeError('网页生成请求中断；插件未自动重试', 502, 'generation_interrupted')); };
    const aborted = () => finish(signal.reason);
    page.on('request', request); page.on('requestfinished', done); page.on('requestfailed', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function throwPageError(page, site) {
  const error = await visibleTarget(page, site.error);
  if (error) throw classifyPageError(await error.innerText());
}

async function watchPageError(page, site, signal) {
  while (true) {
    signal.throwIfAborted();
    await throwPageError(page, site);
    await delay(150, undefined, { signal });
  }
}

async function verifyPageModel(page, site, signal) {
  const deadline = Date.now() + 10000;
  while (true) {
    signal.throwIfAborted();
    await throwPageError(page, site);
    const candidates = page.getByRole('button').filter({ hasText: site.expectedModel });
    for (let i = 0, count = await candidates.count(); i < count; i++) {
      const candidate = candidates.nth(i);
      if (await candidate.isVisible() && (await candidate.innerText()).split(/\s+/).includes(site.expectedModel)) return;
    }
    if (Date.now() >= deadline) throw new BridgeError(`网页没有确认所选模型 ${site.expectedModel}。为避免误用其他模型，本轮未发送。`, 422, 'model_mismatch');
    await delay(100, undefined, { signal });
  }
}

async function disableStudioSearch(page, signal) {
  const deadline = Date.now() + 10000;
  const controls = page.getByRole('switch', { name: 'Grounding with Google Search', exact: true });
  let toggled = false;
  while (true) {
    signal.throwIfAborted();
    const count = await controls.count();
    if (count > 1) throw new BridgeError('搜索开关不唯一，本轮未发送。请检查 Studio 页面。', 422, 'studio_settings_unavailable');
    if (count === 1 && await controls.isVisible()) {
      const checked = await controls.getAttribute('aria-checked');
      if (checked === 'false') return;
      if (checked === 'true' && !toggled) { await controls.click(); toggled = true; }
    }
    if (Date.now() >= deadline) throw new BridgeError('无法确认 AI Studio 搜索已关闭，本轮未发送。请打开右侧 Run settings 面板；若要使用网页现有设置，可将 studioSearch 改为 current。', 422, 'studio_settings_unavailable');
    await delay(100, undefined, { signal });
  }
}

async function readReply(page, selectors) {
  for (const selector of selectors) {
    const items = page.locator(selector);
    if (!(await items.count())) continue;
    const text = await items.evaluateAll(nodes => nodes
      .filter(n => !n.closest('ms-thought-chunk, .thought-panel, .thinking-container'))
      .map(n => {
        const copy = n.cloneNode(true);
        copy.querySelectorAll('button, svg, script, style, mat-expansion-panel-header, code-block .code-block-decoration, mat-icon, .material-symbols-outlined, ms-thought-chunk, .thought-panel').forEach(el => el.remove());
        // Code fences preserve code boundaries. textContent then also works for
        // plain-text JSON replies, including escaped quotes and line breaks.
        copy.querySelectorAll('pre').forEach(pre => {
          const code = pre.querySelector('code');
          const lang = code?.className.match(/language-([\w+-]+)/)?.[1] || pre.closest('ms-code-block')?.getAttribute('data-test-language') || '';
          const contents = code?.textContent ?? pre.textContent;
          const fence = '`'.repeat(Math.max(3, ...[...contents.matchAll(/`+/g)].map(m => m[0].length + 1)));
          pre.replaceWith(document.createTextNode(`\n${fence}${lang}\n${contents}\n${fence}\n`));
        });
        copy.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
        copy.querySelectorAll('p, div, li, h1, h2, h3, h4, tr').forEach(el => el.appendChild(document.createTextNode('\n')));
        return copy.textContent.trim();
      }).filter(Boolean).join('\n\n'));
    if (text) return text;
  }
  return '';
}
