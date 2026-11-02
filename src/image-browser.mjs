import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.mjs';
import { validateImages, MAX_OUTPUT_IMAGES, downloadGeneratedAsset, saveGeneratedImage } from './media.mjs';

async function fileInput(page) {
  const all = page.locator('input[type="file"]');
  const candidates = [];
  for (let i = 0, count = await all.count(); i < count; i++) {
    const input = all.nth(i), accept = (await input.getAttribute('accept') ?? '').toLowerCase();
    if (!accept || accept.includes('image') || /\.(png|jpe?g|webp|gif)/.test(accept)) candidates.push(input);
  }
  if (candidates.length > 1) throw new BridgeError('页面有多个图片上传控件，本轮未发送提示词', 422, 'image_upload_unavailable');
  return candidates[0];
}

export async function checkMediaConsent(page, site, visibleTarget) {
  if (await visibleTarget(page, site.uploadConsent ?? [])) throw new BridgeError('AI Studio 要求确认媒体版权及上传使用提示。本轮尚未发送生成请求；请在保留的网页中阅读并自行确认，再重新发起。插件不会自动点击同意。', 422, 'media_consent_required');
}

export async function uploadImages(page, site, images, signal, visibleTarget) {
  if (!images?.length) return;
  validateImages(images);
  signal.throwIfAborted();
  await checkMediaConsent(page, site, visibleTarget);
  let input = await fileInput(page);
  if (!input) {
    const menu = await visibleTarget(page, site.uploadButton);
    if (!menu) throw new BridgeError('未找到网页图片上传入口；请更新 uploadButton 选择器', 422, 'image_upload_unavailable');
    await menu.click();
    const deadline = Date.now() + 5000;
    let action;
    while (!(input = await fileInput(page)) && !(action = await visibleTarget(page, site.uploadAction))) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new BridgeError('未找到上传文件菜单项', 422, 'image_upload_unavailable');
      await delay(100, undefined, { signal });
    }
    if (!input && action) {
      const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
      chooser.catch(() => {});
      await action.click();
      const selected = await chooser;
      if (images.length > 1 && !selected.isMultiple()) throw new BridgeError('当前网页上传控件只接受单张图片', 422, 'image_upload_unavailable');
      await selected.setFiles(images.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    }
  }
  if (input) {
    if (images.length > 1 && await input.getAttribute('multiple') === null) throw new BridgeError('当前网页上传控件只接受单张图片', 422, 'image_upload_unavailable');
    await input.setInputFiles(images.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
  }
  const deadline = Date.now() + 30000;
  while (true) {
    signal.throwIfAborted();
    await checkMediaConsent(page, site, visibleTarget);
    let confirmed = true;
    for (const image of images) {
      const text = page.getByText(image.name, { exact: false });
      let found = false;
      for (let i = 0, count = await text.count(); i < count; i++) if (await text.nth(i).isVisible()) { found = true; break; }
      if (!found) {
        const labelled = page.locator(`[aria-label*="${image.name}"]`);
        for (let i = 0, count = await labelled.count(); i < count; i++) if (await labelled.nth(i).isVisible()) { found = true; break; }
      }
      if (!found) { confirmed = false; break; }
    }
    if (!confirmed && site.uploadPreview) {
      for (const selector of site.uploadPreview) {
        const ready = await page.locator(selector).evaluateAll(nodes => nodes.filter(n => n.complete && n.naturalWidth > 0 && n.getBoundingClientRect().width > 0).length);
        if (ready === images.length) { confirmed = true; break; }
      }
    }
    const busy = await visibleTarget(page, site.uploadBusy);
    if (confirmed && !busy) return;
    if (Date.now() >= deadline) throw new BridgeError('无法确认图片已上传完毕，本轮未发送提示词。请查看保留的页面。', 422, 'image_upload_incomplete');
    await delay(150, undefined, { signal });
  }
}

export async function generatedImageSources(page, site) {
  for (const selector of site.outputImages) {
    const images = await page.locator(selector).evaluateAll(nodes => nodes
      .filter(n => n.complete && n.naturalWidth >= 128 && n.naturalHeight >= 128 && n.getBoundingClientRect().width > 0)
      .map(n => ({ source: n.currentSrc || n.src, width: n.naturalWidth, height: n.naturalHeight })));
    const unique = [...new Map(images.filter(im => im.source).map(im => [im.source, im])).values()];
    if (unique.length) return unique.slice(0, MAX_OUTPUT_IMAGES);
  }
  return [];
}

export async function savePageImages(page, settings, sources, signal) {
  const files = [];
  try {
    for (const [index, image] of sources.entries()) {
      const buffer = await downloadGeneratedAsset(page.context(), page, image.source, signal);
      signal.throwIfAborted();
      files.push({ ...await saveGeneratedImage(settings.directory, buffer, index + 1), width: image.width, height: image.height, resolution: 'displayed-image' });
    }
    return files;
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    if (e instanceof BridgeError) throw e;
    // URLs may contain private signed parameters. Do not surface request logs.
    throw new BridgeError('生成图片下载失败；未自动重新生图，请查看保留的页面', 422, 'image_download_failed');
  }
}
