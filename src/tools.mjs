import { z } from 'zod';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { BridgeError } from './errors.mjs';
import { readImageFile, validateImages } from './media.mjs';
import { siteForModel } from './models.mjs';

// Tool definitions use the same public Zod shape as @opencode-ai/plugin/tool.
export function createMediaTools(bridge, settings) {
  return {
    gemini_generate_image: {
      description: '通过已登录的 Gemini 网页账号生成图片，保存真实图片并作为文件附件返回。默认使用 Gemini Web；Studio 必须显式选择具有生图能力且已配置的型号。可用本地参考图片进行图像编辑。会使用真实网页额度，不自动重试。',
      args: {
        prompt: z.string().min(1).max(settings.maxPromptChars),
        backend: z.enum(['web', 'studio']).default('web'),
        studioModel: z.string().optional(),
        referenceImages: z.array(z.string()).max(4).optional(),
      },
      async execute(args, context) {
        context.abort.throwIfAborted();
        if (args.backend === 'studio' && !args.studioModel) throw new BridgeError('Studio 生图需要 studioModel，且该 ID 已加入 studioModels；请在网页确认该型号支持图片输出。');
        if (args.backend === 'web' && args.studioModel) throw new BridgeError('Gemini Web 不接受 studioModel');
        siteForModel(settings, args.backend, args.studioModel);
        const images = [];
        try {
          for (const [index, file] of (args.referenceImages ?? []).entries()) {
            const actual = await realpath(path.resolve(context.directory, file));
            await context.ask({ permission: 'read', patterns: [actual], always: [], metadata: { path: actual, purpose: 'Gemini reference image upload' } });
            images.push(await readImageFile(actual, index + 1));
          }
          validateImages(images);
          context.metadata({ title: 'Gemini 网页生图', metadata: { backend: args.backend, referenceCount: images.length } });
          const result = await bridge.generateImage(args.backend, args.prompt, context.abort, { upstreamModel: args.studioModel, images });
          context.abort.throwIfAborted();
          if (!result?.images?.length) throw new BridgeError('网页没有返回可确认的生成图片', 422, 'image_not_generated');
          return {
            title: `生成 ${result.images.length} 张图片`,
            output: [result.text, ...result.images.map(im => `图片已保存：${im.path}`)].filter(Boolean).join('\n'),
            metadata: { backend: args.backend, images: result.images },
            attachments: await Promise.all(result.images.map(async im => ({ type: /** @type {const} */ ('file'), mime: im.mime, url: `data:${im.mime};base64,${(await readFile(im.path)).toString('base64')}`, filename: im.filename }))),
          };
        } catch (e) {
          if (context.abort.aborted) throw context.abort.reason;
          if (e instanceof BridgeError) throw e;
          throw new BridgeError('生图未完成；请检查参考图片、登录状态和保留的页面。没有自动重新生成。', 422, 'image_operation_failed');
        }
      },
    },
    gemini_usage: {
      description: '读取已登录 Gemini 网页设置中实际显示的使用限额与刷新说明，不发送生成请求。不按套餐或本地调用次数推算余额。若网页未显示或 Studio 没有可靠的网页账号数据，返回 remaining=null（未知）；不混用 Developer API 项目限额。',
      args: { backend: z.enum(['web', 'studio']).default('web') },
      async execute(args, context) {
        const result = await bridge.inspectQuota(args.backend, context.abort);
        return { title: 'Gemini 网页使用限额', output: JSON.stringify(result, null, 2), metadata: { backend: args.backend, status: result.status } };
      },
    },
  };
}
