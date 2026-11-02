import { Effect, Stream } from 'effect';
import { OpenAICompatible } from '@opencode/ai/providers/openai-compatible';
import { HttpTransport, Framing } from '@opencode/ai/route';
import { AIError, InvalidRequestError } from '@opencode/ai/effect';
import { INTERNAL_BASE } from './transport.mjs';

const registry = Symbol.for('opencode-gemini-account.v2-transports');
const transports = globalThis[registry] ??= new Map();
export function registerTransport(key, transport) {
  transports.set(key, transport);
  return () => { if (transports.get(key) === transport) transports.delete(key); };
}

// Native OpenCode 2 route: compile Chat Completions with its own protocol,
// execute in-process, then feed the buffered reply back to its native parser.
// No HTTP listener, global fetch patch or outbound .invalid request is used.
export function model(modelID, settings) {
  const base = OpenAICompatible.configure({ provider: 'gemini-account', baseURL: INTERNAL_BASE, apiKey: 'local-browser-session-v1' }).model(modelID);
  const transport = {
    id: 'gemini-account-browser',
    prepare: input => HttpTransport.jsonRequestParts(input),
    execute: prepared => Effect.tryPromise({
      async try(signal) {
        const fetch = transports.get(settings.transportKey);
        if (!fetch) throw new Error('浏览器插件已卸载，请重新加载 OpenCode');
        const response = await fetch(prepared.url, { method: 'POST', headers: prepared.headers, body: prepared.bodyText, signal });
        if (!response.ok) {
          const error = (await response.json()).error;
          // createTransport returns only sanitized local errors.
          throw new Error(`${error.code}: ${error.message}`);
        }
        return { frames: Framing.sse.frame(Stream.make(new TextEncoder().encode(await response.text()))) };
      },
      catch: error => new AIError({ reason: new InvalidRequestError({ message: error.message }) }),
    }),
  };
  return base.route.with({ transport }).model({ id: modelID });
}
