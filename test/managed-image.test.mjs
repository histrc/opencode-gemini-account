import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { make } from '@opencode/ai';
import { Media } from '@opencode/ai/effect';
import * as Google from '@opencode/ai/providers/google';
import { createManagedImageBridge } from '../src/managed-image-bridge.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { managedImageTool, selectImageModel } from '../src/managed-image-tool.mjs';
import { TEST_PNG } from './fixtures/png.mjs';

const imageID = 'gemini-test-image';
const catalog = { [imageID]: { capabilities: { output: { image: true } } }, 'gemini-chat': { capabilities: { output: { image: false } } } };
const output = () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TEST_PNG.toString('base64') } }] }, finishReason: 'STOP' }] });

test('native image protocol preserves reference bytes, aspect and resolution and decodes real image data', async () => {
  const ai = make();
  let calls = 0;
  const bridge = await createManagedImageBridge({ fetch: async (backend, url, init) => {
    calls++;
    assert.equal(backend, 'studio');
    assert.equal(url, `https://managed-gemini.invalid/v1beta/models/${imageID}:generateContent`);
    const body = JSON.parse(new TextDecoder().decode(init.body));
    assert.equal(body.contents[0].parts[0].text, 'edit the fixture');
    assert.equal(body.contents[0].parts[1].inlineData.data, TEST_PNG.toString('base64'));
    assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '1K' });
    return output();
  } });
  try {
    const result = await ai.image.generate({ model: Google.configure({ baseURL: bridge.baseURL, apiKey: 'fixture' }).image(imageID), prompt: 'edit the fixture',
      images: [Media.bytes(TEST_PNG, 'image/png')], aspect: '16:9', resolution: '1K' });
    assert.equal(result.images.length, 1);
    assert.deepEqual(Buffer.from(await ai.bytes(result.image)), TEST_PNG);
    assert.equal(calls, 1);
  } finally { bridge.close(); await ai.dispose(); }
});

test('image failure and cancellation never resubmit a generation', async () => {
  for (const abort of [false, true]) {
    const ai = make(), controller = new AbortController();
    let calls = 0;
    const bridge = await createManagedImageBridge({ fetch: async (_backend, _url, init) => {
      calls++;
      if (!abort) return new Response('unavailable', { status: 503 });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        controller.abort();
      });
    } });
    try {
      await assert.rejects(ai.image.generate({ model: Google.configure({ baseURL: bridge.baseURL, apiKey: 'fixture' }).image(imageID), prompt: 'fixture' }, { signal: controller.signal }));
      assert.equal(calls, 1);
    } finally { bridge.close(); await ai.dispose(); }
  }
});

test('loopback image adapter rejects wrong tokens, browser origins and methods without reaching the backend', async () => {
  let calls = 0;
  const bridge = await createManagedImageBridge({ fetch: async () => { calls++; return output(); } });
  try {
    const url = `${bridge.baseURL}/models/${imageID}:generateContent`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.invalid' } })).status, 404);
    assert.equal((await fetch(url.replace(/\/[a-f0-9]{64}\//, '/wrong/'), { method: 'POST' })).status, 404);
    assert.equal(calls, 0);
  } finally { bridge.close(); }
});

test('managed image route rejects foreign endpoints and text models, and supplies only local credentials upstream', async () => {
  let calls = 0, starts = 0;
  const manager = new ManagedBackends({ directory: tmpdir() }, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, `http://127.0.0.1:39000/v1beta/models/${imageID}:generateContent`);
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-local-key' });
    assert.equal(init.redirect, 'error');
    return output();
  } });
  manager.cachedCatalog = async () => catalog;
  manager.catalog = async () => catalog;
  manager.ensure = async () => { starts++; return { baseURL: 'http://127.0.0.1:39000/v1', apiKey: 'fixture-local-key' }; };
  const init = { method: 'POST', headers: { 'x-goog-api-key': 'must-not-forward', Cookie: 'must-not-forward' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'fixture' }] }] }) };
  for (const url of ['https://evil.invalid/v1/chat/completions', `https://managed-gemini.invalid/v1beta/models/${imageID}:generateContent?key=bad`, 'https://managed-gemini.invalid/v1beta/models/gemini-chat:generateContent']) await assert.rejects(manager.fetch('studio', url, init));
  await assert.rejects(manager.fetch('web', `https://managed-gemini.invalid/v1beta/models/${imageID}:generateContent`, init));
  assert.equal(starts, 0); assert.equal(calls, 0);
  assert.equal((await manager.fetch('studio', `https://managed-gemini.invalid/v1beta/models/${imageID}:generateContent`, init)).status, 200);
  assert.equal(calls, 1);
});

test('image tool checks reference permissions, saves verified bytes and returns a native attachment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-image-tool-'));
  const reference = path.join(directory, 'reference.png');
  let calls = 0, permissions = 0;
  await writeFile(reference, TEST_PNG);
  const controller = new AbortController();
  const ctx = { location: { directory }, permission: { assert: async request => { permissions++; assert.equal(request.action, 'read'); assert.equal(request.resources[0], reference); } },
    experimental: { generate: { image: async (request, options) => {
      calls++;
      assert.equal(permissions, 1);
      assert.equal(options.signal, controller.signal);
      assert.equal(request.model.id, imageID);
      assert.equal(request.images[0].data, TEST_PNG.toString('base64'));
      assert.equal(request.n, 1);
      return { images: [{ data: TEST_PNG.toString('base64'), mime: 'image/png' }] };
    } } } };
  const tool = managedImageTool(ctx, { cachedCatalog: async () => catalog }, { directory });
  const context = { signal: controller.signal, progress: async () => {}, sessionID: 'fixture', agent: 'fixture', messageID: 'fixture', id: 'fixture' };
  try {
    const result = await tool.execute({ prompt: 'fixture', model: imageID, referenceImages: ['reference.png'] }, context);
    assert.equal(calls, 1);
    assert.deepEqual(await readFile(result.metadata.images[0].path), TEST_PNG);
    assert.equal(result.content.filter(item => item.type === 'file').length, 1);
    assert.equal(result.content[1].uri, `data:image/png;base64,${TEST_PNG.toString('base64')}`);
    for (const file of ['https://example.invalid/private.png', '\\\\example.invalid\\share\\image.png']) await assert.rejects(tool.execute({ prompt: 'fixture', referenceImages: [file] }, context), /本地文件路径/);
    assert.equal(permissions, 1);
    ctx.permission.assert = async () => { throw new Error('fixture denied'); };
    await assert.rejects(tool.execute({ prompt: 'fixture', referenceImages: ['reference.png'] }, context), /fixture denied/);
    assert.equal(calls, 1);
    assert.throws(() => selectImageModel(catalog, 'gemini-chat'), /可用生图模型/);
    assert.equal(selectImageModel({ ...catalog, [imageID]: { ...catalog[imageID], name: 'Nano Banana Pro' } }, 'nano banana pro'), imageID);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
