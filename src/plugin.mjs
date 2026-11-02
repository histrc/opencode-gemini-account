// @ts-check
import { loadSettings, PROVIDER } from './settings.mjs';
import { createBridge as createDefaultBridge } from './create-bridge.mjs';
import { acquireBridge } from './bridge-pool.mjs';
import { createTransport, INTERNAL_BASE } from './transport.mjs';
import { modelCatalog } from './models.mjs';
import { createAuthMethods } from './auth.mjs';
import { createMediaTools } from './tools.mjs';

/** @returns {import('@opencode-ai/plugin').Plugin} */
export function createPlugin(createBridge = createDefaultBridge) {
  return async () => {
    const settings = await loadSettings();
    const lease = acquireBridge(settings, () => createBridge(settings));
    const bridge = lease.bridge;
    /** @type {() => Promise<any>} */
    let readAuth = async () => undefined;
    // OpenCode can retain config.options.fetch after merging auth.loader options.
    // Both paths must observe the live auth reader, not a permanently empty one.
    const transport = createTransport(bridge, settings, () => readAuth());
    return {
      tool: settings.connectionMode === 'extension' ? {} : createMediaTools(bridge, settings),
      config: async config => {
        config.provider ??= {};
        const models = modelCatalog(settings);
        config.provider[PROVIDER] = {
          ...config.provider[PROVIDER], name: 'Gemini Account (experimental)',
          npm: '@ai-sdk/openai-compatible',
          options: {
            ...config.provider[PROVIDER]?.options, baseURL: INTERNAL_BASE, maxRetries: 0,
            // The host skips auth.loader before first connection. Keep even that
            // path in-process and explain /connect instead of resolving .invalid.
            fetch: transport,
          },
          models: Object.fromEntries(Object.entries(models).map(([id, m]) => [id, {
            name: m.name, tool_call: m.tools, attachment: settings.connectionMode !== 'extension', reasoning: false, temperature: false,
            // Conservative client budgets, not measured upstream model limits.
            limit: { context: 32768, output: 8192 },
            modalities: { input: settings.connectionMode === 'extension' ? ['text'] : ['text', 'image'], output: ['text'] },
          }])),
        };
      },
      auth: {
        provider: PROVIDER,
        methods: createAuthMethods(bridge, settings),
        loader: async getAuth => {
          readAuth = getAuth;
          const auth = await getAuth();
          if (auth?.type !== 'api' || auth.key !== 'local-browser-session-v1') return {};
          // The in-process fetch buffers the website response. BrowserBridge owns
          // its deadline; a host header timer must not cause a duplicate request.
          return { apiKey: 'local-browser-session-v1', baseURL: INTERNAL_BASE, timeout: false, headerTimeout: false, chunkTimeout: false, fetch: transport };
        },
      },
      dispose: () => lease.release(),
    };
  };

}

export default createPlugin();
