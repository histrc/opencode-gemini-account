import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { inlineImage, imagePayload, validateImages, saveGeneratedImage, downloadGeneratedAsset, MAX_IMAGES } from '../src/media.mjs';
import { preparePrompt } from '../src/protocol.mjs';
import { validateSettings } from '../src/settings.mjs';
import { createTransport, INTERNAL_BASE } from '../src/transport.mjs';
import { createMediaTools } from '../src/tools.mjs';
import { parseQuotaPanel } from '../src/quota.mjs';
import { TEST_PNG, TEST_IMAGE_URL } from './fixtures/png.mjs';

test('vision mode is opt-in and rejects unsupported values', () => {
  assert.equal(validateSettings().webVisionMode, 'current');
  assert.equal(validateSettings({ webVisionMode: 'flash-lite' }).webVisionMode, 'flash-lite');
  assert.throws(() => validateSettings({ webVisionMode: 'auto-fallback' }));
});

test('image input preserves placement and binary data without putting base64 into the prompt', () => {
  const prepared = preparePrompt({ model: 'web-current', messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image_url', image_url: { url: TEST_IMAGE_URL } }, { type: 'text', text: 'Then answer' }] }] }, validateSettings());
  assert.equal(prepared.images.length, 1);
  assert.deepEqual(prepared.images[0].buffer, TEST_PNG);
  assert.match(prepared.prompt, /Inspect this.*Attached image 1: image-1.png.*Then answer/s);
  assert.doesNotMatch(prepared.prompt, /base64,|iVBOR/);
});

test('image decoder rejects remote paths, corrupt encodings, mismatched MIME and oversized collections', () => {
  for (const url of ['https://example.com/a.png', 'file:///private/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', TEST_IMAGE_URL.replace('image/png', 'image/jpeg')]) assert.throws(() => inlineImage(url, 1));
  assert.throws(() => imagePayload(Buffer.alloc(10 * 1024 * 1024 + 1)), e => e.code === 'image_too_large');
  assert.throws(() => validateImages(Array.from({ length: MAX_IMAGES + 1 }, () => imagePayload(TEST_PNG))), e => e.code === 'images_too_large');
});

test('real AI SDK sends a PNG attachment through native custom fetch', async () => {
  let seen;
  const bridge = { async generate(backend, prompt, signal, options) { seen = { backend, prompt, options }; return 'RED'; } };
  const fetch = createTransport(bridge, validateSettings(), async () => ({ type: 'api', key: 'local-browser-session-v1' }));
  const provider = createOpenAICompatible({ name: 'gemini-account', baseURL: INTERNAL_BASE, apiKey: 'local', fetch });
  const result = await generateText({ model: provider('studio-current'), maxRetries: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image', image: TEST_PNG, mediaType: 'image/png' }] }] });
  assert.equal(result.text, 'RED'); assert.equal(seen.backend, 'studio');
  assert.deepEqual(seen.options.images[0].buffer, TEST_PNG);
});

test('generated image files have verified bytes and become native OpenCode attachments', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-image-'));
  try {
    const file = await saveGeneratedImage(directory, TEST_PNG);
    assert.deepEqual(await readFile(file.path), TEST_PNG);
    const tools = createMediaTools({ async generateImage() { return { text: 'Generated', images: [file] }; } }, validateSettings({}, directory));
    const result = await tools.gemini_generate_image.execute({ backend: 'web', prompt: 'A red square' }, { abort: new AbortController().signal, directory, async ask() {}, metadata() {} });
    assert.deepEqual(result.attachments, [{ type: 'file', mime: 'image/png', url: TEST_IMAGE_URL, filename: file.filename }]);
    assert.match(result.output, /图片已保存/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image downloads reject external assets and redirects before contacting them', async () => {
  let calls = 0;
  const context = { request: { async get() { calls++; return { status: () => 302, headers: () => ({ location: 'http://127.0.0.1/private' }), async dispose() {} }; } } };
  await assert.rejects(downloadGeneratedAsset(context, {}, 'https://evil.example/a.png'), e => e.code === 'image_download_failed');
  assert.equal(calls, 0);
  await assert.rejects(downloadGeneratedAsset(context, {}, 'https://lh3.googleusercontent.com/a.png'), e => e.code === 'image_download_failed');
  assert.equal(calls, 1);
});

test('quota parsing separates explicit balance, derived percentage and unknown meters', () => {
  assert.deepEqual(parseQuotaPanel('Usage limits\n25 images remaining').remaining, { value: 25, unit: 'images', basis: 'explicit-page-text', evidence: '25 images remaining' });
  assert.equal(parseQuotaPanel('Usage limits\nUsed: 30%').remaining.value, 70);
  assert.equal(parseQuotaPanel('使用限额\n剩余 12 次').remaining.value, 12);
  const unknown = parseQuotaPanel('AI Pro: up to 100 images per day. Refreshes in 2 hours.', [{ label: 'Five hour limit', value: 40, min: 0, max: 100 }]);
  assert.equal(unknown.remaining, null); assert.equal(unknown.status, 'not_reported');
  assert.equal(unknown.meters[0].value, 40);
  const labelled = parseQuotaPanel('Usage limits', [{ label: 'Weekly usage used', value: 3, min: 0, max: 4 }]);
  assert.equal(labelled.remaining.value, 25);
});

test('quota output redacts account identifiers and never invents balance from a rate-limit warning', () => {
  const result = parseQuotaPanel('Usage limits for private@example.com\nYou reached your usage limit. Refreshes in 1 hour.');
  assert.equal(result.remaining, null); assert.equal(result.status, 'limited');
  assert.doesNotMatch(JSON.stringify(result), /private@example/);
});
