import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserBridge, isGenerationURL } from '../../src/browser.mjs';
import { validateSettings, SITES } from '../../src/settings.mjs';
import { imagePayload } from '../../src/media.mjs';
import { TEST_PNG, TEST_IMAGE_URL } from '../fixtures/png.mjs';

async function setup(backend, { images = true, quota = true, timeoutMs = 15000, multiple = true, quotaRoute = false, previewOnly = false, menuUpload = false, webVisionMode = 'current', modeControl = false, offeredMode = '3.5 Flash-Lite 极速回答', confirmMode = true, copyrightConsent = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-media-browser-'));
  const traffic = [];
  const engine = { async launchPersistentContext(profile) {
    const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.TEST_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    await ctx.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      traffic.push({ method: req.method(), url: req.url(), body: req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : undefined });
      if (req.method() === 'GET' && url.pathname === '/usage') return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><nav>Private conversation says 90% used</nav><main><h1>用量限额</h1><ul aria-label="用量周期"><li>当前用量info已使用 1%重置时间：22:24</li><li>每周限额重置时间：11月8日1:24已使用 2%</li></ul><p>Upgrade pricing must not be read as quota.</p></main>' });
      if (req.method() === 'GET' && url.origin === new URL(SITES[backend].url).origin) {
        const rpc = backend === 'web' ? 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' : 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent';
        const controls = backend === 'web' ? '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button">Send</button>' : '<ms-prompt-box><textarea></textarea></ms-prompt-box><ms-run-button><button>Run</button></ms-run-button><button role="switch" aria-label="Grounding with Google Search" aria-checked="false">Search</button>';
        const generated = backend === 'web' ? `<model-response><div class="markdown"><p>Answer</p>${images ? '<generated-image><img alt="AI-generated image" src="' + TEST_IMAGE_URL + '"></generated-image>' : 'Text answer only'}</div></model-response>` : `<ms-chat-turn><div class="model-prompt-container"><ms-text-chunk>Answer</ms-text-chunk>${images ? '<ms-image-chunk><img src="' + TEST_IMAGE_URL + '"></ms-image-chunk>' : ''}</div></ms-chat-turn>`;
        const html = `<!doctype html><meta charset="utf-8">${controls}<input type="file" accept="image/*" ${multiple ? 'multiple' : ''}><section id="uploads"></section><main></main><button id="settings">Settings</button><div id="quota"></div><script>
          let files=[], uploaded=false;
          document.querySelector('input[type=file]').onchange=async e=>{
            ${copyrightConsent ? "document.body.insertAdjacentHTML('beforeend','<div role=\"dialog\" id=\"copyright-acknowledgement-dialog\"><h2>Start creating with media</h2><button id=\"agree\">Agree to the copyright acknowledgement</button></div>');document.querySelector('#agree').onclick=()=>{document.body.dataset.agreed='true';};return;" : ''}
            document.querySelector('#uploads').innerHTML='<span class="upload-progress" role="progressbar">Uploading</span>';
            files=await Promise.all([...e.target.files].map(async f=>({name:f.name,size:f.size,type:f.type,data:Array.from(new Uint8Array(await f.arrayBuffer()))})));
            await fetch('/fixture-upload',{method:'POST',body:JSON.stringify({files})});
            uploaded=true;document.querySelector('#uploads').innerHTML=${previewOnly ? JSON.stringify('<uploader-file-preview><img alt="attachment" src="' + TEST_IMAGE_URL + '"></uploader-file-preview>') : "files.map(f=>'<span>'+f.name+'</span>').join('')"};
          };
          document.querySelector('button').onclick=async()=>{
            const prompt=${backend === 'web' ? "document.querySelector('.ql-editor').innerText" : "document.querySelector('textarea').value"};
            await fetch(${JSON.stringify(rpc)},{method:'POST',body:JSON.stringify({prompt,uploaded,files,mode:document.querySelector('#mode')?.getAttribute('aria-label')})});
            document.querySelector('main').innerHTML=${JSON.stringify(generated)};
          };
          document.querySelector('#settings').onclick=()=>{document.querySelector('#quota').innerHTML=${JSON.stringify(quota ? '<button role="menuitem" id="usage">Usage limits</button>' : '<span>No usage panel</span>')};const usage=document.querySelector('#usage');if(usage)usage.onclick=()=>{${quotaRoute ? "location.assign('/usage');" : "document.querySelector('#quota').innerHTML='<div role=\"dialog\"><h2>Usage limits</h2><p>30% used</p><p>Refreshes in 2 hours</p><div role=\"progressbar\" aria-label=\"Five-hour usage used\" aria-valuenow=\"30\" aria-valuemax=\"100\" style=\"width:200px;height:10px\"></div></div>';"}};};
          ${menuUpload ? "const detached=document.querySelector('input[type=file]');detached.remove();const upload=document.createElement('button');upload.setAttribute('aria-label','Upload and tools');document.body.append(upload);upload.onclick=()=>{const action=document.createElement('button');action.setAttribute('role','menuitem');action.textContent='Upload files';document.body.append(action);action.onclick=()=>detached.click();};" : ''}
          ${modeControl ? `const mode=document.createElement('button');mode.id='mode';mode.setAttribute('aria-label','打开模式选择器，当前模式为“Flash”');document.body.append(mode);mode.onclick=()=>{const option=document.createElement('button');option.setAttribute('role','menuitem');option.textContent=${JSON.stringify(offeredMode)};document.body.append(option);option.onclick=()=>{${confirmMode ? "mode.setAttribute('aria-label','打开模式选择器，当前模式为“Flash-Lite”');" : ''}option.remove();};};` : ''}
          </script>`;
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      if (req.method() === 'POST' && (url.pathname === '/fixture-upload' || isGenerationURL(req.url(), backend))) return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.abort();
    });
    await ctx.addCookies([{ name: 'SID', value: 'fixture-only', url: new URL(SITES[backend].url).origin, secure: true }]);
    return ctx;
  } };
  const bridge = new BrowserBridge(validateSettings({ timeoutMs, webVisionMode }, directory), engine);
  return { directory, bridge, traffic, async close() { await bridge.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('real Chromium: chooser menu uploads before accepting a filename-free thumbnail', async () => {
  const s = await setup('web', { previewOnly: true, menuUpload: true });
  try {
    await s.bridge.generate('web', 'Inspect this image', undefined, { images: [imagePayload(TEST_PNG)] });
    const calls = s.traffic.filter(r => r.method === 'POST' && isGenerationURL(r.url, 'web'));
    assert.equal(calls.length, 1); assert.equal(calls[0].body.uploaded, true);
    assert.deepEqual(Buffer.from(calls[0].body.files[0].data), TEST_PNG);
  } finally { await s.close(); }
});

for (const backend of ['web', 'studio']) {
  test(`real Chromium: ${backend} uploads exact image bytes before a single generation`, async () => {
    const s = await setup(backend);
    try {
      const result = await s.bridge.generate(backend, 'Inspect attached image', undefined, { images: [imagePayload(TEST_PNG)] });
      assert.equal(typeof result, 'string');
      const calls = s.traffic.filter(r => r.method === 'POST' && isGenerationURL(r.url, backend));
      assert.equal(calls.length, 1); assert.equal(calls[0].body.uploaded, true);
      assert.deepEqual(Buffer.from(calls[0].body.files[0].data), TEST_PNG);
      assert.equal(calls[0].body.files[0].name, 'image-1.png');
    } finally { await s.close(); }
  });

  test(`real Chromium: ${backend} image generation returns verified local files`, async () => {
    const s = await setup(backend);
    try {
      const result = await s.bridge.generateImage(backend, 'A red square');
      assert.equal(result.images.length, 1);
      assert.deepEqual(await readFile(result.images[0].path), TEST_PNG);
      assert.equal(result.images[0].width, 256); assert.equal(result.images[0].mime, 'image/png');
      assert.equal(s.traffic.filter(r => r.method === 'POST' && isGenerationURL(r.url, backend)).length, 1);
    } finally { await s.close(); }
  });
}

test('real Chromium: unsupported multi-file upload stops without a generation', async () => {
  const s = await setup('web', { multiple: false });
  try {
    await assert.rejects(s.bridge.generate('web', 'must not send', undefined, { images: [imagePayload(TEST_PNG, 1), imagePayload(TEST_PNG, 2)] }), e => e.code === 'image_upload_unavailable');
    assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
  } finally { await s.close(); }
});

test('real Chromium: image mode does not turn a text-only response into a fake image', async () => {
  const s = await setup('web', { images: false, timeoutMs: 1200 });
  try {
    await assert.rejects(s.bridge.generateImage('web', 'A red square'), e => e.code === 'generation_timeout');
    await assert.rejects(readdir(path.join(s.directory, 'generated')), e => e.code === 'ENOENT');
  } finally { await s.close(); }
});

test('real Chromium: quota comes from settings UI with zero generation requests', async () => {
  const s = await setup('web');
  try {
    const result = await s.bridge.inspectQuota('web');
    assert.equal(result.status, 'reported');
    assert.ok(result.buckets.some(b => b.value === 70 && b.unit === 'percent'));
    assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
    assert.equal((await s.bridge.context('web')).pages().filter(p => p.url() === SITES.web.url).length, 0);
  } finally { await s.close(); }
});

test('real Chromium: Studio quota stays unknown and never substitutes API limits', async () => {
  const s = await setup('studio');
  try {
    const result = await s.bridge.inspectQuota('studio');
    assert.equal(result.remaining, null); assert.equal(result.status, 'not_reported');
    assert.match(result.reason, /API/);
    assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
  } finally { await s.close(); }
});

test('real Chromium: dedicated quota route keeps cycles separate and excludes private sidebar text', async () => {
  const s = await setup('web', { quotaRoute: true });
  try {
    const result = await s.bridge.inspectQuota('web');
    assert.equal(result.status, 'reported'); assert.equal(result.remaining, null);
    assert.deepEqual(result.buckets.map(b => [b.label, b.value]), [['当前用量', 99], ['每周限额', 98]]);
    const { checkedAt, ...quota } = result;
    assert.doesNotMatch(JSON.stringify(quota), /Private|90|Upgrade/);
    assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
  } finally { await s.close(); }
});

test('real Chromium: opt-in vision mode selects and confirms exact Flash-Lite before upload', async () => {
  const s = await setup('web', { webVisionMode: 'flash-lite', modeControl: true });
  try {
    await s.bridge.generate('web', 'Inspect the image', undefined, { images: [imagePayload(TEST_PNG)] });
    const calls = s.traffic.filter(r => r.method === 'POST' && isGenerationURL(r.url, 'web'));
    assert.equal(calls.length, 1); assert.match(calls[0].body.mode, /Flash-Lite/);
    assert.equal(calls[0].body.uploaded, true);
  } finally { await s.close(); }
});

for (const [title, extra] of [['different version', { offeredMode: '3.6 Flash-Lite 极速回答' }], ['selection not confirmed', { confirmMode: false }]]) {
  test(`real Chromium: vision ${title} stops before uploading or sending`, async () => {
    const s = await setup('web', { webVisionMode: 'flash-lite', modeControl: true, ...extra });
    try {
      await assert.rejects(s.bridge.generate('web', 'Do not send', undefined, { images: [imagePayload(TEST_PNG)] }), e => e.code === 'web_vision_mode_unavailable');
      assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
    } finally { await s.close(); }
  });
}

test('real Chromium: vision mode choice does not force image-generation requests onto Flash-Lite', async () => {
  const s = await setup('web', { webVisionMode: 'flash-lite' });
  try {
    const result = await s.bridge.generateImage('web', 'Generate an image', undefined, { images: [imagePayload(TEST_PNG)] });
    assert.equal(result.images.length, 1);
  } finally { await s.close(); }
});

test('real Chromium: Studio copyright acknowledgement is preserved without accepting or generating', async () => {
  const s = await setup('studio', { copyrightConsent: true });
  try {
    await assert.rejects(s.bridge.generate('studio', 'Do not submit', undefined, { images: [imagePayload(TEST_PNG)] }), e => e.code === 'media_consent_required');
    assert.equal(s.traffic.filter(r => r.method === 'POST').length, 0);
    const page = s.bridge.lastPages.get('studio');
    assert.equal(await page.locator('#copyright-acknowledgement-dialog').isVisible(), true);
    assert.equal(await page.locator('body').getAttribute('data-agreed'), null);
  } finally { await s.close(); }
});
