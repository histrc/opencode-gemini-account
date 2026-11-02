import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { readImageFile, validateImages, saveGeneratedImage, inlineImage } from './media.mjs';

export const imageToolSchema = z.object({
  prompt: z.string().min(1).max(120000),
  model: z.string().trim().min(1).optional().describe('可用的 AI Studio 生图型号 ID 或目录显示名称，例如 Nano Banana Pro。可用 model_list 查询 image 类型；省略时优先使用 Nano Banana 2 Lite'),
  referenceImages: z.array(z.string()).max(4).optional().describe('需要编辑或参考的本地图片路径'),
  aspect: z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/).optional().describe('宽高比，例如 1:1、16:9、9:16'),
  resolution: z.enum(['512', '1K', '2K', '4K']).optional().describe('由所选型号支持的尺寸档位；省略时由模型决定'),
}).strict();

export function selectImageModel(catalog, requested) {
  const available = Object.keys(catalog).filter(id => catalog[id]?.capabilities?.output?.image);
  if (requested) {
    const selected = available.find(id => id === requested || catalog[id].name?.toLowerCase() === requested.trim().toLowerCase());
    if (!selected) throw new Error('所选型号未列为可用生图模型，请重新连接以刷新目录');
    return selected;
  }
  const preferred = ['gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];
  const model = preferred.find(id => available.includes(id)) ?? available[0];
  if (!model) throw new Error('尚无可用生图模型，请在 /connect 连接 AI Studio 账号');
  return model;
}

export function managedImageTool(ctx, manager, settings) {
  return {
    name: 'gemini_generate_image',
    description: '用已连接的 AI Studio 账号生成或编辑真实图片，保存到本机并返回图片附件。支持本地参考图、宽高比和分辨率。文字对话使用此工具即可生图，不需要切换聊天模型。每次生成一张，不自动重试；失败后不要擅自换型号重复生成。',
    input: z.toJSONSchema(imageToolSchema),
    async execute(raw, context) {
      const args = imageToolSchema.parse(raw);
      context.signal.throwIfAborted();
      let catalog = await manager.cachedCatalog('studio');
      if (!Object.values(catalog).some(entry => entry?.capabilities?.output?.image)) catalog = await manager.catalog('studio', { install: true });
      const modelID = selectImageModel(catalog, args.model);
      const reference = [];
      for (const [index, file] of (args.referenceImages ?? []).entries()) {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(file) || /^\\\\|^\/\//.test(file)) throw new Error('参考图只支持本地文件路径，不支持网络地址');
        const requested = path.resolve(ctx.location.directory, file);
        const allowRead = actual => ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
          source: { type: 'tool', messageID: context.messageID, id: context.id },
          action: 'read', resources: [actual], save: [], metadata: { path: actual, purpose: 'AI Studio reference image' } });
        await allowRead(requested);
        const actual = await realpath(requested);
        if (actual !== requested) await allowRead(actual);
        reference.push(await readImageFile(actual, index + 1));
      }
      validateImages(reference);
      await context.progress({ title: 'AI Studio 正在生图', metadata: { model: modelID, referenceCount: reference.length } });
      const result = await ctx.experimental.generate.image({
        model: { providerID: 'aistudio-account', id: modelID }, prompt: args.prompt, n: 1,
        ...(args.aspect ? { aspect: args.aspect } : {}), ...(args.resolution ? { resolution: args.resolution } : {}),
        ...(reference.length ? { images: reference.map(image => ({ data: image.buffer.toString('base64'), mime: image.mimeType, name: image.name })) } : {}),
      }, { signal: context.signal });
      context.signal.throwIfAborted();
      if (!result?.images?.length) throw new Error('生图未返回可保存的图片；未自动重新生成');
      const images = [];
      const content = [];
      for (const [index, image] of result.images.entries()) {
        const payload = inlineImage(`data:${image.mime};base64,${image.data}`, index + 1);
        const saved = await saveGeneratedImage(settings.directory, payload.buffer, index + 1);
        images.push(saved);
        content.push({ type: 'file', uri: `data:${saved.mime};base64,${image.data}`, mime: saved.mime, name: saved.filename });
      }
      return { content: [{ type: 'text', text: images.map(image => `图片已保存：${image.path}`).join('\n') }, ...content],
        metadata: { title: `已生成 ${images.length} 张图片`, model: modelID, referenceCount: reference.length, images } };
    },
  };
}
