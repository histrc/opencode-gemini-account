import { Plugin, Model, Provider } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from './src/managed-settings.mjs';
import { ManagedBackends, MANAGED_PROVIDERS } from './src/managed-backends.mjs';
import { registerManagedTransport } from './src/managed-runtime.mjs';
import { createSetupProgress } from './src/setup-progress.mjs';
import { managedImageTool } from './src/managed-image-tool.mjs';
import { createManagedImageBridge } from './src/managed-image-bridge.mjs';

export default Plugin.define({
  id: 'opencode-gemini-account',
  async setup(ctx) {
    const settings = await loadSettings();
    const manager = new ManagedBackends(settings);
    const cleanup = [];
    try {
      const images = await createManagedImageBridge(manager);
      cleanup.push(images.close);
      for (const backend of ['studio', 'web']) {
        const id = MANAGED_PROVIDERS[backend];
        const providerID = Provider.ID.make(id);
        const name = backend === 'studio' ? 'AI Studio 账号 · OpenCode' : 'Gemini 网页账号 · OpenCode';
        const transportKey = randomUUID();
        cleanup.push(registerManagedTransport(transportKey, (input, init) => manager.fetch(backend, input, init)));
        let catalog = await manager.cachedCatalog(backend);
        await ctx.provider.transform(editor => editor.add({
          info: { ...Provider.Info.empty(providerID), name, integrationID: id, activation: 'enabled',
            package: new URL('./src/managed-runtime.mjs', import.meta.url).href,
            settings: { transportKey, providerID: id, timeout: false, headerTimeout: false, chunkTimeout: false } },
          models: Object.entries(catalog).map(([modelID, entry]) => ({
            ...Model.Info.default(providerID, Model.ID.make(modelID)), name: entry.name ?? modelID,
            ...(entry.capabilities?.output?.image ? { type: 'image', package: '@opencode/ai/providers/google/images', settings: { baseURL: images.baseURL, apiKey: 'local-image-bridge' } } : {}),
            capabilities: { tools: Boolean(entry.capabilities?.toolcall), input: entry.capabilities?.input?.image ? ['text', 'image'] : ['text'], output: entry.capabilities?.output?.image ? ['text', 'image'] : ['text'], temperature: true },
            limit: { context: entry.limit.context, output: entry.limit.output },
          })),
        }));
        await ctx.integration.transform(editor => {
          editor.update(id, integration => { integration.name = name; });
          editor.method.update({ integrationID: id,
            method: { id: 'account', type: 'oauth', label: backend === 'studio' ? '登录 Google AI Studio（自动部署）' : '连接 Gemini 网页账号（自动部署）',
              form: [{ key: 'proxy', type: 'string', title: '网络代理（已有 TUN 可留空）', required: false, placeholder: 'http://127.0.0.1:7890' }] },
            async authorize(answer) {
              if (typeof answer?.proxy === 'string' && answer.proxy.trim()) {
                const value = new URL(answer.proxy.trim());
                if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(value.protocol) || value.username || value.password) throw new Error('网络代理格式无效');
                await mkdir(settings.directory, { recursive: true });
                const file = path.join(settings.directory, 'managed-network.json');
                let network = {};
                try { network = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                await writeFile(file, JSON.stringify({ ...network, proxy: value.href }), { mode: 0o600 });
              }
              const credential = { type: 'oauth', methodID: 'account', access: `managed-${backend}-v1`, refresh: `managed-${backend}-v1`, expires: 8640000000000000 };
              if (backend === 'studio') {
                const progress = await createSetupProgress(settings.directory);
                cleanup.push(progress.close);
                const callback = manager.connectStudio(progress.report).then(async () => {
                    catalog = await manager.catalog('studio');
                    await ctx.provider.reload();
                    await progress.finish();
                    return credential;
                  }).catch(async error => {
                    await progress.finish(error);
                    throw error;
                  });
                callback.catch(() => {});
                return { url: progress.url, mode: 'auto',
                  instructions: '请打开下面的本机进度页：会显示下载量、百分比、解压和安装阶段。Windows 登录浏览器首次约 470 MiB；完整下载会复用，中断会续传。准备结束后，在另一个登录窗口本人完成 Google 登录。网页原有登录不等于此后端已连接。', callback };
              }
              const ready = manager.ensure('web'); ready.catch(() => {});
              return { url: 'https://gemini.google.com/app', mode: 'code',
                instructions: '插件自动部署 Gemini Web 后端。请使用单独的隐私窗口登录 Gemini，按成熟后端的账号连接方式提供该专用会话的 Cookie；不要使用日常浏览器会话。仅保存在本机后端，无需填写 API 地址或服务密钥。',
                async callback(code) {
                  await ready; await manager.connectWeb(code);
                  catalog = await manager.catalog('web');
                  await ctx.provider.reload();
                  return credential;
                },
              };
            },
          });
        });
        // Activation reads cached metadata only. Even a nominally background
        // catalog refresh can synchronously inspect Windows processes and block
        // the host's five-second activation deadline. Connect and actual model
        // requests own backend startup; successful sign-in refreshes the catalog.
      }
      await ctx.tool.transform(editor => editor.add(managedImageTool(ctx, manager, settings)));
      return () => { cleanup.forEach(fn => fn()); };
    } catch (error) { cleanup.forEach(fn => fn()); throw error; }
  },
});
