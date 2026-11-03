import { Effect, Stream } from 'effect';
import { OpenAICompatible } from '@opencode/ai/providers/openai-compatible';
import { HttpTransport, Framing } from '@opencode/ai/route';
import { AIError, InvalidRequestError } from '@opencode/ai/effect';
import { managedFailureMessage } from './managed-diagnostics.mjs';

const registry = Symbol.for('opencode-gemini-account.managed-transports');
const routes = globalThis[registry] ??= new Map();
export function registerManagedTransport(key, transport) {
  routes.set(key, transport);
  return () => routes.delete(key);
}

const failure = message => new AIError({ reason: new InvalidRequestError({ message }) });
export function model(modelID, settings) {
  const base = OpenAICompatible.configure({ provider: settings.providerID, baseURL: 'https://managed-gemini.invalid/v1', apiKey: 'local-managed-transport' }).model(modelID);
  return base.route.with({ transport: {
    id: 'gemini-managed-backend', prepare: input => HttpTransport.jsonRequestParts(input),
    execute: prepared => Effect.tryPromise({
      async try(signal) {
        const transport = routes.get(settings.transportKey);
        if (!transport) throw new Error('本机后端插件已卸载，请重启 OpenCode');
        const response = await transport(prepared.url, { method: 'POST', headers: prepared.headers, body: prepared.bodyText, signal });
        if (!response.ok || !response.body) {
          throw new Error(await managedFailureMessage(response, { modelID }));
        }
        return { frames: Framing.sse.frame(Stream.fromAsyncIterable(response.body, () => failure('模型流式连接中断；未自动重发'))) };
      },
      catch: error => failure(/^本机模型请求失败/.test(error?.message ?? '') ? error.message : '本机模型调用未完成；请检查后端和账号连接。本轮未自动重发。'),
    }),
  } }).model({ id: modelID });
}
