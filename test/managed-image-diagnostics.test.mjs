import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseImage } from '../scripts/diagnose-image.mjs';
import { TEST_PNG } from './fixtures/png.mjs';

test('direct image diagnostic verifies image bytes and excludes chat and tool declarations', async () => {
  let calls = 0;
  const report = await diagnoseImage({ fetch: async (backend, url, init) => {
    calls++;
    assert.equal(backend, 'studio');
    assert.equal(url, 'https://managed-gemini.invalid/v1beta/models/gemini-3-pro-image:generateContent');
    const request = JSON.parse(init.body);
    assert.equal(request.tools, undefined);
    assert.equal(request.messages, undefined);
    assert.deepEqual(request.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } });
    return Response.json({ candidates: [{ content: { parts: [{ text: 'private text' }, { inlineData: { mimeType: 'image/png', data: TEST_PNG.toString('base64') } }] } }] });
  } }, 'gemini-3-pro-image');
  assert.equal(calls, 1);
  assert.equal(report.result, 'IMAGE_RECEIVED');
  assert.deepEqual(report.images, [{ mime: 'image/png', bytes: TEST_PNG.length }]);
  assert.doesNotMatch(JSON.stringify(report), /private|base64|iVBOR/);
});

test('direct image failures never retry, switch model or reveal upstream secrets', async () => {
  for (const [status, body, result] of [
    [403, { error: { message: 'The caller does not have permission: private@example.invalid Bearer fixture' } }, 'GOOGLE_PERMISSION_DENIED'],
    [200, { candidates: [{ content: { parts: [{ text: 'private@example.invalid' }] } }] }, 'NO_IMAGE_RETURNED'],
    [200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW52YWxpZA==' } }] } }] }, 'INVALID_IMAGE_RESPONSE'],
  ]) {
    let calls = 0;
    const report = await diagnoseImage({ fetch: async () => { calls++; return Response.json(body, { status }); } }, 'gemini-3-pro-image');
    assert.equal(report.result, result);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(report), /private|Bearer|fixture/);
  }
});
