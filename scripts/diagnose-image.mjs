import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSettings } from '../src/managed-settings.mjs';
import { ManagedBackends } from '../src/managed-backends.mjs';
import { classifyFailure, readBoundedJSON } from '../src/managed-diagnostics.mjs';
import { inlineImage } from '../src/media.mjs';

// A single direct image request, independent of the chat model and function calls.
// Never log upstream text, inline image data, account identifiers or credentials.
export async function diagnoseImage(manager, model) {
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid model ID');
  const started = Date.now();
  let http;
  try {
    const response = await manager.fetch('studio', `https://managed-gemini.invalid/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(600000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Generate an original illustration of a small cafe on a rainy night, no text.' }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
      }),
    });
    http = response.status;
    const body = await readBoundedJSON(response, 32 * 1024 * 1024, 600000);
    if (!response.ok) return { model, http, result: classifyFailure(http, body), elapsedMs: Date.now() - started };
    if (!body || body.error || !Array.isArray(body.candidates)) return { model, http, result: 'INVALID_RESPONSE', elapsedMs: Date.now() - started };
    const images = [];
    for (const candidate of body.candidates) {
      for (const part of candidate.content?.parts ?? []) {
        if (!part.inlineData) continue;
        const image = inlineImage(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, images.length + 1);
        images.push({ mime: image.mimeType, bytes: image.buffer.length });
      }
    }
    return { model, http, result: images.length ? 'IMAGE_RECEIVED' : 'NO_IMAGE_RETURNED', images, elapsedMs: Date.now() - started };
  } catch (error) {
    return { model, ...(http !== undefined ? { http } : {}), result: error?.name === 'TimeoutError' ? 'TIMEOUT' : http === 200 ? 'INVALID_IMAGE_RESPONSE' : 'LOCAL_OR_CONNECTION_ERROR', elapsedMs: Date.now() - started };
  }
}

async function main() {
  let progress;
  try {
    const args = process.argv.slice(2);
    const live = args.includes('--live');
    const index = args.indexOf('--model');
    const model = index >= 0 ? args[index + 1] : undefined;
    const expected = [...(live ? ['--live'] : []), ...(index >= 0 ? ['--model', model] : [])];
    if (args.length !== expected.length || args.some(arg => !expected.includes(arg)) || (index >= 0 && (!model || model.startsWith('--')))) throw new Error('Invalid arguments');
    const manager = new ManagedBackends(await loadSettings());
    const catalog = await manager.cachedCatalog('studio');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify({ plugin: pkg.version, node: process.version, backend: await manager.status('studio'), imageModels: Object.entries(catalog).filter(([, entry]) => entry?.capabilities?.output?.image).map(([id, entry]) => ({ id, name: entry.name })) }, null, 2));
    if (!live) { console.log('未发送生成请求。直接生图诊断：node scripts/diagnose-image.mjs --live --model gemini-3-pro-image'); return; }
    if (!model || !catalog[model]?.capabilities?.output?.image) { console.error('请用 --model 指定上面列出的图片模型 ID；目录缺失时先完成账号连接。'); process.exitCode = 1; return; }
    console.log(`即将直接调用 ${model}，16:9、默认分辨率。会使用生图额度；不发送聊天请求或函数声明，不换型号、不自动重发、不保存图片或上传记录。`);
    progress = setInterval(() => console.log('仍在等待图片模型响应……'), 15000);
    const report = await diagnoseImage(manager, model);
    console.log(JSON.stringify(report));
    console.log('IMAGE_RECEIVED 表示直接请求收到已检查文件头的图片；OpenCode 聊天 → 工具 → 图片的完整链路仍需单独验证。');
    if (report.result !== 'IMAGE_RECEIVED') process.exitCode = 1;
  } catch { console.error('诊断未完成。请在 0.8.1 或以上插件目录执行：node scripts/diagnose-image.mjs --live --model gemini-3-pro-image。未显示原始错误或凭据。'); process.exitCode = 1; }
  finally { clearInterval(progress); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
