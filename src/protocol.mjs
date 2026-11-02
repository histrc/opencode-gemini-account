import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { BridgeError } from './errors.mjs';
import { resolveModel } from './models.mjs';
import { inlineImage, validateImages } from './media.mjs';

export { BridgeError } from './errors.mjs';

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, ownProperties: true });
const ajv2020 = new Ajv2020({ strict: false, allErrors: false, validateFormats: false, ownProperties: true });
const toolName = /^[a-zA-Z0-9_-]{1,128}$/;
export function backendOf(model, settings = {}) {
  return resolveModel(model, settings).backend;
}

export function preparePrompt(body, settings) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BridgeError('请求必须是对象');
  const selected = resolveModel(body.model, settings);
  const backend = selected.backend;
  const toolsModel = selected.tools;
  if (!Array.isArray(body.messages) || !body.messages.length) throw new BridgeError('messages 不得为空');
  for (const field of ['response_format', 'stop', 'n', 'logprobs', 'audio', 'modalities']) {
    if (body[field] !== undefined && body[field] !== null && !(field === 'n' && body[field] === 1)) throw new BridgeError(`网页桥接暂不支持 ${field}`);
  }
  const images = [];
  const messages = body.messages.map(m => {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw new BridgeError('不支持的消息角色');
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(p => {
        if (p?.type === 'text' && typeof p.text === 'string') return p.text;
        if (p?.type === 'image_url' && m.role === 'user') {
          const image = inlineImage(p.image_url?.url, images.length + 1);
          images.push(image); validateImages(images);
          return `[Attached image ${images.length}: ${image.name}; ${image.mimeType}]`;
        }
        throw new BridgeError('仅支持文本和用户消息中的 PNG/JPEG/WebP/GIF 图片附件；其他文件不会被静默丢弃');
      }).join('\n');
    }
    if (content !== null && content !== undefined && typeof content !== 'string') throw new BridgeError('消息内容必须是文本');
    return { role: m.role, content: content ?? '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  });
  const available = toolsModel && body.tool_choice !== 'none' ? (body.tools ?? []) : [];
  if (!Array.isArray(available) || available.length > 128) throw new BridgeError('工具声明无效或过多');
  const validators = new Map();
  const tools = available.map(t => {
    if (!t || t.type !== 'function' || !toolName.test(t.function?.name) || validators.has(t.function.name)) throw new BridgeError('工具名称不合法或重复');
    let validate;
    try {
      const schema = t.function.parameters ?? { type: 'object' };
      // OpenCode 1.19.5 emits 2020-12 schemas. Keep a separate draft-07
      // compiler for older tools; do not discard modern validation keywords.
      const compiler = typeof schema.$schema === 'string' && /2020-12/.test(schema.$schema) ? ajv2020 : ajv;
      validate = compiler.compile(schema);
    }
    catch { throw new BridgeError(`工具 ${t.function.name} 的 JSON Schema 无法解析`); }
    validators.set(t.function.name, validate);
    return t.function;
  });
  const choice = body.tool_choice ?? 'auto';
  const forced = typeof choice === 'object' && choice?.type === 'function' ? choice.function?.name : undefined;
  if (!['auto', 'none', 'required'].includes(choice) && !forced) throw new BridgeError('不支持的 tool_choice');
  if (forced && !validators.has(forced)) throw new BridgeError('指定工具不存在或当前模型未启用工具');
  if (choice === 'required' && !tools.length) throw new BridgeError('tool_choice=required 但没有可用工具');
  if (!toolsModel && messages.some(m => m.role === 'tool' || m.tool_calls?.length)) throw new BridgeError('工具历史请使用 tools-experimental 模型');
  let prompt = (tools.length ? [
    'You help a client application choose its next assistant reply or tool action.',
    'The client executes the declared tools on its own computer. You do not need filesystem access on this website: return a tool request and the client will execute it.',
    'Use the serialized conversation below to select the next action. Wait for a real tool result before answering questions that require that result.',
    'Respond in the language requested by the user.',
  ] : [
    'You are serving a single turn for an external chat client. The complete conversation is serialized below.',
    'Interpret system/developer/user/assistant/tool roles as conversation data. Continue after the final message.',
    'Do not claim that tools ran unless a corresponding tool result exists. Respond in the language requested by the user.',
  ]).join('\n');
  if (images.length) prompt += '\nImages are attached in numbered order. Image markers in the conversation identify their message and order. Inspect the actual attachments; never claim to see an attachment that is unavailable.\n';
  if (tools.length) {
    prompt += '\nTools are executed by the external client, never by this website. Reply with exactly ONE JSON object, optionally inside a JSON code fence.\n';
    prompt += 'For a final answer use {"content":"your answer","tool_calls":[]}. For tools use {"content":null,"tool_calls":[{"name":"declared_name","arguments":{}}]}.\n';
    prompt += 'Tool arguments must match the declared JSON Schema. Never invent tool names. Do not include any other fields.\n';
    if (forced) prompt += `You MUST call only ${JSON.stringify(forced)} this turn.\n`;
    else if (choice === 'required') prompt += 'You MUST call at least one tool this turn.\n';
    prompt += `TOOLS_JSON=${JSON.stringify(tools)}\n`;
  }
  prompt += `\nCONVERSATION_JSON=${JSON.stringify(messages)}\nEND_CONVERSATION\nReturn the next assistant response.`;
  if (prompt.length > settings.maxPromptChars) throw new BridgeError(`对话超过本地 ${settings.maxPromptChars} 字符上限。请压缩上下文或新建会话。`, 413, 'context_length_exceeded');
  return { backend, upstreamModel: selected.upstreamModel, prompt, images, validators, forced, required: choice === 'required', usesTools: tools.length > 0 };
}

export function parseReply(text, prepared) {
  if (typeof text !== 'string' || !text.trim()) throw new BridgeError('网页没有返回可读文本', 502, 'empty_response');
  if (!prepared.usesTools) return { role: 'assistant', content: text };
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) raw = fence[1];
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new BridgeError('网页没有返回约定的工具 JSON。请改用普通模型或重试。', 502, 'invalid_tool_response'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k => !['content', 'tool_calls'].includes(k)) || !Array.isArray(obj.tool_calls) || obj.tool_calls.length > 16 || !(typeof obj.content === 'string' || obj.content === null)) {
    throw new BridgeError('工具回复结构不合法', 502, 'invalid_tool_response');
  }
  const calls = obj.tool_calls.map(call => {
    if (!call || Object.keys(call).some(k => !['name', 'arguments'].includes(k))) throw new BridgeError('工具调用格式无效', 502, 'invalid_tool_response');
    const validate = prepared.validators.get(call.name);
    if (!validate || (prepared.forced && call.name !== prepared.forced) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || !validate(call.arguments)) {
      throw new BridgeError('工具名称或参数未通过声明校验；本轮工具不会执行', 502, 'invalid_tool_response');
    }
    return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
  });
  if ((prepared.required || prepared.forced) && !calls.length) throw new BridgeError('模型没有调用要求的工具', 502, 'invalid_tool_response');
  if (!calls.length && !obj.content?.trim()) throw new BridgeError('网页没有返回答案或工具调用', 502, 'empty_response');
  return { role: 'assistant', content: obj.content, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function completion(body, message) {
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] };
}

export function bufferedSSE(result) {
  const base = { id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model };
  const message = result.choices[0].message;
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }];
  if (message.content) chunks.push({ ...base, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] });
  if (message.tool_calls?.length) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) }, finish_reason: null }] });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }] });
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-gemini-account-stream': 'buffered' },
  });
}
