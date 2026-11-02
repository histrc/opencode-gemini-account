import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserBridge, runPage, isGenerationURL } from '../../src/browser.mjs';
import { validateSettings, SITES } from '../../src/settings.mjs';
import { siteForModel } from '../../src/models.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// All browser traffic is intercepted. These fixtures test browser mechanics,
// not the accuracy of selectors against today's Google pages.
const launchOptions = {
  headless: true,
  ...(process.env.TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TEST_CHROMIUM_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
};

function html(backend, response, delayedSubmit = false, displayedModel, onSubmitError, { grounding = false, searchControl = true } = {}) {
  const input = backend === 'web'
    ? '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button">Send</button>'
    : '<ms-prompt-box><textarea></textarea></ms-prompt-box><ms-run-button><button>Run</button></ms-run-button>';
  const rpc = backend === 'web'
    ? 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
    : 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent';
  const markup = delayedSubmit ? input.replace('<button class="send-button">Send</button>', '<button aria-label="发送" hidden>发送</button>') : input;
  const search = backend === 'studio' && searchControl ? `<button role="switch" aria-label="Grounding with Google Search" aria-checked="${grounding}" data-clicks="0">Search</button>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${markup}<main></main>${search}${displayedModel ? `<button>${displayedModel}</button>` : ''}<script>
    const search=document.querySelector('[role="switch"]');
    if(search) search.onclick=()=>{search.setAttribute('aria-checked',search.getAttribute('aria-checked')==='true'?'false':'true');search.setAttribute('data-clicks',Number(search.getAttribute('data-clicks'))+1);};
    ${delayedSubmit ? "document.querySelector('[contenteditable]').addEventListener('input', () => setTimeout(() => { document.querySelector('button').hidden = false; }, 250));" : ''}
    document.querySelector('button').onclick = async () => {
      ${onSubmitError ? `document.querySelector('main').innerHTML='<div class="model-error"></div>'; document.querySelector('.model-error').textContent=${JSON.stringify(onSubmitError)}; return;` : ''}
      const r = await fetch(${JSON.stringify(rpc)}, {method:'POST', body:JSON.stringify({grounding:search?.getAttribute('aria-checked')})});
      if (!r.ok) return;
      await r.text();
      document.querySelector('main').innerHTML = ${JSON.stringify(backend === 'web'
        ? `<model-response><div class="markdown">${response}</div></model-response>`
        : `<ms-chat-turn><div class="model-prompt-container"><ms-text-chunk>${response}</ms-text-chunk></div></ms-chat-turn>`)};
    };
  </script></body></html>`;
}

async function fixtures(ctx, backend, { response = '<p>First line</p><p>Second line</p><pre><code class="language-c">int x = 1;</code></pre>', status = 200, lag = 30, delayedSubmit = false, displayedModel, onSubmitError, grounding = false, searchControl = true } = {}) {
  const traffic = [];
  await ctx.route('**/*', async route => {
    const request = route.request(); traffic.push({ method: request.method(), url: request.url(), ...(request.method() === 'POST' ? { grounding: JSON.parse(request.postData() || '{}').grounding } : {}) });
    const url = new URL(request.url()), siteURL = new URL(SITES[backend].url);
    if (request.method() === 'GET' && url.origin === siteURL.origin && url.pathname === siteURL.pathname) return route.fulfill({ contentType: 'text/html', body: html(backend, response, delayedSubmit, displayedModel, onSubmitError, { grounding, searchControl }) });
    if (request.method() === 'POST' && isGenerationURL(request.url(), backend)) {
      await new Promise(resolve => setTimeout(resolve, lag));
      return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }).catch(() => {});
    }
    return route.abort();
  });
  return traffic;
}

for (const backend of ['web', 'studio']) {
  test(`real Chromium: ${backend} submits once and preserves paragraphs/code`, async () => {
    const browser = await chromium.launch(launchOptions);
    try {
      const ctx = await browser.newContext();
      const traffic = await fixtures(ctx, backend);
      const page = await ctx.newPage();
      const text = await runPage(page, SITES[backend], backend, 'sample prompt', AbortSignal.timeout(10000), async () => true);
      assert.match(text, /First line\nSecond line/);
      assert.match(text, /```c\nint x = 1;\n```/);
      assert.equal(traffic.filter(r => r.method === 'POST').length, 1);
      assert.equal(page.listenerCount('requestfinished'), 0);
    } finally { await browser.close(); }
  });
}

test('real Chromium: current Chinese Send label and delayed button rendering work', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    const traffic = await fixtures(ctx, 'web', { delayedSubmit: true, response: 'OK' });
    const page = await ctx.newPage();
    const result = await runPage(page, SITES.web, 'web', 'sample', AbortSignal.timeout(10000), async () => true);
    assert.equal(result, 'OK');
    assert.equal(traffic.filter(r => r.method === 'POST').length, 1);
  } finally { await browser.close(); }
});

test('real Chromium: AI Studio code headers do not contaminate tool JSON', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    await fixtures(ctx, 'studio', { response: '<ms-code-block data-test-language="json"><mat-expansion-panel><mat-expansion-panel-header role="button"><span class="material-symbols-outlined">code</span>JSON<button>Copy</button></mat-expansion-panel-header><div><pre><code>{"content":"OK","tool_calls":[]}</code></pre></div></mat-expansion-panel></ms-code-block>' });
    const page = await ctx.newPage();
    const reply = await runPage(page, SITES.studio, 'studio', 'test JSON', AbortSignal.timeout(10000), async () => true);
    assert.equal(reply.trim(), '```json\n{"content":"OK","tool_calls":[]}\n```');
  } finally { await browser.close(); }
});

test('real Chromium: Gemini code language headers do not contaminate tool JSON', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    await fixtures(ctx, 'web', { response: '<code-block><div class="code-block-decoration"><span>JSON</span><button>Copy</button></div><pre><code>{"content":"OK","tool_calls":[]}</code></pre></code-block>' });
    const page = await ctx.newPage();
    const reply = await runPage(page, SITES.web, 'web', 'test JSON', AbortSignal.timeout(10000), async () => true);
    assert.equal(reply.trim(), '```\n{"content":"OK","tool_calls":[]}\n```');
  } finally { await browser.close(); }
});

test('real Chromium: upstream rejection sends once and removes request listeners', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    const traffic = await fixtures(ctx, 'web', { status: 429 });
    const page = await ctx.newPage();
    await assert.rejects(runPage(page, SITES.web, 'web', 'prompt', AbortSignal.timeout(10000), async () => true), e => e.status === 429);
    assert.equal(traffic.filter(r => r.method === 'POST').length, 1);
    assert.equal(page.listenerCount('request'), 0);
    assert.equal(page.listenerCount('requestfinished'), 0);
  } finally { await browser.close(); }
});

test('real Chromium: persistent bridge checks session, queues requests, and cancels a waiter', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-profile-'));
  let traffic;
  const engine = { async launchPersistentContext(profile) {
    const ctx = await chromium.launchPersistentContext(profile, launchOptions);
    traffic = await fixtures(ctx, 'web', { lag: 200 });
    await ctx.addCookies([{ name: '__Secure-1PSID', value: 'fixture-session-not-a-real-cookie', url: 'https://gemini.google.com', secure: true }]);
    return ctx;
  } };
  const bridge = new BrowserBridge(validateSettings({ browser: 'chromium', timeoutMs: 10000 }, directory), engine);
  try {
    const page = await bridge.openLogin('web');
    await bridge.waitLogin('web', page);
    const first = bridge.generate('web', 'one', AbortSignal.timeout(10000));
    const controller = new AbortController();
    const cancelled = bridge.generate('web', 'cancel', controller.signal);
    controller.abort(new Error('cancelled-waiter'));
    await assert.rejects(cancelled, /cancelled-waiter/);
    const third = bridge.generate('web', 'three', AbortSignal.timeout(10000));
    const values = await Promise.all([first, third]);
    assert.equal(values.length, 2);
    assert.equal(traffic.filter(r => r.method === 'POST').length, 2);
    assert.equal(bridge.queues.size, 0);
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('real Chromium: generation timeout closes only the request page', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-timeout-'));
  const engine = { async launchPersistentContext(profile) {
    const ctx = await chromium.launchPersistentContext(profile, launchOptions);
    await fixtures(ctx, 'web', { lag: 1500 });
    await ctx.addCookies([{ name: 'SID', value: 'fixture', url: 'https://gemini.google.com', secure: true }]);
    return ctx;
  } };
  const bridge = new BrowserBridge(validateSettings({ browser: 'chromium', timeoutMs: 500 }, directory), engine);
  try {
    const loginPage = await bridge.openLogin('web');
    await assert.rejects(bridge.generate('web', 'prompt'), e => e.code === 'generation_timeout');
    assert.equal(loginPage.isClosed(), false);
    const ctx = await bridge.context('web');
    assert.equal(ctx.pages().filter(p => p.url() === SITES.web.url).length, 1);
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('real Chromium: a deadline covers slow startup; an expired queued request never submits later', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-queue-deadline-'));
  let traffic = [];
  const engine = { async launchPersistentContext(profile) {
    await delay(600);
    const ctx = await chromium.launchPersistentContext(profile, launchOptions);
    traffic = await fixtures(ctx, 'web');
    return ctx;
  } };
  const bridge = new BrowserBridge(validateSettings({ timeoutMs: 200 }, directory), engine);
  try {
    const first = assert.rejects(bridge.generate('web', 'startup'), e => e.code === 'generation_timeout');
    await delay(20);
    await assert.rejects(bridge.generate('web', 'must never send'), e => e.code === 'queue_timeout');
    await first;
    await delay(20);
    assert.equal(traffic.filter(r => r.method === 'POST').length, 0);
    assert.equal(bridge.queues.size, 0);
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); }
});

async function testBridge(backend, raw = {}, fixtureOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-v02-'));
  let traffic;
  const engine = { async launchPersistentContext(profile) {
    const ctx = await chromium.launchPersistentContext(profile, launchOptions);
    traffic = await fixtures(ctx, backend, fixtureOptions);
    await ctx.addCookies([{ name: 'SID', value: 'fixture-session', url: new URL(SITES[backend].url).origin, secure: true }]);
    return ctx;
  } };
  const bridge = new BrowserBridge(validateSettings({ browser: 'chromium', timeoutMs: 15000, ...raw }, directory), engine);
  return { bridge, traffic: () => traffic, async close() { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('real Chromium: explicit Studio selection reaches its URL and verifies the visible model', async () => {
  const setup = await testBridge('studio', { studioModels: ['gemini-example'] }, { displayedModel: 'Gemini Example gemini-example', response: 'Pinned result' });
  try {
    const answer = await setup.bridge.generate('studio', 'hello', AbortSignal.timeout(15000), { upstreamModel: 'gemini-example' });
    assert.equal(answer, 'Pinned result');
    const navigation = setup.traffic().find(r => r.method === 'GET');
    assert.equal(new URL(navigation.url).searchParams.get('model'), 'gemini-example');
    assert.equal(setup.traffic().filter(r => r.method === 'POST').length, 1);
  } finally { await setup.close(); }
});

test('real Chromium: a prefix-only model match stops before submitting any prompt', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    const traffic = await fixtures(ctx, 'studio', { displayedModel: 'Gemini Example gemini-example-v2' });
    const settings = validateSettings({ studioModels: ['gemini-example'] });
    const page = await ctx.newPage();
    await assert.rejects(runPage(page, siteForModel(settings, 'studio', 'gemini-example'), 'studio', 'must not send', AbortSignal.timeout(15000), async () => true), e => e.code === 'model_mismatch');
    assert.equal(traffic.filter(r => r.method === 'POST').length, 0);
    assert.equal(await page.locator('textarea').inputValue(), '');
  } finally { await browser.close(); }
});

test('real Chromium: an immediate quota error without a generation request does not wait for network timeout', async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const ctx = await browser.newContext();
    const traffic = await fixtures(ctx, 'studio', { onSubmitError: 'Quota exceeded: private-prompt-marker' });
    const page = await ctx.newPage();
    await assert.rejects(runPage(page, SITES.studio, 'studio', 'sample', AbortSignal.timeout(3000), async () => true), e => {
      assert.equal(e.code, 'quota_limited');
      assert.doesNotMatch(e.message, /private-prompt/);
      return true;
    });
    assert.equal(traffic.filter(r => r.method === 'POST').length, 0);
    assert.equal(page.listenerCount('requestfinished'), 0);
  } finally { await browser.close(); }
});

test('real Chromium: only one completed page is retained per backend and opt-out closes it', async () => {
  for (const keepLastPage of [true, false]) {
    const setup = await testBridge('web', { keepLastPage }, { response: 'OK' });
    try {
      await setup.bridge.openLogin('web');
      await setup.bridge.generate('web', 'one');
      const first = setup.bridge.lastPages.get('web');
      if (keepLastPage) assert.equal(first.isClosed(), false);
      else assert.equal(first, undefined);
      await setup.bridge.generate('web', 'two');
      if (keepLastPage) {
        assert.equal(first.isClosed(), true);
        assert.equal(setup.bridge.lastPages.size, 1);
        assert.equal(setup.bridge.lastPages.get('web').isClosed(), false);
      } else assert.equal(setup.bridge.lastPages.size, 0);
      const ctx = await setup.bridge.context('web');
      assert.equal(ctx.pages().filter(p => p.url() === SITES.web.url).length, keepLastPage ? 2 : 1);
    } finally { await setup.close(); }
  }
});

test('real Chromium: permission failures retain the error page for inspection', async () => {
  const setup = await testBridge('studio', {}, { onSubmitError: 'Permission denied for private-account-marker' });
  try {
    await assert.rejects(setup.bridge.generate('studio', 'sample'), e => e.code === 'permission_denied');
    const page = setup.bridge.lastPages.get('studio');
    assert.equal(page.isClosed(), false);
    assert.match(await page.locator('.model-error').innerText(), /Permission denied/);
    assert.equal(setup.traffic().filter(r => r.method === 'POST').length, 0);
  } finally { await setup.close(); }
});

test('real Chromium: Studio search is disabled and confirmed before submitting once', async () => {
  for (const grounding of [true, false]) {
    const setup = await testBridge('studio', {}, { grounding, response: 'Search-off answer' });
    try {
      assert.equal(await setup.bridge.generate('studio', 'sample'), 'Search-off answer');
      const page = setup.bridge.lastPages.get('studio');
      const search = page.getByRole('switch', { name: 'Grounding with Google Search', exact: true });
      assert.equal(await search.getAttribute('aria-checked'), 'false');
      assert.equal(await search.getAttribute('data-clicks'), grounding ? '1' : '0');
      const posts = setup.traffic().filter(r => r.method === 'POST');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].grounding, 'false');
    } finally { await setup.close(); }
  }
});

test('real Chromium: missing Studio search control fails before filling or sending', async () => {
  const setup = await testBridge('studio', {}, { searchControl: false });
  try {
    await assert.rejects(setup.bridge.generate('studio', 'must never send'), e => e.code === 'studio_settings_unavailable');
    assert.equal(setup.traffic().filter(r => r.method === 'POST').length, 0);
    assert.equal(await setup.bridge.lastPages.get('studio').locator('textarea').inputValue(), '');
  } finally { await setup.close(); }
});

test('real Chromium: current Studio search mode leaves the webpage setting alone', async () => {
  const setup = await testBridge('studio', { studioSearch: 'current' }, { grounding: true, response: 'Current setting' });
  try {
    assert.equal(await setup.bridge.generate('studio', 'sample'), 'Current setting');
    const search = setup.bridge.lastPages.get('studio').getByRole('switch', { name: 'Grounding with Google Search', exact: true });
    assert.equal(await search.getAttribute('aria-checked'), 'true');
    assert.equal(await search.getAttribute('data-clicks'), '0');
    assert.equal(setup.traffic().filter(r => r.method === 'POST')[0].grounding, 'true');
  } finally { await setup.close(); }
});
