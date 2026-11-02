import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, stat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeError } from './errors.mjs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGES = 10;
export const MAX_OUTPUT_IMAGES = 4;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function imageType(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  throw new BridgeError('图片格式无法确认；仅支持 PNG、JPEG、WebP、GIF', 400, 'invalid_image');
}

export function imagePayload(buffer, index = 1, declaredType) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new BridgeError('单张图片必须在 10 MiB 以内', 413, 'image_too_large');
  const mimeType = imageType(buffer);
  if (declaredType && declaredType !== mimeType) throw new BridgeError('图片内容与声明的 MIME 类型不一致', 400, 'invalid_image');
  return { name: `image-${index}.${extensions[mimeType]}`, mimeType, buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

export function inlineImage(url, index) {
  if (typeof url !== 'string') throw new BridgeError('图片地址无效', 400, 'invalid_image');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4) throw new BridgeError('图片需由 OpenCode 以 base64 data URL 提供；不自动下载外部图片地址', 400, 'invalid_image');
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new BridgeError('单张图片超过 10 MiB', 413, 'image_too_large');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.toString('base64') !== match[2]) throw new BridgeError('图片 base64 编码无效', 400, 'invalid_image');
  return imagePayload(buffer, index, match[1]);
}

export function validateImages(images) {
  if (images.length > MAX_IMAGES || images.reduce((sum, im) => sum + im.buffer.length, 0) > MAX_TOTAL_IMAGE_BYTES) throw new BridgeError('每轮最多 10 张图片，总计不超过 20 MiB', 413, 'images_too_large');
  return images;
}

export async function readImageFile(file, index = 1) {
  const actual = await realpath(file);
  const info = await stat(actual);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new BridgeError('参考图片必须是 10 MiB 以内的普通文件', 413, 'image_too_large');
  return imagePayload(await readFile(actual), index);
}

export async function saveGeneratedImage(directory, buffer, index = 1) {
  const payload = imagePayload(buffer, index);
  const folder = path.join(directory, 'generated', randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, payload.name);
  await writeFile(file, payload.buffer, { mode: 0o600, flag: 'wx' });
  return { path: file, url: pathToFileURL(file).href, mime: payload.mimeType, filename: payload.name, bytes: payload.buffer.length, sha256: payload.sha256 };
}

function allowedAsset(url) {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
    (url.hostname === 'gemini.google.com' || url.hostname === 'aistudio.google.com' || /(^|\.)(googleusercontent\.com|gstatic\.com)$/.test(url.hostname));
}

export async function downloadGeneratedAsset(context, page, source, signal) {
  signal?.throwIfAborted();
  if (source.startsWith('data:')) return inlineImage(source, 1).buffer;
  const url = new URL(source);
  if (url.protocol === 'blob:') {
    if (url.origin !== new URL(page.url()).origin) throw new BridgeError('图片 blob 不属于当前网页', 422, 'image_download_failed');
    const base64 = await page.evaluate(async ({ source, maxBytes }) => {
      const response = await fetch(source);
      const blob = await response.blob();
      if (blob.size > maxBytes) throw new Error('Image too large');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    }, { source, maxBytes: MAX_IMAGE_BYTES });
    signal?.throwIfAborted();
    return imagePayload(Buffer.from(base64, 'base64')).buffer;
  }
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedAsset(current)) throw new BridgeError('生成图片地址不属于受支持的 Google 图片域名', 422, 'image_download_failed');
    const response = await context.request.get(current.href, { timeout: 15000, maxRedirects: 0 });
    try {
      signal?.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        const location = response.headers().location;
        if (!location) throw new Error('Missing redirect');
        current = new URL(location, current); continue;
      }
      if (!response.ok() || Number(response.headers()['content-length'] ?? 0) > MAX_IMAGE_BYTES) throw new Error('Download failed');
      const data = await response.body(); signal?.throwIfAborted();
      return imagePayload(data).buffer;
    } finally { await response.dispose(); }
  }
  throw new BridgeError('生成图片的跳转次数超出限制', 422, 'image_download_failed');
}
