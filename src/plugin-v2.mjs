import { Plugin, Model, Provider } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadSettings, PROVIDER } from './settings.mjs';
import { createBridge as createDefaultBridge } from './create-bridge.mjs';
import { acquireBridge } from './bridge-pool.mjs';
import { modelCatalog } from './models.mjs';
import { createTransport, INTERNAL_BASE } from './transport.mjs';
import { createMediaTools } from './tools.mjs';
import { loginLabel } from './auth.mjs';
import { registerTransport } from './runtime-v2.mjs';

export function createV2Plugin(createBridge = createDefaultBridge) {
  return Plugin.define({
    id: 'opencode-gemini-account',
    async setup(ctx) {
      const settings = await loadSettings();
      const lease = acquireBridge(settings, () => createBridge(settings));
      let unregister = () => {};
      try {
        const transport = createTransport(lease.bridge, settings, async () => {
          const connection = await ctx.integration.connection.active(PROVIDER);
          const credential = connection && await ctx.integration.connection.resolve(connection);
          return credential?.type === 'oauth' && credential.access === 'local-browser-session-v1'
            ? { type: 'api', key: credential.access } : undefined;
        });
        const providerID = Provider.ID.make(PROVIDER);
        const transportKey = randomUUID();
        unregister = registerTransport(transportKey, transport);
        await ctx.provider.transform(editor => editor.add({
          info: {
            ...Provider.Info.empty(providerID), name: 'Gemini Account (experimental)',
            integrationID: PROVIDER, activation: 'enabled', package: new URL('./runtime-v2.mjs', import.meta.url).href,
            settings: { transportKey, timeout: false, headerTimeout: false, chunkTimeout: false },
          },
          models: Object.entries(modelCatalog(settings)).map(([id, model]) => ({
            ...Model.Info.default(providerID, Model.ID.make(id)), name: model.name,
            capabilities: { tools: model.tools, input: settings.connectionMode === 'extension' ? ['text'] : ['text', 'image'], output: ['text'], temperature: false },
            limit: { context: 32768, output: 8192 },
          })),
        }));
        await ctx.integration.transform(editor => {
          editor.update(PROVIDER, integration => { integration.name = 'Gemini Account (experimental)'; });
          const backends = settings.connectionMode === 'extension' ? ['studio'] : ['studio', 'web'];
          for (const backend of backends) editor.method.update({
            integrationID: PROVIDER,
            method: { id: backend, type: 'oauth', label: loginLabel(backend, settings.connectionMode) },
            async authorize() {
              const page = await lease.bridge.openLogin(backend);
              return {
                url: settings.sites[backend].url, mode: 'auto',
                instructions: settings.connectionMode === 'extension'
                  ? '请在正常 Edge 中打开 AI Studio，确认本地扩展已安装并填入配对令牌。登录由正常浏览器完成，插件不会读取 Cookie。'
                  : '请在插件打开的独立 Edge/Chrome 窗口本人登录 Google，等待输入框出现。如页面加载失败，请检查网络并在该窗口刷新。无需 API Key。',
                callback: lease.bridge.waitLogin(backend, page).then(async () => {
                  // Standalone V2 auth terminates its server immediately after
                  // returning. Close an idle context first so Chromium flushes
                  // the persistent login before that process exits.
                  if (settings.connectionMode === 'browser' && !lease.bridge.queues.has(backend)) await page.context().close();
                  return { type: 'oauth', methodID: backend, access: 'local-browser-session-v1',
                    refresh: 'local-browser-session-v1', expires: 8640000000000000 };
                }),
              };
            },
          });
        });
        const tools = settings.connectionMode === 'extension' ? {} : createMediaTools(lease.bridge, settings);
        await ctx.tool.transform(editor => {
          for (const [name, tool] of Object.entries(tools)) {
            const schema = z.object(tool.args);
            editor.add({
              name, description: tool.description, input: z.toJSONSchema(schema),
              async execute(input, context) {
                const result = await tool.execute(schema.parse(input), {
                  directory: ctx.location.directory, abort: context.signal,
                  metadata: update => { void context.progress(update); },
                  ask: request => ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
                    source: { type: 'tool', messageID: context.messageID, id: context.id },
                    action: request.permission, resources: request.patterns, save: request.always, metadata: request.metadata }),
                });
                return { content: [
                  { type: 'text', text: result.output },
                  ...(result.attachments ?? []).map(file => ({ type: 'file', uri: file.url, mime: file.mime, name: file.filename })),
                ], metadata: { ...result.metadata, title: result.title } };
              },
            });
          }
        });
        return async () => { unregister(); await lease.release(); };
      } catch (error) { unregister(); await lease.release(); throw error; }
    },
  });
}

export default createV2Plugin();
