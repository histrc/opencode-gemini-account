// Test-only implementation of chrome.tabs using isolated, fully intercepted
// headless pages. Runs the production worker and content scripts unchanged.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { extensionToken } from '../../src/extension-bridge.mjs';

export async function extensionBrowser({ directory, port, scenario = 'normal' }) {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.TEST_CHROMIUM_EXECUTABLE,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const pages = new Map();
  const observed = { submissions: 0, closed: [], reads: [] };
  let id = 0;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== 'https://aistudio.google.com') return route.abort();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <ms-prompt-box><textarea></textarea></ms-prompt-box><ms-run-button><button>Run</button></ms-run-button><main></main>
      <script>
      window.submissions=0;
      document.querySelector('button').onclick=()=>{
        window.submissions++;
        const button=document.querySelector('ms-run-button button');
        if(${JSON.stringify(scenario)}!=='unconfirmed'){button.disabled=true;button.innerHTML='<i class="spin"></i>';}
        const turn=document.createElement('ms-chat-turn');turn.innerHTML='<div class="model-prompt-container"><ms-text-chunk></ms-text-chunk></div>';
        document.querySelector('main').append(turn);
        const reply=turn.querySelector('ms-text-chunk');reply.textContent='PARTIAL';
        setTimeout(()=>{reply.innerHTML='<p>OK</p>';const code=document.createElement('ms-text-chunk');code.innerHTML='<pre><code class="language-js">const value = 1;</code></pre>';turn.querySelector('.model-prompt-container').append(code);button.disabled=false;button.innerHTML='Run';},1200);
      };
      </script>` });
  });
  const content = await readFile(new URL('../../extension/content.js', import.meta.url), 'utf8');
  const newTab = async () => {
    const page = await context.newPage();
    const tabID = ++id;
    pages.set(tabID, page);
    await page.addInitScript(() => { globalThis.chrome = { runtime: { onMessage: { addListener: handler => { globalThis.extensionHandler = handler; } } } }; });
    await page.addInitScript({ content });
    await page.goto('https://aistudio.google.com/prompts/new_chat');
    return { id: tabID, windowId: 1, active: true, url: page.url() };
  };
  const home = await newTab();
  const token = await extensionToken(directory);
  const handlers = {};
  const intervals = new Set();
  const timers = new Set();
  let liveSocket;
  const worker = {
    WebSocket: class extends WebSocket {
      constructor(url) { super(url, { origin: `chrome-extension://${'a'.repeat(32)}` }); liveSocket = this; }
    },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
    setInterval(fn, ms) { const timer = setInterval(fn, ms); intervals.add(timer); return timer; },
    clearInterval,
    chrome: {
      storage: { local: { get: async () => ({ token }), setAccessLevel: async () => {} }, onChanged: { addListener() {} } },
      alarms: { create: async () => {}, onAlarm: { addListener() {} } },
      runtime: { getManifest: () => ({ version: 'test' }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { handlers.popup = fn; } } },
      tabs: {
        query: async () => [home],
        create: newTab,
        get: async tabID => ({ id: tabID, url: pages.get(tabID).url() }),
        async remove(tabID) { observed.closed.push(tabID); await pages.get(tabID)?.close(); pages.delete(tabID); },
        async sendMessage(tabID, message) {
          if (message.action === 'generate') observed.submissions++;
          observed.reads.push({ tabID, action: message.action ?? message.type });
          return await pages.get(tabID).evaluate(message => new Promise(resolve => {
            const pending = globalThis.extensionHandler(message, {}, resolve);
            if (!pending) resolve();
          }), message);
        },
      },
    },
  };
  const source = (await readFile(new URL('../../extension/service-worker.js', import.meta.url), 'utf8')).replace('127.0.0.1:37654', `127.0.0.1:${port}`);
  vm.runInNewContext(source, worker, { filename: 'extension/service-worker.js' });
  return {
    observed, pages, homeID: home.id,
    async close() {
      if (liveSocket) liveSocket.onclose = null;
      liveSocket?.terminate();
      for (const timer of intervals) clearInterval(timer);
      for (const timer of timers) clearTimeout(timer);
      await browser.close();
    },
  };
}
