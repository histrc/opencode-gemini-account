// Test-only browser adapter. Every URL is intercepted and no Google traffic is
// allowed. The production entry point never imports this module.
import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { createPlugin } from '../../src/plugin.mjs';
import { createV2Plugin } from '../../src/plugin-v2.mjs';
import { BrowserBridge, isGenerationURL } from '../../src/browser.mjs';
import { SITES } from '../../src/settings.mjs';
import { chromium } from 'playwright-core';
import { TEST_IMAGE_URL, TEST_PNG } from './png.mjs';

const engine = { async launchPersistentContext(profile, options) {
    const ctx = await chromium.launchPersistentContext(profile, {
      ...options, channel: undefined, headless: true, serviceWorkers: 'block',
      executablePath: process.env.TEST_CHROMIUM_EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    });
    await ctx.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      const backend = Object.keys(SITES).find(b => { const u = new URL(SITES[b].url); return u.origin === url.origin && u.pathname === url.pathname; });
      if (backend && req.method() === 'GET') {
        const inputHTML = backend === 'web'
          ? '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button">Send</button>'
          : '<ms-prompt-box><textarea></textarea></ms-prompt-box><ms-run-button><button>Run</button></ms-run-button>';
        const rpc = backend === 'web'
          ? 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
          : 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent';
        const replyHTML = backend === 'web' ? '<model-response><div class="markdown"></div></model-response>' : '<ms-chat-turn><div class="model-prompt-container"><ms-text-chunk></ms-text-chunk></div></ms-chat-turn>';
        const body = `<!doctype html><meta charset="utf-8">${inputHTML}<button>${url.searchParams.get('model') ?? 'gemini-3.5-flash-lite'}</button>${backend === 'studio' ? '<button role="switch" aria-label="Grounding with Google Search" aria-checked="false">Search</button>' : ''}<input type="file" accept="image/*" multiple><section id="uploads"></section><main></main><button id="settings">Settings</button><div id="usage"></div><script>
          document.querySelector('#settings').onclick=()=>{document.querySelector('#usage').innerHTML='<button role="menuitem" id="limits">Usage limits</button>';document.querySelector('#limits').onclick=()=>{document.querySelector('#usage').innerHTML='<div role="dialog"><h2>Usage limits</h2><p>75% remaining</p><p>Refreshes in 1 hour</p></div>';};};
          let images=[];
          const mode=document.createElement('button');mode.setAttribute('aria-label','打开模式选择器，当前模式为“Flash”');document.body.append(mode);mode.onclick=()=>{const item=document.createElement('button');item.setAttribute('role','menuitem');item.textContent='3.5 Flash-Lite 极速回答';document.body.append(item);item.onclick=()=>{mode.setAttribute('aria-label','打开模式选择器，当前模式为“Flash-Lite”');item.remove();};};
          document.querySelector('input[type=file]').onchange=async e=>{images=await Promise.all([...e.target.files].map(async f=>({name:f.name,data:Array.from(new Uint8Array(await f.arrayBuffer()))})));document.querySelector('#uploads').innerHTML=images.map(f=>'<span>'+f.name+'</span>').join('');};
          document.querySelector('button').onclick=async()=>{
            const prompt=${backend === 'web' ? "document.querySelector('.ql-editor').innerText" : "document.querySelector('textarea').value"};
            const r=await fetch(${JSON.stringify(rpc)},{method:'POST',body:JSON.stringify({prompt,images})});
            const result=await r.json(); document.querySelector('main').innerHTML=${JSON.stringify(replyHTML)};
            document.querySelector(${JSON.stringify(backend === 'web' ? '.markdown' : 'ms-text-chunk')}).textContent=result.reply;
            if(result.image){const container=document.createElement(${JSON.stringify(backend === 'web' ? 'generated-image' : 'ms-image-chunk')});const img=document.createElement('img');img.src=result.image;container.append(img);document.querySelector(${JSON.stringify(backend === 'web' ? 'model-response' : '.model-prompt-container')}).append(container);}
          };</script>`;
        return route.fulfill({ contentType: 'text/html', body });
      }
      if (req.method() === 'POST' && ['studio', 'web'].some(b => isGenerationURL(req.url(), b))) {
        const { prompt, images } = JSON.parse(req.postData());
        if (process.env.TEST_NATIVE_SCENARIO === 'vision') {
          if (images?.length !== 1 || !Buffer.from(images[0].data).equals(TEST_PNG) || !prompt.includes('Attached image 1')) throw new Error('Native image upload missing');
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'NATIVE_IMAGE_INPUT_OK' }) });
        }
        if (process.env.TEST_NATIVE_SCENARIO === 'image-tool' && prompt.startsWith('Generate an actual image')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'Generated fixture image', image: TEST_IMAGE_URL }) });
        const messages = JSON.parse(prompt.split('CONVERSATION_JSON=')[1].split('\nEND_CONVERSATION')[0]);
        const results = messages.filter(m => m.role === 'tool');
        const tools = JSON.parse(prompt.split('TOOLS_JSON=')[1].split('\n')[0]);
        if (process.env.KEEP_NATIVE_FIXTURES) await writeFile(path.join(process.env.GEMINI_ACCOUNT_DATA_DIR, 'fixture-tool-schemas.json'), JSON.stringify(tools, null, 2));
        if (process.env.TEST_NATIVE_SCENARIO === 'image-tool') {
          const reply = results.length ? { content: 'NATIVE_IMAGE_TOOL_OK', tool_calls: [] } : { content: null, tool_calls: [{ name: 'gemini_generate_image', arguments: { prompt: 'A red square', backend: 'web' } }] };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: JSON.stringify(reply) }) });
        }
        if (process.env.TEST_NATIVE_SCENARIO === 'usage-tool') {
          if (results.length && !results.some(m => m.content.includes('75'))) throw new Error('Actual quota tool output missing');
          const reply = results.length ? { content: 'NATIVE_USAGE_TOOL_OK', tool_calls: [] } : { content: null, tool_calls: [{ name: 'gemini_usage', arguments: { backend: 'web' } }] };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: JSON.stringify(reply) }) });
        }
        const argsFor = (name, values) => {
          const tool = tools.find(t => t.name === name);
          if (!tool) throw new Error(`Missing declared ${name}`);
          const props = tool.parameters.properties;
          return Object.fromEntries(Object.entries(values).map(([k, v]) => [k === 'filePath' && !props.filePath ? 'path' : k, v]).filter(([k]) => Object.hasOwn(props, k)));
        };
        let reply;
        if (!results.length) reply = { content: null, tool_calls: [{ name: 'read', arguments: argsFor('read', { filePath: path.join(process.cwd(), 'calculator.cjs') }) }] };
        else if (results.length === 1) reply = { content: null, tool_calls: [{ name: 'edit', arguments: argsFor('edit', { filePath: path.join(process.cwd(), 'calculator.cjs'), oldString: 'a - b', newString: 'a + b' }) }] };
        else if (results.length === 2) {
          const name = tools.some(t => t.name === 'shell') ? 'shell' : 'bash';
          reply = { content: null, tool_calls: [{ name, arguments: argsFor(name, { command: 'node check.cjs', description: 'Run acceptance check' }) }] };
        }
        else {
          const token = results.at(-1).content.match(/VERIFY_TEST_OK_[a-f0-9]+/)?.[0];
          if (!token) throw new Error('Real OpenCode check tool did not return its token');
          reply = { content: token, tool_calls: [] };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: JSON.stringify(reply) }) });
      }
      return route.abort();
    });
    // Only the native login process receives a synthetic session. The following
    // run process must reopen the profile and find its persisted cookie itself.
    const marker = path.join(profile, '.fixture-session-seeded');
    let seeded = true;
    try { await access(marker); } catch { seeded = false; }
    if (!seeded) {
      await ctx.addCookies(Object.values(SITES).map(site => ({ name: 'SID', value: 'fixture-only', url: new URL(site.url).origin, secure: true, expires: Math.floor(Date.now() / 1000) + 3600 })));
      await writeFile(marker, 'Fixture session initialized once; subsequent processes must read the persistent cookie.');
    }
    return ctx;
  } };

const createBridge = settings => new BrowserBridge(settings, engine);
export default { ...createV2Plugin(createBridge), server: createPlugin(createBridge) };
